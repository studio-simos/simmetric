// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * UnifiedUploadPage — Phase 71-05 Task 1 (overwrites 71-03 stub).
 *
 * Stacked layout D-01: page header → dropzone hero → source-mode toggle row
 * → destination chooser → pending panel. SC-5 admin-disabled empty state
 * (Lock icon + heading + body) when !isAdmin && ALLOW_NON_ADMIN_UPLOAD !==
 * "true". D-17 URL ingest source-mode panel (useStageUploadUrl). D-18
 * from-existing-Document entry-mode panel (apiPost /archives/:id/copy-from-doc
 * with fail-closed 403 toast). D-11 skeleton stage feedback via stagePending
 * prop to PendingDocsPanel. D-09 terminal toast on draft status transition.
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import {
  useUploadDrafts,
  useStageUpload,
  useStageUploadUrl,
  useAssignDraft,
} from "../queries/useUploadDrafts";
import { useSettingsHelpers } from "../queries/useSettings";
import { useMe } from "../queries/useAuth";
import { useArchives } from "../queries/useArchives";
import { useChatNav } from "../contexts/ChatContext";
import { apiGet, apiPost, ApiError } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import UploadDestinationChooser, {
  destinationToAssignBody,
} from "./UploadDestinationChooser";
import PendingDocsPanel from "./PendingDocsPanel";
import OcrModeSelector from "./OcrModeSelector";
import type { DraftDestination } from "@simmetric-chat/shared";
import { sanitizeFileName } from "@simmetric-chat/shared";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { Lock, UploadCloud, Plus, FileInput } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  MIME accept map (12 MIME from draftMimeTypeSchema)                 */
/* ------------------------------------------------------------------ */

const MIME_ACCEPT: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "text/markdown": [".md"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "image/png": [".png"],
  "image/jpeg": [".jpeg", ".jpg"],
  "image/webp": [".webp"],
  "image/tiff": [".tif", ".tiff"],
};

/* ------------------------------------------------------------------ */
/*  Admin check helper                                                 */
/* ------------------------------------------------------------------ */

