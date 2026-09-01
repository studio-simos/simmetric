// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useParams, useNavigate, useSearchParams, useLocation, useBeforeUnload } from "react-router-dom";
import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useWidgets } from "../queries/useWidgets";
import WidgetForm from "./WidgetForm";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const VALID_TABS = ["settings", "localization", "questions", "credits", "leads"] as const;
type Tab = (typeof VALID_TABS)[number];

export default function WidgetDetailPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();

  const { data: widgets = [], isLoading } = useWidgets();
  const widget = widgets.find((w) => w.id === params.id);

  const isCreateMode = location.pathname === "/widgets/new";

  // Dirty-guard state (D-02): fed by WidgetForm's onDirtyChange.
  const [isDirty, setIsDirty] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const pendingPathRef = useRef<string | null>(null);
  const lastPathnameRef = useRef(location.pathname);
  const isDiscardingRef = useRef(false);

  // Browser-level guard (reload/close) — research Pattern 3: the
  // data-router blocker hook throws under BrowserRouter (Pitfall 1);
  // useBeforeUnload is the declarative-compatible export.
  useBeforeUnload(
    useCallback((event: BeforeUnloadEvent) => {
      if (isDirty) {
        // G-128-5: Chrome 60+ ignores returnValue alone — preventDefault() is
        // what marks the page "potentially unsafe to leave" and makes the
        // browser-native reload prompt appear. returnValue stays for Firefox.
        event.preventDefault();
        event.returnValue = ""; // Firefox requires returnValue set (A1)
        return true;
      }
    }, [isDirty])
  );

  // In-app guard: intercept the page's own navigation (back-to-list button,
  // breadcrumbs) when the form is dirty — research Pattern 3.
  const requestNavigation = useCallback(
    (to: string) => {
      pendingPathRef.current = to;
      if (isDirty) {
        setShowDiscardDialog(true);
      } else {
        navigate(to);
      }
    },
    [isDirty, navigate]
  );

  // Location watcher for browser back/forward + sidebar navigation (OQ3
  // resolution, ~20 lines): when the pathname changes while dirty, store the
  // new pathname and open the dialog. Guards: initial mount (lastPathnameRef
  // seeded) and our own confirm-navigation (isDiscardingRef).
  useEffect(() => {
    if (location.pathname === lastPathnameRef.current) return;
    lastPathnameRef.current = location.pathname;
    if (isDiscardingRef.current) {
      isDiscardingRef.current = false;
      return;
    }
    if (isDirty) {
      pendingPathRef.current = location.pathname;
      setShowDiscardDialog(true);
    }
  }, [location.pathname, isDirty]);

  const handleDiscardConfirm = () => {
    const to = pendingPathRef.current;
    setShowDiscardDialog(false);
    pendingPathRef.current = null;
    if (to) {
      isDiscardingRef.current = true;
      navigate(to, { replace: true });
    }
  };

  const handleDiscardCancel = () => {
    setShowDiscardDialog(false);
    pendingPathRef.current = null;
  };

  // Discard dialog (repo precedent: WorkspaceCreatePanel.tsx:637-659) — shown
  // on any navigation away with unsaved changes (D-02, SC3).
  const discardDialog = (
    <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("workspace.unsavedNavigateTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("workspace.unsavedNavigateBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleDiscardCancel}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDiscardConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t("workspace.discard")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  usePageMeta(widget?.name || t("widgets.pageTitle"), [
    { label: t("breadcrumb.home"), path: "/" },
    { label: t("breadcrumb.widgets"), path: "/widgets" },
    { label: widget?.name || t("widgets.pageTitle") },
  ]);

  // Tab resolution per research Pattern 1: validate against the 5-value union,
  // fall back to "settings" when missing/invalid (T-128-01).
  const rawTab = searchParams.get("tab");
  const tab: Tab = VALID_TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "settings";

  const handleTabChange = (next: string) => {
    setSearchParams({ tab: next }, { replace: true });
  };

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">{t("common.loading")}</div>;
  }

  // Create mode: /widgets/new — no widget id yet. The full 5-tab structure
  // renders (supersedes 128-01's plain-form-page spec): settings form +
  // localization + shells + leads (leads disabled — no widget id).
  if (isCreateMode) {
    return (
      <>
        <div className="h-full overflow-y-auto p-6 sm:p-8">
          <div className="w-full space-y-6">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => requestNavigation("/widgets")}>
                &larr; {t("breadcrumb.widgets")}
              </Button>
              <h3 className="text-lg font-semibold text-foreground">
                {t("settings.widget.createButton")}
              </h3>
            </div>
            <WidgetForm
              tab={tab}
              onTabChange={handleTabChange}
              onSave={(createdId) => {
                // G-128-4: after CREATE the admin routes to the new widget's
                // edit area (/widgets/:id) — keep this branch.
                if (createdId) navigate(`/widgets/${createdId}`, { replace: true });
              }}
              onDirtyChange={setIsDirty}
            />
          </div>
        </div>
        {discardDialog}
      </>
    );
  }

  // Not found: unknown id (T-128-02) — back-to-list block, no crash.
  if (!widget) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <p className="text-muted-foreground">{t("common.error")}</p>
        <Button size="sm" onClick={() => navigate("/widgets")}>
          &larr; {t("breadcrumb.widgets")}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="h-full overflow-y-auto p-6 sm:p-8">
        <div className="w-full space-y-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => requestNavigation("/widgets")}>
              &larr; {t("breadcrumb.widgets")}
            </Button>
            <h3 className="text-lg font-semibold text-foreground">{widget.name}</h3>
          </div>

          {/* The Tabs live INSIDE WidgetForm's <form> (OQ2 final — one form
              instance across all 5 tabs, D-02). The page keeps only the tab
              state (useSearchParams) + validation and delegates rendering. */}
          <WidgetForm
            widget={widget}
            tab={tab}
            onTabChange={handleTabChange}
            // G-128-4: on EDIT save the admin stays in the current tab — no
            // navigation. The form already resets dirty state on save-success
            // (WidgetForm.tsx) and the tab state lives in the ?tab= URL param,
            // which is untouched. Previously this navigated back to /widgets,
            // ejecting the admin after every save.
            onSave={() => {
              /* stay in the current tab on edit save */
            }}
            onDirtyChange={setIsDirty}
          />
        </div>
      </div>
      {discardDialog}
    </>
  );
}
