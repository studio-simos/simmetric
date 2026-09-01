// Reindex archive wiki pages into the CURRENT vector provider — G-131-17 ops step.
//
// One-off ops tool: clears the vector metadata (vectorContentHash / vectorProvider
// / lastIndexedAt) for every non-deleted page of the given archive, then re-embeds
// all pages via the collector (indexAllWikiPages). This is the explicit data fix for
// provider-switch strandings (e.g. LanceDB → Qdrant): pages whose vectors were
// written to the OLD provider but whose hash still matches would otherwise block the
// hourly wiki-consistency job from re-indexing (the vectorContentHash guard).
//
// The Task 1 guard (vectorProvider drift) makes the hourly scheduler heal such
// strandings automatically going forward; this script is the one-off equivalent for
// archives stranded BEFORE the guard landed.
//
// Usage:
//   pnpm --filter server exec tsx scripts/reindex-archive-wiki.ts <archiveId>
//
// Prerequisiti:
//   - Collector in ascolto (porta 3210) con VECTOR_DB_PROVIDER = provider corrente.
//   - COLLECTOR_SECRET env var settata (validata da Zod in env.ts — min(1)).
//   - Il server .env risolve __dirname-relative (OPS-05): eseguire da packages/server.
//
// Trust boundary (T-131-22 threat register):
//   - Script runs server-side (COLLECTOR_SECRET holder, prisma singleton with
//     soft-delete filters). Validates the archive id via findFirst + deletedAt: null
//     before touching rows — the archive:write-style guard the route enforces,
//     mirrored without HTTP auth (dev/ops tool, committed for reuse).
//   - The pre-index UPDATE is parameterized ($executeRaw tagged template — no
//     string concat, SQL injection prevention).
//   - T-131-20 (DoS): indexAllWikiPages has per-page try/catch — page failures never
//     abort the batch; the collector upsert path (deleteByDocumentId + addDocuments)
//     is idempotent — a re-run is safe.

import { prisma } from "../src/utils/prisma";
import { getEnv } from "../src/config/env";
import { indexAllWikiPages } from "../src/services/wikiEmbeddingService";

async function main(): Promise<void> {
  const archiveId = process.argv[2];

  if (!archiveId) {
    console.error("[reindex-archive-wiki] Missing archive id argument.");
    console.error("Usage: pnpm --filter server exec tsx scripts/reindex-archive-wiki.ts <archiveId>");
    process.exit(1);
  }

  // Env contract (env.ts min(1)): COLLECTOR_SECRET is strictly required — the
  // collector post would reject without it. Fail fast with a clear message.
  const env = getEnv();
  if (!env.COLLECTOR_SECRET) {
    console.error("[reindex-archive-wiki] COLLECTOR_SECRET is empty — cannot authenticate to the collector.");
    process.exit(1);
  }

  // Soft-delete guard: findFirst + deletedAt: null (WR-02 pattern from
  // archiveExport.ts / archiveIndex.ts) — a soft-deleted archive must never be
  // re-indexed.
  const archive = await prisma.archive.findFirst({ where: { id: archiveId, deletedAt: null } });
  if (!archive) {
    console.error(`[reindex-archive-wiki] Archive not found (or soft-deleted): ${archiveId}`);
    process.exit(1);
  }

  const pageCount = await prisma.archivePage.count({
    where: { archiveId, deletedAt: null },
  });
  console.log(`[reindex-archive-wiki] Archive ${archiveId} (${archive.slug}): ${pageCount} non-deleted pages.`);

  // Belt-and-braces with the Task 1 guard: clear the vector metadata so EVERY
  // page counts as drift/never-indexed in the current provider. Parameterized
  // tagged template — no string concat.
  const cleared = await prisma.$executeRaw`
    UPDATE "archive_pages"
    SET "vectorContentHash" = NULL, "vectorProvider" = NULL, "lastIndexedAt" = NULL
    WHERE "archiveId" = ${archiveId} AND "deletedAt" IS NULL
  `;
  console.log(`[reindex-archive-wiki] Cleared vector metadata on ${cleared} page(s).`);

  // Awaited (not fire-and-forget — the script must complete before verification).
  // Per-page failures are caught inside indexAllWikiPages and logged; the batch
  // never aborts (T-131-20).
  await indexAllWikiPages(archiveId);

  const reindexed = await prisma.archivePage.count({
    where: { archiveId, deletedAt: null, lastIndexedAt: { not: null } },
  });
  console.log(`[reindex-archive-wiki] Reindex complete: ${reindexed}/${pageCount} pages indexed into the current provider.`);
  console.log("[reindex-archive-wiki] Per-page failures (if any) were logged above by indexAllWikiPages.");

  await prisma.$disconnect();
  // Exit 0 on completion regardless of per-page failures — the log carries them
  // (the operator can re-run; the script is idempotent). Exit 1 only for
  // missing/invalid archive id or broken env (handled above).
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[reindex-archive-wiki] failed:", e);
    process.exit(1);
  });
}
