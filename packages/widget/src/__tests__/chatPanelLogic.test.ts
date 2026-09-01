// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { shouldShowLeadCard, shouldSend } from "../utils/chatPanelLogic";

describe("shouldShowLeadCard", () => {
  const baseInput = {
    leadCaptureEnabled: true,
    leadSubmitted: false,
    leadDismissed: false,
    messages: [{ role: "assistant", content: "Hello! How can I help?" }],
    isStreaming: false,
  };

  it("returns true when lead capture enabled, assistant answered, not streaming, not submitted/dismissed", () => {
    expect(shouldShowLeadCard(baseInput)).toBe(true);
  });

  it("returns false when lead capture is disabled", () => {
    expect(shouldShowLeadCard({ ...baseInput, leadCaptureEnabled: false })).toBe(false);
  });

  it("returns false when lead already submitted", () => {
    expect(shouldShowLeadCard({ ...baseInput, leadSubmitted: true })).toBe(false);
  });

  it("returns false when lead dismissed", () => {
    expect(shouldShowLeadCard({ ...baseInput, leadDismissed: true })).toBe(false);
  });

  it("returns false when no assistant answer", () => {
    expect(shouldShowLeadCard({ ...baseInput, messages: [] })).toBe(false);
  });

  it("returns false when assistant answer is empty/whitespace", () => {
    expect(shouldShowLeadCard({ ...baseInput, messages: [{ role: "assistant", content: "   " }] })).toBe(false);
  });

  it("returns false when only user messages exist", () => {
    expect(shouldShowLeadCard({ ...baseInput, messages: [{ role: "user", content: "Hi" }] })).toBe(false);
  });

  it("returns false while streaming", () => {
    expect(shouldShowLeadCard({ ...baseInput, isStreaming: true })).toBe(false);
  });

  it("returns true when there are user+assistant messages and not streaming", () => {
    const messages = [
      { role: "user", content: "What is RAG?" },
      { role: "assistant", content: "RAG stands for..." },
    ];
    expect(shouldShowLeadCard({ ...baseInput, messages })).toBe(true);
  });
});

describe("shouldSend", () => {
  it("returns true when value has content, not streaming, not disabled", () => {
    expect(shouldSend("hello", false, false)).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(shouldSend("", false, false)).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(shouldSend("   ", false, false)).toBe(false);
  });

  it("returns false when streaming", () => {
    expect(shouldSend("hello", true, false)).toBe(false);
  });

  it("returns false when disabled", () => {
    expect(shouldSend("hello", false, true)).toBe(false);
  });

  it("returns false when both streaming and disabled", () => {
    expect(shouldSend("hello", true, true)).toBe(false);
  });

  it("returns true for value with leading/trailing spaces (trim still has content)", () => {
    expect(shouldSend("  hello  ", false, false)).toBe(true);
  });
});