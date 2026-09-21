// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Server-side document PII scan-and-mask core (Phase 192 plan 02 —
 * D-01/D-02/D-03).
 *
 * scanDocument(documentId): normalize → 3-tier scan (regex via
 * getActiveCompiledPatterns + checksum via dlpChecksum + LLM NER via
 * dlpNer/ollama) → document-wide placeholder map → mask chunkText →
 * persist masked chunks + FTS rewrite (dlpDocumentMasking) → reembed masked
 * text (collector /api/ingest/reembed) → entity rows with encrypted
 * originals (dlpEntityService) → dlpScannedAt/dlpScanState markers.
 *
 * Scan state rides dlpScannedAt + dlpScanState (never Document.status —
 * research scan-states recommendation). Per-doc failure marks
 * dlpScanState="failed" and RETHROWS — the pg-boss job layer (plan 04)
 * catches and resolves WITHOUT a retry storm.
 */
import prisma, { withSoftDelete } from "../utils/prisma";
import { logger } from "../utils/logger";
import { scanWithPatterns, type ScanPattern, type DLPResult } from "./dlpFilter";
import { getActiveCompiledPatterns } from "./dlpPatternService";
import { isValidCodiceFiscale, isValidPartitaIva, isValidIban } from "./dlpChecksum";
import { resolveNerProvider, runNerOnChunk } from "./dlpNer";
import { applyMaskedChunks, callMaskedReembed, type MaskedChunk } from "./dlpDocumentMasking";
import { writeEntityMap, type DlpEntityMapEntry } from "./dlpEntityService";
import { resolveProviderConfig } from "./providerService";
import {
  DLP_ENTITY_CLASSES,
  type DlpEntityClass,
  type DlpScanJobPayload,
} from "@simmetric-chat/shared";
import { dlpScanJobPayloadSchema } from "@simmetric-chat/shared";

// The $queryRaw-site disposition comment for the masked-chunk UPDATE lives in
// dlpDocumentMasking.ts (the write site) — carried verbatim from the
// documents.ts:1379-1385 precedent. scanDocument upstream guarantees the
// org-asserted scoped read feeding it (see step 1 below).

// Placeholder-guard regex (D-03): [CLASS_N] tokens are excluded from the
// pattern prefilter so already-masked text can never re-match (mask∘mask =
// mask, probe-verified in plan 01 fixtures). Bracket tokens are ALSO
// opaque to the LLM NER pass (dlpNer system prompt + postCheck drop arm).
const PLACEHOLDER_GUARD_REGEX = /\[[A-Z]+_\d+\]/g;

/** Entity-class lexical mapping for deterministic-tier hits. */
const GOV_ID_CLASS: DlpEntityClass = "GOV_ID";
const FINANCIAL_CLASS: DlpEntityClass = "FINANCIAL";
const CONTACT_CLASS: DlpEntityClass = "CONTACT";

/** Built-in pattern `type` → entity class (the deterministic tier). */
const BUILTIN_TYPE_TO_CLASS: Record<string, DlpEntityClass> = {
  it_codice_fiscale: GOV_ID_CLASS,
  it_vat_iva: GOV_ID_CLASS,
  iban: FINANCIAL_CLASS,
  email: CONTACT_CLASS,
  eu_phone: CONTACT_CLASS,
  credit_card: FINANCIAL_CLASS,
  ssn: GOV_ID_CLASS,
};

/**
 * Default lexical patterns for the deterministic tier when the org pattern
 * read FAILS entirely (graceful degradation — NEVER degrade to "no scan";
 * mirrors dlpFilter.scanContentAsync's built-in fallback but for the
 * document path we must at least keep the IT identifier rails).
 * Names match the seeded built-in rows so checksum routing applies.
 */
const FALLBACK_SCAN_PATTERNS: ScanPattern[] = [
  {
    type: "it_codice_fiscale",
    regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gu,
    replacement: "[GOV_ID]",
  },
  {
    type: "it_vat_iva",
    regex: /\b(?:P\.\s?IVA\.?|Partita\s+IVA)[:\s]*(?:IT)?\s?([0-9]{11})\b/gu,
    replacement: "[GOV_ID]",
  },
  {
    type: "iban",
    regex: /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/gu,
    replacement: "[FINANCIAL]",
  },
  {
    type: "email",
    regex: /(?<![\p{L}\p{N}_])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?![\p{L}\p{N}_])/gu,
    replacement: "[CONTACT]",
  },
];

