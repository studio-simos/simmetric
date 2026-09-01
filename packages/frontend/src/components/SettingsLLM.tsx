// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { useProviders } from "../queries/useProviders";
import { showSuccess, showError, showInfo } from "../lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { ReadOnlyBadge, EnvOverriddenBadge } from "./SettingsGeneral";
import type { SettingsEntry, Provider } from "@simmetric-chat/shared";

interface LLMFormValues {
  temperature: number;
  maxTokens: string;
  embeddingProviderId: string;
  embeddingModel: string;
}

// ------------------------------------------------------------------
// Wrapper — waits for both settings and providers before mounting
// the form.  This guarantees the form is created with the correct
// defaultValues on the first render, so Radix Select never has to
// recover from a post-mount reset.
// ------------------------------------------------------------------
export default function SettingsLLM() {
  const { data: settings } = useSettings();
  const { data: providers = [] } = useProviders();
  if (!settings || providers.length === 0) {
    return (
      <div className="w-full space-y-6">
        <h3 className="text-lg font-medium text-foreground">{/* title injected by SettingsPage */}</h3>
        <div className="animate-pulse h-32 bg-card rounded-lg border border-input" />
      </div>
    );
  }

  return <SettingsLLMForm settings={settings} providers={providers} />;
}

interface SettingsLLMFormProps {
  settings: SettingsEntry[];
  providers: Provider[];
}

