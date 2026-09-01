// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 500;

export default function OcrCustomInstructions({
  value,
  onChange,
  maxLength = DEFAULT_MAX_LENGTH,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  const currentLength = value.length;
  const isOverLimit = currentLength > maxLength;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="ocr-instructions">{t("ocr.customInstructionsLabel")}</Label>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </div>

      {expanded && (
        <>
          <Textarea
            id="ocr-instructions"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("ocr.customInstructionsPlaceholder")}
            className={`min-h-[80px] max-h-[200px] resize-y ${
              isOverLimit ? "border-destructive focus-visible:ring-destructive" : ""
            }`}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {t("ocr.customInstructionsHint")}
            </p>
            <span
              className={`text-xs ${
                isOverLimit ? "text-destructive font-medium" : "text-muted-foreground"
              }`}
            >
              {t("ocr.characterCount", { count: currentLength })}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
