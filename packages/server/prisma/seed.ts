import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { DEFAULT_ROLE_MENU_SECTIONS, PERMISSION_NAMES, PROVIDER_PRESETS } from "@simmetric-chat/shared";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// KEEP IN SYNC with PERMISSION_NAMES in @simmetric-chat/shared
// The seed_rbac() SQL procedure is idempotent (ON CONFLICT DO NOTHING on all
// INSERTs). Re-running prisma db seed produces no duplicate permissions or
// role-permission links. The admin role is linked to all 31 PERMISSION_NAMES;
// the user role is linked to the 11 DEFAULT_USER_ROLE.permissions.
export async function seedRbac(): Promise<void> {
  // Build the permission values list from PERMISSION_NAMES (runtime-derived,
  // not hardcoded). Each entry is ('<name>', '<description>').
  const allPermissions = [
    { name: "workspace:read", description: "View workspaces and their contents" },
    { name: "workspace:write", description: "Create and modify workspaces" },
    { name: "workspace:delete", description: "Delete workspaces" },
    { name: "project:read", description: "View projects" },
    { name: "project:write", description: "Create and modify projects" },
    { name: "project:delete", description: "Delete projects" },
    { name: "chat:read", description: "View chats" },
    { name: "chat:write", description: "Send messages in chats" },
    { name: "chat:delete", description: "Delete chats" },
    { name: "document:read", description: "View documents" },
    { name: "document:write", description: "Upload and modify documents" },
    { name: "document:delete", description: "Delete documents" },
    { name: "admin:users", description: "Manage users and their access" },
    { name: "admin:settings", description: "Manage system settings" },
    { name: "admin:roles", description: "Manage roles and permissions" },
    { name: "project:create", description: "Create new projects" },
    { name: "workspace:create", description: "Create new workspaces" },
    { name: "provider:read", description: "View LLM providers" },
    { name: "provider:write", description: "Manage LLM providers" },
    { name: "archive:read", description: "View knowledge archives" },
    { name: "archive:write", description: "Create and modify knowledge archives" },
    { name: "archive:delete", description: "Delete knowledge archives" },
    { name: "backup:destination:read", description: "View backup destinations" },
    { name: "backup:destination:write", description: "Create, modify, and delete backup destinations" },
    { name: "backup:job:read", description: "View backup scheduled jobs" },
    { name: "backup:job:write", description: "Create, modify, toggle, run, and delete backup jobs" },
    { name: "backup:log:read", description: "View backup execution logs and download backup archives" },
    { name: "backup:restore:write", description: "Dry-run and execute restore from a backup log" },
    { name: "memory:read", description: "View per-user per-workspace memories" },
    { name: "memory:write", description: "Create and modify per-user per-workspace memories" },
    { name: "filters:manage", description: "Manage filter plugins (enable/disable)" },
  ];
  // Sanity check: the static list MUST match PERMISSION_NAMES from shared.
  if (allPermissions.length !== PERMISSION_NAMES.length) {
    throw new Error(
      `[seed] seedRbac permission list mismatch: seed.ts has ${allPermissions.length}, PERMISSION_NAMES has ${PERMISSION_NAMES.length}. KEEP IN SYNC with @simmetric-chat/shared.`,
    );
  }
  for (let i = 0; i < PERMISSION_NAMES.length; i++) {
    if (allPermissions[i]!.name !== PERMISSION_NAMES[i]) {
      throw new Error(
        `[seed] seedRbac permission mismatch at index ${i}: seed.ts has "${allPermissions[i]!.name}", PERMISSION_NAMES has "${PERMISSION_NAMES[i]!}". KEEP IN SYNC with @simmetric-chat/shared.`,
      );
    }
  }

  // Build the VALUES list for the INSERT INTO "permissions" statement.
  const permValues = allPermissions
    .map((p) => `('${p.name.replace(/'/g, "''")}', '${p.description.replace(/'/g, "''")}')`)
    .join(", ");

  // The user role permissions (DEFAULT_USER_ROLE.permissions — 11 entries).
  const userPerms = [
    "workspace:read", "chat:read", "chat:write", "document:read",
    "document:write", "archive:read", "provider:read", "project:create",
    "workspace:create", "memory:read", "memory:write",
  ];
  const userPermList = userPerms.map((p) => `'${p}'`).join(", ");

  const procedureSql = `
CREATE OR REPLACE FUNCTION seed_rbac() RETURNS void AS $$
DECLARE
  admin_role_id TEXT;
  user_role_id TEXT;
BEGIN
  -- Idempotent permission inserts (ON CONFLICT DO NOTHING).
  INSERT INTO "permissions" ("name", "description") VALUES
    ${permValues}
  ON CONFLICT ("name") DO NOTHING;

  -- Idempotent role inserts. gen_random_uuid() generates fresh IDs; existing
  -- roles (matched by name) are skipped via ON CONFLICT DO NOTHING.
  INSERT INTO "roles" ("id", "name", "description", "isDefault", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), 'admin', 'Full access to all features and settings', true, now(), now())
  ON CONFLICT ("name") DO NOTHING;
  INSERT INTO "roles" ("id", "name", "description", "isDefault", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), 'user', 'Standard user with limited access', true, now(), now())
  ON CONFLICT ("name") DO NOTHING;

  -- Resolve the role IDs (the rows may pre-exist from a prior seed).
  SELECT "id" INTO admin_role_id FROM "roles" WHERE "name" = 'admin';
  SELECT "id" INTO user_role_id FROM "roles" WHERE "name" = 'user';

  -- Link admin to ALL permissions (idempotent).
  INSERT INTO "role_permissions" ("roleId", "permissionName")
    SELECT admin_role_id, "name" FROM "permissions"
  ON CONFLICT ("roleId", "permissionName") DO NOTHING;

  -- Link user to the DEFAULT_USER_ROLE.permissions subset (idempotent).
  INSERT INTO "role_permissions" ("roleId", "permissionName")
    SELECT user_role_id, "name" FROM "permissions"
    WHERE "name" IN (${userPermList})
  ON CONFLICT ("roleId", "permissionName") DO NOTHING;
END;
$$ LANGUAGE plpgsql;`;

  await prisma.$executeRawUnsafe(procedureSql);
  await prisma.$executeRaw`SELECT seed_rbac()`;
  console.log(`[seed] Seeded RBAC via seed_rbac() procedure (${allPermissions.length} permissions, admin=all, user=${userPerms.length})`);
}

