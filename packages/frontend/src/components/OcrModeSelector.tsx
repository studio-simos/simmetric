// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { Label } from "./ui/label";
import { Loader2 } from "lucide-react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  supportedModes: string[];
  isTransitioning?: boolean;
}

const ALL_MODES = ["text", "table", "figure", "generic"];

export default function OcrModeSelector({
  value,
  onChange,
  supportedModes,
  isTransitioning,
}: Props) {
  const { t } = useTranslation();
  const [localValue, setLocalValue] = useState(value);

  // Keep local value in sync with prop
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // When model changes, auto-select first supported mode if current is unsupported
  useEffect(() => {
    if (supportedModes.length > 0 && !supportedModes.includes(localValue)) {
      const defaultMode = supportedModes[0] ?? "auto";
      setLocalValue(defaultMode);
      onChange(defaultMode);
    }
  }, [supportedModes, localValue, onChange]);

  return (
    <div className="space-y-2">
      <Label htmlFor="ocr-mode">{t("ocr.modeLabel")}</Label>

      {isTransitioning ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <Select
          value={localValue}
          onValueChange={(val) => {
            setLocalValue(val);
            onChange(val);
          }}
          disabled={supportedModes.length === 0}
        >
          <SelectTrigger id="ocr-mode" className="w-full max-w-xs">
            <SelectValue placeholder={t("ocr.modePlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {ALL_MODES.map((mode) => {
              const isSupported = supportedModes.includes(mode);
              return (
                <SelectItem
                  key={mode}
                  value={mode}
                  disabled={!isSupported}
                  className={!isSupported ? "opacity-50" : undefined}
                >
                  {t(`ocr.modes.${mode}`)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}

    </div>
  );
}
