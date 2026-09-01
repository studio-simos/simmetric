// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { stripGroundingTags, sanitizeChatTokens } from "../groundingCleanup";

describe("stripGroundingTags", () => {
  // -----------------------------------------------------------------------
  // Basic: tag + text on same line
  // -----------------------------------------------------------------------
  it("removes ref and det tags when text follows on the same line", () => {
    const input =
      '<|ref|>title<|/ref|><|det|>[[120, 300, 582, 344]]<|/det|>\n' +
      "Profilo Professionale Sviluppatore e Gestore IT";
    const result = stripGroundingTags(input);
    expect(result).toBe(
      "Profilo Professionale Sviluppatore e Gestore IT",
    );
  });

  // -----------------------------------------------------------------------
  // Multiple blocks
  // -----------------------------------------------------------------------
  it("handles multiple grounding blocks in sequence", () => {
    const input = [
      '<|ref|>title<|/ref|><|det|>[[120, 300, 582, 344]]<|/det|>',
      "Profilo Professionale Sviluppatore",
      '<|ref|>text<|/ref|><|det|>[[115, 362, 858, 394]]<|/det|>',
      "Competenze accumulate negli ultimi 2 anni di professione.",
    ].join("\n");
    const result = stripGroundingTags(input);
    // After stripping, the tag-only lines become empty, leaving a blank line
    // between the two text blocks — this is correct paragraph separation.
    expect(result).toBe(
      "Profilo Professionale Sviluppatore\n\n" +
        "Competenze accumulate negli ultimi 2 anni di professione.",
    );
  });

  // -----------------------------------------------------------------------
  // Empty / whitespace-only tags (Pages 2-3 bug)
  // -----------------------------------------------------------------------
  it("handles empty grounding tags (matching pages 2-3 from report)", () => {
    const input = [
      "Page 2",
      "<|ref|>title<|/ref|><|det|>[[115, 85, 827, 124]]<|/det|>",
      "",
      "<|ref|>text<|/ref|><|det|>[[114, 143, 840, 210]]<|/det|>",
      "",
      "<|ref|>title<|/ref|><|det|>[[117, 247, 225, 265]]<|/det|>",
      "",
    ].join("\n");
    const result = stripGroundingTags(input);
    // Only non-empty lines should remain: "Page 2" (the non-grounding content)
    expect(result).toBe("Page 2");
  });

  // -----------------------------------------------------------------------
  // Inline text (text immediately after det tag on same line)
  // -----------------------------------------------------------------------
  it("handles inline text after grounding tags", () => {
    const input = [
      '<|ref|>text<|/ref|><|det|>[[145, 730, 790, 762]]<|/det|> Programmazione full-stack: Next.js/React',
      '<|ref|>text<|/ref|><|det|>[[145, 766, 835, 780]]<|/det|> Senior in formattazione CSS ed HTML',
    ].join("\n");
    const result = stripGroundingTags(input);
    // Space after det tag on first line is trimmed by the final .trim().
    // Space on subsequent lines is preserved (mid-string whitespace).
    expect(result).toBe(
      "Programmazione full-stack: Next.js/React\n" +
        " Senior in formattazione CSS ed HTML",
    );
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------
  it("is idempotent — applying twice produces same result as once", () => {
    const input = [
      '<|ref|>title<|/ref|><|det|>[[120, 300, 582, 344]]<|/det|>',
      "Profilo Professionale Sviluppatore",
      '<|ref|>text<|/ref|><|det|>[[115, 362, 858, 394]]<|/det|>',
      "Competenze accumulate.",
    ].join("\n");
    const first = stripGroundingTags(input);
    const second = stripGroundingTags(first);
    expect(second).toBe(first);
  });

  // -----------------------------------------------------------------------
  // Already-clean markdown (no grounding tags)
  // -----------------------------------------------------------------------
  it("does not modify clean markdown", () => {
    const input = [
      "# Profilo Professionale",
      "",
      "Sviluppatore e Gestore IT",
      "",
      "## Competenze",
      "",
      "- Next.js/React",
      "- Docker & Playwright",
    ].join("\n");
    const result = stripGroundingTags(input);
    expect(result).toBe(input);
  });

  // -----------------------------------------------------------------------
  // Empty string
  // -----------------------------------------------------------------------
  it("returns empty string unchanged", () => {
    expect(stripGroundingTags("")).toBe("");
  });

  // -----------------------------------------------------------------------
  // sub_title type
  // -----------------------------------------------------------------------
  it("handles sub_title grounding type", () => {
    const input = [
      '<|ref|>sub_title<|/ref|><|det|>[[115, 569, 592, 586]]<|/det|>',
      "Altri progetti AI in corso",
    ].join("\n");
    const result = stripGroundingTags(input);
    expect(result).toBe("Altri progetti AI in corso");
  });

  // -----------------------------------------------------------------------
  // Whitespace handling: preserves paragraph breaks
  // -----------------------------------------------------------------------
  it("preserves intentional paragraph breaks", () => {
    const input = [
      '<|ref|>title<|/ref|><|det|>[[120, 300, 582, 344]]<|/det|>',
      "Primo paragrafo.",
      "",
      "Secondo paragrafo.",
    ].join("\n");
    const result = stripGroundingTags(input);
    expect(result).toBe("Primo paragrafo.\n\nSecondo paragrafo.");
  });

  // -----------------------------------------------------------------------
  // Collapses excessive blank lines (3+ → 2)
  // -----------------------------------------------------------------------
  it("collapses 3+ consecutive blank lines to 2", () => {
    const input = [
      '<|ref|>text<|/ref|><|det|>[[1, 2, 3, 4]]<|/det|>',
      "Testo",
      "",
      "",
      "",
      "Altro testo",
    ].join("\n");
    const result = stripGroundingTags(input);
    expect(result).toBe("Testo\n\nAltro testo");
  });

  // -----------------------------------------------------------------------
  // Leading/trailing whitespace
  // -----------------------------------------------------------------------
  it("trims leading and trailing whitespace", () => {
    const input = [
      "",
      '<|ref|>title<|/ref|><|det|>[[1, 2, 3, 4]]<|/det|>',
      "  Testo con spazi  ",
      "",
    ].join("\n");
    const result = stripGroundingTags(input);
    expect(result).toBe("Testo con spazi");
  });
});

// ---------------------------------------------------------------------------
// Chat-template token stripping (260815-05p)
//
// DeepSeek OCR occasionally degenerates and leaks its chat-template control
// tokens (im_start/im_end/md_start/md_end/doc_start/doc_end/im_continue/
// im_begin) into the markdown body — often with a zero-width space (U+200B)
// between "<" and "|", as observed in pasted bug reports. It may also echo
// back fragments of the OCR prompt and emit bare role-keyword lines
// (system/user/assistant). All zero-width-space literals below are written
// as explicit "\u200b" concatenations so the invisible character stays
// reviewable in diffs.
// ---------------------------------------------------------------------------

/** Zero-width space used by the leaked-token variant. */
const ZWSP = "​";

/** Build a leaked chat-template token in the U+200B form, e.g. "<|im_start|>". */
const zwToken = (name: string): string => "<" + ZWSP + "|" + name + "|>";

describe("chat-template token stripping", () => {
  // -----------------------------------------------------------------------
  // 1. Chat-template tokens removed — both plain and U+200B forms
  // -----------------------------------------------------------------------
  it("removes chat-template tokens in both plain and U+200B forms", () => {
    const input = [
      zwToken("im_start"),
      "<|md_start|>",
      "Hello world",
      zwToken("im_end"),
      "<|md_end|>",
      zwToken("doc_start"),
      "<|doc_end|>",
      zwToken("im_continue"),
      "<|im_begin|>",
    ].join("\n");
    const result = stripGroundingTags(input);
    expect(result).toBe("Hello world");
    expect(result).not.toContain("<|");
    expect(result).not.toContain("<" + ZWSP + "|");
  });

  // -----------------------------------------------------------------------
  // 2a. Role keyword line — NO leak markers -> untouched
  // -----------------------------------------------------------------------
  it("keeps a bare role-keyword line when no leak markers are present", () => {
    const input = "system\nHello world";
    expect(stripGroundingTags(input)).toBe(input);
  });

  it("keeps 'user' and 'assistant' lines in leak-free documents", () => {
    // Note: \n{3,} collapse and final .trim() are part of the documented
    // behavior and apply here — but the role words must survive intact.
    expect(stripGroundingTags("user\nA note about the user\n\nassistant")).toBe(
      "user\nA note about the user\n\nassistant",
    );
  });

  // -----------------------------------------------------------------------
  // 2b. Role keyword line — removed when leak markers were present
  // -----------------------------------------------------------------------
  it("removes a bare 'system' line when chat-template leak markers are present", () => {
    const input = zwToken("im_start") + "system\nHello world" + zwToken("im_end");
    // The only surviving content line is "Hello world" (final .trim()
    // removes the leading blank line).
    expect(stripGroundingTags(input)).toBe("Hello world");
  });

  it("removes bare 'user' and 'assistant' lines when leak markers are present", () => {
    const input = [
      zwToken("im_start") + "user",
      "First content line",
      "<|im_end|>",
      "<|im_start|>" + "assistant",
      "Second content line",
    ].join("\n");
    const result = stripGroundingTags(input);
    // Tokens and role keywords are erased in place; the empty-line
    // collapsing pass reduces the resulting 3-newline runs to "\n\n"
    // (paragraph separation).
    expect(result).toBe("First content line\n\nSecond content line");
  });

  // -----------------------------------------------------------------------
  // 3. Prompt-echo lines removed
  // -----------------------------------------------------------------------
  it("removes the 'you will be prompted to provide' prompt-echo line", () => {
    const input = [
      "Legitimate heading",
      "you will be prompted to provide a brief description of the document in Markdown format.",
      "Legitimate trailing line",
    ].join("\n");
    const result = stripGroundingTags(input);
    // The prompt-echo line is erased in place, and the resulting empty line
    // is preserved as paragraph separation ("\n\n") by the blank-line
    // collapsing pass.
    expect(result).toBe("Legitimate heading\n\nLegitimate trailing line");
  });

  it("removes the 'Here is an example of the Markdown content' prompt-echo line", () => {
    const input = [
      "# Title",
      "Here is an example of the Markdown content for the document:",
      "Some real content",
    ].join("\n");
    const result = stripGroundingTags(input);
    // Same paragraph-separation semantics as the test above.
    expect(result).toBe("# Title\n\nSome real content");
  });

  // -----------------------------------------------------------------------
  // 4. Mixed realistic paste (matches the user's bug report)
  // -----------------------------------------------------------------------
  it("cleans a mixed paste of tokens, prompt echo, role lines and real content", () => {
    // Real-world leak excerpt shape: chat-template tokens (plain and
    // zero-width forms) interleaved with a prompt echo and role keywords.
    const input = [
      zwToken("im_start") + "system",
      "You are a document OCR engine.",
      zwToken("im_end"),
      "<|im_start|>" + "user",
      "you will be prompted to provide a brief description of the document in Markdown format. Here is an example of the Markdown content for the document:",
      "<|im_end|>",
      zwToken("im_start") + "assistant",
      zwToken("md_start"),
      "# Measurement Plan",
      "Scaling",
      "Build your measurement framework before launch",
      zwToken("md_end"),
      "<|doc_start|>" + zwToken("doc_end"),
      zwToken("im_continue") + "<|im_begin|>",
    ].join("\n");
    const result = stripGroundingTags(input);
    expect(result).not.toContain("<" + ZWSP + "|");
    expect(result).not.toContain("<|im_");
    expect(result).not.toContain("<|md_");
    expect(result).not.toContain("<|doc_");
    expect(result).toContain("Scaling");
    expect(result).toContain("Build your measurement framework before launch");
    expect(result).toContain("# Measurement Plan");
    expect(result).toContain("You are a document OCR engine.");
    // No bare role-keyword lines left over
    expect(result).not.toMatch(/(^\s*(system|user|assistant)\s*$)/m);
    // Prompt echo gone
    expect(result).not.toContain("you will be prompted to provide");
    expect(result).not.toContain("Here is an example of the Markdown content");
  });

  // -----------------------------------------------------------------------
  // 5. Idempotency with leaked tokens
  // -----------------------------------------------------------------------
  it("is idempotent on input containing leaked chat-template tokens", () => {
    const input = [
      zwToken("im_start") + "system",
      "you will be prompted to provide a brief description of the document.",
      zwToken("im_end"),
      "# Real Title",
      "Real content line",
    ].join("\n");
    const once = stripGroundingTags(input);
    const twice = stripGroundingTags(once);
    expect(twice).toBe(once);
    expect(once).toContain("# Real Title");
    expect(once).toContain("Real content line");
  });

  // -----------------------------------------------------------------------
  // 6. Structure preservation — markdown/code untouched when leak-free
  // -----------------------------------------------------------------------
  it("passes headers, bold and fenced code blocks through unchanged", () => {
    const input = [
      "# Heading",
      "",
      "Some **bold** text and a mention of system configuration.",
      "",
      "```ts",
      'const user = "system";',
      "const role = system && user ? assistant : null;",
      "```",
      "",
      "The assistant should follow the user instructions.",
    ].join("\n");
    const result = stripGroundingTags(input);
    expect(result).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// sanitizeChatTokens (260826-gsr) — universal always-on chat-template
// token stripper. SEPARATE from stripGroundingTags: strips ONLY chat-template
// control tokens (im_*, md_*, doc_*, im_impression, truncated forms) and
// does NOT touch grounding tags (<|ref|>, <|det|>). Applied on every OCR
// page regardless of prompt template (ocrStages wiring).
// ---------------------------------------------------------------------------

describe("sanitizeChatTokens", () => {
  const ZWSP = "​";
  const zwToken = (name: string): string => "<" + ZWSP + "|" + name + "|>";

  // --- im_* family (plain + zero-width-space) ---
  it("strips <|im_start|>, <|im_end|>, <|im_continue|>, <|im_begin|>", () => {
    const input = [
      "<|im_start|>",
      "<|im_end|>",
      "<|im_continue|>",
      "<|im_begin|>",
      "Hello world",
    ].join("\n");
    expect(sanitizeChatTokens(input)).toBe("Hello world");
  });

  it("strips zero-width-space forms of the im_* family", () => {
    const input = [
      zwToken("im_start"),
      zwToken("im_end"),
      zwToken("im_continue"),
      zwToken("im_begin"),
      "Content line",
    ].join("\n");
    expect(sanitizeChatTokens(input)).toBe("Content line");
  });

  // --- md_* family (plain + zero-width-space) ---
  it("strips <|md_start|>, <|md_end|>, <|md_continue|>", () => {
    const input = [
      "<|md_start|>",
      "<|md_end|>",
      "<|md_continue|>",
      "Body text",
    ].join("\n");
    expect(sanitizeChatTokens(input)).toBe("Body text");
  });

  it("strips zero-width-space forms of the md_* family", () => {
    const input = [zwToken("md_start"), zwToken("md_end"), "Body"].join("\n");
    expect(sanitizeChatTokens(input)).toBe("Body");
  });

  // --- doc_* family ---
  it("strips <|doc_start|> and <|doc_end|>", () => {
    const input = ["<|doc_start|>", "<|doc_end|>", "Doc body"].join("\n");
    expect(sanitizeChatTokens(input)).toBe("Doc body");
  });

  // --- im_impression variant ---
  it("strips <|im_impression|>", () => {
    const input = ["<|im_impression|>", "Impression content"].join("\n");
    expect(sanitizeChatTokens(input)).toBe("Impression content");
  });

  // --- truncated forms (no closing |>) ---
  it("strips the truncated <|md| form (no closing |>)", () => {
    const input = "<|md|some text that follows without a closing bracket";
    expect(sanitizeChatTokens(input)).toBe("some text that follows without a closing bracket");
  });

  it("strips the truncated <|im_start| form (no closing |>)", () => {
    // sanitizeChatTokens strips the truncated token <|im_start| but does NOT
    // remove the role keyword "system" that follows — role-line removal is
    // stripGroundingTags' responsibility (gated on leak detection). Here we
    // assert the token prefix is gone and the rest survives.
    const input = "<|im_start|system\nReal content";
    const result = sanitizeChatTokens(input);
    expect(result).not.toContain("<|im_start|");
    expect(result).toContain("system");
    expect(result).toContain("Real content");
  });

  it("strips zero-width-space truncated forms", () => {
    const input = "<" + ZWSP + "|md|trailing text";
    expect(sanitizeChatTokens(input)).toBe("trailing text");
  });

  // --- residual `<` cleanup at line start ---
  it("cleans up an isolated `<` left at the start of a line after stripping", () => {
    // After stripping a truncated token, an isolated `<` may remain at the
    // start of a line. The sanitizer removes it.
    const input = "<\nReal content";
    expect(sanitizeChatTokens(input)).toBe("Real content");
  });

  // --- idempotency ---
  it("is idempotent — applying twice produces the same result as once", () => {
    const input = [
      zwToken("im_start") + "system",
      "<|md_start|>",
      "<|md|truncated",
      "# Real heading",
      "Real content line one.",
      "Real content line two.",
    ].join("\n");
    const once = sanitizeChatTokens(input);
    const twice = sanitizeChatTokens(once);
    expect(twice).toBe(once);
  });

  it("is idempotent on already-clean markdown (no-op)", () => {
    const input = [
      "# Heading",
      "",
      "Some **bold** text.",
      "",
      "```ts",
      'const x = "<|not_a_token|>";',
      "```",
    ].join("\n");
    expect(sanitizeChatTokens(input)).toBe(input);
  });

  // --- empty / undefined / null ---
  it("returns empty string unchanged", () => {
    expect(sanitizeChatTokens("")).toBe("");
  });

  it("returns undefined unchanged", () => {
    expect(sanitizeChatTokens(undefined as unknown as string)).toBeUndefined();
  });

  it("returns null unchanged", () => {
    expect(sanitizeChatTokens(null as unknown as string)).toBeNull();
  });

  // --- grounding tags preserved ---
  it("does NOT strip grounding tags (<|ref|>, <|det|>) — those belong to stripGroundingTags", () => {
    const input =
      '<|ref|>title<|/ref|><|det|>[[0,0,1,1]]<|/det|>\nReal content';
    expect(sanitizeChatTokens(input)).toBe(input);
  });

  it("preserves <|ref|>/<|det|> even when chat-template tokens are also present", () => {
    const input =
      '<|ref|>title<|/ref|><|det|>[[0,0,1,1]]<|/det|>\n' +
      "<|im_start|>\n" +
      "Real content\n" +
      "<|md_end|>";
    const result = sanitizeChatTokens(input);
    expect(result).toContain("<|ref|>title<|/ref|>");
    expect(result).toContain("<|det|>[[0,0,1,1]]<|/det|>");
    expect(result).toContain("Real content");
    expect(result).not.toContain("<|im_start|>");
    expect(result).not.toContain("<|md_end|>");
  });

  // --- realistic mixed leak (matches the KB/archive defect) ---
  it("cleans a realistic leaked-token sample from an archive OCR page", () => {
    const input = [
      zwToken("im_start") + "system",
      "You are an OCR engine.",
      zwToken("im_end"),
      "<|im_start|>user",
      "<|md|",
      "# Article 1",
      "The quick brown fox. The quick brown fox. The quick brown fox.",
      "<|md_end|>",
      zwToken("doc_start") + zwToken("doc_end"),
    ].join("\n");
    const result = sanitizeChatTokens(input);
    expect(result).not.toContain("<" + ZWSP + "|");
    expect(result).not.toContain("<|im_");
    expect(result).not.toContain("<|md");
    expect(result).not.toContain("<|doc_");
    expect(result).toContain("# Article 1");
    expect(result).toContain("The quick brown fox.");
    // Idempotency sanity on the realistic sample
    expect(sanitizeChatTokens(result)).toBe(result);
  });
});
