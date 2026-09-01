// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * System routes integration tests — runs against a real PostgreSQL database
 * cloned from the template via jest.config.integration.js.
 */

import jwt from "jsonwebtoken";
import request from "supertest";

// UUIDv4 regex (RFC 4122) — the D-02 jti shape asserted on initialize tokens.
const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: ReturnType<typeof import("../index").createApp>;
let prisma: import("@prisma/client").PrismaClient;
let env: import("../config/env").Env;

async function setSetupWizardMode(value: string): Promise<void> {
  // Direct DB write — bypasses getSetting's Redis cache (no REDIS_URL in
  // integration tests, so getSetting reads DB anyway). Used by the test
  // harness to drive the setup_wizard_mode state machine.
  await prisma.systemConfig.upsert({
    where: { key: "setup_wizard_mode" },
    create: { key: "setup_wizard_mode", value },
    update: { value },
  });
}

beforeAll(async () => {
  // Modules are loaded lazily here so they pick up the worker-specific
  // DATABASE_URL set by jest.setup.integration.ts.
  const { createApp } = await import("../index");
  app = createApp();

  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;

  const { getEnv } = await import("../config/env");
  env = getEnv();

  await prisma.$connect();

  // Phase 152 (WIZ-02, D-04): the initialize endpoint is hard-gated on
  // setup_wizard_mode === "active" (404 otherwise). The template DB's prisma
  // seed does NOT seed setup_wizard_mode, so set it to "active" here to let
  // the harness's own initialize call pass the gate. (In production the
  // boot sequence's ensureSetupWizardMode() derives "active" on a fresh
  // install; createApp() does not run the boot sequence, so the test must
  // set it explicitly.)
  await setSetupWizardMode("active");

  // Ensure the system is initialised (admin user exists) before tests run.
  const initRes = await request(app)
    .post("/api/system/initialize")
    .send({
      username: `seedadmin_${Date.now()}`,
      email: `seedadmin_${Date.now()}@test.com`,
      password: "testpassword123",
    });

  if (initRes.status !== 201 && initRes.status !== 409) {
    console.warn(
      "[system.integration.test] Unexpected initialize response during setup:",
      initRes.status,
      initRes.body
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

function generateToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: "1h" });
}

describe("GET /api/system/is-initialized", () => {
  it("returns { initialized: true } when admin user exists", async () => {
    const res = await request(app).get("/api/system/is-initialized");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("initialized");
    expect(typeof res.body.initialized).toBe("boolean");
  });
});

describe("POST /api/system/initialize", () => {
  // Phase 152 (WIZ-02, D-10): the initialize handler is hard-gated on
  // setup_wizard_mode === "active" (404 otherwise). The existing 409/400
  // tests exercise the logic AFTER the gate, so each test needs the mode
  // set to "active" to reach the safeParse / isInitialized path. The
  // beforeAll initialize flips the mode to "completed"; reset it here.
  beforeEach(async () => {
    await setSetupWizardMode("active");
  });

  it("returns 409 when system is already initialized", async () => {
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username: "newadmin",
        email: "newadmin@test.com",
        password: "testpassword123",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already initialized");
  });

  it("returns 400 for invalid input", async () => {
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username: "a",
        email: "not-an-email",
        password: "short",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid request body");
  });

  it("returns 400 when password is too short", async () => {
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username: "validuser",
        email: "valid@test.com",
        password: "1234567",
      });

    expect(res.status).toBe(400);
  });

  it("accepts optional config in the payload schema", async () => {
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username: "testadmin2",
        email: "testadmin2@test.com",
        password: "testpassword123",
        config: {
          LLM_PROVIDER: "ollama",
          OLLAMA_BASE_URL: "http://ollama:11434",
          EMBEDDING_PROVIDER: "local",
          VECTOR_DB_PROVIDER: "lancedb",
        },
      });

    expect(res.status).toBe(409);
  });

  it("rejects invalid LLM_PROVIDER value", async () => {
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username: "testadmin3",
        email: "testadmin3@test.com",
        password: "testpassword123",
        config: {
          LLM_PROVIDER: "invalid_provider",
        },
      });

    expect(res.status).toBe(400);
  });

  it("returns an auto-login token carrying a UUIDv4 jti (D-02, TEC-03b)", async () => {
    // The seeded template already has an admin, so isInitialized() blocks a
    // plain second initialize with 409. To exercise the real 201 signing path
    // (the D-02 invariant), clear the admin state first, then initialize with
    // fresh credentials — the initialize itself re-creates an admin, so the
    // initialized state is restored for the tests that follow.
    await prisma.userRole.deleteMany({ where: { role: { name: "admin" } } });
    await prisma.user.deleteMany({ where: { roles: { some: { role: { name: "admin" } } } } });

    const username = `jtiadmin_${Date.now()}`;
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username,
        email: `${username}@test.com`,
        password: "testpassword123",
      });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();

    const payload = jwt.decode(res.body.token) as { userId: string; jti?: string };
    expect(payload.userId).toBeDefined();
    expect(payload.jti).toMatch(UUIDV4_RE);
  });
});

