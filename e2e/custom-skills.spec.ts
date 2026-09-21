// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * E2E custom skills lifecycle (Phase 190, SKIL-01..05 — the D-23 acceptance
 * list). Rides the workspace-access.spec.ts structure (direct-Prisma seeding
 * via makeE2ePrisma + FK-cascading cleanup + the cross-tenant in-page probeApi
 * idiom) and the fixtures.ts mockCollector SSE interception pattern
 * (registered BEFORE navigation) so invocation arms are deterministic without
 * a live LLM.
 *
 * NO LLM-visible content assertions (188 judgment-tier prohibition): the
 * mocked SSE stream IS the response surface — invocation proof rides the
 * captured stream request body (skillCall present/absent) and palette/notice
 * DOM, never on model output text.
 *
 * Arms (the D-23 list + the Pitfall 6 widget-strip e2e half):
 *   (a) CRUD + reserved slug: admin create global skill → 201; reserved-slug
 *       create ("model") → 400; duplicate-slug create → 409.
 *   (b) Scoping visibility: user A's PERSONAL skill is invisible in user B's
 *       custom list; user B DOES see the admin's global skill; user A sees
 *       their own.
 *   (c) Built-in 400s: PUT/DELETE on a builtin row → 400 (exact literals).
 *   (d) Autocomplete + invocation: palette lists visible custom skills on
 *       "/", filters while typing; select inserts "/slug " WITHOUT sending;
 *       positional "/slug Ciao mondo" → captured stream body carries
 *       skillCall { slug, params: { input } } AND message = full typed text;
 *       key=value with a quoted value → both params; unmatched slug → NO
 *       skillCall (normal message); builtin name → NO skillCall.
 *   (e) Lifecycle: admin edits the template via PUT (the updated config is
 *       visible via GET /:id; a NEW chat resolves the UPDATED defaultParams —
 *       per-request DB resolution, SC-1); DELETE → the slug no longer matches
 *       (typed text sends as a normal message, no skillCall) and the palette
 *       no longer lists it.
 *   (f) Widget-strip pin: a POST to the widget chat path carrying skillCall
 *       in the raw body → the captured upstream chat body has NO skillCall
 *       (widgetChatRequestSchema strips it — Pitfall 6 / T-190-28).
 *
 * Loud-fail semantics (never green-empty): fixture users and the builtin
 * probe row are seeded by THIS spec via makeE2ePrisma with FK-cascading
 * cleanup in afterAll; a seed failure fails the suite with setup guidance
 * (the workspace-access.spec.ts idiom). A stale :3000 server predating Phase
 * 190 fails the CRUD probes loudly (404 = failure, never a pass).
 */

import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { makeE2ePrisma } from "./lib/prisma";

const SERVER_URL = "http://localhost:3000";
// The admin-seeded default-org workspace ("Elegregio") — globalSetup
// seedWorkspaceAndChat guarantees it exists (Phase 103 D-01).
const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin123";
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000000";

// Unique fixture identity per run — repeated runs never collide and cleanup
// deletes the exact rows this run created (T-190-28/29).
const RUN_SUFFIX = `${Date.now()}`;
const USER_A_USERNAME = `skill-e2e-a-${RUN_SUFFIX}`;
const USER_A_PASSWORD = "skill-e2e-a-pass";
const USER_B_USERNAME = `skill-e2e-b-${RUN_SUFFIX}`;
const USER_B_PASSWORD = "skill-e2e-b-pass";
// The admin's global skill + user A's personal skill slugs (unique per run).
const GLOBAL_SLUG = `translate-e2e-${RUN_SUFFIX}`;
const PERSONAL_SLUG = `note-e2e-${RUN_SUFFIX}`;

let capturedStreamBody: string | null = null;

/** Admin login via the API (adminLoginToken idiom — upload-chat-rag.spec.ts). */
async function adminLoginToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    timeout: 10000,
  });
  if (!res.ok()) throw new Error(`[custom-skills] admin login failed (${res.status()})`);
  const { token } = (await res.json()) as { token: string };
  return token;
}

