// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { fetchTranscript } from "youtube-transcript-plus";
import { parseOfficeFileAsync } from "officeparser";
import { logger } from "../utils/logger";

export interface ParsedDocument {
  text: string;
  metadata: {
    title?: string;
    pages?: number;
    source: string;
    ocrApplied?: boolean;
    ocrSkipped?: string;
    youtubeVideoId?: string;
    parserFallback?: boolean;
  };
}

/**
 * OCR routing mode — explicit signal from the server (D-03/D-04/D-07/D-08).
 *
 * - "auto"   — default, pre-check with pdf-parse (existing behavior)
 * - "vision" — force vision OCR with the provided ocrModel (server-side; collector returns D-04)
 * - "skip"   — D-04 graceful degradation: return empty text + ocrSkipped metadata
 */
export type OcrMode = "auto" | "vision" | "skip";

/**
 * Parse a file based on its extension/MIME type and return extracted text.
 * Includes OCR fallback for image-only PDFs and officeparser for docx/pptx.
 *
 * @param ocrModel — vision model name (e.g. "glm-ocr:latest"); OCR is server-side
 * @param ocrMode  — explicit routing signal from the server (default: "auto")
 */
export async function parseFile(
  filePath: string,
  originalName: string,
  ocrModel?: string,
  ocrMode: OcrMode = "auto",
): Promise<ParsedDocument> {
  const ext = path.extname(originalName).toLowerCase().replace(".", "");
  const buffer = fs.readFileSync(filePath);

  switch (ext) {
    case "pdf":
      return parsePdf(buffer, originalName, ocrModel, ocrMode);
    case "md":
    case "txt":
      return parseText(buffer, originalName);
    case "csv":
      return parseCsv(buffer, originalName);
    case "docx":
    case "doc":
      return parseDocx(filePath, buffer, originalName);
    case "pptx":
    case "ppt":
      return parseOffice(filePath, originalName);
    case "xlsx":
    case "xls":
      return parseXlsx(buffer, originalName);
    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

/**
 * Parse a YouTube URL and extract the transcript.
 */
export async function parseYoutubeUrl(url: string): Promise<ParsedDocument> {
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) {
    throw new Error("Could not extract video ID from YouTube URL");
  }

  try {
    const transcript = await fetchTranscript(videoId);
    const fullText = transcript.map((entry) => entry.text).join(" ");

    return {
      text: fullText,
      metadata: {
        title: `YouTube: ${videoId}`,
        source: url,
        youtubeVideoId: videoId,
      },
    };
  } catch (err: any) {
    throw new Error(`YouTube transcript extraction failed: ${err.message}`, { cause: err });
  }
}

// ─── Internal Parsers ──────────────────────────────────────────

async function parsePdf(
  buffer: Buffer,
  source: string,
  ocrModel?: string,
  ocrMode: OcrMode = "auto",
): Promise<ParsedDocument> {
  // D-04: skip mode — graceful degradation. Still salvage whatever text
  // pdf-parse can extract from the raw PDF (the server may have forwarded it
  // after a vision-OCR failure) rather than silently discarding it. Surface
  // the skip reason via ocrSkipped so the server can record a statusMessage.
  if (ocrMode === "skip") {
    let text = "";
    let pages: number | undefined;
    try {
      const skipData = await pdfParse(buffer);
      text = (skipData.text || "").trim();
      pages = skipData.numpages;
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.warn(`[parser] PDF "${source}" pdf-parse failed during skip salvage`, { error: msg });
    }
    logger.info(`[parser] PDF "${source}" OCR skipped (ocrMode=skip) — D-04 graceful degradation, salvaged ${text.length} chars`);
    return {
      text,
      metadata: { title: source, pages, source, ocrApplied: false, ocrSkipped: "OCR skipped: no vision model" },
    };
  }

  const data = await pdfParse(buffer);
  const textContent = data.text.trim();

  // "auto" mode: if pdf-parse extracted meaningful text, use it directly (existing behavior)
  if (ocrMode === "auto" && textContent.length > 100) {
    return {
      text: data.text,
      metadata: {
        title: source,
        pages: data.numpages,
        source,
      },
    };
  }

  // "vision" mode: force vision OCR (skip the pdf-parse pre-check).
  // Per D-01, OCR is unified on the vision path and performed server-side.
  // If a "vision" request reaches the collector, no server-side OCR was done;
  // return D-04 degradation rather than running a local OCR tier.
  // "auto" mode with < 100 chars: fall back to vision OCR if ocrModel provided, else D-04.
  if (!ocrModel && (ocrMode === "vision" || ocrMode === "auto")) {
    // No model provided — D-04 graceful degradation (no local OCR fallback)
    logger.info(`[parser] PDF "${source}" OCR skipped — no ocrModel provided (ocrMode=${ocrMode})`);
    return {
      text: data.text || "",
      metadata: { title: source, pages: data.numpages, source, ocrApplied: false, ocrSkipped: "OCR skipped: no vision model" },
    };
  }

  logger.info(`[parser] PDF "${source}" proceeding to OCR (ocrMode=${ocrMode}, ${textContent.length} chars)...`);
  return parsePdfWithOcr(buffer, source, data.numpages, ocrModel, ocrMode);
}

async function parsePdfWithOcr(
  buffer: Buffer,
  source: string,
  pages: number,
  ocrModel?: string,
  ocrMode: OcrMode = "auto",
): Promise<ParsedDocument> {
  // D-04: skip mode — return empty text + ocrSkipped metadata
  if (ocrMode === "skip") {
    return {
      text: "",
      metadata: { title: source, pages, source, ocrApplied: false, ocrSkipped: "OCR skipped: no vision model" },
    };
  }

  // Per D-01, OCR is unified on the vision path and performed server-side.
  // If a "vision" (or "auto" fallback) request reaches the collector with an
  // ocrModel, the server-side vision OCR was not performed. Return D-04
  // degradation — the collector no longer runs a local OCR tier.
  logger.info(
    `[parser] PDF "${source}" OCR routed server-side (ocrMode=${ocrMode}, ocrModel=${ocrModel ?? "none"}) — collector returns D-04 degradation`,
  );
  return {
    text: "",
    metadata: {
      title: source,
      pages,
      source,
      ocrApplied: false,
      ocrSkipped: "OCR skipped: vision OCR is server-side",
    },
  };
}

function parseText(buffer: Buffer, source: string): ParsedDocument {
  return {
    text: buffer.toString("utf-8"),
    metadata: {
      title: source,
      source,
    },
  };
}

function parseCsv(buffer: Buffer, source: string): ParsedDocument {
  const text = buffer.toString("utf-8");
  return {
    text,
    metadata: {
      title: source,
      source,
    },
  };
}

/**
 * Parse docx files. Uses officeparser first (handles more complex formatting),
 * falls back to mammoth if officeparser fails.
 */
async function parseDocx(filePath: string, buffer: Buffer, source: string): Promise<ParsedDocument> {
  try {
    const text = await parseOfficeFileAsync(filePath);
    return {
      text,
      metadata: { title: source, source },
    };
  } catch (err: any) {
    logger.warn(`[parser] officeparser failed for "${source}", falling back to mammoth: ${err.message}`);
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value,
      metadata: { title: source, source },
    };
  }
}

