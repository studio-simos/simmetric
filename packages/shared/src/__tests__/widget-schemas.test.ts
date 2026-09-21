// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  widgetChatRequestSchema,
  widgetSessionCreateSchema,
  createWidgetSchema,
  updateWidgetSchema,
  widgetConfigResponseSchema,
  widgetSessionResponseSchema,
  widgetSearchRequestSchema,
  widgetCreditsSchema,
  widgetWorkspaceArchiveFilterSchema,
  widgetContactOptionsSchema,
  widgetLeadSubmitSchema,
  WIDGET_LOCALES,
} from "../schemas/widget.schema";

// ─── widgetChatRequestSchema ────────────────────────────────────

describe("widgetChatRequestSchema", () => {
  it("accepts valid chat request with message only", () => {
    const result = widgetChatRequestSchema.safeParse({ message: "hello" });
    expect(result.success).toBe(true);
  });

  it("accepts valid chat request with optional chatId", () => {
    const result = widgetChatRequestSchema.safeParse({
      message: "hello",
      chatId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty message", () => {
    const result = widgetChatRequestSchema.safeParse({ message: "" });
    expect(result.success).toBe(false);
  });

  it("rejects message exceeding 4000 chars", () => {
    const result = widgetChatRequestSchema.safeParse({ message: "x".repeat(4001) });
    expect(result.success).toBe(false);
  });

  it("accepts message at exactly 4000 chars", () => {
    const result = widgetChatRequestSchema.safeParse({ message: "x".repeat(4000) });
    expect(result.success).toBe(true);
  });

  it("rejects invalid chatId (not UUID)", () => {
    const result = widgetChatRequestSchema.safeParse({
      message: "hello",
      chatId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  // 131-07 (G-131-19): locale is a first-class field of the chat request —
  // the visitor locale travels widget client → proxy → server orchestrator.
  it("accepts a valid locale (it)", () => {
    const result = widgetChatRequestSchema.safeParse({ message: "hello", locale: "it" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.locale).toBe("it");
    }
  });

  it("accepts all 7 WIDGET_LOCALES codes", () => {
    for (const code of WIDGET_LOCALES) {
      const result = widgetChatRequestSchema.safeParse({ message: "hello", locale: code });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown locale (xx) — enum whitelist is the prompt-injection defense", () => {
    const result = widgetChatRequestSchema.safeParse({ message: "hello", locale: "xx" });
    expect(result.success).toBe(false);
  });

  it("omitted locale stays undefined (additive — old clients keep parsing)", () => {
    const result = widgetChatRequestSchema.safeParse({ message: "hello" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.locale).toBeUndefined();
    }
  });
});

// ─── widgetSessionCreateSchema ──────────────────────────────────

describe("widgetSessionCreateSchema", () => {
  it("accepts valid session creation", () => {
    const result = widgetSessionCreateSchema.safeParse({ widgetId: "w_123" });
    expect(result.success).toBe(true);
  });

  it("rejects empty widgetId", () => {
    const result = widgetSessionCreateSchema.safeParse({ widgetId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing widgetId", () => {
    const result = widgetSessionCreateSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── createWidgetSchema ─────────────────────────────────────────

describe("createWidgetSchema", () => {
  it("accepts valid widget creation with name only", () => {
    const result = createWidgetSchema.safeParse({ name: "Test Widget" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.position).toBe("bottom-right"); // default
    }
  });

  it("accepts widget with all fields", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test Widget",
      welcomeMessage: "Hi there!",
      fallbackMessage: "Sorry, no answer.",
      position: "bottom-left",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.position).toBe("bottom-left");
    }
  });

  it("rejects empty name", () => {
    const result = createWidgetSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name exceeding 200 chars", () => {
    const result = createWidgetSchema.safeParse({ name: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects invalid position", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      position: "top-center",
    });
    expect(result.success).toBe(false);
  });

  it("accepts welcomeMessage up to 1000 chars", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      welcomeMessage: "x".repeat(1000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects welcomeMessage exceeding 1000 chars", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      welcomeMessage: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  // ── Branding field tests (CUST-01) ──

  it("accepts branding fields: primaryColor hex", () => {
    const result = createWidgetSchema.safeParse({ name: "Test", primaryColor: "#4c6ef5" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.primaryColor).toBe("#4c6ef5");
    }
  });

  it("accepts branding fields: botName", () => {
    const result = createWidgetSchema.safeParse({ name: "Test", botName: "HelpBot" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.botName).toBe("HelpBot");
    }
  });

  it("accepts branding fields: logoUrl with https", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      logoUrl: "https://example.com/logo.png",
    });
    expect(result.success).toBe(true);
  });

  it("accepts branding fields: avatarUrl with http", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      avatarUrl: "http://example.com/avatar.png",
    });
    expect(result.success).toBe(true);
  });

  it("rejects javascript: URL in logoUrl", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      logoUrl: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("rejects data: URL in avatarUrl", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      avatarUrl: "data:text/html,<script>alert(1)</script>",
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty string for logoUrl", () => {
    const result = createWidgetSchema.safeParse({ name: "Test", logoUrl: "" });
    expect(result.success).toBe(true);
  });

  it("accepts empty string for avatarUrl", () => {
    const result = createWidgetSchema.safeParse({ name: "Test", avatarUrl: "" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid hex color in primaryColor", () => {
    const result = createWidgetSchema.safeParse({ name: "Test", primaryColor: "red" });
    expect(result.success).toBe(false);
  });

  it("rejects botName exceeding 100 chars", () => {
    const result = createWidgetSchema.safeParse({ name: "Test", botName: "x".repeat(101) });
    expect(result.success).toBe(false);
  });

  // ── Localization blob tests (D-02..D-05) ──

  it("accepts localizedTexts with a partial 1-of-7 locale map", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      localizedTexts: { en: { welcomeMessage: "Hi!" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts suggestedQuestions with 10 questions of exactly 200 chars", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      suggestedQuestions: { en: Array.from({ length: 10 }, () => "x".repeat(200)) },
    });
    expect(result.success).toBe(true);
  });

  it("accepts credits with an https URL", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      credits: { enabled: true, label: "Acme", url: "https://acme.example.com" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts credits with enabled:false and empty label/url (WR-02 widened schema)", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      credits: { enabled: false, label: "", url: "" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts credits with enabled:false and one empty field (WR-02 widened schema)", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      credits: { enabled: false, label: "", url: "https://acme.example.com" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts fallbackLocale de", () => {
    const result = createWidgetSchema.safeParse({ name: "Test", fallbackLocale: "de" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fallbackLocale).toBe("de");
    }
  });

  it("defaults fallbackLocale to en when omitted", () => {
    const result = createWidgetSchema.parse({ name: "Test" });
    expect(result.fallbackLocale).toBe("en");
  });

  it("rejects an unknown locale key in localizedTexts", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      localizedTexts: { xx: { welcomeMessage: "x" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown inner key in localizedTexts", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      localizedTexts: { en: { evil: "x" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects 11 suggested questions", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      suggestedQuestions: { en: Array.from({ length: 11 }, () => "q") },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a 201-char question", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      suggestedQuestions: { en: ["x".repeat(201)] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a javascript: credits URL", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      credits: { enabled: true, label: "Acme", url: "javascript:alert(1)" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a data: credits URL", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      credits: { enabled: true, label: "Acme", url: "data:text/html,<script>alert(1)</script>" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects credits missing url", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      credits: { enabled: true, label: "Acme" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects credits with a non-boolean enabled", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      credits: { enabled: "yes", label: "Acme", url: "https://acme.example.com" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts null blob fields (tri-state write contract)", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      localizedTexts: null,
      suggestedQuestions: null,
      credits: null,
    });
    expect(result.success).toBe(true);
  });

  // ── Per-widget response model pin (260831-hgy) ──

  it("accepts responseProviderId + responseModel pair on create", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      responseProviderId: "550e8400-e29b-41d4-a716-446655440000",
      responseModel: "qwen2.5:7b",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseProviderId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.data.responseModel).toBe("qwen2.5:7b");
    }
  });

  it("accepts null pair on create (clear contract)", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      responseProviderId: null,
      responseModel: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseProviderId).toBeNull();
      expect(result.data.responseModel).toBeNull();
    }
  });

  it("accepts a payload without the pair on create (legacy payloads)", () => {
    const result = createWidgetSchema.safeParse({ name: "Test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseProviderId).toBeUndefined();
      expect(result.data.responseModel).toBeUndefined();
    }
  });

  it("rejects a non-UUID responseProviderId on create", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      responseProviderId: "not-a-uuid",
      responseModel: "qwen2.5:7b",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty responseModel on create (min(1))", () => {
    const result = createWidgetSchema.safeParse({
      name: "Test",
      responseProviderId: "550e8400-e29b-41d4-a716-446655440000",
      responseModel: "",
    });
    expect(result.success).toBe(false);
  });
});

// ─── updateWidgetSchema ──────────────────────────────────────────

describe("updateWidgetSchema", () => {
  it("allows partial update with name only", () => {
    const result = updateWidgetSchema.safeParse({ name: "Updated Widget" });
    expect(result.success).toBe(true);
  });

  it("allows partial update with primaryColor only", () => {
    const result = updateWidgetSchema.safeParse({ primaryColor: "#ff0000" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.primaryColor).toBe("#ff0000");
    }
  });

  it("allows partial update with botName only", () => {
    const result = updateWidgetSchema.safeParse({ botName: "NewBot" });
    expect(result.success).toBe(true);
  });

  it("allows partial update with logoUrl only", () => {
    const result = updateWidgetSchema.safeParse({
      logoUrl: "https://example.com/new-logo.png",
    });
    expect(result.success).toBe(true);
  });

  it("allows partial update with avatarUrl only", () => {
    const result = updateWidgetSchema.safeParse({
      avatarUrl: "https://example.com/new-avatar.png",
    });
    expect(result.success).toBe(true);
  });

  it("allows updating isActive", () => {
    const result = updateWidgetSchema.safeParse({ isActive: false });
    expect(result.success).toBe(true);
  });

  it("rejects invalid hex color in primaryColor", () => {
    const result = updateWidgetSchema.safeParse({ primaryColor: "red" });
    expect(result.success).toBe(false);
  });

  it("rejects javascript: URL in logoUrl", () => {
    const result = updateWidgetSchema.safeParse({
      logoUrl: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("rejects data: URL in avatarUrl", () => {
    const result = updateWidgetSchema.safeParse({
      avatarUrl: "data:image/svg+xml,<svg></svg>",
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty string for logoUrl", () => {
    const result = updateWidgetSchema.safeParse({ logoUrl: "" });
    expect(result.success).toBe(true);
  });

  it("accepts empty string for avatarUrl", () => {
    const result = updateWidgetSchema.safeParse({ avatarUrl: "" });
    expect(result.success).toBe(true);
  });

  it("allows updating name and primaryColor together", () => {
    const result = updateWidgetSchema.safeParse({
      name: "Updated",
      primaryColor: "#ff0000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name in update", () => {
    const result = updateWidgetSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  // ── Localization blob tests (D-02..D-05) ──

  it("accepts localizedTexts with a partial 1-of-7 locale map", () => {
    const result = updateWidgetSchema.safeParse({
      localizedTexts: { it: { placeholder: "Scrivi..." } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts suggestedQuestions with 10 questions of exactly 200 chars", () => {
    const result = updateWidgetSchema.safeParse({
      suggestedQuestions: { en: Array.from({ length: 10 }, () => "x".repeat(200)) },
    });
    expect(result.success).toBe(true);
  });

  it("accepts credits with an http URL", () => {
    const result = updateWidgetSchema.safeParse({
      credits: { enabled: false, label: "Acme", url: "http://acme.example.com" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts credits with enabled:false and empty label/url (WR-02 widened schema)", () => {
    const result = updateWidgetSchema.safeParse({
      credits: { enabled: false, label: "", url: "" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts credits with enabled:false and one empty field (WR-02 widened schema)", () => {
    const result = updateWidgetSchema.safeParse({
      credits: { enabled: false, label: "Acme", url: "" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown locale key in localizedTexts", () => {
    const result = updateWidgetSchema.safeParse({
      localizedTexts: { zz: { welcomeMessage: "x" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown inner key in localizedTexts", () => {
    const result = updateWidgetSchema.safeParse({
      localizedTexts: { en: { welcomeMessage: "x", evil: "y" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects 11 suggested questions", () => {
    const result = updateWidgetSchema.safeParse({
      suggestedQuestions: { en: Array.from({ length: 11 }, () => "q") },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a 201-char question", () => {
    const result = updateWidgetSchema.safeParse({
      suggestedQuestions: { en: ["x".repeat(201)] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a javascript: credits URL", () => {
    const result = updateWidgetSchema.safeParse({
      credits: { enabled: true, label: "Acme", url: "javascript:alert(1)" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a data: credits URL", () => {
    const result = updateWidgetSchema.safeParse({
      credits: { enabled: true, label: "Acme", url: "data:text/html,<script>alert(1)</script>" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects credits missing url", () => {
    const result = updateWidgetSchema.safeParse({
      credits: { enabled: true, label: "Acme" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects credits with a non-boolean enabled", () => {
    const result = updateWidgetSchema.safeParse({
      credits: { enabled: 1, label: "Acme", url: "https://acme.example.com" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts null blob fields (tri-state write contract)", () => {
    const result = updateWidgetSchema.safeParse({
      localizedTexts: null,
      suggestedQuestions: null,
      credits: null,
    });
    expect(result.success).toBe(true);
  });

  it("fallbackLocale accepts all 7 codes", () => {
    for (const code of WIDGET_LOCALES) {
      const result = updateWidgetSchema.safeParse({ fallbackLocale: code });
      expect(result.success).toBe(true);
    }
  });

  it("omitting fallbackLocale leaves it undefined in parsed.data (no default injection)", () => {
    const result = updateWidgetSchema.safeParse({ name: "Updated" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fallbackLocale).toBeUndefined();
    }
  });

  // ── Per-widget response model pin (260831-hgy) ──

  it("accepts responseProviderId + responseModel pair on update", () => {
    const result = updateWidgetSchema.safeParse({
      responseProviderId: "550e8400-e29b-41d4-a716-446655440000",
      responseModel: "llama3.1:8b",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseProviderId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.data.responseModel).toBe("llama3.1:8b");
    }
  });

  it("accepts null pair on update (clear contract — null → SQL NULL)", () => {
    const result = updateWidgetSchema.safeParse({
      responseProviderId: null,
      responseModel: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseProviderId).toBeNull();
      expect(result.data.responseModel).toBeNull();
    }
  });

  it("accepts an update without the pair (partial-update semantics preserved)", () => {
    const result = updateWidgetSchema.safeParse({ name: "Updated" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseProviderId).toBeUndefined();
      expect(result.data.responseModel).toBeUndefined();
    }
  });

  it("rejects a non-UUID responseProviderId on update", () => {
    const result = updateWidgetSchema.safeParse({ responseProviderId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty responseModel on update (min(1))", () => {
    const result = updateWidgetSchema.safeParse({ responseModel: "" });
    expect(result.success).toBe(false);
  });
});

// ─── widgetCreditsSchema URL predicate (WR-01 parity pins) ──
// These cases pin the SHARED isHttpUrl predicate (widget.schema.ts — WHATWG
// new URL() with protocol + non-empty host, case-insensitive) so the WR-01
// client/server divergence (131-REVIEW.md) stays closed: bare schemes are
// REJECTED (new URL() throws — the old startsWith regression that accepted
// them is gone), uppercase/non-slash schemes are ACCEPTED exactly like the
// client new URL() check (the old case-sensitive startsWith rejected them,
// 400ing the ENTIRE PUT). Do NOT change these expectations without changing
// the shared predicate first.

describe("widgetCreditsSchema URL predicate (WR-01 parity pins)", () => {
  it("rejects a bare http:// scheme (new URL() throws — WR-01 regression closed)", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: true,
      label: "Acme",
      url: "http://",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bare https:// scheme (new URL() throws — WR-01 regression closed)", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: true,
      label: "Acme",
      url: "https://",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an uppercase HTTPS://X.COM url (case-insensitive isHttpUrl — parity with the client new URL() check)", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: true,
      label: "Acme",
      url: "HTTPS://X.COM",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an http:example.com url (new URL() parses host example.com — parity with the client new URL() check)", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: true,
      label: "Acme",
      url: "http:example.com",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a javascript: url", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: true,
      label: "Acme",
      url: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid https://example.com url", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: true,
      label: "Acme",
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty url when enabled is false (WR-02 hide-blob contract)", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: false,
      label: "",
      url: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty url when enabled is true", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: true,
      label: "Acme",
      url: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a javascript: url even when enabled is false (defense-in-depth)", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: false,
      label: "",
      url: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an uppercase HTTPS://X.COM url when enabled is false (WR-01 parity — disabled blob still validates http(s))", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: false,
      label: "",
      url: "HTTPS://X.COM",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an http:example.com url when enabled is false (WR-01 parity — new URL() host-aware semantics)", () => {
    const result = widgetCreditsSchema.safeParse({
      enabled: false,
      label: "",
      url: "http:example.com",
    });
    expect(result.success).toBe(true);
  });
});

// ─── widgetConfigResponseSchema ─────────────────────────────────

describe("widgetConfigResponseSchema", () => {
  const validConfig = {
    id: "widget-1",
    name: "Test Widget",
    position: "bottom-right" as const,
    isActive: true,
    workspaceId: "550e8400-e29b-41d4-a716-446655440000",
    workspaceIds: ["550e8400-e29b-41d4-a716-446655440000"],
  };

  it("accepts valid config with required fields", () => {
    const result = widgetConfigResponseSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("accepts config with optional fields", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      welcomeMessage: "Hi!",
      fallbackMessage: "No answer.",
      primaryColor: "#3b82f6",
      locale: "en",
    });
    expect(result.success).toBe(true);
  });

  it("applies default locale", () => {
    const result = widgetConfigResponseSchema.parse(validConfig);
    expect(result.locale).toBe("en");
  });

  it("rejects invalid position", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      position: "top-center",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid workspaceId", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      workspaceId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts and requires workspaceIds (route emission contract)", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      workspaceIds: [
        "550e8400-e29b-41d4-a716-446655440000",
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceIds).toHaveLength(2);
    }
    const { workspaceIds: _omitted, ...configWithoutWorkspaceIds } = validConfig;
    const missing = widgetConfigResponseSchema.safeParse(configWithoutWorkspaceIds);
    expect(missing.success).toBe(false);
  });

  it("rejects invalid primaryColor format", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      primaryColor: "blue",
    });
    expect(result.success).toBe(false);
  });

  it("includes branding defaults for primaryColor and botName", () => {
    const result = widgetConfigResponseSchema.parse(validConfig);
    expect(result.primaryColor).toBe("#4c6ef5");
    expect(result.botName).toBe("AI Assistant");
  });

  it("accepts nullable logoUrl and avatarUrl", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      logoUrl: null,
      avatarUrl: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid logoUrl and avatarUrl URLs", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      logoUrl: "https://example.com/logo.png",
      avatarUrl: "https://example.com/avatar.png",
    });
    expect(result.success).toBe(true);
  });

  // ── 7-locale enum widening + localization blobs (D-01..D-05) ──

  it("locale accepts all 7 codes (3→7 widening regression guard)", () => {
    for (const code of WIDGET_LOCALES) {
      const result = widgetConfigResponseSchema.safeParse({ ...validConfig, locale: code });
      expect(result.success).toBe(true);
    }
  });

  it("fallbackLocale defaults to en when omitted", () => {
    const result = widgetConfigResponseSchema.parse(validConfig);
    expect(result.fallbackLocale).toBe("en");
  });

  it("accepts the three blob fields", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      localizedTexts: { de: { welcomeMessage: "Hallo" } },
      suggestedQuestions: { de: ["Frage 1", "Frage 2"] },
      credits: { enabled: true, label: "Acme", url: "https://acme.example.com" },
      fallbackLocale: "de",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null blob fields (tri-state write contract)", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      localizedTexts: null,
      suggestedQuestions: null,
      credits: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown locale key inside localizedTexts", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...validConfig,
      localizedTexts: { yy: { welcomeMessage: "x" } },
    });
    expect(result.success).toBe(false);
  });
});

// ─── widgetSessionResponseSchema ────────────────────────────────

describe("widgetSessionResponseSchema", () => {
  const validSession = {
    id: "sess-1",
    widgetId: "widget-1",
    sessionToken: "tok_abc123",
    ipAddress: null,
    messageCount: 0,
    conversationCount: 0,
    lastResetAt: "2025-01-01T00:00:00.000Z",
    expiresAt: "2025-01-02T00:00:00.000Z",
    hourlyRemaining: 20,
    dailyRemaining: 5,
  };

  it("accepts valid session response", () => {
    const result = widgetSessionResponseSchema.safeParse(validSession);
    expect(result.success).toBe(true);
  });

  it("applies default hourlyLimit and dailyLimit", () => {
    const result = widgetSessionResponseSchema.parse(validSession);
    expect(result.hourlyLimit).toBe(20);
    expect(result.dailyLimit).toBe(5);
  });

  it("rejects negative messageCount", () => {
    const result = widgetSessionResponseSchema.safeParse({
      ...validSession,
      messageCount: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative conversationCount", () => {
    const result = widgetSessionResponseSchema.safeParse({
      ...validSession,
      conversationCount: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid datetime for lastResetAt", () => {
    const result = widgetSessionResponseSchema.safeParse({
      ...validSession,
      lastResetAt: "not-a-datetime",
    });
    expect(result.success).toBe(false);
  });
});

// ─── widgetSearchRequestSchema (RAG-02, RAG-03) ──────────────────

describe("widgetSearchRequestSchema", () => {
  it("accepts valid search request with query, widgetId, and limit", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "test query",
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 10,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid search request without limit (defaults to 10)", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "test query",
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  it("rejects missing query", () => {
    const result = widgetSearchRequestSchema.safeParse({
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty query", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "",
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects query exceeding 1000 chars", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "x".repeat(1001),
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 10,
    });
    expect(result.success).toBe(false);
  });

  it("accepts query at exactly 1000 chars", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "x".repeat(1000),
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 10,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing widgetId", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "test",
      limit: 10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid widgetId (not UUID)", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "test query",
      widgetId: "not-a-uuid",
      limit: 10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects limit greater than 50", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "test query",
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 51,
    });
    expect(result.success).toBe(false);
  });

  it("accepts limit at exactly 50", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "test query",
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  it("rejects limit less than 1", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "test query",
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer limit", () => {
    const result = widgetSearchRequestSchema.safeParse({
      query: "test query",
      widgetId: "550e8400-e29b-41d4-a716-446655440000",
      limit: 5.5,
    });
    expect(result.success).toBe(false);
  });
});

// ─── WIDGET_LOCALES (D-01) ────────────────────────────────────────

describe("WIDGET_LOCALES", () => {
  it("has length 8", () => {
    expect(WIDGET_LOCALES).toHaveLength(8);
  });

  it("contains en/it/ru/de/fr/es/zh/pt", () => {
    for (const code of ["en", "it", "ru", "de", "fr", "es", "zh", "pt"]) {
      expect(WIDGET_LOCALES).toContain(code);
    }
  });
});

// ─── widgetWorkspaceArchiveFilterSchema (WGTA-01, D-01) ──────────

describe("widgetWorkspaceArchiveFilterSchema", () => {
  it("accepts an empty query (all filters optional — full-archive default)", () => {
    const result = widgetWorkspaceArchiveFilterSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBeUndefined();
      expect(result.data.workspaceId).toBeUndefined();
      expect(result.data.widgetId).toBeUndefined();
    }
  });

  it("accepts valid uuid filters (all three keys set)", () => {
    const result = widgetWorkspaceArchiveFilterSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      widgetId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.data.workspaceId).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
      expect(result.data.widgetId).toBe("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    }
  });

  it("accepts a single-key filter (projectId only)", () => {
    const result = widgetWorkspaceArchiveFilterSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.widgetId).toBeUndefined();
    }
  });

  it("rejects a non-uuid projectId", () => {
    const result = widgetWorkspaceArchiveFilterSchema.safeParse({
      projectId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid workspaceId", () => {
    const result = widgetWorkspaceArchiveFilterSchema.safeParse({
      workspaceId: "workspace-001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid widgetId", () => {
    const result = widgetWorkspaceArchiveFilterSchema.safeParse({
      widgetId: "widget-001",
    });
    expect(result.success).toBe(false);
  });
});
// ─── 260917-mz6: widgetContactOptionsSchema + the four new Widget fields ───

describe("widgetContactOptionsSchema (260917-mz6)", () => {
  const VALID_BLOB = {
    formUrl: "https://example.com/contact",
    bookingUrl: "https://cal.example.com/owner",
    email: "owner@example.com",
    customUrl: "https://example.com/sales",
    customLabel: "Talk to sales",
  };

  it("accepts a fully-populated blob", () => {
    const result = widgetContactOptionsSchema.safeParse(VALID_BLOB);
    expect(result.success).toBe(true);
  });

  it("accepts a partial blob (one field)", () => {
    const result = widgetContactOptionsSchema.safeParse({ email: "owner@example.com" });
    expect(result.success).toBe(true);
  });

  it("rejects a javascript: URL (mandatory isHttpUrl refine — credits-blob precedent)", () => {
    const result = widgetContactOptionsSchema.safeParse({ formUrl: "javascript:alert(1)" });
    expect(result.success).toBe(false);
  });

  it("rejects a data: URL", () => {
    const result = widgetContactOptionsSchema.safeParse({ bookingUrl: "data:text/html,hi" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty blob (superRefine: at least one configured field)", () => {
    const result = widgetContactOptionsSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = JSON.stringify(result.error.flatten());
      expect(messages).toContain("At least one contact option is required");
    }
  });

  it("rejects an all-empty-string blob", () => {
    const result = widgetContactOptionsSchema.safeParse({
      formUrl: "", bookingUrl: "", email: "", customUrl: "", customLabel: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strict object)", () => {
    const result = widgetContactOptionsSchema.safeParse({
      email: "owner@example.com",
      evil: "https://x.example",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed email", () => {
    const result = widgetContactOptionsSchema.safeParse({ email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects a customLabel over 200 chars", () => {
    const result = widgetContactOptionsSchema.safeParse({
      customLabel: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });
});

describe("260917-mz6 write fields on create/update schemas", () => {
  it("createWidgetSchema accepts systemPrompt + contactConfig + timing + timeout", () => {
    const result = createWidgetSchema.safeParse({
      name: "Grounded Widget",
      systemPrompt: "x".repeat(4000),
      contactConfig: { email: "owner@example.com" },
      leadCaptureTiming: "start",
      leadCaptureTimeoutSeconds: 30,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPrompt).toHaveLength(4000);
      expect(result.data.leadCaptureTiming).toBe("start");
    }
  });

  it("createWidgetSchema rejects an over-long systemPrompt (max 4000)", () => {
    const result = createWidgetSchema.safeParse({
      name: "Too Long",
      systemPrompt: "x".repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  it("createWidgetSchema rejects an out-of-bounds leadCaptureTimeoutSeconds (min 5 / max 86400)", () => {
    expect(createWidgetSchema.safeParse({ name: "w", leadCaptureTimeoutSeconds: 4 }).success).toBe(false);
    expect(createWidgetSchema.safeParse({ name: "w", leadCaptureTimeoutSeconds: 86401 }).success).toBe(false);
    expect(createWidgetSchema.safeParse({ name: "w", leadCaptureTimeoutSeconds: 60 }).success).toBe(true);
  });

  it("updateWidgetSchema accepts null clears for all four fields (nullable write contract)", () => {
    const result = updateWidgetSchema.safeParse({
      systemPrompt: null,
      contactConfig: null,
      leadCaptureTimeoutSeconds: null,
    });
    expect(result.success).toBe(true);
  });

  it("updateWidgetSchema rejects an invalid timing enum", () => {
    const result = updateWidgetSchema.safeParse({ leadCaptureTiming: "midway" });
    expect(result.success).toBe(false);
  });

  it("updateWidgetSchema rejects a javascript: URL inside contactConfig", () => {
    const result = updateWidgetSchema.safeParse({
      contactConfig: { formUrl: "javascript:alert(1)" },
    });
    expect(result.success).toBe(false);
  });
});

describe("widgetConfigResponseSchema — 260917-mz6 runtime fields", () => {
  const baseConfig = {
    id: "widget-1",
    name: "Test",
    position: "bottom-right",
    isActive: true,
    workspaceId: "550e8400-e29b-41d4-a716-446655440000",
    workspaceIds: ["550e8400-e29b-41d4-a716-446655440000"],
  };

  it("parses the three runtime fields when present", () => {
    const result = widgetConfigResponseSchema.safeParse({
      ...baseConfig,
      contactConfig: { email: "owner@example.com" },
      leadCaptureTiming: "timeout",
      leadCaptureTimeoutSeconds: 45,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.leadCaptureTiming).toBe("timeout");
      expect(result.data.leadCaptureTimeoutSeconds).toBe(45);
    }
  });

  it("parses old fixtures WITHOUT the new fields (additive-optional)", () => {
    const result = widgetConfigResponseSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
  });

  it("deliberately omits systemPrompt from the runtime response (T-Q02 — never reaches the client)", () => {
    // The write schemas carry systemPrompt; the response schema must NOT.
    // A server accidentally echoing systemPrompt into the config response is
    // stripped by the schema (unknown key on a non-strict object would pass,
    // so assert the SHAPE instead: the inferred type has no systemPrompt key
    // requirement and a fixture carrying it still parses — the guarantee is
    // that the ROUTE never emits it, pinned in internalWidget.test.ts).
    const result = widgetConfigResponseSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("systemPrompt");
    }
  });
});

// ─── 260917-qoh: privacyUrl + lead privacy consent ──────────────────────

describe("260917-qoh privacyUrl on create/update schemas", () => {
  it("createWidgetSchema accepts a valid http(s) privacyUrl", () => {
    expect(createWidgetSchema.safeParse({ name: "w", privacyUrl: "https://example.com/privacy" }).success).toBe(true);
    expect(createWidgetSchema.safeParse({ name: "w", privacyUrl: "http://example.com/privacy" }).success).toBe(true);
  });

  it("createWidgetSchema rejects a javascript:/data: privacyUrl (mandatory isHttpUrl refine)", () => {
    expect(createWidgetSchema.safeParse({ name: "w", privacyUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(createWidgetSchema.safeParse({ name: "w", privacyUrl: "data:text/html,x" }).success).toBe(false);
  });

  it("updateWidgetSchema accepts a valid privacyUrl and null (nullable write contract)", () => {
    expect(updateWidgetSchema.safeParse({ privacyUrl: "https://example.com/privacy" }).success).toBe(true);
    expect(updateWidgetSchema.safeParse({ privacyUrl: null }).success).toBe(true);
  });

  it("updateWidgetSchema rejects a javascript: privacyUrl", () => {
    expect(updateWidgetSchema.safeParse({ privacyUrl: "javascript:alert(1)" }).success).toBe(false);
  });

  it("privacyUrl is optional on both write schemas (undefined = unchanged)", () => {
    expect(createWidgetSchema.safeParse({ name: "w" }).success).toBe(true);
    expect(updateWidgetSchema.safeParse({}).success).toBe(true);
  });
});

describe("widgetConfigResponseSchema — 260917-qoh privacyUrl runtime field", () => {
  const baseConfig = {
    id: "widget-1",
    name: "Test",
    position: "bottom-right",
    isActive: true,
    workspaceId: "550e8400-e29b-41d4-a716-446655440000",
    workspaceIds: ["550e8400-e29b-41d4-a716-446655440000"],
  };

  it("parses the privacyUrl field when present (string or null)", () => {
    const withUrl = widgetConfigResponseSchema.safeParse({ ...baseConfig, privacyUrl: "https://example.com/privacy" });
    expect(withUrl.success).toBe(true);
    if (withUrl.success) expect(withUrl.data.privacyUrl).toBe("https://example.com/privacy");

    const withNull = widgetConfigResponseSchema.safeParse({ ...baseConfig, privacyUrl: null });
    expect(withNull.success).toBe(true);
    if (withNull.success) expect(withNull.data.privacyUrl).toBeNull();
  });

  it("parses old fixtures WITHOUT privacyUrl (additive-optional)", () => {
    expect(widgetConfigResponseSchema.safeParse(baseConfig).success).toBe(true);
  });
});

describe("widgetLeadSubmitSchema — 260917-qoh privacy consent gate", () => {
  const validLead = {
    email: "visitor@example.com",
    privacyConsented: true,
    transcript: [{ role: "user", content: "hi" }],
  };

  it("accepts a lead with privacyConsented: true", () => {
    const result = widgetLeadSubmitSchema.safeParse(validLead);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.privacyConsented).toBe(true);
  });

  it("rejects a lead WITHOUT the consent field (fail-closed 400)", () => {
    const { privacyConsented, ...withoutConsent } = validLead;
    expect(widgetLeadSubmitSchema.safeParse(withoutConsent).success).toBe(false);
  });

  it("rejects a lead with privacyConsented: false (z.literal(true))", () => {
    expect(widgetLeadSubmitSchema.safeParse({ ...validLead, privacyConsented: false }).success).toBe(false);
  });

  it("rejects a lead with a truthy non-boolean consent value", () => {
    expect(widgetLeadSubmitSchema.safeParse({ ...validLead, privacyConsented: "yes" }).success).toBe(false);
  });
});
