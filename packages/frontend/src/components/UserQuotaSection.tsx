// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 207 (Plan 04 Task 2, D-16): admin quota UI — usage cell, edit dialog,
// manual reset, storage meter. Design contract: 207-UI-SPEC.md (radix-nova
// shadcn, semantic status tokens, spacing/typography per its tables). All
// copy rides the settings.users.quota i18n namespace (8 locales).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiGet, apiPut, apiPost } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import type { QuotaUsage, UpdateQuotaInput } from "@simmetric-chat/shared";

type UsageSource = "override" | "preset" | "unlimited" | "unset";

/** Usage band per UI-SPEC color contract: success <80%, warning ≥80%, destructive over. */
export function quotaBand(used: number, limit: number | null): "success" | "warning" | "destructive" | "none" {
  if (limit == null || limit <= 0) return "none";
  const ratio = used / limit;
  if (ratio > 1) return "destructive";
  if (ratio >= 0.8) return "warning";
  return "success";
}

const BAND_CLASS: Record<string, string> = {
  success: "bg-[var(--success-bg)] text-[var(--success-text)]",
  warning: "bg-[var(--warning-bg)] text-[var(--warning-text)] border border-[var(--warning-border)]",
  destructive: "bg-[var(--error-bg)] text-[var(--error-text)]",
  none: "",
};

