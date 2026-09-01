// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// STATE: fetchEventSource + useState/useRef — SSE streaming tier (NOT TanStack Query)
/**
 * useChat — Streaming chat hook (thin aggregator facade)
 *
 * Phase 88 MOD-02: this file is a thin aggregator that owns the cross-cutting
 * state (currentChatId, messages, isStreaming, streamingContent, persistedModel,
 * etc.) and threads `chatId` as an explicit per-call arg (D-09) to three
 * sub-hooks:
 *   - useChatStreaming       — fetchEventSource + SSE event handlers + sendMessage/retryMessage
 *   - useChatPersistence      — loadChat + clearChat + removeMessage + renameChat + regenerate/edit
 *   - useChatModelSelection   — updateChatModel + handleFallback + 30s watcher + resolveEffectiveModel/isModelAvailable
 *
 * The `handleFallback` ↔ `retryMessage` circular dependency between
 * useChatStreaming and useChatModelSelection is broken via two parent-owned
 * refs (`handleFallbackRef`, `retryMessageRef`) synced after each render —
 * the sub-hooks read each other through the ref at invocation time, so the
 * latest closures are always called.
 *
 * The 9 frontend importers keep importing { useChat, UseChatReturn,
 * SourceCitation, resolveEffectiveModel, isModelAvailable, ChatMessage }
 * from "../hooks/useChat" unchanged (D-03 facade, zero importer churn).
 */

import { useState, useRef, useEffect } from "react";
import type { AgentPlan, SourceCitation } from "@simmetric-chat/shared";

import { useChatStreaming } from "./useChatStreaming";
import { useChatModelSelection } from "./useChatModelSelection";
import { useChatPersistence } from "./useChatPersistence";

// D-03 (Phase 87): the canonical `SourceCitation` lives solely in
// @simmetric-chat/shared (D-01 additive superset). Re-export it verbatim so the
// 5 frontend importers (CitationPanel, ChatPanel, chat/ChatMessage,
// chat/ChatCitations, hooks/useChatPanelState) which import `from
// "../hooks/useChat"` keep their paths unchanged.
// Note: `score` is now OPTIONAL on the shared type; the existing
// `source.score !== undefined` narrowing in CitationPanel.tsx:62 and
// ChatCitations.tsx:72 becomes necessary narrowing (D-04) — no consumer edits.
export type { SourceCitation } from "@simmetric-chat/shared";

// D-04 (Phase 88): pure helpers re-exported from this facade so the 9
// importers keep their import paths unchanged. Definitions live in
// useChatModelSelection (the owning sub-module).
export { resolveEffectiveModel, isModelAvailable } from "./useChatModelSelection";

interface ResolvedWikilink {
  slug: string;
  title: string;
  exists: boolean;
  category?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: {
    sources?: SourceCitation[];
    toolCalls?: unknown[];
    modelUsed?: string;
    modelProvider?: string;
    mcpSources?: string[];
    resolvedWikilinks?: ResolvedWikilink[];
    attachedDocumentId?: string;
    attachedDocumentName?: string;
    tokenUsage?: TokenUsage | null;
    plan?: AgentPlan;
    tags?: string[];
    followUps?: string[];
    dlpMatches?: Array<{ type: string; text: string }>;
    /** Pipeline info — describes what tools were called and whether sources
     *  were found. Used to show the user how the answer was produced. */
    pipeline?: {
      toolsCalled: string[];
      sourcesFound: number;
      ragSearched: boolean;
      ragResults: number;
    };
  };
  createdAt: string;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  // D-03 (Phase 94, Plan 94-03): additive mirror of `streamingContent` —
  // accumulates the reasoning trace delivered via SSE `thinking` events.
  // Reset on done/error/new message (same lifecycle as `streamingContent`).
  // Existing fields unchanged (additive — per D-03).
  streamingThinking: string;
  statusMessage: string | null;
  activePlan: AgentPlan | null;
  currentChatId: string | null;
  chatName: string | null;
  error: string | null;
  persistedModel: { providerId?: string; model?: string } | null;
  sendMessage: (content: string, attachedDocId?: string, attachedDocName?: string, modelOverride?: { providerId?: string; model?: string }, archiveId?: string | null) => Promise<void>;
  loadChat: (chatId: string) => Promise<void>;
  clearChat: () => void;
  abortStream: () => void;
  removeMessage: (messageId: string) => Promise<void>;
  renameChat: (name: string) => Promise<void>;
  updateChatModel: (providerId: string | null, model: string | null) => Promise<void>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  regenerateLastResponse: () => Promise<void>;
  editLastMessageAndRegenerate: (newContent: string) => Promise<void>;
}

