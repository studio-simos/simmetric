// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { RefreshCw, Loader2, ChevronDown, ChevronUp } from "lucide-react";

interface Props {
  systemPrompt: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  hasModel: boolean;
}

export default function OcrPromptPreview({
  systemPrompt,
  isLoading,
  error,
  onRefresh,
  hasModel,
}: Props) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t("ocr.previewLabel")}</Label>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-label={isExpanded ? "Collapse preview" : "Expand preview"}
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading || !hasModel}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                {t("ocr.previewUpdating")}
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-3 w-3" />
                {t("ocr.previewUpdateButton")}
              </>
            )}
          </Button>
        </div>
      </div>

      {isExpanded && (
        <div
          className="rounded-md border border-input bg-muted/30 p-3 transition-all duration-200"
          aria-live="polite"
        >
          {error ? (
            <p className="text-sm text-destructive whitespace-pre-wrap">
              {t("ocr.previewError", { error })}
            </p>
          ) : systemPrompt ? (
            <pre className="font-mono text-[13px] leading-[1.6] whitespace-pre-wrap break-words text-foreground">
              {systemPrompt}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              {t("ocr.previewEmpty")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