/** E1: compact usage cell for the users table — em-dash + tooltip when unset. */
export function QuotaUsageCell({ userId, onManage }: { userId: string; onManage: () => void }) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<QuotaUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<QuotaUsage>(`/api/quota/${userId}`)
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (failed) {
    return (
      <span className="text-xs text-[var(--error-text)]">{t("settings.users.quota.loadFailed")}</span>
    );
  }
  if (!usage) {
    return <span className="text-xs text-muted-foreground">…</span>;
  }
  const tokenBand = quotaBand(usage.tokens.used, usage.tokens.limit);
  const tokenUnset = usage.tokens.source === "unset" || usage.tokens.source === "unlimited";
  const storageUnset = usage.storage?.source === "unset" || usage.storage?.source === "unlimited";
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="quota-cell">
      <button
        type="button"
        className={`rounded px-1.5 py-0.5 text-left ${tokenBand !== "none" ? BAND_CLASS[tokenBand] : "text-muted-foreground"}`}
        onClick={onManage}
        title={tokenUnset ? t("settings.users.quota.unsetTooltip") : undefined}
      >
        {tokenUnset
          ? "—"
          : `${usage.tokens.used.toLocaleString()} / ${usage.tokens.limit!.toLocaleString()}`}
        {usage.tokens.source === "preset" && tokenBand !== "none" ? (
          <span className="ml-1 opacity-70">· {t("settings.users.quota.sourcePreset")}</span>
        ) : null}
      </button>
      {usage.storage ? (
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 text-left ${
            quotaBand(usage.storage.usedBytes, usage.storage.limitGb != null ? usage.storage.limitGb * 1_000_000_000 : null) !== "none"
              ? BAND_CLASS[quotaBand(usage.storage.usedBytes, usage.storage.limitGb != null ? usage.storage.limitGb * 1_000_000_000 : null)]
              : "text-muted-foreground"
          }`}
          onClick={onManage}
          title={storageUnset ? t("settings.users.quota.unsetTooltip") : undefined}
        >
          {storageUnset
            ? "—"
            : `${(usage.storage.usedBytes / 1_000_000_000).toFixed(2)} / ${usage.storage.limitGb} GB`}
        </button>
      ) : null}
    </div>
  );
}

/** E4: storage usage meter — caps at 100% visually; over-limit label destructive. */
export function StorageMeter({ usedBytes, limitGb }: { usedBytes: number; limitGb: number | null }) {
  const { t } = useTranslation();
  if (limitGb == null) {
    return <span className="text-xs text-muted-foreground">{t("settings.users.quota.storageUnset")}</span>;
  }
  const limitBytes = limitGb * 1_000_000_000;
  const ratio = limitBytes > 0 ? usedBytes / limitBytes : 0;
  const band = quotaBand(usedBytes, limitBytes);
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <div className="flex flex-col gap-1" data-testid="storage-meter">
      <div className="h-2 w-full overflow-hidden rounded bg-muted">
        <div className={`h-full ${band === "destructive" ? "bg-[var(--error-text)]" : band === "warning" ? "bg-[var(--warning-border)]" : "bg-[var(--success-text)]"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs ${band === "destructive" ? "text-[var(--error-text)]" : "text-muted-foreground"}`}>
        {usedBytes === 0
          ? t("settings.users.quota.storageEmpty", { limit: limitGb })
          : `${(usedBytes / 1_000_000_000).toFixed(2)} / ${limitGb} GB${ratio > 1 ? ` · ${t("settings.users.quota.overLimit")}` : ""}`}
      </span>
    </div>
  );
}

interface QuotaDialogProps {
  userId: string;
  username: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/** E2/E3: quota edit dialog (resolved-chain placeholders, blank = inherit) + manual reset. */
export function UserQuotaDialog({ userId, username, open, onOpenChange, onSaved }: QuotaDialogProps) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<QuotaUsage | null>(null);
  const [tokenLimit, setTokenLimit] = useState("");
  const [storageGb, setStorageGb] = useState("");
  const [tokenUnlimited, setTokenUnlimited] = useState(false);
  const [storageUnlimited, setStorageUnlimited] = useState(false);
  const [anchorDate, setAnchorDate] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    apiGet<QuotaUsage>(`/api/quota/${userId}`)
      .then((u) => setUsage(u))
      .catch(() => showError(t("settings.users.quota.loadFailed")));
  }, [open, userId, t]);

  if (!open) return null;

  const sourceLabel = (s: UsageSource) =>
    s === "override"
      ? t("settings.users.quota.sourceOverride")
      : s === "preset"
        ? t("settings.users.quota.sourcePreset")
        : s === "unlimited"
          ? t("settings.users.quota.sourceUnlimited")
          : t("settings.users.quota.sourceUnset");

  const parseLimit = (raw: string): number | null => {
    if (raw.trim() === "") return null; // blank = inherit
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      setFieldError(t("settings.users.quota.invalidTokenLimit"));
      throw new Error("invalid");
    }
    return n;
  };
  const parseGb = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      setFieldError(t("settings.users.quota.invalidStorageGb"));
      throw new Error("invalid");
    }
    return n;
  };

  const handleSave = async () => {
    setFieldError(null);
    let payload: UpdateQuotaInput;
    try {
      payload = {
        tokenQuotaLimit: parseLimit(tokenLimit),
        storageQuotaGb: parseGb(storageGb),
        tokenQuotaUnlimited: tokenUnlimited,
        storageQuotaUnlimited: storageUnlimited,
        resetAnchorDate: anchorDate ? new Date(anchorDate).toISOString() : null,
      };
    } catch {
      return; // field error already set
    }
    setSaving(true);
    try {
      const updated = await apiPut<QuotaUsage>(`/api/quota/${userId}`, payload);
      setUsage(updated);
      showSuccess(t("settings.users.quota.saveSuccess"));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      showError(t("settings.users.quota.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await apiPost(`/api/quota/${userId}/reset`, { kind: "tokens" });
      const updated = await apiGet<QuotaUsage>(`/api/quota/${userId}`);
      setUsage(updated);
      showSuccess(t("settings.users.quota.resetSuccess"));
      setResetConfirmOpen(false);
      onSaved();
    } catch {
      showError(t("settings.users.quota.resetFailed"));
    } finally {
      setSaving(false);
    }
  };

  const tokenUnsetHere = usage?.tokens.source === "unset" || usage?.tokens.source === "unlimited";
  const storageUnsetHere = usage?.storage?.source === "unset" || usage?.storage?.source === "unlimited";
  const hasActiveTokenQuota = usage?.tokens.limit != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.users.quota.dialogTitle", { username })}</DialogTitle>
          <DialogDescription>{t("settings.users.quota.dialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="tokenQuotaLimit">{t("settings.users.quota.tokenLimitLabel")}</Label>
              {usage ? <Badge variant="outline" className="text-[10px]">{sourceLabel(usage.tokens.source)}</Badge> : null}
            </div>
            <Input
              id="tokenQuotaLimit"
              type="number"
              min={0}
              placeholder={tokenUnsetHere ? t("settings.users.quota.noPresetPlaceholder") : usage?.tokens.limit != null ? String(usage.tokens.limit) : t("settings.users.quota.noPresetPlaceholder")}
              value={tokenLimit}
              onChange={(e) => setTokenLimit(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("settings.users.quota.blankInherits")}</p>
            <div className="flex items-center gap-2">
              <Switch id="tokenUnlimited" checked={tokenUnlimited} onCheckedChange={setTokenUnlimited} />
              <Label htmlFor="tokenUnlimited">{t("settings.users.quota.tokenUnlimitedLabel")}</Label>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="storageQuotaGb">{t("settings.users.quota.storageLabel")}</Label>
              {usage?.storage ? <Badge variant="outline" className="text-[10px]">{sourceLabel(usage.storage.source)}</Badge> : null}
            </div>
            <Input
              id="storageQuotaGb"
              type="number"
              min={0}
              step="0.01"
              placeholder={storageUnsetHere ? t("settings.users.quota.noPresetPlaceholder") : usage?.storage?.limitGb != null ? String(usage.storage.limitGb) : t("settings.users.quota.noPresetPlaceholder")}
              value={storageGb}
              onChange={(e) => setStorageGb(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Switch id="storageUnlimited" checked={storageUnlimited} onCheckedChange={setStorageUnlimited} />
              <Label htmlFor="storageUnlimited">{t("settings.users.quota.storageUnlimitedLabel")}</Label>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="resetAnchorDate">{t("settings.users.quota.anchorLabel")}</Label>
            <Input
              id="resetAnchorDate"
              type="date"
              value={anchorDate}
              onChange={(e) => setAnchorDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("settings.users.quota.anchorHint")}</p>
          </div>

          {usage ? <StorageMeter usedBytes={usage.storage?.usedBytes ?? 0} limitGb={usage.storage?.limitGb ?? null} /> : null}

          {fieldError ? <p className="text-sm text-[var(--error-text)]">{fieldError}</p> : null}
        </div>

        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          {hasActiveTokenQuota ? (
            <Button variant="destructive" size="sm" onClick={() => setResetConfirmOpen(true)} disabled={saving}>
              {t("settings.users.quota.resetCta")}
            </Button>
          ) : null}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? t("common.saving") : t("settings.users.quota.saveCta")}
            </Button>
          </div>
        </DialogFooter>

        <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("settings.users.quota.resetConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.users.quota.resetConfirmBody", {
                  username,
                  used: usage?.tokens.used.toLocaleString() ?? "0",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={handleReset} disabled={saving}>
                {saving ? t("common.saving") : t("settings.users.quota.resetConfirmCta")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}