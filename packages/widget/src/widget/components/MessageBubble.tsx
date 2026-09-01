// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useMemo } from "preact/hooks";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type { SourceCitation } from "../hooks/useWidgetChat";
import { t } from "../i18n";

interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
  citations?: SourceCitation[];
  isStreaming?: boolean;
  avatarUrl: string | null;
}

// Lightweight markdown-it instance for the widget
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

export default function MessageBubble({ role, content, citations, isStreaming, avatarUrl }: MessageBubbleProps) {
  const renderedHtml = useMemo(() => {
    if (role === "user") return "";
    const rawHtml = md.render(content || "");
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: [
        "p", "br", "strong", "em", "a", "code", "pre",
        "ul", "ol", "li", "blockquote", "h1", "h2", "h3",
        "h4", "h5", "h6", "hr", "table", "thead", "tbody",
        "tr", "th", "td",
      ],
      ALLOWED_ATTR: ["href", "target", "rel", "class"],
    });
  }, [content, role]);

  if (role === "user") {
    return (
      <div
        className="max-w-[85%] px-3 py-2 rounded-xl text-sm text-white whitespace-pre-wrap break-words"
        style={{ backgroundColor: "var(--widget-primary)" }}
      >
        {content}
      </div>
    );
  }

  // Assistant/system messages: the bubble mirrors the user bubble's insets
  // (16px from the panel edge on both sides). The avatar overlaps the left
  // gutter instead of pushing the bubble — it hangs half over the bubble's
  // top-left corner, so the text starts at the same 28px inset the user
  // message's text ends at (131 UAT re-test).
  return (
    <div className="relative max-w-[85%] min-w-0">
      {avatarUrl && (
        <img
          src={avatarUrl}
          alt={t("messageBubble.assistantAlt")}
          className="w-7 h-7 rounded-full object-contain absolute -left-[16px] top-1 bg-white border border-[#e5e7eb]"
        />
      )}
      <div className="px-3 py-2 rounded-xl text-sm bg-[#f3f4f6] text-[#111827] break-words min-w-0">
        <div
          className="prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
        {isStreaming && <span className="streaming-cursor" />}
        {citations && citations.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {citations.map((citation, i) => (
              <a
                key={citation.documentId || i}
                href="#"
                onClick={(e) => e.preventDefault()}
                className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold text-white leading-none cursor-default"
                style={{ backgroundColor: "var(--widget-primary)" }}
                title={citation.documentName}
              >
                {i + 1}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}