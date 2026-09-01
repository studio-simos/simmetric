/**
 * Phase 73 — SC-2 unified-upload destination flows (D-73-01/02/04).
 *
 * Five tests covering the destination matrix of the unified upload area
 * (POST /api/uploads stage + POST /api/uploads/:id/assign fan-out):
 *
 *  1. upload → RAG        — stage .txt, assign {rag:true,kb:false}, assert the
 *                           new Document row is visible in GET /api/documents
 *                           immediately (F60 immediate-persist invariant — no
 *                           wait for the async collector :3210 callback).
 *  2. upload → KB         — create an archive, stage .md, assign
 *                           {rag:false,kb:true,archiveId}, assert the assign
 *                           returns 200 with a non-null kbResult AND the draft
 *                           re-listed by GET /api/uploads/pending with
 *                           kbEnabled=true + assignedArchiveId set (the AIJ row
 *                           is created in-process by dispatchKbLeg — no
 *                           collector dependency for the row creation).
 *  3. upload → both       — stage .md, assign {rag:true,kb:true,archiveId},
 *                           assert BOTH the Document row (RAG immediate-persist)
 *                           AND the pending draft kbEnabled=true.
 *  4. upload → unassigned → assign-later — stage .txt (no destination), assert
 *                           GET /api/uploads/pending lists the draft with
 *                           parseStatus="uploaded" + ragEnabled/kbEnabled
 *                           false, then assign {rag:true,kb:false} and assert
 *                           the Document row appears.
 *  5. non-admin blocked when ALLOW_NON_ADMIN_UPLOAD=false (D-73-04, PRM-02) —
 *                           create a non-admin user (admin-register) + a
 *                           project/workspace owned by them with
 *                           allowMemberUploads=false (Prisma direct seed so the
 *                           OR-gate's per-workspace branch cannot satisfy the
 *                           gate), flip the global toggle off, assert POST
 *                           /api/uploads returns 403 for the non-admin JWT,
 *                           assert the UI /uploads renders the "Uploads
 *                           disabled" empty-state, then afterEach restores the
 *                           toggle to true (T-73-05 test-isolation mitigation).
 *
 * Pattern (D-73-02): staging + assign legs are REAL HTTP against the dev
 * server (admin/admin123 auto-seeded via bootstrap-admin-seed). Only the
 * chat/citation SSE leg would be mocked — none of these 5 flows exercise
 * chat, so mockCollector is not invoked here. The collector :3210 is NOT in
 * the playwright.config.ts webServer list; the RAG flow relies on the
 * immediate-persist Document row (F60 fix), the KB flow relies on the
 * in-process AIJ row creation.
 *
 * Reference: .planning/phases/73-non-regression-verification-tests-i18n-parity/
 * 73-03-PLAN.md Task 2 + 73-RESEARCH.md §"Pattern 1/2/3".
 */

import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { makeE2ePrisma } from "./lib/prisma";

const WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66"; // "Elegregio" (admin-owned, dev DB)
const SERVER_URL = "http://localhost:3000";

/** Best-effort DATABASE_URL resolution for the non-admin Prisma seed.
 *  Mirrors e2e/globalSetup.ts:50-61 but resolves `dotenv` from
 *  `packages/server/node_modules` via createRequire — pnpm strict isolation
 *  does NOT hoist dotenv into the root node_modules, so a bare
 *  `import("dotenv")` from the e2e worker (cwd = repo root) fails silently
 *  (the same failure synthesis-run/widget-embed log as "DATABASE_URL not
 *  set"). Resolving from the server package makes the seed actually run when
 *  the root .env is present; returns undefined otherwise so the caller
 *  can test.skip() (repo convention — see synthesis-run.spec.ts:244). */
async function loadDatabaseUrl(): Promise<string | undefined> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const { createRequire } = await import("node:module");
    const path = await import("node:path");
    const requireFromServer = createRequire(path.resolve("packages/server"));
    const dotenv = requireFromServer("dotenv") as { config: (opts: { path: string }) => void };
    dotenv.config({ path: path.resolve(".env") });
  } catch {
    /* fall through — DATABASE_URL stays unset, caller skips */
  }
  return process.env.DATABASE_URL;
}

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

