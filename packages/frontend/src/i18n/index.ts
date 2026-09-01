// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en/translation.json";
import de from "./de/translation.json";
import es from "./es/translation.json";
import fr from "./fr/translation.json";
import it from "./it/translation.json";
import ru from "./ru/translation.json";
import zh from "./zh/translation.json";
import pt from "./pt/translation.json";

export const ALL_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "it", name: "Italiano" },
  { code: "ru", name: "Русский" },
  { code: "zh", name: "中文" },
  { code: "pt", name: "Português" },
] as const;

export type LanguageCode = (typeof ALL_LANGUAGES)[number]["code"];

const ENABLED_LANGUAGES_KEY = "enabled_languages";
const DEFAULT_ENABLED_LANGUAGES: LanguageCode[] = ["en", "de", "es", "fr", "it", "ru", "zh", "pt"];

export function getEnabledLanguages(): LanguageCode[] {
  try {
    const raw = localStorage.getItem(ENABLED_LANGUAGES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      const valid = parsed.filter((c): c is LanguageCode =>
        ALL_LANGUAGES.some((l) => l.code === c),
      );
      if (valid.length > 0) return valid;
    }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_ENABLED_LANGUAGES;
}

export function setEnabledLanguages(codes: LanguageCode[]): void {
  const valid = codes.filter((c) => ALL_LANGUAGES.some((l) => l.code === c));
  // Ensure at least one language remains enabled
  const final = valid.length > 0 ? valid : ["en"];
  localStorage.setItem(ENABLED_LANGUAGES_KEY, JSON.stringify(final));

  // If current language was disabled, switch to first enabled
  if (!final.includes(i18n.language as LanguageCode)) {
    i18n.changeLanguage(final[0]);
  }

  window.dispatchEvent(new CustomEvent("enabled-languages-changed"));
}

// Phase 180 dead-code sweep: the isLanguageEnabled() helper was REMOVED —
// zero callers (consumers filter getEnabledLanguages() directly).

const enabledLanguages = getEnabledLanguages();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
    es: { translation: es },
    fr: { translation: fr },
    it: { translation: it },
    ru: { translation: ru },
    zh: { translation: zh },
    pt: { translation: pt },
  },
  lng: localStorage.getItem("language") || "en",
  fallbackLng: "en",
  supportedLngs: enabledLanguages.length > 0 ? enabledLanguages : ["en"],
  interpolation: {
    escapeValue: false,
  },
});

// Persist language changes
i18n.on("languageChanged", (lng: string) => {
  localStorage.setItem("language", lng);
});

// Phase 180 dead-code sweep: the `export default i18n` was REMOVED — the
// module is consumed via side-effect imports (`import "./i18n"`); named
// exports (getEnabledLanguages / setEnabledLanguages / ALL_LANGUAGES) are
// the import surface.
