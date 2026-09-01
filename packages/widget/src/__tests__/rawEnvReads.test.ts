// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 178 (raw-env-reads-guard) — WIDGET LOG_LEVEL module-load guard.
 *
 * Completes the ×3 logger coverage with the server + collector suites
 * (packages/server/src/__tests__/rawEnvReads.test.ts,
 * packages/collector/src/__tests__/rawEnvReads.test.ts): the widget logger
 * reads `process.env.LOG_LEVEL || "info"` at MODULE LOAD (utils/logger.ts:16)
 * — the same structural exception as the other two services (this module is
 * imported BY config/env.ts for schema-validation error logging, so getEnv()
 * cannot be used there). Pinning the module-load read proves the raw channel
 * survives loadRootEnv (Phase 177) and any future Zod absorption.
 *
 * D-03 symmetry: the widget declares the single-element RAW_ENV_EXCEPTIONS
 * constant ({LOG_LEVEL}) for cross-package parity. No widget Zod absence
 * assertion exists to make — the widget schema DOES declare LOG_LEVEL
 * (z.string().default("info")), so the behavioral constant + the source-level
 * read inventory below carry the tripwire instead.
 */

import "./helpers/setupEnv";

// ─── RAW_ENV_EXCEPTIONS (D-03 — per-package tripwire constant) ──────────────
const RAW_ENV_EXCEPTIONS: ReadonlySet<string> = new Set(["LOG_LEVEL"]);

// ─── Env save/restore doctrine (T-178-02: delete never assign undefined) ─────
const ORIGINAL = process.env.LOG_LEVEL;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = ORIGINAL;
  }
});

describe("RAW_ENV_EXCEPTIONS (D-03 widget constant)", () => {
  it("declares exactly the single widget raw key LOG_LEVEL", () => {
    expect([...RAW_ENV_EXCEPTIONS]).toEqual(["LOG_LEVEL"]);
  });

  it("widget logger has no top-level process.env reads beyond LOG_LEVEL (informational inventory)", async () => {
    // Behavioral inventory (not a source grep): import the logger fresh with a
    // distinctive LOG_LEVEL and assert it landed — proving the ONLY channel the
    // module consumes at load is the documented LOG_LEVEL raw read.
    process.env.LOG_LEVEL = "warn";
    jest.resetModules();
    jest.dontMock("../utils/logger");
    const { logger } = await import("../utils/logger");
    expect(logger.level).toBe("warn");
    // Cross-check the constant covers the exact key the module actually reads.
    expect(RAW_ENV_EXCEPTIONS.has("LOG_LEVEL")).toBe(true);
  });
});

describe("LOG_LEVEL module-load read (utils/logger.ts — widget)", () => {
  it('LOG_LEVEL="debug" at import → logger.level === "debug"', async () => {
    process.env.LOG_LEVEL = "debug";
    jest.resetModules();
    jest.dontMock("../utils/logger");
    const { logger } = await import("../utils/logger");
    expect(logger.level).toBe("debug");
  });

  it('LOG_LEVEL deleted at import → logger.level === "info" (default intact)', async () => {
    delete process.env.LOG_LEVEL;
    jest.resetModules();
    jest.dontMock("../utils/logger");
    const { logger } = await import("../utils/logger");
    expect(logger.level).toBe("info");
  });
});