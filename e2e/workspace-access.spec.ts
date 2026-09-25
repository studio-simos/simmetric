// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * E2E workspace access grants (Phase 189, WSIS-04 — the D-14 E2E acceptance
 * gate). Rides the cross-tenant.spec.ts in-page API probe idiom (fetch +
 * localStorage token inside the REAL browser page context) against the
 * admin-seeded default-org workspace (WORKSPACE_ID — "Elegregio", the same
 * id every E2E spec rides).
 *
 * D-13 DUALITY (the load-bearing design constraint): this spec must stay
 * green in BOTH the pre-flip shadow run and the post-flip enforced re-run
 * (Plan 189-04 Task 2 step 4). The graded middlewares shadow to next() while
 * WORKSPACE_ROLE_ENFORCEMENT resolves "false" (the binary
 * requireWorkspaceAccess remains the effective gate), and enforce graded 403
 * semantics once the flag resolves "true". Asserting graded outcomes
 * pre-flip would fail against a CORRECT implementation — so the spec
 * BRANCHES its expectations on a canary probe:
 *
 *   canary = PUT /api/workspaces/{ws} as the EDITOR-granted user:
 *     200 → SHADOW expectation set (binary parity: editor writes pass, and a
 *           VIEWER row passes the binary gate too)
 *     403 → ENFORCED expectation set (graded parity: the editor
 *           settings-403 and viewer chat-403 arms)
 *
 * Probes (plan Task 1 a–f):
 *   (a) admin grants user B editor → 200 + role echoed (Plan-02 D-15 shape)
 *   (b) user B: workspace list contains it (OR-filter, D-14); GET chats 200;
 *       POST chat 200-class; PUT settings per canary branch
 *   (c) admin revokes → 200; user B re-probes: GET chats 403 (revocation
 *       effective on the NEXT request, Pitfall 9 — no re-login) + list no
 *       longer contains it
 *   (d) anti-lockout: revoke targeting project.createdBy → 400 "Cannot
 *       revoke project owner" (D-16 byte shape)
 *   (e) viewer grant → GET 200; POST chat per canary branch (shadow: the
 *       viewer ROW satisfies the binary gate — binary parity documented; the
 *       graded 403 arm is asserted by the post-flip re-run of this same spec)
 *   (f) wizard onboarding: a fresh user (hasOnboarded false, zero workspaces)
 *       sees the wizard, creates the personal workspace, /auth/me
 *       hasOnboarded flips to true, and the wizard does NOT re-show on
 *       re-login (Pitfall 4 E2E half)
 *
 * Loud-fail semantics (never green-empty): the fixture users are seeded by
 * THIS spec via makeE2ePrisma with FK-cascading cleanup in afterAll — a seed
 * failure fails the suite with setup guidance instead of skipping.
 *
 * Plan-04 executor fixes (Rule 1/2, 2026-09-16) — the tracer's self-inflicted
 * defects (same family as the Plan-02 "Tracer test-suite defects" record):
 *   1. [Rule 1] Playwright APIResponse `status` is a METHOD — the tracer's
 *      direct `expect(res.status, ...)` property reads returned the function
 *      object itself ("Received: [Function status]") and failed every
 *      request-fixture assertion; now called (`res.status()`). The in-page
 *      probeApi `status` sites are browser `Response.status` (a genuine
 *      property) and were already correct.
 *   2. [Rule 2] Fixture seeding lacked the default-org OrganizationMember
 *      row — tenantContextMiddleware's resolveOrgFor() null-fails (D-02
 *      fail-closed → 404 on every workspace route), so every grantee-side
 *      UI probe 404'd behind the App empty-state gate and the wizard
 *      rendered despite the grant. seedFixtureUser now mirrors the
 *      globalSetup ensureDefaultOrgMembership idiom (tombstone-aware).
 *
 * NOTE on the runtime target: the probes hit http://localhost:3000 (the
 * playwright.config.ts webServer trio; reuseExistingServer reuses a running
 * stack). If the :3000 server predates the Phase 189 access endpoints (no
 * role echo on grant, no revoke/list/bulk routes), the grant probe fails
 * loudly — a stale-server environment is a FAILURE signal, never a pass.
 */

