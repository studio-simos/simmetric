// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 131-04 (real-embed UAT fixes) — seam tests for the 5 user-reported widget
 * visual defects, following the welcomeScreen.seam.test.ts / chatPanel.seam
 * .test.ts idiom (node-only jest env — read source, assert the structural
 * contract with regex).
 *
 * Pins (131-04, real-embed UAT):
 * - loader.ts iframe template: NO un-layered universal reset rule with
 *   `padding: 0` — it beats every @layer utilities rule (cascade-layers
 *   spec: un-layered author styles win over layered ones) and collapsed
 *   px-4/py-3/p-4 to 0 in the real embed (defect #1).
 * - InputBar textarea carries `min-h-[44px]` — input height matches the
 *   44px send button (defect #3).
 * - PIIWarningPrompt body falls back to t("welcome.piiNotice") — an empty
 *   piiConsent no longer renders a blank box that leaves the send button
 *   silently disabled (defect #2).
 * - ChatPanel credits footer: two 50% blocks with justify-between + px-4
 *   lateral padding, "generato con IA" left, credits link right (defect
 *   #4/#5).
 */

import * as fs from "fs";
import * as path from "path";

describe("131-04 real-embed UAT fixes (seam)", () => {
  const loaderPath = path.resolve(__dirname, "../routes/loader.ts");
  const inputBarPath = path.resolve(__dirname, "../widget/components/InputBar.tsx");
  const piiPath = path.resolve(__dirname, "../widget/components/PIIWarningPrompt.tsx");
  const chatPanelPath = path.resolve(__dirname, "../widget/components/ChatPanel.tsx");
  const loaderSource = fs.readFileSync(loaderPath, "utf-8");
  const inputBarSource = fs.readFileSync(inputBarPath, "utf-8");
  const piiSource = fs.readFileSync(piiPath, "utf-8");
  const chatPanelSource = fs.readFileSync(chatPanelPath, "utf-8");

  it("loader iframe template has NO un-layered `* { padding: 0 }` reset (defect #1)", () => {
    // The old reset rule is gone — a universal selector rule OUTSIDE any
    // @layer wins the cascade over Tailwind v4's @layer utilities rules.
    expect(loaderSource).not.toMatch(/\*\s*\{\s*margin:\s*0;\s*padding:\s*0;\s*box-sizing:\s*border-box;\s*\}/);
    // The layout-only rule survives.
    expect(loaderSource).toMatch(/html, body, #widget-root \{ width: 100%; height: 100%; overflow: hidden; \}/);
  });

  it("InputBar textarea min-height 44px matches the send button (defect #3)", () => {
    expect(inputBarSource).toMatch(/min-h-\[44px\]/);
    // The textarea must not regress to a smaller fixed height.
    expect(inputBarSource).not.toMatch(/h-9/);
  });

  it("PIIWarningPrompt falls back to t(\"welcome.piiNotice\") for an empty piiConsent (defect #2)", () => {
    expect(piiSource).toMatch(/\{body \|\| t\("welcome\.piiNotice"\)\}/);
  });

  it("ChatPanel credits footer: justify-between + px-4, two 50% blocks (defect #4/#5)", () => {
    // The centered 3-child row (aiGenerated · credits-link) is gone.
    expect(chatPanelSource).not.toMatch(/justify-center gap-2 px-4 pb-2/);
    expect(chatPanelSource).toMatch(/flex items-center justify-between px-4 pb-2/);
    // Left block = "generato con IA" statement (w-1/2, text-left).
    expect(chatPanelSource).toMatch(/<span className="w-1\/2 text-xs text-\[#6b7280\] text-left">/);
    // Right block = credits link (w-1/2, justify-end text-right).
    expect(chatPanelSource).toMatch(/className="w-1\/2 text-xs text-\[#6b7280\] underline/);
    expect(chatPanelSource).toMatch(/inline-flex items-center justify-end text-right/);
    // The old max-w-[60%] inner-span cap is removed (blocks are now 50%).
    expect(chatPanelSource).not.toMatch(/max-w-\[60%\]/);
    // The 130 contract touch target + line-clamp-2 inner span survive.
    expect(chatPanelSource).toMatch(/min-h-\[44px\]/);
    expect(chatPanelSource).toMatch(/<span className="line-clamp-2">/);
  });

  it("ChatPanel lead submit sends the X-Session-Token header (UAT G-131-2)", () => {
    // G-131-2: the lead fetch previously omitted X-Session-Token, but the
    // /api/lead route is behind sessionMiddleware (401 "Missing session
    // token") — every lead submission failed with "Qualcosa è andato
    // storto. Riprova." The fetch headers must spread the session token.
    expect(chatPanelSource).toMatch(/fetch\(`\/api\/lead\/\$\{config\.widgetId\}`/);
    expect(chatPanelSource).toMatch(/"Content-Type": "application\/json"/);
    expect(chatPanelSource).toMatch(/\.\.\.\(sessionToken \? \{ "X-Session-Token": sessionToken \} : \{\}\)/);
    // The token must come from the chat hook and be in the deps array.
    // 151-02 (G-151-1b): the hook surface also exposes sessionLimitReached
    // (daily message limit — input disabled).
    expect(chatPanelSource).toMatch(/const \{ messages, isStreaming, error, rateLimit, sessionLimitReached, sendMessage, abortStream, clearError, sessionToken \} = chat;/);
    expect(chatPanelSource).toMatch(/\[config\.widgetId, messages, sessionToken\]/);
  });
});

// 131-05 (G-131-16): the 'Dati contatto ricevuti' indicator moved OUT of the
// ChatHeader top bar into a new dismissable ContactBanner rendered between
// ChatHeader and ErrorBar in ChatPanel. Dismissal persists via the loader
// handshake (sc-widget-{id}-contact-banner-dismissed). Same seam idiom as the
// 131-04 describe above: node-only jest env — read source, assert the
// structural contract with regex.
describe("131-05 contact banner (G-131-16)", () => {
  const chatHeaderPath = path.resolve(__dirname, "../widget/components/ChatHeader.tsx");
  const chatPanelPath = path.resolve(__dirname, "../widget/components/ChatPanel.tsx");
  const contactBannerPath = path.resolve(__dirname, "../widget/components/ContactBanner.tsx");
  const chatHeaderSource = fs.readFileSync(chatHeaderPath, "utf-8");
  const chatPanelSource = fs.readFileSync(chatPanelPath, "utf-8");
  const contactBannerSource = fs.readFileSync(contactBannerPath, "utf-8");

  it("(a) ChatHeader contains NO contactReceived and NO leadSubmitted references", () => {
    expect(chatHeaderSource).not.toContain("contactReceived");
    expect(chatHeaderSource).not.toContain("leadSubmitted");
  });

  it("(b) banner renders between ChatHeader and ErrorBar in ChatPanel", () => {
    const chatHeaderIndex = chatPanelSource.indexOf("<ChatHeader");
    const contactBannerIndex = chatPanelSource.indexOf("<ContactBanner");
    const errorBarIndex = chatPanelSource.indexOf("<ErrorBar");
    expect(chatHeaderIndex).toBeGreaterThanOrEqual(0);
    expect(contactBannerIndex).toBeGreaterThan(chatHeaderIndex);
    expect(errorBarIndex).toBeGreaterThan(contactBannerIndex);
  });

  it("(c) the banner render is gated on leadSubmitted && !contactBannerDismissed", () => {
    expect(chatPanelSource).toMatch(/leadSubmitted && !contactBannerDismissed/);
  });

  it("(d) ChatPanel persists dismissal via writeStoredValue(config.widgetId, \"contactBannerDismissed\", \"1\")", () => {
    expect(chatPanelSource).toMatch(/writeStoredValue\(config\.widgetId, "contactBannerDismissed", "1"\)/);
    // The restore read on mount must use the same key.
    expect(chatPanelSource).toMatch(/readStoredValue\(config\.widgetId, "contactBannerDismissed"\)/);
  });

  it("(e) ContactBanner has a dismiss button with onClick + aria-label + the 16px X svg (BUG-03 convention)", () => {
    expect(contactBannerSource).toMatch(/onClick=\{onDismiss\}/);
    expect(contactBannerSource).toMatch(/aria-label=\{t\("lead\.dismissLabel"\)\}/);
    expect(contactBannerSource).toMatch(/width="16" height="16" viewBox="0 0 16 16"/);
    expect(contactBannerSource).toMatch(/stroke="#6b7280"/);
    expect(contactBannerSource).toMatch(/aria-hidden="true"/);
  });
});

// 131 UAT re-test — three widget visual defects reported after the i18n +
// archive-retrieval sign-off:
//   1. 'Lascia i dati di contatto' must live BELOW the top bar, not inside it.
//   2. Assistant bubble padding must mirror the user bubble's right edge (the
//      avatar previously pushed the bubble 36px off the 16px panel inset).
//   3. Markdown code blocks must scroll horizontally inside the bubble instead
//      of expanding the bubble to full width.
describe("131 UAT re-test widget layout fixes (seam)", () => {
  const chatHeaderPath = path.resolve(__dirname, "../widget/components/ChatHeader.tsx");
  const leadBannerPath = path.resolve(__dirname, "../widget/components/LeadBanner.tsx");
  const chatPanelPath = path.resolve(__dirname, "../widget/components/ChatPanel.tsx");
  const messageBubblePath = path.resolve(__dirname, "../widget/components/MessageBubble.tsx");
  const indexCssPath = path.resolve(__dirname, "../widget/index.css");
  const chatHeaderSource = fs.readFileSync(chatHeaderPath, "utf-8");
  const leadBannerSource = fs.readFileSync(leadBannerPath, "utf-8");
  const chatPanelSource = fs.readFileSync(chatPanelPath, "utf-8");
  const messageBubbleSource = fs.readFileSync(messageBubblePath, "utf-8");
  const indexCssSource = fs.readFileSync(indexCssPath, "utf-8");

  it("(a) ChatHeader contains NO leaveContact affordance — it moved to LeadBanner below the top bar", () => {
    expect(chatHeaderSource).not.toContain("leaveContact");
    expect(chatHeaderSource).not.toMatch(/showLeadLink/);
    expect(chatHeaderSource).not.toMatch(/onLeadLinkClick/);
  });

  it("(b) ChatPanel renders LeadBanner below ChatHeader, gated on leadCaptureEnabled && !leadSubmitted && leadDismissed", () => {
    const chatHeaderIndex = chatPanelSource.indexOf("<ChatHeader");
    const leadBannerIndex = chatPanelSource.indexOf("<LeadBanner");
    expect(chatHeaderIndex).toBeGreaterThanOrEqual(0);
    expect(leadBannerIndex).toBeGreaterThan(chatHeaderIndex);
    expect(chatPanelSource).toMatch(
      /leadCaptureEnabled && !leadSubmitted && leadDismissed/,
    );
    expect(chatPanelSource).toMatch(/<LeadBanner onClick=\{handleLeadLinkClick\} \/>/);
  });

  it("(c) LeadBanner is a slim under-bar with the leaveContact label and a t() aria/text", () => {
    expect(leadBannerSource).toContain("chatHeader.leaveContact");
    expect(leadBannerSource).toMatch(/shrink-0/);
    expect(leadBannerSource).toMatch(/onClick=\{onClick\}/);
  });

  it("(d) MessageBubble no longer pushes the bubble off the 16px inset — no flex avatar gutter", () => {
    // The old flex gap-2 row (avatar 28px + gap 8px = 36px left inset) is gone.
    expect(messageBubbleSource).not.toMatch(/flex items-start gap-2/);
    // The avatar overlaps the bubble's left corner instead of pushing it.
    expect(messageBubbleSource).toMatch(/absolute -left-\[16px\]/);
    expect(messageBubbleSource).toMatch(/relative max-w-\[85%\] min-w-0/);
    // The bubble's text column can shrink so code blocks can scroll inside it.
    expect(messageBubbleSource).toMatch(/min-w-0/);
  });

  it("(e) index.css gives code blocks an internal horizontal scrollbar", () => {
    expect(indexCssSource).toMatch(/\.prose pre \{/);
    expect(indexCssSource).toMatch(/overflow-x: auto/);
    expect(indexCssSource).toMatch(/white-space: pre/);
  });
});

// 188-03 (WGTA-03, D-12/D-13): attribution links — the row gated by the
// single-flag shouldShowLinks predicate riding the Phase 130 whiteLabel chain.
// Same fs+regex seam idiom as the describes above: node-only jest env — read
// source, assert the structural contract. EXTEND ONLY — every existing regex
// pin above stays byte-intact (the credits row's pinned strings are contract).
describe("188-03 attribution links (WGTA-03, D-12/D-13)", () => {
  const chatPanelPath = path.resolve(__dirname, "../widget/components/ChatPanel.tsx");
  const useWidgetConfigPath = path.resolve(__dirname, "../widget/hooks/useWidgetConfig.ts");
  const chatPanelSource = fs.readFileSync(chatPanelPath, "utf-8");
  const useWidgetConfigSource = fs.readFileSync(useWidgetConfigPath, "utf-8");

  it("(a) ChatPanel renders the attribution row gated on shouldShowLinks(config.whiteLabel)", () => {
    expect(chatPanelSource).toMatch(/shouldShowLinks\(config\.whiteLabel\)/);
  });

  it("(b) both attribution URLs are hardcoded https constants in the REQUIREMENTS.md canonical (www) spelling", () => {
    // D-13: product constants, never admin-supplied (no config-block field)
    expect(chatPanelSource).toMatch(/https:\/\/www\.studiosimos\.it/);
    expect(chatPanelSource).toMatch(/https:\/\/www\.simmetricchat\.com/);
  });

  it("(c) each anchor opens via the sandboxed-iframe bridge: preventDefault + notifyCreditsOpen", () => {
    expect(chatPanelSource).toMatch(/e\.preventDefault\(\);\s*\n\s*notifyCreditsOpen\("https:\/\/www\.studiosimos\.it"\)/);
    expect(chatPanelSource).toMatch(/e\.preventDefault\(\);\s*\n\s*notifyCreditsOpen\("https:\/\/www\.simmetricchat\.com"\)/);
  });

  it("(d) attribution anchors keep the 44px touch target + line-clamp-2 on an INNER span (Phase 131 discipline)", () => {
    // min-h-[44px] on the anchors (already pinned for the credits anchor —
    // here we assert the attribution row carries the same discipline).
    expect(chatPanelSource).toMatch(/className="w-1\/2 text-xs text-\[#6b7280\] underline underline-offset-2 hover:text-\[var\(--widget-primary\)\] min-h-\[44px\] inline-flex items-center justify-start text-left"/);
    expect(chatPanelSource).toMatch(/className="w-1\/2 text-xs text-\[#6b7280\] underline underline-offset-2 hover:text-\[var\(--widget-primary\)\] min-h-\[44px\] inline-flex items-center justify-end text-right"/);
  });

  it("(e) the attribution row sits ABOVE the credits row (credits keeps its last-child position — Pitfall 5)", () => {
    const attributionIndex = chatPanelSource.indexOf('shouldShowLinks(config.whiteLabel)');
    const creditsIndex = chatPanelSource.indexOf("shouldShowCredits(config.whiteLabel, config.credits)");
    expect(attributionIndex).toBeGreaterThanOrEqual(0);
    expect(creditsIndex).toBeGreaterThan(attributionIndex);
  });

  it("(f) shouldShowLinks is exported from the hook file with the single-flag !whiteLabel body (D-12 verbatim semantics)", () => {
    expect(useWidgetConfigSource).toMatch(/export function shouldShowLinks\(whiteLabel: boolean\): boolean \{\s*\n\s*return !whiteLabel;\s*\n\s*\}/);
  });
});

// 188-03 (WGTA-02, D-09/D-10): the product fallback mark — a self-contained
// Preact copy of the Monogram geometry rendered in ChatHeader's logo slot and
// WelcomeScreen's avatar circle when the admin logoUrl/avatarUrl are ABSENT.
// Same fs+regex seam idiom; EXTEND ONLY (existing pins stay byte-intact). The
// loader FAB fallback chain geometry is NOT touched here — loader.test.ts
// pins setFabContent structure and those pins must stay green unmodified.
describe("188-03 product fallback mark (WGTA-02, D-09/D-10)", () => {
  const productMarkPath = path.resolve(__dirname, "../widget/components/ProductMark.tsx");
  const chatHeaderPath = path.resolve(__dirname, "../widget/components/ChatHeader.tsx");
  const welcomeScreenPath = path.resolve(__dirname, "../widget/components/WelcomeScreen.tsx");
  const productMarkSource = fs.readFileSync(productMarkPath, "utf-8");
  const chatHeaderSource = fs.readFileSync(chatHeaderPath, "utf-8");
  const welcomeScreenSource = fs.readFileSync(welcomeScreenPath, "utf-8");

  it("(a) ProductMark.tsx exists as a self-contained Preact copy of the Monogram geometry", () => {
    // The #FDFAF4 rounded-square background + the "S" text glyph (a brand
    // mark, NOT a UI icon surface — the Phase 131 zero-text-glyphs rule
    // targets close/send buttons; research Pattern 5 caveat).
    expect(productMarkSource).toMatch(/viewBox="0 0 32 32"/);
    expect(productMarkSource).toMatch(/<rect width="32" height="32" rx="8" ry="8" fill="#FDFAF4" \/>/);
    expect(productMarkSource).toMatch(/textAnchor="middle"/);
    expect(productMarkSource).toMatch(/aria-label="Simmetric Chat"/);
  });

  it("(b) ProductMark imports NOTHING from packages/frontend (IIFE boundary)", () => {
    expect(productMarkSource).not.toMatch(/from "\.\.\/\.\.\/\.\.\/\.\.\/frontend/);
    expect(productMarkSource).not.toMatch(/@simmetric-chat\/frontend/);
    expect(productMarkSource).not.toMatch(/import .*Monogram/);
  });

  it("(c) ChatHeader renders ProductMark when logoUrl is absent, keeping the img branch when present", () => {
    // The img branch is retained (admin override path) and the ProductMark
    // fallback sits in the else path.
    expect(chatHeaderSource).toMatch(/logoUrl \? \(/);
    expect(chatHeaderSource).toMatch(/<ProductMark/);
    expect(chatHeaderSource).toMatch(/w-7 h-7 rounded-full object-contain mr-2/);
  });

  it("(d) WelcomeScreen renders ProductMark when config.avatarUrl is absent (primary circle preserved)", () => {
    expect(welcomeScreenSource).toMatch(/config\.avatarUrl \? \(/);
    expect(welcomeScreenSource).toMatch(/<ProductMark/);
    // The primary-colored circle geometry is preserved (D-10 restyle-not-rebuild).
    expect(welcomeScreenSource).toMatch(/w-12 h-12 rounded-full flex items-center justify-center mb-4/);
    expect(welcomeScreenSource).toMatch(/var\(--widget-primary\)/);
  });
});
