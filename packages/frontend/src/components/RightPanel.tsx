// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronLeft, ChevronDown, Plug, Cpu, Archive, History, SlidersHorizontal, CheckSquare, BookOpen } from "lucide-react";
import { GlassPanel } from "./GlassPanel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChatNav } from "../contexts/ChatContext";
import { useSessionTokens, useChatTokens } from "../queries/useChatTokens";
import { useMcpConnections } from "../queries/useMcpConnections";
import { useChats, useLinkArchive } from "../queries/useChats";
import { useArchives } from "../queries/useArchives";
import { useMe } from "../queries/useAuth";
import { useAvailableModels } from "../queries/useProviders";
import { useModelAvailability } from "../hooks/useModelAvailability";
import { formatTokens } from "../utils/tokens";
import { ChatModelBadge } from "./chat/ChatModelBadge";
import McpPinnerPopover from "./McpPinnerPopover";
import McpHelpPopover from "./McpHelpPopover";
import { WikiHistoryModal } from "./WikiHistoryModal";
import { TokenStatsDetail } from "./TokenCounterPanel";

/** Built-in agent skills surfaced statically (descriptions live in i18n). */
const BUILTIN_SKILLS = [
  "rag_search",
  "workspace_memory",
  "wiki_query",
  "wiki_write",
  "document_temp_process",
] as const;

const STATUS_DOT: Record<string, string> = {
  connected: "bg-primary",
  disconnected: "bg-muted-foreground/50",
  error: "bg-destructive",
  unknown: "bg-muted-foreground/30",
};

export interface RightPanelProps {
  /** Active project id — used to surface project-scoped MCP connections. */
  selectedProjectId: string;
  className?: string;
  /**
   * "panel" (default) — desktop right-side console: `hidden lg:flex`, collapses
   * to a thin rail, open state persisted to localStorage.
   * "sheet" — content only, no rail / collapse / `hidden` wrapper. Rendered
   * inside the mobile/tablet console Sheet (below `lg`) where the panel
   * variant is hidden.
   */
  variant?: "panel" | "sheet";
}

/**
 * RightPanel — collapsible right-side console (Feature 3.5 / UI_DESIGN.md).
 *
 * Three stacked sections inside a glass-panel:
 * 1. Token Stats — today's session totals (reuse useSessionTokens) plus, when a
 *    chat is open, the per-conversation breakdown (useChatTokens).
 * 2. Archivio collegato (Phase 80 D-05) — Select linking the chat to a
 *    workspace archive; permission-gated (chat:write + archive:read); shows
 *    the linked archive page count (D-15) and an empty state when the
 *    workspace has no archives.
 * 3. Skills & MCP — the five built-in agent skills (static, descriptions via
 *    i18n) and the workspace/project MCP connections with live status dots.
 *
 * Collapsed state persists to `localStorage["right-panel-open"]` (default open).
 * Hidden below `lg` (panel variant) to keep the chat area readable on smaller
 * screens — below `lg` the same content is surfaced via the chat title bar
 * console trigger using the "sheet" variant.
 */