export function useChat(workspaceId: string | null): UseChatReturn {
  // --- Parent-owned state (cross-cutting, threaded to sub-hooks as explicit args) ---
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  // D-03 (Phase 94, Plan 94-03): mirror of streamingContent for reasoning.
  const [streamingThinking, setStreamingThinking] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<AgentPlan | null>(null);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [persistedModel, setPersistedModel] = useState<{ providerId?: string; model?: string } | null>(null);

  // --- Parent-owned refs (threaded to sub-hooks as explicit args) ---
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSourcesRef = useRef<SourceCitation[]>([]);
  const streamingContentRef = useRef("");
  // D-03 (Phase 94, Plan 94-03): mirror of streamingContentRef for reasoning.
  const streamingThinkingRef = useRef("");
  const currentPlanRef = useRef<AgentPlan | null>(null);
  const isFallbackInProgressRef = useRef(false);
  const attemptedModelsRef = useRef<Set<string>>(new Set());
  const workspaceDefaultRef = useRef<{ providerId?: string; model?: string } | null>(null);
  const persistedModelRef = useRef(persistedModel);
  const messagesRef = useRef(messages);

  // Cross-hook refs: break the handleFallback ↔ retryMessage circular dep.
  // Both sub-hooks read each other through the ref at invocation time; the
  // parent syncs the refs after each render so the latest closures are called.
  const handleFallbackRef = useRef<(m: { providerId: string; model: string }) => Promise<void>>(async () => {});
  const retryMessageRef = useRef<
    (
      content: string,
      attachedDocId?: string,
      modelOverride?: { providerId?: string; model?: string } | null,
      fallbackOriginalModel?: { providerId?: string; model?: string } | null
    ) => Promise<void>
  >(async () => {});

  useEffect(() => { persistedModelRef.current = persistedModel; }, [persistedModel]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // --- Sub-hooks (D-09: chatId threaded as explicit per-call arg) ---
  // Order: model → streaming → persistence. Model owns persistedModel state
  // setters; streaming reads persistedModel + handleFallbackRef; persistence
  // reads retryMessageRef + setPersistedModel. Cross-hook refs are synced below.
  const model = useChatModelSelection({
    workspaceId,
    chatId: currentChatId,
    persistedModel,
    setPersistedModel,
    messagesRef,
    retryMessageRef,
    isFallbackInProgressRef,
    attemptedModelsRef,
    workspaceDefaultRef,
    debounceRef,
    persistedModelRef,
  });

  const streaming = useChatStreaming({
    workspaceId,
    chatId: currentChatId,
    setMessages,
    setIsStreaming,
    setStreamingContent,
    setStreamingThinking,
    setStatusMessage,
    setActivePlan,
    setError,
    setCurrentChatId,
    persistedModel,
    setPersistedModel,
    handleFallbackRef,
    abortRef,
    currentSourcesRef,
    streamingContentRef,
    streamingThinkingRef,
    currentPlanRef,
    isFallbackInProgressRef,
    persistedModelRef,
  });

  const persistence = useChatPersistence({
    workspaceId,
    chatId: currentChatId,
    setMessages,
    setCurrentChatId,
    setError,
    setStreamingContent,
    setStatusMessage,
    setActivePlan,
    setPersistedModel,
    retryMessageRef,
    currentPlanRef,
    isFallbackInProgressRef,
    workspaceDefaultRef,
    attemptedModelsRef,
    debounceRef,
    persistedModelRef,
    messagesRef,
  });

  // --- Sync cross-hook refs (breaks the handleFallback ↔ retryMessage cycle) ---
  useEffect(() => { handleFallbackRef.current = model.handleFallback; });
  useEffect(() => { retryMessageRef.current = streaming.retryMessage; });

  return {
    messages,
    isStreaming,
    streamingContent,
    streamingThinking,
    statusMessage,
    activePlan,
    currentChatId,
    chatName: persistence.chatName,
    error,
    persistedModel,
    sendMessage: streaming.sendMessage,
    loadChat: persistence.loadChat,
    clearChat: persistence.clearChat,
    abortStream: streaming.abortStream,
    removeMessage: persistence.removeMessage,
    renameChat: persistence.renameChat,
    updateChatModel: model.updateChatModel,
    setMessages,
    regenerateLastResponse: persistence.regenerateLastResponse,
    editLastMessageAndRegenerate: persistence.editLastMessageAndRegenerate,
  };
}