/**
 * D-03 normalization pass — the document-wide identity key for entity
 * deduplication: uppercase, collapse whitespace, strip accents. Two
 * occurrences of the same normalized value share ONE placeholder number.
 */
export function normalizeForEntityMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accent combining marks
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** One raw match from any tier, positioned in the document-wide text. */
export interface ScanEntityMatch {
  matchedText: string;
  type: string; // pattern type / "checksum:<CF|PIVA|IBAN>" / NER entityClass
  entityClass: DlpEntityClass;
  index: number; // offset in the document-wide (chunk-concatenated) text
  confidence: "high" | "low";
  source: "regex" | "checksum" | "ner";
}

export interface PlaceholderAssignment {
  placeholder: string; // e.g. "[PERSON_1]"
  entityClass: DlpEntityClass;
  normalizedValue: string;
  /** First representative original text (for the encrypted entity row). */
  representative: string;
  occurrences: number;
  firstIndex: number;
}

/**
 * D-03 — document-wide placeholder map. Instance numbers are assigned PER
 * CLASS ordered by first occurrence index AFTER dedupe-by-normalized-value:
 * two occurrences of the same normalized value (case/whitespace/accent
 * normalized) share one placeholder; a CF in chunk 1 and chunk 9 gets the
 * SAME [GOV_ID_N]. Deterministic on re-run (ordering by first occurrence).
 */
