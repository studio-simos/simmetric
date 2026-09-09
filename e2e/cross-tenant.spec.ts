// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * E2E cross-tenant isolation (Phase 185, SAAS-04d — ROADMAP SC-4 E2E arm).
 *
 * Rides the ORG_B fixture seeded by globalSetup's seedOrgBFixture
 * (org …00bb + orgbuser + owner membership + org-b project + OrgB Workspace
 * since 182/184). Proves the cross-tenant doctrine surfaces in the REAL UI
 * flow: the org-b user's session cannot reach the default-org workspace —
 *
 *  Test 1 "restore probe 404 + localStorage heal": login as orgbuser with
 *   lastWorkspaceId pre-pointed at the admin-seeded default-org workspace →
 *   App.tsx's restore() calls GET /api/workspaces/{id} → 404 (tenant
 *   scoping makes the row invisible) → the app heals localStorage
 *   (lastWorkspaceId removed) and NO workspace content is selected. The
 *   underlying contract (SC-4: 404, never 403) is asserted directly in
 *   test 2.
 *
 *  Test 2 "in-page API probe 404": from the logged-in org-b page context,
 *   fetch("/api/workspaces/{DEFAULT_WS_ID}") with the session token →
 *   status 404 {error:"Workspace not found"} — the exact
 *   requireWorkspaceAccess 404 branch (Pitfall 8: a 403 would mean the row
 *   RESOLVED = leak).
 *
 *  Test 3 "org-b's OWN workspace resolves (negative control)": the same
 *   in-page probe against ORG_B_WORKSPACE_ID → 200 — the isolation is
 *   scoping-driven, not auth breakage (the org-b member sees their OWN
 *   workspace).
 *
 * Loud-fail semantics (184-02 gated() lesson — never green-empty): if the
 * org-b fixture is absent (login fails / org rows missing), the tests FAIL
 * with setup guidance instead of skipping. A green-empty suite here would
 * silently void the leak-detector contract (T-185-21).
 *
 * Zero-grep gate (T-182-15): ORG_B* symbols live ONLY under e2e/.
 *
 * Widget E2E arm: deliberately omitted — the integration matrix already
 * covers widget org resolution (185-02 suite + crossTenant matrix 5's
 * extension-level probes), and the widget E2E surface would need new
 * harness beyond fixture extension (plan 185-04 Task 2 skip provision).
 */

import { test, expect, type Page } from "./fixtures";
import { ORG_B_ID, ORG_B_USERNAME, ORG_B_WORKSPACE_ID, ORG_B_USER_EMAIL } from "./fixtures";

const SERVER_URL = "http://localhost:3000";
// The admin-seeded default-org workspace (globalSetup seedWorkspaceAndChat
// + Phase 103 D-01 — the same id every E2E spec rides).
const DEFAULT_ORG_WORKSPACE_ID = "9a334821-b880-411b-affc-805664e7fd66";

/** Login as the org-b fixture user via the UI login form (loginAsAdmin
 *  precedent — 169-03 mount guard, 5000ms waitForSelector). Org-b has no
 *  mustChangePassword (fixture creates with the default false) — the
 *  authenticated app shell (<header>) settles directly. */
async function loginAsOrgB(page: Page): Promise<void> {
  await page.addInitScript((wsId) => {
    localStorage.setItem("language", "en");
    // Point the app's restore() probe at the DEFAULT-ORG workspace: the
    // cross-tenant target. restore() GETs /api/workspaces/{id} on boot —
    // tenant scoping must 404 it and heal localStorage (test 1).
    localStorage.setItem("lastWorkspaceId", wsId);
    try {
      const style = document.createElement("style");
      style.textContent = "* { animation: none !important; transition: none !important; }";
      (document.head || document.documentElement || document.body || document.documentElement)?.appendChild(style);
    } catch {}
  }, DEFAULT_ORG_WORKSPACE_ID);
  await page.goto("/");
  await page.waitForSelector('input[type="text"], input[placeholder*="username" i]', { timeout: 5000 }).catch(() => {});
  const usernameInput = page.locator('input[type="text"]').first();
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill(ORG_B_USERNAME);
    await page.locator('input[type="password"]').first().fill("orgbpass123");
    await page.locator('button[type="submit"]').click();
    await page.locator("header").waitFor({ state: "visible", timeout: 10000 });
  }
}

