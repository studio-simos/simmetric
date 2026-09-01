import { test as base, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * Extended Playwright fixtures for the E2E regression suite (Phase 66).
 *
 *  - adminPage        — auto-logged-in admin page (existing, unchanged).
 *  - chatWithRagPage  — admin-logged page with a fresh chat navigated and a
 *                       deterministic SSE chat/stream mock pre-registered with
 *                       canned citations (D-01/D-02).
 *  - widgetPage       — host page with the real widget loader script mounted
 *                       (real widget service :3211 + real iframe), with ONLY the
 *                       widget chat SSE mocked (D-07). Requires globalSetup to
 *                       have seeded E2E_WIDGET_ID into process.env.
 *
 * Helpers exported separately:
 *  - mockCollector(page, pattern?, opts?) — registers a `page.route` that
 *    fulfills the chat/stream SSE with deterministic `token`/`citations`/`done`
 *    events. See the JSDoc on the function for the naming caveat (D-01).
 *
 * Reference: .planning/phases/66-e2e-playwright/66-CONTEXT.md (D-01, D-02, D-07)
 * and 66-RESEARCH.md §"Code Examples" for the SSE framing verbatim.
 */

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (admin-owned, dev DB)
const SERVER_BASE = "http://localhost:3000";

/** Shared login + animation-disabled init script. Mirrors the adminPage logic
 *  so the composed fixtures (chatWithRagPage) stay self-contained.
 *
 * 169-02 Rule 1: the previous 3000ms `isVisible` race let a cold vite preview
 *  mount skip the login branch (the form hadn't painted in 3s) → the fixture
 *  navigated to /chat unauthenticated → the app redirected to /login and the
 *  textarea never appeared. Mirrors the `adminPage` fixture's
 *  `waitForSelector(..., { timeout: 5000 })` guard so the login form is
 *  actually present before the isVisible check. */
async function loginAsAdmin(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("language", "en");
    localStorage.setItem("lastWorkspaceId", "9a334821-b880-411b-affc-805664e7fd66");
    try {
      const style = document.createElement("style");
      style.textContent = "* { animation: none !important; transition: none !important; }";
      (document.head || document.documentElement || document.body || document.documentElement)?.appendChild(style);
    } catch {}
  });
  await page.goto("/");
  // Wait for the login form to mount (cold vite preview can take >3s). Mirrors
  // the adminPage fixture (lines 162-163) — robust against the boot race that
  // previously caused chatWithRagPage to navigate unauthenticated.
  await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 5000 }).catch(() => {});
  const usernameInput = page.locator('input[type="text"]').first();
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await page.locator('button[type="submit"]').click();
    // Deterministic wait for auth settlement: either the authenticated app
    // shell (TopBar renders <header>) or the force-change-password screen
    // ("Set a new password") appears. Replaces a fixed 1500ms sleep that
    // raced the next isVisible() branch check under a cold/slow dev stack.
    await page
      .locator("header")
      .or(page.getByText("Set a new password"))
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
  }
  // The seeded admin had mustChangePassword=true at first login; clear it once
  // (POST /auth/set-initial-password flips the flag in the DB so subsequent
  // runs skip this branch). New password "admin123" keeps the login valid.
  const forceChangeTitle = page.getByText("Set a new password");
  if (await forceChangeTitle.isVisible().catch(() => false)) {
    const pwInputs = page.locator('input[type="password"]');
    await pwInputs.nth(0).fill("admin123");
    await pwInputs.nth(1).fill("admin123");
    await page.locator('button[type="submit"]').click();
    // mustChangePassword flips to false in the DB; ForcePasswordChange triggers
    // a /auth/me refetch → meData updates → authenticated app shell renders
    // (<header>). Wait deterministically for the app shell instead of a sleep.
    await page.locator("header").first().waitFor({ state: "visible", timeout: 10000 });
  }
}

/** Create a chat server-side via the non-streaming endpoint and return its id.
 *  The route persists the Chat row (chat.ts:79) before invoking the agent, so
 *  the chat exists even if the LLM errors. Pattern reused from chat-flow.spec.ts. */
