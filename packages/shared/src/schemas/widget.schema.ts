// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Widget Locales (D-01) =====
// Mirrors frontend ALL_LANGUAGES (packages/frontend/src/i18n/index.ts:11-19).
// Order differs from D-01's listing (en/it/ru/de/fr/es/zh); parity is a SET
// equality, guarded by widgetLocalesParity.test.ts.
export const WIDGET_LOCALES = ["en", "de", "es", "fr", "it", "ru", "zh", "pt"] as const;
type WidgetLocale = (typeof WIDGET_LOCALES)[number];

const widgetLocaleSchema = z.enum(WIDGET_LOCALES);

// Zod 4.4.3: z.record(z.enum(...), v) requires ALL enum keys present (partial
// maps fail) — so locale-keyed maps are string-keyed records + superRefine
// whitelist (Pitfall 1).
const ALLOWED_LOCALES = new Set<string>(WIDGET_LOCALES);

const rejectUnknownLocales = (val: Record<string, unknown>, ctx: z.RefinementCtx) => {
  for (const key of Object.keys(val)) {
    if (!ALLOWED_LOCALES.has(key)) {
      ctx.addIssue({ code: "custom", message: `Unknown locale: ${key}`, path: [key] });
    }
  }
};

// ===== Per-widget localization / questions / credits blobs (D-02..D-05) =====

// Locale-keyed map of editable content strings. .strict() inner objects reject
// unknown inner keys (verified Zod 4.4.3). Plain text only — no HTML (XSS, D-02).
const widgetLocalizedTextsSchema = z
  .record(z.string(), z.object({
    welcomeMessage: z.string().max(1000).optional(),
    fallbackMessage: z.string().max(1000).optional(),
    placeholder: z.string().max(200).optional(),
    piiConsent: z.string().max(500).optional(),
    leadPrompt: z.string().max(500).optional(),
  }).strict())
  .superRefine(rejectUnknownLocales);
export type WidgetLocalizedTexts = z.infer<typeof widgetLocalizedTextsSchema>;

// Locale-keyed arrays: max 10 questions, max 200 chars each (D-04).
// Tri-state: null = not configured, [] = admin disabled, [...] = shown.
const widgetSuggestedQuestionsSchema = z
  .record(z.string(), z.array(z.string().min(1).max(200)).max(10))
  .superRefine(rejectUnknownLocales);
export type WidgetSuggestedQuestions = z.infer<typeof widgetSuggestedQuestionsSchema>;

// Shared http(s) URL predicate (WR-01 parity fix): case-insensitive +
// host-aware via WHATWG new URL() — the SAME semantics the client
// WidgetCreditsTab uses, so the admin form and the server write gate can
// never diverge (131-REVIEW.md WR-01). Bare schemes ("http://") throw in
// new URL() → rejected (closes the old startsWith regression that accepted
// them); "HTTPS://X.COM" normalizes to protocol https: → accepted;
// "http:example.com" parses with host example.com → accepted (matches the
// client's new URL() check). Exported for cross-package reuse — the frontend
// imports it from @simmetric-chat/shared instead of re-implementing.
export const isHttpUrl = (u: string): boolean => {
  try {
    const url = new URL(u);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
};

// Credits blob (D-05, WR-02). The http/https refine is MANDATORY: z.string().url()
// alone accepts javascript: in Zod 4.4.3 (Pitfall 2) — repo precedent at
// logoUrl/avatarUrl below. WR-02 widening (D-06): empty label/url are allowed
// ONLY when enabled === false (the persisted hide-blob contract — the admin
// toggle must be able to persist { enabled: false, label: "", url: "" }).
// The content constraints live in a chained superRefine (in-file precedent:
// widgetSuggestedQuestionsSchema :42-44) so the base object cannot reject
// conditionally-allowed values; .strict() is retained (unknown keys still
// rejected — the chained superRefine runs after the strict object parse).
export const widgetCreditsSchema = z
  .object({
    enabled: z.boolean(),
    label: z.string().max(200),
    url: z.string(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.enabled === false) {
      // Disabled blob: empty label/url allowed (WR-02 hide contract).
      // Defense-in-depth: a non-empty url must still be http(s) — the credits
      // footer can render it under a Community license (the anchor's
      // preventDefault + notifyCreditsOpen prefix check neutralize it).
      if (v.url !== "" && !isHttpUrl(v.url)) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "Only http:// and https:// URLs are allowed" });
      }
      return;
    }
    // Enabled blob: replicate the ORIGINAL min(1)/url-refine semantics exactly
    // (the existing reject cases :270-297 keep passing).
    if (v.label === "") {
      ctx.addIssue({ code: "custom", path: ["label"], message: "Label is required" });
    }
    if (v.url === "") {
      ctx.addIssue({ code: "custom", path: ["url"], message: "URL is required" });
    } else if (!isHttpUrl(v.url)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "Only http:// and https:// URLs are allowed" });
    }
  });
