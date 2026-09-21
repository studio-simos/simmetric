// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * groundingCleanup.ts — DeepSeek OCR output stripper
 *
 * DeepSeek OCR, when invoked with the <|grounding|> prompt prefix, returns
 * spatial-referenced output where each text block is preceded by two tags:
 *
 *   <|ref|>type<|/ref|><|det|>[[x1, y1, x2, y2]]<|/det|>
 *   Actual text content here
 *
 * The type can be: title, text, sub_title, figure, table, etc.
 * Coordinates are in [x1, y1, x2, y2] format.
 *
 * This module strips those tags, leaving only the actual text content.
 * It handles both inline tags (text on same line) and block tags (text on
 * following line). It also strips leaked chat-template structural tokens —
 * PATTERN-BASED (quick task 260919-lx5): ANY single no-space word enclosed
 * in the `<|...|>` envelope is treated as leaked structure and removed, in
 * either the plain form or the zero-width-space form where a U+200B sits
 * between `<` and `|` — except the grounding tags <|ref|>, <|/ref|>, <|det|>
 * and <|/det|>, which belong to the grounding-tag grammar. It also strips
 * bare role-keyword lines (system/user/assistant — only when leak markers
 * were present in the original input), and echoed OCR-prompt lines. The
 * function is idempotent — applying it to already-clean markdown is a no-op.
 */

// ---------------------------------------------------------------------------
// Regex patterns (compiled once at module scope)
// ---------------------------------------------------------------------------

/**
 * Matches a <|ref|>...<|/ref|> tag.
 * The content inside can be any of: title, text, sub_title, figure, table, etc.
 * Non-greedy match to handle multiple tags on the same line.
 */
const REF_TAG_RE = /<\|ref\|>[^<]*<\|\/ref\|>/g;

/**
 * Matches a <|det|>[[...]]<|/det|> tag.
 * Coordinates inside double brackets: [[x1, y1, x2, y2]]
 * Comma-separated numbers, potentially with decimal points.
 */
const DET_TAG_RE = /<\|det\|>\[\[[^\]]*\]\]<\|\/det\|>/g;

/**
 * Matches one or more leading pipe characters at the start of a line,
 * optionally preceded by whitespace. Used to clean up leftover pipes
 * from malformed tag sequences.
 */
const LEADING_PIPE_RE = /^(\s*)\|{1,}(?=\s|$)/gm;

/**
 * Matches a LEAKED chat-template structural token — PATTERN-BASED, not
 * name-allowlist based (quick task 260919-lx5: chat-template token names are
 * open-ended, so enumerating them is a losing game; a single no-space word
 * in the `<|...|>` envelope is never legitimate document content).
 * Matches ANY no-space word of letters/digits/underscores (case-insensitive
 * charset, so uppercase leak variants like `<|IM_START|>` match too) in
 * EITHER form: the plain `<|name|>` form or the zero-width-space form where
 * a U+200B zero-width space sits between `<` and `|` (the form seen in
 * real-world leaked pastes).
 *
 * Serves BOTH `stripGroundingTags` and `sanitizeChatTokens`.
 *
 * The negative lookahead `(?!(?:ref|det)\|)` rejects ONLY the exact names
 * `ref` and `det` — the grounding-tag grammar owned by stripGroundingTags.
 * The closing forms `<|/ref|>` and `<|/det|>` are excluded automatically
 * because `/` is not in the name charset. Near-misses like `<|refx|>` or
 * `<|reference|>` still match and are removed (the lookahead requires the
 * full literal `ref|` right after the opening envelope).
 */
const LEAKED_TOKEN_RE = /<\u200B?\|(?!(?:ref|det)\|)[a-zA-Z0-9_]+\|>/g;

/**
 * Matches the TRUNCATED leaked chat-template token forms that lack the
 * closing `|>` — e.g. `<|md|`, `<|im_start|`, or for ANY novel token name
 * like `<|whatever|` (optionally with a U+200B between `<` and `|`). These
 * appear when the model output is cut mid-token. The pattern matches the
 * prefix only: `<`, optional U+200B, `|`, a generic no-space word, and a
 * trailing `|` — but NO `>` is required after the trailing `|`. The negative
 * lookahead `(?!>)` ensures we do NOT match the complete `<|name|>` form
 * (that is handled by LEAKED_TOKEN_RE); we only want the truncated form
 * where the closing `>` is missing.
 *
 * NO ref/det exclusion here, deliberately: a truncated `<|ref|` (no closing
 * `>`) is a broken grounding fragment that REF_TAG_RE can never clean, so
 * removing it is correct residual cleanup.
 */
