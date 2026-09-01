// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

// WID-03 D-05/D-06: loader JS must expose a postMessage storage handshake so the
// sandboxed iframe can persist token + message history in the parent-page
// sessionStorage (stable origin) instead of the opaque iframe sessionStorage.
//
// We assert against the LOADER_JS string served by GET /widget/:widgetId.js. The
// iframe sandbox must NOT include allow-same-origin (T-65-03 guardrail).
jest.mock("../services/widgetApi", () => ({
  createSession: jest.fn(),
  getWidgetConfig: jest.fn(),
  validateSession: jest.fn(),
  incrementSessionCounters: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../index";
import { getWidgetConfig } from "../services/widgetApi";

const mockedGetWidgetConfig = getWidgetConfig as jest.Mock;

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetWidgetConfig.mockResolvedValue({
    id: "widget-1",
    name: "x",
    isActive: true,
    workspaceId: "ws-1",
    primaryColor: "#000",
    botName: "bot",
    welcomeMessage: "",
    fallbackMessage: "",
    allowedOrigins: [],
  });
});

describe("GET /widget/:widgetId.js (loader JS)", () => {
  it("serves loader JS with the postMessage storage handshake (WID-03)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/javascript/);
    // Storage handshake message types (D-05)
    expect(res.text).toContain("simmetric:storage-get");
    expect(res.text).toContain("simmetric:storage-data");
    expect(res.text).toContain("simmetric:storage-set");
  });

  it("iframe sandbox does NOT include allow-same-origin (WID-03 D-06 / T-65-03 guardrail)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Sandbox attribute must be exactly allow-scripts allow-forms
    expect(res.text).toMatch(/sandbox\s*=\s*["']allow-scripts allow-forms["']/);
    // Hard guardrail: never allow-same-origin
    expect(res.text).not.toContain("allow-same-origin");
  });

  it("loader uses namespaced sessionStorage keys sc-widget-${widgetId}-session|messages", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Namespaced key prefix sc-widget- (session + messages helpers)
    expect(res.text).toContain("sc-widget-");
  });

  // 260809-uxk (consent deadlock): the storage key map is extended with the
  // consent + lead-submitted keys — the sandboxed iframe's own sessionStorage
  // throws SecurityError on the opaque origin, so consent/lead state must be
  // persisted by the loader under sc-widget-{id}-consent / -lead-submitted.
  it("maps consent and lead-submitted keys to sc-widget-${widgetId}-consent|-lead-submitted (260809-uxk)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Key-construction helpers for the two new keys
    expect(res.text).toContain("'sc-widget-' + widgetId + '-consent'");
    expect(res.text).toContain("'sc-widget-' + widgetId + '-lead-submitted'");
    // The storage-get loop and storage-set branch must consult the same map —
    // no key may be silently dropped (consent read on reload must reach the map).
    expect(res.text).toContain("'-consent'");
    expect(res.text).toContain("'-lead-submitted'");
  });

  // 131-05 (G-131-18): the storage-data reply echoes the request's requestId
  // so the iframe can correlate replies to requests (concurrent reads no
  // longer misroute). The key map gains the contactBannerDismissed key
  // (G-131-16 — Task 2's banner persistence depends on it).
  it("storage-data reply echoes msg.requestId (G-131-18 correlation)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The reply postMessage carries the echoed request id from the request.
    expect(res.text).toContain("requestId: msg.requestId");
  });

  it("maps contactBannerDismissed to sc-widget-${widgetId}-contact-banner-dismissed (G-131-16)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.text).toContain("'sc-widget-' + widgetId + '-contact-banner-dismissed'");
  });

  it("data-locale has NO English default — absent attribute leaves locale null (Pitfall 3)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Bare attribute read form, no OR-combined quoted "en" default
    expect(res.text).toMatch(/var locale = container\.getAttribute\("data-locale"\);/);
    expect(res.text).not.toMatch(/getAttribute\("data-locale"\)\s*\|\|\s*"en"/);
  });

  it("&locale= is appended conditionally — only when data-locale is present", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The conditional append structure: truthiness guard around the locale segment
    expect(res.text).toMatch(/if \(locale\) \{/);
    expect(res.text).toContain('"&locale=" + encodeURIComponent(locale)');
  });

  // G-127-1 (gap: widget ignores host page <html lang>) + data-locale-source:
  // the embed container can now select WHERE the widget language comes from —
  // explicit (data-locale only) / browser (always omit ?locale=) / page
  // (<html lang> only) / auto (default: data-locale wins, else <html lang>).
  // These are string-level structural assertions (node test env, LOADER_JS is
  // served text) proving the selector is wired; the behavioral chain is proven
  // by the route tests D/E/F/H below (explicit ?locale= wins, absent ?locale=
  // fires Accept-Language, unknown tag falls through). The real-browser re-check
  // is the UAT re-test (127-UAT.md Test 1).

  it("data-locale-source: selector read with auto default (G-127-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The attribute read + default: absent attribute → "auto" mode
    expect(res.text).toContain('var localeSource = container.getAttribute("data-locale-source") || "auto";');
  });

  it("data-locale-source: all 4 mode branches are wired (G-127-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.text).toContain('localeSource === "browser"');
    expect(res.text).toContain('localeSource === "page"');
    expect(res.text).toContain('localeSource === "explicit"');
    expect(res.text).toContain('localeSource === "auto" && !locale');
  });

  it("data-locale-source: browser mode forces locale = null → ?locale= omitted (G-127-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Nils the locale regardless of data-locale/page lang; the untouched
    // conditional append then omits ?locale= and the route's Accept-Language
    // detection fires (loader.test.ts Test E behavior).
    expect(res.text).toMatch(/localeSource === "browser"\)\s*\{\s*locale = null;/);
  });

  it("data-locale-source: page mode suppresses data-locale + normalizes <html lang> (G-127-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // data-locale suppressed first — page mode is the ONLY source
    expect(res.text).toMatch(/localeSource === "page"\)\s*\{\s*locale = null;/);
    // The host-page lang read feeds the inline normalization chain
    expect(res.text).toContain("document.documentElement.lang");
    // The token gate is a LITERAL [a-z]{2,3} anchored regex (en-EN → en admitted,
    // en_US/*/empty rejected). NOTE: no negated character class [^a-z] — that
    // matches the wrong text.
    expect(res.text).toContain("[a-z]{2,3}");
    // Assignment pin: gate pass → locale = primary → &locale= appended
    expect(res.text).toMatch(/\.test\(primary\)\)\s*\{\s*locale = primary;/);
  });

  it("data-locale-source: auto mode gates page-lang read behind !locale (SC5, G-127-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The page-lang consult runs only in auto mode AND when data-locale is
    // absent — data-locale keeps first-wins (SC5, route Test D). When the gate
    // fails, locale stays null and the untouched append omits ?locale= (Pitfall 3).
    expect(res.text).toMatch(/localeSource === "auto" && !locale/);
  });

  it("data-locale-source: no OR-combined 'en' default in any mode (Pitfall 3, G-127-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // browser/page modes nil via `locale = null;`, never a quoted default; the
    // existing Pitfall-3 test above pins the exact `var locale` form unmodified.
    expect(res.text).not.toContain('|| "en"');
  });

  // G-128-1 (gap: admin-saved primary color not reflected on plain embeds):
  // LOADER_JS must NOT send ?primaryColor= / ?position= with hardcoded defaults
  // when the embed container lacks the data attributes — an always-sent default
  // query param shadows the server config (Pitfall 3, same class as the Phase
  // 127 ?locale=en landmine). The route (GET /:widgetId) already falls back to
  // config.primaryColor / config.position when the param is absent.

  it("data-primary-color has NO default — absent attribute leaves primaryColor null (Pitfall 3, G-128-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Bare attribute read form, no OR-combined quoted "#4c6ef5" default
    expect(res.text).toMatch(/var primaryColor = container\.getAttribute\("data-primary-color"\);/);
    expect(res.text).not.toMatch(/getAttribute\("data-primary-color"\)\s*\|\|\s*"#4c6ef5"/);
  });

  it("data-position has NO default — absent attribute leaves position null (Pitfall 3, G-128-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Bare attribute read form, no OR-combined quoted "bottom-right" default
    expect(res.text).toMatch(/var position = container\.getAttribute\("data-position"\);/);
    expect(res.text).not.toMatch(/getAttribute\("data-position"\)\s*\|\|\s*"bottom-right"/);
  });

  it("?primaryColor= and ?position= are omitted when the container lacks the data attributes (G-128-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The params array is built conditionally — primaryColor/position are
    // pushed only inside truthiness guards, never unconditionally.
    expect(res.text).toMatch(/if \(primaryColor\) \{/);
    expect(res.text).toMatch(/if \(position\) \{/);
    // The old unconditional concatenation form must be gone
    expect(res.text).not.toContain('"?primaryColor=" + encodeURIComponent(primaryColor)');
    expect(res.text).not.toContain('"&position=" + encodeURIComponent(position)');
  });

  it("primaryColor/position are pushed only when the data attributes are present (attribute-wins, G-128-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The attribute-wins path: the pushed segment carries the attribute value
    expect(res.text).toContain('params.push("primaryColor=" + encodeURIComponent(primaryColor))');
    expect(res.text).toContain('params.push("position=" + encodeURIComponent(position))');
  });

  it("query string is prefixed with ? only when the params array is non-empty (G-128-1)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Never a bare "&" on an empty query — the "?" prefix is conditional on a
    // non-empty params array.
    expect(res.text).toContain('var query = params.length ? "?" + params.join("&") : "";');
  });

  // G-128-2 (gap: FAB unclickable after close): the open/close FAB moves to the
  // HOST page for real embeds. LOADER_JS appends &hostFab=1 to the iframe query
  // (the iframe app then hides its own ChatFab), creates the host FAB button
  // (always pointer-events:auto, outside the pointer-events:none iframe), and
  // coordinates open/close via the simmetric:widgetOpen/simmetric:widgetClose bridge.

  it("appends hostFab=1 to the iframe query (G-128-2)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // hostFab=1 is always pushed into the params array (real embeds)
    expect(res.text).toContain('params.push("hostFab=1")');
  });

  it("creates the host FAB button with always pointer-events:auto (G-128-2)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The host FAB is a button appended to the embed container, outside the
    // iframe, and must stay clickable while the closed iframe is
    // pointer-events:none.
    expect(res.text).toContain('var fab = document.createElement("button")');
    expect(res.text).toContain("container.appendChild(fab)");
    expect(res.text).toContain("pointer-events:auto");
  });

  it("host FAB click posts simmetric:widgetOpen to the iframe and lifts pointer-events (G-128-2)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The click handler posts the open message to the iframe contentWindow and
    // makes the container interactive (the iframe's simmetric:widgetClose bridge
    // restores pointer-events:none + resets the FAB icon).
    expect(res.text).toContain('{ type: "simmetric:widgetOpen" }');
    expect(res.text).toContain("iframeEl.contentWindow.postMessage");
    expect(res.text).toContain('container.style.pointerEvents = "auto"');
  });

  it("simmetric:widgetClose resets the host FAB to its closed state (G-128-2)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // On close the bridge restores pointer-events:none AND resets the FAB
    // (aria-expanded=false + closed icon) — the FAB itself stays clickable.
    expect(res.text).toContain('fab.setAttribute("aria-expanded", "false")');
    expect(res.text).toMatch(/container\.style\.pointerEvents = "none"/);
  });

  // 260809-ipv (gap: the host FAB only opens, never closes; auto-open leaves it
  // visually stuck closed): LOADER_JS gains a shared `fabOpen` boolean in the
  // outer closure (read/written by BOTH the FAB-creation IIFE and the relay
  // IIFE), the FAB click handler toggles open/close, and the relay's
  // simmetric:widgetOpen branch repaints the FAB (auto-open sync). String-level
  // structural assertions — LOADER_JS is served text (node env cannot run
  // browser JS).

  it("loader tracks FAB open state in a shared fabOpen variable initialized to false (260809-ipv)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The shared-state declaration at the outer-IIFE level, initialized closed
    expect(res.text).toMatch(/fabOpen\s*=\s*false;/);
    // The variable must be read/written by BOTH IIFEs (declaration + click
    // toggle + relay open/close branches) — a single private copy inside one
    // IIFE would break the sync.
    expect((res.text.match(/fabOpen/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("host FAB click when open posts simmetric:widgetClose and closes (260809-ipv)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The close branch of the toggle: posts the close message, restores
    // pointer-events:none, resets aria-expanded + FAB content.
    expect(res.text).toContain('{ type: "simmetric:widgetClose" }');
    expect(res.text).toContain('fab.setAttribute("aria-expanded", "false")');
    expect(res.text).toMatch(/container\.style\.pointerEvents = "none"/);
    // The fabOpen conditional lives inside the click handler — it must appear
    // BEFORE the open postMessage in the served text (the toggle branches on
    // the shared state, then posts the open message in the else path).
    const fabOpenConditionalIndex = res.text.indexOf("if (fabOpen)");
    const openPostIndex = res.text.indexOf('{ type: "simmetric:widgetOpen" }');
    expect(fabOpenConditionalIndex).toBeGreaterThanOrEqual(0);
    expect(openPostIndex).toBeGreaterThan(fabOpenConditionalIndex);
  });

  it("simmetric:widgetOpen relay updates the host FAB (auto-open sync, 260809-ipv)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The relay's open branch repaints the FAB (close icon + aria-expanded)
    // so auto-open (autoOpenDelay/URL/exit-intent) leaves the FAB visually OPEN.
    expect(res.text).toContain("setFabContent(fab, true)");
    expect(res.text).toContain('fab.setAttribute("aria-expanded", "true")');
    // Structural placement: the WR-01 source check must precede the open-branch
    // FAB update in the served text — host-page scripts or sibling iframes
    // cannot forge simmetric:widgetOpen to repaint the FAB (T-01 mitigate). The
    // relay branch is the LAST occurrence of the FAB-open literals (the click
    // handler's open branch comes earlier in the text).
    const guardIndex = res.text.indexOf("event.source !== iframeEl.contentWindow");
    const fabUpdateIndex = res.text.lastIndexOf("setFabContent(fab, true)");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(fabUpdateIndex).toBeGreaterThan(guardIndex);
  });

  // 260808-wtz: open/close state relay — the loader must toggle the container's
  // pointer-events when the iframe posts simmetric:widgetOpen / simmetric:widgetClose,
  // and MUST validate the sender first (WR-01, same guard as the storage
  // handshake) so host-page scripts or sibling iframes cannot forge the toggle.

  it("listens for simmetric:widgetOpen and sets container.style.pointerEvents = \"auto\" (260808-wtz)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.text).toContain("simmetric:widgetOpen");
    // The assignment form must be the double-quoted string, matching the
    // message listener that toggles interactivity on open.
    expect(res.text).toMatch(/container\.style\.pointerEvents = "auto"/);
  });

  it("restores pointer-events: none on simmetric:widgetClose (260808-wtz)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.text).toContain("simmetric:widgetClose");
    expect(res.text).toMatch(/container\.style\.pointerEvents = "none"/);
  });

  it("validates the sender against iframeEl.contentWindow before toggling (WR-01, 260808-wtz)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The WR-01 guard pattern — the listener must compare event.source against
    // our iframe's contentWindow before acting on any message.
    expect(res.text).toContain("event.source !== iframeEl.contentWindow");
  });

  // 260809-i6b (gap: host FAB shows the GLOBAL branding color, never the
  // per-widget primaryColor): the iframe posts its effective color once on
  // mount (notifyWidgetConfig → simmetric:widgetConfig); the loader repaints the
  // host FAB's background-color. String-level structural assertions — LOADER_JS
  // is served text (node env cannot run browser JS).

  it("listens for simmetric:widgetConfig from the iframe (260809-i6b)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.text).toContain("simmetric:widgetConfig");
  });

  it("applies the config color to the host FAB background-color (260809-i6b)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The exact assignment form — the FAB repaint overrides just the
    // background-color property (creation-time cssText keeps everything else).
    expect(res.text).toContain("fab.style.backgroundColor = msg.primaryColor");
  });

  it("validates hex before applying the color — anchored #rrggbb regex (260809-i6b)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The anchored hex form shared with useWidgetConfig.ts (--widget-primary):
    // [0-9a-f]{6} inside ^#...$ — a malformed payload ("red", "url(...)") is
    // ignored, so no arbitrary CSS value can be injected into the host page.
    expect(res.text).toContain("[0-9a-f]{6}");
    expect(res.text).toMatch(/\^#\[0-9a-f\]\{6\}\$\/i/);
  });

  it("the simmetric:widgetConfig branch lives inside the WR-01-guarded relay listener (260809-i6b)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Structural placement: the WR-01 source check must precede the config
    // branch in the served text — host-page scripts or sibling iframes cannot
    // forge a config message to repaint the FAB (T-01 mitigate).
    const guardIndex = res.text.indexOf("event.source !== iframeEl.contentWindow");
    const branchIndex = res.text.indexOf("simmetric:widgetConfig");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(branchIndex).toBeGreaterThan(guardIndex);
  });

  // 130-01 (D-02, CRD-03): the credits link opens in a new tab via the
  // postMessage bridge — the iframe posts simmetric:creditsOpen, the LOADER_JS
  // relay (inside the WR-01-guarded listener) re-validates the URL against the
  // http/https allowlist and calls window.open(u, '_blank', 'noopener'). The
  // sandbox stays allow-scripts allow-forms (no allow-popups — D-02 locked).

  it("listens for simmetric:creditsOpen from the iframe (130-01, D-02)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.text).toContain("simmetric:creditsOpen");
  });

  it("re-validates the URL with the http/https prefix allowlist before window.open (130-01, T-130-02)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The SAME http/https prefix allowlist literal as widgetStateBridge +
    // widgetCreditsSchema refine — a javascript:/data:/ftp: payload is a no-op.
    expect(res.text).toContain("u.indexOf('http://') === 0");
    expect(res.text).toContain("u.indexOf('https://') === 0");
    // window.open with the noopener feature — never a bare window.open(u).
    expect(res.text).toContain("window.open(u, '_blank', 'noopener')");
  });

  it("the simmetric:creditsOpen branch lives inside the WR-01-guarded relay listener (130-01, T-130-01)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // Structural placement: the WR-01 source check must precede the credits
    // branch — host-page scripts or sibling iframes cannot forge a creditsOpen
    // message to make the host open an arbitrary URL.
    const guardIndex = res.text.indexOf("event.source !== iframeEl.contentWindow");
    const branchIndex = res.text.indexOf("simmetric:creditsOpen");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(branchIndex).toBeGreaterThan(guardIndex);
  });
});

