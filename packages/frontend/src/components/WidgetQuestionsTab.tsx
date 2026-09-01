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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { X } from "lucide-react";
import type { WidgetFormValues } from "./WidgetForm";

interface WidgetQuestionsTabProps {
  form: UseFormReturn<WidgetFormValues>;
}

/**
 * Questions tab (D-01 / D-02 / QST-01/QST-02): the tri-state mode control
 * (questionsMode radio: "default" | "none" | "custom") plus per-locale
 * question lists for all 7 locales, wired into the shared form instance via
 * nested RHF dotted paths (suggestedQuestions.<locale>).
 *
 * The locale set is FIXED at 7 (ALL_LANGUAGES — parity-guarded with
 * WIDGET_LOCALES by widgetLocalesParity.test.ts), so the fields are plain
 * nested record paths, not a dynamic array. The type mirrors the string-keyed
 * zod record (widgetSuggestedQuestionsSchema) exactly — NOT a fixed
 * Record<WidgetLocale, ...> (research Pitfall 3).
 *
 * Caps match widgetSuggestedQuestionsSchema (max 10 questions × 200 chars
 * each) — the server 400s on exceed, so the client caps input.
 *
 * Tri-state mapping (D-02): "default" → the PUT payload omits the field
 * entirely (blob stays null → client DEFAULT_CONFIG shows); "none" → {} (no
 * questions shown); "custom" → the filled record (may be {} → "none shown").
 * questionsMode is a FORM FIELD, not derived state (research Pattern 2).
 */
export default function WidgetQuestionsTab({ form }: WidgetQuestionsTabProps) {
  const { t } = useTranslation();

  const mode = form.watch("questionsMode");

  // The 3 client defaults (DEFAULT_CONFIG.suggestedQuestions,
  // packages/widget/src/widget/hooks/useWidgetConfig.ts:46-50). Hardcoded
  // here because the widget package is NOT importable from the frontend
  // (frontend imports only @simmetric-chat/shared) — research OQ2 resolution.
  const DEFAULT_QUESTIONS = [
    "What is this product?",
    "How does it work?",
    "What are the pricing plans?",
  ];

  const MODES = [
    { value: "default", labelKey: "widgets.questions.modeDefault", hintKey: "widgets.questions.modeDefaultHint" },
    { value: "none", labelKey: "widgets.questions.modeNone", hintKey: "widgets.questions.modeNoneHint" },
    { value: "custom", labelKey: "widgets.questions.modeCustom", hintKey: "widgets.questions.modeCustomHint" },
  ] as const;

  return (
    <div className="space-y-6">
      {/* Tri-state control (UI-SPEC Interaction Contract 1) — the FIRST
          control of the tab, the visual focal point. */}
      <FormField
        control={form.control}
        name="questionsMode"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("widgets.questions.modeLabel")}</FormLabel>
            <FormControl>
              <RadioGroup
                value={field.value}
                onValueChange={field.onChange}
                className="flex flex-col gap-2"
              >
                {MODES.map((m) => (
                  <div key={m.value} className="flex items-start gap-2">
                    <RadioGroupItem
                      value={m.value}
                      id={`qmode-${m.value}`}
                      className="mt-0.5"
                    />
                    <div className="flex flex-col gap-0.5">
                      <label htmlFor={`qmode-${m.value}`} className="text-sm font-semibold">
                        {t(m.labelKey)}
                      </label>
                      <p className="text-xs text-muted-foreground">{t(m.hintKey)}</p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      {/* Static helper line — always visible (UI-SPEC Copywriting Contract) */}
      <p className="text-xs text-muted-foreground">{t("widgets.questions.maxHint")}</p>

      {/* Mode-gated locale groups (UI-SPEC Interaction Contract 4/5) */}
      {mode === "default" && (
        <section
          data-testid="questions-default-static"
          className="border-t border-border pt-6 space-y-2"
        >
          <h4 className="text-sm font-semibold text-foreground mb-3">
            {t("widgets.questions.modeDefault")}
          </h4>
          {DEFAULT_QUESTIONS.map((q) => (
            <p key={q} className="text-sm text-foreground">
              {q}
            </p>
          ))}
        </section>
      )}

      {mode === "none" && (
        <section data-testid="questions-none-static" className="border-t border-border pt-6">
          <p className="text-sm text-muted-foreground">{t("widgets.questions.modeNoneHint")}</p>
        </section>
      )}

      {mode === "custom" && (
        <>
          {ALL_LANGUAGES.map((lang) => {
            const list = form.watch(`suggestedQuestions.${lang.code}`) ?? [];
            const addQuestion = () => {
              if (list.length >= 10) return;
              form.setValue(`suggestedQuestions.${lang.code}`, [...list, ""], { shouldDirty: true });
            };
            const removeQuestion = (index: number) => {
              form.setValue(
                `suggestedQuestions.${lang.code}`,
                list.filter((_, i) => i !== index),
                { shouldDirty: true }
              );
            };
            return (
              <section
                key={lang.code}
                data-testid={`locale-group-${lang.code}`}
                className="border-t border-border pt-6"
              >
                <h4 className="text-sm font-semibold text-foreground mb-3">{lang.name}</h4>
                {list.length === 0 ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {t("widgets.questions.emptyLocale")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addQuestion}
                    >
                      {t("widgets.questions.addQuestion")}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {list.map((q, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          maxLength={200}
                          placeholder={t("widgets.questions.questionPlaceholder")}
                          value={q}
                          onChange={(e) => {
                            const next = [...list];
                            next[i] = e.target.value;
                            form.setValue(`suggestedQuestions.${lang.code}`, next, { shouldDirty: true });
                          }}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={t("widgets.questions.removeQuestion")}
                          onClick={() => removeQuestion(i)}
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                    <div className="flex items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addQuestion}
                        disabled={list.length >= 10}
                      >
                        {t("widgets.questions.addQuestion")}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {t("widgets.questions.count", { count: list.length })}
                      </span>
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