export default function RightPanel({ selectedProjectId, className, variant = "panel" }: RightPanelProps) {
  const { t } = useTranslation();
  const {
    currentWorkspaceId,
    currentChatId,
    // Chat panel action state (quick 260723-nnr follow-up) — Select messages +
    // Save to Wiki controls relocated here from the ChatToolbar above the
    // message input. State is shared with ChatPanel via ChatContext. (The
    // Tokens toggle was removed in follow-up 3 — token usage now lives in the
    // Token Stats collapsible tendina below, no longer a chat-area panel.)
    selectionMode,
    setSelectionMode,
    selectedMessageIds,
    setSelectedMessageIds,
    setDistillDialogOpen,
    messageCount,
    // 260815-k5s: ephemeral new-chat archive selection — read for display and
    // mutated in the new-chat branch of handleArchiveChange (no server call).
    newChatArchiveId,
    setNewChatArchiveId,
  } = useChatNav();

  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem("right-panel-open");
    return saved === null ? true : saved === "true";
  });

  useEffect(() => {
    // Only persist the desktop panel's collapsed state — the sheet variant is
    // transient (driven by the Sheet open state in ChatPanel).
    if (variant === "panel") {
      localStorage.setItem("right-panel-open", String(open));
    }
  }, [open, variant]);

  // Token stats
  const { data: session } = useSessionTokens(currentWorkspaceId ?? undefined);
  const { data: chatTokens } = useChatTokens(currentWorkspaceId ?? undefined, currentChatId);

  // Phase 80 — linked archive section (D-05, D-06, D-07, D-15)
  const { data: authUser } = useMe();
  const { data: chats = [] } = useChats(currentWorkspaceId ?? undefined);
  const { data: archives = [] } = useArchives(!!currentWorkspaceId);
  const linkArchiveMutation = useLinkArchive();

  // Chat controls (quick 260723-nnr) — model selector + MCP toggles + wiki
  // history relocated from the message input bar into the console panel. The
  // displayModel resolution mirrors ChatPanel.tsx (lines 145-159) but without
  // the ephemeral modelOverride (which lives in ChatPanel); for an existing
  // chat the persisted Chat.providerId/model is the source of truth, and for
  // a brand-new chat the localStorage modelPref:<workspaceId> holds the same
  // value handleNewChat writes.
  const { data: availableModels = [] } = useAvailableModels(currentWorkspaceId !== null);
  const { isStale } = useModelAvailability(currentWorkspaceId !== null);
  const [showHistory, setShowHistory] = useState(false);
  // Collapsible "Token Stats" detail tendina (quick 260723-nnr follow-up 3).
  // The compact IN/OUT/TOT grid stays always visible; expanding reveals the
  // full Conversation/Today breakdown (TokenStatsDetail). Defaults collapsed
  // to keep the console scannable.
  const [tokenDetailOpen, setTokenDetailOpen] = useState(false);
  // D-01 single source of truth: linked archive id comes from the persisted
  // `chat.archiveId` surfaced by the chat list query — never a local useState.
  const activeChatSummary = chats.find((c) => c.id === currentChatId);
  const linkedArchiveId = activeChatSummary?.archiveId ?? null;
  // 260815-k5s: the archive the selector should display. For an existing
  // chat, the persisted `chat.archiveId` is the source of truth. For a
  // brand-new chat (currentChatId null), the ephemeral `newChatArchiveId`
  // from ChatContext drives the Select + page-count subtitle until the first
  // message creates the chat row.
  const displayArchiveId = currentChatId ? linkedArchiveId : newChatArchiveId;
  // Track the previous value for optimistic rollback on mutation error (D-08).
  const previousArchiveIdRef = useRef<string | null>(linkedArchiveId);
  useEffect(() => {
    // Keep the rollback ref in sync when the persisted value changes
    // (e.g. after a successful mutation invalidates + re-syncs the cache).
    previousArchiveIdRef.current = linkedArchiveId;
  }, [linkedArchiveId]);

  // 260815-k5s (D-01): drop the `!!currentChatId` gate so the section renders
  // for a brand-new chat too — gated only on workspace + permissions. The
  // new-chat branch of handleArchiveChange mutates the ephemeral state
  // instead of PATCHing.
  const canLinkArchive =
    !!currentWorkspaceId &&
    !!authUser?.permissions?.includes("chat:write") &&
    !!authUser?.permissions?.includes("archive:read");

  // Whether the user may open the wiki history modal — mirrors the original
  // ChatPanel guard (archive:write + a linked archive). A new chat has no
  // persisted archive, so the button stays hidden — correct.
  const canViewWikiHistory =
    !!authUser?.permissions?.includes("archive:write") && !!linkedArchiveId;

  // displayModel resolution (see comment block above). The single source the
  // console panel can read without reaching into the per-chat useChat hook is
  // the `modelPref:<workspaceId>` localStorage entry — which handleModelChange
  // (ChatPanel) and loadChat both write on every model switch / chat load, so
  // it tracks the effective model for both new and existing chats in this
  // workspace. The badge is informational; clicking it dispatches
  // `open-palette`, whose setOnSelectModel handler still lives in ChatPanel.
  const prefModel = useMemo(() => {
    if (!currentWorkspaceId) return null;
    try {
      const raw = localStorage.getItem(`modelPref:${currentWorkspaceId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { providerId: string; model: string } | null;
      return parsed && parsed.providerId && parsed.model ? parsed : null;
    } catch {
      return null;
    }
  }, [currentWorkspaceId]);
  const activeProviderId = prefModel?.providerId;
  const activeModelName = prefModel?.model;
  const activeModel = availableModels.find(
    (m) => m.providerId === activeProviderId && m.name === activeModelName,
  );
  const modelUnavailable = !!prefModel?.providerId && !availableModels.find(
    (m) => m.providerId === prefModel.providerId && m.name === prefModel.model,
  );
  const defaultModel = availableModels.find((m) => m.isDefault) ?? availableModels[0] ?? null;
  const displayModel = activeModel ?? defaultModel;
  const modelIsDefault = !activeModel && !!defaultModel;

  // Match the displayed archive in the workspace list to read _count.pages
  // (D-15). 260815-k5s: for a new chat, displayArchiveId is the ephemeral
  // newChatArchiveId; for an existing chat, it's the persisted linkedArchiveId.
  const displayArchive = archives.find((a) => a.id === displayArchiveId);
  const displayArchivePageCount = displayArchive?._count?.pages ?? 0;

  function handleArchiveChange(value: string) {
    if (!currentWorkspaceId) return;
    const nextArchiveId = value === "" ? null : value;
    // 260815-k5s: branch on whether this is a brand-new chat or an existing
    // one. Existing chat → PATCH the persisted chat.archiveId (unchanged).
    // New chat (no currentChatId) → mutate the ephemeral ChatContext state;
    // no server call until the first message threads it into the stream body.
    if (!currentChatId) {
      setNewChatArchiveId(nextArchiveId);
      return;
    }
    previousArchiveIdRef.current = linkedArchiveId;
    linkArchiveMutation.mutate(
      { workspaceId: currentWorkspaceId, chatId: currentChatId, archiveId: nextArchiveId },
      {
        onError: () => {
          // Optimistic rollback is implicit: the chats query is NOT invalidated
          // on error, so `linkedArchiveId` stays at the previous value via the
          // cache. The mutation's onError toast (chat.archive.error) is wired
          // in useLinkArchive. No action needed here.
        },
      },
    );
  }

  // MCP connections scoped to the active workspace or project
  const { data: connections = [] } = useMcpConnections();
  const scopedConnections = connections.filter(
    (c) =>
      (currentWorkspaceId && c.workspaceId === currentWorkspaceId) ||
      (selectedProjectId && c.projectId === selectedProjectId),
  );

  const inToday = session?.totalInput ?? 0;
  const outToday = session?.totalOutput ?? 0;
  const totalToday = session?.total ?? 0;
  const hasTokens = totalToday > 0;

  // Shared body — the two stacked sections. Rendered both by the desktop
  // panel (panel variant) and the mobile/tablet Sheet (sheet variant).
  const body = (
    <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-0">
        {/* 0. Chat controls (quick 260723-nnr) — model selector + MCP toggles +
            wiki history relocated here from the message input bar. */}
        <section className="space-y-1.5">
          <SectionTitle icon={<SlidersHorizontal className="w-3 h-3" />}>
            {t("rightPanel.chatControls")}
          </SectionTitle>
          {/* Row 1 — model selector (opens palette via Cmd+K-style badge). */}
          <div className="flex items-center gap-1">
            <ChatModelBadge
              providerId={displayModel?.providerId}
              model={displayModel?.name}
              providerType={displayModel?.providerType}
              capabilities={displayModel?.capabilities}
              unavailable={modelUnavailable}
              isDefault={modelIsDefault}
              isStale={isStale}
              size="md"
            />
          </div>
          {/* Row 2 — per-chat action buttons: MCP pin, MCP help, wiki history.
              The pinner stays enabled without a chat so pins can be staged
              for a brand-new chat (flushed on first message); it needs a
              workspace to scope the connection list. */}
          <div className="flex items-center gap-1 flex-wrap">
            <McpPinnerPopover disabled={!currentWorkspaceId} />
            <McpHelpPopover disabled={!currentChatId} />
            {canViewWikiHistory && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowHistory(true)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title={t("wiki.historyTitle", "Wiki History")}
                    aria-label={t("wiki.historyTitle", "Wiki History")}
                  >
                    <History className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{t("wiki.historyTitle", "Wiki History")}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {/* Row 3 — chat actions relocated from the bar above the message
              input (ChatToolbar): Select messages, Save to Wiki. (Tokens was
              removed in follow-up 3 — its functions now live in the Token Stats
              collapsible tendina below.) State + dialogs are shared with
              ChatPanel via ChatContext. */}
          <div className="flex items-center gap-1 flex-wrap">
            <Button
              variant={selectionMode ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setSelectionMode((prev) => !prev);
                if (selectionMode) setSelectedMessageIds(new Set());
              }}
              disabled={!currentChatId || messageCount === 0}
              className="flex items-center gap-1.5 text-xs h-8"
              title={t("wiki.selectMessagesHint", "Toggle to pick specific messages for distillation")}
              aria-label={t("wiki.selectMessages", "Select Messages")}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              {selectionMode && selectedMessageIds.size > 0
                ? t("wiki.messagesSelected", {
                    selected: selectedMessageIds.size,
                    total: messageCount,
                  })
                : t("wiki.selectMessages")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => setDistillDialogOpen(true)}
              disabled={!currentChatId || !currentWorkspaceId || messageCount === 0}
              className="flex items-center gap-1.5 text-xs h-8"
              aria-label={t("wiki.saveToWiki", "Save to Wiki")}
            >
              <BookOpen className="w-3.5 h-3.5" />
              {t("wiki.saveToWiki")}
            </Button>
          </div>
        </section>

        {/* 1. Token Stats — compact IN/OUT/TOT grid (always visible) plus a
            collapsible tendina (quick 260723-nnr follow-up 3) embedding the
            full Conversation/Today breakdown (TokenStatsDetail) that used to
            open as a chat-area panel above the message input. */}
        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <SectionTitle icon={<Cpu className="w-3 h-3" />}>
              {t("rightPanel.tokenStats")}
            </SectionTitle>
            <button
              type="button"
              onClick={() => setTokenDetailOpen((prev) => !prev)}
              disabled={!currentWorkspaceId}
              aria-label={t("tokens.title", "Token Usage")}
              aria-expanded={tokenDetailOpen}
              className="rounded p-0.5 text-muted-foreground transition-theme hover:text-foreground disabled:opacity-40"
            >
              <ChevronDown
                className={cn("w-3.5 h-3.5 transition-transform", tokenDetailOpen && "rotate-180")}
              />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px]">
            <StatCell label="IN" value={hasTokens ? formatTokens(inToday) : "—"} />
            <StatCell label="OUT" value={hasTokens ? formatTokens(outToday) : "—"} />
            <StatCell label="TOT" value={hasTokens ? formatTokens(totalToday) : "—"} accent />
          </div>
          {currentChatId && chatTokens && (
            <p className="text-[10px] text-muted-foreground font-mono">
              {t("rightPanel.conversation")}:{" "}
              <span className="text-foreground tabular-nums">
                {formatTokens(chatTokens.total)}
              </span>
              {chatTokens.perMessage && (
                <span className="text-muted-foreground">
                  {" · "}
                  {chatTokens.perMessage.length} {t("rightPanel.messages")}
                </span>
              )}
            </p>
          )}
          {!hasTokens && (
            <p className="text-[10px] text-muted-foreground font-mono">
              {t("rightPanel.noTokenData")}
            </p>
          )}
          {/* Collapsible detail tendina — Conversation/Today breakdown. */}
          {tokenDetailOpen && currentWorkspaceId && (
            <div className="mt-1 rounded border border-input bg-background/40 p-2">
              <TokenStatsDetail workspaceId={currentWorkspaceId} chatId={currentChatId} />
            </div>
          )}
        </section>

        {/* 2. Archivio collegato (Phase 80 D-05) */}
        {canLinkArchive && (
          <section className="space-y-1.5">
            <SectionTitle icon={<Archive className="w-3 h-3" />}>
              {t("chat.archive.sectionTitle")}
            </SectionTitle>
            {archives.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("chat.archive.emptyState")}
              </p>
            ) : (
              <Select
                value={displayArchiveId ?? ""}
                onValueChange={handleArchiveChange}
                disabled={linkArchiveMutation.isPending}
              >
                <SelectTrigger
                  className="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 font-mono text-[11px]"
                  aria-label={t("chat.archive.sectionTitle")}
                >
                  <SelectValue placeholder={t("chat.archive.none")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    {t("chat.archive.noneOption")}
                  </SelectItem>
                  {archives.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {displayArchiveId && archives.length > 0 && (
              <p className="text-[10px] text-muted-foreground font-mono">
                {t("chat.archive.pageCount", { count: displayArchivePageCount })}
              </p>
            )}
          </section>
        )}

        {/* 3. Skills & MCP */}
        <section className="space-y-1.5">
          <SectionTitle icon={<Plug className="w-3 h-3" />}>
            {t("rightPanel.skillsMcp")}
          </SectionTitle>
          <div className="space-y-0.5">
            {BUILTIN_SKILLS.map((key) => (
              <div
                key={key}
                className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] hover:bg-muted/40 transition-theme"
                title={t(`skills.${key}.description`)}
              >
                <span className="w-1 h-1 rounded-full bg-primary/70 flex-none" />
                <span className="font-mono text-foreground/90 truncate">
                  {t(`skills.${key}.displayName`)}
                </span>
              </div>
            ))}
          </div>
          <div className="pt-1 space-y-0.5">
            <p className="px-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              {t("rightPanel.mcpConnections")}
            </p>
            {scopedConnections.length === 0 ? (
              <p className="px-1.5 text-[10px] text-muted-foreground font-mono">
                {t("rightPanel.noMcp")}
              </p>
            ) : (
              scopedConnections.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] hover:bg-muted/40 transition-theme"
                  title={c.lastError ?? c.url}
                >
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full flex-none",
                      STATUS_DOT[c.liveStatus ?? "unknown"],
                    )}
                  />
                  <span className="font-mono text-foreground/90 truncate flex-1">{c.name}</span>
                  {typeof c.toolCount === "number" && c.toolCount > 0 && (
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      {c.toolCount}T
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
  );

  // Sheet variant — content only, surfaced from the mobile/tablet title bar.
  // No rail / collapse / `hidden lg:flex` wrapper; the Sheet provides the frame.
  if (variant === "sheet") {
    return (
      <>
        <div className={cn("flex flex-col w-full h-full overflow-hidden", className)}>
          <div className="flex items-center px-3 h-12 flex-none border-b border-input">
            <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              {t("rightPanel.title")}
            </span>
          </div>
          {body}
        </div>
        {showHistory && linkedArchiveId && (
          <WikiHistoryModal
            archiveId={linkedArchiveId}
            onClose={() => setShowHistory(false)}
          />
        )}
      </>
    );
  }

  // Panel variant — desktop right-side console.
  if (!open) {
    return (
      <div className={cn("hidden lg:flex flex-none w-9 border-l border-input bg-card/60", className)}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full flex flex-col items-center gap-2 pt-2 text-muted-foreground hover:text-foreground transition-theme"
          aria-label={t("rightPanel.expand")}
          title={t("rightPanel.expand")}
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="font-mono text-[10px] uppercase tracking-wider [writing-mode:vertical-rl] rotate-180">
            {t("rightPanel.title")}
          </span>
        </button>
      </div>
    );
  }

  return (
    <>
      <GlassPanel
        className={cn(
          "hidden lg:flex flex-col flex-none w-72 border-l border-input overflow-hidden",
          className,
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 h-12 flex-none border-b border-input">
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            {t("rightPanel.title")}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(false)}
            aria-label={t("rightPanel.collapse")}
            title={t("rightPanel.collapse")}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        {body}
      </GlassPanel>
      {showHistory && linkedArchiveId && (
        <WikiHistoryModal
          archiveId={linkedArchiveId}
          onClose={() => setShowHistory(false)}
        />
      )}
    </>
  );
}

function SectionTitle({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <p className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </p>
  );
}

function StatCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded border border-input bg-background/40 px-1.5 py-1">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={cn("tabular-nums", accent && "text-primary")}>{value}</div>
    </div>
  );
}