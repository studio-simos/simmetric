// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

interface LeadCardInput {
  leadCaptureEnabled: boolean;
  leadSubmitted: boolean;
  leadDismissed: boolean;
  messages: Array<{ role: string; content: string }>;
  isStreaming: boolean;
}

export function shouldShowLeadCard(input: LeadCardInput): boolean {
  if (!input.leadCaptureEnabled) return false;
  if (input.leadSubmitted || input.leadDismissed) return false;
  const hasAssistantAnswer = input.messages.some(
    (m) => m.role === "assistant" && m.content.trim() !== "",
  );
  if (!hasAssistantAnswer) return false;
  if (input.isStreaming) return false;
  return true;
}

export function shouldSend(value: string, isStreaming: boolean, disabled: boolean): boolean {
  return value.trim().length > 0 && !isStreaming && !disabled;
}

// 260917-mz6: lead-capture TIMING helper — when does the LeadCaptureCard
// appear? phase ∈ "start" | "limit" | "timeout-due":
//   - "start"      → timing "start": the card shows as soon as the panel opens
//                    (mount), regardless of messages.
//   - "limit"      → timing "end": the card shows when the daily session limit
//                    is reached (alongside ContactOptionsCard).
//   - "timeout-due"→ timing "timeout": the armed timer fired (the caller owns
//                    the arm/disarm lifecycle — messages.length>0 arming).
// Pure truth table, node-testable (jest node env convention). The submitted/
// dismissed gating stays in the CALLER (same split as shouldShowLeadCard).
export function shouldShowLeadAtTiming(
  timing: "start" | "end" | "timeout",
  phase: "start" | "limit" | "timeout-due",
): boolean {
  switch (timing) {
    case "start":
      return phase === "start";
    case "end":
      return phase === "limit";
    case "timeout":
      return phase === "timeout-due";
    default:
      return false;
  }
}

// 260917-qoh: the single lead-submit gate the card consults — the email must
// be non-empty after trim AND the visitor must have ticked the privacy-consent
// checkbox (the server schema independently fails closed on a missing/false
// flag — defense-in-depth, T-Q04). Pure truth table, node-testable (jest node
// env convention like shouldShowLeadAtTiming).
export function isLeadSubmitReady(email: string, privacyConsented: boolean): boolean {
  return email.trim().length > 0 && privacyConsented === true;
}