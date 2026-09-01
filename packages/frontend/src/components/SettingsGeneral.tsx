// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { showSuccess, showError } from "../lib/toast";
import { useMe } from "../queries/useAuth";
import { apiGet } from "../utils/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ALL_LANGUAGES, getEnabledLanguages, setEnabledLanguages, type LanguageCode } from "../i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { getErrorMessage } from "../utils/errorUtils";

/**
 * SettingsGeneral — split into three independently-rendered sub-sections so
 * SettingsPage can place each under a different menu voice:
 *
 *   <SettingsGeneralDlp />        → Avanzate · DLP
 *   <SettingsGeneralLanguages />  → Profilo · Lingue disponibili
 *   <SettingsGeneralResetDb />    → Avanzate · Reset DB
 *
 * The branding controls that used to live here moved to SettingsAppearance
 * (Feature 8 Slice B). `ReadOnlyBadge` is still exported from here —
 * SettingsVectorDB / SettingsAppearance / SettingsLLM reuse it.
 */

/** Avanzate · DLP — toggle redaction of sensitive patterns from prompts + per-role bypass (260829-n95, spec §2.2). */
export function SettingsGeneralDlp() {
  const { t } = useTranslation();
  const { getValue } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();

  const [dlpEnabled, setDlpEnabled] = useState(true);
  // 260829-n95: bypass roles local state — mirrors the toggle pattern
  // (init from settings query, flip optimistically, revert on save error).
  const [bypassRoles, setBypassRoles] = useState<string[]>([]);
  const [savingRoles, setSavingRoles] = useState(false);

  // Role list for the multi-select — same GET /roles the admin Roles tab
  // uses (apiGet pattern from SettingsRoles).
  const [allRoles, setAllRoles] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    apiGet<Array<{ id: string; name: string }>>("/roles")
      .then(setAllRoles)
      .catch(() => setAllRoles([]));
  }, []);

  // Settings-reader values hoisted to stable locals so the effect deps are
  // statically checkable (react-hooks/exhaustive-deps — same pattern 3 as
  // the original toggle effect, extended to the bypass key in 260829-n95).
  const dlpSetting = getValue("DLP_ENABLED");
  const bypassSetting = getValue("DLP_BYPASS_ROLES");

  useEffect(() => {
    setDlpEnabled(dlpSetting !== "false");
    // 260829-n95: parse the bypass list (JSON array of role names) with a
    // safe fallback — a malformed value renders as empty, never crashes.
    try {
      const parsed: unknown = JSON.parse(bypassSetting || "[]");
      setBypassRoles(Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : []);
    } catch {
      setBypassRoles([]);
    }
  }, [dlpSetting, bypassSetting]);

  const handleDlpToggle = async (checked: boolean) => {
    setDlpEnabled(checked);
    try {
      await updateSettings([{ key: "DLP_ENABLED", value: String(checked) }]);
    } catch {
      setDlpEnabled(!checked);
    }
  };

  // 260829-n95: toggle one role in the bypass list and persist the FULL
  // JSON array body: value is a JSON-encoded string of role-name strings —
  // `["role_a","role_b"]` — matching the server-side safe-parse contract.
  const handleBypassRoleToggle = async (roleName: string, checked: boolean) => {
    const next = checked
      ? [...bypassRoles, roleName]
      : bypassRoles.filter((r) => r !== roleName);
    const prev = bypassRoles;
    setBypassRoles(next);
    setSavingRoles(true);
    try {
      await updateSettings([{ key: "DLP_BYPASS_ROLES", value: JSON.stringify(next) }]);
    } catch {
      setBypassRoles(prev);
    } finally {
      setSavingRoles(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-foreground">
            {t("settings.generalTab.dlp.sectionTitle")}
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            {t("settings.generalTab.dlp.description1")}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.generalTab.dlp.description2")}
          </p>
          <p className="text-xs text-muted-foreground mt-1.5 italic">
            {t("settings.generalTab.dlp.hint")}
          </p>
        </div>
        <Switch
          checked={dlpEnabled}
          onCheckedChange={handleDlpToggle}
          aria-label={t("settings.generalTab.dlp.sectionTitle")}
        />
      </div>
      <p className="text-xs font-medium mt-2 text-muted-foreground">
        {dlpEnabled
          ? t("settings.generalTab.dlp.enabled")
          : t("settings.generalTab.dlp.disabled")}
      </p>

      {dlpEnabled && (
        <div className="mt-4 border-t border-border pt-3" data-testid="dlp-bypass-section">
          <h4 className="text-sm font-medium text-foreground">
            {t("settings.generalTab.dlp.bypass.title")}
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            {t("settings.generalTab.dlp.bypass.description")}
          </p>
          {allRoles.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
              {allRoles.map((role) => (
                <div key={role.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`dlp-bypass-${role.id}`}
                    checked={bypassRoles.includes(role.name)}
                    onCheckedChange={(val) => handleBypassRoleToggle(role.name, Boolean(val))}
                    disabled={savingRoles}
                    aria-label={role.name}
                  />
                  <label
                    htmlFor={`dlp-bypass-${role.name}`}
                    className="text-sm cursor-pointer select-none text-foreground"
                  >
                    {role.name}
                  </label>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground mt-2">
              {t("settings.generalTab.dlp.bypass.noRoles")}
            </p>
          )}
          <p className="text-xs font-medium text-destructive mt-3">
            {t("settings.generalTab.dlp.bypass.warning")}
          </p>
        </div>
      )}
    </div>
  );
}

/** Profilo · Lingue disponibili — per-instance enabled-language set. */
export function SettingsGeneralLanguages() {
  const { t } = useTranslation();
  const [enabledLanguages, setEnabledLanguagesState] = useState<LanguageCode[]>(getEnabledLanguages());

  const handleLanguageToggle = (code: LanguageCode, checked: boolean) => {
    const next = checked
      ? [...enabledLanguages, code]
      : enabledLanguages.filter((c) => c !== code);
    if (next.length === 0) return;
    setEnabledLanguagesState(next);
    setEnabledLanguages(next);
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <h4 className="text-sm font-medium text-foreground mb-2">
        {t("settings.generalTab.i18n.sectionTitle")}
      </h4>
      <p className="text-xs text-muted-foreground mb-3">
        {t("settings.generalTab.i18n.description")}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {ALL_LANGUAGES.map((lang) => {
          const checked = enabledLanguages.includes(lang.code);
          const isLast = checked && enabledLanguages.length === 1;
          return (
            <div key={lang.code} className="flex items-center gap-2">
              <Checkbox
                id={`lang-${lang.code}`}
                checked={checked}
                onCheckedChange={(val) => handleLanguageToggle(lang.code, Boolean(val))}
                disabled={isLast}
                aria-label={lang.name}
              />
              <label
                htmlFor={`lang-${lang.code}`}
                className={
                  "text-sm cursor-pointer select-none " +
                  (isLast ? "text-muted-foreground opacity-60" : "text-foreground")
                }
              >
                {lang.name}
              </label>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground mt-3 italic">
        {t("settings.generalTab.i18n.hint")}
      </p>
    </div>
  );
}

/** Avanzate · Reset DB — destructive recovery tool behind typed "RESET" dialog. */
export function SettingsGeneralResetDb() {
  const { t } = useTranslation();
  const { data: user } = useMe();
  const isAdmin = user?.roles.some((r) => r.name === "admin") ?? false;

  const [showResetModal, setShowResetModal] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetting, setResetting] = useState(false);

  const handleResetDB = async () => {
    setResetting(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/system/reset-db", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ confirm: "RESET" }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Reset failed");
      }
      showSuccess(t("settings.generalTab.resetDatabaseSuccess"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.generalTab.resetDatabaseFailed")));
    } finally {
      setResetting(false);
      setShowResetModal(false);
      setResetConfirm("");
    }
  };

  if (!isAdmin) return null;

  return (
    <>
      <div className="pt-2">
        <p className="text-sm text-muted-foreground mt-1">
          {t("settings.generalTab.resetDatabaseDescription")}
        </p>
        <p className="text-sm font-medium text-destructive mt-2">
          {t("settings.generalTab.resetDatabaseWarning")}
        </p>
        <div className="mt-4">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowResetModal(true)}
          >
            {t("settings.generalTab.resetDatabaseButton")}
          </Button>
        </div>
      </div>

      <Dialog
        open={showResetModal}
        onOpenChange={(open) => {
          if (!open) {
            setShowResetModal(false);
            setResetConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {t("settings.generalTab.resetDatabase")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t("settings.generalTab.resetDatabaseDescription")}
          </p>
          <p className="text-xs font-medium text-destructive">
            {t("settings.generalTab.resetDatabaseWarning")}
          </p>
          <div className="space-y-2">
            <Label htmlFor="reset-confirm">
              {t("settings.generalTab.resetDatabaseConfirm")}
            </Label>
            <Input
              id="reset-confirm"
              type="text"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              placeholder="RESET"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleResetDB}
              disabled={resetting || resetConfirm !== "RESET"}
            >
              {resetting
                ? t("common.saving")
                : t("settings.generalTab.resetDatabaseButton")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowResetModal(false);
                setResetConfirm("");
              }}
            >
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReadOnlyBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className="text-xs" title={t("settings.readOnly")}>
      {t("settings.generalTab.envBadge")}
    </Badge>
  );
}

// D-08 (Phase 176): muted hint for "env var set for this key, but the DB
// value wins". Presence text only — never renders an env var value (T-176-01).
function EnvOverriddenBadge() {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className="text-xs text-muted-foreground"
      title={t("settings.envOverridden")}
    >
      {t("settings.envOverriddenBadge")}
    </Badge>
  );
}

export { ReadOnlyBadge, EnvOverriddenBadge };