function checkIsAdmin(roles: { name: string }[] | undefined): boolean {
  if (!roles) return false;
  return roles.some((r) => r.name === "admin" || r.name === "superuser");
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface SimpleDocument {
  id: string;
  name: string;
  workspaceId: string;
  type: string;
  status: string;
}

export default function UnifiedUploadPage() {
  const { t } = useTranslation();
  const { workspaceId: paramsWsId } = useParams();
  const { currentWorkspaceId } = useChatNav();
  const workspaceId = paramsWsId ?? currentWorkspaceId ?? "";
  const hasWorkspace = Boolean(workspaceId);

  const { data: drafts = [] } = useUploadDrafts(workspaceId);
  const stageMutation = useStageUpload();
  const stageUrlMutation = useStageUploadUrl();
  const assignMutation = useAssignDraft(workspaceId);

  const { getValue } = useSettingsHelpers();
  const { data: meData } = useMe();
  const isAdmin = checkIsAdmin(meData?.roles as { name: string }[] | undefined);
  const { data: archives = [] } = useArchives();

  // Destination state (D-02)
  const [destination, setDestination] = useState<DraftDestination>("unassigned");
  const [archiveId, setArchiveId] = useState<string | undefined>(undefined);
  const [ocrMode, setOcrMode] = useState<string>("text");

  // Source-mode toggles (D-17 + D-18)
  const [showUrlPanel, setShowUrlPanel] = useState(false);
  const [showFromDocPanel, setShowFromDocPanel] = useState(false);

  // D-17 URL panel state
  const [urlInput, setUrlInput] = useState("");
  const [urlArchiveId, setUrlArchiveId] = useState<string | undefined>(undefined);

  // D-18 from-doc panel state
  const [documents, setDocuments] = useState<SimpleDocument[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [fromDocArchiveId, setFromDocArchiveId] = useState<string | undefined>(undefined);
  const [fromDocSubmitting, setFromDocSubmitting] = useState(false);

  // D-09 terminal toast: track previous statuses
  const prevStatusRef = useRef<Record<string, { rag: string | null; kb: string | null; parse: string }>>({});

  /* ---------------------------------------------------------------- */
  /*  D-72-02: ?archiveId deep-link pre-selection                      */
  /*  - reads ?archiveId from the URL on mount                         */
  /*  - if it matches an archive in the user's useArchives() list      */
  /*    (server-scoped by archive:read), pre-sets archiveId +          */
  /*    destination="kb" (DEFAULT, still user-modifiable in chooser)   */
  /*  - if not found (deleted/inaccessible/another user's), ignore     */
  /*    the param + show a toast — fail-graceful, no 404 leak          */
  /*  - race guard: `if (archiveId) return` early-exit + `archives`    */
  /*    in deps so the effect waits for the query to resolve and runs  */
  /*    at most once per mount (analog SettingsPage.tsx:207,224-234)    */
  /* ---------------------------------------------------------------- */
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (archiveId) return; // already set (by user or prior deep-link) — respect manual choice
    const qArchiveId = searchParams.get("archiveId");
    if (!qArchiveId) return;
    if (archives.some((a) => a.id === qArchiveId)) {
      setArchiveId(qArchiveId);
      setDestination("kb"); // DEFAULT modifiable in chooser — NOT locked (D-72-02)
    } else {
      showError(t("uploads.deepLink.archiveNotFound"));
    }
  }, [archives, searchParams, archiveId, t]);

  /* ---------------------------------------------------------------- */
  /*  D-09 terminal toast effect                                       */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const prev = prevStatusRef.current;
    const next: Record<string, { rag: string | null; kb: string | null; parse: string }> = {};
    for (const d of drafts) {
      next[d.id] = { rag: d.ragStatus, kb: d.kbStatus, parse: d.parseStatus };
      const p = prev[d.id];
      if (!p) continue;
      // transition to done
      if (p.parse !== "done" && d.parseStatus === "done") {
        showSuccess(t("uploads.terminal.success", { filename: d.originalName }));
        continue;
      }
      // transition to failed (either leg)
      const ragFailed = p.rag !== "failed" && d.ragStatus === "failed";
      const kbFailed = p.kb !== "FAILED" && d.kbStatus === "FAILED";
      if (ragFailed || kbFailed) {
        showError(
          t("uploads.terminal.failed", {
            filename: d.originalName,
            ragStatus: d.ragStatus ?? "n/a",
            kbStatus: d.kbStatus ?? "n/a",
          }),
        );
      }
    }
    prevStatusRef.current = next;
  }, [drafts, t]);

  /* ---------------------------------------------------------------- */
  /*  SC-5 admin-disabled gate                                         */
  /* ---------------------------------------------------------------- */
  const isNonAdminDisabled = !isAdmin && getValue("ALLOW_NON_ADMIN_UPLOAD") !== "true";

  /* ---------------------------------------------------------------- */
  /*  Drop handler (D-03)                                              */
  /* ---------------------------------------------------------------- */
  async function handleDrop(files: File[]) {
    // Defense-in-depth: react-dropzone's `disabled` option already prevents
    // drops when no workspace is selected, but guard the handler too so even
    // if a drop slips through, no FormData is built and no mutation fires
    // (prevents the 400 on POST /api/uploads with empty workspaceId).
    if (!workspaceId) {
      showError(t("uploads.dropzone.noWorkspaceBody"));
      return;
    }
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("workspaceId", workspaceId);
      // quick 260808-vzm: stage the sanitized name client-side (server also
      // sanitizes — defense in depth; keeps the pending list display
      // consistent immediately).
      formData.append("originalName", sanitizeFileName(file.name));
      formData.append("fileSize", String(file.size));
      formData.append("mimeType", file.type || "application/octet-stream");
      try {
        const staged = await stageMutation.mutateAsync({ formData, workspaceId });
        if (destination !== "unassigned") {
          const body = destinationToAssignBody(destination, archiveId);
          await assignMutation.mutateAsync({ id: staged.id, body });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showError(t("uploads.stage.error", { filename: file.name, message: msg }));
      }
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    multiple: true,
    accept: MIME_ACCEPT,
    onDrop: handleDrop,
    disabled: !hasWorkspace,
  });

  if (isNonAdminDisabled) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <Lock className="h-12 w-12 text-muted-foreground" />
        <h2 className="mt-4 text-xl font-semibold">
          {t("uploads.disabled.heading")}
        </h2>
        <p className="mt-2 max-w-md text-center text-sm text-muted-foreground">
          {t("uploads.disabled.body")}
        </p>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  D-17 URL ingest submit                                           */
  /* ---------------------------------------------------------------- */
  async function handleUrlSubmit() {
    if (!workspaceId) {
      showError(t("uploads.dropzone.noWorkspaceBody"));
      return;
    }
    if (!urlInput || !/^https?:\/\//.test(urlInput)) {
      showError(t("uploads.source.url.invalid"));
      return;
    }
    if (!urlArchiveId) {
      showError(t("uploads.source.url.invalid"));
      return;
    }
    try {
      await stageUrlMutation.mutateAsync({
        sourceType: "url",
        url: urlInput,
        archiveId: urlArchiveId,
        ocrMode,
        workspaceId,
      });
      setUrlInput("");
      setShowUrlPanel(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showError(msg);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  D-18 from-doc submit                                             */
  /* ---------------------------------------------------------------- */
  async function loadDocuments() {
    if (documents.length > 0) return;
    try {
      const docs = await apiGet<SimpleDocument[]>(`/documents?workspaceId=${workspaceId}`);
      // Filter out failed documents — they have 0 chunks and copy-from-doc
      // will always fail with "no extracted text". Only show documents that
      // were successfully processed (completed) or are still processing.
      setDocuments(docs.filter((d) => d.status === "completed" || d.status === "processing"));
    } catch {
      // best-effort
    }
  }

  async function handleFromDocSubmit() {
    if (!workspaceId) {
      showError(t("uploads.dropzone.noWorkspaceBody"));
      return;
    }
    if (selectedDocIds.size === 0 || !fromDocArchiveId) {
      showError(t("uploads.source.fromDoc.empty"));
      return;
    }
    setFromDocSubmitting(true);
    try {
      await apiPost(`/archives/${fromDocArchiveId}/copy-from-doc`, {
        documentIds: Array.from(selectedDocIds),
      });
      showSuccess(t("uploads.source.fromDoc.submit"));
      setSelectedDocIds(new Set());
      setShowFromDocPanel(false);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        showError(t("uploads.source.fromDoc.forbidden"));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        showError(msg);
      }
    } finally {
      setFromDocSubmitting(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <div className="h-full flex flex-col">
      {/* Page header */}
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-xl font-semibold text-foreground">
          {t("uploads.page.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("uploads.page.subtitle")}
        </p>
      </div>

      <div className="flex-1 space-y-8 overflow-y-auto p-6">
        {/* Dropzone hero (UPL-01/02) */}
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl p-12 text-center bg-card transition-colors ${
            isDragActive ? "border-primary bg-primary/5" : "border-border"
          } ${!hasWorkspace ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          <input {...getInputProps()} />
          {hasWorkspace ? (
            <>
              <UploadCloud className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-4 text-lg font-medium">
                {t("uploads.dropzone.heading")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("uploads.dropzone.body")}
              </p>
            </>
          ) : (
            <>
              <Lock className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-4 text-lg font-medium">
                {t("uploads.dropzone.noWorkspaceHeading")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("uploads.dropzone.noWorkspaceBody")}
              </p>
            </>
          )}
        </div>

        {/* Source-mode toggle row (D-17 + D-18) */}
        <div className="flex flex-wrap gap-3">
          <Button
            variant="ghost"
            disabled={!hasWorkspace}
            onClick={() => {
              setShowUrlPanel((v) => !v);
              setShowFromDocPanel(false);
            }}
          >
            <Plus className="h-4 w-4" />
            {t("uploads.source.url.label")}
          </Button>
          <Button
            variant="ghost"
            disabled={!hasWorkspace}
            onClick={() => {
              setShowFromDocPanel((v) => !v);
              setShowUrlPanel(false);
              if (!showFromDocPanel) loadDocuments();
            }}
          >
            <FileInput className="h-4 w-4" />
            {t("uploads.source.fromDoc.label")}
          </Button>
        </div>

        {/* D-17 URL panel */}
        {showUrlPanel && (
          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="space-y-2">
                <Label htmlFor="url-input">{t("uploads.source.url.label")}</Label>
                <Input
                  id="url-input"
                  placeholder={t("uploads.source.url.placeholder")}
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("uploads.destination.archive.placeholder")}</Label>
                <Select
                  value={urlArchiveId}
                  onValueChange={setUrlArchiveId}
                >
                  <SelectTrigger className="w-full max-w-sm" data-testid="select-url-archive">
                    <SelectValue placeholder={t("uploads.destination.archive.placeholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {archives.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <OcrModeSelector
                value={ocrMode}
                onChange={setOcrMode}
                supportedModes={["text", "vision", "custom"]}
              />
              <Button onClick={handleUrlSubmit}>
                {t("uploads.source.url.add")}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* D-18 from-doc panel */}
        {showFromDocPanel && (
          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="space-y-2">
                <Label>{t("uploads.source.fromDoc.placeholder")}</Label>
                <ul className="max-h-60 space-y-2 overflow-y-auto rounded-md border border-border p-2">
                  {documents.length > 0 && (
                    <li className="flex items-center gap-2 border-b border-border pb-2 mb-1">
                      <Checkbox
                        checked={selectedDocIds.size === documents.length}
                        onCheckedChange={(checked) => {
                          setSelectedDocIds(() => {
                            if (checked) return new Set(documents.map((d) => d.id));
                            return new Set();
                          });
                        }}
                        aria-label={t("uploads.source.fromDoc.selectAll")}
                      />
                      <span className="text-sm font-medium text-muted-foreground">
                        {t("uploads.source.fromDoc.selectAll")}
                      </span>
                    </li>
                  )}
                  {documents.map((doc) => (
                    <li key={doc.id} className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedDocIds.has(doc.id)}
                        onCheckedChange={() => {
                          setSelectedDocIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(doc.id)) next.delete(doc.id);
                            else next.add(doc.id);
                            return next;
                          });
                        }}
                      />
                      <button
                        type="button"
                        className="text-sm hover:underline"
                        onClick={() => {
                          setSelectedDocIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(doc.id)) next.delete(doc.id);
                            else next.add(doc.id);
                            return next;
                          });
                        }}
                      >
                        {doc.name}
                      </button>
                    </li>
                  ))}
                  {documents.length === 0 && (
                    <li className="text-sm text-muted-foreground">
                      {t("uploads.source.fromDoc.placeholder")}
                    </li>
                  )}
                </ul>
              </div>
              <div className="space-y-2">
                <Label>{t("uploads.source.fromDoc.archivePlaceholder")}</Label>
                <Select
                  value={fromDocArchiveId}
                  onValueChange={setFromDocArchiveId}
                >
                  <SelectTrigger className="w-full max-w-sm" data-testid="select-fromdoc-archive">
                    <SelectValue placeholder={t("uploads.source.fromDoc.archivePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {archives.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleFromDocSubmit}
                disabled={selectedDocIds.size === 0 || !fromDocArchiveId || fromDocSubmitting}
              >
                {t("uploads.source.fromDoc.submit")}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Destination chooser (D-02) */}
        <UploadDestinationChooser
          destination={destination}
          onDestinationChange={setDestination}
          archiveId={archiveId}
          onArchiveIdChange={setArchiveId}
          ocrMode={ocrMode}
          onOcrModeChange={setOcrMode}
        />

        {/* Pending panel (D-04) + D-11 skeleton stage */}
        <PendingDocsPanel workspaceId={workspaceId} stagePending={stageMutation.isPending} />
      </div>
    </div>
  );
}