const TRUNCATED_TOKEN_RE = /<\u200B?\|[a-zA-Z0-9_]+\|(?!>)/g;

/**
 * Matches an isolated `<` left at the start of a line after stripping a
 * truncated token (residual pipe cleanup — mirrors LEADING_PIPE_RE but for
 * the angle bracket the truncated-form regex leaves behind when the `|>`
 * closing was absent and only `<|name|` was removed).
 */
const LEADING_LT_RE = /^(\s*)<(?=\s|$)/gm;

/**
 * Non-global leak-marker detector used ONLY to gate the conditional
 * role-keyword stripping below. PATTERN-BASED (quick task 260919-lx5):
 * matches `<`, optional U+200B, `|`, then ANY no-space word — so a NOVEL
 * leaked token like `<|whatever|>` (or its truncated `<|whatever|` form,
 * since the trailing `|` is required but the closing `>` is optional) still
 * counts as a leak marker and keeps role-line removal firing. Without this
 * generalization, bare system/user/assistant lines would stop being removed
 * during novel-token dumps. Excludes the exact grounding-tag names `ref`/
 * `det` (same lookahead as LEAKED_TOKEN_RE). Captured against the ORIGINAL
 * input before any replacement, so a leak that starts mid-way through the
 * document still enables role-line removal for the whole string.
 */
const HAS_LEAK_MARKER_RE = /<\u200B?\|(?!(?:ref|det)\|)[a-zA-Z0-9_]+\|/;

/**
 * Whole-line role keywords (system / user / assistant) emitted as bare
 * lines when the model degenerates into dumping its chat template. Applied
 * ONLY when HAS_LEAK_MARKER_RE matched the original input, so legitimate
 * documents that mention "system" / "user" / "assistant" on their own
 * lines are left untouched.
 */
const ROLE_LINE_RE = /^\s*(system|user|assistant)\s*$/gm;

/**
 * Prompt-echo lines: when the OCR model degenerates it may parrot back the
 * prompt preamble verbatim. These two phrases come from the OCR prompt
 * itself, so a line containing them is never legitimate document content —
 * the whole line is removed.
 */
