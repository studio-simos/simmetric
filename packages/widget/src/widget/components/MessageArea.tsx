// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useRef } from "preact/hooks";
import type { WidgetMessage } from "../hooks/useWidgetChat";
import MessageBubble from "./MessageBubble";
import FallbackMessage from "./FallbackMessage";

interface MessageAreaProps {
  messages: WidgetMessage[];
  isStreaming: boolean;
  fallbackMessage: string;
  avatarUrl: string | null;
}

export default function MessageArea({ messages, isStreaming, fallbackMessage, avatarUrl }: MessageAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Check if last assistant message is a fallback
  const lastAssistantMsg = messages.findLast((m) => m.role === "assistant");
  const isFallback = lastAssistantMsg?.content === fallbackMessage;

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;

  return (
    <div className="p-4 space-y-3" role="log" aria-live="polite">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <MessageBubble
            role={msg.role}
            content={msg.content}
            citations={msg.citations}
            isStreaming={
              isStreaming &&
              msg.role === "assistant" &&
              msg === messages[messages.length - 1]
            }
            avatarUrl={avatarUrl}
          />
        </div>
      ))}

      {/* Streaming indicator when assistant message has no content yet */}
      {isStreaming && lastMsg?.role === "assistant" && !lastMsg.content && (
        <div className="flex justify-start">
          <div className="bg-[#f3f4f6] max-w-[85%] px-3 py-2 rounded-xl text-sm text-[#9ca3af]">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#9ca3af] animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#9ca3af] animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#9ca3af] animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      )}

      {/* Fallback message when agent unavailable */}
      {isFallback && <FallbackMessage message={fallbackMessage} />}

      {/* Scroll anchor */}
      <div ref={bottomRef} className="h-0" />
    </div>
  );
}
