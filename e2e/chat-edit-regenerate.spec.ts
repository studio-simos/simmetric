import { test, expect } from "./fixtures";

const SERVER_URL = "http://localhost:3000";
const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66";
const EDIT_TEST_CHAT_NAME = "E2E Edit Test Chat";

async function findEditTestChatId(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const auth = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  if (!auth.ok()) throw new Error(`findEditTestChatId: login failed (${auth.status()})`);
  const { token } = (await auth.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const res = await request.get(`${SERVER_URL}/api/workspaces/${WORKSPACE_ID}/chats`, { headers });
  if (!res.ok()) throw new Error(`findEditTestChatId: list failed (${res.status()})`);
  const chats = await res.json();
  const list = Array.isArray(chats) ? chats : chats.chats;
  const editChat = list.find((c: { name: string }) => c.name === EDIT_TEST_CHAT_NAME);
  if (!editChat) throw new Error(`findEditTestChatId: chat "${EDIT_TEST_CHAT_NAME}" not found — globalSetup must seed it`);
  return editChat.id;
}

test.describe("Chat message editing and regeneration", () => {
  test.setTimeout(60000);

  test("last user message has edit button and assistant messages have regenerate button", async ({ adminPage, request }) => {
    const page = adminPage;

    const chatRow = page.locator('[role="option"]').filter({ hasText: EDIT_TEST_CHAT_NAME }).first();
    await chatRow.waitFor({ state: "visible", timeout: 10000 });
    await chatRow.click();
    await page.waitForTimeout(3000);

    await page.waitForSelector('[role="article"]', { timeout: 15000 });

    const editButtons = page.locator('button[aria-label="Edit message"]');
    await expect(editButtons).toHaveCount(1, { timeout: 5000 });

    const regenerateButtons = page.locator('button[aria-label="Regenerate"]');
    const regenerateCount = await regenerateButtons.count();
    expect(regenerateCount).toBeGreaterThanOrEqual(1);
  });

  test("clicking edit shows textarea with message content", async ({ adminPage, request }) => {
    const page = adminPage;

    const chatRow = page.locator('[role="option"]').filter({ hasText: EDIT_TEST_CHAT_NAME }).first();
    await chatRow.waitFor({ state: "visible", timeout: 10000 });
    await chatRow.click();
    await page.waitForTimeout(3000);

    await page.waitForSelector('button[aria-label="Edit message"]', { timeout: 15000 });

    const editButton = page.locator('button[aria-label="Edit message"]').first();
    await editButton.click();

    const editTextarea = page.locator('textarea').first();
    await expect(editTextarea).toBeVisible({ timeout: 5000 });

    const content = await editTextarea.inputValue();
    expect(content.length).toBeGreaterThan(0);

    const cancelButton = page.getByRole("button", { name: "Cancel" }).first();
    if (await cancelButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cancelButton.click();
    }
  });
});
