// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { FileText, Folder } from "lucide-react";

export interface WikiTooltipData {
  slug: string;
  title: string;
  category?: string;
  exists: boolean;
  rect: DOMRect;
}

interface WikiTooltipProps {
  data: WikiTooltipData | null;
}

export function WikiTooltip({ data }: WikiTooltipProps) {
  if (!data) return null;

  const top = data.rect.bottom + 8 + window.scrollY;
  const left = data.rect.left + window.scrollX;

  return (
    <div
      className="fixed z-[70] pointer-events-none"
      style={{ top, left }}
    >
      <div className="rounded-lg border border-border bg-card shadow-lg px-3 py-2 min-w-[180px]">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <FileText size={14} className="text-muted-foreground" />
          <span>{data.title}</span>
        </div>
        {data.category && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
            <Folder size={12} />
            <span>{data.category}</span>
          </div>
        )}
        {!data.exists && (
          <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            Page does not exist — click to create
          </div>
        )}
      </div>
    </div>
  );
}
