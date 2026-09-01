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