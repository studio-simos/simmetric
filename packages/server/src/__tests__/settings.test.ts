// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken, adminUser, regularUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";

const app = createApp();

describe("GET /api/system/settings", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/system/settings");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(regularUser);
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns settings array for admin user", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([
      { key: "LLM_PROVIDER", value: "ollama" },
      { key: "LLM_MODEL", value: "gemma4:latest" },
    ]);

    const token = generateTestToken(adminUser.id);
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

  it("returns 500 when Prisma query fails", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockRejectedValue(new Error("DB connection lost"));

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});

describe("PUT /api/system/settings", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).put("/api/system/settings").send({});
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid body", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: "not-an-array" });

    expect(res.status).toBe(400);
  });

  it("updates settings and returns updated/rejected lists", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([]);
    // 183-01: the write routes through upsertSystemConfigRow (find-first →
    // id-anchored update). Mock the update-path: findFirst returns the
    // existing global row, update resolves. (The old keyed-upsert wiring is
    // gone; the behavioral assertions below are unchanged.)
    (prisma.systemConfig.findFirst as jest.Mock).mockResolvedValue({
      id: "row-llm",
      key: "LLM_PROVIDER",
      value: "ollama",
    });
    (prisma.systemConfig.update as jest.Mock).mockResolvedValue({});

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "LLM_PROVIDER", value: "openai" }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("updated");
    expect(res.body).toHaveProperty("rejected");
  });
});

// ─── Phase 183 (SAAS-02, Plan 05): org-scoped route surface ─────────────────
//
// GET ?organizationId=<uuid> → the org-resolved view with per-entry `source`
// (D-05); invalid uuid → 400 { error, details } (T-183-09, SP-4); no param →
// the global view WITHOUT source fields (P2 pin at the route level). PUT
// configs[{key, value, organizationId}] flows to updateSettings — the tenant
// row's find-first is observable on the prisma mock (D-04); an org-scoped
// ALWAYS_READONLY write lands in the rejected list, never written (D-11).
// The requireAdmin matrix holds UNCHANGED — no new gate (D-04).

// Valid v4-variant uuid for the mock org target (passes z.string().uuid()).
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
// WR-02 (Fix Round 1): a uuid-shaped id that never resolves to an org —
// passes the shared schema's uuid gate, fails the existence check.
const UNKNOWN_ORG = "99999999-9999-4999-8999-999999999999";

