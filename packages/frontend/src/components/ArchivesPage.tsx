// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { Archive, Plus, Upload } from "lucide-react";
import { Button } from "./ui/button";
import { useArchives } from "../queries/useArchives";
import ArchiveCard from "./ArchiveCard";
import ArchiveCreateDialog from "./ArchiveCreateDialog";

export default function ArchivesPage() {
  const { t } = useTranslation();
  usePageMeta(t("archives.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.archives") }]);
  const { data: archives = [], isLoading: loading, error } = useArchives();
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-20">
          <p className="text-muted-foreground">{t("common.loading")}</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex items-center justify-center py-20">
          <p className="text-destructive">{error instanceof Error ? error.message : String(error)}</p>
        </div>
      );
    }

    if (archives.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Archive
            className="h-12 w-12 text-muted-foreground/50 mb-4"
            strokeWidth={1.5}
          />
          <h2 className="text-[28px] font-semibold text-foreground mb-2">
            {t("archives.empty.heading")}
          </h2>
          <p className="text-base text-muted-foreground mb-6">
            {t("archives.empty.body")}
          </p>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t("archives.newArchive")}
          </Button>
          <Link to="/uploads" data-testid="archives-upload-cta-empty">
            <Button variant="outline" className="mt-2">
              <Upload className="mr-2 h-4 w-4" />
              {t("archives.emptyState.uploadCta")}
            </Button>
          </Link>
        </div>
      );
    }

    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {archives.map((archive) => (
          <ArchiveCard key={archive.id} archive={archive} />
        ))}
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-[28px] font-semibold leading-[1.2] text-foreground">
          {t("archives.title")}
        </h1>
        {archives.length > 0 && (
          <div className="flex items-center gap-2">
            <Link to="/uploads" data-testid="archives-upload-cta">
              <Button variant="outline">
                <Upload className="mr-2 h-4 w-4" />
                {t("archives.uploadButton")}
              </Button>
            </Link>
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t("archives.newArchive")}
            </Button>
          </div>
        )}
      </div>

      {renderContent()}

      <ArchiveCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </div>
  );
}
