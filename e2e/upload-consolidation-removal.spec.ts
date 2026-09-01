/**
 * Phase 73 — SC-1/SC-2 upload-consolidation removal-verification (D-73-01/03).
 *
 * Browser-level DOM assertions that the F72 consolidation actually removed the
 * per-section upload affordances and that the surviving CTAs navigate to the
 * unified /uploads area. Route-level grep was already done in
 * 72-VERIFICATION.md — D-73-03 explicitly requires real-browser assertions.
 *
 * Tests:
 *  1. /documents has no dropzone (input[type="file"] count 0 — DocumentUploader
 *     was deleted in F72) AND the header CTA (data-testid="documents-upload-cta")
 *     navigates to /uploads.
 *  2. /archives has no ingest upload affordance (input[type="file"] count 0 —
 *     OcrUploadPanel/UrlIngestionForm deleted in F72); an archive detail page
 *     renders the renamed tab "Jobs" (i18n key archiveDetail.tabs.jobs → "Jobs",
 *     F72 72-02 rename) and the per-archive CTA
 *     (data-testid="archive-detail-upload-cta") deep-links to
 *     /uploads?archiveId=<id>.
 *  3. /uploads?archiveId=<id> deep-link pre-selects the archive AND sets
 *     destination=kb (UnifiedUploadPage.tsx:138-149 useSearchParams reader):
 *     the kb radio (#dest-kb) is in the checked state and the archive picker
 *     shows the target archive name.
 *
 * Selectors (D-73-03): stable data-testid attributes added in Plan 73-03 Task 1
 * (documents-upload-cta, archives-upload-cta, archive-detail-upload-cta) keep
 * the positive assertions decoupled from i18n text. The negative assertions
 * (input[type="file"] count 0) are strong because the deleted components no
 * longer render any file input.
 *
 * Reference: .planning/phases/73-non-regression-verification-tests-i18n-parity/
 * 73-03-PLAN.md Task 3 + 73-PATTERNS.md §"upload-consolidation-removal.spec.ts".
 */

import { test, expect, type APIRequestContext } from "./fixtures";

const SERVER_URL = "http://localhost:3000";