describe("GET /api/system/settings?organizationId (org-scoped view)", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get(`/api/system/settings?organizationId=${ORG_A}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user (no new gate — same requireAdmin, D-04)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(regularUser);
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .get(`/api/system/settings?organizationId=${ORG_A}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 200 with source-bearing entries for a valid uuid", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    // WR-02 (Fix Round 1): the org id must RESOLVE — organization.findFirst
    // returns the live org (unknown ids 400 below).
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: ORG_A,
      name: "Org A",
      deletedAt: null,
    });
    // getAllSettings() global sweep returns no rows; the org overlay finds a
    // tenant row for LLM_PROVIDER (the service wires findMany by where-clause).
    (prisma.systemConfig.findMany as jest.Mock).mockImplementation(
      async (args?: { where?: { organizationId?: string | null } }) => {
        if (args?.where && "organizationId" in args.where && args.where.organizationId === ORG_A) {
          return [{ key: "LLM_PROVIDER", value: "org-a-value", organizationId: ORG_A }];
        }
        return [];
      },
    );

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get(`/api/system/settings?organizationId=${ORG_A}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const llmEntry = res.body.find((s: { key: string }) => s.key === "LLM_PROVIDER");
    expect(llmEntry).toBeDefined();
    expect(llmEntry.value).toBe("org-a-value");
    // D-05: org-scoped entries name their tier.
    expect(llmEntry.source).toBe("tenant");
  });

  it("returns 400 { error, details } for an invalid uuid (T-183-09)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get("/api/system/settings?organizationId=not-a-uuid")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.details).toBeDefined();
  });

  // WR-02 (Fix Round 1): a valid-uuid org that does NOT exist → 400
  // "Organization not found" — a global-equivalent view must not be returned
  // mislabeled as an org view (and no org-scoped read of an unresolvable
  // target is meaningful).
  it("WR-02: valid-uuid UNKNOWN org → 400 Organization not found (GET)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    // Unknown id: the existence lookup misses (soft-deleted rows miss too).
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.findMany as jest.Mock).mockClear();

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get(`/api/system/settings?organizationId=${UNKNOWN_ORG}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Organization not found");
    // The org-scoped view was never computed — no systemConfig query ran.
    expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
  });

  it("WR-02: existence lookup filters live rows only — soft-deleted org → 400 (GET)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue(null);

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get(`/api/system/settings?organizationId=${UNKNOWN_ORG}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    // The lookup itself is soft-delete-aware (deletedAt: null in the where).
    expect(prisma.organization.findFirst).toHaveBeenCalledWith({
      where: { id: UNKNOWN_ORG, deletedAt: null },
    });
  });

  // WR-03 (Fix Round 1) / CR-01 pin at the route level: org-A views a key
  // that ONLY org-B overrode. Pre-fix, getAllSettings' unfiltered findMany
  // put org-B's tenant row into the shared dbMap and org-A's view fell back
  // to org-B's value mislabeled source:"global". Post-fix the base layer is
  // global rows only — org-A must see the GLOBAL tier's value (here: env,
  // since no global row exists for the key), never org-B's value.
  it("WR-03/CR-01: org-A views a key only org-B overrode → global tier resolves, NOT org-B's value", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: ORG_A,
      name: "Org A",
      deletedAt: null,
    });
    process.env.LLM_MODEL = "env-tier-value";
    // The base sweep (global rows only — post-fix where-clause) holds NO row
    // for LLM_MODEL; the ONLY tenant row in the DB belongs to org-B.
    (prisma.systemConfig.findMany as jest.Mock).mockImplementation(
      async (args?: { where?: { organizationId?: string | null } }) => {
        if (args?.where && "organizationId" in args.where && args.where.organizationId === ORG_B) {
          return [{ key: "LLM_MODEL", value: "sk-secret-org-b", organizationId: ORG_B }];
        }
        return [];
      },
    );

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get(`/api/system/settings?organizationId=${ORG_A}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const llmModelEntry = res.body.find((s: { key: string }) => s.key === "LLM_MODEL");
    expect(llmModelEntry).toBeDefined();
    // NOT org-B's secret — the ENV tier resolves (no global row, no org-A row).
    expect(llmModelEntry.value).toBe("env-tier-value");
    expect(llmModelEntry.source).toBe("env");
    delete process.env.LLM_MODEL;
  });

  it("no-param GET returns entries WITHOUT source — global view byte-identical (D-05/P2 route pin)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([
      { key: "LLM_PROVIDER", value: "global-value" },
    ]);

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const entry of res.body) {
      expect(entry).not.toHaveProperty("source");
    }
  });
});

