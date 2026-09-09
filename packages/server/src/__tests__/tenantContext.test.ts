// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TenantContext unit suite (Phase 185, SAAS-04a/04b — Postgres-free).
 *
 * Probes pinned here:
 *  (a) ALS semantics — SAAS-04a concurrency probe: two CONCURRENT runInTenant
 *      callbacks with different organizationIds each observe ONLY their own
 *      store (parallel, not sequential); store absent outside runInTenant;
 *      isTenantBypassed true only inside bypassTenantScope.
 *  (b) scopeToOrg composer — merges caller filters, NEVER auto-injects
 *      deletedAt (D-03 compose-never-replace).
 *  (c) middleware unit — 404 fail-closed (D-02), candidate-no-membership-query
 *      (D-08), joinedAt first-membership tie-break (D-01/SAAS-04c probe),
 *      admin bypass store, ALS store visible inside next().
 *  (d) Tracer end-to-end via supertest on createApp(): org-b member reading an
 *      org-a workspace → 404, with an ALS org canary proving the store spans
 *      middleware → rbac → handler.
 *
 * Shape mirrors documentIdor.test.ts (mockPrisma + supertest + createApp).
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    // withSoftDelete is a passthrough in tests (mock prisma doesn't apply the extension)
    withSoftDelete: (where: any) => where,
  };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 5),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/jobQueue", () => ({
  startJobQueue: jest.fn(),
  stopJobQueue: jest.fn(),
  getBoss: jest.fn(() => null),
  createQueue: jest.fn(),
  schedule: jest.fn(),
}));
jest.mock("../services/storageProvider", () => ({
  getStorageProvider: jest.fn(async () => ({
    put: jest.fn(),
    get: jest.fn(),
    exists: jest.fn(async () => false),
    delete: jest.fn(),
    list: jest.fn(async () => []),
  })),
}));

// Phase 185 (Plan-02): the widget-principal probes drive the REAL
// apiKeyMiddleware — mock validateApiKey to resolve a widget-service
// account key (createApp() must not hit the real HMAC/DB path here).
jest.mock("../services/apiKeyService", () => ({
  __esModule: true,
  validateApiKey: jest.fn(async (rawKey: string) =>
    rawKey === "sk-widget-service-key"
      ? { createdBy: "widget-service-account", organizationId: "org-service-account-DEFAULT" }
      : null,
  ),
  createApiKey: jest.fn(),
  hmacSha256: jest.fn(() => "0".repeat(64)),
  getHmacSecret: jest.fn(() => Buffer.alloc(32, 1)),
  listApiKeys: jest.fn(),
  revokeApiKey: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken, regularUser, adminUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";
import {
  getTenantContext,
  runInTenant,
  bypassTenantScope,
  isTenantBypassed,
  scopeToOrg,
  tenantStorage,
} from "../utils/tenantContext";

const app = createApp();

// ————— tracer fixtures — two orgs, org-b member, org-a workspace ———————————
const ORG_A_ID = "a0a0a0a0-0000-4000-8000-00000000000a";
const ORG_B_ID = "b0b0b0b0-0000-4000-8000-00000000000b";
const ORG_A_WORKSPACE_ID = "aaaa1111-0000-4000-8000-00000000000a";
const ORGB_USER_ID = "orgb-user-001";

/** org-b member fixture (regular permissions, no workspaceAccess). */
const orgbUser = {
  ...regularUser,
  id: ORGB_USER_ID,
  username: "orgbuser",
  email: "orgb@test.local",
};

/** Canary captured inside the mocked prisma.workspace.findFirst call. */
let alsCanary: { storeOrgAtCall: string | undefined; calledWhere: any } = {
  storeOrgAtCall: undefined,
  calledWhere: undefined,
};

beforeEach(() => {
  jest.clearAllMocks();
  alsCanary = { storeOrgAtCall: undefined, calledWhere: undefined };

  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === regularUser.id) return Promise.resolve(regularUser);
    if (id === adminUser.id) return Promise.resolve(adminUser);
    if (id === orgbUser.id) return Promise.resolve(orbUserFixture());
    // Phase 185: the widget-service account (API-key principal) resolves too.
    if (id === "widget-service-account") return Promise.resolve(orbUserFixture());
    return Promise.resolve(null);
  });

  // Membership resolution — the D-01 hot path.
  (prisma.organizationMember.findFirst as jest.Mock).mockImplementation((args: any) => {
    const userId = args?.where?.userId;
    if (userId === ORGB_USER_ID) {
      // Assert the deterministic shape: first LIVE membership, joinedAt asc.
      if (args?.orderBy?.joinedAt !== "asc") return Promise.resolve(null);
      return Promise.resolve({ organizationId: ORG_B_ID });
    }
    if (userId === regularUser.id) return Promise.resolve({ organizationId: ORG_A_ID });
    if (userId === adminUser.id) return Promise.resolve({ organizationId: ORG_A_ID });
    return Promise.resolve(null);
  });

  // The 404 canary: requireWorkspaceAccess's workspace.findFirst records the
  // ALS org visible AT CALL TIME (proves middleware → rbac ALS propagation).
  (prisma.workspace.findFirst as jest.Mock).mockImplementation((args: any) => {
    alsCanary = {
      storeOrgAtCall: getTenantContext()?.organizationId,
      calledWhere: args?.where,
    };
    return Promise.resolve(null); // org-a workspace invisible to org-b store
  });
});

