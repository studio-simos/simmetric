// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useArchives } from "../queries/useArchives";
import { useSynthesisPendingCount } from "../queries/useSynthesis";
import { BookOpen, FlaskConical, ChevronRight, Plus } from "lucide-react";
import { Button } from "./ui/button";
import ArchiveCard from "./ArchiveCard";
import ArchiveCreateDialog from "./ArchiveCreateDialog";
import { useState } from "react";

export default function KnowledgeBasePage() {
  const { t } = useTranslation();
  usePageMeta(t("knowledgeBase.pageTitle"), [
    { label: t("breadcrumb.home"), path: "/" },
    { label: t("knowledgeBase.pageTitle") },
  ]);
  const navigate = useNavigate();
  const { data: archives = [], isLoading: loading } = useArchives();
  const { data: pendingSynthesisData } = useSynthesisPendingCount();
  const pendingSynthesis = pendingSynthesisData?.count ?? 0;
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  return (
    <div className="h-full overflow-y-auto p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground font-mono tracking-tight">
            {t("knowledgeBase.pageTitle")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("knowledgeBase.subtitle")}</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("archives.newArchive")}
        </Button>
      </div>

      {/* Hub cards — entry points */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <HubCard
          icon={<BookOpen className="w-5 h-5" />}
          title={t("archives.title")}
          desc={t("knowledgeBase.archivesDesc")}
          count={archives.length}
          countLabel={t("knowledgeBase.archivesCount")}
          onClick={() => navigate("/archives")}
        />
        <HubCard
          icon={<FlaskConical className="w-5 h-5" />}
          title={t("synthesis.sidebar.label")}
          desc={t("knowledgeBase.synthesisDesc")}
          count={pendingSynthesis}
          countLabel={t("knowledgeBase.synthesisPending")}
          onClick={() => navigate("/synthesis")}
        />
      </div>

      {/* Recent archives */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider font-mono">
            {t("knowledgeBase.recentArchives")}
          </h2>
          <button
            onClick={() => navigate("/archives")}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            {t("knowledgeBase.viewAll")}
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">{t("common.loading")}</p>
        ) : archives.length === 0 ? (
          <div className="rounded-lg border border-dashed border-input bg-card/50 p-8 text-center">
            <BookOpen className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-sm text-muted-foreground">{t("archives.empty.body")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {archives.slice(0, 6).map((archive) => (
              <ArchiveCard key={archive.id} archive={archive} />
            ))}
          </div>
        )}
      </div>

      <ArchiveCreateDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} />
    </div>
  );
}

function HubCard({
  icon,
  title,
  desc,
  count,
  countLabel,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  count: number;
  countLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex items-start gap-4 rounded-lg border border-input bg-card p-5 text-left transition-theme hover:border-primary/50 hover:bg-accent w-full"
    >
      <span className="mt-0.5 text-muted-foreground group-hover:text-primary transition-colors">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-base font-semibold text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground mt-1">{desc}</span>
        <span className="block text-xs text-muted-foreground mt-2 font-mono">
          {countLabel}: <span className="text-foreground">{count}</span>
        </span>
      </span>
      <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary mt-1 transition-colors" />
    </button>
  );
}