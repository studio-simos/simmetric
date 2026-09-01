// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useFeature } from "../hooks/useFeature";
import { useSsoConfig, useSaveSsoConfig, useScimBearerToken, useTestScim } from "../queries/useSso";
import { useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import UpgradePrompt from "./UpgradePrompt";
import { Button } from "@/components/ui/button";
import { AppInput, AppTextarea } from "@/components/ui/app";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

function SsoConfigForm() {
  const { t } = useTranslation();
  usePageMeta(t("sso.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.sso") }]);
  const { data: ssoConfig, isError } = useSsoConfig();
  const saveMutation = useSaveSsoConfig();
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
  const [provider, setProvider] = useState<"saml" | "oidc">("oidc");
  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState({
    clientId: "",
    clientSecret: "",
    discoveryUrl: "",
    entryPoint: "",
    cert: "",
    entityId: "",
    redirectUri: "",
  });
  const [message, setMessage] = useState<string | null>(null);

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
      });
    }
  }, [ssoConfig]);

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
      });
      setMessage(t("common.success"));
    } catch {
      setMessage(t("common.error"));
    }
  };

  const handleTest = async () => {
    setMessage(null);
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
        </div>
      </div>

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
        <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? t("common.loading") : t("common.save")}
        </Button>
        <Button variant="outline" size="sm" onClick={handleTest} disabled={saveMutation.isPending}>
          {t("sso.testConnection")}
        </Button>
      </div>

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