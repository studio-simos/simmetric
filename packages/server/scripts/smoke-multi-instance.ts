/**
 * smoke-multi-instance — Multi-instance Redis scale smoke (Phase 124-01, SC4 / D-01).
 *
 * Closes the Phase 122 SC1 cross-instance deferral by proving the shared-Redis
 * mechanisms at the TWO-INSTANCE composition level:
 *
 *  Precondition — Redis MUST be up and reachable (Pitfall 1: the compose redis
 *  service is expose-only + profiles:[full]; a plain `docker compose up redis`
 *  binds nothing on localhost:6379). Start it with:
 *    docker run -d --name simmetric-chat-smoke-redis -p 6379:6379 redis:7-alpine
 *  (official image, already declared in docker-compose.yml:176). The script
 *  pings Redis via ioredis at REDIS_URL=redis://localhost:6379 and FAILS with
 *  a clear message if unreachable — the assertions must never pass vacuously
 *  via the degradation path.
 *
 *  Two server instances boot as child processes sharing the dev .env
 *  DATABASE_URL (:5432) and JWT_SECRET (required so B verifies A's tokens):
 *    A: NODE_ENV=development REDIS_URL=redis://localhost:6379 SERVER_PORT=3100
 *    B: NODE_ENV=development REDIS_URL=redis://localhost:6379 SERVER_PORT=3101
 *  NODE_ENV=development pinned explicitly (A3: Bree schedulers must NOT
 *  start — the lock assertion invokes withDistributedLock directly). Wait for
 *  `[server] Listening on port` AND `[redis] Connected` in both logs.
 *
 *  Assertion 1 — jti revocation cross-instance: login on A → extract jti from
 *  the token (authService.ts:134 mints jti: crypto.randomUUID()) → write the
 *  revocation key directly to the shared Redis (`set rev:jti:<jti> 1 EX 86400`
 *  — revokeToken is NOT route-wired, Pitfall 3; the direct key write proves
 *  the shared-key mechanism) → GET /api/auth/me on B with the revoked token →
 *  401 {"error":"Token revoked"} (auth.ts:30-31) → control: fresh login token
 *  on B → 200.
 *
 *  Assertion 2 — shared rate-limit bucket: upsert a smoke widget via Prisma
 *  (isActive: true, leadCaptureEnabled: true — the E2E widget's
 *  leadCaptureEnabled defaults false so a dedicated widget avoids the 403 at
 *  internalWidget.ts:102) → POST /api/internal/widget/lead on A 30 times with
 *  X-Api-Key: <WIDGET_API_KEY_PLAINTEXT from e2e/globalSetup.ts:58> → 201 each
 *  → the 31st POST on B → 429 with the widgetLeadLimiter message (rateLimit.ts
 *  :61) → secondary evidence: `GET rl:lead:<ip>` on the shared Redis shows the
 *  counter (the same bucket both instances hit).
 *
 *  Assertion 3 — single-executor distributed lock: run concurrently
 *  `withDistributedLock("smoke:lock", 10_000, hold-10s routine)` and
 *  `withDistributedLock("smoke:lock", 10_000, "B-ran" routine)` via
 *  Promise.all → the first resolves with the holder's return value, the second
 *  resolves null (ResourceLockedError, retryCount 0 — distributedLock.ts:94-96).
 *
 *  Teardown: kill both child processes in a finally block. The Redis container
 *  is left running for reuse (research OQ3) — stop with
 *  `docker stop simmetric-chat-smoke-redis` after the smoke if desired.
 *
 *  Mirror of smoke:ollama (src/smoke/ollamaJs.smoke.ts): exported
 *  runSmokeChecks(): Promise<SmokeResult>; process.exit ONLY inside the
 *  require.main === module guard; human-readable lines to stderr, machine-
 *  readable JSON payload to stdout; fails loud (exit 1 + actionable stderr).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import jwt from "jsonwebtoken";
import Redis from "ioredis";

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SmokeResult {
  checks: SmokeCheck[];
  exitCode: 0 | 1;
}

const ROOT = resolve(__dirname, "../../.."); // packages/server/scripts -> repo root
const SERVER_DIR = resolve(__dirname, ".."); // packages/server
const PORT_A = 3100;
const PORT_B = 3101;
const REDIS_URL = "redis://localhost:6379";
const BOOT_TIMEOUT_MS = 90_000;
const LOG_LINE_TIMEOUT_MS = 30_000;
const WIDGET_API_KEY_PLAINTEXT = "sk-c6a7b6662ab64f4c9582bf83e147675b"; // e2e/globalSetup.ts:58
const WIDGET_NAME = "Smoke Test Widget";

const requireFromServer = createRequire(resolve(SERVER_DIR, "package.json"));
const { PrismaClient } = requireFromServer("@prisma/client") as typeof import("@prisma/client");
const { PrismaPg } = requireFromServer("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
const { Pool } = requireFromServer("pg") as typeof import("pg");

function fail(checks: SmokeCheck[], name: string, detail: string): SmokeCheck {
  const c: SmokeCheck = { name, ok: false, detail };
  checks.push(c);
  return c;
}

function pass(checks: SmokeCheck[], name: string, detail?: string): SmokeCheck {
  const c: SmokeCheck = { name, ok: true, detail };
  checks.push(c);
  return c;
}

function waitForLine(log: () => string, matcher: RegExp, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = (): void => {
      const line = log().split("\n").find((l) => matcher.test(l));
      if (line) return resolvePromise();
      if (Date.now() - start > timeoutMs) {
        rejectPromise(new Error(`timed out waiting for line matching ${matcher} (${timeoutMs}ms)`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function readDevDatabaseUrl(): string {
  const envPath = resolve(SERVER_DIR, "../../.env"); // repo-root .env (single runtime config)
  const content = readFileSync(envPath, "utf-8");
  const m = content.match(/^DATABASE_URL=(.+)$/m);
  if (!m || m[1] === undefined) throw new Error("root .env has no DATABASE_URL line");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

async function bootServer(port: number): Promise<{ proc: ReturnType<typeof spawn>; log: () => string }> {
  const child = spawn("pnpm", ["--filter", "server", "exec", "tsx", "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "development",
      SERVER_PORT: String(port),
      REDIS_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (d) => (text += d.toString()));
  child.stderr.on("data", (d) => (text += d.toString()));
  await waitForLine(() => text, new RegExp(`\\[server\\] Listening on port ${port}`), BOOT_TIMEOUT_MS);
  await waitForLine(() => text, /\[redis\] Connected/, LOG_LINE_TIMEOUT_MS);
  return { proc: child, log: () => text };
}

async function killChild(proc: ReturnType<typeof spawn>): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
  }
}

async function login(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  if (!res.ok) throw new Error(`login on :${port} failed ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`login on :${port} returned no token`);
  return body.token;
}

async function me(port: number, token: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${port}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// runSmokeChecks
// ---------------------------------------------------------------------------

export async function runSmokeChecks(): Promise<SmokeResult> {
  const checks: SmokeCheck[] = [];
  let procA: ReturnType<typeof spawn> | null = null;
  let procB: ReturnType<typeof spawn> | null = null;
  let redis: Redis | null = null;
  let prisma: InstanceType<typeof PrismaClient> | null = null;

  try {
    // ---- Precondition: Redis must be UP (never pass vacuously) ----
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null });
    const pong = await redis.ping().catch((err: Error) => null);
    if (pong !== "PONG") {
      fail(checks, "precondition Redis reachable (PONG)", `redis://localhost:6379 unreachable — start: docker run -d --name simmetric-chat-smoke-redis -p 6379:6379 redis:7-alpine`);
      return { checks, exitCode: 1 };
    }
    pass(checks, "precondition Redis reachable (PONG)", REDIS_URL);

    // ---- Boot both instances ----
    const bootA = await bootServer(PORT_A);
    procA = bootA.proc;
    const bootB = await bootServer(PORT_B);
    procB = bootB.proc;
    pass(checks, "both instances booted (A:3100, B:3101) with [redis] Connected", "logs confirmed");

    // ================================================================
    // Assertion 1 — jti revocation cross-instance
    // ================================================================
    const tokenA = await login(PORT_A);
    const decoded = jwt.decode(tokenA) as { jti?: string } | null;
    if (!decoded?.jti) {
      fail(checks, "A1 jti revocation cross-instance", `login token has no jti claim: ${JSON.stringify(decoded)}`);
    } else {
      await redis.set(`rev:jti:${decoded.jti}`, "1", "EX", 86400); // direct key write — revokeToken not route-wired (Pitfall 3)

      const revokedOnB = await me(PORT_B, tokenA);
      if (revokedOnB.status === 401 && revokedOnB.body.includes("Token revoked")) {
        pass(checks, "A1 revoked token → 401 {\"error\":\"Token revoked\"} on B", `status=${revokedOnB.status} body=${revokedOnB.body}`);
      } else {
        fail(checks, "A1 revoked token → 401 {\"error\":\"Token revoked\"} on B", `got status=${revokedOnB.status} body=${revokedOnB.body}`);
      }

      const controlToken = await login(PORT_B); // fresh, unrevoked
      const controlOnB = await me(PORT_B, controlToken);
      if (controlOnB.status === 200) {
        pass(checks, "A1 control token → 200 on B", `status=${controlOnB.status}`);
      } else {
        fail(checks, "A1 control token → 200 on B", `got status=${controlOnB.status} body=${controlOnB.body}`);
      }
    }

    // ================================================================
    // Assertion 2 — shared rate-limit bucket (30 on A → 31st on B = 429)
    // ================================================================
    // Re-runnability: flush any leftover rl:lead:* buckets from prior runs so
    // the 30→31 assertion starts from a clean shared bucket.
    const staleBuckets = await redis.keys("rl:lead:*").catch(() => []);
    if (staleBuckets.length > 0) await redis.del(...staleBuckets);

    const databaseUrl = readDevDatabaseUrl();
    const pool = new Pool({ connectionString: databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    const admin = await prisma.user.findFirst({ where: { username: "admin" }, select: { id: true } });
    if (!admin) throw new Error("no admin user in dev DB — seed first");

    const widget = await prisma.widget.upsert({
      where: { id: `smoke-widget-${Date.now()}` }, // unique id per run — upsert on a never-existing id creates
      create: {
        name: WIDGET_NAME,
        isActive: true,
        leadCaptureEnabled: true,
        allowedOrigins: JSON.stringify(["http://localhost:5173"]),
        createdBy: admin.id,
      },
      update: {},
    });

    let all201 = true;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`http://localhost:${PORT_A}/api/internal/widget/lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": WIDGET_API_KEY_PLAINTEXT },
        body: JSON.stringify({ email: "smoke@test.local", transcript: [{ role: "user", content: "x" }], widgetId: widget.id }),
      });
      if (res.status !== 201) {
        all201 = false;
        fail(checks, "A2 30× lead POST on A → 201", `attempt ${i + 1} got ${res.status}: ${await res.text()}`);
        break;
      }
    }
    if (all201) pass(checks, "A2 30× lead POST on A → 201", "all 30 accepted");

    const thirtyFirst = await fetch(`http://localhost:${PORT_B}/api/internal/widget/lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": WIDGET_API_KEY_PLAINTEXT },
      body: JSON.stringify({ email: "smoke@test.local", transcript: [{ role: "user", content: "x" }], widgetId: widget.id }),
    });
    const tfBody = await thirtyFirst.text();
    if (thirtyFirst.status === 429 && tfBody.includes("Too many lead submissions")) {
      pass(checks, "A2 31st lead POST on B → 429 (shared rl:lead: bucket)", `status=${thirtyFirst.status} body=${tfBody}`);
    } else {
      fail(checks, "A2 31st lead POST on B → 429 (shared rl:lead: bucket)", `got status=${thirtyFirst.status} body=${tfBody}`);
    }

    // Secondary evidence: the shared Redis counter is the SAME bucket both
    // instances hit. rate-limit-redis v8 key shape is `rl:lead:{ip}:{hash}:
    // {route}:{window}` — scan the prefix instead of hardcoding the ip.
    const leadKeys = await redis.keys("rl:lead:*").catch(() => []);
    if (leadKeys.length > 0) {
      const sample = await redis.get(leadKeys[0] ?? "").catch(() => null);
      pass(checks, "A2 secondary: shared rl:lead:* counter present", `keys=${leadKeys.join(",")} counter=${sample}`);
    } else {
      fail(checks, "A2 secondary: shared rl:lead:* counter present", "no rl:lead:* key on shared Redis");
    }

    // ================================================================
    // Assertion 3 — single-executor distributed lock
    // ================================================================
    // The smoke process must see REDIS_URL so getRedis() resolves (the lock
    // assertion runs IN this process, not in the child servers) — otherwise
    // withDistributedLock degrades to a local run and both routines execute.
    process.env.REDIS_URL = REDIS_URL;
    const { withDistributedLock } = await import("../src/services/distributedLock");
    const holdRoutine = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, 10_000)); // hold the lock 10s
      return "A-held";
    };
    const [first, second] = await Promise.all([
      withDistributedLock("smoke:lock", 10_000, holdRoutine),
      withDistributedLock("smoke:lock", 10_000, async () => "B-ran"),
    ]);
    if (first === "A-held" && second === null) {
      pass(checks, "A3 withDistributedLock single-executor", "holder=A-held, contended acquire resolved null");
    } else {
      fail(checks, "A3 withDistributedLock single-executor", `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
    }
  } finally {
    if (procA) await killChild(procA);
    if (procB) await killChild(procB);
    if (redis) redis.disconnect();
    if (prisma) await prisma.$disconnect();
  }

  const failed = checks.some((c) => !c.ok);
  return { checks, exitCode: failed ? 1 : 0 };
}

async function main(): Promise<void> {
  const result = await runSmokeChecks();

  process.stdout.write(
    JSON.stringify({
      tool: "smoke:multi-instance",
      checks: result.checks,
      exitCode: result.exitCode,
    }) + "\n",
  );

  for (const c of result.checks) {
    console.error(`[smoke:multi-instance] ${c.ok ? "OK  " : "FAIL"} ${c.name}` + (c.detail ? ` — ${c.detail}` : ""));
  }
  if (result.exitCode !== 0) {
    console.error("[smoke:multi-instance] FAILED — see FAIL checks above; fix and re-run `pnpm smoke:multi-instance`");
  }
  process.exit(result.exitCode);
}

const isDirectInvocation = typeof require !== "undefined" && require.main === module;
if (isDirectInvocation) {
  main().catch((err: Error) => {
    console.error("[smoke:multi-instance] Fatal:", err.message);
    process.exitCode = 1;
  });
}
