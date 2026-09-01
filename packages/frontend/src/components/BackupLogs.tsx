// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * BackupLogs — Storico sub-tab: list of past backup runs with filters,
 * pagination, and a per-row Restore action.
 *
 * Phase 57-03 (D-14, D-15, D-16, D-12):
 *  - Server-side filter (status / destination / job / date range) + offset
 *    pagination via `useBackupLogs(filters)`.
 *  - Filter state mirrored in the URL via `useSearchParams` for deep-link
 *    and refresh.
 *  - Conditional 5s `refetchInterval` while any row is in "running" state
 *    (D-12) so the UI shows live progress after a fire-and-navigate from
 *    the Jobs sub-tab.
 *  - Restore button is permission-gated via `useBackupPermission("restore:write")`
 *    (D-19) and disabled while a log is "running".
 *  - The dialog opened by the Restore button is implemented in plan 04; this
 *    component only fires `props.onRestore(log)` and SettingsBackups owns
 *    the dialog state.
 */

import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  useBackupLogs,
  type BackupLog,
  type BackupLogFilters,
} from "../queries/useBackupLogs";
import { useBackupDestinations } from "../queries/useBackupDestinations";
import { useBackupJobs } from "../queries/useBackupJobs";
import { useBackupPermission } from "../hooks/useBackupPermission";
import { ApiError } from "../utils/api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

const STATUS_VALUES = ["all", "success", "failed", "running", "restored"] as const;

const PAGE_SIZES = [10, 20, 50, 100] as const;

const DEFAULT_PAGE_SIZE = 20;

interface BackupLogsProps {
  onRestore: (log: BackupLog) => void;
}

