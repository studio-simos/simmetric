// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Maps a synthesis run.error string to a localized reason line.
 *
 * Server (Plan 64-04) emits prefixed error strings for the known FAILED
 * scenarios. The UI maps each known prefix to an i18n key under
 * `synthesis.detail.errorReason.*`. Unknown errors fall back to the
 * `unknown` key which interpolates the raw {{error}}.
 *
 * The synthesis namespace is intentionally NOT in the i18n:check namespaces
 * list, so the errorReason keys only need to exist in EN/IT/RU (3-locale
 * parity is sufficient and intentional).
 */

interface ReasonMapEntry {
  prefix: string;
  key: string;
}

const ERROR_REASON_MAP: ReasonMapEntry[] = [
  { prefix: "Aborted: 3 consecutive", key: "synthesis.detail.errorReason.abortedConsecutive" },
  { prefix: "Aborted: 5 total", key: "synthesis.detail.errorReason.abortedTotal" },
  { prefix: "Aborted: orphaned PROCESSING (reaper)", key: "synthesis.detail.errorReason.orphanedReaper" },
  { prefix: "Archive template requires local LLM", key: "synthesis.detail.errorReason.phiGate" },
];

type TFunc = (key: string, options?: Record<string, unknown>) => string;

export function renderReasonLine(error: string, t: TFunc): string {
  for (const m of ERROR_REASON_MAP) {
    if (error.startsWith(m.prefix)) {
      return t(m.key);
    }
  }
  return t("synthesis.detail.errorReason.unknown", { error });
}