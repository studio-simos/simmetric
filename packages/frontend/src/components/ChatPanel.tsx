// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useRef, useEffect, useState, useEffectEvent, useMemo } from "react";
import { useChatNav } from "../contexts/ChatContext";
import { useTheme } from "../contexts/ThemeContext";
import { useChat, resolveEffectiveModel, type SourceCitation } from "../hooks/useChat";
import { useSkills, type CustomSkillRow } from "../queries/useSkills";
import { parseSkillArgs } from "../utils/skillArgs";
import { useDropzone } from "react-dropzone";
import { useTranslation } from "react-i18next";
import { apiGet, apiUpload, ApiError } from "../utils/api";
import { showSuccess, showError, showInfo } from "../lib/toast";
import { getGlobalDefaultModel } from "../utils/modelDefaults";
import { setOnSelectModel } from "../hooks/usePaletteCallbacks";
import { useAvailableModels } from "../queries/useProviders";
import { useMe } from "../queries/useAuth";
import { useChatPanelState, type UploadedDoc } from "../hooks/useChatPanelState";
import { useMessageHistory } from "../hooks/useMessageHistory";
import RightPanel from "./RightPanel";
import CitationPanel from "./CitationPanel";
import SkillsPalette, { type SkillsPaletteItem } from "./SkillsPalette";
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
// Phase 191 (KNOW-01 D-06): archive attach picker + composer selection state.
import ArchiveAttachPicker from "./chat/ArchiveAttachPicker";
import { useChats } from "../queries/useChats";
import { useSettingsHelpers } from "../queries/useSettings";
import { X, BookOpen, PanelRight } from "lucide-react";
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
    // 260815-k5s: ephemeral new-chat archive selection. Threaded to sendMessage
    // so the first message creates an archive-scoped chat row (no post-hoc
    // PATCH). Cleared by the ChatContext reset effect once currentChatId
    // becomes non-null; the panel's new-chat transition (reconciler case b)
    // resets it too — including re-clicks in an already-new chat.
    newChatArchiveId,
    setNewChatArchiveId,
  } = useChatNav();
  // Phase 191 (KNOW-02 D-05/D-06): chat-attached archive selection. useState
  // (Zustand-free) mirroring the attachedDoc pattern; the localStorage key
  // below is the DRAFT cache (new chats + refresh survival) while the Chat
  // record is the source of truth (restore via useChat's setRestoredArchiveIds
  // seam). Declared BEFORE the useChat call: the overrides object reads
  // `attachedArchives` eagerly (191-03 WR-01 mirror), so the binding must
  // already be initialized — the old "React hoists the useState" note was
  // only true for the callback reference, never for the value read.
  const [attachedArchives, setAttachedArchives] = useState<string[]>([]);
  const [archivePickerOpen, setArchivePickerOpen] = useState(false);
  const MAX_ATTACHED_ARCHIVES = 5;

  const mainChat = useChat(currentWorkspaceId, {
    // Phase 191 (KNOW-02 D-05): the server record is the source of truth —
    // when loadChat surfaces the chat row's attachedArchiveIds, seed the
    // composer selection with it (the localStorage key is only a draft cache).
    setRestoredArchiveIds: (ids: string[]) => setAttachedArchives(ids),
    // 191-03 (WR-01 review fix): mirror the composer selection into useChat's
    // ref so retryMessage (regenerate / edit-regenerate / model-fallback)
    // sends the CURRENT selection — the turn stays grounded and the server
    // mirror keeps tracking it.
    attachedArchives,
  });
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

  // Phase 190 (SKIL-02, D-05/D-10): the /slug parser + palette read the SAME
  // useSkills cache as the /skills management page (staleTime 5min — no fetch
  // per keystroke). Match set = custom (own + visible globals) ∪ accessible
  // (other users' workspace-scoped rows in viewer+ workspaces) — the exact
  // set resolveInvocableSkill would resolve; builtin slugs are EXCLUDED so
  // typing a builtin name falls through to a normal message (never-error).
  const skillsQuery = useSkills();
  // CR-01 (SKIL-03/D-05): the match set never offers a row scoped to ANOTHER
  // workspace — the server's resolveInvocableSkill workspace arm would reject
  // it, so a stale cache entry would advertise a dead command ("Skill '/x' is
  // not available" on a row the UI itself offered).
  const invocableSkills: CustomSkillRow[] = useMemo(() => {
    const list = skillsQuery.data;
    if (!list) return [];
    return [...list.custom, ...list.accessible].filter(
      (s) => s.isEnabled && (s.workspaceId === null || s.workspaceId === currentWorkspaceId),
    );
  }, [skillsQuery.data, currentWorkspaceId]);

  // Phase 190 (SKIL-02, D-10): the skills palette is a SEPARATE surface from
  // the /model palette (Pitfall 9 — own open state, never the CustomEvent).
  // It opens when the input's first character is "/" EXCEPT the /model family
  // (that branch owns its own surface — the two never double-open), and a
  // space after the slug closes it (space-disambiguation: args are coming).
  const [skillsPaletteOpen, setSkillsPaletteOpen] = useState(false);
  const skillsPaletteItems: SkillsPaletteItem[] = useMemo(
    () =>
      invocableSkills.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description ?? "",
      })),
    [invocableSkills],
  );
  const skillsPaletteBuiltins: SkillsPaletteItem[] = useMemo(
    () =>
      (skillsQuery.data?.builtin ?? []).map((b) => ({
        slug: b.name,
        name: b.displayName,
        description: b.description,
      })),
    [skillsQuery.data],
  );

  // Below lg (1024px) the console surfaces via a Sheet opened from a trigger
  // in the model badge bar; at lg+ the console is inline (RightPanel).
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

  // White-label app name for the chat empty-state wordmark (UI revision R-2).
  // Cached TanStack query — same cache the Settings page reads, no extra fetch.
  const { getValue: getSetting } = useSettingsHelpers();
  const brandingAppName = getSetting("BRANDING_APP_NAME");

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
    statusAnnouncement,
    setStatusAnnouncement,
    showDlpTexts,
    setShowDlpTexts,
  } = useChatPanelState({ persistedModel });

  // Phase 190 (SKIL-02, D-09): chat-level notice for a matched skill whose
  // params could not be parsed — visible above the input, never silent.
  const [skillParamError, setSkillParamError] = useState<string | null>(null);

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

  // Phase 190 (D-10): palette open-state follows the input's first character.
  // Opens on "/", closes when the leading slash is gone, when a space follows
  // the slug (space-disambiguation — the user is writing args), or when the
  // input is the /model family (that surface owns its own palette; the two
  // never double-open — Pitfall 9).
  useEffect(() => {
    const trimmedStart = input.trimStart();
    const isModelFamily = trimmedStart.startsWith("/model");
    const spaceAfterSlug = /^\/[a-z0-9-]+\s/.test(trimmedStart);
    setSkillsPaletteOpen(
      trimmedStart.startsWith("/") && !isModelFamily && !spaceAfterSlug,
    );
  }, [input]);

  // Close the palette + clear the paramError notice on chat/workspace switch.
  useEffect(() => {
    setSkillParamError(null);
  }, [currentChatId, currentWorkspaceId, setSkillParamError]);

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

  // Restore chat from chatStore on mount + when a chat is selected from the
  // global sidebar (App.tsx wires the sidebar's ChatSidebar to onSelectChat →
  // setChatId, which lands here via navChatId). While a stream is active the
  // panel is unmounted, so switching mid-stream is impossible. `loadChat` is
  // a stable useChatPersistence closure; it is read through the useEffectEvent
  // channel below so the deps stay free of the whole `mainChat` object.
  const restoreChat = useEffectEvent(() => {
    if (navChatId && currentWorkspaceId && !currentChatId) {
      loadChat(navChatId);
    }
  });
  useEffect(() => {
    restoreChat();
  }, [navChatId, currentWorkspaceId]);

  // RC-4 model re-seed for the new-chat transition — restored from the
  // pre-R5 handleNewChat body (the clearChat/setChatId parts live in the
  // reconciler below; only the model-resolution chain is mirrored here).
  const reseedNewChatModel = async () => {
    if (!currentWorkspaceId) return;

    const modelPrefKey = `modelPref:${currentWorkspaceId}`;
    // Read the per-workspace preference (written on every effective model
    // choice) so returning to a new chat restores the same model.
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
      // useChatPanelState mirrors persistedModel → modelOverride via an
      // effect on [persistedModel]; this explicit set lands after (async) and
      // wins, so the override follows the re-seeded model.
      setModelOverride(resolved);
      // Persist the effective model as the workspace preference so the next
      // "New chat" restores it (RC-4). This also covers the auto-default case.
      localStorage.setItem(modelPrefKey, JSON.stringify(resolved));
    } else if (pref) {
      // A stale preference existed but no valid model resolved — inform the
      // user instead of silently starting model-less.
      showInfo(t("chat.palette.fallbackToast"));
    }
  };

  // ── Nav-transition reconciler (quick 260910-e0n — R-5 regression fix) ──
  // The R-5 refactor moved ChatSidebar out of this panel into AppSidebar and
  // replaced the panel-side handlers (handleSelectChat/handleNewChat) with
  // bare nav-state writes in App.tsx (setChatId only). Nothing reconciled
  // useChat's internal state with those nav transitions, so the old
  // sync-back effect (below) blindly re-adopted useChat's stale chat id into
  // nav: with chat-A open, `setChatId(null)` was immediately undone by
  // `setChatId("chat-A")` — "New chat" and chat selection were both no-ops.
  //
  // The fix is a prev-value state machine: `nav=null && chat≠null` is
  // AMBIGUOUS (it means both "user pressed New chat" and "first message of a
  // new chat just created one via the SSE done event → setCurrentChatId"), so
  // a prev ref distinguishes the transitions:
  //   (a) creation adoption — previous chat was null, useChat adopted a
  //       server chatId: write it into nav (what the deleted sync-back
  //       effect existed for; the sendMessage `done` path).
  //   (b) new chat / workspace switch — nav went truthy → null while a chat
  //       is still open: abort any in-flight stream FIRST (so its `done`
  //       event cannot re-adopt the old chat after the clear), then
  //       clearChat + reset the ephemeral archive pick + re-seed the model
  //       from the RC-4 preference chain (parity with the pre-R5
  //       handleNewChat).
  //   (c) selection switch — nav moved from one chat to another while a chat
  //       is open: loadChat(navChatId). (When useChat's currentChatId is
  //       null the restoreChat effect above already owns the load — staying
  //       out of that path avoids a double loadChat.)
  // The prev ref is REQUIRED for (a) vs (b): without it a naive
  // `!navChatId` guard breaks creation adoption, and a naive reconciler
  // without prev-state clears a just-finished conversation.
  // useEffectEvent keeps the deps array free of the whole mainChat object
  // (same channel as restoreChat above). currentWorkspaceId is NOT a dep:
  // a workspace switch clears navChatId in the same event (ChatContext
  // setWorkspaceId), so case (b) fires through navChatId, and the re-seed
  // reads the fresh workspace through the useEffectEvent channel.
  const prevNavRef = useRef<{ nav: string | null; chat: string | null }>({
    nav: navChatId,
    chat: currentChatId,
  });

  const reconcileNav = useEffectEvent(() => {
    const prev = prevNavRef.current;
    prevNavRef.current = { nav: navChatId, chat: currentChatId };

    // (a) Creation adoption: useChat picked up a server chatId while nav had
    // no chat — adopt it into nav (preserves the deleted sync-back behavior).
    if (!prev.chat && currentChatId && currentChatId !== navChatId) {
      setChatId(currentChatId);
      return;
    }
    // (b) New chat / workspace switch: navChatId went truthy → null with an
    // open chat — clear the panel (aborting any in-flight stream first) and
    // re-seed the model preference chain.
    if (!navChatId && prev.nav && currentChatId) {
      if (isStreaming) {
        abortStream();
      }
      clearChat();
      setNewChatArchiveId(null);
      void reseedNewChatModel();
      return;
    }
    // (c) Selection switch: nav moved from one open chat to another — load
    // the newly selected chat instead of letting a stale id bounce back.
    if (navChatId && prev.nav && prev.nav !== navChatId && currentChatId && currentChatId !== navChatId) {
      loadChat(navChatId);
    }
  });
  useEffect(() => {
    reconcileNav();
  }, [navChatId, currentChatId]);

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

  // ── Phase 191 (KNOW-02 D-05): attached-archive draft persistence ──
  // Two-layer persistence mirroring the attachedDoc pattern: the localStorage
  // key is the DRAFT cache (new chats where no Chat row exists yet + refresh
  // survival within a session), while the Chat record (mirrored server-side
  // by syncChatAttachment) is the source of truth restored via the
  // setRestoredArchiveIds seam.
  const attachedArchivesKey = currentWorkspaceId
    ? `attachedArchives:${currentWorkspaceId}:${currentChatId || "new"}`
    : null;

  // Write effect: set when non-empty, remove when empty.
  useEffect(() => {
    if (!attachedArchivesKey) return;
    if (attachedArchives.length > 0) {
      localStorage.setItem(attachedArchivesKey, JSON.stringify(attachedArchives));
    } else {
      localStorage.removeItem(attachedArchivesKey);
    }
  }, [attachedArchives, attachedArchivesKey]);

  // Read effect: keyed on the key — parse defensively (untrusted client cache,
  // T-191-04: tampered drafts degrade to no-op retrieval because the server
  // re-resolves org scope on every send; IN-02 review fix: tampered drafts
  // are CLAMPED to the 5-cap instead of surfacing a schema 400 on send).
  useEffect(() => {
    if (!attachedArchivesKey) return;
    try {
      const saved = localStorage.getItem(attachedArchivesKey);
      if (saved) {
        const parsed = JSON.parse(saved) as unknown;
        if (Array.isArray(parsed)) {
          setAttachedArchives(parsed.filter((v): v is string => typeof v === "string").slice(0, MAX_ATTACHED_ARCHIVES));
        }
      } else {
        setAttachedArchives([]);
      }
    } catch {
      // ignore parse errors — the draft is convenience-only
    }
    // 191-04 (WR-02 review fix): the previous gate
    // `attachedArchivesKey.endsWith(":new") && currentChatId` was DEAD —
    // the key ends with ":new" only while currentChatId is null, so the
    // conjunction could never hold and an abandoned `attachedArchives:<ws>:new`
    // draft was never removed (it re-attached its archives to the next new
    // chat and silently attached them on the first send). Fix: clear the
    // ":new" variant whenever a REAL chat id is active — i.e. the first
    // message adopted a chat, so the draft has served its purpose and the
    // live selection now lives under the chatId key. The read effect for the
    // new chat key has already run by then (this same effect), so the cleanup
    // cannot race the restore.
    if (currentChatId && currentWorkspaceId) {
      const newKey = `attachedArchives:${currentWorkspaceId}:new`;
      if (localStorage.getItem(newKey)) localStorage.removeItem(newKey);
    }
  }, [attachedArchivesKey, currentChatId, currentWorkspaceId]);

  // Toggle handler — respects the max-5 cap (D-01; UI mirrors the wire cap
  // so the send never 400s at the schema boundary).
  const handleToggleArchive = (id: string) => {
    setAttachedArchives((prev) =>
      prev.includes(id)
        ? prev.filter((a) => a !== id)
        : prev.length >= MAX_ATTACHED_ARCHIVES
          ? prev
          : [...prev, id],
    );
  };

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
    // Phase 191 (D-02): 7th arg threads the attached-archive selection —
    // only-when-non-empty (absent keeps the body byte-identical). Unlike
    // attachedDoc, the selection is NOT cleared after send (KNOW-02: it
    // persists across messages within the chat session).
    sendMessage(
      trimmed,
      attachedDoc?.id,
      attachedDoc?.name,
      modelOverride ?? undefined,
      newChatArchiveId ?? undefined,
      undefined,
      attachedArchives.length > 0 ? attachedArchives : undefined,
    );
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
      // ── Phase 190 (SKIL-02, D-08): generic /slug parser — strictly AFTER
      // the /model branch (Pitfall 9: the /model surface stays byte-identical).
      // Never-error rule (D-08): the never-error contract applies to slug
      // MATCHING only — an unmatched /word falls through to handleSend() as a
      // normal message; a MATCHED skill with malformed params shows the
      // chat-level paramError notice instead of sending (D-09 not-silent arm).
      if (trimmed.startsWith("/")) {
        const m = /^\/([a-z0-9-]+)(?:\s+(.*))?$/.exec(trimmed);
        const slug = m?.[1];
        const skill = slug ? invocableSkills.find((s) => s.slug === slug) : undefined;
        if (skill) {
          const parsed = parseSkillArgs(
            m?.[2] ?? "",
            skill.inputSchema,
            skill.config.defaultParams ?? {},
          );
          if (parsed.ok) {
            // D-11: the FULL typed text is the message (min(1) satisfied — the
            // user sees their invocation in the transcript); the structured
            // skillCall rides additively — the server re-resolves + compiles.
            // Phase 191 (D-02): the 7th arg keeps followups/invocations
            // grounded in the attached archives; selection persists (KNOW-02).
            sendMessage(
              trimmed,
              attachedDoc?.id,
              attachedDoc?.name,
              modelOverride ?? undefined,
              newChatArchiveId ?? undefined,
              { slug: skill.slug, params: parsed.params },
              attachedArchives.length > 0 ? attachedArchives : undefined,
            );
            setInput("");
            if (attachedDoc) setAttachedDoc(null);
            return;
          }
          // D-09: matched skill + unreadable params → visible notice above the
          // input, nothing sent (never a silent normal-send of a failed call).
          setSkillParamError(t("chat.skillsPalette.paramError", "Could not read parameters for /{{slug}}. Try /{{slug}} key=value.", { slug }));
          return;
        }
        // slug unmatched (incl. builtin names) → fall through to handleSend().
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

      {/* Main Chat Area — the conversation list lives in the global AppSidebar
          (App.tsx wires onSelectChat/onNewChat into this panel); this panel
          hosts only the conversation surface. */}
      {isComparing ? (
        <ModelComparisonView
          workspaceId={currentWorkspaceId}
          onClose={() => setIsComparingWithTransition(false)}
          mainChat={mainChat}
        />
      ) : (
        <div className="relative flex-1 flex flex-col min-w-0">
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

          {/* Model badge bar — above the messages; on <lg the console trigger
              also lives here (the inline RightPanel is hidden below lg). */}
          <div className="flex items-center justify-end gap-2 px-4 py-1.5 border-b border-border">
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
            {/* Console trigger — only where the inline RightPanel is hidden. */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setConsoleOpen(true)}
              className="lg:hidden shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t("chat.openConsole", "Open console")}
              title={t("chat.openConsole", "Open console")}
            >
              <PanelRight className="w-4 h-4" />
            </Button>
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
                appName={brandingAppName || undefined}
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
                  // Phase 191 (D-02): followups stay grounded — the same 7th
                  // arg rides the direct sendMessage call (selection persists
                  // across messages, KNOW-02).
                  if (!isStreaming)
                    sendMessage(question, undefined, undefined, undefined, undefined, undefined, attachedArchives.length > 0 ? attachedArchives : undefined);
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

          {/* Phase 190 (D-09): paramError notice — a matched skill whose args
              could not be parsed surfaces here instead of sending. Destructive
              tint per the UI-SPEC color contract; dismissible. */}
          {skillParamError && (
            <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm flex items-center justify-between" role="alert">
              <span>{skillParamError}</span>
              <Button
                variant="link"
                size="sm"
                onClick={() => setSkillParamError(null)}
                className="text-destructive underline text-sm font-medium hover:text-destructive h-auto px-0"
                aria-label={t("chat.cancel", "Cancel")}
              >
                {t("chat.cancel", "Cancel")}
              </Button>
            </div>
          )}

          {/* Status banner — Feature 4.1.1/4.2.3: live SSE status above the
              input, one polite announcement per state change (not per token). */}
          <ChatStatusBanner statusMessage={statusMessage} />

          {/* Input area — Feature 4: ChatInputArea owns auto-expand, send
              feedback (4.7.3), and a11y (4.9.1). Drag-and-drop stays on the
              root container via react-dropzone. The Phase 190 skills palette
              (SKIL-02/D-10) renders inside this relative wrapper: its anchor
              div hugs the input area's bottom edge and the popover opens
              side="top" above the input — a separate surface from the /model
              palette (Pitfall 9: own open state, never the CustomEvent). */}
          <div className="relative">
            <SkillsPalette
              open={skillsPaletteOpen}
              onClose={() => setSkillsPaletteOpen(false)}
              onSelect={(slug) => {
                // UI-SPEC: selecting inserts "/slug " into the input — NEVER
                // sends. The open-state effect closes it right after (the
                // inserted space hits the space-disambiguation arm too).
                setInput(`/${slug} `);
              }}
              query={input}
              items={skillsPaletteItems}
              builtinItems={skillsPaletteBuiltins}
            />
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
            /* quick 260919-qjg: the archive list lives INSIDE the "+" popover
               as a Knowledge submenu — onAttachArchive now means "open the
               submenu" (the flag still owns the panel-slot mount); the back
               row resets it. Chips stay above the input via the mode="chips"
               instance; the mode="panel" instance is gated on
               archivePickerOpen so the useArchives mount follows the flag.
               Nothing but the chips overlays the chat area above the input. */
            onAttachArchive={() => setArchivePickerOpen(true)}
            onKnowledgeBack={() => setArchivePickerOpen(false)}
            archivePicker={
              attachedArchives.length > 0 ? (
                <ArchiveAttachPicker
                  mode="chips"
                  selectedIds={attachedArchives}
                  onToggle={handleToggleArchive}
                  max={MAX_ATTACHED_ARCHIVES}
                />
              ) : undefined
            }
            archivePickerPanel={
              archivePickerOpen ? (
                <ArchiveAttachPicker
                  mode="panel"
                  selectedIds={attachedArchives}
                  onToggle={handleToggleArchive}
                  max={MAX_ATTACHED_ARCHIVES}
                />
              ) : undefined
            }
            actions={
              <button
                type="button"
                onClick={() => setIsComparing(true)}
                className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent/40"
                aria-label={t("chat.compareModelsTitle", "Compare")}
              >
                <svg className="w-4 h-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span>{t("chat.compareModelsTitle", "Compare")}</span>
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
