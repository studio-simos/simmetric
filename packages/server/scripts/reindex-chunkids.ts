// Reindex chunk ids — D-06 future-proof reindex script.
//
// Riallinea `document_chunks.id` e i vector id al formato condiviso
// `${documentId}-${chunkIndex}` (D-06/ING-01). Lo script è:
//   - idempotente: skip dei chunk già allineati (re-run sicuro dopo crash)
//   - air-gap compatible: usa il modello embedding locale via collector HTTP
//     (nessun import del pacchetto LanceDB nel server — RESEARCH.md
//     Anti-Pattern: il boundary unidirectional shared-only vieta di importare
//     il modulo vector DB nativo dentro il server)
//   - HTTP-only al collector: chiama `POST /api/ingest/reembed` (Plan 07) per
//     re-embeddare i chunk e riscrivere i vettori con il chunk-id condiviso,
//     poi aggiorna `document_chunks.id` server-side via Prisma `$executeRaw`.
//   - soft-delete respected: filtra `Document.deletedAt: null` via
//     `withSoftDelete({ deletedAt: null })`. `DocumentChunk` non ha colonna
//     `deletedAt` (cascade-delete con il Document padre), quindi il filtro
//     sui chunk è indiretto tramite il filtro sul Document.
//   - batch discipline: `for...of` sui document (no risoluzione parallela di
//     promise sui batch — RESEARCH.md Anti-Pattern: OOM risk sul embedding
//     provider).
//
// Usage:
//   pnpm --filter server exec tsx scripts/reindex-chunkids.ts [workspaceId]
//
// Esempi:
//   pnpm --filter server exec tsx scripts/reindex-chunkids.ts            # tutti i workspace
//   pnpm --filter server exec tsx scripts/reindex-chunkids.ts <uuid>     # solo un workspace
//   pnpm --filter server exec tsx scripts/reindex-chunkids.ts --help     # mostra questo help
//
// Prerequisiti:
//   - Collector in ascolto con endpoint `POST /api/ingest/reembed` (Plan 07).
//     Il reembed endpoint re-embedda i chunk con il modello embedding locale
//     (air-gap compatible) e riscrive i vettori con il chunk-id condiviso
//     `${documentId}-${chunkIndex}`.
//   - `COLLECTOR_SECRET` env var settata (validata da Zod in `env.ts`).
//
// Trust boundary (T-60-07 threat register):
//   - Script runs operator-side, non exposed via HTTP. UPDATEs document_chunks.
//   - Server script → Collector (HTTP POST /api/ingest/reembed) con
//     `X-Collector-Secret` header (T-60-07d spoofing mitigation).
//   - Information disclosure (T-60-07a): lo script legge chunk text (potenziale
//     PII) da document_chunks e lo invia al collector per re-embed.
//     NON incollare l'output dello script in canali pubblici (stessa regola
//     degli inspect script di Phase 59).
//   - Tampering (T-60-07b): idempotenza — skip chunk già allineati. Re-run
//     sicuro dopo un crash. Per safety production, wrappe in transazione
//     Prisma (opzionale — D-05 conferma dev-only).
//   - Boundary violation (T-60-07c): NO import del pacchetto LanceDB nel
//     server. HTTP-only al collector via axios.

import axios from "axios";
import { prisma, withSoftDelete } from "../src/utils/prisma";
import { getEnv } from "../src/config/env";

interface ChunkRow {
  id: string;
  documentId: string;
  embeddingId: string;
  metadata: string;
  chunkText: string;
}

/**
 * Derive `chunkIndex` for a chunk row without relying on a top-level DB column.
 *
 * UAT-60-11 root cause: `document_chunks` has NO `chunkIndex` column. Both
 * INSERT sites (documents.ts:599 for new ingestion, system.ts:315 for legacy
 * re-index) populate `embeddingId` as `${documentId}-${chunkIndex}`, so the
 * primary source is the embeddingId suffix. The `metadata` JSON is a fallback
 * for any hypothetical row where embeddingId diverged (metadata shape at both
 * INSERT sites is `{ paragraph, charStart, charEnd }` — no chunkIndex field,
 * but the fallback is kept for robustness).
 *
 * @returns the chunk index as a number, or `undefined` when it cannot be
 * derived (the caller must skip such chunks with a warning).
 */
