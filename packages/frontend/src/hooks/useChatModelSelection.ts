// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useChatModelSelection — per-chat model persistence + fallback sub-hook
 * extracted from useChat.ts (Phase 88 MOD-02, D-09).
 *
 * Owns persistedModel state, resolveEffectiveModel/isModelAvailable (pure
 * helpers re-exported from useChat.ts), updateChatModel (debounced PATCH),
 * handleFallback (three-tier fallback chain), and the 30s availability
 * watcher. The `updateChatModel` body uses `args.chatId` in the apiPatch
 * URL — D-09 resolves the MEMORY `chat-model-persistence-autofallback`
 * stale-read landmine by threading the live chatId from the parent.
 *
 * The `handleFallback` ↔ `retryMessage` circular dependency between this
 * hook and useChatStreaming is broken via a parent-owned ref:
 * `retryMessageRef` is threaded in and read at invocation time.
 *
 * Does NOT import from `contexts/ChatContext` (F81 scission — Pitfall 5).
 */

import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";
import { apiPatch } from "../utils/api";
import { showError, toastWithAction } from "../lib/toast";
import { queryClient } from "../queries/queryClient";
import { queryKeys } from "../queries/keys";
import type { ChatMessage } from "./useChat";

function resolveFallbackModel(
  availableModels: Array<{ providerId: string; name: string; isDefault: boolean }>,
  workspaceDefault: { providerId?: string; model?: string } | null
): { providerId: string; model: string } | null {
  // Tier 1: workspace default
  if (workspaceDefault?.providerId) {
    const found = availableModels.find(
      (m) => m.providerId === workspaceDefault.providerId && m.name === workspaceDefault.model
    );
    if (found) return { providerId: found.providerId, model: found.name };
  }
  // Tier 2: global default
  const globalDefault = availableModels.find((m) => m.isDefault);
  if (globalDefault) return { providerId: globalDefault.providerId, model: globalDefault.name };
  // Tier 3: any available
  if (availableModels.length > 0) {
    const first = availableModels[0];
    if (first) return { providerId: first.providerId, model: first.name };
  }
  return null;
}

/**
 * Type guard: a candidate model is "available" only if both fields are present
 * AND the model is currently in the availableModels list (isEnabled && isAvailable
 * server-side). This is the validation gate that prevents sending a stale/default
 * model that the server can no longer resolve (deleted provider, uninstalled
 * Ollama model, cloud model offline, …).
 */
export function isModelAvailable(
  availableModels: Array<{ providerId: string; name: string }>,
  candidate: { providerId?: string; model?: string } | null | undefined
): candidate is { providerId: string; model: string } {
  return (
    !!candidate &&
    !!candidate.providerId &&
    !!candidate.model &&
    availableModels.some((m) => m.providerId === candidate.providerId && m.name === candidate.model)
  );
}

/**
 * Resolve the *effective* model for a chat by walking the candidate list in
 * priority order and returning the first one that is actually available. If
 * none of the candidates is available, fall back to the three-tier chain
 * (workspace default → global default → any available) via resolveFallbackModel.
 *
 * Candidates are tried in order: per-chat stored model → workspace default →
 * global default (localStorage) → … (caller decides order). Returns null only
 * when no model is available at all.
 *
 * When `availableModels` is empty (providers query not yet hydrated on a cold
 * load), the caller MUST NOT use this — it would return null and clear a valid
 * stored selection. Guard `availableModels.length > 0` at the call site.
 */
export function resolveEffectiveModel(
  availableModels: Array<{ providerId: string; name: string; isDefault: boolean }>,
  candidates: Array<{ providerId?: string; model?: string } | null | undefined>,
  workspaceDefault: { providerId?: string; model?: string } | null
): { providerId: string; model: string } | null {
  for (const candidate of candidates) {
    if (isModelAvailable(availableModels, candidate)) {
      return { providerId: candidate.providerId!, model: candidate.model! };
    }
  }
  return resolveFallbackModel(availableModels, workspaceDefault);
}

export interface UseChatModelSelectionArgs {
  workspaceId: string | null;
  /** D-09: explicit per-call arg from parent's currentChatId state — NOT a closure. */
  chatId: string | null;
  /** Parent-owned persistedModel state (cross-cutting — streaming also reads it). */
  persistedModel: { providerId?: string; model?: string } | null;
  setPersistedModel: React.Dispatch<React.SetStateAction<{ providerId?: string; model?: string } | null>>;
  /** Mirror of messages for handleFallback's last-user-message lookup. */
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  /** Cross-hook ref: retryMessage lives in useChatStreaming. */
  retryMessageRef: React.MutableRefObject<
    (
      content: string,
      attachedDocId?: string,
      modelOverride?: { providerId?: string; model?: string } | null,
      fallbackOriginalModel?: { providerId?: string; model?: string } | null
    ) => Promise<void>
  >;
  /** Refs (owned by parent, threaded as explicit args). */
  isFallbackInProgressRef: React.MutableRefObject<boolean>;
  attemptedModelsRef: React.MutableRefObject<Set<string>>;
  workspaceDefaultRef: React.MutableRefObject<{ providerId?: string; model?: string } | null>;
  debounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  persistedModelRef: React.MutableRefObject<{ providerId?: string; model?: string } | null>;
}

