// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { t } from "../i18n";

// 131 UAT re-test: the 'Lascia i dati di contatto' affordance moved OUT of the
// ChatHeader top bar into this slim bar below it. It only appears while a lead
// card is NOT showing and the lead was never submitted — clicking it reopens
// the LeadCaptureCard. Mirrors ContactBanner's geometry (shrink-0 bar between
// header and content) so the top bar stays clean.
interface LeadBannerProps {
  onClick: () => void;
}

export default function LeadBanner({ onClick }: LeadBannerProps) {
  return (
    <div className="flex items-center justify-center px-4 py-1.5 bg-[#f8fafc] border-b border-gray-200 shrink-0">
      <button
        type="button"
        onClick={onClick}
        className="text-xs bg-transparent border-none cursor-pointer underline underline-offset-2 hover:opacity-80"
        style={{ color: "var(--widget-primary)" }}
      >
        {t("chatHeader.leaveContact")}
      </button>
    </div>
  );
}