// Phase 127 (D-01/D-02/D-06): the iframe HTML carries the fully-resolved flat
// client config in one JSON script block; the 17 data-* attributes are retired.
// These tests are the Wave 0 regression suite from 127-VALIDATION.md.
describe("GET /widget/:widgetId (iframe HTML)", () => {
  // Extract the JSON block text between the widget-config script tags.
  const extractBlock = (html: string): string => {
    const match = html.match(/<script type="application\/json" id="widget-config">([\s\S]*?)<\/script>/);
    if (!match) throw new Error("widget-config block not found in served HTML");
    return match[1];
  };

  const baseFixture = {
    id: "widget-1",
    name: "x",
    isActive: true,
    workspaceId: "ws-1",
    primaryColor: "#000",
    botName: "bot",
    welcomeMessage: "",
    fallbackMessage: "",
    allowedOrigins: [],
    position: "bottom-right",
    fallbackLocale: "it",
    localizedTexts: {
      en: { welcomeMessage: "Hello there & welcome!" },
      it: { welcomeMessage: "Ciao e benvenuto" },
      de: { welcomeMessage: "Willkommen" },
    },
    suggestedQuestions: {
      en: ["What's this?"],
      de: ["Was ist das?"],
    },
  };

  it("Test A (SC2 round-trip): spaces, &, accents round-trip byte-exact through the JSON block", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app).get("/widget/widget-1?locale=en");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.welcomeMessage).toBe("Hello there & welcome!");
  });

  it("Test B (</script> breakout): escaped via \\u003c, JSON.parse round-trips exactly", async () => {
    mockedGetWidgetConfig.mockResolvedValue({
      ...baseFixture,
      localizedTexts: { en: { welcomeMessage: "Hi </script><script>alert(1)</script> world" } },
    });
    const res = await request(app).get("/widget/widget-1?locale=en");

    expect(res.status).toBe(200);
    // The served HTML must contain the escaped form, never a literal </script> from the payload
    expect(res.text).toContain("\\u003c/script");
    const block = JSON.parse(extractBlock(res.text));
    expect(block.welcomeMessage).toBe("Hi </script><script>alert(1)</script> world");
  });

  it("Test C (D-01 retirement): no data-* attributes remain in the served HTML", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app).get("/widget/widget-1?locale=en");

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("data-welcome-message");
    expect(res.text).not.toContain("data-suggested-questions");
    expect(res.text).not.toContain("data-locale");
    expect(res.text).not.toContain("data-auto-open-url-patterns");
    expect(res.text).not.toContain("data-lead-capture-prompt");
  });

  it("Test D (SC5 explicit override wins): ?locale=de beats Accept-Language fr-FR", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app)
      .get("/widget/widget-1?locale=de")
      .set("Accept-Language", "fr-FR");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.locale).toBe("de");
  });

  it("Test E (Accept-Language detection): absent ?locale= is treated as absent — de-DE browser gets de", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app)
      .get("/widget/widget-1")
      .set("Accept-Language", "de-DE,de;q=0.9,en;q=0.8");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.locale).toBe("de");
  });

  it("Test F (fallbackLocale tier): no query, no Accept-Language → fallbackLocale it + its texts", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app).get("/widget/widget-1");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.locale).toBe("it");
    expect(block.welcomeMessage).toBe("Ciao e benvenuto");
  });

  it("Test G (SC3 <html lang>): derives from resolved locale for zh, de, es", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const zh = await request(app).get("/widget/widget-1?locale=zh");
    expect(zh.text).toMatch(/<html lang="zh">/);

    const de = await request(app).get("/widget/widget-1?locale=de");
    expect(de.text).toMatch(/<html lang="de">/);

    const es = await request(app).get("/widget/widget-1?locale=es");
    expect(es.text).toMatch(/<html lang="es">/);
  });

  it("Test H (invalid ?locale= falls through): ?locale=xx + Accept-Language fr → fr", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app)
      .get("/widget/widget-1?locale=xx")
      .set("Accept-Language", "fr");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.locale).toBe("fr");
  });

  it("Test I (suggestedQuestions resolved + tri-state): block carries resolver output, not the raw map", async () => {
    // ?locale=de → de list
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const de = await request(app).get("/widget/widget-1?locale=de");
    expect(JSON.parse(extractBlock(de.text)).suggestedQuestions).toEqual(["Was ist das?"]);

    // ?locale=fr (no fr tier) → per-index fallback to en list
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const fr = await request(app).get("/widget/widget-1?locale=fr");
    expect(JSON.parse(extractBlock(fr.text)).suggestedQuestions).toEqual(["What's this?"]);
  });

  it("Test J (G-128-2): blockConfig.hostFab is true when ?hostFab=1 is passed (real embed)", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app).get("/widget/widget-1?hostFab=1");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.hostFab).toBe(true);
  });

  it("Test K (G-128-2): blockConfig.hostFab is false when the param is absent (preview pane)", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app).get("/widget/widget-1");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.hostFab).toBe(false);
  });

  it("Test L (130-01, D-02/D-03): blockConfig carries credits (raw blob) + whiteLabel (server-derived boolean)", async () => {
    mockedGetWidgetConfig.mockResolvedValue({
      ...baseFixture,
      credits: { enabled: false, label: "X", url: "https://x.example" },
      whiteLabel: true,
    });
    const res = await request(app).get("/widget/widget-1");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.credits).toEqual({ enabled: false, label: "X", url: "https://x.example" });
    expect(block.whiteLabel).toBe(true);
  });

  it("Test M (130-01, D-02/D-03): blockConfig.credits null + whiteLabel false when absent from the API response", async () => {
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture });
    const res = await request(app).get("/widget/widget-1");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.credits).toBeNull();
    expect(block.whiteLabel).toBe(false);
  });

  // ── Quick 260826-p0d: query overrides for the two new trigger params ──────
  // Query > DB priority (D-03); absent query falls back to DB config (D-05,
  // Pitfall 3). The wire format for autoOpenUrlPatterns is the raw JSON-encoded
  // string of string[] (same as the DB column). exitIntentEnabled accepts "1"
  // or "true"; "0"/invalid/absent falls back to the DB boolean.

  it("Test N (260826-p0d): ?autoOpenUrlPatterns query override wins over DB (query > DB)", async () => {
    mockedGetWidgetConfig.mockResolvedValue({
      ...baseFixture,
      autoOpenUrlPatterns: '["/db-pattern/*"]',
    });
    // URL-encoded '["/pricing/*"]'
    const res = await request(app).get(
      "/widget/widget-1?autoOpenUrlPatterns=%5B%22%2Fpricing%2F*%22%5D",
    );

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.autoOpenUrlPatterns).toBe('["/pricing/*"]');
  });

  it("Test O (260826-p0d): absent ?autoOpenUrlPatterns falls back to DB config", async () => {
    mockedGetWidgetConfig.mockResolvedValue({
      ...baseFixture,
      autoOpenUrlPatterns: '["/db-pattern/*"]',
    });
    const res = await request(app).get("/widget/widget-1");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.autoOpenUrlPatterns).toBe('["/db-pattern/*"]');
  });

  it("Test P (260826-p0d): ?exitIntentEnabled=1 query override wins over DB false", async () => {
    mockedGetWidgetConfig.mockResolvedValue({
      ...baseFixture,
      exitIntentEnabled: false,
    });
    const res = await request(app).get("/widget/widget-1?exitIntentEnabled=1");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.exitIntentEnabled).toBe(true);
  });

  it("Test Q (260826-p0d): absent ?exitIntentEnabled falls back to DB config", async () => {
    mockedGetWidgetConfig.mockResolvedValue({
      ...baseFixture,
      exitIntentEnabled: true,
    });
    const res = await request(app).get("/widget/widget-1");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.exitIntentEnabled).toBe(true);
  });

  it("Test R (260826-p0d): ?exitIntentEnabled=0 does NOT override (falls back to DB true)", async () => {
    // Only "1" or "true" override; "0" is not a recognized false-signal — the
    // DB wins per the contract that absent/unrecognized query falls back to DB.
    mockedGetWidgetConfig.mockResolvedValue({
      ...baseFixture,
      exitIntentEnabled: true,
    });
    const res = await request(app).get("/widget/widget-1?exitIntentEnabled=0");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.exitIntentEnabled).toBe(true);
  });

  it("Test S (260826-p0d): ?exitIntentEnabled=true also overrides (true alias)", async () => {
    mockedGetWidgetConfig.mockResolvedValue({
      ...baseFixture,
      exitIntentEnabled: false,
    });
    const res = await request(app).get("/widget/widget-1?exitIntentEnabled=true");

    expect(res.status).toBe(200);
    const block = JSON.parse(extractBlock(res.text));
    expect(block.exitIntentEnabled).toBe(true);
  });

  it("Test T (260826-p0d): existing ?autoOpenDelay behavior is unchanged (query > DB + DB fallback)", async () => {
    // Query wins
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture, autoOpenDelay: 10 });
    const withQuery = await request(app).get("/widget/widget-1?autoOpenDelay=5");
    expect(JSON.parse(extractBlock(withQuery.text)).autoOpenDelay).toBe(5);

    // Absent query → DB fallback
    mockedGetWidgetConfig.mockResolvedValue({ ...baseFixture, autoOpenDelay: 10 });
    const noQuery = await request(app).get("/widget/widget-1");
    expect(JSON.parse(extractBlock(noQuery.text)).autoOpenDelay).toBe(10);
  });

  // ── Quick 260826-p0d: LOADER_JS forwards script.src trigger query params ──
  // String-level structural assertions — LOADER_JS is served text (node env
  // cannot run browser JS). The loader must parse the three trigger params
  // from its own script.src query and forward them to the iframe src.

  it("Test U (260826-p0d): LOADER_JS contains getScriptParam parsing logic", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.text).toContain("getScriptParam");
  });

  it("Test V (260826-p0d): LOADER_JS forwards autoOpenDelay/autoOpenUrlPatterns/exitIntentEnabled to the iframe", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The three forwarding push lines (conditional on the parsed params).
    expect(res.text).toContain('"autoOpenDelay=" + encodeURIComponent(autoOpenDelayParam)');
    expect(res.text).toContain('"autoOpenUrlPatterns=" + encodeURIComponent(autoOpenUrlPatternsParam)');
    expect(res.text).toContain('"exitIntentEnabled=" + encodeURIComponent(exitIntentEnabledParam)');
  });

  it("Test W (260826-p0d): LOADER_JS getScriptParam uses try/catch around decodeURIComponent (T-p0d-01 mitigate)", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    // The malformed-%XX guard — a decode failure must not break the loader.
    expect(res.text).toMatch(/try\s*\{/);
    expect(res.text).toContain("decodeURIComponent(key)");
    expect(res.text).toContain("decodeURIComponent(val)");
  });

  it("Test X (260826-p0d): LOADER_JS strips the query string from script.src before the baseUrl regex", async () => {
    const res = await request(app).get("/widget/widget-1.js");

    expect(res.status).toBe(200);
    expect(res.text).toContain('script.src.split("?")[0]');
  });
});