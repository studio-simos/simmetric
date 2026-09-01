// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { computeLineDiff, type DiffSegment } from "../utils/diff";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

interface WikiDiffViewerProps {
  oldContent: string;
  newContent: string;
  onClose: () => void;
}

function DiffColumn({ segments, label }: { segments: DiffSegment[]; label: string }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-2">
        {label}
      </div>
      <div className="border border-border rounded-lg bg-card p-4 font-mono text-sm whitespace-pre-wrap">
        {segments.map((seg, i) => {
          const bgClass =
            seg.op === -1
              ? "bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200"
              : seg.op === 1
              ? "bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-200"
              : "text-foreground";
          return (
            <span key={i} className={bgClass}>
              {seg.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function WikiDiffViewer({ oldContent, newContent, onClose }: WikiDiffViewerProps) {
  const { t } = useTranslation();
  const { left, right } = computeLineDiff(oldContent, newContent);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-lg font-semibold text-foreground">{t("wiki.diffView")}</h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={20} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex gap-4">
            <DiffColumn segments={left} label={t("wiki.before")} />
            <DiffColumn segments={right} label={t("wiki.after")} />
          </div>
        </div>
      </div>
    </div>
  );
}
