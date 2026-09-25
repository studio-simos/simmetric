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

  it("introspects the full server schema (118 keys)", () => {
    // Structural sentinel: if this drifts, the schema changed and the root
    // .env.example must be re-checked against the new surface. Phase 193
    // (D-05): 84 → 94 with the 10 optional LDAP_* keys. Phase 195 (MCPO-01):
    // 94 → 103 with the 4 client-cred + 5 OAUTH_* override keys. Phase 198
    // (ECCO-01): 103 → 105 with TELEGRAM_API_URL + CONNECTOR_POLL_INTERVAL_MS.
    // Phase 196 (MCPO-04): 105 → 107 with GDRIVE_API_BASE_URL +
    // GRAPH_API_BASE_URL (connector API base-URL overrides, air-gap lever).
    // Post-198 docs commit: 107 → 108 with WIKI_EMBED_TIMEOUT_MS (collector
    // wiki-embed axios wait cap, ENV-only infra key — documented in the
    // [server] section).
    // Phase 197 (MCPO-05): 108 → 109 with GMAIL_API_BASE_URL (Gmail API
    // base-URL override, air-gap lever for the gmail_* connector tools).
    // Phase 199 (ECCO-04): 109 → 111 with DISCORD_API_URL +
    // DISCORD_GATEWAY_URL (Discord connector transport endpoints, air-gap
    // lever — the WIKI_EMBED_TIMEOUT_MS 108 ancestor line stays in the
    // chain above).
    // Phase 200 (ECCO-06, 200-01): 111 → 114 with SLACK_API_URL (connector
    // Web API base URL, .default() schema key) + SLACK_CLIENT_ID +
    // SLACK_CLIENT_SECRET (OAuth client credentials, .optional() — the
    // 109→111 pattern).
    // Phase 200 (ECCO-06, 200-02): 114 → 115 with WHATSAPP_API_URL (the
    // WhatsApp Cloud API Graph base URL, .default() — D-06 air-gap lever).
    // Phase 200 (ECCO-06, 200-03): 115 → 117 with OAUTH_SLACK_AUTH_URL +
    // OAUTH_SLACK_TOKEN_URL (Slack endpoint overrides, .url().optional() —
    // the 195 D-05 air-gap lever pattern extended to the Slack provider).
    // Phase 205 (OCR-02, 205-01): 117 → 118 with OCR_NUM_CTX (runtime
    // num_ctx override, 0 = registry fallback — D-09).
    expect(schemaKeys.length).toBe(118);
  });
});