export default function BackupLogs({ onRestore }: BackupLogsProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const canRead = useBackupPermission("backup:log:read");
  const canRestore = useBackupPermission("backup:restore:write");

  const { data: destinations = [] } = useBackupDestinations();
  const { data: jobs = [] } = useBackupJobs();

  // Read filter state from URL (D-16). Missing or invalid values fall
  // back to defaults — we don't want to 400 on a malformed URL.
  const status = searchParams.get("status");
  const destinationId = searchParams.get("destinationId") || undefined;
  const jobId = searchParams.get("jobId") || undefined;
  const dateFrom = searchParams.get("dateFrom") || undefined;
  const dateTo = searchParams.get("dateTo") || undefined;
  const pageRaw = Number(searchParams.get("page") || "1");
  const pageSizeRaw = Number(
    searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE),
  );
  const sort = searchParams.get("sort") || undefined;
  const filtersFromUrl: BackupLogFilters = {
    status: status && status !== "all" ? status : undefined,
    destinationId,
    jobId,
    dateFrom,
    dateTo,
    page: Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    pageSize:
      Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1
        ? Math.min(pageSizeRaw, 100)
        : DEFAULT_PAGE_SIZE,
    sort,
  };

  const { data, isLoading, error: logsError } = useBackupLogs(filtersFromUrl);

  // Update the URL when any filter changes (D-16). Page resets to 1 when
  // a *non-page* filter changes — see the handler below.
  const updateUrl = (next: BackupLogFilters) => {
    const params = new URLSearchParams();
    if (next.status) params.set("status", next.status);
    if (next.destinationId) params.set("destinationId", next.destinationId);
    if (next.jobId) params.set("jobId", next.jobId);
    if (next.dateFrom) params.set("dateFrom", next.dateFrom);
    if (next.dateTo) params.set("dateTo", next.dateTo);
    if (next.page != null && next.page > 1) params.set("page", String(next.page));
    if (next.pageSize && next.pageSize !== DEFAULT_PAGE_SIZE)
      params.set("pageSize", String(next.pageSize));
    if (next.sort) params.set("sort", next.sort);
    setSearchParams(params, { replace: true });
  };

  const handleFilterChange = (partial: Partial<BackupLogFilters>) => {
    const next: BackupLogFilters = { ...filtersFromUrl, ...partial };
    // D-16: any non-page filter change resets page to 1.
    const isPageOnlyChange =
      Object.keys(partial).length === 1 && partial.page != null;
    if (!isPageOnlyChange) next.page = 1;
    updateUrl(next);
  };

  // WR-04: dedicated handler for page-size changes. Page-size changes
  // do reset page=1 (the user expects to see the first page of the
  // new size), but this used to piggyback on `handleFilterChange` with
  // a brittle `isPageOnlyChange` heuristic that failed when both
  // `page` and `pageSize` were passed in the same partial.
  const handlePageSizeChange = (size: number) => {
    const next: BackupLogFilters = { ...filtersFromUrl, pageSize: size, page: 1 };
    updateUrl(next);
  };

  const handleResetFilters = () => {
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  const hasActiveFilter = Boolean(
    filtersFromUrl.status ||
      filtersFromUrl.destinationId ||
      filtersFromUrl.jobId ||
      filtersFromUrl.dateFrom ||
      filtersFromUrl.dateTo,
  );

  const logs = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 0;
  const currentPage = data?.page ?? filtersFromUrl.page ?? 1;
  const pageSize = data?.pageSize ?? filtersFromUrl.pageSize ?? DEFAULT_PAGE_SIZE;

  const permissionDeniedTitle = t("settings.backups.permissionDenied");

  // Compact page-number list: 1 ... 4 5 6 ... 10
  const pageNumbers = (() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const current = currentPage;
    const result: (number | "...")[] = [1];
    if (current > 3) result.push("...");
    for (
      let p = Math.max(2, current - 1);
      p <= Math.min(totalPages - 1, current + 1);
      p++
    ) {
      result.push(p);
    }
    if (current < totalPages - 2) result.push("...");
    result.push(totalPages);
    return result;
  })();

  if (!canRead) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        {permissionDeniedTitle}
      </div>
    );
  }

  if (logsError instanceof ApiError && logsError.status === 404) {
    return (
      <div className="w-full space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {t("settings.backups.logs.title")}
            </h3>
          </div>
        </div>
        <div className="rounded-lg border border-input bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("backup.enterpriseRequired")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {t("settings.backups.logs.title")}
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            {t("settings.backups.logs.total", { total })}
          </p>
        </div>
      </div>

      {/* Filter bar (D-16) */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("settings.backups.logs.filterStatus")}
          </label>
          <Select
            value={(filtersFromUrl.status as string) ?? "all"}
            onValueChange={(value) =>
              handleFilterChange({ status: value === "all" ? undefined : value })
            }
          >
            <SelectTrigger className="w-[150px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`settings.backups.logs.status_${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("settings.backups.logs.filterDestination")}
          </label>
          <Select
            value={filtersFromUrl.destinationId ?? "all"}
            onValueChange={(value) =>
              handleFilterChange({
                destinationId: value === "all" ? undefined : value,
              })
            }
          >
            <SelectTrigger className="w-[180px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("settings.backups.logs.allDestinations")}</SelectItem>
              {destinations.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("settings.backups.logs.filterJob")}
          </label>
          <Select
            value={filtersFromUrl.jobId ?? "all"}
            onValueChange={(value) =>
              handleFilterChange({ jobId: value === "all" ? undefined : value })
            }
          >
            <SelectTrigger className="w-[180px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("settings.backups.logs.allJobs")}</SelectItem>
              {jobs.map((j) => (
                <SelectItem key={j.id} value={j.id}>
                  {j.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("settings.backups.logs.filterDateFrom")}
          </label>
          <Input
            type="date"
            value={filtersFromUrl.dateFrom ?? ""}
            onChange={(e) =>
              handleFilterChange({ dateFrom: e.target.value || undefined })
            }
            className="w-[160px] h-8 text-sm"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("settings.backups.logs.filterDateTo")}
          </label>
          <Input
            type="date"
            value={filtersFromUrl.dateTo ?? ""}
            onChange={(e) =>
              handleFilterChange({ dateTo: e.target.value || undefined })
            }
            className="w-[160px] h-8 text-sm"
          />
        </div>

        {hasActiveFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleResetFilters}
            className="self-end"
          >
            {t("settings.backups.logs.resetFilters")}
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="bg-card rounded-lg border border-input overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-input text-left text-muted-foreground">
              <TableHead className="px-5 py-2">
                {t("settings.backups.logs.colStatus")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.logs.colDestination")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.logs.colJob")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.logs.colStarted")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.logs.colDuration")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.logs.colSize")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.logs.colChecksum")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.logs.colActions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => {
              const isRunning = log.status === "running";
              const durationMs = computeDurationMs(log);
              const sizeMb = log.fileSize
                ? (log.fileSize / 1024 / 1024).toFixed(1)
                : null;
              const checksumShort = log.checksum
                ? log.checksum.slice(0, 8)
                : null;
              return (
                <TableRow
                  key={log.id}
                  className="border-b border-input hover:bg-accent"
                >
                  <TableCell className="px-5 py-3">
                    <StatusBadge status={log.status} />
                    {isRunning && (
                      <span className="text-xs text-muted-foreground ml-2">
                        {t("settings.backups.logs.runningBadge")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="px-5 py-3 text-foreground text-sm">
                    {log.destination?.name || log.destinationId}
                  </TableCell>
                  <TableCell className="px-5 py-3 text-muted-foreground text-sm">
                    {log.job?.name || "—"}
                  </TableCell>
                  <TableCell className="px-5 py-3 text-muted-foreground text-sm whitespace-nowrap">
                    {log.startedAt
                      ? new Date(log.startedAt).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="px-5 py-3 text-muted-foreground text-sm">
                    {durationMs != null
                      ? `${Math.floor(durationMs / 1000)}s`
                      : "—"}
                  </TableCell>
                  <TableCell className="px-5 py-3 text-muted-foreground text-sm">
                    {sizeMb != null ? `${sizeMb} MB` : "—"}
                  </TableCell>
                  <TableCell
                    className="px-5 py-3 text-muted-foreground text-xs font-mono"
                    title={log.checksum ?? undefined}
                  >
                    {checksumShort ?? "—"}
                  </TableCell>
                  <TableCell className="px-5 py-3">
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => onRestore(log)}
                      disabled={!canRestore || isRunning}
                      title={
                        !canRestore
                          ? permissionDeniedTitle
                          : isRunning
                            ? t("settings.backups.logs.cannotRestoreRunning")
                            : undefined
                      }
                    >
                      {t("settings.backups.logs.restore")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {logs.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="px-5 py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t("settings.backups.logs.empty")}
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {isLoading && logs.length === 0 && (
          <div className="text-center py-8 text-secondary-foreground text-sm">
            {t("common.loading")}
          </div>
        )}
      </div>

      {/* Pagination footer (D-15) */}
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {t("settings.backups.logs.pagination.page", { page: currentPage })}
            </span>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => handlePageSizeChange(Number(value))}
            >
              <SelectTrigger className="w-[110px] h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {t("settings.backups.logs.pagination.pageSize", { size: s })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleFilterChange({ page: 1 })}
              disabled={currentPage === 1}
            >
              {t("settings.backups.logs.pagination.first")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleFilterChange({ page: currentPage - 1 })}
              disabled={currentPage <= 1}
            >
              {t("settings.backups.logs.pagination.prev")}
            </Button>
            {pageNumbers.map((p, i) =>
              p === "..." ? (
                <span
                  key={`ellipsis-${i}`}
                  className="px-2 text-muted-foreground text-sm"
                >
                  …
                </span>
              ) : (
                <Button
                  key={p}
                  variant={p === currentPage ? "default" : "ghost"}
                  size="sm"
                  onClick={() => handleFilterChange({ page: p })}
                >
                  {p}
                </Button>
              ),
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleFilterChange({ page: currentPage + 1 })}
              disabled={currentPage >= totalPages}
            >
              {t("settings.backups.logs.pagination.next")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleFilterChange({ page: totalPages })}
              disabled={currentPage >= totalPages}
            >
              {t("settings.backups.logs.pagination.last")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Local helpers                                                      */
/* ------------------------------------------------------------------ */

function computeDurationMs(log: BackupLog): number | null {
  if (log.startedAt && log.completedAt) {
    const start = new Date(log.startedAt).getTime();
    const end = new Date(log.completedAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return end - start;
    }
  }
  return null;
}

function StatusBadge({ status }: { status: BackupLog["status"] }) {
  // Color map per D-15: success=default, failed=destructive, running=secondary,
  // restored=outline.
  const variant: "default" | "destructive" | "secondary" | "outline" =
    status === "success"
      ? "default"
      : status === "failed"
        ? "destructive"
        : status === "running"
          ? "secondary"
          : "outline";
  return <Badge variant={variant}>{status.toUpperCase()}</Badge>;
}