export type WidgetCredits = z.infer<typeof widgetCreditsSchema>;

// ===== Fallback resolvers (D-06, D-07) =====
// Pure helpers, no side effects, no zod dependency at call time.
// Resolution chain: exact visitor locale → widget fallbackLocale → legacy
// scalars → English. Minimal structural input types (Open Question 3 pin) keep
// these decoupled from response-shape churn across Phases 126-127.

export interface WidgetTextsInput {
  localizedTexts?: WidgetLocalizedTexts | null;
  fallbackLocale?: string | null;
  welcomeMessage?: string | null;
  fallbackMessage?: string | null;
}

export interface WidgetSuggestedQuestionsInput {
  suggestedQuestions?: WidgetSuggestedQuestions | null;
  fallbackLocale?: string | null;
}

export interface ResolvedWidgetTexts {
  welcomeMessage?: string;
  fallbackMessage?: string;
  placeholder?: string;
  piiConsent?: string;
  leadPrompt?: string;
}

// Per-key merge across tiers; exact locale wins. Tier order en (lowest) →
// fallbackLocale → exact locale (highest) per D-07. Legacy scalars are the
// default-language tier (D-06), consulted for welcome/fallback after the blob.
export function resolveWidgetTexts(config: WidgetTextsInput, locale: string): ResolvedWidgetTexts {
  const texts = config.localizedTexts ?? {};
  const fallback = config.fallbackLocale ?? "en";
  const merged = { ...texts.en, ...texts[fallback], ...texts[locale] };
  return {
    welcomeMessage: merged.welcomeMessage ?? config.welcomeMessage ?? undefined,
    fallbackMessage: merged.fallbackMessage ?? config.fallbackMessage ?? undefined,
    placeholder: merged.placeholder,
    piiConsent: merged.piiConsent,
    leadPrompt: merged.leadPrompt,
  };
}

// Tri-state (D-04): null/absent blob → null (not configured → client
// defaults); [] in the exact locale → [] (admin disabled — short-circuit, must
// NOT resurrect a populated fallback list); [...] → shown. Per-index fallback
// (D-07): a partially translated list must not collapse to the default list.
export function resolveSuggestedQuestions(
  config: WidgetSuggestedQuestionsInput,
  locale: string,
): string[] | null {
  if (config.suggestedQuestions == null) return null;
  const fallback = config.fallbackLocale ?? "en";
  const exact = config.suggestedQuestions[locale];
  if (Array.isArray(exact) && exact.length === 0) return [];
  const tiers = [
    exact,
    config.suggestedQuestions[fallback],
    config.suggestedQuestions.en,
  ].filter((l): l is string[] => Array.isArray(l));
  if (tiers.length === 0) return [];
  const maxLen = Math.max(...tiers.map((t) => t.length));
  const merged: string[] = [];
  for (let i = 0; i < maxLen; i += 1) {
    const element = tiers.find((t) => t[i] !== undefined)?.[i];
    if (element !== undefined) merged.push(element);
  }
  return merged;
}

// ===== Widget Schemas =====

// Visitor chat message -- stricter than main server (4000 vs 50000 chars) per D-11
// 131-07 (G-131-19): locale is a first-class field of the chat request — the
// visitor locale travels widget client → proxy → server orchestrator so the
// rag-degraded chrome message and the agent's no-results sentence follow the
// chat language. Additive-optional: old clients that never send it keep
// parsing (omitted → undefined). The WIDGET_LOCALES enum whitelist is the
// prompt-injection defense (T-131-15) — no free-form string ever reaches the
// system prompt.
export const widgetChatRequestSchema = z.object({
  message: z.string().min(1, "Message is required").max(4000, "Message too long for widget chat"),
  chatId: z.string().uuid().nullable().optional(),
  locale: z.enum(WIDGET_LOCALES).optional(),
});
type WidgetChatRequest = z.infer<typeof widgetChatRequestSchema>;

