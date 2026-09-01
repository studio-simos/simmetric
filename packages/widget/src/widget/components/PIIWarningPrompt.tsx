// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { t } from "../i18n";

interface PIIWarningPromptProps {
  onConsent: () => void;
  /** CONTENT string (D-03): the admin-editable piiConsent from the JSON block. */
  body?: string;
}

export default function PIIWarningPrompt({ onConsent, body }: PIIWarningPromptProps) {
  return (
    <div className="bg-[#fffbeb] border border-[#d97706] rounded-lg p-3 mx-4 mb-2 shrink-0">
      <div className="flex items-start gap-2">
        {/* Shield icon */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="#92400e"
          strokeWidth="1.5"
          xmlns="http://www.w3.org/2000/svg"
          className="shrink-0 mt-0.5"
          aria-hidden="true"
        >
          <path d="M8 1L2 3.5v4c0 3.5 2.5 6.5 6 7.5 3.5-1 6-4 6-7.5v-4L8 1z" />
          <line x1="8" y1="6" x2="8" y2="9" />
          <circle cx="8" cy="11" r="0.5" fill="#92400e" />
        </svg>
        <div className="flex-1">
          <p className="text-[13px] text-[#92400e] leading-snug">
            {body || t("welcome.piiNotice")}
          </p>
          <button
            type="button"
            onClick={onConsent}
            className="mt-2 px-3 py-1.5 rounded text-sm font-medium text-white cursor-pointer border-none"
            style={{ backgroundColor: "var(--widget-primary)" }}
          >
            {t("pii.understand")}
          </button>
        </div>
      </div>
    </div>
  );
}