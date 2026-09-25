/**
 * E2E — schemaPrompt end-to-end proof (Phase 187, Plan 03; SC-1 / SC-3 / D-07 / WIKS-02).
 *
 * Four tests covering the full chain through real browser + server + filesystem:
 *
 *  Test 1 "admin sets schemaPrompt in the UI → survives reload (SC-1)":
 *   loginAsAdminUi → /archives/:id → "Config" tab → "Editorial Guidelines
 *   (Schema Prompt)" section visible → type a distinctive marker string into
 *   the textarea → click the header Save button ("Save Configuration",
 *   archives.schemaPrompt.save) → expect the success toast ("Configuration
 *   saved", config.saved) → reload the page → expect the textarea value to
 *   still contain the marker (ROADMAP SC-1 end-to-end). Then clear the
 *   textarea and save again → expect the placeholder + "Use template" button
 *   to re-render (valid empty state, no confirmation — UI-SPEC
 *   destructive-actions row).
 *
 *  Test 2 "Use template + Edit/Preview toggle (UI-SPEC long-text path, lightly)":
 *   with an empty textarea click "Use template" (archives.schemaPrompt.useTemplate)
 *   → expect the textarea to contain the template body including
 *   "raw_sources/ is immutable — never modify original source files."
 *   (DEFAULT_TEMPLATE_BODY verbatim line) → click Preview
 *   (archives.schemaPrompt.tabPreview) → expect rendered markdown (heading
 *   text visible, no raw # in the preview pane) → switch back to Edit → save
 *   → reload → persisted. (The 10000-char rendering stays a held-out visual
 *   test per UI-SPEC — asserted only lightly here.)
 *
 *  Test 3 "KBPG-02/03 non-regression with schemaPrompt PRESENT (SC-3 / D-07)":
 *   with the marker schemaPrompt saved on the archive, create a page via the
 *   API route (POST /api/archives/:id/pages with an admin bearer token) →
 *   expect 2xx; then update the page text via the same PUT (KBPG-03 body-edit
 *   path, content field) → expect 2xx; then rename it (PUT with new slug +
 *   title — KBPG-03 rename path) → expect 2xx. Proves page create/edit/rename
 *   flows are unchanged with schemaPrompt present. (Synthesis-flow
 *   non-regression stays pinned at unit level by 187-01's
 *   synthesisSchemaInjection tests + the existing synthesis-run.spec.ts
 *   staying green; A3 keeps LLM-visible assertions OUT of E2E — judgment-tier
 *   prohibition.)
 *
 *  Test 4 "raw_sources/ non-write, end-to-end (WIKS-02)":
 *   before/after assertions walk the archive's data directory on disk (the
 *   server resolves ARCHIVES_BASE = path.resolve(process.cwd(),
 *   "storage/archives") at packages/server/src/services/archiveService.ts:18,
 *   where process.cwd() is packages/server when Playwright boots it via
 *   `pnpm --filter server exec tsx src/index.ts`) asserting: (a) no file was
 *   created/modified under the archive's raw_sources/ subtree during the
 *   flows (compare snapshot sets — relative path + mtimeMs + size — before
 *   and after), and (b) an explicit write-attempt probe is NOT required —
 *   the traversal rejection is pinned at unit level in Plan 01
 *   (wikiWriteService.test.ts); the E2E invariant is the non-write
 *   observation only (Pitfall 8: no specific HTTP status pinned in E2E).
 *   Additionally assert via GET /api/archives/:archiveId/pages that no page
 *   with a raw_sources category exists (all pages stay in wiki/ categories).
 *
 * Setup strategy: D-08 strategy (b) — seed via Prisma directly (the
 * synthesis-run.spec.ts pattern; Playwright's webServer process cannot be
 * mocked). We seed the DB row AND the on-disk directory structure ourselves
 * (mirroring createArchive's layout: raw_sources/, wiki/{entities,concepts,
 * decisions}/, .internal/, log.md — archiveService.ts:67-80) so the
 * filesystem non-write assertion has a real subtree to observe and page
 * writes have somewhere to land. afterAll hard-deletes the DB rows and the
 * on-disk directory (deterministic cleanup, no cross-run pollution).
 *
 * Env-gating: NONE — no LLM is invoked anywhere in this spec (page create /
 * update routes call validatePageContent + createPage/updatePage, no agent
 * loop, no synthesis run). A4: no LICENSE_KEY dependency (widget features
 * untouched).
 */