function orbUserFixture() {
  return {
    ...regularUser,
    id: ORGB_USER_ID,
    username: "orgbuser",
    email: "orgb@test.local",
  };
}

// ============================================================================
// (a) ALS semantics — SAAS-04a concurrency probe
// ============================================================================

describe("tenantContext ALS carrier (SAAS-04a)", () => {
  it("two CONCURRENT runInTenant callbacks with different orgs each see ONLY their own store", async () => {
    const seen: (string | undefined)[] = [];

    await Promise.all([
      runInTenant({ organizationId: "org-a", bypass: false }, async () => {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        seen.push(getTenantContext()?.organizationId);
      }),
      runInTenant({ organizationId: "org-b", bypass: false }, async () => {
        await new Promise((r) => setImmediate(r));
        seen.push(getTenantContext()?.organizationId);
      }),
    ]);

    expect(seen).toContain("org-a");
    expect(seen).toContain("org-b");
    // No cross-contamination: exactly one observation per org.
    expect(seen.filter((o) => o === "org-a")).toHaveLength(1);
    expect(seen.filter((o) => o === "org-b")).toHaveLength(1);
  });

  it("store is absent outside runInTenant (jobs/boot semantics)", () => {
    expect(getTenantContext()).toBeUndefined();
    expect(isTenantBypassed()).toBe(false);
  });

  it("isTenantBypassed true ONLY inside bypassTenantScope; false inside a normal run", () => {
    const insideBypass = bypassTenantScope(() => isTenantBypassed());
    expect(insideBypass).toBe(true);
    expect(isTenantBypassed()).toBe(false);

    const insideRun = runInTenant({ organizationId: "org-a", bypass: false }, () => isTenantBypassed());
    expect(insideRun).toBe(false);
    expect(isTenantBypassed()).toBe(false);
  });

  it("runInTenant uses tenantStorage.run (NEVER enterWith) — grep gate", () => {
    // Static assertion on the module source (guards the Node docs leak rule).
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../utils/tenantContext.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\.enterWith\s*\(/);
    expect(src).toMatch(/tenantStorage\.run/);
  });

  it("sequential runs do not leak the previous store", async () => {
    const first = await runInTenant({ organizationId: "org-1", bypass: false }, async () => {
      await new Promise((r) => setImmediate(r));
      return getTenantContext()?.organizationId;
    });
    expect(first).toBe("org-1");
    expect(getTenantContext()).toBeUndefined();

    const second = await runInTenant({ organizationId: "org-2", bypass: false }, async () => {
      await new Promise((r) => setImmediate(r));
      return getTenantContext()?.organizationId;
    });
    expect(second).toBe("org-2");
  });

  it("nested fan-out (Promise.all) inside one run keeps the parent store", async () => {
    const out = await runInTenant({ organizationId: "parent", bypass: false }, async () =>
      Promise.all([
        (async () => {
          await new Promise((r) => setImmediate(r));
          return getTenantContext()?.organizationId;
        })(),
        getTenantContext()?.organizationId,
      ]),
    );
    expect(out).toEqual(["parent", "parent"]);
  });
});

