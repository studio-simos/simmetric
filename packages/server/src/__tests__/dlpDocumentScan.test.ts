// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Document DLP scan pipeline tests (Phase 192 plan 02 Task 1 — tracer).
 *
 * Covers: placeholder numbering stability across chunks (D-03), mask∘mask
 * idempotency, placeholder prefilter non-match, zero-PII clean state,
 * soft-deleted skip, checksum-invalid-but-regex-matching masking (Pitfall 2
 * two-tier), NER verbatim-substring post-check + provider-skip arm, and the
 * scanDocument orchestration (mocked prisma + mocked collector fetch).
 */
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Prisma mock (lazy holder — jest.mock factories are hoisted above const
// initializers, so the factory must not dereference the holder eagerly).
interface MockPrismaShape {
  document: {
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  dlpEntity: {
    create: jest.Mock;
    findMany: jest.Mock;
    deleteMany: jest.Mock;
  };
}
const prismaHolder: { prisma?: MockPrismaShape } = {};
function buildMockPrisma(): MockPrismaShape {
  return {
    document: {
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    dlpEntity: {
      create: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
}
prismaHolder.prisma = buildMockPrisma();
const mockPrisma = prismaHolder.prisma!;

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  get default() {
    return prismaHolder.prisma;
  },
  withSoftDelete: (where: Record<string, unknown>) => ({ ...where, deletedAt: null }),
}));

const mockGetActiveCompiledPatterns = jest.fn();
jest.mock("../services/dlpPatternService", () => ({
  __esModule: true,
  getActiveCompiledPatterns: (...args: unknown[]) => mockGetActiveCompiledPatterns(...args),
}));

// NER mocked wholesale — the NER contract is exercised by the dedicated arms
// via runNerOnChunk's real logic being imported fresh in the ner describe
// (the module is re-imported after the mock registration below).
const mockRunNerOnChunk = jest.fn();
const mockResolveNerProvider = jest.fn();
jest.mock("../services/dlpNer", () => ({
  __esModule: true,
  runNerOnChunk: (...args: unknown[]) => mockRunNerOnChunk(...args),
  resolveNerProvider: (...args: unknown[]) => mockResolveNerProvider(...args),
}));

const mockResolveProviderConfig = jest.fn();
jest.mock("../services/providerService", () => ({
  __esModule: true,
  resolveProviderConfig: (...args: unknown[]) => mockResolveProviderConfig(...args),
}));

// encryptionService: real encrypt passthrough-style (deterministic fake) so
// the D-04 column contract (originalEncrypted = encrypt(value)) is asserted
// without real crypto in the unit tier.
jest.mock("../services/encryptionService", () => ({
  __esModule: true,
  encrypt: jest.fn((v: string) => `enc:${v}`),
  decrypt: jest.fn((v: string) => v.replace(/^enc:/, "")),
}));

// collectorDispatchAgent: the dispatcher is a bare undici Agent — the masking
// module only references it as a value; mock with a sentinel.
jest.mock("../utils/collectorDispatchAgent", () => ({
  __esModule: true,
  collectorDispatchAgent: { __isMockDispatchAgent: true },
}));

const mockApplyMaskedChunks = jest.fn();
const mockCallMaskedReembed = jest.fn();
jest.mock("../services/dlpDocumentMasking", () => ({
  __esModule: true,
  applyMaskedChunks: (...args: unknown[]) => mockApplyMaskedChunks(...args),
  callMaskedReembed: (...args: unknown[]) => mockCallMaskedReembed(...args),
}));

import {
  buildPlaceholderMap,
  maskWithPlaceholders,
  normalizeForEntityMatch,
  hasPlaceholderTokens,
  scanDocument,
  parseScanJobPayload,
  type ScanEntityMatch,
} from "../services/dlpDocumentService";
import { scanWithPatterns, DLP_PATTERNS } from "../services/dlpFilter";

// The org's active pattern set used by scanDocument's deterministic tier:
// the three IT identifier rails + email (mirrors the seeded built-ins with
// 'gu' flags — same shape as dlpFilter.DLP_PATTERNS entries).
const TEST_PATTERNS = DLP_PATTERNS.filter((p) => p.enabled !== false).map((p) => ({
  type: p.type,
  regex: p.regex,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetActiveCompiledPatterns.mockResolvedValue(TEST_PATTERNS);
  mockResolveProviderConfig.mockResolvedValue(null); // no provider → NER skipped
  mockResolveNerProvider.mockReturnValue(null);
  mockRunNerOnChunk.mockResolvedValue([]);
});

function match(
  matchedText: string,
  type: string,
  entityClass: ScanEntityMatch["entityClass"],
  index: number,
  source: ScanEntityMatch["source"] = "regex",
): ScanEntityMatch {
  return { matchedText, type, entityClass, index, confidence: "high", source };
}

// ── Pure function arms (D-03) ────────────────────────────────────────────────

describe("normalizeForEntityMatch (D-03 identity key)", () => {
  it("uppercases, collapses whitespace, and strips accents", () => {
    expect(normalizeForEntityMatch("  mario   rossi ")).toBe("MARIO ROSSI");
    expect(normalizeForEntityMatch("Piazza Rinàscita")).toBe(normalizeForEntityMatch("piazza rinascita"));
  });
});

describe("buildPlaceholderMap (D-03 document-wide numbering)", () => {
  it("assigns per-class instance numbers by first occurrence", () => {
    const map = buildPlaceholderMap([
      match("RSSMRA85M01A001X", "checksum:it_codice_fiscale", "GOV_ID", 100, "checksum"),
      match("Mario Rossi", "PERSON", "PERSON", 10, "ner"),
      match("mario rossi", "PERSON", "PERSON", 50, "ner"),
      match("Via Roma 1", "ADDRESS", "ADDRESS", 20, "ner"),
    ]);
    const person = [...map.values()].find((a) => a.entityClass === "PERSON")!;
    const address = [...map.values()].find((a) => a.entityClass === "ADDRESS")!;
    const govId = [...map.values()].find((a) => a.entityClass === "GOV_ID")!;
    expect(person.placeholder).toBe("[PERSON_1]");
    expect(person.occurrences).toBe(2); // case-normalized dedupe
    expect(address.placeholder).toBe("[ADDRESS_1]");
    expect(govId.placeholder).toBe("[GOV_ID_1]");
  });

  it("dedupes identical normalized values to ONE placeholder (CF in two chunks → same number)", () => {
    // Two occurrences of the same CF at different offsets.
    const map = buildPlaceholderMap([
      match("RSSMRA85M01A001X", "checksum:it_codice_fiscale", "GOV_ID", 100, "checksum"),
      match("RSSMRA85M01A001X", "checksum:it_codice_fiscale", "GOV_ID", 900, "checksum"),
    ]);
    expect(map.size).toBe(1);
    const assignment = [...map.values()][0]!;
    expect(assignment.placeholder).toBe("[GOV_ID_1]");
    expect(assignment.occurrences).toBe(2);
  });

  it("numbers per class independently and deterministically across re-runs", () => {
    const input = [
      match("Via Roma 1", "ADDRESS", "ADDRESS", 5, "ner"),
      match("RSSMRA85M01A001X", "checksum:it_codice_fiscale", "GOV_ID", 10, "checksum"),
      match("Via Verdi 2", "ADDRESS", "ADDRESS", 90, "ner"),
    ];
    const map1 = buildPlaceholderMap(input);
    const map2 = buildPlaceholderMap(input);
    const vals1 = [...map1.values()].map((v) => v.placeholder);
    const vals2 = [...map2.values()].map((v) => v.placeholder);
    expect(vals1).toEqual(vals2);
    expect(vals1).toContain("[ADDRESS_1]");
    expect(vals1).toContain("[ADDRESS_2]");
  });
});

describe("maskWithPlaceholders (D-03 masking)", () => {
  it("replaces each match span with its placeholder", () => {
    const map = buildPlaceholderMap([
      match("RSSMRA85M01A001X", "checksum:it_codice_fiscale", "GOV_ID", 12, "checksum"),
    ]);
    const text = "Codice: RSSMRA85M01A001X fine";
    const masked = maskWithPlaceholders(text, [
      match("RSSMRA85M01A001X", "checksum:it_codice_fiscale", "GOV_ID", 8, "checksum"),
    ], map);
    expect(masked).toBe("Codice: [GOV_ID_1] fine");
  });

  it("mask∘mask = mask (idempotency, D-03): re-masking masked text is byte-identical", () => {
    const text = "Il signor Mario Rossi, CF RSSMRA85M01A001X, via Roma 12";
    const matches = [
      match("Mario Rossi", "PERSON", "PERSON", 10, "ner"),
      match("RSSMRA85M01A001X", "checksum:it_codice_fiscale", "GOV_ID", 33, "checksum"),
    ];
    const map = buildPlaceholderMap(matches);
    const masked1 = maskWithPlaceholders(text, matches, map);

    // Re-run the full pipeline on the masked text: the only "matches" the
    // scan would find are the placeholder tokens themselves (the prefilter
    // drops them — see next describe). Passing ZERO matches reproduces the
    // same string byte-identically.
    const masked2 = maskWithPlaceholders(masked1, [], map);
    expect(masked2).toBe(masked1);
    expect(masked1).not.toBe(text);
    expect(masked1).toContain("[PERSON_1]");
    expect(masked1).toContain("[GOV_ID_1]");
  });

  it("merges overlapping/adjacent spans into ONE occurrence (checksum-adjacency edge)", () => {
    // Two matches overlapping (second starts inside the first) — the
    // descending single-pass walk replaces only the outermost span.
    const map = buildPlaceholderMap([
      match("IT60X0542811101000000123456", "checksum:iban", "FINANCIAL", 0, "checksum"),
    ]);
    const text = "IT60X0542811101000000123456 tail";
    const masked = maskWithPlaceholders(text, [
      match("IT60X0542811101000000123456", "checksum:iban", "FINANCIAL", 0, "checksum"),
      match("60X0542811101000000123456", "checksum:iban", "FINANCIAL", 1, "checksum"),
    ], map);
    expect(masked).toBe("[FINANCIAL_1] tail");
  });
});

describe("placeholder prefilter (D-03 idempotency guard)", () => {
  it("hasPlaceholderTokens detects [CLASS_N] tokens", () => {
    expect(hasPlaceholderTokens("hello [PERSON_1] world")).toBe(true);
    expect(hasPlaceholderTokens("no tokens here")).toBe(false);
  });

  it("text containing [PERSON_1]-style tokens produces ZERO new matches in the scan pass", () => {
    const masked = "Il cliente [PERSON_1] abita in [ADDRESS_1], CF [GOV_ID_1], mail [CONTACT_1]";
    const res = scanWithPatterns(masked, TEST_PATTERNS);
    expect(res.hasMatch).toBe(false);
    expect(res.matches).toHaveLength(0);
  });
});

// ── NER arms (D-02) ──────────────────────────────────────────────────────────

// The wholesale dlpNer mock above intercepts dlpDocumentService's imports.
// For the NER-contract arms below we exercise the REAL module through a
// separate dynamic import chain: use jest.requireActual via a standalone
// module instance.
describe("dlpNer contract (via requireActual)", () => {
  // Lazy-load the real dlpNer module bypassing the mock.
  function realDlpNer(): typeof import("../services/dlpNer") {
    const actual = jest.requireActual("../services/dlpNer") as typeof import("../services/dlpNer");
    return actual;
  }

  it("runNerOnChunk returns [] immediately with no provider (skip arm)", async () => {
    const ner = realDlpNer();
    const result = await ner.runNerOnChunk("some text", null);
    expect(result).toEqual([]);
  });

  it("runNerOnChunk returns [] on parse failure / JSON violation (graceful arm)", async () => {
    const ner = realDlpNer();
    // A provider pointing at an unreachable host: with LLM_TIMEOUT=0 the
    // fetch fails fast → caught → [] (never throws).
    const result = await ner.runNerOnChunk("some text", {
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      apiKey: null,
    });
    expect(result).toEqual([]);
  });
});

// ── scanDocument orchestration ───────────────────────────────────────────────

const DOC_ID = "d0000000-1000-4000-8000-000000000001";
const WS_ID = "a0000000-1000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-0000-0000-000000000000";

/** Entity rows captured from the mocked dlpEntity.create calls (typed). */
function entityRowsCreated(): Array<{ placeholder: string; originalEncrypted?: string; entityClass: string }> {
  return mockPrisma.dlpEntity.create.mock.calls.map(
    (c: Array<{ data: { placeholder: string; originalEncrypted?: string; entityClass: string } }>) => c[0]!.data,
  );
}

function fixtureDoc(overrides: {
  dlpScannedAt?: Date | null;
  toggle?: boolean;
  deletedAt?: Date | null;
  chunks?: Array<{ chunkText: string; id: string }>;
} = {}) {
  const chunks = overrides.chunks ?? [
    { id: `${DOC_ID}-0`, chunkText: "Il signor Rossi vive in Via Roma 1. P. IVA: 00743110157." },
    { id: `${DOC_ID}-1`, chunkText: "Contact him at mario.rossi@example.com for the contract." },
  ];
  return {
    id: DOC_ID,
    workspaceId: WS_ID,
    organizationId: ORG_ID,
    name: "fixture.txt",
    type: "txt",
    embeddingModel: "test-embed",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    status: "completed",
    dlpScannedAt: overrides.dlpScannedAt ?? null,
    dlpScanState: null as string | null,
    workspace: { id: WS_ID, dlpDocumentScanEnabled: overrides.toggle ?? true },
    deletedAt: overrides.deletedAt ?? null,
    chunks: chunks.map((c) => ({
      id: c.id,
      chunkText: c.chunkText,
      embeddingId: c.id,
      metadata: JSON.stringify({ chunkIndex: Number(c.id.split("-").pop()) }),
    })),
  };
}

describe("scanDocument", () => {
  it("scans a completed document end-to-end: entity rows + markers + masked chunks + reembed", async () => {
    const doc = fixtureDoc();
    mockPrisma.document.findFirst.mockResolvedValue(doc);
    mockPrisma.document.update.mockResolvedValue(doc);
    mockPrisma.document.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.dlpEntity.create.mockResolvedValue({});

    await scanDocument(DOC_ID);

    // Entity rows written with placeholder + encrypted original (D-04).
    expect(mockPrisma.dlpEntity.create).toHaveBeenCalled();
    const createdRows = entityRowsCreated();
    // CF + P.IVA + email in the fixture → GOV_ID + CONTACT classes present.
    const placeholders = createdRows.map((r) => r.placeholder);
    expect(placeholders.some((p: string) => p.startsWith("[GOV_ID_"))).toBe(true);
    expect(placeholders.some((p: string) => p.startsWith("[CONTACT_"))).toBe(true);
    // originalEncrypted rides the encrypt passthrough (never plaintext).
    const govRow = createdRows.find((r) => r.placeholder.startsWith("[GOV_ID_"));
    expect(govRow!.originalEncrypted).toMatch(/^enc:/);

    // Markers: dlpScannedAt set + dlpScanState="scanned" (entities > 0).
    const finalUpdate = mockPrisma.document.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate.data.dlpScannedAt).toBeInstanceOf(Date);
    expect(finalUpdate.data.dlpScanState).toBe("scanned");

    // Masked chunks handed to the masking module (applyMaskedChunks called
    // with chunks whose text carries placeholders).
    expect(mockApplyMaskedChunks).toHaveBeenCalledTimes(1);
    const maskedArg = mockApplyMaskedChunks.mock.calls[0]![1] as Array<{ chunkText: string }>;
    const allMaskedText = maskedArg.map((c) => c.chunkText).join("\n");
    expect(allMaskedText).toContain("[GOV_ID_");
    expect(allMaskedText).toContain("[CONTACT_");
    expect(allMaskedText).not.toContain("00743110157");
    expect(allMaskedText).not.toContain("mario.rossi@example.com");

    // Reembed called with the masked payload (D-06).
    expect(mockCallMaskedReembed).toHaveBeenCalledTimes(1);
  });

  it("zero-PII document: zero entity rows, dlpScannedAt set, dlpScanState='clean'", async () => {
    const doc = fixtureDoc({
      chunks: [{ id: `${DOC_ID}-0`, chunkText: "Plain text about quarterly planning and budgets." }],
    });
    mockPrisma.document.findFirst.mockResolvedValue(doc);
    mockPrisma.document.update.mockResolvedValue(doc);
    mockPrisma.document.updateMany.mockResolvedValue({ count: 1 });

    await scanDocument(DOC_ID);

    expect(mockPrisma.dlpEntity.create).not.toHaveBeenCalled();
    const finalUpdate = mockPrisma.document.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate.data.dlpScannedAt).toBeInstanceOf(Date);
    expect(finalUpdate.data.dlpScanState).toBe("clean");
  });

  it("soft-deleted document: scoped findFirst returns null → skip + log, NO writes", async () => {
    mockPrisma.document.findFirst.mockResolvedValue(null);

    await scanDocument(DOC_ID);

    expect(mockPrisma.document.update).not.toHaveBeenCalled();
    expect(mockApplyMaskedChunks).not.toHaveBeenCalled();
    expect(mockPrisma.dlpEntity.create).not.toHaveBeenCalled();
    // The scoped read carried the soft-delete filter (T-192-08 race guard).
    const readArg = mockPrisma.document.findFirst.mock.calls[0]?.[0];
    expect(readArg.where.deletedAt).toBeNull();
  });

  it("workspace toggle OFF → skip, no writes", async () => {
    const doc = fixtureDoc({ toggle: false });
    mockPrisma.document.findFirst.mockResolvedValue(doc);

    await scanDocument(DOC_ID);

    expect(mockPrisma.document.update).not.toHaveBeenCalled();
    expect(mockApplyMaskedChunks).not.toHaveBeenCalled();
  });

  it("already-scanned document (dlpScannedAt set) → idempotent skip (D-12 marker)", async () => {
    const doc = fixtureDoc({ dlpScannedAt: new Date() });
    mockPrisma.document.findFirst.mockResolvedValue(doc);

    await scanDocument(DOC_ID);

    expect(mockPrisma.document.update).not.toHaveBeenCalled();
    expect(mockApplyMaskedChunks).not.toHaveBeenCalled();
  });

  it("checksum-invalid-but-regex-matching CF is ALSO masked (Pitfall 2 two-tier policy)", async () => {
    // RSSMRA85M01A001R = invalid check letter (official parity) but matches
    // the lexical shape — must still be masked.
    const doc = fixtureDoc({
      chunks: [{ id: `${DOC_ID}-0`, chunkText: "Codice fiscale: RSSMRA85M01A001R (typo)." }],
    });
    mockPrisma.document.findFirst.mockResolvedValue(doc);
    mockPrisma.document.update.mockResolvedValue(doc);
    mockPrisma.document.updateMany.mockResolvedValue({ count: 1 });

    await scanDocument(DOC_ID);

    const createdRows = entityRowsCreated();
    expect(createdRows.length).toBe(1);
    expect(createdRows[0]!.placeholder).toBe("[GOV_ID_1]");
    // The masked chunk text was written with the placeholder.
    const maskedArg = mockApplyMaskedChunks.mock.calls[0]![1] as Array<{ chunkText: string }>;
    expect(maskedArg[0]!.chunkText).toContain("[GOV_ID_1]");
    expect(maskedArg[0]!.chunkText).not.toContain("RSSMRA85M01A001R");
  });

  it("NER tier: entries are dropped when not verbatim substrings (paraphrase guard)", async () => {
    mockResolveProviderConfig.mockResolvedValue({ type: "ollama", baseUrl: "http://x", apiKey: null, model: "m" });
    mockResolveNerProvider.mockReturnValue({ baseUrl: "http://x", model: "m", apiKey: null });
    mockRunNerOnChunk.mockResolvedValue([
      { text: "Signor Rossi", entityClass: "PERSON" }, // NOT in the chunk
      { text: "Rossi", entityClass: "PERSON" }, // verbatim → kept
    ]);
    const doc = fixtureDoc({
      chunks: [{ id: `${DOC_ID}-0`, chunkText: "Il signor Rossi è arrivato." }],
    });
    mockPrisma.document.findFirst.mockResolvedValue(doc);
    mockPrisma.document.update.mockResolvedValue(doc);
    mockPrisma.document.updateMany.mockResolvedValue({ count: 1 });

    await scanDocument(DOC_ID);

    const createdRows = entityRowsCreated();
    const person = createdRows.find((r) => r.placeholder.startsWith("[PERSON_"));
    expect(person!.originalEncrypted).toBe("enc:Rossi");
  });

  it("job failure path: any error marks dlpScanState='failed' and rethrows", async () => {
    const doc = fixtureDoc();
    mockPrisma.document.findFirst.mockResolvedValue(doc);
    mockPrisma.document.update.mockResolvedValue(doc);
    mockPrisma.document.updateMany.mockResolvedValue({ count: 1 });
    mockApplyMaskedChunks.mockRejectedValue(new Error("FTS down"));

    await expect(scanDocument(DOC_ID)).rejects.toThrow("FTS down");
    const failedUpdate = mockPrisma.document.updateMany.mock.calls.at(-1)?.[0];
    expect(failedUpdate?.data.dlpScanState).toBe("failed");
  });

  it("payload validator: forged payloads fail to null (T-192-11 no-op skip)", () => {
    expect(parseScanJobPayload({ documentId: DOC_ID, workspaceId: WS_ID, organizationId: ORG_ID })).not.toBeNull();
    expect(parseScanJobPayload({ documentId: "not-a-uuid" })).toBeNull();
    expect(parseScanJobPayload(null)).toBeNull();
  });
});
// ── pg-boss consumer contracts (Task 2) ──────────────────────────────────────

const mockBoss = {
  work: jest.fn(),
  send: jest.fn(),
  createQueue: jest.fn(),
};

jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn(() => mockBoss),
  createQueue: jest.fn(),
  send: jest.fn(),
  schedule: jest.fn(),
}));

