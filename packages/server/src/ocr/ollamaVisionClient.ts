// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Ollama Vision OCR Client
 *
 * Provides the ocrPage function that orchestrates a single-page OCR call
 * to an Ollama vision model via the official `ollama` (ollama-js) client
 * (Phase 92-03, D-01 — the hand-rolled axios NDJSON plumbing was deleted;
 * the shared getOllamaClient() factory from 92-01 is the single transport).
 *
 * Per-model endpoint selection (modelRegistry.ts, untouched):
 * - apiEndpoint "generate" (glm-ocr / generic) → client.generate({...})
 *   yields chunks with `response` (markdown delta) + done/eval_count/done_reason
 * - apiEndpoint "chat" (deepseek-ocr) → client.chat({ messages:[{role,content,images}] })
 *   yields chunks with `message.content` (markdown delta) + done/eval_count/done_reason
 *
 * Key design decisions (per RESEARCH.md / 92-PATTERNS.md):
 * - Shared client from getOllamaClient(host, { timeoutMs: OCR_TIMEOUT }) — the
 *   factory's timeout-wrapped fetch is the ONLY timeout mechanism (Pitfall 1:
 *   ollama-js has NO timeout option).
 * - Temperature: 0 inside `options` object (NOT top-level — Pitfall 3).
 * - keep_alive: from getEnv().OLLAMA_KEEP_ALIVE (default 10m from 92-01,
 *   D-04 — replaces the pre-migration hardcoded 5m).
 * - num_predict: from getEnv().OCR_NUM_PREDICT (default 8192), num_ctx: modelConfig.contextWindow.
 * - images: base64 string arrays ONLY — never file paths (ollama-js
 *   encodeImage sniffs existing paths and reads disk — Pitfall 9).
 * - Per-request abort: bridge the caller's AbortSignal to THIS stream's
 *   iterator.abort() ({once:true} + finally removal) — NEVER client.abort()
 *   on the shared singleton (Pitfall 2 — kills all in-flight streams).
 * - Errors: duck-typed ResponseError (err.name === "ResponseError" +
 *   err.status_code) — ResponseError is thrown but NOT exported by ollama,
 *   so importing it fails typecheck (Pitfall 3). No ollama-js error type
 *   escapes ocrPage (D-08).
 */

import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { type OcrModelConfig } from "./modelRegistry";
import {
  buildDeepseekOcrPrompt,
  buildGlmOcrPrompt,
  buildGenericOcrPrompt,
  type OcrPrompt,
} from "./promptTemplates";
import { getOllamaClient } from "../services/ollamaClient";

// ---------------------------------------------------------------------------
// OCR System Prompt (fallback path)
// Per AI-SPEC Section 4 and plan specification: instructs the vision model
// to produce clean Markdown with structural preservation, uncertainty
// flagging, and no commentary.
// ---------------------------------------------------------------------------

const OCR_SYSTEM_PROMPT = [
  "You are a document OCR engine. Your sole task is to transcribe the content of document images into clean, well-structured Markdown.",
  "",
  "Rules:",
  "1. Output ONLY the Markdown content of the document. No greetings, no explanations, no \"Here is the transcription:\" preambles.",
  "2. Preserve the document's structure: headings (# ## ###), bullet lists, numbered lists, tables (Markdown pipe tables), and paragraph breaks.",
  "3. For images or diagrams, insert: [Image: brief description]",
  "4. If text is unclear, ambiguous, or potentially misread, insert: [UNVERIFIED: reason] immediately after the uncertain text.",
  "5. Do not correct grammar, spelling, or formatting of the source document. Transcribe what you see, not what you think it should be.",
  "6. For handwritten text, do your best and mark it: [HANDWRITING: transcribed text]",
  "7. Preserve the reading order: left-to-right, top-to-bottom.",
].join("\n");

// ---------------------------------------------------------------------------
// ocrPage
// ---------------------------------------------------------------------------

/**
 * Result of a single-page OCR operation.
 */
export interface OcrPageResult {
  /** 1-based page number */
  pageNumber: number;
  /** Extracted Markdown content */
  markdown: string;
  /** Number of tokens used by the vision model (eval_count) */
  tokensUsed: number;
  /** Duration of the OCR call in milliseconds */
  durationMs: number;
  /** True when the vision model stopped at the output token limit (done_reason: "length") — output may be incomplete */
  truncated?: boolean;
}

