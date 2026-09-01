// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useChatStreaming — SSE streaming sub-hook extracted from useChat.ts
 * (Phase 88 MOD-02, D-09).
 *
 * Owns the fetchEventSource + SSE event handlers + sendMessage/retryMessage.
 * Receives ALL state, setters, and refs as explicit args from the parent
 * useChat aggregator — chatId is an explicit per-call arg (D-09), NOT a
 * stale closure over currentChatId. This resolves the MEMORY
 * `chat-model-persistence-autofallback` stale-read landmine: every SSE
 * handler reads `args.chatId` (the live value the parent threaded), never
 * a captured `currentChatId`.
 *
 * The `handleFallback` ↔ `retryMessage` circular dependency between this
 * hook and useChatModelSelection is broken via a parent-owned ref:
 * `handleFallbackRef` is threaded in and read at invocation time, so the
 * latest `handleFallback` is always called.
 *
 * Does NOT import from `contexts/ChatContext` (F81 scission — Pitfall 5).
 */

import { fetchEventSource } from "@microsoft/fetch-event-source";
import { useTranslation } from "react-i18next";
import { showError } from "../lib/toast";
import { addWikiEdit } from "../utils/archiveQueue";
import { queryClient } from "../queries/queryClient";
import { queryKeys } from "../queries/keys";
import { getErrorMessage } from "../utils/errorUtils";
import type { AgentPlan, SourceCitation } from "@simmetric-chat/shared";
import type { ChatMessage } from "./useChat";

const API_BASE = "/api";

/**
 * Format a non-2xx SSE response into an Error, surfacing the server's
 * `{ error, details }` payload. Validation `details` (fieldErrors) are
 * appended when present so the operator sees *which* field failed (e.g.
 * chatId null vs missing) instead of a bare "HTTP 400". This is a
 * self-hosted, local-first app — validation details are not sensitive
 * and aid debugging. `import.meta.env.DEV` is intentionally avoided so the
 * module loads under ts-jest CommonJS (import.meta is unavailable there).
 */
function formatStreamError(response: Response, body: { error?: string; details?: unknown }): Error {
  const base = body.error || `HTTP ${response.status}`;
  if (body.details) {
    let detailStr: string;
    try {
      detailStr =
        typeof body.details === "string" ? body.details : JSON.stringify(body.details);
    } catch {
      detailStr = String(body.details);
    }
    return new Error(`${base} — ${detailStr}`);
  }
  return new Error(base);
}

export interface UseChatStreamingArgs {
  workspaceId: string | null;
  /** D-09: explicit per-call arg from parent's currentChatId state — NOT a closure. */
  chatId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setIsStreaming: (v: boolean) => void;
  setStreamingContent: React.Dispatch<React.SetStateAction<string>>;
  // D-03 (Phase 94, Plan 94-03): mirror of setStreamingContent for reasoning.
  setStreamingThinking: React.Dispatch<React.SetStateAction<string>>;
  setStatusMessage: (v: string | null) => void;
  setActivePlan: (v: AgentPlan | null) => void;
  setError: (v: string | null) => void;
  setCurrentChatId: (v: string | null) => void;
  persistedModel: { providerId?: string; model?: string } | null;
  setPersistedModel: React.Dispatch<React.SetStateAction<{ providerId?: string; model?: string } | null>>;
  /** Cross-hook ref: handleFallback lives in useChatModelSelection. */
  handleFallbackRef: React.MutableRefObject<(m: { providerId: string; model: string }) => Promise<void>>;
  /** Refs (owned by parent, threaded as explicit args). */
  abortRef: React.MutableRefObject<AbortController | null>;
  currentSourcesRef: React.MutableRefObject<SourceCitation[]>;
  streamingContentRef: React.MutableRefObject<string>;
  // D-03 (Phase 94, Plan 94-03): mirror of streamingContentRef for reasoning.
  streamingThinkingRef: React.MutableRefObject<string>;
  currentPlanRef: React.MutableRefObject<AgentPlan | null>;
  isFallbackInProgressRef: React.MutableRefObject<boolean>;
  persistedModelRef: React.MutableRefObject<{ providerId?: string; model?: string } | null>;
}

