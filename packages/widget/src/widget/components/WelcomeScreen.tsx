// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { WidgetConfig } from "../hooks/useWidgetConfig";
import { t } from "../i18n";
import ProductMark from "./ProductMark";

interface WelcomeScreenProps {
  config: WidgetConfig;
  onQuestionClick: (question: string) => void;
  onInputFocus?: () => void;
}

export default function WelcomeScreen({ config, onQuestionClick }: WelcomeScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 py-6">
      {/* Widget avatar — 188-03 (WGTA-02, D-10 restyle-not-rebuild): when the
          admin avatarUrl is absent the primary-colored circle renders the
          product fallback mark (self-contained Preact Monogram copy) instead
          of the generic chat-bubble glyph; the circle geometry is preserved. */}
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center mb-4 overflow-hidden"
        style={{ backgroundColor: "var(--widget-primary)" }}
      >
        {config.avatarUrl ? (
          <img
            src={config.avatarUrl}
            alt={config.botName}
            className="w-12 h-12 rounded-full object-contain"
          />
        ) : (
          <ProductMark size={36} color="#4c6ef5" className="rounded-md" />
        )}
      </div>

      {/* Welcome message (WCORE-05 display) */}
      <p className="text-xl font-semibold text-[#111827] text-center mb-2 leading-tight" style={{ maxWidth: "280px" }}>
        {config.welcomeMessage}
      </p>

      {/* AI disclosure subtitle */}
      <p className="text-xs text-[#6b7280] mb-6">{t("welcome.aiSubtitle")}</p>

      {/* Suggested question chips (WCORE-05) */}
      {config.suggestedQuestions.length > 0 && (
        <div className="flex flex-col gap-2 w-[80%]" style={{ maxWidth: "320px" }}>
          {config.suggestedQuestions.slice(0, 3).map((question, i) => (
            <button
              key={i}
              type="button"
              role="button"
              aria-label={question}
              onClick={() => onQuestionClick(question)}
              className="px-4 py-2 rounded-full border text-sm cursor-pointer bg-transparent hover:bg-[#f0f4ff] active:bg-[#dbe4ff] text-center leading-snug min-h-[44px] flex items-center justify-center"
              style={{ borderColor: "var(--widget-primary)", color: "var(--widget-primary)" }}
            >
              {/* CR-01 (G-129-1): line-clamp-2 lives on this inner span, NOT the
                  button — combining flex with line-clamp-2 on one element is
                  defeated in the compiled bundle (.flex{display:flex} overrides
                  .line-clamp-2{display:-webkit-box} at equal specificity, making
                  -webkit-line-clamp inert). The span renders {question} as text
                  only — no dangerouslySetInnerHTML (T-129-04-01). */}
              <span className="line-clamp-2">{question}</span>
            </button>
          ))}
        </div>
      )}

      {/* PII notice text — CONTENT piiConsent wins (D-03); chrome key is the fallback */}
      <p className="text-xs text-[#6b7280] mt-6 text-center leading-relaxed" style={{ maxWidth: "280px" }}>
        {config.piiConsent || t("welcome.piiNotice")}
      </p>
    </div>
  );
}