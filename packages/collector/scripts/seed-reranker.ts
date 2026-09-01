/**
 * seed-reranker.ts — Operator-facing CLI that pre-populates the on-disk HF cache
 * for the CrossEncoder reranker model `onnx-community/bge-reranker-v2-m3-ONNX`
 * (~544MB int8 ONNX, A2 size correction — bge-reranker-v2-m3 is XLM-RoBERTa-large
 * 568M params → int8 ≈ 544MB; NOT the original ~220MB estimate).
 *
 * Phase 93 / DEP-06 — closes the air-gap deployment path. Mirror of the
 * `packages/server/scripts/rotate-encryption-key.ts` CLI-script pattern
 * (PATTERNS notes no existing embed-seed script; this is a NEW script pattern).
 *
 * Air-gap stance (T-93-01 mitigate, T-93-05 supply chain):
 *   - This seeding script runs on a NETWORKED host with `env.allowRemoteModels=true`
 *     so it can download the 4-file int8 ONNX cache from huggingface.co.
 *   - The collector RUNTIME uses `env.allowRemoteModels=false` (set in
 *     `src/services/reranker.ts:110`) so a cache miss throws fail-loud at
 *     `pipeline()` load time — NOT a silent network attempt.
 *   - The script pins the model `--revision <sha>` for supply-chain safety
 *     (T-93-05) and uses the official `onnx-community` HF org
 *     (Transformers.js-tagged model, 42K downloads).
 *
 * Two deploy options (D-06):
 *   Option A (preferred for air-gap): bake the seeded cache into the Docker image
 *     via the additive `COPY` step in `docker/Dockerfile.collector`. The runtime
 *     loads offline with `allowRemoteModels=false`.
 *   Option B (operator flexibility): host-mount the seeded cache dir as a volume
 *     (`docker/docker-compose.yml` collector service). Documented as a comment.
 *
 * DEP-06 SC4 (manual checkpoint — Task 2 of plan 93-03): on a networked host
 * with a staged `Xenova/all-MiniLM-L6-v2` embed cache + this seeded reranker
 * cache, `pnpm --filter collector test -- hfLocalEmbedding` is green against
 * the real ONNX cache under HF v3.8.1. HF v4 is NOT adopted (defer v0.16).
 *
 * Usage:
 *   pnpm --filter collector seed:reranker [--cache-dir <path>] [--revision <sha>]
 *
 * Defaults:
 *   --cache-dir  ./packages/collector/.cache/huggingface  (mirror embeddings cache)
 *   --revision  (unset — HF hub resolves to the latest onnx-community revision;
 *                pass an explicit SHA to pin for supply-chain reproducibility)
 */

import { program } from "commander";
import * as fs from "fs";
import * as path from "path";

// D-04: the official Transformers.js-tagged ONNX fork. BAAI/bge-reranker-v2-m3
// ships safetensors-only and throws at pipeline() load time under JS; the
// onnx-community fork is the ONNX-quantized variant the reranker loads.
const RERANKER_MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";

// The 4 files the quantized ONNX pipeline actually loads (mirror
// reranker.ts:60-65 REQUIRED_FILES + embeddings.ts). A half-seeded cache
// (e.g. tokenizer.json present but onnx/model_quantized.onnx missing) would
// pass a naive single-file guard and fail at pipeline load with a confusing
// error. The post-seed presence check surfaces ALL 4 paths so the operator
// can restore the full cache in one pass.
const REQUIRED_FILES = [
  "config.json",
  "tokenizer_config.json",
  "tokenizer.json",
  "onnx/model_quantized.onnx",
] as const;

program
  .name("seed-reranker")
  .description(
    "Pre-populate the on-disk HF cache for onnx-community/bge-reranker-v2-m3-ONNX " +
      "(~544MB int8 ONNX). Run on a networked host; the collector runtime loads " +
      "the seeded cache offline with allowRemoteModels=false.",
  )
  .option(
    "--cache-dir <path>",
    "Local filesystem path for the seeded cache",
    "./packages/collector/.cache/huggingface",
  )
  .option(
    "--revision <sha>",
    "Pin the model revision (SHA) for supply-chain safety (T-93-05). " +
      "Unset = latest onnx-community revision.",
  )
  .action(async (opts: { cacheDir: string; revision?: string }) => {
    const { env, pipeline } = await import("@huggingface/transformers");

    // Seeding stance (opposite of the runtime air-gap stance in reranker.ts:110):
    // allowRemoteModels=true so pipeline() downloads the 4-file int8 ONNX cache
    // from huggingface.co. The collector runtime sets allowRemoteModels=false.
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    env.cacheDir = path.resolve(opts.cacheDir);

    console.log(`[seed:reranker] cacheDir       = ${env.cacheDir}`);
    console.log(`[seed:reranker] model          = ${RERANKER_MODEL}`);
    console.log(
      `[seed:reranker] revision       = ${opts.revision ?? "(latest onnx-community)"}`,
    );
    console.log(
      `[seed:reranker] allowRemote    = true (networked host; runtime flips to false)`,
    );
    console.log(
      `[seed:reranker] downloading ~544MB int8 ONNX (A2: bge-reranker-v2-m3 is XLM-RoBERTa-large 568M params)…`,
    );

    // D-06 / Pitfall 3: HF v3 renamed `quantized: true` to `dtype: "q8"`. Passing
    // `quantized` silently ignores and loads fp32 (~2.2 GB, 5x slower). The
    // collector runtime pipeline call uses the same `dtype: "q8"` shape.
    const pipelineOpts: { dtype: "q8"; revision?: string } = { dtype: "q8" };
    if (opts.revision) pipelineOpts.revision = opts.revision;

    await pipeline("text-classification", RERANKER_MODEL, pipelineOpts);

    console.log(
      `[seed:reranker] cache populated at ${env.cacheDir} for ${RERANKER_MODEL} (~544MB int8 ONNX)`,
    );

    // DEP-06 4-file layout check — read-only presence check against REQUIRED_FILES
    // (concurrency: idempotent, no mutation of the cache; interruption leaves the
    // on-disk cache untouched). Surfaces the FIRST missing file path AND
    // enumerates all 4 required files so the operator can restore in one pass.
    const modelDir = path.join(env.cacheDir, RERANKER_MODEL);
    const missing: string[] = [];
    const present: string[] = [];
    for (const relative of REQUIRED_FILES) {
      const filePath = path.join(modelDir, relative);
      if (fs.existsSync(filePath)) {
        present.push(relative);
      } else {
        missing.push(filePath);
      }
    }
    console.log(`[seed:reranker] model dir      = ${modelDir}`);
    console.log(`[seed:reranker] present files  = ${present.join(", ")}`);
    if (missing.length > 0) {
      console.error(
        `[seed:reranker] MISSING ${missing.length} of ${REQUIRED_FILES.length} required files:`,
      );
      for (const p of missing) console.error(`  - ${p}`);
      console.error(
        `[seed:reranker] Restore all 4 files under ${modelDir} or re-run the seed script.`,
      );
      process.exit(1);
    }
    console.log(
      `[seed:reranker] DEP-06 4-file layout check PASSED (all ${REQUIRED_FILES.length} files present).`,
    );
    console.log(
      `[seed:reranker] Next: Option A — bake ${env.cacheDir} into the Docker image ` +
        `(see docker/Dockerfile.collector COPY step); Option B — host-mount as a volume ` +
        `(see docker/docker-compose.yml collector service). Runtime loads offline ` +
        `(allowRemoteModels=false).`,
    );
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(
    `[seed:reranker] FAILED:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});