// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { Card, CardContent } from "./ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { FileText, Upload, Network, Settings, X, ClipboardList } from "lucide-react";
import {
  useArchive,
  useArchivePages,
  useDeleteArchive,
} from "../queries/useArchives";
import { showSuccess, showError } from "../lib/toast";
import type { OcrJob } from "../queries/useOcrJobs";
import ArchiveHeader from "./ArchiveHeader";
import ArchiveSidebar from "./ArchiveSidebar";
import ArchivePageFullView from "./ArchivePageFullView";
import { ArchiveGraphView } from "./ArchiveGraphView";
import { ArchiveConfigPanel } from "./ArchiveConfigPanel";
import OcrJobList from "./OcrJobList";
import OcrPreviewModal from "./OcrPreviewModal";
import PageCreateDialog from "./PageCreateDialog";
import PageDeleteDialog from "./PageDeleteDialog";
import { ArchiveExportDialog } from "./ArchiveExportDialog";
import { getErrorMessage } from "../utils/errorUtils";

export default function ArchiveDetailPage() {
  const params = useParams<{ archiveId: string; "*"?: string }>();
  const { archiveId } = params;
  const splat = params["*"] || "";
  const slug = splat.startsWith("pages/") ? splat.slice(6) : undefined;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  const { data: currentArchive, isLoading: archiveLoading, error: archiveError } = useArchive(archiveId);
  const { data: currentPages = [] } = useArchivePages(archiveId);
  const deleteArchiveMutation = useDeleteArchive();

  usePageMeta(
    currentArchive?.name || t("archives.pageTitle"),
    [
      { label: t("breadcrumb.home"), path: "/" },
      { label: t("breadcrumb.archives"), path: "/archives" },
      { label: currentArchive?.name || t("archives.detail") },
    ]
  );

  // Shared state lifted to orchestrator (avoiding Pitfall 1)
  const [activeTab, setActiveTab] = useState<string>("pages");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [showCreatePage, setShowCreatePage] = useState(false);
  const [showDeleteArchive, setShowDeleteArchive] = useState(false);
  const [showDeletePage, setShowDeletePage] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [previewJob, setPreviewJob] = useState<OcrJob | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleDeleteArchive = async () => {
    if (!archiveId) return;
    try {
      await deleteArchiveMutation.mutateAsync(archiveId);
      showSuccess(t("archives.deleteConfirm.title"));
      navigate("/archives");
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("common.error")));
    }
  };

  // Loading / error / not-found states
  const isLoading = archiveLoading;
  if (isLoading && !currentArchive) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-[300px] w-full" />
      </div>
    );
  }

  if (archiveError && !currentArchive) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-destructive">{archiveError.message}</p>
      </div>
    );
  }

  if (!currentArchive) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-muted-foreground">{t("archives.notFound")}</p>
      </div>
    );
  }

  const isFullPageView = !!slug;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* D-01: Full-width header banner */}
      <ArchiveHeader
        archive={currentArchive}
        onNewPage={() => setShowCreatePage(true)}
        onExport={() => setShowExport(true)}
        onDelete={() => setShowDeleteArchive(true)}
        onMenuClick={() => setSidebarOpen(true)}
      />

      {/* D-02: Two-column layout under header */}
      <div className="flex flex-1 min-h-0">
        {/* D-03/D-04: Sidebar (w-64 on desktop, Sheet on mobile) */}
        {isMobile ? (
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetContent side="left" className="w-64 p-0" showCloseButton={false}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <SheetTitle>{t("archives.title")}</SheetTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSidebarOpen(false)}
                  className="h-9 w-9"
                  aria-label={t("archives.closeSidebar", "Close sidebar")}
                >
                  <X className="h-5 w-5" />
                </Button>
              </div>
              <ArchiveSidebar
                className="h-full border-r-0"
                archiveId={archiveId!}
                pages={currentPages}
                onPageClick={(pageSlug: string) => {
                  navigate(`/archives/${archiveId}/pages/${pageSlug}`);
                  setSidebarOpen(false);
                }}
                onDeletePage={(pageSlug: string) => setShowDeletePage(pageSlug)}
                selectedSlug={slug}
                selectedCategory={selectedCategory}
                onCategoryChange={setSelectedCategory}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
              />
            </SheetContent>
          </Sheet>
        ) : (
          <ArchiveSidebar
            archiveId={archiveId!}
            pages={currentPages}
            onPageClick={(pageSlug: string) => navigate(`/archives/${archiveId}/pages/${pageSlug}`)}
            onDeletePage={(pageSlug: string) => setShowDeletePage(pageSlug)}
            selectedSlug={slug}
            selectedCategory={selectedCategory}
            onCategoryChange={setSelectedCategory}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
          />
        )}

        {/* D-06: Main area (flex-1) with 4 tabs */}
        <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="px-3 sm:px-6 pt-4 flex items-center justify-between gap-2 flex-wrap">
              <div className="overflow-x-auto">
                <TabsList variant="line" className="mb-0 flex-nowrap whitespace-nowrap">
                  <TabsTrigger value="pages">
                    <FileText className="mr-1.5 h-3.5 w-3.5" />
                    {t("archiveDetail.tabs.pages")}
                  </TabsTrigger>
                  <TabsTrigger value="jobs">
                    <ClipboardList className="mr-1.5 h-3.5 w-3.5" />
                    {t("archiveDetail.tabs.jobs")}
                  </TabsTrigger>
                  <TabsTrigger value="graph">
                    <Network className="mr-1.5 h-3.5 w-3.5" />
                    {t("archiveDetail.tabs.graph")}
                  </TabsTrigger>
                  <TabsTrigger value="config">
                    <Settings className="mr-1.5 h-3.5 w-3.5" />
                    {t("archiveDetail.tabs.config")}
                  </TabsTrigger>
                </TabsList>
              </div>
              <div className="flex items-center gap-2">
                {/* D-72-02: per-archive Upload button → unified area deep-link */}
                <Button asChild variant="secondary" size="sm">
                  <Link to={`/uploads?archiveId=${archiveId}`} data-testid="archive-detail-upload-cta">
                    <Upload className="mr-2 h-4 w-4" />
                    {t("archiveDetail.uploadToArchiveButton")}
                  </Link>
                </Button>
              </div>
            </div>

            <TabsContent value="pages" className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 mt-0">
              {isFullPageView ? (
                <ArchivePageFullView
                  archiveId={archiveId!}
                  slug={slug!}
                  onBack={() => navigate(`/archives/${archiveId}`)}
                  onDeletePage={() => setShowDeletePage(slug!)}
                />
              ) : (
                <Card className="flex items-center justify-center h-64">
                  <CardContent>
                    <p className="text-muted-foreground">{t("archives.selectPagePreview")}</p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* D-72-03: ingest tab repurposed to "jobs" — OcrJobList view/manage only (no upload affordances) */}
            <TabsContent value="jobs" className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 mt-0">
              <div className="space-y-6">
                <OcrJobList archiveId={archiveId!} onPreview={(job) => setPreviewJob(job)} />
              </div>
            </TabsContent>

            <TabsContent value="graph" className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 mt-0">
              {currentArchive && (
                <ArchiveGraphView
                  archiveId={currentArchive.id}
                  onNodeClick={(nodeSlug: string) => navigate(`/archives/${archiveId}/pages/${nodeSlug}`)}
                />
              )}
            </TabsContent>

            <TabsContent value="config" className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 mt-0">
              {currentArchive && <ArchiveConfigPanel archiveId={currentArchive.id} />}
            </TabsContent>
          </Tabs>
        </main>
      </div>

      {/* Dialogs and Modals */}
      <AlertDialog open={showDeleteArchive} onOpenChange={setShowDeleteArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("archives.deleteConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("archives.deleteConfirm.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("archives.deleteConfirm.keepButton")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteArchive} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PageCreateDialog open={showCreatePage} onOpenChange={setShowCreatePage} archiveId={archiveId!} onSuccess={() => {}} />
      <PageDeleteDialog
        open={showDeletePage !== null}
        onOpenChange={(open) => { if (!open) setShowDeletePage(null); }}
        pageSlug={showDeletePage || ""}
        archiveId={archiveId!}
        onSuccess={() => {
          if (slug) {
            navigate(`/archives/${archiveId}`);
          }
        }}
      />
      {previewJob && <OcrPreviewModal job={previewJob} archiveId={archiveId!} open={!!previewJob} onClose={() => setPreviewJob(null)} />}
      {showExport && currentArchive && <ArchiveExportDialog archiveId={currentArchive.id} archiveName={currentArchive.name} onClose={() => setShowExport(false)} />}
    </div>
  );
}