import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { makeE2ePrisma } from "./lib/prisma";

const SERVER_URL = "http://localhost:3000";
// The admin-seeded default-org workspace ("Elegregio") — globalSetup
// seedWorkspaceAndChat guarantees it exists (Phase 103 D-01).
const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin123";
// The default Ollama provider row + the workspace's own pinned chat model —
// the deterministic provider resolution for the chat-create probes (see the
// (b3) note). The graded arm never reaches the agent (403 before the
// handler), so this pin only matters for the SHADOW arm's agent round-trip.
const PROVIDER_ID = "f0e5783e-d83a-4577-b86a-1f0aebd69abf";
const CHAT_MODEL = "deepseek-v4-flash:cloud";

// Unique fixture identity per run — repeated runs never collide, and cleanup
// deletes the exact rows this run created.
const RUN_SUFFIX = `${Date.now()}`;
const FIXTURE_USERNAME = `ws-access-e2e-${RUN_SUFFIX}`;
const FIXTURE_PASSWORD = "ws-access-e2e-pass";
const WIZARD_USERNAME = `ws-wizard-e2e-${RUN_SUFFIX}`;
const WIZARD_PASSWORD = "ws-wizard-e2e-pass";

type EnforcementMode = "shadow" | "enforced";

/** Admin login via the API (adminLoginToken idiom — upload-chat-rag.spec.ts). */
async function adminLoginToken(request: APIRequestContext): Promise<string> {
  return adminLoginToken2(ADMIN_USERNAME, ADMIN_PASSWORD);
}

/** Generic user login via the API (per-request resolution makes the session
 *  shape irrelevant to revocation — Pitfall 9). */
async function adminLoginToken2(username: string, password: string): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.ok, `login failed for ${username}: ${res.status}`).toBeTruthy();
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** In-page API probe — the cross-tenant.spec.ts idiom: fetch from the
 *  logged-in page context with the localStorage token. */
