// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { logger } from "../utils/logger";
import { getEnv, clearEnvCache } from "../config/env";
import { getOllamaClient } from "./ollamaClient";

// D-08: Auto-configure only when corresponding environment variables are not already set.
// D-09: Run the Ollama reachability check on every server startup.
// D-10: Query Ollama's /api/tags endpoint to auto-set OLLAMA_MODEL from the first available model.
// D-11: Skip auto-configuration entirely if Ollama is reachable but has no models available.
export async function autoDetectOllama(): Promise<void> {
  const env = getEnv();

  // D-08: Respect explicit configuration. These checks intentionally read raw
  // process.env rather than getEnv(): getEnv() resolves OLLAMA_BASE_URL to its
  // default ("http://ollama:11434") so it would never be undefined, which would
  // disable the "skip auto-config when explicitly set" semantics. The raw read
  // distinguishes "operator set this" from "schema supplied a default". See
  // .planning/codebase/CONCERNS.md (#2 accepted exception).
  if (env.LLM_PROVIDER !== "ollama" && process.env.LLM_PROVIDER) return;
  if (process.env.OLLAMA_BASE_URL) return;

  const ollamaUrl = "http://ollama:11434";

  try {
    const response = await getOllamaClient(ollamaUrl, { timeoutMs: 3000 }).list();
    const models: Array<{ name: string }> = response.models || [];

    // D-11: Skip when Ollama is reachable but has no models
    if (models.length === 0) {
      logger.info("[ollama] Ollama is reachable but has no models. Skipping auto-config.");
      return;
    }

    // D-10: Auto-set env vars for this process lifetime.
    //
    // Why mutate process.env (and not persist to SystemConfig, as a codebase
    // review once suggested): getEnv() reads process.env, NOT SystemConfig, for
    // these keys — so writing to SystemConfig would NOT change what
    // providerService.resolveProviderConfig() sees via getEnv(). Mutating
    // process.env is the correct mechanism to feed the resolved values back
    // through getEnv(). The immediately-following clearEnvCache() invalidates
    // the parsed cache so downstream getEnv() callers observe the new values
    // (this is the staleness mitigation — no read sees a stale cached value).
    // The mutation only runs when the vars were NOT already set (D-08 guards
    // above), so an operator's explicit configuration is never overwritten.
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_BASE_URL = ollamaUrl;
    process.env.OLLAMA_MODEL = models[0]!.name;

    // Invalidate the getEnv() cache so downstream code sees the new values
    clearEnvCache();

    logger.info(`[ollama] Auto-configured with model: ${models[0]!.name}`);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.info(`[ollama] Not reachable at ${ollamaUrl}: ${message}`);
  }
}
