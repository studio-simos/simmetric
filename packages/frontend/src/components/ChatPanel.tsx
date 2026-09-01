// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useRef, useEffect, useState } from "react";
import { useChatNav } from "../contexts/ChatContext";
import { useTheme } from "../contexts/ThemeContext";
import { useChat, type SourceCitation, resolveEffectiveModel } from "../hooks/useChat";
import { useDropzone } from "react-dropzone";
import { useTranslation } from "react-i18next";
import { apiGet, apiUpload, ApiError } from "../utils/api";
import { getGlobalDefaultModel } from "../utils/modelDefaults";
import { showSuccess, showError, showInfo } from "../lib/toast";
import { setOnSelectModel } from "../hooks/usePaletteCallbacks";
import { useAvailableModels } from "../queries/useProviders";
import { useMe } from "../queries/useAuth";
import { useBelowLg } from "../hooks/useIsMobile";
import { useChatPanelState, type UploadedDoc } from "../hooks/useChatPanelState";
import { useMessageHistory } from "../hooks/useMessageHistory";
import ChatSidebar from "./ChatSidebar";
import RightPanel from "./RightPanel";
import CitationPanel from "./CitationPanel";
import { ChatMessageList } from "./chat/ChatMessageList";
import { ChatEmptyState } from "./chat/ChatEmptyState";
import { ChatInputArea } from "./chat/ChatInputArea";
import { ChatMessage } from "./chat/ChatMessage";
import { ChatStatusBanner } from "./chat/ChatStatusBanner";
import { ChatModelBadge } from "./chat/ChatModelBadge";
import { useSpeechRecognition, SpeechRecognition } from "../hooks/useSpeechRecognition";
import { WikilinkRenderer } from "./WikilinkRenderer";
import { WikiTooltip } from "./WikiTooltip";
import ModelComparisonView from "./ModelComparisonView";
import { useViewTransition } from "./ui/view-transition";
import { WikiPageModal } from "./WikiPageModal";
import { sanitizeFileName } from "@simmetric-chat/shared";
import { WikiBrokenLinkDialog } from "./WikiBrokenLinkDialog";
import { WikiDistillDialog } from "./WikiDistillDialog";
import { DlpTextsToggle } from "./chat/DlpTextsToggle";
import { useChats } from "../queries/useChats";
import { X, Menu, PanelRight, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Sheet, SheetPortal, SheetOverlay, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import * as SheetPrimitive from "@radix-ui/react-dialog";

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

export default function ChatPanel() {
  const {
    currentWorkspaceId,
    currentChatId: navChatId,
    setChatId,
    // Chat panel action state lifted into ChatContext (quick 260723-nnr
    // follow-up) so the Select/Save-to-Wiki controls can live in the right
    // console panel (RightPanel) which is a sibling of this routed panel.
    // (The Tokens toggle was removed in follow-up 3 — token usage now lives
    // in the RightPanel "Token Stats" collapsible tendina, no chat-area panel.)
    selectionMode,
    selectedMessageIds,
    setSelectedMessageIds,
    distillDialogOpen,
    setDistillDialogOpen,
    setMessageCount,
    // 260815-k5s: ephemeral new-chat archive selection. Reset to null on
    // "New chat" and threaded to sendMessage so the first message creates
    // an archive-scoped chat row (no post-hoc PATCH). Cleared by the
    // ChatContext reset effect once currentChatId becomes non-null.
    newChatArchiveId,
    setNewChatArchiveId,
  } = useChatNav();
  const mainChat = useChat(currentWorkspaceId);
  const {
    messages,
    isStreaming,
    streamingContent,
    statusMessage,
    activePlan,
    currentChatId,
    error,
    persistedModel,
    sendMessage,
    loadChat,
    clearChat,
    abortStream,
    removeMessage,
    updateChatModel,
    regenerateLastResponse,
    editLastMessageAndRegenerate,
  } = mainChat;

  const { data: availableModels = [] } = useAvailableModels(currentWorkspaceId !== null);
  const { data: authUser } = useMe();

  // Below lg (1024px) the chat sidebar collapses to a Sheet and the console
  // surfaces via a trigger in the chat title bar. At lg+ both are inline and
  // the title bar is hidden.
  const belowLg = useBelowLg();
  const [consoleOpen, setConsoleOpen] = useState(false);

  // Phase 80 (D-01): `Chat.archiveId` is the single source of truth for the
  // linked archive. The chat list query surfaces the persisted field; we
  // match the active chat by id and read its `archiveId` here. The ephemeral
  // archive-selection state from useChatPanelState has been removed. The
  // workspace archives list is fetched by RightPanel directly (Plan 05);
  // ChatPanel no longer needs `useArchives` here.
  const { data: chats = [] } = useChats(currentWorkspaceId ?? undefined);
  const activeChatSummary = chats.find((c) => c.id === currentChatId);
  const linkedArchiveId = activeChatSummary?.archiveId ?? null;

  const {
    input,
    setInput,
    ttsPlaying,
    setTtsPlaying,
    citationPanelSources,
    setCitationPanelSources,
    attachedDoc,
    setAttachedDoc,
    uploading,
    setUploading,
    modelOverride,
    setModelOverride,
    isComparing,
    setIsComparing,
    wikiTooltip,
    setWikiTooltip,
    wikiModalSlug,
    setWikiModalSlug,
    wikiCreateSlug,
    setWikiCreateSlug,
    editingMessageId,
    setEditingMessageId,
    editInput,
    setEditInput,
    deletingMessageId,
    setDeletingMessageId,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    statusAnnouncement,
    setStatusAnnouncement,
    showDlpTexts,
    setShowDlpTexts,
  } = useChatPanelState({ persistedModel });

  // Quick 260829-spj: same gate as DLPNotice (ChatMessage.tsx) — only admins
  // can reveal DLP-redacted text, so the global toggle only exists for them.
  const isDlpAdmin = authUser?.permissions?.includes("admin:settings") ?? false;

  // Resolve active model (override → persisted → default fallback) for badge.
  const activeModelName = modelOverride?.model ?? persistedModel?.model;
  const activeProviderId = modelOverride?.providerId ?? persistedModel?.providerId;
  const resolvedModel = activeProviderId && activeModelName
    ? availableModels.find((m) => m.providerId === activeProviderId && m.name === activeModelName)
    : undefined;
  const defaultModel = availableModels.find((m) => m.isDefault) ?? availableModels?.[0];
  const displayModel = resolvedModel ?? defaultModel;
  const modelIsDefault = !resolvedModel && !!defaultModel;

  // Terminal-style message history (global + persisted in localStorage).
  // ArrowUp on the first line recalls the previous sent message; ArrowDown on
  // the last line moves forward, back to the live draft. See useMessageHistory.
  const messageHistory = useMessageHistory();

  // Mirror messages.length into ChatContext so the right console panel
  // (RightPanel) can render the "Select messages" label ("N of M selected")
  // and gate Save-to-Wiki without owning the useChat instance. React bails
  // out when the number is unchanged, so streaming token appends (which don't
  // change length) don't trigger extra renders.
  useEffect(() => {
    setMessageCount(messages.length);
  }, [messages.length, setMessageCount]);

  // The chat-level model badge, MCP toggles, and wiki history button were
  // relocated from the message input bar to the RightPanel console (quick
  // 260723-nnr). The displayModel/activeModel resolution that fed the inline
  // badge is now duplicated in RightPanel (reading modelPref localStorage);
  // ChatPanel still owns `persistedModel`/`modelOverride`/`availableModels`
  // for sendMessage, handleModelChange, handleModelCommand, and ChatEmptyState.

  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isHackerTheme = resolvedTheme === "hacker";
  const prevStreamingRef = useRef(false);

  const {
    transcript,
    listening,
    resetTranscript,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition();

  // Update input when speech transcript changes
  useEffect(() => {
    if (transcript) {
      setInput(transcript);
    }
  }, [transcript, setInput]);

  // Feature 4.9.2: announce the stream phase once (start / complete) — never per token.
  useEffect(() => {
    if (isStreaming && !prevStreamingRef.current) {
      setStatusAnnouncement(t("chat.status.responding", "AI is responding..."));
    } else if (!isStreaming && prevStreamingRef.current) {
      setStatusAnnouncement(t("chat.status.complete", "Response complete"));
      const timer = setTimeout(() => setStatusAnnouncement(null), 1500);
      prevStreamingRef.current = isStreaming;
      return () => clearTimeout(timer);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, t, setStatusAnnouncement]);

  // Listen for comparison toggle event
  useEffect(() => {
    const handler = () => setIsComparing((prev) => !prev);
    window.addEventListener("toggle-comparison", handler);
    return () => window.removeEventListener("toggle-comparison", handler);
  }, [setIsComparing]);

  // Animate the single ↔ split comparison toggle via CSS View Transitions
  // (graceful no-op on browsers without support).
  const transitionTo = useViewTransition();
  const setIsComparingWithTransition = (value: boolean) => {
    transitionTo(() => setIsComparing(value));
  };

  // Escape key closes comparison
  useEffect(() => {
    if (!isComparing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsComparing(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isComparing, setIsComparing]);

  // Restore chat from chatStore on mount (session persistence)
  useEffect(() => {
    if (navChatId && currentWorkspaceId && !currentChatId) {
      loadChat(navChatId);
    }
  }, []); // mount only

  // Sync useChat's local currentChatId into ChatContext (nav source of truth).
  // Covers paths that set currentChatId inside useChat without an explicit
  // setChatId call — notably sendMessage creating a brand-new chat (server
  // returns data.chatId). The guard skips null so it never clobbers the
  // mount-restore above (currentChatId is null while navChatId is the restored
  // lastChatId), and the equality check prevents a render loop.
  useEffect(() => {
    if (currentChatId && currentChatId !== navChatId) {
      setChatId(currentChatId);
    }
  }, [currentChatId, navChatId, setChatId]);

  // Persist attached document across navigation
  const attachedDocKey = currentWorkspaceId
    ? `attachedDoc:${currentWorkspaceId}:${currentChatId || "new"}`
    : null;

  useEffect(() => {
    if (!attachedDocKey) return;
    if (attachedDoc) {
      localStorage.setItem(attachedDocKey, JSON.stringify(attachedDoc));
    } else {
      localStorage.removeItem(attachedDocKey);
    }
  }, [attachedDoc, attachedDocKey]);

  useEffect(() => {
    if (!attachedDocKey) return;
    try {
      const saved = localStorage.getItem(attachedDocKey);
      if (saved) {
        const parsed = JSON.parse(saved) as UploadedDoc;
        setAttachedDoc(parsed);
      }
    } catch {
      // ignore parse errors
    }
  }, [attachedDocKey, setAttachedDoc]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    // Record into the persisted global history (terminal-style ↑/↓ recall).
    // Skip slash commands so /model etc. don't pollute the message history.
    if (!trimmed.startsWith("/")) {
      messageHistory.push(trimmed);
    }
    setInput("");
    resetTranscript();
    // 260815-k5s: thread the ephemeral new-chat archive selection so the
    // first message creates an archive-scoped chat row. `?? undefined`
    // keeps the arg absent (not null) when no archive was picked —
    // sendMessage's `...(archiveId && { archiveId })` spread then omits it.
    sendMessage(trimmed, attachedDoc?.id, attachedDoc?.name, modelOverride ?? undefined, newChatArchiveId ?? undefined);
    setAttachedDoc(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ↑/↓ message history — bash-like: only engage when the cursor is on the
    // first line (Up) / last line (Down) so multiline editing still works.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const el = e.currentTarget;
      const at = el.selectionStart ?? el.value.length;
      const noModifier = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (noModifier) {
        const onFirstLine = !el.value.slice(0, at).includes("\n");
        const onLastLine = !el.value.slice(at).includes("\n");
        if (e.key === "ArrowUp" && onFirstLine) {
          const next = messageHistory.navigate("up", el.value);
          if (next != null) {
            e.preventDefault();
            setInput(next);
            // Defer cursor placement to after React reconciles the new value.
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = next.length;
            });
          }
        } else if (e.key === "ArrowDown" && onLastLine) {
          const next = messageHistory.navigate("down", el.value);
          if (next != null) {
            e.preventDefault();
            setInput(next);
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = next.length;
            });
          }
        }
      }
      // Let ArrowUp/Down fall through (no return) so Enter handling below is
      // never reached for arrow keys.
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = input.trim();
      if (trimmed.startsWith("/model")) {
        handleModelCommand(trimmed);
        return;
      }
      handleSend();
    }
  };

  const toggleMic = () => {
    if (listening) {
      SpeechRecognition.stopListening();
    } else {
      SpeechRecognition.startListening({ continuous: true, language: i18n.language });
    }
  };

  const handleReadAloud = async (text: string, msgId: string) => {
    if (ttsPlaying === msgId) {
      speechSynthesis.cancel();
      setTtsPlaying(null);
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => setTtsPlaying(null);
    utterance.onerror = () => setTtsPlaying(null);
    setTtsPlaying(msgId);
    speechSynthesis.speak(utterance);
  };

  const handleModelChange = (selection: { providerId: string; model: string } | null) => {
    if (isStreaming) {
      abortStream();
    }
    setModelOverride(selection);
    if (currentChatId && selection) {
      updateChatModel(selection.providerId, selection.model)
        .then(() => {
          if (currentWorkspaceId) {
            localStorage.setItem(`modelPref:${currentWorkspaceId}`, JSON.stringify(selection));
          }
        })
        .catch(() => {
          showError(t("chat.modelSelector.unavailable", "Failed to update model"));
          setModelOverride(persistedModel);
        });
    } else if (selection && currentWorkspaceId) {
      localStorage.setItem(`modelPref:${currentWorkspaceId}`, JSON.stringify(selection));
    }
  };

  const handleModelCommand = (text: string) => {
    const remainder = text.slice("/model".length).trim();
    setInput(""); // D-08: strip command text before any action

    if (!remainder) {
      // D-07: empty args → open palette with all models
      window.dispatchEvent(new CustomEvent("open-palette"));
      return;
    }

    // D-07: exact match → switch immediately
    const exact = availableModels.find(
      (m) => m.name === remainder || m.displayName === remainder
    );
    if (exact) {
      handleModelChange({ providerId: exact.providerId, model: exact.name });
      return;
    }

    // D-07: partial match → open palette filtered
    const partials = availableModels.filter(
      (m) =>
        m.name.toLowerCase().includes(remainder.toLowerCase()) ||
        (m.displayName && m.displayName.toLowerCase().includes(remainder.toLowerCase()))
    );

    if (partials.length > 0) {
      window.dispatchEvent(new CustomEvent("open-palette", { detail: { filter: remainder } }));
    } else {
      // D-07: no match → error toast
      showError(t("chat.modelCommand.notFound", "Model not found"));
    }
  };

  useEffect(() => {
    setOnSelectModel(handleModelChange);
    return () => {
      setOnSelectModel(null);
    };
  }, [handleModelChange]);

  const handleSelectChat = (chatId: string) => {
    // Keep ChatContext.currentChatId (nav source of truth, read by RightPanel
    // archive-link section + MCP pinners) in sync with the actively-open chat.
    // loadChat only updates useChat's local currentChatId — without this sync,
    // the archive-link section never renders in a fresh session (no
    // localStorage lastChatId to restore from).
    setChatId(chatId);
    loadChat(chatId);
  };

  const handleNewChat = async () => {
    setChatId(null);
    clearChat();
    // 260815-k5s (D-03): reset the ephemeral archive selector to 'none' on
    // every "New chat" so a previous new-chat pick never leaks. The
    // ChatContext reset effect also fires (currentChatId → null), but
    // setting here is explicit and covers the case where navChatId was
    // already null (re-clicking "New chat" in an already-new chat).
    setNewChatArchiveId(null);
    if (!currentWorkspaceId) return;

    const modelPrefKey = `modelPref:${currentWorkspaceId}`;
    // RC-4: read the per-workspace preference (written on every effective
    // model choice, not just explicit dropdown picks) so returning to a new
    // chat restores the same model.
    let pref: { providerId?: string; model?: string } | null = null;
    try {
      const saved = localStorage.getItem(modelPrefKey);
      if (saved) pref = JSON.parse(saved) as { providerId: string; model: string };
    } catch {
      // ignore parse errors
    }

    const globalDefault = getGlobalDefaultModel();

    // Fetch the workspace default up front so it's part of the candidate chain.
    let workspaceDefault: { providerId?: string; model?: string } | null = null;
    try {
      const config = await apiGet<{ providerId?: string; model?: string }>(`/workspaces/${currentWorkspaceId}/agent-config`);
      workspaceDefault = config.providerId ? { providerId: config.providerId, model: config.model || undefined } : null;
    } catch {
      // ignore — resolve without the workspace default candidate
    }

    let resolved: { providerId?: string; model?: string } | null;
    if (availableModels.length > 0) {
      // RC-1: validate every candidate against the live availableModels list.
      // A stale pref / workspace / global default pointing at an unavailable
      // model is skipped; resolveEffectiveModel falls back to the three-tier
      // chain (workspace → global(isDefault) → any available) so a new chat
      // never starts on a broken model.
      resolved = resolveEffectiveModel(availableModels, [pref, workspaceDefault, globalDefault], workspaceDefault);
    } else {
      // Providers query not hydrated yet — best-effort without validation.
      resolved = pref ?? workspaceDefault ?? globalDefault ?? null;
    }

    if (resolved?.providerId) {
      setModelOverride(resolved);
      // Persist the effective model as the workspace preference so the next
      // "New chat" restores it (RC-4). This also covers the auto-default case
      // that the previous code never persisted.
      localStorage.setItem(modelPrefKey, JSON.stringify(resolved));
    } else if (pref) {
      // A stale preference existed but no valid model resolved — inform the
      // user instead of silently starting model-less.
      showInfo(t("chat.palette.fallbackToast"));
    }
  };

  // File upload handler
  const onDrop = async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0 || !currentWorkspaceId) return;
    setUploading(true);

    for (const file of acceptedFiles) {
      if (file.size > MAX_UPLOAD_SIZE) {
        showError(t("chat.upload.tooLarge", "File too large — max 100MB"));
        continue;
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("workspaceId", currentWorkspaceId);

      try {
        const result = await apiUpload<{ id: string }>("/documents/upload", formData);
        // quick 260808-vzm: badge and toast show the same sanitized name the
        // server stores (spaces -> dashes, invalid chars substituted).
        const safeName = sanitizeFileName(file.name);
        setAttachedDoc({ id: result.id, name: safeName });
        showSuccess(`"${safeName}" attached to next message`);
      } catch (err: unknown) {
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 413) {
          showError(t("chat.upload.tooLarge", "File too large — max 100MB"));
        } else if (status === 403) {
          showError(t("chat.upload.noPermission", "You do not have permission to upload documents to this workspace"));
        } else if (status >= 500) {
          showError(t("chat.upload.serverError", "Server error — please try again later"));
        } else if (status === 0 || !status) {
          showError(t("chat.upload.networkError", "Network error — check your connection"));
        } else {
          showError(t("chat.upload.failed", `Failed to upload "${file.name}"`));
        }
      }
    }
    setUploading(false);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    accept: {
      "application/pdf": [".pdf"],
      "text/markdown": [".md"],
      "text/plain": [".txt"],
      "text/csv": [".csv"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    },
  });

  const openCitations = (sources: SourceCitation[]) => {
    setCitationPanelSources(sources);
  };

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e.target as HTMLElement)?.closest("[data-file-link]");
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const fileName = target.getAttribute("data-file-link") || target.textContent?.trim() || "";
      if (!fileName || !/\.[a-z0-9]{1,5}$/i.test(fileName)) return;
      const allSources = messagesRef.current
        .filter((m) => m.metadata?.sources && Array.isArray(m.metadata.sources) && m.metadata.sources.length > 0)
        .flatMap((m) => (m.metadata!.sources ?? []) as SourceCitation[]);
      const matched = allSources.find(
        (s) => s.documentName?.toLowerCase() === fileName.toLowerCase()
          || s.documentName?.toLowerCase().endsWith(fileName.toLowerCase()),
      );
      setCitationPanelSources(matched ? allSources : [
        { documentId: `link-${Date.now()}`, documentName: fileName, chunkText: undefined },
      ]);
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);

  const lastUserMessageId = messages.length > 0
    ? [...messages].reverse().find((m) => m.role === "user")?.id
    : undefined;

  if (!currentWorkspaceId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p>{t("chat.selectWorkspace")}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex h-full" {...getRootProps()}>
      <Input {...getInputProps()} className="hidden" />

      {/* Drag overlay */}
      {isDragActive && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary z-50 flex flex-col items-center justify-center gap-1">
          <p className="text-primary text-lg font-medium">{t("chat.dropzoneHint", "Drop files here to attach to chat")}</p>
          <p className="text-primary text-sm">{t("chat.dropzoneFormats", "Supported: PDF, Markdown, CSV, TXT, DOCX, XLSX (max 100MB)")}</p>
        </div>
      )}

      {/* Chat Sidebar — inline at lg+, Sheet overlay below lg (mobile + tablet).
          The Sheet mirrors the console Sheet's styles and dynamics (same
          width, overlay, close button, controlled-only via `open`), but
          stays anchored to the LEFT — `left-0`, `border-r`, slides in/out
          from the left — instead of the console's right. */}
      {belowLg ? (
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetPortal>
            <SheetOverlay className="bg-black/50 backdrop-blur-sm" />
            <SheetPrimitive.Content
              className={cn(
                "fixed z-50 gap-4 bg-background p-0 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
                "inset-y-0 left-0 h-full w-80 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-xs"
              )}
            >
              <SheetTitle className="sr-only">{t("chat.sidebarTitle", "Chat list")}</SheetTitle>
              <SheetDescription className="sr-only">
                {t("chat.sidebarDescription", "List of your chats in this workspace")}
              </SheetDescription>
              <ChatSidebar
                variant="sheet"
                onClose={() => setMobileSidebarOpen(false)}
                workspaceId={currentWorkspaceId}
                currentChatId={currentChatId}
                onSelectChat={(chatId) => {
                  handleSelectChat(chatId);
                  setMobileSidebarOpen(false);
                }}
                onNewChat={() => {
                  handleNewChat();
                  setMobileSidebarOpen(false);
                }}
              />
            </SheetPrimitive.Content>
          </SheetPortal>
        </Sheet>
      ) : (
        <ChatSidebar
          workspaceId={currentWorkspaceId}
          currentChatId={currentChatId}
          onSelectChat={handleSelectChat}
          onNewChat={handleNewChat}
        />
      )}

      {/* Main Chat Area */}
      {isComparing ? (
        <ModelComparisonView
          workspaceId={currentWorkspaceId}
          onClose={() => setIsComparingWithTransition(false)}
          mainChat={mainChat}
        />
      ) : (
        <div className="relative flex-1 flex flex-col min-w-0">
          {/* Chat title bar — below lg only. Hosts the chat-list and console
              triggers (both collapse to Sheets below lg). Hidden at lg+ where
              the chat sidebar and right console are inline. No title text.
              On mobile/tablet the bar is an `absolute` transparent overlay
              pinned to the top of the chat area: the chat content (ChatMessageList)
              fills the whole strip and scrolls behind it, so the area is
              covered by the chat with no divider line. The container is
              `pointer-events-none` so text behind it stays selectable; only the
              two buttons re-enable `pointer-events-auto`. */}
          <div className="lg:hidden absolute top-0 inset-x-0 z-30 flex items-center justify-between gap-2 px-3 sm:px-4 py-2 pointer-events-none">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileSidebarOpen(true)}
              className="pointer-events-auto shrink-0 -ml-1 bg-background/60 backdrop-blur-sm"
              aria-label={t("chat.openSidebar", "Open chat list")}
              title={t("chat.openSidebar", "Open chat list")}
            >
              <Menu className="w-5 h-5" />
            </Button>
            <div className="flex-1 flex items-center justify-center min-w-0 px-2 pointer-events-auto">
              <ChatModelBadge
                providerId={displayModel?.providerId}
                model={displayModel?.name}
                providerType={displayModel?.providerType}
                capabilities={displayModel?.capabilities}
                isDefault={modelIsDefault}
                size="sm"
                className="max-w-[200px]"
              />
            </div>
            <div className="flex items-center gap-1 pointer-events-auto">
              {messages.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                  if (citationPanelSources) {
                    setCitationPanelSources(null);
                  } else {
                    const allSources = messages
                      .filter((m) => m.metadata?.sources && Array.isArray(m.metadata.sources) && m.metadata.sources.length > 0)
                      .flatMap((m) => (m.metadata!.sources ?? []) as SourceCitation[]);
                    setCitationPanelSources(allSources.length > 0 ? allSources : null);
                  }
                }}
                className="shrink-0 bg-background/60 backdrop-blur-sm text-muted-foreground hover:text-foreground"
                aria-label={t("chat.sources", "Sources")}
                title={t("chat.sources", "Sources")}
              >
                <BookOpen className="w-4 h-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setConsoleOpen(true)}
                className="shrink-0 bg-background/60 backdrop-blur-sm"
                aria-label={t("chat.openConsole", "Open console")}
                title={t("chat.openConsole", "Open console")}
              >
                <PanelRight className="w-5 h-5" />
              </Button>
            </div>
          </div>

          {/* Console Sheet — below lg, surfaces RightPanel content from the right. */}
          <Sheet open={consoleOpen} onOpenChange={setConsoleOpen}>
            <SheetPortal>
              <SheetOverlay className="bg-black/50 backdrop-blur-sm" />
              <SheetPrimitive.Content
                className={cn(
                  "fixed z-50 gap-4 bg-background p-0 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
                  "inset-y-0 right-0 h-full w-80 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-xs"
                )}
              >
                <SheetTitle className="sr-only">{t("rightPanel.title", "Console")}</SheetTitle>
                <SheetDescription className="sr-only">
                  {t("rightPanel.title", "Console")}
                </SheetDescription>
                <SheetPrimitive.Close className="absolute right-3 top-3 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none z-50">
                  <X className="h-4 w-4" />
                  <span className="sr-only">{t("common.close")}</span>
                </SheetPrimitive.Close>
                <RightPanel variant="sheet" selectedProjectId="" />
              </SheetPrimitive.Content>
            </SheetPortal>
          </Sheet>

          {/* Desktop model badge bar — visible at lg+ above messages */}
          <div className="hidden lg:flex items-center justify-end gap-2 px-4 py-1.5 border-b border-border">
            {messages.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (citationPanelSources) {
                    setCitationPanelSources(null);
                  } else {
                    const allSources = messages
                      .filter((m) => m.metadata?.sources && Array.isArray(m.metadata.sources) && m.metadata.sources.length > 0)
                      .flatMap((m) => (m.metadata!.sources ?? []) as SourceCitation[]);
                    setCitationPanelSources(allSources.length > 0 ? allSources : null);
                  }
                }}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t("chat.sources", "Sources")}
                title={t("chat.sources", "Sources")}
              >
                <BookOpen className="w-4 h-4" />
              </Button>
            )}
            <ChatModelBadge
              providerId={displayModel?.providerId}
              model={displayModel?.name}
              providerType={displayModel?.providerType}
              capabilities={displayModel?.capabilities}
              isDefault={modelIsDefault}
              size="sm"
            />
          </div>

          {/* Messages — Feature 4: ChatMessageList owns a11y (role=log,
              aria-live), message animations, auto-scroll, empty state, and the
              streaming indicator. The per-message body (wiki, TTS, edit/delete,
              citations, MCP chips, selection) is rendered via the closure. */}
          <ChatMessageList
            messages={messages}
            isStreaming={isStreaming}
            streamingContent={streamingContent}
            statusMessage={statusMessage}
            activePlan={activePlan}
            statusAnnouncement={statusAnnouncement}
            emptyState={
              <ChatEmptyState
                workspaceId={currentWorkspaceId ?? undefined}
                activeModel={{
                  providerId: modelOverride?.providerId ?? persistedModel?.providerId,
                  model: modelOverride?.model ?? persistedModel?.model,
                }}
                airGapped={/ollama|local/i.test(
                  `${modelOverride?.providerId ?? persistedModel?.providerId ?? ""}`,
                )}
                onQuickAction={(prompt) => setInput(prompt)}
              />
            }
            renderMessage={(msg) => (
              <ChatMessage
                message={msg}
                isHackerTheme={isHackerTheme}
                authUser={authUser ?? null}
                showDlpTexts={showDlpTexts}
                isLastUserMessage={msg.id === lastUserMessageId}
                selectionMode={selectionMode}
                selected={selectedMessageIds.has(msg.id)}
                ttsPlayingId={ttsPlaying}
                onToggleSelect={() => {
                  setSelectedMessageIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(msg.id)) {
                      next.delete(msg.id);
                    } else {
                      next.add(msg.id);
                    }
                    return next;
                  });
                }}
                onRegenerate={regenerateLastResponse}
                onReadAloud={handleReadAloud}
                onEditStart={(id, content) => {
                  setEditingMessageId(id);
                  setEditInput(content);
                }}
                onDelete={setDeletingMessageId}
                onCitationsOpen={openCitations}
                editing={editingMessageId === msg.id}
                editInput={editInput}
                onEditInputChange={setEditInput}
                onEditSave={() => {
                  editLastMessageAndRegenerate(editInput.trim());
                  setEditingMessageId(null);
                }}
                onEditCancel={() => setEditingMessageId(null)}
                renderAssistantBody={
                  msg.metadata?.resolvedWikilinks
                    ? (m) => (
                        <div className="prose prose-sm max-w-none dark:prose-invert chat-ai-body">
                          <WikilinkRenderer
                            content={m.content}
                            resolvedWikilinks={m.metadata!.resolvedWikilinks!}
                            onWikilinkClick={(slug, exists) => {
                              if (exists) {
                                setWikiModalSlug(slug);
                              } else {
                                setWikiCreateSlug(slug);
                              }
                            }}
                            onWikilinkHover={(slug, rect, resolved) => {
                              setWikiTooltip({
                                slug,
                                title: resolved?.title || slug,
                                category: resolved?.category,
                                exists: resolved?.exists ?? false,
                                rect,
                              });
                            }}
                            onWikilinkLeave={() => setWikiTooltip(null)}
                          />
                        </div>
                      )
                    : undefined
                }
                onFollowUpClick={(question) => {
                  if (!isStreaming) sendMessage(question);
                }}
              />
            )}
          />

          {/* Error bar */}
          {error && (
            <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm flex items-center justify-between">
              <span>{error}</span>
              <Button
                variant="link"
                size="sm"
                onClick={() => regenerateLastResponse()}
                className="text-destructive underline text-sm font-medium hover:text-destructive h-auto px-0"
              >
                {t("chat.retry")}
              </Button>
            </div>
          )}

          {/* Wiki distill dialog — its trigger (Save to Wiki) lives in the
              right console panel (RightPanel "Controlli chat"); the dialog
              itself is rendered here where the chat + messages live. State is
              shared via ChatContext (quick 260723-nnr follow-up). The token
              usage panel was removed in follow-up 3 — it now lives as a
              collapsible tendina inside RightPanel "Token Stats". */}
          {currentChatId && (
            <WikiDistillDialog
              open={distillDialogOpen}
              onClose={() => setDistillDialogOpen(false)}
              chatId={currentChatId}
              selectedMessageIds={selectedMessageIds}
              totalMessageCount={messages.length}
            />
          )}

          {/* Status banner — Feature 4.1.1/4.2.3: live SSE status above the
              input, one polite announcement per state change (not per token). */}
          <ChatStatusBanner statusMessage={statusMessage} />

          {/* Input area — Feature 4: ChatInputArea owns auto-expand, send
              feedback (4.7.3), and a11y (4.9.1). Drag-and-drop stays on the
              root container via react-dropzone. */}
          <ChatInputArea
            value={input}
            onChange={setInput}
            onKeyDown={handleKeyDown}
            onSend={handleSend}
            isStreaming={isStreaming}
            onAbort={abortStream}
            attachedDocName={attachedDoc?.name ?? null}
            onRemoveAttachment={() => setAttachedDoc(null)}
            onFileSelect={(files) => onDrop(files)}
            uploading={uploading}
            micSupported={browserSupportsSpeechRecognition}
            micListening={listening}
            onToggleMic={toggleMic}
            isHackerTheme={isHackerTheme}
            actions={
              <button
                type="button"
                onClick={() => setIsComparing(true)}
                className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent/40"
                aria-label={t("chat.compareModelsTitle")}
              >
                <svg className="w-4 h-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span>{t("chat.compareModelsTitle")}</span>
              </button>
            }
            dlpToggle={
              <DlpTextsToggle
                visible={isDlpAdmin}
                checked={showDlpTexts}
                onToggle={setShowDlpTexts}
              />
            }
          />
        </div>
      )}

      {/* Citation Panel */}
      {citationPanelSources && (
        <CitationPanel
          sources={citationPanelSources}
          onClose={() => setCitationPanelSources(null)}
        />
      )}

      {/* Wiki tooltip */}
      <WikiTooltip data={wikiTooltip} />

      {/* Wiki modals — gated on chat.archiveId (D-02: no wiki access without a linked archive) */}
      {wikiModalSlug && linkedArchiveId && (
        <WikiPageModal
          archiveId={linkedArchiveId}
          slug={wikiModalSlug}
          onClose={() => setWikiModalSlug(null)}
        />
      )}
      {wikiCreateSlug && linkedArchiveId && (
        <WikiBrokenLinkDialog
          archiveId={linkedArchiveId}
          slug={wikiCreateSlug}
          onClose={() => setWikiCreateSlug(null)}
          onCreated={() => setWikiCreateSlug(null)}
        />
      )}

      {/* Message delete confirmation dialog */}
      {deletingMessageId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-lg w-80 p-4 space-y-3">
            <h3 className="text-base font-semibold text-foreground">
              {t("chat.deleteMessage", "Delete message")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("chat.deleteMessageConfirm", "Are you sure you want to delete this message?")}
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeletingMessageId(null)}
              >
                {t("chat.cancel", "Cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  removeMessage(deletingMessageId);
                  setDeletingMessageId(null);
                }}
              >
                {t("chat.deleteMessage", "Delete message")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
