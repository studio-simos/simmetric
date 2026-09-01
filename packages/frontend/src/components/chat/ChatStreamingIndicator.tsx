// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { renderMarkdown } from "../../utils/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * ChatStreamingIndicator — live rendering of an in-flight assistant response
 * (Feature 4.2.3).
 *
 * Uses the AI-document shell (not a bubble):
 *   1. status message only (no content yet) → spinner + mono status label.
 *   2. streaming content available → rendered markdown + a blinking neon
 *      cursor (`.chat-cursor`, 1px×16px, neon-green under hacker) appended
 *      inline, plus a live `~N tok` badge bottom-right derived from
 *      `streamingContent.length / 4` (useChat exposes no token count pre-done).
 *   3. nothing yet → skeleton placeholder in the AI shell.
 *
 * Streaming text appears immediately (no per-token animation) per 4.7.1; the
 * cursor is the only motion. aria-live announcement ("AI is responding…") is
 * owned by ChatMessageList so it fires once per stream, not per token (4.9.2).
 */
export interface ChatStreamingIndicatorProps {
  statusMessage: string | null;
  streamingContent: string;
}

export function ChatStreamingIndicator({
  statusMessage,
  streamingContent,
}: ChatStreamingIndicatorProps) {
  const { t } = useTranslation();
  // Live token estimate — rough chars/4 heuristic (no real count until `done`).
  const tokenEstimate = streamingContent ? Math.ceil(streamingContent.length / 4) : 0;

  return (
    <div
      className="chat-msg-ai flex-1 min-w-0 rounded-lg border-l-2 px-3 py-2 bg-[var(--chat-ai-bg)] border-l-[var(--chat-accent)] border-y border-r border-[var(--chat-border)]"
      role="article"
      aria-label={t("chat.message.assistantLabel", "AI response")}
    >
      {statusMessage && !streamingContent ? (
        <div className="flex items-center gap-2 py-1">
          <div
            className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full"
            aria-hidden="true"
          />
          <span className="text-sm font-mono text-muted-foreground">{statusMessage}</span>
        </div>
      ) : streamingContent ? (
        <div className="relative">
          <div
            className="prose prose-sm max-w-none dark:prose-invert chat-ai-body"
            // Content sanitized via DOMPurify in renderMarkdown
            dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }}
          />
          <span className="chat-cursor" aria-hidden="true" />
          <span
            className={cn(
              "absolute bottom-0 right-1 text-[10px] font-mono text-muted-foreground",
              "bg-[var(--chat-code-bg)] px-1.5 py-0.5 rounded border border-[var(--chat-border)]",
            )}
            aria-hidden="true"
          >
            ~{tokenEstimate} tok
          </span>
        </div>
      ) : (
        <div className="space-y-2 py-2" aria-hidden="true">
          <Skeleton className="h-4 w-[250px]" />
          <Skeleton className="h-4 w-[200px]" />
          <Skeleton className="h-4 w-[150px]" />
        </div>
      )}
    </div>
  );
}