/** Flip a SystemConfig boolean toggle via PUT /api/system/settings. */
async function setToggle(
  request: APIRequestContext,
  adminToken: string,
  key: string,
  value: string,
): Promise<void> {
  const res = await request.put(`${SERVER_URL}/api/system/settings`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { configs: [{ key, value }] },
    timeout: 8000,
  });
  expect(res.ok(), `toggle ${key}=${value} failed: ${res.status()}`).toBeTruthy();
}

/** Unique suffix so repeated runs do not collide in the dev DB. */
const RUN_ID = Date.now().toString();

/**
 * WR-03: describe-scoped registries of rows created by tests 1-4 so the
 * afterAll cleanup can soft-delete (UploadDraft, Document) / hard-delete
 * (ArchiveImportJob — no deletedAt column) the staged rows. Without this,
 * every E2E run on a shared dev DB leaves drafts, RAG Document rows, and
 * AIJ rows behind (the RUN_ID suffix only prevents name collisions, not row
 * accumulation). The archive soft-delete in each test's finally already
 * tombstones the Archive row but leaves AIJ/draft/document rows intact —
 * the registry + afterAll closes that gap. Idempotent: cleanup guards on
 * `deletedAt: null` and wraps each step in try/catch so a missing row on a
 * partial run is a no-op.
 */
const createdDraftIds: string[] = [];
const createdDocumentNames: string[] = [];
const createdArchiveIds: string[] = [];

