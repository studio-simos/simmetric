// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { useAvailableModels } from "../queries/useProviders";
import { useMe } from "../queries/useAuth";
import { getInitials } from "./SettingsProfile";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { UseChatReturn } from "../hooks/useChat";
import { renderMarkdown } from "../utils/markdown";
import ModelSelector from "./ModelSelector";
import { CitationBadge } from "./CitationPanel";
import { cn } from "@/lib/utils";

const capabilityKeyMap: Record<string, string> = {
  "local-only": "chat.capabilities.localOnly",
  "fastest": "chat.capabilities.fastest",
  "smartest": "chat.capabilities.smartest",
  "reasoning": "chat.capabilities.reasoning",
};

interface ComparisonPaneProps {
  chat: UseChatReturn;
  modelOverride: { providerId?: string; model?: string } | null;
  onModelChange: (selection: { providerId: string; model: string } | null) => void;
  isStale: boolean;
}

export default function ComparisonPane({
  chat,
  modelOverride,
  onModelChange,
  isStale,
}: ComparisonPaneProps) {
  const { t } = useTranslation();
  const { data: availableModels = [] } = useAvailableModels();
  const { data: authUser } = useMe();
  const paneModel = availableModels.find(
    (m) => m.providerId === modelOverride?.providerId && m.name === modelOverride?.model
  );

  const handleRetry = () => {
    const lastUserMessage = chat.messages.filter((m) => m.role === "user").pop();
    if (lastUserMessage) {
      chat.sendMessage(
        lastUserMessage.content,
        lastUserMessage.metadata?.attachedDocumentId,
        lastUserMessage.metadata?.attachedDocumentName,
        modelOverride ?? undefined
      );
    }
  };

  const openCitations = (sources: NonNullable<NonNullable<UseChatReturn["messages"][number]["metadata"]>["sources"]>) => {
    if (sources && sources.length > 0) {
      window.dispatchEvent(
        new CustomEvent("comparison:openCitations", { detail: { sources } })
      );
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Pane header */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border bg-card">
        <ModelSelector
          value={modelOverride}
          onChange={onModelChange}
          isStale={isStale}
        />
        {paneModel?.capabilities?.map((tag) => (
          <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0.5">
            {t(capabilityKeyMap[tag] || tag)}
          </Badge>
        ))}
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4" role="log" aria-live="polite">
        {chat.messages.length === 0 && !chat.isStreaming && (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground text-sm">
              {t("chat.comparison.emptyPane")}
            </p>
          </div>
        )}

        {chat.messages.map((msg) => (
          <div key={msg.id} className="group flex justify-start items-end gap-1.5">
            <Card
              size="sm"
              className={cn(
                "max-w-[80%] ring-0",
                msg.role === "user"
                  ? "bg-[var(--chat-user-bg)] text-[var(--chat-user-fg)] border border-[var(--chat-border)]"
                  : "bg-[var(--chat-ai-bg)] border-l-2 border-l-[var(--chat-accent)] border-y border-r border-[var(--chat-border)]",
              )}
            >
              <CardContent className="py-2 px-3">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline">
                    {msg.role === "user" ? t("common.you") : t("common.assistant")}
                  </Badge>
                  {msg.role === "assistant" && msg.metadata?.modelUsed && (
                    <Badge variant="secondary">{msg.metadata.modelUsed}</Badge>
                  )}
                </div>
                {msg.role === "assistant" ? (
                  <div
                    className="prose prose-sm max-w-none dark:prose-invert chat-ai-body"
                    // Content sanitized via DOMPurify in renderMarkdown utility
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                  />
                ) : (
                  <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.6]">{msg.content}</p>
                )}

                {/* Citation badges */}
                {msg.role === "assistant" && msg.metadata?.sources && msg.metadata.sources.length > 0 && (
                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-muted-foreground mr-1">Sources:</span>
                    {msg.metadata.sources.map((source, i) => (
                      <CitationBadge
                        key={`${source.documentId}-${i}`}
                        index={i}
                        onClick={() => openCitations(msg.metadata!.sources!)}
                      />
                    ))}
                  </div>
                )}

                {/* AI disclaimer — Phase 149 BRAND-02 / D-03: muted footnote
                    below every completed assistant message, matching the main
                    ChatMessage view. Same t() signature + class set as task 1
                    so a missing-key render is impossible and the look is
                    identical across views. Assistant-only (D-05); user and
                    streaming/skeleton states intentionally excluded. */}
                {msg.role === "assistant" && (
                  <p data-testid="ai-disclaimer" className="text-xs text-muted-foreground mt-2">
                    {t("chat.aiDisclaimer", "Le risposte sono generate tramite intelligenza artificiale")}
                  </p>
                )}
              </CardContent>
            </Card>
            {msg.role === "user" && authUser && (
              <Avatar className="size-7">
                <AvatarImage src={authUser.avatar || undefined} alt="" />
                <AvatarFallback>{getInitials(authUser)}</AvatarFallback>
              </Avatar>
            )}
          </div>
        ))}

        {/* Streaming message */}
        {chat.isStreaming && (
          <div className="flex justify-start">
            {chat.statusMessage && !chat.streamingContent ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
                <span className="text-sm text-muted-foreground">{chat.statusMessage}</span>
              </div>
            ) : chat.streamingContent ? (
              <Card
                size="sm"
                className="max-w-[80%] ring-0 bg-[var(--chat-ai-bg)] border-l-2 border-l-[var(--chat-accent)] border-y border-r border-[var(--chat-border)]"
              >
                <CardContent className="py-2 px-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline">{t("common.assistant")}</Badge>
                  </div>
                  <div
                    className="prose prose-sm max-w-none dark:prose-invert chat-ai-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(chat.streamingContent) }}
                  />
                  <span className="inline-block w-1.5 h-4 bg-muted-foreground animate-pulse ml-0.5 align-middle" />
                </CardContent>
              </Card>
            ) : (
              <Card size="sm" className="max-w-[80%]">
                <CardContent className="py-3 px-4 space-y-2">
                  <Skeleton className="h-4 w-[250px]" />
                  <Skeleton className="h-4 w-[200px]" />
                  <Skeleton className="h-4 w-[150px]" />
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Inline error block */}
        {chat.error && (
          <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm flex items-center justify-between">
            <span>{chat.error}</span>
            <Button
              variant="link"
              size="sm"
              onClick={handleRetry}
              className="text-destructive underline text-sm font-medium"
            >
              {t("chat.comparison.retry")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