describe("PUT /api/system/settings with org-scoped configs[] items", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app)
      .put("/api/system/settings")
      .send({ configs: [{ key: "LLM_PROVIDER", value: "x", organizationId: ORG_A }] });
    expect(res.status).toBe(401);
  });

  it("org item flows to updateSettings — tenant-row find-first observable on the mock (D-04)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    // WR-02 (Fix Round 1): the org id must resolve before the write path.
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: ORG_A,
      name: "Org A",
      deletedAt: null,
    });
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([]);
    // No existing tenant row → helper goes to the create arm; capture the
    // create's data to assert the org landed on the row.
    (prisma.systemConfig.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.create as jest.Mock).mockResolvedValue({
      id: "row-new-org",
      key: "LLM_PROVIDER",
      value: "org-write-value",
      organizationId: ORG_A,
    });

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [{ key: "LLM_PROVIDER", value: "org-write-value", organizationId: ORG_A }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("updated");
    expect(res.body).toHaveProperty("rejected");
    expect(res.body.rejected).not.toContain("LLM_PROVIDER");
    // The helper's find-first ran with the ORG filter (the tenant-row probe).
    expect(prisma.systemConfig.findFirst).toHaveBeenCalledWith({
      where: { key: "LLM_PROVIDER", organizationId: ORG_A },
    });
    // The create landed with the org attached.
    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "LLM_PROVIDER", value: "org-write-value", organizationId: ORG_A },
    });
  });

  it("org-scoped ALWAYS_READONLY write → rejected list, never written (D-11/T-183-01)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    // WR-02 (Fix Round 1): the org resolves (validation passes) — the reject
    // happens later, at the service-side D-11 gate.
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: ORG_A,
      name: "Org A",
      deletedAt: null,
    });
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findFirst as jest.Mock).mockClear();
    (prisma.systemConfig.create as jest.Mock).mockClear();
    (prisma.systemConfig.update as jest.Mock).mockClear();

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [
          { key: "JWT_SECRET", value: "tenant-secret-override", organizationId: ORG_A },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toContain("JWT_SECRET");
    expect(res.body.updated).toHaveLength(0);
    // Nothing reached the write path (no row of ANY tier touched).
    expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
    expect(prisma.systemConfig.update).not.toHaveBeenCalled();
  });

  it("PUT with an invalid organizationId uuid → 400 (shared schema uuid gate)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [{ key: "LLM_PROVIDER", value: "x", organizationId: "not-a-uuid" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  // WR-02 (Fix Round 1): a valid-uuid UNKNOWN org used to escape validation
  // and die as a raw P2003 FK error inside the helper's create → 500 with
  // Prisma driver internals. Now: 400 "Organization not found" BEFORE any
  // write is attempted.
  it("WR-02: valid-uuid UNKNOWN org → 400 Organization not found, no write attempted (PUT)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findFirst as jest.Mock).mockClear();
    (prisma.systemConfig.create as jest.Mock).mockClear();
    (prisma.systemConfig.update as jest.Mock).mockClear();

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [{ key: "LLM_PROVIDER", value: "x", organizationId: UNKNOWN_ORG }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Organization not found");
    // No write path of ANY kind was touched (the P2003 death is unreachable).
    expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
    expect(prisma.systemConfig.update).not.toHaveBeenCalled();
  });

  it("WR-02: mixed global+org batch with an unknown org → 400 before ANY item writes", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.findFirst as jest.Mock).mockClear();
    (prisma.systemConfig.create as jest.Mock).mockClear();

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [
          { key: "LLM_PROVIDER", value: "global-write" }, // global item — still blocked
          { key: "LLM_MODEL", value: "org-write", organizationId: UNKNOWN_ORG },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Organization not found");
    // Neither item reached the write path.
    expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
  });

  it("WR-02: known org PUT still flows through — existence check passes (regression pin)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: ORG_A,
      name: "Org A",
      deletedAt: null,
    });
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.create as jest.Mock).mockResolvedValue({
      id: "row-new-org",
      key: "LLM_PROVIDER",
      value: "org-write-value",
      organizationId: ORG_A,
    });

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [{ key: "LLM_PROVIDER", value: "org-write-value", organizationId: ORG_A }],
      });

    expect(res.status).toBe(200);
    expect(res.body.rejected).not.toContain("LLM_PROVIDER");
    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "LLM_PROVIDER", value: "org-write-value", organizationId: ORG_A },
    });
  });
});
// ─── Phase 184 (SAAS-03, Plan 05): storage config-key probes (D-01) ─────────
//
// The 6 storage keys ride the existing config machinery byte-identically:
// enum-gated (configKeySchema), seeded via CONFIG_DEFAULTS (overwrite:false),
// DB-editable per-org through the 183 cascade — they are NOT ALWAYS_READONLY
// (contrast JWT_SECRET: org-scoped write → rejected). The cascade probes
// follow the 176/183 precedence-probe style (mocked prisma rows).

