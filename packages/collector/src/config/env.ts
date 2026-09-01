// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";
import {
  embeddingProviderSchema,
  vectorDbProviderSchema,
  ollamaKeepAliveSchema,
  loadRootEnv,
  resolveRootEnvPath,
} from "@simmetric-chat/shared";
import { logger } from "../utils/logger";

// OPS-05 (D-12) lineage: env paths resolve __dirname-relative, not
// process.cwd(). The per-package .env file was REMOVED (Phase 177 cleanup)
// — the repo-root .env is THE single runtime config. ENV_PATH points at the
// root file (marker-walk; cwd-adjacent fallback when no
// pnpm-workspace.yaml exists up-chain); it feeds the fail-loud Zod
// diagnostics below (`Expected .env at:`) and is intentionally NOT
// exported (nothing outside this module reads it — Phase 180 sweep).
const ENV_PATH = resolveRootEnvPath(__dirname);

// Root-only loader: fills ONLY keys absent from process.env (never
// overridden), no values logged. ENV_PATH is the same path the fail-loud
// diagnostics below print, keeping the contract identical.
loadRootEnv(__dirname);

// Phase 178.1 (CF-08): exported for the envExampleParity tripwire's shape
// introspection only — do not mutate (.shape is mutable in Zod).
export const envSchema = z.object({
  COLLECTOR_PORT: z.coerce.number().default(3210),
  COLLECTOR_URL: z.string().default("http://localhost:3210"),
  SERVER_URL: z.string().default("http://localhost:3000"),
  // D-05 (Phase 89-03): "hf-local" is the additive HF v3 provider (@huggingface/transformers).
  // "local" stays the unchanged default (Xenova 2.x). Air-gap stance: allowRemoteModels=false.
  // Single source of truth: packages/shared/src/schemas/env.schema.ts.
  EMBEDDING_PROVIDER: embeddingProviderSchema,
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  // D-08 (Phase 91-01): "pgvector" is the third provider (raw pg Pool in the
  // collector, URL via runtime config D-02). Default "lancedb" is invariant
  // (Rule 3 additive widening).
  // Single source of truth: packages/shared/src/schemas/env.schema.ts.
  VECTOR_DB_PROVIDER: vectorDbProviderSchema,
  VECTOR_DB_URL: z.string().optional(),
  VECTOR_DB_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://ollama:11434"),
  // D-04 (Phase 92-01): ollama-js keep_alive for warm KV cache between
  // requests (guidance 5–30min; never -1/infinite). Threaded to embed calls
  // by the collector embed migration plan; schema-only in this plan.
  // Single source of truth: packages/shared/src/schemas/env.schema.ts.
  OLLAMA_KEEP_ALIVE: ollamaKeepAliveSchema,
  STORAGE_PATH: z.string().default("./storage"),
  // Phase 93 / RER-01 (D-04): CrossEncoder reranker model + cache dir. Additive
  // fields with safe defaults — no process.exit(1) risk. The reranker is a
  // sibling of HuggingFaceLocalEmbeddingProvider; it loads lazily on first
  // /ingest/rerank call (default-OFF is a server-side SystemConfig gate, planned
  // in 93-02; the collector endpoint is always available). A1 correction: the
  // default is the ONNX-quantized community model (NOT BAAI/bge-reranker-v2-m3,
  // which ships safetensors-only and throws at pipeline() load time under JS).
  RERANKER_MODEL: z.string().default("Xenova/bge-reranker-base"),
  // RERANKER_CACHE_DIR mirrors HF_CACHE_DIR: optional override; when unset the
  // reranker falls back to HF_CACHE_DIR then env.cacheDir (HF v3 default).
  RERANKER_CACHE_DIR: z.string().optional(),
  COLLECTOR_SECRET: z
    .string()
    .min(1, "COLLECTOR_SECRET is required"),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env | null = null;

export function getEnv(): Env {
  if (!parsedEnv) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      // OPS-05 (D-13): actionable diagnostic naming resolved .env path +
      // missing keys BEFORE the non-zero exit. No raw secret values logged.
      const missing = result.error.issues
        .filter(
          (i) =>
            i.code === "invalid_type" &&
            i.message.includes("received undefined"),
        )
        .map((i) => i.path.join("."))
        .join(", ");
      logger.error(
        `[env] Invalid environment variables. Expected .env at: ${ENV_PATH}` +
          (missing ? `\n[env] Missing required key(s): ${missing}` : "") +
          `\n[env] Validation errors: ${JSON.stringify(
            result.error.flatten().fieldErrors,
          )}`,
      );
      process.exit(1);
    }
    parsedEnv = result.data;
  }
  return parsedEnv;
}

export function clearEnvCache(): void {
  parsedEnv = null;
}
