// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useMemo } from "preact/hooks";
import { initWidgetI18n } from "../i18n";
import type { WidgetCredits } from "@simmetric-chat/shared";

export interface WidgetConfig {
  widgetId: string;
  name: string;
  primaryColor: string;
  botName: string;
  logoUrl: string | null;
  avatarUrl: string | null;
  position: "left" | "right";
  locale: string;
  welcomeMessage: string;
  fallbackMessage: string;
  placeholder: string;
  piiConsent: string;
  suggestedQuestions: string[];
  // Display trigger fields (CUST-03)
  autoOpenDelay: number | null;
  autoOpenUrlPatterns: string | null;
  exitIntentEnabled: boolean;
  exitIntentCooldownMs: number;
  // Lead capture fields (ADM-04)
  leadCaptureEnabled: boolean;
  leadCapturePrompt: string | null;
  // G-128-2: true when the widget is embedded via LOADER_JS (&hostFab=1) — the
  // host page owns the FAB, so the iframe app must NOT render its own ChatFab.
  // The admin preview pane loads the iframe route directly (no param), so its
  // iframe keeps the FAB (hostFab false).
  hostFab: boolean;
  // 130-01 (D-03): license-derived white-label flag (server-emitted, never
  // client-supplied) + the admin-configured credits blob (raw pass-through).
  whiteLabel: boolean;
  credits: WidgetCredits | null;
}

// 129-01: exported so the node tests can assert the tri-state mapping
// (null → DEFAULT_CONFIG.suggestedQuestions) against the actual defaults.
export const DEFAULT_CONFIG: WidgetConfig = {
  widgetId: "",
  name: "AI Assistant",
  primaryColor: "#4c6ef5",
  botName: "AI Assistant",
  logoUrl: null,
  avatarUrl: null,
  position: "right",
  locale: "en",
  welcomeMessage: "Hi! How can I help?",
  fallbackMessage: "I don't have an answer for that. Please contact us for more help.",
  placeholder: "Type a message...",
  piiConsent: "Before you begin: Your messages may be processed by AI. Do not share personal information.",
  suggestedQuestions: [
    "What is this product?",
    "How does it work?",
    "What are the pricing plans?",
  ],
  autoOpenDelay: null,
  autoOpenUrlPatterns: null,
  exitIntentEnabled: false,
  exitIntentCooldownMs: 1800000,
  leadCaptureEnabled: false,
  leadCapturePrompt: null,
  hostFab: false,
  // 130-01 (D-03): no default label string here — the label is i18n'd at
  // render time (config.credits?.label || t("credits.poweredBy")), RESEARCH
  // Pitfall 4 (DEFAULT_CONFIG is locale-independent). whiteLabel false +
  // credits null = neutral, credits always visible under Community.
  whiteLabel: false,
  credits: null,
};

// Validate URL scheme before setting CSS custom properties (defense-in-depth)
const isValidUrl = (url: string | null): url is string =>
  !!url && (url.startsWith("http://") || url.startsWith("https://"));

// D-01: pure helper — the single read choke point over the JSON block. No DOM
// access, no CSS side effects (node-testable). Returns null for null/empty
// input or any JSON.parse failure; otherwise maps the block's flat
// client-shaped fields into WidgetConfig. No defaults are injected here
// (missing strings map to "", missing nullable fields to null) — DEFAULT_CONFIG
// is the hook's fallback, not the helper's.
// 129-01 carve-out: suggestedQuestions is the DOCUMENTED exception to "no
// defaults injected here" — null/absent maps to DEFAULT_CONFIG.suggestedQuestions
// (D-02: "blob stays null → client DEFAULT_CONFIG shows"; the loader keeps
// emitting null at loader.ts:521 — the client owns defaulting). [] maps to []
// (admin disabled — defaults never resurrect, Phase 125 OQ1 pin).
export function parseWidgetConfigBlock(textContent: string | null): WidgetConfig | null {
  if (!textContent) return null;
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(textContent);
  } catch {
    return null; // malformed/tampered block — caller falls back to DEFAULT_CONFIG
  }
  if (typeof raw !== "object" || raw === null) return null;

  // Pitfall 5: API shape "bottom-right"/"bottom-left" → client "right"/"left"
  const position: "left" | "right" = raw.position === "bottom-left" ? "left" : "right";

  // Pitfall 7: autoOpenUrlPatterns stays the raw JSON-encoded string —
  // matchUrlPattern JSON.parses it itself.
  const autoOpenUrlPatterns = typeof raw.autoOpenUrlPatterns === "string" ? raw.autoOpenUrlPatterns : null;

  // Numeric fields keep parseInt-with-NaN-guard semantics (block carries
  // numbers; coerce defensively).
  const autoOpenDelay = raw.autoOpenDelay != null ? parseInt(String(raw.autoOpenDelay), 10) : null;
  const exitIntentCooldownMs = raw.exitIntentCooldownMs != null
    ? parseInt(String(raw.exitIntentCooldownMs), 10)
    : 1800000;

  return {
    widgetId: typeof raw.widgetId === "string" ? raw.widgetId : "",
    name: typeof raw.name === "string" ? raw.name : "",
    primaryColor: typeof raw.primaryColor === "string" ? raw.primaryColor : "",
    botName: typeof raw.botName === "string" ? raw.botName : "",
    logoUrl: typeof raw.logoUrl === "string" ? raw.logoUrl : null,
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : null,
    position,
    locale: typeof raw.locale === "string" ? raw.locale : "",
    welcomeMessage: typeof raw.welcomeMessage === "string" ? raw.welcomeMessage : "",
    fallbackMessage: typeof raw.fallbackMessage === "string" ? raw.fallbackMessage : "",
    placeholder: typeof raw.placeholder === "string" ? raw.placeholder : "",
    piiConsent: typeof raw.piiConsent === "string" ? raw.piiConsent : "",
    // 129-01 tri-state (QST-01 SC1): array → filtered strings; null/absent →
    // the 3 client defaults ("not configured"); [] → [] (admin disabled —
    // defaults never resurrect, Phase 125 OQ1 pin).
    suggestedQuestions: Array.isArray(raw.suggestedQuestions)
      ? raw.suggestedQuestions.filter((q: unknown): q is string => typeof q === "string")
      : DEFAULT_CONFIG.suggestedQuestions,
    autoOpenDelay: isNaN(autoOpenDelay as number) ? null : autoOpenDelay,
    autoOpenUrlPatterns,
    exitIntentEnabled: raw.exitIntentEnabled === true,
    exitIntentCooldownMs: isNaN(exitIntentCooldownMs) ? 1800000 : exitIntentCooldownMs,
    leadCaptureEnabled: raw.leadCaptureEnabled === true,
    leadCapturePrompt: typeof raw.leadCapturePrompt === "string" ? raw.leadCapturePrompt : null,
    hostFab: raw.hostFab === true,
    // 130-01 (D-03): mechanical mapping with the per-field typeof defensive
    // guards convention. Missing fields map to neutral values (whiteLabel
    // false, credits null) — no DEFAULT_CONFIG injection (the no-injection
    // test contract). The credits blob is a raw pass-through; the client owns
    // defaulting (D-02).
    whiteLabel: raw.whiteLabel === true,
    credits: typeof raw.credits === "object" && raw.credits !== null
      ? {
          enabled: raw.credits.enabled === true,
          label: typeof raw.credits.label === "string" ? raw.credits.label : "",
          url: typeof raw.credits.url === "string" ? raw.credits.url : "",
        }
      : null,
  };
}

