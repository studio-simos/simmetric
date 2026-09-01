// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Gemini (Google Generative Language API) streaming.
// Extracted from the original llmStreaming.ts god-file (Phase 158 / CSW-13).
// buildGeminiRequestBody/extractGeminiText stay in providerService (D-08/D-14).

import axios, { type AxiosRequestConfig } from "axios";
import type { ProviderConfig } from "@simmetric-chat/shared";
import { getEnv } from "../../config/env";
import { buildGeminiRequestBody, extractGeminiText } from "../../services/providerService";
import type { ChatMessageEntry, OnTokenCallback, StreamingLLMResult } from "./types";
import { parseToolCall } from "./toolCallParser";

/**
 * Gemini (Google Generative Language API) streaming —
 * POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *
 * Response is standard SSE (`data: {json}\n\n`). Each event is a full
 * `GenerateContentResponse` with `candidates[0].content.parts[].text`. A single
 * event may carry multiple parts (or zero, e.g. a usage-only final chunk). Token
 * usage lives in `usageMetadata` on the final chunk:
 *   { promptTokenCount, candidatesTokenCount, totalTokenCount }
 *
 * The system prompt is moved into `systemInstruction` and the assistant role
 * is renamed to `"model"` by `buildGeminiRequestBody` (shared with the
 * non-streaming path in providerService).
 */
export async function streamGemini(
  context: ChatMessageEntry[],
  providerConfig: ProviderConfig,
  onToken: OnTokenCallback,
  signal?: AbortSignal,
): Promise<StreamingLLMResult> {
  const apiKey = providerConfig.apiKey;
  if (!apiKey) throw new Error("Gemini API key not configured");

  const body = buildGeminiRequestBody(context, providerConfig);
  const url = `${providerConfig.baseUrl}/v1beta/models/${providerConfig.model}:streamGenerateContent?alt=sse`;

  const response = await axios.post(url, body, {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    responseType: "stream",
    timeout: getEnv().LLM_TIMEOUT,
    signal,
  } as AxiosRequestConfig);

  return parseGeminiSSEStream(response.data, onToken);
}

function parseGeminiSSEStream(
  stream: NodeJS.ReadableStream,
  onToken: OnTokenCallback,
): Promise<StreamingLLMResult> {
  return new Promise((resolve, reject) => {
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let buffer = "";

    const handleEvent = (data: unknown): void => {
      // Text deltas (a single event may carry multiple parts)
      const text = extractGeminiText(data);
      if (text) {
        content += text;
        onToken(text);
      }
      // Usage metadata (present on the final chunk)
      const usage = (data as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
        ?.usageMetadata;
      if (usage) {
        promptTokens = usage.promptTokenCount || promptTokens;
        completionTokens = usage.candidatesTokenCount || completionTokens;
      }
    };

    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      // Keep the last incomplete line
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("event:")) continue;
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          handleEvent(JSON.parse(data));
        } catch {
          // Skip malformed JSON
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
          try {
            handleEvent(JSON.parse(trimmed.slice(6)));
          } catch {
            // Ignore
          }
        }
      }
      const toolCall = parseToolCall(content);
      resolve({ content, toolCall, usage: { promptTokens, completionTokens } });
    });

    stream.on("error", (err: Error) => {
      // D-07: On client disconnect (abortController.abort()), resolve with an
      // estimated usage instead of rejecting so the orchestrator's
      // budget.consumeTokens gets the usage and the save-in-finally (62-03)
      // persists it. Estimate = floor(content.length / 4) completion tokens.
      const isAbortError =
        err.name === "CanceledError" ||
        (err as { code?: string }).code === "ERR_CANCELED" ||
        (err as { code?: string }).code === "ECANCELED" ||
        /abort|cancel/i.test(err.message || "");
      if (isAbortError && content.length > 0) {
        const toolCall = parseToolCall(content);
        resolve({
          content,
          toolCall,
          usage: { promptTokens: 0, completionTokens: Math.floor(content.length / 4) },
        });
        return;
      }
      reject(err);
    });
  });
}
