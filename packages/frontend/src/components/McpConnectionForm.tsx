// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { apiGet } from "../utils/api";
import {
  useCreateMcpConnection,
  useUpdateMcpConnection,
} from "../queries/useMcpConnections";
import { showSuccess, showError } from "../lib/toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import type { McpConnection, McpConnectionCreateInput, McpConnectionUpdateInput } from "../queries/useMcpConnections";
import { getErrorMessage } from "../utils/errorUtils";
import McpHeadersEditor, {
  type HeaderRow,
  headersToRows,
  rowsToHeaders,
} from "./McpHeadersEditor";

interface ProjectItem { id: string; name: string }
interface WorkspaceItem { id: string; name: string }

interface McpConnectionFormProps {
  connection?: McpConnection | null;
  onClose: () => void;
  onSave: () => void;
}

interface McpFormValues {
  name: string;
  url: string;
  transportType: "sse" | "streamable-http";
  projectId: string;
  workspaceId: string;
  enabled: boolean;
}

export default function McpConnectionForm({ connection, onClose, onSave }: McpConnectionFormProps) {
  const { t } = useTranslation();
  const createMutation = useCreateMcpConnection();
  const updateMutation = useUpdateMcpConnection();

  const isEdit = !!connection;
  const firstInputRef = useRef<HTMLInputElement>(null);

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [headersError, setHeadersError] = useState("");
  const [scopeError, setScopeError] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => headersToRows(connection?.headers));

  const form = useForm<McpFormValues>({
    defaultValues: {
      name: connection?.name || "",
      url: connection?.url || "",
      transportType: connection?.transportType || "sse",
      // "none" sentinel — the scope selects must be deselectable (exactly one
      // of project/workspace is required; "Nessuno" clears the other side).
      projectId: connection?.projectId || "none",
      workspaceId: connection?.workspaceId || "none",
      enabled: connection?.enabled ?? true,
    },
  });

  // Fetch projects and workspaces on mount
  useEffect(() => {
    apiGet<ProjectItem[]>("/projects").then(setProjects).catch(() => {});
    apiGet<WorkspaceItem[]>("/workspaces").then(setWorkspaces).catch(() => {});
  }, []);

  // Focus first input on mount
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const handleSubmit = form.handleSubmit(async (data) => {
    setHeadersError("");
    setScopeError("");

    // Build + validate headers from rows (skip rows with empty name)
    const { headers: parsedHeaders, error: headerErr } = rowsToHeaders(headerRows);
    if (headerErr) {
      setHeadersError(t(`settings.mcpConnections.${headerErr}`));
      return;
    }
    const finalHeaders = parsedHeaders ?? {};

    // Validate scope mutual exclusivity. "none" sentinel = deselected.
    const hasProject = !!data.projectId && data.projectId !== "none";
    const hasWorkspace = !!data.workspaceId && data.workspaceId !== "none";
    if ((hasProject && hasWorkspace) || (!hasProject && !hasWorkspace)) {
      setScopeError(t("settings.mcpConnections.errorScopeRequired"));
      return;
    }

    if (!data.name.trim() || !data.url.trim()) {
      showError(t("settings.mcpConnections.nameLabel") + " / " + t("settings.mcpConnections.urlLabel") + " required");
      return;
    }

    setSaving(true);
    try {
      if (isEdit && connection) {
        const payload: McpConnectionUpdateInput = {
          name: data.name.trim(),
          url: data.url.trim(),
          transportType: data.transportType,
          projectId: data.projectId === "none" ? undefined : data.projectId,
          workspaceId: data.workspaceId === "none" ? undefined : data.workspaceId,
          headers: finalHeaders,
          enabled: data.enabled,
        };
        await updateMutation.mutateAsync({ id: connection.id, data: payload });
        showSuccess(t("settings.mcpConnections.updateSuccess"));
      } else {
        const payload: McpConnectionCreateInput = {
          name: data.name.trim(),
          url: data.url.trim(),
          transportType: data.transportType,
          projectId: data.projectId === "none" ? undefined : data.projectId,
          workspaceId: data.workspaceId === "none" ? undefined : data.workspaceId,
          headers: finalHeaders,
          enabled: data.enabled,
        };
        await createMutation.mutateAsync(payload);
        showSuccess(t("settings.mcpConnections.createSuccess"));
      }

      onSave();
    } catch (err: unknown) {
      showError(getErrorMessage(err, isEdit ? t("settings.mcpConnections.updateFailed") : t("settings.mcpConnections.createFailed")));
    } finally {
      setSaving(false);
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => {
                const { ref: _fieldRef, ...fieldRest } = field;
                return (
                  <FormItem>
                    <FormLabel>{t("settings.mcpConnections.nameLabel")}</FormLabel>
                    <FormControl>
                      <Input
                        ref={firstInputRef}
                        type="text"
                        placeholder={t("settings.mcpConnections.namePlaceholder")}
                        {...fieldRest}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />

            {/* URL */}
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings.mcpConnections.urlLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder={t("settings.mcpConnections.urlPlaceholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Transport Type */}
            <FormField
              control={form.control}
              name="transportType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings.mcpConnections.transportLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(value) => field.onChange(value)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sse">{t("settings.mcpConnections.transportSse")}</SelectItem>
                        <SelectItem value="streamable-http">{t("settings.mcpConnections.transportStreamableHttp")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Project */}
            <FormField
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings.mcpConnections.projectLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // Mutual exclusivity: picking a project clears the workspace.
                        if (value !== "none") {
                          form.setValue("workspaceId", "none");
                        }
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("settings.mcpConnections.selectProject")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t("settings.mcpConnections.noneOption")}</SelectItem>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Workspace */}
            <FormField
              control={form.control}
              name="workspaceId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings.mcpConnections.workspaceLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // Mutual exclusivity: picking a workspace clears the project.
                        if (value !== "none") {
                          form.setValue("projectId", "none");
                        }
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("settings.mcpConnections.selectWorkspace")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t("settings.mcpConnections.noneOption")}</SelectItem>
                        {workspaces.map((w) => (
                          <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Scope error */}
            {scopeError && (
              <p className="text-sm text-destructive">{scopeError}</p>
            )}

            {/* Headers — structured key/value editor (reusable component) */}
            <McpHeadersEditor
              rows={headerRows}
              onChange={setHeaderRows}
              error={headersError}
            />

            {/* Enabled */}
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2">
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      aria-label={t("settings.mcpConnections.enabledLabel")}
                    />
                  </FormControl>
                  <FormLabel className="!mt-0">{t("settings.mcpConnections.enabledLabel")}</FormLabel>
                </FormItem>
              )}
            />

            {/* Footer */}
            <div className="pt-4 border-t border-border flex gap-2 justify-end">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={onClose}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={saving}
              >
                {saving ? (isEdit ? t("settings.mcpConnections.saving") : t("settings.mcpConnections.creating")) : t("settings.mcpConnections.saveChanges")}
              </Button>
            </div>
      </form>
    </Form>
  );
}
