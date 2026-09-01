// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 260809-uxk Task 1 — ChatPanel/InputBar PII consent deadlock seam test.
 *
 * The widget test environment is node-only (packages/widget/jest.config.js —
 * testEnvironment: "node", no jsdom; T-65-SC forbids new test deps), so Preact
 * components cannot render. Following the welcomeScreen.seam.test.ts idiom:
 * read the source files with fs.readFileSync and assert the structural
 * contract with regex matches.
 *
 * Pins (260809-uxk, D-01):
 * - ChatPanel.tsx contains NO sessionStorage token outside comment lines —
 *   the opaque-origin SecurityError trap is gone (the iframe is sandboxed
 *   without allow-same-origin; ALL persistence goes through the loader
 *   handshake via readStoredValue/writeStoredValue)
 * - ChatPanel imports readStoredValue/writeStoredValue from "../hooks/useWidgetChat"
 * - InputBar.tsx textarea carries `disabled={isStreaming}` ONLY — a disabled
 *   textarea cannot receive focus, which was the deadlock (consent prompt
 *   never shown → hasConsented stays false → input grayed forever). The
 *   `disabled` prop still gates the send button + handleSubmit.
 * - WelcomeScreen receives onQuestionClick={handleSend} (the gated handler) —
 *   the chip bypass is closed: the visitor sees the PIIWarningPrompt before
 *   ANY message is sent, per the design intent.
 */

import * as fs from "fs";
import * as path from "path";

describe("ChatPanel/InputBar consent deadlock seams (260809-uxk)", () => {
  const chatPanelPath = path.resolve(__dirname, "../widget/components/ChatPanel.tsx");
  const inputBarPath = path.resolve(__dirname, "../widget/components/InputBar.tsx");
  const chatPanelSource = fs.readFileSync(chatPanelPath, "utf-8");
  const inputBarSource = fs.readFileSync(inputBarPath, "utf-8");

  it("ChatPanel.tsx contains no sessionStorage token outside comment lines", () => {
    // Strip comment lines (both // line comments and /* */ block comments) so
    // explanatory history may mention the removed API, then assert no token.
    const codeOnly = chatPanelSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n")
      // Remove /* ... */ block comments (single-line only — this file has none spanning lines)
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toContain("sessionStorage");
  });

  it("ChatPanel imports readStoredValue/writeStoredValue from the useWidgetChat hook", () => {
    // The consent + lead state must persist via the loader handshake, never
    // the sandboxed iframe's own storage. The import line must reference both
    // wrappers from the hook module.
    expect(chatPanelSource).toMatch(
      /import \{[^}]*readStoredValue[^}]*writeStoredValue[^}]*\} from "\.\.\/hooks\/useWidgetChat"/,
    );
  });

  it("InputBar.tsx textarea is disabled={isStreaming} ONLY — never consent-disabled (deadlock fix)", () => {
    // The textarea must ALWAYS be focusable so onFocus fires and the PII
    // prompt appears; consent gates the SEND (button + handleSubmit), not the
    // input. The old deadlock form `disabled={isStreaming || disabled}` is
    // pinned as REMOVED.
    expect(inputBarSource).toMatch(/disabled=\{isStreaming\}/);
    expect(inputBarSource).not.toContain("disabled={isStreaming || disabled}");
  });

  it("ChatPanel passes the gated handleSend to WelcomeScreen onQuestionClick (chip bypass closed)", () => {
    // WelcomeScreen's chip click must route through the consent gate — raw
    // sendMessage would let a visitor send before seeing the PII warning.
    expect(chatPanelSource).toMatch(/onQuestionClick=\{handleSend\}/);
    // The gate must also be wired to InputBar's send path.
    expect(chatPanelSource).toMatch(/onSend=\{handleSend\}/);
  });

  it("ChatPanel gates sends on hasConsentedRef via the handleSend handler", () => {
    // Structural pin: handleSend consults the consent ref and shows the PII
    // prompt instead of sending when consent is missing.
    expect(chatPanelSource).toMatch(/if \(!hasConsentedRef\.current\)/);
    expect(chatPanelSource).toMatch(/setShowPIIPrompt\(true\)/);
    expect(chatPanelSource).toMatch(/void sendMessage\(message\)/);
  });
});
