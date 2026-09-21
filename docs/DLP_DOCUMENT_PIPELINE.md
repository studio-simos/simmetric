# DLP Document Pipeline — Operator Guide

Phase 192 (DLP-01..06). How document PII detection, masking, and unmasking work for administrators and operators.

## Overview

When DLP document scanning is enabled for a workspace, every uploaded document passes through an **async pg-boss scan** after ingest completes:

1. **Detect** — 3-tier pipeline: admin-configurable regex patterns (`dlpPatternService`), checksum validation for fixed-format Italian identifiers (Codice Fiscale incl. omocodia, P.IVA, IBAN — `dlpChecksum`), and LLM contextual NER for names/addresses (existing Ollama client).
2. **Mask** — detected entities become document-wide numbered placeholders (`[PERSON_1]`, `[GOV_ID_2]`, …). Masking is idempotent (mask∘mask = mask) — the placeholder syntax can never re-match.
3. **Re-embed masked** — `document_chunks.chunkText` is rewritten with masked text, FTS `searchVector`/`searchVectorMulti` recomputed, and vectors re-embedded via the collector `/api/ingest/reembed` endpoint. No unredacted vector remains searchable.
4. **Encrypt originals** — the original text + every entity value are stored AES-256-GCM encrypted (`encryptionService`, ENCRYPTION_KEY contract). Masking is one-way: the encrypted originals are the only clean copy.

## Admin controls

### Per-workspace toggle (DLP-01)

Settings → Workspaces → **DLP document scan** switch (per-workspace column `workspaces.dlpDocumentScanEnabled`, default **off**).

- The toggle is **disabled with a gate-blocked helper** until the eval gate (below) has passed — disabling is never blocked.
- State flips optimistically and reverts on save error.

### Eval gate (DLP-05)

The detection-quality eval must pass before enablement:

- **POST /api/system/dlp/eval/run** (admin) — runs the repeatable runner over the committed Italian-PII fixture corpus (`packages/server/src/__tests__/fixtures/dlp-eval/`). Persists the result to the internal SystemConfig key `DLP_EVAL_LAST_RUN` (not admin-editable).
- **GET /api/system/dlp/eval/result** (admin) — reads the last run. Never-run returns `{ passed: false, noRun: true }` — never a silent pass.
- **Gate metric:** 0 checksum-suppressed false positives on the GOV_ID/FINANCIAL classes. PERSON/ADDRESS recall is **documented-only** (nerMode marks `stub` vs `live`).

### Legacy corpus backfill (DLP-06)

**POST /api/system/dlp/backfill** (admin, AlertDialog-confirmed in the UI):

- **Eval-gated**: refuses with `409 { error, gate: "eval-not-passed" }` when the last eval result is absent or failed.
- **Idempotent + resumable**: `dlpScannedAt` marker — re-runs enqueue only documents lacking the marker.
- **Rate-limited**: queue concurrency 1 (below the live-scan queue).
- Convergence is pinned by the integration twin (`dlpBackfill.integration.test.ts`, real Postgres): masked chunks persisted, tsvectors recomputed, reembed payload byte-equal to stored masked text, zero-remaining-PII audit query.

## Chat re-composition (DLP-03)

Masked placeholders reach the LLM; at **stream end, exactly once**, the server re-composes placeholders in the terminal message for users holding `dlp:unmask` on the citing document's workspace. The additive `content` field on the `done` SSE payload carries the re-composed text; widget visitors **never** receive re-composed text (server-enforced; the UI only hides the control).

## Preview unmask (DLP-04)

`GET /api/documents/:documentId/text` serves **masked text by default**. `?unmask=true` re-composes only through the gate ladder: valid unmask param → workspace toggle on → `resolveWorkspaceRole` + `dlp:unmask` permission. Every miss arm returns masked text (200) — the endpoint is never an entitlement oracle. The UI toggle renders only for permitted users on documents with entities (DOM-absence), is per-view, and is never persisted.

## Audit matrix (SC-4)

Every read path is pinned by a behavioral test in `dlpReadPathMatrix.test.ts` (18 rows): text view, OCR preview, synthesis, citations, widget RAG, MCP tools, FTS, exports, KB copy-from-doc, admin re-embed. Widget/citations/MCP carry hard-never negative pins (masked, never re-composed).