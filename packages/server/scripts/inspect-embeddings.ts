// Stored-vector dim vs configured-EMBEDDING_MODEL dim assertion.
//
// Catches silent dim-mismatch regressions: if the collector stores vectors
// with a different dimensionality than the configured EMBEDDING_MODEL expects,
// vector search silently returns zero results (or crashes on dot-product).
//
// Usage:
//   pnpm --filter server exec tsx scripts/inspect-embeddings.ts <workspaceId>
//
// Trust boundary: reaches the collector via HTTP only (no @lancedb/lancedb
// import — Pitfall 4). The collector response shape for /api/ingest/query is
// not formally typed (Open Question Q1), so this script probes the response
// and falls back to a non-zero result-count check when dim is not exposed.
//
// NOTE: End-to-end smoke DEFERRED per operator "skip-smoke" decision
// (2026-07-16) — fixtures (real PostgreSQL + ingested doc + running collector)
// were not provisioned in this session. The script imports the real code paths
// and passes typecheck; the live smoke is deferred to a later operator session.

import axios from "axios";
import { prisma } from "../src/utils/prisma";
import { getEnv } from "../src/config/env";
import { getSetting } from "../src/services/systemConfigService";

// Static map of known embedding model defaults. If the configured model is
// not in this map, expectedDim is undefined and the script falls back to a
// non-zero result-count check (path B).
const KNOWN_MODEL_DIMS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-MiniLM-L12-v2": 384,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

interface CollectorResultRow {
  vector?: number[];
  dimension?: number;
  metadata?: { chunkText?: string };
}

interface CollectorResponseBody {
  results?: CollectorResultRow[];
  dimension?: number;
}

async function main(): Promise<void> {
  const workspaceIdArg = process.argv[2];

  if (!workspaceIdArg) {
    console.error(
      "Usage: tsx scripts/inspect-embeddings.ts <workspaceId>",
    );
    process.exit(1);
  }

  // Read the configured embedding model (DB > ENV > Default via getSetting).
  const setting = await getSetting("EMBEDDING_MODEL");
  const embeddingModel = setting.value || undefined;
  const expectedDim = embeddingModel ? KNOWN_MODEL_DIMS[embeddingModel] : undefined;

  if (expectedDim === undefined) {
    console.log(
      `[inspect-embeddings] expected dim unknown for model "${embeddingModel}" — will assert result count > 0 only`,
    );
  } else {
    console.log(
      `[inspect-embeddings] configured model="${embeddingModel}" expected dim=${expectedDim}`,
    );
  }

  // Call the collector (HTTP-only boundary — no LanceDB import).
  let resp;
  try {
    resp = await axios.post<CollectorResponseBody>(
      `${getEnv().COLLECTOR_URL}/api/ingest/query`,
      {
        query: "test",
        workspaceId: workspaceIdArg,
        limit: 1,
        embeddingModel,
      },
      { timeout: 30000 },
    );
  } catch (err: unknown) {
    console.error(
      `[inspect-embeddings] collector unreachable: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const body = resp.data || ({} as CollectorResponseBody);
  const results: CollectorResultRow[] = body.results || [];
  const firstResult = results[0];

  // Probe the response shape (Open Question Q1).
  const firstResultKeys = firstResult ? Object.keys(firstResult).join(",") : "(empty)";
  console.log(
    `[inspect-embeddings] response shape: results=${results.length}, firstResultKeys=${firstResultKeys}`,
  );

  // Derive storedDim from whichever shape the collector exposes.
  let storedDim: number | undefined;
  if (firstResult?.vector && Array.isArray(firstResult.vector)) {
    storedDim = firstResult.vector.length;
  } else if (typeof firstResult?.dimension === "number") {
    storedDim = firstResult.dimension;
  } else if (typeof body.dimension === "number") {
    storedDim = body.dimension;
  }

  // Assertion path A: dim available + expected dim known.
  if (storedDim !== undefined && expectedDim !== undefined) {
    if (storedDim !== expectedDim) {
      console.error(
        `[inspect-embeddings] MISMATCH: stored=${storedDim} expected=${expectedDim}`,
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    console.log(
      `[inspect-embeddings] OK stored=${storedDim} expected=${expectedDim}`,
    );
    await prisma.$disconnect();
    process.exit(0);
  }

  // Assertion path B (fallback per Q1): dim NOT available — assert non-zero
  // result count for a known-good workspace.
  if (results.length === 0) {
    console.error(
      `[inspect-embeddings] no results returned for a known-good workspace — possible dim mismatch or empty index`,
    );
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(
    `[inspect-embeddings] OK (fallback) — ${results.length} result(s) returned for workspace ${workspaceIdArg}`,
  );
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("[inspect-embeddings] failed:", e);
  process.exit(1);
});