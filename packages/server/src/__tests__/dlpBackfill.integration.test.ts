// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * dlpBackfill.integration.test.ts — DLP-06 integration twin (Phase 192
 * plan 06 Task 2 — real PostgreSQL :5434 via .env.test + jest globalSetup).
 *
 * Proves the DATA convergence of the legacy backfill (D-12) that the unit
 * battery cannot: the plan 02 scanDocument sequence, driven through plan 06's
 * per-document body (runBackfillDocument), converges on real Postgres —
 * masked chunkText persisted, BOTH tsvector columns recomputed from the
 * masked text, dlpScannedAt/dlpScanState markers set, entity rows written
 * with ENCRYPTED originals (the REAL AES-256-GCM chain — encryptionService is
 * NOT stubbed here), the reembed payload byte-equal to the stored masked
 * chunkText (placeholder-occurrence parity — probe edge encoding; byte-length
 * parity is deliberately NOT asserted anywhere per must_haves), idempotent
 * re-run via the dlpScannedAt marker, and the DLP-06 post-backfill audit
 * (research Pitfall 7) embedded as a real assertion: ZERO document_chunks
 * rows still carrying any ground-truth PII value.
 *
 * The reembed is captured at the HTTP boundary (global fetch swap — no
 * collector needed; the queue transport is unit-tested) and the twin drives
 * runBackfillDocument DIRECTLY, not through pg-boss.
 *
 * Ground-truth PII values reuse the COMMITTED DLP-05 eval fixtures (synthetic
 * Italian corpus — 01-anagrafica-cliente / 04-iban-bonifico; real docs never
 * enter the repo).
 *
 * Run: pnpm --filter server test:integration -- dlpBackfill.integration
 * (needs CREATEDB Postgres on :5434; excluded from `pnpm test` — Postgres-free
 * turbo invariant; jest.config.js testPathIgnorePatterns keeps it out).
 *
 * Real Prisma, NO partial mocks of the prisma singleton (per MEMORY
 * rag-empty-results-diagnosis-20260721 discipline, documentFtsBulkInsert
 * precedent). All service imports are dynamic inside beforeAll so the prisma
 * singleton binds to the per-file worker DATABASE_URL (jest.setup.integration).
 */

jest.setTimeout(60_000);

// Module marker: every other member of this file's top-level surface is a
// dynamic import, and a file without static import/export is compiled as a
// GLOBAL SCRIPT — its top-level `let` bindings would collide with the other
// integration twins' `let prisma` (TS2451). This export keeps it a module.
export {};

// Env floor (mirrors setupEnv.ts fallbacks — the integration config does not
// load .env.test; the root .env normally provides these, this keeps the twin
// deterministic when only the DB is provisioned).
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-for-unit-tests-32ch";
process.env.COLLECTOR_SECRET =
  process.env.COLLECTOR_SECRET ?? "test-collector-secret-for-unit-tests";

// Real Prisma client — do NOT mock. Bound in beforeAll AFTER
// jest.setup.integration.ts's beforeAll pins the worker DATABASE_URL.
let prisma: import("@prisma/client").PrismaClient;

// Services under test — dynamic imports (worker-DB binding, see header).
let countEligibleDocuments: (organizationId?: string) => Promise<number>;
let runBackfillDocument: (
  jobData: unknown,
) => Promise<"processed" | "skipped" | "invalid">;
let getEnv: typeof import("../config/env").getEnv;

// ── Ground truth (committed eval-fixture values — synthetic) ─────────────────

const PII_CF = "RSSMRA85M01A001X";
const PII_EMAIL = "marco.rossi@example.it";
const PII_IBAN = "IT60X0542811101000000123456";
const PII_VAT_DIGITS = "00743110157";

const PII_CHUNK_0 = `Contratto di assistenza.\nCodice Fiscale cliente: ${PII_CF}\nEmail: ${PII_EMAIL}`;
const PII_CHUNK_1 = `Coordinate bancarie per i pagamenti:\nIBAN: ${PII_IBAN}\nPartita IVA: IT${PII_VAT_DIGITS}`;

// Expected masked chunks — D-03 document-wide numbering: per-class counters in
// the shared DLP_ENTITY_CLASSES order (PERSON, ADDRESS, FINANCIAL, GOV_ID,
// CONTACT) by first occurrence. GOV_ID holds TWO entities (CF first; the VAT
// regex consumes the label into the match, so the masked span is the WHOLE
// label+number). Simulation-verified against the real tier sequence.
const EXPECTED_MASKED_CHUNK_0 = `Contratto di assistenza.\nCodice Fiscale cliente: [GOV_ID_1]\nEmail: [CONTACT_1]`;
const EXPECTED_MASKED_CHUNK_1 = `Coordinate bancarie per i pagamenti:\nIBAN: [FINANCIAL_1]\n[GOV_ID_2]`;

