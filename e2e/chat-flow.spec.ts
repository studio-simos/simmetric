import { test, expect, mockCollector, type Page, type APIRequestContext } from "./fixtures";

/**
 * Feature 4.10.4 — Chat flow E2E (Playwright).
 *
 * Critical path: login → workspace → send message → streaming visual → response
 * → citations → rename chat → switch model via Cmd+K.
 *
 * Environment notes:
 *  - Live dev stack (server :3000, frontend :5173) via playwright.config.ts
 *    webServer (reuseExistingServer: true). Bootstrap admin: admin / admin123.
 *  - `lastWorkspaceId` pre-seeded so ChatPanel has a workspace on first paint.
 *  - `language=en` forced → deterministic aria-labels/title values.
 *  - Rename + Cmd+K (test 1) are LLM-INDEPENDENT: a chat is created via the
 *    API (POST /api/workspaces/:id/chat always persists the chat row before the
 *    agent runs), its id recovered from the chat list, then the page navigates
 *    to it. This decouples the deterministic UI assertions from LLM availability.
 *  - Send + streaming (test 2) and citations (test 3) register the SSE mock
 *    (mockCollector, D-04) BEFORE page.goto so the chat/stream request is
 *    intercepted at the browser boundary with deterministic token/citations/done
 *    events. No live LLM dependency — the stream returns "Hello world!" (and
 *    one citation source for test 3).
 */

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (admin-owned, dev DB)

async function loginAsAdmin(page: Page) {
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
  // 169-03 (PATTERNS finding #4): wait for the login form to mount (cold vite
  // preview can take >3s). Mirrors the shared loginAsAdmin in fixtures.ts:50
  // + the adminPage fixture — the previous 3000ms isVisible race let a cold
  // mount skip the login branch → navigated to /chat unauthenticated.
  await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 5000 }).catch(() => {});
  const usernameInput = page.locator('input[type="text"]').first();
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await page.locator('button[type="submit"]').click();
    // Deterministic wait for auth settlement: either the authenticated app
    // shell (TopBar renders <header>) or the force-change-password screen
    // ("Set a new password") appears. Replaces a fixed 1500ms sleep that
    // raced downstream assertions under a cold/slow dev stack.
    await page
      .locator("header")
      .or(page.getByText("Set a new password"))
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
  }
  // 169-03 (PATTERNS finding #4): the seeded admin has mustChangePassword=true
  // (bootstrap-admin-seed); complete the force-change once so the chat UI loads.
  // Without this branch the admin lands on ForcePasswordChange and the chat
  // textarea never renders → tests 1-3 flake. Mirrors fixtures.ts:66-79 + the
  // adminPage fixture (lines 198-207). New password "admin123" keeps the login
  // valid; the DB flag flips so subsequent runs skip this branch.
  const forceChangeTitle = page.getByText("Set a new password");
  if (await forceChangeTitle.isVisible().catch(() => false)) {
    const pwInputs = page.locator('input[type="password"]');
    await pwInputs.nth(0).fill("admin123");
    await pwInputs.nth(1).fill("admin123");
    await page.locator('button[type="submit"]').click();
    await page.locator("header").first().waitFor({ state: "visible", timeout: 10000 });
  }
}

/** Create a chat server-side via the non-streaming endpoint and return its id.
 *  The route persists the Chat row (chat.ts:79) before invoking the agent, so
 *  the chat exists even if the LLM errors. We then read the id from the list. */
