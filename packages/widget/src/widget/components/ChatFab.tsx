// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { t } from "../i18n";

interface ChatFabProps {
  isOpen: boolean;
  position: "left" | "right";
  logoUrl: string | null;
  onClick: () => void;
}

export default function ChatFab({ isOpen, position, logoUrl, onClick }: ChatFabProps) {
  const positionClasses = position === "left"
    ? "left-5"
    : "right-5";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t(isOpen ? "chat.closeLabel" : "chat.openLabel")}
      aria-expanded={isOpen}
      tabIndex={0}
      className={`
        fixed bottom-5 ${positionClasses}
        w-14 h-14
        rounded-full
        shadow-[0_4px_12px_rgba(0,0,0,0.15)]
        cursor-pointer
        z-[999999]
        flex items-center justify-center
        border-none outline-none
        active:scale-95
        hover:opacity-90
      `}
      style={{
        backgroundColor: "var(--widget-primary)",
        transition: "transform 150ms ease, opacity 150ms ease",
      }}
    >
      {isOpen ? <CloseIcon /> : logoUrl ? (
        <img
          src={logoUrl}
          alt={t("fab.alt")}
          className="w-7 h-7 rounded-full object-contain"
        />
      ) : <ChatIcon />}
    </button>
  );
}

function ChatIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="white"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="white"
      strokeWidth="2"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <line x1="4" y1="4" x2="16" y2="16" />
      <line x1="16" y1="4" x2="4" y2="16" />
    </svg>
  );
}