/**
 * Playwright globalSetup — seeds an E2E Widget into the dev DB before the
 * E2E-02 widget-embed suite runs (Plan 66-01 Task 1, decision D-07).
 *
 * Flow:
 *  1. POST /api/auth/login (admin/admin123) → JWT
 *  2. GET /api/widgets → if an "E2E Test Widget" already exists, reuse its id
 *     (idempotency — repeated `pnpm test:e2e` runs don't pile up widgets)
 *  3. POST /api/widgets → new Widget record (Enterprise license active in dev,
 *     widget_enabled=true — verified spike A4)
 *  4. Persist widget.id to process.env.E2E_WIDGET_ID for the widgetPage fixture
 *
 * Fallback: if the REST POST fails (license/limit/network), seed directly via
 * PrismaClient. This bypasses requireFeature("widget_enabled") + requireFeatureLimit.
 * PrismaClient is resolved from packages/server/node_modules via createRequire
 * (the root worktree node_modules does not hoist @prisma/client).
 *
 * Spike results (Plan 66-01 Task 1):
 *  - A1 (route.fulfill SSE): verified via Context7 /microsoft/playwright/v1.61.0
 *    (see 66-RESEARCH.md §"Code Examples"). A one-shot `route.fulfill({ body })`
 *    with `contentType: "text/event-stream"` is a valid SSE stream for
 *    @microsoft/fetch-event-source — the parser splits events on `\n\n`
 *    regardless of TCP chunking. Not re-run live here because it requires a
 *    fresh browser + server + frontend cycle that is out of scope for a
 *    parallel worktree executor; the API contract is stable in 1.61.x.
 *  - A4 (widget_enabled license flag): confirmed active via
 *    `curl /api/license/info` → tier=enterprise, features.widget_enabled=true,
 *    max_widgets=999999. No system_config row exists for widget_enabled (it is
 *    a license-JWT flag, not a SystemConfig key), so SQL `UPDATE system_config`
 *    is NOT the remediation path — the Enterprise license JWT is.
 *  - WIDGET_API_KEY match: the root `.env` (gitignored, main repo) holds
 *    `sk-c6a7b6662ab64f4c9582bf83e147675b` (same as `.env.example`). The dev DB
 *    `api_keys` table has 0 rows → `apiKeyMiddleware` returns 401 "Invalid API
 *    key" for the widget service. This is a known environment gap that blocks
 *    Plan 02 widget-embed suite at runtime; it does NOT block Plan 01 code
 *    deliverables (globalSetup seeds the Widget via admin JWT, which works).
 *    Remediation deferred to Plan 02: run `pnpm --filter server generate-apikey`
 *    + update the root `.env`, or insert an ApiKey row matching the
 *    existing key.
 */
import { request as pwRequest, type APIRequestContext } from "@playwright/test";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { makeE2ePrisma } from "./lib/prisma";
import type { PrismaClient } from "@prisma/client";
import {
  ORG_B_ID,
  ORG_B_WORKSPACE_ID,
  ORG_B_USERNAME,
  ORG_B_SLUG,
  ORG_B_USER_EMAIL,
} from "./fixtures";

// bcryptjs + @simmetric-chat/shared are packages/server(-reachable) deps —
// pnpm strict isolation does NOT hoist them into the root node_modules, and
// the e2e/ directory has no tsconfig of its own, so bare ESM imports fail to
// resolve at runtime. Same resolution seam as makeE2ePrisma (createRequire
// from packages/server). Keeps ONE definition of DEFAULT_ORG_ID (shared) —
// the literal-UUID fixture allowance applies only to ORG_B_* constants.
const requireFromServer = createRequire(path.resolve("packages/server"));
const bcrypt = requireFromServer("bcryptjs") as typeof import("bcryptjs");
const { DEFAULT_ORG_ID } = requireFromServer("@simmetric-chat/shared") as typeof import("@simmetric-chat/shared");

// TS-04 adjacency guard (182-PLAN-04 must_haves): the org-b fixture org must
// NEVER equal the default org — two orgs' rows never merge. Fail loudly here
// rather than seeding a fixture that silently aliases the default tenant.
if (ORG_B_ID === DEFAULT_ORG_ID) {
  throw new Error(
    "[globalSetup] ORG_B_ID collides with DEFAULT_ORG_ID — org-b fixture misconfiguration",
  );
}

const E2E_WIDGET_NAME = "E2E Test Widget";
const SERVER_URL = process.env.E2E_SERVER_URL ?? "http://localhost:3000";
const ALLOWED_ORIGIN = "http://localhost:5173";

// Phase 103 D-01: the workspace ID hardcoded across all E2E specs
// (e2e/fixtures.ts:24 WORKSPACE_ID). globalSetup ensures this workspace exists.
const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66";