test.describe("E2E cross-tenant isolation (org-b — SAAS-04d, SC-4)", () => {
  // Loud fixture-presence semantics (IN-01, 185-05): the comment's original
  // "fixtureVerified" guard was dead code (set, never read) — the ACTUAL
  // loud-fail behavior is the loginAsOrgB throw below: a failed org-b login
  // (broken seedOrgBFixture seed) fails the test immediately with fixture
  // guidance — never a green-empty pass.

  test("restore probe — cross-tenant lastWorkspaceId 404s and heals localStorage (no org-a workspace content surfaces)", async ({ page }) => {
    await loginAsOrgB(page);

    // The restore() probe is ASYNC (it starts after the auth settles and the
    // 404 round-trip lands after <header> mounts) — poll until the heal
    // completes or the timeout proves the leak. The cross-tenant workspace
    // id must be GONE from localStorage: restore() GETs
    // /api/workspaces/{id} → 404 (tenant scoping makes the row invisible)
    // → removeItem. App.tsx:263-267's persist effect only re-writes the key
    // when workspace state CHANGES — the 404 heal arm leaves it removed.
    await expect
      .poll(
        async () =>
          page.evaluate(() => localStorage.getItem("lastWorkspaceId")),
        {
          timeout: 15000,
          message:
            "restore() must REMOVE the cross-tenant lastWorkspaceId (GET /api/workspaces/{id} returned 404 — " +
            "if the id persists, the org-b session ADOPTED the org-a workspace = leak; " +
            "if the org-b login itself failed, seedOrgBFixture did not seed the fixture — check globalSetup logs)",
        },
      )
      .toBeNull();

    // No workspace selected: the app shell never renders the default-org
    // workspace name ("Elegregio" when seeded) for the org-b session.
    await expect(page.getByText("Elegregio")).toHaveCount(0);
  });

  test("in-page API probe — GET /api/workspaces/{default-org id} → 404 Workspace not found (SC-4 E2E arm)", async ({ page }) => {
    await loginAsOrgB(page);

    const result = await page.evaluate(async ({ wsId, serverUrl }) => {
      const token = localStorage.getItem("token");
      const res = await fetch(`${serverUrl}/api/workspaces/${wsId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      let body: { error?: string } = {};
      try {
        body = (await res.json()) as { error?: string };
      } catch {
        body = {};
      }
      return { status: res.status, error: body.error ?? null };
    }, { wsId: DEFAULT_ORG_WORKSPACE_ID, serverUrl: SERVER_URL });

    // NEVER 403 — a 403 would mean the row RESOLVED for the org-b principal
    // (Pitfall 8 existence leak). The exact requireWorkspaceAccess 404 branch.
    expect(result.status).toBe(404);
    expect(result.error).toBe("Workspace not found");
  });

  test("negative control — org-b's OWN workspace resolves 200 for the org-b session (scoping-driven isolation, not auth breakage)", async ({ page }) => {
    await loginAsOrgB(page);

    const result = await page.evaluate(async ({ wsId, serverUrl, orgId }) => {
      const token = localStorage.getItem("token");
      const res = await fetch(`${serverUrl}/api/workspaces/${wsId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      let body: { id?: string; organizationId?: string; error?: string } = {};
      try {
        body = (await res.json()) as { id?: string; organizationId?: string; error?: string };
      } catch {
        body = {};
      }
      return { status: res.status, id: body.id ?? null, organizationId: body.organizationId ?? null, error: body.error ?? null };
    }, { wsId: ORG_B_WORKSPACE_ID, serverUrl: SERVER_URL, orgId: ORG_B_ID });

    expect(result.status).toBe(200);
    expect(result.id).toBe(ORG_B_WORKSPACE_ID);
    expect(result.organizationId).toBe(ORG_B_ID);
  });

  // Fixture-identity sanity (silent guard for the constants import — the
  // ORG_B_USER_EMAIL/ORG_B_ID pair must never alias the default tenant;
  // mirrors the globalSetup TS-04 adjacency guard at the spec level).
  test("fixture sanity — ORG_B_ID distinct from DEFAULT_ORG_ID", async () => {
    expect(ORG_B_ID).not.toBe("00000000-0000-0000-0000-000000000000");
    expect(ORG_B_USER_EMAIL).not.toBe("admin@simmetric-chat.local");
  });
});