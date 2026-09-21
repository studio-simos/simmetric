// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useFeature } from "../hooks/useFeature";
import {
  useSsoConfig,
  useSaveSsoConfig,
  useScimBearerToken,
  useTestScim,
  useTestLdapConnection,
  useLdapMap,
  usePutLdapMap,
  type LdapMapping,
  type LdapTestResult,
} from "../queries/useSso";
import { useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { apiGet } from "../queries/api";
import UpgradePrompt from "./UpgradePrompt";
import { Button } from "@/components/ui/button";
import { AppInput, AppTextarea } from "@/components/ui/app";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, Plus, Trash2, X } from "lucide-react";
import { getErrorMessage } from "../utils/errorUtils";
import type { FeatureFlag } from "@simmetric-chat/shared";

export default function SsoSettingsPanel() {
  const { t } = useTranslation();
  usePageMeta(t("sso.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.sso") }]);
  const ssoEnabled = useFeature("sso_enabled" as FeatureFlag);

  if (!ssoEnabled) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <h2 className="text-xl font-bold mb-4">{t("sso.title")}</h2>
        <UpgradePrompt feature="sso_enabled" />
      </div>
    );
  }

  return <SsoConfigForm />;
}

/**
 * Phase 193 (D-19) — shape of the SsoConfigForm's config state slice.
 * Named at module scope so LdapConfigSection's props type structurally
 * matches the actual useState slice (no Record<string, unknown> widening).
 */
interface SsoFormConfig {
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  entryPoint: string;
  cert: string;
  entityId: string;
  redirectUri: string;
  ldapUrl: string;
  ldapBindDn: string;
  ldapBindPassword: string;
  ldapSearchBase: string;
  ldapSearchFilter: string;
  ldapGroupSearchBase: string;
  ldapGroupSearchFilter: string;
  ldapUseTls: boolean;
  ldapAcceptCert: string;
  ldapFallbackToLocal: boolean;
}