export function buildPlaceholderMap(
  matches: ScanEntityMatch[],
): Map<string, PlaceholderAssignment> {
  // Key: normalized value + class → assignment. Dedupe by normalized value
  // (per research: "identical normalized entity text gets the SAME number").
  const byKey = new Map<string, PlaceholderAssignment>();
  for (const m of matches) {
    const normalized = normalizeForEntityMatch(m.matchedText);
    const key = `${m.entityClass}\u0000${normalized}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      // Keep the earliest firstIndex (deterministic ordering).
      if (m.index < existing.firstIndex) existing.firstIndex = m.index;
      continue;
    }
    byKey.set(key, {
      placeholder: "", // assigned below, after ordering
      entityClass: m.entityClass,
      normalizedValue: normalized,
      representative: m.matchedText,
      occurrences: 1,
      firstIndex: m.index,
    });
  }

  // Number per class by firstIndex (stable across re-runs).
  const counters = new Map<DlpEntityClass, number>();
  const sorted = [...byKey.values()].sort((a, b) => {
    if (a.entityClass !== b.entityClass) {
      return DLP_ENTITY_CLASSES.indexOf(a.entityClass) - DLP_ENTITY_CLASSES.indexOf(b.entityClass);
    }
    return a.firstIndex - b.firstIndex;
  });
  for (const assignment of sorted) {
    const next = (counters.get(assignment.entityClass) ?? 0) + 1;
    counters.set(assignment.entityClass, next);
    assignment.placeholder = `[${assignment.entityClass}_${next}]`;
  }
  return byKey;
}

/**
 * Mask `text` by replacing match spans with their document-wide placeholders.
 *
 * Idempotency strategy (D-03, Pitfall 5): matches are sorted DESCENDING by
 * index and each span is replaced ONCE per pass on a fresh string — no
 * re-scan of the replaced text happens inside this function, so
 * mask(mask(x)) === mask(x) holds structurally (the re-run finds only
 * placeholder tokens, which the prefilter excludes).
 *
 * Overlapping spans: adjacent matches inside one span (checksum-adjacency
 * edge) are merged upstream — overlapping matches with identical spans are
 * deduped, and nested duplicates collapse because replacement is single-pass
 * left-to-right over disjoint spans.
 */
export function maskWithPlaceholders(
  text: string,
  matches: ScanEntityMatch[],
  placeholderMap: Map<string, PlaceholderAssignment>,
): string {
  if (matches.length === 0) return text;

  // Resolve each match to its placeholder (same dedupe key as the map build).
  interface Span {
    start: number;
    end: number;
    placeholder: string;
  }
  const spans: Span[] = [];
  for (const m of matches) {
    const normalized = normalizeForEntityMatch(m.matchedText);
    const key = `${m.entityClass}\u0000${normalized}`;
    const assignment = placeholderMap.get(key);
    if (!assignment) continue;
    spans.push({ start: m.index, end: m.index + m.matchedText.length, placeholder: assignment.placeholder });
  }
  if (spans.length === 0) return text;

  // Sort descending and walk: skip any span overlapping an already-taken
  // span (adjacent/overlapping matches are MERGED into one occurrence —
  // one entity occurrence per class, never double-counted).
  spans.sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    if (span.end > lastStart) continue; // overlaps a span already replaced
    out = out.slice(0, span.start) + span.placeholder + out.slice(span.end);
    lastStart = span.start;
  }
  return out;
}

/**
 * The placeholder prefilter (D-03): text with [PERSON_1]-style tokens gets
 * ZERO new matches in the scan pass — the guard runs BEFORE the pattern
 * passes and the tokens simply do not match any PII pattern (probe-verified
 * in plan 01). This function is the explicit proof seam used by tests.
 */
export function hasPlaceholderTokens(text: string): boolean {
  PLACEHOLDER_GUARD_REGEX.lastIndex = 0;
  return PLACEHOLDER_GUARD_REGEX.test(text);
}

interface ScanChunkRow {
  id: string;
  chunkText: string;
  embeddingId: string;
  metadata: string | null;
}

/**
 * Validate a pg-boss payload against the shared schema (T-192-11): a forged
 * payload fails validation → the handler degrades to a no-op skip, never a
 * cross-org write (the document re-read below is org-scoped regardless).
 */
export function parseScanJobPayload(data: unknown): DlpScanJobPayload | null {
  const safe = dlpScanJobPayloadSchema.safeParse(data);
  return safe.success ? safe.data : null;
}

/**
 * Deterministic tier routing: pattern type → checksum validation.
 * CF/PIVA/IBAN regex hits run through dlpChecksum — checksum-valid are
 * high-confidence; checksum-invalid-but-regex-matching are ALSO masked,
 * tagged lower-confidence (research Pitfall 2 two-tier policy: masking is
 * not skipped on checksum failure, only confidence is lowered).
 */
function checksumTier(
  matchedText: string,
  type: string,
): { entityClass: DlpEntityClass; confidence: "high" | "low"; source: "regex" | "checksum" } {
  if (type === "it_codice_fiscale" || type === "ssn") {
    // ssn's shape is US-only; CF routing is for the IT pattern.
    if (type === "it_codice_fiscale") {
      const valid = isValidCodiceFiscale(matchedText);
      return {
        entityClass: GOV_ID_CLASS,
        confidence: valid ? "high" : "low",
        source: valid ? "checksum" : "regex",
      };
    }
  }
  if (type === "it_vat_iva") {
    const digits = matchedText.replace(/[^0-9]/g, "").slice(-11);
    const valid = digits.length === 11 && isValidPartitaIva(digits);
    return {
      entityClass: GOV_ID_CLASS,
      confidence: valid ? "high" : "low",
      source: valid ? "checksum" : "regex",
    };
  }
  if (type === "iban") {
    const compact = matchedText.replace(/\s+/g, "");
    const valid = isValidIban(compact);
    return {
      entityClass: FINANCIAL_CLASS,
      confidence: valid ? "high" : "low",
      source: valid ? "checksum" : "regex",
    };
  }
  // Non-checksum lexical patterns (email, credit_card, …): regex source.
  const cls = BUILTIN_TYPE_TO_CLASS[type] ?? GOV_ID_CLASS;
  return { entityClass: cls, confidence: "high", source: "regex" };
}

/**
 * NER prefilter lexical triggers (research A5): address markers or
 * capitalized-word density — chunks with these (or with zero deterministic
 * hits) go to the LLM; others are skipped (cost gate, T-192-07).
 */
function hasLexicalNerTrigger(text: string): boolean {
  // Italian address markers
  if (/\b(Via|Corso|Piazza|Viale|Piazza|Largo|Via\/Piazza)\b/u.test(text)) return true;
  // Capitalized-word density: >= 2 capitalized words mid-text suggests names.
  const capitalized = text.match(/(?:^|[\s,.:;!?()[\]"])([A-ZÀÈÉÌÒÙ][a-zà-ù']{2,})/gu);
  return (capitalized?.length ?? 0) >= 2;
}

/**
 * THE orchestrator (D-01/D-02/D-03). Sequence:
 * 1. org-asserted withSoftDelete scoped read (doc + chunks + workspace);
 *    soft-deleted doc → skip + log (race guard, T-192-08).
 * 2. Workspace toggle OFF → skip (no-op).
 * 3. Deterministic tier over chunk texts (prefilter: placeholder guard FIRST
 *    — already-masked chunks never re-match).
 * 4. Checksum routing (two-tier confidence policy, Pitfall 2).
 * 5. NER pass on chunks with lexical triggers or zero deterministic hits
 *    (cost gate — T-192-07).
 * 6. Document-wide placeholder map (D-03) + mask every chunk.
 * 7. applyMaskedChunks (FTS UPDATE) → callMaskedReembed (D-06/D-07).
 * 8. writeEntityMap (encrypted originals, D-04).
 * 9. Markers: dlpScannedAt=now, dlpScanState = entities>0 ? "scanned" :
 *    "clean". Any thrown error → dlpScanState="failed" + rethrow.
 */
export async function scanDocument(documentId: string): Promise<void> {
  try {
    // Org-asserted scoped read (T-192-05/T-192-08): withSoftDelete +
    // deletedAt: null — soft-deleted docs skip (scan-bypass race guard).
    const doc = await prisma.document.findFirst({
      where: withSoftDelete({ id: documentId, deletedAt: null }),
      include: {
        workspace: { select: { id: true, dlpDocumentScanEnabled: true } },
        chunks: {
          orderBy: { id: "asc" },
        },
      },
    });

    if (!doc) {
      logger.info(`[dlp-scan] Document ${documentId} not found (or deleted) — scan skipped`);
      return;
    }

    // Per-consume toggle re-read (the row was just read — same read, no cache).
    if (!doc.workspace?.dlpDocumentScanEnabled) {
      logger.info(`[dlp-scan] Workspace DLP toggle off for document ${documentId} — scan skipped`);
      return;
    }

    // Idempotency marker (D-12): an already-scanned doc is NOT re-scanned by
    // the backfill arm; the live-scan enqueue arms clear the marker.
    if (doc.dlpScannedAt) {
      logger.info(`[dlp-scan] Document ${documentId} already scanned (dlpScannedAt set) — scan skipped`);
      return;
    }

    // Mark scanning start (UX state; the marker column is the truth).
    await prisma.document.update({
      where: { id: doc.id },
      data: { dlpScanState: "scanning" },
    });

    // ── Tier 1: deterministic regex over the chunk texts ──────────────────
    let patterns: ScanPattern[];
    try {
      patterns = await getActiveCompiledPatterns(doc.organizationId);
    } catch (err: unknown) {
      // Graceful degradation (dlpFilter precedent): DB failure → built-in
      // rails — NEVER degrade to "no scan" (fail-open to deterministic tiers).
      logger.warn("[dlp-scan] pattern read failed — falling back to built-in IT patterns", {
        error: err instanceof Error ? err.message : String(err),
      });
      patterns = FALLBACK_SCAN_PATTERNS;
    }

    interface ChunkScanOutcome {
      chunk: ScanChunkRow;
      matches: ScanEntityMatch[];
      nerEligible: boolean;
      deterministicHits: number;
    }
    const chunkResults: ChunkScanOutcome[] = [];

    // NER provider resolved ONCE per document (the job calls this internally).
    const providerConfig = await resolveProviderConfig();
    const nerProvider = resolveNerProvider(providerConfig ?? null);

    // Document-wide offset base per chunk: chunks are read ordered by id
    // (asc = chunkIndex asc per the Bug A id alignment); each chunk's
    // base offset accumulates the previous chunk's length + separator so
    // match offsets are MONOTONIC document-wide (dedupe + ordering only —
    // the per-chunk masking consumes chunk-local indices).
    let offsetBase = 0;
    for (const chunk of doc.chunks) {
      const matches: ScanEntityMatch[] = [];

      // Prefilter: skip chunks that are ALREADY masked (idempotent re-runs).
      if (hasPlaceholderTokens(chunk.chunkText)) {
        chunkResults.push({ chunk, matches, nerEligible: false, deterministicHits: 0 });
        offsetBase += chunk.chunkText.length + 1;
        continue;
      }

      // Tier 1 — lexical regex (org-scoped compiled patterns).
      let scan: DLPResult;
      try {
        scan = scanWithPatterns(chunk.chunkText, patterns);
      } catch (scanErr: unknown) {
        // Zero-length guards inside scanWithPatterns protect admin patterns;
        // any residual throw is contained per-chunk (one bad chunk never
        // fails the document).
        logger.warn(`[dlp-scan] regex tier failed for chunk ${chunk.id} — chunk skipped`, {
          error: scanErr instanceof Error ? scanErr.message : String(scanErr),
        });
        chunkResults.push({ chunk, matches, nerEligible: false, deterministicHits: 0 });
        offsetBase += chunk.chunkText.length + 1;
        continue;
      }

      // Checksum routing on the lexical hits (Tier 2).
      let deterministicHits = 0;
      for (const m of scan.matches) {
        const route = checksumTier(m.matchedText, m.type);
        matches.push({
          matchedText: m.matchedText,
          type: route.source === "checksum" ? `checksum:${m.type}` : m.type,
          entityClass: route.entityClass,
          index: offsetBase + m.index,
          confidence: route.confidence,
          source: route.source,
        });
        if (route.source === "checksum") deterministicHits += 1;
      }

      // Tier 3 — LLM NER (cost gate: only NER-eligible chunks). Chunks with
      // zero checksum-valid hits OR lexical triggers go to the LLM.
      const nerEligible =
        !!nerProvider &&
        (deterministicHits === 0 || hasLexicalNerTrigger(chunk.chunkText));
      if (nerEligible && nerProvider) {
        const nerEntries = await runNerOnChunk(chunk.chunkText, nerProvider);
        for (const entry of nerEntries) {
          const at = chunk.chunkText.indexOf(entry.text);
          if (at < 0) continue; // runNerOnChunk already guards; belt-and-braces
          matches.push({
            matchedText: entry.text,
            type: entry.entityClass,
            entityClass: entry.entityClass,
            index: offsetBase + at,
            confidence: "high",
            source: "ner",
          });
        }
      }

      chunkResults.push({ chunk, matches, nerEligible, deterministicHits });
      offsetBase += chunk.chunkText.length + 1;
    }

    // ── Document-wide entity merge + placeholder map (D-03) ────────────────
    // Each chunk's matches carry document-wide offsets (offsetBase
    // accumulation above), so numbering is stable across chunks (a CF in
    // chunk 1 and chunk 9 → the SAME [GOV_ID_N]). Overlapping spans from the
    // SAME chunk (checksum-adjacency edge) merge inside maskWithPlaceholders
    // — one entity occurrence per checksum class, never double-counted.
    const allMatches: ScanEntityMatch[] = [];
    for (const r of chunkResults) allMatches.push(...r.matches);
    const placeholderMap = buildPlaceholderMap(allMatches);

    // ── Mask every chunk ────────────────────────────────────────────────────
    // maskWithPlaceholders receives the DOCUMENT-WIDE matches but masks the
    // chunk-local text: per-chunk indices are recovered by subtracting the
    // chunk's offset base (deterministic — same accumulation as above).
    const maskedChunks: MaskedChunk[] = [];
    let base = 0;
    for (const r of chunkResults) {
      const chunkMatches = r.matches.map((m) => ({ ...m, index: m.index - base }));
      const masked = maskWithPlaceholders(r.chunk.chunkText, chunkMatches, placeholderMap);
      maskedChunks.push({
        id: r.chunk.id,
        chunkText: masked,
        embeddingId: r.chunk.embeddingId,
        metadata: r.chunk.metadata,
      });
      base += r.chunk.chunkText.length + 1;
    }

    // ── Order contract: mask-in-DB → reembed → entity rows ────────────────
    await applyMaskedChunks(doc, maskedChunks);
    await callMaskedReembed(doc, maskedChunks);

    // Entity rows (encrypted originals — D-04; the one-way door walked after
    // the checkpoint-approved decision).
    const entityEntries: DlpEntityMapEntry[] = [...placeholderMap.values()].map((a) => ({
      entityClass: a.entityClass,
      placeholder: a.placeholder,
      original: a.representative,
      occurrences: a.occurrences,
    }));
    if (entityEntries.length > 0) {
      await writeEntityMap(doc.id, entityEntries);
    }

    // ── Markers ─────────────────────────────────────────────────────────────
    await prisma.document.update({
      where: { id: doc.id },
      data: {
        dlpScannedAt: new Date(),
        dlpScanState: entityEntries.length > 0 ? "scanned" : "clean",
      },
    });
    logger.info(
      `[dlp-scan] Document ${doc.id} scanned: ${entityEntries.length} entities, masked ${maskedChunks.length} chunks`,
    );
  } catch (err: unknown) {
    // Per-doc failure → dlpScanState="failed" + RETHROW to the job layer
    // (the plan 04 consumer catches + resolves — no retry storm; the failed
    // marker prevents the backfill from re-enqueueing an already-failed doc
    // until an operator intervenes).
    try {
      await prisma.document.updateMany({
        where: { id: documentId },
        data: { dlpScanState: "failed" },
      });
    } catch (markErr: unknown) {
      logger.error("[dlp-scan] failed-state write also failed", {
        documentId,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
    logger.error("[dlp-scan] scan failed", {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Rethrow to the job layer (plan 04 consumer catches + resolves).
    throw err;
  }
}