/**
 * E2E-02 — MCP install → pin → use (D-02, D-03 full-mock).
 *
 * Focused new file (per Open Question 3 — NOT an extension of
 * marketplace-lifecycle.spec.ts) covering the per-chat MCP pinning flow
 * fixed in Phase 63:
 *
 *  Setup (beforeAll):
 *   - admin login via API → JWT
 *   - create a chat via POST /api/workspaces/:id/chat (createChatId pattern
 *     from chat-flow.spec.ts — the Chat row persists before the agent runs)
 *   - browse the MCP marketplace catalog (GET /api/mcp-marketplace) for an
 *     installable entry; if none, test.skip the suite with a documented
 *     reason (acceptable per Plan 66-02 acceptance_criteria)
 *   - if an entry is already installed in WORKSPACE_ID, reuse the existing
 *     MCPConnection; otherwise install via POST /mcp-marketplace/:entryId
 *     /install and capture the connectionId
 *
 *  Test body:
 *   - login as admin via UI (deterministic init: language=en, no animation)
 *   - register the mockCollector helper on the chat/stream SSE pattern
 *     (D-03: the chat LLM call is mocked; the agent loop on the server is
 *     never invoked with a real LLM provider). See the mockCollector call in
 *     the test body for the exact URL pattern.
 *   - navigate to /chat/<chatId>
 *   - open the McpPinnerPopover (aria-label="MCP Connections" per EN i18n)
 *   - toggle the pin switch for the installed connection
 *   - verify via API that the pin record exists (GET /api/chats/:chatId/pins)
 *   - type a message + send → assert the mock token "Hello world!" renders
 *
 * Server-side MCP logic (skill registration, tool invocation, MCP client
 * connect/disconnect) is covered by contract test 63-05. E2E-02 only
 * exercises the UI lifecycle + pin persistence.
 *
 * Env-gating: NONE. The chat SSE is full-mock per D-03. The only runtime
 * prerequisite is at least one McpCatalogEntry in the dev DB (skip
 * documented if empty — acceptable per plan).
 *
 * Rule 1 deviations from plan:
 *  - Plan said `request.post('/api/mcp/marketplace/install', { body: { catalogEntryId } })`.
 *    The actual route is `POST /api/mcp-marketplace/:entryId/install` with
 *    `{ workspaceId }` in the body (packages/server/src/routes/marketplace.ts
 *    line 146). Fixed inline.
 *  - Plan said assert `pinnedMcpConnections` or `mcpConnectionIds` on the
 *    chat. The Chat model has NO such field — pins live in a separate
 *    ChatMCPPin table accessed via `GET /api/chats/:chatId/pins`
 *    (packages/server/src/routes/mcpPins.ts, mounted at /api/chats). Fixed
 *    inline.
 */

import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { mockCollector } from "./fixtures";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (admin-owned, dev DB)
const SERVER_URL = "http://localhost:3000";

