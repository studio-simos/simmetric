// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget i18n init module (D-03).
 *
 * Creates a FRESH i18next instance per call via `i18next.createInstance()`
 * (RESEARCH Pitfall 2: the module-level singleton silently ignores new
 * options on re-init in the same process — never use it here). The 8 locale
 * resources are statically imported so Vite bundles them into the IIFE
 * (air-gap safe, D-04 — no runtime fetch).
 *
 * No DOM access anywhere in this module (node-testable).
 */
import i18next, { type i18n } from "i18next";
import en from "./en.json";
import de from "./de.json";
import es from "./es.json";
import fr from "./fr.json";
import it from "./it.json";
import ru from "./ru.json";
import zh from "./zh.json";
import pt from "./pt.json";

/**
 * LOCAL literal mirror of the shared WIDGET_LOCALES — NOT a runtime import
 * from the shared package (repo pattern: type-only imports only, zero
 * runtime shared in the IIFE; shared-side parity is guarded by the shared
 * package's widgetLocalesParity tests).
 */
const WIDGET_LOCALES = ["en", "de", "es", "fr", "it", "ru", "zh", "pt"] as const;

const resources = {
  en: { translation: en },
  de: { translation: de },
  es: { translation: es },
  fr: { translation: fr },
  it: { translation: it },
  ru: { translation: ru },
  zh: { translation: zh },
  pt: { translation: pt },
} as const;

/** Module-level state slot for the `t` helper (set by initWidgetI18n). */
let instance: i18n | null = null;

/**
 * Initializes a fresh i18next instance for the given locale (server-resolved
 * from the JSON block — single source of truth per D-02/D-03) with the full
 * D-03 option set. Returns the instance; also stores it for the `t` helper.
 */
export function initWidgetI18n(locale: string): i18n {
  // createInstance() per call — a second init with different options must
  // never silently merge into the previous instance (Pitfall 2).
  const inst = i18next.createInstance();
  inst.init({
    resources,
    lng: locale,
    fallbackLng: "en",
    returnEmptyString: false,
    initAsync: false,
    load: "languageOnly",
    supportedLngs: WIDGET_LOCALES,
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
  });
  instance = inst;
  return inst;
}

/**
 * Translates a chrome-string key via the stored instance. Returns the key
 * itself when initWidgetI18n has not been called (safe for tests importing
 * modules that reference t at render time without an init).
 */
export function t(key: string, options?: Record<string, unknown>): string {
  if (!instance) return key;
  return instance.t(key, options);
}