async function seedMenuSections() {
  for (const [roleName, sections] of Object.entries(DEFAULT_ROLE_MENU_SECTIONS)) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      console.warn(`[seed] Role "${roleName}" not found, skipping menu sections`);
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

    console.log(`[seed] Seeded ${sections.length} menu sections for role "${roleName}"`);
  }
}

// D-16 AUGMENT (not replace): the 12 existing placeholder entries are kept
// unchanged. 15 new curated entries with real URLs (D-15 approved) are appended
// below. Runtime/admin-owned fields (installCount, healthStatus,
// consecutiveFailures, lastHealthCheck) are intentionally absent from this
// array — they are NOT seeded at bootstrap per D-03 (air-gap: no phone-home).
export const MCP_CATALOG_ENTRIES = [
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
    // ─── D-15 approved curated entries (MCP-06) — real URLs, mixed tiers ───
    {
      id: "b1e3f4a2-0013-4000-8000-000000000013",
      name: "GitHub",
      url: "https://api.githubcopilot.com/mcp",
      transportType: "streamable-http",
      description: "Official GitHub MCP server for repository management, issues, pull requests, code search, and file operations via the GitHub Copilot endpoint.",
      category: "Software Development",
      version: "1.0.0",
      author: "GitHub",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0014-4000-8000-000000000014",
      name: "Stripe",
      url: "https://mcp.stripe.com/",
      transportType: "streamable-http",
      description: "Official Stripe MCP server for payment operations, customer management, subscription handling, and transaction queries.",
      category: "Payments",
      version: "1.0.0",
      author: "Stripe",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0015-4000-8000-000000000015",
      name: "Cloudflare Workers",
      url: "https://bindings.mcp.cloudflare.com/sse",
      transportType: "sse",
      description: "Official Cloudflare MCP server for managing Workers, KV stores, R2 buckets, D1 databases, and edge deployments.",
      category: "Software Development",
      version: "1.0.0",
      author: "Cloudflare",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0016-4000-8000-000000000016",
      name: "Cloudflare Observability",
      url: "https://observability.mcp.cloudflare.com/sse",
      transportType: "sse",
      description: "Official Cloudflare observability MCP server for querying analytics, logs, traffic metrics, and security events across Cloudflare services.",
      category: "Observability",
      version: "1.0.0",
      author: "Cloudflare",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0017-4000-8000-000000000017",
      name: "Notion",
      url: "https://mcp.notion.com/sse",
      transportType: "sse",
      description: "Official Notion MCP server for searching, reading, creating, and updating pages, databases, and blocks within Notion workspaces.",
      category: "Project Management",
      version: "1.0.0",
      author: "Notion",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0018-4000-8000-000000000018",
      name: "Linear",
      url: "https://mcp.linear.app/sse",
      transportType: "sse",
      description: "Official Linear MCP server for managing issues, projects, cycles, and labels. Supports search, creation, and status updates for agile workflows.",
      category: "Project Management",
      version: "1.0.0",
      author: "Linear",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0019-4000-8000-000000000019",
      name: "Sentry",
      url: "https://mcp.sentry.dev/sse",
      transportType: "sse",
      description: "Official Sentry MCP server for retrieving error events, stack traces, release information, and performance metrics from Sentry projects.",
      category: "Software Development",
      version: "1.0.0",
      author: "Sentry",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0020-4000-8000-000000000020",
      name: "Supabase",
      url: "https://mcp.supabase.com/mcp",
      transportType: "streamable-http",
      description: "Official Supabase MCP server for managing PostgreSQL databases, auth providers, storage buckets, and edge functions on the Supabase platform.",
      category: "Database",
      version: "1.0.0",
      author: "Supabase",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0021-4000-8000-000000000021",
      name: "Google Maps",
      url: "https://mapstools.googleapis.com/mcp",
      transportType: "streamable-http",
      description: "Official Google Maps MCP server for geocoding, reverse geocoding, directions, places search, and distance matrix queries.",
      category: "Mapping / Search",
      version: "1.0.0",
      author: "Google",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0022-4000-8000-000000000022",
      name: "Google BigQuery",
      url: "https://bigquery.googleapis.com/mcp",
      transportType: "streamable-http",
      description: "Official Google BigQuery MCP server for running SQL queries, exploring datasets, managing tables, and analyzing large-scale data warehouses.",
      category: "Data Analysis",
      version: "1.0.0",
      author: "Google",
      verificationTier: "official",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0023-4000-8000-000000000023",
      name: "Hugging Face",
      url: "https://hf.co/mcp",
      transportType: "streamable-http",
      description: "Verified community MCP server for browsing Hugging Face models, datasets, and Spaces. Supports model search, metadata retrieval, and inference endpoints.",
      category: "AI / Models",
      version: "1.0.0",
      author: "Hugging Face",
      verificationTier: "verified_community",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0024-4000-8000-000000000024",
      name: "Exa Search",
      url: "https://mcp.exa.ai/mcp",
      transportType: "streamable-http",
      description: "Verified community MCP server for Exa AI-powered web search. Provides real-time search results, content extraction, and similarity-based queries.",
      category: "Search",
      version: "1.0.0",
      author: "Exa",
      verificationTier: "verified_community",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0025-4000-8000-000000000025",
      name: "DeepWiki",
      url: "https://mcp.deepwiki.com/sse",
      transportType: "sse",
      description: "Verified community MCP server for DeepWiki documentation RAG. Queries wiki-style documentation across open-source repositories with semantic search.",
      category: "Documentation / RAG",
      version: "1.0.0",
      author: "Cognition Labs",
      verificationTier: "verified_community",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0026-4000-8000-000000000026",
      name: "Cloudflare Docs",
      url: "https://docs.mcp.cloudflare.com/sse",
      transportType: "sse",
      description: "Verified community MCP server for Cloudflare documentation. Provides searchable access to Cloudflare product docs, API references, and integration guides.",
      category: "Documentation",
      version: "1.0.0",
      author: "Cloudflare",
      verificationTier: "verified_community",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
    {
      id: "b1e3f4a2-0027-4000-8000-000000000027",
      name: "Semgrep",
      url: "https://mcp.semgrep.ai/sse",
      transportType: "sse",
      description: "Verified community MCP server for Semgrep static analysis (SAST). Scans code for security vulnerabilities, code quality issues, and compliance violations.",
      category: "Security / SAST",
      version: "1.0.0",
      author: "Semgrep",
      verificationTier: "verified_community",
      lastCommitDate: new Date("2026-07-01T00:00:00.000Z"),
      headers: "{}",
    },
  ];

// D-04: the upsert update branch MUST NOT include installCount,
// healthStatus, consecutiveFailures, or lastHealthCheck — these are
// admin/runtime-owned fields. Re-seeding must not clobber them.
export async function seedCatalogEntries(
  prismaClient?: { mcpCatalogEntry: { upsert: (args: unknown) => Promise<unknown> } },
) {
  const client = prismaClient || prisma;
  for (const entry of MCP_CATALOG_ENTRIES) {
    await client.mcpCatalogEntry.upsert({
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

  console.log(`[seed] Seeded ${MCP_CATALOG_ENTRIES.length} MCP catalog entries`);
}

// Provider preset catalog (quick task 260723-ps2). Idempotent upsert by slug.
// The update branch intentionally excludes no fields — preset constants are
// author-controlled and re-seeding should refresh name/baseUrl/defaultModel/
// docsUrl/description when the constants file changes. There are no
// admin/runtime-owned fields on ProviderPreset (unlike McpCatalogEntry which
// has installCount/healthStatus).
export async function seedProviderPresets(
  prismaClient?: { providerPreset: { upsert: (args: unknown) => Promise<unknown> } },
) {
  const client = prismaClient || prisma;
  for (const preset of PROVIDER_PRESETS) {
    await client.providerPreset.upsert({
      where: { slug: preset.id },
      update: {
        name: preset.name,
        type: preset.type,
        baseUrl: preset.baseUrl,
        defaultModel: preset.defaultModel,
        authMethod: preset.authMethod,
        docsUrl: preset.docsUrl,
        requiresOAuth: preset.requiresOAuth,
        category: preset.category,
        description: preset.description,
      },
      create: {
        slug: preset.id,
        name: preset.name,
        type: preset.type,
        baseUrl: preset.baseUrl,
        defaultModel: preset.defaultModel,
        authMethod: preset.authMethod,
        docsUrl: preset.docsUrl,
        requiresOAuth: preset.requiresOAuth,
        category: preset.category,
        description: preset.description,
      },
    });
  }

  console.log(`[seed] Seeded ${PROVIDER_PRESETS.length} provider presets`);
}

async function seedSystemConfig() {
  const defaults: Record<string, string> = {
    LLM_PROVIDER: "ollama",
    LLM_MODEL: "gemma4:latest",
    LLM_TEMPERATURE: "0.7",
    LLM_MAX_TOKENS: "4096",
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    VECTOR_DB_PROVIDER: "lancedb",
    SERVER_PORT: "3000",
    COLLECTOR_PORT: "3210",
    SESSION_EXPIRY: "86400000",
    ALLOW_REGISTRATION: "true",
    DISABLE_TELEMETRY: "true",
    BRANDING_APP_NAME: "Simmetric Chat",
    BRANDING_PRIMARY_COLOR: "#973C00",
  };

  for (const [key, value] of Object.entries(defaults)) {
    await prisma.systemConfig.upsert({
      where: { key },
      update: {}, // Don't override user-set values
      create: { key, value },
    });
  }

  console.log(`[seed] Seeded ${Object.keys(defaults).length} default config entries`);
}

async function seedServiceAccount() {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email: "widget@simmetric-chat.local" },
        { username: "widget-service" },
      ],
    },
  });
  if (existing) {
    console.log("[seed] Service account already exists, skipping");
    return;
  }

  const SALT_ROUNDS = 12;
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  // The widget service account authenticates via API key, never via password
  // login — seed a crypto-random secret that is never logged or disclosed.
  const passwordHash = await bcrypt.hash(
    crypto.randomBytes(32).toString("hex"),
    salt,
  );

  const user = await prisma.user.create({
    data: {
      username: "widget-service",
      email: "widget@simmetric-chat.local",
      passwordHash,
      salt,
    },
  });

  console.log(`[seed] Created service account: ${user.email}`);
}

