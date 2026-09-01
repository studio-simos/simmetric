// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { t } from "../i18n";

interface ErrorBarProps {
  error: string;
  onDismiss: () => void;
}

export default function ErrorBar({ error, onDismiss }: ErrorBarProps) {
  return (
    <div
      className="bg-[#fef2f2] text-[#dc2626] px-4 py-2 flex items-center justify-between text-sm shrink-0"
      style={{
        animation: "slideDown 100ms ease-out",
        maxHeight: "52px",
      }}
    >
      <span className="flex-1 pr-2">{error}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("errorBar.dismissLabel")}
        className="bg-transparent border-none cursor-pointer text-[#dc2626] p-1 rounded hover:bg-[#dc2626]/10"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#dc2626" strokeWidth="2" xmlns="http://www.w3.org/2000/svg">
          <line x1="3" y1="3" x2="13" y2="13" />
          <line x1="13" y1="3" x2="3" y2="13" />
        </svg>
      </button>
    </div>
  );
}