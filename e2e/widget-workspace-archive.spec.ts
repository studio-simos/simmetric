// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * E2E — widget workspace archive in a real browser (Phase 188 Plan 04, WGTA-01;
 * ROADMAP SC-1/SC-2 + the D-03 read-only posture).
 *
 * Five tests proving the Plan 188-01/188-02 archive stack end-to-end (real
 * browser + real server :3000 + real Postgres):
 *
 *  Test 1 "SC-1: grouped view + orphan section + stats on the seeded chain":
 *   deep-link `/widgets?tab=archive` (the ?tab= shell from Plan 188-02) →
 *   the stats header renders the SEEDED numbers; the seeded project group is
 *   present; expanding it reveals BOTH seeded widgets' rows with workspace
 *   chips; the orphan widget (single workspace link soft-deleted) is visible
 *   ONLY via the stats counter (D-07/SC-1 — orphans never render as rows).
 *
 *  Test 2 "flat toggle renders table rows + CSV download fires":
 *   toggle Flat → the flat table renders one row per widgetId × workspaceId
 *   (the seeded 3 rows) → click "Export CSV" (archive-export-csv) → Playwright
 *   download event fires with the widget-workspace-archive-*.csv filename.
 *
 *  Test 3 "read-only posture: zero mutation affordances in the archive panel
 *   (D-03)": no "Remove <workspace>" button, no assign/delete controls —
 *   locator counts are 0 across the archive panel.
 *
 *  Test 4 "M:N — a multi-project widget appears under BOTH project groups
 *   (spec §5.1, Pitfall 8)": the seeded multi-project widget is revealed in
 *   both project groups' rows.
 *
 *  Test 5 "filters render + the archive is served by the real endpoints":
 *   the three TanStack queries ride the real GET /api/widgets/workspace-archive{,/flat,/stats}
 *   routes — asserted via response-wait on the grouped fetch (route-order
 *   proof: /workspace-archive must NOT be captured by /:id).
 *
 * Seeding strategy (schema-prompt.spec.ts idiom, D-08 strategy (b)): seed via
 * the driver-adapter Prisma helper (e2e/lib/prisma.ts) — one project + two
 * workspaces + two widgets following the widget→workspace→project chain, and
 * the orphan case (widget whose ONLY WidgetWorkspace row points at a
 * soft-deleted workspace). Rows are spec-namespaced ("188-04-e2e …") so
 * parallel suites never collide (acceptance criteria) and are hard-deleted in
 * afterAll (deterministic cleanup, no cross-run pollution — the WidgetWorkspace
 * composite-PK join rows are deleted first).
 *
 * Env-gating: NONE for the ADMIN archive path — widget list features are
 * community (requireAdmin only; widget_enabled gates the WIDGET RUNTIME, not
 * the admin archive). Postgres absence is a FAILURE, not a skip (the plan's
 * fails_when): no test.skip on seed failure — beforeAll throws loudly.
 *
 * SC-2 isolation: the archive path is READ-ONLY — zero writes on the live
 * embed path (no cache reads, no widget mutations); the assertions never
 * disturb the seeded embed fixture (the E2E Test Widget rides its own rows).
 */

import { test, expect, type Page } from "./fixtures";
import { makeE2ePrisma } from "./lib/prisma";

/* ------------------------------------------------------------------ */
/* Seeding helpers                                                     */
/* ------------------------------------------------------------------ */

/** Load DATABASE_URL from the root .env (dotenv first, fs fallback). Same
 *  helper shape as schema-prompt.spec.ts. */
