// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useChatNav } from "../contexts/ChatContext";
import { useProjects } from "../queries/useProjects";
import TokenCounterWidget from "./TokenCounterWidget";
import ProjectRenameModal from "./ProjectRenameModal";

interface TopBarUser {
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  avatar?: string | null;
}

export interface TopBarProps {
  /** Active section / page title shown in the bar (already i18n-resolved by caller). */
  currentSection: string;
  /** Currently selected project id (drives the project name label + rename target). */
  selectedProjectId: string;
  /**
   * Authenticated user — kept in the props shape for the App.tsx call site
   * (UI revision R-5 moved the user menu into the sidebar's UserMenuDialog),
   * but the bar itself no longer renders a user menu.
   */
  user?: TopBarUser | null;
  /** Logout handler (passed through to App wiring; unused inside the bar). */
  onLogout?: () => void;
  className?: string;
}

/**
 * TopBar — slim desktop top bar (UI revision R-5).
 *
 * 48px-tall, sits above the main content area. Left: active project name with
 * an inline rename trigger (opens ProjectRenameModal → PUT /api/projects/:id)
 * and the active section label in monospace. Right: compact session token
 * widget. The consolidated UserDropdown was removed in R-5 — the user menu
 * (language/theme/settings/sign-out) now lives in the sidebar footer's
 * UserMenuDialog; sign-out is wired by App.tsx directly.
 *
 * Visible at all breakpoints. Intentionally theme-aware (`bg-card/80` +
 * `border-input`) so it stays correct in light / dark / hacker.
 */
export default function TopBar({
  currentSection,
  selectedProjectId,
  className,
}: TopBarProps) {
  const { t } = useTranslation();
  const { currentWorkspaceId } = useChatNav();
  const { data: projects } = useProjects();

  const [renameOpen, setRenameOpen] = useState(false);

  const activeProject = projects?.find((p) => p.id === selectedProjectId) ?? null;
  const projectName = activeProject?.name ?? (selectedProjectId ? "…" : t("topbar.noProject"));

  return (
    <header
      className={cn(
        "flex h-12 flex-none items-center justify-between gap-3 border-b border-input bg-card/80 px-3 backdrop-blur transition-theme",
        className,
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {/* Active project name + inline rename (Feature 1 / 3.5).
            Visible at all breakpoints. The "Progetto:" label is hidden below
            425px to save space on phones; the name + rename button remain. */}
        <div className="flex items-center gap-1 min-w-0">
          <span
            className="font-mono text-xs text-muted-foreground/70 uppercase tracking-wider hidden min-[425px]:inline"
            aria-hidden
          >
            {t("sidebar.project")}:
          </span>
          <span
            className="font-mono text-xs text-foreground truncate max-w-[18ch]"
            title={projectName}
          >
            {projectName}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setRenameOpen(true)}
            disabled={!activeProject}
            aria-label={t("topbar.renameProject")}
            title={t("topbar.renameProject")}
          >
            <Pencil className="w-3 h-3" />
          </Button>
        </div>

        <span className="text-muted-foreground/40 hidden md:inline" aria-hidden>
          /
        </span>
        <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground truncate">
          {currentSection || "—"}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <TokenCounterWidget workspaceId={currentWorkspaceId} />
      </div>

      <ProjectRenameModal
        open={renameOpen}
        onOpenChange={setRenameOpen}
        project={activeProject ? { id: activeProject.id, name: activeProject.name } : null}
      />
    </header>
  );
}