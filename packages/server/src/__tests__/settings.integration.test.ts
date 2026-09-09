// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Settings integration tests — runs against a real PostgreSQL database.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";

let app: ReturnType<typeof import("../index").createApp>;
let prisma: import("@prisma/client").PrismaClient;
let env: import("../config/env").Env;

let adminUserId: string;
let regularUserId: string;
const adminPassword = "adminpassword123";
const regularPassword = "userpassword123";

beforeAll(async () => {
  const { createApp } = await import("../index");
  app = createApp();

  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;

  const { getEnv } = await import("../config/env");
  env = getEnv();

  await prisma.$connect();

  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const userRole = await prisma.role.findUnique({ where: { name: "user" } });

  const salt = await bcrypt.genSalt(12);

  const admin = await prisma.user.create({
    data: {
      username: "settings_admin",
      email: "settings_admin@test.com",
      passwordHash: await bcrypt.hash(adminPassword, salt),
      salt,
    },
  });
  adminUserId = admin.id;

  if (adminRole) {
    await prisma.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id },
    });
  }

  const regular = await prisma.user.create({
    data: {
      username: "settings_user",
      email: "settings_user@test.com",
      passwordHash: await bcrypt.hash(regularPassword, salt),
      salt,
    },
  });
  regularUserId = regular.id;

  if (userRole) {
    await prisma.userRole.create({
      data: { userId: regular.id, roleId: userRole.id },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

function generateToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: "1h" });
}

// ─── GET /api/system/settings ───────────────────────────────────────

describe("GET /api/system/settings", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/system/settings");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    const token = generateToken(regularUserId);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns settings array for admin user", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("key");
    expect(res.body[0]).toHaveProperty("value");
    expect(res.body[0]).toHaveProperty("readOnly");
  });
});

// ─── PUT /api/system/settings ───────────────────────────────────────

describe("PUT /api/system/settings", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).put("/api/system/settings").send({});
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid body", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: "not-an-array" });

    expect(res.status).toBe(400);
  });

  it("updates settings and returns updated/rejected lists", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "LLM_TEMPERATURE", value: "0.9" }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("updated");
    expect(res.body).toHaveProperty("rejected");
    expect(res.body.updated.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects readOnly settings in the rejected list", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [
          { key: "JWT_SECRET", value: "should-not-change" },
          { key: "LLM_MODEL", value: "new-model" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.rejected.length).toBeGreaterThanOrEqual(1);
    // JWT_SECRET should be rejected because it's ALWAYS_READONLY
    expect(res.body.rejected).toContain("JWT_SECRET");
  });
});

// ─── (Phase 70 SC-4 flip probe removed — Plan 05 replaces it in-place with
// the Phase 183 SC-3 cross-tenant isolation suite below; the flip behavior
// itself is covered by the plan-level "updates settings and returns
// updated/rejected lists" probe above plus the ALLOW_NON_ADMIN_UPLOAD unit
// gates in uploadGate.test.ts.)

// NOTE: do NOT statically `import { getSetting } from "../services/systemConfigService"`
// at module top-level. systemConfigService transitively imports `../utils/prisma`, whose
// singleton constructs its PrismaClient adapter via `getEnv().DATABASE_URL` at first import.
// A static top-level import runs at test-file LOAD time — BEFORE `jest.setup.integration.ts`'s
// `beforeAll` sets `process.env.DATABASE_URL` to the per-file worker DB — so the singleton (and
// the `getEnv()` cache) locks onto the shell-inherited main DB URL and every subsequent
// `await import("../utils/prisma")` returns that same main-DB singleton. The test then writes
// to the main `simmetricchat` dev DB instead of its worker clone (unique-constraint collisions on
// re-run, and dev-DB pollution). Importing dynamically INSIDE the `it` block (after the worker
// URL is set) defers singleton construction until the worker URL is active. This rule applies
// to ANY integration test: avoid static top-level imports of modules that transitively load the
// Prisma singleton (services/, routes/, agent/, ../index) — use dynamic `await import(...)` in
// `beforeAll`/`it` instead.

