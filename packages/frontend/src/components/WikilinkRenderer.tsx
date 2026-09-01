// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useRef, useLayoutEffect } from "react";
import { renderMarkdown } from "../utils/markdown";

interface ResolvedWikilink {
  slug: string;
  title: string;
  exists: boolean;
  category?: string;
}

interface WikilinkRendererProps {
  content: string;
  resolvedWikilinks: ResolvedWikilink[];
  onWikilinkClick: (slug: string, exists: boolean) => void;
  onWikilinkHover: (slug: string, rect: DOMRect, resolved?: ResolvedWikilink) => void;
  onWikilinkLeave: () => void;
}

const PLUS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;

export function WikilinkRenderer({
  content,
  resolvedWikilinks,
  onWikilinkClick,
  onWikilinkHover,
  onWikilinkLeave,
}: WikilinkRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const regex = /\[\[([^\]]+)\]\]/g;
  let match;
  const matches: Array<{ full: string; inner: string; start: number }> = [];
  while ((match = regex.exec(content)) !== null) {
    if (match[0] && match[1] !== undefined) {
      matches.push({ full: match[0], inner: match[1], start: match.index });
    }
  }

  let textWithLinks = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    if (!m) continue;
    const parts = m.inner.split("|");
    const slug = (parts[0] ?? "").trim();
    const display = (parts[1] || slug).trim();
    const markdownLink = `[${display}](#wikilink-${encodeURIComponent(slug)})`;
    textWithLinks = textWithLinks.slice(0, m.start) + markdownLink + textWithLinks.slice(m.start + m.full.length);
  }

  const html = renderMarkdown(textWithLinks);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const anchors = containerRef.current.querySelectorAll('a[href^="#wikilink-"]');

    anchors.forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      const slug = decodeURIComponent(href.replace("#wikilink-", ""));
      const resolved = resolvedWikilinks.find((r) => r.slug === slug);
      const exists = resolved?.exists === true;

      const el = a as HTMLElement;

      // Apply styling classes
      el.className = exists
        ? "text-blue-600 underline cursor-pointer hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
        : "text-muted-foreground cursor-pointer hover:text-foreground inline-flex items-center gap-1";
      el.title = exists ? (resolved?.title || slug) : "Click to create this page";

      // Remove any existing Plus icon to avoid duplicates when re-enhancing
      const existingPlus = el.querySelector(".wikilink-plus");
      if (existingPlus) {
        existingPlus.remove();
      }

      if (!exists) {
        const plusSpan = document.createElement("span");
        plusSpan.className = "wikilink-plus inline-flex items-center";
        plusSpan.innerHTML = PLUS_ICON_SVG;
        el.appendChild(plusSpan);
      }

      // Attach event handlers (overwrites any previous handlers)
      el.onclick = (e) => {
        e.preventDefault();
        onWikilinkClick(slug, exists);
      };
      el.onmouseenter = () => {
        onWikilinkHover(slug, el.getBoundingClientRect(), resolved);
      };
      el.onmouseleave = onWikilinkLeave;
    });

    return () => {
      anchors.forEach((a) => {
        const el = a as HTMLElement;
        el.onclick = null;
        el.onmouseenter = null;
        el.onmouseleave = null;
      });
    };
  }, [html, resolvedWikilinks, onWikilinkClick, onWikilinkHover, onWikilinkLeave]);

  return (
    <div
      ref={containerRef}
      className="prose prose-sm max-w-none dark:prose-invert chat-ai-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