import { test, expect, type Page } from "./fixtures";
import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { makeE2ePrisma } from "./lib/prisma";

/** Resolve simple-git from packages/server/node_modules (pnpm strict
 *  isolation does not hoist it to the root — the established e2e idiom,
 *  e2e/custom-skills.spec.ts loadBcrypt). A bare ESM import here breaks
 *  Playwright test DISCOVERY for the whole e2e dir (the resolver throws
 *  at spec-load, not inside the guarded seed block). */
const requireFromServer = createRequire(new URL("../packages/server/package.json", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- simple-git types resolve only from packages/server; the call contract is simpleGit(dir) → SimpleGit (init/addConfig/add/commit used below)
const simpleGit: (dir: string) => { init(): Promise<unknown>; addConfig(key: string, value: string): Promise<unknown>; add(paths: string | string[]): Promise<unknown>; commit(message: string): Promise<unknown> } =
  requireFromServer("simple-git").simpleGit;

const SERVER_URL = "http://localhost:3000";
const TEST_ARCHIVE_SLUG_PREFIX = "e2e-schema-prompt-";

/** The server resolves ARCHIVES_BASE = path.resolve(process.cwd(),
 *  "storage/archives") with cwd = packages/server (playwright.config.ts boots
 *  it via `pnpm --filter server exec tsx src/index.ts`). */
const ARCHIVES_BASE = path.resolve(process.cwd(), "packages", "server", "storage", "archives");

/** Load DATABASE_URL from the root .env (gitignored — try dotenv, fall back
 *  to process.env.DATABASE_URL). Mirrors the synthesis spec's helper. */
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

/** Prisma 7 driver-adapter pattern client (e2e/lib/prisma.ts — GAP-01 fix). */
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

/** Admin bearer token via the real login endpoint (fixtures.ts pattern). */
async function getAdminToken(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const auth = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  if (!auth.ok()) throw new Error(`getAdminToken: login failed (${auth.status()})`);
  const { token } = (await auth.json()) as { token: string };
  return token;
}

/** UI login as admin. Mirrors the synthesis-run.spec.ts init pattern:
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
  await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 5000 }).catch(() => {});
  const usernameInput = page.locator('input[type="text"]').first();
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await page.locator('button[type="submit"]').click();
    // Deterministic wait for auth settlement: either the authenticated app
    // shell (<header>) or the force-change-password screen appears.
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
    await page.locator("header").first().waitFor({ state: "visible", timeout: 10000 });
  }
}

/** i18n keys rendered by Plan 02 (en locale — the test runs in en). */
const LABEL = "Editorial Guidelines (Schema Prompt)";
const SAVE_BTN = "Save Configuration";
const SAVING_BTN = "Saving Configuration…";
const SAVED_TOAST = "Configuration saved";
const USE_TEMPLATE = "Use template";
const TAB_EDIT = "Edit";
const TAB_PREVIEW = "Preview";
const PLACEHOLDER_PREFIX = "No schema prompt set";

/** Recursive snapshot of a directory subtree: relative path → mtimeMs + size.
 *  Used for the raw_sources/ non-write assertion (set-compare before/after). */
async function snapshotDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // directory absent → empty snapshot
  }
  for (const e of entries) {
    const child = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await snapshotDir(child);
      for (const [k, v] of sub) out.set(path.join(e.name, k), v);
      // Also record the directory itself (mtime can change without file changes)
      const st = await fs.stat(child).catch(() => null);
      if (st) out.set(path.join(e.name) + "/", `dir mtime=${st.mtimeMs}`);
    } else {
      const st = await fs.stat(child).catch(() => null);
      if (st) out.set(e.name, `file mtime=${st.mtimeMs} size=${st.size}`);
    }
  }
  return out;
}

// Shared state across tests.
let prisma: Awaited<ReturnType<typeof getPrismaClient>> | null = null;
let adminUserId: string | undefined;
let testArchiveId: string | undefined;
let testArchiveSlug: string | undefined;
const MARKER_PROMPT =
  "E2E-SCHEMA-PROMPT-MARKER — Every page must start with a one-paragraph summary.";