// ─── SC-3: cross-tenant isolation on the route (Phase 183, Plan 05) ────────
//
// Two orgs, SAME key, DIFFERENT values via the REAL route + REAL Postgres —
// no bleed either direction, and the global view stays source-free (P2).
// Route-level proof of T-183-02's mitigation (projectProhibitions #1):
// the org target arrives explicitly (accepted admin trust boundary — Phase
// 185 TenantContext binds principal→org), the isolation that matters here is
// value-level: org-a's override never leaks into org-b's or the global view.
//
// Key choice: ALLOW_REGISTRATION is a UI-editable config key (NOT
// ALWAYS_READONLY — the D-11 reject would block tenant writes), and the
// seeded global default is "true". Dynamic-import doctrine honored: the
// getAllSettings read-back imports systemConfigService INSIDE the test
// (after the worker DATABASE_URL is set by jest.setup.integration.ts).
//
// Cleanup restores the global-only pre-test state: deleteMany the two tenant
// rows (non-unique filter — stays legal post-M5 composite swap). The orgs
// themselves are the migration-seeded Default org and a purpose-built second
// org; the second org is created+deleted inside the suite.

describe("GET/PUT /api/system/settings cross-tenant isolation (SC-3, real PG)", () => {
  const createdOrgId: string[] = [];
  let orgAId = "";
  let orgBId = "";

  beforeAll(async () => {
    // Create BOTH probe orgs in the worker DB (the template DB carries only
    // the migration-seeded Default org; the "Org B (E2E)" row exists only in
    // the main dev DB, seeded by e2e/globalSetup). Prisma's cuid() ids fail
    // the shared z.string().uuid() validation, so the orgs are created with
    // explicit v4 uuid ids (crypto.randomUUID via the create's explicit id
    // override) — a hardcoded 00000000-...-bb-style non-v4 uuid would be
    // REJECTED by the schema at the PUT route (zod v4 uuid checks variant
    // bits; only all-zero/all-f pass).
    const { randomUUID } = await import("crypto");
    const { default: prismaClient } = await import("../utils/prisma");
    const orgA = await prismaClient.organization.create({
      data: {
        id: randomUUID(),
        name: "settings_xt_isolation_a",
        slug: `settings-xt-a-${Date.now()}`,
      },
    });
    orgAId = orgA.id;
    createdOrgId.push(orgAId);

    const orgB = await prismaClient.organization.create({
      data: {
        id: randomUUID(),
        name: "settings_xt_isolation_b",
        slug: `settings-xt-b-${Date.now()}`,
      },
    });
    orgBId = orgB.id;
    createdOrgId.push(orgBId);
  });

  afterAll(async () => {
    // Restore the global-only pre-test state: drop the tenant rows FIRST
    // (systemConfig.organizationId FK is onDelete: Restrict), then the orgs.
    // Fix Round 1 (WR-03): DISABLE_TELEMETRY joined the probe keys (the
    // test's finally-block already drops it — swept here too for safety).
    try {
      if (orgAId) {
        await prisma.systemConfig.deleteMany({
          where: {
            key: { in: ["ALLOW_REGISTRATION", "DISABLE_TELEMETRY"] },
            organizationId: { in: [orgAId, orgBId] },
          },
        });
      }
      for (const id of createdOrgId) {
        await prisma.organization.delete({ where: { id } }).catch(() => {});
      }
    } catch (err) {
      console.error("[settings.integration] cross-tenant cleanup failed:", (err as Error).message);
    }
  });

  it("two orgs, same key, different values — no bleed via the real route + real DB", async () => {
    const token = generateToken(adminUserId);

    // (1) org-a override → "false"; (2) org-b override → "false" (same key,
    // both overridden — the tenant-wins arm).
    const putA = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "ALLOW_REGISTRATION", value: "false", organizationId: orgAId }] });
    expect(putA.status).toBe(200);
    expect(putA.body.updated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "ALLOW_REGISTRATION", value: "false" }),
      ]),
    );

    const putB = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "ALLOW_REGISTRATION", value: "false", organizationId: orgBId }] });
    expect(putB.status).toBe(200);
    expect(putB.body.updated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "ALLOW_REGISTRATION", value: "false" }),
      ]),
    );

    // (3) Dynamic-import read-back (doctrine): the resolved views must name
    // their tiers and disagree per org while the global view keeps the
    // pre-existing seeded value WITHOUT a source field.
    //
    // Fix Round 1 (WR-03): the org-B override value is deliberately the
    // STRING "false" (≠ the seeded global "true") so the global assertion
    // below pins the VALUE, not a coincidence — pre-fix, org-B wrote "true"
    // which happened to equal the seeded global default, so the no-bleed
    // assertion passed even if a tenant row polluted the global dbMap.
    // Note: org-A keeps its "false" override (written above); the
    // fallback-arm probes in the next test cover the no-override direction.
    const { getAllSettings } = await import("../services/systemConfigService");
    const viewA = await getAllSettings(orgAId);
    const viewB = await getAllSettings(orgBId);
    const globalView = await getAllSettings();

    const entryA = viewA.find((s) => s.key === "ALLOW_REGISTRATION");
    const entryB = viewB.find((s) => s.key === "ALLOW_REGISTRATION");
    const entryGlobal = globalView.find((s) => s.key === "ALLOW_REGISTRATION");

    expect(entryA).toMatchObject({ value: "false", source: "tenant" });
    expect(entryB).toMatchObject({ value: "false", source: "tenant" });
    // SC-3 global-view no-bleed, now by VALUE CONTRAST (WR-03 strengthening):
    // org-B's override is "false" — the global view must still show the
    // seeded "true". A tenant row in the global map would flip this to
    // "false" (Map last-wins) and fail the probe.
    expect(entryGlobal?.value).toBe("true");
    expect(entryGlobal?.value).not.toBe("false"); // ≠ either override — no tenant row leaked
    expect(entryGlobal).not.toHaveProperty("source"); // P2: global view source-free

    // (4) Route-level no-bleed: GET ?organizationId=orgA returns org-a's
    // value; org-b's value and the global row never shadow it.
    const getA = await request(app)
      .get(`/api/system/settings?organizationId=${orgAId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getA.status).toBe(200);
    const routeA = getA.body.find((s: { key: string }) => s.key === "ALLOW_REGISTRATION");
    expect(routeA).toMatchObject({ value: "false", source: "tenant" });

    const getB = await request(app)
      .get(`/api/system/settings?organizationId=${orgBId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getB.status).toBe(200);
    const routeB = getB.body.find((s: { key: string }) => s.key === "ALLOW_REGISTRATION");
    expect(routeB).toMatchObject({ value: "false", source: "tenant" });
  });

  // WR-03 (Fix Round 1, 183-REVIEW): the FALLBACK arm — org-A has NO
  // override for a key that org-B overrode. This is the exact scenario
  // CR-01 exploits (pre-fix, getAllSettings' unfiltered findMany fed
  // org-B's tenant row into the shared dbMap and org-A's view fell back to
  // org-B's value, mislabeled source:"global"). Both service- and route-
  // level probes pin: org-A resolves the GLOBAL tier, org-B's value never
  // appears, and the global view stays tenant-free.
  it("WR-03 fallback arm: org-A (no override) views a key only org-B overrode → global value, never org-B's", async () => {
    const token = generateToken(adminUserId);
    // org-B writes a DISTINGUISHABLE override value (≠ global default "true"
    // and ≠ org-A's "false" from the previous test).
    const putB2 = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "DISABLE_TELEMETRY", value: "org-b-marker", organizationId: orgBId }] });
    expect(putB2.status).toBe(200);
    expect(putB2.body.updated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "DISABLE_TELEMETRY", value: "org-b-marker" }),
      ]),
    );

    try {
      // (1) Service level: getAllSettings(orgA) must NOT carry org-B's value.
      const { getAllSettings, getSetting } = await import("../services/systemConfigService");
      const viewA = await getAllSettings(orgAId);
      const entryA = viewA.find((s) => s.key === "DISABLE_TELEMETRY");
      expect(entryA).toBeDefined();
      expect(entryA?.value).not.toBe("org-b-marker"); // CR-01 bleed pinned
      // The cascade resolves the seeded global row ("true") for org-A.
      expect(entryA).toMatchObject({ value: "true", source: "global" });
      // No entry in org-A's view carries org-B's marker anywhere.
      expect(viewA.some((s) => s.value === "org-b-marker")).toBe(false);

      // getSetting single-key cascade agrees with the listing view.
      const singleA = await getSetting("DISABLE_TELEMETRY", orgAId);
      expect(singleA.value).toBe("true");
      expect(singleA.source).toBe("global");

      // org-B itself still sees its override.
      const singleB = await getSetting("DISABLE_TELEMETRY", orgBId);
      expect(singleB).toMatchObject({ value: "org-b-marker", source: "tenant" });

      // (2) Route level: GET ?organizationId=orgA — the same no-bleed pin
      // through the real HTTP surface.
      const getA = await request(app)
        .get(`/api/system/settings?organizationId=${orgAId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(getA.status).toBe(200);
      const routeA = getA.body.find((s: { key: string }) => s.key === "DISABLE_TELEMETRY");
      expect(routeA).toBeDefined();
      expect(routeA.value).not.toBe("org-b-marker");
      expect(routeA).toMatchObject({ value: "true", source: "global" });
    } finally {
      // Restore pre-test state for this key (deleteMany is non-unique —
      // legal post-M5): drop org-B's tenant row.
      await prisma.systemConfig
        .deleteMany({ where: { key: "DISABLE_TELEMETRY", organizationId: orgBId } })
        .catch(() => {});
    }
  });

  // WR-02 (Fix Round 1, 183-REVIEW): a valid-uuid org id that does NOT
  // exist must 400 "Organization not found" on BOTH org surfaces — not a
  // raw P2003 500 with Prisma driver internals (PUT) and not a global-
  // equivalent view mislabeled as org-resolved (GET).
  it("WR-02: unknown-org PUT → 400 Organization not found (not a raw P2003 500); unknown-org GET → 400", async () => {
    const token = generateToken(adminUserId);
    const unknownOrgId = "99999999-9999-4999-8999-999999999999";

    // Sanity: the id really is absent from the worker DB.
    const missing = await prisma.organization.findFirst({ where: { id: unknownOrgId } });
    expect(missing).toBeNull();

    // PUT — pre-fix this died as a 500 with the raw FK error.
    const putUnknown = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [{ key: "ALLOW_REGISTRATION", value: "false", organizationId: unknownOrgId }],
      });
    expect(putUnknown.status).toBe(400);
    expect(putUnknown.body.error).toBe("Organization not found");
    // No row was written against the unresolvable org.
    const wroteNothing = await prisma.systemConfig.findFirst({
      where: { key: "ALLOW_REGISTRATION", organizationId: unknownOrgId },
    });
    expect(wroteNothing).toBeNull();

    // GET — no global-equivalent view mislabeled as org-resolved.
    const getUnknown = await request(app)
      .get(`/api/system/settings?organizationId=${unknownOrgId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getUnknown.status).toBe(400);
    expect(getUnknown.body.error).toBe("Organization not found");
  });

  it("legacy global readOnly-reject probe stays green post-swap (D-09/D-10 zero-migration proof)", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [
          { key: "JWT_SECRET", value: "should-not-change" },
          { key: "LLM_MODEL", value: "new-model" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.rejected.length).toBeGreaterThanOrEqual(1);
    // JWT_SECRET should be rejected because it's ALWAYS_READONLY
    expect(res.body.rejected).toContain("JWT_SECRET");
  });
});
