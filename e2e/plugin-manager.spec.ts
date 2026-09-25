// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-05, 202-06 Task 1) — Plugin manager E2E journey.
 *
 * install → license → enable → disable → uninstall via the REAL UI + routes
 * with a REAL loadable zip fixture (RESEARCH A5): upload rides the multer +
 * installFromZip path (no API mocking), the license paste rides the real
 * RS256 verify (JWT minted in-test with node:crypto + the SIBLING tool's
 * committed license-private.pem — keypair-verified against the server's
 * embedded LICENSE_PUBLIC_KEY).
 *
 * RESTART IS OUT OF SCOPE (D-09): a restart would kill the server under
 * Playwright. The restart flow is covered by the 202-02 unit pin (202 +
 * graceful-shutdown-called-exactly-once) and the 202-04 component pin
 * (supervisor/manual split) — NO restart call exists anywhere in this spec.
 *
 * Environment bring-up: the stack must serve :3000 with the phase-202
 * migrations. A docker-proxy-owned :3000 that fails the pre-flight skips
 * with the documented reason (the 197-04 stale-server runbook: docker stop
 * simmetric-chat-server unblocks a fresh tsx boot) — never a half-booted
 * stack, never a silent pass.
 */

import { test, expect } from "./fixtures";
import { execFileSync } from "node:child_process";
import { createSign, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVER_URL = "http://localhost:3000";
const FRONTEND_URL = "http://localhost:5173";
const FIXTURE_PATH = resolve(process.cwd(), "e2e/fixtures/plugin-fixture.zip");
const GENERATOR = resolve(process.cwd(), "packages/server/scripts/make-plugin-fixture.cjs");
// The sibling license tool's committed keypair — its PUBLIC half matches the
// server's embedded LICENSE_PUBLIC_KEY_PEM (verified by modulus equality).
const LICENSE_PRIVATE_KEY = resolve(process.cwd(), "../simmetric-license-tool/keys/license-private.pem");
const PLUGIN_NAME = "@fixture/widget";

let adminToken: string;

/** Minimal RS256 JWT signer (node:crypto only — jsonwebtoken lives in the
 * server package, not the root workspace the e2e runner resolves from). */
function signRs256Jwt(payload: Record<string, unknown>, privatePem: string): string {
  const b64url = (buf: Buffer) =>
    buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  const signature = signer.sign(privatePem);
  return `${header}.${body}.${b64url(signature)}`;
}

test.describe("Plugin Manager Lifecycle", () => {
  test.beforeAll(async ({ request }) => {
    // ── Generate the zip fixture (a REAL loadable CJS module, A5) ──
    execFileSync("node", [GENERATOR, "--out", FIXTURE_PATH], { cwd: process.cwd() });
    if (!existsSync(FIXTURE_PATH)) {
      throw new Error("plugin fixture zip missing after generation — failing loudly, never silently skipping");
    }

    // ── Pre-flight: the server must be up AND carry the phase-202 surface ──
    try {
      const loginRes = await request.post(`${SERVER_URL}/api/auth/login`, {
        data: { username: "admin", password: "admin123" },
      });
      if (!loginRes.ok()) {
        test.skip(true, `Server pre-flight login failed (${loginRes.status()}) — documented-environment skip (197-04 runbook: docker stop simmetric-chat-server, then a fresh tsx boot)`);
        return;
      }
      adminToken = (await loginRes.json()).token;
      const pluginsRes = await request.get(`${SERVER_URL}/api/plugins`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!pluginsRes.ok()) {
        test.skip(true, `/api/plugins returned ${pluginsRes.status()} — server predates the phase-202 migrations or runs a foreign DB (197-04 runbook skip)`);
        return;
      }
    } catch {
      test.skip(true, "Server unreachable on :3000 — documented-environment skip (197-04 stale-server runbook)");
      return;
    }
  });

  test("install → license → enable → disable → uninstall journey", async ({ page }) => {
    // ── Login via UI (marketplace-lifecycle idiom) ──
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForSelector("input", { timeout: 10000 });
    const inputs = page.locator("input");
    if ((await inputs.count()) >= 2) {
      await inputs.nth(0).fill("admin");
      await inputs.nth(1).fill("admin123");
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(2000);
    }

    // ── Navigate to /plugins (sidebar entry visible per the menu gate) ──
    await page.goto(`${FRONTEND_URL}/plugins`);
    await expect(page.getByText("Install a plugin")).toBeVisible({ timeout: 15000 });

    // ── Upload the zip fixture (REAL multer + installFromZip path) ──
    await page.setInputFiles('[data-testid="dropzone-input"]', FIXTURE_PATH);
    await expect(page.getByText("Plugin installed — enable it to load after a restart.")).toBeVisible({ timeout: 20000 });

    const card = page.locator("[data-plugin-card]").filter({ hasText: PLUGIN_NAME });
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.getByText("Managed")).toBeVisible();
    // Fresh installs are enabled:false — the status priority renders
    // Disabled (disabled > failed > loaded > installed).
    await expect(card.getByText("Disabled")).toBeVisible();
    // platform fixture, never verified → amber pending badge
    await expect(card.getByText("License missing")).toBeVisible();

    // ── License modal: paste → Verify (probe-only) → Save ──
    const jwt = signRs256Jwt(
      {
        tier: "enterprise",
        iss: "simmetric-chat",
        sub: "E2E Plugin Fixture",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        plugin: PLUGIN_NAME,
      },
      readFileSync(LICENSE_PRIVATE_KEY, "utf8"),
    );

    await card.getByRole("button", { name: "Plugin actions" }).click();
    await page.getByText("Manage license").click();
    await expect(page.getByText("This plugin requires a Simmetric platform license before it can load.")).toBeVisible();
    const licenseInput = page.getByLabel("License key (JWT)");
    // A-6: the modal ALWAYS opens empty.
    await expect(licenseInput).toHaveValue("");
    await licenseInput.fill(jwt);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("License valid — safe to save.")).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Save license" }).click();
    await expect(page.getByText("License saved")).toBeVisible({ timeout: 10000 });
    // The card's license badge refetches to License ✓ (the JWT itself is
    // never echoed anywhere — A-6 write-only discipline).
    await expect(card.getByText("License ✓")).toBeVisible({ timeout: 15000 });

    // ── Enable toggle: deferred-effect toast + amber restart-pending chip ──
    await card.getByRole("switch").click();
    await expect(page.getByText("Plugin Enable — takes effect after a restart.")).toBeVisible({ timeout: 10000 });
    await expect(card.getByText("Restart required")).toBeVisible({ timeout: 15000 });
    // Toggle back off before uninstall (D-08: DELETE only on disabled rows).
    await card.getByRole("switch").click();
    await expect(page.getByText("Plugin Disable — takes effect after a restart.")).toBeVisible({ timeout: 10000 });

    // ── Uninstall (Cancel first in tab order — the 199 idiom) ──
    await card.getByRole("button", { name: "Plugin actions" }).click();
    await page.getByText("Uninstall").click();
    await expect(page.getByText("Uninstall @fixture/widget?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible(); // Cancel FIRST
    await page.getByRole("button", { name: "Uninstall" }).last().click();
    await expect(page.getByText("Plugin uninstalled")).toBeVisible({ timeout: 10000 });
    await expect(card).toHaveCount(0, { timeout: 15000 });
  });
});