// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { JSX } from "preact";
import type { WidgetContactOptions } from "@simmetric-chat/shared";
import { t } from "../i18n";
import { notifyCreditsOpen } from "../../utils/widgetStateBridge";

interface ContactOptionsCardProps {
  contactConfig: WidgetContactOptions | null;
  // Lead capture available (enabled + not yet submitted) → show the
  // "leave your email here" arm wired to ChatPanel's setShowLeadCard(true).
  leadAvailable: boolean;
  onOpenLeadCard: () => void;
}

// 260917-mz6: the limit-reached contact card. One row per CONFIGURED option —
// site form (formUrl), booking (bookingUrl), owner email (mailto from email),
// custom link (customUrl with customLabel as the display text) — each opens
// via notifyCreditsOpen (the loader's creditsOpen bridge allows http/https/
// mailto host-side; the sandboxed iframe cannot navigate itself). Geometry/
// classes mirror LeadCaptureCard. All text via t() (SEC-04: textContent
// discipline — no dangerouslySetInnerHTML anywhere).
export default function ContactOptionsCard({ contactConfig, leadAvailable, onOpenLeadCard }: ContactOptionsCardProps) {
  // Per-option rendering decision: an entry shows only when its payload is
  // configured (non-empty string). The email option opens a mailto: URL.
  type Entry = { key: string; label: string; url: string };
  const entries: Entry[] = [];
  if (contactConfig?.formUrl) {
    entries.push({ key: "form", label: t("contact.form"), url: contactConfig.formUrl });
  }
  if (contactConfig?.bookingUrl) {
    entries.push({ key: "booking", label: t("contact.booking"), url: contactConfig.bookingUrl });
  }
  if (contactConfig?.email) {
    entries.push({ key: "email", label: t("contact.emailUs"), url: `mailto:${contactConfig.email}` });
  }
  if (contactConfig?.customUrl) {
    entries.push({
      key: "custom",
      label: contactConfig.customLabel || contactConfig.customUrl,
      url: contactConfig.customUrl,
    });
  }

  const handleOpen = (url: string, e: JSX.TargetedEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    notifyCreditsOpen(url);
  };

  return (
    <div
      className="mx-3 mb-2 rounded-lg border border-[#d1d5db] bg-white p-4"
      style={{ animation: "slideUp 300ms ease-out" }}
    >
      <p className="text-sm font-medium text-foreground m-0 mb-2">
        {t("contact.heading")}
      </p>

      <div className="flex flex-col gap-1">
        {entries.map((entry) => (
          <a
            key={entry.key}
            href={entry.url}
            onClick={(e) => handleOpen(entry.url, e)}
            className="block px-3 py-2 rounded text-sm text-foreground no-underline border border-[#e5e7eb] hover:border-[var(--widget-primary)] min-h-[44px] inline-flex items-center"
          >
            <span className="line-clamp-2">{entry.label}</span>
          </a>
        ))}
        {leadAvailable && (
          <button
            type="button"
            onClick={onOpenLeadCard}
            className="px-3 py-2 rounded text-sm font-medium text-white border-none cursor-pointer hover:opacity-90 min-h-[44px]"
            style={{ backgroundColor: "var(--widget-primary)" }}
          >
            {t("contact.leaveEmailHere")}
          </button>
        )}
      </div>
    </div>
  );
}