function SettingsLLMForm({ settings, providers }: SettingsLLMFormProps) {
  const { isReadOnly, isEnvOverridden } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);

  // ----------------------------------------------------------------
  // Derive initial form values from the saved settings + provider list
  // ----------------------------------------------------------------
  const embeddingProviderSetting = settings.find((s) => s.key === "EMBEDDING_PROVIDER")?.value ?? "";
  const embeddingModelSetting = settings.find((s) => s.key === "EMBEDDING_MODEL")?.value ?? "";
  const temperatureSetting = settings.find((s) => s.key === "LLM_TEMPERATURE")?.value ?? "0.7";
  const maxTokensSetting = settings.find((s) => s.key === "LLM_MAX_TOKENS")?.value ?? "4096";

  let providerId = "";
  if (embeddingProviderSetting && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(embeddingProviderSetting)) {
    providerId = embeddingProviderSetting;
  } else if (embeddingProviderSetting === "local" || embeddingProviderSetting === "ollama") {
    const fallbackProvider = providers.find((p) => p.type === "ollama" && p.isEnabled && p.models?.some((m) => m.isEmbedding && m.isEnabled && m.isAvailable));
    if (fallbackProvider) {
      providerId = fallbackProvider.id;
    }
  }

  let model = embeddingModelSetting;
  const provider = providers.find((p) => p.id === providerId);
  if (provider) {
    const modelExists = provider.models?.some((m) => m.name === embeddingModelSetting && m.isEmbedding && m.isEnabled && m.isAvailable);
    if (!modelExists) {
      const firstEmbeddingModel = provider.models?.find((m) => m.isEmbedding && m.isEnabled && m.isAvailable);
      if (firstEmbeddingModel) {
        model = firstEmbeddingModel.name;
      } else {
        model = "";
      }
    }
  }

  const initialValues: LLMFormValues = {
    temperature: parseFloat(temperatureSetting) || 0.7,
    maxTokens: maxTokensSetting || "4096",
    embeddingProviderId: providerId,
    embeddingModel: model,
  };

  // Form is created ONCE with the correct initial values.
  const form = useForm<LLMFormValues>({
    defaultValues: initialValues,
  });

  const embeddingProviders = providers.filter((p) => p.isEnabled && p.models?.some((m) => m.isEmbedding && m.isEnabled && m.isAvailable));

  const currentProviderId = form.watch("embeddingProviderId");
  const embeddingModels = (() => {
    const provider = providers.find((p) => p.id === currentProviderId);
    return provider?.models?.filter((m) => m.isEmbedding && m.isEnabled && m.isAvailable) || [];
  })();

  const onSubmit = async (data: LLMFormValues) => {
    setSaving(true);
    try {
      const configs: { key: string; value: string }[] = [];

      const addIfNotReadOnly = (key: string, value: string) => {
        if (!isReadOnly(key)) configs.push({ key, value });
      };

      addIfNotReadOnly("LLM_TEMPERATURE", String(data.temperature));
      addIfNotReadOnly("LLM_MAX_TOKENS", data.maxTokens);

      // Map selected providerId back to provider type string for persistence
      const selectedProvider = providers.find((p) => p.id === data.embeddingProviderId);
      const providerType = selectedProvider?.type === "openai" ? "openai" : selectedProvider?.type === "ollama" ? "ollama" : "local";
      addIfNotReadOnly("EMBEDDING_PROVIDER", providerType);

      addIfNotReadOnly("EMBEDDING_MODEL", data.embeddingModel);

      if (configs.length === 0) {
        showInfo(t("settings.llm.allEnvVars"));
        setSaving(false);
        return;
      }

      const result = await updateSettings(configs);
      if (result.rejected.length > 0) {
        showError(t("settings.llm.readOnlyRejected", { keys: result.rejected.join(", ") }));
      } else {
        showSuccess(t("settings.llm.saveSuccess"));
      }
    } catch {
      showError(t("settings.llm.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full space-y-6">
      <h3 className="text-lg font-medium text-foreground">{t("settings.llm.title")}</h3>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          {/* Temperature */}
          <Section title={t("settings.llm.sectionParameters", "Parameters")}>
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="temperature"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t("settings.llm.temperatureLabel")}: {field.value}
                    </FormLabel>
                    <div className="flex items-center gap-2 min-w-0">
                      <FormControl>
                        <Slider
                          min={0}
                          max={2}
                          step={0.1}
                          value={[field.value]}
                          onValueChange={([v]) => field.onChange(v)}
                          disabled={isReadOnly("LLM_TEMPERATURE")}
                          className="flex-1 min-w-0"
                        />
                      </FormControl>
                      {isReadOnly("LLM_TEMPERATURE") && <ReadOnlyBadge />}
                    </div>
                    <FormMessage />
                    <p className="text-xs text-muted-foreground mt-1">{t("settings.llm.temperatureHint")}</p>
                  </FormItem>
                )}
              />

              {/* Max Tokens */}
              <FormField
                control={form.control}
                name="maxTokens"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings.llm.maxTokens")}</FormLabel>
                    <div className="flex items-center gap-2 min-w-0">
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          disabled={isReadOnly("LLM_MAX_TOKENS")}
                          className="flex-1 min-w-0"
                        />
                      </FormControl>
                      {isReadOnly("LLM_MAX_TOKENS") && <ReadOnlyBadge />}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </Section>

          {/* Embedding */}
          <Section title={t("settings.llm.sectionEmbedding")}>
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="embeddingProviderId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings.llm.embeddingProviderLabel")}</FormLabel>
                    <div className="flex items-center gap-2 min-w-0">
                      <FormControl>
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            field.onChange(value);
                            form.setValue("embeddingModel", "");
                          }}
                          disabled={isReadOnly("EMBEDDING_PROVIDER")}
                        >
                          <SelectTrigger className="flex-1 min-w-0">
                            <SelectValue placeholder={t("settings.llm.selectProvider", "Select provider...")} />
                          </SelectTrigger>
                          <SelectContent>
                            {embeddingProviders.map((p) => (
                              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      {isReadOnly("EMBEDDING_PROVIDER") ? (
                        <ReadOnlyBadge />
                      ) : (
                        isEnvOverridden("EMBEDDING_PROVIDER") && <EnvOverriddenBadge />
                      )}
                    </div>
                    <FormMessage />
                    {embeddingProviders.length === 0 && (
                      <p className="text-xs text-muted-foreground mt-1">{t("settings.llm.noEmbeddingProviders", "No providers with embedding models. Add a provider and refresh models, or mark models as embedding in Providers settings.")}</p>
                    )}
                  </FormItem>
                )}
              />

              {currentProviderId && (
                <FormField
                  control={form.control}
                  name="embeddingModel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("settings.llm.embeddingModelLabel", "Embedding Model")}</FormLabel>
                      <div className="flex items-center gap-2 min-w-0">
                        <FormControl>
                          <Select
                            value={field.value}
                            onValueChange={(value) => field.onChange(value)}
                            disabled={isReadOnly("EMBEDDING_MODEL")}
                          >
                            <SelectTrigger className="flex-1 min-w-0">
                              <SelectValue placeholder={t("settings.llm.selectModel", "Select model...")} />
                            </SelectTrigger>
                            <SelectContent>
                              {embeddingModels.map((m) => (
                                <SelectItem key={m.id} value={m.name}>{m.displayName || m.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                        {isReadOnly("EMBEDDING_MODEL") ? (
                          <ReadOnlyBadge />
                        ) : (
                          isEnvOverridden("EMBEDDING_MODEL") && <EnvOverriddenBadge />
                        )}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>
          </Section>

          {/* Save */}
          <div className="pt-4">
            <Button type="submit" disabled={saving}>
              {saving ? t("common.saving") : t("settings.saveChanges")}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-lg border border-input p-5">
      <h4 className="text-sm font-semibold text-foreground mb-4">{title}</h4>
      {children}
    </div>
  );
}
