// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useChatNav } from "../contexts/ChatContext";
import { showSuccess, showError } from "../lib/toast";
import { apiGet, apiPost, apiPut, ApiError } from "../utils/api";
import { getGlobalDefaultModel, setGlobalDefaultModel } from "../utils/modelDefaults";
import {
  useProviders,
  useAvailableModels,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
  useSetDefaultProvider,
  useRefreshModels,
  useUpdateModel,
  useDeleteModel,
  useSetDefaultModel,
} from "../queries/useProviders";
import { pullModel } from "../utils/providerActions";
import ModelSelector from "./ModelSelector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { Provider, ProviderModel, ProviderType } from "@simmetric-chat/shared";
import { providerTypeSchema } from "@simmetric-chat/shared";
import { getErrorMessage } from "../utils/errorUtils";
import ProviderPresetCatalog from "./ProviderPresetCatalog";

const capabilityKeyMap: Record<string, string> = {
  "local-only": "chat.capabilities.localOnly",
  "cloud": "chat.capabilities.cloud",
  "fastest": "chat.capabilities.fastest",
  "smartest": "chat.capabilities.smartest",
  "reasoning": "chat.capabilities.reasoning",
};

const KNOWN_OLLAMA_MODELS = [
  "llama3.1",
  "deepseek-r1",
  "nomic-embed-text",
  "llama3.2",
  "gemma3",
  "qwen2.5",
  "qwen3",
  "mistral",
  "gemma2",
  "llama3",
  "gemma4",
  "qwen2.5-coder",
  "phi3",
  "qwen3.5",
  "llava",
  "mxbai-embed-large",
  "gpt-oss",
  "qwen3-coder",
  "phi4",
  "qwen",
  "llama2",
  "gemma",
  "glm-ocr",
  "qwen2",
  "codellama",
  "mistral-nemo",
  "bge-m3",
  "minicpm-v",
  "tinyllama",
  "qwen3.6",
  "qwen3-vl",
  "llama3.2-vision",
  "deepseek-coder",
  "llama3.3",
  "dolphin3",
  "smollm2",
  "deepseek-v3",
  "qwen2.5vl",
  "olmo2",
  "qwen3-embedding",
  "codegemma",
  "snowflake-arctic-embed",
  "mistral-small",
  "granite3.1-moe",
  "orca-mini",
  "deepseek-coder-v2",
  "starcoder2",
  "nemotron-3-super",
  "mixtral",
  "llama2-uncensored",
  "falcon3",
  "mistral-small3.2",
  "minimax-m2.7",
  "llava-llama3",
  "glm-5.1",
  "qwq",
  "cogito",
  "smollm",
  "dolphin-llama3",
  "gemma3n",
  "translategemma",
  "qwen3-coder-next",
  "dolphin-mixtral",
  "llama4",
  "phi4-reasoning",
  "dolphin-mistral",
  "gemma",
  "dolphin-phi",
  "hermes3",
  "phi",
  "moondream",
  "command-r",
  "granite-code",
  "magistral",
  "granite4",
  "glm-4.7-flash",
  "sqlcoder",
  "ministral-3",
  "phi4-mini",
  "yi",
  "codestral",
  "mistral-large",
  "deepscaler",
  "lfm2.5-thinking",
  "wizard-vicuna-uncensored",
  "zephyr",
  "openchat",
  "starcoder",
  "glm4",
  "wizardlm2",
  "nous-hermes",
  "deepseek-v2",
  "vicuna",
  "deepseek-llm",
  "openthinker",
  "falcon",
  "lfm2",
  "codeqwen",
  "openhermes",
  "qwen2-math",
  "granite3.3",
  "neural-chat",
  "aya",
  "nous-hermes2",
  "llama2-chinese",
  "stable-code",
  "yi-coder",
  "wizardcoder",
  "stablelm2",
  "llama3-chatqa",
  "llama-guard3",
  "granite3-dense",
  "granite3.1-dense",
  "phi3.5",
  "wizard-math",
  "devstral",
  "dolphincoder",
  "internlm2",
  "aya-expanse",
  "llama3-gradient",
  "samantha-mistral",
  "llama3-groq-tool-use",
  "granite3.2-vision",
  "xwinlm",
  "starling-lm",
  "phind-codellama",
  "yarn-llama2",
  "solar",
  "deepcoder",
  "granite3-moe",
  "paraphrase-multilingual",
  "devstral-small-2",
  "stable-beluga",
  "orca2",
  "reader-lm",
  "shieldgemma",
  "llama-pro",
  "yarn-mistral",
  "nexusraven",
  "wizardlm",
  "bakllava",
  "meditron",
  "command-r-plus",
  "mistral-small3.1",
  "exaone-deep",
  "deepseek-v3.1",
  "tinydolphin",
  "nemotron-mini",
  "codegeex4",
  "mistral-openorca",
  "nemotron-3-nano",
  "nomic-embed-text-v2-moe",
  "medllama2",
  "wizardlm-uncensored",
  "nemotron3",
  "opencoder",
  "reflection",
  "nemotron",
  "codeup",
  "nous-hermes2-mixtral",
  "athene-v2",
  "qwen3-next",
  "megadolphin",
  "everythinglm",
  "solar-pro",
  "magicoder",
  "exaone3.5",
  "mathstral",
  "falcon2",
  "notus",
  "notux",
  "nuextract",
  "stablelm-zephyr",
  "bespoke-minicheck",
  "mistrallite",
  "firefunction-v2",
  "wizard-vicuna",
  "deepseek-ocr",
  "rnj-1",
  "open-orca-platypus2",
  "codebooga",
  "goliath",
  "granite3.2",
  "olmo-3",
  "snowflake-arctic-embed2",
  "kimi-k2.6",
  "r1-1776",
  "sailor2",
  "tulu3",
  "minimax-m3",
  "dbrx",
  "devstral-2",
  "granite-embedding",
  "ornith",
  "granite3-guardian",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "granite4.1",
  "llava-phi3",
  "mistral-medium-3.5",
  "glm-5.2",
  "command-r7b",
  "phi4-mini-reasoning",
  "deepseek-v2.5",
  "olmo-3.1",
  "smallthinker",
  "medgemma",
  "alfred",
  "command-a",
  "cogito-2.1",
  "marco-o1",
  "kimi-k2.7-code",
  "command-r7b-arabic",
  "functiongemma",
  "gpt-oss-safeguard",
  "nemotron-cascade-2",
  "medgemma1.5",
  "lfm2.5",
  "mistral-large-3",
  "laguna-xs-2.1",
  "laguna-s-2.1",
  "nemotron-3-ultra",
  "north-mini-code-1.0",
  "minicpm-v4.6",
  "kimi-k3",
  "laguna-xs.2",
  "minicpm-v4.5",
  "granite4.1-guardian",
];

const createProviderSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: providerTypeSchema,
  baseUrl: z.string().min(1, "Base URL is required"),
  apiKey: z.string().optional(),
});

type CreateProviderValues = z.infer<typeof createProviderSchema>;

export default function SettingsProviders() {
  const { t } = useTranslation();
  const { data: providers = [], isLoading: loading, error } = useProviders();
  const createProviderMutation = useCreateProvider();
  const updateProviderMutation = useUpdateProvider();
  const queryClient = useQueryClient();
  const deleteProviderMutation = useDeleteProvider();
  const setDefaultMutation = useSetDefaultProvider();
  const setDefaultModelMutation = useSetDefaultModel();
  const refreshModelsMutation = useRefreshModels();
  const updateModelMutation = useUpdateModel();
  const deleteModelMutation = useDeleteModel();

  const [showCreate, setShowCreate] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [defaultModel, setDefaultModel] = useState<{ providerId?: string; model?: string } | null>(null);
  const [planMode, setPlanMode] = useState(false);

  interface PullProgress { status: string; digest?: string; total?: number; completed?: number }
  const [pulling, setPulling] = useState<{ providerId: string; modelName: string; progress: PullProgress | null; error: string | null } | null>(null);
  const [providerToDelete, setProviderToDelete] = useState<string | null>(null);
  const [modelToDelete, setModelToDelete] = useState<{ providerId: string; modelId: string } | null>(null);

  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editProviderName, setEditProviderName] = useState("");
  const [editProviderBaseUrl, setEditProviderBaseUrl] = useState("");
  const [editProviderApiKey, setEditProviderApiKey] = useState("");

  const { currentWorkspaceId } = useChatNav();

  // Load workspace agent config when workspace changes
  useEffect(() => {
    if (!currentWorkspaceId) {
      setDefaultModel(getGlobalDefaultModel());
      return;
    }
    apiGet<{ providerId?: string | null; model?: string; planMode?: boolean }>(`/workspaces/${currentWorkspaceId}/agent-config`)
      .then((config) => {
        if (config.providerId) {
          setDefaultModel({ providerId: config.providerId, model: config.model || undefined });
        } else {
          setDefaultModel(getGlobalDefaultModel());
        }
        setPlanMode(Boolean(config.planMode));
      })
      .catch(() => {
        setDefaultModel(getGlobalDefaultModel());
        setPlanMode(false);
      });
  }, [currentWorkspaceId]);

  const handleDefaultModelChange = async (selection: { providerId?: string; model?: string } | null) => {
    // Always update local state and global default
    setDefaultModel(selection);
    if (selection?.providerId) {
      setGlobalDefaultModel({ providerId: selection.providerId, model: selection.model || "" });
      // Make the corresponding provider the default provider
      try {
        await setDefaultMutation.mutateAsync(selection.providerId);
      } catch {
        // Non-blocking: model selection still works even if provider default fails
      }
      // Also set the specific model as default
      if (selection.model) {
        try {
          // Find the model ID from available models
          const availableModels = queryClient.getQueryData<Array<{ id: string; providerId: string; name: string }>>(["providers", "available"]);
          const modelObj = availableModels?.find((m) => m.providerId === selection.providerId && m.name === selection.model);
          if (modelObj) {
            await setDefaultModelMutation.mutateAsync({ providerId: modelObj.providerId, modelId: modelObj.id });
          }
        } catch {
          // Non-blocking
        }
      }
    } else {
      setGlobalDefaultModel(null);
    }
    // Persist to workspace API when a workspace is selected
    if (currentWorkspaceId) {
      try {
        await apiPut(`/workspaces/${currentWorkspaceId}/agent-config`, {
          providerId: selection?.providerId ?? null,
          model: selection?.model ?? null,
        });
      } catch {
        showError(t("settings.agent.defaultModelError", "Failed to save default model"));
      }
    }
  };

  const handleTogglePlanMode = async (enabled: boolean) => {
    setPlanMode(enabled);
    if (!currentWorkspaceId) return;
    try {
      await apiPut(`/workspaces/${currentWorkspaceId}/agent-config`, { planMode: enabled });
    } catch {
      setPlanMode(!enabled);
      showError(t("settings.agent.planModeError", "Failed to toggle plan mode"));
    }
  };

  const handleCreate = async (data: CreateProviderValues) => {
    try {
      await createProviderMutation.mutateAsync(data as { name: string; type: ProviderType; baseUrl: string; apiKey?: string });
      showSuccess(t("settings.providers.created"));
      setShowCreate(false);
    } catch {
      showError(t("settings.providers.createFailed"));
    }
  };

  const handleDelete = (id: string) => {
    setProviderToDelete(id);
  };

  const confirmDelete = async () => {
    if (!providerToDelete) return;
    try {
      await deleteProviderMutation.mutateAsync(providerToDelete);
      showSuccess(t("settings.providers.deleted"));
      if (expandedProvider === providerToDelete) setExpandedProvider(null);
    } catch {
      showError(t("settings.providers.deleteFailed"));
    } finally {
      setProviderToDelete(null);
    }
  };

  const confirmDeleteModel = async () => {
    if (!modelToDelete) return;
    try {
      await deleteModelMutation.mutateAsync(modelToDelete);
      showSuccess(t("settings.providers.modelDeleted", "Model deleted"));
    } catch {
      showError(t("settings.providers.deleteFailed"));
    } finally {
      setModelToDelete(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await setDefaultMutation.mutateAsync(id);
      showSuccess(t("settings.providers.updated"));
    } catch {
      showError(t("settings.providers.updateFailed"));
    }
  };

  const handleToggleEnabled = async (id: string, isEnabled: boolean) => {
    try {
      await updateProviderMutation.mutateAsync({ id, data: { isEnabled } });
      showSuccess(t("settings.providers.updated"));
    } catch {
      showError(t("settings.providers.updateFailed"));
    }
  };

  const handleStartEditProvider = (provider: Provider) => {
    setEditingProviderId(provider.id);
    setEditProviderName(provider.name);
    setEditProviderBaseUrl(provider.baseUrl);
    setEditProviderApiKey("");
  };

  const handleSaveProviderEdit = async (id: string) => {
    try {
      const data: { name?: string; baseUrl?: string; apiKey?: string } = {
        name: editProviderName,
        baseUrl: editProviderBaseUrl,
      };
      if (editProviderApiKey.trim()) {
        data.apiKey = editProviderApiKey.trim();
      }
      await updateProviderMutation.mutateAsync({ id, data });
      showSuccess(t("settings.providers.updated"));
      setEditingProviderId(null);
      setEditProviderName("");
      setEditProviderBaseUrl("");
      setEditProviderApiKey("");
    } catch {
      showError(t("settings.providers.updateFailed"));
    }
  };

  const handleCancelProviderEdit = () => {
    setEditingProviderId(null);
    setEditProviderName("");
    setEditProviderBaseUrl("");
    setEditProviderApiKey("");
  };

  const handleRefresh = async (id: string) => {
    try {
      const result = await refreshModelsMutation.mutateAsync(id);
      showSuccess(t("settings.providers.refreshed", { count: result.refreshed }));
    } catch {
      showError(t("settings.providers.refreshFailed"));
    }
  };

  const handlePullModel = async (providerId: string, modelName: string) => {
    setPulling({ providerId, modelName, progress: null, error: null });
    try {
      await pullModel(providerId, modelName, (progress) => {
        setPulling((prev) => prev ? { ...prev, progress } : null);
      });
      showSuccess(t("settings.providers.downloadSuccess", "Model downloaded successfully"));
    } catch (err: unknown) {
      setPulling((prev) => prev ? { ...prev, error: getErrorMessage(err) } : null);
      showError(getErrorMessage(err, t("settings.providers.downloadFailed", "Download failed")));
    } finally {
      setPulling(null);
    }
  };

  const handleToggleModel = async (providerId: string, modelId: string, enabled: boolean) => {
    try {
      await updateModelMutation.mutateAsync({ providerId, modelId, data: { isEnabled: enabled } });
    } catch {
      showError(t("settings.providers.updateFailed"));
    }
  };

  const handleToggleEmbedding = async (providerId: string, modelId: string, isEmbedding: boolean) => {
    try {
      await updateModelMutation.mutateAsync({ providerId, modelId, data: { isEmbedding } });
    } catch {
      showError(t("settings.providers.updateFailed"));
    }
  };

  const handleToggleOcr = async (providerId: string, modelId: string, isOcr: boolean) => {
    try {
      await updateModelMutation.mutateAsync({ providerId, modelId, data: { isOcr } });
    } catch {
      showError(t("settings.providers.updateFailed"));
    }
  };

  const handleSaveDisplayName = async (providerId: string, modelId: string) => {
    try {
      await updateModelMutation.mutateAsync({ providerId, modelId, data: { displayName: editDisplayName || null } });
      setEditingModel(null);
      setEditDisplayName("");
    } catch {
      showError(t("settings.providers.updateFailed"));
    }
  };

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl">
        <div className="bg-destructive/10 text-destructive rounded-lg p-4 text-sm">
          {error?.message ?? String(error)}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">
          {t("settings.providers.title")}
        </h3>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowCatalog(true)}
          >
            {t("providerPreset.addFromCatalog")}
          </Button>
          <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
            {t("settings.providers.addProvider")}
          </Button>
        </div>
      </div>

      <ProviderPresetCatalog open={showCatalog} onOpenChange={setShowCatalog} />

      <div className="bg-card rounded-lg border border-input p-4">
        <label className="block text-sm font-medium text-foreground mb-1">
          {t("settings.agent.defaultModel")}
        </label>
        <p className="text-xs text-muted-foreground mb-3">
          {t("settings.agent.defaultModelHint")}
        </p>
        <ModelSelector
          value={defaultModel}
          onChange={handleDefaultModelChange}
        />
      </div>

      <div className="bg-card rounded-lg border border-input p-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label className="block text-sm font-medium text-foreground mb-1">
            {t("settings.agent.planMode")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("settings.agent.planModeHint")}
          </p>
        </div>
        <Switch
          aria-checked={planMode}
          onCheckedChange={() => handleTogglePlanMode(!planMode)}
          aria-label={t("config.autoIndex")}
        />
      </div>

      {showCreate && (
        <CreateProviderForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {providers.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {t("settings.providers.noProviders")}
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isExpanded={expandedProvider === provider.id}
              onToggleExpand={() =>
                setExpandedProvider(
                  expandedProvider === provider.id ? null : provider.id,
                )
              }
              onSetDefault={() => handleSetDefault(provider.id)}
              onToggleEnabled={(enabled) =>
                handleToggleEnabled(provider.id, enabled)
              }
              onDelete={() => handleDelete(provider.id)}
              onRefresh={() => handleRefresh(provider.id)}
              onStartEdit={() => handleStartEditProvider(provider)}
              onSaveEdit={() => handleSaveProviderEdit(provider.id)}
              onCancelEdit={handleCancelProviderEdit}
              isEditingProvider={editingProviderId === provider.id}
              editProviderName={editProviderName}
              editProviderBaseUrl={editProviderBaseUrl}
              editProviderApiKey={editProviderApiKey}
              onEditProviderNameChange={setEditProviderName}
              onEditProviderBaseUrlChange={setEditProviderBaseUrl}
              onEditProviderApiKeyChange={setEditProviderApiKey}
              onToggleModel={(modelId, enabled) =>
                handleToggleModel(provider.id, modelId, enabled)
              }
              onToggleEmbedding={(modelId, isEmbedding) =>
                handleToggleEmbedding(provider.id, modelId, isEmbedding)
              }
              onToggleOcr={(modelId, isOcr) =>
                handleToggleOcr(provider.id, modelId, isOcr)
              }
              onUpdateModel={(modelId, data) =>
                updateModelMutation.mutateAsync({
                  providerId: provider.id,
                  modelId,
                  data,
                })
              }
              editingModel={editingModel}
              editDisplayName={editDisplayName}
              onEditModel={(modelId, currentName) => {
                setEditingModel(modelId);
                setEditDisplayName(currentName || "");
              }}
              onSaveDisplayName={(modelId) =>
                handleSaveDisplayName(provider.id, modelId)
              }
              onEditDisplayNameChange={setEditDisplayName}
              onDeleteModel={(modelId) =>
                setModelToDelete({ providerId: provider.id, modelId })
              }
              onPullModel={(modelName) =>
                handlePullModel(provider.id, modelName)
              }
              pulling={pulling?.providerId === provider.id ? pulling : null}
            />
          ))}
        </div>
      )}

      <AlertDialog
        open={!!providerToDelete}
        onOpenChange={(open) => !open && setProviderToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.providers.deleteConfirmTitle", "Delete Provider")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "settings.providers.deleteConfirmBody",
                "This will permanently delete the provider and all its models. This action cannot be undone.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("common.cancel", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings.providers.deleteConfirmAction", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!modelToDelete}
        onOpenChange={(open) => !open && setModelToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.providers.deleteModelConfirmTitle", "Delete Model")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "settings.providers.deleteModelConfirmBody",
                "This will permanently delete the model. This action cannot be undone.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("common.cancel", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteModel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProviderCard({
  provider,
  isExpanded,
  onToggleExpand,
  onSetDefault,
  onToggleEnabled,
  onDelete,
  onRefresh,
  onToggleModel,
  onToggleEmbedding,
  onToggleOcr,
  onUpdateModel,
  editingModel,
  editDisplayName,
  onEditModel,
  onSaveDisplayName,
  onEditDisplayNameChange,
  onDeleteModel,
  onPullModel,
  pulling,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  isEditingProvider,
  editProviderName,
  editProviderBaseUrl,
  editProviderApiKey,
  onEditProviderNameChange,
  onEditProviderBaseUrlChange,
  onEditProviderApiKeyChange,
}: {
  provider: Provider;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSetDefault: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  onRefresh: () => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
  onToggleEmbedding: (modelId: string, isEmbedding: boolean) => void;
  onToggleOcr: (modelId: string, isOcr: boolean) => void;
  onUpdateModel: (modelId: string, data: { temperature?: number | null; maxTokens?: number | null }) => void;
  editingModel: string | null;
  editDisplayName: string;
  onEditModel: (modelId: string, currentName: string | null) => void;
  onSaveDisplayName: (modelId: string) => void;
  onEditDisplayNameChange: (value: string) => void;
  onDeleteModel: (modelId: string) => void;
  onPullModel: (modelName: string) => void;
  pulling: { providerId: string; modelName: string; progress: { status: string; digest?: string; total?: number; completed?: number } | null; error: string | null } | null;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  isEditingProvider: boolean;
  editProviderName: string;
  editProviderBaseUrl: string;
  editProviderApiKey: string;
  onEditProviderNameChange: (value: string) => void;
  onEditProviderBaseUrlChange: (value: string) => void;
  onEditProviderApiKeyChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const models = provider.models || [];
  const typeIcon = provider.type === "ollama" ? "🏠" : provider.type === "openai" ? "☁️" : provider.type === "openrouter" ? "🌐" : "🤖";

  return (
    <div className="bg-card rounded-lg border border-input overflow-hidden">
      <div
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-accent transition-colors"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">{typeIcon}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">
                {provider.name}
              </span>
              {provider.isDefault && (
                <Badge variant="default" className="text-xs">
                  {t("settings.providers.defaultBadge")}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground uppercase">
                {provider.type}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {provider.baseUrl}
              {provider.lastError && (
                <span className="text-destructive ml-2">
                  ⚠ {provider.lastError}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Switch
                  aria-checked={provider.isEnabled}
                  onCheckedChange={(checked) => onToggleEnabled(checked)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={t(
                    "settings.providers.toggleEnabled",
                    "Toggle provider",
                  )}
                />
              </TooltipTrigger>
              <TooltipContent>
                {provider.isEnabled
                  ? t(
                      "settings.providers.enabledTooltip",
                      "Provider enabled — click to disable",
                    )
                  : t(
                      "settings.providers.disabledTooltip",
                      "Provider disabled — click to enable",
                    )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <svg
            className={`w-5 h-5 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-input p-4 space-y-3">
          {isEditingProvider ? (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">
                {t("settings.providers.editProviderTitle", "Edit Provider")}
              </h4>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t("settings.providers.nameLabel")}
                  </label>
                  <Input
                    type="text"
                    value={editProviderName}
                    onChange={(e) => onEditProviderNameChange(e.target.value)}
                    placeholder={t("settings.providers.namePlaceholder")}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t("settings.providers.baseUrlLabel")}
                  </label>
                  <Input
                    type="text"
                    value={editProviderBaseUrl}
                    onChange={(e) =>
                      onEditProviderBaseUrlChange(e.target.value)
                    }
                    placeholder={t("settings.providers.baseUrlPlaceholder")}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t("settings.providers.apiKeyLabel")}
                  </label>
                  <Input
                    type="password"
                    value={editProviderApiKey}
                    onChange={(e) => onEditProviderApiKeyChange(e.target.value)}
                    placeholder={t(
                      "settings.providers.apiKeyPlaceholderEdit",
                      "Leave blank to keep current key",
                    )}
                    className="w-full"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={onSaveEdit}>
                  {t("settings.providers.saveChanges", "Save Changes")}
                </Button>
                <Button variant="outline" size="sm" onClick={onCancelEdit}>
                  {t("settings.providers.cancelEdit", "Cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {!provider.isDefault && (
                  <Button variant="outline" size="sm" onClick={onSetDefault}>
                    {t("settings.providers.setDefault")}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onRefresh}>
                  {t("settings.providers.refreshModels")}
                </Button>
                <Button variant="outline" size="sm" onClick={onStartEdit}>
                  {t("settings.providers.editProvider", "Edit")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDelete}
                  className="ml-auto border-destructive text-destructive hover:bg-destructive/10"
                >
                  {t("settings.providers.deleteConfirm")}
                </Button>
              </div>

              {provider.type === "ollama" && (
                <div className="space-y-3">
                  <OllamaCloudLogin providerId={provider.id} t={t} />
                  <OllamaDownloadSection
                    onPullModel={onPullModel}
                    pulling={pulling}
                    t={t}
                  />
                </div>
              )}

              <div>
                <h5 className="text-sm font-medium text-foreground mb-2">
                  {t("settings.providers.models")}
                </h5>
                {models.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("settings.providers.noModels")}
                  </p>
                ) : (
                  <div className="space-y-1.5 overflow-x-auto">
                    <div className="flex items-center gap-3 py-1 px-2 border-b border-input mb-1">
                      <span className="flex text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {t("settings.providers.colEnabled")}
                      </span>
                      <span className="flex text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {t("settings.providers.colEmbedding")}
                      </span>
                      <span className="flex text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {t("settings.providers.colOcr")}
                      </span>
                      <span className="flex-1 min-w-0 text-xs font-medium text-muted-foreground">
                        {t("settings.providers.colModel")}
                      </span>
                      <span className="flex text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {t("settings.providers.colParams")}
                      </span>
                      <span className="flex text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {t("settings.providers.colType")}
                      </span>
                      <span className="flex text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {t("settings.providers.colEdit")}
                      </span>
                      <span className="flex text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {t("settings.providers.colDelete")}
                      </span>
                    </div>
                    {models.map((model) => (
                      <ModelRow
                        key={model.id}
                        model={model}
                        providerId={provider.id}
                        providerType={provider.type}
                        providerApiKey={provider.apiKey}
                        isEditing={editingModel === model.id}
                        editDisplayName={editDisplayName}
                        onToggle={(enabled) => onToggleModel(model.id, enabled)}
                        onToggleEmbedding={(isEmbedding) =>
                          onToggleEmbedding(model.id, isEmbedding)
                        }
                        onToggleOcr={(isOcr) => onToggleOcr(model.id, isOcr)}
                        onUpdate={(data) => onUpdateModel(model.id, data)}
                        onEdit={() => onEditModel(model.id, model.displayName)}
                        onSaveDisplayName={() => onSaveDisplayName(model.id)}
                        onEditDisplayNameChange={onEditDisplayNameChange}
                        onDelete={() => onDeleteModel(model.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OllamaDownloadSection({
  onPullModel,
  pulling,
  t,
}: {
  onPullModel: (modelName: string) => void;
  pulling: { providerId: string; modelName: string; progress: { status: string; digest?: string; total?: number; completed?: number } | null; error: string | null } | null;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [modelName, setModelName] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = modelName.trim()
    ? KNOWN_OLLAMA_MODELS.filter((m) =>
        m.toLowerCase().includes(modelName.toLowerCase())
      )
    : KNOWN_OLLAMA_MODELS.slice(0, 8);

  const handleDownload = () => {
    const trimmed = modelName.trim();
    if (!trimmed) return;
    onPullModel(trimmed);
    setModelName("");
    setShowSuggestions(false);
  };

  const handleSelect = (name: string) => {
    setModelName(name);
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) {
      if (e.key === "Enter") handleDownload();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % filtered.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
        break;
      case "Enter":
        e.preventDefault();
        if (filtered.length > 0) {
          const selected = filtered[activeIndex];
          if (selected) handleSelect(selected);
        } else {
          handleDownload();
        }
        break;
      case "Escape":
        setShowSuggestions(false);
        break;
    }
  };

  useEffect(() => {
    setActiveIndex(0);
  }, [modelName]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const progress = pulling?.progress;
  const percent = progress?.total && progress?.completed
    ? Math.round((progress.completed / progress.total) * 100)
    : null;

  return (
    <div className="space-y-2">
      <h5 className="text-sm font-medium text-foreground">
        {t("settings.providers.downloadModel", "Download Model")}
      </h5>
      {pulling ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
            <span className="text-xs text-muted-foreground">
              {progress?.status ||
                t("settings.providers.downloading", "Downloading...")}{" "}
              {pulling.modelName}
            </span>
            {percent !== null && (
              <span className="text-xs text-primary font-medium">
                {percent}%
              </span>
            )}
          </div>
          {percent !== null && (
            <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-primary h-full rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          {pulling.error && (
            <p className="text-xs text-destructive">{pulling.error}</p>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div ref={containerRef} className="flex-1 relative">
            <Input
              ref={inputRef}
              type="text"
              value={modelName}
              onChange={(e) => {
                setModelName(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onKeyDown={handleKeyDown}
              placeholder={t(
                "settings.providers.modelNamePlaceholder",
                "e.g., gemma4:latest",
              )}
              className="w-full px-3 py-1.5 text-sm"
            />
            {showSuggestions && filtered.length > 0 && (
              <div className="absolute z-50 w-full mt-1 bg-[var(--popover)] text-[var(--popover-foreground)] border border-[var(--border)] rounded-md shadow-lg max-h-48 overflow-y-auto">
                {filtered.map((m, idx) => (
                  <div
                    key={m}
                    className={`px-3 py-1.5 text-sm cursor-pointer ${
                      idx === activeIndex
                        ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                        : ""
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelect(m);
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    {m}
                  </div>
                ))}
              </div>
            )}
          </div>
          <Button
            size="sm"
            onClick={handleDownload}
            disabled={!modelName.trim()}
          >
            {t("settings.providers.download", "Download")}
          </Button>
        </div>
      )}
    </div>
  );
}

function OllamaCloudLogin({
  providerId,
  t,
}: {
  providerId: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [loginState, setLoginState] = useState<"idle" | "pending" | "authenticated" | "error">("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const handleCloudLogin = async () => {
    setLoginState("pending");
    try {
      const result = await apiPost<{ status: "pending" | "authenticated"; connectUrl?: string }>(
        `/providers/${providerId}/ollama-login`,
        {},
      );
      if (result.status === "authenticated") {
        setLoginState("authenticated");
        showSuccess(t("settings.providers.ollamaCloudLoginSuccess"));
        return;
      }
      if (result.status === "pending" && result.connectUrl) {
        window.open(result.connectUrl, "_blank", "noopener,noreferrer");
        pollRef.current = setInterval(async () => {
          try {
            const status = await apiGet<{ status: "pending" | "authenticated"; connectUrl?: string }>(
              `/providers/${providerId}/ollama-login/status`,
            );
            if (status.status === "authenticated") {
              setLoginState("authenticated");
              showSuccess(t("settings.providers.ollamaCloudLoginSuccess"));
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
            }
          } catch {
            // Transient polling errors — keep polling.
          }
        }, 3000);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 501) {
        showError(t("settings.providers.ollamaCloudLoginNotDocker"));
      } else {
        showError(t("settings.providers.ollamaCloudLoginError"));
      }
      setLoginState("error");
    }
  };

  if (loginState === "authenticated") {
    return (
      <Button variant="outline" size="sm" disabled className="text-green-600 border-green-300 dark:text-green-400 dark:border-green-800">
        ✓ {t("settings.providers.ollamaCloudLoginSuccess")}
      </Button>
    );
  }

  if (loginState === "pending") {
    return (
      <Button variant="outline" size="sm" disabled>
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary mr-2" />
        {t("settings.providers.ollamaCloudLoginPending")}
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={handleCloudLogin}>
      {t("settings.providers.ollamaCloudLogin")}
    </Button>
  );
}

function ModelRow({
  model,
  providerId,
  providerType,
  providerApiKey,
  isEditing,
  editDisplayName,
  onToggle,
  onToggleEmbedding,
  onToggleOcr,
  onUpdate,
  onEdit,
  onSaveDisplayName,
  onEditDisplayNameChange,
  onDelete,
}: {
  model: ProviderModel;
  providerId: string;
  providerType: string;
  providerApiKey: string | null;
  isEditing: boolean;
  editDisplayName: string;
  onToggle: (enabled: boolean) => void;
  onToggleEmbedding: (isEmbedding: boolean) => void;
  onToggleOcr: (isOcr: boolean) => void;
  onUpdate: (data: { temperature?: number | null; maxTokens?: number | null }) => void;
  onEdit: () => void;
  onSaveDisplayName: () => void;
  onEditDisplayNameChange: (value: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isActuallyLocal = providerType === "ollama" ? !providerApiKey : false;
  const { data: availableModels = [] } = useAvailableModels();
  const capabilities = availableModels.find(
    (m) => m.name === model.name && m.providerId === providerId
  )?.capabilities || [];

  return (
    <div className="flex items-center gap-3 py-1.5 px-2 rounded hover:bg-accent group">
      <Checkbox
        checked={model.isEnabled}
        onCheckedChange={(checked) => onToggle(Boolean(checked))}
        aria-label={t("settings.providers.toggleModel", "Toggle model")}
      />

      <Checkbox
        checked={model.isEmbedding}
        onCheckedChange={(checked) => onToggleEmbedding(Boolean(checked))}
        aria-label={t("settings.providers.embeddingToggle", "Embedding model")}
      />

      <Checkbox
        checked={model.isOcr}
        onCheckedChange={(checked) => onToggleOcr(Boolean(checked))}
        aria-label={t("settings.providers.ocrToggle", "OCR model")}
      />

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={editDisplayName}
              onChange={(e) => onEditDisplayNameChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSaveDisplayName()}
              placeholder={t("settings.providers.displayNamePlaceholder")}
              className="flex-1 px-2 py-1 h-auto text-sm"
              autoFocus
            />
            <Button variant="link" size="sm" onClick={onSaveDisplayName}>
              ✓
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-foreground truncate">
                {model.displayName || model.name}
              </span>
              {model.displayName && model.displayName !== model.name && (
                <span className="text-xs text-muted-foreground truncate">({model.name})</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <label className="text-xs text-muted-foreground">{t("settings.providers.temperature", "Temp")}</label>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={model.temperature ?? 0.7}
                  onChange={(e) => onUpdate({ temperature: parseFloat(e.target.value) })}
                  className="w-20"
                />
                <span className="text-xs text-foreground w-6">{model.temperature ?? 0.7}</span>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <label className="text-xs text-muted-foreground">{t("settings.providers.maxTokens", "Max")}</label>
                <Input
                  type="number"
                  min={1}
                  max={100000}
                  value={String(model.maxTokens ?? "")}
                  placeholder="4096"
                  onChange={(e) => onUpdate({ maxTokens: e.target.value === "" ? null : parseInt(e.target.value, 10) })}
                  className="w-16 px-1 py-0.5 h-auto text-xs"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Badge className={`text-xs ${
          isActuallyLocal
            ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        }`}>
          {isActuallyLocal ? t("settings.providers.modelLocal") : t("settings.providers.modelCloud")}
        </Badge>
        {capabilities.map((tag) => (
          <Badge
            key={tag}
            className={`text-xs ${
              tag === "local-only"
                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                : tag === "cloud"
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                  : tag === "fastest"
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  : tag === "smartest"
                    ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
                    : tag === "reasoning"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                      : "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400"
            }`}
          >
            {t(capabilityKeyMap[tag] || tag)}
          </Badge>
        ))}
        {!model.isAvailable && (
          <span className="text-xs text-muted-foreground italic">
            {t("settings.providers.modelUnavailable")}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onEdit}
          className="opacity-0 group-hover:opacity-100 transition-opacity"
          title={t("settings.providers.displayNamePlaceholder")}
        >
          ✏️
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDelete}
          className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          ✕
        </Button>
      </div>
    </div>
  );
}

function CreateProviderForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (data: CreateProviderValues) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const form = useForm<CreateProviderValues>({
    resolver: zodResolver(createProviderSchema),
    defaultValues: {
      name: "Ollama",
      type: "ollama",
      baseUrl: "http://ollama:11434",
      apiKey: "",
    },
  });

  const watchType = form.watch("type");

  useEffect(() => {
    const type = form.getValues("type");
    switch (type) {
      case "ollama":
        form.setValue("name", "Ollama");
        form.setValue("baseUrl", "http://ollama:11434");
        break;
      case "openai":
        form.setValue("name", "OpenAI");
        form.setValue("baseUrl", "https://api.openai.com");
        break;
      case "anthropic":
        form.setValue("name", "Anthropic");
        form.setValue("baseUrl", "https://api.anthropic.com");
        break;
      case "openrouter":
        form.setValue("name", "OpenRouter");
        form.setValue("baseUrl", "https://openrouter.ai/api");
        break;
      case "gemini":
        form.setValue("name", "Gemini");
        form.setValue("baseUrl", "https://generativelanguage.googleapis.com");
        break;
      case "xiaomi":
        form.setValue("name", "Xiaomi MiMo");
        form.setValue("baseUrl", "https://api.xiaomi.com/mimo/v1");
        break;
      case "minimax":
        form.setValue("name", "MiniMax");
        form.setValue("baseUrl", "https://api.minimaxi.com/v1");
        break;
    }
  }, [watchType, form]);

  const handleSubmit = form.handleSubmit((data) => {
    onSubmit({
      ...data,
      name: data.name || `${data.type.charAt(0).toUpperCase() + data.type.slice(1)} Provider`,
    });
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="bg-card rounded-lg border border-input p-5 space-y-4">
        <h4 className="text-sm font-semibold text-foreground">{t("settings.providers.createProvider")}</h4>

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("settings.providers.nameLabel")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  placeholder={t("settings.providers.namePlaceholder")}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("settings.providers.typeLabel")}</FormLabel>
              <FormControl>
                <Select
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    const newType = value as ProviderType;
                    switch (newType) {
                      case "ollama": form.setValue("baseUrl", "http://ollama:11434"); break;
                      case "openai": form.setValue("baseUrl", "https://api.openai.com"); break;
                      case "openrouter": form.setValue("baseUrl", "https://openrouter.ai/api"); break;
                      case "anthropic": form.setValue("baseUrl", "https://api.anthropic.com"); break;
                      case "gemini": form.setValue("baseUrl", "https://generativelanguage.googleapis.com"); break;
                      case "xiaomi": form.setValue("baseUrl", "https://api.xiaomi.com/mimo/v1"); break;
                      case "minimax": form.setValue("baseUrl", "https://api.minimaxi.com/v1"); break;
                      default: form.setValue("baseUrl", "https://api.openai.com");
                    }
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ollama">Ollama</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    <SelectItem value="gemini">Gemini (native)</SelectItem>
                    <SelectItem value="xiaomi">Xiaomi MiMo (native)</SelectItem>
                    <SelectItem value="minimax">MiniMax (native)</SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="baseUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("settings.providers.baseUrlLabel")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  placeholder={t("settings.providers.baseUrlPlaceholder")}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="apiKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("settings.providers.apiKeyLabel")}</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder={t("settings.providers.apiKeyPlaceholder")}
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground mt-1">{t("settings.providers.apiKeyHint")}</p>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            size="sm"
          >
            {t("settings.providers.createProvider")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
          >
            {t("common.cancel", "Cancel")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