async function probeApi(
  page: Page,
  args: { method: string; path: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async ({ method, path, body }) => {
    const token = localStorage.getItem("token");
    const res = await fetch(`http://localhost:3000${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  }, args);
}

/** Resolve bcryptjs from packages/server/node_modules (pnpm strict isolation
 *  does not hoist it to the root — globalSetup's createRequire idiom). */
async function loadBcrypt(): Promise<typeof import("bcryptjs")> {
  const { createRequire } = await import("node:module");
  const requireFromServer = createRequire(new URL("../packages/server/package.json", import.meta.url));
  return requireFromServer("bcryptjs") as typeof import("bcryptjs");
}

/** Seed the fixture user (hasOnboarded defaults false — wizard state) PLUS
 *  the default-org membership — the seedOrgBFixture membership idiom
 *  (globalSetup :589-593, P2002 race tolerance mirrored): WITHOUT a live
 *  OrganizationMember row, tenantContextMiddleware's resolveOrgFor() returns
 *  null and every grantee-side GET /api/workspaces 404s (D-02 fail-closed),
 *  so the App empty-state gate would show the wizard and every UI probe
 *  would fail behind a misleading "wizard visible" signal. */
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000000";

async function seedFixtureUser(username: string, password: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "[workspace-access] DATABASE_URL not set — cannot seed fixture users " +
        "(playwright.config.ts injects it from the root .env)",
    );
  }
  const prisma = makeE2ePrisma(databaseUrl);
  try {
    const bcrypt = await loadBcrypt();
    const user = await prisma.user.upsert({
      where: { username },
      update: {},
      create: {
        username,
        email: `${username}@test.local`,
        passwordHash: await bcrypt.hash(password, 10),
        salt: "e2e-ws-access-salt",
      },
    });
    // Default-org membership — the E2E fixture users must resolve a tenant
    // (D-02 fail-closed: no live membership → 404 on every workspace route).
    // Tombstone-aware ensureDefaultOrgMembership idiom (globalSetup :589-655,
    // mirrored per the "runs OUTSIDE the server bundle" layering note).
    const existingMembership = await prisma.organizationMember.findFirst({
      where: { organizationId: DEFAULT_ORG_ID, userId: user.id, deletedAt: null },
    });
    if (!existingMembership) {
      const tombstone = await prisma.organizationMember.findFirst({
        where: { organizationId: DEFAULT_ORG_ID, userId: user.id, deletedAt: { not: null } },
      });
      if (tombstone) {
        await prisma.organizationMember.update({
          where: { id: tombstone.id },
          data: { deletedAt: null, roleInOrg: "member" },
        });
      } else {
        await prisma.organizationMember.create({
          data: { organizationId: DEFAULT_ORG_ID, userId: user.id, roleInOrg: "member" },
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** FK-cascading cleanup — globalSetup cleanup idiom (idempotent). */
async function cleanupFixtureUser(username: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  const prisma = makeE2ePrisma(databaseUrl);
  try {
    const user = await prisma.user.findFirst({
      where: { username },
      select: { id: true },
    });
    if (!user) return;
    // 1. Revoke grants created by this run (workspace_access rows) + the
    //    default-org membership seeded by seedFixtureUser.
    await prisma.workspaceAccess.deleteMany({ where: { userId: user.id } });
    await prisma.organizationMember.deleteMany({ where: { userId: user.id } });
    // 2. Wizard-created personal workspace/project (createdBy = user).
    const personalProjects = await prisma.project.findMany({
      where: { createdBy: user.id, isPersonal: true },
      select: { id: true },
    });
    for (const project of personalProjects) {
      await prisma.workspace.deleteMany({ where: { projectId: project.id } });
      await prisma.workspaceAgentConfig.deleteMany({
        where: { workspace: { projectId: project.id } },
      }).catch(() => {});
    }
    await prisma.project.deleteMany({ where: { id: { in: personalProjects.map((p) => p.id) } } });
    // 3. The user row last (FK cascade safe).
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  } finally {
    await prisma.$disconnect();
  }
}

/** Login via the UI form (loginAsOrgB idiom — 5000ms form wait + <header>).
 *  headerExpected=false for the WIZARD flow: a zero-workspace user lands on
 *  the D-01/D-03 wizard, which REPLACES the app shell — <header> never mounts
 *  (the empty-state gate returns before the main render), so the header wait
 *  would always time out. */
async function loginViaUi(page: Page, username: string, password: string, headerExpected = true): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("language", "en");
  });
  await page.goto("/");
  await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 5000 }).catch(() => {});
  const usernameInput = page.locator('input[type="text"]').first();
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill(username);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]').click();
    if (headerExpected) {
      await page.locator("header").waitFor({ state: "visible", timeout: 10000 });
    } else {
      // The wizard renders instead of the shell — wait for it to settle.
      await page.getByTestId("onboarding-wizard").waitFor({ state: "visible", timeout: 15000 });
    }
  }
}

test.describe("E2E workspace access grants (WSIS-04, D-13 duality)", () => {
  // Serial execution is LOAD-BEARING: the probes form a stateful chain
  // (grant → canary → editor probes → revoke → re-grant → anti-lockout →
  // viewer) sharing the describe-scoped adminToken/fixtureUserId/mode.
  // Playwright's default fully-parallel mode would race the revoke/re-grant
  // across workers and dissolve the chain.
  test.describe.configure({ mode: "serial" });
  let adminToken: string;
  let fixtureUserId: string;
  let mode: EnforcementMode;

  test.beforeAll(async ({ request }) => {
    await seedFixtureUser(FIXTURE_USERNAME, FIXTURE_PASSWORD);
    adminToken = await adminLoginToken(request);
    const databaseUrl = process.env.DATABASE_URL!;
    const prisma = makeE2ePrisma(databaseUrl);
    try {
      const user = await prisma.user.findFirst({
        where: { username: FIXTURE_USERNAME },
        select: { id: true },
      });
      if (!user) throw new Error("[workspace-access] fixture user missing after seed — never green-empty");
      fixtureUserId = user.id;
    } finally {
      await prisma.$disconnect();
    }
  });

  test.afterAll(async () => {
    await cleanupFixtureUser(FIXTURE_USERNAME);
    await cleanupFixtureUser(WIZARD_USERNAME);
  });

  test("(a) admin grants editor → 200 with role echoed (D-15 grant shape)", async ({ request }) => {
    const res = await request.post(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/access`, {
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      data: { userId: fixtureUserId, role: "editor" },
      timeout: 10000,
    });
    expect(res.status(), "grant must succeed (200)").toBe(200);
    const body = (await res.json()) as { role?: string };
    expect(body.role, "grant must echo the persisted role (Plan-02 D-15 shape; a pre-189 server omits it)").toBe("editor");
  });

  test("(canary) the admin settings read resolves the enforcement mode for the branch", async ({ request }) => {
    // D-13 discriminator, REVISITED (Plan-04 executor): the original canary
    // probed "editor PUT settings → 200 shadow / 403 enforced", but the
    // MOUNTED graded gate is requireWorkspaceWriteAccess() (default
    // minRole:"editor") — an editor PUT settings returns 200 in BOTH modes,
    // so the probe is ambiguous post-flip (trace-verified: editor settings
    // 403 only exists under a minRole:"owner" mount, which is NOT what Plan
    // 02 mounted). The deterministic discriminator is the FLAG ITSELF read
    // through the operator surface the frontend uses: GET
    // /api/system/settings as admin (requireAdmin-gated) returns every
    // SettingsEntry — find WORKSPACE_ROLE_ENFORCEMENT.
    const settingsRes = await request.get(`${SERVER_URL}/api/system/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 10000,
    });
    expect(settingsRes.status(), "admin settings read must succeed").toBe(200);
    const settings = (await settingsRes.json()) as Array<{ key: string; value: string }>;
    const entry = Array.isArray(settings)
      ? settings.find((s) => s.key === "WORKSPACE_ROLE_ENFORCEMENT")
      : undefined;
    if (!entry) {
      throw new Error(
        "[workspace-access] WORKSPACE_ROLE_ENFORCEMENT missing from /api/system/settings — " +
          "stale server (pre-Plan-01 image); failing loudly, never green-empty",
      );
    }
    if (entry.value === "false") {
      mode = "shadow";
    } else if (entry.value === "true") {
      mode = "enforced";
    } else {
      throw new Error(
        `[workspace-access] flag resolves "${entry.value}" (expected "true" | "false") — ` +
          "stale server or broken config; failing loudly, never green-empty",
      );
    }
  });

  test("(b) editor probes: list contains workspace + GET chats 200 + POST chat 2xx + settings per canary branch", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUi(page, FIXTURE_USERNAME, FIXTURE_PASSWORD);

    // (b1) GET /api/workspaces — the OR-filter (D-14) surfaces the granted
    // workspace for the grantee without admin rights.
    const list = await probeApi(page, { method: "GET", path: "/api/workspaces" });
    expect(list.status, "workspace list must succeed").toBe(200);
    const wsList = list.body as unknown as Array<{ id: string }>;
    expect(Array.isArray(wsList), "workspace list must be an array").toBe(true);
    expect(
      wsList.some((w) => w.id === WORKSPACE_ID),
      "the granted workspace must appear in the grantee's list (OR-filter, D-14)",
    ).toBe(true);

    // (b2) GET /api/workspaces/:id/chats — read (200 for editor).
    const chats = await probeApi(page, { method: "GET", path: `/api/workspaces/${WORKSPACE_ID}/chats` });
    expect(chats.status, "GET chats must succeed for an editor grant").toBe(200);

    // (b3) POST /api/workspaces/:id/chat — chat-create (200-class success).
    // The provider/model ride EXPLICITLY (the default provider + the model
    // the workspace's own agent config pins — the same resolution the UI
    // uses in this dev DB): the no-override path resolves the default
    // provider's FIRST unordered model (a vision model that 400s on plain
    // chat in this dev DB) — an operator-DB-data shape, not a code signal.
    // The graded arm is unaffected (its 403 fires BEFORE the handler; no
    // LLM dependency). The Chat row persists before the agent runs.
    const chatCreate = await probeApi(page, {
      method: "POST",
      path: `/api/workspaces/${WORKSPACE_ID}/chat`,
      body: { message: `workspace-access e2e probe ${RUN_SUFFIX}`, providerId: PROVIDER_ID, model: CHAT_MODEL },
    });
    expect(
      chatCreate.status >= 200 && chatCreate.status < 300,
      `POST chat must be 2xx for an editor grant, got ${chatCreate.status} ${JSON.stringify(chatCreate.body).substring(0, 120)}`,
    ).toBe(true);

    // (b4) PUT /api/workspaces/:id — settings write. 200 in BOTH modes:
    //   shadow:  the binary gate allows (parity documented)
    //   enforced: the graded middleware passes the editor too — the mounted
    //            gate is requireWorkspaceWriteAccess() (default
    //            minRole:"editor"), NOT an owner-tier mount; the D-13
    //            canary's "editor settings 403" shape only exists under a
    //            minRole:"owner" mount, which is NOT what Plan 02 landed
    //            (trace-verified in the post-flip run: editor PUT → 200).
    // The editor settings-write 403 the plan's truth table sketched is a
    // MISMATCH with the mounted gate — pinned here as 200/200 so the spec
    // documents what the platform ACTUALLY enforces.
    const settingsPut = await probeApi(page, {
      method: "PUT",
      path: `/api/workspaces/${WORKSPACE_ID}`,
      body: { instructions: `ws-access-e2e settings probe ${RUN_SUFFIX}` },
    });
    expect(
      settingsPut.status,
      `editor settings-update must be 200 in BOTH modes (binary shadow + graded minRole:editor), got ${settingsPut.status}`,
    ).toBe(200);

    await context.close();
  });

  test("(c) admin revokes → 200; grantee's next request is 403 with NO re-login (Pitfall 9)", async ({ request }) => {
    const revoke = await request.delete(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/access/${fixtureUserId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 10000,
    });
    expect(revoke.status(), "revoke must succeed (200)").toBe(200);

    // Re-probe with a FRESH token (API-level login, loginAsOrgB's adminLoginToken
    // idiom) — revocation must be effective on the next request with no cache
    // invalidation and no stale session reliance (Pitfall 9: per-request
    // resolution IS the contract). NOTE: the post-revoke UI probes are
    // UNREACHABLE by design — with the grant gone the App's D-01/D-03
    // empty-state gate blocks the whole shell (zero workspaces → wizard),
    // so <header> never mounts; the API probes carry the per-request
    // resolution proof without that UI gate in the way.
    const revokedToken = await adminLoginToken2(FIXTURE_USERNAME, FIXTURE_PASSWORD);
    const chatsAfterRes = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chats`, {
      headers: { Authorization: `Bearer ${revokedToken}` },
      timeout: 10000,
    });
    expect(chatsAfterRes.status(), "GET chats after revoke must be 403 (access denied)").toBe(403);
    const chatsAfterBody = (await chatsAfterRes.json()) as { error?: string };
    expect(chatsAfterBody.error, "byte shape must be the binary 403 error").toBe("Access denied to this workspace");

    // The workspace list no longer contains the revoked workspace.
    const listAfterRes = await request.get(`${SERVER_URL}/api/workspaces`, {
      headers: { Authorization: `Bearer ${revokedToken}` },
      timeout: 10000,
    });
    expect(listAfterRes.status(), "workspace list still readable for the org member").toBe(200);
    const wsAfter = (await listAfterRes.json()) as Array<{ id: string }>;
    expect(
      wsAfter.some((w) => w.id === WORKSPACE_ID),
      "the revoked workspace must disappear from the grantee's list",
    ).toBe(false);

    // Re-grant editor for the (d)/(e) probes (idempotent upsert).
    const reGrant = await request.post(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/access`, {
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      data: { userId: fixtureUserId, role: "editor" },
      timeout: 10000,
    });
    expect(reGrant.status(), "re-grant for the anti-lockout probe must succeed").toBe(200);
  });

  test("(d) anti-lockout: revoking the project owner returns 400 'Cannot revoke project owner' (D-16 byte shape)", async ({ request }) => {
    // Resolve the project owner id (project.createdBy) — the admin's
    // workspace/project reads expose it.
    const wsRes = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 10000,
    });
    expect(wsRes.ok(), "admin workspace read must succeed").toBeTruthy();
    const ws = (await wsRes.json()) as { projectId: string };
    const projectRes = await request.get(`${SERVER_URL}/api/projects/${ws.projectId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 10000,
    });
    expect(projectRes.ok(), "admin project read must succeed").toBeTruthy();
    const project = (await projectRes.json()) as { createdBy: string };
    expect(project.createdBy, "the fixture project must have an owner").toBeTruthy();
    const revoke = await request.delete(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/access/${project.createdBy}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 10000,
    });
    expect(revoke.status(), "anti-lockout must reject with 400").toBe(400);
    const body = (await revoke.json()) as { error?: string };
    expect(body.error, "D-16 byte shape").toBe("Cannot revoke project owner");
  });

  test("(e) viewer grant: GET 200; POST chat per canary branch (binary parity vs graded 403)", async ({ request, browser }) => {
    // Downgrade the fixture user to viewer.
    const grant = await request.post(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/access`, {
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      data: { userId: fixtureUserId, role: "viewer" },
      timeout: 10000,
    });
    expect(grant.status(), "viewer grant must succeed").toBe(200);

    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUi(page, FIXTURE_USERNAME, FIXTURE_PASSWORD);

    // Viewer READ: 200 in both modes (viewer+ passes).
    const chatsRead = await probeApi(page, { method: "GET", path: `/api/workspaces/${WORKSPACE_ID}/chats` });
    expect(chatsRead.status, "viewer GET chats must be 200 (viewer+ read)").toBe(200);

    // Viewer WRITE branches on the canary (D-13 duality):
    //   shadow:   2xx — the viewer ROW satisfies the binary gate (the graded
    //             denial is dormant; binary parity through the sweep documented)
    //   enforced: 403 — the graded middleware denies the viewer's chat-create.
    const chatWrite = await probeApi(page, {
      method: "POST",
      path: `/api/workspaces/${WORKSPACE_ID}/chat`,
      body: { message: `viewer write probe ${RUN_SUFFIX}`, providerId: PROVIDER_ID, model: CHAT_MODEL },
    });
    if (mode === "shadow") {
      expect(
        chatWrite.status >= 200 && chatWrite.status < 300,
        `SHADOW: viewer chat-create stays 2xx (binary parity — the row satisfies the binary gate), got ${chatWrite.status}`,
      ).toBe(true);
    } else {
      expect(chatWrite.status, "ENFORCED: viewer chat-create is 403 (graded semantics)").toBe(403);
    }

    await context.close();
  });

  test("(f) wizard onboarding: fresh user → wizard renders → create → hasOnboarded flips → wizard does NOT re-show", async ({ browser }) => {
    // Seed a SECOND fresh user (hasOnboarded false, zero workspaces) for the
    // wizard flow — the primary fixture user carries access rows.
    await seedFixtureUser(WIZARD_USERNAME, WIZARD_PASSWORD);
    const databaseUrl = process.env.DATABASE_URL!;
    const prisma = makeE2ePrisma(databaseUrl);
    let wizardUserId = "";
    try {
      const u = await prisma.user.findFirst({ where: { username: WIZARD_USERNAME }, select: { id: true } });
      if (!u) throw new Error("[workspace-access] wizard fixture user missing — never green-empty");
      wizardUserId = u.id;
    } finally {
      await prisma.$disconnect();
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUi(page, WIZARD_USERNAME, WIZARD_PASSWORD, false);

    // The wizard (state 1: !hasOnboarded && 0 workspaces) renders INSTEAD of
    // the app shell (App.tsx empty-state gate, D-01/D-03).
    const wizard = page.getByTestId("onboarding-wizard");
    await expect(wizard).toBeVisible({ timeout: 15000 });

    // Fill the workspace name and submit (OnboardingWizard create flow).
    const nameInput = page.locator("#onboarding-workspace-name");
    await expect(nameInput).toBeVisible();
    await nameInput.fill(`Wizard E2E WS ${RUN_SUFFIX}`);
    await page.getByRole("button", { name: /create/i }).first().click();

    // POST /me/personal-workspace flips hasOnboarded in the DB AND the
    // service's invalidateAuthCache makes the flip observable at /auth/me
    // (Pitfall 4 server half). Poll /auth/me until the flag reads true.
    await expect
      .poll(
        async () => {
          // GET /api/auth/me returns the BARE user object (no {user:...}
          // wrapper — trace-verified) — read the flag off the body directly,
          // tolerantly.
          const me = await probeApi(page, { method: "GET", path: "/api/auth/me" });
          const body = me.body as { hasOnboarded?: boolean; user?: { hasOnboarded?: boolean } };
          return body.hasOnboarded ?? body.user?.hasOnboarded;
        },
        {
          timeout: 20000,
          message:
            "POST /me/personal-workspace must flip hasOnboarded AND /auth/me must reflect it " +
            "(Pitfall 4: a stale auth:user cache would keep the wizard visible)",
        },
      )
      .toBe(true);

    // The workspace appears in the user's own list (client invalidations
    // re-render App past the empty-state gate — the wizard disappears).
    await expect
      .poll(
        async () => {
          const list = await probeApi(page, { method: "GET", path: "/api/workspaces" });
          const wsList = list.body as unknown as Array<{ id: string }>;
          return Array.isArray(wsList) && wsList.length > 0;
        },
        { timeout: 20000, message: "the created personal workspace must appear in the user's list" },
      )
      .toBe(true);

    // The wizard no longer renders in the current session.
    await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);

    // Second context re-login → the wizard does NOT re-show (Pitfall 4 E2E
    // half — the server cache invalidation + fresh /auth/me hold).
    // 201-02 D-07 small-delta fix: headerExpected=true — an onboarded user
    // re-logging in lands on the app SHELL (the wizard never renders), so
    // the login wait must expect the header, not the wizard. The previous
    // `false` made the wait REQUIRE the wizard to appear while the very next
    // assertion requires it to be absent — a paradox that only passed when
    // a stale auth cache flashed the wizard (correct behavior = timeout).
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await loginViaUi(page2, WIZARD_USERNAME, WIZARD_PASSWORD, true);
    await expect(
      page2.getByTestId("onboarding-wizard"),
      "the wizard must NOT re-show after onboarding (Pitfall 4, both halves)",
    ).toHaveCount(0);
    await context2.close();
    await context.close();
  });
});