export function useChatModelSelection(args: UseChatModelSelectionArgs) {
  const { t } = useTranslation();
  const { persistedModel, setPersistedModel } = args;

  const updateChatModel = async (providerId: string | null, model: string | null) => {
    // D-09: use args.chatId (explicit per-call arg), NOT a stale currentChatId closure.
    // This resolves the MEMORY `chat-model-persistence-autofallback` stale-read bug.
    if (!args.workspaceId || !args.chatId) return;
    const previous = persistedModel;
    // Optimistic update
    setPersistedModel(providerId ? { providerId, model: model || undefined } : null);
    if (args.debounceRef.current) clearTimeout(args.debounceRef.current);
    return new Promise<void>((resolve, reject) => {
      args.debounceRef.current = setTimeout(async () => {
        try {
          await apiPatch(`/workspaces/${args.workspaceId}/chats/${args.chatId}/model`, { providerId, model });
          resolve();
        } catch {
          // Revert on failure
          setPersistedModel(previous);
          reject(new Error("Failed to update chat model"));
        }
      }, 200);
    });
  };

  const handleFallback = async (previousModel: { providerId: string; model: string }) => {
    if (args.isFallbackInProgressRef.current) return;
    args.isFallbackInProgressRef.current = true;

    const availableModels = queryClient.getQueryData<Array<{ providerId: string; name: string; isDefault: boolean }>>(queryKeys.providers.available) ?? [];
    const fallback = resolveFallbackModel(availableModels, args.workspaceDefaultRef.current);

    if (!fallback) {
      showError(t("chat.fallback.noModels"));
      args.isFallbackInProgressRef.current = false;
      args.attemptedModelsRef.current.clear();
      return;
    }

    const attemptKey = `${fallback.providerId}:${fallback.model}`;
    if (args.attemptedModelsRef.current.has(attemptKey)) {
      showError(t("chat.fallback.noModels"));
      args.isFallbackInProgressRef.current = false;
      args.attemptedModelsRef.current.clear();
      return;
    }
    args.attemptedModelsRef.current.add(attemptKey);

    const originalModel = args.persistedModelRef.current;
    setPersistedModel(fallback);

    try {
      await updateChatModel(fallback.providerId, fallback.model);
      toastWithAction(
        t("chat.fallback.switched", { from: previousModel.model, to: fallback.model }),
        t("chat.fallback.undo"),
        () => {
          setPersistedModel(originalModel);
          updateChatModel(originalModel?.providerId || null, originalModel?.model || null);
        },
        "info"
      );

      await new Promise((r) => setTimeout(r, 500));

      const lastUserMessage = args.messagesRef.current[args.messagesRef.current.length - 1];
      if (lastUserMessage?.role === "user") {
        // D-09: call retryMessage via the cross-hook ref (lives in useChatStreaming).
        await args.retryMessageRef.current(
          lastUserMessage.content,
          lastUserMessage.metadata?.attachedDocumentId,
          fallback,
          originalModel
        );
      }
    } catch {
      setPersistedModel(originalModel);
      showError(t("chat.modelSelector.unavailable"));
    } finally {
      args.isFallbackInProgressRef.current = false;
    }
  };

  // Polling-based fallback watcher
  const onFallbackCheck = useEffectEvent(() => {
    if (!args.workspaceId || !persistedModel?.providerId) return;
    const availableModels = queryClient.getQueryData<Array<{ providerId: string; name: string; isDefault: boolean }>>(queryKeys.providers.available) ?? [];
    const stillAvailable = availableModels.find(
      (m) => m.providerId === persistedModel.providerId && m.name === persistedModel.model
    );
    if (!stillAvailable && !args.isFallbackInProgressRef.current) {
      handleFallback(persistedModel as { providerId: string; model: string });
    }
  });

  useEffect(() => {
    if (!args.workspaceId || !persistedModel?.providerId) return;
    onFallbackCheck(); // immediate check on mount / when deps change
    const id = setInterval(() => onFallbackCheck(), 30000);
    return () => clearInterval(id);
  }, [args.workspaceId, persistedModel?.providerId]);

  return { updateChatModel, handleFallback };
}