// Session creation request per D-08/D-09
export const widgetSessionCreateSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
});
type WidgetSessionCreate = z.infer<typeof widgetSessionCreateSchema>;

// Widget creation/update (admin) per D-14
export const createWidgetSchema = z.object({
  name: z.string().min(1).max(200),
  welcomeMessage: z.string().max(1000).optional(),
  fallbackMessage: z.string().max(1000).optional(),
  position: z.enum(["bottom-right", "bottom-left"]).default("bottom-right"),
  // Branding fields (CUST-01) -- Enterprise-only writes, Community uses defaults
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i, "Must be a valid hex color").optional(),
  botName: z.string().max(100).optional(),
  logoUrl: z.preprocess(
    (val) => val === "" ? null : val,
    z.string().url("Must be a valid URL").refine(
      (url) => url.startsWith("http://") || url.startsWith("https://"),
      { message: "Only http:// and https:// URLs are allowed" }
    ).nullable().optional()
  ),
  avatarUrl: z.preprocess(
    (val) => val === "" ? null : val,
    z.string().url("Must be a valid URL").refine(
      (url) => url.startsWith("http://") || url.startsWith("https://"),
      { message: "Only http:// and https:// URLs are allowed" }
    ).nullable().optional()
  ),
  // NOTE: autoOpenUrlPatterns is stored as JSON-encoded string of string[] in DB. Use z.string() here.
  autoOpenDelay: z.number().int().min(1).max(300).nullable().optional(),
  autoOpenUrlPatterns: z.string().max(2000).nullable().optional(),
  exitIntentEnabled: z.boolean().optional(),
  exitIntentCooldownMs: z.number().int().min(60000).max(86400000).optional(),
  leadCaptureEnabled: z.boolean().optional(),
  leadCapturePrompt: z.string().max(500).nullable().optional(),
  // Per-widget rate-limit override (SCALE-04, D-05). null = global default.
  rateLimitPerMinute: z.number().int().positive().nullable().optional(),
  // Per-widget daily MESSAGE limit (151-02, G-151-1b). null = global default
  // (5 messages/day prod, 50/day dev). Positive int; semantics = messages
  // sent per visitor per day (views never count — enforced on the send path).
  sessionLimitPerDay: z.number().int().positive().nullable().optional(),
  // CORS allowed origins (JSON-encoded string of string[] for DB storage)
  allowedOrigins: z.string().max(2000).nullable().optional(),
  // Per-widget localization (D-02..D-05). .nullable() is the write contract
  // for tri-state: null → Prisma.DbNull translation happens at the server route
  // (Plan 03). fallbackLocale defaults to "en" on create.
  localizedTexts: widgetLocalizedTextsSchema.nullable().optional(),
  suggestedQuestions: widgetSuggestedQuestionsSchema.nullable().optional(),
  credits: widgetCreditsSchema.nullable().optional(),
  fallbackLocale: widgetLocaleSchema.default("en"),
  // 260809-uxk T3: bound knowledge archive (D-08 wiki_query). Nullable write
  // contract — null clears the binding (SQL NULL via the route's spread; plain
  // String column, no toJsonWriteValue needed). Mirrors rateLimitPerMinute.
  archiveId: z.string().uuid("Invalid archive ID").nullable().optional(),
  // 260831-hgy: per-widget response model pin — the provider+model that
  // serves this widget's chat responses. Nullable write contract (mirrors
  // archiveId): null → SQL NULL clears the pin, undefined = leave unchanged
  // on update. responseProviderId is a Provider UUID; responseModel is the
  // model NAME on that provider (mirrors Chat.model, not ProviderModel.id).
  responseProviderId: z.string().uuid("Invalid provider ID").nullable().optional(),
  responseModel: z.string().min(1).max(200).nullable().optional(),
});
type CreateWidgetInput = z.infer<typeof createWidgetSchema>;

