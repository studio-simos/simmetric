// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import crypto from "node:crypto";
import prisma from "../utils/prisma";
import { PERMISSION_NAMES, DEFAULT_ROLES, DEFAULT_ROLE_MENU_SECTIONS } from "@simmetric-chat/shared";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";
import bcrypt from "bcryptjs";
import { getSetting } from "./systemConfigService";
import { hmacSha256 } from "./apiKeyService";

/**
 * Legacy hardcoded passwords that older deployments seeded onto the
 * widget-service account: "testpassword123" from this service's seeder,
 * "widget123" from prisma/seed.ts (`pnpm db:seed`). Referenced ONLY to
 * detect-and-rotate those known-weak hashes on existing installs — they are
 * never used to seed a new account.
 */
const KNOWN_WEAK_PASSWORDS = ["testpassword123", "widget123"];

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "workspace:read": "View workspaces and their contents",
  "workspace:write": "Create and modify workspaces",
  "workspace:delete": "Delete workspaces",
  "project:read": "View projects",
  "project:write": "Create and modify projects",
  "project:delete": "Delete projects",
  "chat:read": "View chats",
  "chat:write": "Send messages in chats",
  "chat:delete": "Delete chats",
  "document:read": "View documents",
  "document:write": "Upload and modify documents",
  "document:delete": "Delete documents",
  "admin:users": "Manage users and their access",
  "admin:settings": "Manage system settings",
  "admin:roles": "Manage roles and permissions",
  "project:create": "Create new projects",
  "workspace:create": "Create new workspaces",
  "provider:read": "View LLM providers",
  "provider:write": "Configure LLM providers",
  // Phase 97 (MEM-01 D-02): memory permissions — user manages their own per-user-per-workspace memories.
  "memory:read": "View own memories",
  "memory:write": "Create and modify own memories",
};

/** Seed permissions into the database (idempotent; internal step of seedAll) */
async function seedPermissions(): Promise<void> {
  const allPermissions = PERMISSION_NAMES.map((name) => ({
    name,
    description: PERMISSION_DESCRIPTIONS[name] ?? name,
  }));

  for (const perm of allPermissions) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: { description: perm.description },
      create: perm,
    });
  }

  logger.info(`[seed] Seeded ${allPermissions.length} permissions`);
}

/** Seed roles and role-permission associations (idempotent; internal step of seedAll) */
async function seedRoles(): Promise<void> {
  for (const roleDef of DEFAULT_ROLES) {
    const role = await prisma.role.upsert({
      where: { name: roleDef.name },
      update: {},
      create: {
        name: roleDef.name,
        description: roleDef.description,
        isDefault: roleDef.isDefault,
      },
    });

    for (const permName of roleDef.permissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionName: {
            roleId: role.id,
            permissionName: permName,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionName: permName,
        },
      });
    }

    logger.info(`[seed] Seeded role "${roleDef.name}" with ${roleDef.permissions.length} permissions`);
  }
}

/** Seed menu sections per role (idempotent; internal step of seedAll) */
async function seedMenuSections(): Promise<void> {
  for (const [roleName, sections] of Object.entries(DEFAULT_ROLE_MENU_SECTIONS)) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      logger.warn(`[seed] Role "${roleName}" not found, skipping menu sections`);
      continue;
    }

    for (const section of sections) {
      await prisma.roleMenuSection.upsert({
        where: {
          roleId_menuSection: {
            roleId: role.id,
            menuSection: section,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          menuSection: section,
        },
      });
    }

    logger.info(`[seed] Seeded ${sections.length} menu sections for role "${roleName}"`);
  }
}

