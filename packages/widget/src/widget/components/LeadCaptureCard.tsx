// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { t } from "../i18n";

interface LeadCaptureCardProps {
  onSubmit: (email: string, name?: string) => Promise<void>;
  onDismiss: () => void;
  promptText?: string;
}

export default function LeadCaptureCard({ onSubmit, onDismiss, promptText }: LeadCaptureCardProps) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError(t("lead.emailRequired"));
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

        {error && (
          <p className="text-xs m-0" style={{ color: "#dc2626" }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 rounded text-sm font-medium text-white border-none cursor-pointer hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: "var(--widget-primary)" }}
        >
          {submitting ? t("lead.sending") : t("lead.shareInfo")}
        </button>
      </form>
    </div>
  );
}