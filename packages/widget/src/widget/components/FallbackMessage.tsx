// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

interface FallbackMessageProps {
  message: string;
}

export default function FallbackMessage({ message }: FallbackMessageProps) {
  return (
    <div className="flex justify-center my-3">
      <div className="max-w-[90%] text-center italic text-[#6b7280] text-[13px] px-3 py-2 flex items-center justify-center gap-1">
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="#6b7280"
          strokeWidth="1.5"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="shrink-0"
        >
          <circle cx="7" cy="7" r="6" />
          <line x1="7" y1="4" x2="7" y2="8" />
          <circle cx="7" cy="10" r="0.5" fill="#6b7280" />
        </svg>
        <span>{message}</span>
      </div>
    </div>
  );
}