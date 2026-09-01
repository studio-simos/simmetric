// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

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

export interface OcrPrompt {
  systemPrompt: string;
  userPrompt: string;
  images?: string[];
}

export interface BuildOcrPromptParams {
  pageNumber: number;
  totalPages: number;
  base64Image: string;
  ocrMode?: "text" | "table" | "figure" | "generic";
  customInstructions?: string;
}

export function buildDeepseekOcrPrompt(params: BuildOcrPromptParams): OcrPrompt {
  const mode = params.ocrMode || "generic";

  // Use official DeepSeek OCR prompts (from deepseek-ai/deepseek-ocr documentation).
  // The model is sensitive to prompt format — non-standard phrasing like "Mode: text."
  // has been observed to trigger text degeneration loops.
  let ocrInstruction: string;
  switch (mode) {
    case "text":
      ocrInstruction = "<|grounding|>Free OCR.";
      break;
    case "figure":
      ocrInstruction = "<|grounding|>Parse the figure.";
      break;
    case "table":
      ocrInstruction = "<|grounding|>Extract all tables as Markdown pipe tables.";
      break;
    default: // generic
      ocrInstruction = "<|grounding|>Convert the document to markdown.";
  }

  const customPart = params.customInstructions
    ? ` ${params.customInstructions}`
    : "";

  const userPrompt = `${ocrInstruction} [Page ${params.pageNumber}/${params.totalPages}]${customPart}`;

  return {
    systemPrompt: OCR_SYSTEM_PROMPT,
    userPrompt: userPrompt.trim(),
  };
}

export function buildGlmOcrPrompt(params: BuildOcrPromptParams): OcrPrompt {
  const mode = params.ocrMode || "generic";

  let systemPrompt: string;
  switch (mode) {
    case "text":
      systemPrompt = "You are a text recognition engine. Transcribe all visible text into clean Markdown.";
      break;
    case "table":
      systemPrompt = "You are a table recognition engine. Extract all tables as Markdown pipe tables.";
      break;
    case "figure":
      systemPrompt = "You are a figure recognition engine. Describe all diagrams and images.";
      break;
    default:
      systemPrompt = OCR_SYSTEM_PROMPT;
  }

  const customPart = params.customInstructions
    ? `\n${params.customInstructions}`
    : "";

  return {
    systemPrompt,
    userPrompt: `Transcribe page ${params.pageNumber} of ${params.totalPages} to Markdown.${customPart}`,
    images: [params.base64Image],
  };
}

export function buildGenericOcrPrompt(params: BuildOcrPromptParams): OcrPrompt {
  const customPart = params.customInstructions
    ? `\n${params.customInstructions}`
    : "";

  return {
    systemPrompt: OCR_SYSTEM_PROMPT,
    userPrompt: `Transcribe page ${params.pageNumber} of ${params.totalPages} to Markdown.${customPart}`,
    images: [params.base64Image],
  };
}
