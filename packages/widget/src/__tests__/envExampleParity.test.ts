// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * WIDGET envSchema ↔ root .env.example parity tripwire. Fails the moment a
 * schema key loses documentation in the repo-root .env.example (the single
 * exhaustive template since the per-package .env.example files were
 * removed).
 *
 * Shape-only design (T-178.1-03 doctrine): static import of the exported
 * envSchema, `.shape` introspection ONLY — the parsed-env accessor is NEVER
 * imported or called here (no parse, no required-env seeding, no exit path).
 *
 * Widget jest maps @simmetric-chat/shared to SOURCE (../shared/src/index.ts,
 * jest.config.js:18), so this suite runs without a shared build — server and
 * collector twins resolve shared via dist and rely on turbo ^build freshness.
 *
 * Direction of enforcement is one-way, schema ⊆ file (D-02).
 * Per-key probe: `/^\s*#?\s*KEY\s*=/m` against the full file text; failure
 * message mirrors the repo's i18n-check.cjs style (count + one per line).
 */

import { readFileSync } from "fs";
import path from "path";
import { envSchema } from "../config/env";

// Repo-root .env.example (walk up from packages/widget/src/__tests__).
const EXAMPLE_PATH = path.resolve(__dirname, "../../../../.env.example");

describe("widget envSchema ↔ root .env.example parity", () => {
  const example = readFileSync(EXAMPLE_PATH, "utf-8");
  const schemaKeys = Object.keys(envSchema.shape);

  it("documents every widget envSchema key in the root .env.example", () => {
    const missing = schemaKeys.filter(
      (key) => !new RegExp(`^\\s*#?\\s*${key}\\s*=`, "m").test(example),
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing ${missing.length} widget keys in .env.example:\n` +
          missing.map((k) => `  - ${k}`).join("\n"),
      );
    }
    expect(missing).toEqual([]);
  });

  it("introspects the full widget schema (6 keys)", () => {
    // Structural sentinel: regeneration must track schema drift.
    expect(schemaKeys.length).toBe(6);
  });
});