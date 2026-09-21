// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * fetchDiagnostics.ts — unwrap undici connection-level fetch failures.
 *
 * Node's fetch (undici) surfaces connection-level failures as a bare
 * TypeError("fetch failed"); the real reason (ECONNREFUSED, ENOTFOUND, …)
 * rides the `cause` chain, which the plain `err.message` log line drops.
 * This helper extracts a compact, operator-readable detail string from that
 * chain so the collector-dispatch catch block can log WHY the dispatch
 * failed.
 *
 * Pure function: no I/O, no secrets (never reads env), never throws.
 * Everything that is not an undici-shaped connection failure returns null —
 * callers treat null as "nothing to add".
 */

/** Connection-level codes undici / the TCP stack report on `cause.code`. */
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** A cause entry with a usable `code` (Error-ish with a code property). */
interface CodedError {
  code?: unknown;
  message?: unknown;
}

function detailFromCause(cause: unknown): string | null {
  const coded = cause as CodedError | null | undefined;
  if (!coded || typeof coded !== "object") {
    return null;
  }
  const code = typeof coded.code === "string" ? coded.code : undefined;
  if (!code || !CONNECTION_CODES.has(code)) {
    return null;
  }
  const message = typeof coded.message === "string" ? coded.message : "";
  return message ? `${code} — ${message}` : code;
}

/**
 * Classify an undici connection-level fetch failure.
 *
 * Returns a compact detail string (e.g. "ECONNREFUSED — connect
 * ECONNREFUSED 127.0.0.1:3210") only when `err` is an Error whose message is
 * exactly "fetch failed" AND its `cause` chain (through AggregateError's
 * first usable entry) carries a known connection-level code. Everything else
 * — plain errors, abort DOMExceptions, causes with unrelated codes, non-
 * Error input — returns null. Never throws.
 */
export function describeFetchFailureCause(err: unknown): string | null {
  if (!(err instanceof Error) || err.message !== "fetch failed") {
    return null;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof AggregateError) {
    for (const entry of cause.errors ?? []) {
      const detail = detailFromCause(entry);
      if (detail) {
        return detail;
      }
    }
    return null;
  }
  return detailFromCause(cause);
}