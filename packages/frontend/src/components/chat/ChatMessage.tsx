// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check, RefreshCw, Volume2, VolumeX, Pencil, Trash2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { showSuccess } from "../../lib/toast";
import { renderMarkdown } from "../../utils/markdown";
import { getInitials } from "../SettingsProfile";
import type { AuthUser } from "../../queries/useAuth";
import type { ChatMessage as ChatMessageType, SourceCitation } from "../../hooks/useChat";
import { ChatModelBadge } from "./ChatModelBadge";
import { ChatCitations } from "./ChatCitations";
import { PipelineInfo } from "./PipelineInfo";
import { DLPNotice } from "./DLPNotice";

/**
 * ChatMessage — "Simmetric Native" message render (Feature 4.2.1 + 4.2.2).
 *
 * Two layouts:
 *  • User (4.2.1): right-aligned bubble, max-w 70%, glass bg, asymmetric
 *    border-radius (tail effect via rounded-br-sm), font-sans 14px, timestamp
 *    revealed on hover, user avatar on the right.
 *  • AI (4.2.2): full-width "document" — header (model icon + ChatModelBadge +
 *    mono timestamp), markdown body (.chat-ai-body styles code blocks + hacker
 *    scanlines), minimal footer action row [Copy][Regenerate][Read aloud]
 *    + inline ChatCitations + MCP chips. border-left accent per theme.
 *
 * The rich assistant body (wiki links) is delegated to the parent via
 * `renderAssistantBody` so wiki handler state stays in ChatPanel. Selection,
 * edit-in-progress, delete, regenerate, read-aloud are parent-driven via props.
 *
 * a11y (4.9.1): role="article" + aria-label are set by the ChatMessageItem
 * wrapper in ChatMessageList; this component adds the inner semantics.
 */
export interface ChatMessageProps {
  message: ChatMessageType;
  isHackerTheme: boolean;
  authUser: AuthUser | null;
  /**
   * Quick 260829-spj: global "Show DLP texts" preference from ChatPanel
   * (default false) — forwarded to DLPNotice as `showTextDefault` so the
   * more-actions toggle controls all notices at once. Manual per-notice
   * reveal is still possible.
   */
  showDlpTexts?: boolean;
  isLastUserMessage: boolean;
  selectionMode: boolean;
  selected: boolean;
  ttsPlayingId: string | null;
  onToggleSelect: () => void;
  onRegenerate: () => void;
  onReadAloud: (text: string, msgId: string) => void;
  onEditStart: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onCitationsOpen: (sources: SourceCitation[]) => void;
  // edit-in-progress (parent owns editingMessageId + editInput)
  editing: boolean;
  editInput: string;
  onEditInputChange: (value: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  // assistant body override (wiki rendering w/ handlers)
  renderAssistantBody?: (msg: ChatMessageType) => ReactNode;
  onFollowUpClick?: (question: string) => void;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function ChatMessage({
  message: msg,
  isHackerTheme,
  authUser,
  showDlpTexts,
  isLastUserMessage,
  selectionMode,
  selected,
  ttsPlayingId,
  onToggleSelect,
  onRegenerate,
  onReadAloud,
  onEditStart,
  onDelete,
  onCitationsOpen,
  editing,
  editInput,
  onEditInputChange,
  onEditSave,
  onEditCancel,
  renderAssistantBody,
  onFollowUpClick,
}: ChatMessageProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showSuccess(t("chat.message.copyFailed", "Copy failed"));
    }
  };

  const time = formatTime(msg.createdAt);
  const isUser = msg.role === "user";

