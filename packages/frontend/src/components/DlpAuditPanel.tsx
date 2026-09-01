// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../queries/keys";
import { apiGet } from "../utils/api";
import { useFeature } from "../hooks/useFeature";
import UpgradePrompt from "./UpgradePrompt";
import { ChevronDown, ChevronRight, Eye, EyeOff, ShieldAlert } from "lucide-react";

interface DlpMatch {
  type: string;
  text: string;
}

interface DlpEventLog {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  userId: string | null;
  userName: string | null;
  entityName: string | null;
  metadata: {
    matchTypes?: string[];
    matches?: DlpMatch[];
    // 260829-ms8: origin surface added server-side ("chat" | "widget");
    // legacy rows have no key → treated as unknown and shown under the
    // "All" filter only.
    source?: string;
  } | null;
  createdAt: string;
}

interface DlpAuditResponse {
  logs: DlpEventLog[];
  total: number;
}

const PAGE_SIZE = 20;

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function actionLabel(action: string, t: (key: string) => string): string {
  switch (action) {
    case "dlp.input_match":
      return t("dlpAudit.actionInput");
    case "dlp.output_match":
      return t("dlpAudit.actionOutput");
    case "dlp.rag_context_match":
      return t("dlpAudit.actionRagContext");
    case "dlp.bypassed":
      // 260829-n95 (spec §2.2): role-bypass audit row — WHO bypassed, never the content.
      return t("dlpAudit.actionBypassed");
    default:
      return action;
  }
}

// 260829-ms8: client-side source filter values (DLP_FEATURES_SPEC §2.1 v1 —
// the backend returns the full page; filtering over the fetched page happens
// here; server-side source query param is deferred to slice 3).
type SourceFilter = "all" | "chat" | "widget";

/**
 * DlpAuditPanel — Admin DLP match history panel in Settings → Avanzate.
 *
 * Reads from GET /api/event-logs?entityType=dlp with offset-based pagination.
 * Shows date, user, entity, action, match types, and expandable matched text.
 */
