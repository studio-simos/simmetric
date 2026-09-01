// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * citationDedup — cross-fallback citation deduplication (Phase 151, RAG-02)
 * plus the grounding filter (260829-w5z), the two stages of the citation
 * pipeline.
 *
 * Pure functions, no DB access, no imports beyond the shared type. Run at the
 * two orchestrator citation-assembly points (orchestrator.ts runAgent +
 * runAgentStreaming) AFTER the `flatMap(tc.sources)` — the single choke point
 * where all tool-call citations converge before SSE emission and persistence.
 *
 * Stage 1 — dedupeCitations (Phase 151, RAG-02). Semantics (D-05, D-06):
 *  - Dedup at the CITATION layer, never the search layer (dedup before RRF
 *    breaks fusion math; chunks vs wiki pages are different units).
 *  - Wiki page wins, subsumed chunk dropped (wiki pages are synthesized —
 *    higher signal).
 *  - Deterministic structured keys ONLY: `page:<pageSlug>` and
 *    `doc:<documentId>` (from `Fonti: [[doc:<id>]]` frontmatter). Never text
 *    similarity (O(n²), non-deterministic, over/under-filters).
 *
 * Pass 1 claims keys from wiki citations — but ONLY from tool citations that
 * actually carry `pageSlug`/`sourceDocumentIds` (pageSlug-presence gating).
 * The `source === "tool"` marker is also used by the memory-fallback RAG path
 * and MCP skills, which must NOT be treated as wiki citations.
 *
 * Pass 2 drops rag_search citations whose `documentId` matches a claimed
 * `doc:` key or whose `pageSlug` matches a claimed `page:` key. Everything
 * else is kept in order.
 *
 * Stage 2 — filterGroundedCitations (260829-w5z). Citations attached to a
 * chat message must reflect sources the answer actually GROUNDS ON — not
 * everything any search tool happened to retrieve. Real-world incident: a
 * "no further info" answer displayed "Fonti (5)" of one document at ~1.5%
 * relevance, none of which the answer text used.
 *
 * Order matters: dedupe first (wiki wins, subsumed chunk dropped), THEN the
 * grounding filter — deterministic and unit-testable.
 *
 * filterGroundedCitations semantics (v1, pinned by unit tests):
 *  1. Per-documentId cap of 2 citations — top-2 by score (descending);
 *     absent/tied scores fall back to input order (first-2). Kills the
 *     "5 snippets of the same low-score document" noise pattern regardless
 *     of overlap.
 *  2. Overlap-grounding for chunk citations (wiki-like pass through): a
 *     citation is GROUNDED when its chunkText shares meaningful lexical
 *     overlap with the final response — distinctive tokens (normalized:
 *     lowercase, diacritics stripped, punctuation → space, whitespace
 *     collapsed; length ≥ 4, dedup, small multi-language stopword list
 *     inline — IT/EN + ru/fr/de/es/pt, matching the orchestrator's 8-locale
 *     output surface) counted present via cheap substring containment (model
 *     morphology toleration — NOT word-boundary). Grounded when hits ≥ 2
 *     AND hit-ratio ≥ 20% — the conservative conjunction (prefer keeping
 *     borderline citations over dropping real ones).
 *  3. Pass-through (never overlap-dropped):
 *     - wiki-like citations — `source === "tool"` with pageSlug, or
 *       `source === "archive"`, or pageSlug present (same wiki-identity
 *       gating as dedupeCitations pass 1): wiki pages render their own
 *       citation identity and their content often IS the referenced page
 *       even when paraphrased;
 *     - web / memory citations;
 *     - citations with missing/empty chunkText (no evidence → don't invent
 *       filters);
 *     - chunkText with zero distinctive tokens (all short/stopword).
 *  4. Short-circuit: final response < 60 normalized chars → keep all
 *     citations (too short to judge; likely a tool-status or error text).
 *
 * The incident example ("preventivo intestatario FOSCHI SIMONE, 8 kWp" vs
 * the chunk paste quote) stays grounded — the answer DID mention the
 * intestatario fact — while the duplicate low-score snippets of the same
 * document are removed by 1 + 2.
 */
import type { SourceCitation } from "@simmetric-chat/shared";