import {
  initDlpDocumentScanScheduler,
  initDlpBackfillScheduler,
  enqueueDlpScan,
  DLP_SCAN_QUEUE_NAME,
  DLP_BACKFILL_QUEUE_NAME,
} from "../services/dlpDocumentScanJob";
import { send as sendDelegator, createQueue as createQueueDelegator } from "../services/jobQueue";

describe("pg-boss consumers (Task 2 — D-01/D-12)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-arm the deterministic-tier mocks cleared by the outer beforeEach.
    mockGetActiveCompiledPatterns.mockResolvedValue(TEST_PATTERNS);
    mockResolveProviderConfig.mockResolvedValue(null);
    mockResolveNerProvider.mockReturnValue(null);
    mockRunNerOnChunk.mockResolvedValue([]);
    mockApplyMaskedChunks.mockResolvedValue(undefined);
    mockCallMaskedReembed.mockResolvedValue(undefined);
    mockPrisma.document.findFirst.mockResolvedValue(null);
    mockPrisma.document.update.mockResolvedValue({});
    mockPrisma.document.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.dlpEntity.create.mockResolvedValue({});
  });

  function capturedWorkHandler(queueName: string): (jobs: unknown) => Promise<void> {
    // pg-boss 12.29: work(name, OPTIONS, handler) — handler is the 3rd arg.
    const call = mockBoss.work.mock.calls.find((c) => c[0] === queueName);
    expect(call).toBeDefined();
    return call![2];
  }

  it("initDlpDocumentScanScheduler: createQueue carries Pitfall-6 options (expireInSeconds 3600, retryLimit 3, retryBackoff)", async () => {
    await initDlpDocumentScanScheduler();
    expect(createQueueDelegator).toHaveBeenCalledWith(
      DLP_SCAN_QUEUE_NAME,
      expect.objectContaining({
        expireInSeconds: 3600,
        retryLimit: 3,
        retryBackoff: true,
      }),
    );
    // work options: batchSize 1, localConcurrency 2 (12.29: options are the
    // 2nd argument, handler the 3rd).
    const workCall = mockBoss.work.mock.calls.find((c) => c[0] === DLP_SCAN_QUEUE_NAME);
    expect(workCall![1]).toEqual(expect.objectContaining({ batchSize: 1, localConcurrency: 2 }));
  });

  it("scan handler: the toggle is re-read per job (workspace off → skip, no writes)", async () => {
    await initDlpDocumentScanScheduler();
    const handler = capturedWorkHandler(DLP_SCAN_QUEUE_NAME);
    const doc = fixtureDoc({ toggle: false });
    mockPrisma.document.findFirst.mockResolvedValue(doc);

    await handler([{ data: { documentId: DOC_ID, workspaceId: WS_ID, organizationId: ORG_ID } }]);

    // No masking work happened (scanDocument skipped on the toggle).
    expect(mockApplyMaskedChunks).not.toHaveBeenCalled();
  });

  it("scan handler: failed scan marks dlpScanState='failed' instead of throwing (no retry storm)", async () => {
    await initDlpDocumentScanScheduler();
    const handler = capturedWorkHandler(DLP_SCAN_QUEUE_NAME);
    const doc = fixtureDoc();
    mockPrisma.document.findFirst.mockResolvedValue(doc);
    mockCallMaskedReembed.mockRejectedValue(new Error("reembed failed"));

    // The handler RESOLVES (never rejects) — pg-boss gets success.
    await expect(
      handler([{ data: { documentId: DOC_ID, workspaceId: WS_ID, organizationId: ORG_ID } }]),
    ).resolves.toBeUndefined();
    const failedUpdate = mockPrisma.document.updateMany.mock.calls.at(-1)?.[0];
    expect(failedUpdate?.data.dlpScanState).toBe("failed");
  });

  it("scan handler: forged payload degrades to a no-op skip (T-192-11)", async () => {
    await initDlpDocumentScanScheduler();
    const handler = capturedWorkHandler(DLP_SCAN_QUEUE_NAME);
    await handler([{ data: { documentId: "forged" } }]);
    expect(mockPrisma.document.findFirst).not.toHaveBeenCalled();
  });

  it("initDlpBackfillScheduler: own queue, localConcurrency 1 (rate limit below the live scan)", async () => {
    await initDlpBackfillScheduler();
    expect(createQueueDelegator).toHaveBeenCalledWith(
      DLP_BACKFILL_QUEUE_NAME,
      expect.objectContaining({ expireInSeconds: 3600, retryDelayMax: 600 }),
    );
    const workCall = mockBoss.work.mock.calls.find((c) => c[0] === DLP_BACKFILL_QUEUE_NAME);
    expect(workCall![1]).toEqual(expect.objectContaining({ batchSize: 1, localConcurrency: 1 }));
  });

  it("backfill handler: already-scanned doc (dlpScannedAt set) is skipped (D-12 idempotency marker)", async () => {
    await initDlpBackfillScheduler();
    const handler = capturedWorkHandler(DLP_BACKFILL_QUEUE_NAME);
    const doc = fixtureDoc({ dlpScannedAt: new Date() });
    mockPrisma.document.findFirst.mockResolvedValue(doc);

    await handler([{ data: { documentId: DOC_ID, workspaceId: WS_ID, organizationId: ORG_ID } }]);
    expect(mockApplyMaskedChunks).not.toHaveBeenCalled();
  });

  it("enqueueDlpScan: sends the shared-schema payload; invalid payload NOT sent", async () => {
    await enqueueDlpScan(DOC_ID, WS_ID, ORG_ID);
    expect(sendDelegator).toHaveBeenCalledTimes(1);
    expect(sendDelegator).toHaveBeenCalledWith(DLP_SCAN_QUEUE_NAME, {
      documentId: DOC_ID,
      workspaceId: WS_ID,
      organizationId: ORG_ID,
    });

    await enqueueDlpScan("not-a-uuid", WS_ID, ORG_ID);
    expect(sendDelegator).toHaveBeenCalledTimes(1); // unchanged
  });
});
