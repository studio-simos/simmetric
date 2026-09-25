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

    // Phase 205 D-11 hard constraint — the deepseek-ocr builder ignores
    // ocrPrompt (byte-identical regression pin).
    it("ignores ocrPrompt entirely (byte-identical output with ocrPrompt set)", () => {
      const withOverride = buildDeepseekOcrPrompt({
        ...baseParams,
        ocrPrompt: "Text recognition:",
      });
      const without = buildDeepseekOcrPrompt(baseParams);
      expect(withOverride.systemPrompt).toBe(without.systemPrompt);
      expect(withOverride.userPrompt).toBe(without.userPrompt);
      expect(withOverride.images).toBeUndefined();
      expect(withOverride.userPrompt).toBe(
        "<|grounding|>Convert the document to markdown. [Page 3/10]",
      );
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

    // Phase 205 D-11 (OCR-04) — ocrPrompt override + byte-identical fallback.
    describe("ocrPrompt override (Phase 205 OCR-04)", () => {
      const GLM_LEGACY_PROMPTS = {
        text: "You are a text recognition engine. Transcribe all visible text into clean Markdown.",
        table: "You are a table recognition engine. Extract all tables as Markdown pipe tables.",
        figure: "You are a figure recognition engine. Describe all diagrams and images.",
        generic: [
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
        ].join("\n"),
      };

      const GLM_LEGACY_USER_PROMPT = "Transcribe page 3 of 10 to Markdown.";

      it("uses ocrPrompt as systemPrompt for ALL modes when non-empty", () => {
        for (const ocrMode of ["text", "table", "figure", "generic", undefined] as const) {
          const prompt = buildGlmOcrPrompt({
            ...baseParams,
            ocrMode,
            ocrPrompt: "Text recognition:",
          });
          expect(prompt.systemPrompt).toBe("Text recognition:");
          expect(prompt.userPrompt).toBe(GLM_LEGACY_USER_PROMPT);
          expect(prompt.images).toEqual(["BASE64STUB"]);
        }
      });

      it("sends the raw (untrimmed) ocrPrompt verbatim as systemPrompt", () => {
        // Raw value sent verbatim; trim is only the emptiness check
        const prompt = buildGlmOcrPrompt({
          ...baseParams,
          ocrPrompt: "  Text recognition:  ",
        });
        expect(prompt.systemPrompt).toBe("  Text recognition:  ");
      });

      it("falls back byte-identically to per-mode strings when ocrPrompt is empty", () => {
        for (const [ocrMode, expected] of Object.entries(GLM_LEGACY_PROMPTS)) {
          const prompt = buildGlmOcrPrompt({
            ...baseParams,
            ocrMode: ocrMode as "text" | "table" | "figure" | "generic",
            ocrPrompt: "",
          });
          expect(prompt.systemPrompt).toBe(expected);
          expect(prompt.userPrompt).toBe(GLM_LEGACY_USER_PROMPT);
        }
      });

      it("falls back byte-identically when ocrPrompt is undefined", () => {
        for (const [ocrMode, expected] of Object.entries(GLM_LEGACY_PROMPTS)) {
          const prompt = buildGlmOcrPrompt({
            ...baseParams,
            ocrMode: ocrMode as "text" | "table" | "figure" | "generic",
            ocrPrompt: undefined,
          });
          expect(prompt.systemPrompt).toBe(expected);
        }
      });

      it("treats whitespace-only ocrPrompt as empty (legacy fallback)", () => {
        for (const [ocrMode, expected] of Object.entries(GLM_LEGACY_PROMPTS)) {
          const prompt = buildGlmOcrPrompt({
            ...baseParams,
            ocrMode: ocrMode as "text" | "table" | "figure" | "generic",
            ocrPrompt: "   \t\n  ",
          });
          expect(prompt.systemPrompt).toBe(expected);
        }
      });

      it("customInstructions still appends identically in the ocrPrompt-set path", () => {
        const prompt = buildGlmOcrPrompt({
          ...baseParams,
          ocrMode: "text",
          ocrPrompt: "Text recognition:",
          customInstructions: "Preserve borders",
        });
        expect(prompt.userPrompt).toBe(`${GLM_LEGACY_USER_PROMPT}\nPreserve borders`);
      });

      it("customInstructions still appends identically in the ocrPrompt-unset path", () => {
        const prompt = buildGlmOcrPrompt({
          ...baseParams,
          ocrMode: "text",
          customInstructions: "Preserve borders",
        });
        expect(prompt.userPrompt).toBe(`${GLM_LEGACY_USER_PROMPT}\nPreserve borders`);
      });
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

    // Phase 205 D-11 hard constraint — the generic builder ignores ocrPrompt
    // (byte-identical regression pin).
    it("ignores ocrPrompt entirely (byte-identical output with ocrPrompt set)", () => {
      const withOverride = buildGenericOcrPrompt({
        ...baseParams,
        ocrPrompt: "Text recognition:",
      });
      const without = buildGenericOcrPrompt(baseParams);
      expect(without.systemPrompt).toContain("You are a document OCR engine");
      expect(without.systemPrompt).toContain("1. Output ONLY the Markdown");
      expect(without.systemPrompt).toBe("You are a document OCR engine. Your sole task is to transcribe the content of document images into clean, well-structured Markdown.\n\nRules:\n1. Output ONLY the Markdown content of the document. No greetings, no explanations, no \"Here is the transcription:\" preambles.\n2. Preserve the document's structure: headings (# ## ###), bullet lists, numbered lists, tables (Markdown pipe tables), and paragraph breaks.\n3. For images or diagrams, insert: [Image: brief description]\n4. If text is unclear, ambiguous, or potentially misread, insert: [UNVERIFIED: reason] immediately after the uncertain text.\n5. Do not correct grammar, spelling, or formatting of the source document. Transcribe what you see, not what you think it should be.\n6. For handwritten text, do your best and mark it: [HANDWRITING: transcribed text]\n7. Preserve the reading order: left-to-right, top-to-bottom.");
      expect(withOverride.systemPrompt).toBe(without.systemPrompt);
      expect(withOverride.userPrompt).toBe(without.userPrompt);
      expect(withOverride.images).toEqual(without.images);
    });
  });
});
