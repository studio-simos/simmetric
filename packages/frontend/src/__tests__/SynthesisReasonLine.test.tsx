// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for the synthesis FAILED reason line helper (KB-04).
 *
 * The helper maps server-provided `run.error` prefixed strings to i18n keys
 * under `synthesis.detail.errorReason.*`. Unknown errors fall back to the
 * `unknown` key which interpolates the raw {{error}}.
 */

import { renderReasonLine } from "../lib/synthesisReason";

// EN strings from UI-SPEC KB-04 table — the helper is locale-agnostic; it
// calls `t(key, options)` and returns whatever the translator yields. We
// pass a fake `t` that returns the EN copy verbatim so the tests assert the
// mapping logic, not i18n plumbing.

const EN_COPY: Record<string, string> = {
  "synthesis.detail.errorReason.abortedConsecutive":
    "Aborted after 3 consecutive LLM failures. Check the synthesis model endpoint and retry.",
  "synthesis.detail.errorReason.abortedTotal":
    "Aborted after 5 scattered LLM failures across the archive. Check the synthesis model endpoint and retry.",
  "synthesis.detail.errorReason.orphanedReaper":
    "Marked failed: the run was orphaned (server crashed or timed out after 2h). Trigger a new run to continue.",
  "synthesis.detail.errorReason.phiGate":
    "Blocked: this archive's template requires a local LLM (Ollama), but an external provider is configured. Switch the synthesis provider to Ollama or remove the localLLMOnly template constraint.",
  "synthesis.detail.errorReason.unknown": "{{error}}",
};

function fakeT(key: string, options?: Record<string, unknown>): string {
  const raw = EN_COPY[key] ?? key;
  if (!options) return raw;
  return raw.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? ""));
}

describe("SynthesisReasonLine — renderReasonLine", () => {
  it("maps 'Aborted: 3 consecutive' prefix to abortedConsecutive", () => {
    const out = renderReasonLine("Aborted: 3 consecutive LLM failures on pass 2", fakeT);
    expect(out).toBe(EN_COPY["synthesis.detail.errorReason.abortedConsecutive"]);
  });

  it("maps 'Aborted: 5 total' prefix to abortedTotal", () => {
    const out = renderReasonLine("Aborted: 5 total LLM failures across the archive", fakeT);
    expect(out).toBe(EN_COPY["synthesis.detail.errorReason.abortedTotal"]);
  });

  it("maps 'Aborted: orphaned PROCESSING (reaper)' prefix to orphanedReaper", () => {
    const out = renderReasonLine("Aborted: orphaned PROCESSING (reaper)", fakeT);
    expect(out).toBe(EN_COPY["synthesis.detail.errorReason.orphanedReaper"]);
  });

  it("maps 'Archive template requires local LLM' prefix to phiGate", () => {
    const out = renderReasonLine(
      "Archive template requires local LLM; external provider configured (PHI gate).",
      fakeT,
    );
    expect(out).toBe(EN_COPY["synthesis.detail.errorReason.phiGate"]);
  });

  it("falls back to unknown with {{error}} interpolation for unrecognized errors", () => {
    const out = renderReasonLine("Unexpected boom", fakeT);
    expect(out).toBe("Unexpected boom");
  });

  it("interpolates multi-line / unusual error strings via unknown fallback", () => {
    const out = renderReasonLine("Network timeout (ETIMEDOUT 131)", fakeT);
    expect(out).toBe("Network timeout (ETIMEDOUT 131)");
  });
});