export function DlpAuditPanel() {
  const { t } = useTranslation();
  const auditEnabled = useFeature("audit_log_immutable");
  const [page, setPage] = useState(1);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [showTextRow, setShowTextRow] = useState<string | null>(null);
  // 260829-ms8: client-side filters over the fetched page.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [chatIdFilter, setChatIdFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");

  const offset = (page - 1) * PAGE_SIZE;

  const { data, isLoading, error, refetch } = useQuery<DlpAuditResponse>({
    queryKey: queryKeys.eventLogs.list({ entityType: "dlp", limit: PAGE_SIZE, offset }),
    queryFn: () =>
      apiGet<DlpAuditResponse>(
        `/event-logs?entityType=dlp&limit=${PAGE_SIZE}&offset=${offset}`,
      ),
    enabled: auditEnabled,
    staleTime: 30_000,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  // 260829-ms8: client-side filtering over the fetched page (spec v1 —
  // server-side source filtering deferred to slice 3). Chat-id and user
  // matches are case-insensitive substrings; source matches the metadata
  // tag ("all" shows everything, including legacy rows without the key).
  const filteredLogs = (data?.logs ?? []).filter((log) => {
    if (sourceFilter === "chat" && log.metadata?.source !== "chat") return false;
    if (sourceFilter === "widget" && log.metadata?.source !== "widget") return false;
    if (chatIdFilter && !log.entityId.toLowerCase().includes(chatIdFilter.toLowerCase())) return false;
    if (userFilter) {
      const name = (log.userName ?? "").toLowerCase();
      if (!name.includes(userFilter.toLowerCase())) return false;
    }
    return true;
  });

  // Feature-gated: render the upgrade prompt on Community tier so the 402
  // from the Enterprise-gated endpoint never fires. The `enabled` option on
  // useQuery above keeps the request from firing; this early return renders
  // the upgrade card instead of the table/loading/error UI.
  if (!auditEnabled) {
    return <UpgradePrompt feature="audit_log_immutable" />;
  }

  const handleToggleRow = (id: string) => {
    setExpandedRow((prev) => (prev === id ? null : id));
    setShowTextRow(null);
  };

  const handleToggleText = (id: string) => {
    setShowTextRow((prev) => (prev === id ? null : id));
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-12 rounded-lg bg-[var(--surface-alt)] animate-pulse"
          />
        ))}
        <div className="text-sm text-[var(--text-muted)] text-center py-2">
          {t("dlpAudit.loading")}
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    const isNotFound =
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status: number }).status === 404;
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-[var(--error-text)]">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>
              {isNotFound
                ? t("dlpAudit.enterpriseRequired") || "DLP audit requires the Enterprise plugin."
                : t("dlpAudit.error")}
            </span>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-sm font-medium text-[var(--primary)] hover:underline"
          >
            {t("dlpAudit.retry")}
          </button>
        </div>
      </div>
    );
  }

  // Empty state
  if (!data || data.logs.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
        <ShieldAlert className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)]" />
        <p className="text-sm font-medium text-[var(--text)]">
          {t("dlpAudit.empty")}
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          {t("dlpAudit.emptyDesc")}
        </p>
      </div>
    );
  }

  const hasActiveFilters = sourceFilter !== "all" || chatIdFilter.trim() !== "" || userFilter.trim() !== "";

  return (
    <div className="space-y-3">
      {/* Description */}
      <p className="text-sm text-[var(--text-muted)]">
        {t("dlpAudit.description")}
      </p>

      {/* Filters (260829-ms8) — client-side over the fetched page */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          aria-label={t("dlpAudit.filterSource")}
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
        >
          <option value="all">{t("dlpAudit.filterAll")}</option>
          <option value="chat">{t("dlpAudit.filterChat")}</option>
          <option value="widget">{t("dlpAudit.filterWidget")}</option>
        </select>
        <input
          type="text"
          value={chatIdFilter}
          onChange={(e) => setChatIdFilter(e.target.value)}
          placeholder={t("dlpAudit.filterChatId")}
          aria-label={t("dlpAudit.filterChatId")}
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] w-full sm:w-56"
        />
        <input
          type="text"
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          placeholder={t("dlpAudit.filterUser")}
          aria-label={t("dlpAudit.filterUser")}
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] w-full sm:w-44"
        />
      </div>

      {/* Filtered-empty state (rows exist but no match on the current filter) */}
      {filteredLogs.length === 0 && hasActiveFilters ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
          <p className="text-sm font-medium text-[var(--text)]">
            {t("dlpAudit.filterEmpty")}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          {/* Header row — hidden on mobile */}
          <div className="hidden sm:flex items-center gap-4 px-4 py-2.5 bg-[var(--surface-alt)] border-b border-[var(--border)] text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            <div className="w-40 shrink-0">{t("dlpAudit.date")}</div>
            <div className="w-24 shrink-0">{t("dlpAudit.user")}</div>
            <div className="w-32 shrink-0 min-w-0">{t("dlpAudit.entity")}</div>
            <div className="w-20 shrink-0">{t("dlpAudit.action")}</div>
            <div className="flex-1 min-w-0">{t("dlpAudit.matchTypes")}</div>
            <div className="w-24 shrink-0 text-right">{t("dlpAudit.details")}</div>
          </div>

          {filteredLogs.map((log, idx) => (
          <div key={log.id}>
            <div
              className={`flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 px-4 py-3 ${
                idx > 0 ? "border-t border-[var(--border)]" : ""
              } bg-[var(--surface)] text-sm`}
            >
              {/* Mobile: label+value pairs */}
              <div className="flex sm:hidden items-center justify-between w-full">
                <span className="text-xs text-[var(--text-muted)] font-medium">
                  {formatDate(log.createdAt)}
                </span>
                <button
                  type="button"
                  onClick={() => handleToggleRow(log.id)}
                  className="flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
                  aria-expanded={expandedRow === log.id}
                  aria-controls={`dlp-details-${log.id}`}
                >
                  {expandedRow === log.id
                    ? t("dlpAudit.hideDetails")
                    : t("dlpAudit.viewDetails")}
                  {expandedRow === log.id ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                </button>
              </div>

              {/* Desktop columns */}
              <div className="w-full sm:w-40 shrink-0 text-xs sm:text-sm text-[var(--text)]">
                {formatDate(log.createdAt)}
              </div>
              <div className="w-full sm:w-24 shrink-0 text-xs sm:text-sm text-[var(--text)]">
                {log.userName ?? t("dlpAudit.system")}
              </div>
              <div className="w-full sm:w-32 shrink-0 text-xs sm:text-sm text-[var(--text-muted)] truncate">
                {log.entityName ?? `${log.entityId.substring(0, 8)}…`}
              </div>
              <div className="w-full sm:w-20 shrink-0">
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[var(--surface-alt)] text-[var(--text-muted)]">
                  {actionLabel(log.action, t)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1 flex-wrap">
                  {(log.metadata?.matchTypes ?? []).map((type) => (
                    <span
                      key={type}
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[var(--surface-alt)] text-[var(--text-muted)]"
                    >
                      {type}
                    </span>
                  ))}
                </div>
              </div>

              {/* Desktop expand button */}
              <div className="hidden sm:flex w-24 shrink-0 justify-end">
                <button
                  type="button"
                  onClick={() => handleToggleRow(log.id)}
                  className="flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
                  aria-expanded={expandedRow === log.id}
                  aria-controls={`dlp-details-${log.id}`}
                >
                  {expandedRow === log.id
                    ? t("dlpAudit.hideDetails")
                    : t("dlpAudit.viewDetails")}
                  {expandedRow === log.id ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                </button>
              </div>
            </div>

            {/* Expanded details */}
            {expandedRow === log.id && (
              <div
                id={`dlp-details-${log.id}`}
                className="px-4 py-3 border-t border-[var(--border)] bg-[var(--surface-alt)]"
              >
                {log.metadata?.matches && log.metadata.matches.length > 0 ? (
                  <div className="space-y-2">
                    {/* Show text toggle */}
                    <button
                      type="button"
                      onClick={() => handleToggleText(log.id)}
                      aria-expanded={showTextRow === log.id}
                      className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                    >
                      {showTextRow === log.id ? (
                        <>
                          <EyeOff className="w-3 h-3" />
                          {t("dlpAudit.hideDetails")}
                        </>
                      ) : (
                        <>
                          <Eye className="w-3 h-3" />
                          {t("dlpAudit.viewDetails")}
                        </>
                      )}
                    </button>

                    {/* Matched text */}
                    {showTextRow === log.id && (
                      <div className="space-y-1">
                        {log.metadata.matches.map((match, mIdx) => (
                          <div key={mIdx} className="flex items-start gap-2">
                            <span className="text-xs font-medium text-[var(--text-muted)] shrink-0 mt-0.5 w-16">
                              {match.type}
                            </span>
                            <code className="text-xs font-mono bg-[var(--surface)] rounded p-1.5 overflow-x-auto break-all text-[var(--text-muted)] flex-1">
                              {match.text}
                            </code>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (log.metadata?.matchTypes ?? []).length > 0 ? (
                  /* quick 260829-m6p: type-only events (matches missing or
                     empty) show the detected types instead of the bare
                     "no details" fallback — e.g. legacy rows or events where
                     only match types were recorded. */
                  <div className="space-y-1">
                    {(log.metadata?.matchTypes ?? []).map((type) => (
                      <div key={type} className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[var(--surface-alt)] text-[var(--text-muted)] shrink-0 w-16 justify-center">
                          {type}
                        </span>
                        <span className="text-xs text-[var(--text-muted)]">
                          {t("dlpAudit.matchTypesOnly")}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-[var(--text-muted)]">
                    {t("dlpAudit.noMatchDetails")}
                  </p>
                )}
              </div>
            )}
          </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] transition-colors"
        >
          {t("dlpAudit.previous")}
        </button>

        <span className="text-sm text-[var(--text-muted)]">
          {t("dlpAudit.page", { current: page, total: totalPages })}
        </span>

        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] transition-colors"
        >
          {t("dlpAudit.next")}
        </button>
      </div>
    </div>
  );
}

export default DlpAuditPanel;
