// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

// 260808-wtz: the widget must tell the host page when the chat opens/closes so
// the loader can toggle pointer-events on the embed container (the snippet's
// inline `pointer-events: none` otherwise keeps the open panel non-interactive).
//
// notifyOpenState is a pure client-side bridge helper: it posts
// simmetric:widgetOpen / simmetric:widgetClose to window.parent with the "*" target,
// matching the existing outbound-bridge convention (useWidgetChat.ts
// postStorageToLoader — sandboxed iframe has an opaque origin, postMessage on
// window.parent delivers only to the parent window). The inbound validation
// (event.source === iframeEl.contentWindow) lives in the LOADER_JS listener.
import { notifyOpenState, notifyWidgetConfig, notifyCreditsOpen } from "../utils/widgetStateBridge";

describe("notifyOpenState — open/close postMessage bridge (260808-wtz)", () => {
  let postMessageMock: jest.Mock;
  let originalWindow: typeof global.window | undefined;

  beforeEach(() => {
    postMessageMock = jest.fn();
    originalWindow = (global as { window?: typeof global.window }).window;
    (global as unknown as { window: { parent: { postMessage: jest.Mock } } }).window = {
      parent: { postMessage: postMessageMock },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as unknown as { window?: typeof global.window }).window;
    } else {
      (global as unknown as { window: typeof global.window }).window = originalWindow;
    }
  });

  it("notifyOpenState(true) posts { type: \"simmetric:widgetOpen\" } to window.parent with \"*\" target", () => {
    notifyOpenState(true);

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = postMessageMock.mock.calls[0] as unknown as [any, string];
    expect(firstCall[0]).toEqual({ type: "simmetric:widgetOpen" });
    expect(firstCall[1]).toBe("*");
  });

  it("notifyOpenState(false) posts { type: \"simmetric:widgetClose\" } to window.parent with \"*\" target", () => {
    notifyOpenState(false);

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = postMessageMock.mock.calls[0] as unknown as [any, string];
    expect(firstCall[0]).toEqual({ type: "simmetric:widgetClose" });
    expect(firstCall[1]).toBe("*");
  });

  it("does NOT throw when window.parent is unavailable (direct iframe navigation, not embedded)", () => {
    // Remove the window mock entirely — no window in this node env means the
    // helper's guard must no-op instead of throwing.
    delete (global as unknown as { window?: typeof global.window }).window;

    expect(() => notifyOpenState(true)).not.toThrow();
    expect(() => notifyOpenState(false)).not.toThrow();
  });
});

// 260809-i6b: the host-page open/close FAB (created by LOADER_JS on real
// embeds) must be painted with the per-widget primaryColor the admin set in
// WidgetForm, not the global branding color baked into the embed snippet. The
// iframe already knows the effective color (route-resolved into the JSON
// block) — notifyWidgetConfig posts it to the host once on mount; the loader's
// WR-01-guarded relay listener applies it to fab.style.backgroundColor.
//
// Same outbound-bridge convention as notifyOpenState: target "*" is safe (the
// sandboxed iframe has an opaque origin — postMessage on window.parent
// delivers only to the parent window); inbound validation lives on the loader
// side. The helper owns the hex validation (same regex literal as
// useWidgetConfig.ts --widget-primary) so App.tsx stays a one-liner and the
// contract is unit-testable.
describe("notifyWidgetConfig — primaryColor postMessage bridge (260809-i6b)", () => {
  let postMessageMock: jest.Mock;
  let originalWindow: typeof global.window | undefined;

  beforeEach(() => {
    postMessageMock = jest.fn();
    originalWindow = (global as { window?: typeof global.window }).window;
    (global as unknown as { window: { parent: { postMessage: jest.Mock } } }).window = {
      parent: { postMessage: postMessageMock },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as unknown as { window?: typeof global.window }).window;
    } else {
      (global as unknown as { window: typeof global.window }).window = originalWindow;
    }
  });

  it("notifyWidgetConfig(\"#123abc\") posts { type: \"simmetric:widgetConfig\", primaryColor } to window.parent with \"*\" target", () => {
    notifyWidgetConfig("#123abc");

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = postMessageMock.mock.calls[0] as unknown as [any, string];
    expect(firstCall[0]).toEqual({ type: "simmetric:widgetConfig", primaryColor: "#123abc" });
    expect(firstCall[1]).toBe("*");
  });

  it.each([
    ["red", "named color"],
    ["#12345", "5-digit hex"],
    ["#1234567", "7-digit hex"],
    ["", "empty string"],
    [null, "null"],
  ])("notifyWidgetConfig(%p) does NOT post (%s)", (color) => {
    notifyWidgetConfig(color as unknown as string);

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT throw when window.parent is unavailable (direct iframe navigation, not embedded)", () => {
    // Remove the window mock entirely — no window in this node env means the
    // helper's guard must no-op instead of throwing.
    delete (global as unknown as { window?: typeof global.window }).window;

    expect(() => notifyWidgetConfig("#123abc")).not.toThrow();
  });
});

