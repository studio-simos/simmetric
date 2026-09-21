// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Agent } from "undici";

/**
 * collectorDispatchAgent.ts — undici dispatcher for the server→collector
 * ingest dispatch (documents.ts POST /api/ingest).
 *
 * WHY: Node's global fetch (undici) enforces a 300s `headersTimeout` — if the
 * collector holds the connection open longer than that before sending response
 * headers, undici kills the socket with a bare TypeError("fetch failed") whose
 * cause carries UND_ERR_HEADERS_TIMEOUT. That code is deliberately NOT in
 * fetchDiagnostics' CONNECTION_CODES set (it is not a connection-level
 * failure), so the enriched "Collector fetch failed before response" log line
 * stays silent and the operator sees only the raw "fetch failed".
 *
 * This is exactly what happened on 2026-09-18 17:18:58: a 2.58 MB PDF with
 * ~270k chars of text, dispatched at 17:13:57, failed ~5:01 later — the local
 * (Xenova) CPU embedding pipeline legitimately exceeds any fixed 300s window,
 * while the D-1 design makes the ingest wait cap an operator OPT-IN
 * (COLLECTOR_INGEST_TIMEOUT_MS unset = unbounded). The dispatcher restores
 * that intent at the transport layer: header/body timeouts disabled, keeping
 * only an idle-socket keepalive so a dead collector still surfaces as
 * ECONNRESET/UND_ERR_SOCKET instead of hanging forever.
 *
 * Module-level singleton: agents hold connection pools; one per process is
 * the intended shape (mirrors vectorStore's singleton convention).
 *
 * UPGRADE RULE (2026-09-19 incident): this dependency MUST stay on undici v7
 * while call sites pass this Agent to Node's BUILT-IN `globalThis.fetch`.
 * undici v8 rewrote the Dispatcher handler protocol (`onRequestStart` — the
 * new v2 interface); a v8 Agent handed to the built-in global fetch (which
 * runs its bundled undici 7.x and invokes dispatchers with the v1 protocol)
 * fails validation BEFORE any network I/O and surfaces as the bare
 * TypeError("fetch failed") the operator saw in the 2026-09-19 Docker
 * incident — instantly, with `health collector: true` still green because
 * `checkCollectorHealth` (hybridSearchService) rides axios and never receives
 * this dispatcher. Upgrading to undici v8 therefore requires SIMULTANEOUSLY
 * switching every dispatcher call site (documents.ts ingest,
 * dlpDocumentMasking.ts reembed, builtinSkills.ts document_temp_process) to
 * undici's own `fetch` export (v8 fetch + v8 Agent are mutually compatible) —
 * never one half of the pairing. The loopback regression test
 * (collectorDispatchAgent.test.ts) fails loudly if this pairing breaks.
 */
export const collectorDispatchAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 30_000,
});