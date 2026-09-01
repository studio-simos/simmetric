// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { t } from "../i18n";

// 131-05 (G-131-16): the 'Dati contatto ricevuti' indicator moved OUT of the
// ChatHeader top bar into this dismissable banner, rendered between ChatHeader
// and ErrorBar in ChatPanel. Dismissal is owned by ChatPanel (persisted via
// the loader handshake — sc-widget-{id}-contact-banner-dismissed), so this
// component is a pure presentational bar with a single onDismiss callback.
// The X button mirrors ErrorBar's geometry (BUG-03 convention): 16px viewBox,
// two lines, strokeWidth 2, muted stroke #6b7280, aria-hidden on the svg.
interface ContactBannerProps {
  onDismiss: () => void;
}

export default function ContactBanner({ onDismiss }: ContactBannerProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-[#f8fafc] border-b border-gray-200 shrink-0">
      <span className="text-xs text-[#374151]">{t("chatHeader.contactReceived")}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("lead.dismissLabel")}
        className="bg-transparent border-none cursor-pointer text-[#6b7280] p-1 rounded hover:bg-gray-100"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#6b7280" strokeWidth="2" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <line x1="3" y1="3" x2="13" y2="13" />
          <line x1="13" y1="3" x2="3" y2="13" />
        </svg>
      </button>
    </div>
  );
}