/** Login as admin via API and return the JWT bearer token. */
async function adminLoginToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    timeout: 8000,
  });
  expect(res.ok(), `admin login failed: ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}

/** Create an archive via the admin API and return its id. */
async function createArchive(request: APIRequestContext, token: string, name: string): Promise<string> {
  const res = await request.post(`${SERVER_URL}/api/archives`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name },
    timeout: 10000,
  });
  expect(res.status(), `archive create must return 201, got ${res.status()}`).toBe(201);
  return (await res.json()).id;
}

const RUN_ID = Date.now().toString();

test.describe("upload consolidation removal verification", () => {
  test("/documents has no dropzone, CTA navigates to /uploads", async ({ adminPage: page }) => {
    await page.goto("/documents");
    // DocumentsPage renders a <div> shell (no <main> element); the header CTA
    // (data-testid="documents-upload-cta") is always present in the page header
    // (not gated on loading/empty state), so it is the readiness signal.
    const cta = page.locator('[data-testid="documents-upload-cta"]');
    await expect(cta).toBeVisible({ timeout: 15000 });

    // Negative (D-73-03): no file-input dropzone — DocumentUploader was deleted
    // in F72, so /documents is a RAG view/browse/query/manage surface only.
    await expect(page.locator('input[type="file"]')).toHaveCount(0);

    // Positive: the header CTA (stable testid from Plan 73-03 Task 1) navigates
    // to the unified upload area.
    await cta.click();
    await expect(page).toHaveURL(/\/uploads/);

    // Optional: the empty-state CTA renders only when the workspace has no
    // documents — assert softly so the test does not couple to dev DB state.
    await page.goto("/documents");
    await expect(cta).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="documents-upload-cta-empty"]'))
      .toBeVisible()
      .catch(() => { /* empty-state CTA only shows when the doc list is empty */ });
  });

  test("/archives tab Jobs present, no ingest upload affordances", async ({ adminPage: page, request }) => {
    const token = await adminLoginToken(request);
    // Ensure the archive list is non-empty so the header CTA (gated on
    // archives.length > 0) renders.
    const archiveName = `e2e-removal-${RUN_ID}`;
    const archiveId = await createArchive(request, token, archiveName);

    try {
      // /archives list: no ingest-tab upload affordance (OcrUploadPanel /
      // UrlIngestionForm deleted in F72).
      await page.goto("/archives");
      // ArchivesPage renders a <div> shell (no <main>); the header CTA
      // (archives-upload-cta) is gated on archives.length > 0 — we created an
      // archive above, so once useArchives() refetches the CTA appears. Wait
      // for it as the readiness signal.
      const listCta = page.locator('[data-testid="archives-upload-cta"]');
      await expect(listCta).toBeVisible({ timeout: 15000 });
      await expect(page.locator('input[type="file"]')).toHaveCount(0);

      // Header CTA navigates to /uploads.
      await listCta.click();
      await expect(page).toHaveURL(/\/uploads/);

      // Archive detail: tab "Jobs" present (archiveDetail.tabs.jobs → "Jobs",
      // F72 72-02 rename from "ingest"), no file-input affordance, and the
      // per-archive CTA deep-links to /uploads?archiveId=<id>.
      await page.goto(`/archives/${archiveId}`);
      // ArchiveDetailPage renders a <main> shell, but the readiness signal is
      // the "Jobs" tab (Radix TabsTrigger, role="tab") which appears once the
      // archive loads.
      await expect(page.getByRole("tab", { name: "Jobs" })).toBeVisible({ timeout: 15000 });
      // No ingest upload affordance on the archive detail either.
      await expect(page.locator('input[type="file"]')).toHaveCount(0);

      const detailCta = page.locator('[data-testid="archive-detail-upload-cta"]');
      await expect(detailCta).toBeVisible({ timeout: 10000 });
      await detailCta.click();
      await expect(page).toHaveURL(/\/uploads\?archiveId=/);
    } finally {
      // Idempotent soft-delete cleanup (analog create-project-sidebar.spec.ts).
      await request
        .delete(`${SERVER_URL}/api/archives/${archiveId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        .catch(() => {});
    }
  });

  test("/uploads?archiveId=X deep-link pre-selects archive + destination=kb", async ({ adminPage: page, request }) => {
    const token = await adminLoginToken(request);
    const archiveName = `e2e-deeplink-${RUN_ID}`;
    const archiveId = await createArchive(request, token, archiveName);

    try {
      // Deep-link with ?archiveId — UnifiedUploadPage.tsx:138-149 useSearchParams
      // reader pre-sets archiveId + destination="kb" (DEFAULT, still
      // user-modifiable) when the id matches an archive in the user's list.
      await page.goto(`/uploads?archiveId=${archiveId}`);
      // UnifiedUploadPage renders a <div> shell (no <main>); the destination
      // chooser's kb radio (#dest-kb, id built as `dest-${opt.value}` in
      // UploadDestinationChooser.tsx:189) is the readiness signal. The
      // useSearchParams reader pre-sets destination="kb" when archiveId
      // matches an archive in the user's list.
      const kbRadio = page.locator("#dest-kb");
      await expect(kbRadio).toBeVisible({ timeout: 15000 });

      // destination=kb pre-selected: the kb radio (#dest-kb) is in the checked
      // state (Radix RadioGroupItem exposes data-state="checked").
      await expect(kbRadio).toHaveAttribute("data-state", "checked");

      // The archive picker is shown (destination kb/both → showArchivePicker)
      // and carries the pre-selected archive name.
      await expect(page.getByText(archiveName).first()).toBeVisible({ timeout: 10000 });
    } finally {
      await request
        .delete(`${SERVER_URL}/api/archives/${archiveId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        .catch(() => {});
    }
  });
});