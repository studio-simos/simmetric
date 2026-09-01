// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { apiGet } from "../utils/api";
import { Button } from "@/components/ui/button";

interface WorkspaceOption {
  id: string;
  name: string;
}

interface WidgetWorkspaceSelectorProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export default function WidgetWorkspaceSelector({ selectedIds, onChange }: WidgetWorkspaceSelectorProps) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadWorkspaces = async () => {
      try {
        const data = await apiGet<WorkspaceOption[]>("/workspaces");
        setWorkspaces(data);
      } catch {
        // Silently fail -- workspace list is not critical for initial load
      } finally {
        setLoading(false);
      }
    };
    loadWorkspaces();
  }, []);

  const removeWorkspace = (id: string) => {
    onChange(selectedIds.filter((wId) => wId !== id));
  };

  const selectedWorkspaces = workspaces.filter((w) => selectedIds.includes(w.id));

  if (loading) {
    return <div className="text-xs text-secondary-foreground">{t("common.loading")}</div>;
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-muted-foreground mb-1">
        {t("settings.widget.workspacesLabel")}
      </label>
      <select
        multiple
        value={selectedIds}
        onChange={(e) => {
          const options = Array.from(e.target.selectedOptions, (o) => o.value);
          onChange(options);
        }}
        className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground min-h-[80px]"
      >
        {workspaces.map((ws) => (
          <option
            key={ws.id}
            value={ws.id}
            className={selectedIds.includes(ws.id) ? "bg-primary text-white" : ""}
          >
            {ws.name}
          </option>
        ))}
      </select>
      <p className="text-[10px] text-secondary-foreground">
        {t("settings.widget.workspacesPlaceholder")}
      </p>

      {/* Selected workspace chips */}
      {selectedWorkspaces.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {selectedWorkspaces.map((ws) => (
            <span
              key={ws.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded bg-accent text-muted-foreground"
            >
              {ws.name}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => removeWorkspace(ws.id)}
                className="text-secondary-foreground hover:text-foreground"
                aria-label={`Remove ${ws.name}`}
              >
                &times;
              </Button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}