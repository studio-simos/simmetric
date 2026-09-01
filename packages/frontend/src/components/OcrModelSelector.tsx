// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { Badge } from "./ui/badge";
import { Label } from "./ui/label";
import type { OcrModelConfig } from "@simmetric-chat/shared";

interface Props {
  value: string;
  onChange: (value: string) => void;
  models: OcrModelConfig[];
  isLoading: boolean;
  error: Error | null;
  staleModel?: string;
}

const CAPABILITY_COLORS: Record<string, string> = {
  text: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  table: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  figure: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  generic: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export default function OcrModelSelector({
  value,
  onChange,
  models,
  isLoading,
  error,
  staleModel,
}: Props) {
  const { t } = useTranslation();

  const selectedModel = models.find((m) => m.name === value);

  return (
    <div className="space-y-2">
      <Label htmlFor="ocr-model">{t("ocr.modelLabel")}</Label>

      {isLoading ? (
        <Select disabled value="">
          <SelectTrigger id="ocr-model" className="w-full max-w-xs">
            <SelectValue placeholder={t("ocr.modelLoading")} />
          </SelectTrigger>
        </Select>
      ) : error ? (
        <p className="text-sm text-destructive">
          {t("ocr.error.fetchFailed")}
        </p>
      ) : models.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("ocr.noModelsAvailable")}
        </p>
      ) : (
        <>
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger id="ocr-model" className="w-full max-w-xs">
              <SelectValue placeholder={t("ocr.modelPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {models.map((model) => (
                <SelectItem key={model.name} value={model.name}>
                  <div className="flex items-center gap-2">
                    <span>{model.name}</span>
                    <div className="flex gap-1">
                      {model.supportedModes.map((mode) => (
                        <Badge
                          key={mode}
                          variant="outline"
                          className={`text-[10px] px-1 py-0 ${CAPABILITY_COLORS[mode] ?? ""}`}
                        >
                          {t(`ocr.capabilities.${mode}`)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {staleModel && !selectedModel && (
            <p className="text-sm text-warning">
              {t("ocr.modelStale")}: {staleModel}
            </p>
          )}

          {selectedModel && (
            <div className="flex flex-wrap gap-1 pt-1">
              {selectedModel.supportedModes.map((mode: string) => (
                <Badge
                  key={mode}
                  variant="outline"
                  className={`text-xs ${CAPABILITY_COLORS[mode] ?? ""}`}
                >
                  {t(`ocr.capabilities.${mode}`)}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
