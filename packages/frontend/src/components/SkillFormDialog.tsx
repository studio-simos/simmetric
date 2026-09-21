// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 190 (SKIL-01/03, D-20) — Create/Edit skill dialog per the UI-SPEC
 * interaction contract: slug kebab validation + reserved-slug error + 409
 * duplicate error copy; mode Select with Prompt enabled and Webhook DISABLED
 * "coming soon"; scope Select Personal/Workspace/Global where Global is
 * disabled (tooltip) for non-admins and Workspace reveals a workspace picker;
 * template Textarea mono with a {{param}} highlight overlay tracking scroll;
 * defaultParams key-value editor HIDDEN when the template has zero
 * placeholders (zero-one-many); inputSchema editor as Tabs Auto-generate ↔
 * Manual JSON with auto-generate scanning {{param}} occurrences; explicit
 * Save Skill button only (no auto-save); isEnabled Switch in edit mode;
 * Test button disabled in create mode with the testNeedsSave helper — the
 * preview rides POST /api/skills/:id/test via the page's onTest (no
 * client-side compilation, no LLM call — D-20).
 *
 * Server-authoritative: client validation is UX-only (T-190-19) — every save
 * goes through the page's onSave → useCreateSkill/useUpdateSkill, and the
 * server safeParse + permission/scope/limit gates re-run.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, FlaskConical } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { AppInput, AppTextarea, AppSelect } from "@/components/ui/app";
import { Label } from "./ui/label";
import { SelectItem } from "./ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Switch } from "./ui/switch";
import { ScrollArea } from "./ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { RESERVED_SLUGS } from "@simmetric-chat/shared";
import { ApiError } from "../utils/api";

export interface SkillFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit mode pre-fill; null → create mode. */
  skill: {
    id: string;
    slug: string;
    name: string;
    description: string;
    scope: string;
    workspaceId: string | null;
    isEnabled?: boolean;
    config: { template?: string; defaultParams: Record<string, string> };
    inputSchema: Record<string, unknown>;
  } | null;
  /** Page-level save (create or update) — server-authoritative validation. */
  onSave: (payload: Record<string, unknown>, id?: string) => Promise<void>;
  /** Page-level test — POST /api/skills/:id/test via useTestSkill (server compiles). */
  onTest?: (id: string, params: Record<string, string>) => Promise<{ compiledPrompt: string }>;
  isAdmin?: boolean;
  /** Workspaces for the Workspace-scope picker (the user's existing workspaces query). */
  workspaces?: { id: string; name: string }[];
}

const SLUG_RE = /^[a-z0-9-]+$/;
/** Template placeholder pattern — mirrors skill.schema.ts TEMPLATE_PLACEHOLDER_RE. */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

/** Extract the {{param}} names a template references (deduped, ordered). */
function extractPlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const key = match[1] as string;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

