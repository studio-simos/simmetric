// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// 260917-qoh: the widget prompt service. The mz6-era EXPORTED default
// constant is GONE — every widget carries its own systemPrompt (the Widget
// row column, admin-authored). This module keeps:
//   - a MODULE-PRIVATE (unexported) baseline grounding string: the legacy
//     null-arm floor, so widgets saved before per-widget prompts existed
//     stay grounded. It is NOT a global default — new/edited widgets always
//     carry an explicit prompt of their own.
//   - resolveWidgetSystemPrompt(): the single resolution point for the
//     widget chat route (row prompt or the private floor).
//   - buildReplyLanguageDirective(): the reply-language directive composed
//     SERVER-SIDE from the validated visitor locale (the WIDGET_LOCALES
//     enum gate is upstream in chatRequestSchema — T-131-15; no free-form
//     page-language string is ever interpolated here, T-Q03).
//
// Everything here is SERVER-SIDE ONLY — it rides the DB-resolved Widget row
// into AgentRunParams.widgetSystemPrompt and is deliberately absent from
// widgetConfigResponseSchema (prompt-injection surface, T-Q02: it must never
// reach the client bundle).

// The module-private grounding floor (260917-mz6 intent minus its trailing
// "answer in the visitor's language" sentence — the language concern now
// rides its own helper, buildReplyLanguageDirective). Unexported: it is the
// legacy null-arm floor, not a global default.
const GROUNDING_FLOOR = [
  "You are a support assistant embedded in this product's website.",
  "Answer the visitor's questions using EXCLUSIVELY the knowledge retrieved from the workspace knowledge base provided in the conversation context.",
  "Never answer from your general training knowledge — if the retrieved knowledge does not contain the answer, say that you cannot answer this question.",
  "When you cannot answer, also list a few example topics you CAN answer about, drawn from the names of the knowledge sources available to you.",
].join(" ");

/**
 * 260917-qoh: resolve the widget chat system prompt. A non-blank row value
 * wins (trimmed); a null/blank column falls back to the module-private
 * grounding floor so legacy null rows stay grounded (the mz6 guarantee,
 * minus the exported global constant).
 */
export function resolveWidgetSystemPrompt(raw: string | null | undefined): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return GROUNDING_FLOOR;
}

// WIDGET_LOCALES → English language names (the static map backing
// buildReplyLanguageDirective). The enum is the single source of truth for
// the key set — unknown codes fall back to the raw code in the directive.
const WIDGET_LOCALE_NAMES: Record<string, string> = {
  en: "English",
  de: "German",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  ru: "Russian",
  zh: "Chinese",
  pt: "Portuguese",
};

/**
 * 260917-qoh: the reply-language directive — composed ONLY from the
 * validated visitor locale (chatRequestSchema.locale ∈ WIDGET_LOCALES,
 * T-131-15; never from any free-form page-language string, T-Q03). A known
 * locale pins replies to that language; an absent/unknown one falls back to
 * "reply in the language the visitor writes in". The ONLY interpolation into
 * the returned string is the locale code and its static English name.
 */
export function buildReplyLanguageDirective(locale?: string | null): string {
  if (locale && WIDGET_LOCALE_NAMES[locale]) {
    return `The page the visitor is on uses language ${WIDGET_LOCALE_NAMES[locale]} (${locale}); ALWAYS write your replies in that language.`;
  }
  return "Always reply in the same language the visitor writes in.";
}