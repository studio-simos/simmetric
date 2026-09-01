// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useChatPersistence — chat history + lifecycle sub-hook extracted from
 * useChat.ts (Phase 88 MOD-02, D-09).
 *
 * Owns loadChat, clearChat, removeMessage, renameChat, regenerateLastResponse,
 * editLastMessageAndRegenerate. The parent owns messages/setMessages and
 * chatName/setChatName state; this sub-hook receives them as explicit args
 * (D-09) and operates via setters. `chatId` is threaded as an explicit
 * per-call arg — NOT a stale closure over currentChatId. The
 * `regenerateLastResponse` / `editLastMessageAndRegenerate` paths call
 * `retryMessage` (useChatStreaming) via the parent-owned `retryMessageRef`.
 *
 * loadChat's RC-3 persistence PATCH uses the explicit `chatId` arg in the
 * apiPatch URL (the same pattern the MEMORY `chat-model-persistence-autofallback`
 * fix introduced) — generalized across the sub-hook per D-09.
 *
 * Does NOT import from `contexts/ChatContext` (F81 scission — Pitfall 5).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiDelete, apiPut, apiPatch, apiGet } from "../utils/api";
import { showError } from "../lib/toast";
import { queryClient } from "../queries/queryClient";
import { queryKeys } from "../queries/keys";
import { getGlobalDefaultModel } from "../utils/modelDefaults";
import { getErrorMessage } from "../utils/errorUtils";
import type { AgentPlan } from "@simmetric-chat/shared";
import type { ChatMessage } from "./useChat";
import { isModelAvailable, resolveEffectiveModel } from "./useChatModelSelection";

const API_BASE = "/api";

export interface UseChatPersistenceArgs {
  workspaceId: string | null;
  /** D-09: explicit per-call arg from parent's currentChatId state — NOT a closure. */
  chatId: string | null;
  /** Parent-owned state threaded as args. */
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setCurrentChatId: (v: string | null) => void;
  setError: (v: string | null) => void;
  setStreamingContent: (v: string) => void;
  setStatusMessage: (v: string | null) => void;
  setActivePlan: (v: AgentPlan | null) => void;
  setPersistedModel: React.Dispatch<React.SetStateAction<{ providerId?: string; model?: string } | null>>;
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
  currentPlanRef: React.MutableRefObject<AgentPlan | null>;
  isFallbackInProgressRef: React.MutableRefObject<boolean>;
  workspaceDefaultRef: React.MutableRefObject<{ providerId?: string; model?: string } | null>;
  attemptedModelsRef: React.MutableRefObject<Set<string>>;
  debounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  persistedModelRef: React.MutableRefObject<{ providerId?: string; model?: string } | null>;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
}