// Phase 152 (WIZ-02) — setup_wizard_mode state machine: is-initialized
// extension, the D-10 hard 404 gate on initialize, the D-08 mustChangePassword
// gate, and the D-04 mode flip after a successful initialize.
describe("GET /api/system/is-initialized — setup_wizard_mode (Phase 152, D-04)", () => {
  it("returns setupWizardMode alongside initialized (completed when admin exists)", async () => {
    // afterAll of the initialize block leaves an admin + mode=completed (the
    // beforeAll initialize flipped it). Pin the mode explicitly so this test
    // does not depend on test ordering.
    await setSetupWizardMode("completed");
    const res = await request(app).get("/api/system/is-initialized");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("setupWizardMode");
    expect(res.body.setupWizardMode).toBe("completed");
  });

  it("returns setupWizardMode='active' when the mode is active", async () => {
    await setSetupWizardMode("active");
    const res = await request(app).get("/api/system/is-initialized");
    expect(res.status).toBe(200);
    expect(res.body.setupWizardMode).toBe("active");
  });

  it("defaults setupWizardMode to 'active' when the row is unset (G-152-1, D-04)", async () => {
    // Simulate a pre-152 install / fresh DB reset where the row was never
    // seeded (or was cleared): delete it, then is-initialized must still
    // respond. Per G-152-1 + D-04 the fallback is now "active" (not "completed")
    // — a fresh-install user must see the wizard, which owns admin creation.
    await prisma.systemConfig.deleteMany({ where: { key: "setup_wizard_mode" } });
    const res = await request(app).get("/api/system/is-initialized");
    expect(res.status).toBe(200);
    expect(res.body.setupWizardMode).toBe("active");
  });
});

// Phase 152 gap G-152-1: prove that ensureSetupWizardMode() invalidates the
// Redis config:setup_wizard_mode cache after re-deriving the mode. The bug:
// getSetting() reads Redis before the DB, so a stale "completed" in Redis
// suppresses the wizard on a fresh DB reset even after the DB row is cleared.
// The fix (Plan 152-04 Task 1) added a redis.del after the prisma.upsert. This
// integration test seeds a stale "completed" in BOTH Redis and the DB, clears
// the admins + DB row, calls ensureSetupWizardMode() directly, then asserts the
// route returns "active" — proving the stale Redis value was invalidated and
// getSetting re-read the DB. Self-skips when Redis is unavailable (REDIS_URL
// absent) — the unit suite covers the DEL call; this is the end-to-end proof.
describe("GET /api/system/is-initialized — Redis cache invalidation (G-152-1)", () => {
  let redisClient: { set: (k: string, v: string) => Promise<unknown>; del: (k: string) => Promise<unknown> } | null;

  beforeAll(async () => {
    const { getRedis } = await import("../services/redisService");
    redisClient = getRedis();
  });

  afterEach(async () => {
    // Restore the suite's invariant: an admin exists + mode=completed so the
    // other describes (initialize 404 gate, probes) are not poisoned. The
    // jtiadmin test pattern (lines 172-173) deletes admins to exercise the 201
    // path; we re-create one here if none remain.
    await setSetupWizardMode("completed");
    const adminRole = await prisma.role.findFirst({ where: { name: "admin" } });
    if (adminRole) {
      const adminCount = await prisma.userRole.count({ where: { roleId: adminRole.id } });
      if (adminCount === 0) {
        const username = `restore_admin_${Date.now()}`;
        await prisma.user.create({
          data: { username, email: `${username}@test.com`, passwordHash: "x", salt: "x", mustChangePassword: true },
        });
        const u = await prisma.user.findUnique({ where: { username } });
        if (u) await prisma.userRole.create({ data: { userId: u.id, roleId: adminRole.id } });
      }
    }
    if (redisClient) {
      try { await redisClient.del("config:setup_wizard_mode"); } catch { /* non-blocking */ }
    }
  });

  it("returns 'active' after ensureSetupWizardMode invalidates a stale Redis 'completed' (G-152-1)", async () => {
    if (!redisClient) {
      console.warn("[system.integration.test] G-152-1 Redis test SKIPPED — REDIS_URL not set (getRedis() returned null). Unit suite covers the DEL call.");
      return;
    }

    // (1) Seed a stale "completed" into Redis (the G-152-1 bug condition).
    await redisClient.set("config:setup_wizard_mode", JSON.stringify("completed"));
    // (2) And into the DB (so the test starts from the "already initialized" state).
    await setSetupWizardMode("completed");
    // (3) Simulate a fresh DB reset: delete all admin userRoles + admin users.
    await prisma.userRole.deleteMany({ where: { role: { name: "admin" } } });
    await prisma.user.deleteMany({ where: { roles: { some: { role: { name: "admin" } } } } });
    // (4) Clear the DB row to "" (the pre-derivation state).
    await setSetupWizardMode("");
    // (5) Run the boot derivation directly — ensureSetupWizardMode re-derives
    //     "active" (no admin) and writes it + invalidates the stale Redis key.
    const { ensureSetupWizardMode } = await import("../services/systemConfigService");
    await ensureSetupWizardMode();
    // (6) The route must now return "active" — the stale Redis "completed" was
    //     invalidated, getSetting re-read the DB's "active".
    const res = await request(app).get("/api/system/is-initialized");
    expect(res.status).toBe(200);
    expect(res.body.setupWizardMode).toBe("active");
  });
});