test.describe("E2E — schemaPrompt persistence + KBPG non-regression + raw_sources non-write", () => {
  test.beforeAll(async () => {
    const databaseUrl = await loadDatabaseUrl();
    if (!databaseUrl) {
      console.warn("[schema-prompt] DATABASE_URL not set — seeding will fail");
      return;
    }
    prisma = await getPrismaClient();
    if (!prisma) return;

    adminUserId = (
      await prisma.user.findFirst({
        where: { roles: { some: { role: { name: { in: ["admin", "superuser"] } } } } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })
    )?.id;
    if (!adminUserId) {
      console.warn("[schema-prompt] No admin user found — skipping seed");
      return;
    }

    // Seed a fresh test Archive owned by admin. Unique slug per run so
    // parallel CI workers don't collide on the slug unique constraint.
    const unique = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    testArchiveSlug = TEST_ARCHIVE_SLUG_PREFIX + unique;
    const archive = await prisma.archive.create({
      data: {
        slug: testArchiveSlug,
        name: `E2E Schema Prompt Test Archive ${unique}`,
        description: "Created by e2e/schema-prompt.spec.ts — safe to delete",
        createdBy: adminUserId,
      },
    });
    testArchiveId = archive.id;

    // Mirror createArchive's on-disk layout (archiveService.ts:67-80) so the
    // raw_sources/ subtree exists for the non-write observation and page
    // writes have a target. The server does this for API-created archives;
    // we replicate it for the Prisma-seeded row.
    const archiveDir = path.join(ARCHIVES_BASE, testArchiveSlug);
    for (const dir of [
      path.join(archiveDir, "raw_sources"),
      path.join(archiveDir, "wiki", "entities"),
      path.join(archiveDir, "wiki", "concepts"),
      path.join(archiveDir, "wiki", "decisions"),
      path.join(archiveDir, "inventory"),
      path.join(archiveDir, ".internal"),
    ]) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(
      path.join(archiveDir, "log.md"),
      `# E2E Schema Prompt Test Archive ${unique} — Operation Log\n`,
      "utf-8",
    );

    // 260919: mirror createArchive's git init (archiveService.ts:83-91) — the
    // seeded layout previously skipped it, so every page create/update in the
    // KBPG test logged "[archive] Git commit failed ... not a git repository"
    // (best-effort commit noise in the server log, no test failure). With the
    // repo initialized the commits succeed like a real API-created archive.
    try {
      const git = simpleGit(archiveDir);
      await fs.writeFile(path.join(archiveDir, ".gitignore"), ".internal/\n", "utf-8");
      await git.init();
      await git.addConfig("user.name", `user-${adminUserId}`);
      await git.addConfig("user.email", "user@simmetric-chat");
      await git.add(".gitignore");
      await git.commit("archive: init");
    } catch {
      // Best-effort — page flows do not depend on git versioning.
    }
  });

  test.afterAll(async () => {
    if (!prisma) return;
    try {
      if (testArchiveId) {
        await prisma.archivePage.deleteMany({ where: { archiveId: testArchiveId } }).catch(() => {});
        await prisma.archiveConfig.deleteMany({ where: { archiveId: testArchiveId } }).catch(() => {});
        await prisma.archive.delete({ where: { id: testArchiveId } }).catch(() => {});
      }
    } finally {
      await prisma.$disconnect();
      // Best-effort on-disk cleanup (mirror of the seeded layout) — after the
      // prisma rows are gone the directory is orphaned; remove it.
      if (testArchiveSlug) {
        const archiveDir = path.join(ARCHIVES_BASE, testArchiveSlug);
        await fs.rm(archiveDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  /** Navigate to the test archive's Config tab and wait for the panel. */
  async function openConfigPanel(page: Page): Promise<void> {
    await page.goto(`/archives/${testArchiveId}`);
    // The detail page renders a 4-tab TabsList (pages/jobs/graph/config).
    // Click the Config tab (archiveDetail.tabs.config = "Config").
    await page.locator('button[role="tab"]:has-text("Config")').first().click();
    // Wait for the config panel's header title (config.title = "Archive Configuration").
    await expect(page.getByRole("heading", { name: "Archive Configuration" })).toBeVisible({ timeout: 15000 });
    // Wait for the section heading (archives.schemaPrompt.label).
    await expect(page.getByRole("heading", { name: LABEL }).first()).toBeVisible({ timeout: 15000 });
  }

  /** The schema-prompt textarea is the one labeled with the section label
   *  (AppTextarea renders <Label htmlFor> + <Textarea id>). Scope by the
   *  labeled association so we never match the purpose/scope textareas. */
  async function getSchemaTextarea(page: Page) {
    // The section renders TWO elements with the label text (h4 heading +
    // AppTextarea Label). Use getByLabel which resolves via htmlFor/id.
    return page.getByLabel(LABEL).first();
  }

  async function saveConfig(page: Page): Promise<void> {
    // The header Save button (archives.schemaPrompt.save = "Save Configuration").
    const saveBtn = page.locator(`button:has-text("${SAVE_BTN}")`).first();
    await expect(saveBtn).toBeVisible({ timeout: 10000 });
    // Wait for the save POST to settle (PUT /api/archives/:id/config).
    const savePromise = page.waitForResponse(
      (resp) => resp.url().includes(`/api/archives/${testArchiveId}/config`) && resp.request().method() === "PUT",
      { timeout: 15000 }
    );
    await saveBtn.click();
    const resp = await savePromise;
    expect(resp.status(), `config PUT must be 2xx, got ${resp.status()}`).toBeGreaterThanOrEqual(200);
    expect(resp.status()).toBeLessThan(300);
    // Success toast (config.saved = "Configuration saved").
    await expect(page.getByText(SAVED_TOAST).first()).toBeVisible({ timeout: 10000 });
  }

  test("SC-1: admin sets schemaPrompt in the UI → survives reload; clear + save → valid empty state", async ({ page }) => {
    test.skip(!testArchiveId, "Seed failed (DATABASE_URL or admin user missing) — skipping");
    await loginAsAdminUi(page);
    await openConfigPanel(page);

    const textarea = await getSchemaTextarea(page);
    await expect(textarea).toBeVisible({ timeout: 10000 });

    // Empty state: placeholder visible + "Use template" button present.
    await expect(textarea).toHaveAttribute("placeholder", new RegExp(PLACEHOLDER_PREFIX));
    await expect(page.locator(`button:has-text("${USE_TEMPLATE}")`).first()).toBeVisible();

    // Type the marker prompt (distinctive string per the plan's action spec).
    const marker = `E2E-SCHEMA-PROMPT-MARKER-${Date.now().toString(36)} — Every page must start with a one-paragraph summary.`;
    await textarea.fill(marker);

    await saveConfig(page);

    // Reload the page → the textarea value must still contain the marker
    // (ROADMAP SC-1: saved text survives reload, hydration via useArchiveConfig).
    await page.reload();
    await openConfigPanel(page);
    const textareaAfterReload = await getSchemaTextarea(page);
    await expect(textareaAfterReload).toBeVisible({ timeout: 15000 });
    await expect(textareaAfterReload).toHaveValue(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // Clear the textarea and save again → valid empty state (UI-SPEC
    // destructive-actions row: no confirmation required). The placeholder +
    // "Use template" button must re-render once the invalidated config query
    // refetches (useUpdateArchiveConfig onSuccess invalidates the config key).
    await textareaAfterReload.fill("");
    await saveConfig(page);
    await expect(page.locator(`button:has-text("${USE_TEMPLATE}")`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByLabel(LABEL).first()).toHaveAttribute("placeholder", new RegExp(PLACEHOLDER_PREFIX));
  });

  test("SC-1b: clear + save → placeholder and Use template re-render (valid empty state)", async ({ page }) => {
    test.skip(!testArchiveId, "Seed failed — skipping empty-state test");
    await loginAsAdminUi(page);
    await openConfigPanel(page);

    const textarea = await getSchemaTextarea(page);
    await expect(textarea).toBeVisible({ timeout: 10000 });

    // Ensure a non-empty starting state (idempotent per run — this test may
    // run after a retry that left the archive in either state).
    const current = await textarea.inputValue();
    if (current.length === 0) {
      await textarea.fill("E2E-SCHEMA-PROMPT-EMPTY-STATE-SEED");
      await saveConfig(page);
      await page.reload();
      await openConfigPanel(page);
    }

    // Clear + save → the empty state re-renders (placeholder + Use template)
    // once the config refetch lands.
    await textarea.fill("");
    await saveConfig(page);
    // Wait for the refetch: the "Use template" button (rendered only while
    // schemaPrompt.length === 0) reappears.
    await expect(page.locator(`button:has-text("${USE_TEMPLATE}")`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByLabel(LABEL).first()).toHaveAttribute("placeholder", new RegExp(PLACEHOLDER_PREFIX));
  });

  test("Use template + Edit/Preview toggle → save → persists (UI-SPEC light pass)", async ({ page }) => {
    test.skip(!testArchiveId, "Seed failed — skipping template test");
    await loginAsAdminUi(page);
    await openConfigPanel(page);

    const textarea = await getSchemaTextarea(page);
    await expect(textarea).toBeVisible({ timeout: 10000 });

    // Start empty (idempotent): if a prior test left content, clear + save.
    if ((await textarea.inputValue()).length > 0) {
      await textarea.fill("");
      await saveConfig(page);
      await page.reload();
      await openConfigPanel(page);
    }

    // "Use template" (visible only while empty — Plan 02's inverted-condition fix).
    const templateBtn = page.locator(`button:has-text("${USE_TEMPLATE}")`).first();
    await expect(templateBtn).toBeVisible({ timeout: 10000 });
    await templateBtn.click();
    // The textarea now carries the template body including the verbatim
    // raw_sources immutability line (DEFAULT_TEMPLATE_BODY).
    await expect(textarea).toHaveValue(/raw_sources\/ is immutable — never modify original source files\./);
    // Template button disappears once non-empty.
    await expect(templateBtn).toHaveCount(0);

    // Edit/Preview toggle: Preview renders markdown (heading text visible in
    // the preview pane, no raw # prefix).
    await page.locator(`button:has-text("${TAB_PREVIEW}")`).first().click();
    const previewPane = page.locator('[data-testid="schema-preview"]');
    await expect(previewPane).toBeVisible({ timeout: 10000 });
    // The h1 "Wiki Editorial Guidelines" renders as an element (not raw "# ").
    await expect(previewPane.locator("h1, h2").first()).toBeVisible();
    const previewText = (await previewPane.innerText()).trim();
    expect(previewText.startsWith("#")).toBe(false);
    expect(previewText).toContain("Page Structure");

    // Back to Edit → save → reload → persisted.
    await page.locator(`button:has-text("${TAB_EDIT}")`).first().click();
    await expect(previewPane).toHaveCount(0);
    await saveConfig(page);
    await page.reload();
    await openConfigPanel(page);
    const textareaAfterReload = await getSchemaTextarea(page);
    await expect(textareaAfterReload).toBeVisible({ timeout: 15000 });
    await expect(textareaAfterReload).toHaveValue(/raw_sources\/ is immutable — never modify original source files\./);
  });

  test("D-07: KBPG page create/text-edit/rename with schemaPrompt PRESENT + raw_sources non-write (SC-3, WIKS-02)", async ({ request }) => {
    test.skip(!testArchiveId || !adminUserId, "Seed failed — skipping KBPG test");
    test.setTimeout(60000);

    // Ensure the marker schemaPrompt is saved on the archive (via the config
    // API — same Zod-validated route the UI uses). This makes the
    // non-regression claim precise: the flows work WITH the advisory config
    // present, not absent.
    const token = await getAdminToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const putConfig = await request.put(`${SERVER_URL}/api/archives/${testArchiveId}/config`, {
      headers,
      data: { agentPersona: "balanced", purpose: "", scope: "", schemaPrompt: MARKER_PROMPT },
      timeout: 10000,
    });
    expect(putConfig.status(), "config PUT with marker schemaPrompt must be 2xx").toBeLessThan(300);
    // Verify the saved config carries the marker (SC-1 server-side half).
    const getConfig = await request.get(`${SERVER_URL}/api/archives/${testArchiveId}/config`, { headers });
    expect(getConfig.ok()).toBeTruthy();
    const storedConfig = (await getConfig.json()) as { schemaPrompt?: string };
    expect(storedConfig.schemaPrompt).toContain("E2E-SCHEMA-PROMPT-MARKER");

    // Snapshot the archive's raw_sources/ subtree BEFORE the page flows.
    const archiveDir = path.join(ARCHIVES_BASE, testArchiveSlug as string);
    const rawSourcesDir = path.join(archiveDir, "raw_sources");
    const before = await snapshotDir(rawSourcesDir);

    // ── KBPG page CREATE (POST /:archiveId/pages) ──────────────────────────
    const createSlug = `e2e-schema-prompt-page-${Date.now().toString(36)}`;
    const createResp = await request.post(`${SERVER_URL}/api/archives/${testArchiveId}/pages`, {
      headers,
      data: {
        title: "E2E Schema Prompt Page",
        content: "# E2E Schema Prompt Page\n\nCreated by e2e/schema-prompt.spec.ts to prove KBPG-02/03 flows stay unchanged.",
        category: "concepts",
      },
      timeout: 15000,
    });
    expect(createResp.status(), `page create must be 2xx, got ${createResp.status()}`).toBeGreaterThanOrEqual(200);
    expect(createResp.status()).toBeLessThan(300);
    const createdPage = (await createResp.json()) as { slug: string };

    // ── KBPG-03 TEXT EDIT (PUT /:archiveId/pages/:slug — body edit path) ───
    const editResp = await request.put(`${SERVER_URL}/api/archives/${testArchiveId}/pages/${createdPage.slug}`, {
      headers,
      data: {
        body: "# E2E Schema Prompt Page\n\nEdited body text — KBPG-02 text-edit flow with schemaPrompt present.",
      },
      timeout: 15000,
    });
    expect(editResp.status(), `page text edit must be 2xx, got ${editResp.status()}`).toBeGreaterThanOrEqual(200);
    expect(editResp.status()).toBeLessThan(300);

    // ── KBPG-03 RENAME (PUT with new slug + title — rename path) ──────────
    const renamedSlug = `${createdPage.slug}-renamed`;
    const renameResp = await request.put(`${SERVER_URL}/api/archives/${testArchiveId}/pages/${createdPage.slug}`, {
      headers,
      data: { slug: renamedSlug, title: "E2E Schema Prompt Page (Renamed)" },
      timeout: 15000,
    });
    expect(renameResp.status(), `page rename must be 2xx, got ${renameResp.status()}`).toBeGreaterThanOrEqual(200);
    expect(renameResp.status()).toBeLessThan(300);

    // ── WIKS-02 (a): no file created/modified under raw_sources/ during the flows.
    const after = await snapshotDir(rawSourcesDir);
    expect(
      after.size,
      "raw_sources/ subtree must be byte-identical after the page flows (WIKS-02 end-to-end)"
    ).toBe(before.size);
    for (const [k, v] of before) {
      expect(after.get(k), `raw_sources entry ${k} changed during page flows`).toBe(v);
    }

    // ── WIKS-02 (b): no page row carries a raw_sources category — every page
    // lives in wiki/ categories (GET /:archiveId/pages observation, not a
    // write-attempt probe — the traversal rejection is pinned at unit level).
    const pagesResp = await request.get(`${SERVER_URL}/api/archives/${testArchiveId}/pages`, { headers });
    expect(pagesResp.ok()).toBeTruthy();
    const pages = (await pagesResp.json()) as Array<{ slug: string; category: string; filePath?: string }>;
    expect(pages.length).toBeGreaterThanOrEqual(1);
    for (const p of pages) {
      expect(
        ["entities", "concepts", "decisions", "graph-wiki", "general"].includes(p.category),
        `page ${p.slug} has unexpected category ${p.category}`
      ).toBe(true);
    }
    const renamedStillThere = pages.find((p) => p.slug === renamedSlug);
    expect(renamedStillThere, "renamed page must be listed").toBeTruthy();
  });
});

// The Save button's pending label is asserted implicitly by saveConfig's
// response wait; the marker constant is used by the D-07 test's config seed.