// Widget update schema -- all fields optional (CUST-01)
export const updateWidgetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  welcomeMessage: z.string().max(1000).optional(),
  fallbackMessage: z.string().max(1000).optional(),
  position: z.enum(["bottom-right", "bottom-left"]).optional(),
  isActive: z.boolean().optional(),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i, "Must be a valid hex color").optional(),
  botName: z.string().max(100).optional(),
  logoUrl: z.preprocess(
    (val) => val === "" ? null : val,
    z.string().url("Must be a valid URL").refine(
      (url) => url.startsWith("http://") || url.startsWith("https://"),
      { message: "Only http:// and https:// URLs are allowed" }
    ).nullable().optional()
  ),
  avatarUrl: z.preprocess(
    (val) => val === "" ? null : val,
    z.string().url("Must be a valid URL").refine(
      (url) => url.startsWith("http://") || url.startsWith("https://"),
      { message: "Only http:// and https:// URLs are allowed" }
    ).nullable().optional()
  ),
  // Trigger and lead capture fields
  autoOpenDelay: z.number().int().min(1).max(300).nullable().optional(),
  autoOpenUrlPatterns: z.string().max(2000).nullable().optional(),
  exitIntentEnabled: z.boolean().optional(),
  exitIntentCooldownMs: z.number().int().min(60000).max(86400000).optional(),
  leadCaptureEnabled: z.boolean().optional(),
  leadCapturePrompt: z.string().max(500).nullable().optional(),
  // Per-widget rate-limit override (SCALE-04, D-05). null = global default.
  rateLimitPerMinute: z.number().int().positive().nullable().optional(),
  // Per-widget daily MESSAGE limit (151-02, G-151-1b). null = global default.
  sessionLimitPerDay: z.number().int().positive().nullable().optional(),
  // CORS allowed origins (JSON-encoded string of string[] for DB storage)
  allowedOrigins: z.string().max(2000).nullable().optional(),
  // Per-widget localization (D-02..D-05). .nullable() write contract for
  // tri-state. fallbackLocale is plain optional here — a .default() would
  // inject "en" into parsed.data on every update and overwrite the stored
  // value via the route's data spread (partial-update semantics preserved).
  localizedTexts: widgetLocalizedTextsSchema.nullable().optional(),
  suggestedQuestions: widgetSuggestedQuestionsSchema.nullable().optional(),
  credits: widgetCreditsSchema.nullable().optional(),
  fallbackLocale: widgetLocaleSchema.optional(),
  // 260809-uxk T3: bound knowledge archive — nullable write contract so the
  // admin form can clear a binding (null → SQL NULL).
  archiveId: z.string().uuid("Invalid archive ID").nullable().optional(),
  // 260831-hgy: per-widget response model pin — nullable write contract so
  // the admin form can clear the selection (null → SQL NULL). Plain String
  // columns, no toJsonWriteValue needed (mirrors archiveId).
  responseProviderId: z.string().uuid("Invalid provider ID").nullable().optional(),
  responseModel: z.string().min(1).max(200).nullable().optional(),
});
type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>;

// Internal API: widget config response shape per D-13
export const widgetConfigResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  welcomeMessage: z.string().nullable().optional(),
  fallbackMessage: z.string().nullable().optional(),
  position: z.enum(["bottom-right", "bottom-left"]),
  isActive: z.boolean(),
  workspaceId: z.string().uuid(),
  // All linked workspace IDs (route emission, internalWidget.ts:159). Required —
  // the route 404s on empty whitelists, so the array is always present and non-empty.
  workspaceIds: z.array(z.string().uuid()),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional().default("#4c6ef5"),
  botName: z.string().optional().default("AI Assistant"),
  logoUrl: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  // Widened 3→7 (D-01): no literal 3-value enum remains in this file.
  locale: widgetLocaleSchema.default("en"),
  // NOTE: autoOpenUrlPatterns returned as raw JSON string; client must JSON.parse() into string[]
  autoOpenDelay: z.number().nullable().optional(),
  autoOpenUrlPatterns: z.string().nullable().optional(),
  exitIntentEnabled: z.boolean().optional(),
  exitIntentCooldownMs: z.number().optional(),
  leadCaptureEnabled: z.boolean().optional(),
  leadCapturePrompt: z.string().nullable().optional(),
  // Per-widget rate-limit override (SCALE-04, D-05). null = global default.
  rateLimitPerMinute: z.number().int().nullable().optional(),
  // Per-widget daily MESSAGE limit (151-02, G-151-1b). null = global default.
  sessionLimitPerDay: z.number().int().nullable().optional(),
  // Localization blobs + fallbackLocale in the response contract now
  // (Open Question 2 pin); raw emission is Phase 126.
  localizedTexts: widgetLocalizedTextsSchema.nullable().optional(),
  suggestedQuestions: widgetSuggestedQuestionsSchema.nullable().optional(),
  credits: widgetCreditsSchema.nullable().optional(),
  fallbackLocale: widgetLocaleSchema.default("en"),
  // 130-01 (D-03): license-derived white-label flag — additive, optional-with-
  // default so old fixtures keep parsing. The server derives it from
  // isFeatureEnabled("white_label"); it is NEVER client-supplied (the write
  // schemas gain no whiteLabel field — only the read response carries it).
  whiteLabel: z.boolean().optional().default(false),
  // 260809-uxk T3: bound knowledge archive id (null when unbound). Additive
  // optional so old fixtures keep parsing (mirrors whiteLabel).
  archiveId: z.string().uuid().nullable().optional(),
});
export type WidgetConfigResponse = z.infer<typeof widgetConfigResponseSchema>;