/**
 * Send a single page image to the Ollama vision model for OCR.
 *
 * Flow:
 * 1. Base64-encode the image buffer
 * 2. Build system + user prompts using model-specific template
 * 3. Resolve the shared ollama-js client via getOllamaClient (92-01)
 * 4. POST via client.generate (default) or client.chat (deepseek-ocr)
 *    — ollama-js parses the NDJSON upstream and yields parsed chunk objects
 * 5. Accumulate `response` (generate) or `message.content` (chat) in order
 * 6. Log warnings for truncation (done_reason: "length")
 * 7. Return structured result
 *
 * Critical implementation details:
 * - Temperature: 0 MUST be inside the `options` object (NOT top-level)
 * - /api/generate response uses `response` field
 * - /api/chat response uses `message.content` field
 * - deepseek-ocr requires the chat endpoint (documented on ollama.com)
 * - keep_alive flows from OLLAMA_KEEP_ALIVE (D-04 — default "10m")
 * - Per-request abort bridges the caller's signal to THIS stream's
 *   iterator.abort() — NEVER client.abort() on the shared singleton
 *   (Pitfall 2 — kills all in-flight streams process-wide)
 * - images are base64 strings ONLY — never file paths (Pitfall 9)
 *
 * @param imageBuffer - PNG-encoded image of the page
 * @param pageNumber - 1-based page number (for prompt context)
 * @param totalPages - Total pages in document (for prompt context)
 * @param modelName - Actual model name (e.g. "deepseek-ocr:latest"), NOT the registry pattern
 * @param modelConfig - Pre-resolved OCR model configuration
 * @param signal - Optional AbortSignal for cancellation
 * @param useFallbackPrompt - If true, use simplified plain-text prompt
 * @param ocrMode - Optional mode override (text/table/figure/generic)
 * @param customInstructions - Optional custom instructions appended to prompt
 * @returns OcrPageResult with markdown, token count, and duration
 */
