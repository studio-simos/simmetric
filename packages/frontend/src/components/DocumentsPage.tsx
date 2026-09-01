// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { apiGet, apiPost, ApiError } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import { useTranslation } from "react-i18next";
import { useWorkspaces } from "../queries/useWorkspaces";
import { useMe } from "../queries/useAuth";
import { useChatNav } from "../contexts/ChatContext";
import { useArchives } from "../queries/useArchives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Copy, Eye, Upload, Trash2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { getErrorMessage } from "../utils/errorUtils";

interface Document {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  chunkCount: number;
  embeddingModel: string;
  status: "pending" | "processing" | "completed" | "failed";
  statusMessage: string | null;
  fileSize: number;
  createdAt: string;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function statusBadge(status: Document["status"]) {
  const variantMap: Record<Document["status"], "secondary" | "default" | "destructive" | "outline"> = {
    pending: "secondary",
    processing: "default",
    completed: "default",
    failed: "destructive",
  };
  return (
    <Badge variant={variantMap[status]} className="text-xs">
      {status}
    </Badge>
  );
}

function fileTypeIcon(type: string) {
  const iconMap: Record<string, string> = {
    pdf: "📄",
    md: "📝",
    csv: "📊",
    docx: "📃",
    xlsx: "📈",
    txt: "📄",
    pptx: "📊",
    youtube: "▶️",
  };
  return iconMap[type] || "📄";
}

export default function DocumentsPage() {
  const { workspaceId: urlWorkspaceId } = useParams<{ workspaceId?: string }>();
  const navigate = useNavigate();
  const { currentWorkspaceId } = useChatNav();
  const { data: meData } = useMe();
  const isAdmin = meData?.permissions?.includes("admin:settings") ?? false;
  const effectiveWorkspaceId = urlWorkspaceId || currentWorkspaceId || null;
  const { t } = useTranslation();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [copyArchiveId, setCopyArchiveId] = useState<string>("");
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copySubmitting, setCopySubmitting] = useState(false);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { data: workspaces = [] } = useWorkspaces();
  const workspace = workspaces.find((w) => w.id === effectiveWorkspaceId);
  // KB-05a: archives list is filtered server-side by archive:write
  const { data: writableArchives = [] } = useArchives();

  const fetchDocuments = async () => {
    try {
      const params = !showAllWorkspaces && effectiveWorkspaceId ? `?workspaceId=${effectiveWorkspaceId}` : "";
      const docs = await apiGet<Document[]>(`/documents${params}`);
      setDocuments(docs);
    } catch (err: unknown) {
      showError(t("documents.loadFailed", { error: getErrorMessage(err) }));
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    fetchDocuments();
  }, [effectiveWorkspaceId, showAllWorkspaces]);

