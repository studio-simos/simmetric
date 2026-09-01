// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import type { UseFormReturn } from "react-hook-form";
import { ALL_LANGUAGES } from "../i18n/index";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WidgetFormValues } from "./WidgetForm";

interface WidgetLocalizationTabProps {
  form: UseFormReturn<WidgetFormValues>;
}

/**
 * Localization tab (D-03 / I18N-01): the widget default language selector
 * (fallbackLocale, 7 locales from ALL_LANGUAGES) plus per-language chat texts
 * (welcomeMessage, fallbackMessage, placeholder, piiConsent, leadPrompt) for
 * all 7 locales, wired into the shared form instance via nested RHF dotted
 * paths (localizedTexts.<locale>.<field>).
 *
 * The locale set is FIXED at 7 (ALL_LANGUAGES — parity-guarded with
 * WIDGET_LOCALES by widgetLocalesParity.test.ts), so the fields are plain
 * nested record paths, not a dynamic array (research Pattern 4). The type
 * mirrors the string-keyed zod record (widgetLocalizedTextsSchema) exactly —
 * NOT a fixed Record<WidgetLocale, ...> (research Pitfall 3).
 *
 * maxLengths match widgetLocalizedTextsSchema maxes (1000/1000/200/500/500) —
 * the server 400s on exceed, so the client caps input.
 */
export default function WidgetLocalizationTab({ form }: WidgetLocalizationTabProps) {
  const { t } = useTranslation();

  const FIELDS = [
    { key: "welcomeMessage", maxLength: 1000 },
    { key: "fallbackMessage", maxLength: 1000 },
    { key: "placeholder", maxLength: 200 },
    { key: "piiConsent", maxLength: 500 },
    { key: "leadPrompt", maxLength: 500 },
  ] as const;

  return (
    <div className="space-y-6">
      {/* Default language selector (I18N-01) — display names reuse
          ALL_LANGUAGES[].name, zero new i18n keys (research Pitfall 5). */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">
          {t("widgets.localization.fallbackLocaleLabel")}
        </h4>
        <FormField
          control={form.control}
          name="fallbackLocale"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("widgets.localization.fallbackLocaleLabel")}</FormLabel>
              <FormControl>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </section>

      {/* Per-locale text groups — 7 locales × 5 fields on nested dotted paths */}
      {ALL_LANGUAGES.map((lang) => (
        <section
          key={lang.code}
          data-testid={`locale-group-${lang.code}`}
          className="border-t border-border pt-6"
        >
          <h4 className="text-sm font-semibold text-foreground mb-3">{lang.name}</h4>
          <div className="space-y-4">
            {FIELDS.map(({ key, maxLength }) => (
              <FormField
                key={key}
                control={form.control}
                name={`localizedTexts.${lang.code}.${key}`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(`widgets.localization.${key}`)}</FormLabel>
                    <FormControl>
                      <Textarea
                        maxLength={maxLength}
                        className="min-h-[60px] resize-y"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