/** Seed MCP catalog entries (idempotent) */
export async function seedCatalogEntries(): Promise<void> {
  const entries = [
    {
      id: "b1e3f4a2-0001-4000-8000-000000000001",
      name: "GitHub MCP Server",
      url: "https://mcp.github.com/sse",
      transportType: "sse",
      description: "Official GitHub MCP server providing repository, issue, and PR tools for AI-assisted development workflows.",
      category: "Developer Tools",
      version: "1.2.0",
      author: "GitHub",
      verificationTier: "official",
      lastCommitDate: new Date("2026-04-15T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0002-4000-8000-000000000002",
      name: "Postman API Tools",
      url: "https://mcp.postman.com/sse",
      transportType: "sse",
      description: "Community-maintained MCP server for Postman API collections and testing. Widely used and well-maintained.",
      category: "API Tools",
      version: "2.0.1",
      author: "Postman Community",
      verificationTier: "verified_community",
      lastCommitDate: new Date("2026-03-20T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0003-4000-8000-000000000003",
      name: "Filesystem Navigator",
      url: "https://mcp.filesystem.dev/sse",
      transportType: "sse",
      description: "Community-verified MCP server for filesystem operations with safety sandboxing.",
      category: "System Tools",
      version: "0.9.5",
      author: "FSDev Collective",
      verificationTier: "verified_community",
      lastCommitDate: new Date("2025-09-10T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0004-4000-8000-000000000004",
      name: "Weather Data Provider",
      url: "https://mcp.weather.example.com/sse",
      transportType: "sse",
      description: "Unverified community weather data MCP server. Provides current conditions and forecasts via Open-Meteo API.",
      category: "Data Providers",
      version: "1.0.0",
      author: "WeatherFan",
      verificationTier: "unverified",
      lastCommitDate: new Date("2026-05-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0005-4000-8000-000000000005",
      name: "SQL Database Explorer",
      url: "https://mcp.sql-explorer.io/sse",
      transportType: "sse",
      description: "Community MCP server for exploring SQL databases with read-only queries. Supports PostgreSQL, MySQL, and SQLite.",
      category: "Database",
      version: "1.1.0",
      author: "DBTools",
      verificationTier: "unverified",
      lastCommitDate: new Date("2026-02-28T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0006-4000-8000-000000000006",
      name: "Docker Container Manager",
      url: "https://mcp.docker-tools.dev/sse",
      transportType: "sse",
      description: "Manage Docker containers, images, and compose stacks via MCP. Requires Docker socket access.",
      category: "DevOps",
      version: "0.8.0",
      author: "ContainerGuru",
      verificationTier: "unverified",
      lastCommitDate: new Date("2025-12-15T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0007-4000-8000-000000000007",
      name: "Email Assistant",
      url: "https://mcp.email-tools.com/sse",
      transportType: "sse",
      description: "Read, search, and compose emails via IMAP/SMTP. Supports Gmail, Outlook, and custom mail servers.",
      category: "Productivity",
      version: "1.3.0",
      author: "MailBot",
      verificationTier: "unverified",
      lastCommitDate: new Date("2025-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0008-4000-8000-000000000008",
      name: "Jira Integration",
      url: "https://mcp.jira-connect.io/sse",
      transportType: "sse",
      description: "Create, update, and search Jira issues. Supports custom fields and sprint management.",
      category: "Project Management",
      version: "2.1.0",
      author: "AgileTools",
      verificationTier: "unverified",
      lastCommitDate: new Date("2025-11-20T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0009-4000-8000-000000000009",
      name: "Slack Notifier",
      url: "https://mcp.slack-bridge.dev/sse",
      transportType: "sse",
      description: "Send messages and notifications to Slack channels. Read channel history with proper scoping.",
      category: "Communication",
      version: "1.0.1",
      author: "ChatBridge",
      verificationTier: "unverified",
      lastCommitDate: new Date("2025-10-05T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0010-4000-8000-000000000010",
      name: "Web Scraper",
      url: "https://mcp.scraper-tools.org/sse",
      transportType: "sse",
      description: "Extract structured data from web pages with CSS selectors and XPath. Respects robots.txt.",
      category: "Data Tools",
      version: "0.7.2",
      author: "DataMiner",
      verificationTier: "unverified",
      lastCommitDate: new Date("2026-01-10T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0011-4000-8000-000000000011",
      name: "Obsidian Notes Sync",
      url: "https://mcp.obsidian-bridge.com/sse",
      transportType: "sse",
      description: "Read and create Obsidian notes. Search vault contents with full-text and tag filtering.",
      category: "Knowledge Management",
      version: "1.0.0",
      author: "NoteSync",
      verificationTier: "unverified",
      lastCommitDate: null,
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0012-4000-8000-000000000012",
      name: "Calendar Scheduler",
      url: "https://mcp.calendar-tools.dev/sse",
      transportType: "sse",
      description: "Create and manage calendar events across Google Calendar, Outlook, and CalDAV providers.",
      category: "Productivity",
      version: "0.5.0",
      author: "TimeWizard",
      verificationTier: "unverified",
      lastCommitDate: null,
      headers: "{}",
    },
  ];

  for (const entry of entries) {
    await prisma.mcpCatalogEntry.upsert({
      where: { id: entry.id },
      update: {
        name: entry.name,
        url: entry.url,
        transportType: entry.transportType,
        description: entry.description,
        category: entry.category,
        version: entry.version,
        author: entry.author,
        verificationTier: entry.verificationTier,
        lastCommitDate: entry.lastCommitDate,
        headers: entry.headers,
      },
      create: {
        id: entry.id,
        name: entry.name,
        url: entry.url,
        transportType: entry.transportType,
        description: entry.description,
        category: entry.category,
        version: entry.version,
        author: entry.author,
        verificationTier: entry.verificationTier,
        lastCommitDate: entry.lastCommitDate,
        headers: entry.headers,
      },
    });
  }

  logger.info(`[seed] Seeded ${entries.length} MCP catalog entries`);
}

/** Seed widget service account (idempotent) */
export async function seedServiceAccount(): Promise<void> {
  const SALT_ROUNDS = 12;

  // The widget service account authenticates exclusively via API key
  // (apiKeyMiddleware on /api/internal/widget; keys are minted by
  // scripts/generate-widget-apikey.js). Nobody ever logs in with this user's
  // password, so it only exists to satisfy the non-null passwordHash/salt
  // columns. We therefore generate it as a crypto-random secret that is never
  // logged or disclosed anywhere — there is intentionally no
  // WIDGET_SERVICE_PASSWORD env var.
  const generateRandomPassword = (): string => crypto.randomBytes(32).toString("hex");

  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email: "widget-service@system" },
        { username: "widget-service" },
      ],
    },
  });

  if (existing) {
    // Older deployments seeded this account with a hardcoded weak password.
    // Detect those exact legacy hashes and rotate to a fresh random secret so
    // existing installs don't carry the weak credential forever.
    let hasWeakPassword = false;
    if (existing.passwordHash) {
      for (const weak of KNOWN_WEAK_PASSWORDS) {
        if (await bcrypt.compare(weak, existing.passwordHash)) {
          hasWeakPassword = true;
          break;
        }
      }
    }

    if (hasWeakPassword) {
      const salt = await bcrypt.genSalt(SALT_ROUNDS);
      const passwordHash = await bcrypt.hash(generateRandomPassword(), salt);
      await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, salt },
      });
      logger.warn(`[seed] Rotated weak password on existing service account: ${existing.email}`);
      return;
    }

    logger.info("[seed] Service account already exists, skipping");
    return;
  }

  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const passwordHash = await bcrypt.hash(generateRandomPassword(), salt);

  const user = await prisma.user.create({
    data: {
      username: "widget-service",
      email: "widget-service@system",
      passwordHash,
      salt,
    },
  });

  logger.info(`[seed] Created service account: ${user.email}`);
}

/**
 * Seed the widget API key row (idempotent) — 151-02 G-151-1a/1b follow-up.
 *
 * The widget service authenticates to the server's /api/internal/widget routes
 * with `X-Api-Key: <WIDGET_API_KEY>` (root .env / docker-compose
 * env). apiKeyMiddleware (middleware/auth.ts) delegates to validateApiKey,
 * which accepts a key ONLY if an HMAC-SHA256 digest match exists in the
 * api_keys table (Phase 163/SCALE-03 — key_hash column) — the env var alone
 * is not enough. Docker deployments pass WIDGET_API_KEY to both containers
 * but never minted the DB row, so every widget outbound call 401'd and the
 * widget iframe rendered with an empty config (no auto-open, session 500s).
 *
 * This seeder closes the gap: when the server-side WIDGET_API_KEY env is set,
 * it ensures an api_keys row whose HMAC digest matches that exact key exists,
 * owned by the widget-service account (seedServiceAccount). The lookup mirrors
 * validateApiKey exactly (findUnique({key_hash})), so a seeded row is
 * guaranteed to authenticate. Idempotent: on every boot the findUnique finds
 * the existing row and skips. If the env key rotates, a new row is
 * minted for the new key (old rows are left in place — same behavior as the
 * manual generate-widget-apikey.js script).
 *
 * No-op when WIDGET_API_KEY is unset (the server-side key is optional by
 * design — cache-bust push disabled) or when the widget-service account is
 * missing (seedServiceAccount must run first).
 *
 * Crash-loop safety (quick 260830-og8 D-01): the display prefix is derived
 * from the HMAC digest (keyHash.substring(0, 8)) — deterministic per
 * (WIDGET_API_KEY, API_KEY_HMAC_SECRET) pair, so rotation self-heals and a
 * stale row sharing only the raw-key prefix cannot collide. Even so, a P2002
 * unique-constraint failure (two boots racing the same create, or the
 * astronomically rare 8-hex digest-prefix collision) is TOLERATED, never
 * propagated: seeding runs at boot inside the process.exit(1) try/catch, so a
 * rethrow here would crash-loop the deployment on a conflict that is either
 * already resolved (another boot won the race — re-check finds the row) or
 * best-effort ignorable (display-only prefix, lookup is by key_hash). P2002
 * → re-check findUnique({key_hash}): found → info log, return (the winner's
 * row authenticates the same key by digest); null → warn log, return.
 * Non-P2002 errors still throw.
 */
export async function seedWidgetApiKey(): Promise<void> {
  const env = getEnv();
  if (!env.WIDGET_API_KEY) {
    logger.info("[seed] Widget API key seeding skipped — WIDGET_API_KEY not set");
    return;
  }

  const serviceAccount = await prisma.user.findFirst({
    where: {
      OR: [
        { email: "widget-service@system" },
        { username: "widget-service" },
      ],
    },
    select: { id: true },
  });
  if (!serviceAccount) {
    logger.warn("[seed] Widget API key seeding skipped — widget-service account not found (run seedServiceAccount first)");
    return;
  }

  const rawKey = env.WIDGET_API_KEY;
  const keyHash = hmacSha256(rawKey);
  // Prefix is display-only (Phase 163 D-03 — lookup is by key_hash). Deriving
  // it from the digest makes it idempotent per (key, secret) pair and exposes
  // zero raw-key material (T-OG8-02).
  const prefix = keyHash.substring(0, 8);

  // Idempotency: if a row with this key_hash already exists, the key is already
  // seeded (HMAC digest is deterministic — same raw key + same secret → same
  // digest). Replaces the old prefix findMany + bcrypt.compare loop.
  const existing = await prisma.apiKey.findUnique({ where: { key_hash: keyHash } });
  if (existing) {
    logger.info("[seed] Widget API key already seeded, skipping");
    return;
  }

  try {
    await prisma.apiKey.create({
      data: {
        name: "widget-service (auto-seeded)",
        prefix,
        key_hash: keyHash,
        createdBy: serviceAccount.id,
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "P2002") {
      throw err;
    }
    // P2002 on api_keys.prefix — tolerated, never rethrown (T-OG8-01):
    // re-check by key_hash, the same lookup the idempotency check + validateApiKey
    // use. A found row = a concurrent boot won the race and minted the identical
    // digest; a null = the ~2^-32 digest-prefix collision. Either way boot
    // proceeds.
    const winner = await prisma.apiKey.findUnique({ where: { key_hash: keyHash } });
    if (winner) {
      logger.info("[seed] Widget API key already seeded — concurrent boot won the race");
      return;
    }
    logger.warn(
      "[seed] Widget API key seeded row conflicts on display prefix with different key_hash — skipping (best-effort seeding, never fatal at boot)",
    );
  }
  logger.info("[seed] Seeded widget API key row (HMAC digest, auto-seeded from WIDGET_API_KEY)");
}

/**
 * Seed a bootstrap admin user on first startup, so the system is usable
 * straight after `pnpm db:migrate` + `pnpm dev` without a manual
 * `POST /api/system/initialize` call.
 *
 * Credentials come from env (SEED_ADMIN_USERNAME / PASSWORD / EMAIL, defaults
 * admin / admin123 / admin@example.com). The account is created with
 * mustChangePassword=true, so the bootstrap password is single-use: the first
 * login forces a rotation via /api/auth/set-initial-password. This mirrors the
 * D-02 contract already used by POST /api/system/initialize.
 *
 * Idempotent: if any admin user already exists (any user linked to the admin
 * role), seeding is skipped — we never overwrite or reset an existing admin's
 * password. If the configured username/email is already taken by a non-admin
 * user, we skip with a warning rather than clobbering or stealing the handle.
 *
 * Gated by SEED_BOOTSTRAP_ADMIN (default true); set to false in deployments
 * that manage their first admin out-of-band.
 */
export async function seedBootstrapAdmin(): Promise<void> {
  const env = getEnv();
  if (!env.SEED_BOOTSTRAP_ADMIN) {
    logger.info("[seed] Bootstrap admin seeding disabled (SEED_BOOTSTRAP_ADMIN=false)");
    return;
  }

  // Phase 152 (WIZ-02, D-05): when the setup wizard is active (fresh install,
  // no admin), the wizard owns admin creation — skip the seed so no
  // admin/admin123 default credential is created. SEED_BOOTSTRAP_ADMIN stays
  // as the hard override that runs BEFORE this check (backward compat for
  // docker/CI deploys that explicitly opt in). The skip guard reads the
  // boot-derived setup_wizard_mode value, so ensureSetupWizardMode() MUST
  // have run before this point (boot-order pin in bootOrder.test.ts).
  const wizardMode = await getSetting("setup_wizard_mode");
  if (wizardMode.value === "active") {
    logger.info(
      "[seed] Setup wizard is active — skipping bootstrap admin (wizard owns admin creation)",
    );
    return;
  }

  const { SEED_ADMIN_USERNAME: username, SEED_ADMIN_PASSWORD: password, SEED_ADMIN_EMAIL: email } = env;

  const adminRole = await prisma.role.findFirst({ where: { name: "admin" } });
  if (!adminRole) {
    logger.warn("[seed] Admin role not found — skipping bootstrap admin (run seedRoles first)");
    return;
  }

  // Skip entirely once any admin user exists — never reset a real admin.
  const adminCount = await prisma.userRole.count({ where: { roleId: adminRole.id } });
  if (adminCount > 0) {
    logger.info(`[seed] Admin user already exists (${adminCount}) — skipping bootstrap admin`);
    return;
  }

  // Don't clobber an existing account that happens to hold the configured handle.
  const handleTaken = await prisma.user.findFirst({
    where: { OR: [{ username }, { email }] },
  });
  if (handleTaken) {
    logger.warn(
      `[seed] Username "${username}" / email "${email}" already in use by a non-admin user — skipping bootstrap admin`,
    );
    return;
  }

  const SALT_ROUNDS = 12;
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const passwordHash = await bcrypt.hash(password, salt);

  const user = await prisma.user.create({
    data: {
      username,
      email,
      passwordHash,
      salt,
      mustChangePassword: true,
    },
  });
  await prisma.userRole.create({
    data: { userId: user.id, roleId: adminRole.id },
  });

  logger.warn(
    `[seed] Bootstrap admin created — username="${username}". ` +
      `It was seeded with the default password and MUST be changed at first login (mustChangePassword=true).`,
  );
}

/** Run all seed steps (idempotent, safe to call on every startup) */
export async function seedDatabase(): Promise<void> {
  logger.info("[seed] Running auto-seed...");
  await seedPermissions();
  await seedRoles();
  await seedMenuSections();
  logger.info("[seed] Auto-seed completed");
}