// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { showSuccess, showError } from "../lib/toast";
import { useSettingsHelpers } from "../queries/useSettings";
import { useFeature } from "../hooks/useFeature";
import type { Widget } from "@simmetric-chat/shared";
import {
  useCreateWidget,
  useUpdateWidget,
  useUpdateWidgetWorkspaces,
} from "../queries/useWidgets";
import UpgradePrompt from "./UpgradePrompt";
import WidgetWorkspaceSelector from "./WidgetWorkspaceSelector";
import { useArchives } from "../queries/useArchives";
import { useAvailableModels } from "../queries/useProviders";
import WidgetPreviewPane from "./WidgetPreviewPane";
import WidgetLocalizationTab from "./WidgetLocalizationTab";
import WidgetLeadsTab from "./WidgetLeadsTab";
import WidgetQuestionsTab from "./WidgetQuestionsTab";
import WidgetCreditsTab from "./WidgetCreditsTab";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "../utils/errorUtils";
import { resolveWidgetServiceUrl } from "../utils/widgetServiceUrl";
import { buildWidgetSnippet } from "../utils/widgetSnippet";

const WIDGET_TABS = ["settings", "localization", "questions", "credits", "leads"] as const;
export type WidgetTab = (typeof WIDGET_TABS)[number];

interface WidgetFormProps {
  widget?: Widget | null;
  tab: WidgetTab;
  onTabChange: (tab: WidgetTab) => void;
  onSave: (createdId?: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Safely parse a JSON string, returning null on failure */
function safeJsonParse(value: string): string[] | null {
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Parse the autoOpenUrlPatterns wire value into `string[] | null`.
 *
 * The server stores/returns the field as a RAW JSON-encoded string (DB
 * String?, widget.schema.ts:311-313 — the widget client JSON.parses it
 * itself), so the admin form must handle both shapes defensively:
 *  - null/undefined → null (never configured)
 *  - string[]       → as-is (future/typed callers)
 *  - string         → safeJsonParse of the raw JSON string (malformed →
 *                     null, never a render-time throw — G-151-1c)
 * Mirrors the allowedOrigins dual-shape seeding (G-151-1c root cause).
 */
function parsePatternList(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return safeJsonParse(value);
  return null;
}

export interface WidgetFormValues {
  name: string;
  position: "bottom-right" | "bottom-left";
  isActive: boolean;
  welcomeMessage: string;
  fallbackMessage: string;
  primaryColor: string;
  botName: string;
  logoUrl: string;
  avatarUrl: string;
  autoOpenByUrlEnabled: boolean;
  autoOpenUrlPatterns: string;
  autoOpenByTimeEnabled: boolean;
  autoOpenDelay: string;
  exitIntentEnabled: boolean;
  exitIntentCooldownMin: string;
  leadCaptureEnabled: boolean;
  leadCapturePrompt: string;
  allowedOrigins: string;
  // 151-02 (G-151-1b): per-widget daily MESSAGE limit ("" = unset → global
  // default of 5 messages/day prod / 50/day dev). String field (RHF numeric
  // inputs hold strings; the payload branch converts).
  sessionLimitPerDay: string;
  // Localization (D-03 / I18N-01): the widget default language + per-locale
  // chat texts. localizedTexts mirrors the string-keyed zod record
  // (widgetLocalizedTextsSchema) exactly — NOT a fixed Record<WidgetLocale, ...>
  // (research Pitfall 3: the server schema is string-keyed with a superRefine
  // whitelist; a fixed-keys type would reject valid writes / allow rejected keys).
  fallbackLocale: string;
  localizedTexts: Record<string, {
    welcomeMessage?: string;
    fallbackMessage?: string;
    placeholder?: string;
    piiConsent?: string;
    leadPrompt?: string;
  }>;
  // Questions tri-state (D-01/D-02, 129-01): questionsMode is a FORM FIELD,
  // not derived state (research Pattern 2) — "default" (omit) and "none" ({})
  // serialize differently from the same empty record, so the mode must
  // survive as a distinct value. suggestedQuestions mirrors the string-keyed
  // zod record (widgetSuggestedQuestionsSchema) exactly — NOT a fixed
  // Record<WidgetLocale, ...> (research Pitfall 3: the server schema is
  // string-keyed with a superRefine whitelist; a fixed-keys type would reject
  // valid writes / allow rejected keys).
  questionsMode: "default" | "none" | "custom";
  suggestedQuestions: Record<string, string[] | undefined>;
  // Credits blob (D-05): mirrors widgetCreditsSchema (widget.schema.ts:50-58) —
  // the strict blob shape { enabled, label, url }. The form ALWAYS carries all
  // three fields (RHF has no tri-state; the payload branch below decides
  // full-blob-or-null on save).
  credits: { enabled: boolean; label: string; url: string; };
  // 260809-uxk T4: bound knowledge archive id ("" = none/unbound; the payload
  // branch sends null for "" per the nullable schema contract).
  archiveId: string;
  // 260831-hgy: per-widget response model pin — ONE composite form value
  // "${providerId}::${model}" (a single AvailableModel entry carries both
  // server values: provider UUID + model NAME). "" = not configured → the
  // payload branch sends null for BOTH fields (clears the pin).
  responseModelSelect: string;
}

export default function WidgetForm({ widget, tab, onTabChange, onSave, onDirtyChange }: WidgetFormProps) {
  const { t } = useTranslation();
  const createWidget = useCreateWidget();
  const updateWidget = useUpdateWidget();
  const updateWorkspaces = useUpdateWidgetWorkspaces();
  const { getValue } = useSettingsHelpers();
  const canWhiteLabel = useFeature("white_label");
  // 260809-uxk T4: global archive list (archives are not workspace-scoped —
  // the same list RightPanel uses). Feeds the Knowledge Archive selector.
  const { data: archives = [] } = useArchives();
  // 260831-hgy: available models for the per-widget response model pin
  // (GET /api/providers/models/available flattened by the existing hook —
  // one entry carries both values the server needs: provider UUID + model
  // name). Mirrors the useArchives() pattern above.
  const { data: availableModels = [] } = useAvailableModels();

  // widgetServiceUrl resolution — same-origin by default (the widget is served
  // behind the app origin via reverse proxy); NEVER derived from SERVER_URL
  // (docker-internal hostname → mixed content / unreachable embed, G-151-1a/1b).
  const widgetServiceUrl = resolveWidgetServiceUrl(
    getValue("WIDGET_SERVICE_URL") || "",
    window.location.origin
  );

  const isEdit = !!widget;
  const firstInputRef = useRef<HTMLInputElement>(null);

  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>(
    widget?.workspaces?.map((w) => w.workspaceId) || []
  );
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const form = useForm<WidgetFormValues>({
    defaultValues: {
      name: widget?.name || "",
      position: widget?.position || "bottom-right",
      isActive: widget?.isActive ?? true,
      welcomeMessage: widget?.welcomeMessage || "",
      fallbackMessage: widget?.fallbackMessage || "",
      primaryColor: widget?.primaryColor || "#4c6ef5",
      botName: widget?.botName || "",
      logoUrl: widget?.logoUrl || "",
      avatarUrl: widget?.avatarUrl || "",
      // 151-03 (G-151-1c): autoOpenUrlPatterns arrives as a RAW JSON-encoded
      // string on the wire (server passes the DB column through unparsed);
      // parsePatternList handles both shapes — null → empty list, malformed
      // string → null → empty list (never a render-time throw). The toggle
      // derives from the PARSED list so an empty-array string "[]" stays OFF.
      autoOpenByUrlEnabled: !!parsePatternList(widget?.autoOpenUrlPatterns)?.length,
      autoOpenUrlPatterns: parsePatternList(widget?.autoOpenUrlPatterns)?.join(", ") || "",
      autoOpenByTimeEnabled: widget?.autoOpenDelay != null,
      autoOpenDelay: widget?.autoOpenDelay?.toString() || "",
      exitIntentEnabled: widget?.exitIntentEnabled ?? false,
      exitIntentCooldownMin: widget?.exitIntentCooldownMs ? String(Math.round(widget.exitIntentCooldownMs / 60000)) : "30",
      leadCaptureEnabled: widget?.leadCaptureEnabled ?? false,
      leadCapturePrompt: widget?.leadCapturePrompt || "",
      sessionLimitPerDay: widget?.sessionLimitPerDay?.toString() || "",
      allowedOrigins: Array.isArray(widget?.allowedOrigins)
        ? widget.allowedOrigins.join("\n")
        : (typeof widget?.allowedOrigins === "string" ? safeJsonParse(widget.allowedOrigins)?.join("\n") || "" : ""),
      // Localization seeding (D-06 fields now typed on Widget): the blob loads
      // as-is; fallbackLocale defaults to "en" when unset.
      fallbackLocale: widget?.fallbackLocale || "en",
      localizedTexts: widget?.localizedTexts ?? {},
      // Questions tri-state seeding (129-01, research Pitfall 6 — the `?? {}`
      // guard is REQUIRED or null throws): null → "default" (not configured →
      // client defaults), empty record → "none" (admin disabled), else →
      // "custom". suggestedQuestions seeds the 7 locale groups for 129-02.
      questionsMode: widget?.suggestedQuestions == null ? "default" : Object.keys(widget.suggestedQuestions).length === 0 ? "none" : "custom",
      suggestedQuestions: widget?.suggestedQuestions ?? {},
      // Credits seeding (D-05): the `?? { enabled: true, label: "", url: "" }`
      // guard is REQUIRED — widget.credits is null for never-configured
      // widgets, and seeding null would throw on the nested FormField paths.
      credits: widget?.credits ?? { enabled: true, label: "", url: "" },
      // 260809-uxk T4: archive binding seeds from the widget row ("" = none).
      archiveId: widget?.archiveId || "",
      // 260831-hgy: response model pin seeds the composite from the widget
      // row ("" = not configured). Both fields must be set for a valid pin —
      // a half-set legacy row seeds "" (normalizes to cleared on save).
      responseModelSelect: widget?.responseProviderId && widget?.responseModel
        ? `${widget.responseProviderId}::${widget.responseModel}`
        : "",
    },
  });

  // Focus first input on mount
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  // Loose watch for fields that land in later plans (128-03 adds
  // fallbackLocale to WidgetFormValues) — typed as unknown until then.
  const watchAny = (name: string) => form.watch(name as never);

  // Dirty-guard contract: report form dirtiness to the page (D-02).
  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);

  const handleSubmit = form.handleSubmit(async (data) => {
    if (!data.name.trim()) {
      showError(t("settings.widget.nameLabel") + " is required");
      return;
    }

    setSaving(true);
    try {
      const formData: Record<string, unknown> = {
        name: data.name.trim(),
        position: data.position,
      };

      // Legacy fallback-tier texts (D-06): only send when non-empty — the
      // shared schema declares them z.string().optional() (NOT nullable), so
      // a null for an empty textarea 400s the ENTIRE PUT and the
      // localizedTexts blob + fallbackLocale never reach Prisma (G-128-3).
      if (data.welcomeMessage.trim()) {
        formData.welcomeMessage = data.welcomeMessage.trim();
      }
      if (data.fallbackMessage.trim()) {
        formData.fallbackMessage = data.fallbackMessage.trim();
      }

      if (isEdit) {
        formData.isActive = data.isActive;
      }

      // Branding fields (only send if white_label is enabled). Empty
      // botName/logoUrl/avatarUrl are OMITTED, never sent as null — the
      // schema rejects botName null (z.string().max(100).optional(),
      // widget.schema.ts:196) and the form must not send values the shared
      // schema refuses (G-128-3).
      if (canWhiteLabel) {
        formData.primaryColor = data.primaryColor;
        if (data.botName.trim()) formData.botName = data.botName.trim();
        if (data.logoUrl.trim()) formData.logoUrl = data.logoUrl.trim();
        if (data.avatarUrl.trim()) formData.avatarUrl = data.avatarUrl.trim();
      }

      // Display triggers
      // autoOpenUrlPatterns is stored as a JSON-encoded string of string[]
      // (schema z.string(), widget.schema.ts:213 — the widget client
      // JSON.parses it back). When the toggle is off the field is omitted
      // entirely rather than sending an array or null (G-128-3).
      if (data.autoOpenByUrlEnabled) {
        formData.autoOpenUrlPatterns = JSON.stringify(
          data.autoOpenUrlPatterns.split(",").map((p: string) => p.trim()).filter(Boolean)
        );
      }
      formData.autoOpenDelay = data.autoOpenByTimeEnabled ? parseInt(data.autoOpenDelay, 10) || null : null;
      formData.exitIntentEnabled = data.exitIntentEnabled;
      formData.exitIntentCooldownMs = data.exitIntentEnabled ? parseInt(data.exitIntentCooldownMin, 10) * 60000 : 1800000;

      // Lead capture
      formData.leadCaptureEnabled = data.leadCaptureEnabled;
      formData.leadCapturePrompt = data.leadCaptureEnabled ? (data.leadCapturePrompt.trim() || null) : null;

      // 151-02 (G-151-1b): per-widget daily MESSAGE limit — empty → null
      // (global default); positive int otherwise. Nullable write contract.
      const sessionLimit = parseInt(data.sessionLimitPerDay, 10);
      formData.sessionLimitPerDay = data.sessionLimitPerDay.trim() && sessionLimit > 0 ? sessionLimit : null;

      // CORS allowed origins (converts newline-separated string to JSON-encoded array)
      formData.allowedOrigins = data.allowedOrigins.trim()
        ? JSON.stringify(data.allowedOrigins.split("\n").map((o: string) => o.trim()).filter(Boolean))
        : null;

      // Localization (D-03 / I18N-01): the default language + the per-locale
      // texts blob. forceMount registers ALL 35 nested fields, so the record
      // always carries every locale — filter to locales with at least one
      // filled field (trimmed), and drop empty fields within a locale. An
      // all-empty blob → null clears it server-side (research Pattern 4;
      // toJsonWriteValue handles the Prisma.DbNull translation, Phase 125).
      // The legacy welcomeMessage/fallbackMessage scalars above KEEP saving —
      // they remain the fallback tier (D-06, resolveWidgetTexts consults them
      // after the blob tier).
      formData.fallbackLocale = data.fallbackLocale;
      const localizedTexts: Record<string, Record<string, string>> = {};
      for (const [locale, fields] of Object.entries(data.localizedTexts ?? {})) {
        const filled: Record<string, string> = {};
        for (const [field, value] of Object.entries(fields ?? {})) {
          if (typeof value === "string" && value.trim()) filled[field] = value.trim();
        }
        if (Object.keys(filled).length > 0) localizedTexts[locale] = filled;
      }
      formData.localizedTexts = Object.keys(localizedTexts).length > 0 ? localizedTexts : null;

      // Questions tri-state payload (D-02, 129-01): branch on data.questionsMode.
      // CRITICAL: do NOT copy the localization null-when-empty branch above —
      // questions sends {} when all-empty, never null (research Anti-Pattern:
      // null means "not configured → client defaults", sending null would
      // resurrect defaults — the exact QST-01 SC1 failure).
      if (data.questionsMode === "none") {
        // Empty record → every locale resolves [] → nothing shows; defaults
        // never resurrect (Phase 125 OQ1 pin).
        formData.suggestedQuestions = {};
      } else if (data.questionsMode === "custom") {
        // Filled record — only locales with ≥1 trimmed non-empty question are
        // emitted; empty rows within a locale are dropped (mirrors the
        // localizedTexts filter above). May be {} → "none shown" (QST-01 SC1).
        const suggestedQuestions: Record<string, string[]> = {};
        for (const [locale, list] of Object.entries(data.suggestedQuestions ?? {})) {
          const filled = (list ?? []).map((q) => q.trim()).filter(Boolean);
          if (filled.length > 0) suggestedQuestions[locale] = filled;
        }
        formData.suggestedQuestions = suggestedQuestions;
      } else if (data.questionsMode === "default") {
        // "default" → the blob must stay/return to SQL NULL ("client
        // defaults"). Omit for never-configured widgets (G-128-3), but
        // null-clear when a record exists so the radio choice actually
        // persists (WR-01): the server's updateWidgetSchema accepts
        // .nullable() and toJsonWriteValue(null) → Prisma.DbNull, so the
        // reload re-seeds "default" and the client DEFAULT_CONFIG shows.
        // OR-form-check (WR-02, 129-REVIEW): the null-clear fires when the
        // widget has a non-null blob (prop, refreshed by the useWidgets()
        // refetch after save) OR the form still holds a non-empty record
        // from a just-left "custom" mode — the form half closes the
        // refetch-window race where the prop lags the server state on a
        // fast double-save. The prop half is KEPT because the none→default
        // transition carries {} in the form (Object.keys({}).length === 0)
        // and must still null-clear when the prop is fresh — a
        // form-value-only check would silently regress it. Never-configured
        // widgets (null prop + {} form values) keep omit-only: neither
        // half fires.
        if (
          widget?.suggestedQuestions != null ||
          Object.keys(data.suggestedQuestions ?? {}).length > 0
        ) {
          formData.suggestedQuestions = null;
        }
      }

      // Credits blob (D-05, WR-02): three branches. (1) enabled === false →
      // ALWAYS persist the blob (empty label/url allowed per the widened
      // widgetCreditsSchema) — never null-clear, or the toggle silently
      // no-ops: shouldShowCredits(whiteLabel=true, {enabled:false,...}) → false
      // only when the blob is persisted (D-06/WR-02). (2) enabled:true with
      // BOTH label and url non-empty (trimmed) → the full valid blob — the
      // strict schema rejects a partial blob (label min(1) fails on "", the
      // http/https refine fails on ""), so a mixed fill null-clears → client
      // defaults show (D-02). Credits has NO tri-state — do NOT copy the
      // questions {} branch above (research Anti-Pattern: a partial blob 400s
      // the ENTIRE PUT via the strict widgetCreditsSchema; {} would also fail
      // label min(1)).
      if (data.credits && data.credits.enabled === false) {
        // D-06/WR-02: enabled:false must actually hide credits — persist the
        // blob (empty label/url allowed per the widened schema) so
        // shouldShowCredits(whiteLabel=true, {enabled:false,...}) → false.
        // Never null-clear.
        formData.credits = {
          enabled: false,
          label: data.credits.label.trim(),
          url: data.credits.url.trim(),
        };
      } else if (data.credits && data.credits.label.trim() && data.credits.url.trim()) {
        formData.credits = {
          enabled: data.credits.enabled,
          label: data.credits.label.trim(),
          url: data.credits.url.trim(),
        };
      } else {
        formData.credits = null; // enabled:true with empty label/url → defaults (unchanged)
      }

      // 260809-uxk T4: bound knowledge archive (nullable schema contract —
      // null clears the binding; the server spread writes SQL NULL). "" from
      // the "none" option → null.
      formData.archiveId = data.archiveId || null;

      // 260831-hgy: per-widget response model pin (nullable schema contract —
      // null clears BOTH columns; "" from the "Workspace default" option →
      // null/null). Split on the FIRST "::" — provider UUIDs never contain
      // it, model names can (a half-set legacy row normalizes to cleared:
      // either side empty → both null).
      const sep = data.responseModelSelect.indexOf("::");
      const pId = sep === -1 ? "" : data.responseModelSelect.slice(0, sep);
      const mName = sep === -1 ? "" : data.responseModelSelect.slice(sep + 2);
      formData.responseProviderId = pId || null;
      formData.responseModel = mName || null;

      let createdId: string | undefined;
      if (isEdit && widget) {
        await updateWidget.mutateAsync({ id: widget.id, data: formData });
        await updateWorkspaces.mutateAsync({ widgetId: widget.id, workspaceIds: selectedWorkspaceIds });
        showSuccess(t("settings.widget.updateSuccess"));
      } else {
        const created = await createWidget.mutateAsync(formData);
        createdId = created.id;
        if (selectedWorkspaceIds.length > 0) {
          await updateWorkspaces.mutateAsync({ widgetId: created.id, workspaceIds: selectedWorkspaceIds });
        }
        showSuccess(t("settings.widget.createSuccess"));
      }

      // Reset dirty state on save-success only (research Anti-Pattern:
      // defaultValues are read once at mount — never reset on refetch).
      form.reset(form.getValues());

      onSave(createdId);
    } catch (err: unknown) {
      showError(getErrorMessage(err, isEdit ? t("settings.widget.updateFailed") : t("settings.widget.createFailed")));
    } finally {
      setSaving(false);
    }
  });

  const handleCopySnippet = () => {
    if (!widget) return;
    // Quick 260826-p0d (D-04): copy the DYNAMIC snippet reflecting live form
    // values, not the old static template. form.getValues(...) is the
    // canonical read in event callbacks (react-hook-form docs — form.watch in
    // a callback returns the current value but getValues is idiomatic for
    // event handlers).
    const snippet = buildWidgetSnippet(widget.id, widgetServiceUrl, {
      autoOpenByTimeEnabled: form.getValues("autoOpenByTimeEnabled"),
      autoOpenDelay: form.getValues("autoOpenDelay"),
      autoOpenByUrlEnabled: form.getValues("autoOpenByUrlEnabled"),
      autoOpenUrlPatterns: form.getValues("autoOpenUrlPatterns"),
      exitIntentEnabled: form.getValues("exitIntentEnabled"),
    });
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      showError(t("settings.widget.copyFailed"));
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">
          {isEdit ? t("common.edit") : t("settings.widget.createButton")}
        </h3>
      </div>

      {/* Body */}
      <Form {...form}>
        <form onSubmit={handleSubmit} noValidate className="space-y-6">
          {/* Tabs-in-form (OQ2 final — D-02): ONE useForm instance wraps ALL
              five panels; the Tabs live inside the <form> so every tab shares
              the single instance. forceMount keeps all panels mounted; the
              hidden class is REQUIRED because forceMount renders every panel
              visible (research Pattern 2). Create mode renders the Tabs
              unconditionally (supersedes 128-01's plain-form-page spec) with
              the leads panel disabled (no widget id yet). */}
          <Tabs value={tab} onValueChange={(next) => onTabChange(next as WidgetTab)}>
            <TabsList className="mb-4">
              <TabsTrigger value="settings">{t("widgets.tabs.settings")}</TabsTrigger>
              <TabsTrigger value="localization">{t("widgets.tabs.localization")}</TabsTrigger>
              <TabsTrigger value="questions">{t("widgets.tabs.questions")}</TabsTrigger>
              <TabsTrigger value="credits">{t("widgets.tabs.credits")}</TabsTrigger>
              <TabsTrigger value="leads">{t("widgets.tabs.leads")}</TabsTrigger>
            </TabsList>

            <TabsContent value="settings" forceMount className={cn(tab !== "settings" && "hidden")}>
            {/* Core fields section */}
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => {
                  const { ref: _fieldRef, ...fieldRest } = field;
                  return (
                    <FormItem>
                      <FormLabel>{t("settings.widget.nameLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          ref={firstInputRef}
                          type="text"
                          placeholder={t("settings.widget.namePlaceholder")}
                          {...fieldRest}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />

              <FormField
                control={form.control}
                name="position"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings.widget.positionLabel")}</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value}
                        onValueChange={(value) => field.onChange(value)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="bottom-right">{t("settings.widget.positionBottomRight")}</SelectItem>
                          <SelectItem value="bottom-left">{t("settings.widget.positionBottomLeft")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {isEdit && (
                <FormField
                  control={form.control}
                  name="isActive"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="!mt-0">
                        {field.value ? t("settings.widget.activeBadge") : t("settings.widget.inactiveBadge")}
                      </FormLabel>
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="welcomeMessage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings.widget.welcomeMessageLabel")}</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder={t("settings.widget.welcomeMessagePlaceholder")}
                        className="min-h-[80px] resize-y"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="fallbackMessage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings.widget.fallbackMessageLabel")}</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder={t("settings.widget.fallbackMessagePlaceholder")}
                        className="min-h-[80px] resize-y"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Knowledge Workspaces section */}
            <div className="border-t border-border pt-6">
              <WidgetWorkspaceSelector
                selectedIds={selectedWorkspaceIds}
                onChange={setSelectedWorkspaceIds}
              />
            </div>

            {/* 260809-uxk T4: Knowledge Archive section — binds a global
                archive for widget chat (D-08 wiki_query). "" = no archive
                (general knowledge only). */}
            <div className="border-t border-border pt-6">
              <FormField
                control={form.control}
                name="archiveId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings.widget.archiveLabel")}</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value}
                        onValueChange={(value) => field.onChange(value)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t("settings.widget.archivePlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">{t("settings.widget.archiveNone")}</SelectItem>
                          {archives.map((archive) => (
                            <SelectItem key={archive.id} value={archive.id}>
                              {archive.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* 260831-hgy: Response Model section — per-widget LLM pin.
                Composite value "${providerId}::${model}"; "" = workspace
                default (pin cleared). Options grouped by provider (mirrors
                ModelSelector's grouping); stale stored selections render an
                extra "unavailable" item so the admin can see/replace/clear
                them (never a render-time throw). */}
            <div className="border-t border-border pt-6">
              <FormField
                control={form.control}
                name="responseModelSelect"
                render={({ field }) => {
                  // Stale-selection guard: the seeded composite (provider
                  // deleted / model renamed) is NOT among availableModels →
                  // render it as an extra item so the trigger never renders
                  // empty and the admin can see and replace/clear it.
                  const storedComposite = widget?.responseProviderId && widget?.responseModel
                    ? `${widget.responseProviderId}::${widget.responseModel}`
                    : "";
                  const isStale =
                    !!storedComposite &&
                    !availableModels.some(
                      (m) => `${m.providerId}::${m.name}` === storedComposite
                    );
                  // Group by providerName (Map preserves insertion order).
                  const byProvider = new Map<string, typeof availableModels>();
                  for (const m of availableModels) {
                    const list = byProvider.get(m.providerName) ?? [];
                    list.push(m);
                    byProvider.set(m.providerName, list);
                  }
                  return (
                    <FormItem>
                      <FormLabel>{t("settings.widget.responseModelLabel")}</FormLabel>
                      <FormControl>
                        <Select
                          value={field.value}
                          onValueChange={(value) => field.onChange(value)}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t("settings.widget.responseModelPlaceholder")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">{t("settings.widget.responseModelDefault")}</SelectItem>
                            {isStale && storedComposite && (
                              <SelectItem value={storedComposite}>
                                {widget?.responseModel} ({t("settings.widget.responseModelUnavailable")})
                              </SelectItem>
                            )}
                            {Array.from(byProvider.entries()).map(([providerName, models]) => (
                              <SelectGroup key={providerName}>
                                <SelectLabel>{providerName}</SelectLabel>
                                {models.map((m) => (
                                  <SelectItem key={`${m.providerId}::${m.name}`} value={`${m.providerId}::${m.name}`}>
                                    {m.displayName || m.name}
                                    {m.isLocal ? " · Local" : " · Cloud"}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            </div>

            {/* Branding section */}
            <div className="border-t border-border pt-6">
              <h4 className="text-sm font-semibold text-foreground mb-3">
                {t("settings.widget.brandingSection")}
              </h4>
              {canWhiteLabel ? (
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="primaryColor"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("settings.widget.primaryColorLabel")}</FormLabel>
                        <div className="flex gap-3 items-center">
                          <Input
                            type="color"
                            {...field}
                            className="w-10 h-10 rounded border border-input cursor-pointer bg-card p-1"
                          />
                          <Input
                            type="text"
                            {...field}
                            className="flex-1 border border-input rounded px-3 py-2 text-sm bg-card text-foreground font-mono"
                            placeholder="#4c6ef5"
                          />
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="botName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("settings.widget.botNameLabel")}</FormLabel>
                        <FormControl>
                          <Input
                            type="text"
                            placeholder={t("settings.widget.botNamePlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="logoUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("settings.widget.logoUrlLabel")}</FormLabel>
                        <FormControl>
                          <Input
                            type="url"
                            placeholder={t("settings.widget.logoUrlPlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="avatarUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("settings.widget.avatarUrlLabel")}</FormLabel>
                        <FormControl>
                          <Input
                            type="url"
                            placeholder={t("settings.widget.avatarUrlPlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Live Preview (D-05, ADM-02): real iframe to the widget
                      service with debounced query overrides; placeholder in
                      create mode (no widget id yet). */}
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      {t("settings.widget.previewLabel")}
                    </label>
                    <WidgetPreviewPane
                      widgetId={widget?.id ?? null}
                      primaryColor={form.watch("primaryColor") || undefined}
                      position={form.watch("position")}
                      // fallbackLocale lands in 128-03 — until then the pane
                      // omits the locale param (Pitfall 3: absent is absent).
                      locale={(watchAny("fallbackLocale") as unknown as string | undefined) || undefined}
                      // Quick 260826-hx5 (D-02): forward the live autoOpenDelay
                      // form value so the preview auto-opens after the
                      // configured delay without waiting for the iframe's
                      // config fetch. Toggle off → undefined → param omitted
                      // (loader falls back to DB config, null for unsaved).
                      autoOpenDelay={
                        form.watch("autoOpenByTimeEnabled")
                          ? form.watch("autoOpenDelay") || undefined
                          : undefined
                      }
                    />
                  </div>
                </div>
              ) : (
                <UpgradePrompt
                  feature="white_label"
                  message={t("settings.widget.brandingUpgrade")}
                />
              )}
            </div>

            {/* Display Triggers section */}
            {isEdit && (
              <div className="border-t border-border pt-6">
                <h4 className="text-sm font-semibold text-foreground mb-3">
                  {t("settings.widget.displayTriggersSection")}
                </h4>
                <div className="space-y-4">
                  {/* Auto-open by URL */}
                  <FormField
                    control={form.control}
                    name="autoOpenByUrlEnabled"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                            {t("settings.widget.autoOpenByUrl")}
                          </label>
                        </FormControl>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("settings.widget.autoOpenByUrlHint")}
                        </p>
                      </FormItem>
                    )}
                  />
                  {form.watch("autoOpenByUrlEnabled") && (
                    <FormField
                      control={form.control}
                      name="autoOpenUrlPatterns"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.widget.urlPatternsLabel")}</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder={t("settings.widget.urlPatternsPlaceholder")}
                              className="min-h-[60px] resize-y"
                              {...field}
                            />
                          </FormControl>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t("settings.widget.urlPatternsHelp")}
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {/* Auto-open by time */}
                  <FormField
                    control={form.control}
                    name="autoOpenByTimeEnabled"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                            {t("settings.widget.autoOpenByTime")}
                          </label>
                        </FormControl>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("settings.widget.autoOpenByTimeHint")}
                        </p>
                      </FormItem>
                    )}
                  />
                  {form.watch("autoOpenByTimeEnabled") && (
                    <FormField
                      control={form.control}
                      name="autoOpenDelay"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.widget.autoOpenDelayLabel")}</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min={1}
                              max={300}
                              placeholder={t("settings.widget.autoOpenDelayPlaceholder")}
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {/* Exit intent */}
                  <FormField
                    control={form.control}
                    name="exitIntentEnabled"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                            {t("settings.widget.exitIntentToggle")}
                          </label>
                        </FormControl>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("settings.widget.exitIntentToggleHint")}
                        </p>
                      </FormItem>
                    )}
                  />
                  {form.watch("exitIntentEnabled") && (
                    <FormField
                      control={form.control}
                      name="exitIntentCooldownMin"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.widget.exitIntentCooldownLabel")}</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min={1}
                              max={1440}
                              placeholder={t("settings.widget.exitIntentCooldownPlaceholder")}
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Limits section (151-02, G-151-1b): per-widget daily MESSAGE
                limit — enforced by the widget service on the send path
                (widgetDailyMessageLimiter, 24h per-visitor window). Empty =
                global default (5 messages/day prod, 50/day dev). */}
            {isEdit && (
              <div className="border-t border-border pt-6">
                <h4 className="text-sm font-semibold text-foreground mb-3">
                  {t("settings.widget.limitsSection")}
                </h4>
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="sessionLimitPerDay"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("settings.widget.sessionLimitPerDay")}</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            placeholder={t("settings.widget.sessionLimitPerDayPlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("settings.widget.sessionLimitPerDayHint")}
                        </p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            )}

            {/* Lead Capture section */}
            {isEdit && (
              <div className="border-t border-border pt-6">
                <h4 className="text-sm font-semibold text-foreground mb-3">
                  {t("settings.widget.leadCaptureSection")}
                </h4>
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="leadCaptureEnabled"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                            {t("settings.widget.leadCaptureToggle")}
                          </label>
                        </FormControl>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("settings.widget.leadCaptureToggleHint")}
                        </p>
                      </FormItem>
                    )}
                  />
                  {form.watch("leadCaptureEnabled") && (
                    <FormField
                      control={form.control}
                      name="leadCapturePrompt"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.widget.leadCapturePromptLabel")}</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder={t("settings.widget.leadCapturePromptPlaceholder")}
                              className="min-h-[60px] resize-y"
                              maxLength={500}
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </div>
              </div>
            )}

            {/* CORS Allowed Origins (edit mode only) */}
            {isEdit && (
              <div className="border-t border-border pt-6">
                <h4 className="text-sm font-semibold text-foreground mb-3">
                  {t("settings.widget.allowedOriginsLabel")}
                </h4>
                <p className="text-xs text-muted-foreground mb-3">
                  {t("settings.widget.allowedOriginsHint")}
                </p>
                <FormField
                  control={form.control}
                  name="allowedOrigins"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          placeholder={t("settings.widget.allowedOriginsPlaceholder")}
                          className="min-h-[60px] resize-y font-mono text-xs"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {/* Embed Snippet (edit mode only) */}
            {isEdit && widget && (
              <div className="border-t border-border pt-6">
                <h4 className="text-sm font-semibold text-foreground mb-3">
                  {t("settings.widget.embedCodeLabel")}
                </h4>
                <p className="text-xs text-muted-foreground mb-2">
                  {t("settings.widget.embedCodeHint")}
                </p>
                <div className="bg-muted text-muted-foreground rounded p-4 text-xs font-mono overflow-x-auto whitespace-pre">
                  {/* Quick 260826-p0d (D-04): real-time snippet reflecting live
                      form values via form.watch (same pattern as the existing
                      autoOpenDelay preview at :732). The snippet updates
                      in-place as the user toggles the trigger options. */}
                  {buildWidgetSnippet(widget.id, widgetServiceUrl, {
                    autoOpenByTimeEnabled: form.watch("autoOpenByTimeEnabled"),
                    autoOpenDelay: form.watch("autoOpenDelay"),
                    autoOpenByUrlEnabled: form.watch("autoOpenByUrlEnabled"),
                    autoOpenUrlPatterns: form.watch("autoOpenUrlPatterns"),
                    exitIntentEnabled: form.watch("exitIntentEnabled"),
                  })}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={handleCopySnippet}
                  className={cn("mt-2 transition-colors", copied && "bg-secondary")}
                  aria-live="polite"
                >
                  {copied ? t("settings.widget.copied") : t("settings.widget.copyButton")}
                </Button>
              </div>
            )}
            </TabsContent>

            {/* Localization tab (D-03 / I18N-01) — functional: default language
                selector + per-locale texts on the shared form instance. */}
            <TabsContent value="localization" forceMount className={cn(tab !== "localization" && "hidden")}>
              <WidgetLocalizationTab form={form} />
            </TabsContent>

            {/* Questions tab (D-01 / QST-01/QST-02): functional tri-state
                editor on the shared form instance. */}
            <TabsContent value="questions" forceMount className={cn(tab !== "questions" && "hidden")}>
              <WidgetQuestionsTab form={form} />
            </TabsContent>

            {/* Credits tab (D-05 / CRD-01 SC2): functional editor on the
                shared form instance — enabled Switch + label Input (max 200)
                + URL Input with client-side http/https validation. The tab is
                registered in WIDGET_TABS :49 and TabsTrigger :380 — no
                tab-list change. */}
            <TabsContent value="credits" forceMount className={cn(tab !== "credits" && "hidden")}>
              <WidgetCreditsTab form={form} />
            </TabsContent>

            {/* Leads tab (ADM-03): widgetId is "" in create mode — the tab
                renders a disabled/empty state rather than querying leads. */}
            <TabsContent value="leads" forceMount className={cn(tab !== "leads" && "hidden")}>
              <WidgetLeadsTab widgetId={widget?.id ?? ""} />
            </TabsContent>
          </Tabs>

            {/* Footer */}
            <div className="pt-4 border-t border-border flex gap-2 justify-end">
              <Button
                type="submit"
                size="sm"
                disabled={saving}
              >
                {saving
                  ? isEdit
                    ? t("settings.widget.saving")
                    : t("settings.widget.creating")
                  : t("settings.widget.saveChanges") || t("common.save")}
              </Button>
            </div>
          </form>
        </Form>
    </div>
  );
}