async function createChatId(request: APIRequestContext): Promise<string> {
  const auth = await request.post(`${SERVER_BASE}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  if (!auth.ok()) throw new Error(`createChatId: login failed (${auth.status()})`);
  const { token } = (await auth.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  // POST /chat (singular) with a message — no dedicated POST /chats create
  // endpoint exists; the Chat row is persisted before the agent runs.
  await request.post(`${SERVER_BASE}/api/workspaces/${WORKSPACE_ID}/chat`, {
    headers,
    data: { message: "e2e rag chat setup" },
    timeout: 8000,
  }).catch(() => { /* LLM may error — Chat row exists either way */ });
  const res = await request.get(`${SERVER_BASE}/api/workspaces/${WORKSPACE_ID}/chats`, { headers });
  if (!res.ok()) throw new Error(`createChatId: list failed (${res.status()})`);
  const chats = await res.json();
  const list = Array.isArray(chats) ? chats : chats.chats;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("createChatId: no chats returned");
  }
  return list[0].id; // sorted by updatedAt desc server-side
}

/** SSE-boundary mock for chat/stream (D-01). Registers `page.route` on the
 *  given pattern and fulfills with deterministic `token` / `citations` / `done`
 *  events. The SSE body is plain text with `\n\n` separators — a single
 *  `route.fulfill({ body })` is a valid stream for @microsoft/fetch-event-source
 *  (the parser splits on `\n\n` regardless of TCP chunking; verified via
 *  Context7 /microsoft/playwright/v1.61.0 — see 66-RESEARCH.md §"Code Examples").
 *
 *  ATTENZIONE: il nome `mockCollector` è un'approssimazione (D-01) — mocka la
 *  SSE di chat/stream al boundary browser, NON il servizio collector :3210.
 *  `page.route` intercetta solo chiamate browser→server; il collector è chiamato
 *  dal server via axios server-side, invisibile al browser. Il nome è mantenuto
 *  per tracciabilità E2E-01. */
export async function mockCollector(
  page: Page,
  pattern: string = "**/api/workspaces/*/chat/stream",
  opts: { withCitations?: boolean; tokens?: string[] } = {}
): Promise<void> {
  const tokens = opts.tokens ?? ["Hello", " world", "!"];
  const sseBody =
    tokens.map(t => `event: token\ndata: ${JSON.stringify(t)}\n\n`).join("") +
    (opts.withCitations
      // GAP-03 fix: wrap citations array in {sources: [...]} to match the
      // useChat.ts:271 contract (data.sources || []) and the real server SSE
      // contract (packages/server/src/routes/chat.ts:500
      // sendSSE("citations", { sources: result.sources || [] })). A bare
      // array made data.sources undefined → currentSourcesRef.current = []
      // → ChatCitations.tsx rendered null (sources.length === 0) → the
      // "Sources (N)" toggle never appeared in upload-chat-rag.spec.ts.
      ? `event: citations\ndata: ${JSON.stringify({
          sources: [
            { documentId: "doc-1", documentName: "doc.md", chunkText: "chunk", score: 0.9 },
          ],
        })}\n\n`
      : "") +
    `event: done\ndata: ${JSON.stringify({ chatId: "chat-1", messageId: "msg-1" })}\n\n`;

  await page.route(pattern, async route => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
      body: sseBody,
    });
  });
}

export const test = base.extend({
  /** Auto-logged-in admin page (existing behavior, preserved). */
  adminPage: async ({ page }, use) => {
    await page.addInitScript(() => {
      localStorage.setItem("language", "en");
      localStorage.setItem("lastWorkspaceId", "9a334821-b880-411b-affc-805664e7fd66");
      try {
        const style = document.createElement("style");
        style.textContent = "* { animation: none !important; transition: none !important; }";
        (document.head || document.documentElement || document.body || document.documentElement)?.appendChild(style);
      } catch {}
    });

    await page.goto("/");
    await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 5000 }).catch(() => {});

    const usernameInput = page.locator('input[type="text"]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    if (await usernameInput.isVisible()) {
      await usernameInput.fill("admin");
      await passwordInput.fill("admin123");
      await page.locator('button[type="submit"]').click();
      // Deterministic wait for auth settlement: either the authenticated app
      // shell (TopBar renders <header>) or the force-change-password screen
      // ("Set a new password") appears. Replaces a fixed 2000ms sleep.
      await page
        .locator("header")
        .or(page.getByText("Set a new password"))
        .first()
        .waitFor({ state: "visible", timeout: 10000 });
    }

    // The seeded admin has mustChangePassword=true (bootstrap-admin-seed), so the
    // first login lands on the ForcePasswordChange screen instead of the app.
    // Complete it once (POST /auth/set-initial-password clears the flag in the DB,
    // so subsequent runs skip this branch). New password = "admin123" (min 8) keeps
    // the admin/admin123 login valid for every run.
    const forceChangeTitle = page.getByText("Set a new password");
    if (await forceChangeTitle.isVisible().catch(() => false)) {
      const pwInputs = page.locator('input[type="password"]');
      await pwInputs.nth(0).fill("admin123");
      await pwInputs.nth(1).fill("admin123");
      await page.locator('button[type="submit"]').click();
      // After force-change submit, wait deterministically for the authenticated
      // app shell (<header>) to mount instead of a fixed 2000ms sleep.
      await page.locator("header").first().waitFor({ state: "visible", timeout: 10000 });
    }

    await use(page);
  },

  /** Admin-logged page with a fresh chat created via API and the chat/stream
   *  SSE route pre-registered with canned citations (D-01/D-02). The SSE mock
   *  is registered BEFORE page.goto so the streaming request is intercepted on
   *  first paint. */
  chatWithRagPage: async ({ page, request }, use) => {
    await loginAsAdmin(page);
    const chatId = await createChatId(request);
    // Register the SSE mock BEFORE navigating so the first chat/stream request
    // is intercepted (order matters — page.route must be in place before the
    // streaming fetch fires).
    await mockCollector(page, "**/api/workspaces/*/chat/stream", { withCitations: true });
    await page.goto(`/chat/${chatId}`);
    await use(page);
  },

  /** Host page with the real widget loader script mounted (real widget service
   *  :3211 + real iframe, per D-07). Only the widget chat SSE is mocked
   *  (see mockCollector call below for the exact pattern); the loader, session
   *  create, and config fetch run against the real widget service :3211.
   *  Requires globalSetup to have seeded process.env.E2E_WIDGET_ID.
   *
   *  TST-01 (Phase 122, D-05/D-06): the host page is served from a REAL origin
   *  — packages/frontend/public/e2e-widget-host.html on :5173 via `vite preview`
   *  (never page.route synthesis, never page.setContent — Chromium PNA blocks
   *  the localhost:3211 subresource from a route-fulfilled page, and
   *  about:blank's opaque origin throws SecurityError on sessionStorage).
   *  The fixture seeds BOTH audited keys (sc-widget-<id>-session +
   *  sc-widget-<id>-messages) in the PARENT sessionStorage via addInitScript
   *  BEFORE the loader executes, using a REAL session token from
   *  POST http://localhost:3211/api/sessions (a WidgetSession DB row — a
   *  hand-rolled fake would 401 on the first chat request) and WidgetMessage-
   *  shaped messages whose content is DISTINCT from the mock SSE tokens.
   *
   *  Loader contract (packages/widget/src/routes/loader.ts): the script tag
   *  carries `data-target="<containerId>"`; the container element holds
   *  `data-widget-id="<id>"`. The loader builds the iframe src as
   *  `<baseUrl>/<widgetId>?primaryColor=...&position=...&locale=...` where
   *  baseUrl is the script src minus the trailing filename. */
  widgetPage: async ({ page, request }, use) => {
    const widgetId = process.env.E2E_WIDGET_ID;
    if (!widgetId) {
      throw new Error(
        "widgetPage fixture requires process.env.E2E_WIDGET_ID — globalSetup " +
        "(./e2e/globalSetup.ts) must run first. Verify the widget was seeded in " +
        "the dev DB and that the Playwright config wires globalSetup."
      );
    }
    // Pitfall 8: the SSE mock must be registered FIRST so the iframe's first
    // chat/stream request is intercepted (order matters).
    await mockCollector(page, "**/api/chat/*/stream", { withCitations: false });

    // Real session token via the widget service API (creates a WidgetSession
    // DB row server-side — validateSession requires it, RESEARCH Pitfall 4).
    const sessionRes = await request.post("http://localhost:3211/api/sessions", {
      data: { widgetId },
      timeout: 10000,
    });
    if (!sessionRes.ok()) {
      throw new Error(
        `widgetPage fixture: POST /api/sessions failed (${sessionRes.status()}) — ` +
        "the Playwright webServer trio guarantees :3211 is up; check the widget " +
        "service logs."
      );
    }
    const { sessionToken } = (await sessionRes.json()) as { sessionToken: string };

    // WidgetMessage-shaped messages (useWidgetChat.ts:14) with content DISTINCT
    // from the mock SSE tokens ("Hello world!") — Pitfall 5.
    const messages = [
      { id: "m1", role: "user", content: "Seeded question" },
      { id: "m2", role: "assistant", content: "Seeded answer" },
    ];

    // Seed BOTH audited keys in the PARENT sessionStorage before the loader
    // script executes (addInitScript runs before page scripts on navigation).
    // Seeding via the parent sessionStorage API directly — NEVER by posting
    // simmetric:storage-set (WR-01 source check silently ignores it, audit §3.3).
    await page.addInitScript(
      ({ widgetId, sessionToken, messages }) => {
        sessionStorage.setItem(
          "sc-widget-" + widgetId + "-session",
          JSON.stringify({ token: sessionToken })
        );
        sessionStorage.setItem(
          "sc-widget-" + widgetId + "-messages",
          JSON.stringify(messages)
        );
      },
      { widgetId, sessionToken, messages }
    );

    // WR-02 (131-REVIEW.md): count browser-side POST /api/sessions from the
    // iframe BEFORE it mounts. The loader handshake (iframe mount →
    // requestStorageFromLoader → cache hit vs fall-through to POST
    // /api/sessions) completes during fixture setup — a counter registered
    // in the test body would be vacuous (the waitForSelector below is the
    // point AFTER which the handshake already ran). page.route intercepts
    // ONLY browser-originated requests — the fixture's own APIRequestContext
    // POST above is NOT counted. Exposed on the page object for the spec to
    // assert (Test 1's "zero new POST /api/sessions" gate).
    const sessionCreateCount = { value: 0 };
    await page.route("**/api/sessions", async (route) => {
      if (route.request().method() === "POST") {
        sessionCreateCount.value += 1;
      }
      await route.continue();
    });
    (page as any).__sessionCreateCount = sessionCreateCount;

    // Real navigation to the real :5173 server (D-06 fix — never setContent).
    await page.goto("/e2e-widget-host.html?widgetId=" + encodeURIComponent(widgetId));
    await page.waitForSelector('iframe[src*="localhost:3211"]', { timeout: 10000 });
    await use(page);
  },
});

export { expect };