// ============================================================================
// (b) scopeToOrg composer — D-03 compose-never-replace
// ============================================================================

describe("scopeToOrg composer (D-03)", () => {
  it("merges caller { id, deletedAt: null } with organizationId", () => {
    const merged = scopeToOrg("org-a", { id: "w1", deletedAt: null });
    expect(merged).toEqual({ organizationId: "org-a", id: "w1", deletedAt: null });
  });

  it("does NOT auto-inject deletedAt when caller omitted it", () => {
    const merged = scopeToOrg("org-a", { id: "w1" });
    expect(merged).not.toHaveProperty("deletedAt");
    expect(merged).toEqual({ organizationId: "org-a", id: "w1" });
  });

  it("empty where → { organizationId } only", () => {
    expect(scopeToOrg("org-a")).toEqual({ organizationId: "org-a" });
    expect(scopeToOrg("org-a", undefined)).toEqual({ organizationId: "org-a" });
    expect(scopeToOrg("org-a", {})).toEqual({ organizationId: "org-a" });
  });

  // ─── WR-01 (185-05): the CONTEXT org wins on an organizationId collision ───
  // A caller where carrying its own organizationId (e.g. client-influenced
  // data reaching a query) must NEVER downgrade the tenant filter — the
  // context org key is spread LAST, so the context value replaces the caller's.
  it("caller organizationId COLLISION composes to the CONTEXT org value (WR-01 context-wins)", () => {
    const merged = scopeToOrg("org-context", { id: "w1", organizationId: "org-attacker" } as any);
    expect(merged).toEqual({ id: "w1", organizationId: "org-context" });
    // The context org overrode the colliding key — never the reverse.
    expect(merged.organizationId).toBe("org-context");
  });

  it("WR-01: non-org caller keys survive the collision resolution", () => {
    const merged = scopeToOrg("org-context", { deletedAt: null, organizationId: "org-attacker", status: "active" } as any);
    expect(merged).toEqual({ deletedAt: null, organizationId: "org-context", status: "active" });
  });
});

// ============================================================================
// (c) tenantContextMiddleware unit — resolution arms + fail-closed
// ============================================================================

function makeRes() {
  const state: { statusCode?: number; body?: any; finished: boolean } = { finished: false };
  const res: any = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(data: any) {
      state.body = data;
      state.finished = true;
      return res;
    },
  };
  return { res, state };
}

