// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 92-01 (D-04): OLLAMA_KEEP_ALIVE additive env key (server schema).
 *
 * Verifies the Zod default ("10m") when the var is unset and operator
 * override passthrough when set. Per-test jest.resetModules() + dynamic
 * import because env.ts caches the parsed env in module state and runs
 * dotenv.config() at module load. Hermeticity: dotenv only injects keys
 * ABSENT from process.env, and no .env file carries OLLAMA_KEEP_ALIVE (this
 * plan adds it to .env.example only), so the delete-then-import default
 * case is hermetic.
 */
import "./helpers/setupEnv";

// Mock the logger before the env module is imported (env.ts logs via winston
// on validation failure). The globalThis stash survives jest.resetModules()
// (the factory re-runs on re-require); a module-scope const would go stale
// under @swc/jest's import hoisting — envResolution.test.ts precedent.
jest.mock("../utils/logger", () => {
  const g = globalThis as unknown as { __keepAliveLoggerError?: jest.Mock };
  g.__keepAliveLoggerError ??= jest.fn();
  return {
    __esModule: true,
    logger: {
      error: g.__keepAliveLoggerError,
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
  };
});

const ENV_KEY = "OLLAMA_KEEP_ALIVE";
const ORIGINAL = process.env[ENV_KEY];

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = ORIGINAL;
  }
});

describe("OLLAMA_KEEP_ALIVE env schema (92-01 D-04, server)", () => {
  it('defaults to "10m" when unset', async () => {
    jest.resetModules();
    // Never assign undefined — process.env stringifies it to "undefined".
    delete process.env[ENV_KEY];
    const envModule = await import("../config/env");
    envModule.clearEnvCache();
    expect(envModule.getEnv().OLLAMA_KEEP_ALIVE).toBe("10m");
  });

  it("honors an operator override", async () => {
    jest.resetModules();
    process.env[ENV_KEY] = "30m";
    const envModule = await import("../config/env");
    envModule.clearEnvCache();
    expect(envModule.getEnv().OLLAMA_KEEP_ALIVE).toBe("30m");
  });
});