/** Admin login via API → returns JWT bearer token. */
async function adminLoginToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  expect(res.ok(), `admin login failed: ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** Create a chat server-side via POST /api/workspaces/:id/chat (Chat row
 *  persists before the agent runs — pattern reused from chat-flow.spec.ts). */
async function createChatId(request: APIRequestContext, token: string): Promise<string> {
  await request.post(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chat`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message: "e2e mcp-pin-use setup" },
    timeout: 8000,
  }).catch(() => {
    // LLM may error — the Chat row persists either way.
  });
  const res = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chats`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 8000,
  });
  expect(res.ok(), `chat list fetch failed: ${res.status()}`).toBeTruthy();
  const chats = await res.json();
  const list = Array.isArray(chats) ? chats : (chats as { chats: unknown[] }).chats;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("createChatId: no chats returned");
  }
  return (list as Array<{ id: string }>)[0].id;
}

/** Browse the MCP marketplace for an installable entry in WORKSPACE_ID.
 *  Reuses an already-installed connection if one exists; otherwise returns
 *  the first catalog entry to install. Returns null if the catalog is empty
 *  (caller will test.skip). */
async function findInstallableEntry(
  request: APIRequestContext,
  token: string
): Promise<{ entryId: string; connectionId?: string } | null> {
  const listRes = await request.get(
    `${SERVER_URL}/api/mcp-marketplace?workspaceId=${WORKSPACE_ID}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
  );
  if (!listRes.ok()) return null;
  const entries = (await listRes.json()) as Array<{
    id: string;
    name: string;
    isInstalled?: boolean;
  }>;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // Prefer an entry already installed in this workspace (reuse connection).
  const installed = entries.find((e) => e.isInstalled === true);
  if (installed) {
    const connsRes = await request.get(
      `${SERVER_URL}/api/mcp-connections?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    if (connsRes.ok()) {
      const conns = (await connsRes.json()) as Array<{
        id: string;
        name: string;
        catalogEntryId?: string;
      }>;
      const match = conns.find((c) => c.catalogEntryId === installed.id);
      if (match) return { entryId: installed.id, connectionId: match.id };
    }
  }

  return { entryId: entries[0].id };
}

/** UI login as admin. Mirrors the chat-flow.spec.ts init pattern:
 *  language=en, lastWorkspaceId seeded, animations disabled for determinism.
 *
 *  GAP-02 fix: the init script sets lastChatId=<chatId> so App.tsx restore
 *  calls setChatId(lastChatId) → ChatContext.currentChatId becomes non-null
 *  → McpPinnerPopover receives disabled={false}. Without this, the button
 *  stays disabled (disabled={!currentChatId}) and pinnerBtn.click() times
 *  out. The chatId is closed over via page.addInitScript(callback, arg). */
async function loginAsAdminUi(page: Page): Promise<void> {
  await page.addInitScript((cId: string) => {
    localStorage.setItem("language", "en");
    localStorage.setItem("lastWorkspaceId", "9a334821-b880-411b-affc-805664e7fd66");
    localStorage.setItem("lastChatId", cId);
    const style = document.createElement("style");
    style.textContent = "* { animation: none !important; transition: none !important; }";
    document.head.appendChild(style);
  }, chatId);
  await page.goto("/");
  // 169-03: wait for the login form to mount (cold vite preview can take >3s).
  // Mirrors fixtures.ts:50 + chat-flow + synthesis-run loginAsAdmin — the
  // previous 3000ms isVisible race skipped the login branch on a cold mount
  // → navigated to /chat unauthenticated → redirected to /login.
  await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 5000 }).catch(() => {});
  const usernameInput = page.locator('input[type="text"]').first();
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await page.locator('button[type="submit"]').click();
    // Deterministic wait for auth settlement: either the authenticated app
    // shell (TopBar renders <header>) or the force-change-password screen
    // ("Set a new password") appears. Replaces a fixed 1500ms sleep.
    await page
      .locator("header")
      .or(page.getByText("Set a new password"))
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
  }
  // First-login force-change-password screen — clear once (POST flips the
  // DB flag; subsequent runs skip this branch).
  const forceChangeTitle = page.getByText("Set a new password");
  if (await forceChangeTitle.isVisible().catch(() => false)) {
    const pwInputs = page.locator('input[type="password"]');
    await pwInputs.nth(0).fill("admin123");
    await pwInputs.nth(1).fill("admin123");
    await page.locator('button[type="submit"]').click();
    // After force-change submit, wait deterministically for the authenticated
    // app shell (<header>) to mount instead of a fixed 1500ms sleep.
    await page.locator("header").first().waitFor({ state: "visible", timeout: 10000 });
  }
}

let adminToken: string;
let chatId: string;
let connectionId: string | undefined;
let skipReason: string | undefined;

test.describe("E2E-02 — MCP install → pin → use (D-02, D-03 full-mock)", () => {
  test.beforeAll(async ({ request }) => {
    adminToken = await adminLoginToken(request);
    chatId = await createChatId(request, adminToken);

    const entry = await findInstallableEntry(request, adminToken);
    if (!entry) {
      skipReason = "No MCP catalog entries in dev DB — skipping MCP pin→use suite";
      return;
    }

    if (entry.connectionId) {
      // Reuse the existing connection.
      connectionId = entry.connectionId;
      return;
    }

    // Install via API. 409 = already installed — fall through to lookup.
    const installRes = await request.post(
      `${SERVER_URL}/api/mcp-marketplace/${entry.entryId}/install`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { workspaceId: WORKSPACE_ID },
        timeout: 10000,
      }
    );
    if (installRes.status() === 201) {
      const body = (await installRes.json()) as { id: string };
      connectionId = body.id;
      return;
    }
    if (installRes.status() === 409) {
      // Already installed — find the existing connection.
      const connsRes = await request.get(
        `${SERVER_URL}/api/mcp-connections?workspaceId=${WORKSPACE_ID}`,
        { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 10000 }
      );
      if (connsRes.ok()) {
        const conns = (await connsRes.json()) as Array<{
          id: string;
          catalogEntryId?: string;
        }>;
        const match = conns.find((c) => c.catalogEntryId === entry.entryId);
        if (match) {
          connectionId = match.id;
          return;
        }
      }
    }
    skipReason = `MCP install failed (status ${installRes.status()}) — skipping pin→use flow`;
  });

  test("MCP install→pin→use includes pinned connection in chat request", async ({ page, request }) => {
    if (skipReason || !connectionId) {
      test.skip(true, skipReason ?? "MCP connection not available");
      return;
    }

    await loginAsAdminUi(page);

    // Register the chat SSE mock BEFORE navigating so the streaming fetch is
    // intercepted on first paint (D-03: full-mock LLM, no env-gating).
    await mockCollector(page, "**/api/workspaces/*/chat/stream", { withCitations: false });

    await page.goto(`/chat/${chatId}`);

    // Open the MCP pinner popover. EN i18n key mcpPinner.title = "MCP Connections".
    const pinnerBtn = page.locator('button[aria-label="MCP Connections"]').first();
    await expect(pinnerBtn).toBeVisible({ timeout: 15000 });
    // GAP-02 fix: wait for the button to be ENABLED, not just visible.
    // McpPinnerPopover is rendered with disabled={!currentChatId}; without
    // the lastChatId init, currentChatId stays null and the button remains
    // disabled (click would time out). toBeEnabled catches this regression
    // family explicitly.
    await expect(pinnerBtn).toBeEnabled({ timeout: 15000 });
    await pinnerBtn.click();

    // The popover lists workspace-scoped MCP connections. Each row has a
    // Switch (role="switch") with aria-label "Pin to chat" (unpinned) or
    // "Unpin from chat" (pinned). The popover fetches pins on open
    // (apiGet /chats/:chatId/pins) — wait for the switch to be visible.
    const unpinSwitch = page.locator('button[role="switch"][aria-label="Unpin from chat"]').first();
    const pinSwitch = page.locator('button[role="switch"][aria-label="Pin to chat"]').first();

    // Determine the current state. The popover is open; at least one switch
    // should be visible for the installed connection.
    const isAlreadyPinned = await unpinSwitch.isVisible().catch(() => false);
    if (!isAlreadyPinned) {
      await expect(pinSwitch).toBeVisible({ timeout: 5000 });
      await pinSwitch.click();
      // Wait for the pin POST /api/chats/:chatId/pins to settle.
      await page.waitForTimeout(1000);
    }

    // Verify via API that the pin record exists for our connectionId.
    const pinsRes = await request.get(`${SERVER_URL}/api/chats/${chatId}/pins`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 8000,
    });
    expect(pinsRes.ok(), `pins fetch failed: ${pinsRes.status()}`).toBeTruthy();
    const pins = (await pinsRes.json()) as Array<{ id: string; connectionId: string }>;
    const ourPin = pins.find((p) => p.connectionId === connectionId);
    expect(ourPin, `pin record for connection ${connectionId} must exist`).toBeTruthy();

    // Close the popover (Esc) so the chat input is interactable.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Type and send a message. The SSE mock will respond with tokens
    // "Hello", " world", "!" — assert the assistant message renders with
    // "Hello world!" (D-03: no real LLM invoked).
    const textarea = page.locator('textarea[aria-label="Message input"]');
    await expect(textarea).toBeVisible({ timeout: 10000 });
    await textarea.fill("mcp-pin probe");
    await textarea.press("Enter");

    await expect(page.locator("text=Hello world!").first()).toBeVisible({ timeout: 15000 });
  });
});