// 130-01 (D-02): the credits link opens in a new tab via a postMessage bridge
// to the host page — the sandboxed iframe (allow-scripts allow-forms, no
// allow-popups) cannot window.open itself. notifyCreditsOpen posts
// simmetric:creditsOpen with the validated URL; the LOADER_JS relay re-validates
// and calls window.open. Same outbound-bridge convention as notifyOpenState /
// notifyWidgetConfig: target "*" is safe (opaque-origin sandboxed iframe), the
// loader's inbound event.source check is the real authentication. The helper
// owns the http/https prefix validation — the SAME allowlist literal as
// isValidUrl in useWidgetConfig.ts and the widgetCreditsSchema refine — so a
// javascript:/data:/ftp: payload is a no-op, never a post.
describe("notifyCreditsOpen — credits URL postMessage bridge (130-01, D-02)", () => {
  let postMessageMock: jest.Mock;
  let originalWindow: typeof global.window | undefined;

  beforeEach(() => {
    postMessageMock = jest.fn();
    originalWindow = (global as { window?: typeof global.window }).window;
    (global as unknown as { window: { parent: { postMessage: jest.Mock } } }).window = {
      parent: { postMessage: postMessageMock },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as unknown as { window?: typeof global.window }).window;
    } else {
      (global as unknown as { window: typeof global.window }).window = originalWindow;
    }
  });

  it("notifyCreditsOpen(\"https://simmetric.chat\") posts { type: \"simmetric:creditsOpen\", url } to window.parent with \"*\" target", () => {
    notifyCreditsOpen("https://simmetric.chat");

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = postMessageMock.mock.calls[0] as unknown as [any, string];
    expect(firstCall[0]).toEqual({ type: "simmetric:creditsOpen", url: "https://simmetric.chat" });
    expect(firstCall[1]).toBe("*");
  });

  it("notifyCreditsOpen(\"http://example.com\") posts — http is allowed by the allowlist", () => {
    notifyCreditsOpen("http://example.com");

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = postMessageMock.mock.calls[0] as unknown as [any, string];
    expect(firstCall[0]).toEqual({ type: "simmetric:creditsOpen", url: "http://example.com" });
  });

  it.each([
    ["javascript:alert(1)", "javascript: scheme"],
    ["data:text/html,<script>alert(1)</script>", "data: scheme"],
    ["ftp://example.com/file", "ftp: scheme"],
    ["", "empty string"],
    [null, "null"],
  ])("notifyCreditsOpen(%p) does NOT post (%s)", (url) => {
    notifyCreditsOpen(url as unknown as string);

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT throw when window.parent is unavailable (direct iframe navigation, not embedded)", () => {
    delete (global as unknown as { window?: typeof global.window }).window;

    expect(() => notifyCreditsOpen("https://simmetric.chat")).not.toThrow();
  });
});
