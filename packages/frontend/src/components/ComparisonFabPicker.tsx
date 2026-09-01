// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface ComparisonFabPickerProps {
  paneAModel: { providerId?: string; model?: string } | null;
  paneBModel: { providerId?: string; model?: string } | null;
  onMerge: (pane: "A" | "B") => void;
}

export default function ComparisonFabPicker({
  paneAModel,
  paneBModel,
  onMerge,
}: ComparisonFabPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const firstButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      firstButtonRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <>
      {/* Floating action button */}
      <Button
        variant="default"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Select response to keep"
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 md:bottom-6 md:right-6 md:left-auto md:translate-x-0 rounded-full shadow-lg hover:opacity-90"
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </Button>

      {/* Picker overlay */}
      {open && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-card border border-border rounded-lg shadow-xl p-4 z-50 w-80 max-w-[90vw]"
          >
            <p className="text-sm font-medium text-foreground mb-3">
              {t("chat.comparison.mergePrompt")}
            </p>
            <Button
              ref={firstButtonRef}
              variant="outline"
              onClick={() => {
                onMerge("A");
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 mb-2 justify-start h-auto"
            >
              {t("chat.comparison.keepResponse", {
                model: paneAModel?.model || "A",
              })}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                onMerge("B");
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 last:mb-0 justify-start h-auto"
            >
              {t("chat.comparison.keepResponse", {
                model: paneBModel?.model || "B",
              })}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
