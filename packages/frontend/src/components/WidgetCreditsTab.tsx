// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import type { UseFormReturn } from "react-hook-form";
import { isHttpUrl } from "@simmetric-chat/shared";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import UpgradePrompt from "./UpgradePrompt";
import { useFeature } from "../hooks/useFeature";
import type { WidgetFormValues } from "./WidgetForm";

interface WidgetCreditsTabProps {
  form: UseFormReturn<WidgetFormValues>;
}

/**
 * Credits tab (D-05 / CRD-01 SC2): the enabled Switch, the label Input and
 * the URL Input — wired into the SHARED form instance via nested RHF dotted
 * paths (credits.enabled / credits.label / credits.url). Receives the shared
 * form; NEVER creates its own useForm.
 *
 * The field shapes mirror widgetCreditsSchema (widget.schema.ts:50-58) — the
 * strict blob the PUT payload must satisfy:
 * - label maxLength 200 mirrors max(200); the payload branch trims and the
 *   schema enforces min(1) (a partial blob 400s the ENTIRE PUT).
 * - url validation is a MANUAL check mirroring the shared refine EXACTLY:
 *   valid when empty or a real http(s) URL with a non-empty host — the
 *   shared isHttpUrl predicate (widget.schema.ts) imported from
 *   @simmetric-chat/shared, so the client and the server write gate can never
 *   diverge (WR-01 parity fix). NEVER z.string().url() semantics, which
 *   accepts javascript: (RESEARCH Pitfall 2). On violation FormMessage
 *   renders widgets.credits.urlInvalid and RHF blocks submit
 *   (T-130-07 defense-in-depth; the server schema stays the authoritative
 *   write gate).
 *
 * Quick 260826-hx5 (D-01): the enabled toggle + label/URL inputs are editable
 * ONLY when the `widget_credits_editing` feature flag is on. When the flag is
 * off, the whole tab renders an UpgradePrompt instead of a greyed-out form
 * (matches the white_label UpgradePrompt pattern in WidgetForm.tsx). The
 * server PUT route enforces the same gate inline (T-hx5-01) so the frontend
 * gate cannot be bypassed via the API.
 */
export default function WidgetCreditsTab({ form }: WidgetCreditsTabProps) {
  const { t } = useTranslation();
  const canEditCredits = useFeature("widget_credits_editing");

  if (!canEditCredits) {
    return (
      <UpgradePrompt
        feature="widget_credits_editing"
        message={t("widgets.credits.editingUpgradeMessage")}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Enabled toggle (A4 — always editable, hint carries the license copy) */}
      <section data-testid="credits-enabled" className="space-y-3">
        <FormField
          control={form.control}
          name="credits.enabled"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <FormLabel className="!mt-0">{t("widgets.credits.enabled")}</FormLabel>
            </FormItem>
          )}
        />
        <p className="text-xs text-muted-foreground">{t("widgets.credits.enabledHint")}</p>
      </section>

      {/* Label field — max 200 mirrors widgetCreditsSchema label max */}
      <section className="border-t border-border pt-6">
        <FormField
          control={form.control}
          name="credits.label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("widgets.credits.label")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  maxLength={200}
                  data-testid="credits-label"
                  placeholder={t("widgets.credits.labelPlaceholder")}
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">{t("widgets.credits.labelHint")}</p>
              <FormMessage />
            </FormItem>
          )}
        />
      </section>

      {/* URL field — client-side http/https validation mirroring the shared
          refine (T-130-07, WR-01): valid when empty or a real http(s) URL
          with a non-empty host. Uses the SHARED isHttpUrl predicate from
          @simmetric-chat/shared (widget.schema.ts) — the exact same check the
          server widgetCreditsSchema runs, so the admin form and the PUT
          gate can never diverge (the old /^https?:\/\// prefix regex
          accepted bare schemes like "http://" that the server rejects,
          400ing the ENTIRE PUT) */}
      <section className="border-t border-border pt-6">
        <FormField
          control={form.control}
          name="credits.url"
          rules={{
            validate: (value: string) => {
              const trimmed = value.trim();
              if (trimmed === "") return true; // empty stays valid (defaults fallback)
              return isHttpUrl(trimmed) ? true : t("widgets.credits.urlInvalid");
            },
          }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("widgets.credits.url")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  data-testid="credits-url"
                  placeholder={t("widgets.credits.urlPlaceholder")}
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">{t("widgets.credits.urlHint")}</p>
              <FormMessage />
            </FormItem>
          )}
        />
      </section>
    </div>
  );
}
