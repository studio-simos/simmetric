// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 199 (199-02, ECCO-05) — "Connettori" admin panel (Settings
 * sub-section, D-08). Card list per the approved UI-SPEC (A-1: card grid,
 * NOT the MCP table): platform card list with health badges, create dialog
 * (ONE form with inline Validate — not a wizard, D-09), Telegram-only
 * polling/webhook controls (D-06), test-message dialog, enable/disable
 * toggle, delete confirm.
 *
 * Permission gating (196-03 useMe() seam): sub-section visibility keys on
 * connector:view; every action affordance keys individually on
 * connector:manage — HIDDEN, not disabled (the server 403 is the backstop,
 * T-199-06).
 *
 * Secret discipline (T-199-05): the bot token input is create-only
 * type="password" with a show/hide toggle; it is never pre-filled or echoed
 * — the UI consumes only the secrets-stripped serialized row.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiGet } from "../utils/api";
import {
  useConnectors,
  useCreateConnector,
  useToggleConnector,
  useDeleteConnector,
  useValidateConnectorToken,
  useWebhookSetup,
  useWebhookRemove,
  useTestConnector,
  useOauthProviders,
  useStartConnectorOauth,
  type Connector,
  type ConnectorPlatform,
} from "../queries/useConnectors";
import { useMe } from "../queries/useAuth";
import { assignRedirect } from "../lib/redirect";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MessageCircle,
  MessagesSquare,
  Hash,
  Phone,
  MoreHorizontal,
  Eye,
  EyeOff,
  CheckCircle2,
} from "lucide-react";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

/** Platform glyph map (UI-SPEC A-3): generic lucide icons, no brand-icon
 * package; forward-compatible slots for Phase 200 (slack → Hash,
 * whatsapp → Phone). Rendered text-muted-foreground — no per-platform
 * brand colors in v1. */
export const PLATFORM_GLYPHS: Record<ConnectorPlatform, typeof MessageCircle> = {
  telegram: MessageCircle,
  discord: MessagesSquare,
  slack: Hash,
  whatsapp: Phone,
};

const PLATFORM_OPTIONS: ConnectorPlatform[] = ["telegram", "discord", "slack", "whatsapp"];
/** Phase 200 (ECCO-06) — all four platforms flip live: slack/whatsapp render
 * as enabled Select options (the disabled/platformComingSoon branch stops
 * firing for them; the key itself is retained in all 8 locales — UI-SPEC
 * A-2, dead-but-retained). The platform-conditional create fields below are
 * the reason the unlock is usable: slack requires a signing secret,
 * whatsapp requires phone number ID + app secret + verify token at create
 * time (D-03/D-06/D-07 — a bare unlock would ship unusable connectors). */
const IMPLEMENTED_PLATFORMS: ConnectorPlatform[] = ["telegram", "discord", "slack", "whatsapp"];
const ALL_LOCALES = ["en", "it", "ru", "de", "es", "fr", "zh", "pt"];

interface WorkspaceOption {
  id: string;
  name: string;
}

interface ArchiveOption {
  id: string;
  name: string;
}

