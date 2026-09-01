// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 152-03 (WIZ-01) — SetupWizard component (full 4-step wizard).
// Implements D-02 (linear steps + back-nav, no dead-ends), D-03 (single
// component, local useState step + field state), D-06 (probe buttons,
// non-blocking on failure), D-07 (model dropdown populated by probe,
// manual fallback when probe fails/returns zero), D-08 (auto-login —
// store returned JWT), D-09 (redirect to /chat on success).
//
// Composition (UI-SPEC §Registry Safety): ONLY pre-existing shadcn
// primitives + ThemeToggle + lucide icons. No new components installed.
//
// State (frontend AGENTS.md golden rule): step index + field values are
// local useState (ephemeral UI state, D-03); the initialize call is a
// TanStack Query mutation (useInitialize); the probe calls are TanStack
// Query mutations (useProbeLlm/useProbeVector). The golden rule is
// satisfied — REST → TanStack Query for the server-state calls, local
// state for the step flow.
//
// Color (UI-SPEC §Color): all colors via var(--*) tokens (bg-background,
// var(--card), var(--primary) for accent, var(--muted-foreground), var
// (--border)). Never hardcoded hex.
//
// Accessibility (UI-SPEC §Accessibility): password show/hide with
// aria-label, probe status messages aria-live="polite", stepper active
// circle aria-current="step", 44px touch targets on mobile.
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import ThemeToggle from "./ThemeToggle";
import { getEnabledLanguages } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppInput } from "@/components/ui/app";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Eye, EyeOff, Loader2, Check } from "lucide-react";
import { getErrorMessage } from "../utils/errorUtils";
import { navigateTo } from "../utils/navigation";
import { showSuccess } from "../lib/toast";
import {
  useInitialize,
  useProbeLlm,
  useProbeVector,
} from "../queries/useSystem";
import { initializeSchema } from "@simmetric-chat/shared";
import type { InitializeInput } from "@simmetric-chat/shared";

type LlmProvider = "ollama" | "openai" | "anthropic" | "openrouter";
type VectorProvider = "lancedb" | "qdrant" | "pgvector" | "chroma";

const LLM_PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "ollama", label: "Ollama" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
];

const VECTOR_PROVIDERS: { value: VectorProvider; label: string }[] = [
  { value: "lancedb", label: "LanceDB (local)" },
  { value: "qdrant", label: "Qdrant" },
  { value: "pgvector", label: "pgvector" },
  { value: "chroma", label: "Chroma" },
];

const STEP_COUNT = 4;
const STEP_LABELS = [
  "setup.wizard.steps.admin.title",
  "setup.wizard.steps.llm.title",
  "setup.wizard.steps.vector.title",
  "setup.wizard.steps.confirm.title",
] as const;

interface WizardFields {
  username: string;
  email: string;
  password: string;
  llmProvider: LlmProvider;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  vectorProvider: VectorProvider;
  vectorUrl: string;
}

const DEFAULT_FIELDS: WizardFields = {
  username: "",
  email: "",
  password: "",
  llmProvider: "ollama",
  llmBaseUrl: "http://localhost:11434",
  llmApiKey: "",
  llmModel: "",
  vectorProvider: "lancedb",
  vectorUrl: "",
};

/**
 * Validate the admin step against `initializeSchema` (the SAME schema the
 * server validates against — shared AGENTS.md: never re-declare). Only the
 * admin fields are required for step 0; LLM/vector config is optional per
 * `initializeSchema` (config is `.optional()`).
 *
 * Returns a map of field-key -> error message (empty if valid).
 */
function validateAdminStep(fields: WizardFields): Record<string, string> {
  const errors: Record<string, string> = {};
  const partial = {
    username: fields.username,
    email: fields.email,
    password: fields.password,
  };
  const parsed = initializeSchema.safeParse(partial);
  if (!parsed.success) {
    const fe = parsed.error.flatten().fieldErrors;
    if (fe.username) errors.username = "setup.wizard.errors.usernameRequired";
    if (fe.email) errors.email = "setup.wizard.errors.emailInvalid";
    if (fe.password) errors.password = "setup.wizard.errors.passwordShort";
  }
  return errors;
}

