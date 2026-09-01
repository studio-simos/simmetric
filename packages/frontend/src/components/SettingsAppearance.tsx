// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme, type Theme } from "../contexts/ThemeContext";
import { useSettingsHelpers, useUpdateSettings, useUploadBrandingIcon, useDeleteBrandingIcon } from "../queries/useSettings";
import { useFeature } from "../hooks/useFeature";
import { showSuccess, showError, showInfo } from "../lib/toast";
import { ApiError } from "../utils/api";
import {
  type UiFontScale,
  UI_FONT_SCALE_KEY,
  readUiFontScale,
  applyUiFontScale,
} from "../lib/uiFontScale";
import {
  type Density,
  UI_DENSITY_KEY,
  readDensity,
  applyDensity,
} from "../lib/uiDensity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import UpgradePrompt from "./UpgradePrompt";
import { ReadOnlyBadge, EnvOverriddenBadge } from "./SettingsGeneral";
import { Check } from "lucide-react";

/**
 * SettingsAppearance — Feature 3.4b (UI_DESIGN.md).
 *
 * Appearance preferences, grouped into 5 controls:
 *
 *  - Theme: light / dark / hacker / system, driven by ThemeContext (the same
 *    provider that toggles `.dark` + `.theme-hacker` on <html>).
 *  - Accent color: the white-label BRANDING_PRIMARY_COLOR, persisted via the
 *    standard settings PUT and broadcast live with a `branding-changed`
 *    CustomEvent (consumed by App.tsx → applyPrimaryColor). Community tier
 *    (no `white_label` flag) sees an UpgradePrompt instead of the picker.
 *  - UI font size: a localStorage-only UI-wide font scale (sm/md/lg) applied as
 *    the `--ui-font-scale` CSS var on <html>. Deliberately distinct from the
 *    per-user chat `textSize` (managed in SettingsProfile) — this scales the
 *    chrome, not the conversation body.
 *  - Density: compact / comfortable, localStorage-only, toggles a
 *    `density-compact` class on <html> (CSS tightens paddings/gaps).
 *  - Branding (Feature 8 Slice B): app name + app subtitle + app icon, moved
 *    here from SettingsGeneral so all white-label BRANDING_* keys live in one
 *    place next to the accent picker that already owns BRANDING_PRIMARY_COLOR.
 *    App name/subtitle persist via the settings PUT; the icon uploads through
 *    the dedicated /api/system/settings/branding/icon endpoint. A live header
 *    preview mirrors the AppSidebar branding block. Community tier sees an
 *    UpgradePrompt instead of the form.
 *
 * The two localStorage-backed controls are intentionally client-only: they are
 * cosmetic shell preferences, not per-user data, and keeping them out of the
 * DB avoids a schema change and a round-trip on every toggle. They degrade
 * gracefully for SSR (guarded by `typeof document`).
 *
 * The bootstrap application of the saved font scale + density (FOUC-safe,
 * pre-React-render) lives in `../lib/uiFontScale` and `../lib/uiDensity` —
 * imported for their side effect in `main.tsx` before `<App />` mounts. This
 * component imports the same modules as the single source of truth for the
 * types + helpers, and only retains the user-driven on-change apply + persist
 * effects below. The previous mount-only `useEffect(() => { applyUiFontScale
 * (uiFontScale); applyDensity(density); }, [])` is no longer needed because
 * the module-level init in main.tsx already applied the saved value before
 * React render (FONT-01).
 */