const STORAGE_KEYS = [
  "STORAGE_PROVIDER",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

describe("Phase 184 storage config keys (D-01)", () => {
  it("GET returns all 6 storage keys with their defaults (seedConfigDefaults overwrite:false shape)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue(
      STORAGE_KEYS.map((key) => ({
        key,
        value: key === "STORAGE_PROVIDER" ? "localfs" : "",
      })),
    );

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const byKey = new Map(res.body.map((s: { key: string; value: string }) => [s.key, s.value]));
    for (const key of STORAGE_KEYS) {
      expect(byKey.has(key)).toBe(true);
    }
    expect(byKey.get("STORAGE_PROVIDER")).toBe("localfs");
    for (const key of STORAGE_KEYS.slice(1)) {
      expect(byKey.get(key)).toBe("");
    }
  });

  it("PUT with an invalid STORAGE VALUE... no — VALUE is a free string per setConfigSchema; an unknown KEY fails the whole bulk request 400 (route-boundary schema)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [
          { key: "STORAGE_PROVIDER", value: "s3" },
          { key: "TOTALLY_UNKNOWN_KEY", value: "x" },
        ],
      });

    // Route-level bulkSetConfigSchema rejects the WHOLE body on an unknown
    // key (z.enum over configKeySchema) — 400 { error, details }, nothing
    // reaches the write path.
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("PUT accepts STORAGE_PROVIDER 's3' — global row write lands (D-01)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.create as jest.Mock).mockResolvedValue({ id: "row-s3" });

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "STORAGE_PROVIDER", value: "s3" }] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "STORAGE_PROVIDER", value: "s3" })]),
    );
    // The accepted item hit the write path (global row — org target null).
    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "STORAGE_PROVIDER", value: "s3", organizationId: null },
    });
  });

  it("org-scoped storage write is ACCEPTED (not ALWAYS_READONLY) — D-01 per-tenant S3 contract", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: ORG_A,
      name: "Org A",
      deletedAt: null,
    });
    (prisma.systemConfig.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.systemConfig.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.systemConfig.create as jest.Mock).mockResolvedValue({
      id: "row-org-s3",
      key: "STORAGE_PROVIDER",
      value: "s3",
      organizationId: ORG_A,
    });

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [{ key: "STORAGE_PROVIDER", value: "s3", organizationId: ORG_A }],
      });

    expect(res.status).toBe(200);
    expect(res.body.rejected).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "STORAGE_PROVIDER" })]),
    );
    expect(res.body.updated).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "STORAGE_PROVIDER", value: "s3" })]),
    );
    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "STORAGE_PROVIDER", value: "s3", organizationId: ORG_A },
    });
  });

  it("cascade: getSetting(STORAGE_PROVIDER, orgId) resolves default → global → tenant (precedence probes)", async () => {
    // Precedence matrix over the real service (183 probe style): the mock
    // prisma findMany resolves rows by organizationId filter.
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    (prisma.systemConfig.findMany as jest.Mock).mockImplementation(
      async (args?: { where?: { organizationId?: string | null } }) => {
        const org = args?.where && "organizationId" in args.where ? args.where.organizationId : undefined;
        if (org === ORG_A) {
          return [{ key: "STORAGE_PROVIDER", value: "s3", organizationId: ORG_A }];
        }
        if (org === null || org === undefined) {
          return [{ key: "STORAGE_PROVIDER", value: "localfs-global" }];
        }
        return [];
      },
    );
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: ORG_A,
      name: "Org A",
      deletedAt: null,
    });

    const token = generateTestToken(adminUser.id);
    // Org A view: tenant row wins → "s3" with source "tenant".
    const resA = await request(app)
      .get(`/api/system/settings?organizationId=${ORG_A}`)
      .set("Authorization", `Bearer ${token}`);
    expect(resA.status).toBe(200);
    const entryA = resA.body.find((s: { key: string }) => s.key === "STORAGE_PROVIDER");
    expect(entryA.value).toBe("s3");
    expect(entryA.source).toBe("tenant");

    // Org B view: no tenant row → global row wins → "localfs-global" with source "global".
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: ORG_B,
      name: "Org B",
      deletedAt: null,
    });
    const resB = await request(app)
      .get(`/api/system/settings?organizationId=${ORG_B}`)
      .set("Authorization", `Bearer ${token}`);
    expect(resB.status).toBe(200);
    const entryB = resB.body.find((s: { key: string }) => s.key === "STORAGE_PROVIDER");
    expect(entryB.value).toBe("localfs-global");
    expect(entryB.source).toBe("global");
  });
});
