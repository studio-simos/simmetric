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
import UserDropdown from "./ui/UserDropdown";

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
  /** Authenticated user, for the avatar dropdown. */
  user: TopBarUser | null;
  /** Logout handler. */
  onLogout: () => void;
  className?: string;
}

/**
 * TopBar — desktop top bar (Feature 3.2 / 3.5 / 7.4 / UI_DESIGN.md).
 *
 * 48px-tall, sits above the main content area. Left: active
 * project name with an inline rename trigger (opens ProjectRenameModal →
 * PUT /api/projects/:id, invalidates the projects cache and dispatches
 * `projects-changed`), and the active section label in monospace. Right:
 * default-model chip was removed (Feature 8 follow-up): model switching is
 * consolidated into the ChatInputArea `ChatModelBadge` ("md"), which is the
 * single model selector for the chat, and the global Cmd+K palette remains
 * available from anywhere. Right side: compact session token widget, and the
 * consolidated UserDropdown (language + theme + links + license +
 * version + sign-out). The standalone ThemeToggle was removed in Feature 7.4
 * — theme switching now lives inside UserDropdown.
 *
 * Visible at all breakpoints (the same bar serves mobile and desktop — the
 * mobile-specific MobileTopBar/Sheet pattern was removed). The PROGETTO
 * block (project label + name + inline rename) is always visible: on tablet
 * and desktop (≥425px) the "Progetto:" label is shown too; on mobile (<425px)
 * only the label is hidden — the project name + inline rename button remain
 * alongside the active section label + token widget + user menu.
 * Intentionally theme-aware (`bg-card/80` + `border-input`) rather than using
 * the fixed-dark `glass-panel`, so it stays correct in light / dark / hacker.
 */
export default function TopBar({
  currentSection,
  selectedProjectId,
  user,
  onLogout,
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

        {/* Consolidated user menu (Feature 7.4) — language + theme + links + license + sign-out */}
        <UserDropdown user={user} onLogout={onLogout} />
      </div>

      <ProjectRenameModal
        open={renameOpen}
        onOpenChange={setRenameOpen}
        project={activeProject ? { id: activeProject.id, name: activeProject.name } : null}
      />
    </header>
  );
}