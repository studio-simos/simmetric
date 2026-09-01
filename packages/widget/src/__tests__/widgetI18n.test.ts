// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * widgetI18n.test.ts — D-03 option semantics pinned against the real
 * installed i18next 26.3.6, plus the singleton-isolation regression test
 * (RESEARCH Pitfall 2).
 *
 * Every test calls initWidgetI18n fresh — each call creates a new instance
 * via createInstance(), so there is no cross-test pollution.
 */
import i18next from "i18next";
import { initWidgetI18n, t } from "../widget/i18n";
import en from "../widget/i18n/en.json";
import de from "../widget/i18n/de.json";
import es from "../widget/i18n/es.json";
import fr from "../widget/i18n/fr.json";
import it from "../widget/i18n/it.json";
import ru from "../widget/i18n/ru.json";
import zh from "../widget/i18n/zh.json";
import pt from "../widget/i18n/pt.json";

describe("initWidgetI18n — D-03 option semantics (real i18next 26.3.6)", () => {
  test("(a) init with 'de' resolves to de and returns German values", () => {
    const inst = initWidgetI18n("de");
    expect(inst.resolvedLanguage).toBe("de");
    expect(t("chat.closeLabel")).toBe("Chat schließen");
  });

  test("(b) fallbackLng: zh key exists → zh value; fr returns French values", () => {
    const zhInst = initWidgetI18n("zh");
    expect(zhInst.resolvedLanguage).toBe("zh");
    expect(t("rateLimit.retryIn", { minutes: 5 })).toBe("请在 5 分钟后重试。");

    const frInst = initWidgetI18n("fr");
    expect(frInst.resolvedLanguage).toBe("fr");
    expect(t("chat.openLabel")).toBe("Ouvrir le chat");
  });

  test("(c) returnEmptyString:false — empty value falls through to fallback tier", () => {
    // Mutated resources passed DIRECTLY to a fresh createInstance().init —
    // the module resources are never mutated. The empty en value must fall
    // through to the non-empty de fallback tier (verified against real
    // 26.3.6: same-language fallback has no tier to fall to, so the fallback
    // language must differ).
    const mutated = { ...en, "chat.openLabel": "" };
    const inst = i18next.createInstance();
    inst.init({
      resources: { en: { translation: mutated }, de: { translation: de } },
      lng: "en",
      fallbackLng: "de",
      returnEmptyString: false,
      initAsync: false,
      load: "languageOnly",
      supportedLngs: ["en", "de"],
      nonExplicitSupportedLngs: true,
      interpolation: { escapeValue: false },
    });
    // Empty value must NOT blank the UI — falls through to the fallback tier
    // (the key's non-empty de value).
    expect(inst.t("chat.openLabel")).toBe("Chat öffnen");
  });

  test("(d) load:'languageOnly' + nonExplicitSupportedLngs — en-US resolves to en", () => {
    const inst = initWidgetI18n("en-US");
    expect(inst.resolvedLanguage).toBe("en");
    expect(t("chat.closeLabel")).toBe("Close chat");
  });

  test("(e) singleton isolation — second init returns French, never stale German; distinct instances", () => {
    const first = initWidgetI18n("de");
    expect(t("chat.closeLabel")).toBe("Chat schließen");

    const second = initWidgetI18n("fr");
    expect(t("chat.closeLabel")).toBe("Fermer le chat");
    expect(t("chat.openLabel")).toBe("Ouvrir le chat");

    // createInstance per call → distinct objects, no shared state.
    expect(second).not.toBe(first);
    expect(second.resolvedLanguage).toBe("fr");
  });

  test("(f) interpolation — {{count}} substituted", () => {
    initWidgetI18n("en");
    expect(t("rateLimit.messagesRemaining", { count: 3 })).toBe(
      "3 messages remaining this hour."
    );
  });

  test("(g) uninitialized safety — t returns the key itself before init", () => {
    // Fresh module boundary so the module-level instance slot is empty.
    jest.isolateModules(() => {
      const fresh = require("../widget/i18n") as typeof import("../widget/i18n");
      expect(fresh.t("chat.openLabel")).toBe("chat.openLabel");
    });
  });

  test("(h) welcome.piiNotice exists in all 8 locales (Plan 03 key extension)", () => {
    const locales = { en, de, es, fr, it, ru, zh, pt };
    for (const [locale, resources] of Object.entries(locales)) {
      // Array path form — the key contains a literal dot, which toHaveProperty
      // would otherwise treat as a nested-path separator.
      expect(resources).toHaveProperty(["welcome.piiNotice"]);
      expect((resources as Record<string, string>)["welcome.piiNotice"].trim().length).toBeGreaterThan(0);
      // No raw key leakage — the value must never equal the key itself.
      expect((resources as Record<string, string>)["welcome.piiNotice"]).not.toBe("welcome.piiNotice");
    }
  });

  test("(i) credits.poweredBy + credits.aiGenerated exist non-empty in all 8 locales (130-01, CRD-04)", () => {
    const locales = { en, de, es, fr, it, ru, zh, pt };
    for (const [locale, resources] of Object.entries(locales)) {
      for (const key of ["credits.poweredBy", "credits.aiGenerated"]) {
        expect(resources).toHaveProperty([key]);
        expect((resources as Record<string, string>)[key].trim().length).toBeGreaterThan(0);
        // No raw key leakage — the value must never equal the key itself.
        expect((resources as Record<string, string>)[key]).not.toBe(key);
      }
    }
  });

  test("(j) chatErrors.ragDegraded exists non-empty in all 8 locales (131-07, G-131-19)", () => {
    const locales = { en, de, es, fr, it, ru, zh, pt };
    for (const [locale, resources] of Object.entries(locales)) {
      expect(resources).toHaveProperty(["chatErrors.ragDegraded"]);
      expect((resources as Record<string, string>)["chatErrors.ragDegraded"].trim().length).toBeGreaterThan(0);
      // No raw key leakage — the value must never equal the key itself.
      expect((resources as Record<string, string>)["chatErrors.ragDegraded"]).not.toBe("chatErrors.ragDegraded");
    }
  });
});
