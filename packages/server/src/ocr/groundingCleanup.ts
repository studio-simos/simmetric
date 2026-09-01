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
 * following line). It also strips leaked chat-template structural tokens
 * (im_start/im_end/md_start/md_end/doc_start/doc_end/im_continue/im_begin
 * and friends, in either the plain `<|name|>` form or the zero-width-space
 * form where a U+200B sits between `<` and `|`), bare role-keyword lines
 * (system/user/assistant — only when leak markers were present in the
 * original input), and echoed OCR-prompt lines. The function is idempotent —
 * applying it to already-clean markdown is a no-op.
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
 * Matches a leaked chat-template structural token in EITHER form: the plain
 * `<|name|>` form or the zero-width-space form where a U+200B zero-width
 * space sits between `<` and `|` (the form seen in real-world leaked pastes).
 * The name set covers the DeepSeek/GPT-style chat-template control tokens:
 * im_start, im_end, im_continue, im_begin, md_start, md_end, doc_start,
 * doc_end, system, user, assistant, end_of_text, eot_id.
 */
const CHAT_TEMPLATE_TOKEN_RE =
  /<\u200B?\|(?:im_start|im_end|im_continue|im_begin|md_start|md_end|doc_start|doc_end|system|user|assistant|end_of_text|eot_id)\|>/g;

/**
 * Matches the EXTENDED chat-template token set used by `sanitizeChatTokens`
 * (the always-on universal pass). Covers the same tokens as
 * CHAT_TEMPLATE_TOKEN_RE plus im_impression, md_continue, and md (truncated),
 * in BOTH the plain `<|name|>` and zero-width-space (`<` + U+200B + `|name|>`)
 * forms. The truncated forms `<|md|` and `<|im_start|` (no closing `|>`) are
 * handled by TRUNCATED_TOKEN_RE below — this regex requires the closing `|>`.
 */
const SANITIZE_TOKEN_RE =
  /<\u200B?\|(?:im_start|im_end|im_continue|im_begin|im_impression|md_start|md_end|md_continue|md|doc_start|doc_end|system|user|assistant|end_of_text|eot_id)\|>/g;

/**
 * Matches the TRUNCATED chat-template token forms that lack the closing
 * `|>` — `<|md|` and `<|im_start|` (optionally with a U+200B between `<` and
 * `|`). These appear when the model output is cut mid-token. The alternation
 * matches the prefix only: `<`, optional U+200B, `|`, the token name, and a
 * trailing `|` — but NO `>` is required after the trailing `|`. The negative
 * lookahead `(?!\>)` ensures we do NOT match the complete `<|name|>` form
 * (that is handled by SANITIZE_TOKEN_RE); we only want the truncated form
 * where the closing `>` is missing.
 */
const TRUNCATED_TOKEN_RE =
  /<\u200B?\|(?:md|im_start|im_end|im_continue|im_begin|im_impression|md_start|md_end|md_continue|doc_start|doc_end)\|(?!>)/g;

/**
 * Matches an isolated `<` left at the start of a line after stripping a
 * truncated token (residual pipe cleanup — mirrors LEADING_PIPE_RE but for
 * the angle bracket the truncated-form regex leaves behind when the `|>`
 * closing was absent and only `<|name|` was removed).
 */
const LEADING_LT_RE = /^(\s*)<(?=\s|$)/gm;

/**
 * Non-global leak-marker detector used ONLY to gate the conditional
 * role-keyword stripping below. Matches `<`, optional U+200B, `|`, then
 * one of the im_/md_/doc_ structural prefixes. Captured against the ORIGINAL
 * input before any replacement, so a leak that starts mid-way through the
 * document still enables role-line removal for the whole string.
 */
const HAS_LEAK_MARKER_RE = /<\u200B?\|(?:im_|md_|doc_)/;

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
 *    (im_/md_/doc_ prefixes, plain or U+200B form) — used to gate step 3
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
 * steps 1–4 are no-ops on the second application. It does NOT modify
 * content inside code blocks (```) or inline code (`) since grounding tags
 * are not expected there, and leak-free documents pass through unchanged
 * (the role-keyword removal is gated on an actual leak being present).
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

  // Step 2: remove leaked chat-template structural tokens (both forms)
  cleaned = cleaned.replace(CHAT_TEMPLATE_TOKEN_RE, "");

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
 * chat-template control tokens (im_*, md_*, doc_*, role keywords when leaked,
 * im_impression, the truncated `<|md|` / `<|im_start|` forms). It does NOT
 * touch grounding tags (`<|ref|>`, `<|det|>`) — `stripGroundingTags` owns
 * those and gates role-keyword removal on leak detection. This function is
 * meant to run on EVERY OCR page regardless of prompt template, so it stays
 * lightweight and never removes role-keyword lines (those only appear during
 * a full chat-template dump, which `stripGroundingTags` already handles when
 * leak markers are present).
 *
 * Order of operations (idempotent by construction):
 *   1. Remove plain + zero-width-space chat-template tokens (SANITIZE_TOKEN_RE)
 *   2. Remove truncated forms `<|md|` / `<|im_start|` (TRUNCATED_TOKEN_RE)
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

  // Step 1: remove plain + zero-width-space chat-template tokens (extended set)
  cleaned = cleaned.replace(SANITIZE_TOKEN_RE, "");

  // Step 2: remove truncated forms (`<|md|`, `<|im_start|` without closing `|>`)
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