export default function SettingsConnectors() {
  const { t } = useTranslation();
  const { data: connectors = [], isLoading } = useConnectors();
  const createMutation = useCreateConnector();
  const toggleMutation = useToggleConnector();
  const deleteMutation = useDeleteConnector();
  const validateMutation = useValidateConnectorToken();
  const webhookSetupMutation = useWebhookSetup();
  const webhookRemoveMutation = useWebhookRemove();
  const testMutation = useTestConnector();
  const { data: me } = useMe();

  // Sub-section visibility gate (D-08): the component renders from the menu
  // deep-link path too, so it re-checks connector:view itself — the same
  // double-gate shape SettingsMcpConnections uses. Users without
  // connector:view see neither panel nor menu voice. The gate renders null
  // AFTER the hook block (rules-of-hooks: no early return before useState).
  const canView = (me?.permissions ?? []).includes("connector:view");
  // Every action affordance keys individually on connector:manage — hidden,
  // not disabled (UI-SPEC permission gating; server 403 is the backstop).
  const canManage = (me?.permissions ?? []).includes("connector:manage");

  const [creating, setCreating] = useState(false);
  // Single-flight toggle state (the MCP pattern): one in-flight toggle at a
  // time; the row's Switch disables + aria-busy while pending.
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Connector | null>(null);
  const [testTarget, setTestTarget] = useState<Connector | null>(null);
  const [testPlatformUserId, setTestPlatformUserId] = useState("");
  const [testing, setTesting] = useState(false);
  // Webhook setup mini-dialog state (telegram rows only).
  const [webhookTarget, setWebhookTarget] = useState<Connector | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookUrlError, setWebhookUrlError] = useState("");
  const [webhookBusy, setWebhookBusy] = useState(false);
  // Phase 200 (D-05): the Connect-with-Slack visibility signal + the
  // create-then-connect OAuth arm.
  const { data: oauthProviders = [] } = useOauthProviders();
  const startOauthMutation = useStartConnectorOauth();
  const [connecting, setConnecting] = useState(false);

  /* ---------------- create dialog state ---------------- */

  const [platform, setPlatform] = useState<ConnectorPlatform | "">("");
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  // Phase 200 (ECCO-06, UI-SPEC contract 2): platform-conditional create
  // fields — a total function of the selected platform. Selecting a
  // platform clears the other platforms' values (no orphan submission) and
  // resets the inline Validate state (existing behavior).
  const [signingSecret, setSigningSecret] = useState("");
  const [showSigningSecret, setShowSigningSecret] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showAppSecret, setShowAppSecret] = useState(false);
  const [verifyToken, setVerifyToken] = useState("");
  const [showVerifyToken, setShowVerifyToken] = useState(false);
  const [whatsappBusinessAccountId, setWhatsappBusinessAccountId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [archiveId, setArchiveId] = useState("none");
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [fallbackMessage, setFallbackMessage] = useState("");
  const [fallbackLocale, setFallbackLocale] = useState("en");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [archives, setArchives] = useState<ArchiveOption[]>([]);
  const [formErrors, setFormErrors] = useState<{ platform?: string; name?: string; token?: string; workspace?: string; signingSecret?: string; phoneNumberId?: string; appSecret?: string; verifyToken?: string }>({});
  const [validateState, setValidateState] = useState<
    { status: "idle" | "validating" | "ok" | "failed"; botUsername?: string | null; error?: string }
  >({ status: "idle" });
  const [saving, setSaving] = useState(false);

  const resetCreateForm = () => {
    setPlatform("");
    setName("");
    setBotToken("");
    setShowToken(false);
    setSigningSecret("");
    setShowSigningSecret(false);
    setPhoneNumberId("");
    setAppSecret("");
    setShowAppSecret(false);
    setVerifyToken("");
    setShowVerifyToken(false);
    setWhatsappBusinessAccountId("");
    setWorkspaceId("");
    setArchiveId("none");
    setWelcomeMessage("");
    setFallbackMessage("");
    setFallbackLocale("en");
    setFormErrors({});
    setValidateState({ status: "idle" });
    setConnectWithSlackArmed(false);
  };

  const openCreate = () => {
    resetCreateForm();
    // Org-scoped workspace + archive option lists for the two Selects
    // (McpConnectionForm mount-fetch idiom; failures leave empty lists —
    // the required-workspace validation still blocks submit).
    apiGet<WorkspaceOption[]>("/workspaces").then(setWorkspaces).catch(() => {});
    apiGet<ArchiveOption[]>("/archives").then(setArchives).catch(() => {});
    setCreating(true);
  };

  const closeCreate = () => {
    setCreating(false);
    resetCreateForm();
  };

  /* ---------------- handlers ---------------- */

  const handleToggle = async (conn: Connector) => {
    setTogglingId(conn.id);
    try {
      await toggleMutation.mutateAsync({ id: conn.id, isEnabled: !conn.isEnabled });
      showSuccess(
        t("settings.connectors.toggleSuccess", {
          status: !conn.isEnabled ? t("settings.connectors.enabledWord") : t("settings.connectors.disabledWord"),
        })
      );
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.connectors.toggleFailed")));
    } finally {
      setTogglingId(null);
    }
  };

  const handleValidate = async () => {
    if (!platform || !botToken.trim()) {
      setValidateState({ status: "failed", error: !platform ? t("settings.connectors.errorPlatformRequired") : t("settings.connectors.errorTokenRequired") });
      return;
    }
    // A-7: the whatsapp probe needs the Phone Number ID — the platform's
    // required fields must be non-empty before the request fires
    // (telegram/discord keep the platform+token-only condition unchanged).
    if (platform === "slack" && !signingSecret.trim()) {
      setValidateState({ status: "failed", error: t("settings.connectors.errorSigningSecretRequired") });
      return;
    }
    if (platform === "whatsapp" && (!phoneNumberId.trim() || !appSecret.trim() || !verifyToken.trim())) {
      setValidateState({
        status: "failed",
        error: !phoneNumberId.trim()
          ? t("settings.connectors.errorPhoneNumberIdRequired")
          : !appSecret.trim()
            ? t("settings.connectors.errorAppSecretRequired")
            : t("settings.connectors.errorVerifyTokenRequired"),
      });
      return;
    }
    setValidateState({ status: "validating" });
    try {
      const result = await validateMutation.mutateAsync({
        platform,
        botToken: botToken.trim(),
        ...(platform === "slack" && signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {}),
        ...(platform === "whatsapp" && phoneNumberId.trim() ? { phoneNumberId: phoneNumberId.trim() } : {}),
        ...(platform === "whatsapp" && appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        ...(platform === "whatsapp" && verifyToken.trim() ? { verifyToken: verifyToken.trim() } : {}),
        ...(platform === "whatsapp" && whatsappBusinessAccountId.trim() ? { whatsappBusinessAccountId: whatsappBusinessAccountId.trim() } : {}),
      });
      if (result.valid) {
        setValidateState({ status: "ok", botUsername: result.botUsername ?? "" });
      } else {
        setValidateState({ status: "failed", error: t("settings.connectors.errorGeneric") });
      }
    } catch (err: unknown) {
      setValidateState({ status: "failed", error: getErrorMessage(err, t("settings.connectors.errorGeneric")) });
    }
  };

  /** A-7: the Validate button's disabled condition — whatsapp requires the
   * platform's required fields non-empty (the probe needs the Phone Number
   * ID); slack requires the signing secret; telegram/discord keep the
   * platform+token-only condition byte-identically. */
  const validateDisabled =
    validateState.status === "validating" ||
    !platform ||
    !botToken.trim() ||
    (platform === "slack" && !signingSecret.trim()) ||
    (platform === "whatsapp" && (!phoneNumberId.trim() || !appSecret.trim() || !verifyToken.trim()));

  /** Connect-with-Slack visibility (UI-SPEC contract 4): rendered only when
   * platform === slack AND the /oauth/providers signal reports slack
   * configured. Static fields always remain visible below it (coexistence —
   * A-6). */
  const slackOauthConfigured = oauthProviders.some((p) => p.id === "slack" && p.configured);

  const handleCreateSubmit = async () => {
    const errors: typeof formErrors = {};
    if (!platform) errors.platform = t("settings.connectors.errorPlatformRequired");
    if (!name.trim()) errors.name = t("settings.connectors.errorNameRequired");
    if (!botToken.trim()) errors.token = t("settings.connectors.errorTokenRequired");
    if (!workspaceId || workspaceId === "none") errors.workspace = t("settings.connectors.errorWorkspaceRequired");
    // Phase 200 (UI-SPEC contract 2): the platform's required inline checks
    // mirror the existing error*Required pattern. A-11: the signing secret
    // stays REQUIRED at create even in the OAuth arm — the OAuth response
    // carries no signing secret (app-level credential, not a token); the
    // callback merges and never overwrites it (Plan 03's config merge).
    if (platform === "slack" && !signingSecret.trim()) {
      errors.signingSecret = t("settings.connectors.errorSigningSecretRequired");
    }
    if (platform === "whatsapp") {
      if (!phoneNumberId.trim()) errors.phoneNumberId = t("settings.connectors.errorPhoneNumberIdRequired");
      if (!appSecret.trim()) errors.appSecret = t("settings.connectors.errorAppSecretRequired");
      if (!verifyToken.trim()) errors.verifyToken = t("settings.connectors.errorVerifyTokenRequired");
    }
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      // botToken is min(1) required in the schema even in the OAuth arm —
      // the admin pastes a placeholder token when using the Connect arm (the
      // OAuth callback overwrites botTokenEncrypted; Plan 03).
      const created = await createMutation.mutateAsync({
        platform: platform as ConnectorPlatform,
        name: name.trim(),
        workspaceId,
        archiveId: archiveId === "none" ? null : archiveId,
        botToken: botToken.trim(),
        ...(platform === "slack" && signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {}),
        ...(platform === "whatsapp" && phoneNumberId.trim() ? { phoneNumberId: phoneNumberId.trim() } : {}),
        ...(platform === "whatsapp" && appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        ...(platform === "whatsapp" && verifyToken.trim() ? { verifyToken: verifyToken.trim() } : {}),
        ...(platform === "whatsapp" && whatsappBusinessAccountId.trim() ? { whatsappBusinessAccountId: whatsappBusinessAccountId.trim() } : {}),
        welcomeMessage: welcomeMessage.trim() ? welcomeMessage.trim() : undefined,
        fallbackMessage: fallbackMessage.trim() ? fallbackMessage.trim() : undefined,
        fallbackLocale: fallbackLocale || "en",
      });
      showSuccess(t("settings.connectors.createSuccess"));
      setCreating(false);

      // Phase 200 (UI-SPEC contract 4): CREATE-THEN-CONNECT — when the admin
      // came in via the Connect-with-Slack arm, the just-created connector's
      // id drives POST /:id/oauth/start and the page navigates full-page to
      // the authorizeUrl (lib/redirect seam — 196-03 lesson; dialog state is
      // not held across the redirect). A start failure keeps the success
      // toast (the connector EXISTS) and surfaces the connect error.
      if (connectWithSlackArmed) {
        resetCreateForm();
        try {
          const data = await startOauthMutation.mutateAsync(created.id);
          assignRedirect(data.authorizeUrl);
        } catch {
          showError(t("settings.connectors.oauthConnectFailed"));
        } finally {
          setConnecting(false);
        }
        return;
      }
      resetCreateForm();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.connectors.createFailed")));
      setConnecting(false);
    } finally {
      setSaving(false);
    }
  };

  /** The Connect-with-Slack arm: clicking the outline button stores the
   * intent, the NEXT create submit routes into POST /:id/oauth/start
   * (create-then-connect — the connector row must exist before oauth/start
   * can mint its connector-audience state). */
  const [connectWithSlackArmed, setConnectWithSlackArmed] = useState(false);

  const handleWebhookSetupSubmit = async () => {
    if (!webhookTarget) return;
    const url = webhookUrl.trim();
    // Client-side URL validation (UI-SPEC: validated client-side as a URL).
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      valid = false;
    }
    if (!valid) {
      setWebhookUrlError(t("settings.connectors.errorGeneric"));
      return;
    }
    setWebhookBusy(true);
    try {
      await webhookSetupMutation.mutateAsync({ id: webhookTarget.id, url });
      showSuccess(t("settings.connectors.toggleSuccess", { status: t("settings.connectors.modeWebhook") }));
      setWebhookTarget(null);
      setWebhookUrl("");
      setWebhookUrlError("");
    } catch (err: unknown) {
      // The missing-secret arm maps to webhookNotConfigured, else
      // errorGeneric (UI-SPEC webhook contract). Mode stays whatever the
      // refetched row says (P-7 desync protection is server-owned).
      const message = getErrorMessage(err, "");
      const missingSecret = /secret/i.test(message);
      showError(missingSecret ? t("settings.connectors.webhookNotConfigured") : t("settings.connectors.errorGeneric"));
    } finally {
      setWebhookBusy(false);
    }
  };

  const handleWebhookRemove = async (conn: Connector) => {
    try {
      await webhookRemoveMutation.mutateAsync(conn.id);
      showSuccess(t("settings.connectors.toggleSuccess", { status: t("settings.connectors.modePolling") }));
    } catch (err: unknown) {
      const message = getErrorMessage(err, "");
      const missingSecret = /secret/i.test(message);
      showError(missingSecret ? t("settings.connectors.webhookNotConfigured") : t("settings.connectors.errorGeneric"));
    }
  };

  const handleTestSubmit = async () => {
    if (!testTarget || !testPlatformUserId.trim()) return;
    setTesting(true);
    try {
      await testMutation.mutateAsync({ id: testTarget.id, platformUserId: testPlatformUserId.trim() });
      showSuccess(t("settings.connectors.testSuccess"));
      setTestTarget(null);
      setTestPlatformUserId("");
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.connectors.testFailed", { error: "" })));
    } finally {
      setTesting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      showSuccess(t("settings.connectors.deleteSuccess"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.connectors.deleteFailed")));
    } finally {
      setDeleteTarget(null);
    }
  };

  /* ---------------- derived helpers ---------------- */

  const tokenHint = (p: ConnectorPlatform | ""): string | null => {
    if (p === "telegram") return t("settings.connectors.tokenHintTelegram");
    if (p === "discord") return t("settings.connectors.tokenHintDiscord");
    // Phase 200 (UI-SPEC copywriting): the slack hint points at the OAuth
    // arm; the whatsapp hint names the Meta app dashboard.
    if (p === "slack") return t("settings.connectors.tokenHintSlack");
    if (p === "whatsapp") return t("settings.connectors.tokenHintWhatsapp");
    return null;
  };

  const platformName = (p: ConnectorPlatform): string => t(`settings.connectors.platform.${p}`);

  if (!canView) return null;

  return (
    <TooltipProvider>
      <div className="w-full space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {t("settings.connectors.title")}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {t("settings.connectors.description")}
            </p>
          </div>
          {canManage && (
            <Button size="sm" onClick={openCreate}>
              {t("settings.connectors.createButton")}
            </Button>
          )}
        </div>

        {/* Loading (initial fetch only — TanStack keeps previous data on
            refetch, so the list never blanks) */}
        {isLoading && connectors.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-sm">
            {t("common.loading")}
          </div>
        )}

        {/* Card grid */}
        {connectors.length > 0 && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {connectors.map((conn) => (
              <ConnectorCard
                key={conn.id}
                conn={conn}
                canManage={canManage}
                toggling={togglingId === conn.id}
                onToggle={() => void handleToggle(conn)}
                onTest={() => {
                  setTestTarget(conn);
                  setTestPlatformUserId("");
                }}
                onWebhookSetup={() => {
                  setWebhookTarget(conn);
                  setWebhookUrl("");
                  setWebhookUrlError("");
                }}
                onWebhookRemove={() => void handleWebhookRemove(conn)}
                onDelete={() => setDeleteTarget(conn)}
              />
            ))}
          </div>
        )}

        {/* Empty state (MCP idiom, py-8) */}
        {!isLoading && connectors.length === 0 && (
          <div className="py-8 text-center">
            <p className="text-lg font-semibold text-foreground mb-2">
              {t("settings.connectors.noConnectors")}
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              {t("settings.connectors.noConnectorsBody")}
            </p>
            {canManage && (
              <Button size="sm" onClick={openCreate}>
                {t("settings.connectors.createButton")}
              </Button>
            )}
          </div>
        )}

        {/* Create dialog (ONE form with inline Validate — not a wizard) */}
        <Dialog
          open={creating}
          onOpenChange={(open) => {
            if (!open) closeCreate();
          }}
        >
          <DialogContent className="max-w-[640px] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("settings.connectors.createButton")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {/* 1. Platform */}
              <div className="space-y-2">
                <label className="text-sm font-medium">{t("settings.connectors.platformLabel")}</label>
                <Select
                  value={platform || undefined}
                  onValueChange={(value) => {
                    setPlatform(value as ConnectorPlatform);
                    // Platform switch: clear the other platforms' conditional
                    // values (no orphan values submitted — UI-SPEC contract 2)
                    // and reset the inline Validate state (existing behavior).
                    setSigningSecret("");
                    setShowSigningSecret(false);
                    setPhoneNumberId("");
                    setAppSecret("");
                    setShowAppSecret(false);
                    setVerifyToken("");
                    setShowVerifyToken(false);
                    setWhatsappBusinessAccountId("");
                    setFormErrors((prev) => {
                      const { signingSecret: _s, phoneNumberId: _p, appSecret: _a, verifyToken: _v, ...rest } = prev;
                      void _s;
                      void _p;
                      void _a;
                      void _v;
                      return rest;
                    });
                    setValidateState({ status: "idle" });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("settings.connectors.platformLabel")} />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORM_OPTIONS.map((p) => {
                      const implemented = IMPLEMENTED_PLATFORMS.includes(p);
                      return (
                        <SelectItem key={p} value={p} disabled={!implemented}>
                          <span>{platformName(p)}</span>
                          {!implemented && (
                            <span className="text-xs text-muted-foreground ml-2">
                              {t("settings.connectors.platformComingSoon")}
                            </span>
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {formErrors.platform && <p className="text-sm text-destructive">{formErrors.platform}</p>}
              </div>

              {/* 2. Name */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="connector-name">
                  {t("settings.connectors.nameLabel")}
                </label>
                <Input
                  id="connector-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("settings.connectors.namePlaceholder")}
                  maxLength={200}
                />
                {formErrors.name && <p className="text-sm text-destructive">{formErrors.name}</p>}
              </div>

              {/* 3. Bot Token (+ inline Validate) — plus the Phase 200
                  Connect-with-Slack arm (UI-SPEC contract 4): the outline
                  button renders ONLY when platform === slack AND the
                  /oauth/providers signal reports slack configured; static
                  fields remain visible below it (A-6 coexistence — OAuth and
                  static are alternative token sources for the same
                  connector). Clicking it arms create-then-connect. */}
              {platform === "slack" && slackOauthConfigured && (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving || connecting}
                    onClick={() => {
                      setConnectWithSlackArmed(true);
                      setValidateState({ status: "idle" });
                    }}
                  >
                    {t("settings.connectors.connectWithSlack")}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.connectors.connectWithSlackHint")}
                  </p>
                </div>
              )}

              {/* 3. Bot Token (+ inline Validate) */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="connector-token">
                  {t("settings.connectors.tokenLabel")}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="connector-token"
                      type={showToken ? "text" : "password"}
                      value={botToken}
                      onChange={(e) => {
                        setBotToken(e.target.value);
                        setValidateState({ status: "idle" });
                      }}
                      className="pr-9"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showToken ? t("settings.connectors.tokenHide") : t("settings.connectors.tokenShow")}
                      title={showToken ? t("settings.connectors.tokenHide") : t("settings.connectors.tokenShow")}
                    >
                      {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleValidate()}
                    disabled={validateDisabled}
                  >
                    {validateState.status === "validating"
                      ? t("settings.connectors.validating")
                      : t("settings.connectors.validate")}
                  </Button>
                </div>
                {tokenHint(platform) && (
                  <p className="text-xs text-muted-foreground">{tokenHint(platform)}</p>
                )}
                {/* Inline validate result (optional-but-recommended — the
                    form does NOT hard-block saving an unvalidated token, A-5). */}
                {validateState.status === "ok" && (
                  <p className="flex items-center gap-1 text-sm text-green-700 dark:text-green-400 truncate">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    {t("settings.connectors.validateOk", { username: validateState.botUsername ?? "" })}
                  </p>
                )}
                {validateState.status === "failed" && validateState.error && (
                  <p className="text-sm text-destructive truncate">
                    {t("settings.connectors.validateFailed", { error: validateState.error })}
                  </p>
                )}
                {formErrors.token && <p className="text-sm text-destructive">{formErrors.token}</p>}
              </div>

              {/* 3b. Platform-conditional create fields (Phase 200, UI-SPEC
                  contract 2) — a total function of the selected platform:
                  telegram/discord render none (byte-identical to 199),
                  slack renders Signing Secret, whatsapp renders Phone Number
                  ID → App Secret → Verify Token → WBA ID (optional). Secret
                  fields are create-only type=password with the labelled
                  show/hide toggle (T-199-05 discipline). */}
              {platform === "slack" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="connector-signing-secret">
                    {t("settings.connectors.signingSecretLabel")}
                  </label>
                  <div className="relative">
                    <Input
                      id="connector-signing-secret"
                      type={showSigningSecret ? "text" : "password"}
                      value={signingSecret}
                      onChange={(e) => {
                        setSigningSecret(e.target.value);
                        setValidateState({ status: "idle" });
                      }}
                      className="pr-9"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSigningSecret((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showSigningSecret ? t("settings.connectors.tokenHide") : t("settings.connectors.tokenShow")}
                      title={showSigningSecret ? t("settings.connectors.tokenHide") : t("settings.connectors.tokenShow")}
                    >
                      {showSigningSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("settings.connectors.signingSecretHint")}</p>
                  {formErrors.signingSecret && <p className="text-sm text-destructive">{formErrors.signingSecret}</p>}
                </div>
              )}
              {platform === "whatsapp" && (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="connector-phone-number-id">
                      {t("settings.connectors.phoneNumberIdLabel")}
                    </label>
                    <Input
                      id="connector-phone-number-id"
                      type="text"
                      value={phoneNumberId}
                      onChange={(e) => {
                        setPhoneNumberId(e.target.value);
                        setValidateState({ status: "idle" });
                      }}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">{t("settings.connectors.phoneNumberIdHint")}</p>
                    {formErrors.phoneNumberId && <p className="text-sm text-destructive">{formErrors.phoneNumberId}</p>}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="connector-app-secret">
                      {t("settings.connectors.appSecretLabel")}
                    </label>
                    <div className="relative">
                      <Input
                        id="connector-app-secret"
                        type={showAppSecret ? "text" : "password"}
                        value={appSecret}
                        onChange={(e) => {
                          setAppSecret(e.target.value);
                          setValidateState({ status: "idle" });
                        }}
                        className="pr-9"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAppSecret((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showAppSecret ? t("settings.connectors.tokenHide") : t("settings.connectors.tokenShow")}
                        title={showAppSecret ? t("settings.connectors.tokenHide") : t("settings.connectors.tokenShow")}
                      >
                        {showAppSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("settings.connectors.appSecretHint")}</p>
                    {formErrors.appSecret && <p className="text-sm text-destructive">{formErrors.appSecret}</p>}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="connector-verify-token">
                      {t("settings.connectors.verifyTokenLabel")}
                    </label>
                    <div className="relative">
                      <Input
                        id="connector-verify-token"
                        type={showVerifyToken ? "text" : "password"}
                        value={verifyToken}
                        onChange={(e) => {
                          setVerifyToken(e.target.value);
                          setValidateState({ status: "idle" });
                        }}
                        className="pr-9"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setShowVerifyToken((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showVerifyToken ? t("settings.connectors.tokenHide") : t("settings.connectors.tokenShow")}
                        title={showVerifyToken ? t("settings.connectors.tokenHide") : t("settings.connectors.tokenShow")}
                      >
                        {showVerifyToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("settings.connectors.verifyTokenHint")}</p>
                    {formErrors.verifyToken && <p className="text-sm text-destructive">{formErrors.verifyToken}</p>}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="connector-wba-id">
                      {t("settings.connectors.wbaIdLabel")}
                    </label>
                    <Input
                      id="connector-wba-id"
                      type="text"
                      value={whatsappBusinessAccountId}
                      onChange={(e) => {
                        setWhatsappBusinessAccountId(e.target.value);
                        setValidateState({ status: "idle" });
                      }}
                      autoComplete="off"
                    />
                  </div>
                </>
              )}

              {/* 4. Workspace */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="connector-workspace">
                  {t("settings.connectors.workspaceLabel")}
                </label>
                <Select value={workspaceId || undefined} onValueChange={(value) => setWorkspaceId(value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("settings.connectors.selectWorkspace")} />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {formErrors.workspace && <p className="text-sm text-destructive">{formErrors.workspace}</p>}
              </div>

              {/* 5. Archive (optional) */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="connector-archive">
                  {t("settings.connectors.archiveLabel")}
                </label>
                <Select value={archiveId} onValueChange={(value) => setArchiveId(value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("settings.connectors.selectArchive")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("settings.connectors.selectArchive")}</SelectItem>
                    {archives.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 6. Welcome Message */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="connector-welcome">
                  {t("settings.connectors.welcomeLabel")}
                </label>
                <Textarea
                  id="connector-welcome"
                  value={welcomeMessage}
                  onChange={(e) => setWelcomeMessage(e.target.value)}
                  maxLength={4000}
                  className="min-h-[72px]"
                />
                {welcomeMessage.length > 3500 && (
                  <p className="text-xs text-muted-foreground">{welcomeMessage.length}/4000</p>
                )}
              </div>

              {/* 7. Fallback Message */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="connector-fallback">
                  {t("settings.connectors.fallbackLabel")}
                </label>
                <Textarea
                  id="connector-fallback"
                  value={fallbackMessage}
                  onChange={(e) => setFallbackMessage(e.target.value)}
                  maxLength={4000}
                  className="min-h-[72px]"
                />
                {fallbackMessage.length > 3500 && (
                  <p className="text-xs text-muted-foreground">{fallbackMessage.length}/4000</p>
                )}
              </div>

              {/* 8. Fallback Locale */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="connector-fallback-locale">
                  {t("settings.connectors.fallbackLocaleLabel")}
                </label>
                <Select value={fallbackLocale} onValueChange={(value) => setFallbackLocale(value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_LOCALES.map((loc) => (
                      <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Footer */}
              <div className="pt-4 border-t border-border flex gap-2 justify-end">
                <Button variant="ghost" size="sm" type="button" onClick={closeCreate}>
                  {t("common.cancel")}
                </Button>
                <Button type="button" size="sm" onClick={() => void handleCreateSubmit()} disabled={saving}>
                  {t("settings.connectors.createSubmit")}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Test-message dialog */}
        <Dialog
          open={!!testTarget}
          onOpenChange={(open) => {
            if (!open) {
              setTestTarget(null);
              setTestPlatformUserId("");
            }
          }}
        >
          <DialogContent className="max-w-[480px]">
            <DialogHeader>
              <DialogTitle>{t("settings.connectors.test")}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t("settings.connectors.testDialogBody")}</p>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="connector-test-userid">
                {t("settings.connectors.testPlatformUserIdLabel")}
              </label>
              <Input
                id="connector-test-userid"
                type="text"
                value={testPlatformUserId}
                onChange={(e) => setTestPlatformUserId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("settings.connectors.testPlatformUserIdHint")}</p>
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="ghost" size="sm" onClick={() => setTestTarget(null)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={() => void handleTestSubmit()} disabled={testing || !testPlatformUserId.trim()}>
                {t("settings.connectors.testSend")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Webhook setup mini-dialog (telegram rows only) */}
        <Dialog
          open={!!webhookTarget}
          onOpenChange={(open) => {
            if (!open) {
              setWebhookTarget(null);
              setWebhookUrl("");
              setWebhookUrlError("");
            }
          }}
        >
          <DialogContent className="max-w-[480px]">
            <DialogHeader>
              <DialogTitle>{t("settings.connectors.webhookSetup")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="connector-webhook-url">
                {t("settings.connectors.webhookSetupUrlLabel")}
              </label>
              <Input
                id="connector-webhook-url"
                type="text"
                value={webhookUrl}
                onChange={(e) => {
                  setWebhookUrl(e.target.value);
                  setWebhookUrlError("");
                }}
                placeholder="https://"
              />
              <p className="text-xs text-muted-foreground">{t("settings.connectors.webhookSetupUrlHint")}</p>
              {webhookUrlError && <p className="text-sm text-destructive">{webhookUrlError}</p>}
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="ghost" size="sm" onClick={() => setWebhookTarget(null)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={() => void handleWebhookSetupSubmit()} disabled={webhookBusy || !webhookUrl.trim()}>
                {t("settings.connectors.webhookSetup")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Delete confirm (soft delete — chats are kept) */}
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("settings.connectors.deleteConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("settings.connectors.deleteConfirmBody")}</AlertDialogDescription>
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
      </div>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ */
/*  ConnectorCard                                                      */
/* ------------------------------------------------------------------ */

function ConnectorCard({
  conn,
  canManage,
  toggling,
  onToggle,
  onTest,
  onWebhookSetup,
  onWebhookRemove,
  onDelete,
}: {
  conn: Connector;
  canManage: boolean;
  toggling: boolean;
  onToggle: () => void;
  onTest: () => void;
  onWebhookSetup: () => void;
  onWebhookRemove: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const Glyph = PLATFORM_GLYPHS[conn.platform];
  const isTelegram = conn.platform === "telegram";

  return (
    <Card className="p-4">
      <CardContent className="p-0 space-y-2">
        {/* Header row: glyph + name + health badge (right-aligned) */}
        <div className="flex items-center gap-2 min-w-0">
          <Glyph className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm truncate text-foreground" title={conn.name}>
            {conn.name}
          </span>
          <span className="ml-auto shrink-0">
            <HealthBadge conn={conn} />
          </span>
        </div>

        {/* Meta rows */}
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="truncate" title={conn.botUsername ?? undefined}>
            {conn.botUsername
              ? `@${conn.botUsername}`
              : t("settings.connectors.tokenNotValidated")}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isTelegram && (
              <Badge variant="outline" className="text-xs">
                {conn.pollMode === "webhook"
                  ? t("settings.connectors.modeWebhook")
                  : t("settings.connectors.modePolling")}
              </Badge>
            )}
            {isTelegram && conn.lastWebhookAt && (
              <span className="truncate" title={conn.lastWebhookAt}>{conn.lastWebhookAt}</span>
            )}
            {isTelegram && conn.lastPollAt && (
              <span className="truncate" title={conn.lastPollAt}>{conn.lastPollAt}</span>
            )}
          </div>
        </div>

        {/* Action row: Switch + link actions + overflow menu. All gated
            connector:manage — hidden, not disabled (T-199-06). */}
        {canManage && (
          <div className="flex items-center gap-2 pt-1">
            <Switch
              checked={conn.isEnabled}
              onCheckedChange={onToggle}
              disabled={toggling}
              aria-busy={toggling}
              aria-label={t("settings.connectors.toggleAria", { name: conn.name })}
            />
            <div className="ml-auto flex items-center gap-1">
              <Button variant="link" size="sm" className="h-8 px-2" onClick={onTest}>
                {t("settings.connectors.test")}
              </Button>
              {isTelegram && conn.pollMode === "polling" && (
                <Button variant="link" size="sm" className="h-8 px-2" onClick={onWebhookSetup}>
                  {t("settings.connectors.webhookSetup")}
                </Button>
              )}
              {isTelegram && conn.pollMode === "webhook" && (
                <Button variant="link" size="sm" className="h-8 px-2" onClick={onWebhookRemove}>
                  {t("settings.connectors.webhookRemove")}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={t("settings.connectors.cardMenu")}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="text-destructive-foreground"
                    onClick={onDelete}
                  >
                    {t("common.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  HealthBadge — ONE badge per row, disabled > error > healthy >       */
/*  unknown priority (UI-SPEC health matrix, A-12).                     */
/* ------------------------------------------------------------------ */

function HealthBadge({ conn }: { conn: Connector }) {
  const { t } = useTranslation();

  if (!conn.isEnabled) {
    return (
      <Badge className="bg-gray-500/10 text-muted-foreground" aria-label={t("settings.connectors.statusDisabled")}>
        {t("settings.connectors.statusDisabled")}
      </Badge>
    );
  }
  if (conn.healthStatus === "error") {
    const tooltipText = conn.lastError
      ? t("settings.connectors.lastErrorTooltip", { error: conn.lastError })
      : t("settings.connectors.statusError");
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            className="bg-destructive/10 text-destructive"
            aria-label={t("settings.connectors.statusError")}
          >
            {t("settings.connectors.statusError")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-[40ch] whitespace-normal">{tooltipText}</TooltipContent>
      </Tooltip>
    );
  }
  if (conn.healthStatus === "healthy") {
    return (
      <Badge className="bg-green-500/10 text-green-700 dark:text-green-400" aria-label={t("settings.connectors.statusHealthy")}>
        {t("settings.connectors.statusHealthy")}
      </Badge>
    );
  }
  return (
    <Badge className="bg-gray-500/10 text-muted-foreground" aria-label={t("settings.connectors.statusUnknown")}>
      {t("settings.connectors.statusUnknown")}
    </Badge>
  );
}