export function useChatPersistence(args: UseChatPersistenceArgs) {
  const { t } = useTranslation();
  const [chatName, setChatName] = useState<string | null>(null);

  const loadChat = async (chatId: string) => {
    if (!args.workspaceId) return;

    try {
      const token = localStorage.getItem("token");
      const [messagesRes, chats] = await Promise.all([
        fetch(`${API_BASE}/workspaces/${args.workspaceId}/chats/${chatId}/messages`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
        apiGet<Array<{ id: string; providerId: string | null; model: string }>>(`/workspaces/${args.workspaceId}/chats`),
      ]);

      if (!messagesRes.ok) throw new Error("Failed to load messages");

      const rawMessages = await messagesRes.json();
      const parsed: ChatMessage[] = rawMessages.map((m: Record<string, unknown>) => ({
        ...m,
        metadata: typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata,
      }));

      args.setMessages(parsed);
      args.setCurrentChatId(chatId);
      args.setError(null);

      const chat = chats.find((c) => c.id === chatId);

      // Resolve the workspace default up front so it's available both as a
      // fallback candidate and for the workspaceDefaultRef (used by the
      // 30s availability watcher / handleFallback).
      let workspaceDefault: { providerId?: string; model?: string } | null = null;
      try {
        const config = await apiGet<{ providerId?: string; model?: string }>(`/workspaces/${args.workspaceId}/agent-config`);
        workspaceDefault = config.providerId ? { providerId: config.providerId, model: config.model || undefined } : null;
        args.workspaceDefaultRef.current = workspaceDefault;
      } catch {
        workspaceDefault = null;
      }

      const storedModel = chat?.providerId ? { providerId: chat.providerId, model: chat.model } : null;
      const globalDefault = getGlobalDefaultModel();
      const availableModels =
        queryClient.getQueryData<Array<{ providerId: string; name: string; isDefault: boolean }>>(queryKeys.providers.available) ?? [];

      let resolvedModel: { providerId?: string; model?: string } | null;
      let needsPersist = false;
      if (availableModels.length > 0) {
        // Validate every candidate against the live availableModels list. This
        // is the RC-1 fix: a stale workspace/global default pointing at a
        // deleted/unavailable model is skipped instead of sent to the server
        // (where it would fail to resolve and error out).
        resolvedModel = resolveEffectiveModel(
          availableModels,
          [storedModel, workspaceDefault, globalDefault],
          workspaceDefault
        );
        // RC-3: persist the resolved model onto the Chat record when the chat
        // had no model stored OR its stored model is no longer available (we
        // fell back to a different one). This makes the actually-used model
        // sticky so reopening / refresh restores the exact same model.
        needsPersist = !!resolvedModel && (!storedModel || !isModelAvailable(availableModels, storedModel));
      } else {
        // Providers query not hydrated yet on a cold load — trust the stored /
        // workspace / global value as before. Don't validate (would clear a
        // valid selection) and don't persist (can't confirm availability).
        resolvedModel = storedModel ?? workspaceDefault ?? globalDefault ?? null;
      }

      args.setPersistedModel(resolvedModel);

      if (needsPersist && resolvedModel?.providerId) {
        // PATCH directly with the explicit chatId — updateChatModel() reads
        // the `currentChatId` React state which is still the pre-load value
        // inside this async closure, so it would no-op / patch the wrong chat.
        // D-09: use the explicit chatId arg, NOT args.chatId (which is the
        // pre-load value from the parent). This mirrors the original fix.
        apiPatch(`/workspaces/${args.workspaceId}/chats/${chatId}/model`, {
          providerId: resolvedModel.providerId,
          model: resolvedModel.model,
        }).catch(() => {
          // Non-blocking: the in-memory persistedModel is already set; a
          // failed persistence just means we re-resolve on next load.
        });
      }
    } catch (err: unknown) {
      args.setError(getErrorMessage(err));
    }
  };

  const clearChat = () => {
    if (args.debounceRef.current) {
      clearTimeout(args.debounceRef.current);
      args.debounceRef.current = null;
    }
    args.setMessages([]);
    args.setCurrentChatId(null);
    setChatName(null);
    args.setError(null);
    args.setStreamingContent("");
    args.setStatusMessage(null);
    args.setActivePlan(null);
    args.currentPlanRef.current = null;
    args.setPersistedModel(getGlobalDefaultModel());
    args.workspaceDefaultRef.current = null;
    args.attemptedModelsRef.current.clear();
    args.isFallbackInProgressRef.current = false;
  };

  const removeMessage = async (messageId: string) => {
    // D-09: use args.chatId (explicit per-call arg), NOT a stale closure.
    if (!args.workspaceId || !args.chatId) return;
    // Optimistic removal
    args.setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await apiDelete(`/workspaces/${args.workspaceId}/chats/${args.chatId}/messages/${messageId}`);
    } catch {
      // If delete fails, reload chat to restore
      loadChat(args.chatId);
    }
  };

  const renameChat = async (name: string) => {
    // D-09: use args.chatId (explicit per-call arg), NOT a stale closure.
    if (!args.workspaceId || !args.chatId) return;
    try {
      await apiPut(`/workspaces/${args.workspaceId}/chats/${args.chatId}`, { name });
      setChatName(name);
    } catch {
      // Ignore rename failure
    }
  };

  const regenerateLastResponse = async () => {
    // D-09: use args.chatId (explicit per-call arg), NOT a stale closure.
    if (!args.workspaceId || !args.chatId) return;

    let userIdx = -1;
    for (let i = args.messagesRef.current.length - 1; i >= 0; i--) {
      const m = args.messagesRef.current[i];
      if (m && m.role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;

    const lastUserMessage = args.messagesRef.current[userIdx];
    if (!lastUserMessage) return;

    let assistantIdx = -1;
    for (let i = userIdx + 1; i < args.messagesRef.current.length; i++) {
      const m = args.messagesRef.current[i];
      if (m && m.role === "assistant") {
        assistantIdx = i;
        break;
      }
    }

    const assistantMessage = assistantIdx !== -1 ? args.messagesRef.current[assistantIdx] : null;

    if (assistantMessage) {
      args.setMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
      try {
        await apiDelete(`/workspaces/${args.workspaceId}/chats/${args.chatId}/messages/${assistantMessage.id}`);
      } catch {
        loadChat(args.chatId);
        return;
      }
    }

    // D-09: call retryMessage via the cross-hook ref (lives in useChatStreaming).
    await args.retryMessageRef.current(
      lastUserMessage.content,
      lastUserMessage.metadata?.attachedDocumentId,
      args.persistedModelRef.current,
      null
    );
  };

  const editLastMessageAndRegenerate = async (newContent: string) => {
    // D-09: use args.chatId (explicit per-call arg), NOT a stale closure.
    if (!args.workspaceId || !args.chatId) return;

    let userIdx = -1;
    for (let i = args.messagesRef.current.length - 1; i >= 0; i--) {
      const m = args.messagesRef.current[i];
      if (m && m.role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;

    const lastUserMessage = args.messagesRef.current[userIdx];
    if (!lastUserMessage) return;

    try {
      await apiPut(`/workspaces/${args.workspaceId}/chats/${args.chatId}/messages/${lastUserMessage.id}`, {
        content: newContent,
      });
    } catch {
      showError(t("chat.editFailed", "Failed to edit message"));
      return;
    }

    args.setMessages((prev) =>
      prev.map((m) => (m.id === lastUserMessage.id ? { ...m, content: newContent } : m))
    );

    let assistantIdx = -1;
    for (let i = userIdx + 1; i < args.messagesRef.current.length; i++) {
      const m = args.messagesRef.current[i];
      if (m && m.role === "assistant") {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx !== -1) {
      const assistantMessage = args.messagesRef.current[assistantIdx];
      if (assistantMessage) {
        args.setMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
        try {
          await apiDelete(`/workspaces/${args.workspaceId}/chats/${args.chatId}/messages/${assistantMessage.id}`);
        } catch {
          loadChat(args.chatId);
          return;
        }
      }
    }

    // D-09: call retryMessage via the cross-hook ref (lives in useChatStreaming).
    await args.retryMessageRef.current(
      newContent,
      lastUserMessage.metadata?.attachedDocumentId,
      args.persistedModelRef.current,
      null
    );
  };

  return {
    chatName,
    setChatName,
    loadChat,
    clearChat,
    removeMessage,
    renameChat,
    regenerateLastResponse,
    editLastMessageAndRegenerate,
  };
}