// Internal API: session validation response per D-09/D-10
export const widgetSessionResponseSchema = z.object({
  id: z.string(),
  widgetId: z.string(),
  sessionToken: z.string(),
  ipAddress: z.string().nullable(),
  messageCount: z.number().int().min(0),
  conversationCount: z.number().int().min(0),
  lastResetAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  hourlyLimit: z.number().int().default(20),
  dailyLimit: z.number().int().default(5),
  hourlyRemaining: z.number().int().min(0),
  dailyRemaining: z.number().int().min(0),
});
type WidgetSessionResponse = z.infer<typeof widgetSessionResponseSchema>;

// Internal API: session counter increment per D-10
export const widgetSessionIncrementSchema = z.object({
  field: z.enum(["messageCount", "conversationCount"], {
    message: "Invalid field. Must be messageCount or conversationCount",
  }),
});
type WidgetSessionIncrement = z.infer<typeof widgetSessionIncrementSchema>;

// Internal API: widget search request (RAG-02, RAG-03)
// The client sends widgetId, NOT workspaceIds. The server resolves workspaceIds
// from the widget's WidgetWorkspace whitelist in the DB (IDOR prevention per T-03-04).
export const widgetSearchRequestSchema = z.object({
  query: z.string().min(1, "Search query is required").max(1000, "Search query too long"),
  widgetId: z.string().uuid("Invalid widget ID"),
  limit: z.number().int().min(1).max(50).default(10),
});
type WidgetSearchRequest = z.infer<typeof widgetSearchRequestSchema>;

// Display trigger configuration (CUST-03, per D-01/D-02/D-03/D-04/D-05)
const widgetTriggerConfigSchema = z.object({
  autoOpenDelay: z.number().int().min(1).max(300).nullable().optional(),
  // NOTE: autoOpenUrlPatterns is stored as a JSON-encoded string of string[] in the DB (Prisma String?).
  // The Zod schema validates the raw string form. Client consumers must JSON.parse() it into string[].
  // The WidgetConfig TypeScript interface exposes the parsed form: autoOpenUrlPatterns: string[] | null
  autoOpenUrlPatterns: z.string().max(2000).nullable().optional(),
  exitIntentEnabled: z.boolean().optional(),
  exitIntentCooldownMs: z.number().int().min(60000).max(86400000).optional(),
});
type WidgetTriggerConfig = z.infer<typeof widgetTriggerConfigSchema>;

// Lead capture configuration (ADM-04, per D-06/D-07/D-08)
const widgetLeadCaptureSchema = z.object({
  leadCaptureEnabled: z.boolean().optional(),
  leadCapturePrompt: z.string().max(500).nullable().optional(),
});
type WidgetLeadCapture = z.infer<typeof widgetLeadCaptureSchema>;

// Visitor lead submission (ADM-04, per D-08/D-10)
export const widgetLeadSubmitSchema = z.object({
  email: z.string().email("Valid email is required"),
  name: z.string().max(200).optional(),
  transcript: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: z.string().optional(),
  })).min(1, "Transcript must include at least one message"),
});
type WidgetLeadSubmit = z.infer<typeof widgetLeadSubmitSchema>;

// Admin lead export query parameters (ADM-04, per D-12)
const widgetLeadExportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  columns: z.string().optional(),
});
type WidgetLeadExportQuery = z.infer<typeof widgetLeadExportQuerySchema>;

// Widget analytics query parameters (ADM-03)
export const widgetAnalyticsQuerySchema = z.object({
  days: z.coerce.number().refine(v => [7, 30, 90].includes(v), { message: "days must be 7, 30, or 90" }).default(30),
  widgetId: z.string().uuid().optional(),
});
type WidgetAnalyticsQueryInput = z.infer<typeof widgetAnalyticsQuerySchema>;