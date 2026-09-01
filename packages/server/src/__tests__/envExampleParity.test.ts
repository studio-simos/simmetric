// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * SERVER envSchema ↔ root .env.example parity tripwire (Phase 178.1 lineage).
 *
 * Fails the moment a schema key loses documentation in the repo-root
 * .env.example (the single exhaustive template since the per-package
 * .env.example files were removed). Shape-only design (T-178.1-03 doctrine):
 * static import of the exported envSchema, `.shape` introspection ONLY — the
 * parsed-env accessor is NEVER imported or called here, so there is no
 * parse, no required-env seeding, and no process.exit path. (Parse output is
 * unusable as a completeness source anyway: Zod 4 omits optional keys whose
 * value is undefined — see rawEnvReads.test.ts:415-19.)
 *
 * Direction of enforcement is one-way, schema ⊆ file: extra documented lines
 * (pointer comments for raw-read keys, collector/widget sections) are
 * legitimate and never fail the guard.
 *
 * Per-key probe: `/^\s*#?\s*KEY\s*=/m` against the full file text — active
 * `KEY=` and commented `# KEY=` lines both count as documented; prose header
 * lines carry no line-start `KEY=` so they can never satisfy the probe.
 * Failure message mirrors the repo's i18n-check.cjs style (count + one per line).
 */

import { readFileSync } from "fs";
import path from "path";
import { envSchema } from "../config/env";

// Repo-root .env.example (walk up from packages/server/src/__tests__).
const EXAMPLE_PATH = path.resolve(__dirname, "../../../../.env.example");

describe("server envSchema ↔ root .env.example parity", () => {
  const example = readFileSync(EXAMPLE_PATH, "utf-8");
  const schemaKeys = Object.keys(envSchema.shape);

  it("documents every server envSchema key in the root .env.example", () => {
    const missing = schemaKeys.filter(
      (key) => !new RegExp(`^\\s*#?\\s*${key}\\s*=`, "m").test(example),
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing ${missing.length} server keys in .env.example:\n` +
          missing.map((k) => `  - ${k}`).join("\n"),
      );
    }
    expect(missing).toEqual([]);
  });

  it("introspects the full server schema (83 keys)", () => {
    // Structural sentinel: if this drifts, the schema changed and the root
    // .env.example must be re-checked against the new surface.
    expect(schemaKeys.length).toBe(83);
  });
});