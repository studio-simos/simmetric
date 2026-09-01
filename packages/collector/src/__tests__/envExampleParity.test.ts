// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * COLLECTOR envSchema ↔ root .env.example parity tripwire. Fails the moment
 * a schema key loses documentation in the repo-root .env.example (the single
 * exhaustive template since the per-package .env.example files were
 * removed).
 *
 * Shape-only design (T-178.1-03 doctrine): static import of the exported
 * envSchema, `.shape` introspection ONLY — the parsed-env accessor is NEVER
 * imported or called here (no parse, no required-env seeding, no exit path;
 * parse output drops undefined optionals and would false-green the guard —
 * see the twin server doctrine comment in envExampleParity.test.ts).
 *
 * Direction of enforcement is one-way, schema ⊆ file (D-02): extra documented
 * lines (raw-read pointer comments: HF_CACHE_DIR, XENOVA_CACHE_DIR,
 * HF_ALLOW_REMOTE_MODELS, OPENAI_API_KEY dual-path note) are legitimate and
 * never fail the guard. OPENAI_API_KEY must never gain an ACTIVE assignment
 * line in the [collector] section (it is a raw channel on the collector, a
 * schema key on the server) — the asserted `^OPENAI_API_KEY=` 0-hit check
 * pins that boundary.
 *
 * Per-key probe: `/^\s*#?\s*KEY\s*=/m` against the full file text; failure
 * message mirrors the repo's i18n-check.cjs style (count + one per line).
 */

import { readFileSync } from "fs";
import path from "path";
import { envSchema } from "../config/env";

// Repo-root .env.example (walk up from packages/collector/src/__tests__).
const EXAMPLE_PATH = path.resolve(__dirname, "../../../../.env.example");

describe("collector envSchema ↔ root .env.example parity", () => {
  const example = readFileSync(EXAMPLE_PATH, "utf-8");
  const schemaKeys = Object.keys(envSchema.shape);

  it("documents every collector envSchema key in the root .env.example", () => {
    const missing = schemaKeys.filter(
      (key) => !new RegExp(`^\\s*#?\\s*${key}\\s*=`, "m").test(example),
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing ${missing.length} collector keys in .env.example:\n` +
          missing.map((k) => `  - ${k}`).join("\n"),
      );
    }
    expect(missing).toEqual([]);
  });

  it("introspects the full collector schema (15 keys)", () => {
    // Structural sentinel: regeneration must track schema drift.
    expect(schemaKeys.length).toBe(15);
  });

  it("keeps the OPENAI dual-path key out of active assignments (raw channel here)", () => {
    // Pitfall 2 (D-02: no keys fabricated): OPENAI_API_KEY is a collector
    // raw-read (embeddings.ts dual-path); the [collector] section may
    // mention it only as a pointer comment, never as an active assignment.
    // The root .env.example DOES carry an active line for the server schema
    // — the probe therefore asserts no UNCOMMENTED line exists at all, and
    // the pointer comment in the raw-read section stays a comment.
    expect(/^OPENAI_API_KEY=/m.test(example)).toBe(false);
  });
});