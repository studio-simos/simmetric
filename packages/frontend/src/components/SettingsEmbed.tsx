// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiGet } from "../utils/api";
import { showInfo } from "../lib/toast";
import { useSettingsHelpers } from "../queries/useSettings";
import { resolveWidgetServiceUrl } from "../utils/widgetServiceUrl";

interface ProjectItem { id: string; name: string }
interface WorkspaceItem { id: string; name: string; projectId: string }

export default function SettingsEmbed() {
  const { t } = useTranslation();
  const { getValue } = useSettingsHelpers();
  
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [embedStyle, setEmbedStyle] = useState<"iframe" | "script">("iframe");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiGet<ProjectItem[]>("/projects")
      .then(setProjects)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedProject) { setWorkspaces([]); setSelectedWorkspace(""); return; }
    apiGet<WorkspaceItem[]>("/workspaces")
      .then((data) => {
        setWorkspaces(data.filter((w) => w.projectId === selectedProject));
        setSelectedWorkspace("");
      })
      .catch(() => {});
  }, [selectedProject]);

  // widgetServiceUrl resolution — same-origin by default (the widget is served
  // behind the app origin via reverse proxy); NEVER derived from SERVER_URL
  // (docker-internal hostname → unreachable/mixed-content embed, G-151-1a).
  const widgetServiceUrl = resolveWidgetServiceUrl(
    getValue("WIDGET_SERVICE_URL") || "",
    window.location.origin
  );
  const primaryColor = getValue("BRANDING_PRIMARY_COLOR") || "#973C00";
  const appName = getValue("BRANDING_APP_NAME") || "Simmetric Chat";

  const embedUrl = selectedWorkspace
    ? `${widgetServiceUrl}/widget/${selectedWorkspace}?primaryColor=${encodeURIComponent(primaryColor)}`
    : "";

  const embedCode = selectedWorkspace
    ? embedStyle === "iframe"
      ? `<!-- ${appName} Chat Widget -->\n<iframe\n  src="${embedUrl}"\n  title="${appName}"\n  sandbox="allow-scripts allow-forms"\n  style="position:fixed;bottom:20px;right:20px;width:400px;height:600px;border:none;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.15);z-index:9999;"\n></iframe>`
      : `<!-- ${appName} Chat Widget -->\n<div id="sc-widget" data-widget-id="${selectedWorkspace}" data-primary-color="${primaryColor}" data-position="bottom-right"></div>\n<script src="${widgetServiceUrl}/widget/${selectedWorkspace}.js" data-target="sc-widget"></script>`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    showInfo(t("settings.embed.copied"));
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full space-y-6">
      <h3 className="text-lg font-medium text-foreground">
        {t("settings.embed.title")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t("settings.embed.description")}
      </p>

      <div className="bg-card rounded-lg border border-input p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-1">
            {t("settings.embed.projectLabel")}
          </label>
          <Select
            value={selectedProject || "none"}
            onValueChange={(value) =>
              setSelectedProject(value === "none" ? "" : value)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("settings.embed.selectProject")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t("settings.embed.selectProject")}
              </SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-1">
            {t("settings.embed.workspaceLabel")}
          </label>
          <Select
            value={selectedWorkspace || "none"}
            onValueChange={(value) =>
              setSelectedWorkspace(value === "none" ? "" : value)
            }
            disabled={!selectedProject}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("settings.embed.selectWorkspace")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t("settings.embed.selectWorkspace")}
              </SelectItem>
              {workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-1">
            {t("settings.embed.styleLabel")}
          </label>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="radio"
                name="embedStyle"
                value="iframe"
                checked={embedStyle === "iframe"}
                onChange={() => setEmbedStyle("iframe")}
                className="accent-primary"
              />
              {t("settings.embed.styleIframe")}
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="radio"
                name="embedStyle"
                value="script"
                checked={embedStyle === "script"}
                onChange={() => setEmbedStyle("script")}
                className="accent-primary"
              />
              {t("settings.embed.styleScript")}
            </label>
          </div>
        </div>

        {selectedWorkspace && (
          <div className="pt-2 border-t border-border">
            <p className="text-xs text-secondary-foreground mb-2">
              {embedStyle === "iframe"
                ? t("settings.embed.iframeHint")
                : t("settings.embed.scriptHint")}
            </p>
          </div>
        )}

        {embedCode && (
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              {t("settings.embed.codeLabel")}
            </label>
            <div className="relative">
              <pre className="bg-background border border-input rounded p-4 text-xs text-foreground font-mono overflow-x-auto whitespace-pre-wrap">
                {embedCode}
              </pre>
              <Button
                size="sm"
                onClick={handleCopy}
                className="absolute top-2 right-2 px-3 py-1.5 text-xs font-medium text-white rounded hover:opacity-90 transition-opacity"
              >
                {copied
                  ? t("settings.embed.copiedButton")
                  : t("settings.embed.copyButton")}
              </Button>
            </div>
            <p className="text-xs text-secondary-foreground mt-2">
              {t("settings.embed.pasteHint")}
            </p>

            {embedStyle === "iframe" && (
              <div className="mt-3">
                <label className="block text-sm font-medium text-muted-foreground mb-1">
                  {t("settings.embed.preview")}
                </label>
                <div
                  className="border border-input rounded overflow-hidden"
                  style={{ height: 400, maxWidth: 400 }}
                >
                  <iframe
                    src={embedUrl}
                    title={`${appName} Preview`}
                    sandbox="allow-scripts allow-forms"
                    style={{ width: "100%", height: "100%", border: "none" }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}