  // Poll for pending/processing documents
  useEffect(() => {
    const hasActive = documents.some((d) => d.status === "pending" || d.status === "processing");

    if (hasActive && !pollingRef.current) {
      pollingRef.current = setInterval(fetchDocuments, 4000);
    } else if (!hasActive && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [documents, effectiveWorkspaceId, showAllWorkspaces]);

  // Clear selection when document list changes (e.g. after fetch)
  useEffect(() => {
    setSelectedDocs((prev) => {
      const validIds = new Set(documents.map((d) => d.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validIds.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [documents]);

  const selectedCount = selectedDocs.size;
  const allSelected = documents.length > 0 && selectedDocs.size === documents.length;

  function toggleSelect(id: string) {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedDocs(() => {
      if (allSelected) return new Set();
      return new Set(documents.map((d) => d.id));
    });
  }

  const handleBulkDelete = async () => {
    setDeleting(true);
    try {
      // Quick 260815-gak: single POST /documents/bulk-delete replaces the
      // N+1 sequential DELETE loop that exhausted the rate-limiter bucket.
      const result = await apiPost<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>(
        "/documents/bulk-delete",
        { documentIds: Array.from(selectedDocs) },
      );
      const ok = result.deleted.length;
      if (result.failed.length === 0) {
        showSuccess(t("documents.bulkDelete.success", { count: ok }));
      } else {
        const failedNames = result.failed
          .map((item) => documents.find((d) => d.id === item.id)?.name ?? item.id)
          .join(", ");
        showError(
          t("documents.bulkDelete.partialError", {
            ok,
            failed: result.failed.length,
            message: failedNames,
          }),
        );
      }
      // Remove only the server-confirmed deleted docs (not the full selection,
      // which may include docs that failed access checks).
      setDocuments((prev) => prev.filter((d) => !result.deleted.includes(d.id)));
      setSelectedDocs(new Set());
    } finally {
      setDeleting(false);
      setBulkDeleteOpen(false);
    }
  };

  const handleBulkCopyToArchive = async () => {
    if (!copyArchiveId || selectedDocs.size === 0) return;
    setCopySubmitting(true);
    try {
      await apiPost(`/archives/${copyArchiveId}/copy-from-doc`, {
        documentIds: Array.from(selectedDocs),
      });
      const archive = writableArchives.find((a) => a.id === copyArchiveId);
      showSuccess(
        t("documents.bulkCopy.success", {
          count: selectedDocs.size,
          archiveName: archive?.name ?? copyArchiveId,
        }),
      );
      setSelectedDocs(new Set());
      setCopyArchiveId("");
      setCopyDialogOpen(false);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        showError(t("documents.bulkCopy.forbidden"));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        showError(msg);
      }
    } finally {
      setCopySubmitting(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">
            {t("documents.title")}
          </h2>
          {workspace && !showAllWorkspaces && (
            <p className="text-sm text-muted-foreground mt-1">{workspace.name}</p>
          )}
          {showAllWorkspaces && (
            <p className="text-sm text-muted-foreground mt-1">{t("documents.allWorkspacesLabel", { defaultValue: "All workspaces" })}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/uploads" data-testid="documents-upload-cta">
              <Upload className="mr-2 h-4 w-4" />
              {t("documents.uploadButton")}
            </Link>
          </Button>
          {isAdmin && (
            <>
              <Switch
                id="show-all-docs"
                checked={showAllWorkspaces}
                onCheckedChange={setShowAllWorkspaces}
              />
              <Label htmlFor="show-all-docs" className="text-sm text-muted-foreground cursor-pointer">
                {t("documents.showAllWorkspaces", { defaultValue: "Show all workspaces" })}
              </Label>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {!effectiveWorkspaceId && (
          <p className="text-sm text-muted-foreground">{t("documents.noWorkspace")}</p>
        )}

        {/* Document List */}
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-3">
            {t("documents.documentsCount", { count: documents.length })}
          </h3>

          {/* Bulk action toolbar — shown when any documents are selected */}
          {documents.length > 0 && (
            <div className="flex items-center gap-2 mb-3">
              <div className="flex items-center gap-2 mr-auto">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  aria-label={t("documents.bulkSelect.selectAll")}
                />
                <span className="text-sm font-medium text-muted-foreground">
                  {t("documents.bulkSelect.selectedCount", { count: selectedCount })}
                </span>
              </div>
              {selectedCount > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={writableArchives.length === 0}
                    onClick={() => setCopyDialogOpen(true)}
                  >
                    <Copy className="mr-1 h-3 w-3" />
                    {t("documents.bulkSelect.copyToArchive")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setBulkDeleteOpen(true)}
                    disabled={deleting}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    {deleting
                      ? t("documents.bulkSelect.deleting")
                      : t("documents.bulkSelect.deleteSelected")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">{t("documents.loading")}</div>
          ) : documents.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              <p className="font-medium">{t("documents.emptyTitle")}</p>
              <p className="mt-1">{t("documents.emptyBody")}</p>
              <Button asChild variant="outline" className="mt-4">
                <Link to="/uploads" data-testid="documents-upload-cta-empty">
                  <Upload className="mr-2 h-4 w-4" />
                  {t("documents.emptyState.uploadCta")}
                </Link>
              </Button>
            </div>
          ) : (
            <Card className="overflow-hidden">
              <CardContent className="p-0">
                <Table className="min-w-full divide-y divide-border">
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead className="px-4 py-3 w-10">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={toggleSelectAll}
                          aria-label={t("documents.bulkSelect.selectAll")}
                        />
                      </TableHead>
                      <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">{t("documents.table.document")}</TableHead>
                      {showAllWorkspaces && (
                        <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">{t("documents.table.workspace")}</TableHead>
                      )}
                      <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">{t("documents.table.type")}</TableHead>
                      <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">{t("documents.table.size")}</TableHead>
                      <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">{t("documents.table.chunks")}</TableHead>
                      <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">{t("documents.table.status")}</TableHead>
                      <TableHead className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase">{t("documents.table.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="divide-y divide-border">
                    {documents.map((doc) => (
                      <TableRow key={doc.id} className="hover:bg-muted transition-colors">
                        <TableCell className="px-4 py-3">
                          <Checkbox
                            checked={selectedDocs.has(doc.id)}
                            onCheckedChange={() => toggleSelect(doc.id)}
                            aria-label={`select ${doc.name}`}
                          />
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">{fileTypeIcon(doc.type)}</span>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate max-w-xs">{doc.name}</p>
                              <p className="text-xs text-secondary-foreground">
                                {new Date(doc.createdAt).toLocaleDateString()}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        {showAllWorkspaces && (
                          <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                            {workspaces.find((w) => w.id === doc.workspaceId)?.name || doc.workspaceId}
                          </TableCell>
                        )}
                        <TableCell className="px-4 py-3 text-sm text-muted-foreground">{doc.type.toUpperCase()}</TableCell>
                        <TableCell className="px-4 py-3 text-sm text-muted-foreground">{formatFileSize(doc.fileSize)}</TableCell>
                        <TableCell className="px-4 py-3 text-sm text-muted-foreground">{doc.chunkCount}</TableCell>
                        <TableCell className="px-4 py-3">
                          <div className="flex flex-col items-start gap-1">
                            {statusBadge(doc.status)}
                            {doc.status === "failed" && doc.statusMessage && (
                              <p className="text-xs text-destructive max-w-xs truncate" title={doc.statusMessage}>
                                {doc.statusMessage}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-3 text-right">
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => navigate(`/documents/${doc.id}`)}
                            className="min-h-[44px] text-xs"
                          >
                            <Eye className="mr-1 h-3 w-3" />
                            {t("documents.view")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Bulk delete confirmation dialog */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("documents.bulkDelete.confirmTitle", { count: selectedCount })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("documents.bulkDelete.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("documents.bulkDelete.cancel", { defaultValue: "Cancel" })}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting
                ? t("documents.bulkDelete.deleting", { defaultValue: "Deleting..." })
                : t("documents.bulkDelete.confirm", { count: selectedCount })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk copy-to-archive dialog */}
      <Dialog open={copyDialogOpen} onOpenChange={setCopyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[20px] font-semibold">
              {t("documents.bulkCopy.dialogTitle", {
                count: selectedCount,
                defaultValue: "Copy {{count}} documents to archive",
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("archives.copyToArchive.description")}
            </p>
            <div className="space-y-2">
              <Label htmlFor="bulk-copy-archive-select">{t("archives.copyToArchive.selectArchive")}</Label>
              {writableArchives.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("archives.copyToArchive.emptyState")}
                </p>
              ) : (
                <Select value={copyArchiveId} onValueChange={setCopyArchiveId}>
                  <SelectTrigger id="bulk-copy-archive-select">
                    <SelectValue placeholder={t("archives.copyToArchive.selectArchive")} />
                  </SelectTrigger>
                  <SelectContent>
                    {writableArchives.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setCopyDialogOpen(false)}
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              onClick={handleBulkCopyToArchive}
              disabled={!copyArchiveId || copySubmitting || writableArchives.length === 0}
            >
              {copySubmitting
                ? t("archives.copyToArchive.copying")
                : t("archives.copyToArchive.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}