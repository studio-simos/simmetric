// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useState } from "preact/hooks";
import type { RateLimitInfo } from "../hooks/useWidgetChat";
import { t } from "../i18n";

interface RateLimitNoticeProps {
  rateLimit: RateLimitInfo;
  /** 151-02 (G-151-1b): daily MESSAGE limit reached — a hard per-visitor
   *  cap. When true the panel is a persistent full-panel blocking state and
   *  the 60s auto-clear is suppressed (the budget resets only when the
   *  server's 24h window rolls over; auto-hiding a daily block would be
   *  wrong — the input stays disabled either way via sessionLimitReached). */
  sessionLimitReached?: boolean;
}

export default function RateLimitNotice({ rateLimit, sessionLimitReached }: RateLimitNoticeProps) {
  const [visible, setVisible] = useState(true);

  // Auto-clear after 60 seconds — EXCEPT for the daily blocking state (a hard
  // per-visitor limit must stay visible until the server window resets).
  useEffect(() => {
    if (sessionLimitReached) return;
    const timer = setTimeout(() => setVisible(false), 60000);
    return () => clearTimeout(timer);
  }, [sessionLimitReached]);

  if (!visible) return null;

  const isDaily = sessionLimitReached
    || (rateLimit.dailyRemaining !== undefined && rateLimit.dailyRemaining <= 0);
  const isHourly = rateLimit.hourlyRemaining !== undefined && rateLimit.hourlyRemaining <= 0;

  const heading = t("rateLimit.heading");
  let body = t("rateLimit.bodyDefault");

  if (isDaily) {
    body = t("rateLimit.bodyDaily");
  } else if (isHourly) {
    body = t("rateLimit.bodyHourly");
  }

  // Show remaining counts when available
  if (rateLimit.hourlyRemaining !== undefined && rateLimit.hourlyRemaining > 0) {
    body = t("rateLimit.messagesRemaining", { count: rateLimit.hourlyRemaining });
  }
  if (rateLimit.dailyRemaining !== undefined && rateLimit.dailyRemaining > 0) {
    body = t("rateLimit.conversationsRemaining", { count: rateLimit.dailyRemaining });
  }

  // Show retry time if available (daily case: "tomorrow" — no minute math)
  if (rateLimit.retryAfter && !isDaily) {
    body += ` ${t("rateLimit.retryIn", { minutes: Math.ceil(rateLimit.retryAfter / 60) })}`;
  }

  // 151-02 (G-151-1b): the daily case is a full-panel blocking state —
  // larger heading, no clock icon, persistent (no auto-clear above).
  if (isDaily) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-10 text-center bg-[#fef2f2] rounded-lg border border-[#fecaca] mx-4 my-4">
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#dc2626"
          strokeWidth="2"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <p className="text-lg font-bold text-[#991b1b] mt-3">{heading}</p>
        <p className="text-sm text-[#b91c1c] mt-2">{body}</p>
        {rateLimit.retryAfter && (
          <p className="text-xs text-[#b91c1c] mt-2">
            {t("rateLimit.resetsTomorrow")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-6 text-center">
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#6b7280"
        strokeWidth="2"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <p className="text-base font-semibold text-[#111827] mt-2">{heading}</p>
      <p className="text-sm text-[#6b7280] mt-1">{body}</p>
    </div>
  );
}
