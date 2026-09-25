// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useRef, useEffect, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  useMcpConnections,
  useDeleteMcpConnection,
  useToggleMcpConnection,
  useTestMcpConnection,
  useStartMcpOauth,
  useRevokeMcpOauth,
} from "../queries/useMcpConnections";
import { queryKeys } from "../queries/keys";
import { useMe } from "../queries/useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, ChevronDown } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { showSuccess, showError } from "../lib/toast";
import { assignRedirect } from "../lib/redirect";
import McpConnectionForm from "./McpConnectionForm";
import type { McpConnection } from "../queries/useMcpConnections";
import { getErrorMessage } from "../utils/errorUtils";

// 196-03 (UI-SPEC Badge Matrix): "expiring" = tokenExpiresAt within 10
// minutes of now — mirrors the Phase 195 proactive-refresh window (D-12).
const EXPIRING_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Restricted-scope marker for the granted-scope panel warning (D-02): scopes
 * whose provider def carries scopesAreRestricted (google: gmail.readonly
 * today — oauthProviderRegistry.ts:74). Full-URI forms both registries use.
 * Client-side mirror of the server registry's flag (the UI has no registry
 * endpoint; the server's assertScopesGranted remains the enforcement
 * backstop — this only drives the amber warning line).
 */
const RESTRICTED_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export default function SettingsMcpConnections() {
  const { t } = useTranslation();
  const { data: connections = [], isLoading } = useMcpConnections();
  const deleteMutation = useDeleteMcpConnection();
  const toggleMutation = useToggleMcpConnection();
  const testMutation = useTestMcpConnection();
  const startOauthMutation = useStartMcpOauth();
  const revokeOauthMutation = useRevokeMcpOauth();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  // UI-SPEC permission gating: Connect/Reauthorize/Revoke are HIDDEN (not
  // disabled) without mcp:oauth:manage; badges + scope panel stay visible to
  // view-only admins (read endpoints carry no extra permission). The server
  // 403 is the backstop (T-196-13).
  const canManageOauth = (me?.permissions ?? []).includes("mcp:oauth:manage");
  const [searchParams, setSearchParams] = useSearchParams();

  const [editingConnection, setEditingConnection] = useState<McpConnection | null>(null);
  const [creating, setCreating] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpConnection | null>(null);
  // OAuth lifecycle state (196-03): single-flight per row via the mutation's
  // isPending + explicit id stamp; one revoke dialog target; one expanded
  // scope panel at a time (D-02).
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<McpConnection | null>(null);
  const [expandedScopesId, setExpandedScopesId] = useState<string | null>(null);
  const [testState, setTestState] = useState<
    Map<string, { status: "testing" | "success" | "error"; toolCount?: number; error?: string }>
  >(new Map());

  const testTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleToggle = async (conn: McpConnection) => {
    setTogglingId(conn.id);
    try {
      await toggleMutation.mutateAsync({ id: conn.id, enabled: !conn.enabled });
      showSuccess(
        t("settings.mcpConnections.toggleSuccess", {
          status: !conn.enabled ? "enabled" : "disabled",
        })
      );
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.mcpConnections.toggleFailed")));
    } finally {
      setTogglingId(null);
    }
  };

  const handleTest = async (conn: McpConnection) => {
    // Clear any existing timeout for this connection
    const existingTimeout = testTimeoutRef.current.get(conn.id);
    if (existingTimeout) clearTimeout(existingTimeout);

    setTestState((prev) => {
      const next = new Map(prev);
      next.set(conn.id, { status: "testing" });
      return next;
    });

    try {
      const result = await testMutation.mutateAsync(conn.id);
      if (!result.success) {
        const rawError = result.error || "";
        const isNetworkError = /ENOTFOUND|ECONNREFUSED|fetch failed/i.test(rawError);
        const friendlyError = isNetworkError
          ? "Server unreachable. Check URL and try again."
          : rawError;
        showError(friendlyError);
        setTestState((prev) => {
          const next = new Map(prev);
          next.set(conn.id, { status: "error", error: friendlyError });
          return next;
        });
      } else {
        setTestState((prev) => {
          const next = new Map(prev);
          next.set(conn.id, {
            status: "success",
            toolCount: result.toolCount,
          });
          return next;
        });
      }
    } catch (err: unknown) {
      const rawMessage = getErrorMessage(err, "");
      const isNetworkError = /ENOTFOUND|ECONNREFUSED|fetch failed/i.test(rawMessage);
      const friendlyError = isNetworkError
        ? "Server unreachable. Check URL and try again."
        : rawMessage;
      showError(friendlyError);
      setTestState((prev) => {
        const next = new Map(prev);
        next.set(conn.id, { status: "error", error: friendlyError });
        return next;
      });
    }

    // Auto-clear after 5 seconds
    const timeout = setTimeout(() => {
      setTestState((prev) => {
        const next = new Map(prev);
        next.delete(conn.id);
        return next;
      });
      testTimeoutRef.current.delete(conn.id);
    }, 5000);
    testTimeoutRef.current.set(conn.id, timeout);
  };

  const handleDelete = (conn: McpConnection) => {
    setDeleteTarget(conn);
  };

  /* ---------------------------------------------------------------- */
  /*  OAuth lifecycle (196-03 — MCPO-02, D-03)                         */
  /* ---------------------------------------------------------------- */

  /**
   * Connect / Reauthorize handler (D-03): POST oauth/start → full-page
   * redirect to the provider authorizeUrl (window.location.assign via
   * lib/redirect — never a popup or new window). NEVER a secondary browser
   * context — the URL is an absolute provider URL, deliberately not
   * useNavigate. Busy state (disabled + pending label) is single-flight per
   * row: a second click cannot fire a second oauth/start before the first
   * resolves (MCPO-02 concurrency edge). On error → oauth.connectFailed
   * toast, button re-enables, row state unchanged.
   */
  const handleConnect = async (conn: McpConnection) => {
    if (connectingId !== null) return; // one pending authorization at a time
    setConnectingId(conn.id);
    try {
      const data = await startOauthMutation.mutateAsync(conn.id);
      assignRedirect(data.authorizeUrl);
    } catch {
      // Locked i18n copy (UI-SPEC error state row) — never surface raw
      // provider/server prose from the start failure.
      showError(t("settings.mcpConnections.oauth.connectFailed"));
    } finally {
      setConnectingId(null);
    }
  };

  /**
   * Revoke handler (D-03c): DELETE oauth behind the confirm AlertDialog —
   * this runs only after the dialog's destructive action. Success →
   * oauth.revoked toast; list invalidation (hook) flips the badge to "Not
   * connected" on refetch.
   */
  const handleConfirmRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await revokeOauthMutation.mutateAsync(revokeTarget.id);
      showSuccess(t("settings.mcpConnections.oauth.revoked"));
    } catch {
      // Same locked-copy posture as the connect error arm (UI-SPEC error row).
      showError(t("settings.mcpConnections.oauth.connectFailed"));
    } finally {
      setRevokeTarget(null);
    }
  };

  /**
   * ?oauth= return handler (D-03 / UI-SPEC Connect flow step 5): the provider
   * redirects back with ?oauth=<authorized|error> (195 D-09 contract). The
   * param drives ONLY a toast + refetch — never an auth decision (T-196-12).
   * Stripped immediately via setSearchParams replace so a refresh never
   * double-toasts; actual badge state comes from the invalidated list query
   * (server truth).
   */
  useEffect(() => {
    const oauthParam = searchParams.get("oauth");
    if (!oauthParam) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.mcpConnections.list });
    if (oauthParam === "authorized") {
      // Provider label from the refetched rows is not reliably available at
      // effect time — resolve it best-effort from the list for the toast.
      const provider = connections.find(
        (c) => c.authType === "oauth" && c.oauthProvider
      )?.oauthProvider;
      showSuccess(
        t("settings.mcpConnections.oauth.returnSuccess", {
          provider: provider ?? t("settings.mcpConnections.title"),
        })
      );
    } else {
      showError(t("settings.mcpConnections.oauth.returnError"));
    }
    // Strip the param (replaceState semantics — SettingsPage deep-link
    // analog at SettingsPage.tsx:569-584): refresh never double-toasts.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("oauth");
        return next;
      },
      { replace: true }
    );
  }, [searchParams, queryClient, setSearchParams, t, connections]);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      showSuccess(t("settings.mcpConnections.deleteSuccess"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.mcpConnections.deleteFailed")));
    } finally {
      setDeleteTarget(null);
    }
  };

  const StatusDot = ({ status }: { status?: string }) => {
    if (status === "connected") {
      return (
        <span className="flex items-center text-secondary-foreground">
          <span className="w-2 h-2 rounded-full inline-block mr-2 bg-green-500" />
          {t("settings.mcpConnections.statusConnected")}
        </span>
      );
    }
    if (status === "error") {
      return (
        <span className="flex items-center text-destructive-foreground">
          <span className="w-2 h-2 rounded-full inline-block mr-2 bg-red-500" />
          {t("settings.mcpConnections.statusError")}
        </span>
      );
    }
    return (
      <span className="flex items-center text-secondary-foreground">
        <span className="w-2 h-2 rounded-full inline-block mr-2 bg-gray-400" />
        {t("settings.mcpConnections.statusDisconnected")}
      </span>
    );
  };

  const TestBadge = ({ conn }: { conn: McpConnection }) => {
    const state = testState.get(conn.id);
    if (!state) return null;

    if (state.status === "testing") {
      return (
        <span className="text-xs text-muted-foreground ml-2">
          {t("settings.mcpConnections.testing")}
        </span>
      );
    }
    if (state.status === "success") {
      return (
        <span className="text-xs text-secondary-foreground ml-2">
          {t("settings.mcpConnections.testSuccess", { count: state.toolCount || 0 })}
        </span>
      );
    }
    return (
      <span className="text-xs text-destructive-foreground ml-2">
        {t("settings.mcpConnections.testFailed", { error: state.error || "" })}
      </span>
    );
  };

  /**
   * OAuth badge — 196-03 UI-SPEC Badge Matrix (D-02). A TOTAL function of
   * (authType, oauthStatus, tokenExpiresAt): each data state maps to exactly
   * one deterministic badge variant; authType "none" renders NO badge at all
   * (legacy rows stay visually clean — MCPU-01 empty edge). State is conveyed
   * through text + symbol + color (never color alone); aria-label carries the
   * full meaning. Renders from sanitized fields only (T-196-11) — the UI
   * never decodes tokens.
   */
  const OauthBadge = ({ conn }: { conn: McpConnection }) => {
    const authType = conn.authType ?? "none";
    const oauthStatus = conn.oauthStatus ?? "none";

    if (authType === "none") return null;

    if (authType === "static") {
      return (
        <Badge
          variant="outline"
          aria-label={t("settings.mcpConnections.oauth.badgeStatic")}
        >
          {t("settings.mcpConnections.oauth.badgeStatic")}
        </Badge>
      );
    }

    // authType === "oauth" — the 6 oauth matrix states.
    if (oauthStatus === "pending") {
      return (
        <Badge
          className="bg-gray-500/10 text-muted-foreground"
          aria-label={t("settings.mcpConnections.oauth.pending")}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse mr-1" />
          {t("settings.mcpConnections.oauth.pending")}
        </Badge>
      );
    }

    if (oauthStatus === "error") {
      // Tooltip reads the sanitized oauthErrorSummary (plan 01 D-03a) with
      // the generic-copy fallback (D-03 fail-safe default).
      const summary = conn.oauthErrorSummary;
      const tooltipText = summary
        ? t("settings.mcpConnections.oauth.errorSummary", { summary })
        : t("settings.mcpConnections.oauth.errorGeneric");
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              className="bg-destructive/10 text-destructive"
              aria-label={t("settings.mcpConnections.oauth.badgeOauthError")}
            >
              {t("settings.mcpConnections.oauth.badgeOauthError")}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-[40ch] whitespace-normal">
            {tooltipText}
          </TooltipContent>
        </Tooltip>
      );
    }

    if (oauthStatus === "authorized") {
      // "Expiring" = tokenExpiresAt within 10 minutes of now (195 D-12).
      // Absent tokenExpiresAt + authorized ⇒ ✓ without expiry text.
      const expiresMs = conn.tokenExpiresAt
        ? new Date(conn.tokenExpiresAt).getTime()
        : null;
      const isExpiring =
        expiresMs !== null && expiresMs - Date.now() <= EXPIRING_THRESHOLD_MS;

      if (expiresMs !== null && isExpiring) {
        const time = formatExpiryTime(expiresMs - Date.now());
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                className="bg-amber-500/10 text-amber-700 dark:text-amber-400"
                aria-label={t("settings.mcpConnections.oauth.badgeOauthExpiring", { time })}
              >
                {t("settings.mcpConnections.oauth.badgeOauthExpiring", { time })}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-[40ch] whitespace-normal">
              {t("settings.mcpConnections.oauth.expiresAt", {
                time: formatExpiryTime(expiresMs - Date.now()),
              })}
            </TooltipContent>
          </Tooltip>
        );
      }

      const expiresTooltip =
        expiresMs !== null
          ? t("settings.mcpConnections.oauth.expiresAt", {
              time: formatExpiryTime(expiresMs - Date.now()),
            })
          : null;
      const badge = (
        <Badge
          className="bg-green-500/10 text-green-700 dark:text-green-400"
          aria-label={
            expiresTooltip
              ? `${t("settings.mcpConnections.oauth.badgeOauthOk")} — ${expiresTooltip}`
              : t("settings.mcpConnections.oauth.badgeOauthOk")
          }
        >
          {t("settings.mcpConnections.oauth.badgeOauthOk")}
        </Badge>
      );
      return expiresTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent className="max-w-[40ch] whitespace-normal">
            {expiresTooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        badge
      );
    }

    // oauthStatus === "none" — gray-muted tint, no tooltip.
    return (
      <Badge
        className="bg-gray-500/10 text-muted-foreground"
        aria-label={t("settings.mcpConnections.oauth.badgeOauthNone")}
      >
        {t("settings.mcpConnections.oauth.badgeOauthNone")}
      </Badge>
    );
  };

  /** Bounded relative-time helper for badge/tooltip copy (≤ ~20ch in every
   * locale — the long-text backstop test pins the bound). */
  const formatExpiryTime = (msUntil: number): string => {
    const minutes = Math.max(0, Math.round(msUntil / 60000));
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      return t("settings.mcpConnections.oauth.inHours", { count: hours });
    }
    return t("settings.mcpConnections.oauth.inMinutes", { count: minutes });
  };

  /**
   * Granted-scope panel (D-02): trigger link in the status cell (authorized
   * rows with non-empty oauthScopes only) expanding a Collapsible row
   * beneath the connection row. NOTE per plan: oauthScopes is the REQUESTED
   * scope set (the registry-reduced list requested at connect time — the CAS
   * arm in mcpOAuthCallback.ts does not write back the granted set); the
   * locked UI-SPEC label copy stays "Granted scopes", and the actual grant
   * is enforced server-side by assertScopesGranted — do not "correct" the
   * label to "Requested scopes".
   */
  const ScopePanel = ({ conn }: { conn: McpConnection }) => {
    const scopes = (conn.oauthScopes ?? "").split(/\s+/).filter(Boolean);
    if ((conn.oauthStatus ?? "none") !== "authorized" || scopes.length === 0) {
      return null;
    }
    const isOpen = expandedScopesId === conn.id;
    // Restricted-scope warning when ANY granted scope appears in a provider
    // def carrying scopesAreRestricted (google gmail.readonly today).
    // NOTE: only the TRIGGER renders here — the content lives in the
    // colSpan=6 expanded row (ScopePanelContent) because a CollapsibleContent
    // inside the status cell would duplicate the chips AND table DOM does not
    // allow the panel to span columns from within a cell.
    return (
      <Collapsible open={isOpen} onOpenChange={(open) => setExpandedScopesId(open ? conn.id : null)}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-expanded={isOpen}
          >
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
            />
            {t("settings.mcpConnections.oauth.scopesGranted", { count: scopes.length })}
          </button>
        </CollapsibleTrigger>
      </Collapsible>
    );
  };

  /** Expanded-row content for the granted-scope panel (D-02) — rendered in
   * the TableCell colSpan=6 row beneath the connection row. Chips wrap with
   * flex-wrap + break-all on URIs; restrictedScopeWarning line carries the
   * 16px amber AlertTriangle. Same requested-scopes note as ScopePanel. */
  const ScopePanelContent = ({ conn }: { conn: McpConnection }) => {
    const scopes = (conn.oauthScopes ?? "").split(/\s+/).filter(Boolean);
    const hasRestricted = scopes.some((s) => RESTRICTED_SCOPES.includes(s));
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1" data-testid={`scope-chips-${conn.id}`}>
          {scopes.map((scope) => (
            <span
              key={scope}
              className="inline-block text-xs font-medium bg-secondary text-secondary-foreground rounded-4xl px-2 py-0.5 break-all"
            >
              {scope}
            </span>
          ))}
        </div>
        {hasRestricted && (
          <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {t("settings.mcpConnections.oauth.restrictedScopeWarning", {
              provider: conn.oauthProvider ?? "",
            })}
          </p>
        )}
      </div>
    );
  };

  /** Primary lifecycle action per row — exactly ONE shows at a time
   * (MCPO-02/MCPU-01 ordering edge): Connect for oauthStatus none|pending,
   * Reauthorize for authorized|error (error rows show Reauthorize — the
   * recovery CTA). WR-03: pending rows are connectable — the admin closed
   * the browser mid-authorize (or the IdP never called back) and only
   * Revoke remained, which is undiscoverable and semantically wrong
   * (nothing to revoke). The server's POST oauth/start has no status
   * precondition and a re-start mints a fresh nonce/verifier pair (the
   * state service is single-use per nonce — a second start cannot poison
   * the first), so re-starting a pending row is a supported operation the
   * UI now offers. Hidden entirely without mcp:oauth:manage (not disabled —
   * UI-SPEC permission gating, T-196-13). Busy state disables + shows the
   * pending copy immediately (single-flight, MCPO-02 concurrency edge). */
  const oauthLifecycleAction = (conn: McpConnection) => {
    if (!canManageOauth) return null;
    const authType = conn.authType ?? "none";
    const oauthStatus = conn.oauthStatus ?? "none";
    if (authType !== "oauth") return null;

    const isConnect = oauthStatus === "none" || oauthStatus === "pending";
    const isReauthorize = oauthStatus === "authorized" || oauthStatus === "error";
    if (!isConnect && !isReauthorize) return null;

    const isBusy = connectingId === conn.id;
    return (
      <Button
        variant="link"
        size="sm"
        className="text-primary"
        onClick={() => handleConnect(conn)}
        disabled={isBusy}
        aria-disabled={isBusy}
        aria-busy={isBusy}
      >
        {isBusy
          ? t("settings.mcpConnections.oauth.pending")
          : isConnect
            ? t("settings.mcpConnections.oauth.connect", { provider: conn.oauthProvider ?? "" })
            : t("settings.mcpConnections.oauth.reauthorize")}
      </Button>
    );
  };

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">
          {t("settings.mcpConnections.title")}
        </h3>
        <Button size="sm" onClick={() => setCreating(true)}>
          {t("settings.mcpConnections.createButton")}
        </Button>
      </div>

      {/* Table */}
      <div className="bg-card rounded-lg border border-input overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-input text-left text-muted-foreground">
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colName")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colUrl")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colTransport")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colStatus")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colEnabled")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colActions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((conn) => (
              <Fragment key={conn.id}>
                <TableRow
                  className="border-b border-input hover:bg-accent"
                >
                  <TableCell className="px-5 py-3 text-foreground">
                    {conn.name}
                  </TableCell>
                  <TableCell className="px-5 py-3 text-muted-foreground text-xs max-w-[200px] truncate">
                    {conn.url}
                  </TableCell>
                  <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                    {conn.transportType}
                  </TableCell>
                  <TableCell className="px-5 py-3">
                    {/* D-02: StatusDot keeps live connectivity (its own state
                        machine); the OAuth badge renders beneath it in the
                        SAME cell — two independent states never merge. */}
                    <div className="space-y-2">
                      <StatusDot status={conn.liveStatus} />
                      <div>
                        <OauthBadge conn={conn} />
                        <ScopePanel conn={conn} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-5 py-3">
                    {togglingId === conn.id ? (
                      <span className="text-xs text-muted-foreground">...</span>
                    ) : (
                      <Switch
                        checked={conn.enabled}
                        onCheckedChange={() => handleToggle(conn)}
                        disabled={togglingId === conn.id}
                        aria-label={t("settings.mcpConnections.enabledLabel")}
                      />
                    )}
                  </TableCell>
                  <TableCell className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => handleTest(conn)}
                        disabled={testState.get(conn.id)?.status === "testing"}
                      >
                        {t("settings.mcpConnections.test")}
                      </Button>
                      <TestBadge conn={conn} />
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => setEditingConnection(conn)}
                      >
                        {t("common.edit")}
                      </Button>
                      {oauthLifecycleAction(conn)}
                      {(conn.oauthStatus ?? "none") !== "none" &&
                        conn.authType === "oauth" &&
                        canManageOauth && (
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() => setRevokeTarget(conn)}
                            className="text-destructive-foreground"
                          >
                            {t("settings.mcpConnections.oauth.revoke")}
                          </Button>
                        )}
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => handleDelete(conn)}
                        className="text-destructive-foreground"
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {/* Expanded scope-panel row (D-02) — one row expanded at a
                    time via expandedScopesId; colSpan=6 spans the table. */}
                {expandedScopesId === conn.id && (
                  <TableRow className="border-b border-input">
                    <TableCell colSpan={6} className="px-5 pb-4">
                      <ScopePanelContent conn={conn} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {connections.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="px-5 py-8 text-center">
                  <p className="text-lg font-semibold text-foreground mb-2">
                    {t("settings.mcpConnections.noConnections")}
                  </p>
                  <p className="text-sm text-muted-foreground mb-4">
                    {t("settings.mcpConnections.noConnectionsBody")}
                  </p>
                  <Button size="sm" onClick={() => setCreating(true)}>
                    {t("settings.mcpConnections.createButton")}
                  </Button>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {isLoading && connections.length === 0 && (
          <div className="text-center py-8 text-secondary-foreground text-sm">
            {t("common.loading")}
          </div>
        )}
      </div>

      {/* Delete Confirmation AlertDialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.mcpConnections.deleteConfirmTitle", {
                defaultValue: "Delete MCP Connection",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.mcpConnections.deleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke OAuth Confirmation AlertDialog (196-03 D-03c) — locked
          revokeConfirmTitle/revokeConfirmBody copy, destructive styling
          identical to the delete confirm. */}
      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.mcpConnections.oauth.revokeConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.mcpConnections.oauth.revokeConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmRevoke}
            >
              {t("settings.mcpConnections.oauth.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog */}
      <Dialog
        open={creating || !!editingConnection}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditingConnection(null);
          }
        }}
      >
        <DialogContent className="max-w-[640px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingConnection
                ? t("settings.mcpConnections.edit")
                : t("settings.mcpConnections.title")}
            </DialogTitle>
          </DialogHeader>
          <McpConnectionForm
            connection={editingConnection}
            onClose={() => {
              setCreating(false);
              setEditingConnection(null);
            }}
            onSave={() => {
              setCreating(false);
              setEditingConnection(null);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
