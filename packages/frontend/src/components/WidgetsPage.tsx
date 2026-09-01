// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { showSuccess, showError } from "../lib/toast";
import { useFeature } from "../hooks/useFeature";
import { usePageMeta } from "@/hooks/usePageMeta";
import type { Widget } from "@simmetric-chat/shared";
import { useWidgets, useDeleteWidget } from "../queries/useWidgets";
import { Badge } from "@/components/ui/badge";
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
import { getErrorMessage } from "../utils/errorUtils";

export default function WidgetsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  usePageMeta(t("widgets.pageTitle"), [
    { label: t("breadcrumb.home"), path: "/" },
    { label: t("breadcrumb.widgets") },
  ]);
  const { data: widgets = [], isLoading: loading } = useWidgets();
  const deleteWidget = useDeleteWidget();
  const widgetEnabled = useFeature("widget_enabled");

  const [widgetToDelete, setWidgetToDelete] = useState<Widget | null>(null);

  const handleDelete = async () => {
    if (!widgetToDelete) return;
    try {
      await deleteWidget.mutateAsync(widgetToDelete.id);
      showSuccess(t("settings.widget.deleteSuccess"));
      setWidgetToDelete(null);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.widget.deleteFailed")));
    }
  };

  if (!widgetEnabled) {
    return (
      <div className="h-full overflow-y-auto p-6 sm:p-8">
        <div className="w-full space-y-6">
          <div className="sticky top-0 z-10 mb-4 border border-input bg-accent rounded-lg p-4 flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground shrink-0" />
            <span className="text-sm text-foreground">
              {t("widgets.disabledBanner")}
            </span>
          </div>

          <h3 className="text-lg font-semibold text-foreground">
            {t("settings.widget.title")}
          </h3>

          {loading && (
            <div className="text-muted-foreground text-sm">
              {t("common.loading")}
            </div>
          )}

          {!loading && widgets.length === 0 && (
            <div className="text-center py-12">
              <h4 className="text-lg font-semibold text-foreground mb-2">
                {t("settings.widget.noWidgets")}
              </h4>
              <p className="text-sm text-muted-foreground">
                {t("settings.widget.noWidgetsBody")}
              </p>
            </div>
          )}

          {!loading && widgets.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {widgets.map((widget) => (
                <div
                  key={widget.id}
                  className="bg-card rounded-lg border border-border p-5"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-lg font-semibold text-foreground">
                      {widget.name}
                    </span>
                    <Badge
                      variant={widget.isActive ? "default" : "outline"}
                      className="text-xs"
                      aria-label={`Status: ${widget.isActive ? t("settings.widget.activeBadge") : t("settings.widget.inactiveBadge")}`}
                    >
                      {widget.isActive
                        ? t("settings.widget.activeBadge")
                        : t("settings.widget.inactiveBadge")}
                    </Badge>
                  </div>

                  {widget.workspaces && widget.workspaces.length > 0 && (
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("settings.widget.workspacesCount", {
                        count: widget.workspaces.length,
                      })}
                    </p>
                  )}

                  {widget._count?.leads != null && widget._count.leads > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("settings.widget.leadsTab")}: {widget._count.leads}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="text-muted-foreground text-sm">{t("common.loading")}</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-6 sm:p-8">
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">
          {t("settings.widget.title")}
        </h3>
        <Button size="sm" onClick={() => navigate("/widgets/new")}>
          {t("settings.widget.createButton")}
        </Button>
      </div>

      {/* Empty state */}
      {widgets.length === 0 && (
        <div className="text-center py-12">
          <h4 className="text-lg font-semibold text-foreground mb-2">
            {t("settings.widget.noWidgets")}
          </h4>
          <p className="text-sm text-muted-foreground mb-4">
            {t("settings.widget.noWidgetsBody")}
          </p>
          <Button size="sm" onClick={() => navigate("/widgets/new")}>
            {t("settings.widget.createButton")}
          </Button>
        </div>
      )}

      {/* Widget card grid */}
      {widgets.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {widgets.map((widget) => (
            <div
              key={widget.id}
              onClick={() => navigate(`/widgets/${widget.id}`)}
              className="bg-card rounded-lg border border-border p-5 hover:border-primary transition-colors cursor-pointer"
              role="button"
              tabIndex={0}
              aria-label={`Edit widget: ${widget.name}`}
              onKeyDown={(e) => {
                if (e.key === "Enter") navigate(`/widgets/${widget.id}`);
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-lg font-semibold text-foreground">
                  {widget.name}
                </span>
                <Badge
                  variant={widget.isActive ? "default" : "outline"}
                  className="text-xs"
                  aria-label={`Status: ${widget.isActive ? t("settings.widget.activeBadge") : t("settings.widget.inactiveBadge")}`}
                >
                  {widget.isActive
                    ? t("settings.widget.activeBadge")
                    : t("settings.widget.inactiveBadge")}
                </Badge>
              </div>

              {widget.workspaces && widget.workspaces.length > 0 && (
                <p className="text-xs text-muted-foreground mb-1">
                  {t("settings.widget.workspacesCount", {
                    count: widget.workspaces.length,
                  })}
                </p>
              )}

              {widget._count?.leads != null && widget._count.leads > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.widget.leadsTab")}: {widget._count.leads}
                </p>
              )}

              <div className="flex gap-3 min-h-[44px] items-center">
                <Button
                  variant="link"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/widgets/${widget.id}`);
                  }}
                >
                  {t("common.edit")}
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setWidgetToDelete(widget);
                  }}
                  className="text-destructive"
                  aria-label={`Delete widget: ${widget.name}`}
                >
                  {t("common.delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        open={!!widgetToDelete}
        onOpenChange={(open) => !open && setWidgetToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.widget.confirmDelete")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setWidgetToDelete(null)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </div>
  );
}