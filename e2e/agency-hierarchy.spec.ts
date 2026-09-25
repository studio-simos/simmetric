// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 206 (AGENCY-01..04, Plan 05 Task 4) — agency hierarchy E2E journey
 * (API-first, connectors-telegram.spec.ts idiom: admin login via API → JWT;
 * globalSetup seeds admin/admin123; roles seeded idempotently by prisma/seed.ts).
 *
 * Journey (serial — shared module state):
 *  1. Admin provisions the agency user (admin-register, role "Web Agency") + sets ceiling 2
 *  2. Agency login → create×2 OK → third → 409 { error, quota: "users" }
 *  3. Sub-user login (temp password) → mustChangePassword → rotate
 *  4. Sub-user menus resolve the Utente Cloud set; forged agency:users:manage grant → 403 (D-03/D-08)
 *  5. Disable → sub-user login REJECTED (fail-closed); re-enable → login OK
 */

import { test, expect } from "./fixtures";

const SERVER_URL = "http://localhost:3000";
const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AGENCY_USERNAME = `agency_e2e_${testRunId}`;
const AGENCY_PASSWORD = "agency-e2e-pass-K1";
const SUB_A = `sub_e2e_${testRunId}_a`;
const SUB_B = `sub_e2e_${testRunId}_b`;
const ROTATED_PASSWORD = "rotated-e2e-pass-1";

let adminToken = "";
let agencyToken = "";
let agencyUserId = "";
let subATempPassword = "";
let subAId = "";

test.describe("Agency hierarchy journey (Phase 206)", () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${SERVER_URL}/api/auth/login`, {
      data: { username: "admin", password: "admin123" },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;
  });

  test("admin provisions the agency user + sets the ceiling (AGENCY-02/04 admin side)", async ({ request }) => {
    const register = await request.post(`${SERVER_URL}/api/auth/admin-register`, {
      data: {
        username: AGENCY_USERNAME,
        email: `${AGENCY_USERNAME}@example.test`,
        password: AGENCY_PASSWORD,
        role: "Web Agency",
      },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(register.status()).toBe(201);
    agencyUserId = (await register.json()).user.id;
    expect(agencyUserId).toBeTruthy();

    const patch = await request.patch(`${SERVER_URL}/api/users/${agencyUserId}`, {
      data: { maxSponsoredUsers: 2 },
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(patch.ok()).toBeTruthy();
  });

  test("agency creates sub-users within the ceiling; breach → 409 quota:users (AGENCY-01/04)", async ({ request }) => {
    const agencyLogin = await request.post(`${SERVER_URL}/api/auth/login`, {
      data: { username: AGENCY_USERNAME, password: AGENCY_PASSWORD },
    });
    expect(agencyLogin.ok()).toBeTruthy();
    agencyToken = (await agencyLogin.json()).token;

    const first = await request.post(`${SERVER_URL}/api/agency/users`, {
      data: { username: SUB_A, email: `${SUB_A}@example.test` },
      headers: { Authorization: `Bearer ${agencyToken}` },
    });
    expect(first.status()).toBe(201);
    const firstBody = await first.json();
    subATempPassword = firstBody.generatedPassword as string;
    subAId = firstBody.user.id as string;
    expect(firstBody.user.mustChangePassword).toBe(true);
    // D-06: the temp password rides ONCE; the agency relays it out-of-band.
    expect(subATempPassword).toBeTruthy();

    const second = await request.post(`${SERVER_URL}/api/agency/users`, {
      data: { username: SUB_B, email: `${SUB_B}@example.test` },
      headers: { Authorization: `Bearer ${agencyToken}` },
    });
    expect(second.status()).toBe(201);

    const third = await request.post(`${SERVER_URL}/api/agency/users`, {
      data: { username: `sub_e2e_${testRunId}_c`, email: `sub_e2e_${testRunId}_c@example.test` },
      headers: { Authorization: `Bearer ${agencyToken}` },
    });
    expect(third.status()).toBe(409);
    expect((await third.json()).quota).toBe("users");
  });

  test("sub-user onboards (mustChangePassword → rotation) and resolves Utente Cloud menus (CLOUD-01)", async ({ request }) => {
    const login = await request.post(`${SERVER_URL}/api/auth/login`, {
      data: { username: SUB_A, password: subATempPassword },
    });
    expect(login.ok()).toBeTruthy();
    const body = await login.json();
    expect(body.user.mustChangePassword).toBe(true);

    const setPw = await request.post(`${SERVER_URL}/api/auth/set-initial-password`, {
      data: { newPassword: ROTATED_PASSWORD },
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(setPw.ok()).toBeTruthy();

    const menus = await request.get(`${SERVER_URL}/api/roles/me/menu-sections`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(menus.ok()).toBeTruthy();
    const sections = (await menus.json()) as { menuSections: string[] };
    for (const expected of ["dashboard", "chat", "knowledgeBase", "documents", "widget"]) {
      expect(sections.menuSections).toContain(expected);
    }
    expect(sections.menuSections).not.toContain("eventLog");
    expect(sections.menuSections).not.toContain("marketplace");

    // Lattice pin: a forged agency:users:manage grant → 403 (D-03/D-08).
    const forged = await request.put(`${SERVER_URL}/api/agency/users/${subAId}/permissions`, {
      data: { permissions: ["agency:users:manage"] },
      headers: { Authorization: `Bearer ${agencyToken}` },
    });
    expect(forged.status()).toBe(403);
  });

  test("disable → fail-closed login; re-enable restores (D-05)", async ({ request }) => {
    const disable = await request.post(`${SERVER_URL}/api/agency/users/${subAId}/disable`, {
      headers: { Authorization: `Bearer ${agencyToken}` },
    });
    expect(disable.ok()).toBeTruthy();

    const lockedLogin = await request.post(`${SERVER_URL}/api/auth/login`, {
      data: { username: SUB_A, password: ROTATED_PASSWORD },
    });
    expect(lockedLogin.status()).toBe(401);
    expect((await lockedLogin.json()).error).toContain("disabled");

    const enable = await request.post(`${SERVER_URL}/api/agency/users/${subAId}/enable`, {
      headers: { Authorization: `Bearer ${agencyToken}` },
    });
    expect(enable.ok()).toBeTruthy();

    const restored = await request.post(`${SERVER_URL}/api/auth/login`, {
      data: { username: SUB_A, password: ROTATED_PASSWORD },
    });
    expect(restored.ok()).toBeTruthy();
  });
});