async function createChatId(request: APIRequestContext): Promise<string> {
  const auth = await request.post("http://localhost:3000/api/auth/login", {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  expect(auth.ok()).toBeTruthy();
  const { token } = await auth.json();
  const headers = { Authorization: `Bearer ${token}` };
  await request.post(`http://localhost:3000/api/workspaces/${WORKSPACE_ID}/chat`, {
    headers,
    data: { message: "e2e setup message" },
    timeout: 8000,
  }).catch(() => {});
  const res = await request.get(`http://localhost:3000/api/workspaces/${WORKSPACE_ID}/chats`, { headers });
  expect(res.ok()).toBeTruthy();
  const chats = await res.json();
  const list = Array.isArray(chats) ? chats : chats.chats;
  expect(list.length).toBeGreaterThan(0);
  return list[0].id;
}

test.describe("Feature 4.10.4 — Chat flow E2E", () => {
  // CI load note: the full login+create+rename+palette chain sits close to the
  // default 30s budget under degraded CI (Ollama unreachable → slower page
  // loads); the 30s wall was hit at the final press() twice on 2026-09-01
  // (33523476596). 90s removes the cumulative-budget flake.
  test.setTimeout(90_000);
  test("rename chat + Cmd+K model palette (deterministic, LLM-independent)", async ({ page, request }) => {
    await createChatId(request); // ensures ≥1 chat exists in the workspace
    await loginAsAdmin(page);
    await page.goto("/");

    // Open the chat via the sidebar. The created chat is named "e2e setup
    // message" (message.substring(0,50) server-side). If the POST failed
    // before the chat row was persisted, fall back to any visible chat row.
    let chatRow = page.locator('text=e2e setup message').first();
    const chatRowVisible = await chatRow.isVisible({ timeout: 5000 }).catch(() => false);
    if (!chatRowVisible) {
      chatRow = page.locator('[role="option"]').first();
    }
    await expect(chatRow).toBeVisible({ timeout: 15000 });
    await chatRow.click();

    // Rename moved into ChatBadgeMenu (Feature: chat-list/console layout
    // unification). The row is a [role="option"]; when active it carries
    // aria-selected="true". Scope the badge-menu trigger to the active row so
    // we don't open another row's menu. EN aria-label = sidebar.badgeMenu =
    // "Chat actions" (language=en forced by the init script).
    const activeRow = page.locator('[role="option"][aria-selected="true"]');
    await expect(activeRow).toHaveAttribute("aria-selected", "true", { timeout: 10000 });
    const badgeMenuBtn = activeRow.locator('button[aria-label="Chat actions"]');
    await expect(badgeMenuBtn).toBeVisible({ timeout: 10000 });
    await badgeMenuBtn.click();

    // The dropdown content renders in a Radix portal. Click the "Rename" item
    // (EN sidebar.menuRename = "Rename"). Use exact match so we don't collide
    // with the TopBar's "Rename project" button (topbar.renameProject).
    const renameItem = page.getByText("Rename", { exact: true });
    await expect(renameItem).toBeVisible({ timeout: 5000 });
    await renameItem.click();

    // Selecting "Rename" sets renaming(chat.id) → an inline <Input type="text">
    // renders inside the active row (no "Save" button; submits on Enter/onBlur).
    const nameField = activeRow.locator('input[type="text"]');
    await expect(nameField).toBeVisible({ timeout: 5000 });
    await nameField.fill("E2E Renamed Chat");
    await nameField.press("Enter");
    // Rename applied → the new name renders (header span and/or sidebar row).
    await expect(page.locator("text=E2E Renamed Chat").first())
      .toBeVisible({ timeout: 8000 });

    // Open ModelPalette via Ctrl/Cmd+K. Blur the focused input first: the
    // keyboard-shortcuts hook is disabled while an input is focused.
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    await page.keyboard.press("Control+k");
    const paletteSearch = page.getByPlaceholder("Search model...");
    await expect(paletteSearch).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(paletteSearch).not.toBeVisible({ timeout: 3000 });
  });

  test("send message → streaming visual → stream settles", async ({ page }) => {
    await loginAsAdmin(page);
    // D-04: register the SSE mock BEFORE page.goto so the chat/stream request
    // is intercepted at the browser boundary on first paint. The mock emits
    // deterministic tokens "Hello", " world", "!" + done — no live LLM dependency.
    await mockCollector(page);
    await page.goto("/");

    const textarea = page.locator('textarea[aria-label="Message input"]');
    await expect(textarea).toBeVisible({ timeout: 15000 });

    const prompt = `E2E probe ${Date.now()}: what is 2 plus 2?`;
    await textarea.fill(prompt);
    await textarea.press("Enter");

    // Optimistic user message renders (Feature 4.9.1: role=article, aria-label
    // "User message"). Deterministic signal that send → ChatMessageList rendered.
    const userArticle = page.locator('[role="article"][aria-label="User message"]').first();
    await expect(userArticle).toBeVisible({ timeout: 8000 });

    // The mock SSE stream emits "Hello world!" (tokens: "Hello", " world", "!").
    // Assert the mocked assistant response renders — deterministic, no LLM.
    await expect(page.locator("text=Hello world!").first())
      .toBeVisible({ timeout: 15000 });
  });

  test("citations render when RAG sources are present", async ({ page, request }) => {
    await loginAsAdmin(page);
    // Pre-create a chat via the API and navigate to /chat/:chatId (the proven
    // chatWithRagPage fixture pattern — see fixtures.ts:179-188 and the
    // passing upload-chat-rag.spec.ts test 2). On /chat/:chatId the ChatPanel
    // loads with currentChatId set so the SSE stream request carries the
    // chatId and the frontend processes the citations event correctly.
    // Navigating to "/" (root) without a pre-created chat caused the citations
    // toggle to never render (regression from Plan 103-02).
    const chatId = await createChatId(request);
    // D-04: register the SSE mock WITH citations BEFORE page.goto. The mock
    // emits one citation source (withCitations: true) so "Sources (1)" appears.
    await mockCollector(page, "**/api/workspaces/*/chat/stream", { withCitations: true });
    await page.goto("/chat/" + chatId);

    const textarea = page.locator('textarea[aria-label="Message input"]');
    await expect(textarea).toBeVisible({ timeout: 15000 });
    await textarea.fill("Summarize the documents in this workspace");
    await textarea.press("Enter");

    // The mock emits exactly 1 citation source — assert "Sources (1)" appears
    // and the citation list renders on click. Deterministic, no indexed docs
    // needed (the mock supplies the citation, not the RAG pipeline).
    const sourcesToggle = page.locator('text=/^Sources\\s*\\(1\\)$/').first();
    await expect(sourcesToggle).toBeVisible({ timeout: 10000 });
    await sourcesToggle.click();
    await expect(page.locator(".chat-citation-list").first())
      .toBeVisible({ timeout: 5000 });
  });
});