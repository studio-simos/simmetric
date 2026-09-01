/**
 * Unit tests for `runCheck` in scripts/check-license.ts (LIC-03, D-02).
 *
 * Strategy (mirrors reindex-chunkids.test.ts): jest.mock ../../src/config/env
 * (export ENV_PATH as a fake path) and jest.mock dotenv (control `{ error }`
 * vs `{}`); set/delete process.env.LICENSE_KEY between cases with
 * jest.resetModules + re-require of the script so the module-scope dotenv load
 * re-runs per case.
 *
 * IMPORTANT: the public key used to verify licenses is the embedded
 * production key in license-public-key.ts — there is intentionally NO env
 * override (an override would allow self-signing). Tests sign tokens with the
 * test private key, which does NOT match the embedded production public key,
 * so any signed token verifies as bad-signature against the real verifier.
 * The "valid enterprise" path is therefore NOT unit-testable here — it is
 * covered by the smoke test (which uses a token in .env.test signed with the
 * test key, also expected to be bad-signature against the production key).
 * The "valid" path in production is covered by manual/integration testing
 * with a real token issued by the vendor's private key.
 *
 * Exit-code contract under test:
 *   0 = Community-entitled (missing LICENSE_KEY is the normal Community state)
 *   1 = token-doesn't-entitle (expired/bad-signature/malformed/schema-mismatch)
 *   2 = env-load failure (dotenv error)
 * No captured stdout/warn ever contains the key fixture.
 */

jest.mock("../../src/config/env", () => ({
  ENV_PATH: "/fake/path/.env",
}));

jest.mock("dotenv", () => ({
  config: jest.fn(),
}));

// commander@15 is ESM-only (jest transformIgnorePatterns excludes node_modules,
// and the scoped exception list is shared — do not widen it). Mock it: main()
// never runs under jest (isDirectInvocation is false), so runCheck never
// touches program — only the module-scope import needs to resolve.
jest.mock("commander", () => ({
  program: {
    option: jest.fn().mockReturnThis(),
    parse: jest.fn(),
    opts: jest.fn().mockReturnValue({}),
  },
}));

import jwt from "jsonwebtoken";
import { getTestPrivateKey } from "../../src/__tests__/helpers/licenseTestKeys";

const makePayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tier: "enterprise",
  iss: "simmetric-chat",
  sub: "Acme Corp",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  ...over,
});

// Tokens signed with the test private key will ALWAYS verify as bad-signature
// against the embedded PRODUCTION public key (there is no env override).
const signLicense = (payload: Record<string, unknown>): string =>
  jwt.sign(payload, getTestPrivateKey(), { algorithm: "RS256" });

// Re-require the script inside each test so the module-scope dotenv load
// re-evaluates with the current mock.
function loadScript() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require("dotenv").config as jest.Mock).mockReturnValue({}); // default: clean load
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../check-license") as typeof import("../check-license");
}

const setEnv = (key?: string) => {
  if (key === undefined) delete process.env.LICENSE_KEY;
  else process.env.LICENSE_KEY = key;
};

describe("check-license runCheck exit-code contract (LIC-03)", () => {
  afterEach(() => {
    delete process.env.LICENSE_KEY;
    jest.restoreAllMocks();
  });

  it("exit 0 — missing LICENSE_KEY is Community-entitled (OQ1)", async () => {
    setEnv(undefined);
    const { runCheck } = loadScript();
    const result = await runCheck({});
    expect(result.exitCode).toBe(0);
    expect(result.tier).toBe("community");
    expect(result.reason).toBe("missing");
  });

  it("exit 1 — test-signed token is bad-signature against the embedded production key (no env override possible)", async () => {
    // A token signed with the TEST private key cannot verify against the
    // embedded PRODUCTION public key — this is the security guarantee under
    // test. There is no LICENSE_PUBLIC_KEY env to override the verifier.
    const token = signLicense(makePayload());
    setEnv(token);
    const { runCheck } = loadScript();
    const result = await runCheck({});
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("bad-signature");
  });

  it("exit 1 — expired license JWT (still bad-signature first, since signature fails before exp check)", async () => {
    // Note: with a test-signed token, verification fails at the signature step
    // (bad-signature) before the expiry check runs. To test "expired" we'd
    // need a token signed by the production private key — not available here.
    // The "expired" reason is covered by the unit test in license.test.ts
    // (which calls verifyLicenseKey directly with the test public key).
    const token = signLicense(
      makePayload({
        iat: Math.floor(Date.now() / 1000) - 365 * 24 * 3600,
        exp: Math.floor(Date.now() / 1000) - 1,
      }),
    );
    setEnv(token);
    const { runCheck } = loadScript();
    const result = await runCheck({});
    expect(result.exitCode).toBe(1);
    // Signature fails first → bad-signature (not "expired").
    expect(result.reason).toBe("bad-signature");
  });

  it("exit 1 — malformed (not a JWT)", async () => {
    setEnv("not-a-jwt");
    const { runCheck } = loadScript();
    const result = await runCheck({});
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("malformed");
  });

  it("exit 1 — schema-mismatch (valid signature against test key impossible here; this token is bad-signature against production)", async () => {
    // As above: cannot reach schema-mismatch without a valid signature.
    // The schema-mismatch reason is covered by license.test.ts (direct
    // verifyLicenseKey call with the test public key). Here the token simply
    // fails at signature verification.
    const token = signLicense({
      iss: "simmetric-chat",
      sub: "NoTier Corp",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    setEnv(token);
    const { runCheck } = loadScript();
    const result = await runCheck({});
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("bad-signature");
  });

  it("exit 2 — env-load failure (dotenv returns { error })", async () => {
    setEnv(undefined);
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("dotenv").config as jest.Mock).mockReturnValue({
      error: new Error("ENOTFOUND"),
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../check-license") as typeof import("../check-license");
    const result = await mod.runCheck({});
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe("env-load-failure");
  });

  it("exit 0 + --json — missing key emits community JSON", async () => {
    setEnv(undefined);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const { runCheck } = loadScript();
    const result = await runCheck({ json: true });
    expect(result.exitCode).toBe(0);
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(JSON.parse(out)).toEqual(
      expect.objectContaining({ tier: "community", reason: "missing", exitCode: 0 }),
    );
  });

  it("no-secret-in-stdout canary — captured console output never contains the key fixture", async () => {
    const token = signLicense(makePayload());
    setEnv(token);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { runCheck } = loadScript();

    const result = await runCheck({});
    expect(result.exitCode).toBe(1); // bad-signature against embedded production key

    const captured = [
      ...logSpy.mock.calls.map((c) => String(c[0])),
      ...warnSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");
    expect(captured).not.toContain(token);
  });
});