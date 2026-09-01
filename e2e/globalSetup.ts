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
import { makeE2ePrisma } from "./lib/prisma";
import type { PrismaClient } from "@prisma/client";

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
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const dotenv = (await import("dotenv")).default;
    const envPath = path.resolve(process.cwd(), ".env");
    dotenv.config({ path: envPath });
    if (process.env.DATABASE_URL) {
      return process.env.DATABASE_URL;
    }
    const fs = await import("node:fs");
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
  // 1. Find or create a Project for the admin
  let project = await prisma.project.findFirst({
    where: { name: "E2E Test Project", deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    project = await prisma.project.create({
      data: { name: "E2E Test Project", createdBy: adminId },
      select: { id: true },
    });
    console.log(`[globalSetup] Seeded E2E Test Project id=${project.id}`);
  }

  // 2. Ensure the hardcoded workspace exists. Do NOT pass createdBy —
  //    Workspace has no such field (schema.prisma lines 169-198).
  const existingWs = await prisma.workspace.findUnique({ where: { id: WORKSPACE_ID } });
  if (!existingWs) {
    await prisma.workspace.create({
      data: { id: WORKSPACE_ID, projectId: project.id, name: "Elegregio" },
    });
    console.log(`[globalSetup] Seeded workspace ${WORKSPACE_ID} ("Elegregio")`);
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
  await seedWorkspaceAndChat(prisma, admin.id);
  await seedApiKey(prisma, admin.id);
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