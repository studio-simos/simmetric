// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

// Phase 127 (D-01): useWidgetConfig reads the JSON config block via textContent
// + JSON.parse — the single read choke point. The pure helper
// parseWidgetConfigBlock is extracted so it can be unit-tested in the node
// environment without rendering the Preact hook (threat model T-65-SC forbids
// new test deps; jest.config.js is testEnvironment node, no jsdom — same
// pattern as useWidgetChat.dedup.test.ts).
import { parseWidgetConfigBlock, DEFAULT_CONFIG, shouldShowCredits } from "../widget/hooks/useWidgetConfig";

describe("parseWidgetConfigBlock (D-01 JSON block reader)", () => {
  it("maps a valid block JSON into WidgetConfig — position mapping, locale, resolved texts", () => {
    const block = JSON.stringify({
      widgetId: "widget-1",
      name: "Support Bot",
      primaryColor: "#123456",
      botName: "Support",
      logoUrl: "https://example.com/logo.png",
      avatarUrl: "https://example.com/avatar.png",
      position: "bottom-left",
      locale: "de",
      welcomeMessage: "Hallo!",
      fallbackMessage: "Keine Antwort.",
      placeholder: "Nachricht...",
      piiConsent: "Datenschutz",
      leadCapturePrompt: "Kontakt teilen",
      suggestedQuestions: ["Was ist das?"],
      autoOpenDelay: 5,
      autoOpenUrlPatterns: '["/pricing/*"]',
      exitIntentEnabled: true,
      exitIntentCooldownMs: 60000,
      leadCaptureEnabled: true,
    });

    const config = parseWidgetConfigBlock(block);

    expect(config).not.toBeNull();
    expect(config!.widgetId).toBe("widget-1");
    expect(config!.name).toBe("Support Bot");
    // Pitfall 5: API shape "bottom-left" → client "left"
    expect(config!.position).toBe("left");
    expect(config!.locale).toBe("de");
    expect(config!.welcomeMessage).toBe("Hallo!");
    expect(config!.placeholder).toBe("Nachricht...");
    expect(config!.piiConsent).toBe("Datenschutz");
    expect(config!.leadCapturePrompt).toBe("Kontakt teilen");
    expect(config!.suggestedQuestions).toEqual(["Was ist das?"]);
    expect(config!.exitIntentEnabled).toBe(true);
    expect(config!.leadCaptureEnabled).toBe(true);
  });

  it("maps API position bottom-right → client right", () => {
    const config = parseWidgetConfigBlock(JSON.stringify({ position: "bottom-right" }));
    expect(config!.position).toBe("right");
  });

  it("autoOpenUrlPatterns passes through as the raw JSON-encoded string (Pitfall 7)", () => {
    const config = parseWidgetConfigBlock(JSON.stringify({ autoOpenUrlPatterns: '["/pricing/*"]' }));
    expect(config!.autoOpenUrlPatterns).toBe('["/pricing/*"]');
  });

  it("returns null for null/empty input", () => {
    expect(parseWidgetConfigBlock(null)).toBeNull();
    expect(parseWidgetConfigBlock("")).toBeNull();
    expect(parseWidgetConfigBlock("   ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseWidgetConfigBlock("{not json")).toBeNull();
    expect(parseWidgetConfigBlock("42")).toBeNull(); // non-object
  });

  it("maps missing optional fields to neutral values — no DEFAULT_CONFIG injection", () => {
    // A block missing most optional fields must NOT leak DEFAULT_CONFIG values
    // (name "AI Assistant", welcomeMessage "Hi! How can I help?", etc.) — the
    // helper is mechanical; DEFAULT_CONFIG is the hook's fallback, not the
    // helper's. WidgetConfig requires strings, so missing strings map to ""
    // (the neutral non-default value) and nullable fields to null.
    const config = parseWidgetConfigBlock(JSON.stringify({ widgetId: "w1" }));

    expect(config).not.toBeNull();
    expect(config!.name).toBe("");
    expect(config!.welcomeMessage).toBe("");
    expect(config!.fallbackMessage).toBe("");
    expect(config!.placeholder).toBe("");
    expect(config!.piiConsent).toBe("");
    expect(config!.logoUrl).toBeNull();
    expect(config!.avatarUrl).toBeNull();
    expect(config!.autoOpenUrlPatterns).toBeNull();
    expect(config!.leadCapturePrompt).toBeNull();
    expect(config!.autoOpenDelay).toBeNull();
    // 129-01 carve-out: suggestedQuestions is the DOCUMENTED exception to "no
    // DEFAULT_CONFIG injection" — a null/absent block field maps to the 3
    // client defaults (D-02: "blob stays null → client DEFAULT_CONFIG shows").
    // All OTHER no-injection assertions above stay unchanged.
    expect(config!.suggestedQuestions).toEqual(DEFAULT_CONFIG.suggestedQuestions);
    expect(config!.exitIntentEnabled).toBe(false);
    expect(config!.leadCaptureEnabled).toBe(false);
    // 130-01: whiteLabel/credits are neutral when absent from the block —
    // whiteLabel false, credits null (no DEFAULT_CONFIG leakage).
    expect(config!.whiteLabel).toBe(false);
    expect(config!.credits).toBeNull();
    // No DEFAULT_CONFIG values anywhere
    expect(config!.name).not.toBe("AI Assistant");
    expect(config!.welcomeMessage).not.toBe("Hi! How can I help?");
  });

  it("maps a null/absent suggestedQuestions to the 3 client defaults (129-01 tri-state 'not configured')", () => {
    // QST-01 SC1: a widget with questions "not configured" (blob stays null)
    // must show the 3 client defaults — NOT zero chips. The loader keeps
    // emitting null (loader.ts:521); the client owns defaulting.
    const config = parseWidgetConfigBlock(JSON.stringify({ widgetId: "w1", suggestedQuestions: null }));
    expect(config).not.toBeNull();
    expect(config!.suggestedQuestions).toEqual(DEFAULT_CONFIG.suggestedQuestions);
    expect(config!.suggestedQuestions).toEqual([
      "What is this product?",
      "How does it work?",
      "What are the pricing plans?",
    ]);
  });

  it("maps an empty [] suggestedQuestions to [] — admin disabled, defaults never resurrect (129-01)", () => {
    // Phase 125 OQ1 pin: "no questions" sends {} → every locale resolves [] →
    // nothing shows. The client must NOT re-inject the defaults for [].
    const config = parseWidgetConfigBlock(JSON.stringify({ widgetId: "w1", suggestedQuestions: [] }));
    expect(config).not.toBeNull();
    expect(config!.suggestedQuestions).toEqual([]);
  });

  it("maps whiteLabel + credits from the block (130-01, D-03)", () => {
    const block = JSON.stringify({
      widgetId: "w1",
      whiteLabel: true,
      credits: { enabled: false, label: "X", url: "https://x.example" },
    });

    const config = parseWidgetConfigBlock(block);

    expect(config).not.toBeNull();
    expect(config!.whiteLabel).toBe(true);
    expect(config!.credits).toEqual({ enabled: false, label: "X", url: "https://x.example" });
  });

  it("maps a non-boolean whiteLabel to false and a malformed credits blob to neutral inner values (130-01 defensive guards)", () => {
    // Per the plan's mapping spec: an object blob maps with per-field typeof
    // guards (enabled false, label "", url "") — only non-object/absent maps
    // to null. whiteLabel is strict-boolean: non-true → false.
    const config = parseWidgetConfigBlock(JSON.stringify({
      widgetId: "w1",
      whiteLabel: "yes",
      credits: { enabled: "no" },
    }));

    expect(config).not.toBeNull();
    expect(config!.whiteLabel).toBe(false);
    expect(config!.credits).toEqual({ enabled: false, label: "", url: "" });
  });
});

// 130-01 (D-03, RESEARCH Pitfall 5): the single visibility predicate for the
// credits footer line. Hiding requires BOTH the license-derived whiteLabel
// flag AND the admin's credits.enabled === false. Community (whiteLabel false)
// ALWAYS shows — even with enabled:false the credits stay visible. Exported
// from the hook file (NOT the component) so jest node env can import it
// without the Preact/DOM tree — same rationale as shouldRenderFab.
describe("shouldShowCredits — 4-combination visibility matrix (130-01, CRD-02)", () => {
  it("(false, null) → true — no blob, no white-label: credits visible by default (CRD-01)", () => {
    expect(shouldShowCredits(false, null)).toBe(true);
  });

  it("(false, { enabled: false }) → true — Community + enabled:false still SHOWS (Pitfall 5)", () => {
    expect(shouldShowCredits(false, { enabled: false, label: "X", url: "https://x.example" })).toBe(true);
  });

  it("(true, { enabled: true }) → true — white-label license, credits enabled: visible", () => {
    expect(shouldShowCredits(true, { enabled: true, label: "X", url: "https://x.example" })).toBe(true);
  });

  it("(true, { enabled: false }) → false — white-label license + admin disabled: hidden", () => {
    expect(shouldShowCredits(true, { enabled: false, label: "X", url: "https://x.example" })).toBe(false);
  });
});