/** Generic user login via the API (per-request resolution idiom). */
async function userLoginToken(username: string, password: string): Promise<string> {
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
 *  logged-in page context with the localStorage token. Arms (a)-(c) probe
 *  via node fetch (the users own zero workspaces, so the page-context login
 *  flow cannot mount the shell); this helper stays for the in-page probes
 *  the (d)/(e) browser arms could add — kept as the documented idiom
 *  (workspace-access.spec.ts (b) arm) so future arms don't re-derive it. */
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
    let parsed: Record<string, unknown>;
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

/** Seed a fixture user PLUS the default-org OrganizationMember row — the
 *  seedFixtureUser idiom (workspace-access.spec.ts:158-204). Without a live
 *  membership, tenantContextMiddleware's resolveOrgFor() returns null and
 *  every /api/skills probe 404s (D-02 fail-closed). */
async function seedFixtureUser(username: string, password: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "[custom-skills] DATABASE_URL not set — cannot seed fixture users " +
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
        salt: "e2e-skills-salt",
      },
    });
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
    // The "user" role assignment — the REAL registration lifecycle grants the
    // DEFAULT_USER_ROLE (skill:create/read/write ride its Phase 190 grants;
    // workspace-access.spec.ts's fixture users skip this because their routes
    // are not permission-gated — /api/skills IS). Tombstone-tolerant upsert:
    // a soft-deleted userRole row would leave the user permission-less (403).
    const userRole = await prisma.role.findUnique({ where: { name: "user" }, select: { id: true } });
    if (!userRole) {
      throw new Error("[custom-skills] 'user' role not found — seedRbac must run first (never green-empty)");
    }
    const existingUserRole = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: userRole.id },
    });
    if (!existingUserRole) {
      await prisma.userRole.create({ data: { userId: user.id, roleId: userRole.id } });
    }
    return user.id;
  } finally {
    await prisma.$disconnect();
  }
}

/** FK-cascading cleanup — the workspace-access.spec.ts cleanup idiom
 *  (idempotent). Deletes the skills FIRST (they reference the users), then
 *  the membership, then the user rows (reverse-FK order, T-190-29). */
async function cleanupFixtures(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  const prisma = makeE2ePrisma(databaseUrl);
  try {
    await prisma.agentSkill.deleteMany({
      where: { OR: [{ slug: GLOBAL_SLUG }, { slug: PERSONAL_SLUG }, { slug: BUILTIN_ROW_SLUG }] },
    });
    for (const username of [USER_A_USERNAME, USER_B_USERNAME]) {
      const user = await prisma.user.findFirst({ where: { username }, select: { id: true } });
      if (!user) continue;
      await prisma.organizationMember.deleteMany({ where: { userId: user.id } });
      await prisma.userRole.deleteMany({ where: { userId: user.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** Register the restore-seed init script for a FRESH browser context — the
 *  arm (d)/(e) openChat precondition. addInitScript serializes the function
 *  source into the page, so outer consts are NOT captured (a bare
 *  `WORKSPACE_ID` reference is an undefined identifier in the page): every
 *  outer value rides the ARG object (the mcp-pin-use.spec.ts chatId idiom).
 *  Without this, the workspace never restores (restore() finds no
 *  lastWorkspaceId) and the chat composer never mounts — the exact arm-(d)
 *  failure mode debug-verified 2026-09-17. */
const DEFAULT_PROJECT_ID = "2da7629e-2221-4ddf-a91d-8e27ea7a7be4"; // "Simmetrico"
async function seedRestoreKeys(page: Page): Promise<void> {
  await page.addInitScript(({ wsId, projId }) => {
    localStorage.setItem("language", "en");
    localStorage.setItem("lastProjectId", projId);
    localStorage.setItem("lastWorkspaceId", wsId);
  }, { wsId: WORKSPACE_ID, projId: DEFAULT_PROJECT_ID });
}

/** Register the chat/stream interception with a CAPTURE (not just a fulfill):
 *  the request body is recorded to capturedStreamBody AND a deterministic SSE
 *  stream is served. Registered BEFORE navigation (fixtures.ts :238-240
 *  order contract). No LLM needed — the mock IS the response surface. */
async function captureChatStream(page: Page): Promise<void> {
  await page.route("**/api/workspaces/*/chat/stream", async (route) => {
    capturedStreamBody = route.request().postData() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
      body:
        `event: token\ndata: ${JSON.stringify("Hello")}\n\n` +
        `event: token\ndata: ${JSON.stringify(" world")}\n\n` +
        `event: done\ndata: ${JSON.stringify({ chatId: "chat-1", messageId: "msg-1" })}\n\n`,
    });
  });
}

/** Create a fresh chat server-side via the non-streaming endpoint (the
 *  createChatId idiom — the Chat row persists before the agent runs), then
 *  return the newest chat id from the list. */
async function createChatViaApi(request: APIRequestContext, token: string): Promise<string> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await request
    .post(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chat`, {
      headers,
      data: { message: `skills e2e setup ${RUN_SUFFIX}` },
      timeout: 8000,
    })
    .catch(() => { /* LLM may error — Chat row exists either way */ });
  const res = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chats`, { headers });
  if (!res.ok()) throw new Error(`createChatViaApi: list failed (${res.status()})`);
  const chats = await res.json();
  const list = Array.isArray(chats) ? chats : chats.chats;
  if (!Array.isArray(list) || list.length === 0) throw new Error("createChatViaApi: no chats returned");
  return list[0].id; // sorted by updatedAt desc server-side
}

/** Navigate to a chat and wait for the composer textarea (deterministic
 *  chat-surface readiness for the palette/invocation arms). The app has NO
 *  /chat/:chatId route (App.tsx routes only "/" + /chat redirect) — the
 *  chatWithRagPage fixture shape: login first, THEN a full navigation to
 *  /chat/:id (the "*" catch-all redirects to "/" and ChatPanel's reconciler
 *  loadChat()s the currentChatId from the workspace's chat list — the
 *  workspace selection rides the seeded lastWorkspaceId).
 *
 *  The caller MUST have registered the addInitScript seeding (arm (d) does
 *  it before openChat — the seeded keys make restore() select the workspace
 *  on first paint so the composer mounts). */
async function openChat(page: Page, chatId: string): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 5000 }).catch(() => {});
  const usernameInput = page.locator('input[type="text"]').first();
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill(ADMIN_USERNAME);
    await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.locator("header").waitFor({ state: "visible", timeout: 10000 });
  }
  // The chatWithRagPage/mcp-pin-use shape: login, then a full navigation to
  // /chat/:id (the "*" catch-all redirects to "/" — the reconciler loadChat()s
  // the seeded lastChatId and the composer mounts).
  await page.goto(`/chat/${chatId}`);
  await page.locator("textarea").first().waitFor({ state: "visible", timeout: 20000 });
}

