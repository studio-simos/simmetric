// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "../../hooks/useChat";
import type { AgentPlan } from "@simmetric-chat/shared";
import { ChatStreamingIndicator } from "./ChatStreamingIndicator";
import { PlanBanner } from "./PlanBanner";

/**
 * ChatMessageList — the scrollable, accessible transcript container.
 *
 * Feature 4.7.1: each message is wrapped by `ChatMessageItem` which applies
 *   the user (slide-in-right + fade) / assistant (fade + slide-up) animation.
 * Feature 4.9.1: `role="log"` + `aria-live="polite"` so streaming output is
 *   announced to assistive tech without interrupting.
 * Feature 4.9.2: a visually-hidden `statusAnnouncement` region fires once per
 *   stream ("AI is responding…" / "Response complete") — never per token.
 *
 * The rich per-message body (wiki links, TTS, edit/delete, citations, MCP
 * chips, selection checkbox) is provided by the parent via `renderMessage`,
 * so this component owns only the cross-cutting concerns: order, a11y,
 * animation, auto-scroll, empty state, and the streaming indicator.
 */
export interface ChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  statusMessage: string | null;
  /** Active plan for the in-flight stream (plan mode). Renders a banner above the streaming indicator. */
  activePlan?: AgentPlan | null;
  /** Shown when there are no messages and nothing is streaming. */
  emptyState?: ReactNode;
  /** Renders the inner body of a message (parent-owned rich content). */
  renderMessage: (message: ChatMessage, index: number) => ReactNode;
  /** Single announcement for the current stream phase (4.9.2). */
  statusAnnouncement?: string | null;
  className?: string;
}

/**
 * ChatMessageItem — animation + a11y wrapper around a single message body.
 * The body itself (Card, content, action buttons) is passed as `children`.
 */
interface ChatMessageItemProps {
  message: ChatMessage;
  children: ReactNode;
  className?: string;
}

function ChatMessageItem({ message, children, className }: ChatMessageItemProps) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const animationClass = isUser ? "chat-msg-user" : "chat-msg-ai";
  const ariaLabel = isUser
    ? t("chat.message.userLabel", "User message")
    : t("chat.message.assistantLabel", "AI response");

  return (
    <div
      // 4.2.1: user bubble right-aligned; 4.2.2: AI document full-width left.
      className={cn("group flex items-end gap-1.5", isUser ? "justify-end" : "justify-start", animationClass, className)}
      role="article"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

export function ChatMessageList({
  messages,
  isStreaming,
  streamingContent,
  statusMessage,
  activePlan,
  emptyState,
  renderMessage,
  statusAnnouncement,
  className,
}: ChatMessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages or streaming content (Feature: preserved
  // behavior from the original ChatPanel, now co-located with the list).
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  return (
    <div
      className={cn("flex-1 overflow-y-auto p-4 space-y-4", className)}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {messages.length === 0 && !isStreaming && emptyState}

      {messages.map((msg, index) => (
        <div key={msg.id} className="space-y-2">
          {msg.role === "assistant" && msg.metadata?.plan ? (
            <PlanBanner plan={msg.metadata.plan} done defaultExpanded={false} />
          ) : null}
          <ChatMessageItem message={msg}>
            {renderMessage(msg, index)}
          </ChatMessageItem>
        </div>
      ))}

      {isStreaming && (
        <>
          {activePlan ? (
            <PlanBanner plan={activePlan} done={false} />
          ) : null}
          <ChatStreamingIndicator statusMessage={statusMessage} streamingContent={streamingContent} />
        </>
      )}

      <div ref={endRef} />

      {statusAnnouncement && (
        <span className="sr-only" role="status">
          {statusAnnouncement}
        </span>
      )}
    </div>
  );
}