export function deriveChunkIndex(
  embeddingId: string,
  documentId: string,
  metadataJson: string,
): number | undefined {
  // Primary: embeddingId is `${documentId}-${N}` at both INSERT sites.
  const prefix = `${documentId}-`;
  if (embeddingId.startsWith(prefix)) {
    const suffix = embeddingId.slice(prefix.length);
    const parsed = Number.parseInt(suffix, 10);
    if (Number.isInteger(parsed) && !Number.isNaN(parsed)) {
      return parsed;
    }
  }

  // Fallback: metadata JSON may carry a numeric chunkIndex field.
  try {
    const parsed = JSON.parse(metadataJson);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).chunkIndex === "number" &&
      Number.isInteger((parsed as Record<string, unknown>).chunkIndex as number)
    ) {
      return (parsed as Record<string, unknown>).chunkIndex as number;
    }
  } catch {
    // malformed JSON — no fallback available
  }

  return undefined;
}

function printHelp(): void {
  console.log(
    [
      "Usage: tsx scripts/reindex-chunkids.ts [workspaceId]",
      "",
      "Reindex document_chunks.id e vector id al formato condiviso",
      "`${documentId}-${chunkIndex}` (D-06/ING-01).",
      "",
      "Opzioni:",
      "  [workspaceId]  UUID del workspace da re-indicizzare. Se omesso,",
      "                 processa tutti i workspace non soft-deletati.",
      "  --help, -h     Mostra questo help ed esce.",
      "",
      "Prerequisiti: collector in ascolto con POST /api/ingest/reembed",
      "(Plan 07) + COLLECTOR_SECRET env var.",
      "",
      "Sicurezza: lo script legge chunk text (potenziale PII). NON",
      "incollare l'output in canali pubblici (T-60-07a).",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const workspaceArg = process.argv[2];

  if (workspaceArg === "--help" || workspaceArg === "-h") {
    printHelp();
    process.exit(0);
  }

  // Nessun argomento = processa tutti i workspace (valido, non errore).
  // Valida formato UUID se passato (fail-fast su typo).
  if (workspaceArg !== undefined) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(workspaceArg)) {
      console.error(
        `[reindex] Argomento non valido: "${workspaceArg}" non è un UUID.`,
      );
      console.error(
        'Usage: tsx scripts/reindex-chunkids.ts [workspaceId]  (oppure --help)',
      );
      process.exit(1);
    }
  }

  const env = getEnv();
  console.log(
    "[reindex] Starting chunk-id reindex (air-gap, idempotent, via /api/ingest/reembed)",
  );
  if (workspaceArg) {
    console.log(`[reindex] Scope: workspace ${workspaceArg}`);
  } else {
    console.log("[reindex] Scope: all workspaces (no workspaceId filter)");
  }

  // Soft-delete rispettato a livello di Document (CLAUDE.md mandate).
  // DocumentChunk non ha `deletedAt` (cascade-delete con il Document padre),
  // quindi il filtro sui chunk è indiretto tramite il Document.
  const docs = await prisma.document.findMany({
    where: workspaceArg
      ? withSoftDelete({ workspaceId: workspaceArg, deletedAt: null })
      : withSoftDelete({ deletedAt: null }),
    include: { workspace: true },
  });

  console.log(`[reindex] Found ${docs.length} document(s) to inspect.`);

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Batch discipline: for...of sui document, no risoluzione parallela di
  // promise sui batch (RESEARCH.md Anti-Pattern — OOM risk sul embedding
  // provider). Il reembed endpoint gestisce il batching interno dei chunk
  // via for...of in embed().
  for (const doc of docs) {
    try {
      // Fetch chunks esistenti. DocumentChunk non ha deletedAt (schema Prisma
      // conferma: model DocumentChunk @ line 279-293), quindi nessun filtro
      // `deletedAt IS NULL` sulla query chunks — il filtro soft-delete è già
      // applicato a livello di Document sopra.
      //
      // UAT-60-11: document_chunks ha NO colonna `chunkIndex` (PostgreSQL
      // 42703). chunkIndex è derivato da `embeddingId` (primario, popolato come
      // `${documentId}-${chunkIndex}` a entrambi gli INSERT sites: documents.ts
      // e system.ts) con fallback su `metadata` JSON. Nessun riferimento a una
      // colonna top-level chunkIndex in SQL.
      const rawChunks = (await prisma.$queryRaw<ChunkRow[]>`
        SELECT id, "documentId", "embeddingId", "metadata", "chunkText"
        FROM "document_chunks"
        WHERE "documentId" = ${doc.id}
        ORDER BY id ASC
      `) as ChunkRow[];

      if (rawChunks.length === 0) {
        console.log(`[reindex] Doc ${doc.id}: no chunks, skipping`);
        skippedCount++;
        continue;
      }

      // Derive chunkIndex per row from embeddingId (primary) + metadata (fallback).
      // Skip rows with no derivable chunkIndex (warning, non-fatal).
      const chunks: Array<ChunkRow & { chunkIndex: number }> = [];
      for (const c of rawChunks) {
        const idx = deriveChunkIndex(c.embeddingId, c.documentId, c.metadata);
        if (idx === undefined) {
          console.log(
            `[reindex] Doc ${doc.id}: chunk ${c.id} has no derivable chunkIndex (embeddingId=${c.embeddingId}), skipping`,
          );
          continue;
        }
        chunks.push({ ...c, chunkIndex: idx });
      }

      if (chunks.length === 0) {
        console.log(
          `[reindex] Doc ${doc.id}: all chunks have no derivable chunkIndex, cannot reindex`,
        );
        errorCount++;
        continue;
      }

      // Idempotency check: se tutti i chunk hanno già
      // `id === ${documentId}-${chunkIndex}` → skip (già allineati).
      const allAligned = chunks.every(
        (c) => c.id === `${doc.id}-${c.chunkIndex}`,
      );
      if (allAligned) {
        console.log(
          `[reindex] Doc ${doc.id}: chunks already aligned, skipping`,
        );
        skippedCount++;
        continue;
      }

      // Costruisci il payload per il reembed endpoint (Plan 07).
      const reembedChunks = chunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        chunkText: c.chunkText,
      }));

      // Chiama POST /api/ingest/reembed (Plan 07). Il reembed endpoint
      // re-embedda i chunk con il modello locale (air-gap) e riscrive i
      // vettori con il chunk-id condiviso `${documentId}-${chunkIndex}`.
      // Timeout 60000ms — più generoso del 5000ms default: il re-embed di
      // molti chunk può richiedere tempo, specialmente con cold-start del
      // modello embedding locale.
      const reembedResp = await axios.post(
        `${env.COLLECTOR_URL}/api/ingest/reembed`,
        {
          documentId: doc.id,
          workspaceId: doc.workspaceId,
          workspaceName: doc.workspace?.name,
          chunks: reembedChunks,
          embeddingModel: doc.embeddingModel,
        },
        {
          timeout: 60000,
          headers: {
            "X-Collector-Secret": env.COLLECTOR_SECRET,
            "Content-Type": "application/json",
          },
        },
      );

      const reembedded = reembedResp.data?.chunkCount ?? chunks.length;
      console.log(
        `[reindex] Doc ${doc.id}: reembedded ${reembedded} chunks via /api/ingest/reembed`,
      );

      // UPDATE document_chunks.id: allinea il FTS-side id al vector-side id
      // (Plan 07 ha già allineato i vettori). Usa $executeRaw con tagged
      // template literal (SQL injection prevention — CLAUDE.md mandate).
      //
      // IN-05: wrap the per-document UPDATE batch in `prisma.$transaction([...])`
      // so a crash mid-batch cannot leave some rows with new IDs and others with
      // old IDs. The skip (`if (chunk.id === newId) continue`) is applied BEFORE
      // building the transaction array, so idempotency is preserved. The
      // transaction is scoped to this document's batch only (not the whole
      // script) — the reembed step is itself idempotent (delete-then-add), so
      // this is defense-in-depth, not data-loss prevention.
      const updates: ReturnType<typeof prisma.$executeRaw>[] = [];
      for (const chunk of chunks) {
        const newId = `${doc.id}-${chunk.chunkIndex}`;
        if (chunk.id === newId) continue; // già allineato
        updates.push(
          prisma.$executeRaw`
            UPDATE "document_chunks"
            SET id = ${newId}
            WHERE id = ${chunk.id}
          `,
        );
      }
      if (updates.length > 0) {
        await prisma.$transaction(updates);
      }
      const updatedCount = updates.length;

      console.log(
        `[reindex] Doc ${doc.id}: re-embedded ${reembedded} chunks, aligned ${updatedCount} document_chunks.id rows`,
      );
      processedCount++;
    } catch (err: unknown) {
      errorCount++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[reindex] Doc ${doc.id}: FAILED — ${msg}`);
      // Continua al prossimo document — un fallimento non blocca gli altri.
      // L'operatore può re-runnare lo script (idempotente) dopo aver risolto.
    }
  }

  console.log(
    `[reindex] Reindex complete. ${docs.length} documents inspected: ${processedCount} processed, ${skippedCount} skipped, ${errorCount} errors.`,
  );

  await prisma.$disconnect();
  // WR-07: exits 1 if ANY document errored (defensive — surfaces partial
  // failure to the operator / CI so chunk-id misalignment is not silently
  // swallowed). The script is idempotent: the operator reads the logs, fixes
  // the failing documents, and re-runs until exit 0. Exits 1 only here on
  // per-document errors; a fatal start-up failure (auth/env/argv) exits 1
  // earlier in the `main().catch` guard below.
  process.exit(errorCount > 0 ? 1 : 0);
}

// Guard so unit tests can import `deriveChunkIndex` without invoking main().
if (require.main === module) {
  main().catch((e) => {
    console.error("[reindex] failed:", e);
    process.exit(1);
  });
}