export default function SkillFormDialog({
  open,
  onOpenChange,
  skill,
  onSave,
  onTest,
  isAdmin = false,
  workspaces = [],
}: SkillFormDialogProps) {
  const { t } = useTranslation();
  const isEdit = skill !== null;

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skillMode, setSkillMode] = useState("prompt");
  const [scope, setScope] = useState("personal");
  const [workspaceId, setWorkspaceId] = useState("");
  const [template, setTemplate] = useState("");
  const [defaultParams, setDefaultParams] = useState<{ key: string; value: string }[]>([]);
  const [schemaTab, setSchemaTab] = useState("auto");
  const [manualJson, setManualJson] = useState("{}");
  const [isEnabled, setIsEnabled] = useState(true);

  const [slugError, setSlugError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Test-preview state — server-compiled only (D-20).
  const [preview, setPreview] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Template highlight overlay scroll sync.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // (Re)initialize on open — ArchiveCreateDialog reset idiom. The init blob
  // is serialized to a stable dep (usePageMeta D-05 pattern 3): `skill` is a
  // fresh object reference per row render, so listing it raw would re-run the
  // effect every render; the JSON string gates re-runs on content only.
  // skillInit (parsed back) is the content source — the effect reads ONLY the
  // serialized blob, keeping the dep list exhaustive-deps-clean.
  const skillInit = useMemo(
    () =>
      JSON.stringify({
        id: skill?.id ?? null,
        slug: skill?.slug ?? null,
        name: skill?.name ?? null,
        description: skill?.description ?? null,
        scope: skill?.scope ?? null,
        workspaceId: skill?.workspaceId ?? null,
        isEnabled: skill?.isEnabled ?? null,
        config: skill?.config ?? null,
        inputSchema: skill?.inputSchema ?? null,
      }),
    [skill]
  );
  useEffect(() => {
    if (!open) return;
    const source = JSON.parse(skillInit) as {
      id: string | null;
      slug: string | null;
      name: string | null;
      description: string | null;
      scope: string | null;
      workspaceId: string | null;
      isEnabled: boolean | null;
      config: { template?: string; defaultParams: Record<string, string> } | null;
      inputSchema: Record<string, unknown> | null;
    };
    const config = source.config ?? { defaultParams: {} };
    const inputSchema = source.inputSchema ?? { properties: {}, required: [] };
    setSlug(source.slug ?? "");
    setName(source.name ?? "");
    setDescription(source.description ?? "");
    setSkillMode("prompt");
    setScope(source.scope ?? "personal");
    setWorkspaceId(source.workspaceId ?? "");
    setTemplate(typeof config.template === "string" ? config.template : "");
    setDefaultParams(
      Object.entries(config.defaultParams ?? {}).map(([key, value]) => ({ key, value }))
    );
    setManualJson(JSON.stringify(inputSchema, null, 2));
    setIsEnabled(source.isEnabled ?? true);
    setSchemaTab("auto");
    setSlugError(null);
    setJsonError(null);
    setSaveError(null);
    setPreview(null);
  }, [open, skillInit]);

  const placeholders = useMemo(() => extractPlaceholders(template), [template]);

  // Auto-generated draft schema: every placeholder becomes a string-typed property.
  const autoSchema = useMemo(() => {
    const properties: Record<string, { type: string }> = {};
    for (const key of placeholders) properties[key] = { type: "string" };
    return { properties, required: [] };
  }, [placeholders]);

  // Zero-one-many: the defaultParams editor is HIDDEN when the template has
  // zero placeholders (UI-SPEC zero-one-many row).
  const showDefaultParams = placeholders.length > 0;

  const validateManualJson = (): boolean => {
    try {
      const parsed = JSON.parse(manualJson);
      if (!parsed || typeof parsed !== "object") {
        setJsonError(t("skills.form.jsonError"));
        return false;
      }
      setJsonError(null);
      return true;
    } catch {
      setJsonError(t("skills.form.jsonError"));
      return false;
    }
  };

  /** Pure parse (no side effects) — the save-path schema source. */
  const parsedManualSchema = ():
    | { properties: Record<string, unknown>; required: string[] }
    | null => {
    try {
      const parsed = JSON.parse(manualJson);
      if (!parsed || typeof parsed !== "object") return null;
      return {
        properties: (parsed.properties ?? {}) as Record<string, unknown>,
        required: (parsed.required ?? []) as string[],
      };
    } catch {
      return null;
    }
  };

  const validateSlug = (): boolean => {
    if (!slug.trim()) return false;
    if (!SLUG_RE.test(slug)) {
      setSlugError(t("skills.form.slugInvalid"));
      return false;
    }
    if ((RESERVED_SLUGS as readonly string[]).includes(slug)) {
      setSlugError(t("skills.form.slugReserved"));
      return false;
    }
    setSlugError(null);
    return true;
  };

  const buildPayload = (): Record<string, unknown> | null => {
    if (!validateSlug() && !isEdit) return null;
    if (schemaTab === "manual" && !validateManualJson()) return null;
    const inputSchema = schemaTab === "manual" ? parsedManualSchema() : autoSchema;
    const params: Record<string, string> = {};
    for (const entry of defaultParams) {
      if (entry.key.trim()) params[entry.key.trim()] = entry.value;
    }
    const config = { template, defaultParams: params, injectAs: "user" };
    if (isEdit) {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        config,
        inputSchema,
      };
      if (scope !== undefined) payload.scope = scope;
      if (scope === "workspace") payload.workspaceId = workspaceId || undefined;
      return payload;
    }
    const payload: Record<string, unknown> = {
      slug,
      name: name.trim(),
      description: description.trim(),
      skillMode: "prompt",
      config,
      inputSchema,
      scope,
    };
    if (scope === "workspace") payload.workspaceId = workspaceId || undefined;
    return payload;
  };

  const handleSave = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(payload, isEdit ? skill!.id : undefined);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        setSlugError(t("skills.form.slugDuplicate"));
      } else if (!(err instanceof ApiError && err.status === 402)) {
        // 402 rides the page-level limit arm; other failures surface inline.
        setSaveError(t("skills.error.save"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!isEdit || !onTest || !skill) return;
    setTesting(true);
    setPreview(null);
    try {
      const params: Record<string, string> = {};
      for (const entry of defaultParams) {
        if (entry.key.trim()) params[entry.key.trim()] = entry.value;
      }
      const result = await onTest(skill.id, params);
      setPreview(result.compiledPrompt);
    } catch {
      setSaveError(t("skills.error.save"));
    } finally {
      setTesting(false);
    }
  };

  const syncOverlayScroll = () => {
    if (overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
      overlayRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  /** Split the template into plain/placeholder segments for the highlight overlay. */
  const overlaySegments = useMemo(() => {
    const segments: { text: string; isPlaceholder: boolean }[] = [];
    let last = 0;
    for (const match of template.matchAll(PLACEHOLDER_RE)) {
      const start = match.index ?? 0;
      if (start > last) segments.push({ text: template.slice(last, start), isPlaceholder: false });
      segments.push({ text: match[0], isPlaceholder: true });
      last = start + match[0].length;
    }
    if (last < template.length) segments.push({ text: template.slice(last), isPlaceholder: false });
    return segments;
  }, [template]);

  return (
    <TooltipProvider>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold">
              {isEdit ? t("skills.form.editTitle") : t("skills.form.createTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Slug — mono, kebab validation, reserved + duplicate error copy */}
            {!isEdit && (
              <AppInput
                id="skill-slug"
                label="Slug"
                className="font-mono"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                onBlur={validateSlug}
                error={slugError ?? undefined}
                helperText="/my-skill"
                data-testid="skill-form-slug"
              />
            )}
            {isEdit && (
              <div className="text-sm">
                <span className="text-muted-foreground">/</span>
                <span className="font-mono">{skill?.slug}</span>
              </div>
            )}
            {isEdit && slugError && <p className="text-xs text-destructive">{slugError}</p>}

            <AppInput
              id="skill-name"
              label={t("skills.form.name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="skill-form-name"
            />

            <AppTextarea
              id="skill-description"
              label={t("common.description")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              data-testid="skill-form-description"
            />

            {/* Mode — Prompt enabled; Webhook DISABLED "coming soon" (D-01, SKIL-F01) */}
            <AppSelect
              id="skill-mode"
              label={t("skills.form.mode")}
              value={skillMode}
              onValueChange={setSkillMode}
              data-testid="skill-form-mode"
            >
              <SelectItem value="prompt">{t("skills.form.modePrompt")}</SelectItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="w-full">
                    <SelectItem value="webhook" disabled>
                      {t("skills.form.modeWebhook")}
                    </SelectItem>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">{t("skills.form.modeWebhookSoon")}</TooltipContent>
              </Tooltip>
            </AppSelect>

            {/* Scope — Personal / Workspace / Global (admin-only; UX-only gate, server re-gates) */}
            <AppSelect
              id="skill-scope"
              label={t("skills.form.scope")}
              value={scope}
              onValueChange={setScope}
              data-testid="skill-form-scope"
            >
              <SelectItem value="personal">{t("skills.form.scopePersonal")}</SelectItem>
              <SelectItem value="workspace">{t("skills.form.scopeWorkspace")}</SelectItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="w-full">
                    <SelectItem value="global" disabled={!isAdmin} data-testid="skill-form-scope-global">
                      {t("skills.form.scopeGlobal")}
                    </SelectItem>
                  </div>
                </TooltipTrigger>
                {!isAdmin && <TooltipContent side="top">{t("skills.form.scopeGlobalAdminOnly")}</TooltipContent>}
              </Tooltip>
            </AppSelect>

            {/* Workspace picker — revealed only for workspace scope */}
            {scope === "workspace" && (
              <AppSelect
                id="skill-workspace"
                label={t("skills.form.workspace")}
                value={workspaceId}
                onValueChange={setWorkspaceId}
                placeholder={t("skills.form.selectWorkspace")}
                data-testid="skill-form-workspace"
              >
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </AppSelect>
            )}

            {/* Template — mono textarea with {{param}} highlight overlay tracking scroll */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="skill-template">{t("skills.form.template")}</Label>
              <div className="relative">
                <div
                  ref={overlayRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent px-3 py-2 text-sm font-mono"
                  data-testid="skill-template-overlay"
                >
                  {overlaySegments.map((seg, i) =>
                    seg.isPlaceholder ? (
                      <span key={i} className="text-primary/70">
                        {seg.text}
                      </span>
                    ) : (
                      <span key={i} className="text-transparent">
                        {seg.text}
                      </span>
                    )
                  )}
                </div>
                <textarea
                  id="skill-template"
                  ref={textareaRef}
                  className="relative min-h-[160px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  onScroll={syncOverlayScroll}
                  data-testid="skill-form-template"
                />
              </div>
            </div>

            {/* defaultParams — key-value rows, HIDDEN with zero placeholders */}
            {showDefaultParams && (
              <div className="flex flex-col gap-2" data-testid="skill-form-default-params">
                <Label>{t("skills.form.defaultParams")}</Label>
                {defaultParams.map((entry, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm font-mono"
                      value={entry.key}
                      placeholder={t("skills.form.paramKey")}
                      onChange={(e) => {
                        const next = [...defaultParams];
                        next[idx] = { ...entry, key: e.target.value };
                        setDefaultParams(next);
                      }}
                      data-testid={`skill-param-key-${idx}`}
                    />
                    <input
                      className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm font-mono"
                      value={entry.value}
                      placeholder={t("skills.form.paramValue")}
                      onChange={(e) => {
                        const next = [...defaultParams];
                        next[idx] = { ...entry, value: e.target.value };
                        setDefaultParams(next);
                      }}
                      data-testid={`skill-param-value-${idx}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("skills.form.removeParam")}
                      onClick={() => setDefaultParams(defaultParams.filter((_, i) => i !== idx))}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setDefaultParams([...defaultParams, { key: "", value: "" }])}
                  data-testid="skill-param-add"
                >
                  <Plus className="mr-1 h-3 w-3" />
                  {t("skills.form.addParam")}
                </Button>
              </div>
            )}

            {/* inputSchema — Tabs Auto-generate ↔ Manual JSON */}
            <div className="flex flex-col gap-2" data-testid="skill-form-input-schema">
              <Label>{t("skills.form.inputSchema")}</Label>
              <Tabs value={schemaTab} onValueChange={setSchemaTab}>
                <TabsList>
                  <TabsTrigger value="auto">{t("skills.form.inputSchemaAuto")}</TabsTrigger>
                  <TabsTrigger value="manual">{t("skills.form.inputSchemaManual")}</TabsTrigger>
                </TabsList>
                <TabsContent value="auto">
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs font-mono" data-testid="skill-schema-auto">
                    {JSON.stringify(autoSchema, null, 2)}
                  </pre>
                </TabsContent>
                <TabsContent value="manual">
                  <textarea
                    className="min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={manualJson}
                    onChange={(e) => {
                      setManualJson(e.target.value);
                      // Live-validate: flag invalid JSON as the user types.
                      const v = e.target.value;
                      try {
                        const parsed = JSON.parse(v);
                        setJsonError(parsed && typeof parsed === "object" ? null : t("skills.form.jsonError"));
                      } catch {
                        setJsonError(t("skills.form.jsonError"));
                      }
                    }}
                    data-testid="skill-form-json"
                  />
                  {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
                </TabsContent>
              </Tabs>
            </div>

            {/* isEnabled — edit mode only (D-02) */}
            {isEdit && (
              <div className="flex items-center gap-2">
                <Switch
                  id="skill-enabled"
                  checked={isEnabled}
                  onCheckedChange={setIsEnabled}
                  data-testid="skill-form-enabled"
                />
                <Label htmlFor="skill-enabled">{t("skills.form.enabled")}</Label>
              </div>
            )}

            {/* Test preview — server-compiled only, ScrollArea max-height 320px */}
            {preview !== null && (
              <div className="flex flex-col gap-1.5">
                <Label>{t("skills.form.testPreview")}</Label>
                <ScrollArea className="max-h-[320px] rounded-md border border-input bg-muted p-3" data-testid="skill-test-preview">
                  <pre className="whitespace-pre-wrap break-words text-xs font-mono">{preview}</pre>
                </ScrollArea>
              </div>
            )}

            {saveError && <p className="text-xs text-destructive">{saveError}</p>}
          </div>

          <DialogFooter>
            <div className="flex w-full items-center justify-between gap-2">
              {/* Test Skill — outline; disabled in create mode with the testNeedsSave helper */}
              <div className="flex flex-col">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={handleTest}
                      disabled={!isEdit || testing}
                      data-testid="skill-form-test"
                    >
                      <FlaskConical className="mr-2 h-4 w-4" />
                      {t("skills.form.test")}
                    </Button>
                  </TooltipTrigger>
                  {!isEdit && <TooltipContent side="top">{t("skills.form.testNeedsSave")}</TooltipContent>}
                </Tooltip>
                {!isEdit && <p className="text-xs text-muted-foreground mt-1">{t("skills.form.testNeedsSave")}</p>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={handleSave} disabled={saving} data-testid="skill-form-save">
                  {saving ? t("skills.form.saving") : t("skills.form.save")}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}