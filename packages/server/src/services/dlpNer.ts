// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * LLM contextual NER for the document DLP scan (Phase 192 plan 02 — D-02).
 *
 * Rides the EXISTING ollama client (getOllamaClient) — no new provider
 * wiring (D-02: "LLM NER rides the existing Ollama client ONLY; non-ollama
 * → null → NER skipped"). Structured output via ollama `format` JSON-schema
 * (constrained decoding — the model CANNOT emit non-conforming JSON) plus a
 * verbatim-substring post-check (T-192-04 paraphrase guard: the model cannot
 * inject entity text absent from the chunk — entries whose `text` is not an
 * exact substring are DROPPED, never masked by fuzzy match).
 *
 * Graceful arms (fail-open to the deterministic tiers — a NER failure never
 * blocks the scan): missing provider → [] (skip), timeout → [] per chunk,
 * parse failure → [] per chunk. Deterministic regex+checksum entities are
 * still masked without the NER tier.
 */
import { getOllamaClient } from "./ollamaClient";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import {
  nerResponseSchema,
  type NerResponse,
  type DlpEntityClass,
  type ProviderConfig,
} from "@simmetric-chat/shared";

/**
 * NER output JSON-schema — the ollama `format` payload (constrained
 * decoding). enum mirrors shared DLP_ENTITY_CLASSES (kept literal because
 * ollama needs a raw JSON schema object, not a Zod schema).
 */
export const NER_FORMAT = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          entityClass: {
            type: "string",
            enum: ["PERSON", "ADDRESS", "FINANCIAL", "GOV_ID", "CONTACT"],
          },
        },
        required: ["text", "entityClass"],
      },
    },
  },
  required: ["entities"],
} as const;

/**
 * System prompt. Italian (the domain language — D-13 spirit) + Pitfall 3(b):
 * bracketed placeholder tokens are OPAQUE — the model must never alter or
 * re-emit them as entity text (they contain no PII by construction).
 */
const NER_SYSTEM_PROMPT =
  "Estrai entità PII dal testo italiano. Rispondi SOLO con JSON conforme allo schema. " +
  "I token tra parentesi quadre sono opachi, non alterarli e non estrarli.";

/** Per-chunk NER options — num_ctx stays modest (research: single-chunk input). */
const NER_NUM_CTX = 2048;

export interface NerProviderConfig {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}

/**
 * Resolve the NER provider for a document scan. The scan's caller resolves
 * the chat LLM via resolveProviderConfig (providerService) and calls this
 * gate: ONLY ollama-type providers are eligible (D-02). Anything else →
 * null → the NER pass is SKIPPED entirely (deterministic tiers still run).
 */
export function resolveNerProvider(config: ProviderConfig | null): NerProviderConfig | null {
  if (!config) return null;
  if (config.type !== "ollama") return null;
  if (!config.baseUrl || !config.model) return null;
  return { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey ?? null };
}

/**
 * Run the LLM NER pass on ONE chunk (per-chunk input is naturally bounded —
 * collector chunks are ~1000 chars).
 *
 * Returns `{ text, entityClass }[]` entries that PASSED the verbatim-substring
 * post-check, deduped by (text, entityClass) within the chunk. On missing
 * provider / timeout / parse failure → [] and log (the degraded arm is safe:
 * the deterministic tiers still mask).
 */
export async function runNerOnChunk(
  chunkText: string,
  providerConfig: NerProviderConfig | null,
): Promise<Array<{ text: string; entityClass: DlpEntityClass }>> {
  if (!providerConfig) return [];
  if (chunkText.length === 0) return [];

  const timeoutMs = getEnv().LLM_TIMEOUT;
  const client = getOllamaClient(providerConfig.baseUrl, {
    timeoutMs,
    ...(providerConfig.apiKey ? { apiKey: providerConfig.apiKey } : {}),
  });

  try {
    // Non-streaming chat with constrained-decoding format (research §LLM NER
    // Design). temperature 0 = deterministic extraction. NOTE: we never call
    // client.abort() — the timeout rides the client's wrapped fetch
    // (AbortSignal.timeout inside ollamaClient.fetchWithTimeout).
    const response = await client.chat({
      model: providerConfig.model,
      messages: [
        { role: "system", content: NER_SYSTEM_PROMPT },
        { role: "user", content: chunkText },
      ],
      format: NER_FORMAT,
      options: { temperature: 0, num_ctx: NER_NUM_CTX },
      stream: false,
    });

    const raw = response.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn("[dlp-ner] non-JSON response — NER skipped for chunk", {
        model: providerConfig.model,
      });
      return [];
    }

    const safe = nerResponseSchema.safeParse(parsed);
    if (!safe.success) {
      logger.warn("[dlp-ner] schema-violating response — NER skipped for chunk", {
        model: providerConfig.model,
      });
      return [];
    }

    return postCheckNerEntries(chunkText, safe.data);
  } catch (err: unknown) {
    // Timeout / network failure — the graceful arm: skip NER for this chunk,
    // the deterministic tiers still mask. Never re-throw (fail-open).
    logger.warn("[dlp-ner] NER call failed — chunk skipped (deterministic tiers unaffected)", {
      model: providerConfig.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * T-192-04 paraphrase guard (verbatim-substring post-check): keep only
 * entries whose text occurs VERBATIM in the chunk, dedupe identical
 * (text, entityClass) pairs. Never mask by fuzzy match.
 */
export function postCheckNerEntries(
  chunkText: string,
  parsed: NerResponse,
): Array<{ text: string; entityClass: DlpEntityClass }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; entityClass: DlpEntityClass }> = [];
  for (const entry of parsed.entities) {
    if (entry.text.length === 0) continue;
    if (!chunkText.includes(entry.text)) continue; // paraphrase guard — DROP
    // Placeholder tokens contain no PII; a model echoing them as entities
    // would mask nothing (they are dropped by the scan prefilter anyway).
    if (entry.text.startsWith("[") && entry.text.endsWith("]")) continue;
    const key = `${entry.entityClass}\u0000${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: entry.text, entityClass: entry.entityClass });
  }
  return out;
}