const ENTITY_ORIGINALS: Record<string, string> = {
  "[GOV_ID_1]": PII_CF,
  "[CONTACT_1]": PII_EMAIL,
  "[FINANCIAL_1]": PII_IBAN,
  "[GOV_ID_2]": `Partita IVA: IT${PII_VAT_DIGITS}`,
};

const CLEAN_CHUNK_0 =
  "Analisi dei dati aziendali del terzo trimestre. Il documento non contiene dati sensibili.";
const CLEAN_CHUNK_1 =
  "Riepilogo delle attivita pianificate per il prossimo ciclo di revisione interna.";

// ── Reembed capture (HTTP-boundary mock — no collector needed) ───────────────

interface CapturedReembed {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
const reembedCalls: CapturedReembed[] = [];
const originalFetch = globalThis.fetch;

// ── Seed state ────────────────────────────────────────────────────────────────

let orgId: string;
let userId: string;
let projectId: string;
let workspaceId: string;
let piiDocId: string;
let cleanDocId: string;
let markedDocId: string;
const MARKED_SCANNED_AT = new Date("2026-01-02T03:04:05.000Z");

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();

  const svc = await import("../services/dlpBackfillService");
  countEligibleDocuments = svc.countEligibleDocuments;
  runBackfillDocument = svc.runBackfillDocument;
  ({ getEnv } = await import("../config/env"));

  // Seed the tenant chain (org → user → project → workspace toggle ON).
  const org = await prisma.organization.create({
    data: { name: "DLP Backfill Twin Org", slug: "dlp-backfill-twin-org" },
  });
  orgId = org.id;
  const user = await prisma.user.create({
    data: {
      username: "dlp_twin_admin",
      email: "dlp_twin_admin@test.com",
      passwordHash: "integration-twin-no-login",
      salt: "twinsalt",
    },
  });
  userId = user.id;
  const project = await prisma.project.create({
    data: {
      name: "DLP Backfill Twin Project",
      organizationId: orgId,
      createdBy: userId,
    },
  });
  projectId = project.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: "DLP Backfill Twin Workspace",
      projectId,
      organizationId: orgId,
      dlpDocumentScanEnabled: true, // D-05 toggle ON — the backfill respects it
    },
  });
  workspaceId = workspace.id;

  // 3 legacy documents (probe edge: PII + clean + already-marked):
  // 1. PII doc — 2 chunks with ground-truth deterministic PII, no marker.
  const piiDoc = await prisma.document.create({
    data: {
      organizationId: orgId,
      workspaceId,
      name: "dlp-twin-pii.txt",
      type: "txt",
      filePath: "/tmp/dlp-twin-pii.txt",
      cacheKey: "dlp-twin-pii-cache",
      chunkCount: 2,
      status: "completed",
      embeddingModel: "test-embed-model",
    },
  });
  piiDocId = piiDoc.id;
  // 2. Clean doc — zero PII, no marker (the zero-entity "clean" outcome).
  const cleanDoc = await prisma.document.create({
    data: {
      organizationId: orgId,
      workspaceId,
      name: "dlp-twin-clean.txt",
      type: "txt",
      filePath: "/tmp/dlp-twin-clean.txt",
      cacheKey: "dlp-twin-clean-cache",
      chunkCount: 2,
      status: "completed",
      embeddingModel: "test-embed-model",
    },
  });
  cleanDocId = cleanDoc.id;
  // 3. Already-marked doc — dlpScannedAt set; carries PII so the suite can
  //    prove the marker guard left its UNMASKED text untouched.
  const markedDoc = await prisma.document.create({
    data: {
      organizationId: orgId,
      workspaceId,
      name: "dlp-twin-marked.txt",
      type: "txt",
      filePath: "/tmp/dlp-twin-marked.txt",
      cacheKey: "dlp-twin-marked-cache",
      chunkCount: 1,
      status: "completed",
      embeddingModel: "test-embed-model",
      dlpScannedAt: MARKED_SCANNED_AT,
      dlpScanState: "scanned",
    },
  });
  markedDocId = markedDoc.id;

  // Chunk rows — id = `${documentId}-${chunkIndex}` (Bug A alignment;
  // embeddingId === chunkId). tsvector columns left NULL: the scan's masked
  // UPDATE recomputes both, and the twin asserts the recomputation.
  await prisma.documentChunk.createMany({
    data: [
      {
        id: `${piiDocId}-0`,
        documentId: piiDocId,
        chunkText: PII_CHUNK_0,
        metadata: JSON.stringify({ paragraph: 0, charStart: 0, charEnd: PII_CHUNK_0.length }),
        embeddingId: `${piiDocId}-0`,
      },
      {
        id: `${piiDocId}-1`,
        documentId: piiDocId,
        chunkText: PII_CHUNK_1,
        metadata: JSON.stringify({ paragraph: 1, charStart: 0, charEnd: PII_CHUNK_1.length }),
        embeddingId: `${piiDocId}-1`,
      },
      {
        id: `${cleanDocId}-0`,
        documentId: cleanDocId,
        chunkText: CLEAN_CHUNK_0,
        metadata: JSON.stringify({ paragraph: 0, charStart: 0, charEnd: CLEAN_CHUNK_0.length }),
        embeddingId: `${cleanDocId}-0`,
      },
      {
        id: `${cleanDocId}-1`,
        documentId: cleanDocId,
        chunkText: CLEAN_CHUNK_1,
        metadata: JSON.stringify({ paragraph: 1, charStart: 0, charEnd: CLEAN_CHUNK_1.length }),
        embeddingId: `${cleanDocId}-1`,
      },
      {
        id: `${markedDocId}-0`,
        documentId: markedDocId,
        chunkText: `Verbale chiuso in data remota. Codice Fiscale: ${PII_CF} (gi\u00e0 registrata).`,
        metadata: JSON.stringify({ paragraph: 0, charStart: 0, charEnd: 60 }),
        embeddingId: `${markedDocId}-0`,
      },
    ],
  });

  // HTTP-boundary reembed capture: the ONLY mocked seam (the plan-02 masking
  // module's real code runs — payload build + schema parse + headers — but the
  // network hop lands here instead of the collector).
  globalThis.fetch = (async (
    input: unknown,
    init?: { headers?: Record<string, string>; body?: string },
  ) => {
    reembedCalls.push({
      url: String(input),
      body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  try {
    const docIds = [piiDocId, cleanDocId, markedDocId].filter(Boolean);
    if (docIds.length > 0) {
      // Document deletion cascades document_chunks + dlp_entities (FK
      // onDelete: Cascade) — no orphan encrypted ciphertext survives.
      await prisma.document.deleteMany({ where: { id: { in: docIds } } });
    }
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (projectId) {
      await prisma.projectAccess.deleteMany({ where: { projectId } });
      await prisma.project.deleteMany({ where: { id: projectId } });
    }
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } });
  } catch {
    // Best-effort cleanup (worker DB is dropped wholesale on the next run).
  }
  await prisma?.$disconnect();
});