export default function SetupWizard() {
  const { t, i18n } = useTranslation();
  const [enabledLanguages, setEnabledLanguages] = useState(getEnabledLanguages());
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState<WizardFields>(DEFAULT_FIELDS);
  const [showPassword, setShowPassword] = useState(false);
  const [adminErrors, setAdminErrors] = useState<Record<string, string>>({});
  // Probe state (LLM step)
  const [llmProbeModels, setLlmProbeModels] = useState<string[] | null>(null);
  const [llmProbeError, setLlmProbeError] = useState<string | null>(null);
  // Probe state (vector step)
  const [vectorProbeOk, setVectorProbeOk] = useState<boolean | null>(null);
  const [vectorProbeError, setVectorProbeError] = useState<string | null>(null);
  // Initialize error (confirm step)
  const [initError, setInitError] = useState<string | null>(null);

  const initializeMutation = useInitialize();
  const probeLlmMutation = useProbeLlm();
  const probeVectorMutation = useProbeVector();

  useEffect(() => {
    const handler = () => setEnabledLanguages(getEnabledLanguages());
    window.addEventListener("enabled-languages-changed", handler);
    return () => window.removeEventListener("enabled-languages-changed", handler);
  }, []);

  const set = <K extends keyof WizardFields>(key: K, value: WizardFields[K]) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    // Reset probe-derived state when the underlying config changes
    if (key === "llmProvider" || key === "llmBaseUrl" || key === "llmApiKey") {
      setLlmProbeModels(null);
      setLlmProbeError(null);
    }
    if (key === "vectorProvider" || key === "vectorUrl") {
      setVectorProbeOk(null);
      setVectorProbeError(null);
    }
  };

  const changeLanguage = (lng: string) => i18n.changeLanguage(lng);

  const adminValid = Object.keys(validateAdminStep(fields)).length === 0;
  const nextDisabled = step === 0 ? !adminValid : false;

  const handleNext = () => {
    if (step === 0) {
      const errs = validateAdminStep(fields);
      if (Object.keys(errs).length > 0) {
        setAdminErrors(errs);
        return;
      }
      setAdminErrors({});
    }
    if (step < STEP_COUNT - 1) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 0) setStep(step - 1);
  };

  const handleProbeLlm = async () => {
    setLlmProbeModels(null);
    setLlmProbeError(null);
    try {
      const result = await probeLlmMutation.mutateAsync({
        provider: fields.llmProvider,
        baseUrl: fields.llmBaseUrl || undefined,
        apiKey: fields.llmApiKey || undefined,
      });
      if (result.ok && result.models) {
        setLlmProbeModels(result.models);
        const firstModel = result.models[0];
        if (result.models.length > 0 && firstModel && !result.models.includes(fields.llmModel)) {
          set("llmModel", firstModel);
        }
      } else {
        setLlmProbeError(result.error ?? "probe failed");
      }
    } catch (err) {
      setLlmProbeError(getErrorMessage(err, "probe failed"));
    }
  };

  const handleProbeVector = async () => {
    setVectorProbeOk(null);
    setVectorProbeError(null);
    try {
      const result = await probeVectorMutation.mutateAsync({
        provider: fields.vectorProvider,
        url: fields.vectorUrl || undefined,
      });
      setVectorProbeOk(result.ok);
      if (!result.ok) setVectorProbeError(result.error ?? "probe failed");
    } catch (err) {
      setVectorProbeOk(false);
      setVectorProbeError(getErrorMessage(err, "probe failed"));
    }
  };

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    setInitError(null);
    const payload: InitializeInput = {
      username: fields.username,
      email: fields.email,
      password: fields.password,
      config: {
        LLM_PROVIDER: fields.llmProvider,
        LLM_MODEL: fields.llmModel || undefined,
        LLM_API_KEY: fields.llmApiKey || undefined,
        OLLAMA_BASE_URL: fields.llmProvider === "ollama" ? fields.llmBaseUrl || undefined : undefined,
        VECTOR_DB_PROVIDER: fields.vectorProvider,
        VECTOR_DB_URL: fields.vectorUrl || undefined,
      },
    };
    try {
      const result = await initializeMutation.mutateAsync(payload);
      // D-08 auto-login — store the returned JWT under the same localStorage
      // key useLogin uses so the existing auth flow picks it up on the
      // next render (no separate login step).
      localStorage.setItem("token", result.token);
      showSuccess(t("setup.wizard.success"));
      // D-09 redirect to /chat. Use navigateTo (full-page nav) so the app
      // re-mounts cleanly with the new token; react-router in-app
      // navigation would skip the App.tsx auth gate re-evaluation.
      navigateTo("/chat");
    } catch (err) {
      setInitError(getErrorMessage(err, "initialize failed"));
    }
  };

  const submitting = initializeMutation.isPending;
  const probingLlm = probeLlmMutation.isPending;
  const probingVector = probeVectorMutation.isPending;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        {/* Controls bar — theme toggle + language selector (mirror LoginPage §72-98) */}
        <div className="flex items-center justify-end gap-2 mb-4">
          <ThemeToggle />
          {enabledLanguages.length > 1 && (
            <Select
              value={i18n.language}
              onValueChange={(value) => changeLanguage(value)}
              aria-label={t("login.language")}
            >
              <SelectTrigger className="w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enabledLanguages.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code === "en" && "English"}
                    {code === "de" && "Deutsch"}
                    {code === "es" && "Español"}
                    {code === "fr" && "Français"}
                    {code === "it" && "Italiano"}
                    {code === "ru" && "Русский"}
                    {code === "zh" && "中文"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">{t("setup.wizard.title")}</CardTitle>
            <CardDescription>{t("setup.wizard.subtitle")}</CardDescription>
            {/* Stepper — composed from div + circles + Separator (UI-SPEC §UI Considerations — no new Stepper component) */}
            <div className="flex items-center justify-center gap-2 mt-4">
              {STEP_LABELS.map((labelKey, idx) => {
                const isCompleted = idx < step;
                const isActive = idx === step;
                return (
                  <div key={labelKey} className="flex items-center gap-2">
                    <div className="flex flex-col items-center gap-1">
                      <div
                        aria-current={isActive ? "step" : undefined}
                        data-testid={`stepper-circle-${idx}`}
                        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium border-2"
                        style={{
                          backgroundColor: isActive || isCompleted ? "var(--primary)" : "var(--card)",
                          borderColor: isActive || isCompleted ? "var(--primary)" : "var(--border)",
                          color: isActive || isCompleted ? "var(--primary-foreground)" : "var(--muted-foreground)",
                        }}
                      >
                        {isCompleted ? <Check className="w-3 h-3" /> : idx + 1}
                      </div>
                      <span
                        className="text-xs"
                        style={{
                          color: isActive ? "var(--foreground)" : "var(--muted-foreground)",
                          fontWeight: isActive ? 500 : 400,
                        }}
                      >
                        {t(labelKey)}
                      </span>
                    </div>
                    {idx < STEP_LABELS.length - 1 && (
                      <div
                        className="h-0.5 w-8"
                        style={{
                          backgroundColor: idx < step ? "var(--primary)" : "var(--border)",
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </CardHeader>

          <CardContent>
            {/* Step 0 — Admin account */}
            {step === 0 && (
              <div className="space-y-4" aria-live="polite">
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
                    {t("setup.wizard.steps.admin.title")}
                  </h2>
                  <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                    {t("setup.wizard.steps.admin.desc")}
                  </p>
                </div>
                <AppInput
                  label={t("setup.wizard.steps.admin.title") /* reuse; test asserts aria-label */}
                  type="text"
                  value={fields.username}
                  onChange={(e) => set("username", e.target.value)}
                  aria-label="Username"
                  placeholder="admin"
                  error={adminErrors.username ? t("setup.wizard.errors.usernameRequired") : undefined}
                />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="setup-email">Email</Label>
                  <Input
                    id="setup-email"
                    type="email"
                    value={fields.email}
                    onChange={(e) => set("email", e.target.value)}
                    aria-label="Email"
                    placeholder="admin@example.com"
                  />
                  {adminErrors.email && (
                    <p className="text-xs" style={{ color: "var(--destructive)" }}>
                      {t("setup.wizard.errors.emailInvalid")}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="setup-password">Password</Label>
                  <div className="relative">
                    <Input
                      id="setup-password"
                      type={showPassword ? "text" : "password"}
                      value={fields.password}
                      onChange={(e) => set("password", e.target.value)}
                      aria-label="Password"
                      placeholder="At least 8 characters"
                      className="pr-10"
                      autoComplete="new-password"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2"
                      tabIndex={-1}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                    </Button>
                  </div>
                  {adminErrors.password && (
                    <p className="text-xs" style={{ color: "var(--destructive)" }}>
                      {t("setup.wizard.errors.passwordShort", { min: "8" })}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Step 1 — LLM provider */}
            {step === 1 && (
              <div className="space-y-4" aria-live="polite">
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
                    {t("setup.wizard.steps.llm.title")}
                  </h2>
                  <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                    {t("setup.wizard.steps.llm.desc")}
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Provider</Label>
                  <Select
                    value={fields.llmProvider}
                    onValueChange={(v) => set("llmProvider", v as LlmProvider)}
                  >
                    <SelectTrigger className="w-full min-h-[44px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LLM_PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Base URL</Label>
                  <Input
                    type="url"
                    value={fields.llmBaseUrl}
                    onChange={(e) => set("llmBaseUrl", e.target.value)}
                    placeholder="http://localhost:11434"
                    className="min-h-[44px]"
                  />
                </div>
                {(fields.llmProvider === "openai" ||
                  fields.llmProvider === "anthropic" ||
                  fields.llmProvider === "openrouter") && (
                  <div className="flex flex-col gap-1.5">
                    <Label>API key</Label>
                    <Input
                      type="password"
                      value={fields.llmApiKey}
                      onChange={(e) => set("llmApiKey", e.target.value)}
                      placeholder="sk-…"
                      className="min-h-[44px]"
                    />
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleProbeLlm}
                  disabled={probingLlm}
                  className="min-h-[44px]"
                >
                  {probingLlm ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t("setup.wizard.testing")}
                    </>
                  ) : (
                    t("setup.wizard.testConnection")
                  )}
                </Button>
                {llmProbeError && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {t("setup.wizard.probeFailure", { target: fields.llmBaseUrl || fields.llmProvider })}
                    </AlertDescription>
                  </Alert>
                )}
                {llmProbeModels && llmProbeModels.length > 0 && (
                  <div aria-live="polite">
                    <p className="text-sm" style={{ color: "var(--primary)" }}>
                      {t("setup.wizard.probeSuccess", { count: String(llmProbeModels.length) })}
                    </p>
                    <div className="flex flex-col gap-1.5 mt-2">
                      <Label>Model</Label>
                      <Select
                        value={fields.llmModel}
                        onValueChange={(v) => set("llmModel", v)}
                      >
                        <SelectTrigger className="w-full min-h-[44px] text-sm">
                          <SelectValue placeholder={t("setup.wizard.modelsEmpty")} />
                        </SelectTrigger>
                        <SelectContent>
                          {llmProbeModels.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                {llmProbeModels && llmProbeModels.length === 0 && (
                  <div aria-live="polite">
                    <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                      {t("setup.wizard.modelsEmptyAfterProbe")}
                    </p>
                    <div className="flex flex-col gap-1.5 mt-2">
                      <Label>Model</Label>
                      <Input
                        type="text"
                        value={fields.llmModel}
                        onChange={(e) => set("llmModel", e.target.value)}
                        placeholder="llama3.2:latest"
                        className="min-h-[44px]"
                      />
                    </div>
                  </div>
                )}
                {!llmProbeModels && !llmProbeError && (
                  <div className="flex flex-col gap-1.5">
                    <Label>Model</Label>
                    <Input
                      type="text"
                      value={fields.llmModel}
                      onChange={(e) => set("llmModel", e.target.value)}
                      placeholder={t("setup.wizard.modelsEmpty")}
                      className="min-h-[44px]"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Step 2 — Vector DB */}
            {step === 2 && (
              <div className="space-y-4" aria-live="polite">
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
                    {t("setup.wizard.steps.vector.title")}
                  </h2>
                  <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                    {t("setup.wizard.steps.vector.desc")}
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Provider</Label>
                  <Select
                    value={fields.vectorProvider}
                    onValueChange={(v) => set("vectorProvider", v as VectorProvider)}
                  >
                    <SelectTrigger className="w-full min-h-[44px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VECTOR_PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {fields.vectorProvider !== "lancedb" && (
                  <div className="flex flex-col gap-1.5">
                    <Label>URL</Label>
                    <Input
                      type="url"
                      value={fields.vectorUrl}
                      onChange={(e) => set("vectorUrl", e.target.value)}
                      placeholder={
                        fields.vectorProvider === "qdrant"
                          ? "http://qdrant:6333"
                          : fields.vectorProvider === "chroma"
                            ? "http://chroma:8000"
                            : ""
                      }
                      className="min-h-[44px]"
                    />
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleProbeVector}
                  disabled={probingVector}
                  className="min-h-[44px]"
                >
                  {probingVector ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t("setup.wizard.testing")}
                    </>
                  ) : (
                    t("setup.wizard.testConnection")
                  )}
                </Button>
                {vectorProbeOk === true && (
                  <p className="text-sm" style={{ color: "var(--primary)" }} aria-live="polite">
                    {t("setup.wizard.probeSuccess", { count: "" }).replace(/—.*$/, "— OK")}
                  </p>
                )}
                {vectorProbeError && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {t("setup.wizard.probeFailure", { target: fields.vectorUrl || fields.vectorProvider })}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {/* Step 3 — Confirm + submit */}
            {step === 3 && (
              <form onSubmit={handleComplete} className="space-y-4" aria-live="polite">
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
                    {t("setup.wizard.steps.confirm.title")}
                  </h2>
                  <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                    {t("setup.wizard.steps.confirm.desc")}
                  </p>
                </div>
                {initError && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {t("setup.wizard.initializeError", { message: initError })}
                    </AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <div className="flex justify-between border-b pb-1" style={{ borderColor: "var(--border)" }}>
                    <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>Username</span>
                    <span className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                      {fields.username}
                    </span>
                  </div>
                  <div className="flex justify-between border-b pb-1" style={{ borderColor: "var(--border)" }}>
                    <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>Email</span>
                    <span className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                      {fields.email}
                    </span>
                  </div>
                  <div className="flex justify-between border-b pb-1" style={{ borderColor: "var(--border)" }}>
                    <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>LLM provider</span>
                    <span className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                      {fields.llmProvider}
                    </span>
                  </div>
                  <div className="flex justify-between border-b pb-1" style={{ borderColor: "var(--border)" }}>
                    <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>LLM model</span>
                    <span className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                      {fields.llmModel || "—"}
                    </span>
                  </div>
                  <div className="flex justify-between border-b pb-1" style={{ borderColor: "var(--border)" }}>
                    <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>Vector DB</span>
                    <span className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                      {fields.vectorProvider}
                    </span>
                  </div>
                </div>
              </form>
            )}

            {/* Navigation footer — always visible; Back allowed (D-02 no dead-ends); Next disabled only on step 0 when invalid */}
            <Separator className="my-4" />
            <div className="flex justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleBack}
                disabled={step === 0}
                className="min-h-[44px]"
              >
                {t("setup.wizard.back")}
              </Button>
              {step < STEP_COUNT - 1 ? (
                <Button
                  type="button"
                  variant="default"
                  onClick={handleNext}
                  disabled={nextDisabled}
                  className="min-h-[44px]"
                >
                  {t("setup.wizard.next")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="default"
                  onClick={(e) => {
                    e.preventDefault();
                    handleComplete(e as unknown as React.FormEvent);
                  }}
                  disabled={submitting}
                  className="min-h-[44px]"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t("setup.wizard.testing")}
                    </>
                  ) : (
                    t("setup.wizard.complete")
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}