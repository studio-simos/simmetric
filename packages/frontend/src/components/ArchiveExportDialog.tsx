// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileArchive, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useExportArchive } from "../queries/useArchives";
import { showError } from "../lib/toast";

import { cn } from "@/lib/utils"
import { getErrorMessage } from "../utils/errorUtils";
interface ArchiveExportDialogProps {
  archiveId: string;
  archiveName: string;
  onClose: () => void;
}

export function ArchiveExportDialog({ archiveId, archiveName, onClose }: ArchiveExportDialogProps) {
  const { t } = useTranslation();
  const exportMutation = useExportArchive();
  const [format, setFormat] = useState<"zip" | "pdf">("zip");

  const handleExport = async () => {
    try {
      await exportMutation.mutateAsync({ archiveId, format });
      onClose();
    } catch (err: unknown) {
      showError(getErrorMessage(err, "Export failed"));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">
            {t("export.dialogTitle")}
          </h3>
          <Button variant="ghost" size="icon" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </Button>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          {t("export.dialogDescription", { name: archiveName })}
        </p>

        <div className="flex gap-3 mb-6">
          <Button
            variant="outline"
            onClick={() => setFormat("zip")}
            className={cn("flex-1 flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors h-auto", format === "zip"
                ? "border-blue-500 bg-blue-500/10"
                : "border-border hover:bg-accent")}
          >
            <FileArchive size={24} className={format === "zip" ? "text-blue-500" : "text-muted-foreground"} />
            <span className="text-sm font-medium text-foreground">{t("export.formatZip")}</span>
            <span className="text-xs text-muted-foreground">{t("export.formatZipDesc")}</span>
          </Button>

          <Button
            variant="outline"
            onClick={() => setFormat("pdf")}
            className={cn("flex-1 flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors h-auto", format === "pdf"
                ? "border-blue-500 bg-blue-500/10"
                : "border-border hover:bg-accent")}
          >
            <FileText size={24} className={format === "pdf" ? "text-blue-500" : "text-muted-foreground"} />
            <span className="text-sm font-medium text-foreground">{t("export.formatPdf")}</span>
            <span className="text-xs text-muted-foreground">{t("export.formatPdfDesc")}</span>
          </Button>
        </div>

        <div className="flex justify-end gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            disabled={exportMutation.isPending}
          >
            <Download size={16} />
            {exportMutation.isPending ? t("export.exporting") : t("export.download")}
          </Button>
        </div>
      </div>
    </div>
  );
}
