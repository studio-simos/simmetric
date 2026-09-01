// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  resolveWidgetTexts,
  resolveSuggestedQuestions,
} from "../schemas/widget.schema";
import type { WidgetSuggestedQuestions } from "../schemas/widget.schema";

// ─── resolveWidgetTexts (D-07 chain: exact → fallbackLocale → legacy → en) ──

describe("resolveWidgetTexts", () => {
  it("exact locale wins over fallbackLocale per key", () => {
    const result = resolveWidgetTexts(
      {
        localizedTexts: {
          en: { welcomeMessage: "EN welcome" },
          de: { welcomeMessage: "DE welcome" },
        },
        fallbackLocale: "de",
      },
      "de",
    );
    expect(result.welcomeMessage).toBe("DE welcome");
  });

  it("fallbackLocale used when exact locale missing", () => {
    const result = resolveWidgetTexts(
      {
        localizedTexts: {
          en: { welcomeMessage: "EN welcome" },
          de: { welcomeMessage: "DE welcome" },
        },
        fallbackLocale: "de",
      },
      "fr",
    );
    expect(result.welcomeMessage).toBe("DE welcome");
  });

  it("legacy welcomeMessage used when no blob entry in any tier", () => {
    const result = resolveWidgetTexts(
      {
        localizedTexts: { en: { placeholder: "Ask..." } },
        fallbackLocale: "de",
        welcomeMessage: "Legacy hello",
        fallbackMessage: "Legacy fallback",
      },
      "fr",
    );
    expect(result.welcomeMessage).toBe("Legacy hello");
    expect(result.fallbackMessage).toBe("Legacy fallback");
    expect(result.placeholder).toBe("Ask...");
  });

  it("texts.en used when fallbackLocale is not en and exact/fallback lack the key", () => {
    const result = resolveWidgetTexts(
      {
        localizedTexts: {
          en: { welcomeMessage: "EN welcome", piiConsent: "EN pii" },
          de: { welcomeMessage: "DE welcome" },
        },
        fallbackLocale: "de",
      },
      "fr",
    );
    expect(result.welcomeMessage).toBe("DE welcome"); // fallback tier wins
    expect(result.piiConsent).toBe("EN pii"); // en tier fills the gap
  });

  it("per-key merge: exact locale provides placeholder, fallbackLocale provides welcomeMessage", () => {
    const result = resolveWidgetTexts(
      {
        localizedTexts: {
          en: { welcomeMessage: "EN welcome" },
          de: { welcomeMessage: "DE welcome", placeholder: "DE placeholder" },
          fr: { placeholder: "FR placeholder" },
        },
        fallbackLocale: "de",
      },
      "fr",
    );
    expect(result.welcomeMessage).toBe("DE welcome");
    expect(result.placeholder).toBe("FR placeholder");
  });

  it("empty localizedTexts → legacy scalars only", () => {
    const result = resolveWidgetTexts(
      { localizedTexts: {}, welcomeMessage: "Legacy hello" },
      "it",
    );
    expect(result.welcomeMessage).toBe("Legacy hello");
    expect(result.placeholder).toBeUndefined();
  });

  it("all-null config → all undefined", () => {
    const result = resolveWidgetTexts(
      {
        localizedTexts: null,
        fallbackLocale: null,
        welcomeMessage: null,
        fallbackMessage: null,
      },
      "it",
    );
    expect(result).toEqual({
      welcomeMessage: undefined,
      fallbackMessage: undefined,
      placeholder: undefined,
      piiConsent: undefined,
      leadPrompt: undefined,
    });
  });

  it("fallbackLocale absent → defaults to en", () => {
    const result = resolveWidgetTexts(
      {
        localizedTexts: { en: { welcomeMessage: "EN welcome" }, de: { welcomeMessage: "DE welcome" } },
      },
      "fr",
    );
    expect(result.welcomeMessage).toBe("EN welcome");
  });

  it("returns undefined (not null) for unset fields — ResolvedWidgetTexts contract", () => {
    const result = resolveWidgetTexts({ localizedTexts: { it: { leadPrompt: "x" } } }, "it");
    expect(result.welcomeMessage).toBeUndefined();
    expect(result.leadPrompt).toBe("x");
  });
});

// ─── resolveSuggestedQuestions (D-04 tri-state + D-07 per-index fallback) ──

describe("resolveSuggestedQuestions", () => {
  it("null blob → null (not configured → client defaults)", () => {
    expect(resolveSuggestedQuestions({ suggestedQuestions: null }, "en")).toBeNull();
    expect(resolveSuggestedQuestions({}, "en")).toBeNull();
  });

  it("[] in exact locale → [] even when fallback and en are populated (short-circuit)", () => {
    const sq: WidgetSuggestedQuestions = {
      en: ["EN q1", "EN q2"],
      de: ["DE q1", "DE q2"],
      it: [],
    };
    expect(resolveSuggestedQuestions({ suggestedQuestions: sq, fallbackLocale: "de" }, "it")).toEqual([]);
  });

  it("exact locale list wins whole", () => {
    const sq: WidgetSuggestedQuestions = {
      en: ["EN q1", "EN q2"],
      de: ["DE q1", "DE q2", "DE q3"],
    };
    const result = resolveSuggestedQuestions({ suggestedQuestions: sq, fallbackLocale: "de" }, "de");
    expect(result).toEqual(["DE q1", "DE q2", "DE q3"]);
  });

  it("per-index merge: 2-question exact list does not collapse to 4-question fallback", () => {
    const sq: WidgetSuggestedQuestions = {
      en: ["EN q1", "EN q2", "EN q3", "EN q4"],
      de: ["DE q1", "DE q2", "DE q3", "DE q4"],
      fr: ["FR q1", "FR q2"],
    };
    const result = resolveSuggestedQuestions({ suggestedQuestions: sq, fallbackLocale: "de" }, "fr");
    expect(result).toEqual(["FR q1", "FR q2", "DE q3", "DE q4"]);
  });

  it("fallbackLocale used when exact missing", () => {
    const sq: WidgetSuggestedQuestions = {
      en: ["EN q1"],
      de: ["DE q1", "DE q2"],
    };
    const result = resolveSuggestedQuestions({ suggestedQuestions: sq, fallbackLocale: "de" }, "fr");
    expect(result).toEqual(["DE q1", "DE q2"]);
  });

  it("en used when exact and fallback missing", () => {
    const sq: WidgetSuggestedQuestions = {
      en: ["EN q1", "EN q2"],
    };
    const result = resolveSuggestedQuestions({ suggestedQuestions: sq, fallbackLocale: "de" }, "fr");
    expect(result).toEqual(["EN q1", "EN q2"]);
  });

  it("no tier has questions → []", () => {
    const sq: WidgetSuggestedQuestions = { en: [], de: [] };
    const result = resolveSuggestedQuestions({ suggestedQuestions: sq, fallbackLocale: "de" }, "fr");
    expect(result).toEqual([]);
  });

  it("fallbackLocale absent → defaults to en", () => {
    const sq: WidgetSuggestedQuestions = {
      en: ["EN q1"],
      de: ["DE q1"],
    };
    const result = resolveSuggestedQuestions({ suggestedQuestions: sq }, "fr");
    expect(result).toEqual(["EN q1"]);
  });
});