  // ─── User bubble (4.2.1) ───
  if (isUser) {
    return (
      <>
        {selectionMode && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="w-4 h-4 shrink-0 self-center cursor-pointer accent-[var(--primary)]"
            aria-label={t("chat.message.selectToggle", "Select message")}
          />
        )}
        <div className="flex flex-col items-end gap-1 max-w-[70%] sm:max-w-[70%]">
          <div
            className={cn(
              "chat-msg-user rounded-lg rounded-br-sm px-3 py-2 text-[14px] leading-[1.6]",
              "bg-[var(--chat-user-bg)] text-[var(--chat-user-fg)] border border-[var(--chat-border)]",
              isHackerTheme && "border-l-2 border-l-[#00d4ff]",
            )}
          >
            {editing ? (
              <div className="space-y-2 min-w-[220px]">
                <Textarea
                  value={editInput}
                  onChange={(e) => onEditInputChange(e.target.value)}
                  className="min-h-[60px] text-sm bg-[var(--chat-input-bg)]"
                  rows={2}
                  autoFocus
                />
                <div className="flex gap-2 justify-end">
                  <Button size="sm" onClick={onEditSave} disabled={!editInput.trim()}>
                    {t("chat.save", "Save")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={onEditCancel}>
                    {t("chat.cancel", "Cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words">{msg.content}</p>
            )}

            {msg.metadata?.attachedDocumentId && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <Badge variant="outline" className="text-xs">
                  <Paperclip className="w-3 h-3 mr-1" />
                  {msg.metadata.attachedDocumentName || t("chat.attachedDocument", "Attached document")}
                </Badge>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1">
            <span className="chat-msg-timestamp">{time}</span>
            {isLastUserMessage && !editing && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onEditStart(msg.id, msg.content)}
                    className="size-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-opacity"
                    title={t("chat.editMessage", "Edit")}
                    aria-label={t("chat.editMessage", "Edit")}
                  >
                    <Pencil className="w-3 h-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{t("chat.editMessage", "Edit")}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(msg.id)}
                  className="size-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  title={t("chat.deleteMessage", "Delete")}
                  aria-label={t("chat.deleteMessage", "Delete")}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t("chat.deleteMessage", "Delete")}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {authUser && (
          <Avatar className="size-7 shrink-0">
            <AvatarImage src={authUser.avatar || undefined} alt="" />
            <AvatarFallback>{getInitials(authUser)}</AvatarFallback>
          </Avatar>
        )}
      </>
    );
  }

  // ─── AI document (4.2.2) ───
  const mcpSources = msg.metadata?.mcpSources ?? [];
  const sources = msg.metadata?.sources ?? [];

  return (
    <>
      {selectionMode && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="w-4 h-4 shrink-0 self-start mt-1 cursor-pointer accent-[var(--primary)]"
          aria-label={t("chat.message.selectToggle", "Select message")}
        />
      )}
      <div
        className={cn(
          "chat-msg-ai flex-1 min-w-0 rounded-lg border-l-2 px-3 py-2",
          "bg-[var(--chat-ai-bg)] border-l-[var(--chat-accent)] border-y border-r border-[var(--chat-border)]",
        )}
      >
        {/* Header: persisted model label (display-only, NOT a selector) + timestamp.
            The model used for THIS response is read from metadata.modelUsed
            (populated by the SSE `done` event), so different responses can show
            different models. No picker on a past AI reply. */}
        <div className="flex items-center gap-2 mb-1.5">
          <ChatModelBadge
            model={msg.metadata?.modelUsed}
            modelProvider={msg.metadata?.modelProvider}
            size="sm"
            displayOnly
          />
          <span className="chat-msg-timestamp opacity-100 ml-auto">{time}</span>
        </div>

        {/* Body */}
        {renderAssistantBody ? (
          renderAssistantBody(msg)
        ) : (
          <div
            className="prose prose-sm max-w-none dark:prose-invert chat-ai-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        )}

        {/* MCP sources chips */}
        {mcpSources.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">{t("chat.mcpSources.label", "Tools")}</span>
            {mcpSources.slice(0, 5).map((tool, idx) => (
              <Badge variant="outline" key={idx} className="text-xs">{tool}</Badge>
            ))}
            {mcpSources.length > 5 && (
              <span className="text-xs text-muted-foreground">+{mcpSources.length - 5} more</span>
            )}
          </div>
        )}

        {/* Citations (inline, expandable) */}
        {sources.length > 0 && (
          <ChatCitations sources={sources} onOpenPanel={onCitationsOpen} />
        )}

        {/* Pipeline info — shows how the answer was produced */}
        {msg.metadata?.pipeline && (
          <PipelineInfo
            toolsCalled={msg.metadata.pipeline.toolsCalled}
            sourcesFound={msg.metadata.pipeline.sourcesFound}
            ragSearched={msg.metadata.pipeline.ragSearched}
            ragResults={msg.metadata.pipeline.ragResults}
          />
        )}

        {/* Tags + follow-up suggestions (Phase 98 D-06/D-07) */}
        {msg.metadata?.tags && msg.metadata.tags.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">{t("chat.tags.label", "Tags")}</span>
            {msg.metadata.tags.map((tag, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-xs text-[var(--text-muted)] border border-[var(--border)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {msg.metadata?.followUps && msg.metadata.followUps.length > 0 && (
          <div className="mt-2">
            <span className="text-xs text-muted-foreground block mb-1">{t("chat.followUps.label", "Suggested questions")}</span>
            {msg.metadata.followUps.map((q, i) => (
              <button
                key={i}
                className="text-left text-sm text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--border)] rounded-lg px-3 py-2 hover:bg-[var(--surface-hover)] transition-colors w-full mb-1"
                onClick={() => onFollowUpClick?.(q)}
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* DLP Notice — Phase 115: rendered below assistant messages with DLP matches in metadata */}
        {msg.metadata?.dlpMatches && msg.metadata.dlpMatches.length > 0 && (
          <DLPNotice
            matches={msg.metadata.dlpMatches}
            isAdmin={authUser?.permissions?.includes("admin:settings") ?? false}
            showTextDefault={showDlpTexts}
          />
        )}

        {/* AI disclaimer — Phase 149 BRAND-02: muted footnote below every
            assistant message body (D-05 — assistant-only, never on user
            bubbles). Plain text via t() (no dangerouslySetInnerHTML). */}
        <p data-testid="ai-disclaimer" className="text-xs text-muted-foreground mt-2">
          {t("chat.aiDisclaimer", "Le risposte sono generate tramite intelligenza artificiale")}
        </p>

        {/* Footer action row */}
        <div className="mt-2 flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                className="size-6 text-muted-foreground hover:text-foreground"
                title={t("chat.message.copy", "Copy")}
                aria-label={t("chat.message.copy", "Copy")}
              >
                {copied ? <Check className="w-3 h-3 text-[var(--chat-accent)]" /> : <Copy className="w-3 h-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{copied ? t("chat.message.copied", "Copied") : t("chat.message.copy", "Copy")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onRegenerate}
                className="size-6 text-muted-foreground hover:text-foreground"
                title={t("chat.regenerate", "Regenerate")}
                aria-label={t("chat.regenerate", "Regenerate")}
              >
                <RefreshCw className="w-3 h-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("chat.regenerate", "Regenerate")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onReadAloud(msg.content, msg.id)}
                className="size-6 text-muted-foreground hover:text-foreground"
                title={t("chat.readAloud", "Read aloud")}
                aria-label={t("chat.readAloud", "Read aloud")}
              >
                {ttsPlayingId === msg.id ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("chat.readAloud", "Read aloud")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(msg.id)}
                className="size-6 ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                title={t("chat.deleteMessage", "Delete")}
                aria-label={t("chat.deleteMessage", "Delete")}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("chat.deleteMessage", "Delete")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );
}

