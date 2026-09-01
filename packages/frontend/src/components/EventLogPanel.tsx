// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { logger } from "@/utils/logger";
import { showError } from "@/lib/toast";
import { useTranslation } from "react-i18next";
import { useFeature } from "../hooks/useFeature";
import type { FeatureFlag } from "@simmetric-chat/shared";
import UpgradePrompt from "./UpgradePrompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface EventLogEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  userId: string | null;
  userName: string | null;
  entityName: string;
  metadata: string | null;
  createdAt: string;
}

export default function EventLogPanel() {
  const { t } = useTranslation();
  const auditEnabled = useFeature("audit_log_immutable" as FeatureFlag);

  if (!auditEnabled) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <h2 className="text-xl font-bold mb-4">{t("eventLog.title")}</h2>
        <UpgradePrompt feature="audit_log_immutable" />
      </div>
    );
  }

  return <EventLogPanelContent />;
}

// Extracted so every useState/useEffect is unconditional at the top level.
// EventLogPanel keeps useTranslation/useFeature before its early return; the
// gated UI state lives here where no conditional return precedes it.
function EventLogPanelContent() {
  const { t } = useTranslation();

  const [logs, setLogs] = useState<EventLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ entityType: "all" });
  // D-02: default page size 50; page state drives offset pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [exporting, setExporting] = useState(false);

  // D-03: totalPages derived client-side from server total + pageSize
  const totalPages = Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;

  useEffect(() => {
    fetchLogs();
  }, [filters, page, pageSize]);

  // D-03: entityType filter change resets to page 1
  useEffect(() => {
    setPage(1);
  }, [filters.entityType]);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("token");
      const params = new URLSearchParams();
      if (filters.entityType !== "all") params.set("entityType", filters.entityType);
      params.set("limit", String(pageSize));
      params.set("offset", String(offset));

      const response = await fetch(`/api/event-logs?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (response.status === 404) {
        setError(t("eventLog.enterpriseRequired") || "Event logs require the Enterprise plugin.");
        setLogs([]);
        setTotal(0);
        return;
      }

      if (response.status === 402) {
        setError(t("eventLog.licenseRequired") || "Event logs require an Enterprise license.");
        setLogs([]);
        setTotal(0);
        return;
      }

      if (!response.ok) throw new Error("Failed to fetch logs");

      const data = await response.json();
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err) {
      logger.error("[eventLog] Failed to fetch event logs", { error: err instanceof Error ? err.message : String(err) });
      setError(t("eventLog.fetchError") || "Failed to fetch event logs.");
    } finally {
      setLoading(false);
    }
  };

  const fetchAllLogsForExport = async () => {
    const token = localStorage.getItem("token");
    const params = new URLSearchParams();
    if (filters.entityType !== "all") params.set("entityType", filters.entityType);
    params.set("limit", "10000");
    params.set("offset", "0");

    const response = await fetch(`/api/event-logs?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!response.ok) throw new Error("Failed to fetch logs for export");
    const data = await response.json();
    return data.logs || [];
  };

  const handleExportCSV = async () => {
    setExporting(true);
    try {
      const allLogs = await fetchAllLogsForExport();
      const headers = [t("eventLog.colTime"), t("eventLog.colType"), t("eventLog.colAction"), t("eventLog.colEntityId"), t("eventLog.colUserId"), "Metadata"];
      const rows = allLogs.map((log: { createdAt: string; entityType: string; action: string; entityName: string; userName?: string; metadata?: string }) => [
        new Date(log.createdAt).toISOString(),
        log.entityType,
        log.action,
        log.entityName,
        log.userName || t("eventLog.systemUser"),
        log.metadata || "",
      ]);

      const escape = (val: string) => `"${val.replace(/"/g, '""')}"`;
      const csv = [headers.map(escape).join(","), ...rows.map((r: string[]) => r.map(escape).join(","))].join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `event-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.error("[eventLog] CSV export failed", { error: err instanceof Error ? err.message : String(err) });
      showError(t("eventLog.exportError") || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleExportJSON = async () => {
    setExporting(true);
    try {
      const allLogs = await fetchAllLogsForExport();
      const data = allLogs.map((log: { createdAt: string; entityType: string; action: string; entityName: string; userName?: string; metadata?: string }) => ({
        time: new Date(log.createdAt).toISOString(),
        type: log.entityType,
        action: log.action,
        entityName: log.entityName,
        userName: log.userName || "system",
        metadata: log.metadata,
      }));

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `event-log-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.error("[eventLog] JSON export failed", { error: err instanceof Error ? err.message : String(err) });
      showError(t("eventLog.exportError") || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const entityTypeVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    chat: "outline",
    project: "default",
    workspace: "outline",
    document: "secondary",
    user: "destructive",
  };

  // Compact page-number list with eliding (BackupLogs pattern, D-01)
  const pageNumbers = (() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const current = page;
    const result: (number | "...")[] = [1];
    if (current > 3) result.push("...");
    for (let p = Math.max(2, current - 1); p <= Math.min(totalPages - 1, current + 1); p++) {
      result.push(p);
    }
    if (current < totalPages - 2) result.push("...");
    result.push(totalPages);
    return result;
  })();

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-foreground">{t("eventLog.title")}</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCSV}
            disabled={logs.length === 0 || exporting}
          >
            {exporting ? "..." : t("eventLog.exportCsv")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportJSON}
            disabled={logs.length === 0 || exporting}
          >
            {exporting ? "..." : t("eventLog.exportJson")}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-4">
        <Select
          value={filters.entityType}
          onValueChange={(value) => setFilters({ ...filters, entityType: value })}
        >
          <SelectTrigger className="text-sm">
            <SelectValue placeholder={t("eventLog.allTypes")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("eventLog.allTypes")}</SelectItem>
            <SelectItem value="chat">{t("eventLog.typeChat")}</SelectItem>
            <SelectItem value="project">{t("eventLog.typeProject")}</SelectItem>
            <SelectItem value="workspace">{t("eventLog.typeWorkspace")}</SelectItem>
            <SelectItem value="document">{t("eventLog.typeDocument")}</SelectItem>
            <SelectItem value="user">{t("eventLog.typeUser")}</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-sm text-muted-foreground self-center">
          {total > 0
            ? t("eventLog.showingResults", {
                from: offset + 1,
                to: Math.min(page * pageSize, total),
                total,
              })
            : t("eventLog.totalEvents", { count: 0 })}
        </span>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-4 mb-4 text-sm">
          {error}
        </div>
      )}

      {/* Log Table */}
      {loading ? (
        <div className="text-muted-foreground py-8 text-center">{t("eventLog.loading")}</div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="border-b text-left text-muted-foreground">
                <TableHead className="pb-2 pr-4">{t("eventLog.colTime")}</TableHead>
                <TableHead className="pb-2 pr-4">{t("eventLog.colType")}</TableHead>
                <TableHead className="pb-2 pr-4">{t("eventLog.colAction")}</TableHead>
                <TableHead className="pb-2 pr-4">{t("eventLog.colEntityId")}</TableHead>
                <TableHead className="pb-2">{t("eventLog.colUserId")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id} className="border-b border-border">
                  <TableCell className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="py-2 pr-4">
                    <Badge
                      variant={entityTypeVariant[log.entityType] || "outline"}
                      className="text-xs"
                    >
                      {log.entityType}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2 pr-4 font-mono text-xs">{log.action}</TableCell>
                  <TableCell className="py-2 pr-4 text-muted-foreground text-xs truncate max-w-[180px]">
                    {log.entityName}
                  </TableCell>
                  <TableCell className="py-2 text-muted-foreground text-xs truncate max-w-[180px]">
                    {log.userName ?? t("eventLog.systemUser")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {logs.length === 0 && (
            <p className="text-muted-foreground text-center py-8">{t("eventLog.noEvents")}</p>
          )}

          {/* Pagination footer (D-04: bottom only) */}
          {total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {t("eventLog.pagination.page", { page })}
                </span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) => {
                    setPageSize(Number(value));
                    setPage(1); // D-02: page size change resets to page 1
                  }}
                >
                  <SelectTrigger className="w-[110px] h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[25, 50, 100].map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {t("eventLog.pagination.pageSize", { size: s })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage(1)}
                  disabled={page === 1}
                >
                  {t("eventLog.pagination.first")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  {t("eventLog.pagination.prev")}
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
                      variant={p === page ? "default" : "ghost"}
                      size="sm"
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </Button>
                  ),
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  {t("eventLog.pagination.next")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage(totalPages)}
                  disabled={page >= totalPages}
                >
                  {t("eventLog.pagination.last")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}