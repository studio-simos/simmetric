// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { t } from "../i18n";
import { notifyCreditsOpen } from "../../utils/widgetStateBridge";
import { isLeadSubmitReady } from "../../utils/chatPanelLogic";

interface LeadCaptureCardProps {
  onSubmit: (email: string, name?: string) => Promise<void>;
  onDismiss: () => void;
  promptText?: string;
  // 260917-qoh: the per-widget privacy policy URL (from the widget config).
  // null/absent = not configured → the consent checkbox renders WITHOUT a
  // link. When configured, the link row opens the page host-side via the
  // notifyCreditsOpen bridge (the loader's creditsOpen handler window.opens
  // it on the HOST page with noopener — the sandboxed iframe has no
  // allow-popups, so NEVER a raw target="_blank" anchor here).
  privacyUrl?: string | null;
}

// 260917-qoh: the lead card now gates the email share behind a REQUIRED
// privacy-consent checkbox. The submit button stays disabled until the
// checkbox is ticked (and handleSubmit re-guards with the same helper —
// T-Q04 defense-in-depth: the server schema also fails closed on a
// missing/false consent flag). All text via t(); SEC-04 textContent
// discipline (no dangerouslySetInnerHTML anywhere); geometry/classes mirror
// the card's existing block.
export default function LeadCaptureCard({ onSubmit, onDismiss, promptText, privacyUrl }: LeadCaptureCardProps) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [privacyChecked, setPrivacyChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePrivacyLinkClick = () => {
    if (privacyUrl) notifyCreditsOpen(privacyUrl);
  };

  const handleSubmit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError(t("lead.emailRequired"));
      return;
    }

    // 260917-qoh: the consent gate — unchecked checkbox → the email is NOT
    // shared (client gate; the server independently rejects a request
    // without privacyConsented:true).
    if (!isLeadSubmitReady(email, privacyChecked)) {
      setError(t("lead.privacyConsentRequired"));
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(email.trim(), name.trim() || undefined);
    } catch {
      setError(t("lead.submitError"));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="mx-3 mb-2 rounded-lg border border-[#d1d5db] bg-white p-4"
      style={{ animation: "slideUp 300ms ease-out" }}
    >
      <div className="flex items-start justify-between mb-2">
        <p className="text-sm font-medium text-foreground m-0">
          {promptText || t("lead.promptFallback")}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("lead.dismissLabel")}
          className="w-6 h-6 flex items-center justify-center bg-transparent border-none cursor-pointer hover:text-foreground rounded"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="#6b7280"
            strokeWidth="2"
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
          >
            <line x1="3" y1="3" x2="13" y2="13" />
            <line x1="13" y1="3" x2="3" y2="13" />
          </svg>
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <input
          type="email"
          placeholder={t("lead.emailPlaceholder")}
          value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          required
          className="border border-[#d1d5db] rounded px-3 py-2 text-sm bg-white text-foreground focus:ring-1 focus:ring-[var(--widget-primary)] outline-none"
          disabled={submitting}
        />
        <input
          type="text"
          placeholder={t("lead.namePlaceholder")}
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          className="border border-[#d1d5db] rounded px-3 py-2 text-sm bg-white text-foreground focus:ring-1 focus:ring-[var(--widget-primary)] outline-none"
          disabled={submitting}
        />

        {/* 260917-qoh: REQUIRED privacy-consent checkbox — the submit stays
            disabled until ticked. The label is a full-sentence i18n key (no
            sentence-splitting across locales). */}
        <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={privacyChecked}
            onInput={(e) => setPrivacyChecked((e.target as HTMLInputElement).checked)}
            className="mt-0.5 accent-[var(--widget-primary)] cursor-pointer"
            disabled={submitting}
          />
          <span>{t("lead.privacyConsentLabel")}</span>
        </label>

        {/* 260917-qoh: the privacy link row — rendered ONLY when the admin
            configured a per-widget privacyUrl. A button styled as a link
            (never a target="_blank" anchor — no allow-popups in the sandbox);
            the notifyCreditsOpen bridge opens the page host-side in a new
            tab with noopener. */}
        {privacyUrl && (
          <button
            type="button"
            onClick={handlePrivacyLinkClick}
            className="text-xs underline text-left bg-transparent border-none cursor-pointer p-0 hover:opacity-80"
            style={{ color: "var(--widget-primary)" }}
          >
            {t("lead.privacyPolicyLink")}
          </button>
        )}

        {error && (
          <p className="text-xs m-0" style={{ color: "#dc2626" }}>{error}</p>
        )}

        {/* 260917-qoh: the visual disabled state matches the consent gate. */}
        <button
          type="submit"
          disabled={submitting || !privacyChecked}
          className="px-4 py-2 rounded text-sm font-medium text-white border-none cursor-pointer hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: "var(--widget-primary)" }}
        >
          {submitting ? t("lead.sending") : t("lead.shareInfo")}
        </button>
      </form>
    </div>
  );
}