/**
 * Parse pptx files via officeparser.
 * Falls back to a degraded empty-text result (with `parserFallback: true`
 * metadata flag) when officeparser fails — mirroring the parseDocx fallback
 * pattern at :159-174, but without a secondary parser since mammoth is
 * DOCX-only (RESEARCH.md Pitfall 4). The document completes with 0 chunks
 * instead of failing the entire ingestion.
 */
async function parseOffice(filePath: string, source: string): Promise<ParsedDocument> {
  try {
    const text = await parseOfficeFileAsync(filePath);
    return {
      text,
      metadata: { title: source, source },
    };
  } catch (err: any) {
    logger.warn(
      `[parser] officeparser failed for "${source}", falling back to degraded text extraction: ${err.message}`,
    );
    return {
      text: "",
      metadata: { title: source, source, parserFallback: true },
    };
  }
}

function parseXlsx(buffer: Buffer, source: string): ParsedDocument {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const texts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const data = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1 });
    texts.push(`=== Sheet: ${sheetName} ===`);
    for (const row of data) {
      if (!row) continue;
      texts.push(row.map((cell) => String(cell ?? "")).join("\t"));
    }
  }

  return {
    text: texts.join("\n"),
    metadata: {
      title: source,
      source,
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function extractYoutubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1] ?? null;
  }

  return null;
}