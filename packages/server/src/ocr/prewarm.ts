// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { getOllamaClient } from "../services/ollamaClient";

/**
 * Result of a model pre-warm operation.
 */
export interface PrewarmResult {
  success: boolean;
  message: string;
  modelName: string;
  status?: string;
}

/**
 * Pre-warm an Ollama model by pulling it via the official ollama-js client
 * (Phase 92-03, D-01 — the hand-rolled axios /api/pull POST was replaced
 * by client.pull({ model, stream: false }) through the shared
 * getOllamaClient() factory from 92-01).
 *
 * Non-streaming mode returns a single ProgressResponse with the pull status.
 * Timeout: OCR_TIMEOUT (default 600s) via the factory's timeout-wrapped fetch
 * (Pitfall 1: ollama-js has NO timeout option).
 *
 * This function does NOT throw — errors are returned as structured
 * PrewarmResult with success=false. The route handler (Plan 07) wraps
 * this with authMiddleware + requireAdmin for defense-in-depth.
 *
 * @param modelName - The full model identifier (e.g., "glm-ocr:latest")
 * @returns PrewarmResult with success status and human-readable message
 */
export async function prewarmModel(modelName: string): Promise<PrewarmResult> {
  try {
    const response = await getOllamaClient(getEnv().OLLAMA_BASE_URL, {
      timeoutMs: getEnv().OCR_TIMEOUT,
    }).pull({ model: modelName, stream: false });

    // ollama-js pull takes `model` (not `name`) and returns a
    // ProgressResponse whose `status` field mirrors the old axios
    // response.data.status shape.
    const status = response.status ?? "unknown";

    logger.info("[ocr] Model pre-warmed", { modelName, status });

    return {
      success: true,
      message: `Model "${modelName}" is ready.`,
      modelName,
      status,
    };
  } catch (error: unknown) {
    // Never throws — any ollama-js error (ResponseError / TimeoutError /
    // fetch failed) is swallowed into the structured result exactly as
    // the pre-migration axios catch did (D-08 parity by construction).
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error("[ocr] Failed to pre-warm model", {
      modelName,
      error: errorMessage,
    });

    return {
      success: false,
      message:
        "Could not pre-warm model. Check Ollama connection and model name.",
      modelName,
    };
  }
}