export async function ocrPage(
  imageBuffer: Buffer,
  pageNumber: number,
  totalPages: number,
  modelName: string,
  modelConfig: OcrModelConfig,
  signal?: AbortSignal,
  useFallbackPrompt?: boolean,
  ocrMode?: "text" | "table" | "figure" | "generic",
  customInstructions?: string,
): Promise<OcrPageResult> {
  const base64Image = imageBuffer.toString("base64");
  const startedAt = Date.now();

  let systemPrompt: string;
  let userPrompt: string;
  let images: string[] | undefined;

  if (useFallbackPrompt) {
    // Backward compatibility: simplified plain-text prompt
    systemPrompt = OCR_SYSTEM_PROMPT;
    userPrompt = `Transcribe page ${pageNumber} of ${totalPages} as plain text.`;
    images = [base64Image];
  } else {
    let promptResult: OcrPrompt;
    switch (modelConfig.promptTemplate) {
      case "deepseek-ocr":
        promptResult = buildDeepseekOcrPrompt({
          pageNumber,
          totalPages,
          base64Image,
          ocrMode,
          customInstructions,
        });
        break;
      case "glm-ocr":
        promptResult = buildGlmOcrPrompt({
          pageNumber,
          totalPages,
          base64Image,
          ocrMode,
          customInstructions,
        });
        break;
      default:
        promptResult = buildGenericOcrPrompt({
          pageNumber,
          totalPages,
          base64Image,
          ocrMode,
          customInstructions,
        });
    }

    systemPrompt = promptResult.systemPrompt;
    userPrompt = promptResult.userPrompt;
    images = promptResult.images ?? [base64Image];
  }

  // Determine API endpoint based on model config (modelRegistry untouched)
  const useChatEndpoint = modelConfig.apiEndpoint === "chat";

  // Shared ollama-js client — the factory's timeout-wrapped fetch is the
  // ONLY timeout mechanism (Pitfall 1: ollama-js has NO timeout option).
  const client = getOllamaClient(getEnv().OLLAMA_BASE_URL, {
    timeoutMs: getEnv().OCR_TIMEOUT,
  });

  // Common request fields shared by both endpoints, mirroring the
  // pre-migration body verbatim. CRITICAL: temperature lives INSIDE options,
  // NOT at top level (Pitfall 3). images stays base64 strings — NEVER file
  // paths (Pitfall 9). keep_alive flows from OLLAMA_KEEP_ALIVE (D-04).
  const options = {
    temperature: 0,
    // num_predict flows from OCR_NUM_PREDICT env var (default 8192) — admins
    // raise the cap for dense documents; truncation is surfaced via the
    // `truncated` flag on the result so downstream code can react.
    num_predict: getEnv().OCR_NUM_PREDICT,
    num_ctx: modelConfig.contextWindow, // context window from config
  };
  const keepAlive = getEnv().OLLAMA_KEEP_ALIVE;

  try {
    // ollama-js parses NDJSON upstream and yields parsed chunk objects.
    // Build the typed request per endpoint so TS infers the
    // AbortableAsyncIterator<ChatResponse | GenerateResponse> return.
    type StreamChunk = {
      response?: string;
      message?: { content?: string };
      done?: boolean;
      done_reason?: string;
      eval_count?: number;
    };
    type Stream = AsyncIterable<StreamChunk> & { abort(): void };

    let stream: Stream;
    if (useChatEndpoint) {
      // /api/chat format: messages array with images on the user message
      const messages: Array<{ role: string; content: string; images?: string[] }> = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: userPrompt, images });
      stream = (await client.chat({
        model: modelName,
        messages,
        stream: true,
        options,
        keep_alive: keepAlive,
      } as Parameters<typeof client.chat>[0])) as unknown as Stream;
    } else {
      // /api/generate format: system + prompt + images at top level
      stream = (await client.generate({
        model: modelName,
        system: systemPrompt,
        prompt: userPrompt,
        images,
        stream: true,
        options,
        keep_alive: keepAlive,
      } as Parameters<typeof client.generate>[0])) as unknown as Stream;
    }

    // Per-request abort: bridge the caller's signal to THIS stream only —
    // NEVER client.abort() on the shared singleton (Pitfall 2).
    const onAbort = () => stream.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let content = "";
    let evalCount = 0;
    let truncated = false;

    // 260829-lkq: ollama-js 0.6.3 throws "Did not receive done or success
    // response in stream." when the NDJSON stream ends without a done:true
    // chunk. The glm-ocr custom RENDERER/PARSER engine intermittently does
    // exactly that AFTER emitting complete, correct transcription (verified
    // live: 916 chunks / 2337 chars of valid text, ollama-side log shows a
    // normal stop with truncated=0). Discarding that content fails whole
    // pages that actually succeeded. Salvage rule: if the iterator dies with
    // that signature AND we already accumulated non-empty content, treat the
    // content as the page result with truncated=true (same semantics as the
    // done_reason:"length" path). Empty content ⇒ a real failure — rethrow.
    const DONE_LESS_ERROR = "Did not receive done or success response in stream.";

    try {
      for await (const chunk of stream) {
        // Field-name difference between endpoints is the critical bit:
        // generate → chunk.response; chat → chunk.message?.content.
        if (useChatEndpoint) {
          const delta = chunk.message?.content ?? "";
          if (delta) content += delta;
        } else {
          const delta = chunk.response ?? "";
          if (delta) content += delta;
        }
        if (chunk.done) {
          evalCount = chunk.eval_count ?? 0;
          // done_reason: "stop" (normal), "length" (truncated), "load" (unloaded)
          if (chunk.done_reason === "length") {
            truncated = true;
            logger.warn("[ocr] OCR output truncated (done_reason: length)", {
              evalCount,
            });
          }
        }
      }
    } catch (streamErr: unknown) {
      const isDoneLess =
        streamErr instanceof Error && streamErr.message === DONE_LESS_ERROR;
      if (isDoneLess && content.length > 0) {
        // Salvage: the stream delivered real transcription before closing
        // without the done marker. WARN (not error) — degraded-but-successful.
        logger.warn(
          "[ocr] OCR stream ended without done marker — salvaging accumulated content",
          {
            pageNumber,
            contentLength: content.length,
            error: streamErr.message,
          },
        );
        signal?.removeEventListener("abort", onAbort);
        return {
          pageNumber,
          markdown: content,
          tokensUsed: evalCount,
          durationMs: Date.now() - startedAt,
          truncated: true,
        };
      }
      throw streamErr;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    return {
      pageNumber,
      markdown: content,
      tokensUsed: evalCount,
      durationMs: Date.now() - startedAt,
      truncated,
    };
  } catch (err: unknown) {
    // ollama-js ResponseError is thrown but NOT exported by the module —
    // duck-type via err.name / err.status_code (RESEARCH Pattern 3, Pitfall 3).
    const errorName = (err as Error | null)?.name;
    const status =
      err !== null &&
      typeof err === "object" &&
      "status_code" in err &&
      typeof (err as { status_code?: unknown }).status_code === "number"
        ? (err as { status_code: number }).status_code
        : undefined;

    if (errorName === "ResponseError" && status !== undefined) {
      if (status === 404) {
        throw new Error(
          `Model "${modelName}" not found. Run 'ollama pull ${modelName}' first.`,
          { cause: err },
        );
      }
      if (status === 401) {
        throw new Error(
          `Model "${modelName}" authentication failed. Check your API key or Ollama configuration.`,
          { cause: err },
        );
      }
      if (status === 400) {
        throw new Error(
          `Model "${modelName}" rejected the request (HTTP 400). The request may be invalid.`,
          { cause: err },
        );
      }
    }
    // AbortError, TypeError (fetch failed), TimeoutError, and a done-less
    // stream with EMPTY content (260829-lkq — salvageable done-less streams
    // with content never reach this path) all fall through to the generic
    // wrap — identical to today's CanceledError/network-error path (D-08).
    // No ollama-js error type escapes ocrPage.
    throw new Error(`Ollama vision OCR error: ${(err as Error).message}`, {
      cause: err,
    });
  }
}