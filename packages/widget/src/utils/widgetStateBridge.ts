// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// 260808-wtz: notify the host page when the chat opens/closes so the loader can
// toggle pointer-events on the embed container (the snippet's inline
// `pointer-events: none` keeps the host page unblocked when closed, but the
// opened panel must be interactive).
//
// Outbound iframe->parent bridge — same convention as postStorageToLoader in
// useWidgetChat.ts: target "*" is safe because the sandboxed iframe has an
// opaque origin and postMessage on window.parent delivers only to the parent
// window. Inbound validation (event.source === iframeEl.contentWindow) lives on
// the loader side.
export function notifyOpenState(isOpen: boolean): void {
  if (typeof window === "undefined" || !window.parent) return;
  window.parent.postMessage(
    { type: isOpen ? "simmetric:widgetOpen" : "simmetric:widgetClose" },
    "*"
  );
}

// 260809-i6b: tell the host page the widget's effective primaryColor so the
// loader can paint the host-page open/close FAB with the per-widget color the
// admin set in WidgetForm (the embed snippet only bakes the GLOBAL branding
// color via data-primary-color — the iframe knows the real one from the JSON
// block). Same outbound bridge convention as notifyOpenState: target "*" is
// safe (sandboxed iframe, opaque origin — postMessage on window.parent
// delivers only to the parent window); the loader re-validates inbound anyway
// (defense-in-depth across the iframe->host trust boundary).
//
// The helper owns the hex validation — the SAME regex literal as
// useWidgetConfig.ts (--widget-primary) — so App.tsx stays a one-liner and the
// contract is unit-testable. A non-hex payload is a no-op: nothing is posted.
export function notifyWidgetConfig(primaryColor: string): void {
  if (typeof window === "undefined" || !window.parent) return;
  if (!/^#[0-9a-f]{6}$/i.test(primaryColor)) return;
  window.parent.postMessage(
    { type: "simmetric:widgetConfig", primaryColor },
    "*"
  );
}

// 130-01 (D-02): the credits link opens in a new tab via a postMessage bridge
// to the host page — the sandboxed iframe (allow-scripts allow-forms, no
// allow-popups) cannot window.open itself. Same outbound-bridge convention as
// notifyOpenState/notifyWidgetConfig: target "*" is safe (opaque-origin
// sandboxed iframe — postMessage on window.parent delivers only to the parent
// window); the loader's inbound event.source check is the real authentication.
//
// The helper owns the http/https prefix validation — the SAME allowlist
// literal as isValidUrl in useWidgetConfig.ts and the widgetCreditsSchema
// refine (widget.schema.ts) — so a javascript:/data:/ftp: payload is a no-op,
// never a post. The LOADER_JS relay re-validates the URL across the
// iframe→host trust boundary before window.open (defense-in-depth).
export function notifyCreditsOpen(url: string): void {
  if (typeof window === "undefined" || !window.parent) return;
  // typeof guard keeps null/undefined a no-op (never throw) — same defensive
  // posture as isValidUrl's !!url short-circuit; the allowlist literal is the
  // SAME http/https prefix check as useWidgetConfig.ts + widgetCreditsSchema.
  if (typeof url !== "string" || !(url.startsWith("http://") || url.startsWith("https://"))) return;
  window.parent.postMessage(
    { type: "simmetric:creditsOpen", url },
    "*"
  );
}
