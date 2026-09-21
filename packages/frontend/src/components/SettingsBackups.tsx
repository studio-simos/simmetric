// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Settings → Backups — root tab component with 3 sub-tabs:
 *   1. Destinazioni (Destinations)  — wired by plan 57-01
 *   2. Programmati (Scheduled jobs)  — wired by plan 57-02
 *   3. Storico (History / logs)      — wired by plan 57-03 (and 04 for the modal)
 *
 * Per D-02 the active sub-tab is mirrored in the URL (`?sub=`) for deep-link
 * and refresh, and persisted in localStorage under `lastBackupsSubSection`.
 *
 * The Backups tab visibility is gated by the 3 backup read permissions via
 * `SETTINGS_TAB_PERMISSIONS.backups` (added in plan 57-01). License gating
 * for `backup_enabled` is intentionally NOT applied at the tab level — see
 * SettingsPage.tsx for the rationale comment. The license gate lives inside
 * `BackupDestinationForm.tsx` (D-20: when a Community-tier user picks a
 * remote destination type, <UpgradePrompt feature="backup_enabled" /> is
 * rendered in place of the credentials section).
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useViewTransition } from "./ui/view-transition";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "./ui/tabs";
import BackupDestinations from "./BackupDestinations";
import BackupJobs from "./BackupJobs";
import BackupLogs from "./BackupLogs";
import RestoreConfirmDialog from "./RestoreConfirmDialog";
import type { BackupLog } from "../queries/useBackupLogs";

type SubTab = "destinations" | "jobs" | "logs";

const SUB_TABS: SubTab[] = ["destinations", "jobs", "logs"];

function isSubTab(value: string | null): value is SubTab {
  return value === "destinations" || value === "jobs" || value === "logs";
}

export default function SettingsBackups() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const transitionTo = useViewTransition();

  // Read initial sub-tab from URL, falling back to localStorage, then default.
  const urlSub = searchParams.get("sub");
  const initialSub: SubTab = isSubTab(urlSub)
    ? urlSub
    : (() => {
        const last = typeof window !== "undefined"
          ? localStorage.getItem("lastBackupsSubSection")
          : null;
        return isSubTab(last) ? last : "destinations";
      })();

  const [activeSub, setActiveSub] = useState<SubTab>(initialSub);
  // W-05: Selected log for the Restore modal (plan 04 mounts the
  // <RestoreConfirmDialog> below; the setter is wired through
  // BackupLogs.onRestore).
  const [restoreLog, setRestoreLog] = useState<BackupLog | null>(null);

  // Persist active sub-tab to URL + localStorage on change (D-02, D-03).
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("lastBackupsSubSection", activeSub);
    }
    const next = new URLSearchParams(searchParams);
    next.set("sub", activeSub);
    setSearchParams(next, { replace: true });
    // We deliberately depend only on activeSub so the URL update fires once per
    // change. `searchParams` and `setSearchParams` are react-router stable
    // setters (setSearchParams is referentially stable across renders;
    // `searchParams` is read fresh into `next` inside the body so a stale
    // closure on it is intentional — we only want to preserve the *other*
    // query params, not re-run when they change). (D-05 pattern 3 —
    // intentional, documented.)
  }, [activeSub]);

  const handleSubChange = (value: string) => {
    if (!isSubTab(value)) return;
    transitionTo(() => setActiveSub(value));
  };

  return (
    <div className="w-full space-y-4">
      <Tabs value={activeSub} onValueChange={handleSubChange}>
        <TabsList className="flex overflow-x-auto h-auto bg-transparent p-0 gap-1 w-full border-b border-border">
          {SUB_TABS.map((sub) => (
            <TabsTrigger
              key={sub}
              value={sub}
              className="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors rounded-none data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent"
            >
              {t(`settings.backups.subTabs.${sub}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="destinations" className="mt-4">
          <BackupDestinations />
        </TabsContent>

        <TabsContent value="jobs" className="mt-4">
          <BackupJobs
            onNavigateToLogs={() => {
              handleSubChange("logs");
            }}
          />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <BackupLogs onRestore={setRestoreLog} />
        </TabsContent>
      </Tabs>

      {restoreLog && (
        <RestoreConfirmDialog
          log={restoreLog}
          open={!!restoreLog}
          onOpenChange={(open) => {
            if (!open) setRestoreLog(null);
          }}
          onComplete={() => {
            setRestoreLog(null);
          }}
        />
      )}
    </div>
  );
}
