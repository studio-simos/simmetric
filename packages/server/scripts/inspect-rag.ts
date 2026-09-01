// RAG fusion diagnostic — dumps vector top-k + FTS top-k + RRF-fused results
// side by side so Bug A (#1 RRF id-space mismatch), #13 RRF edge cases, and
// #18 FTS documentName absence are directly observable.
//
// Acceptance tool for Phase 60's RAG fusion fix: after the fix, the RRF-fused
// table must show `source: "both"` results. Today (Bug A) `source: "both"` is
// dead code because vector ids and FTS chunk ids live in different id spaces.
//
// Usage:
//   pnpm --filter server exec tsx scripts/inspect-rag.ts "<query>" <workspaceId> [limit=5]
//
// Trust boundary: reaches the collector via HTTP only (no @lancedb/lancedb
// import). Prints chunkText.slice(0, 80) only — do not paste script output
// into public channels (PII guard, T-59-03-01).
//
// NOTE: End-to-end smoke DEFERRED per operator "skip-smoke" decision
// (2026-07-16) — fixtures (real PostgreSQL + ingested doc + running collector)
// were not provisioned in this session. The script imports the real code paths
// and passes typecheck; the live smoke is deferred to a later operator session.

import axios from "axios";
import { prisma } from "../src/utils/prisma";
import { hybridSearch } from "../src/services/hybridSearchService";
import { ftsSearch } from "../src/services/ftsService";
import { getEnv } from "../src/config/env";
import { getSetting } from "../src/services/systemConfigService";

interface VectorResultRow {
  id?: string;
  score?: number;
  text?: string;
  documentName?: string;
  metadata?: { chunkId?: string; chunkText?: string; documentName?: string };
}

async function main(): Promise<void> {
  const queryArg = process.argv[2];
  const workspaceIdArg = process.argv[3];
  const limitArg = process.argv[4];

  if (!queryArg || !workspaceIdArg) {
    console.error(
      "Usage: tsx scripts/inspect-rag.ts <query> <workspaceId> [limit=5]",
    );
    process.exit(1);
  }

  const limitParsed = Number(limitArg || "5");
  const limit = Number.isFinite(limitParsed) && limitParsed > 0 ? limitParsed : 5;

  // --- FTS top-k (PostgreSQL tsvector) ---
  // Bug #18: ftsService does not JOIN documents.name, so documentName is absent
  // from FTS results. The literal below documents the bug inline.
  try {
    const ftsResults = await ftsSearch(queryArg, workspaceIdArg, limit);
    console.log("\n[inspect-rag] FTS top-k (PostgreSQL tsvector):");
    console.table(
      ftsResults.map((r) => ({
        chunkId: r.chunkId,
        rank: r.rank,
        documentName: "(not joined — bug #18)",
        chunkText: r.chunkText.slice(0, 80),
      })),
    );
  } catch (err: unknown) {
    console.error(
      `[inspect-rag] fts top-k failed: ${(err as Error).message}`,
    );
  }

  // --- Vector top-k via collector HTTP (HTTP-only boundary — no LanceDB import) ---
  const setting = await getSetting("EMBEDDING_MODEL");
  const embeddingModel = setting.value || undefined;
  try {
    const vResp = await axios.post(
      `${getEnv().COLLECTOR_URL}/api/ingest/query`,
      {
        query: queryArg,
        workspaceId: workspaceIdArg,
        limit,
        embeddingModel,
      },
      { timeout: 30000 },
    );
    const rawResults: VectorResultRow[] = (vResp.data?.results || []) as VectorResultRow[];
    console.log("\n[inspect-rag] Vector top-k (collector /api/ingest/query):");
    console.table(
      rawResults.map((r) => ({
        id: r.id ?? r.metadata?.chunkId ?? "(missing id)",
        score: r.score ?? 0,
        documentName: r.documentName ?? r.metadata?.documentName ?? "(not exposed)",
        chunkText: (r.text ?? r.metadata?.chunkText ?? "").slice(0, 80),
      })),
    );
  } catch (err: unknown) {
    // Degraded diagnostic is useful — collector may be down in dev/air-gap.
    console.error(
      `[inspect-rag] vector top-k: collector unreachable (${(err as Error).message})`,
    );
  }

  // --- RRF-fused (the real code path via hybridSearch) ---
  const fused = await hybridSearch(queryArg, workspaceIdArg, limit);
  console.log("\n[inspect-rag] RRF-fused (hybridSearch):");
  console.table(
    fused.map((r) => ({
      chunkId: r.chunkId,
      score: r.score,
      source: r.source,
      documentName: r.documentName ?? "(undefined)",
    })),
  );

  // Key diagnostic — Bug A makes `source: "both"` dead code today.
  const bothCount = fused.filter((r) => r.source === "both").length;
  console.log(
    `[inspect-rag] source=="both" count: ${bothCount} (expect 0 until Phase 60 fixes Bug A)`,
  );

  await prisma.$disconnect();
  // Empty results are a valid diagnostic, not a failure — exit 0 regardless.
  process.exit(0);
}

main().catch((e) => {
  console.error("[inspect-rag] failed:", e);
  process.exit(1);
});