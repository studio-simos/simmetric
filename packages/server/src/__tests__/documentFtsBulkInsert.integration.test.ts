// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * RAG-04 integration test — FTS bulk `unnest` INSERT (real PostgreSQL).
 *
 * Verifies the batched `unnest` INSERT shape that replaced the one-by-one
 * loop at routes/documents.ts:832-850. The route's chunk-insert block is
 * inline in a larger try/catch inside the collector-callback handler, so
 * extracting it would change the route's behavior scope. Instead (option (b)
 * per 85-02-PLAN.md Task 3), this test issues the EXACT `unnest` INSERT SQL
 * that the route emits, against a seeded document in the real worker DB, and
 * asserts the SQL shape mirrors the route's end-to-end.
 *
 * Run: pnpm --filter server test:integration -- src/__tests__/documentFtsBulkInsert.integration.test.ts
 *
 * Per MEMORY rag-empty-results-diagnosis-20260721: real Prisma, NO partial
 * mocks of the prisma singleton are permitted in this file (real DB only).
 */

import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";

// Phase 151 (RAG-01): the multi-config fragment is imported dynamically in
// beforeAll — a top-level import would transitively load the prisma singleton
// (via ftsService.ts) BEFORE jest.setup.integration.ts sets the worker
// DATABASE_URL, pinning the client to the wrong database.
let MULTI_CONFIG_TSVECTOR: string;

// Real Prisma client — do NOT mock. Imported dynamically in beforeAll so the
// worker-specific DATABASE_URL (set by jest.setup.integration.ts) is picked up.
let prisma: import("@prisma/client").PrismaClient;

let adminUserId: string;
let workspaceId: string;
let documentId: string;
const adminPassword = "ftsbulk_admin_pass";

beforeAll(async () => {
  const { createApp } = await import("../index");
  // createApp wires middleware/routers — exercising it here confirms the route
  // module loads cleanly with the batched INSERT in place.
  createApp();

  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();

  // Phase 151 (RAG-01): load the fragment AFTER the worker DB URL is set.
  ({ MULTI_CONFIG_TSVECTOR } = await import("../services/ftsService"));

  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const salt = await bcrypt.genSalt(12);
  const admin = await prisma.user.create({
    data: {
      username: "fts_bulk_admin",
      email: "fts_bulk_admin@test.com",
      passwordHash: await bcrypt.hash(adminPassword, salt),
      salt,
    },
  });
  adminUserId = admin.id;
  if (adminRole) {
    await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  }

  const project = await prisma.project.create({
    data: { name: "FTS Bulk Project", description: "RAG-04 test project", createdBy: adminUserId },
  });
  const workspace = await prisma.workspace.create({
    data: { name: "FTS Bulk Workspace", projectId: project.id },
  });
  workspaceId = workspace.id;

  const doc = await prisma.document.create({
    data: {
      workspaceId,
      name: "fts-bulk-test.txt",
      type: "txt",
      filePath: "/tmp/fts-bulk-test.txt",
      cacheKey: "fts-bulk-cache-key",
      chunkCount: 0,
      status: "completed",
    },
  });
  documentId = doc.id;
});