export function dedupeCitations(citations: SourceCitation[]): SourceCitation[] {
  const claimed = new Set<string>();

  // Pass 1: wiki pages claim first (D-05 — wiki wins, chunk dropped).
  for (const c of citations) {
    if (c.source !== "tool") continue;
    // pageSlug-presence gating: only citations that actually carry wiki
    // identity fields are treated as wiki citations. The memory-fallback
    // RAG path and MCP skills emit source: "tool" WITHOUT these fields.
    if (c.pageSlug) claimed.add(`page:${c.pageSlug}`);
    for (const id of c.sourceDocumentIds ?? []) {
      if (id) claimed.add(`doc:${id}`);
    }
  }

  // Pass 2: drop subsumed rag_search citations; keep everything else in order.
  return citations.filter((c) => {
    // Wiki/tool/web/memory citations are never dropped by this filter.
    if (c.source === "tool" || c.source === "web" || c.source === "memory") return true;
    if (c.documentId && claimed.has(`doc:${c.documentId}`)) return false;
    if (c.pageSlug && claimed.has(`page:${c.pageSlug}`)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// filterGroundedCitations (260829-w5z) — grounding filter, stage 2.
// ---------------------------------------------------------------------------

/** Distinctive-token minimum length: tokens shorter than this ("via",
 *  "kwp", "2025") are too generic or too numeric to trust as grounding
 *  evidence. */
const MIN_TOKEN_LENGTH = 4;

/** Grounding thresholds — conservative conjunction: a chunk citation is
 *  grounded only when it clears BOTH bars, so borderline chunks survive
 *  (fewer false drops > fewer noise citations, per the incident remedy). */
const MIN_GROUNDING_HITS = 2;
const MIN_GROUNDING_RATIO = 0.2;

/** Max citations kept per documentId. */
const MAX_PER_DOCUMENT = 2;

/** Responses shorter than this (normalized) are too short to judge — likely
 *  a tool-status or error text — so all citations are kept. */
const MIN_RESPONSE_CHARS = 60;

/** Multi-language inline stopword list (ru/fr/de/es/pt added in 260829-wtz).
 *  Intentionally conservative sizing — aggressive stopword pruning shrinks the
 *  distinctive-token pool and causes false drops, the failure mode this filter
 *  must avoid. Entries are lowercase + diacritics-stripped (the `normalizeText`
 *  form) and only useful at length ≥ MIN_TOKEN_LENGTH: `distinctiveTokens`
 *  applies that length gate BEFORE the stopword set lookup, so shorter
 *  entries (le, das, que, …) would be dead weight and are omitted. */
const STOPWORDS = new Set([
  // Italian
  "come", "quale", "quelli", "questo", "questa", "questi", "queste",
  "quello", "quella", "perche", "nello", "nelle", "nella", "sulla",
  "sullo", "sulle", "della", "delle", "dello", "degli", "dagli",
  "dalla", "dalle", "sono", "essere", "avere", "stato", "stata",
  "stati", "state", "molto", "dove", "quando", "senza", "sotto",
  "sopra", "quest", "oltre", "presso", "verso", "dopo", "prima",
  // English
  "which", "their", "there", "these", "those", "about", "would",
  "could", "should", "where", "while", "what", "when", "with",
  "from", "have", "been", "were", "into", "than", "then", "them",
  "they", "this", "that",
  // French
  "dans", "avec", "pour", "sont", "plus", "mais", "dont",
  "ainsi", "entre", "leur", "nous", "vous", "elle", "elles",
  "cette", "comme", "etre", "apres",
  // German
  "eine", "einem", "einen", "einer", "eines",
  "sind", "nicht", "auch", "wird", "werden", "wurde", "konnen",
  "sich", "uber", "beim", "damit",
  // Spanish
  "para", "como", "pero", "este", "esta", "estos", "estas",
  "tiene", "tienen", "sobre", "entre", "hasta", "desde",
  "cuando", "porque", "aqui",
  // Portuguese
  "para", "como", "mais", "sobre", "entre", "isso", "aquilo",
  "esse", "essa", "pelo", "pela", "pelos", "pelas",
  "tambem", "porque", "quando", "estao", "sendo",
  // Russian (Cyrillic passes \p{L} in normalizeText; only ≥4-char forms
  // survive MIN_TOKEN_LENGTH, so shorter ones are omitted here)
  "чтобы", "которые", "который", "этот", "это", "этого", "такой",
  "такие", "также", "больше", "всё", "всего", "был", "была",
  "были", "было", "есть", "этапа",
]);

/** Lowercase, strip diacritics, map punctuation to spaces, collapse
 *  whitespace. Used for both the short-response check and tokenization. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Distinctive tokens of a text: normalized words of length ≥
 * MIN_TOKEN_LENGTH, deduplicated, stopwords dropped. Input order preserved.
 */
function distinctiveTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const tok of normalizeText(text).split(" ")) {
    if (tok.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    tokens.push(tok);
  }
  return tokens;
}

/**
 * Wiki-identity gating — mirrors dedupeCitations pass 1: only citations
 * that actually carry wiki identity fields are treated as wiki citations
 * (the memory-fallback RAG path and MCP skills emit `source: "tool"`
 * WITHOUT them). Wiki pages render their own citation identity, and their
 * content often IS the referenced page even when paraphrased differently —
 * the overlap filter's target is the rag_search-at-1.5% noise case, not
 * wiki.
 */
function isWikiLike(c: SourceCitation): boolean {
  if (c.source === "archive") return true;
  return Boolean(c.pageSlug);
}

/**
 * Grounding check for a single chunk citation against the normalized final
 * response. A token is "present" via cheap substring containment (NOT
 * word-boundary — tolerates model morphology like plurals and suffixes).
 * Missing/empty chunkText and chunks with zero distinctive tokens are kept
 * (no evidence → don't invent filters).
 */
function isGrounded(c: SourceCitation, normalizedResponse: string): boolean {
  const chunkText = c.chunkText;
  if (!chunkText || chunkText.trim().length === 0) return true;

  const tokens = distinctiveTokens(chunkText);
  if (tokens.length === 0) return true;

  let hits = 0;
  for (const t of tokens) {
    if (normalizedResponse.includes(t)) hits++;
  }
  return hits >= MIN_GROUNDING_HITS && hits / tokens.length >= MIN_GROUNDING_RATIO;
}

/**
 * Stage 2 of the citation pipeline (after dedupeCitations): keep only
 * citations the final response actually grounds on.
 *
 * v1 rule (deterministic):
 *  (1) per-documentId cap of MAX_PER_DOCUMENT citations — top-N by score
 *      (descending); absent scores and ties fall back to input order
 *      (first-N);
 *  (2) overlap-grounding filter for chunk citations (wiki-like, web,
 *      memory pass through).
 *
 * Both stages keep survivors in their original relative input order.
 */
export function filterGroundedCitations(
  citations: SourceCitation[],
  finalResponse: string,
): SourceCitation[] {
  if (citations.length === 0) return [];

  const normalizedResponse = normalizeText(finalResponse);
  // Very short responses: too short to judge — likely a tool-status or
  // error text. Keep all citations.
  if (normalizedResponse.length < MIN_RESPONSE_CHARS) return [...citations];

  // (1) Per-documentId cap: for every documentId with more than the cap,
  // keep only the top-N by score (score ties / absent scores fall back to
  // input order). Citations without a documentId are never capped.
  const indexesToDrop = new Set<number>();
  const perDocIndexes = new Map<string, number[]>();
  for (let i = 0; i < citations.length; i++) {
    const docId = citations[i]?.documentId;
    if (!docId) continue;
    const list = perDocIndexes.get(docId);
    if (list) list.push(i);
    else perDocIndexes.set(docId, [i]);
  }
  for (const list of perDocIndexes.values()) {
    if (list.length <= MAX_PER_DOCUMENT) continue;
    const keep = new Set(
      list
        .slice()
        .sort((a, b) => {
          const sa = citations[a]?.score;
          const sb = citations[b]?.score;
          if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
          return a - b; // tie or absent score(s): input order wins
        })
        .slice(0, MAX_PER_DOCUMENT),
    );
    for (const i of list) {
      if (!keep.has(i)) indexesToDrop.add(i);
    }
  }
  const capped =
    indexesToDrop.size === 0 ? citations : citations.filter((_, i) => !indexesToDrop.has(i));
  if (capped.length === 0) return [];

  // (2) Overlap-grounding filter for chunk citations.
  return capped.filter((c) => {
    if (isWikiLike(c)) return true; // wiki/archive + pageSlug pass through
    if (c.source === "web" || c.source === "memory") return true;
    return isGrounded(c, normalizedResponse);
  });
}