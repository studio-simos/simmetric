/**
 * E2E-02 — Upload → Chat-with-RAG (D-02, D-03 full-mock).
 *
 * Two coupled but separate tests covering the upload→chat-RAG critical flow
 * fixed in Phases 60-65:
 *
 *  1. "upload persists Document row immediately" — real multipart POST to
 *     /api/documents/upload, assert 201, assert the document appears in the
 *     workspace document list. No wait for async indexing (D-02: the Document
 *     row persists immediately; the collector callback PUT /api/documents/:id
 *     /status runs later and is out of scope for this assertion).
 *
 *  2. "chat-with-RAG renders citations from mockCollector SSE" — uses the
 *     `chatWithRagPage` fixture (admin login + chat created via API + SSE
 *     route pre-registered with canned citations + page navigated to
 *     /chat/<chatId>). Type a message, send, assert the "Sources (N)" toggle
 *     appears, click to expand, assert the citation documentName "doc.md"
 *     renders. NO LLM, NO collector, NO vector DB — full-mock per D-03.
 *
 * Reference: .planning/phases/66-e2e-playwright/66-02-PLAN.md Task 1.
 *
 * Rule 1 deviation from plan: the plan's Test 1 said
 *   `request.post('/api/workspaces/9a33.../documents', { multipart: { file } })`
 * but the actual server route is `POST /api/documents/upload` with
 * `workspaceId` in the multipart body (packages/server/src/routes/documents.ts
 * line 232). There is no `/api/workspaces/:id/documents` POST endpoint. The
 * plan also missed the `workspaceId` multipart field — the route 400s without
 * it. Fixed inline.
 *
 * Env-gating: NONE. Both tests are full-mock (D-03) and run without a
 * configured LLM provider or a running collector.
 */

import { test, expect, type APIRequestContext } from "./fixtures";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (admin-owned, dev DB)
const SERVER_URL = "http://localhost:3000";
const UPLOAD_FILENAME = "e2e-test-upload-chat-rag.txt";

/** Login as admin via API and return the JWT bearer token. */
async function adminLoginToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  expect(res.ok(), `admin login failed: ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { token: string };
  return body.token;
}

test.describe("E2E-02 — Upload → Chat-with-RAG (D-02, D-03 full-mock)", () => {
  test("upload persists Document row immediately (no wait for indexing)", async ({ request }) => {
    const token = await adminLoginToken(request);
    const headers = { Authorization: `Bearer ${token}` };

    // POST /api/documents/upload — multipart with file + workspaceId.
    // Rule 1 fix: the plan referenced /api/workspaces/:id/documents which does
    // not exist; the actual route is /api/documents/upload with workspaceId in
    // the multipart body (documents.ts:232).
    const uploadRes = await request.post(`${SERVER_URL}/api/documents/upload`, {
      headers,
      multipart: {
        file: {
          name: UPLOAD_FILENAME,
          mimeType: "text/plain",
          buffer: Buffer.from(
            "E2E upload-chat-rag deterministic probe. " +
            "This file is created by Playwright suite e2e/upload-chat-rag.spec.ts " +
            "to verify the upload→document-list critical path."
          ),
        },
        workspaceId: WORKSPACE_ID,
      },
      timeout: 20000,
    });
    expect(uploadRes.status(), `upload must return 201, got ${uploadRes.status()}`).toBe(201);

    // List documents in the workspace. D-02: the Document row is persisted
    // synchronously by the route handler — no need to wait for the async
    // collector indexing callback (PUT /api/documents/:id/status).
    const listRes = await request.get(
      `${SERVER_URL}/api/documents?workspaceId=${WORKSPACE_ID}`,
      { headers, timeout: 10000 }
    );
    expect(listRes.ok(), `document list must return 2xx, got ${listRes.status()}`).toBeTruthy();
    const documents = (await listRes.json()) as Array<{ name: string; id: string }>;
    const ours = documents.find((d) => d.name === UPLOAD_FILENAME);
    expect(ours, `uploaded ${UPLOAD_FILENAME} must appear in the workspace document list`).toBeTruthy();
  });

  test("chat-with-RAG renders citations from mockCollector SSE (D-03 full-mock)", async ({ chatWithRagPage }) => {
    // chatWithRagPage fixture (from ./fixtures, Plan 66-01):
    //   - admin login via UI
    //   - chatId created via POST /api/workspaces/:id/chat (message persisted)
    //   - mockCollector registered on **/api/workspaces/*/chat/stream with
    //     withCitations:true (canned citation: documentName "doc.md")
    //   - page navigated to /chat/<chatId>
    // The SSE mock emits: token "Hello", " world", "!", citations [{doc.md}],
    // done. No LLM, no collector, no vector DB.

    const textarea = chatWithRagPage.locator('textarea[aria-label="Message input"]');
    await expect(textarea).toBeVisible({ timeout: 15000 });

    await textarea.fill("test query");
    await textarea.press("Enter");

    // The assistant message renders with the mock tokens "Hello world!".
    // Optimistic user message renders first (role=article, aria-label="User
    // message"); then the SSE mock fires synchronously and the assistant
    // message streams in. We assert the citation toggle appears — the mock
    // emits a `citations` event with documentName "doc.md", which the frontend
    // renders as the "Sources (N)" collapsible toggle (chat-flow.spec.ts
    // pattern; EN i18n key chat.citations.toggle = "Sources ({{count}})").
    const sourcesToggle = chatWithRagPage.locator('text=/^Sources\\s*\\(\\d+\\)$/').first();
    await expect(sourcesToggle).toBeVisible({ timeout: 15000 });

    // Expand the citation list.
    await sourcesToggle.click();

    // Assert the canned citation documentName "doc.md" renders in the list.
    // ChatCitations.tsx renders source.documentName as a truncated text block;
    // "doc.md" should be findable as page text after the list is open.
    await expect(chatWithRagPage.locator("text=doc.md").first()).toBeVisible({ timeout: 5000 });
  });
});