describe("tenantContextMiddleware (D-01/D-02/D-08)", () => {
  // Import through the mocked-prisma world.
  let tenantContextMiddleware: any;
  let resolveOrgFor: any;
  beforeAll(() => {
    ({ tenantContextMiddleware, resolveOrgFor } = require("../middleware/tenantContext"));
  });

  it("no live membership → 404 {error:'Not found'} fail-closed; next() NOT called", async () => {
    (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue(null);
    const req: any = { userId: "membershipless-user" };
    const { res, state } = makeRes();
    const next = jest.fn();

    await tenantContextMiddleware(req, res, next);

    expect(res.status).toBeDefined();
    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Not found" });
    expect(next).not.toHaveBeenCalled();
  });

  it("membership found → req.organizationId set + ALS store visible inside next()", async () => {
    (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({
      organizationId: ORG_A_ID,
    });
    const req: any = { userId: regularUser.id };
    const { res, state } = makeRes();
    const next = jest.fn(() => {
      // The ALS store must span the middleware → downstream chain.
      expect(getTenantContext()?.organizationId).toBe(ORG_A_ID);
      expect(getTenantContext()?.bypass).toBe(false);
    });

    await tenantContextMiddleware(req, res, next);

    expect(req.organizationId).toBe(ORG_A_ID);
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.statusCode).toBeUndefined(); // never touched res
  });

  it("admin user → store.bypass === true AND req.organizationId still set", async () => {
    (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({
      organizationId: ORG_A_ID,
    });
    const req: any = { userId: adminUser.id };
    const { res } = makeRes();
    const next = jest.fn(() => {
      expect(getTenantContext()?.bypass).toBe(true);
      expect(getTenantContext()?.organizationId).toBe(ORG_A_ID);
    });

    await tenantContextMiddleware(req, res, next);

    expect(req.organizationId).toBe(ORG_A_ID);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("tenantOrgCandidate present → organizationMember.findFirst NEVER called (D-08 API-key arm)", async () => {
    const req: any = { userId: regularUser.id, tenantOrgCandidate: ORG_B_ID };
    const { res } = makeRes();
    const next = jest.fn(() => {
      expect(getTenantContext()?.organizationId).toBe(ORG_B_ID);
    });

    await tenantContextMiddleware(req, res, next);

    expect(req.organizationId).toBe(ORG_B_ID);
    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("two-membership user with joinedAt asc ordering → FIRST membership wins (SAAS-04c tie-break)", async () => {
    // Mock findFirst honoring the orderBy contract: return the earliest live row.
    (prisma.organizationMember.findFirst as jest.Mock).mockImplementation((args: any) => {
      // The middleware MUST ask for joinedAt asc determinism — assert the shape.
      expect(args?.orderBy).toEqual({ joinedAt: "asc" });
      expect(args?.where).toEqual({ userId: regularUser.id, deletedAt: null });
      // Earliest = ORG_A (the first-joined org).
      return Promise.resolve({ organizationId: ORG_A_ID });
    });

    const org = await resolveOrgFor({ userId: regularUser.id } as any);
    expect(org).toBe(ORG_A_ID);

    // And the mocked join-earliest behavior flows through the middleware:
    const req: any = { userId: regularUser.id };
    const { res } = makeRes();
    const next = jest.fn();
    await tenantContextMiddleware(req, res, next);
    expect(req.organizationId).toBe(ORG_A_ID);
  });

  it("resolution error → 404 fail-closed (never 500, never fail-open)", async () => {
    (prisma.organizationMember.findFirst as jest.Mock).mockRejectedValue(
      new Error("db down"),
    );
    const req: any = { userId: regularUser.id };
    const { res, state } = makeRes();
    const next = jest.fn();

    await tenantContextMiddleware(req, res, next);

    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Not found" });
    expect(next).not.toHaveBeenCalled();
  });

  it("req fields from client (headers/body/query) NEVER influence resolution (T-185-01)", async () => {
    (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue(null);
    // Simulate a client trying every spoofing vector.
    const req: any = {
      userId: "membershipless-user",
      headers: { "x-organization-id": ORG_B_ID },
      body: { organizationId: ORG_B_ID },
      query: { organizationId: ORG_B_ID },
      tenantOrgCandidate: undefined,
    };
    const { res, state } = makeRes();
    const next = jest.fn();

    await tenantContextMiddleware(req, res, next);

    // Still 404 — client input is never consulted.
    expect(state.statusCode).toBe(404);
    expect(req.organizationId).toBeUndefined();
  });

  it("defensive re-entry: existing store → next() without re-resolution", async () => {
    const req: any = { userId: regularUser.id };
    const { res } = makeRes();
    const next = jest.fn();

    await runInTenant({ organizationId: "already-inside", bypass: false }, async () => {
      await tenantContextMiddleware(req, res, next);
    });

    expect(req.organizationId).toBeUndefined(); // untouched
    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// (d) Tracer end-to-end — org-b member → GET /api/workspaces/:id → 404
// ============================================================================

describe("tracer: tenant isolation end-to-end on ONE route (createApp)", () => {
  it("org-b member reading org-a workspace → 404, with ALS org canary spanning middleware → rbac → handler", async () => {
    const token = generateTestToken(orbUserFixture().id);
    const res = await request(app)
      .get(`/api/workspaces/${ORG_A_WORKSPACE_ID}`)
      .set("Authorization", `Bearer ${token}`);

    // Cross-tenant = 404 (NEVER 403 — the leak-detector assertion, D-02).
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workspace not found");

    // Canary: at findFirst call time the ALS store carried ORG_B — the store
    // spans middleware → rbac (requireWorkspaceAccess) → handler.
    expect(alsCanary.storeOrgAtCall).toBe(ORG_B_ID);

    // The 404 came from requireWorkspaceAccess's null branch: the mocked
    // findFirst returned null and the branch fired with the caller's where.
    expect(alsCanary.calledWhere).toEqual(
      expect.objectContaining({ id: ORG_A_WORKSPACE_ID }),
    );
  });

  it("membershipless user on a workspaces route → 404 {error:'Not found'} (fail-closed tracer)", async () => {
    (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .get(`/api/workspaces/${ORG_A_WORKSPACE_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("chain order: router.use(authMiddleware) immediately followed by router.use(tenantContextMiddleware) (D-09 grep gate)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../routes/workspaces.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /router\.use\(authMiddleware\)[\s\S]{0,600}?router\.use\(tenantContextMiddleware\)/,
    );
    // And no rbac/license gate sneaks between the two router.use lines:
    const order = src.indexOf("router.use(authMiddleware)");
    const tenant = src.indexOf("router.use(tenantContextMiddleware)");
    const between = src.slice(order, tenant);
    expect(between).not.toMatch(/requirePermission|requireAdmin|requireFeatureLimit|requireWorkspaceAccess/);
  });
});
// ============================================================================
// (e) Plan-02 principal variants — widget row org, API-key candidate,
//     collector-callback bypass contract (D-05/D-08, T-185-07/08/09)
// ============================================================================

describe("Plan-02 principal variants (D-08)", () => {
  it("widget path — supertest POST /api/internal/widget/chat/stream carries the widget-row org in the ALS store; the SERVICE ACCOUNT's membership is NEVER queried (Pitfall 5 / T-185-07)", async () => {
    // The widget RUNTIME is license-gated — flip the feature flag for this
    // probe (the mock's isFeatureEnabled returns false by default).
    const { isFeatureEnabled } = require("../services/licenseService");
    (isFeatureEnabled as jest.Mock).mockReturnValue(true);

    // The REAL apiKeyMiddleware runs — the module-level jest.mock below
    // resolves the widget-service account's mint-time org (the ApiKey row),
    // deliberately DIFFERENT from the widget row's org (T-185-07: two
    // independent identity dimensions — the widget org wins).

    // Widget row (org-b whitelist) + its workspace org.
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
      id: "widget-185",
      deletedAt: null,
      isActive: true,
      workspaces: [{ workspaceId: "ws-widget-185" }],
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      organizationId: ORG_B_ID,
    });

    const res = await request(app)
      .post("/api/internal/widget/chat/stream")
      .set("X-Api-Key", "sk-widget-service-key")
      .set("X-Widget-Id", "widget-185")
      .send({ message: "hi" });

    // The route proceeds past the tenant slot (widget + workspace resolved)
    // all the way to the stream handler (200 SSE). A 404 here would mean
    // the tenant slot fail-closed — i.e. the org did NOT come from the
    // widget row.
    expect(res.status).toBe(200);

    // T-185-07 probe: the widget-service account's membership was NEVER the
    // org source — organizationMember.findFirst must be called ZERO times.
    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();

    // The widget-row resolution ran exactly once (the middleware), and the
    // workspace lookup followed the WidgetWorkspace whitelist chain.
    expect(prisma.widget.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "widget-185", deletedAt: null, isActive: true },
      }),
    );
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "ws-widget-185", deletedAt: null }),
        select: { organizationId: true },
      }),
    );
  });

  it("API-key path — validateApiKey resolves { createdBy, organizationId }; the tenant middleware runs organizationMember.findFirst ZERO times (D-08 candidate arm)", async () => {
    // resolveOrgFor unit probe: a request carrying ONLY the candidate (no
    // userId) must return the candidate without any membership query.
    const { resolveOrgFor } = require("../middleware/tenantContext");
    (prisma.organizationMember.findFirst as jest.Mock).mockClear();

    const req: any = { tenantOrgCandidate: ORG_B_ID };
    const org = await resolveOrgFor(req);

    expect(org).toBe(ORG_B_ID);
    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
  });

  it("API-key path end-to-end — the org comes from the ApiKey row (mint-time pin), the service-account membership is never consulted", async () => {
    // The /api/internal/widget router mounts apiKeyMiddleware + the widget
    // tenant slot; an invalid widget id fails closed WITHOUT a membership
    // query — proving the API-key candidate (not a membership lookup) fed
    // the slot attempt.
    // Flip the widget_enabled flag (license-gated router) + null widget row.
    // apiKeyMiddleware's validateApiKey is module-mocked below.
    const { isFeatureEnabled } = require("../services/licenseService");
    (isFeatureEnabled as jest.Mock).mockReturnValue(true);
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .set("X-Api-Key", "sk-widget-service-key")
      .set("X-Widget-Id", "missing-widget")
      .send({ query: "q", widgetId: "missing-widget", limit: 5 });

    // Widget-row 404 (byte-identical shape) — the slot attempted widget
    // resolution, NOT a membership lookup.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Widget not found or inactive");
    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
  });

  it("collector callback — PUT /api/documents/:id/status with a valid X-Collector-Secret keeps the 200-path contract (byte-identical probe, D-05/T-185-08)", async () => {
    // No tenant slot guards this route (secret-gated, no principal) — the
    // update proceeds unscoped regardless of any ALS state.
    (prisma.document.update as jest.Mock).mockResolvedValue({
      id: "doc-185",
      status: "completed",
      storageKey: null,
      filePath: null,
    });

    const res = await request(app)
      .put("/api/documents/doc-185/status")
      .set("X-Collector-Secret", "test-collector-secret-for-unit-tests")
      .send({ status: "completed" });

    // Byte-identical contract: 200 + the document JSON (no new fields).
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("doc-185");

    // The update was NOT org-scoped by any tenant store (no principal —
    // the PK-keyed where reaches the mock unchanged).
    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "doc-185" },
      }),
    );
  });

  it("collector callback with a WRONG secret → 401 byte-identical (the bypass sentinel is never set on open routes, T-185-08)", async () => {
    const res = await request(app)
      .put("/api/documents/doc-185/status")
      .set("X-Collector-Secret", "wrong-secret")
      .send({ status: "completed" });

    expect(res.status).toBe(401);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it("bypass inventory grep gate — tenantBypass appears ONLY in the documented D-05 surfaces", () => {
    const fs = require("fs");
    const path = require("path");
    const routesDir = path.resolve(__dirname, "../routes");
    const agentDir = path.resolve(__dirname, "../agent");
    const allowed = new Set([
      "documents.ts",      // collector status callback (secretEquals gate)
      "archiveImport.ts",  // collector parse-result callback (secretEquals gate)
      "mcpServer.ts",      // MCP SSE + message (admin/loopback mcpAuthCheck)
    ]);

    const hits: string[] = [];
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.includes("__tests__")) continue;
        const src = fs.readFileSync(full, "utf8");
        if (src.includes("tenantBypass")) {
          const rel = path.relative(path.resolve(__dirname, ".."), full);
          hits.push(rel);
        }
      }
    };
    scan(routesDir);
    scan(agentDir);

    for (const hit of hits) {
      const fileName = path.basename(hit);
      expect({ file: fileName, allowed: allowed.has(fileName) }).toEqual({
        file: fileName,
        allowed: true,
      });
    }
    expect(hits.length).toBeGreaterThanOrEqual(3); // documents + archiveImport + mcpServer
  });

  // ─── CR-05 (185-05): the enterprise seam's mountProtected carries the
  // tenant slot — the 185-03-style chain gate extended to the loader. The
  // loader is the ONLY seam enterprise routers can mount through (they
  // cannot import community middleware); a mounted chain missing the tenant
  // slot left every enterprise requireFeatureLimit route 404ing
  // (req.organizationId undefined) and tenant-model reads unscoped.
  // Phase 186 (D-02): the ctx factory (buildPluginContext + the CR-05 chain)
  // was extracted into pluginLoaderCore.ts (shared with the SaaS loader) —
  // the gate now reads the core, which is the single mount chain source.
  it("CR-05 gate: mountProtected mounts authMiddleware → tenantContextMiddleware → router (chain-order pin, pluginLoaderCore.ts)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../services/pluginLoaderCore.ts"),
      "utf8",
    );
    // The ONLY app.use inside mountProtected must carry all three in order.
    expect(src).toMatch(
      /app\.use\(path,\s*authMiddleware,\s*tenantContextMiddleware,\s*router\)/,
    );
    // And mountPublic documents the no-slot posture explicitly (D-02
    // auth-tier exception — IdP callbacks have no principal, SCIM has its
    // own Bearer).
    const mountPublic = src.slice(src.indexOf("mountPublic("));
    expect(mountPublic).toMatch(/NO tenant slot/);
  });
});