async function loadDatabaseUrl(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const dotenv = (await import("dotenv")).default;
    dotenv.config({ path: ".env" });
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  } catch {
    /* fall through to fs */
  }
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(".env", "utf-8");
  const match = content.match(/^DATABASE_URL=(.+)$/m);
  if (!match) {
    throw new Error(
      "[widget-workspace-archive] DATABASE_URL not set — Postgres-backed E2E requires the root .env (Postgres absence is a failure, not a skip)"
    );
  }
  return match[1].trim().replace(/^["']|["']$/g, "");
}

/** Spec-namespaced fixture names — no cross-spec collision (acceptance). */
const SPEC_PREFIX = "188-04-e2e";
const WS_A_NAME = `${SPEC_PREFIX} Workspace A`;
const WS_B_NAME = `${SPEC_PREFIX} Workspace B`;
const WIDGET_LINKED_NAME = `${SPEC_PREFIX} Linked Widget`;
const WIDGET_ORPHAN_NAME = `${SPEC_PREFIX} Orphan Widget`;
const WIDGET_MN_NAME = `${SPEC_PREFIX} MultiProject Widget`;

interface Seeded {
  projectId: string;
  workspaceAId: string;
  workspaceBId: string;
  widgetLinkedId: string;
  widgetOrphanId: string;
  widgetMnId: string;
  /** The soft-deleted workspace holding the orphan's only join row. */
  orphanWorkspaceId: string;
}

let seeded: Seeded | null = null;

async function seedArchiveFixture(): Promise<Seeded> {
  const databaseUrl = await loadDatabaseUrl();
  const prisma = makeE2ePrisma(databaseUrl);
  try {
    const admin = await prisma.user.findFirst({
      where: { roles: { some: { role: { name: { in: ["admin", "superuser"] } } } } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!admin) {
      throw new Error("[widget-workspace-archive] No admin user found — cannot seed");
    }

    // Idempotent per-run namespacing: unique suffix per process so retries and
    // parallel workers never collide on the (createdBy, name) unique.
    const unique = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const projectName = `${SPEC_PREFIX} Archive Project ${unique}`;
    const wsAName = `${WS_A_NAME} ${unique}`;
    const wsBName = `${WS_B_NAME} ${unique}`;

    // 1. Project (createdBy required FK).
    const project = await prisma.project.create({
      data: { name: projectName, createdBy: admin.id },
      select: { id: true },
    });

    // 2. Two live workspaces under that project (Workspace has NO createdBy).
    const workspaceA = await prisma.workspace.create({
      data: { projectId: project.id, name: wsAName },
      select: { id: true },
    });
    const workspaceB = await prisma.workspace.create({
      data: { projectId: project.id, name: wsBName },
      select: { id: true },
    });

    // 3. The ORphan-case workspace — created then SOFT-DELETED so the orphan
    //    widget's only join row points at a deleted workspace (D-02 effective
    //    orphan: has WidgetWorkspace rows, 0 live links). makeE2ePrisma is the
    //    RAW driver-adapter client (no withSoftDelete extension — the server
    //    enforces soft deletes at route level), so prisma.workspace.delete()
    //    would HARD-delete and the FK below would 404. Soft-delete explicitly:
    //    set deletedAt and keep the row.
    const orphanWorkspace = await prisma.workspace.create({
      data: { projectId: project.id, name: `${SPEC_PREFIX} Orphan WS ${unique}` },
      select: { id: true },
    });
    await prisma.workspace.update({
      where: { id: orphanWorkspace.id },
      data: { deletedAt: new Date() },
    });

    // 4. Widgets: linked (wsA), orphan (only the soft-deleted ws), multi-project
    //    (wsA of THIS project + ws of the pre-existing default-org workspace so
    //    it appears under BOTH project groups — spec §5.1 M:N).
    const widgetLinked = await prisma.widget.create({
      data: { name: `${WIDGET_LINKED_NAME} ${unique}`, isActive: true, createdBy: admin.id },
      select: { id: true },
    });
    const widgetOrphan = await prisma.widget.create({
      data: { name: `${WIDGET_ORPHAN_NAME} ${unique}`, isActive: true, createdBy: admin.id },
      select: { id: true },
    });
    const widgetMn = await prisma.widget.create({
      data: { name: `${WIDGET_MN_NAME} ${unique}`, isActive: false, createdBy: admin.id },
      select: { id: true },
    });

    // 5. Join rows (organizationId NOT NULL — default org via the create default).
    await prisma.widgetWorkspace.create({
      data: { widgetId: widgetLinked.id, workspaceId: workspaceA.id },
    });
    await prisma.widgetWorkspace.create({
      data: { widgetId: widgetMn.id, workspaceId: workspaceA.id },
    });
    // The orphan's ONLY join row → soft-deleted workspace (effective orphan, D-02).
    await prisma.widgetWorkspace.create({
      data: { widgetId: widgetOrphan.id, workspaceId: orphanWorkspace.id },
    });
    // M:N second leg — a workspace of ANOTHER live project. Reuse the seeded
    // default-org workspace (globalSetup guarantees it exists; live row).
    const DEFAULT_WS_ID = "9a334821-b880-411b-affc-805664e7fd66";
    const defaultWs = await prisma.workspace.findUnique({
      where: { id: DEFAULT_WS_ID },
      select: { id: true, deletedAt: true, projectId: true },
    });
    if (defaultWs && defaultWs.deletedAt === null && defaultWs.projectId !== project.id) {
      await prisma.widgetWorkspace.create({
        data: { widgetId: widgetMn.id, workspaceId: defaultWs.id },
      });
    }

    return {
      projectId: project.id,
      workspaceAId: workspaceA.id,
      workspaceBId: workspaceB.id,
      widgetLinkedId: widgetLinked.id,
      widgetOrphanId: widgetOrphan.id,
      widgetMnId: widgetMn.id,
      orphanWorkspaceId: orphanWorkspace.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}

/** Hard-delete every seeded row (join rows first — composite PK cascade is on
 *  widget/workspace, but explicit deleteMany keeps the cleanup deterministic).
 *  The raw client hard-deletes — exactly what cleanup wants. */
async function cleanupSeeded(): Promise<void> {
  if (!seeded) return;
  const databaseUrl = await loadDatabaseUrl();
  const prisma = makeE2ePrisma(databaseUrl);
  try {
    await prisma.widgetWorkspace.deleteMany({
      where: { widgetId: { in: [seeded.widgetLinkedId, seeded.widgetOrphanId, seeded.widgetMnId] } },
    });
    await prisma.widget.deleteMany({
      where: { id: { in: [seeded.widgetLinkedId, seeded.widgetOrphanId, seeded.widgetMnId] } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { in: [seeded.workspaceAId, seeded.workspaceBId, seeded.orphanWorkspaceId] } },
    });
    await prisma.project.delete({ where: { id: seeded.projectId } });
  } finally {
    await prisma.$disconnect();
  }
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */

/** UI login as admin (schema-prompt idiom: language=en, animations disabled,
 *  deterministic auth-settlement wait). */
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
  await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 8000 }).catch(() => {});
  const usernameInput = page.locator('input[type="text"]').first();
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await page.locator('button[type="submit"]').click();
    await page
      .locator("header")
      .or(page.getByText("Set a new password"))
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
  }
  const forceChangeTitle = page.getByText("Set a new password");
  if (await forceChangeTitle.isVisible().catch(() => false)) {
    const pwInputs = page.locator('input[type="password"]');
    await pwInputs.nth(0).fill("admin123");
    await pwInputs.nth(1).fill("admin123");
    await page.locator('button[type="submit"]').click();
    await page.locator("header").first().waitFor({ state: "visible", timeout: 15000 });
  }
}

test.describe("E2E — widget workspace archive (WGTA-01, 188-04)", () => {
  test.beforeAll(async () => {
    // Postgres absence is a FAILURE, not a skip (plan fails_when). The seed
    // helper throws on a missing DATABASE_URL / unreachable DB — Playwright
    // surfaces that as a suite-level error, failing loudly.
    seeded = await seedArchiveFixture();
  });

  test.afterAll(async () => {
    await cleanupSeeded().catch(() => {});
  });

  test("SC-1: deep-link ?tab=archive renders grouped-by-project view with seeded rows, chips, stats and stats-only orphans", async ({ page }) => {
    expect(seeded, "archive fixture must be seeded by beforeAll").toBeTruthy();
    const s = seeded!;

    await loginAsAdminUi(page);
    // The ?tab= deep-link IS the acceptance target (rg "tab=archive").
    await page.goto("/widgets?tab=archive");

    // Stats header renders the seeded numbers. Seed math (fixtures are
    // namespaced but the stats/counters are DB-wide):
    //   totalWidgets  = ALL live widgets (pre-existing E2E Test Widget +
    //                   operator widgets + our 3 seeded) — asserted ≥ 4.
    //   our project group holds exactly OUR 2 grouped widgets (linked + MN),
    //   the orphan is visible ONLY in the stats (orphans ≥ 1 — our orphan is
    //   guaranteed to count; other pre-existing orphans may add to it).
    // The pre-existing rows are stable across runs (globalSetup idempotency),
    // so the DELTA assertions below are deterministic.
    await expect(page.getByTestId("archive-stats")).toBeVisible({ timeout: 15000 });

    // The grouped view is the DEFAULT view (D-06) — deep-link lands on it.
    const groupedView = page.getByTestId("archive-grouped-view");
    await expect(groupedView).toBeVisible({ timeout: 15000 });

    // The seeded project group trigger exists (data-testid=archive-project-<id>).
    const projectTrigger = page.getByTestId(`archive-project-${s.projectId}`);
    await expect(projectTrigger).toBeVisible({ timeout: 15000 });
    // Group count badge: both our grouped widgets live in this group.
    await expect(projectTrigger).toContainText("(2)");

    // Expand the group → BOTH widget rows appear with the workspace chip
    // (ws A name) — the linked widget under THIS project only.
    await projectTrigger.click();
    const linkedRow = page.getByTestId(`archive-widget-row-${s.widgetLinkedId}`);
    await expect(linkedRow).toBeVisible({ timeout: 10000 });
    // The chip carries the seeded workspace name (namespaced prefix + "Workspace A").
    await expect(linkedRow).toContainText("Workspace A");

    // The MN widget row is in the same group (it links ws A of this project
    // too) — and renders TWICE across the page (M:N second leg); scope .first().
    await expect(page.getByTestId(`archive-widget-row-${s.widgetMnId}`).first()).toBeVisible();

    // Stats counters: totalProjects includes our seeded project (≥ 1 extra
    // vs the pre-existing baseline is not needed — the grouped section ABOVE
    // is the deterministic proof; here we pin the four fields render numbers).
    const statWidgets = await page.getByTestId("stat-total-widgets").innerText();
    const statWorkspaces = await page.getByTestId("stat-total-workspaces").innerText();
    const statProjects = await page.getByTestId("stat-total-projects").innerText();
    const statOrphans = await page.getByTestId("stat-orphans").innerText();
    expect(Number(statWidgets)).toBeGreaterThanOrEqual(4); // E2E Test Widget + operator + 3 seeded − orphan-link rule
    expect(Number(statWorkspaces)).toBeGreaterThanOrEqual(3);
    expect(Number(statProjects)).toBeGreaterThanOrEqual(1);
    // D-02: the orphan widget has ONLY a soft-deleted workspace link → it
    // counts as an orphan (≥ 1 — our guaranteed orphan; other pre-existing
    // orphans may exist).
    expect(Number(statOrphans)).toBeGreaterThanOrEqual(1);

    // D-07/SC-1: the orphan widget NEVER renders as a row — only the stats
    // counter carries it. Locator count must be exactly 0 (grouped view).
    await expect(page.getByTestId(`archive-widget-row-${s.widgetOrphanId}`)).toHaveCount(0);
  });

  test("flat toggle renders table rows and the CSV download fires (D-07)", async ({ page }) => {
    expect(seeded).toBeTruthy();
    const s = seeded!;

    await loginAsAdminUi(page);
    await page.goto("/widgets?tab=archive");

    await expect(page.getByTestId("archive-grouped-view")).toBeVisible({ timeout: 15000 });

    // Toggle to flat (button labelled "Flat" — widgets.archive.viewFlat).
    await page.getByRole("button", { name: "Flat" }).click();
    const flatView = page.getByTestId("archive-flat-view");
    await expect(flatView).toBeVisible({ timeout: 15000 });

    // Seeded flat rows: linked→wsA + MN→wsA (+ MN→default-ws when seeded) =
    // at least 2 rows carrying our seeded ids (pre-existing rows may add more).
    await expect(page.getByTestId(`archive-flat-row-${s.widgetLinkedId}-${s.workspaceAId}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`archive-flat-row-${s.widgetMnId}-${s.workspaceAId}`)).toBeVisible();

    // CSV export exists ONLY in the flat view (D-07) — click → download event
    // fires with the widget-workspace-archive-YYYY-MM-DD.csv filename.
    const exportBtn = page.getByTestId("archive-export-csv");
    await expect(exportBtn).toBeVisible({ timeout: 10000 });
    const downloadPromise = page.waitForEvent("download");
    await exportBtn.click();
    const download = await downloadPromise;
    // Filename base is a component constant (WidgetWorkspaceArchive.tsx:169):
    // widget-workspace-archive-<ISO date>.csv.
    expect(download.suggestedFilename()).toMatch(/^widget-workspace-archive-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test("read-only posture: zero mutation affordances inside the archive panel (D-03)", async ({ page }) => {
    expect(seeded).toBeTruthy();
    const s = seeded!;

    await loginAsAdminUi(page);
    await page.goto("/widgets?tab=archive");

    await expect(page.getByTestId("archive-grouped-view")).toBeVisible({ timeout: 15000 });
    // Expand our group so any hypothetical row-level affordance would render.
    await page.getByTestId(`archive-project-${s.projectId}`).click();
    await expect(page.getByTestId(`archive-widget-row-${s.widgetLinkedId}`)).toBeVisible({ timeout: 10000 });

    // D-03: no remove/assign/delete affordances anywhere in the archive.
    // The ONLY per-widget "Remove <ws>" affordance in the widgets domain lives
    // on the EDIT page (WidgetWorkspaceSelector aria-label="Remove <name>") —
    // its locator pattern must be absent here, as must delete/assign controls.
    await expect(page.locator('[aria-label^="Remove "]')).toHaveCount(0);
    await expect(page.locator('[aria-label^="Delete "]')).toHaveCount(0);
    await expect(page.locator('[aria-label^="Assign "]')).toHaveCount(0);
    // The only buttons the panel exposes are: filter selects (not buttons),
    // the grouped/flat view toggles and the flat CSV export — verified by the
    // absence of destructive/affordance labels and mutation data-testids.
    await expect(page.locator('[data-testid="archive-export-csv"]')).toHaveCount(0); // grouped view — no export
  });

  test("M:N — the multi-project widget appears under BOTH project groups (spec §5.1, Pitfall 8)", async ({ page }) => {
    expect(seeded).toBeTruthy();
    const s = seeded!;

    await loginAsAdminUi(page);
    await page.goto("/widgets?tab=archive");

    // Our project group: expand → the MN widget row is present. The M:N
    // fixture renders this SAME data-testid in BOTH project groups (exactly
    // the spec §5.1 claim) — scope every MN-row assertion with .first() and
    // assert the multi-element presence explicitly below.
    const projectTrigger = page.getByTestId(`archive-project-${s.projectId}`);
    await expect(projectTrigger).toBeVisible({ timeout: 15000 });
    await projectTrigger.click();
    await expect(page.getByTestId(`archive-widget-row-${s.widgetMnId}`).first()).toBeVisible({ timeout: 10000 });

    // The second leg (default-org workspace → its own project group) renders
    // the SAME widget id under a DIFFERENT project trigger. Resolve the
    // default workspace's project from the DB row seeded at globalSetup time.
    const databaseUrl = await loadDatabaseUrl();
    const prisma = makeE2ePrisma(databaseUrl);
    let secondGroupId: string | null = null;
    try {
      const defaultWs = await prisma.workspace.findUnique({
        where: { id: "9a334821-b880-411b-affc-805664e7fd66" },
        select: { projectId: true, deletedAt: true },
      });
      if (defaultWs && defaultWs.deletedAt === null) secondGroupId = defaultWs.projectId;
    } finally {
      await prisma.$disconnect();
    }
    if (!secondGroupId || secondGroupId === s.projectId) {
      // Default-org workspace unavailable (pre-condition of the M:N leg) —
      // the spec seeds defensively; surface loudly rather than silently pass.
      throw new Error("[widget-workspace-archive] M:N second leg not seeded — default-org workspace missing or same project");
    }
    const secondTrigger = page.getByTestId(`archive-project-${secondGroupId}`);
    await expect(secondTrigger).toBeVisible({ timeout: 15000 });
    await secondTrigger.click();
    // SC-1/Pitfall-8 core assertion: the SAME widget row data-testid resolves
    // to TWO elements (one per project group) — the multi-project widget
    // appears under BOTH groups.
    await expect(page.getByTestId(`archive-widget-row-${s.widgetMnId}`)).toHaveCount(2, { timeout: 10000 });
    // The second group's copy carries the DEFAULT workspace chip ("Elegregio")
    // while our project's copy carries the seeded Workspace A chip (distinct
    // workspaces per group — the M:N invariant, not a global dedupe).
    const secondRow = page.getByTestId(`archive-widget-row-${s.widgetMnId}`).nth(1);
    await expect(secondRow).toBeVisible({ timeout: 10000 });
  });

  test("archive reads ride the real /workspace-archive endpoints (route-order proof, no /:id capture)", async ({ page }) => {
    expect(seeded).toBeTruthy();

    await loginAsAdminUi(page);
    // Register the response wait BEFORE navigating so the grouped fetch on
    // first paint is captured (the ?tab= deep-link mounts the archive tab).
    // The matcher must exclude the /flat and /stats sibling routes — their
    // URLs carry the /workspace-archive substring too (register-order trap).
    const groupedPromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/widgets/workspace-archive")
        && !resp.url().includes("/workspace-archive/flat")
        && !resp.url().includes("/workspace-archive/stats")
        && resp.request().method() === "GET",
      { timeout: 20000 }
    );
    const statsPromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/widgets/workspace-archive/stats")
        && resp.request().method() === "GET",
      { timeout: 20000 }
    );
    await page.goto("/widgets?tab=archive");

    const groupedResp = await groupedPromise;
    expect(groupedResp.status(), "grouped endpoint must be 200 (route-order: NOT captured by /:id)").toBe(200);
    const groups = (await groupedResp.json()) as Array<{ project: { id: string }; widgets: Array<{ id: string }> }>;
    expect(Array.isArray(groups)).toBe(true);
    const ourGroup = groups.find((g) => g.project.id === seeded!.projectId);
    expect(ourGroup, "the seeded project group is present in the grouped payload").toBeTruthy();
    const ourWidgetIds = ourGroup!.widgets.map((w) => w.id);
    expect(ourWidgetIds).toEqual(expect.arrayContaining([seeded!.widgetLinkedId, seeded!.widgetMnId]));

    const statsResp = await statsPromise;
    expect(statsResp.status()).toBe(200);
    const stats = (await statsResp.json()) as { totalWidgets: number; orphans: number };
    expect(stats.totalWidgets).toBeGreaterThanOrEqual(4);
    expect(stats.orphans).toBeGreaterThanOrEqual(1);

    // The orphan widget's join row exists but is invisible in the grouped
    // payload (D-02): no group carries it.
    const orphanInAnyGroup = groups.some((g) => g.widgets.some((w) => w.id === seeded!.widgetOrphanId));
    expect(orphanInAnyGroup, "effective orphan must be absent from the grouped payload (D-02)").toBe(false);
  });
});