describe("DLP-06 backfill integration twin (real Postgres, D-12)", () => {
  it("seeds 3 legacy docs (PII / clean / already-marked) → countEligibleDocuments returns 2 (marker + status filter, org-scoped)", async () => {
    await expect(countEligibleDocuments()).resolves.toBe(2);
    // T-192-29 tenancy proof on the count seam: a foreign org sees none.
    await expect(
      countEligibleDocuments("00000000-0000-0000-0000-00000000000f"),
    ).resolves.toBe(0);
    await expect(countEligibleDocuments(orgId)).resolves.toBe(2);
  });

  it("drives runBackfillDocument on the PII doc → masked chunks persisted + both tsvector columns recomputed + markers + encrypted entity rows + reembed payload byte-equal to the stored masked chunkText", async () => {
    // Meaningfulness pre-check: BEFORE the backfill the CF lexeme IS
    // searchable via searchVector — wait, the seeded rows have NULL tsvector
    // columns (no FTS write yet), so the pre-check is the NULL state itself.
    const preSv = await prisma.$queryRaw<{ sv: string | null }[]>`
      SELECT "searchVector"::text AS sv FROM "document_chunks"
      WHERE "documentId" = ${piiDocId} ORDER BY id ASC
    `;
    expect(preSv.map((r) => r.sv)).toEqual([null, null]);

    const outcome = await runBackfillDocument({
      documentId: piiDocId,
      workspaceId,
      organizationId: orgId,
    });
    expect(outcome).toBe("processed");

    // Markers: dlpScannedAt set + dlpScanState="scanned" (4 entities > 0).
    const docRow = await prisma.document.findUnique({ where: { id: piiDocId } });
    expect(docRow).not.toBeNull();
    expect(docRow!.dlpScannedAt).toBeInstanceOf(Date);
    expect(docRow!.dlpScanState).toBe("scanned");

    // Masked chunkText persisted EXACTLY (D-03 placeholders, doc-wide numbering).
    const chunks = await prisma.documentChunk.findMany({
      where: { documentId: piiDocId },
      orderBy: { id: "asc" },
    });
    expect(chunks.map((c) => c.chunkText)).toEqual([
      EXPECTED_MASKED_CHUNK_0,
      EXPECTED_MASKED_CHUNK_1,
    ]);

    // UPDATE-not-delete+insert contract: chunk ids + embeddingId survive.
    expect(chunks.map((c) => c.id)).toEqual([`${piiDocId}-0`, `${piiDocId}-1`]);
    expect(chunks.map((c) => c.embeddingId)).toEqual([`${piiDocId}-0`, `${piiDocId}-1`]);
    // Landmine L1: metadata untouched (text, byte-equal JSON).
    expect(chunks[0]!.metadata).toBe(
      JSON.stringify({
        paragraph: 0,
        charStart: 0,
        charEnd: PII_CHUNK_0.length,
      }),
    );

    // FTS recomputed FROM THE MASKED TEXT: 'assistenza' (untouched prose)
    // matches; the CF lexeme is GONE from searchVector.
    const cfHits = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "document_chunks"
      WHERE "documentId" = ${piiDocId}
        AND "searchVector" @@ websearch_to_tsquery('english', ${PII_CF})
    `;
    expect(cfHits.length).toBe(0);
    const assistenza = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "document_chunks"
      WHERE "documentId" = ${piiDocId}
        AND "searchVector" @@ to_tsquery('english', ${"assistenza"})
    `;
    expect(assistenza.length).toBe(1);
    // searchVectorMulti (RAG-01 7-config) recomputed from the masked text.
    const multi = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "document_chunks"
      WHERE "documentId" = ${piiDocId}
        AND "searchVectorMulti" @@ (
          websearch_to_tsquery('english', ${"contratto"}) ||
          websearch_to_tsquery('italian', ${"contratto"}) ||
          websearch_to_tsquery('german', ${"contratto"}) ||
          websearch_to_tsquery('french', ${"contratto"}) ||
          websearch_to_tsquery('spanish', ${"contratto"}) ||
          websearch_to_tsquery('russian', ${"contratto"}) ||
          websearch_to_tsquery('simple', ${"contratto"})
        )
    `;
    expect(multi.length).toBe(1);

    // Entity rows: 4 classes-worth, with REAL decrypt of the encrypted
    // originals (D-04 — encryptionService is NOT stubbed in this twin).
    const entities = await prisma.dlpEntity.findMany({
      where: { documentId: piiDocId },
      orderBy: { placeholder: "asc" },
    });
    expect(entities).toHaveLength(4);
    const { decrypt } = await import("../services/encryptionService");
    const byPlaceholder = new Map(entities.map((r) => [r.placeholder, r] as const));
    for (const [placeholder, original] of Object.entries(ENTITY_ORIGINALS)) {
      const row = byPlaceholder.get(placeholder);
      expect(row).toBeDefined(); // missing entity row would fail the decrypt below
      expect(decrypt(row!.originalEncrypted)).toBe(original);
      expect(row!.originalEncrypted).not.toContain(original); // never plaintext
      expect(row!.occurrences).toBe(1);
      // Class derivation mirrors the LAST-underscore matcher (GOV_ID contains
      // an underscore — a first-underscore split would mangle it).
      const inner = placeholder.slice(1, -1);
      expect(row!.entityClass).toBe(inner.slice(0, inner.lastIndexOf("_")));
    }

    // Reembed capture (HTTP boundary): one call, masked-only payload.
    expect(reembedCalls.length).toBe(1);
    const call = reembedCalls[0]!;
    expect(call.url.endsWith("/api/ingest/reembed")).toBe(true);
    expect(call.headers["X-Collector-Secret"]).toBe(getEnv().COLLECTOR_SECRET);
    expect(call.body.documentId).toBe(piiDocId);
    expect(call.body.workspaceId).toBe(workspaceId);
    expect(call.body.embeddingModel).toBe("test-embed-model");
    expect(call.body.documentType).toBe("txt");
    expect(call.body.documentCreatedAt).toBe(docRow!.createdAt.toISOString());
    const payloadChunks = call.body.chunks as Array<{
      chunkIndex: number;
      chunkText: string;
    }>;
    // Placeholder-occurrence parity (probe edge encoding): the reembed payload
    // chunkText EQUALS the stored masked chunkText EXACTLY — byte for byte.
    expect(payloadChunks.map((c) => c.chunkText)).toEqual(
      chunks.map((c) => c.chunkText),
    );
    expect(payloadChunks.map((c) => c.chunkText)).toEqual([
      EXPECTED_MASKED_CHUNK_0,
      EXPECTED_MASKED_CHUNK_1,
    ]);
    expect(payloadChunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
    // D-07: the ORIGINAL unmasked text never rides the reembed.
    const serialized = JSON.stringify(call.body);
    for (const pii of [PII_CF, PII_EMAIL, PII_IBAN, PII_VAT_DIGITS]) {
      expect(serialized).not.toContain(pii);
    }
  });

  it("drives the zero-PII doc → dlpScanState 'clean', zero entity rows, reembed payload equals the stored clean text", async () => {
    const outcome = await runBackfillDocument({
      documentId: cleanDocId,
      workspaceId,
      organizationId: orgId,
    });
    expect(outcome).toBe("processed");

    const docRow = await prisma.document.findUnique({ where: { id: cleanDocId } });
    expect(docRow!.dlpScannedAt).toBeInstanceOf(Date);
    expect(docRow!.dlpScanState).toBe("clean"); // zero entities is a valid outcome
    expect(await prisma.dlpEntity.count({ where: { documentId: cleanDocId } })).toBe(0);

    expect(reembedCalls.length).toBe(2);
    const payloadChunks = reembedCalls[1]!.body.chunks as Array<{
      chunkIndex: number;
      chunkText: string;
    }>;
    expect(payloadChunks.map((c) => c.chunkText)).toEqual([CLEAN_CHUNK_0, CLEAN_CHUNK_1]);
  });

  it("re-run convergence: the second job on the same document is a marker skip — chunkText byte-identical, entity count unchanged, no extra reembed", async () => {
    const before = await prisma.documentChunk.findMany({
      where: { documentId: piiDocId },
      orderBy: { id: "asc" },
    });
    const beforeTexts = before.map((c) => c.chunkText);
    const entityCountBefore = await prisma.dlpEntity.count({
      where: { documentId: piiDocId },
    });
    const docBefore = await prisma.document.findUnique({ where: { id: piiDocId } });

    const outcome = await runBackfillDocument({
      documentId: piiDocId,
      workspaceId,
      organizationId: orgId,
    });
    expect(outcome).toBe("skipped");

    // No extra reembed (the marker short-circuits before any scan machinery).
    expect(reembedCalls.length).toBe(2);

    // Byte-identical convergence (D-12 idempotency on real Postgres).
    const after = await prisma.documentChunk.findMany({
      where: { documentId: piiDocId },
      orderBy: { id: "asc" },
    });
    expect(
      Buffer.compare(
        Buffer.from(beforeTexts.join("\u0000"), "utf8"),
        Buffer.from(after.map((c) => c.chunkText).join("\u0000"), "utf8"),
      ),
    ).toBe(0);
    expect(after.map((c) => c.chunkText)).toEqual(beforeTexts);
    expect(await prisma.dlpEntity.count({ where: { documentId: piiDocId } })).toBe(
      entityCountBefore,
    );
    // The marker itself was not rewritten by the skip.
    const docAfter = await prisma.document.findUnique({ where: { id: piiDocId } });
    expect(docAfter!.dlpScannedAt!.toISOString()).toBe(
      docBefore!.dlpScannedAt!.toISOString(),
    );
    expect(docAfter!.dlpScanState).toBe("scanned");
  });

  it("DLP-06 audit (research Pitfall 7): zero remaining PII in document_chunks for the scanned doc; the marker-guarded doc keeps its unmasked text; eligibility drained to 0", async () => {
    const remaining = await prisma.$queryRaw<{ id: string; chunkText: string }[]>`
      SELECT id, "chunkText" FROM "document_chunks"
      WHERE "documentId" = ${piiDocId} AND (
        "chunkText" LIKE ${`%${PII_CF}%`} OR
        "chunkText" LIKE ${`%${PII_EMAIL}%`} OR
        "chunkText" LIKE ${`%${PII_IBAN}%`} OR
        "chunkText" LIKE ${`%${PII_VAT_DIGITS}%`}
      )
    `;
    expect(remaining.length).toBe(0);

    // The already-marked doc was NEVER touched: its raw CF text is still there.
    const marked = await prisma.documentChunk.findFirst({
      where: { documentId: markedDocId },
    });
    expect(marked!.chunkText).toContain(PII_CF);
    const markedDoc = await prisma.document.findUnique({ where: { id: markedDocId } });
    expect(markedDoc!.dlpScannedAt!.toISOString()).toBe(MARKED_SCANNED_AT.toISOString());

    // All three docs now carry the marker → eligibility drained.
    await expect(countEligibleDocuments()).resolves.toBe(0);
  });
});