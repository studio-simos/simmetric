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
  FormDescription,
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

// OAuth providers (registry keys — mirrors the server PROVIDER_DEFAULTS set;
// form-level Select options only, server schema/registry remain authoritative).
const OAUTH_PROVIDER_OPTIONS = ["google", "microsoft"] as const;

type AuthTypeValue = "none" | "static" | "oauth";

interface McpFormValues {
  name: string;
  url: string;
  transportType: "sse" | "streamable-http";
  projectId: string;
  workspaceId: string;
  enabled: boolean;
  // Phase 196 (D-01): auth fields. authType defaults to "none"; oauth fields
  // are hidden+cleared when authType ≠ oauth (mirrors the shared Zod
  // spurious-fields refine).
  authType: AuthTypeValue;
  oauthProvider: string;
  oauthScopes: string;
  oauthClientId: string;
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
  const [oauthProviderError, setOauthProviderError] = useState("");
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
      // Phase 196 (D-01): authType defaults to "none" for new connections;
      // edit mode renders the row's current value (locked, see below).
      authType: (connection?.authType as AuthTypeValue | undefined) ?? "none",
      oauthProvider: connection?.oauthProvider ?? "",
      oauthScopes: connection?.oauthScopes ?? "",
      oauthClientId: "", // create-time-only per the 195 refines — never seeded
    },
  });

  const isOauth = form.watch("authType") === "oauth";
  const authTypeWatched = form.watch("authType");

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
    setOauthProviderError("");

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

    // Phase 196 (D-01): client-side mirror of the shared create refine
    // (mcpConnection.schema.ts:71-73) — authType oauth requires a provider.
    if (data.authType === "oauth" && !data.oauthProvider) {
      setOauthProviderError(t("settings.mcpConnections.oauth.providerRequired"));
      return;
    }
    // Spurious-field arm (schema refines :78-83): oauth fields reset when
    // authType ≠ oauth (the UI also clears them on flip — this is the
    // submit-time backstop).
    const oauthFields =
      data.authType === "oauth"
        ? {
            oauthProvider: data.oauthProvider || undefined,
            oauthScopes: data.oauthScopes.trim() ? data.oauthScopes.trim() : undefined,
            oauthClientId: data.oauthClientId.trim() ? data.oauthClientId.trim() : undefined,
          }
        : {};

    setSaving(true);
    try {
      if (isEdit && connection) {
        // CR-02: an EMPTY headers editor must never translate into a
        // destructive `headers: {}` PUT. Omitting the key means the server
        // keeps the row's stored headers (the update refine treats an
        // absent field as "keep current value") — this protects oauth rows
        // (whose headers editor is hidden) and any edit where the admin
        // only changes the name. An explicit header-removal still works:
        // rowsToHeaders returns {} only when the admin deleted every row of
        // a static row's editor — a static row's editor is seeded from the
        // fetched headers (re-exposed on /statuses), so a genuinely emptied
        // editor IS the admin's intent and {} is sent deliberately.
        const headersPayload: Record<string, string> | undefined =
          Object.keys(finalHeaders).length > 0 ? finalHeaders : undefined;
        const payload: McpConnectionUpdateInput = {
          name: data.name.trim(),
          url: data.url.trim(),
          transportType: data.transportType,
          projectId: data.projectId === "none" ? undefined : data.projectId,
          workspaceId: data.workspaceId === "none" ? undefined : data.workspaceId,
          headers: headersPayload,
          enabled: data.enabled,
          // Edit mode NEVER sends authType/oauthProvider/oauthClientId — the
          // 195 update refine treats an absent authType as "row keeps its
          // current value", and oauthClientId is create-time-only. The UI
          // locks these fields (see render below), so they cannot change.
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
          // Create includes the oauth fields ONLY when authType=oauth — the
          // shared create refine rejects spurious oauth fields otherwise.
          ...(data.authType === "oauth" ? { authType: "oauth" as const, ...oauthFields } : {}),
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
                        data-testid="mcp-name-input"
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
                      data-testid="mcp-url-input"
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
                      <SelectTrigger className="w-full" data-testid="transport-select-trigger">
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
                      <SelectTrigger className="w-full" data-testid="project-select-trigger">
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
                      <SelectTrigger className="w-full" data-testid="workspace-select-trigger">
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

            {/* Authentication (Phase 196 D-01) — above the headers editor.
                Edit mode LOCKS authType + oauthProvider (disabled Selects +
                lockedHint); oauthClientId is create-time-only. */}
            <FormField
              control={form.control}
              name="authType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings.mcpConnections.oauth.authTypeLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value as AuthTypeValue);
                        // Spurious-field reset on flip away from oauth (the
                        // shared refine rejects oauth fields on non-oauth).
                        if (value !== "oauth") {
                          form.setValue("oauthProvider", "");
                          form.setValue("oauthScopes", "");
                          form.setValue("oauthClientId", "");
                          setOauthProviderError("");
                        }
                      }}
                      disabled={isEdit}
                    >
                      <SelectTrigger
                        className="w-full"
                        data-testid="authtype-select-trigger"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t("settings.mcpConnections.oauth.authTypeNone")}</SelectItem>
                        <SelectItem value="static">{t("settings.mcpConnections.oauth.authTypeStatic")}</SelectItem>
                        <SelectItem value="oauth">{t("settings.mcpConnections.oauth.authTypeOauth")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  {isEdit && (
                    <FormDescription>
                      {t("settings.mcpConnections.oauth.lockedHint")}
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* OAuth provider + scopes + clientId — revealed when authType=oauth */}
            {isOauth && (
              <>
                <FormField
                  control={form.control}
                  name="oauthProvider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("settings.mcpConnections.oauth.providerLabel")}</FormLabel>
                      <FormControl>
                        <Select
                          value={field.value || undefined}
                          onValueChange={(value) => {
                            field.onChange(value);
                            setOauthProviderError("");
                          }}
                          disabled={isEdit}
                        >
                          <SelectTrigger
                            className="w-full"
                            data-testid="oauth-provider-select-trigger"
                          >
                            <SelectValue
                              placeholder={t("settings.mcpConnections.oauth.providerLabel")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {OAUTH_PROVIDER_OPTIONS.map((p) => (
                              <SelectItem key={p} value={p}>
                                {p}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      {isEdit && (
                        <FormDescription>
                          {t("settings.mcpConnections.oauth.lockedHint")}
                        </FormDescription>
                      )}
                      {oauthProviderError && (
                        <p className="text-sm text-destructive">{oauthProviderError}</p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="oauthScopes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("settings.mcpConnections.oauth.scopesLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          data-testid="mcp-oauth-scopes-input"
                          placeholder="https://www.googleapis.com/auth/drive.readonly"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        {t("settings.mcpConnections.oauth.scopesHint")}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Create-time-only per the 195 refines — never rendered in
                    edit mode. Dormant column (195 D-06): persisted so provider
                    config is complete when core wires it; NOT consumed by the
                    v1 oauth/start flow. */}
                {!isEdit && (
                  <FormField
                    control={form.control}
                    name="oauthClientId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("settings.mcpConnections.oauth.clientIdLabel")}</FormLabel>
                        <FormControl>
                          <Input
                            type="text"
                            data-testid="mcp-oauth-clientid-input"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </>
            )}

            {/* Headers — structured key/value editor (reusable component).
                Visible ONLY for authType static (196 D-01/UI-SPEC: custom
                headers are not the auth mechanism for oauth connections);
                the staticHeadersHint line replaces it when hidden. */}
            {authTypeWatched === "static" ? (
              <div data-testid="mcp-headers-editor">
                <McpHeadersEditor
                  rows={headerRows}
                  onChange={setHeaderRows}
                  error={headersError}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="static-headers-hint">
                {t("settings.mcpConnections.oauth.staticHeadersHint")}
              </p>
            )}

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
                data-testid="mcp-submit"
                disabled={saving}
              >
                {saving ? (isEdit ? t("settings.mcpConnections.saving") : t("settings.mcpConnections.creating")) : t("settings.mcpConnections.saveChanges")}
              </Button>
            </div>
      </form>
    </Form>
  );
}