// G-128-2: pure FAB-visibility decision — the iframe app renders its own
// ChatFab only when the host page does NOT own the FAB (hostFab false). Real
// embeds via LOADER_JS append &hostFab=1 → the host FAB is created host-side
// and the iframe FAB is hidden; the admin preview pane sends no param →
// hostFab false → the iframe keeps its FAB. Exported from useWidgetConfig.ts
// (NOT App.tsx) so it is node-testable without importing the Preact/DOM tree
// (jest.config.js is testEnvironment node, no jsdom, T-65-SC).
export function shouldRenderFab(hostFab: boolean): boolean {
  return !hostFab;
}

// 130-01 (D-03, RESEARCH Pitfall 5): the single visibility predicate for the
// credits footer line. Hiding requires BOTH the license-derived whiteLabel
// flag AND the admin's credits.enabled === false. Community (whiteLabel
// false) ALWAYS shows — even with enabled:false the credits stay visible.
// Exported from the hook file (NOT the component) so jest node env can test
// it — same rationale as shouldRenderFab.
export function shouldShowCredits(whiteLabel: boolean, credits: WidgetCredits | null): boolean {
  return !(whiteLabel === true && credits?.enabled === false);
}

export function useWidgetConfig(): WidgetConfig {
  return useMemo(() => {
    // D-01: the hook's only DOM input is the block's textContent — no attribute
    // reads anywhere.
    const el = document.getElementById("widget-config");
    if (!el) {
      // OQ2: no JSON block — init chrome i18n with the DEFAULT_CONFIG locale
      // (en) so chrome strings still render (RESEARCH A4: no hand-rolled
      // navigator.languages fallback needed). A throwing i18n init must never
      // blank the widget.
      try {
        initWidgetI18n(DEFAULT_CONFIG.locale);
      } catch {
        // i18n is chrome-only — a failed init degrades to raw keys, never a crash
      }
      return DEFAULT_CONFIG;
    }

    const config = parseWidgetConfigBlock(el.textContent);
    if (!config) {
      // malformed/tampered block — no partial config; same en fallback init
      try {
        initWidgetI18n(DEFAULT_CONFIG.locale);
      } catch {
        // i18n is chrome-only — a failed init degrades to raw keys, never a crash
      }
      return DEFAULT_CONFIG;
    }

    // Set CSS custom properties from branding config (Pitfall 4 — preserved
    // verbatim from the attribute-read era, now sourced from the block).
    const validPrimaryColor = /^#[0-9a-f]{6}$/i.test(config.primaryColor) ? config.primaryColor : DEFAULT_CONFIG.primaryColor;
    document.documentElement.style.setProperty("--widget-primary", validPrimaryColor);
    document.documentElement.style.setProperty("--widget-bot-name", `"${config.botName}"`);
    document.documentElement.style.setProperty("--widget-logo", isValidUrl(config.logoUrl) ? `url(${config.logoUrl})` : "none");
    document.documentElement.style.setProperty("--widget-avatar", isValidUrl(config.avatarUrl) ? `url(${config.avatarUrl})` : "none");

    // OQ2: init chrome i18n from the server-resolved locale AFTER the CSS side
    // effects. The memo runs once per mount and initAsync:false makes the init
    // synchronous, so every subsequent t() call in the same render tree sees
    // the initialized instance. A throwing i18n init must never blank the widget.
    try {
      initWidgetI18n(config.locale);
    } catch {
      // i18n is chrome-only — a failed init degrades to raw keys, never a crash
    }

    return config;
  }, []);
}