// Phase 103 D-02: the WIDGET_API_KEY plaintext from the root .env
// (gitignored; same value as .env.example). The api_keys row's HMAC-SHA256
// digest (key_hash) must match this so the widget service apiKeyMiddleware
// validation succeeds (Phase 163/SCALE-03 — keyed-HMAC digest lookup).
const WIDGET_API_KEY_PLAINTEXT = "sk-c6a7b6662ab64f4c9582bf83e147675b";
const WIDGET_API_KEY_PREFIX = WIDGET_API_KEY_PLAINTEXT.substring(0, 8); // "sk-c6a7b"

/** Best-effort dotenv load so the Prisma fallback can find DATABASE_URL (and
 *  the seedApiKey HMAC path can find API_KEY_HMAC_SECRET). */
async function loadDatabaseUrl(): Promise<string | undefined> {
  // Dotenv load FIRST, before the DATABASE_URL short-circuit (182-04 Task 2
  // Rule 1 fix): playwright.config.ts injects DATABASE_URL into process.env
  // before globalSetup runs, so the old "return early when DATABASE_URL is
  // set" branch skipped the dotenv load entirely — and with it
  // API_KEY_HMAC_SECRET, which seedApiKey's HMAC path reads from the same
  // root .env (the fixture chain then aborted before org-b could seed).
  // dotenv never overrides keys already in process.env, so an unconditional
  // load is order-safe.
  try {
    const dotenv = (await import("dotenv")).default;
    const envPath = path.resolve(process.cwd(), ".env");
    dotenv.config({ path: envPath });
  } catch {
    // dotenv unresolvable from this context — process.env may still carry
    // DATABASE_URL (playwright config injects it); the fs fallback below covers it.
  }
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  try {
    const fs = await import("node:fs");
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(/^DATABASE_URL=(.+)$/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Phase 163 (SCALE-03): HMAC-SHA256 signing for the E2E api_keys seed row.
 *
 * The E2E globalSetup runs OUTSIDE the server bundle (it uses makeE2ePrisma,
 * not the singleton), so it cannot import getHmacSecret/hmacSha256 from
 * packages/server/src/services/apiKeyService. This inlines a mirror of the
 * EXACT same contract (RESEARCH Pitfall 2): Buffer.from(secret, "base64")
 * before createHmac — NEVER the raw base64 string. A string key vs a Buffer
 * key produce DIFFERENT digests; validateApiKey (server-side) uses the Buffer
 * path, so this inline copy must too, or the seeded row's digest won't match
 * and every widget spec 401s (T-163-08 tampering mitigation).
 *
 * The secret is read from the root .env (the same dotenv load that
 * surfaces DATABASE_URL in loadDatabaseUrl above).
 */
function getHmacSecret(): Buffer {
  const raw = process.env.API_KEY_HMAC_SECRET;
  if (!raw) {
    throw new Error(
      "API_KEY_HMAC_SECRET is required when API keys are used. " +
        "Generate a base64 32-byte key with: openssl rand -base64 32, " +
        "set it in the root .env, and restart.",
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `API_KEY_HMAC_SECRET must decode to exactly 32 bytes (got ${decoded.length}). ` +
        "Generate with: openssl rand -base64 32",
    );
  }
  return decoded;
}

function hmacSha256(rawKey: string): string {
  return crypto.createHmac("sha256", getHmacSecret()).update(rawKey).digest("hex");
}

/** Fallback: insert the Widget row directly via PrismaClient, bypassing the
 *  REST requireFeature/requireFeatureLimit gates. Resolves @prisma/client
 *  from packages/server/node_modules (root worktree does not hoist it). */
async function seedViaPrisma(): Promise<string | null> {
  const databaseUrl = await loadDatabaseUrl();
  if (!databaseUrl) {
    console.error("[globalSetup] Prisma fallback skipped — DATABASE_URL not set");
    return null;
  }
  try {
    // GAP-01 fix: use shared e2e/lib/prisma helper (Prisma 7 driver-adapter
    // pattern). The old PrismaClient constructor with an inline datasource
    // URL option is rejected by Prisma 7.x — this fallback was latent (never
    // reached when the REST path succeeded) but contained the same
    // anti-pattern as widget-embed.spec.ts:79. Fix preventively.
    const prisma = makeE2ePrisma(databaseUrl);
    try {
      // Find an admin user to satisfy the createdBy FK.
      const admin = await prisma.user.findFirst({
        where: { roles: { some: { role: { name: { in: ["admin", "superuser"] } } } } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!admin) {
        console.error("[globalSetup] Prisma fallback aborted — no admin user found");
        return null;
      }
      // Reuse an existing E2E widget (idempotency).
      const existing = await prisma.widget.findFirst({
        where: { name: E2E_WIDGET_NAME, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        console.log(`[globalSetup] Reused existing E2E widget via Prisma id=${existing.id}`);
        return existing.id;
      }
      const created = await prisma.widget.create({
        data: {
          name: E2E_WIDGET_NAME,
          allowedOrigins: JSON.stringify([ALLOWED_ORIGIN]),
          isActive: true,
          createdBy: admin.id,
        },
        select: { id: true },
      });
      console.log(`[globalSetup] Seeded E2E widget via Prisma id=${created.id}`);
      return created.id;
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.error("[globalSetup] Prisma fallback failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ============================================================
// Phase 103 (Plan 103-01) — Stable E2E fixture seeding
// ============================================================

/**
 * D-01: Seed workspace 9a334821-... ("Elegregio") + admin WorkspaceAccess + >=1 Chat.
 *
 * CRITICAL (RESEARCH.md Pitfall 1): the Workspace model has NO `createdBy`
 * field. Workspace access is managed via the WorkspaceAccess join table, which
 * has NO `role` field (only userId, workspaceId, grantedAt). Seeding requires a
 * three-table chain:
 *   1. Project (createdBy = adminId) — required FK for Workspace.projectId
 *   2. Workspace (id = WORKSPACE_ID, projectId = project.id) — NO createdBy
 *   3. WorkspaceAccess (userId = adminId, workspaceId = WORKSPACE_ID) — NO role
 *   4. Chat (workspaceId = WORKSPACE_ID) — so createChatId always finds >=1 chat
 *
 * Idempotent: check-then-create at every step (same pattern as widget seeding).
 */
async function seedWorkspaceAndChat(prisma: PrismaClient, adminId: string): Promise<void> {
  // 1. Find or create a Project for the admin. Tombstone-aware (Rule 3,
  //    182-04 execution): projects_createdBy_name_key is a PLAIN unique
  //    (D-06 kept it non-partial), so a soft-deleted "E2E Test Project"
  //    row permanently blocks re-create with P2002 — the create-project-
  //    sidebar spec soft-deletes its projects (cleanup), and a tombstoned
  //    shared fixture name once aborted this whole chain. Revive the
  //    tombstone (deletedAt: null) — the same D-05 either-branch-safe
  //    resurrect shape every Phase 182 write path uses. The revive is a
  //    no-op when a live row already exists.
  let project = await prisma.project.findFirst({
    where: { name: "E2E Test Project", deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    const tombstone = await prisma.project.findFirst({
      where: { name: "E2E Test Project", deletedAt: { not: null } },
      select: { id: true },
    });
    if (tombstone) {
      await prisma.project.update({
        where: { id: tombstone.id },
        data: { deletedAt: null },
      });
      project = { id: tombstone.id };
      console.log(`[globalSetup] Revived tombstoned E2E Test Project id=${project.id}`);
    }
  }
  if (!project) {
    try {
      project = await prisma.project.create({
        data: { name: "E2E Test Project", createdBy: adminId },
        select: { id: true },
      });
      console.log(`[globalSetup] Seeded E2E Test Project id=${project.id}`);
    } catch (err) {
      // P2002 race tolerance: a concurrent seeder created the row between
      // our findFirst and create (TOCTOU window) — re-read and continue.
      if ((err as { code?: string }).code !== "P2002") throw err;
      const winner = await prisma.project.findFirst({
        where: { name: "E2E Test Project", deletedAt: null },
        select: { id: true },
      });
      if (!winner) throw err;
      project = winner;
      console.log(`[globalSetup] E2E Test Project created concurrently, re-read id=${project.id}`);
    }
  }

  // 2. Ensure the hardcoded workspace exists. Do NOT pass createdBy —
  //    Workspace has no such field (schema.prisma lines 169-198).
  //    Tombstone-resurrect (Rule 1/3, 182-04 Task 2): the workspace row can be
  //    soft-deleted between runs (operator UI action — the E2E dev DB carried a
  //    2026-08-30 tombstone on 9a334821 that 404'd every upload/chat spec
  //    because documents.ts/chat routes filter deletedAt: null). findUnique
  //    sees the row regardless of deletedAt (no $extends soft-delete filter on
  //    the raw client), so "exists" alone is not enough — clear the tombstone
  //    the same D-05 either-branch-safe way the project lookup above does.
  const existingWs = await prisma.workspace.findUnique({ where: { id: WORKSPACE_ID } });
  if (!existingWs) {
    await prisma.workspace.create({
      data: { id: WORKSPACE_ID, projectId: project.id, name: "Elegregio" },
    });
    console.log(`[globalSetup] Seeded workspace ${WORKSPACE_ID} ("Elegregio")`);
  } else if (existingWs.deletedAt !== null) {
    await prisma.workspace.update({
      where: { id: WORKSPACE_ID },
      data: { deletedAt: null },
    });
    console.log(`[globalSetup] Revived tombstoned workspace ${WORKSPACE_ID} ("Elegregio")`);
  }

  // 3. Ensure admin has workspace access. CRITICAL: WorkspaceAccess has NO
  //    role field (schema.prisma lines 135-145 — only userId, workspaceId,
  //    grantedAt). Do NOT pass role: "owner" — that causes a Prisma "Unknown
  //    argument" error.
  const existingAccess = await prisma.workspaceAccess.findFirst({
    where: { userId: adminId, workspaceId: WORKSPACE_ID },
  });
  if (!existingAccess) {
    await prisma.workspaceAccess.create({
      data: { userId: adminId, workspaceId: WORKSPACE_ID },
    });
    console.log(`[globalSetup] Seeded WorkspaceAccess for admin on workspace ${WORKSPACE_ID}`);
  }

  // 4. Ensure at least one Chat exists in the workspace (so createChatId
  //    always finds >=1 chat even if the POST /chat fails).
  const existingChat = await prisma.chat.findFirst({
    where: { workspaceId: WORKSPACE_ID, deletedAt: null },
    select: { id: true },
  });
  if (!existingChat) {
    await prisma.chat.create({
      data: { workspaceId: WORKSPACE_ID, name: "E2E Seeded Chat" },
    });
    console.log(`[globalSetup] Seeded chat in workspace ${WORKSPACE_ID}`);
  }

  // 5. Seed a chat with user + assistant messages for edit/regenerate tests.
  //    The chat-edit-regenerate.spec.ts test needs both a user message (with
  //    an Edit button) and an assistant message (with a Regenerate button).
  //    We seed these directly via Prisma because the /chat endpoint triggers
  //    an LLM call which may not be available in CI.
  const EDIT_TEST_CHAT_NAME = "E2E Edit Test Chat";
  let editChat = await prisma.chat.findFirst({
    where: { workspaceId: WORKSPACE_ID, name: EDIT_TEST_CHAT_NAME, deletedAt: null },
    select: { id: true },
  });
  if (!editChat) {
    editChat = await prisma.chat.create({
      data: { workspaceId: WORKSPACE_ID, name: EDIT_TEST_CHAT_NAME },
      select: { id: true },
    });
    await prisma.chatMessage.createMany({
      data: [
        {
          chatId: editChat.id,
          role: "user",
          content: "What is the capital of Italy?",
        },
        {
          chatId: editChat.id,
          role: "assistant",
          content: "The capital of Italy is Rome.",
          metadata: JSON.stringify({ modelUsed: "e2e-test-model", providerUsed: "e2e" }),
        },
        {
          chatId: editChat.id,
          role: "user",
          content: "And what about France?",
        },
        {
          chatId: editChat.id,
          role: "assistant",
          content: "The capital of France is Paris.",
          metadata: JSON.stringify({ modelUsed: "e2e-test-model", providerUsed: "e2e" }),
        },
      ],
    });
    console.log(`[globalSetup] Seeded edit test chat ${editChat.id} with 4 messages`);
  }
}

/**
 * D-02: Seed the api_keys row matching the widget service WIDGET_API_KEY env.
 *  Moved from e2e/widget-embed.spec.ts:71-131 (seedWidgetApiKey). The
 *  apiKeyMiddleware delegates to validateApiKey, which accepts a key ONLY if
 *  an HMAC-SHA256 digest match exists in the api_keys table (Phase 163/SCALE-03
 *  — key_hash column) — if no row exists, widget-embed specs get 401.
 *
 * Phase 163 rewrite (RESEARCH Pitfall 3): the old path inlined bcrypt.hash/
 *  bcrypt.compare against the bcrypt hashedKey column. After the Plan 01
 *  migration drops hashedKey, that path throws "Unknown argument hashedKey"
 *  at runtime — every widget spec would 401 before any spec body ran. This
 *  rewrite computes key_hash = hmacSha256(WIDGET_API_KEY_PLAINTEXT) and writes
 *  data.key_hash (NOT data.hashedKey). Idempotency is findUnique({key_hash})
 *  (the digest is deterministic — if the env key didn't change, the digest
 *  didn't change; no update needed, unlike the old bcrypt re-hash path).
 *
 *  The HMAC helper is inlined here (getHmacSecret/hmacSha256 above) because
 *  globalSetup runs outside the server bundle — it cannot import from
 *  packages/server/src/services/apiKeyService. The inlined copy mirrors the
 *  exact Buffer.from(secret,"base64") contract (T-163-08).
 */
async function seedApiKey(prisma: PrismaClient, adminId: string): Promise<void> {
  const keyHash = hmacSha256(WIDGET_API_KEY_PLAINTEXT);
  const existing = await prisma.apiKey.findUnique({
    where: { key_hash: keyHash },
    select: { id: true },
  });
  if (existing) {
    // The digest is deterministic — same env key → same digest → row already
    // matches. No update needed (the old bcrypt path re-hashed if the env
    // key changed, but HMAC digests are deterministic so this is a true
    // no-op when the key is unchanged).
    return;
  }
  await prisma.apiKey.create({
    data: {
      name: "E2E Widget Service",
      prefix: WIDGET_API_KEY_PREFIX,
      key_hash: keyHash,
      createdBy: adminId,
    },
  });
  console.log(`[globalSetup] Seeded api_keys row for WIDGET_API_KEY (prefix=${WIDGET_API_KEY_PREFIX}, HMAC digest)`);
}

/**
 * Phase 185 (185-05 CR-01 e2e repair): the widgetTenantContext slot (185-02)
 * fail-closes 404 "Widget has no linked workspaces" when the Widget's
 * WidgetWorkspace whitelist is empty — the D-08 "org per principal, never
 * null" doctrine. The 182-era internal widget session-create route had NO
 * whitelist check, so the shared dev DB drifted to 0 widget_workspaces rows
 * without ever breaking the 182 UAT (the E2E intercepts browser→:3211
 * chat/stream, the loader catches config-fetch 404s, and session-create
 * skipped whitelists entirely). Against the 185 build the empty whitelist
 * 404s the fixture's own POST :3211/api/sessions → the whole widget-embed
 * suite fails at fixture setup.
 *
 * Heal: ensure the E2E Test Widget whitelists the seeded default-org
 * workspace (WORKSPACE_ID). Idempotent find-first → create — repeated runs
 * are no-ops. Harness-only (e2e/); zero production paths.
 */
async function seedWidgetWhitelist(prisma: PrismaClient): Promise<void> {
  const widget = await prisma.widget.findFirst({
    where: { name: E2E_WIDGET_NAME, deletedAt: null },
    select: { id: true },
  });
  if (!widget) {
    // No E2E widget (creation failed upstream) — nothing to whitelist.
    return;
  }
  const existing = await prisma.widgetWorkspace.findFirst({
    where: { widgetId: widget.id, workspaceId: WORKSPACE_ID },
    select: { widgetId: true },
  });
  if (existing) {
    return;
  }
  await prisma.widgetWorkspace.create({
    data: {
      widgetId: widget.id,
      workspaceId: WORKSPACE_ID,
      // WidgetWorkspace.organizationId is NOT NULL (M4) — derive from the
      // widget row per the D-08 chain (the row is default-org in this
      // harness; explicit DEFAULT fallback mirrors widgets.ts's createMany).
      organizationId: DEFAULT_ORG_ID,
    },
  });
  console.log(`[globalSetup] Seeded WidgetWorkspace whitelist (E2E widget → ${WORKSPACE_ID}) — the 185-02 tenant slot fail-closes on an empty whitelist`);
}

/**
 * Phase 182 (SAAS-01b, 182-PLAN-04 Task 1) — org-b fixture: the second-tenant
 * E2E harness seed. Pitfall 12 half-b: fixtures assuming one implicit org are
 * the classic post-migration failure — the Phase 185 leak-detector suites
 * depend on a second org existing NOW. Purely ADDITIVE: existing specs stay
 * default-org (their rows inherit DEFAULT_ORG_ID via the M4 column default)
 * and are untouched by this function.
 *
 * Every step is idempotent (upsert keyed on the stable fixture identity) so
 * repeated `pnpm test:e2e` runs are no-ops:
 *  1. Organization  — slug-keyed upsert ("org-b", fixture UUID …00bb).
 *  2. User          — username-keyed upsert (orgbuser / orgbuser@example.com).
 *                     TS-04 global uniqueness: email + username DIFFER from
 *                     every default-org fixture identity (admin, user,
 *                     widget-service) — two orgs' users never share a login
 *                     identity by construction.
 *  3. Membership    — find-first → tombstone-resurrect → create-with-P2002-
 *                     catch chain (182-PLAN-03 Rule 1 deviation: the partial
 *                     unique index organization_members_organizationId_userId_key
 *                     WHERE deletedAt IS NULL CANNOT arbitrate a composite-
 *                     unique upsert — Postgres 42P10). The resurrect arm
 *                     revives soft-deleted rows AND persists roleInOrg=owner
 *                     (WR-02 — removal downgrades, re-add re-grants) and works
 *                     with OR without the partial index (D-05 either-branch-
 *                     safe shape). roleInOrg "owner" is org-b's OWN owner —
 *                     the default org keeps having no owner (Phase 185
 *                     provisioning concern).
 *  4. Project       — org-b's OWN "OrgB Test Project" (organizationId ORG_B_ID,
 *                     createdBy orgbUser; tombstone-resurrect + P2002 tolerance;
 *                     NOT the default-org E2E Test Project — WR-03/G-182-03).
 *  5. Workspace     — id-keyed upsert (…00b1, "OrgB Workspace") — the Phase
 *                     185 cross-tenant leak target. organizationId is supplied
 *                     EXPLICITLY (org-b's own org, NOT the default), and the
 *                     update arm re-parents projectId on every run (WR-03 heal:
 *                     re-runs repair rows seeded by the pre-fix fixture that
 *                     still parent to the default-org project). The workspace
 *                     parent is org-b-owned so org resolution via
 *                     workspace→project yields org-b on every path.
 *
 * The default-org equivalence reference (DEFAULT_ORG_ID from
 * @simmetric-chat/shared) is imported for the Phase 185 adjacency probe:
 * ORG_B_ID is deliberately distinct from it — two orgs' rows never merge.
 *
 * E2E-relevant DB writes may use literal fixture UUIDs (test-fixture
 * allowance per the debt-table rule); the constants live in ./fixtures so
 * Phase 185 suites import the same single definitions.
 *
 * Zero production-path leak (threat T-182-15): this function and the ORG_B
 * constants exist ONLY under e2e/ — no seed.ts/seedService reference.
 */
async function seedOrgBFixture(prisma: PrismaClient): Promise<void> {
  // 1. Org B — slug-keyed upsert; a re-run hits the update arm (no-op).
  //    Safe to re-run: the create arm fires only when the slug is absent.
  await prisma.organization.upsert({
    where: { slug: ORG_B_SLUG },
    update: {},
    create: { id: ORG_B_ID, name: "Org B (E2E)", slug: ORG_B_SLUG },
  });
  console.log(`[globalSetup] org-b: organization ensured (id=${ORG_B_ID}, slug=${ORG_B_SLUG})`);

  // 2. Dedicated org-b user — username-keyed upsert. Email/username are
  //    globally unique and DIFFER from admin (admin@simmetric-chat.local /
  //    admin@example.com) and every other fixture identity (TS-04). Safe to
  //    re-run: existing user returns unchanged (password untouched).
  const orgbUser = await prisma.user.upsert({
    where: { username: ORG_B_USERNAME },
    update: {},
    create: {
      username: ORG_B_USERNAME,
      email: ORG_B_USER_EMAIL,
      passwordHash: await bcrypt.hash("orgbpass123", 10),
      salt: "e2e-orgb-salt",
    },
  });
  console.log(`[globalSetup] org-b: user ensured (id=${orgbUser.id}, username=${ORG_B_USERNAME})`);

  // 3. Membership — org-b's own owner. Composite-unique idempotency via the
  //    find-first → resurrect → create-with-P2002-catch chain (NOT upsert —
  //    the partial unique index forbids ON CONFLICT arbitration, Postgres
  //    42P10; see ensureDefaultOrgMembership in organizationService.ts for
  //    the full semantics + the e2e-layering note: globalSetup runs OUTSIDE
  //    the server bundle, so the helper is mirrored here rather than
  //    imported — same reasoning as the inline hmacSha256 copy above).
  //    The update arm resurrects tombstones (deletedAt: null) — works with
  //    OR without the partial index.
  const existingMembership = await prisma.organizationMember.findFirst({
    where: { organizationId: ORG_B_ID, userId: orgbUser.id, deletedAt: null },
  });
  if (!existingMembership) {
    const tombstone = await prisma.organizationMember.findFirst({
      where: { organizationId: ORG_B_ID, userId: orgbUser.id, deletedAt: { not: null } },
    });
    if (tombstone) {
      // Tombstone resurrect: flip deletedAt back to null AND persist
      // roleInOrg=owner (WR-02/G-182-02 — removal must downgrade; re-add
      // re-grants). P2002 here = a concurrent caller won — their row is
      // live, the outcome we want.
      try {
        await prisma.organizationMember.update({
          where: { id: tombstone.id },
          data: { deletedAt: null, roleInOrg: "owner" },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
      }
    } else {
      try {
        await prisma.organizationMember.create({
          data: { organizationId: ORG_B_ID, userId: orgbUser.id, roleInOrg: "owner" },
        });
      } catch (err) {
        // P2002 race tolerance (D-05 TOCTOU window): a concurrent seeder
        // created/resurrected the row — re-check and continue normally.
        if ((err as { code?: string }).code !== "P2002") throw err;
        const winner = await prisma.organizationMember.findFirst({
          where: { organizationId: ORG_B_ID, userId: orgbUser.id, deletedAt: null },
        });
        if (!winner) throw err;
      }
    }
    console.log(`[globalSetup] org-b: membership ensured (roleInOrg=owner)`);
  }

  // 4. Org-b's OWN project (WR-03/G-182-03): the workspace parent must live in
  //    org-b — the previous fixture reused the default-org "E2E Test Project",
  //    embedding the exact cross-org parent/child inconsistency the Phase 185
  //    leak-detectors exist to catch (workspaces.organizationId=…00bb under
  //    projects.organizationId=…0000). Tombstone-aware resurrect + P2002 race
  //    tolerance, same D-05 either-branch-safe shape as seedWorkspaceAndChat
  //    (projects_createdBy_name_key is a PLAIN unique — a soft-deleted row
  //    permanently blocks re-create). Lookup keys on BOTH createdBy and name —
  //    the same pair the plain unique arbitrates.
  const ORG_B_PROJECT_NAME = "OrgB Test Project";
  let project = await prisma.project.findFirst({
    where: { name: ORG_B_PROJECT_NAME, createdBy: orgbUser.id, deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    const tombstone = await prisma.project.findFirst({
      where: { name: ORG_B_PROJECT_NAME, createdBy: orgbUser.id, deletedAt: { not: null } },
      select: { id: true },
    });
    if (tombstone) {
      await prisma.project.update({
        where: { id: tombstone.id },
        data: { deletedAt: null },
      });
      project = { id: tombstone.id };
      console.log(`[globalSetup] org-b: revived tombstoned OrgB Test Project id=${project.id}`);
    }
  }
  if (!project) {
    try {
      project = await prisma.project.create({
        data: { name: ORG_B_PROJECT_NAME, createdBy: orgbUser.id, organizationId: ORG_B_ID },
        select: { id: true },
      });
      console.log(`[globalSetup] org-b: created OrgB Test Project id=${project.id}`);
    } catch (err) {
      // P2002 race tolerance: a concurrent seeder created the row between our
      // findFirst and create (TOCTOU window) — re-read and continue.
      if ((err as { code?: string }).code !== "P2002") throw err;
      const winner = await prisma.project.findFirst({
        where: { name: ORG_B_PROJECT_NAME, createdBy: orgbUser.id, deletedAt: null },
        select: { id: true },
      });
      if (!winner) throw err;
      project = winner;
      console.log(`[globalSetup] org-b: OrgB Test Project created concurrently, re-read id=${project.id}`);
    }
  }
  await prisma.workspace.upsert({
    where: { id: ORG_B_WORKSPACE_ID },
    update: { projectId: project.id },
    create: {
      id: ORG_B_WORKSPACE_ID,
      organizationId: ORG_B_ID,
      projectId: project.id,
      name: "OrgB Workspace",
    },
  });
  console.log(`[globalSetup] org-b: workspace ensured (id=${ORG_B_WORKSPACE_ID}, org=${ORG_B_ID}, project=${project.id})`);
  console.log(`[globalSetup] org-b: workspace re-parent heal applied (WR-03: update arm sets projectId — re-runs repair rows seeded by the pre-fix fixture)`);
}

/**
 * D-03: Clear admin mustChangePassword flag so the force-change modal never
 *  blocks spec navigation. Idempotent — updateMany is a no-op if no rows
 *  match (flag already cleared). Do NOT filter by deletedAt — User has no
 *  deletedAt field (schema.prisma lines 21-62).
 */
async function clearMustChangePassword(prisma: PrismaClient): Promise<void> {
  const result = await prisma.user.updateMany({
    where: { username: "admin", mustChangePassword: true },
    data: { mustChangePassword: false },
  });
  if (result.count > 0) {
    console.log(`[globalSetup] Cleared admin mustChangePassword (rows updated: ${result.count})`);
  }
}

/**
 * Find the admin user (same query as seedViaPrisma lines 81-85) and run all
 * three new seeding functions. Called from both the REST success path and
 * the Prisma fallback path so the fixtures are seeded regardless of which
 * widget-seeding path was taken.
 */
async function seedE2eFixtures(prisma: PrismaClient): Promise<void> {
  const admin = await prisma.user.findFirst({
    where: { roles: { some: { role: { name: { in: ["admin", "superuser"] } } } } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!admin) {
    console.error("[globalSetup] No admin user found — skipping E2E fixture seeding");
    return;
  }
  // Wizard-mode heal (Rule 1, 182-04 Task 2): the frontend renders the Setup
  // Wizard INSTEAD of the login page whenever
  // /api/system/is-initialized returns setupWizardMode="active" (App.tsx
  // wizard-vs-login gate) — even when an admin user exists. The shared dev
  // DB can carry a stale mode="active" row (operator/integration residue —
  // ensureSetupWizardMode never overwrites a non-empty value at boot), which
  // 404-proofed every adminPage fixture: the login form never mounts, so
  // button[type=submit] never appears (18 spec failures in the 182-04
  // first E2E attempt). State-machine invariant: admin exists ⇒ initialized
  // ⇒ mode MUST be "completed". Healing here mirrors the tombstone-resurrect
  // arms above — idempotent, either-branch-safe, harness-only.
  const wizardMode = await prisma.systemConfig.findUnique({
    where: { key: "setup_wizard_mode" },
    select: { value: true },
  });
  if (!wizardMode || wizardMode.value !== "completed") {
    await prisma.systemConfig.upsert({
      where: { key: "setup_wizard_mode" },
      create: { key: "setup_wizard_mode", value: "completed" },
      update: { value: "completed" },
    });
    console.log("[globalSetup] Healed setup_wizard_mode → completed (admin exists; stale/missing value was blocking the E2E login surface)");
  }
  await seedWorkspaceAndChat(prisma, admin.id);
  await seedApiKey(prisma, admin.id);
  await seedWidgetWhitelist(prisma);
  // Phase 182 (182-PLAN-04 Task 1): org-b fixture — additive second-tenant
  // seed for the Phase 185 leak-detector suites (Pitfall 12 half-b). Runs on
  // all three REST-path branches via seedE2eFixturesViaFreshClient.
  await seedOrgBFixture(prisma);
  await clearMustChangePassword(prisma);
}

export default async function globalSetup(): Promise<void> {
  let ctx: APIRequestContext | undefined;
  try {
    ctx = await pwRequest.newContext({ baseURL: SERVER_URL });

    // 0. Fresh-install path (CI: quick 260831-sqr): on an empty DB the boot
    //    derives setup_wizard_mode="active" and the bootstrap-admin seed
    //    skips (the wizard owns admin creation — seedService Phase 152).
    //    Initialize THROUGH the wizard's own endpoint so admin/admin123 exists
    //    for the login below. Idempotent: on an already-initialized DB the
    //    endpoint 404s (mode="completed") and the error is ignored.
    const initRes = await ctx.post("/api/system/initialize", {
      data: {
        username: "admin",
        email: "admin@example.com",
        password: "admin123",
        config: {},
      },
      timeout: 10000,
    }).catch(() => null);
    if (initRes && initRes.ok()) {
      console.log("[globalSetup] Initialized system via setup wizard (fresh DB) — admin/admin123 created");
    }

    // 1. Admin login
    const loginRes = await ctx.post("/api/auth/login", {
      data: { username: "admin", password: "admin123" },
      timeout: 10000,
    });
    if (!loginRes.ok()) {
      console.error(`[globalSetup] admin login failed (${loginRes.status()}) — trying Prisma fallback`);
      const fallbackId = await seedViaPrisma();
      if (fallbackId) process.env.E2E_WIDGET_ID = fallbackId;
      // Phase 103: seed E2E fixtures via a fresh Prisma client (the fallback
      // above disconnected its client in its finally block).
      await seedE2eFixturesViaFreshClient();
      return;
    }
    const { token } = (await loginRes.json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}` };

    // 2. Idempotency: reuse an existing E2E Test Widget if present
    const listRes = await ctx.get("/api/widgets", { headers, timeout: 10000 });
    if (listRes.ok()) {
      const widgets = (await listRes.json()) as Array<{ id: string; name: string }>;
      const existing = widgets.find(w => w.name === E2E_WIDGET_NAME);
      if (existing) {
        process.env.E2E_WIDGET_ID = existing.id;
        console.log(`[globalSetup] Reused existing E2E widget id=${existing.id}`);
        // Phase 103: seed E2E fixtures even when reusing the widget.
        await seedE2eFixturesViaFreshClient();
        return;
      }
    }

    // 3. Create the widget. allowedOrigins is a JSON-encoded string per
    //    createWidgetSchema (widget.schema.ts:49) — NOT an array.
    const createRes = await ctx.post("/api/widgets", {
      headers,
      data: {
        name: E2E_WIDGET_NAME,
        allowedOrigins: JSON.stringify([ALLOWED_ORIGIN]),
      },
      timeout: 10000,
    });
    if (!createRes.ok()) {
      const body = await createRes.text().catch(() => "<no body>");
      console.error(`[globalSetup] POST /api/widgets failed (${createRes.status()}): ${body} — trying Prisma fallback`);
      const fallbackId = await seedViaPrisma();
      if (fallbackId) process.env.E2E_WIDGET_ID = fallbackId;
      else console.error("[globalSetup] No widget seeded — widget-embed suite will fail");
      // Phase 103: seed E2E fixtures regardless of widget creation outcome.
      await seedE2eFixturesViaFreshClient();
      return;
    }
    const created = (await createRes.json()) as { id: string };
    process.env.E2E_WIDGET_ID = created.id;
    console.log(`[globalSetup] Seeded E2E widget id=${created.id}`);
    // Phase 103: seed E2E fixtures after successful widget creation.
    await seedE2eFixturesViaFreshClient();
  } finally {
    await ctx?.dispose();
  }
}

/**
 * Helper: create a fresh Prisma client (via loadDatabaseUrl + makeE2ePrisma),
 * run seedE2eFixtures, and disconnect. Used from all three REST-path branches
 * (login fail, widget reuse, widget create, widget create fail) so the
 * fixture seeding runs exactly once regardless of which branch was taken.
 */
async function seedE2eFixturesViaFreshClient(): Promise<void> {
  const databaseUrl = await loadDatabaseUrl();
  if (!databaseUrl) {
    console.error("[globalSetup] E2E fixture seeding skipped — DATABASE_URL not set");
    return;
  }
  const prisma = makeE2ePrisma(databaseUrl);
  try {
    await seedE2eFixtures(prisma);
  } catch (err) {
    console.error("[globalSetup] E2E fixture seeding failed:", err instanceof Error ? err.stack : String(err));
  } finally {
    await prisma.$disconnect();
  }
}