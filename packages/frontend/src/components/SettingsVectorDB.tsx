// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { showSuccess, showError, showInfo } from "../lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import type { SettingsEntry } from "@simmetric-chat/shared";

type VectorDBProvider = "lancedb" | "qdrant" | "pgvector" | "chroma";

function defaultUrlFor(provider: VectorDBProvider): string {
  switch (provider) {
    case "qdrant": return "http://qdrant:6333";
    case "pgvector": return "postgresql://simmetricchat:simmetricchat@localhost:5432/simmetricchat";
    case "chroma": return "http://chroma:8000";
    default: return "";
  }
}

interface VectorDBFormValues {
  provider: VectorDBProvider;
  url: string;
  apiKey: string;
}

export default function SettingsVectorDB() {
  const { data: settings } = useSettings();
  const { t } = useTranslation();

  if (!settings) {
    return (
      <div className="w-full space-y-6">
        <h3 className="text-lg font-medium text-foreground">
          {t("settings.vectordb.title")}
        </h3>
        <div className="animate-pulse h-32 bg-card rounded-lg border border-input" />
      </div>
    );
  }

  return <SettingsVectorDBForm settings={settings} />;
}

interface SettingsVectorDBFormProps {
  settings: SettingsEntry[];
}

function SettingsVectorDBForm({ settings }: SettingsVectorDBFormProps) {
  const { isReadOnly, isEnvOverridden } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);

  const storedProvider = (settings.find((s) => s.key === "VECTOR_DB_PROVIDER")?.value || "lancedb") as VectorDBProvider;
  const storedUrl = settings.find((s) => s.key === "VECTOR_DB_URL")?.value || "";
  const defaultUrl = defaultUrlFor(storedProvider);
  const initialValues: VectorDBFormValues = {
    provider: storedProvider,
    url: !storedUrl ? defaultUrl : storedUrl,
    apiKey: settings.find((s) => s.key === "VECTOR_DB_API_KEY")?.value || "",
  };

  const form = useForm<VectorDBFormValues>({
    defaultValues: initialValues,
  });

  const provider = form.watch("provider");
  const prevProviderRef = useRef<VectorDBProvider>(storedProvider);

  useEffect(() => {
    if (provider !== prevProviderRef.current) {
      form.setValue("url", defaultUrlFor(provider));
      if (provider === "pgvector") form.setValue("apiKey", "");
      prevProviderRef.current = provider;
    }
  }, [provider, form]);

  const handleSave = form.handleSubmit(async (data) => {
    setSaving(true);
    try {
      const configs: { key: string; value: string }[] = [];
      if (!isReadOnly("VECTOR_DB_PROVIDER")) configs.push({ key: "VECTOR_DB_PROVIDER", value: data.provider });
      if (!isReadOnly("VECTOR_DB_URL")) configs.push({ key: "VECTOR_DB_URL", value: data.url });
      if (!isReadOnly("VECTOR_DB_API_KEY")) configs.push({ key: "VECTOR_DB_API_KEY", value: data.apiKey });

      if (configs.length === 0) {
        showInfo(t("settings.vectordb.allEnvVars"));
        return;
      }

      const result = await updateSettings(configs);
      if (result.rejected.length > 0) {
        showError(t("settings.vectordb.readOnlyRejected", { keys: result.rejected.join(", ") }));
      } else {
        showSuccess(t("settings.vectordb.saveSuccess"));
      }
    } catch {
      showError(t("settings.vectordb.saveFailed"));
    } finally {
      setSaving(false);
    }
  });

  return (
    <div className="w-full space-y-6">
      <h3 className="text-lg font-medium text-foreground">
        {t("settings.vectordb.title")}
      </h3>

      <Form {...form}>
        <form
          onSubmit={handleSave}
          className="bg-card rounded-lg border border-border p-5 space-y-4"
        >
          <FormField
            control={form.control}
            name="provider"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("settings.vectordb.providerLabel")}</FormLabel>
                <div className="flex items-center gap-2 min-w-0">
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(value) =>
                        field.onChange(value as VectorDBProvider)
                      }
                      disabled={isReadOnly("VECTOR_DB_PROVIDER")}
                    >
                      <SelectTrigger className="flex-1 min-w-0 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lancedb">
                          {t("settings.vectordb.providerLancedb")}
                        </SelectItem>
                        <SelectItem value="qdrant">
                          {t("settings.vectordb.providerQdrant")}
                        </SelectItem>
                        <SelectItem value="pgvector">
                          {t("settings.vectordb.providerPgvector")}
                        </SelectItem>
                        <SelectItem value="chroma">
                          {t("settings.vectordb.providerChroma")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  {isReadOnly("VECTOR_DB_PROVIDER") ? (
                    <ReadOnlyBadge />
                  ) : (
                    isEnvOverridden("VECTOR_DB_PROVIDER") && <EnvOverriddenBadge />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {provider === "lancedb" && t("settings.vectordb.lancedbHint")}
                  {provider === "qdrant" && t("settings.vectordb.qdrantHint")}
                  {provider === "pgvector" && t("settings.vectordb.pgvectorHint")}
                  {provider === "chroma" && t("settings.vectordb.chromaHint")}
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          {provider !== "lancedb" && (
            <>
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {provider === "chroma" ? t("settings.vectordb.chromaUrl") :
                       provider === "pgvector" ? t("settings.vectordb.pgvectorUrl") :
                       t("settings.vectordb.qdrantUrl")}
                    </FormLabel>
                    <div className="flex items-center gap-2 min-w-0">
                      <FormControl>
                        <Input
                          type="text"
                          placeholder={
                            provider === "pgvector"
                              ? t("settings.vectordb.pgvectorUrlPlaceholder")
                              : provider === "chroma"
                                ? t("settings.vectordb.chromaUrlPlaceholder")
                                : t("settings.vectordb.qdrantUrlPlaceholder")
                          }
                          disabled={isReadOnly("VECTOR_DB_URL")}
                          className="flex-1 min-w-0"
                          {...field}
                        />
                      </FormControl>
                      {isReadOnly("VECTOR_DB_URL") && <ReadOnlyBadge />}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="apiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {provider === "pgvector" ? t("settings.vectordb.pgvectorApiKey") :
                       provider === "chroma" ? t("settings.vectordb.chromaApiKey") :
                       t("settings.vectordb.qdrantApiKey")}
                    </FormLabel>
                    <div className="flex items-center gap-2 min-w-0">
                      <FormControl>
                        <Input
                          type="password"
                          placeholder={
                            provider === "pgvector"
                              ? t("settings.vectordb.pgvectorApiKeyPlaceholder")
                              : provider === "chroma"
                                ? t("settings.vectordb.chromaApiKeyPlaceholder")
                                : t("settings.vectordb.qdrantApiKeyPlaceholder")
                          }
                          disabled={isReadOnly("VECTOR_DB_API_KEY")}
                          className="flex-1 min-w-0"
                          {...field}
                        />
                      </FormControl>
                      {isReadOnly("VECTOR_DB_API_KEY") && <ReadOnlyBadge />}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}

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