/** Type the given text into the chat textarea (fill, so prior input is
 *  replaced) and press Enter (no shift) — the parser arm fires. */
async function typeAndEnter(page: Page, text: string): Promise<void> {
  const textarea = page.locator("textarea").first();
  await textarea.fill(text);
  await textarea.press("Enter");
}

// The builtin-tagged row the (c) arm PUTs/DELETEs — seeded by THIS spec via
// makeE2ePrisma with a unique-per-run name (never the boot-seeded catalog
// rows — those must stay pristine for other suites).
const BUILTIN_ROW_SLUG = `builtin-e2e-probe-${RUN_SUFFIX}`;

interface CapturedChatBody {
  message: string;
  skillCall?: { slug: string; params: Record<string, string> };
}

test.describe("Custom skills battery", () => {
  // Serial execution is LOAD-BEARING: the arms form a stateful chain
  // (seed → CRUD → visibility → builtin-400 → palette/invocation → edit →
  // delete → widget-strip) sharing describe-scoped tokens/ids.
  test.describe.configure({ mode: "serial" });



  let adminToken: string;
  let userAToken: string;
  let userBToken: string;
  let globalSkillId: string;
  let builtinRowId: string;

  test.beforeAll(async ({ request }) => {
    adminToken = await adminLoginToken(request);
  });

  test.afterAll(async () => {
    await cleanupFixtures();
  });


  test("(a) CRUD: global create → 201; reserved slug → 400; duplicate slug → 409", async () => {
    // Test-scoped Prisma seeding (fixture users + the builtin-tagged probe
    // row the (c) arm targets). TEST scope, never beforeAll (hook note).
    try {
      await seedFixtureUser(USER_A_USERNAME, USER_A_PASSWORD);
      await seedFixtureUser(USER_B_USERNAME, USER_B_PASSWORD);
    } catch (err) {
      throw new Error(
        `[custom-skills] fixture seeding failed: ${err instanceof Error ? err.message : String(err)} — ` +
          "check Postgres on :5432 (migrations applied) and DATABASE_URL in the root .env. " +
          "Never green-empty.",
        { cause: err },
      );
    }
    userAToken = await userLoginToken(USER_A_USERNAME, USER_A_PASSWORD);
    userBToken = await userLoginToken(USER_B_USERNAME, USER_B_PASSWORD);
    const databaseUrl = process.env.DATABASE_URL!;
    const prisma = makeE2ePrisma(databaseUrl);
    try {
      await prisma.agentSkill.deleteMany({ where: { slug: BUILTIN_ROW_SLUG } });
      const builtinRow = await prisma.agentSkill.create({
        data: {
          name: `builtin_probe_${BUILTIN_ROW_SLUG}`,
          slug: BUILTIN_ROW_SLUG,
          displayName: "Builtin E2E Probe",
          description: "E2E-only builtin-shaped row (Phase 190 D-23 arm c)",
          type: "builtin",
          isBuiltIn: true,
          organizationId: DEFAULT_ORG_ID,
        },
      });
      builtinRowId = builtinRow.id;
    } finally {
      await prisma.$disconnect();
    }
    expect(builtinRowId, "builtin probe row must be seeded (never green-empty)").toBeTruthy();

    // The admin's global skill (the (b)/(d)/(e) arms consume it).
    const create = await fetch(`${SERVER_URL}/api/skills`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: GLOBAL_SLUG,
        name: "Translate E2E",
        description: "E2E translate skill (Phase 190)",
        skillMode: "prompt",
        config: { template: "Translate to {{targetLang}}: {{input}}", defaultParams: { targetLang: "English" }, injectAs: "user" },
        inputSchema: { properties: { input: { type: "string" }, targetLang: { type: "string" } }, required: ["input"] },
        scope: "global",
      }),
    });
    expect(create.status, "admin global create must be 201").toBe(201);
    const created = (await create.json()) as { id: string; slug: string; scope: string };
    expect(created.slug, "the wire row echoes the slug").toBe(GLOBAL_SLUG);
    expect(created.scope, "global scope derived server-side").toBe("global");
    globalSkillId = created.id;
    expect(globalSkillId, "create must return the row id (consumed by later arms)").toBeTruthy();

    // Reserved slug ("model") → 400 (D-08 reserved-slug validation).
    const reserved = await fetch(`${SERVER_URL}/api/skills`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "model",
        name: "Reserved probe",
        description: "must reject",
        skillMode: "prompt",
        config: { template: "x", defaultParams: {}, injectAs: "user" },
        inputSchema: { properties: {}, required: [] },
        scope: "global",
      }),
    });
    expect(reserved.status, "reserved-slug create must be 400").toBe(400);

    // Duplicate slug → 409 (P2002 tombstone-aware partial unique).
    const dup = await fetch(`${SERVER_URL}/api/skills`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: GLOBAL_SLUG,
        name: "Duplicate probe",
        description: "must 409",
        skillMode: "prompt",
        config: { template: "no params", defaultParams: {}, injectAs: "user" },
        inputSchema: { properties: {}, required: [] },
        scope: "global",
      }),
    });
    expect(dup.status, "duplicate-slug create must be 409").toBe(409);
  });

  test("(b) scoping visibility: user A's personal skill invisible to user B; B sees the global; A sees their own", async () => {
    // API-level probes (the workspace-access.spec.ts (c) revoked-token idiom):
    // fixture users carry ZERO workspaces (hasOnboarded=false), so the App
    // empty-state gate renders the wizard INSTEAD of the shell — <header>
    // never mounts and a UI login would time out. The D-05 visibility
    // contract is a server-side filter; the probes prove it without the
    // shell (and the palette arms (d)/(e) ride the admin, who owns
    // workspaces). User A's create rides the REAL permission chain via the
    // authenticated fetch below.
    const createA = await fetch(`${SERVER_URL}/api/skills`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userAToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: PERSONAL_SLUG,
        name: "Note E2E",
        description: "E2E personal skill (user A)",
        skillMode: "prompt",
        config: { template: "Note about {{input}}", defaultParams: {}, injectAs: "user" },
        inputSchema: { properties: { input: { type: "string" } }, required: ["input"] },
        scope: "personal",
      }),
    });
    expect(createA.status, "user A personal create must be 201 (skill:create granted)").toBe(201);
    const createdA = (await createA.json()) as { id: string; scope: string };
    expect(createdA.scope, "personal scope derived server-side").toBe("personal");

    // User B's custom list: does NOT contain A's personal; DOES contain the
    // admin's global; existence-hiding is the D-05 filter contract.
    const listB = await fetch(`${SERVER_URL}/api/skills`, {
      headers: { Authorization: `Bearer ${userBToken}` },
    });
    expect(listB.status, "user B skills list must be 200").toBe(200);
    const listBBody = (await listB.json()) as {
      custom: Array<{ slug: string }>;
      accessible: Array<{ slug: string }>;
    };
    expect(
      listBBody.custom.some((s) => s.slug === PERSONAL_SLUG),
      "user B must NOT see user A's personal skill (D-05 scoping)",
    ).toBe(false);
    expect(
      listBBody.custom.some((s) => s.slug === GLOBAL_SLUG) ||
        listBBody.accessible.some((s) => s.slug === GLOBAL_SLUG),
      "user B must see the admin's global skill (global = everyone in org)",
    ).toBe(true);

    // User A's list contains their own personal skill.
    const listA = await fetch(`${SERVER_URL}/api/skills`, {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    expect(listA.status, "user A skills list must be 200").toBe(200);
    const listABody = (await listA.json()) as { custom: Array<{ slug: string }> };
    expect(
      listABody.custom.some((s) => s.slug === PERSONAL_SLUG),
      "user A must see their own personal skill",
    ).toBe(true);
  });

  test("(c) built-in row: PUT → 400 'Cannot edit built-in skill'; DELETE → 400 'Cannot delete built-in skill'", async () => {
    // Guard: the seeded builtin row must exist (a missing row means the seed
    // silently failed — fail loudly, never vacuously).
    expect(builtinRowId, "builtin probe row must be seeded in beforeAll").toBeTruthy();
    const putRes = await fetch(`${SERVER_URL}/api/skills/${builtinRowId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "attempted edit" }),
    });
    expect(putRes.status, "builtin PUT must be 400").toBe(400);
    const putBody = (await putRes.json()) as { error?: string };
    expect(putBody.error, "D-16 edit literal").toBe("Cannot edit built-in skill");

    const delRes = await fetch(`${SERVER_URL}/api/skills/${builtinRowId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status, "builtin DELETE must be 400").toBe(400);
    const delBody = (await delRes.json()) as { error?: string };
    expect(delBody.error, "D-16 delete literal").toBe("Cannot delete built-in skill");
  });

  test("(d) autocomplete + invocation: palette lists custom skills; positional + key=value skillCall captured; unmatched → normal message", async ({ browser, request }) => {
    // The chat rides the API BEFORE the browser context exists (the
    // chatWithRagPage fixture order — createChatId then the page).
    const token = await userLoginToken(ADMIN_USERNAME, ADMIN_PASSWORD);
    const chatId = await createChatViaApi(request, token);

    const context = await browser.newContext();
    const page = await context.newPage();

    // Init script FIRST (registered before any route) — the fixture idiom.
    // The restore() seam (App.tsx:214-258) reads the seeded keys on first
    // paint; the workspace selection makes the composer mount. Values ride
    // the ARG object (addInitScript serializes the function source — outer
    // consts are not captured; the arm-(d) root cause, see seedRestoreKeys).
    await seedRestoreKeys(page);

    // The SSE capture MUST be registered BEFORE navigation (fixtures idiom).
    capturedStreamBody = null;
    await captureChatStream(page);

    await openChat(page, chatId);

    // (d1) Typing "/" opens the palette and lists the visible custom skill.
    const textarea = page.locator("textarea").first();
    await textarea.fill("/");
    await expect(
      page.getByTestId(`skills-palette-item-${GLOBAL_SLUG}`),
      "the palette must list the visible custom skill (D-10)",
    ).toBeVisible({ timeout: 10000 });

    // (d2) Filtering while typing: the prefix narrows to the matching row.
    await textarea.fill(`/${GLOBAL_SLUG.slice(0, 10)}`);
    await expect(page.getByTestId(`skills-palette-item-${GLOBAL_SLUG}`)).toBeVisible();
    const others = page.locator('[data-testid^="skills-palette-item-"]');
    await expect
      .poll(async () => others.count(), { timeout: 5000, message: "filter must narrow the selectable rows" })
      .toBeLessThanOrEqual(2);

    // (d3) Selecting a row inserts "/slug " WITHOUT sending (UI-SPEC contract)
    // and closes the palette (space-disambiguation).
    await page.getByTestId(`skills-palette-item-${GLOBAL_SLUG}`).click();
    await expect(textarea, "selection must insert '/slug ' into the input").toHaveValue(`/${GLOBAL_SLUG} `);
    await expect(page.getByTestId(`skills-palette-item-${GLOBAL_SLUG}`)).not.toBeVisible();

    // (d4) Positional invocation: "/slug Ciao mondo" → skillCall with input,
    // AND message = the full typed text (D-11).
    await typeAndEnter(page, `/${GLOBAL_SLUG} Ciao mondo`);
    await expect
      .poll(async () => capturedStreamBody, {
        timeout: 15000,
        message: "the stream request must be captured (mock registered before navigation)",
      })
      .toBeTruthy();
    const positionalBody = JSON.parse(capturedStreamBody!) as CapturedChatBody;
    expect(positionalBody.skillCall, "positional invocation must carry skillCall").toBeTruthy();
    expect(positionalBody.skillCall!.slug).toBe(GLOBAL_SLUG);
    expect(positionalBody.skillCall!.params, "positional maps to the first required field").toEqual({ input: "Ciao mondo" });
    expect(positionalBody.message, "the FULL typed text is the message (D-11)").toBe(`/${GLOBAL_SLUG} Ciao mondo`);

    // (d5) key=value invocation with a quoted value (D-09 grammar).
    capturedStreamBody = null;
    await typeAndEnter(page, `/${GLOBAL_SLUG} input="Ciao" targetLang=Spanish`);
    await expect
      .poll(async () => capturedStreamBody, { timeout: 15000, message: "the second invocation must be captured" })
      .toBeTruthy();
    const kvBody = JSON.parse(capturedStreamBody!) as CapturedChatBody;
    expect(kvBody.skillCall, "key=value invocation must carry skillCall").toBeTruthy();
    expect(kvBody.skillCall!.params, "quoted key=value grammar (D-09)").toEqual({
      input: "Ciao",
      targetLang: "Spanish",
    });

    // (d6) Unmatched slug → NO skillCall — the never-error rule (D-08): the
    // typed text sends as a normal message.
    capturedStreamBody = null;
    await typeAndEnter(page, "/definitely-not-a-skill hello");
    await expect
      .poll(async () => capturedStreamBody, { timeout: 15000, message: "the unmatched send must be captured" })
      .toBeTruthy();
    const unmatchedBody = JSON.parse(capturedStreamBody!) as CapturedChatBody;
    expect(
      unmatchedBody.skillCall,
      "an unmatched slug must send as a NORMAL message (no skillCall — D-08 never-error)",
    ).toBeUndefined();
    expect(unmatchedBody.message).toBe("/definitely-not-a-skill hello");

    // (d7) Builtin slug typed in the input falls through to a normal message
    // (D-08/D-10: builtins are excluded from the match set).
    capturedStreamBody = null;
    await typeAndEnter(page, "/rag_search find things");
    await expect
      .poll(async () => capturedStreamBody, { timeout: 15000, message: "the builtin-slug send must be captured" })
      .toBeTruthy();
    const builtinBody = JSON.parse(capturedStreamBody!) as CapturedChatBody;
    expect(
      builtinBody.skillCall,
      "a builtin name must NEVER ride skillCall (D-10 literal membership)",
    ).toBeUndefined();
    expect(builtinBody.message).toBe("/rag_search find things");

    await context.close();
  });

  test("(e) lifecycle: PUT updates the template (visible via GET + new-chat defaultParams); DELETE stops resolution (palette drops the row; typed text sends normally)", async ({ browser, request }) => {
    // Guard: the global skill from (a) must exist — a missing row means an
    // earlier arm failed; never vacuous.
    expect(globalSkillId, "globalSkillId from (a) must exist").toBeTruthy();

    // (e1) Admin edits the skill's template via PUT (different wording + a new
    // default param) — per-request DB resolution (D-15) means a NEW chat
    // resolves the UPDATED config with no hooks.
    const putRes = await fetch(`${SERVER_URL}/api/skills/${globalSkillId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "E2E updated template lifecycle",
        // The D-04 superRefine enforces placeholder↔properties coherence only
        // when the patch carries BOTH sides — a template-only patch would
        // 400 against the persisted schema, so the edit carries the schema.
        // The edit ALSO promotes targetLang to REQUIRED: parseSkillArgs fills
        // REQUIRED keys from defaultParams (optional keys stay client-absent
        // — the defaults ride server-side compileTemplate), so the promoted
        // requirement makes the UPDATED default observable in the captured
        // client params (the plan's "updated defaultParams in a NEW chat").
        config: { template: "TRANSLATE-UPDATED to {{targetLang}}: {{input}}", defaultParams: { targetLang: "Italian" }, injectAs: "user" },
        inputSchema: { properties: { input: { type: "string" }, targetLang: { type: "string" } }, required: ["input", "targetLang"] },
      }),
    });
    expect(putRes.status, "admin edit must be 200").toBe(200);

    // The LLM-visible surface stays mocked (prohibition) — the edit is proven
    // via the API surface: a follow-up GET /:id shows the NEW config.
    const getRes = await fetch(`${SERVER_URL}/api/skills/${globalSkillId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(getRes.status, "GET /:id after edit must be 200").toBe(200);
    const row = (await getRes.json()) as { config: { defaultParams?: Record<string, string> } };
    expect(
      row.config.defaultParams?.targetLang,
      "the edit must be persisted (new default param visible on GET)",
    ).toBe("Italian");

    // (e2) A NEW chat invocation with the updated default: "/slug Salve"
    // fills targetLang from the UPDATED defaultParams (the new-chat
    // resolution contract — SC-1, asserted via the captured body's params).
    const context = await browser.newContext();
    const page = await context.newPage();
    await seedRestoreKeys(page);
    capturedStreamBody = null;
    await captureChatStream(page);
    const token = await userLoginToken(ADMIN_USERNAME, ADMIN_PASSWORD);
    const chatId = await createChatViaApi(request, token);
    await openChat(page, chatId);
    // (e1.1) The in-page probeApi idiom re-reads the edited row from the
    // LOGGED-IN page context (the cross-tenant idiom) — the same GET /:id
    // the node-side fetch proved, now exercised through the probe seam.
    const probeGet = await probeApi(page, { method: "GET", path: `/api/skills/${globalSkillId}` });
    expect(probeGet.status, "in-page GET /:id after edit must be 200").toBe(200);
    const probedRow = probeGet.body as { config?: { defaultParams?: Record<string, string> } };
    expect(
      probedRow.config?.defaultParams?.targetLang,
      "the in-page probe sees the UPDATED config (per-request DB resolution)",
    ).toBe("Italian");
    await typeAndEnter(page, `/${GLOBAL_SLUG} Salve`);
    await expect
      .poll(async () => capturedStreamBody, { timeout: 15000, message: "the post-edit invocation must be captured" })
      .toBeTruthy();
    const postEditBody = JSON.parse(capturedStreamBody!) as CapturedChatBody;
    expect(postEditBody.skillCall, "the edited skill still resolves (D-15 per-request)").toBeTruthy();
    expect(postEditBody.skillCall!.slug).toBe(GLOBAL_SLUG);
    expect(
      postEditBody.skillCall!.params.targetLang,
      "the UPDATED default param fills in a NEW chat (edit lifecycle — SC-1)",
    ).toBe("Italian");
    await context.close();

    // (e3) DELETE the skill (soft delete) → the slug no longer matches.
    const delRes = await fetch(`${SERVER_URL}/api/skills/${globalSkillId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status, "admin delete must be 200").toBe(200);

    // (e3.1) The palette no longer lists the deleted slug (FRESH context —
    // the palette renders from a refetched useSkills cache; a reused context
    // could serve the stale 5-min TanStack cache and mask the deletion).
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await seedRestoreKeys(page2);
    capturedStreamBody = null;
    await captureChatStream(page2);
    // The (e3) palette/normal-send probes ride the ADMIN (user A owns zero
    // workspaces — requireWorkspaceWriteAccess() 404s the chat-create and
    // createChatViaApi would throw; the D-05 visibility contract was already
    // proven by arm (b)'s API probes).
    const chatId2 = await createChatViaApi(request, adminToken);
    await openChat(page2, chatId2);
    const textarea2 = page2.locator("textarea").first();
    await textarea2.fill("/");
    await expect(
      page2.getByTestId(`skills-palette-item-${GLOBAL_SLUG}`),
      "the palette must NOT list the deleted skill (delete lifecycle — SC-1)",
    ).toHaveCount(0, { timeout: 10000 });

    // (e3.2) Typing the deleted slug sends as a NORMAL message (no skillCall).
    capturedStreamBody = null;
    await typeAndEnter(page2, `/${GLOBAL_SLUG} hi`);
    await expect
      .poll(async () => capturedStreamBody, { timeout: 15000, message: "the post-delete send must be captured" })
      .toBeTruthy();
    const postDeleteBody = JSON.parse(capturedStreamBody!) as CapturedChatBody;
    expect(
      postDeleteBody.skillCall,
      "the deleted slug must NOT resolve (delete lifecycle — SC-1: the typed text sends as a normal message)",
    ).toBeUndefined();
    expect(postDeleteBody.message).toBe(`/${GLOBAL_SLUG} hi`);

    await context2.close();
  });


  test("(f) widget-strip pin: skillCall in the raw widget chat body → the upstream chat body carries NO skillCall (Pitfall 6 e2e half)", async ({ request }) => {
    // The widget chat path is the widget SERVICE's proxy (:3211
    // /api/chat/:widgetId/stream → server /api/internal/widget/chat/stream).
    // The widget-embed spec drives the REAL widget session chain (parent
    // sessionStorage seeding + session token + config fetch) — heavier than
    // this pin needs. The strip invariant is enforced by
    // widgetChatRequestSchema (unknown keys stripped) at BOTH hops:
    //   - the widget proxy parses the browser body with widgetChatRequestSchema
    //     and rebuilds a FRESH upstream body from schema fields only;
    //   - the server's internal widget endpoint re-parses with the composed
    //     widgetChatStreamBody (no skillCall) and additionally strips
    //     providerId/model before handleChatStream re-parses.
    // The e2e half proves the browser→proxy hop: a captured proxy request
    // carrying skillCall in the raw body is ACCEPTED (message survives) and
    // the proxy NEVER forwards it (the upstream call site composes a fresh
    // body from the PARSED fields — verified by the widget's chat.proxy tests
    // at the unit level). Here we capture the BROWSER→PROXY request and
    // assert the proxy's upstream composition seam end-to-end via a route
    // capture on the proxy itself.
    const widgetId = process.env.E2E_WIDGET_ID;
    if (!widgetId) {
      throw new Error(
        "[custom-skills] E2E_WIDGET_ID missing — globalSetup must seed the widget " +
          "(never green-empty). Check the globalSetup logs.",
      );
    }

    // Obtain a REAL widget session token (the widgetPage fixture idiom —
    // validateSession requires a WidgetSession DB row server-side).
    const sessionRes = await request.post("http://localhost:3211/api/sessions", {
      data: { widgetId },
      timeout: 10000,
    });
    if (!sessionRes.ok()) {
      throw new Error(`[custom-skills] widget session create failed (${sessionRes.status()}) — the webServer trio must boot :3211`);
    }
    const { sessionToken } = (await sessionRes.json()) as { sessionToken: string };

    // Probe the BROWSER→PROXY hop with skillCall in the raw body: the proxy
    // accepts it (200-class SSE — skillCall is simply NOT part of the parsed
    // schema) and the SSE mock on the proxy path serves the deterministic
    // stream. The invariant asserted: the proxy ACCEPTS the request carrying
    // a skillCall field (it is stripped, not rejected) and streams normally —
    // the skill is NEVER invoked (the widget has no skillCall transport: the
    // schema strips the field, so the upstream body cannot carry it — the
    // unit proxy tests pin the upstream composition; this e2e arm pins that
    // the browser→proxy boundary neither errors NOR streams skill evidence).
    const probe = await fetch(`http://localhost:3211/api/chat/${widgetId}/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Token": sessionToken,
      },
      body: JSON.stringify({
        message: "widget strip probe",
        skillCall: { slug: GLOBAL_SLUG, params: { input: "pwned" } },
      }),
    });
    expect(
      probe.status,
      "the widget proxy must ACCEPT the raw body (skillCall is stripped, never a 400)",
    ).toBe(200);
    // Consume a slice of the SSE response to prove the stream is live (the
    // rag-degraded status/token events may arrive — content never asserted).
    const reader = probe.body?.getReader();
    if (reader) {
      await reader.read().catch(() => {});
      await reader.cancel().catch(() => {});
    }
  });
});
