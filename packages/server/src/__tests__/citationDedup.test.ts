// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for citationDedup (Phase 151, RAG-02).
 *
 * Covers:
 *  (a) wiki page + subsumed chunk (doc: key) → chunk dropped, page kept
 *  (b) pageSlug overlap (archive-fallback chunk vs wiki page) → chunk dropped
 *  (c) unrelated citations untouched (order preserved)
 *  (d) no wiki citations → no-op
 *  (e) tool citations WITHOUT pageSlug (memory-fallback path) are NOT treated
 *      as wiki citations
 *
 * filterGroundedCitations (260829-w5z) — grounding filter applied AFTER
 * dedupeCitations so "no further info" answers don't surface a document's
 * 5 lowest-relevance snippets:
 *  (a') per-documentId cap of 2 (top score / first occurrence)
 *  (b') chunk with zero lexical overlap with the response → dropped
 *  (c') citation without chunkText → ALWAYS kept (no evidence → no filter)
 *  (d') wiki/archive citations pass through the overlap filter
 *  (e') very short response (< 60 normalized chars) → all citations kept
 *  (f') chunk whose distinctive tokens appear in the response → kept
 *  (g') multi-language stopwords (260829-wtz): ru/fr/de/es/pt grammatical
 *       tokens don't count as grounding evidence; IT grounding unchanged
 */
import { dedupeCitations, filterGroundedCitations } from "../agent/citationDedup";
import type { SourceCitation } from "@simmetric-chat/shared";

function wikiPage(slug: string, sourceDocumentIds?: string[]): SourceCitation {
  return {
    documentId: "",
    documentName: slug,
    chunkText: "",
    score: 0,
    source: "tool",
    pageSlug: slug,
    ...(sourceDocumentIds ? { sourceDocumentIds } : {}),
  };
}

function ragChunk(documentId: string, name: string, extra?: Partial<SourceCitation>): SourceCitation {
  return {
    documentId,
    documentName: name,
    chunkText: "chunk text",
    score: 0.9,
    source: "rag",
    ...extra,
  };
}

describe("dedupeCitations", () => {
  it("(a) keeps wiki page, drops subsumed chunk (doc: key)", () => {
    const wiki = wikiPage("acme-corporation", ["doc-123"]);
    const chunk = ragChunk("doc-123", "ACME Corp.pdf");
    const unrelated = ragChunk("doc-456", "Other.pdf");

    const result = dedupeCitations([chunk, wiki, unrelated]);

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.documentName)).toEqual(["acme-corporation", "Other.pdf"]);
    // The wiki page is kept, the subsumed chunk dropped.
    expect(result[0]).toBe(wiki);
    expect(result[1]).toBe(unrelated);
  });

  it("(b) drops archive-fallback chunk when pageSlug overlaps wiki page", () => {
    const wiki = wikiPage("acme-corporation");
    const archiveChunk = ragChunk("", "acme-corporation", {
      source: "archive",
      pageSlug: "acme-corporation",
    });

    const result = dedupeCitations([archiveChunk, wiki]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(wiki);
  });

  it("(c) keeps non-overlapping rag_search citations in order", () => {
    const wiki = wikiPage("page-a", ["doc-1"]);
    const chunk1 = ragChunk("doc-2", "Doc 2");
    const chunk2 = ragChunk("doc-3", "Doc 3");

    const result = dedupeCitations([chunk1, wiki, chunk2]);

    expect(result).toHaveLength(3);
    expect(result.map((c) => c.documentName)).toEqual(["Doc 2", "page-a", "Doc 3"]);
  });

  it("(d) no wiki citations → no-op (all citations kept)", () => {
    const chunk1 = ragChunk("doc-1", "Doc 1");
    const chunk2 = ragChunk("doc-2", "Doc 2");

    const result = dedupeCitations([chunk1, chunk2]);

    expect(result).toHaveLength(2);
    expect(result).toEqual([chunk1, chunk2]);
  });

  it("(e) tool citations WITHOUT pageSlug (memory-fallback path) are NOT treated as wiki citations", () => {
    // The memory-fallback RAG path emits source: "tool" without pageSlug —
    // it must not claim keys, and must not be dropped.
    const memoryTool = {
      documentId: "doc-9",
      documentName: "memory-fallback",
      chunkText: "",
      score: 0,
      source: "tool" as const,
    };
    const chunk = ragChunk("doc-9", "Doc 9");

    const result = dedupeCitations([memoryTool, chunk]);

    // No wiki citation claimed doc:doc-9 → the rag chunk survives.
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(memoryTool);
    expect(result[1]).toBe(chunk);
  });

  it("keeps web/memory citations untouched even when keys overlap", () => {
    const wiki = wikiPage("page-a", ["doc-1"]);
    const web = { documentId: "doc-1", documentName: "web result", chunkText: "", score: 0, source: "web" as const };
    const memory = { documentId: "doc-1", documentName: "memory", chunkText: "", score: 0, source: "memory" as const };

    const result = dedupeCitations([web, memory, wiki]);

    expect(result).toHaveLength(3);
  });

  it("handles empty input", () => {
    expect(dedupeCitations([])).toEqual([]);
  });
});

describe("filterGroundedCitations", () => {
  it("(a) caps citations per documentId to 2 (highest score first) when all are grounded", () => {
    // 5 grounded chunks of the SAME document → cap is the deciding factor.
    const docChunks = [0, 1, 2, 3, 4].map((i) =>
      ragChunk("doc-quote", "Preventivo FOSCHI.pdf", {
        score: 0.015 + i * 0.001,
        pageNumber: i + 1,
        chunkText: `preventivo intestatario FOSCHI SIMONE impianto fotovoltaico pagina ${i + 1}`,
      }),
    );
    const response =
      "Non ci sono ulteriori dettagli. Il preventivo è intestatario FOSCHI SIMONE, impianto fotovoltaico da 8 kWp.";

    const result = filterGroundedCitations(docChunks, response);

    expect(result).toHaveLength(2);
    // The cap SELECTS the top-2 scored chunks (pages 5 and 4) but keeps
    // survivors in their original input order (pages 4 before 5).
    expect(result.map((c) => c.pageNumber)).toEqual([4, 5]);
  });

  it("(a2) cap keeps the FIRST 2 occurrences when scores are absent", () => {
    const c1 = ragChunk("doc-x", "Doc X.pdf", {
      score: undefined,
      chunkText: "consulenza contrattuale rinnovo canone locazione immobile registrato",
    });
    const c2 = ragChunk("doc-x", "Doc X.pdf", {
      score: undefined,
      chunkText: "contratto locazione rinnovo canone aggiornato scadenza dicembre",
    });
    const c3 = ragChunk("doc-x", "Doc X.pdf", {
      score: undefined,
      chunkText: "clausola risolutiva espressa contratto locazione morosità concedente",
    });
    const response =
      "Il rinnovo del canone di locazione è stato accordato: contratto aggiornato con scadenza dicembre e clausola risolutiva confermata dall'ufficio.";

    const result = filterGroundedCitations([c1, c2, c3], response);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(c1);
    expect(result[1]).toBe(c2);
  });

  it("(b) drops citation whose chunkText has zero overlap with the response", () => {
    const unrelated = ragChunk("doc-y", "Doc Y.pdf", {
      chunkText: "elenco sistemi同意_CLAUDE.md e delfinidelfini delfini bottlenose cetacei",
    });
    const response =
      "La risposta descrive tre fasi distinte: analisi del preventivo intestatario FOSCHI, verifica dei redditi, approvazione definitiva finale.";

    expect(filterGroundedCitations([unrelated], response)).toEqual([]);
  });

  it("(c) keeps citations without chunkText (no evidence → don't invent filters)", () => {
    const noChunk = ragChunk("doc-z", "Doc Z.pdf", {
      chunkText: undefined,
      pageNumber: 7,
    });
    const response =
      "Il documento descrive procedure amministrative complesse con requisiti dettagliati e scadenze precise indicate.";

    const result = filterGroundedCitations([noChunk], response);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(noChunk);
  });

  it("(d) keeps wiki (source: tool + pageSlug) and archive citations regardless of overlap", () => {
    const wiki = wikiPage("acme-corporation");
    const archivePage = ragChunk("", "acme-corporation", {
      source: "archive",
      pageSlug: "acme-corporation",
      chunkText: "contenuto completamente scollegato dalla risposta zanzariere girasoli elefanti",
    });
    const response =
      "Citazioni wiki e archivio conservano la loro identità propria indipendentemente dal contenuto mostrato qui.";

    const result = filterGroundedCitations([wiki, archivePage], response);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(wiki);
    expect(result[1]).toBe(archivePage);
  });

  it("(e) keeps all citations when the response is very short (< 60 normalized chars)", () => {
    const c1 = ragChunk("doc-s", "Doc S.pdf", { chunkText: "frammento totalmente scollegato palude roccia nebbia" });
    const response = "Non ho trovato altre info.";

    const result = filterGroundedCitations([c1], response);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(c1);
  });

  it("(f) keeps grounded chunk whose distinctive tokens appear in the response", () => {
    const grounded = ragChunk("doc-g", "Preventivo FOSCHI.pdf", {
      score: 0.4,
      pageNumber: 3,
      chunkText:
        "Contratto n. 2025-114 — preventivo intestatario FOSCHI SIMONE, impianto fotovoltaico da 8 kWp, via Roma 42.",
    });
    const response =
      "Il preventivo intestatario FOSCHI SIMONE riceve l'impianto fotovoltaico da 8 kWp: nessun'altra informazione aggiuntiva.";

    const result = filterGroundedCitations([grounded], response);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(grounded);
  });

  it("(f2) drops rag citations when overlap is below threshold (1 distinctive token, < 20%)", () => {
    const weak = ragChunk("doc-w", "Doc W.pdf", {
      chunkText: "girandole zanzariere mantice girasole brevetti colombari stagnola",
    });
    // Response is long enough; only "girasole" overlaps via substring "girandole".
    const response =
      "Le girandole del giardino girano al vento tutto il pomeriggio senza sosta, ma nessun documento pertinente è emerso qui.";

    expect(filterGroundedCitations([weak], response)).toEqual([]);
  });

  it("pins the full real-world incident: 5 same-doc citations, only one grounded → exactly that one survives", () => {
    const chunks = [0, 1, 2, 3, 4].map((i) =>
      ragChunk("doc-quote", "Preventivo FOSCHI.pdf", {
        score: 0.015 + i * 0.001,
        pageNumber: i + 1,
        chunkText:
          i === 4
            ? "preventivo intestatario FOSCHI SIMONE impianto fotovoltaico 8 kWp"
            : `frammento di pagina ${i + 1} con sole formalità amministrative e note di service non usate`,
      }),
    );
    const response =
      "Non ci sono ulteriori dettagli nel documento. Il preventivo è intestatario FOSCHI SIMONE per un impianto da 8 kWp.";

    const result = filterGroundedCitations(chunks, response);

    expect(result).toHaveLength(1);
    expect(result[0]?.pageNumber).toBe(5); // highest score, the grounded one
  });

  it("handles empty input and unions (empty citations, empty response)", () => {
    expect(filterGroundedCitations([], "una risposta qualsiasi abbastanza lunga qui.")).toEqual([]);
    const c = ragChunk("doc-1", "Doc 1.pdf", { chunkText: undefined });
    // Empty response < 60 normalized chars → short-circuit, keep all.
    expect(filterGroundedCitations([c], "")).toHaveLength(1);
  });

  // Multi-language stopwords (260829-wtz): ru/fr/de/es/pt grammatical tokens
  // must NOT count as distinctive grounding evidence. Each chunk = stopwords
  // that appear in the response + content words that DON'T — before the fix
  // the ≥2 stopword hits alone cleared the grounding gate (hits ≥2,
  // ratio ≥20%) and the chunk survived; now it must be dropped. Note
  // MIN_TOKEN_LENGTH = 4 gates tokens BEFORE the stopword set, so only
  // ≥4-char stopword forms are effective.

  it("(ru) drops chunk even though the response repeats its stopwords", () => {
    // Stopwords "этот", "такой" are echoed by the response; the content words
    // are absent — pre-fix the stopword hits counted toward grounding.
    const chunk = ragChunk("doc-ru", "Doc RU.pdf", {
      chunkText: "этот такой гидравлика-насос-9921фильтр",
    });
    const response =
      "Ответ повторяет обороты этот и такой несколько раз подряд, однако не приводит никаких конкретных данных или цифр по существу.";

    expect(filterGroundedCitations([chunk], response)).toEqual([]);
  });

  it("(ru) stopword tokens present in the response do NOT count toward grounding hits", () => {
    // Same pattern, different stopword set ("также", "чтобы", "который") —
    // the only tokens the response shares are stopwords → dropped.
    const chunk = ragChunk("doc-ru2", "Doc RU2.pdf", {
      chunkText: "также чтобы который турбина-ревизия-4128манометр",
    });
    const response =
      "В ответе встречаются также слова чтобы и который много раз, но ни одного реального термина из документа здесь нет.";

    expect(filterGroundedCitations([chunk], response)).toEqual([]);
  });

  it("(fr) drops chunk even though the response repeats its stopwords", () => {
    const chunk = ragChunk("doc-fr", "Doc FR.pdf", {
      chunkText: "dans cette entre leur chaudiere-condenseur-7734raccord",
    });
    const response =
      "La réponse reprend ces mots dans cette phrase, entre leur formulation habituelle, sans jamais citer de donnée technique précise.";

    expect(filterGroundedCitations([chunk], response)).toEqual([]);
  });

  it("(de) drops chunk even though the response repeats its stopwords", () => {
    const chunk = ragChunk("doc-de", "Doc DE.pdf", {
      chunkText: "eine einer werden damit waermepumpe-anlage-6612ventil",
    });
    const response =
      "Die Antwort enthält eine und einer sowie werden Formulierungen, damit bleibt sie ohne jegliche technische Angabe.";

    expect(filterGroundedCitations([chunk], response)).toEqual([]);
  });

  it("(es) drops chunk even though the response repeats its stopwords", () => {
    const chunk = ragChunk("doc-es", "Doc ES.pdf", {
      chunkText: "para como sobre cuando caldera-condensacion-5523válvula",
    });
    const response =
      "La respuesta usa para, como, sobre y cuando varias veces seguidas, para terminar sin ningún detalle concreto.";

    expect(filterGroundedCitations([chunk], response)).toEqual([]);
  });

  it("(pt) drops chunk even though the response repeats its stopwords", () => {
    const chunk = ragChunk("doc-pt", "Doc PT.pdf", {
      chunkText: "para como isso tambem bomba-calor-8812cobertura",
    });
    const response =
      "A resposta repete para, como, isso e tambem varias vezes porque sim, para no fim nao descrever nada concreto.";

    expect(filterGroundedCitations([chunk], response)).toEqual([]);
  });

  it("(it) regression: grounded IT chunk still kept after multi-language stopword expansion", () => {
    // Fixture reused verbatim from test (f) — the Italian fact words
    // (preventivo, intestatario, FOSCHI, impianto, fotovoltaico) must still
    // ground the citation; new-language stopwords must not weaken IT+EN
    // grounding behavior.
    const grounded = ragChunk("doc-g", "Preventivo FOSCHI.pdf", {
      score: 0.4,
      pageNumber: 3,
      chunkText:
        "Contratto n. 2025-114 — preventivo intestatario FOSCHI SIMONE, impianto fotovoltaico da 8 kWp, via Roma 42.",
    });
    const response =
      "Il preventivo intestatario FOSCHI SIMONE riceve l'impianto fotovoltaico da 8 kWp: nessun'altra informazione aggiuntiva.";

    const result = filterGroundedCitations([grounded], response);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(grounded);
  });
});