function SsoConfigForm() {
  const { t } = useTranslation();
  usePageMeta(t("sso.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.sso") }]);
  const { data: ssoConfig, isError } = useSsoConfig();
  const saveMutation = useSaveSsoConfig();
  // Phase 193 (D-16/D-19) — LDAP test-connection + mapping hooks (193-04 Task 1).
  const testLdapMut = useTestLdapConnection();
  const putLdapMap = usePutLdapMap();
  // WR-08 (193-REVIEW) — hydration flag for the map PUT guard: the mapping
  // rows hydrate async (GET /sso/ldap/map); saving before they land (or
  // while a NON-ldap provider is selected) used to bulk-DELETE every
  // LdapGroupRoleMap row — the PUT is a full-list replace (deleteMany({}) +
  // createMany) and mass-revoked LDAP-mapped roles at next login. The
  // commit now runs ONLY on an ldap-arm save with hydrated rows. (Same
  // query key as the editor's own useLdapMap — TanStack dedupes to ONE
  // network call.)
  const { data: mapDataForGuard } = useLdapMap();
  const mapLoaded = mapDataForGuard !== undefined;
  const { getValue } = useSettingsHelpers();
  const serverUrl = getValue("SERVER_URL") || (typeof window !== "undefined" ? window.location.origin : "");

  // All hooks MUST run before any early return (Rules of Hooks).
  // Phase 143 (EPA-03 — UI-SPEC D-11): community-build error state.
  // In a pure community build the enterprise plugin is absent, so
  // /api/sso/config returns 404 → useSsoConfig().isError is true. Render a
  // graceful informational Alert (variant="default") instead of the config
  // form. The copy explains the Enterprise license + plugin requirement; it
  // does NOT leak the SsoConfig row contents (a 404 means no row was returned).
  // Phase 147 will replace this with proper conditional lazy-loading of the
  // enterprise UI chunk. No retry button (interim contract per UI-SPEC).
  // Phase 193 (D-19): provider widens with the third `ldap` member.
  const [provider, setProvider] = useState<"saml" | "oidc" | "ldap">("oidc");
  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState<SsoFormConfig>({
    clientId: "",
    clientSecret: "",
    discoveryUrl: "",
    entryPoint: "",
    cert: "",
    entityId: "",
    redirectUri: "",
    // Phase 193 (LDAP-01, D-03) — additive LDAP fields. ldapBindPassword is
    // WRITE-ONLY plaintext on input; the server encrypts at rest and never
    // echoes it (T-193-15: no ciphertext echo, ever).
    ldapUrl: "",
    ldapBindDn: "",
    ldapBindPassword: "",
    ldapSearchBase: "",
    ldapSearchFilter: "",
    ldapGroupSearchBase: "",
    ldapGroupSearchFilter: "",
    ldapUseTls: true, // D-06 default ON
    ldapAcceptCert: "",
    ldapFallbackToLocal: true, // D-03 default ON
  });
  const [message, setMessage] = useState<string | null>(null);
  // Phase 193 (D-19) — staged mapping rows live HERE (panel scope) so the
  // single Save handler commits config + rows through the two PUTs.
  const [stagedMappings, setStagedMappings] = useState<LdapMapping[]>([]);

  useEffect(() => {
    if (ssoConfig) {
      setProvider(ssoConfig.provider ?? "oidc");
      setEnabled(ssoConfig.enabled);
      setConfig({
        clientId: ssoConfig.clientId ?? "",
        clientSecret: "",
        discoveryUrl: ssoConfig.discoveryUrl ?? "",
        entryPoint: ssoConfig.entryPoint ?? "",
        cert: ssoConfig.cert ?? "",
        entityId: ssoConfig.entityId ?? "",
        redirectUri: ssoConfig.redirectUri ?? "",
        ldapUrl: ssoConfig.ldapUrl ?? "",
        ldapBindDn: ssoConfig.ldapBindDn ?? "",
        // Write-only: never hydrate from the (absent) ciphertext — the field
        // stays blank unless the admin types a NEW password (D-05/T-193-15).
        ldapBindPassword: "",
        ldapSearchBase: ssoConfig.ldapSearchBase ?? "",
        ldapSearchFilter: ssoConfig.ldapSearchFilter ?? "",
        ldapGroupSearchBase: ssoConfig.ldapGroupSearchBase ?? "",
        ldapGroupSearchFilter: ssoConfig.ldapGroupSearchFilter ?? "",
        ldapUseTls: ssoConfig.ldapUseTls ?? true,
        ldapAcceptCert: ssoConfig.ldapAcceptCert ?? "",
        ldapFallbackToLocal: ssoConfig.ldapFallbackToLocal ?? true,
      });
    }
  }, [ssoConfig]);

  // Phase 193 (D-05/T-193-15) — when the bind password is carried by env
  // (env-over-DB), the field renders READ-ONLY with the configured-state
  // placeholder (SCIM token precedent, ScimSection). The server exposes
  // ldapBindPasswordConfigured, never the ciphertext.
  const ldapBindPasswordViaEnv =
    ssoConfig?.ldapBindPasswordConfigured === true && !config.ldapBindPassword;

  if (isError) {
    return (
      <div className="max-w-md mx-auto mt-8 text-center">
        <Alert variant="default">
          <AlertDescription>
            <p className="font-semibold text-lg">{t("sso.unavailableTitle")}</p>
            <p className="text-sm text-muted-foreground mt-2">{t("sso.unavailableBody")}</p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const handleSave = async () => {
    setMessage(null);
    try {
      await saveMutation.mutateAsync({
        provider,
        enabled,
        clientId: config.clientId || null,
        clientSecret: config.clientSecret || null,
        discoveryUrl: config.discoveryUrl || null,
        entryPoint: config.entryPoint || null,
        cert: config.cert || null,
        entityId: config.entityId || null,
        redirectUri: config.redirectUri || null,
        // Phase 193 (D-03) — the ldap fields ride the SAME single save.
        // ldapUrl/ldapBindDn persist whenever the field holds content.
        ldapUrl: config.ldapUrl || null,
        ldapBindDn: config.ldapBindDn || null,
        // ldapBindPassword is plaintext on input only (encrypted at rest).
        // CR-04 (193-REVIEW): the field is NEVER hydrated from ciphertext
        // (write-only), so an unmodified field is "" — sending null here
        // WIPED the stored ciphertext on every unrelated SSO save (the
        // server treats a defined key as authoritative). OMIT the key
        // entirely unless the admin typed a NEW password; clearing is the
        // server contract's explicit-null arm (a deliberate typed value —
        // the form never auto-sends it).
        ...(config.ldapBindPassword ? { ldapBindPassword: config.ldapBindPassword } : {}),
        ldapSearchBase: config.ldapSearchBase || null,
        ldapSearchFilter: config.ldapSearchFilter || null,
        ldapGroupSearchBase: config.ldapGroupSearchBase || null,
        ldapGroupSearchFilter: config.ldapGroupSearchFilter || null,
        ldapUseTls: config.ldapUseTls,
        ldapAcceptCert: config.ldapAcceptCert || null,
        ldapFallbackToLocal: config.ldapFallbackToLocal,
      });
      // Phase 193 (D-19) — staged mapping rows commit through the bulk
      // full-list replace in the SAME save (one commit, no per-row calls).
      // WR-08 (193-REVIEW): gated on the LDAP arm AND hydration — the PUT
      // is a FULL-LIST replace (server-side deleteMany({}) + createMany in
      // one transaction), so an unconditional commit from an unrelated
      // SAML/OIDC save (or a save racing the rows' hydration, staged = [])
      // bulk-deleted every LdapGroupRoleMap row and mass-revoked
      // LDAP-mapped roles at next login. Latent today only because the map
      // route was unmounted (CR-01); fixing CR-01 without this turned it
      // live.
      if (provider === "ldap" && mapLoaded) {
        await putLdapMap.mutateAsync({ mappings: stagedMappings });
      }
      setMessage(t("common.success"));
    } catch (err: unknown) {
      // Phase 193 — saveFailed replaces the bare common.error fallback for
      // this surface (getErrorMessage idiom). Per-key rejections follow the
      // partial-save refetch convention (PUT returns { updated, rejected }).
      setMessage(getErrorMessage(err, t("settings.sso.ldap.saveFailed")));
    }
  };

  const handleTest = async () => {
    setMessage(null);
    // Phase 193 (D-16) — in the ldap arm the Test button calls the
    // structured diagnostics endpoint; the result renders as the 4-row
    // checklist (LdapDiagnostics below), never a raw server string.
    if (provider === "ldap") {
      try {
        await testLdapMut.mutateAsync();
      } catch {
        // A thrown call means the request itself failed - the typed shape
        // stays null and the SsoConfigForm renders the banner arm. No raw
        // error text ever surfaces (T-193-12).
      }
      return;
    }
    try {
      const token = localStorage.getItem("token");
      const headers: Record<string, string> = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const res = await fetch("/api/sso/test", {
        method: "POST",
        headers,
      });
      const data = await res.json();
      setMessage(data.success ? t("sso.testSuccess") : t("sso.testFailed"));
    } catch {
      setMessage(t("common.error"));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <h2 className="text-xl font-bold">{t("sso.title")}</h2>
      <p className="text-sm text-muted-foreground">{t("sso.description")}</p>

      {/* Enabled toggle */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-primary"
          />
          <span className="text-sm font-medium text-foreground">{t("sso.enabled")}</span>
        </label>
      </div>

      {/* Provider selector */}
      <div>
        <label className="text-sm font-medium text-muted-foreground">
          {t("sso.provider")}
        </label>
        <div className="mt-1 flex gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="provider"
              value="oidc"
              checked={provider === "oidc"}
              onChange={() => setProvider("oidc")}
            />
            <span className="text-sm text-foreground">OIDC</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="provider"
              value="saml"
              checked={provider === "saml"}
              onChange={() => setProvider("saml")}
            />
            <span className="text-sm text-foreground">SAML 2.0</span>
          </label>
          {/* Phase 193 (D-19) — third provider option, styled identically
              to the existing native radios. */}
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="provider"
              value="ldap"
              checked={provider === "ldap"}
              onChange={() => setProvider("ldap")}
            />
            <span className="text-sm text-foreground">LDAP</span>
          </label>
        </div>
      </div>

      {/* Phase 193 (D-17) — enabling LDAP over a configured SAML/OIDC shows
          the inline advisory Alert (NOT a modal; save stays possible). */}
      {provider === "ldap" && enabled &&
        (ssoConfig?.provider === "saml" || ssoConfig?.provider === "oidc") && (
          <Alert variant="default">
            <AlertDescription className="text-xs text-muted-foreground">
              {t("settings.sso.ldap.exclusiveHint")}
            </AlertDescription>
          </Alert>
        )}

      {/* Phase 193 (D-19) — LDAP config section. When provider is `ldap`,
          the SAML/OIDC field sections are HIDDEN (not merely inactive) per
          the UI-SPEC out-of-scope row (D-17 exclusivity mirrored). */}
      {provider === "ldap" && (
        <LdapConfigSection
          config={config}
          setConfig={setConfig}
          bindPasswordViaEnv={ldapBindPasswordViaEnv}
        />
      )}

      {/* OIDC fields */}
      {provider === "oidc" && (
        <div className="space-y-3">
          <AppInput
            label={t("sso.discoveryUrl")}
            value={config.discoveryUrl}
            onChange={(e) => setConfig({ ...config, discoveryUrl: e.target.value })}
            placeholder="https://accounts.google.com/.well-known/openid-configuration"
          />
          <AppInput
            label={t("sso.clientId")}
            value={config.clientId}
            onChange={(e) => setConfig({ ...config, clientId: e.target.value })}
          />
          <AppInput
            label={t("sso.clientSecret")}
            type="password"
            value={config.clientSecret}
            onChange={(e) => setConfig({ ...config, clientSecret: e.target.value })}
            placeholder={t("sso.clientSecretPlaceholder")}
          />
          <AppInput
            label={t("sso.redirectUri")}
            value={config.redirectUri}
            onChange={(e) => setConfig({ ...config, redirectUri: e.target.value })}
            placeholder={`${serverUrl}/api/auth/oidc/callback`}
          />
          <p className="text-xs text-muted-foreground">{t("sso.oidcHint")}</p>
        </div>
      )}

      {/* SAML fields */}
      {provider === "saml" && (
        <div className="space-y-3">
          <AppInput
            label={t("sso.entryPoint")}
            value={config.entryPoint}
            onChange={(e) => setConfig({ ...config, entryPoint: e.target.value })}
            placeholder="https://idp.example.com/saml/sso"
          />
          <AppTextarea
            label={t("sso.certificate")}
            value={config.cert}
            onChange={(e) => setConfig({ ...config, cert: e.target.value })}
            placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
            className="font-mono"
            rows={4}
          />
          <AppInput
            label={t("sso.entityId")}
            value={config.entityId}
            onChange={(e) => setConfig({ ...config, entityId: e.target.value })}
            placeholder="simmetric-chat"
          />
          <AppInput
            label={t("sso.redirectUri")}
            value={config.redirectUri}
            onChange={(e) => setConfig({ ...config, redirectUri: e.target.value })}
            placeholder={`${serverUrl}/api/auth/saml/callback`}
          />
          <div className="text-xs text-muted-foreground space-y-1">
            <p>{t("sso.samlMetadataHint")}: <code>{serverUrl}/api/auth/saml/metadata</code></p>
          </div>
        </div>
      )}

      {/* SSO Save + Test */}
      <div className="flex gap-3">
        <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending || putLdapMap.isPending}>
          {(saveMutation.isPending || putLdapMap.isPending) ? t("common.loading") : t("common.save")}
        </Button>
        {/* Phase 193 (D-16) — the ldap arm's Test button carries the
            testPending label while pending; both buttons disable. */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={saveMutation.isPending || (provider === "ldap" && testLdapMut.isPending)}
        >
          {provider === "ldap" && testLdapMut.isPending
            ? t("settings.sso.ldap.testPending")
            : t("sso.testConnection")}
        </Button>
      </div>

      {/* Phase 193 (D-16) — the structured diagnostics checklist renders
          in the ldap arm, replacing any previous result. A THROWN call
          renders the testFailed banner arm (error flag; T-193-12). */}
      {provider === "ldap" && (
        <LdapDiagnostics
          result={testLdapMut.data ?? null}
          error={testLdapMut.isError}
          pending={testLdapMut.isPending}
        />
      )}

      {/* Login URL info box */}
      {enabled && provider && (
        <div className="rounded-lg border border-input bg-muted/30 p-4 space-y-2">
          <p className="text-sm font-medium text-foreground">{t("sso.loginUrlsTitle")}</p>
          <div className="text-xs text-muted-foreground space-y-1">
            {provider === "saml" && (
              <p><code>{serverUrl}/api/auth/saml/login</code></p>
            )}
            {provider === "oidc" && (
              <>
                <p><code>{serverUrl}/api/auth/oidc/oidc/login</code> (custom OIDC)</p>
                <p><code>{serverUrl}/api/auth/oidc/google/login</code> (Google)</p>
                <p><code>{serverUrl}/api/auth/oidc/github/login</code> (GitHub)</p>
                <p><code>{serverUrl}/api/auth/oidc/microsoft/login</code> (Microsoft)</p>
              </>
            )}
          </div>
        </div>
      )}

      {message && <div className="text-sm text-muted-foreground">{message}</div>}

      {/* Phase 193 (D-19) — group→role mapping editor + test-connection
          diagnostics render INSIDE the ldap arm (ScimSection sibling idiom:
          sibling components defined at file scope below). */}
      {provider === "ldap" && (
        <TooltipProvider delayDuration={200}>
          <LdapMappingEditor staged={stagedMappings} setStaged={setStagedMappings} />
        </TooltipProvider>
      )}

      {/* SCIM 2.0 Provisioning Section */}
      <ScimSection />
    </div>
  );
}

function ScimSection() {
  const { t } = useTranslation();
  const { token, isReadOnly } = useScimBearerToken();
  const updateSettings = useUpdateSettings();
  const testScimMut = useTestScim();
  const { getValue } = useSettingsHelpers();
  const serverUrl = getValue("SERVER_URL") || (typeof window !== "undefined" ? window.location.origin : "");

  const [tokenInput, setTokenInput] = useState("");
  const [scimMessage, setScimMessage] = useState<string | null>(null);

  useEffect(() => {
    setTokenInput(isReadOnly ? token : "");
  }, [token, isReadOnly]);

  const handleSaveScim = async () => {
    setScimMessage(null);
    try {
      await updateSettings.mutateAsync([{ key: "SCIM_BEARER_TOKEN", value: tokenInput }]);
      setScimMessage(t("common.success"));
    } catch {
      setScimMessage(t("common.error"));
    }
  };

  const handleTestScim = async () => {
    setScimMessage(null);
    try {
      const result = await testScimMut.mutateAsync();
      setScimMessage(result.success ? t("sso.scimTestSuccess") : t("sso.scimTestFailed"));
    } catch {
      setScimMessage(t("common.error"));
    }
  };

  return (
    <div className="border-t border-input pt-6 space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">{t("sso.scimTitle")}</h3>
        <p className="text-sm text-muted-foreground mt-1">{t("sso.scimDescription")}</p>
      </div>

      <AppInput
        label={t("sso.scimBearerToken")}
        type="password"
        value={isReadOnly ? token : tokenInput}
        onChange={(e) => setTokenInput(e.target.value)}
        disabled={isReadOnly}
        placeholder={isReadOnly ? t("sso.scimTokenEnvSet") : t("sso.scimTokenPlaceholder")}
      />

      {isReadOnly && (
        <p className="text-xs text-muted-foreground">{t("sso.scimTokenReadOnly")}</p>
      )}

      <div>
        <label className="text-sm font-medium text-muted-foreground">{t("sso.scimEndpoint")}</label>
        <div className="mt-1">
          <code className="text-sm text-foreground bg-muted px-2 py-1 rounded">{serverUrl}/scim/v2</code>
        </div>
      </div>

      <div className="flex gap-3">
        {!isReadOnly && (
          <Button
            size="sm"
            onClick={handleSaveScim}
            disabled={updateSettings.isPending}
          >
            {updateSettings.isPending ? t("common.loading") : t("common.save")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={handleTestScim}
          disabled={testScimMut.isPending}
        >
          {testScimMut.isPending ? t("common.loading") : t("sso.scimTestConnection")}
        </Button>
      </div>

      {scimMessage && <div className="text-sm text-muted-foreground">{scimMessage}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Phase 193 (LDAP) — inline components (ScimSection sibling idiom)   */
/* ------------------------------------------------------------------ */

/**
 * Phase 193 (D-19) — shape of the SsoConfigForm's ldap config state slice.
 * Typed structurally at the consumer seam (the 187 precedent — an inferred
 * state type would require rawSources-style carry-through here).
 */
/**
 * Phase 193 (D-19/D-06/D-05) — the LDAP config field section. Rendered
 * ONLY inside `provider === "ldap"` (SAML/OIDC fields are hidden then,
 * not merely inactive — D-17 exclusivity mirrored in the UI).
 *
 * Threat-model controls (T-193-15): the bind-password field is WRITE-ONLY —
 * it never hydrates from the stored ciphertext, and when the value is
 * carried by env (ldapBindPasswordConfigured) it renders READ-ONLY with
 * the configured-state placeholder (SCIM token precedent).
 */
function LdapConfigSection({
  config,
  setConfig,
  bindPasswordViaEnv,
}: {
  config: SsoFormConfig;
  setConfig: React.Dispatch<React.SetStateAction<SsoFormConfig>>;
  bindPasswordViaEnv: boolean;
}) {
  const { t } = useTranslation();
  // D-06 exclusivity mirrored in the UI — TLS toggle is DISABLED when the
  // URL input starts with the ldaps scheme (StartTLS vs implicit-TLS).
  const urlIsLdaps = config.ldapUrl.trimStart().toLowerCase().startsWith("ldaps://");

  return (
    <div className="space-y-3">
      <AppInput
        label={t("settings.sso.ldap.url")}
        value={config.ldapUrl}
        onChange={(e) => setConfig({ ...config, ldapUrl: e.target.value })}
        placeholder="ldaps://ad.example.com:636"
        className="font-mono"
      />
      <AppInput
        label={t("settings.sso.ldap.bindDn")}
        value={config.ldapBindDn}
        onChange={(e) => setConfig({ ...config, ldapBindDn: e.target.value })}
        placeholder="cn=service,ou=service-accounts,dc=example,dc=com"
      />
      {/* T-193-15 — write-only bind password; NEVER echoes ciphertext. When
          the value is carried by env, the field is read-only with the
          configured-state placeholder (env-over-DB per D-05). */}
      <AppInput
        label={t("settings.sso.ldap.bindPassword")}
        type="password"
        value={bindPasswordViaEnv ? "••••••••" : config.ldapBindPassword}
        onChange={(e) => setConfig({ ...config, ldapBindPassword: e.target.value })}
        disabled={bindPasswordViaEnv}
        placeholder={
          bindPasswordViaEnv
            ? t("settings.sso.ldap.bindPasswordViaEnv")
            : t("sso.clientSecretPlaceholder")
        }
      />
      {bindPasswordViaEnv && (
        <p className="text-xs text-muted-foreground">
          {t("settings.sso.ldap.bindPasswordReadOnly")}
        </p>
      )}
      <AppInput
        label={t("settings.sso.ldap.searchBase")}
        value={config.ldapSearchBase}
        onChange={(e) => setConfig({ ...config, ldapSearchBase: e.target.value })}
        placeholder="dc=example,dc=com"
      />
      <AppInput
        label={t("settings.sso.ldap.searchFilter")}
        value={config.ldapSearchFilter}
        onChange={(e) => setConfig({ ...config, ldapSearchFilter: e.target.value })}
        placeholder="(uid={{username}})"
        className="font-mono"
      />
      <AppInput
        label={t("settings.sso.ldap.groupSearchBase")}
        value={config.ldapGroupSearchBase}
        onChange={(e) => setConfig({ ...config, ldapGroupSearchBase: e.target.value })}
        placeholder="ou=groups,dc=example,dc=com"
      />
      <AppInput
        label={t("settings.sso.ldap.groupSearchFilter")}
        value={config.ldapGroupSearchFilter}
        onChange={(e) => setConfig({ ...config, ldapGroupSearchFilter: e.target.value })}
        placeholder="(member={{dn}})"
        className="font-mono"
      />

      <div className="flex items-center gap-3">
        <Switch
          checked={config.ldapUseTls}
          onCheckedChange={(checked) => setConfig({ ...config, ldapUseTls: checked })}
          disabled={urlIsLdaps}
          aria-label={t("settings.sso.ldap.useTls")}
        />
        <label className="text-sm font-medium text-foreground">
          {t("settings.sso.ldap.useTls")}
        </label>
      </div>
      {/* D-06 exclusivity hint — the established helper-text idiom. */}
      <p className="text-xs text-muted-foreground">{t("settings.sso.ldap.tlsHint")}</p>

      <AppTextarea
        label={t("settings.sso.ldap.acceptCert")}
        value={config.ldapAcceptCert}
        onChange={(e) => setConfig({ ...config, ldapAcceptCert: e.target.value })}
        placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
        className="font-mono"
        rows={4}
      />

      <div className="flex items-center gap-3">
        <Switch
          checked={config.ldapFallbackToLocal}
          onCheckedChange={(checked) => setConfig({ ...config, ldapFallbackToLocal: checked })}
          aria-label={t("settings.sso.ldap.fallbackToLocal")}
        />
        <label className="text-sm font-medium text-foreground">
          {t("settings.sso.ldap.fallbackToLocal")}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.sso.ldap.fallbackHint")}</p>
    </div>
  );
}

/**
 * Phase 193 (D-19/D-10) — group→role mapping editor. Rows STAGE locally and
 * commit through the SAME single Save as the config (bulk PUT /ldap/map via
 * the panel save flow — no per-row API call, no confirm dialog on remove:
 * additive, re-addable, bounded blast radius per the UI-SPEC).
 */
function LdapMappingEditor({
  staged,
  setStaged,
}: {
  staged: LdapMapping[];
  setStaged: React.Dispatch<React.SetStateAction<LdapMapping[]>>;
}) {
  const { t } = useTranslation();
  const { data: mapData } = useLdapMap();
  const [draftDn, setDraftDn] = useState("");
  const [draftRoleId, setDraftRoleId] = useState("");

  // Hydrate staged rows from the server list once loaded (rows are then
  // edited locally; Save commits the whole list). setStaged is a stable
  // useState setter from the parent, listed explicitly to satisfy
  // exhaustive-deps without a disable (React-compiler-safe).
  useEffect(() => {
    if (mapData?.mappings) setStaged(mapData.mappings);
  }, [mapData, setStaged]);

  // The admin-role warning (D-10) keys on the role NAME — DEFAULT_ADMIN_ROLE
  // is seeded with name "admin" (packages/shared/src/constants/permissions.ts).
  const [roles, setRoles] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    apiGet<Array<{ id: string; name: string }>>("/roles")
      .then((data) => {
        if (!cancelled) setRoles(data);
      })
      .catch(() => {
        // Non-fatal: the mapping editor still renders without role names —
        // the Select falls back to raw ids (server-side validation owns the
        // truth; client-side labeling is UX only).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const adminRoleIds = (Array.isArray(roles) ? roles : [])
    .filter((r) => r.name === "admin")
    .map((r) => r.id);
  const hasAdminWarning = staged.some((row) => adminRoleIds.includes(row.roleId));

  // Client-side dedupe of (dn, roleId) pairs (the @@unique contract) —
  // duplicates are prevented at stage time; the server still validates.
  const isDuplicatePair = staged.some(
    (row) =>
      row.ldapGroupDn.toLowerCase() === draftDn.trim().toLowerCase() &&
      row.roleId === draftRoleId,
  );
  const canAdd = draftDn.trim().length > 0 && draftRoleId.length > 0 && !isDuplicatePair;

  const addRow = () => {
    if (!canAdd) return;
    setStaged([...staged, { ldapGroupDn: draftDn.trim(), roleId: draftRoleId }]);
    setDraftDn("");
    setDraftRoleId("");
  };

  const removeRow = (index: number) => {
    // NO confirm dialog — staged locally, committed on Save (UI-SPEC).
    setStaged(staged.filter((_, i) => i !== index));
  };

  return (
    <div className="border-t border-input pt-6 space-y-4">
      <div>
        {/* Route A exemption — the ScimSection heading idiom reused verbatim. */}
        <h3 className="text-lg font-semibold text-foreground">
          {t("settings.sso.ldap.mapTitle")}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settings.sso.ldap.mapDescription")}
        </p>
      </div>

      {staged.length === 0 ? (
        <div className="rounded-lg border border-input bg-muted/30 p-4 space-y-2">
          <p className="text-sm font-medium text-foreground">
            {t("settings.sso.ldap.mapEmptyTitle")}
          </p>
          <p className="text-xs text-muted-foreground">{t("settings.sso.ldap.mapEmptyBody")}</p>
          <Button size="sm" onClick={addRow} disabled={!canAdd}>
            <Plus className="w-4 h-4" />
            {t("settings.sso.ldap.addMapping")}
          </Button>
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.sso.ldap.groupDn")}</TableHead>
                <TableHead>{t("settings.users.roleLabel")}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {staged.map((row, index) => (
                <TableRow key={`${row.ldapGroupDn}-${row.roleId}-${index}`}>
                  <TableCell>
                    {/* Long DNs scroll horizontally inside the single-line
                        input (UI-SPEC long-text backstop — no wrap, no
                        collapsed siblings). */}
                    <AppInput
                      aria-label={t("settings.sso.ldap.groupDn")}
                      value={row.ldapGroupDn}
                      onChange={(e) => {
                        const next = [...staged];
                        next[index] = { ...row, ldapGroupDn: e.target.value };
                        setStaged(next);
                      }}
                      className="font-mono overflow-x-auto whitespace-nowrap"
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={row.roleId}
                      onValueChange={(value) => {
                        const next = [...staged];
                        next[index] = { ...row, roleId: value };
                        setStaged(next);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Array.isArray(roles) ? roles : []).map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeRow(index)}
                          aria-label={t("settings.sso.ldap.removeMapping")}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {t("settings.sso.ldap.removeMapping")}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Add row (stages another blank row). */}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <AppInput
                label={t("settings.sso.ldap.groupDn")}
                value={draftDn}
                onChange={(e) => setDraftDn(e.target.value)}
                placeholder="cn=ldap-admins,ou=groups,dc=example,dc=com"
                className="font-mono"
              />
            </div>
            <div className="w-48">
              <label className="text-sm font-medium text-muted-foreground">
                {t("settings.users.roleLabel")}
              </label>
              <Select value={draftRoleId} onValueChange={(value) => setDraftRoleId(value)}>
                <SelectTrigger className="w-full mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Array.isArray(roles) ? roles : []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" onClick={addRow} disabled={!canAdd}>
              <Plus className="w-4 h-4" />
              {t("settings.sso.ldap.addMapping")}
            </Button>
          </div>
          {isDuplicatePair && (
            <p className="text-xs text-destructive">{t("settings.sso.ldap.duplicateMapping")}</p>
          )}

          {/* D-10 — the advisory amber alert (NOT destructive, NOT accent);
              save remains possible (explicit admin action). */}
          {hasAdminWarning && (
            <Alert variant="default" className="text-amber-500">
              <AlertDescription className="text-xs">
                {t("settings.sso.ldap.mapAdminWarning")}
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Phase 193 (D-16) — test-connection diagnostics. The Test button calls
 * useTestLdapConnection; results render the 4-row structured checklist
 * (Check/X icons per UI-SPEC) inside the info-box idiom. T-193-12: stage
 * NAMES only — NO raw LDAP server error strings are ever rendered.
 */
function LdapDiagnostics({
  result,
  error,
  pending,
}: {
  result: LdapTestResult | null;
  error: boolean;
  pending: boolean;
}) {
  const { t } = useTranslation();

  const rows: Array<{ key: keyof Omit<LdapTestResult, "groupCount">; label: string }> = [
    { key: "reachable", label: t("settings.sso.ldap.diag.reachable") },
    { key: "bindOk", label: t("settings.sso.ldap.diag.bindOk") },
    { key: "userFound", label: t("settings.sso.ldap.diag.userFound") },
    { key: "groupsFound", label: t("settings.sso.ldap.diag.groupsFound") },
  ];

  // A THROWN call (request itself failed) renders the overall banner arm —
  // stage NAMES only; the raw error string never crosses (T-193-12).
  if (!result && !error) return null;

  return (
    <div className="rounded-lg border border-input bg-muted/30 p-4 space-y-2">
      {/* reachable=false (or a thrown call) ⇒ the overall banner (stage
          names only, no raw server strings — D-15/D-16). */}
      {(!result || !result.reachable) && (
        <p className="text-sm font-medium text-destructive">
          {t("settings.sso.ldap.testFailed")}
        </p>
      )}
      {result &&
        rows.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-2 text-sm">
            {result[key] ? (
              <Check className="w-4 h-4 text-primary" aria-hidden="true" />
            ) : (
              <X className="w-4 h-4 text-destructive" aria-hidden="true" />
            )}
            <span className="text-sm text-foreground">{label}</span>
          </div>
        ))}
      {pending && (
        <p className="text-xs text-muted-foreground">
          {t("settings.sso.ldap.testPending")}
        </p>
      )}
    </div>
  );
}