afterAll(async () => {
  try {
    await prisma.$executeRaw`DELETE FROM "document_chunks" WHERE "documentId" = ${documentId}`;
    await prisma.document.deleteMany({ where: { id: documentId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    const projects = await prisma.project.findMany({ where: { createdBy: adminUserId } });
    for (const p of projects) {
      await prisma.projectAccess.deleteMany({ where: { projectId: p.id } });
      await prisma.project.deleteMany({ where: { id: p.id } });
    }
    await prisma.userRole.deleteMany({ where: { userId: adminUserId } });
    await prisma.user.deleteMany({ where: { id: adminUserId } });
  } catch {
    // Best-effort cleanup
  }
  await prisma.$disconnect();
});

/**
 * Helper: emit the EXACT batched `unnest` INSERT the route emits, for a
 * fixed `chunks` array. Mirrors routes/documents.ts RAG-04 block verbatim
 * (same column order, same ::text[] params, same to_tsvector regconfig).
 * Phase 151 (RAG-01): the route now also populates searchVectorMulti via the
 * shared MULTI_CONFIG_TSVECTOR fragment — mirrored here.
 */
async function bulkInsertChunks(
  documentId: string,
  chunks: { chunkIndex: number; chunkText: string; paragraph?: number; charStart?: number; charEnd?: number }[],
): Promise<void> {
  // Mirror the route's non-blocking DELETE-then-INSERT wrapper.
  await prisma.$executeRaw`DELETE FROM "document_chunks" WHERE "documentId" = ${documentId}`;

  const FTS_BATCH_SIZE = 500;
  for (let i = 0; i < chunks.length; i += FTS_BATCH_SIZE) {
    const batch = chunks.slice(i, i + FTS_BATCH_SIZE);
    const ids = batch.map((c) => `${documentId}-${c.chunkIndex}`);
    const docIds = batch.map(() => documentId);
    const texts = batch.map((c) => c.chunkText);
    const metas = batch.map((c) =>
      JSON.stringify({ paragraph: c.paragraph, charStart: c.charStart, charEnd: c.charEnd }),
    );
    const embIds = ids; // Bug A alignment preserved (embeddingId === chunkId)
    await prisma.$queryRaw`
      INSERT INTO "document_chunks" ("id", "documentId", "chunkText", "metadata", "embeddingId", "searchVector", "searchVectorMulti", "createdAt")
      SELECT t.id, t.documentId, t.chunkText, t.metadata, t.embeddingId,
             to_tsvector('english', t.chunkText),
             (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)} FROM (SELECT t.chunkText::text AS t) AS t),
             NOW()
      FROM unnest(
        ${ids}::text[],
        ${docIds}::text[],
        ${texts}::text[],
        ${metas}::text[],
        ${embIds}::text[]
      ) AS t(id, documentId, chunkText, metadata, embeddingId)
    `;
  }
}

describe("RAG-04 FTS bulk unnest INSERT", () => {
  it("inserts rows with correct to_tsvector + ${docId}-${chunkIndex} id + batch slicing", async () => {
    // 502 chunks exercises the 500-chunk batch boundary (2 batches: 500 + 2).
    const chunks = Array.from({ length: 502 }, (_, i) => ({
      chunkIndex: i,
      chunkText: i === 0 ? "postgresql full text search lexeme indexing" : `chunk text ${i}`,
      paragraph: i,
      charStart: i * 100,
      charEnd: i * 100 + 100,
    }));

    await bulkInsertChunks(documentId, chunks);

    const rows = await prisma.documentChunk.findMany({ where: { documentId } });
    expect(rows).toHaveLength(502);

    // D-08: chunk id format `${documentId}-${chunkIndex}` preserved. Lexicographic
    // id ordering is not numeric, so assert via direct lookup at the batch
    // boundary (chunkIndex 0, 499, 500, 501) — these exercise both batches.
    const boundaryIndices = [0, 499, 500, 501];
    for (const idx of boundaryIndices) {
      const row = await prisma.documentChunk.findUnique({
        where: { id: `${documentId}-${idx}` },
      });
      expect(row).not.toBeNull();
      expect(row!.id).toBe(`${documentId}-${idx}`);
    }

    // Bug A alignment: embeddingId === chunkId for every row.
    for (const row of rows) {
      expect(row.embeddingId).toBe(row.id);
    }

    // Landmine L1: metadata is text, byte-equal to JSON.stringify input.
    const firstRow = await prisma.documentChunk.findUnique({
      where: { id: `${documentId}-0` },
    });
    expect(firstRow!.metadata).toBe(
      JSON.stringify({ paragraph: 0, charStart: 0, charEnd: 100 }),
    );

    // to_tsvector('english', ...) regconfig marker present on the first chunk
    // (whose text was crafted to contain recognizable lexemes).
    const svRows = await prisma.$queryRaw<{ sv: string }[]>`
      SELECT "searchVector"::text AS sv FROM "document_chunks" WHERE id = ${firstRow!.id}
    `;
    expect(svRows.length).toBe(1);
    // 'postgresql' is a recognized lexeme; to_tsvector stores lexemes not raw text.
    expect(svRows[0]!.sv).toMatch(/postgresql|lexeme|index|search|text/);
  });

  it("GIN index populated (to_tsvector @@ to_tsquery matches)", async () => {
    // The first chunk's text contains "postgresql" — a GIN-indexed lexeme.
    const hits = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "document_chunks"
      WHERE "searchVector" @@ to_tsquery('english', ${"postgresql"})
      LIMIT 1
    `;
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("Phase 151 (RAG-01): Italian query matches Italian text via searchVectorMulti (OR-ed 7-config)", async () => {
    // Research-verified regression: to_tsvector('english','analisi dei dati')
    // @@ websearch_to_tsquery('italian','analisi') is FALSE — the italian
    // query stems to 'analis' while the english column holds 'analisi'. The
    // multi-config column holds BOTH lexemes, so the OR-ed query matches.
    const chunkId = `${documentId}-italian-probe`;
    await prisma.$executeRaw`
      INSERT INTO "document_chunks" ("id", "documentId", "chunkText", "metadata", "embeddingId", "searchVector", "searchVectorMulti", "createdAt")
      VALUES (
        ${chunkId},
        ${documentId},
        ${"analisi dei dati aziendali"},
        ${"{}"},
        ${chunkId},
        to_tsvector('english', ${"analisi dei dati aziendali"}),
        (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)} FROM (SELECT ${"analisi dei dati aziendali"}::text AS t) AS t),
        NOW()
      )
    `;

    // Old column + italian query: the silent-miss bug this phase fixes.
    const oldColumn = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "document_chunks"
      WHERE "searchVector" @@ websearch_to_tsquery('italian', ${"analisi"})
        AND id = ${chunkId}
    `;
    expect(oldColumn.length).toBe(0);

    // Multi column + OR-ed 7-config query: matches the italian-stemmed lexeme.
    const multi = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "document_chunks"
      WHERE "searchVectorMulti" @@ (
        websearch_to_tsquery('english', ${"analisi"}) || websearch_to_tsquery('italian', ${"analisi"}) ||
        websearch_to_tsquery('german', ${"analisi"}) || websearch_to_tsquery('french', ${"analisi"}) ||
        websearch_to_tsquery('spanish', ${"analisi"}) || websearch_to_tsquery('russian', ${"analisi"}) ||
        websearch_to_tsquery('simple', ${"analisi"})
      )
        AND id = ${chunkId}
    `;
    expect(multi.length).toBe(1);

    await prisma.$executeRaw`DELETE FROM "document_chunks" WHERE id = ${chunkId}`;
  });

  it("metadata is text, not jsonb (Landmine L1 regression net)", async () => {
    // Insert a chunk with a known metadata payload and read it back via Prisma.
    // The column is String @db.Text — no jsonb round-trip, so the bytes are
    // preserved exactly (no whitespace normalization, no key reorder).
    const meta = JSON.stringify({ paragraph: 1, charStart: 5, charEnd: 10 });
    const chunkId = `${documentId}-meta-test`;
    await prisma.$executeRaw`
      INSERT INTO "document_chunks" ("id", "documentId", "chunkText", "metadata", "embeddingId", "searchVector", "createdAt")
      VALUES (
        ${chunkId},
        ${documentId},
        ${"landmine metadata byte equality probe"},
        ${meta},
        ${chunkId},
        to_tsvector('english', ${"landmine metadata byte equality probe"}),
        NOW()
      )
    `;
    const row = await prisma.documentChunk.findUnique({ where: { id: chunkId } });
    expect(row).not.toBeNull();
    expect(row!.metadata).toBe(meta);
    // Exact byte equality — no whitespace insertion or key reorder.
    expect(row!.metadata).toBe('{"paragraph":1,"charStart":5,"charEnd":10}');
  });
});