export function useChatStreaming(args: UseChatStreamingArgs) {
  const { t } = useTranslation();

  const abortStream = () => {
    if (args.abortRef.current) {
      args.abortRef.current.abort();
      args.abortRef.current = null;
    }
    args.setIsStreaming(false);
    args.setStreamingContent("");
    args.setStreamingThinking("");
    args.setStatusMessage(null);
  };

  const retryMessage = async (
    content: string,
    attachedDocId?: string,
    modelOverride?: { providerId?: string; model?: string } | null,
    fallbackOriginalModel?: { providerId?: string; model?: string } | null
  ) => {
    if (!args.workspaceId) return;

    if (args.abortRef.current) {
      args.abortRef.current.abort();
    }

    args.setIsStreaming(true);
    args.setStreamingContent("");
    args.streamingContentRef.current = "";
    args.setStreamingThinking("");
    args.streamingThinkingRef.current = "";
    args.setStatusMessage(null);
    args.setError(null);
    args.currentSourcesRef.current = [];
    args.currentPlanRef.current = null;
    args.setActivePlan(null);

    const controller = new AbortController();
    args.abortRef.current = controller;

    const token = localStorage.getItem("token");

    const effectiveOverride = modelOverride || args.persistedModel;

    try {
      await fetchEventSource(`${API_BASE}/workspaces/${args.workspaceId}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: content,
          // D-09: use args.chatId (explicit per-call arg), NOT a currentChatId closure.
          ...(args.chatId && { chatId: args.chatId }),
          isRegeneration: true,
          // D-03 (Phase 94): main frontend opts in to thinking events.
          include_thinking: true,
          ...(attachedDocId && { attachedDocumentId: attachedDocId }),
          ...(effectiveOverride?.providerId && { providerId: effectiveOverride.providerId }),
          ...(effectiveOverride?.model && { model: effectiveOverride.model }),
        }),
        signal: controller.signal,

        onopen: async (response) => {
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw formatStreamError(response, body);
          }
        },

        onmessage: (event) => {
          switch (event.event) {
            case "plan": {
              try {
                const plan = JSON.parse(event.data) as AgentPlan;
                if (plan && typeof plan.goal === "string" && Array.isArray(plan.steps)) {
                  args.currentPlanRef.current = plan;
                  args.setActivePlan(plan);
                }
              } catch {
                // Ignore malformed plan events — falls back to no banner.
              }
              break;
            }
            case "token": {
              try {
                const token = JSON.parse(event.data);
                args.streamingContentRef.current += token;
                args.setStreamingContent((prev) => prev + token);
              } catch {
                args.streamingContentRef.current += event.data;
                args.setStreamingContent((prev) => prev + event.data);
              }
              break;
            }
            case "status": {
              try {
                const data = JSON.parse(event.data);
                args.setStatusMessage(data.message || null);
              } catch {
                args.setStatusMessage(event.data);
              }
              break;
            }
            case "citations": {
              try {
                const data = JSON.parse(event.data);
                args.currentSourcesRef.current = data.sources || [];
              } catch {
                // Ignore parse errors
              }
              break;
            }
            case "wiki_edit": {
              try {
                const data = JSON.parse(event.data);
                addWikiEdit(data);
              } catch {
                // Ignore parse errors
              }
              break;
            }
            case "done": {
              try {
                const data = JSON.parse(event.data);
                const finalContent = args.streamingContentRef.current;
                const assistantMessage: ChatMessage = {
                  id: data.messageId || `assistant-${Date.now()}`,
                  role: "assistant",
                  content: finalContent,
                  metadata: {
                    sources: args.currentSourcesRef.current,
                    ...(data.model && { modelUsed: data.model }),
                    ...(data.providerType && { modelProvider: data.providerType }),
                    ...(data.mcpSources?.length > 0 && { mcpSources: data.mcpSources }),
                    ...(data.resolvedWikilinks && { resolvedWikilinks: data.resolvedWikilinks }),
                    ...(data.tokenUsage && { tokenUsage: data.tokenUsage }),
                    ...(args.currentPlanRef.current && { plan: args.currentPlanRef.current }),
                    ...(data.dlp_matches?.length > 0 && { dlpMatches: data.dlp_matches }),
                    ...(data.pipeline && { pipeline: data.pipeline }),
                  },
                  createdAt: new Date().toISOString(),
                };

                // retryMessage does NOT re-add the user message — it is already in the history
                args.setMessages((prev) => [...prev, assistantMessage]);
                args.setCurrentChatId(data.chatId || args.chatId);
              } catch {
                // Ignore parse errors
              }
              args.streamingContentRef.current = "";
              args.streamingThinkingRef.current = "";
              args.currentPlanRef.current = null;
              args.setIsStreaming(false);
              args.setStreamingContent("");
              args.setStreamingThinking("");
              args.setStatusMessage(null);
              args.setActivePlan(null);
              break;
            }
            case "error": {
              try {
                const data = JSON.parse(event.data);
                let errorText = data.error || "Streaming failed";
                if (typeof errorText === "string" && errorText.includes("[CLOUD_MODEL_OFFLINE]")) {
                  errorText = t("chat.cloudModelOffline", "This model requires a connection to ollama.com. Select a local model or connect your computer to the internet.");
                }
                if (typeof errorText === "string" && errorText.includes("[CLOUD_MODEL_AUTH_FAILED]")) {
                  errorText = t("chat.cloudModelAuthFailed", "Ollama cloud model authentication failed. Please check your API key in Settings > Providers.");
                }
                args.setError(errorText);
              } catch {
                args.setError("Streaming failed");
              }
              args.setIsStreaming(false);
              args.setStreamingContent("");
              args.setStreamingThinking("");
              args.setStatusMessage(null);
              args.setActivePlan(null);
              args.currentPlanRef.current = null;
              // RC-2: the selected model itself errored at the LLM provider
              // (HTTP 400 "model not found", 401, cloud-offline, …) — surfaced
              // as an SSE `error` event, NOT a connection drop. The existing
              // handleFallback was wired only to `onerror`, so this case left
              // the user stuck with a hard error and forced a manual dropdown
              // pick. Auto-recover via the same fallback chain (workspace →
              // global → any available), which also persists the new model and
              // re-sends the last user message. Guards: only when a model is
              // explicitly selected, and isFallbackInProgressRef prevents
              // loops (a fallback retry that also errors won't re-trigger).
              if (args.persistedModelRef.current?.providerId && !args.isFallbackInProgressRef.current) {
                args.handleFallbackRef.current(args.persistedModelRef.current as { providerId: string; model: string });
              }
              break;
            }
            // D-03 (Phase 94, Plan 94-03): SSE `thinking` event consumer.
            // Mirror of `token` case — accumulates reasoning into
            // streamingThinking state. The default: break branch below MUST
            // remain unchanged (Pitfall 4 safety — per D-06).
            case "thinking": {
              try {
                const data = JSON.parse(event.data);
                if (data.content) {
                  args.streamingThinkingRef.current += data.content;
                  args.setStreamingThinking((prev) => prev + data.content);
                }
              } catch {
                // Ignore parse errors (per RESEARCH §Frontend useChat pattern)
              }
              break;
            }
            default:
              break;
          }
        },

        onclose: () => {
          args.setIsStreaming(false);
          args.setStatusMessage(null);
        },

        onerror: (err) => {
          args.setError(err instanceof Error ? getErrorMessage(err) : "Connection lost");
          args.setIsStreaming(false);
          args.setStreamingContent("");
          args.setStreamingThinking("");
          args.setStatusMessage(null);

          if (args.isFallbackInProgressRef.current && fallbackOriginalModel) {
            args.setPersistedModel(fallbackOriginalModel);
            args.isFallbackInProgressRef.current = false;
            showError(t("chat.fallback.noModels"));
          }

          throw err;
        },
      });
    } catch (err: unknown) {
      if (err instanceof Error ? err.name !== "AbortError" : true) {
        args.setError(getErrorMessage(err, "Failed to send message"));
      }
      args.setIsStreaming(false);
      args.setStreamingContent("");
      args.setStatusMessage(null);
    } finally {
      args.abortRef.current = null;
    }
  };

  const sendMessage = async (content: string, attachedDocId?: string, attachedDocName?: string, modelOverride?: { providerId?: string; model?: string }, archiveId?: string | null) => {
    if (!args.workspaceId) return;

    // Abort any existing stream
    if (args.abortRef.current) {
      args.abortRef.current.abort();
    }

    // Add user message optimistically
    const userMessage: ChatMessage = {
      id: `temp-user-${Date.now()}`,
      role: "user",
      content,
      metadata: {
        ...(attachedDocId && { attachedDocumentId: attachedDocId }),
        ...(attachedDocName && { attachedDocumentName: attachedDocName }),
      },
      createdAt: new Date().toISOString(),
    };

    args.setMessages((prev) => [...prev, userMessage]);
    args.setIsStreaming(true);
    args.setStreamingContent("");
    args.streamingContentRef.current = "";
    args.setStreamingThinking("");
    args.streamingThinkingRef.current = "";
    args.setStatusMessage(null);
    args.setError(null);
    args.currentSourcesRef.current = [];
    args.currentPlanRef.current = null;
    args.setActivePlan(null);

    // Capture whether this is the first message of a brand-new chat (no
    // currentChatId yet). The server creates the Chat record on first
    // message and returns `chatId` in the SSE `done` event; we invalidate
    // the chats-list query in that case so the sidebar refetches
    // immediately and the new row appears (bypassing the 10s staleTime).
    const controller = new AbortController();
    args.abortRef.current = controller;

    const token = localStorage.getItem("token");

    const effectiveOverride = modelOverride || args.persistedModel;

    try {
      await fetchEventSource(`${API_BASE}/workspaces/${args.workspaceId}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: content,
          // D-09: use args.chatId (explicit per-call arg), NOT a currentChatId closure.
          ...(args.chatId && { chatId: args.chatId }),
          // D-03 (Phase 94): main frontend opts in to thinking events.
          include_thinking: true,
          ...(attachedDocId && { attachedDocumentId: attachedDocId }),
          ...(effectiveOverride?.providerId && { providerId: effectiveOverride.providerId }),
          ...(effectiveOverride?.model && { model: effectiveOverride.model }),
          // 260815-k5s: the archive selected before the first message of a
          // new chat — threaded so the server's chat.create is archive-scoped
          // from the start (no post-hoc PATCH). Only spread when truthy;
          // null/undefined/absent keeps the body byte-identical to today.
          ...(archiveId && { archiveId }),
        }),
        signal: controller.signal,

        onopen: async (response) => {
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw formatStreamError(response, body);
          }
        },

        onmessage: (event) => {
          switch (event.event) {
            case "plan": {
              try {
                const plan = JSON.parse(event.data) as AgentPlan;
                if (plan && typeof plan.goal === "string" && Array.isArray(plan.steps)) {
                  args.currentPlanRef.current = plan;
                  args.setActivePlan(plan);
                }
              } catch {
                // Ignore malformed plan events — falls back to no banner.
              }
              break;
            }
            case "token": {
              try {
                const token = JSON.parse(event.data);
                args.streamingContentRef.current += token;
                args.setStreamingContent((prev) => prev + token);
              } catch {
                // Treat raw data as token
                args.streamingContentRef.current += event.data;
                args.setStreamingContent((prev) => prev + event.data);
              }
              break;
            }
            case "status": {
              try {
                const data = JSON.parse(event.data);
                args.setStatusMessage(data.message || null);
              } catch {
                args.setStatusMessage(event.data);
              }
              break;
            }
            case "citations": {
              try {
                const data = JSON.parse(event.data);
                args.currentSourcesRef.current = data.sources || [];
              } catch {
                // Ignore parse errors
              }
              break;
            }
            case "wiki_edit": {
              try {
                const data = JSON.parse(event.data);
                addWikiEdit(data);
              } catch {
                // Ignore parse errors
              }
              break;
            }
            case "done": {
              try {
                const data = JSON.parse(event.data);
                // Finalize the assistant message using the ref for accurate content
                const finalContent = args.streamingContentRef.current;
                const assistantMessage: ChatMessage = {
                  id: data.messageId || `assistant-${Date.now()}`,
                  role: "assistant",
                  content: finalContent,
                  metadata: {
                    sources: args.currentSourcesRef.current,
                    ...(data.model && { modelUsed: data.model }),
                    ...(data.providerType && { modelProvider: data.providerType }),
                    ...(data.mcpSources?.length > 0 && { mcpSources: data.mcpSources }),
                    ...(data.resolvedWikilinks && { resolvedWikilinks: data.resolvedWikilinks }),
                    ...(data.tokenUsage && { tokenUsage: data.tokenUsage }),
                    ...(args.currentPlanRef.current && { plan: args.currentPlanRef.current }),
                    ...(data.dlp_matches?.length > 0 && { dlpMatches: data.dlp_matches }),
                  },
                  createdAt: new Date().toISOString(),
                };

                args.setMessages((prev) => {
                  const withoutTemp = prev.filter((m) => !m.id.startsWith("temp-user-"));
                  // If loadChat raced and already fetched the persisted user message from DB,
                  // don't add a duplicate — just append the assistant response.
                  const lastMsg = withoutTemp[withoutTemp.length - 1];
                  const alreadyHasUser = lastMsg?.role === "user" && lastMsg.content === userMessage.content;
                  if (alreadyHasUser) {
                    return [...withoutTemp, assistantMessage];
                  }
                  return [
                    ...withoutTemp,
                    { ...userMessage, id: `user-${data.chatId}-${Date.now()}` },
                    assistantMessage,
                  ];
                });
                args.setCurrentChatId(data.chatId || args.chatId);
                // D-07 (Phase 98): invalidate chats-list on every done event so
                // the sidebar refetches the chat title (auto-title gen is
                // fire-and-forget post-commit server-side). A delayed
                // re-invalidation (~3s) covers the LLM title-gen latency.
                if (data.chatId && args.workspaceId) {
                  const wsId = args.workspaceId;
                  queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(wsId) });
                  setTimeout(() => {
                    queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(wsId) });
                  }, 3000);
                }
              } catch {
                // Ignore parse errors
              }
              args.streamingContentRef.current = "";
              args.streamingThinkingRef.current = "";
              args.currentPlanRef.current = null;
              args.setIsStreaming(false);
              args.setStreamingContent("");
              args.setStreamingThinking("");
              args.setStatusMessage(null);
              args.setActivePlan(null);
              break;
            }
            case "error": {
              try {
                const data = JSON.parse(event.data);
                let errorText = data.error || "Streaming failed";
                if (typeof errorText === "string" && errorText.includes("[CLOUD_MODEL_OFFLINE]")) {
                  errorText = t("chat.cloudModelOffline", "This model requires a connection to ollama.com. Select a local model or connect your computer to the internet.");
                }
                if (typeof errorText === "string" && errorText.includes("[CLOUD_MODEL_AUTH_FAILED]")) {
                  errorText = t("chat.cloudModelAuthFailed", "Ollama cloud model authentication failed. Please check your API key in Settings > Providers.");
                }
                args.setError(errorText);
              } catch {
                args.setError("Streaming failed");
              }
              args.setIsStreaming(false);
              args.setStreamingContent("");
              args.setStreamingThinking("");
              args.setStatusMessage(null);
              args.setActivePlan(null);
              args.currentPlanRef.current = null;
              // RC-2: the selected model itself errored at the LLM provider
              // (HTTP 400 "model not found", 401, cloud-offline, …) — surfaced
              // as an SSE `error` event, NOT a connection drop. The existing
              // handleFallback was wired only to `onerror`, so this case left
              // the user stuck with a hard error and forced a manual dropdown
              // pick. Auto-recover via the same fallback chain (workspace →
              // global → any available), which also persists the new model and
              // re-sends the last user message. Guards: only when a model is
              // explicitly selected, and isFallbackInProgressRef prevents
              // loops (a fallback retry that also errors won't re-trigger).
              if (args.persistedModelRef.current?.providerId && !args.isFallbackInProgressRef.current) {
                args.handleFallbackRef.current(args.persistedModelRef.current as { providerId: string; model: string });
              }
              break;
            }
            // D-03 (Phase 94, Plan 94-03): SSE `thinking` event consumer.
            // Mirror of `token` case — accumulates reasoning into
            // streamingThinking state. The default: break branch below MUST
            // remain unchanged (Pitfall 4 safety — per D-06).
            case "thinking": {
              try {
                const data = JSON.parse(event.data);
                if (data.content) {
                  args.streamingThinkingRef.current += data.content;
                  args.setStreamingThinking((prev) => prev + data.content);
                }
              } catch {
                // Ignore parse errors (per RESEARCH §Frontend useChat pattern)
              }
              break;
            }
            default:
              // Ignore unknown events
              break;
          }
        },

        onclose: () => {
          args.setIsStreaming(false);
          args.setStatusMessage(null);
        },

        onerror: (err) => {
          args.setError(err instanceof Error ? getErrorMessage(err) : "Connection lost");
          args.setIsStreaming(false);
          args.setStreamingContent("");
          args.setStreamingThinking("");
          args.setStatusMessage(null);
          args.setActivePlan(null);
          args.currentPlanRef.current = null;

          if (args.persistedModelRef.current?.providerId) {
            args.handleFallbackRef.current(args.persistedModelRef.current as { providerId: string; model: string });
          }

          // Don't reconnect — let the user decide
          throw err;
        },
      });
    } catch (err: unknown) {
      if (err instanceof Error ? err.name !== "AbortError" : true) {
        args.setError(getErrorMessage(err, "Failed to send message"));
      }
      args.setIsStreaming(false);
      args.setStreamingContent("");
      args.setStreamingThinking("");
      args.setStatusMessage(null);
    } finally {
      args.abortRef.current = null;
    }
  };

  return { sendMessage, retryMessage, abortStream };
}