// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 176 (CF-01/D-01): single source of truth for the environment-config
 * surface duplicated across packages/server/src/config/env.ts and
 * packages/collector/src/config/env.ts. Each consuming package's z.object
 * places these fields inline — identical enums, identical defaults, zero
 * runtime behavior change (D-02). Pure data module: no IO, no side effects
 * (probe CF-01 concurrency), and re-imports resolve through the module cache
 * to the identical schema objects (probe CF-01 idempotency — pinned in
 * src/__tests__/envSchema.test.ts).
 *
 * Provenance of the enum values (keep provenance when widening additively):
 * - EMBEDDING_PROVIDERS — Phase 89-03 (D-05): "hf-local" added additively;
 *   "local" stays the unchanged default (Xenova 2.x).
 * - VECTOR_DB_PROVIDERS — Phase 91-01 (D-08): "pgvector" widened additively;
 *   Phase 114-01: "chroma". Default "lancedb" is invariant (Rule 3 additive
 *   widening — do NOT touch or reorder). The pgvector URL is served by
 *   /api/system/vector-db-config from getEnv().DATABASE_URL.
 * - OLLAMA_KEEP_ALIVE — Phase 92-01 (D-04): ollama-js keep_alive for warm KV
 *   cache between requests (guidance 5–30 min; never -1/infinite — no
 *   permanent memory pinning on small deployments).
 *
 * Out-of-scope by design (T-176-03 / Phase 178): raw-read keys (HF_*, ENCRYPTION_KEY,
 * API_KEY_HMAC_SECRET, LOG_LEVEL) are NOT absorbed here.
 */
import { z } from "zod";

export const EMBEDDING_PROVIDERS = [
  "local",
  "openai",
  "ollama",
  "hf-local",
] as const;

export const VECTOR_DB_PROVIDERS = [
  "lancedb",
  "qdrant",
  "pgvector",
  "chroma",
] as const;

export const embeddingProviderSchema = z
  .enum(EMBEDDING_PROVIDERS)
  .default("local");

export const vectorDbProviderSchema = z
  .enum(VECTOR_DB_PROVIDERS)
  .default("lancedb");

export const ollamaKeepAliveSchema = z.string().default("10m");

type EmbeddingProviderValue = (typeof EMBEDDING_PROVIDERS)[number];
type VectorDBProviderValue = (typeof VECTOR_DB_PROVIDERS)[number];