const PROMPT_ECHO_LINE_RES = [
  /^.*you will be prompted to provide.*$/gm,
  /^.*Here is an example of the Markdown content.*$/gm,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip DeepSeek OCR grounding tags and leaked chat-template artifacts from
 * OCR output, leaving only the actual text content.
 *
 * Processing steps:
 * 1. Detect whether the ORIGINAL input contains leaked chat-template tokens
 *    (ANY `<|word|>` / `<|word|` form, plain or U+200B — pattern-based, so
 *    novel token names count too) — used to gate step 3
 * 2. Remove all leaked chat-template structural tokens in both the plain
 *    `<|name|>` and zero-width-space (`<` + U+200B + `|name|>`) forms
 * 3. If (1) detected a leak, remove bare role-keyword lines
 *    (system / user / assistant) — these lines are only emitted during a
 *    chat-template dump, never in legitimate OCR output
 * 4. Remove whole lines that echo the OCR prompt preamble
 *    ("you will be prompted to provide ...", "Here is an example of the
 *    Markdown content ...")
 * 5. Remove all <|ref|>type<|/ref|> tags
 * 6. Remove all <|det|>[[coordinates]]<|/det|> tags
 * 7. Clean up any stray pipe characters left from malformed tag sequences
 * 8. Collapse consecutive blank lines (max 2)
 * 9. Trim leading/trailing whitespace
 *
 * This function is idempotent — applying it to already-clean markdown is a
 * no-op. After the first pass the output contains no leak markers, so
 * steps 1–4 are no-ops on the second application. NOTE: there is NO
 * code-block awareness in this module — token-shaped content (`<|word|>`)
 * is removed wherever it appears, including inside fenced code blocks
 * (```) and inline code (intended per 260919-lx5: a no-space word in the
 * `<| |>` envelope is never legitimate content). Documents that contain NO
 * `<|word|>` forms pass through unchanged (the role-keyword removal is
 * gated on an actual leak being present).
 *
 * @param markdown - Raw OCR output potentially containing grounding tags
 * @returns Clean markdown with grounding tags and chat-template leaks removed
 */
export function stripGroundingTags(markdown: string): string {
  if (!markdown) return markdown;

  // Step 1: detect leaked chat-template tokens in the ORIGINAL input,
  // BEFORE any mutation, so role-line removal is conditioned on the
  // document actually having leaked.
  const hadLeakedTokens = HAS_LEAK_MARKER_RE.test(markdown);

  let cleaned = markdown;

  // Step 2: remove leaked chat-template structural tokens (both forms —
  // pattern-based: any no-space word in the <|...|> envelope)
  cleaned = cleaned.replace(LEAKED_TOKEN_RE, "");

  // Step 3: only when a leak was present, remove bare role-keyword lines
  if (hadLeakedTokens) {
    cleaned = cleaned.replace(ROLE_LINE_RE, "");
  }

  // Step 4: remove prompt-echo lines
  for (const echoRe of PROMPT_ECHO_LINE_RES) {
    cleaned = cleaned.replace(echoRe, "");
  }

  // Step 5: Remove <|ref|>type<|/ref|> tags
  cleaned = cleaned.replace(REF_TAG_RE, "");

  // Step 6: Remove <|det|>[[coordinates]]<|/det|> tags
  cleaned = cleaned.replace(DET_TAG_RE, "");

  // Step 7: Clean up stray pipe characters from malformed sequences.
  // Sometimes the regex replacement leaves behind pipes like "|text"
  // or standalone "|". Remove leading pipes at line starts.
  cleaned = cleaned.replace(LEADING_PIPE_RE, "$1");

  // Step 8: Collapse 3+ consecutive blank lines into 2
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // Step 9: Trim leading/trailing whitespace but preserve a single
  // trailing newline if the original had content
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Universal always-on sanitizer for leaked chat-template tokens.
 *
 * SEPARATE from `stripGroundingTags` (D-01): this pass strips ONLY
 * chat-template control tokens — PATTERN-BASED (quick task 260919-lx5):
 * ANY single no-space word enclosed in the `<|...|>` envelope (plain,
 * zero-width-space, uppercase, or truncated without the closing `|>`) is
 * treated as leaked structure. It does NOT touch grounding tags (`<|ref|>`,
 * `<|det|>`) — `stripGroundingTags` owns those (the ref/det names are
 * excluded by lookahead; `/ref` and `/det` by the name charset) and gates
 * role-keyword removal on leak detection. This function is
 * meant to run on EVERY OCR page regardless of prompt template, so it stays
 * lightweight and never removes role-keyword lines (those only appear during
 * a full chat-template dump, which `stripGroundingTags` already handles when
 * leak markers are present).
 *
 * Order of operations (idempotent by construction):
 *   1. Remove plain + zero-width-space leaked tokens (LEAKED_TOKEN_RE)
 *   2. Remove truncated forms `<|name|` without closing `|>` (TRUNCATED_TOKEN_RE)
 *   3. Clean up any isolated `<` left at line starts (LEADING_LT_RE)
 *   4. Collapse 3+ consecutive blank lines to 2
 *   5. Trim leading/trailing whitespace
 *
 * Grounding tags (`<|ref|>`, `<|det|>`, `<|/ref|>`, `<|/det|>`) are NOT
 * matched by any of the above regexes and pass through unchanged. Reapplying
 * the function to already-clean output is a no-op — all matched tokens are
 * gone after the first pass and the residual `<` cleanup only fires on the
 * exact residual pattern, so clean markdown is untouched.
 *
 * @param markdown - OCR output potentially containing leaked chat-template tokens
 * @returns Markdown with chat-template tokens removed (grounding tags preserved)
 */
export function sanitizeChatTokens(markdown: string): string {
  if (!markdown) return markdown;

  let cleaned = markdown;

  // Step 1: remove plain + zero-width-space leaked tokens (generic pattern)
  cleaned = cleaned.replace(LEAKED_TOKEN_RE, "");

  // Step 2: remove truncated forms (`<|name|` without closing `|>`)
  cleaned = cleaned.replace(TRUNCATED_TOKEN_RE, "");

  // Step 3: clean up an isolated `<` left at the start of a line after
  // stripping a truncated token (the angle bracket survives when the regex
  // consumed `<|name|` but left the preceding `<`'s position producing a
  // stray `<` at line start).
  cleaned = cleaned.replace(LEADING_LT_RE, "$1");

  // Step 4: collapse 3+ consecutive blank lines into 2
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // Step 5: trim leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}