test.describe("unified-upload destinations", () => {
  test("upload → RAG (stage + assign rag=true)", async ({ request }) => {
    const token = await adminLoginToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const filename = `e2e-rag-${RUN_ID}.txt`;

    // Stage a .txt draft (text/plain is RAG-eligible).
    const stageRes = await request.post(`${SERVER_URL}/api/uploads`, {
      headers,
      multipart: {
        file: {
          name: filename,
          mimeType: "text/plain",
          buffer: Buffer.from(`E2E upload-rag probe ${RUN_ID}`),
        },
        workspaceId: WORKSPACE_ID,
      },
      timeout: 20000,
    });
    expect(stageRes.status(), `stage must return 201, got ${stageRes.status()}`).toBe(201);
    const draft = (await stageRes.json()) as { id: string };
    expect(draft.id).toBeTruthy();
    createdDraftIds.push(draft.id);
    createdDocumentNames.push(filename);

    // Assign to RAG only.
    const assignRes = await request.post(`${SERVER_URL}/api/uploads/${draft.id}/assign`, {
      headers,
      data: { rag: true, kb: false },
      timeout: 20000,
    });
    expect(assignRes.status(), `assign must return 2xx, got ${assignRes.status()}`).toBeLessThan(300);
    expect([200, 202]).toContain(assignRes.status());

    // Immediate-persist invariant (F60): the Document row is created
    // synchronously by dispatchRagLeg (uploadDraftService.ts:99) BEFORE the
    // async collector callback — visible in the document list right away.
    const listRes = await request.get(
      `${SERVER_URL}/api/documents?workspaceId=${WORKSPACE_ID}`,
      { headers, timeout: 10000 },
    );
    expect(listRes.ok(), `document list must return 2xx, got ${listRes.status()}`).toBeTruthy();
    const documents = (await listRes.json()) as Array<{ name: string; id: string }>;
    expect(
      documents.find((d) => d.name === filename),
      `staged ${filename} must appear in the workspace document list (immediate-persist)`,
    ).toBeTruthy();
  });

  test("upload → KB (stage + assign kb=true, archiveId)", async ({ request }) => {
    const token = await adminLoginToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const archiveName = `e2e-kb-${RUN_ID}`;
    const filename = `e2e-kb-${RUN_ID}.md`;

    // Create an archive (global entity — no workspaceId in the body).
    const archiveRes = await request.post(`${SERVER_URL}/api/archives`, {
      headers,
      data: { name: archiveName, description: "E2E KB destination flow" },
      timeout: 10000,
    });
    expect(archiveRes.status(), `archive create must return 201, got ${archiveRes.status()}`).toBe(201);
    const archive = (await archiveRes.json()) as { id: string };
    expect(archive.id).toBeTruthy();
    createdArchiveIds.push(archive.id);

    try {
      // Stage a .md draft (text/markdown is KB-eligible via ALLOWED_ARCHIVE_MIME).
      const stageRes = await request.post(`${SERVER_URL}/api/uploads`, {
        headers,
        multipart: {
          file: {
            name: filename,
            mimeType: "text/markdown",
            buffer: Buffer.from(`# E2E KB probe ${RUN_ID}\n\nKnowledge base page content.`),
          },
          workspaceId: WORKSPACE_ID,
        },
        timeout: 20000,
      });
      expect(stageRes.status(), `stage must return 201, got ${stageRes.status()}`).toBe(201);
      const draft = (await stageRes.json()) as { id: string };
      createdDraftIds.push(draft.id);

      // Assign to KB only.
      const assignRes = await request.post(`${SERVER_URL}/api/uploads/${draft.id}/assign`, {
        headers,
        data: { rag: false, kb: true, archiveId: archive.id },
        timeout: 20000,
      });
      expect(assignRes.status(), `assign must return 2xx, got ${assignRes.status()}`).toBeLessThan(300);
      const assignBody = (await assignRes.json()) as { kbResult: string | null };
      // The KB leg dispatches an ArchiveImportJob in-process (uploadDraftService
      // .ts:168) — the assign response carries the per-leg settle status.
      expect(assignBody.kbResult, `kbResult must be reported by the fan-out`).not.toBeNull();

      // The pending list reflects the in-process AIJ row creation: kbEnabled
      // flipped true + assignedArchiveId set (no collector dependency for the
      // row creation — the ArchivePage itself is produced by the async
      // collector parse pipeline, which is out of scope for this assertion).
      const pendingRes = await request.get(
        `${SERVER_URL}/api/uploads/pending?workspaceId=${WORKSPACE_ID}`,
        { headers, timeout: 10000 },
      );
      expect(pendingRes.ok()).toBeTruthy();
      const pending = (await pendingRes.json()) as Array<{
        id: string;
        kbEnabled: boolean;
        assignedArchiveId: string | null;
      }>;
      const ours = pending.find((d) => d.id === draft.id);
      expect(ours, `draft ${draft.id} must appear in the pending list`).toBeTruthy();
      expect(ours!.kbEnabled, `kbEnabled must be true after the KB assign`).toBe(true);
      expect(ours!.assignedArchiveId, `assignedArchiveId must match the target archive`).toBe(archive.id);
    } finally {
      // Idempotent soft-delete cleanup (analog create-project-sidebar.spec.ts).
      await request
        .delete(`${SERVER_URL}/api/archives/${archive.id}`, { headers })
        .catch(() => {});
    }
  });

  test("upload → both (stage + assign rag=true kb=true)", async ({ request }) => {
    const token = await adminLoginToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const archiveName = `e2e-both-${RUN_ID}`;
    const filename = `e2e-both-${RUN_ID}.md`;

    const archiveRes = await request.post(`${SERVER_URL}/api/archives`, {
      headers,
      data: { name: archiveName },
      timeout: 10000,
    });
    expect(archiveRes.status()).toBe(201);
    const archive = (await archiveRes.json()) as { id: string };
    createdArchiveIds.push(archive.id);

    try {
      // .md is both RAG-eligible (all 12 MIME) and KB-eligible (ALLOWED_ARCHIVE_MIME).
      const stageRes = await request.post(`${SERVER_URL}/api/uploads`, {
        headers,
        multipart: {
          file: {
            name: filename,
            mimeType: "text/markdown",
            buffer: Buffer.from(`# E2E both probe ${RUN_ID}\n\nDual-destination content.`),
          },
          workspaceId: WORKSPACE_ID,
        },
        timeout: 20000,
      });
      expect(stageRes.status()).toBe(201);
      const draft = (await stageRes.json()) as { id: string };
      createdDraftIds.push(draft.id);
      createdDocumentNames.push(filename);

      const assignRes = await request.post(`${SERVER_URL}/api/uploads/${draft.id}/assign`, {
        headers,
        data: { rag: true, kb: true, archiveId: archive.id },
        timeout: 20000,
      });
      expect(assignRes.status(), `assign must return 2xx, got ${assignRes.status()}`).toBeLessThan(300);

      // RAG immediate-persist: the Document row is visible right away.
      const listRes = await request.get(
        `${SERVER_URL}/api/documents?workspaceId=${WORKSPACE_ID}`,
        { headers, timeout: 10000 },
      );
      expect(listRes.ok()).toBeTruthy();
      const documents = (await listRes.json()) as Array<{ name: string }>;
      expect(documents.find((d) => d.name === filename), `RAG leg must persist the Document row`).toBeTruthy();

      // KB leg: the pending list shows kbEnabled=true + assignedArchiveId.
      const pendingRes = await request.get(
        `${SERVER_URL}/api/uploads/pending?workspaceId=${WORKSPACE_ID}`,
        { headers, timeout: 10000 },
      );
      expect(pendingRes.ok()).toBeTruthy();
      const pending = (await pendingRes.json()) as Array<{
        id: string;
        kbEnabled: boolean;
        assignedArchiveId: string | null;
      }>;
      const ours = pending.find((d) => d.id === draft.id);
      expect(ours, `draft must appear in the pending list`).toBeTruthy();
      expect(ours!.kbEnabled, `kbEnabled must be true after the both assign`).toBe(true);
      expect(ours!.assignedArchiveId).toBe(archive.id);
    } finally {
      await request
        .delete(`${SERVER_URL}/api/archives/${archive.id}`, { headers })
        .catch(() => {});
    }
  });

  test("upload → unassigned → assign-later", async ({ request }) => {
    const token = await adminLoginToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const filename = `e2e-unassigned-${RUN_ID}.txt`;

    // Stage with no destination (no archiveId, no assign yet).
    const stageRes = await request.post(`${SERVER_URL}/api/uploads`, {
      headers,
      multipart: {
        file: {
          name: filename,
          mimeType: "text/plain",
          buffer: Buffer.from(`E2E unassigned probe ${RUN_ID}`),
        },
        workspaceId: WORKSPACE_ID,
      },
      timeout: 20000,
    });
    expect(stageRes.status()).toBe(201);
    const draft = (await stageRes.json()) as { id: string };
    createdDraftIds.push(draft.id);
    createdDocumentNames.push(filename);

    // The pending list must surface the unassigned draft (parseStatus
    // "uploaded", both legs disabled).
    const pendingRes = await request.get(
      `${SERVER_URL}/api/uploads/pending?workspaceId=${WORKSPACE_ID}`,
      { headers, timeout: 10000 },
    );
    expect(pendingRes.ok()).toBeTruthy();
    const pendingBefore = (await pendingRes.json()) as Array<{
      id: string;
      parseStatus: string;
      ragEnabled: boolean;
      kbEnabled: boolean;
    }>;
    const before = pendingBefore.find((d) => d.id === draft.id);
    expect(before, `unassigned draft must appear in the pending list`).toBeTruthy();
    expect(before!.parseStatus, `unassigned draft parseStatus must be "uploaded"`).toBe("uploaded");
    expect(before!.ragEnabled).toBe(false);
    expect(before!.kbEnabled).toBe(false);

    // Assign-later to RAG.
    const assignRes = await request.post(`${SERVER_URL}/api/uploads/${draft.id}/assign`, {
      headers,
      data: { rag: true, kb: false },
      timeout: 20000,
    });
    expect(assignRes.status()).toBeLessThan(300);

    // Immediate-persist: the Document row appears after the late assign.
    const listRes = await request.get(
      `${SERVER_URL}/api/documents?workspaceId=${WORKSPACE_ID}`,
      { headers, timeout: 10000 },
    );
    expect(listRes.ok()).toBeTruthy();
    const documents = (await listRes.json()) as Array<{ name: string }>;
    expect(
      documents.find((d) => d.name === filename),
      `late-assigned ${filename} must appear in the document list`,
    ).toBeTruthy();
  });

  test("non-admin blocked when ALLOW_NON_ADMIN_UPLOAD=false (D-73-04, PRM-02)", async ({ request, page }) => {
    const adminToken = await adminLoginToken(request);
    const adminHeaders = { Authorization: `Bearer ${adminToken}` };

    // --- Setup: create a non-admin user via the admin-register route. ---
    // The route is admin-only (requireAdmin) and defaults the role to "user"
    // when `role` is omitted (auth.ts:88-121 + adminRegisterSchema). Idempotent:
    // a repeated run hits a 400 "already exists" and proceeds to login.
    const nonAdminCreds = {
      username: `e2e_nonadmin_${RUN_ID}`,
      email: `e2e_nonadmin_${RUN_ID}@test.local`,
      password: "Test1234!",
    };
    await request
      .post(`${SERVER_URL}/api/auth/admin-register`, {
        headers: adminHeaders,
        data: nonAdminCreds,
        timeout: 8000,
      })
      .catch(() => { /* already exists on re-run — proceed to login */ });

    const loginRes = await request.post(`${SERVER_URL}/api/auth/login`, {
      data: { username: nonAdminCreds.username, password: nonAdminCreds.password },
      timeout: 8000,
    });
    expect(loginRes.ok(), `non-admin login failed: ${loginRes.status()}`).toBeTruthy();
    const nonAdminToken = (await loginRes.json()) as { token: string };
    const nonAdminHeaders = { Authorization: `Bearer ${nonAdminToken.token}` };

    // Resolve the non-admin user id (needed for the Prisma project/workspace seed).
    const meRes = await request.get(`${SERVER_URL}/api/auth/me`, { headers: nonAdminHeaders, timeout: 8000 });
    expect(meRes.ok()).toBeTruthy();
    const me = (await meRes.json()) as { id: string };
    const nonAdminUserId = me.id;

    // --- Prisma seed: a project + workspace owned by the non-admin with
    //     allowMemberUploads=false. The per-workspace branch of the OR-gate
    //     (assertNonAdminUploadAllowed) must NOT satisfy the gate, so the
    //     global toggle flip is the only thing being exercised. The non-admin
    //     owns the project → assertWorkspaceAccess passes via isProjectOwner
    //     (uploads.ts:145) → the request reaches the toggle check. ---
    const databaseUrl = await loadDatabaseUrl();
    // Repo convention (synthesis-run.spec.ts:244): when DATABASE_URL cannot be
    // resolved in the e2e worker (dotenv not hoisted to root, no env var), skip
    // the seed-dependent test rather than throwing — the PRM-02 toggle gate is
    // exercised only in environments with DB access.
    test.skip(!databaseUrl, "DATABASE_URL not resolvable — skipping non-admin Prisma seed");
    const prisma = makeE2ePrisma(databaseUrl!);
    let nonAdminWorkspaceId = "";
    let nonAdminProjectId = "";
    try {
      // The admin-register route creates the user with mustChangePassword=true
      // (same as the bootstrap admin). The adminPage fixture clears it via the
      // UI force-change flow; for the non-admin we clear it via the
      // /api/auth/set-initial-password endpoint (auth.ts:495) — NOT a direct
      // Prisma update — so the server-side auth cache (authService.ts:213
      // invalidateAuthCache) is invalidated atomically with the flag clear.
      // A bare prisma.user.update leaves the Redis auth:user:<id> cache
      // (TTL = SESSION_EXPIRY) serving stale mustChangePassword=true → the
      // frontend's /api/auth/me returns true → App.tsx:443 renders the
      // ForcePasswordChange screen instead of /uploads, and the "Uploads
      // disabled" assertion never sees its target. set-initial-password sets
      // the new password to the SAME value ("Test1234!") so the subsequent
      // non-admin login still works.
      await request.post(`${SERVER_URL}/api/auth/set-initial-password`, {
        headers: nonAdminHeaders,
        data: { newPassword: nonAdminCreds.password },
        timeout: 8000,
      });
      const project = await prisma.project.create({
        data: { name: `e2e-na-proj-${RUN_ID}`, createdBy: nonAdminUserId },
      });
      nonAdminProjectId = project.id;
      const workspace = await prisma.workspace.create({
        data: {
          projectId: project.id,
          name: `e2e-na-ws-${RUN_ID}`,
          allowMemberUploads: false,
        },
      });
      nonAdminWorkspaceId = workspace.id;

      // --- Flip the global toggle OFF (admin). ---
      await setToggle(request, adminToken, "ALLOW_NON_ADMIN_UPLOAD", "false");

      // --- API assertion: POST /api/uploads must return 403 for the
      //     non-admin JWT (PRM-02 assertNonAdminUploadAllowed OR-gate fails:
      //     ALLOW_NON_ADMIN_UPLOAD="false" && workspace.allowMemberUploads=false,
      //     non-admin → no bypass). ---
      const uploadRes = await request.post(`${SERVER_URL}/api/uploads`, {
        headers: nonAdminHeaders,
        multipart: {
          file: {
            name: `e2e-na-blocked-${RUN_ID}.txt`,
            mimeType: "text/plain",
            buffer: Buffer.from(`E2E non-admin blocked probe ${RUN_ID}`),
          },
          workspaceId: nonAdminWorkspaceId,
        },
        timeout: 20000,
      });
      expect(
        uploadRes.status(),
        `non-admin upload must be blocked (403) when the toggle is off, got ${uploadRes.status()}`,
      ).toBe(403);

      // --- UI assertion: the non-admin /uploads renders the admin-disabled
      //     empty-state (UnifiedUploadPage.tsx:185-198 isNonAdminDisabled
      //     gate — Lock icon + "Uploads disabled" heading). Hydrate the
      //     session by setting the token + lastWorkspaceId in localStorage
      //     before first navigation (mirrors the adminPage fixture pattern). ---
      await page.addInitScript(({ token, wsId }) => {
        localStorage.setItem("language", "en");
        localStorage.setItem("token", token);
        localStorage.setItem("lastWorkspaceId", wsId);
        const style = document.createElement("style");
        style.textContent = "* { animation: none !important; transition: none !important; }";
        document.head.appendChild(style);
      }, { token: nonAdminToken.token, wsId: nonAdminWorkspaceId });

      await page.goto("/uploads");
      // The isNonAdminDisabled gate fires after the useMe/useSettingsHelpers
      // hooks resolve; give the session hydration a moment.
      await expect(page.getByText("Uploads disabled")).toBeVisible({ timeout: 15000 });
    } finally {
      // --- Teardown (T-73-05): restore the global toggle to true so
      //     subsequent E2E runs are not poisoned. Best-effort — never mask
      //     a test failure. ---
      await setToggle(request, adminToken, "ALLOW_NON_ADMIN_UPLOAD", "true").catch(() => {});
      // Soft-delete the seeded workspace + project. There is no cascade
      // soft-delete at the Prisma level (Workspace.deletedAt and
      // Project.deletedAt are independent tombstones), so each row must be
      // tombstoned explicitly — the workspace is tombstoned first because the
      // FK ordering is workspace → project, leaving the project orphaned with
      // `deletedAt: null` would let it resurface in `requireProjectAccess`
      // queries across E2E runs. Best-effort — idempotent unique names
      // tolerate leftover rows on a mid-test crash.
      try {
        if (nonAdminWorkspaceId) {
          await prisma.workspace.update({
            where: { id: nonAdminWorkspaceId },
            data: { deletedAt: new Date() },
          });
        }
        if (nonAdminProjectId) {
          await prisma.project.update({
            where: { id: nonAdminProjectId },
            data: { deletedAt: new Date() },
          });
        }
        // Hard-delete the seeded project + non-admin user so no rows are left
        // behind on the shared dev DB (User has no deletedAt column, so
        // soft-delete is not an option — and the project FK Project.createdBy →
        // User.id blocks User hard-delete until the project row is removed).
        // Order: hard-delete project first (cascades Workspace hard-delete via
        // Workspace.project onDelete: Cascade), then hard-delete user (cascades
        // UserRole + UploadDraft via their onDelete: Cascade). The prior
        // soft-deletes are defensive tombstones; the hard-deletes remove the
        // rows so subsequent E2E runs do not accumulate users/projects.
        if (nonAdminProjectId) {
          await prisma.project.deleteMany({ where: { id: nonAdminProjectId } });
        }
        if (nonAdminUserId) {
          await prisma.user.deleteMany({ where: { id: nonAdminUserId } });
        }
      } catch {
        /* best-effort */
      }
      await prisma.$disconnect().catch(() => {});
    }
  });

  // Safety-net afterEach (T-73-05): even if the non-admin test fails before
  // its own finally restores the toggle, this restore runs after every test
  // in the describe block so the global SystemConfig row is never left false.
  // WR-03: also tombstones the staged UploadDraft + Document rows and hard-
  // deletes the ArchiveImportJob rows produced by tests 1-4, so the shared
  // dev DB does not accumulate them across E2E runs. The RUN_ID suffix only
  // prevents name collisions — without this afterAll, drafts/documents/AIJs
  // pile up indefinitely (UploadDraft and Document are tombstoned via
  // deletedAt; ArchiveImportJob has no deletedAt column, so it is hard-
  // deleted). All steps are best-effort and idempotent (guard on
  // deletedAt: null, wrap each step in try/catch) so a partial run or a
  // missing row is a no-op, never a suite failure.
  test.afterAll(async ({ request }) => {
    try {
      const token = await adminLoginToken(request);
      await setToggle(request, token, "ALLOW_NON_ADMIN_UPLOAD", "true").catch(() => {});
    } catch {
      /* best-effort — never fail the suite from teardown */
    }
    // WR-03: row cleanup for tests 1-4 (drafts/documents/AIJs). Skipped
    // silently when DATABASE_URL is not resolvable in the e2e worker (same
    // convention as test 5 — see synthesis-run.spec.ts:244).
    const databaseUrl = await loadDatabaseUrl().catch(() => undefined);
    if (!databaseUrl) return;
    let prisma: ReturnType<typeof makeE2ePrisma> | undefined;
    try {
      prisma = makeE2ePrisma(databaseUrl);
      const now = new Date();
      if (createdDraftIds.length) {
        await prisma.uploadDraft.updateMany({
          where: { id: { in: createdDraftIds }, deletedAt: null },
          data: { deletedAt: now },
        });
      }
      if (createdDocumentNames.length) {
        await prisma.document.updateMany({
          where: { name: { in: createdDocumentNames }, workspaceId: WORKSPACE_ID, deletedAt: null },
          data: { deletedAt: now },
        });
      }
      if (createdArchiveIds.length) {
        // AIJ has no deletedAt — hard-delete. Archives are already soft-deleted
        // by each test's finally; the AIJ rows reference those archive IDs.
        await prisma.archiveImportJob.deleteMany({
          where: { archiveId: { in: createdArchiveIds } },
        });
      }
    } catch {
      /* best-effort — never fail the suite from teardown */
    } finally {
      if (prisma) await prisma.$disconnect().catch(() => {});
    }
  });
});