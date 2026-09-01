/**
 * smoke-license-e2e — License diagnostics end-to-end gate.
 *
 * Verifies the LICENSE diagnostics surface against a LIVE server child
 * process, with the canary-absence gate (no LICENSE_KEY / JWT-body substring on
 * any surface).
 *
 *  Path A — test token from .env.test (signed with the TEST private key) is
 *  rejected by the embedded PRODUCTION public key → Community-degraded
 *  verdicts. This is the security guarantee: a token not signed by the
 *  vendor's private key cannot unlock Enterprise, no matter what env is set.
 *  (There is NO LICENSE_PUBLIC_KEY env override — an override would allow
 *  self-signing.)
 *    - boot server on :3102 with LICENSE_KEY=<test-token> → boot log MUST
 *      contain warn `[license] fallback to Community` reason=bad-signature
 *    - GET /api/license/diagnose → 200, tier=community, reason=bad-signature,
 *      cachedTier=community, env.licenseKeyPresent=true,
 *      env.licensePublicKeyPresent=true, jwt.isJwt=true
 *    - `license:check` CLI → exit code 1 (token-doesn't-entitle)
 *
 *  Canary-absence (cross-cutting): for each surface — (a) boot log, (b)
 *  diagnose response body, (c) CLI stdout — assert no substring match of the
 *  LICENSE_KEY value or the JWT body segment. There is no LICENSE_SECRET under
 *  RS256 — the public key is not a secret.
 *
 *  NOTE: the "valid enterprise" path is NOT covered here — it requires a token
 *  signed by the vendor's PRODUCTION private key, which is not in this repo.
 *  That path is verified manually/integration by issuing a real license with
 *  the simmetric-license-tool and configuring it on a staging server.
 *
 *  Pitfall 7: the server boots with the DEV .env DATABASE_URL (:5432, live
 *  postgres container) — .env.test points at :5434 with no live server.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const SERVER_PORT = 3102;
const BOOT_TIMEOUT_MS = 90_000;
const LOG_LINE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface BootResult {
  log: string;
  exitCode: number | null;
}

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

function canaryCheck(
  checks: SmokeCheck[],
  surfaceName: string,
  surface: string,
  key: string | undefined,
  jwtBody: string | undefined,
): void {
  const forbidden: string[] = [];
  if (key) forbidden.push(key);
  if (jwtBody) forbidden.push(jwtBody);
  let leaked: string | undefined;
  for (const f of forbidden) {
    if (f && surface.includes(f)) {
      leaked = f === jwtBody ? "JWT-body segment" : "LICENSE_KEY value";
      break;
    }
  }
  if (leaked) {
    fail(checks, `canary-absence on ${surfaceName}`, `LEAKED ${leaked}`);
  } else {
    pass(checks, `canary-absence on ${surfaceName}`, "no key/jwtBody substring");
  }
}

function waitForLine(log: () => string, matcher: RegExp, timeoutMs: number): Promise<string> {
  const start = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = (): void => {
      const line = log().split("\n").find((l) => matcher.test(l));
      if (line) return resolvePromise(line);
      if (Date.now() - start > timeoutMs) {
        rejectPromise(new Error(`timed out waiting for line matching ${matcher} (${timeoutMs}ms)`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function killChild(proc: ReturnType<typeof spawn>): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
  }
}

async function readTestToken(): Promise<string> {
  const envTest = readFileSync(resolve(SERVER_DIR, ".env.test"), "utf-8");
  const m = envTest.match(/^LICENSE_KEY=(.+)$/m);
  if (!m || m[1] === undefined) {
    throw new Error("packages/server/.env.test has no LICENSE_KEY line — Path A precondition broken");
  }
  return m[1].trim().replace(/^["']|["']$/g, "");
}

async function loginAndGetToken(port: number): Promise<{ token: string; jwtBody: string }> {
  const res = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  if (!res.ok) throw new Error(`login on :${port} failed with ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`login on :${port} returned no token`);
  return { token: body.token, jwtBody: body.token.split(".")[1] ?? "" };
}

async function diagnose(port: number, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://localhost:${port}/api/license/diagnose`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) {
    throw new Error(`diagnose on :${port} returned ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function runCli(env: Record<string, string>): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn("pnpm", ["--filter", "server", "license:check"], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (stderr) stdout += "\n" + stderr; // capture both for the canary scan
      resolvePromise({ stdout, exitCode: code });
    });
  });
}

// ---------------------------------------------------------------------------
// runSmokeChecks
// ---------------------------------------------------------------------------

export async function runSmokeChecks(): Promise<SmokeResult> {
  const checks: SmokeCheck[] = [];
  let proc: ReturnType<typeof spawn> | null = null;

  try {
    // ---------------------------------------------------------------
    // Path A — test token from .env.test → bad-signature → Community
    // ---------------------------------------------------------------
    const token = await readTestToken();
    const jwtBodyA = token.split(".")[1] ?? "";

    const bootA = await (async () => {
      const child = spawn("pnpm", ["--filter", "server", "exec", "tsx", "src/index.ts"], {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: "development",
          SERVER_PORT: String(SERVER_PORT),
          LICENSE_KEY: token,
          // No LICENSE_SECRET under RS256 — strip any inherited value.
          LICENSE_SECRET: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.on("data", (d) => (text += d.toString()));
      child.stderr.on("data", (d) => (text += d.toString()));
      const readyP = waitForLine(() => text, /\[server\] Listening on port 3102/, BOOT_TIMEOUT_MS);
      proc = child;
      await readyP;
      await waitForLine(() => text, /\[license\] fallback to Community/, LOG_LINE_TIMEOUT_MS);
      return text;
    })();

    const warnLine = bootA.split("\n").find((l) => l.includes("[license] fallback to Community") && l.includes("bad-signature"));
    if (warnLine) {
      pass(checks, "Path A boot log warns [license] fallback to Community reason=bad-signature", warnLine.trim());
    } else {
      fail(checks, "Path A boot log warns [license] fallback to Community reason=bad-signature", "missing warn line");
    }
    canaryCheck(checks, "Path A boot log", bootA, token, jwtBodyA);

    const loginA = await loginAndGetToken(SERVER_PORT);
    const diagA = await diagnose(SERVER_PORT, loginA.token);
    const diagAOk =
      diagA.tier === "community" &&
      diagA.reason === "bad-signature" &&
      diagA.cachedTier === "community" &&
      (diagA.env as Record<string, unknown>)?.licenseKeyPresent === true &&
      (diagA.env as Record<string, unknown>)?.licensePublicKeyPresent === true &&
      (diagA.jwt as Record<string, unknown>)?.isJwt === true;
    if (diagAOk) {
      pass(checks, "Path A diagnose: tier=community reason=bad-signature cachedTier=community keyPresent pubKeyPresent isJwt", JSON.stringify(diagA));
    } else {
      fail(checks, "Path A diagnose verdicts", `unexpected body: ${JSON.stringify(diagA)}`);
    }
    canaryCheck(checks, "Path A diagnose body", JSON.stringify(diagA), token, jwtBodyA);

    const cliA = await runCli({ LICENSE_KEY: token, LICENSE_SECRET: "" });
    if (cliA.exitCode === 1) {
      pass(checks, "Path A license:check exits 1 (token-doesn't-entitle)", `exitCode=${cliA.exitCode}`);
    } else {
      fail(checks, "Path A license:check exits 1", `exitCode=${cliA.exitCode} stdout=${cliA.stdout}`);
    }
    canaryCheck(checks, "Path A CLI stdout", cliA.stdout, token, jwtBodyA);
  } finally {
    if (proc) await killChild(proc);
  }

  const failed = checks.some((c) => !c.ok);
  return { checks, exitCode: failed ? 1 : 0 };
}

async function main(): Promise<void> {
  const result = await runSmokeChecks();

  process.stdout.write(
    JSON.stringify({
      tool: "smoke:license-e2e",
      checks: result.checks,
      exitCode: result.exitCode,
    }) + "\n",
  );

  for (const c of result.checks) {
    console.error(`[smoke:license-e2e] ${c.ok ? "OK  " : "FAIL"} ${c.name}` + (c.detail ? ` — ${c.detail}` : ""));
  }
  if (result.exitCode !== 0) {
    console.error("[smoke:license-e2e] FAILED — see FAIL checks above; fix and re-run `pnpm smoke:license-e2e`");
  }
  process.exit(result.exitCode);
}

const isDirectInvocation = typeof require !== "undefined" && require.main === module;
if (isDirectInvocation) {
  main().catch((err: Error) => {
    console.error("[smoke:license-e2e] Fatal:", err.message);
    process.exitCode = 1;
  });
}