// ── Accent color presets ──────────────────────────────────────────────────
const ACCENT_PRESETS = [
  "#973C00", // brand orange (default)
  "#4c6ef5", // indigo
  "#00ff9c", // hacker neon green
  "#00d4ff", // cyan
  "#22c55e", // green
  "#f97316", // orange
  "#ec4899", // pink
  "#a855f7", // purple
  "#ef4444", // red
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

// Allowed MIME types for the branding icon upload (must match server-side guard).
const ICON_ALLOWED_MIME = ["image/png", "image/svg+xml", "image/x-icon", "image/webp"];
const ICON_MAX_BYTES = 1_000_000;

export default function SettingsAppearance() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { getValue, isReadOnly, isEnvOverridden } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();
  const { mutateAsync: uploadIcon } = useUploadBrandingIcon();
  const { mutateAsync: deleteIcon } = useDeleteBrandingIcon();
  const canWhiteLabel = useFeature("white_label");

  const [accentDraft, setAccentDraft] = useState(() => getValue("BRANDING_PRIMARY_COLOR") || "#973C00");
  const [savingAccent, setSavingAccent] = useState(false);
  const [uiFontScale, setUiFontScaleState] = useState<UiFontScale>(readUiFontScale);
  const [density, setDensityState] = useState<Density>(readDensity);

  // ── Branding (moved from SettingsGeneral, Feature 8 Slice B) ───────────
  const [appNameDraft, setAppNameDraft] = useState(() => getValue("BRANDING_APP_NAME") || "");
  const [appSubtitleDraft, setAppSubtitleDraft] = useState(() => getValue("BRANDING_APP_SUBTITLE") || "");
  const [iconPreview, setIconPreview] = useState(() => getValue("BRANDING_APP_ICON_URL") || "");
  // Cache-busting token for the app icon <img>. The server persists the icon at
  // a stable URL, so a replacement at the same path would show a stale cached
  // image. The bust is bumped on every upload (Feature 8 Slice C) and applied
  // at render time — kept separate from `iconPreview` because the settings
  // query invalidation (see useUploadBrandingIcon) repopulates `iconPreview`
  // with the raw URL, which would otherwise strip the cache-bust.
  const [iconBust, setIconBust] = useState(
    () => Number(localStorage.getItem("branding-icon-bust")) || 0,
  );
  const iconDisplaySrc = iconPreview
    ? iconBust > 0
      ? iconPreview.includes("?")
        ? `${iconPreview}&t=${iconBust}`
        : `${iconPreview}?t=${iconBust}`
      : iconPreview
    : "";
  const [savingBranding, setSavingBranding] = useState(false);
  const [iconUploading, setIconUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep the accent draft in sync when the server value loads/changes.
  useEffect(() => {
    const v = getValue("BRANDING_PRIMARY_COLOR");
    if (v && HEX_RE.test(v)) setAccentDraft(v);
  }, [getValue]);

  // Keep branding drafts in sync when the server values load/change.
  useEffect(() => {
    setAppNameDraft(getValue("BRANDING_APP_NAME") || "");
    setAppSubtitleDraft(getValue("BRANDING_APP_SUBTITLE") || "");
    setIconPreview(getValue("BRANDING_APP_ICON_URL") || "");
    // `getValue` is a settings-reader helper recreated each render from the
    // settings query; the actual dependency values it returns for the three
    // BRANDING keys are already inlined as deps below, so listing `getValue`
    // itself would force a re-run every render (it is not a stable ref).
    // (D-05 pattern 3 — intentional, documented.)
  }, [getValue("BRANDING_APP_NAME"), getValue("BRANDING_APP_SUBTITLE"), getValue("BRANDING_APP_ICON_URL")]);

  // Apply + persist UI font scale.
  useEffect(() => {
    applyUiFontScale(uiFontScale);
    localStorage.setItem(UI_FONT_SCALE_KEY, uiFontScale);
  }, [uiFontScale]);

  // Apply + persist density.
  useEffect(() => {
    applyDensity(density);
    localStorage.setItem(UI_DENSITY_KEY, density);
  }, [density]);

  // Note: the bootstrap (mount-only) apply of uiFontScale + density that used
  // to live here is no longer needed — the FOUC-safe module-level init in
  // `lib/uiFontScale.ts` / `lib/uiDensity.ts` (imported by main.tsx before
  // <App /> mounts) applies the saved value before React render. The two
  // effects above remain because they handle the user-driven on-change case
  // (state changed in this component → apply + persist). See FONT-01.

  const saveAccent = async (hex: string) => {
    if (!HEX_RE.test(hex)) {
      showError(t("settings.appearance.accentInvalid"));
      return;
    }
    if (isReadOnly("BRANDING_PRIMARY_COLOR")) return; // community gate
    setSavingAccent(true);
    try {
      await updateSettings([{ key: "BRANDING_PRIMARY_COLOR", value: hex }]);
      // Broadcast live so App.tsx applies the color without a reload.
      window.dispatchEvent(
        new CustomEvent("branding-changed", { detail: { primaryColor: hex } }),
      );
      showSuccess(t("settings.appearance.accentSaved"));
    } catch {
      showError(t("settings.appearance.accentError"));
    } finally {
      setSavingAccent(false);
    }
  };

  const saveBranding = async () => {
    const configs = [];
    if (!isReadOnly("BRANDING_APP_NAME")) configs.push({ key: "BRANDING_APP_NAME", value: appNameDraft });
    if (!isReadOnly("BRANDING_APP_SUBTITLE")) configs.push({ key: "BRANDING_APP_SUBTITLE", value: appSubtitleDraft });

    if (configs.length === 0) {
      showInfo(t("settings.appearance.branding.noEditableSettings"));
      return;
    }
    setSavingBranding(true);
    try {
      const result = await updateSettings(configs);
      const brandingRejected = result.rejected.filter((k: string) => k.startsWith("BRANDING_"));
      if (brandingRejected.length > 0) {
        showError(t("settings.appearance.branding.enterpriseRequired"));
      } else if (result.rejected.length > 0) {
        showError(t("settings.appearance.branding.readOnlyRejected", { keys: result.rejected.join(", ") }));
      } else {
        showSuccess(t("settings.appearance.branding.saved"));
      }
      // Apply branding in real-time.
      window.dispatchEvent(new CustomEvent("branding-changed", {
        detail: { appName: appNameDraft, appSubtitle: appSubtitleDraft },
      }));
    } catch {
      showError(t("settings.appearance.branding.saveFailed"));
    } finally {
      setSavingBranding(false);
    }
  };

  const handleIconUpload = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    if (!ICON_ALLOWED_MIME.includes(file.type) || file.size > ICON_MAX_BYTES) {
      showError(t("settings.appearance.branding.appIconInvalid"));
      return;
    }
    setIconUploading(true);
    try {
      // Use the URL returned by the server (persisted) rather than a throwaway
      // blob: URL — the previous SettingsGeneral impl hardcoded the path and
      // used URL.createObjectURL, which broke on reload. Slice C will add
      // cache-busting on top of this.
      const { url } = await uploadIcon(file);
      // Bump the cache-bust so every <img> consuming the icon (the live
      // preview here + AppSidebar header via the branding-changed event)
      // re-fetches the freshly written file instead of serving the stale
      // cached version at the same URL (Feature 8 Slice C).
      const bust = Date.now();
      setIconBust(bust);
      localStorage.setItem("branding-icon-bust", String(bust));
      setIconPreview(url);
      showSuccess(t("settings.appearance.branding.saved"));
      window.dispatchEvent(new CustomEvent("branding-changed", { detail: { appIconUrl: url, iconBust: bust } }));
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        showError(t("settings.appearance.branding.iconEnterpriseRequired") || "Branding icon upload requires the Enterprise plugin.");
      } else {
        showError(t("settings.appearance.branding.saveFailed"));
      }
    } finally {
      setIconUploading(false);
    }
  };

  const handleIconRemove = async () => {
    setIconUploading(true);
    try {
      await deleteIcon();
      setIconPreview("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      showSuccess(t("settings.appearance.branding.appIconRemoved"));
      window.dispatchEvent(new CustomEvent("branding-changed", { detail: { appIconUrl: "" } }));
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        showError(t("settings.appearance.branding.iconEnterpriseRequired") || "Branding icon upload requires the Enterprise plugin.");
      } else {
        showError(t("settings.appearance.branding.saveFailed"));
      }
    } finally {
      setIconUploading(false);
    }
  };

  const themeOptions: { value: Theme; labelKey: string; hintKey: string }[] = [
    { value: "light", labelKey: "settings.appearance.themeLight", hintKey: "settings.appearance.themeLightHint" },
    { value: "dark", labelKey: "settings.appearance.themeDark", hintKey: "settings.appearance.themeDarkHint" },
    { value: "hacker", labelKey: "settings.appearance.themeHacker", hintKey: "settings.appearance.themeHackerHint" },
    { value: "system", labelKey: "settings.appearance.themeSystem", hintKey: "settings.appearance.themeSystemHint" },
  ];

  const fontOptions: { value: UiFontScale; labelKey: string }[] = [
    { value: "sm", labelKey: "settings.appearance.fontSmall" },
    { value: "md", labelKey: "settings.appearance.fontMedium" },
    { value: "lg", labelKey: "settings.appearance.fontLarge" },
  ];

  const densityOptions: { value: Density; labelKey: string }[] = [
    { value: "comfortable", labelKey: "settings.appearance.densityComfortable" },
    { value: "compact", labelKey: "settings.appearance.densityCompact" },
  ];

  return (
    <div className="space-y-8 max-w-2xl">
      {/* ── Theme ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t("settings.appearance.themeTitle")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.appearance.themeDesc")}
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {themeOptions.map((opt) => {
            const active = theme === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTheme(opt.value)}
                aria-pressed={active}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-left transition-theme",
                  active
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-input bg-card/40 text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="block text-sm font-medium">{t(opt.labelKey)}</span>
                <span className="block text-[11px] text-muted-foreground mt-0.5">
                  {t(opt.hintKey)}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Accent color ─────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t("settings.appearance.accentTitle")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.appearance.accentDesc")}
          </p>
        </div>
        <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {ACCENT_PRESETS.map((hex) => {
                const active = accentDraft.toLowerCase() === hex.toLowerCase();
                return (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => {
                      setAccentDraft(hex);
                      saveAccent(hex);
                    }}
                    aria-label={hex}
                    aria-pressed={active}
                    className={cn(
                      "h-8 w-8 rounded-full border-2 flex items-center justify-center transition-transform hover:scale-110",
                      active ? "border-foreground" : "border-transparent",
                    )}
                    style={{ backgroundColor: hex }}
                  >
                    {active && <Check className="w-4 h-4 text-white mix-blend-difference" />}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="accent-custom" className="text-xs text-muted-foreground">
                {t("settings.appearance.accentCustom")}
              </Label>
              <Input
                id="accent-custom"
                type="color"
                value={accentDraft}
                onChange={(e) => setAccentDraft(e.target.value)}
                onBlur={(e) => saveAccent(e.target.value)}
                className="h-9 w-16 shrink-0 p-1 cursor-pointer"
                aria-label={t("settings.appearance.accentCustom")}
              />
              <Input
                type="text"
                value={accentDraft}
                onChange={(e) => setAccentDraft(e.target.value)}
                onBlur={(e) => saveAccent(e.target.value)}
                className="h-9 flex-1 min-w-0 font-mono text-xs"
                placeholder="#973C00"
                aria-label={t("settings.appearance.accentHex")}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveAccent(accentDraft)}
                disabled={savingAccent || isReadOnly("BRANDING_PRIMARY_COLOR")}
                className="shrink-0"
              >
                {savingAccent ? t("settings.appearance.saving") : t("settings.appearance.apply")}
              </Button>
            </div>
          </div>
      </section>

      {/* ── UI font size ─────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t("settings.appearance.fontTitle")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.appearance.fontDesc")}
          </p>
        </div>
        <div className="flex gap-2">
          {fontOptions.map((opt) => {
            const active = uiFontScale === opt.value;
            return (
              <Button
                key={opt.value}
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() => setUiFontScaleState(opt.value)}
                aria-pressed={active}
              >
                {t(opt.labelKey)}
              </Button>
            );
          })}
        </div>
      </section>

      {/* ── Density ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t("settings.appearance.densityTitle")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.appearance.densityDesc")}
          </p>
        </div>
        <div className="flex gap-2">
          {densityOptions.map((opt) => {
            const active = density === opt.value;
            return (
              <Button
                key={opt.value}
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() => setDensityState(opt.value)}
                aria-pressed={active}
              >
                {t(opt.labelKey)}
              </Button>
            );
          })}
        </div>
      </section>

      {/* ── Branding (moved from SettingsGeneral, Feature 8 Slice B) ─── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t("settings.appearance.branding.title")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.appearance.branding.desc")}
          </p>
        </div>
        {!canWhiteLabel ? (
          <UpgradePrompt feature="white_label" />
        ) : (
          <div className="space-y-4">
            {/* App Name */}
            <div className="space-y-1.5">
              <Label htmlFor="branding-app-name">
                {t("settings.appearance.branding.appNameLabel")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="branding-app-name"
                  type="text"
                  value={appNameDraft}
                  onChange={(e) => setAppNameDraft(e.target.value)}
                  placeholder={t("settings.appearance.branding.appNamePlaceholder")}
                  disabled={isReadOnly("BRANDING_APP_NAME")}
                  className="flex-1"
                />
                {isReadOnly("BRANDING_APP_NAME") ? (
                  <ReadOnlyBadge />
                ) : (
                  isEnvOverridden("BRANDING_APP_NAME") && <EnvOverriddenBadge />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.appearance.branding.appNameHint")}
              </p>
            </div>

            {/* App Subtitle */}
            <div className="space-y-1.5">
              <Label htmlFor="branding-app-subtitle">
                {t("settings.appearance.branding.appSubtitleLabel")}
              </Label>
              <Input
                id="branding-app-subtitle"
                type="text"
                value={appSubtitleDraft}
                onChange={(e) => setAppSubtitleDraft(e.target.value)}
                placeholder={t("settings.appearance.branding.appSubtitlePlaceholder")}
                disabled={isReadOnly("BRANDING_APP_SUBTITLE")}
                className="flex-1"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.appearance.branding.appSubtitleHint")}
              </p>
            </div>

            {/* App Icon upload / preview */}
            <div className="space-y-1.5">
              <Label>{t("settings.appearance.branding.appIconLabel")}</Label>
              <div className="flex items-center gap-3">
                {iconPreview ? (
                  <img
                    src={iconDisplaySrc}
                    alt={t("settings.appearance.branding.appIconLabel")}
                    className="app-icon h-10 w-10 rounded-md object-cover"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-md border border-dashed border-border flex items-center justify-center text-muted-foreground text-xs">
                    —
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/svg+xml,image/x-icon,image/webp"
                  className="hidden"
                  onChange={handleIconUpload}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={iconUploading || isReadOnly("BRANDING_APP_ICON_URL")}
                >
                  {iconUploading
                    ? t("settings.appearance.branding.appIconUploading")
                    : t("settings.appearance.branding.appIconUpload")}
                </Button>
                {iconPreview ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleIconRemove}
                    disabled={iconUploading}
                  >
                    {t("settings.appearance.branding.appIconRemove")}
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.appearance.branding.appIconHint")}
              </p>
            </div>

            {/* Live header preview (mirrors the AppSidebar branding block) */}
            <div className="pt-3 border-t border-input">
              <p className="text-sm font-medium text-muted-foreground mb-2">
                {t("settings.appearance.branding.preview")}
              </p>
              <div className="flex items-center gap-3 p-4 rounded-lg bg-muted border border-input">
                {iconPreview ? (
                  <img
                    src={iconDisplaySrc}
                    alt={t("settings.appearance.branding.appIconLabel")}
                    className="app-icon h-8 w-8 rounded-lg object-cover"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-lg border border-dashed border-border flex items-center justify-center text-muted-foreground text-xs">
                    —
                  </div>
                )}
                <div>
                  <p className="font-semibold text-foreground">
                    {appNameDraft || t("settings.appearance.branding.appNamePlaceholder")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {appSubtitleDraft || t("settings.appearance.branding.previewSubtitle")}
                  </p>
                </div>
              </div>
            </div>

            {/* Save */}
            <div className="pt-1">
              <Button type="button" onClick={saveBranding} disabled={savingBranding}>
                {savingBranding ? t("common.saving") : t("settings.saveChanges")}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}