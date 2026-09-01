// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * RAG OCR Service — Server-side vision OCR for PDF ingestion pipeline.
 *
 * Extracts text from PDFs using a vision-capable LLM (Ollama, OpenAI, Anthropic)
 * before forwarding to the collector for chunking/embedding.
 *
 * Flow:
 *   1. Load PDF via pdfjs-dist
 *   2. Render each page to PNG
 *   3. Call vision model for OCR
 *   4. Concatenate page results
 *   5. Write to a temporary .txt file
 *   6. Return the .txt file path (caller forwards to collector)
 *
 * For now supports Ollama vision models via ocrPage().
 * OpenAI/Anthropic vision support can be added by extending the provider
 * branch in ocrSinglePage().
 */

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { logger } from "../utils/logger";
import { renderPageToPng } from "../ocr/pdfRenderer";
import { ocrPage } from "../ocr/ollamaVisionClient";
import { resolveModelConfig } from "../ocr/modelRegistry";
import { stripGroundingTags } from "../ocr/groundingCleanup";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMP_DIR = path.resolve(process.cwd(), "storage/uploads");
const MAX_PAGES = 50; // Safety cap to avoid runaway processing

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RagOcrResult {
  /** Path to the temporary .txt file containing extracted text */
  textFilePath: string;
  /** Number of pages processed */
  pageCount: number;
  /** Total tokens consumed by the vision model */
  totalTokens: number;
  /** Total duration in milliseconds */
  totalDurationMs: number;
}

/**
 * Extract text from a PDF using a vision-capable LLM.
 *
 * @param pdfPath — Absolute path to the PDF file
 * @param modelName — Vision model identifier (e.g. "glm-ocr:latest")
 * @returns Path to a temporary .txt file with the extracted text
 */
export async function extractTextFromPdf(
  pdfPath: string,
  modelName: string,
): Promise<RagOcrResult> {
  const pdfBuffer = await fs.readFile(pdfPath);
  const pdfDoc = await pdfjsLib
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      disableAutoFetch: true,
      disableStream: true,
    })
    .promise;

  const totalPages = Math.min(pdfDoc.numPages, MAX_PAGES);
  const modelConfig = resolveModelConfig(modelName);
  logger.info(`[rag-ocr] Starting OCR on ${totalPages} page(s) with model ${modelName}`, {
    pdfPath,
    modelName,
    totalPages,
  });

  const pageTexts: string[] = [];
  let totalTokens = 0;
  let totalDurationMs = 0;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const pngBuffer = await renderPageToPng(pdfPath, pageNum, 2.0);
      const ocrResult = await ocrPage(
        pngBuffer,
        pageNum,
        totalPages,
        modelName,
        modelConfig,
        undefined,
        false,
      );

      // Strip grounding tags for DeepSeek OCR models
      let cleanMarkdown = ocrResult.markdown;
      if (modelConfig.promptTemplate === "deepseek-ocr") {
        cleanMarkdown = stripGroundingTags(ocrResult.markdown);
      }

      pageTexts.push(`## Page ${pageNum}\n\n${cleanMarkdown}`);
      totalTokens += ocrResult.tokensUsed;
      totalDurationMs += ocrResult.durationMs;

      logger.info(`[rag-ocr] Page ${pageNum}/${totalPages} done`, {
        tokensUsed: ocrResult.tokensUsed,
        durationMs: ocrResult.durationMs,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isModelNotFound = message.toLowerCase().includes("not found");
      if (isModelNotFound) {
        logger.warn(`[rag-ocr] Page ${pageNum} model not found`, { error: message });
      } else {
        logger.error(`[rag-ocr] Page ${pageNum} failed`, { error: message });
      }
      pageTexts.push(
        `## Page ${pageNum}\n\n` +
        (isModelNotFound
          ? `[FAILED: OCR model not installed — ${message}]`
          : `[FAILED: OCR error — ${message}]`),
      );
    }
  }

  const fullText = pageTexts.join("\n\n---\n\n");

  // Write to a temp .txt file
  const hash = crypto.randomBytes(8).toString("hex");
  const textFilePath = path.resolve(TEMP_DIR, `ocr-${hash}.txt`);
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.writeFile(textFilePath, fullText, "utf-8");

  logger.info(`[rag-ocr] Completed. Text written to ${textFilePath}`, {
    pageCount: totalPages,
    totalTokens,
    totalDurationMs,
  });

  return {
    textFilePath,
    pageCount: totalPages,
    totalTokens,
    totalDurationMs,
  };
}

/**
 * Clean up a temporary OCR text file. Best-effort — swallows errors.
 */
export async function cleanupOcrTextFile(textFilePath: string): Promise<void> {
  try {
    await fs.unlink(textFilePath);
  } catch {
    // Ignore cleanup errors
  }
}
