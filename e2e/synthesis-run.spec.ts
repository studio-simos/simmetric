/**
 * E2E-02 — Synthesis run state machine (D-08, D-03 full-mock).
 *
 * Three tests covering the synthesis state machine fixed in Phases 60-65:
 *
 *  Test 1 "COMPLETED run appears in synthesis dashboard with status badge":
 *   loginAsAdmin UI → navigate /synthesis → assert our seeded COMPLETED run's
 *   card shows the EN badge "Awaiting Approval" (i18n key
 *   synthesis.detail.status.COMPLETED = "Awaiting Approval", NOT "COMPLETED"
 *   — the badge maps the run's DB status to a human-facing label).
 *
 *  Test 2 "approve COMPLETED run → APPROVED": click the run card → detail
 *   view opens → click "Approve All" (t("synthesis.detail.approveAll") =
 *   "Approve All") → POST /api/synthesis/:runId/approve → 200 → UI badge
 *   updates to "Approved" (i18n key synthesis.detail.status.APPROVED).
 *
 *  Test 3 "PENDING fast-assert (synthesis pipeline scheduler race window)":
 *   seed a fresh PENDING SynthesisRun in the test body (NOT beforeAll —
 *   minimizes the window before the synthesis pipeline scheduler's 10s poll
 *   claims it), navigate to /synthesis, assert the "Pending" badge is
 *   visible within 5s (Pitfall 5: the PENDING→PROCESSING pipeline scheduler
 *   polls PENDING every 10s via setInterval and flips to PROCESSING; we
 *   must assert before the poll fires), then cleanup the seeded run.
 *
 *  169-03 PATTERNS finding #3: the "Bree scheduler race" terminology was
 *  STALE — Bree was replaced by pg-boss in Phase 165, but the synthesis
 *  PENDING→PROCESSING pipeline scheduler is still a setInterval (10s) at
 *  packages/server/src/index.ts:678 (initSynthesisPipelineScheduler), NOT
 *  pg-boss. Only the reaper (orphaned PROCESSING → FAILED) is pg-boss cron
 *  (initSynthesisReaperScheduler, 15-min, index.ts:649). The 10s poll
 *  cadence is preserved → the race window shape is the SAME.
 *
 * Setup strategy: D-08 strategy (b) — seed via PrismaClient directly. We
 * do NOT mock via Jest (Playwright's webServer process cannot be mocked
 * from the test runner — the server runs as a separate Node process).
 * Acceptance criterion: `grep -c "jest\\.mock" e2e/synthesis-run.spec.ts`
 * returns 0.
 *
 * Side-effect containment: `applyApprovedChanges` (called by the approve
 * route) writes ArchivePage rows to the archive. To avoid corrupting real
 * data, we seed a FRESH test Archive owned by admin with a unique slug per
 * test run. afterAll hard-deletes the SynthesisRun rows and the test
 * Archive (and any ArchivePage rows created by the approve side effect).
 *
 * Env-gating: NONE. No LLM is invoked — the approve endpoint only writes
 * pages from the already-stored previewJson. D-03 full-mock.
 *
 * Rule 1 deviation from plan: the plan said "assert 'COMPLETED' badge
 * text". The actual EN i18n key synthesis.detail.status.COMPLETED maps to
 * "Awaiting Approval" (the badge does NOT render the raw DB status — it
 * renders a human-facing label). Fixed inline: assert "Awaiting Approval"
 * for COMPLETED and "Approved" for APPROVED. Similarly the "Pending"
 * label for PENDING.
 */

import { test, expect, type Page } from "./fixtures";
import path from "node:path";
import { makeE2ePrisma } from "./lib/prisma";

const SERVER_URL = "http://localhost:3000";
const TEST_ARCHIVE_SLUG_PREFIX = "e2e-synthesis-test-archive-";

/** Load DATABASE_URL from the root .env (gitignored in the worktree
 *  — try dotenv, fall back to process.env.DATABASE_URL). */
async function loadDatabaseUrl(): Promise<string | undefined> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const dotenv = (await import("dotenv")).default;
    dotenv.config({ path: path.resolve(".env") });
    return process.env.DATABASE_URL;
  } catch {
    return undefined;
  }
}

/** Resolve @prisma/client from packages/server/node_modules (pnpm strict
 *  isolation — the root node_modules does not have it). GAP-01 fix: use the
 *  shared e2e/lib/prisma helper (Prisma 7 driver-adapter pattern). The old
 *  no-arg PrismaClient constructor form does NOT pick up DATABASE_URL without
 *  a driver adapter and was crashing beforeAll (66-HUMAN-UAT GAP-01).
 *
 *  D-08 strategy (b) preserved: no jest spy/mock — the test seeds via
 *  PrismaClient directly, only the init form changes. */
async function getPrismaClient() {
  const databaseUrl = await loadDatabaseUrl();
  if (!databaseUrl) {
    throw new Error(
      "getPrismaClient: DATABASE_URL not set — loadDatabaseUrl() returned " +
        "undefined. Ensure the root .env exists or DATABASE_URL is " +
        "exported in the test runner env."
    );
  }
  return makeE2ePrisma(databaseUrl);
}