describe("POST /api/system/initialize — setup_wizard_mode 404 gate (Phase 152, D-10)", () => {
  it("returns 404 { error: 'Not found' } when setup_wizard_mode=completed (hard gate, generic body)", async () => {
    await setSetupWizardMode("completed");
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username: "ghostadmin",
        email: "ghost@test.com",
        password: "testpassword123",
      });

    expect(res.status).toBe(404);
    // Pitfall 4: the 404 body MUST be indistinguishable from a missing route.
    expect(res.body).toEqual({ error: "Not found" });
    // No details, no "already initialized" hint.
    expect(res.body).not.toHaveProperty("details");
  });

  it("returns 404 BEFORE running safeParse (no body-validation feedback to a completed-mode probe)", async () => {
    // An attacker probing a completed endpoint sends a malformed body. The
    // 404 gate runs first, so the response is 404 (not 400 with field errors).
    await setSetupWizardMode("completed");
    const res = await request(app)
      .post("/api/system/initialize")
      .send({ username: "a", email: "not-an-email", password: "short" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("creates the admin with mustChangePassword=false when setup_wizard_mode=active (wizard path, D-08)", async () => {
    // Clear admins so initialize creates a fresh one (wizard path).
    await prisma.userRole.deleteMany({ where: { role: { name: "admin" } } });
    await prisma.user.deleteMany({ where: { roles: { some: { role: { name: "admin" } } } } });
    await setSetupWizardMode("active");

    const username = `wizardadmin_${Date.now()}`;
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username,
        email: `${username}@test.com`,
        password: "testpassword123",
      });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    // D-08: the wizard IS the first password set, so no rotation prompt.
    expect(res.body.user.mustChangePassword).toBe(false);

    // Verify the DB row matches the response.
    const created = await prisma.user.findUnique({ where: { username } });
    expect(created?.mustChangePassword).toBe(false);
  });

  it("flips setup_wizard_mode to 'completed' after a successful initialize (D-04)", async () => {
    await prisma.userRole.deleteMany({ where: { role: { name: "admin" } } });
    await prisma.user.deleteMany({ where: { roles: { some: { role: { name: "admin" } } } } });
    await setSetupWizardMode("active");

    const username = `flipadmin_${Date.now()}`;
    const initRes = await request(app)
      .post("/api/system/initialize")
      .send({
        username,
        email: `${username}@test.com`,
        password: "testpassword123",
      });
    expect(initRes.status).toBe(201);

    // (d) after a successful initialize, GET /is-initialized reports completed.
    const statusRes = await request(app).get("/api/system/is-initialized");
    expect(statusRes.body.setupWizardMode).toBe("completed");

    // (d) a second POST /initialize returns 404 (the gate now blocks).
    const secondRes = await request(app)
      .post("/api/system/initialize")
      .send({
        username: `second_${Date.now()}`,
        email: `second_${Date.now()}@test.com`,
        password: "testpassword123",
      });
    expect(secondRes.status).toBe(404);
    expect(secondRes.body).toEqual({ error: "Not found" });
  });

  it("retains the 409 'already initialized' guard as defense-in-depth when mode is active but an admin exists", async () => {
    // An admin exists (from a prior test) and mode is active. The 404 gate
    // passes (active), safeParse passes, then isInitialized() fires 409.
    await setSetupWizardMode("active");
    // Ensure an admin exists.
    const adminRole = await prisma.role.findFirst({ where: { name: "admin" } });
    const hasAdmin = adminRole
      ? (await prisma.userRole.count({ where: { roleId: adminRole.id } })) > 0
      : false;
    if (!hasAdmin) {
      // Create a throwaway admin so the 409 path is exercised.
      const username = `defadmin_${Date.now()}`;
      await prisma.user.create({
        data: { username, email: `${username}@test.com`, passwordHash: "x", salt: "x", mustChangePassword: true },
      });
      if (adminRole) {
        const u = await prisma.user.findUnique({ where: { username } });
        if (u) await prisma.userRole.create({ data: { userId: u.id, roleId: adminRole.id } });
      }
    }

    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username: `extra_${Date.now()}`,
        email: `extra_${Date.now()}@test.com`,
        password: "testpassword123",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already initialized");
  });
});

