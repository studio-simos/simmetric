// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { showError } from "../lib/toast";
import {
  useWidgetLeads,
  useWidgetLead,
  useExportLeadsCsv,
} from "../queries/useWidgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getErrorMessage } from "../utils/errorUtils";

interface WidgetLeadsTabProps {
  widgetId: string;
}

export default function WidgetLeadsTab({ widgetId }: WidgetLeadsTabProps) {
  const { t } = useTranslation();
  const exportLeadsCsv = useExportLeadsCsv();

  const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null);

  // Leads query
  const {
    data: leadsData,
    isLoading: leadsLoading,
  } = useWidgetLeads(widgetId, 1, 20);
  const leads = leadsData?.leads ?? [];

  // Selected lead detail for transcript expansion
  const { data: selectedLead } = useWidgetLead(
    widgetId,
    expandedLeadId ?? undefined
  );

  // CSV export state
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exportColumns, setExportColumns] = useState<string[]>(["email", "name", "date"]);
  const [showExportDialog, setShowExportDialog] = useState(false);

  const handleExportCsv = async () => {
    try {
      await exportLeadsCsv.mutateAsync({
        widgetId,
        from: exportFrom || undefined,
        to: exportTo || undefined,
        columns: exportColumns.join(","),
      });
    } catch (err: unknown) {
      showError(getErrorMessage(err, "Export failed"));
    }
    setShowExportDialog(false);
  };

  const toggleColumn = (col: string) => {
    setExportColumns((prev) =>
      prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]
    );
  };

  const handleExpandLead = (leadId: string) => {
    if (expandedLeadId === leadId) {
      setExpandedLeadId(null);
      return;
    }
    setExpandedLeadId(leadId);
  };

  return (
    <div className="space-y-4">
      {/* Export button */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">
          {t("settings.widget.leadsTab")}
        </h4>
        <Button size="sm" onClick={() => setShowExportDialog(true)}>
          {t("settings.widget.exportLeads")}
        </Button>
      </div>

      {/* Export dialog */}
      {showExportDialog && (
        <div className="bg-card rounded-lg border border-border p-4 space-y-3">
          <h5 className="text-sm font-semibold text-foreground">
            {t("settings.widget.exportLeads")}
          </h5>
          <div className="flex gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                {t("settings.widget.dateFrom")}
              </label>
              <Input
                type="date"
                value={exportFrom}
                onChange={(e) => setExportFrom(e.target.value)}
                className="px-3 py-2 text-sm w-auto"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                {t("settings.widget.dateTo")}
              </label>
              <Input
                type="date"
                value={exportTo}
                onChange={(e) => setExportTo(e.target.value)}
                className="px-3 py-2 text-sm w-auto"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              {t("settings.widget.columns")}
            </label>
            <div className="flex gap-4">
              {["email", "name", "transcript", "date"].map((col) => (
                <label
                  key={col}
                  className="flex items-center gap-1.5 text-sm text-foreground"
                >
                  <Checkbox
                    checked={exportColumns.includes(col)}
                    onCheckedChange={() => toggleColumn(col)}
                  />
                  {t(
                    `settings.widget.column${col.charAt(0).toUpperCase() + col.slice(1)}`,
                  )}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowExportDialog(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={handleExportCsv}>
              {t("settings.widget.downloadCsv")}
            </Button>
          </div>
        </div>
      )}

      {/* Lead list */}
      {leadsLoading ? (
        <div className="text-sm text-muted-foreground">
          {t("common.loading")}
        </div>
      ) : leads.length === 0 ? (
        <div className="text-center py-8">
          <h4 className="text-lg font-semibold text-foreground mb-2">
            {t("settings.widget.noLeads")}
          </h4>
          <p className="text-sm text-muted-foreground mb-4">
            {t("settings.widget.noLeadsBody")}
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-border">
                <TableHead className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">
                  {t("settings.widget.columnName")}
                </TableHead>
                <TableHead className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">
                  {t("settings.widget.columnEmail")}
                </TableHead>
                <TableHead className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">
                  {t("settings.widget.columnDate")}
                </TableHead>
                <TableHead className="text-left px-4 py-2 text-xs font-medium text-muted-foreground"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow
                  key={lead.id}
                  className="border-b border-border hover:bg-accent"
                >
                  <TableCell className="px-4 py-2 text-foreground">
                    {lead.name || "--"}
                  </TableCell>
                  <TableCell className="px-4 py-2 text-foreground">
                    {lead.email}
                  </TableCell>
                  <TableCell className="px-4 py-2 text-muted-foreground">
                    {new Date(lead.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="px-4 py-2">
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() =>
                        handleExpandLead(lead.id)
                      }
                    >
                      {expandedLeadId === lead.id
                        ? t("settings.widget.hideTranscript")
                        : t("settings.widget.viewTranscript")}
                    </Button>
                  </TableCell>
                  {expandedLeadId === lead.id &&
                    selectedLead?.id === lead.id && (
                      <TableCell colSpan={4} className="px-4 py-2">
                        <div className="mt-2 p-3 bg-muted rounded text-xs space-y-2">
                          {(selectedLead.transcript || []).map(
                            (msg, i) => (
                              <div key={i}>
                                <span className="font-semibold text-foreground">
                                  {msg.role === "user"
                                    ? "Visitor"
                                    : "Assistant"}
                                  :
                                </span>{" "}
                                <span className="text-muted-foreground">
                                  {msg.content}
                                </span>
                              </div>
                            ),
                          )}
                        </div>
                      </TableCell>
                    )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
