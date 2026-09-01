// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { t } from "../i18n";

interface ChatHeaderProps {
  name: string;
  botName: string;
  logoUrl: string | null;
  onClose: () => void;
}

export default function ChatHeader({ name, botName, logoUrl, onClose }: ChatHeaderProps) {
  return (
    <div
      className="h-[52px] flex items-center justify-between px-4 shrink-0"
      style={{ backgroundColor: "var(--widget-primary)" }}
    >
      <div className="flex items-center">
        {logoUrl && (
          <img
            src={logoUrl}
            alt={t("chatHeader.logoAlt")}
            className="w-7 h-7 rounded-full object-contain mr-2"
          />
        )}
        <div>
          <h2
            role="heading"
            aria-level={2}
            className="text-white text-base font-semibold m-0 leading-tight"
          >
            {name}
          </h2>
          <span className="text-white text-xs opacity-80 leading-tight">{botName}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("chat.closeLabel")}
        className="w-11 h-11 flex items-center justify-center bg-transparent border-none cursor-pointer rounded-lg hover:bg-white/10"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="white"
          strokeWidth="2"
          xmlns="http://www.w3.org/2000/svg"
        >
          <line x1="4" y1="4" x2="16" y2="16" />
          <line x1="16" y1="4" x2="4" y2="16" />
        </svg>
      </button>
    </div>
  );
}