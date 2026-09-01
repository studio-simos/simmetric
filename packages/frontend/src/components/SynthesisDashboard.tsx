// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useNavigate } from "react-router-dom";
import { useSynthesisPendingRuns, useDeleteSynthesisRun } from "../queries/useSynthesis";
import { Button } from "@/components/ui/button";
import { showSuccess, showError } from "../lib/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import SynthesisRunCard from "./SynthesisRunCard";
import { Inbox, RefreshCw } from "lucide-react";
import { getErrorMessage } from "../utils/errorUtils";

function SkeletonCard() {
  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10 p-4 animate-pulse h-32">
      <div className="flex flex-col gap-3">
        <div className="h-5 bg-accent rounded w-2/3" />
        <div className="h-4 bg-accent rounded w-1/2" />
        <div className="h-3 bg-accent rounded w-1/3" />
      </div>
    </div>
  );
}

export default function SynthesisDashboard() {
  const { t } = useTranslation();
  usePageMeta(t("synthesis.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.synthesis") }]);
  const navigate = useNavigate();
  const { data: pendingRuns, isLoading, error, refetch } = useSynthesisPendingRuns();
  const deleteMutation = useDeleteSynthesisRun();
  const runs = pendingRuns ?? [];

  const handleDelete = async (runId: string) => {
    try {
      await deleteMutation.mutateAsync(runId);
      showSuccess(t("synthesis.deleteRunSuccess"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("common.error")));
    }
  };

  const [archiveFilter, setArchiveFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const archiveNames = (() => {
    const names = new Set<string>();
    for (const run of runs) {
      const name = run.archive?.name || run.archiveId;
      if (name) names.add(name);
    }
    return Array.from(names).sort();
  })();

  const statusValues: string[] = [
    "PENDING",
    "PROCESSING",
    "COMPLETED",
    "APPROVED",
    "REJECTED",
    "PARTIAL",
    "FAILED",
  ];

  const filteredRuns = (() => {
    let result = [...runs];
    if (archiveFilter !== "all") {
      result = result.filter((r) => {
        const name = r.archive?.name || r.archiveId;
        return name === archiveFilter;
      });
    }
    if (statusFilter !== "all") {
      result = result.filter((r) => r.status === statusFilter);
    }
    result.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return result;
  })();

  // Loading state
  if (isLoading && runs.length === 0) {
    return (
      <div className="h-full overflow-auto p-6">
        <h1 className="mb-6" style={{ fontSize: "28px", fontWeight: 600, lineHeight: 1.1 }}>
          {t("synthesis.dashboard.title")}
        </h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  // Error state
  if (error && runs.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 flex items-center justify-center">
        <div className="text-center max-w-md">
          <h2 style={{ fontSize: "28px", fontWeight: 600, lineHeight: 1.1 }}>
            {t("synthesis.dashboard.error.heading")}
          </h2>
          <p
            className="mt-2 text-muted-foreground"
            style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}
          >
            {t("synthesis.dashboard.error.body")}
          </p>
          <Button
            variant="outline"
            className="mt-4 gap-2"
            onClick={() => refetch()}
          >
            <RefreshCw className="w-4 h-4" />
            {t("synthesis.dashboard.retry")}
          </Button>
        </div>
      </div>
    );
  }

  // Empty state
  if (!isLoading && runs.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 flex items-center justify-center">
        <div className="text-center max-w-md">
          <Inbox className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
          <h2 style={{ fontSize: "28px", fontWeight: 600, lineHeight: 1.1 }}>
            {t("synthesis.dashboard.empty.heading")}
          </h2>
          <p
            className="mt-2 text-muted-foreground"
            style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}
          >
            {t("synthesis.dashboard.empty.body")}
          </p>
        </div>
      </div>
    );
  }

  // Populated state
  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="mb-6" style={{ fontSize: "28px", fontWeight: 600, lineHeight: 1.1 }}>
        {t("synthesis.dashboard.title")}
      </h1>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="flex items-center gap-2">
          <label
            className="text-xs font-semibold text-muted-foreground"
            style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}
          >
            {t("synthesis.dashboard.filterByArchive")}:
          </label>
          <Select value={archiveFilter} onValueChange={setArchiveFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {archiveNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label
            className="text-xs font-semibold text-muted-foreground"
            style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}
          >
            {t("synthesis.dashboard.filterByStatus")}:
          </label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {statusValues.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(`synthesis.detail.status.${status}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredRuns.map((run) => (
          <SynthesisRunCard
            key={run.id}
            run={run}
            onClick={() => navigate(`/synthesis/${run.id}`)}
            onDelete={() => handleDelete(run.id)}
          />
        ))}
      </div>
    </div>
  );
}