// Phase 152 (WIZ-01, D-06, RESEARCH OQ1) — public wizard-gated probe
// endpoints. Both are PUBLIC (no authMiddleware — the wizard runs before the
// user has a JWT) but wizard-gated: 404 { error: "Not found" } when
// setup_wizard_mode !== "active" (same D-10 hard-gate pattern as initialize).
// Failed probes are non-blocking (D-06): 200 with { ok: false, error }.
describe("POST /api/system/probe-llm (Phase 152, D-06)", () => {
  it("returns 404 { error: 'Not found' } when setup_wizard_mode=completed", async () => {
    await setSetupWizardMode("completed");
    const res = await request(app)
      .post("/api/system/probe-llm")
      .send({ provider: "ollama", baseUrl: "http://localhost:11434" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("returns 200 { ok: false, generic error } when mode=active and the provider is unreachable (G-152-2 generic non-leaking error)", async () => {
    await setSetupWizardMode("active");
    // An unreachable Ollama baseUrl — the probe must NOT throw; it returns
    // 200 with { ok: false, error } so the wizard can show the error but
    // still let the user proceed (configure later in Settings). The ollama
    // provider uses allowLoopback=true so 127.0.0.1 passes the SSRF guard
    // and fails at the connection (unreachable port 1). The error is the
    // generic non-leaking message — no IP/port/connection-refused echo.
    const res = await request(app)
      .post("/api/system/probe-llm")
      .send({ provider: "ollama", baseUrl: "http://127.0.0.1:1" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", false);
    expect(res.body.error).toBe("Could not reach the configured endpoint");
    // G-152-2: no host/port/connection topology leak in the error string.
    expect(res.body.error).not.toMatch(/127\.0\.0\.1|connect|ECONNREFUSED|port/i);
  });
});

describe("POST /api/system/probe-vector (Phase 152, D-06)", () => {
  it("returns 404 { error: 'Not found' } when setup_wizard_mode=completed", async () => {
    await setSetupWizardMode("completed");
    const res = await request(app)
      .post("/api/system/probe-vector")
      .send({ provider: "lancedb" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("returns 200 { ok: true } for the default LanceDB provider when mode=active (local, no network check)", async () => {
    await setSetupWizardMode("active");
    const res = await request(app)
      .post("/api/system/probe-vector")
      .send({ provider: "lancedb" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // T-152-04: no internal topology leak.
    expect(JSON.stringify(res.body)).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });

  it("returns 200 { ok: false, generic error } for qdrant loopback url (G-152-2 loopback block for probe-vector)", async () => {
    await setSetupWizardMode("active");
    // probe-vector qdrant uses allowLoopback=false, so 127.0.0.1 is
    // REJECTED by the SSRF guard before any outbound connection. This now
    // proves the SSRF loopback block (not just an unreachable port).
    const res = await request(app)
      .post("/api/system/probe-vector")
      .send({ provider: "qdrant", url: "http://127.0.0.1:1" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", false);
    expect(res.body.error).toBe("Could not reach the configured endpoint");
    expect(res.body.error).not.toMatch(/127\.0\.0\.1|connect|ECONNREFUSED|port/i);
  });
});

// Phase 152 gap G-152-2 (CR-01): SSRF rejection proofs for the public probe
// endpoints. These run with real DNS resolution against literal-IP inputs
// (the guard short-circuits IP literals — no DNS needed) and assert the
// generic non-leaking error is returned for each blocked category. The
// probe endpoints are unauthenticated (wizard-gated only); without the
// guard an attacker could pivot the fresh-install server into an
// internal-network scanner / cloud-metadata reacher.
describe("POST /api/system/probe-llm — SSRF guard (G-152-2, CR-01)", () => {
  beforeEach(async () => {
    await setSetupWizardMode("active");
  });

  it("blocks http://169.254.169.254/latest/meta-data/ (AWS/GCP/Azure metadata) with the generic error", async () => {
    const res = await request(app)
      .post("/api/system/probe-llm")
      .send({ provider: "ollama", baseUrl: "http://169.254.169.254/latest/meta-data/" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Could not reach the configured endpoint" });
  });

  it("blocks http://10.0.0.1/ (RFC1918 10.x) with the generic error", async () => {
    const res = await request(app)
      .post("/api/system/probe-llm")
      .send({ provider: "ollama", baseUrl: "http://10.0.0.1/" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Could not reach the configured endpoint" });
  });

  it("blocks file:///etc/passwd (non-http(s) protocol) with the generic error", async () => {
    const res = await request(app)
      .post("/api/system/probe-llm")
      .send({ provider: "ollama", baseUrl: "file:///etc/passwd" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Could not reach the configured endpoint" });
  });

  it("blocks 100.100.100.200 (Alibaba metadata) with the generic error", async () => {
    const res = await request(app)
      .post("/api/system/probe-llm")
      .send({ provider: "ollama", baseUrl: "http://100.100.100.200/" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Could not reach the configured endpoint" });
  });

  it("returns 'Unsupported provider' (no input echo) for an unknown provider", async () => {
    const res = await request(app)
      .post("/api/system/probe-llm")
      .send({ provider: "evil-provider-name" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Unsupported provider" });
    // IN-01: the input must NOT be echoed back.
    expect(res.body.error).not.toMatch(/evil-provider-name/);
  });
});

describe("POST /api/system/probe-vector — SSRF guard (G-152-2, CR-01)", () => {
  beforeEach(async () => {
    await setSetupWizardMode("active");
  });

  it("blocks qdrant http://127.0.0.1:6333/ (loopback blocked for probe-vector) with the generic error", async () => {
    const res = await request(app)
      .post("/api/system/probe-vector")
      .send({ provider: "qdrant", url: "http://127.0.0.1:6333/" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Could not reach the configured endpoint" });
  });

  it("blocks qdrant http://169.254.169.254/ (cloud-metadata) with the generic error", async () => {
    const res = await request(app)
      .post("/api/system/probe-vector")
      .send({ provider: "qdrant", url: "http://169.254.169.254/" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Could not reach the configured endpoint" });
  });

  it("returns 'Unsupported provider' (no input echo) for an unknown provider", async () => {
    const res = await request(app)
      .post("/api/system/probe-vector")
      .send({ provider: "evil-vector-name" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Unsupported provider" });
    expect(res.body.error).not.toMatch(/evil-vector-name/);
  });
});

describe("POST /api/system/reset-db", () => {
  it("returns 401 without authentication", async () => {
    const res = await request(app)
      .post("/api/system/reset-db")
      .send({ confirm: "RESET" });

    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    const regularUser = await prisma.user.findFirst({
      where: { roles: { none: { role: { name: "admin" } } } },
      include: { roles: { include: { role: { include: { permissions: true } } } } },
    });

    if (!regularUser) {
      return;
    }

    const token = generateToken(regularUser.id);
    const res = await request(app)
      .post("/api/system/reset-db")
      .set("Authorization", `Bearer ${token}`)
      .send({ confirm: "RESET" });

    expect(res.status).toBe(403);
  });

  it("returns 400 when confirmation body is wrong", async () => {
    const adminUser = await prisma.user.findFirst({
      where: { roles: { some: { role: { name: "admin" } } } },
    });

    if (!adminUser) return;

    const token = generateToken(adminUser.id);

    const res1 = await request(app)
      .post("/api/system/reset-db")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res1.status).toBe(400);
    expect(res1.body.error).toContain("confirm");

    const res2 = await request(app)
      .post("/api/system/reset-db")
      .set("Authorization", `Bearer ${token}`)
      .send({ confirm: "WRONG" });

    expect(res2.status).toBe(400);
  });

  it("returns 200 when admin sends { confirm: 'RESET' }", async () => {
    const adminUser = await prisma.user.findFirst({
      where: { roles: { some: { role: { name: "admin" } } } },
    });

    if (!adminUser) return;

    const token = generateToken(adminUser.id);
    const res = await request(app)
      .post("/api/system/reset-db")
      .set("Authorization", `Bearer ${token}`)
      .send({ confirm: "RESET" });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("reset");
  });
});

// Phase 152 gap G-152-3 (CR-02): TOCTOU race in /api/system/initialize. The
// 404 gate, isInitialized(), existingUser check, prisma.user.create, and the
// mode flip were not atomic — two concurrent requests with distinct
// usernames/emails both passed all guards, both created admins, both received
// valid JWTs before the mode flip armed the gate. This block proves the fix:
// admin creation + role + config + mode-flip run inside a single
// prisma.$transaction (Serializable), the mode flips to "completed" BEFORE
// the JWT is issued, and the loser's P2034 serialization-failure is mapped
// to 409 (never 500). The race-loser is 404 if it failed the inner re-check
// before commit, or 409 if it aborted at commit with P2034 — both satisfy
// the single-admin invariant.
describe("POST /api/system/initialize — TOCTOU race (G-152-3, CR-02)", () => {
  beforeEach(async () => {
    // Fresh-install pre-state for every race test: no admin, mode=active.
    await prisma.userRole.deleteMany({ where: { role: { name: "admin" } } });
    await prisma.user.deleteMany({ where: { roles: { some: { role: { name: "admin" } } } } });
    await setSetupWizardMode("active");
  });

  it("two concurrent initialize requests with distinct creds produce exactly one 201 and one 404/409 (never two admins, never 500)", async () => {
    const ts = Date.now();
    const credsA = {
      username: `racerA_${ts}`,
      email: `racerA_${ts}@test.com`,
      password: "testpassword123",
    };
    const credsB = {
      username: `racerB_${ts}`,
      email: `racerB_${ts}@test.com`,
      password: "testpassword123",
    };

    const [resA, resB] = await Promise.all([
      request(app).post("/api/system/initialize").send(credsA),
      request(app).post("/api/system/initialize").send(credsB),
    ]);

    const results = [resA, resB];
    // Exactly one 201 (the winner).
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    // Exactly one 404-or-409 (the loser — 404 if the inner re-check fired
    // before commit, 409 if it aborted at commit with P2034).
    expect(results.filter((r) => r.status === 404 || r.status === 409).length).toBe(1);
    // Warning 1: the loser's P2034 serialization failure MUST be mapped to
    // 409 (never 500) — never swallow a serialization failure as a generic
    // 500.
    expect(results.filter((r) => r.status === 500).length).toBe(0);

    // Exactly one admin in the DB (the winner; the loser's transaction
    // rolled back).
    const adminCount = await prisma.user.count({
      where: { roles: { some: { role: { name: "admin" } } } },
    });
    expect(adminCount).toBe(1);

    // The winning transaction flipped setup_wizard_mode to "completed".
    const mode = await prisma.systemConfig.findUnique({
      where: { key: "setup_wizard_mode" },
    });
    expect(mode?.value).toBe("completed");
  });

  it("a single initialize still returns 201 + token + mustChangePassword=false (happy-path regression, D-08)", async () => {
    const username = `happy_${Date.now()}`;
    const res = await request(app)
      .post("/api/system/initialize")
      .send({
        username,
        email: `${username}@test.com`,
        password: "testpassword123",
      });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.mustChangePassword).toBe(false);

    const created = await prisma.user.findUnique({ where: { username } });
    expect(created?.mustChangePassword).toBe(false);
  });

  it("returns 404 BEFORE safeParse when mode=completed (404-before-safeParse invariant preserved by the outer fast-path gate)", async () => {
    await setSetupWizardMode("completed");
    const res = await request(app)
      .post("/api/system/initialize")
      .send({ username: "a", email: "not-an-email", password: "short" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });
});
