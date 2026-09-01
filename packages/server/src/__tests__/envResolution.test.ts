// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * OPS-05 lineage — env path resolution + clear missing-key error.
 *
 * Verifies (per D-12 / D-13, updated for the Phase 177 cleanup):
 *  - ENV_PATH resolves to the REPO-ROOT .env (the single runtime config;
 *    the per-package packages/server/.env no longer exists).
 *  - A missing required env var makes getEnv() emit a clear message naming
 *    the resolved .env absolute path + the missing key, then exit non-zero.
 *    The opaque process.exit(1) is now preceded by an actionable diagnostic.
 */
import "./helpers/setupEnv";
import path from "path";

// Capture logger.error calls so we can assert the diagnostic contents without
// requiring a winston transport. Mocked before the env module is imported.
// NOTE: factory stores the error fn on globalThis so it survives
// jest.resetModules() (the test re-requires env.ts, which re-runs this
// factory); a fresh jest.fn() per factory run would leave the module-scope
// `loggerError` reference stale. globalThis avoids the TDZ that an outer
// `const` would trigger under @swc/jest's import hoisting.
jest.mock("../utils/logger", () => {
  const g = globalThis as unknown as { __envResLoggerError?: jest.Mock };
  g.__envResLoggerError ??= jest.fn();
  return {
    __esModule: true,
    logger: {
      error: g.__envResLoggerError,
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
  };
});
const loggerError = (globalThis as unknown as { __envResLoggerError: jest.Mock }).__envResLoggerError;

// Suppress real process.exit so the missing-key path does not terminate the
// test runner. We throw a sentinel so the throw unwinds past getEnv().
const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
  code?: number,
) => {
  throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
}) as never);

// Top-level import loads env.ts with the full test env (from setupEnv).
// ENV_PATH is the module-level constant exported for this test.
import { ENV_PATH } from "../config/env";

const ENV_KEY = "COLLECTOR_SECRET";

afterAll(() => {
  exitSpy.mockRestore();
});

describe("OPS-05 env resolution + clear missing-key error", () => {
  it("env resolved to the REPO-ROOT .env (marker-walk from __dirname)", () => {
    // env.ts __dirname = packages/server/src/config → marker-walk finds the
    // repo root → ENV_PATH = <repo-root>/.env (the single runtime config).
    // The per-package packages/server/.env no longer exists.
    expect(ENV_PATH).toBe(path.resolve(__dirname, "../../../../.env"));
    expect(ENV_PATH.endsWith(path.join("packages", "server", ".env"))).toBe(
      false, // sanity: never the old per-package path
    );
  });

  it("env missing key clear message names resolved .env path + missing key", () => {
    jest.resetModules();
    loggerError.mockClear();

    // No-op dotenv so the fresh require does not re-populate process.env from
    // the root .env (which would re-set the key we just deleted).
    jest.doMock("dotenv", () => ({ config: jest.fn() }));

    const saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    try {
      // Fresh require → mocked dotenv.config is a no-op; safeParse sees the
      // missing key and runs the clear-message branch.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const envModule = require("../config/env");
      expect(() => envModule.getEnv()).toThrow(/process\.exit\(1\)/);
    } finally {
      if (saved !== undefined) process.env[ENV_KEY] = saved;
      jest.dontMock("dotenv");
    }

    expect(loggerError).toHaveBeenCalled();
    const msg = String(loggerError.mock.calls.at(-1)![0]);
    expect(msg).toContain("Expected .env at:");
    expect(msg).toContain(ENV_PATH);
    expect(msg).toContain("Missing required key(s):");
    expect(msg).toContain("COLLECTOR_SECRET");
  });
});