/** Minimal valid previewJson for a COMPLETED run. The frontend
 *  SynthesisRunDetail reads `previewJson.changes` to determine if the
 *  approve action is actionable (isActionable = status COMPLETED/PARTIAL
 *  AND changes.length > 0). We provide one "create" change with a unique
 *  slug so applyApprovedChanges creates exactly one ArchivePage that we
 *  can clean up deterministically. */
function buildPreviewJson(runId: string, archiveId: string, pageSlug: string) {
  return {
    runId,
    archiveId,
    status: "COMPLETED",
    createdAt: new Date().toISOString(),
    budgetUsed: { pagesRead: 1, pagesWritten: 1, tokensUsed: 100, llmCallsUsed: 2 },
    contradictions: [],
    changes: [
      {
        pageSlug,
        action: "create",
        category: "general",
        title: "E2E Test Page",
        proposedContent: "# E2E Test Page\n\nCreated by the synthesis E2E suite.",
        confidence: 0.95,
        sources: [],
        approved: false,
      },
    ],
  };
}

/** UI login as admin. Mirrors the chat-flow.spec.ts init pattern:
 *  language=en, lastWorkspaceId seeded, animations disabled for determinism. */
async function loginAsAdminUi(page: Page): Promise<void> {
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
  // 169-03: wait for the login form to mount (cold vite preview can take >3s).
  // Mirrors fixtures.ts:50 + chat-flow loginAsAdmin — the previous 3000ms
  // isVisible race skipped the login branch on a cold mount → the test
  // navigated to /synthesis unauthenticated → redirected to /login.
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

// Shared state across tests.
let prisma: Awaited<ReturnType<typeof getPrismaClient>> | null = null;
let adminUserId: string | undefined;
let testArchiveId: string | undefined;
let completedRunId: string | undefined;
let testPageSlug: string | undefined;
const pendingRunIds: string[] = [];

test.describe("E2E-02 — Synthesis run state machine (D-08, D-03 full-mock)", () => {
  test.beforeAll(async () => {
    const databaseUrl = await loadDatabaseUrl();
    if (!databaseUrl) {
      console.warn("[synthesis-run] DATABASE_URL not set — seeding will fail");
      return;
    }
    prisma = await getPrismaClient();
    // Prisma 7 driver-adapter pattern: the client connects via the pg.Pool
    // adapter bound to DATABASE_URL inside makeE2ePrisma. No env override or
    // constructor-datasource option needed (GAP-01 fix — see e2e/lib/prisma.ts).
    if (!prisma) return;

    // Find an admin user to satisfy the createdBy FK.
    adminUserId = (
      await prisma.user.findFirst({
        where: { roles: { some: { role: { name: { in: ["admin", "superuser"] } } } } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })
    )?.id;
    if (!adminUserId) {
      console.warn("[synthesis-run] No admin user found — skipping seed");
      return;
    }

    // Seed a fresh test Archive owned by admin. Unique slug per run so
    // parallel CI workers don't collide on the slug unique constraint.
    const unique = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const slug = TEST_ARCHIVE_SLUG_PREFIX + unique;
    const archive = await prisma.archive.create({
      data: {
        slug,
        name: `E2E Synthesis Test Archive ${unique}`,
        description: "Created by e2e/synthesis-run.spec.ts — safe to delete",
        createdBy: adminUserId,
      },
    });
    testArchiveId = archive.id;
    testPageSlug = "e2e-test-page-" + unique;

    // Seed a COMPLETED SynthesisRun with a valid previewJson (one "create"
    // change pointing at our testPageSlug). The approve route will create
    // exactly one ArchivePage row in our test archive.
    const completedRun = await prisma.synthesisRun.create({
      data: {
        archiveId: testArchiveId,
        status: "COMPLETED",
        pagesRead: 1,
        pagesWritten: 1,
        tokensUsed: 100,
        llmCallsUsed: 2,
        contradictionsFound: 0,
        previewJson: buildPreviewJson("placeholder", testArchiveId, testPageSlug),
        createdBy: adminUserId,
        // expiresAt 2h ahead so the reaper does not flip it.
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });
    completedRunId = completedRun.id;

    // Patch the previewJson.runId to match the actual run id (cosmetic —
    // the approve route does not read previewJson.runId, it reads the URL
    // param; but keep it consistent in case the UI renders it).
    await prisma.synthesisRun.update({
      where: { id: completedRunId },
      data: { previewJson: buildPreviewJson(completedRunId, testArchiveId as string, testPageSlug as string) },
    });
  });

  test.afterAll(async () => {
    if (!prisma) return;
    try {
      // Delete the PENDING run(s) seeded by Test 3.
      for (const id of pendingRunIds) {
        await prisma.synthesisRun.delete({ where: { id } }).catch(() => {});
      }
      // Delete the COMPLETED run (status may now be APPROVED if Test 2 ran).
      if (completedRunId) {
        await prisma.synthesisRun.delete({ where: { id: completedRunId } }).catch(() => {});
      }
      // Delete any ArchivePage rows created by the approve side effect.
      if (testArchiveId) {
        await prisma.archivePage.deleteMany({ where: { archiveId: testArchiveId } }).catch(() => {});
        await prisma.archive.delete({ where: { id: testArchiveId } }).catch(() => {});
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("COMPLETED run appears in synthesis dashboard with status badge", async ({ page }) => {
    test.skip(!completedRunId || !testArchiveId, "Seed failed (DATABASE_URL or admin user missing) — skipping");
    await loginAsAdminUi(page);
    await page.goto("/synthesis");

    // The SynthesisDashboard lists runs via useSynthesisPendingRuns (GET
    // /api/synthesis/status returns ALL runs). Each run renders a
    // SynthesisRunCard with a status badge. The EN i18n key
    // synthesis.detail.status.COMPLETED = "Awaiting Approval" (Rule 1 fix:
    // the badge does NOT render the raw DB status — it renders a human
    // label). We assert the badge text for our seeded COMPLETED run.
    //
    // We scope by the archive name to avoid matching unrelated runs in the
    // dev DB. The card renders the archive name (SynthesisRunCard.tsx).
    const card = page.locator("text=E2E Synthesis Test Archive").first();
    await expect(card).toBeVisible({ timeout: 15000 });

    // The badge is a sibling within the card. Assert "Awaiting Approval"
    // is visible within the card's container (closest ancestor article/div).
    const cardContainer = card.locator("xpath=ancestor::*[self::article or self::div][1]");
    await expect(cardContainer.locator("text=Awaiting Approval")).toBeVisible({ timeout: 5000 });
  });

  test("approve COMPLETED run → APPROVED", async ({ page }) => {
    test.skip(!completedRunId || !testArchiveId, "Seed failed — skipping approve test");
    await loginAsAdminUi(page);
    await page.goto("/synthesis");

    // Click the run card to open the detail view (SynthesisRunDetail).
    const card = page.locator("text=E2E Synthesis Test Archive").first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();

    // The detail view renders the "Approve All" button when isActionable
    // (status COMPLETED/PARTIAL AND previewJson.changes.length > 0). EN
    // i18n key synthesis.detail.approveAll = "Approve All".
    const approveBtn = page.locator('button:has-text("Approve All")').first();
    await expect(approveBtn).toBeVisible({ timeout: 10000 });

    // Intercept the approve POST to assert 200 (the route calls
    // applyApprovedChanges which writes an ArchivePage row in our test
    // archive — that's the side effect we contain in afterAll).
    const approvePromise = page.waitForResponse(
      (resp) => resp.url().includes(`/api/synthesis/${completedRunId}/approve`) && resp.request().method() === "POST",
      { timeout: 15000 }
    );
    await approveBtn.click();
    const approveResp = await approvePromise;
    expect(approveResp.status(), `approve must return 2xx, got ${approveResp.status()}`).toBeGreaterThanOrEqual(200);
    expect(approveResp.status()).toBeLessThan(300);

    // The UI updates the run's status to APPROVED. The badge re-renders
    // with the EN label "Approved" (synthesis.detail.status.APPROVED).
    // The detail view or the card should now show "Approved".
    await expect(page.locator("text=Approved").first()).toBeVisible({ timeout: 10000 });
  });

  test("PENDING fast-assert (synthesis pipeline scheduler race window)", async ({ page }) => {
    test.skip(!testArchiveId || !adminUserId, "Seed failed — skipping PENDING test");

    // Seed a fresh PENDING run IN THE TEST BODY (not beforeAll) to minimize
    // the window before the synthesis pipeline scheduler's 10s poll claims it
    // (Pitfall 5: the PENDING→PROCESSING scheduler is a setInterval 10s at
    // index.ts:678 initSynthesisPipelineScheduler — NOT Bree, NOT pg-boss; it
    // polls PENDING every 10s and flips to PROCESSING; we must assert the
    // PENDING badge before the poll fires).
    if (!prisma) {
      test.skip(true, "Prisma client not initialized");
      return;
    }
    const pendingRun = await prisma.synthesisRun.create({
      data: {
        archiveId: testArchiveId as string,
        status: "PENDING",
        previewJson: null,
        createdBy: adminUserId as string,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });
    pendingRunIds.push(pendingRun.id);

    await loginAsAdminUi(page);
    // Navigate immediately to minimize the race window.
    await page.goto("/synthesis");

    // Assert the "Pending" badge is visible within 5s (Pitfall 5: the
    // PENDING→PROCESSING scheduler polls every 10s via setInterval; we assert
    // < 5s so even if the poll fires mid-test, the badge was visible first).
    // Scope by the archive name to avoid matching unrelated runs.
    const card = page.locator("text=E2E Synthesis Test Archive").first();
    await expect(card).toBeVisible({ timeout: 10000 });
    const cardContainer = card.locator("xpath=ancestor::*[self::article or self::div][1]");
    await expect(cardContainer.locator("text=Pending")).toBeVisible({ timeout: 5000 });
  });
});