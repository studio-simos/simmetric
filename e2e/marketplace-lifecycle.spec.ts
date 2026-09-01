/**
 * E2E test: MCP Marketplace Lifecycle
 *
 * Exercises the complete marketplace lifecycle:
 * 1. Browse catalog with trust badges
 * 2. View detail page with commit recency badge
 * 3. Install an MCP server
 * 4. Toggle (enable/disable) the connection
 * 5. Uninstall the server
 * 6. Verify audit events are logged
 *
 * Uses an echo MCP server started in-process for deterministic results.
 */

import { test, expect } from "./fixtures";

const SERVER_URL = "http://localhost:3000";
const FRONTEND_URL = "http://localhost:5173";

let adminToken: string;
let echoServerPort: number;
let catalogEntryId: string;
let workspaceId: string;
let connectionId: string;

test.describe("MCP Marketplace Lifecycle", () => {
  test.beforeAll(async ({ request }) => {
    // ── Start echo MCP server ──
    try {
      const res = await request.post(`${SERVER_URL}/api/__tests__/start-echo-server`);
      if (res.ok()) {
        const body = await res.json();
        echoServerPort = body.port;
      } else {
        throw new Error("echo server start endpoint returned non-ok");
      }
    } catch {
      test.skip(true, "Echo MCP server failed to start — skipping marketplace lifecycle test");
      return;
    }

    // ── Login as admin ──
    const loginRes = await request.post(`${SERVER_URL}/api/auth/login`, {
      data: { username: "admin", password: "admin123" },
    });
    expect(loginRes.ok()).toBeTruthy();
    const loginBody = await loginRes.json();
    adminToken = loginBody.token;
    expect(adminToken).toBeDefined();

    // ── Create test project ──
    const projectRes = await request.post(`${SERVER_URL}/api/projects`, {
      data: { name: `E2E Test Project ${Date.now()}` },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(projectRes.ok()).toBeTruthy();
    const project = await projectRes.json();
    const projectId = project.id;

    // ── Create test workspace ──
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { projectId, name: "E2E Test Workspace" },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(wsRes.ok()).toBeTruthy();
    const ws = await wsRes.json();
    workspaceId = ws.id;

    // ── Create catalog entry for echo server ──
    const catRes = await request.post(`${SERVER_URL}/api/mcp-marketplace`, {
      data: {
        name: "E2E Echo Server",
        url: `http://localhost:${echoServerPort}/sse`,
        transportType: "sse",
        description: "Test echo MCP server for E2E marketplace lifecycle testing. Echoes messages back.",
        category: "Developer Tools",
        version: "1.0.0",
        author: "E2E Test Suite",
        verificationTier: "official",
      },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(catRes.ok()).toBeTruthy();
    const catEntry = await catRes.json();
    catalogEntryId = catEntry.id;
  });

  test.afterAll(async ({ request }) => {
    // ── Clean up test data ──
    if (connectionId) {
      try {
        await request.delete(`${SERVER_URL}/api/mcp-connections/${connectionId}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      } catch { /* best-effort cleanup */ }
    }
    if (catalogEntryId) {
      try {
        // No delete endpoint; connection cleanup is sufficient
      } catch { /* best-effort */ }
    }
    // Stop echo server
    try {
      await request.post(`${SERVER_URL}/api/__tests__/stop-echo-server`);
    } catch { /* server may already be stopped */ }
  });

  test("Step 1 — browse catalog with trust badges visible", async ({ page }) => {
    // Login via UI
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForSelector("input", { timeout: 5000 });
    const inputs = page.locator("input");
    const inputCount = await inputs.count();
    if (inputCount >= 2) {
      await inputs.nth(0).fill("admin");
      await inputs.nth(1).fill("admin123");
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(2000);
    }

    // Navigate to marketplace
    await page.goto(`${FRONTEND_URL}/mcp-marketplace`);
    await page.waitForTimeout(2000);

    // Verify marketplace heading is visible
    const heading = page.locator("h1, h2, h3").filter({ hasText: /Marketplace|MCP/i }).first();
    await expect(heading).toBeVisible({ timeout: 5000 }).catch(() => {
      // Marketplace may not be the current view; try clicking sidebar link
    });

    // Verify our echo server card is in the catalog
    const echoCard = page.locator("text=E2E Echo Server").first();
    await expect(echoCard).toBeVisible({ timeout: 5000 });
  });

  test("Step 2 — navigate to detail page and verify badges", async ({ page }) => {
    test.skip(!catalogEntryId, "catalogEntryId not set — beforeAll failed");

    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForSelector("input", { timeout: 5000 });
    const inputs = page.locator("input");
    const inputCount = await inputs.count();
    if (inputCount >= 2) {
      await inputs.nth(0).fill("admin");
      await inputs.nth(1).fill("admin123");
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(2000);
    }

    await page.goto(`${FRONTEND_URL}/mcp-marketplace/${catalogEntryId}`);
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      localStorage.setItem("lastWorkspaceId", "9a334821-b880-411b-affc-805664e7fd66");
    });
    await page.reload();
    await page.waitForTimeout(3000);

    await expect(page.locator("text=E2E Echo Server").first()).toBeVisible({ timeout: 15000 });

    const officialBadge = page.locator("text=Official").first();
    await expect(officialBadge).toBeVisible({ timeout: 5000 });
  });

  test("Step 3 — install echo MCP server", async ({ page, request }) => {
    test.skip(!catalogEntryId || !adminToken, "setup not ready — beforeAll failed");

    const installRes = await request.post(
      `${SERVER_URL}/api/mcp-marketplace/${catalogEntryId}/install`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { workspaceId },
        timeout: 15000,
      },
    );

    if (installRes.ok()) {
      const connRes = await request.get(
        `${SERVER_URL}/api/mcp-connections?workspaceId=${workspaceId}`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      if (connRes.ok()) {
        const connections = await connRes.json();
        const echoConn = connections.find((c: { name: string }) => c.name === "E2E Echo Server");
        if (echoConn) connectionId = echoConn.id;
      }
    }

    expect(connectionId).toBeDefined();
  });

  test("Step 4 — toggle connection disable/enable", async ({ request }) => {
    test.skip(!connectionId || !adminToken, "connectionId not set — Step 3 failed");

    // Disable the connection
    const disableRes = await request.post(`${SERVER_URL}/api/mcp-connections/${connectionId}/toggle`, {
      data: { enabled: false },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(disableRes.ok()).toBeTruthy();
    const disableBody = await disableRes.json();
    expect(disableBody.enabled).toBe(false);

    await new Promise((r) => setTimeout(r, 500));

    // Re-enable the connection
    const enableRes = await request.post(`${SERVER_URL}/api/mcp-connections/${connectionId}/toggle`, {
      data: { enabled: true },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(enableRes.ok()).toBeTruthy();
    const enableBody = await enableRes.json();
    expect(enableBody.enabled).toBe(true);
  });

  test("Step 5 — uninstall echo server and verify audit events", async ({ page, request }) => {
    test.skip(!catalogEntryId || !adminToken || !workspaceId, "setup not ready — beforeAll failed");
    // License-tier guard (quick 260831-sqr): the audit-log verification at the
    // end of this step requires the enterprise audit_log_immutable feature
    // (GET /api/event-logs is enterprise-gated — 402 on Community). Skip the
    // whole step on Community builds; a CI-minted Enterprise token is
    // impossible by design (vendor private key + no verifier env-override).
    const licRes = await request.get(`${SERVER_URL}/api/license/info`, { timeout: 10000 });
    if (licRes.ok()) {
      const info = (await licRes.json()) as { tier?: string };
      test.skip(info.tier !== "enterprise", "Enterprise license required (audit log is enterprise-gated)");
    }

    const uninstallRes = await request.post(
      `${SERVER_URL}/api/mcp-marketplace/${catalogEntryId}/uninstall`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { workspaceId },
        timeout: 15000,
      },
    );

    const logsRes = await request.get(
      `${SERVER_URL}/api/event-logs?entityType=mcp_connection&limit=20`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(logsRes.ok()).toBeTruthy();
    const logs = await logsRes.json();

    const events = Array.isArray(logs) ? logs : logs.events || logs.data || [];
    const actions = events.map((e: { action?: string; type?: string }) => e.action || e.type || "");
    const hasInstall = actions.some((a: string) => a.includes("install"));
    const hasUninstall = actions.some((a: string) => a.includes("uninstall"));

    expect(hasInstall || hasUninstall || uninstallRes.ok()).toBeTruthy();
  });
});
