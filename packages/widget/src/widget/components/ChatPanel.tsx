// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { WidgetConfig } from "../hooks/useWidgetConfig";
import { shouldShowCredits } from "../hooks/useWidgetConfig";
import type { UseWidgetChatReturn } from "../hooks/useWidgetChat";
import { readStoredValue, writeStoredValue } from "../hooks/useWidgetChat";
import ChatHeader from "./ChatHeader";
import ContactBanner from "./ContactBanner";
import LeadBanner from "./LeadBanner";
import MessageArea from "./MessageArea";
import InputBar from "./InputBar";
import WelcomeScreen from "./WelcomeScreen";
import ErrorBar from "./ErrorBar";
import RateLimitNotice from "./RateLimitNotice";
import PIIWarningPrompt from "./PIIWarningPrompt";
import LeadCaptureCard from "./LeadCaptureCard";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { t } from "../i18n";
import { notifyCreditsOpen } from "../../utils/widgetStateBridge";

interface ChatPanelProps {
  config: WidgetConfig;
  chat: UseWidgetChatReturn;
  onClose: () => void;
}

export default function ChatPanel({ config, chat, onClose }: ChatPanelProps) {
  const { messages, isStreaming, error, rateLimit, sessionLimitReached, sendMessage, abortStream, clearError, sessionToken } = chat;
  const position = config.position;

  // PII consent state — persisted via the loader handshake (260809-uxk). The
  // sandboxed iframe's own sessionStorage throws SecurityError on the opaque
  // origin, so consent MUST live on the parent page (sc-widget-{id}-consent).
  // Initial state is false; the mount effect restores it from the loader.
  const [hasConsented, setHasConsented] = useState(false);
  const [showPIIPrompt, setShowPIIPrompt] = useState(false);
  const hasConsentedRef = useRef(hasConsented);
  useEffect(() => {
    // ref-mirror: sync hasConsentedRef to state for async callbacks
    // (handleSend/handleInputFocus read .current without re-subscribing).
    // Preact ref-mirror pattern — react-compiler's purity rule is stricter
    // than Preact's actual ref semantics here.
    // eslint-disable-next-line react-compiler/react-compiler
    hasConsentedRef.current = hasConsented;
  }, [hasConsented]);

  // 260809-uxk: restore consent + lead-submitted state from the loader on
  // mount. Both keys were lost on reload before (sessionStorage no-ops in the
  // sandbox) — consent is now sticky across reloads.
  useEffect(() => {
    let cancelled = false;
    void readStoredValue(config.widgetId, "consent").then((v) => {
      if (!cancelled && v === "1") setHasConsented(true);
    });
    void readStoredValue(config.widgetId, "leadSubmitted").then((v) => {
      if (!cancelled && v === "1") setLeadSubmitted(true);
    });
    // 131-05 (G-131-16): restore the contact-banner dismiss flag. The Task 1
    // requestId correlation makes this third concurrent read reliable — each
    // read resolves its own key (the pre-fix handshake misrouted concurrent
    // reads, so this restore would have resolved null).
    void readStoredValue(config.widgetId, "contactBannerDismissed").then((v) => {
      if (!cancelled && v === "1") setContactBannerDismissed(true);
    });
    return () => { cancelled = true; };
  }, [config.widgetId]);

  // Lead capture state (ADM-04)
  const [showLeadCard, setShowLeadCard] = useState(false);
  const [leadSubmitted, setLeadSubmitted] = useState(false);
  const [leadDismissed, setLeadDismissed] = useState(false);

  // 131-05 (G-131-16): the contact-received banner's dismiss flag. Persisted
  // via the loader handshake (sc-widget-{id}-contact-banner-dismissed) so the
  // dismissal survives reloads. leadSubmitted is NOT cleared — it still gates
  // the lead card (G-131-18) and the showLeadLink button.
  const [contactBannerDismissed, setContactBannerDismissed] = useState(false);

  const handleContactBannerDismiss = useCallback(() => {
    setContactBannerDismissed(true);
    writeStoredValue(config.widgetId, "contactBannerDismissed", "1");
  }, [config.widgetId]);

  const handleConsent = useCallback(() => {
    setHasConsented(true);
    setShowPIIPrompt(false);
    writeStoredValue(config.widgetId, "consent", "1");
  }, [config.widgetId]);

  const handleInputFocus = useCallback(() => {
    if (!hasConsentedRef.current) {
      setShowPIIPrompt(true);
    }
  }, []);

  // 260809-uxk (consent gate): the single send path — typed sends AND welcome
  // chips route through this gate. Without consent the PIIWarningPrompt shows
  // instead of sending (closes the chip bypass: onQuestionClick previously
  // received raw sendMessage).
  const handleSend = useCallback((message: string) => {
    if (!hasConsentedRef.current) {
      setShowPIIPrompt(true);
      return;
    }
    void sendMessage(message);
  }, [sendMessage]);

  // Lead submission handler — calls widget service endpoint directly
  const handleLeadSubmit = useCallback(async (email: string, name?: string) => {
    const transcript = messages.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    const response = await fetch(`/api/lead/${config.widgetId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { "X-Session-Token": sessionToken } : {}),
      },
      body: JSON.stringify({ email, name, transcript }),
    });
    if (!response.ok) throw new Error(t("chatPanel.leadSubmitFailed"));
    setLeadSubmitted(true);
    writeStoredValue(config.widgetId, "leadSubmitted", "1");
    setShowLeadCard(false);
  }, [config.widgetId, messages, sessionToken]);

  const handleLeadDismiss = useCallback(() => {
    setShowLeadCard(false);
    setLeadDismissed(true);
  }, []);

  const handleLeadLinkClick = useCallback(() => {
    setShowLeadCard(true);
    setLeadDismissed(false);
  }, []);

  // Show lead card after first assistant answer (per D-07)
  useEffect(() => {
    if (!config.leadCaptureEnabled) return;
    if (leadSubmitted || leadDismissed) return;
    const hasAssistantAnswer = messages.some(m => m.role === "assistant" && m.content.trim() !== "");
    const doneStreaming = !isStreaming;
    if (hasAssistantAnswer && doneStreaming) {
      setShowLeadCard(true);
    }
  }, [messages, isStreaming, config.leadCaptureEnabled, leadSubmitted, leadDismissed]);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 5000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  const panelPositionClasses = position === "left"
    ? "left-5"
    : "right-5";

  return (
    <div
      role="dialog"
      aria-label={t("chatPanel.ariaLabel")}
      className={`
        fixed bottom-24 ${panelPositionClasses}
        w-[376px] h-[600px]
        max-w-[calc(100vw-40px)] max-h-[calc(100vh-120px)]
        flex flex-col
        bg-white
        rounded-t-[12px]
        shadow-[0_8px_32px_rgba(0,0,0,0.12)]
        overflow-hidden
        z-[999998]
      `}
      style={{
        animation: "panelOpen 250ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}
    >
      <ChatHeader
        name={config.name}
        botName={config.botName}
        logoUrl={config.logoUrl}
        onClose={onClose}
      />

      {/* 131 UAT re-test: the 'Lascia i dati di contatto' affordance lives
          BELOW the top bar (not inside ChatHeader). Same visibility as the
          old header link — shown only after the lead card was dismissed and
          the lead was never submitted. */}
      {config.leadCaptureEnabled && !leadSubmitted && leadDismissed && (
        <LeadBanner onClick={handleLeadLinkClick} />
      )}

      {/* 131-05 (G-131-16): the contact-received indicator lives in a
          dismissable banner BELOW the top bar (not inside ChatHeader). The
          banner slots between ChatHeader and ErrorBar so errors still render
          'just below' it. Dismissal persists via the loader handshake. */}
      {leadSubmitted && !contactBannerDismissed && (
        <ContactBanner onDismiss={handleContactBannerDismiss} />
      )}

      {error && <ErrorBar error={error} onDismiss={clearError} />}

      <div className="flex-1 overflow-y-auto relative">
        {messages.length === 0 && !isStreaming ? (
          <WelcomeScreen
            config={config}
            onQuestionClick={handleSend}
            onInputFocus={handleInputFocus}
          />
        ) : (
          <MessageArea
            messages={messages}
            isStreaming={isStreaming}
            fallbackMessage={config.fallbackMessage}
            avatarUrl={config.avatarUrl}
          />
        )}
        {rateLimit && (
          <RateLimitNotice rateLimit={rateLimit} sessionLimitReached={sessionLimitReached} />
        )}
      </div>

      {showLeadCard && config.leadCaptureEnabled && !leadSubmitted && (
        <LeadCaptureCard
          onSubmit={handleLeadSubmit}
          onDismiss={handleLeadDismiss}
          promptText={config.leadCapturePrompt || undefined}
        />
      )}

      {showPIIPrompt && !hasConsented && (
        <PIIWarningPrompt onConsent={handleConsent} body={config.piiConsent} />
      )}

      <InputBar
        onSend={handleSend}
        onAbort={abortStream}
        isStreaming={isStreaming}
        // 151-02 (G-151-1b): the daily message limit is a hard per-visitor
        // cap — the user must not be able to write or send at all.
        disabled={!hasConsented || sessionLimitReached}
        onFocus={handleInputFocus}
        placeholder={config.placeholder || undefined}
      />

      {/* 130-01 (D-01/D-04): credits footer line — the LAST child after
          <InputBar>, always visible when the panel is open. Visibility is the
          single shouldShowCredits predicate (D-03, Pitfall 5: Community always
          shows). The anchor KEEPS href for semantics/accessibility but onClick
          owns the open (preventDefault + bridge — the sandbox blocks real
          navigation, D-02). Label resolves at render time via t() — never
          baked into DEFAULT_CONFIG (Pitfall 4). line-clamp-2 on the INNER
          span, never the flex anchor (129 CR-01 lesson); min-h-[44px] touch
          target (frontend AGENTS.md 44px convention).
          131-04 (real-embed UAT): the footer is restyled to two 50% blocks —
          "generato con IA" (left, text-left) + credits link (right,
          text-right) — with justify-between + lateral padding (px-4), per the
          user's reported defect #4/#5. */}
      {shouldShowCredits(config.whiteLabel, config.credits) && (
        <div className="flex items-center justify-between px-4 pb-2">
          <span className="w-1/2 text-xs text-[#6b7280] text-left">{t("credits.aiGenerated")}</span>
          <a
            href={config.credits?.url || "https://simmetric.chat"}
            onClick={(e) => {
              e.preventDefault();
              notifyCreditsOpen(config.credits?.url || "https://simmetric.chat");
            }}
            className="w-1/2 text-xs text-[#6b7280] underline underline-offset-2 hover:text-[var(--widget-primary)] min-h-[44px] inline-flex items-center justify-end text-right"
          >
            <span className="line-clamp-2">{config.credits?.label || t("credits.poweredBy")}</span>
          </a>
        </div>
      )}
    </div>
  );
}