async function seedAdminUser() {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email: "admin@simmetric-chat.local" },
        { username: "admin" },
      ],
    },
  });
  if (existing) {
    console.log("[seed] Admin user already exists, skipping");
    return;
  }

  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  if (!adminRole) {
    console.warn("[seed] Admin role not found, cannot seed admin user");
    return;
  }

  const SALT_ROUNDS = 12;
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const passwordHash = await bcrypt.hash("admin123", salt);

  const user = await prisma.user.create({
    data: {
      username: "admin",
      email: "admin@simmetric-chat.local",
      passwordHash,
      salt,
      mustChangePassword: true,
    },
  });

  await prisma.userRole.create({
    data: {
      userId: user.id,
      roleId: adminRole.id,
    },
  });

  console.log(
    '[seed] Created admin user (username: "admin", password: "admin123") — mustChangePassword=true, rotation forced at first login',
  );
}

async function seedUserUser() {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email: "user@simmetric-chat.local" },
        { username: "user" },
      ],
    },
  });
  if (existing) {
    console.log("[seed] Demo user already exists, skipping");
    return;
  }

  const userRole = await prisma.role.findUnique({ where: { name: "user" } });
  if (!userRole) {
    console.warn("[seed] User role not found, cannot seed demo user");
    return;
  }

  const SALT_ROUNDS = 12;
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const passwordHash = await bcrypt.hash("user123", salt);

  const user = await prisma.user.create({
    data: {
      username: "user",
      email: "user@simmetric-chat.local",
      passwordHash,
      salt,
    },
  });

  await prisma.userRole.create({
    data: {
      userId: user.id,
      roleId: userRole.id,
    },
  });

  console.log('[seed] Created demo user (username: "user", password: "user123")');
}

export async function main() {
  console.log("[seed] Starting database seed...");

  await seedRbac();
  await seedMenuSections();
  await seedCatalogEntries();
  await seedProviderPresets();
  await seedSystemConfig();
  await seedServiceAccount();
  await seedAdminUser();
  await seedUserUser();

  console.log("[seed] Seed completed successfully");
}

// Guard main() so the module is importable from unit tests without triggering
// the full seed pipeline. `prisma db seed` runs this file as the entry point
// (npx tsx prisma/seed.ts), so require.main === module is true in production.
if (require.main === module) {
  main()
    .catch((e) => {
      console.error("[seed] Seed failed:", e instanceof Error ? e.message : String(e));
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}