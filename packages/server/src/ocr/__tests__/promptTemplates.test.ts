// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  buildDeepseekOcrPrompt,
  buildGlmOcrPrompt,
  buildGenericOcrPrompt,
} from "../promptTemplates";

describe("promptTemplates", () => {
  const baseParams = {
    pageNumber: 3,
    totalPages: 10,
    base64Image: "BASE64STUB",
  };

  describe("buildDeepseekOcrPrompt", () => {
    it("returns systemPrompt with 7 rules and generic mode by default", () => {
      const prompt = buildDeepseekOcrPrompt(baseParams);
      expect(prompt.systemPrompt).toContain("You are a document OCR engine");
      expect(prompt.systemPrompt).toContain("1. Output ONLY the Markdown");
      expect(prompt.userPrompt).toContain("<|grounding|>Convert the document to markdown");
      expect(prompt.userPrompt).toContain("[Page 3/10]");
    });

    it("does not include images field", () => {
      const prompt = buildDeepseekOcrPrompt(baseParams);
      expect(prompt.images).toBeUndefined();
    });

    it("includes <|grounding|> prefix when ocrMode is figure", () => {
      const prompt = buildDeepseekOcrPrompt({ ...baseParams, ocrMode: "figure" });
      expect(prompt.userPrompt).toContain("<|grounding|>");
      expect(prompt.userPrompt).toContain("Parse the figure");
    });

    it("appends customInstructions after the page info", () => {
      const prompt = buildDeepseekOcrPrompt({
        ...baseParams,
        customInstructions: "Focus on layout",
      });
      expect(prompt.userPrompt).toContain("<|grounding|>");
      expect(prompt.userPrompt).toContain("[Page 3/10] Focus on layout");
    });

    it("uses table extraction prompt with custom instructions for table mode", () => {
      const prompt = buildDeepseekOcrPrompt({
        ...baseParams,
        ocrMode: "table",
        customInstructions: "Preserve borders",
      });
      expect(prompt.userPrompt).toContain("<|grounding|>");
      expect(prompt.userPrompt).toContain("Extract all tables as Markdown pipe tables");
      expect(prompt.userPrompt).toContain("Preserve borders");
    });
  });

  describe("buildGlmOcrPrompt", () => {
    it("returns text recognition system prompt for text mode", () => {
      const prompt = buildGlmOcrPrompt({ ...baseParams, ocrMode: "text" });
      expect(prompt.systemPrompt).toBe(
        "You are a text recognition engine. Transcribe all visible text into clean Markdown."
      );
      expect(prompt.userPrompt).toContain("page 3 of 10");
    });

    it("returns table recognition system prompt for table mode", () => {
      const prompt = buildGlmOcrPrompt({ ...baseParams, ocrMode: "table" });
      expect(prompt.systemPrompt).toBe(
        "You are a table recognition engine. Extract all tables as Markdown pipe tables."
      );
    });

    it("returns figure recognition system prompt for figure mode", () => {
      const prompt = buildGlmOcrPrompt({ ...baseParams, ocrMode: "figure" });
      expect(prompt.systemPrompt).toBe(
        "You are a figure recognition engine. Describe all diagrams and images."
      );
    });

    it("returns generic OCR system prompt for generic mode", () => {
      const prompt = buildGlmOcrPrompt({ ...baseParams, ocrMode: "generic" });
      expect(prompt.systemPrompt).toContain("You are a document OCR engine");
      expect(prompt.systemPrompt).toContain("1. Output ONLY the Markdown");
    });

    it("returns generic OCR system prompt when ocrMode is missing", () => {
      const prompt = buildGlmOcrPrompt(baseParams);
      expect(prompt.systemPrompt).toContain("You are a document OCR engine");
    });

    it("returns images array with one element", () => {
      const prompt = buildGlmOcrPrompt(baseParams);
      expect(prompt.images).toEqual(["BASE64STUB"]);
    });

    it("appends custom instructions on a new line", () => {
      const prompt = buildGlmOcrPrompt({
        ...baseParams,
        customInstructions: "Preserve borders",
      });
      expect(prompt.userPrompt).toContain("Preserve borders");
    });
  });

  describe("buildGenericOcrPrompt", () => {
    it("returns standard OCR system prompt", () => {
      const prompt = buildGenericOcrPrompt(baseParams);
      expect(prompt.systemPrompt).toContain("You are a document OCR engine");
      expect(prompt.systemPrompt).toContain("1. Output ONLY the Markdown");
    });

    it("returns images array with one element", () => {
      const prompt = buildGenericOcrPrompt(baseParams);
      expect(prompt.images).toEqual(["BASE64STUB"]);
    });

    it("appends custom instructions on a new line", () => {
      const prompt = buildGenericOcrPrompt({
        ...baseParams,
        customInstructions: "Focus on headers",
      });
      expect(prompt.userPrompt).toContain("Focus on headers");
    });
  });
});
