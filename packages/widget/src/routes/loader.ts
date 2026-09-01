// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { getWidgetConfig } from "../services/widgetApi";
import { logger } from "../utils/logger";
// Runtime import is fine here: this is widget *server* code (tsx/node), not the
// Vite client IIFE — the no-runtime-shared-in-IIFE rule applies only to the
// client bundle (widgetApi.ts already imports shared at the top of this package).
import { resolveWidgetTexts, resolveSuggestedQuestions, WIDGET_LOCALES } from "@simmetric-chat/shared";

const router: Router = Router();

// D-02 tier (b): hand-rolled Accept-Language resolution (RESEARCH Pattern 2).
// Comma-split, `;q=` weights (default 1, stable sort by q desc), `"*"` entries
// skipped, per-tag `new Intl.Locale(tag).language` inside try/catch — RangeError
// on malformed tags like `en_US` is caught and skipped, `zh-Hans-CN` → `zh`.
function resolveFromAcceptLanguage(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const parts = header.split(",").map((s) => s.trim()).filter(Boolean);
  const parsed = parts
    .map((p) => {
      const [tag, ...qs] = p.split(";");
      const q = qs.length ? parseFloat((qs[0] ?? "").split("=")[1] ?? "") : 1;
      return { tag: (tag ?? "").trim(), q: isNaN(q) ? 1 : q };
    })
    .filter((p) => p.tag !== "" && p.tag !== "*") // wildcard: skip (Intl.Locale("*") throws)
    .sort((a, b) => b.q - a.q); // q=1 first, stable for ties
  for (const { tag } of parsed) {
    try {
      const lang = new Intl.Locale(tag).language; // "en-US" → "en", "zh-Hans-CN" → "zh"
      if ((WIDGET_LOCALES as readonly string[]).includes(lang)) return lang;
    } catch {
      // RangeError for malformed tags like "en_US" — skip, try next
    }
  }
  return undefined;
}

// Localized <title> per resolved locale (D-06). The parent-page iframe.title in
// LOADER_JS stays static "Chat Widget" — the parent page has no locale knowledge
// without data-locale, and the loader JS is cached (max-age=3600) so per-locale
// injection would poison the cache.
const WIDGET_TITLES: Record<string, string> = {
  en: "Chat Widget",
  de: "Chat-Widget",
  es: "Widget de chat",
  fr: "Widget de chat",
  it: "Widget di chat",
  ru: "Виджет чата",
  zh: "聊天组件",
};

// Static loader JS — uses getAttribute() for data-attributes (SEC-04, no innerHTML, no string interpolation)
const LOADER_JS = `
(function() {
  var script = document.currentScript;
  if (!script) return;

  var targetId = script.getAttribute("data-target");
  var container = targetId ? document.getElementById(targetId) : null;
  if (!container) return;

  var widgetId = container.getAttribute("data-widget-id");
  if (!widgetId) return;

  // G-128-1 (Pitfall 3): NO hardcoded defaults — an absent data-primary-color /
  // data-position must leave the variables null so the route treats the missing
  // ?primaryColor= / ?position= as absent and falls back to the admin-saved
  // config (loader.ts GET /:widgetId). Same class as the Phase 127 ?locale=en
  // landmine: an always-sent default query param shadows the server config.
  // The override still works when the attribute is present.
  var primaryColor = container.getAttribute("data-primary-color");
  var position = container.getAttribute("data-position");
  // Phase 127 (Pitfall 3): NO "en" default — an absent data-locale must leave
  // the variable null so the route treats the missing ?locale= as absent and
  // Accept-Language detection actually fires. The override still works when the
  // attribute is present.
  var locale = container.getAttribute("data-locale");

  // Quick 260826-p0d (D-01, T-p0d-01 mitigate): the embed snippet now carries
  // trigger override params (?autoOpenDelay, ?autoOpenUrlPatterns,
  // ?exitIntentEnabled) on THIS script's own src URL. LOADER_JS must forward
  // them to the iframe URL so the route handler receives them and overrides
  // the DB-saved config (query > DB priority, D-03). Hand-rolled query parsing
  // in the existing ES5 style (no URLSearchParams — consistency with the
  // params array builder below). getScriptParam wraps decodeURIComponent in a
  // try/catch so a malformed %XX sequence in the script src query string
  // cannot throw and break the loader JS for ALL widgets on the page
  // (T-p0d-01: Tampering — semi-trusted admin input parsed via decode).
  function getScriptParam(name) {
    var src = script.src;
    var qIndex = src.indexOf("?");
    if (qIndex === -1) return null;
    var query = src.slice(qIndex + 1);
    var pairs = query.split("&");
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      var eq = pair.indexOf("=");
      var key = eq === -1 ? pair : pair.slice(0, eq);
      var val = eq === -1 ? "" : pair.slice(eq + 1);
      try {
        if (decodeURIComponent(key) === name) {
          return decodeURIComponent(val);
        }
      } catch (e) {
        // Malformed %XX — skip this pair, never break the loader (T-p0d-01).
        continue;
      }
    }
    return null;
  }
  var autoOpenDelayParam = getScriptParam("autoOpenDelay");
  var autoOpenUrlPatternsParam = getScriptParam("autoOpenUrlPatterns");
  var exitIntentEnabledParam = getScriptParam("exitIntentEnabled");

  // data-locale-source (G-127-1): selects WHERE the widget language comes from.
  //   "explicit" — data-locale is the only source (no page-lang consult);
  //   "browser"  — always omit ?locale= so Accept-Language detection fires;
  //   "page"     — the host page's <html lang> is the only source;
  //   "auto"     — default: data-locale wins, else <html lang>, else omit.
  // Pitfall 3 holds in every mode: no "en" default — no valid signal leaves
  // locale null, so no ?locale= is appended and the route falls to Accept-Language.
  var localeSource = container.getAttribute("data-locale-source") || "auto";

  // browser: force omission regardless of data-locale or page lang
  if (localeSource === "browser") { locale = null; }
  // page: the host page's <html lang> is the ONLY source — a present data-locale
  // is suppressed first, then the lang is normalized (trim → toLowerCase →
  // primary subtag before "-" → [a-z]{2,3} gate → locale = primary). The
  // underscore is deliberately NOT a separator: en_US → en_us has no dash →
  // primary is en_us → rejected by the gate. Invalid/absent → locale stays null.
  else if (localeSource === "page") {
    locale = null;
    var pageLang = (document.documentElement.lang || "").trim().toLowerCase();
    var dashIndex = pageLang.indexOf("-");
    var primary = dashIndex === -1 ? pageLang : pageLang.slice(0, dashIndex);
    if (/^[a-z]{2,3}$/.test(primary)) { locale = primary; }
  }
  // explicit: data-locale is the only source; absent data-locale → locale stays
  // null → ?locale= omitted → route falls to Accept-Language (no-op branch).
  else if (localeSource === "explicit") {
    // no-op — data-locale already read above
  }
  // auto (default): data-locale wins (SC5, gated by !locale); else the host
  // page's <html lang> participates with the same normalization + gate above.
  else if (localeSource === "auto" && !locale) {
    var pageLang = (document.documentElement.lang || "").trim().toLowerCase();
    var dashIndex = pageLang.indexOf("-");
    var primary = dashIndex === -1 ? pageLang : pageLang.slice(0, dashIndex);
    if (/^[a-z]{2,3}$/.test(primary)) { locale = primary; }
  }

  // Quick 260826-p0d (D-01): strip the query string from script.src BEFORE
  // the regex strips the last path segment. The embed snippet now carries
  // ?autoOpenDelay=5&... on the <script src>; without this strip the trailing-
  // segment regex would match "/widget-1.js?autoOpenDelay=5" (all non-slash
  // chars), which still yields the correct baseUrl here, but stripping the
  // query first is explicit and robust against any future widget-id encoding
  // that could interact with query chars.
  var scriptSrcNoQuery = script.src.split("?")[0];
  var baseUrl = scriptSrcNoQuery.replace(/\\/[^/]+$/, "");
  // G-128-1: build the query as a params array — primaryColor/position are
  // pushed ONLY when the container has the data attributes (bare reads above,
  // no defaults). hostFab=1 is always pushed (G-128-2). Join with "&" and
  // prefix "?" only when the array is non-empty — never a bare "&" on an empty
  // query, which would land in the path and 404.
  var params = [];
  if (primaryColor) {
    params.push("primaryColor=" + encodeURIComponent(primaryColor));
  }
  if (position) {
    params.push("position=" + encodeURIComponent(position));
  }
  params.push("hostFab=1");
  // Quick 260826-p0d (D-01): forward the trigger override params parsed from
  // the script's own src query string to the iframe URL. Each is pushed only
  // when present (omission-not-empty). The route handler merges them with
  // query > DB priority.
  if (autoOpenDelayParam) {
    params.push("autoOpenDelay=" + encodeURIComponent(autoOpenDelayParam));
  }
  if (autoOpenUrlPatternsParam) {
    params.push("autoOpenUrlPatterns=" + encodeURIComponent(autoOpenUrlPatternsParam));
  }
  if (exitIntentEnabledParam) {
    params.push("exitIntentEnabled=" + encodeURIComponent(exitIntentEnabledParam));
  }
  var query = params.length ? "?" + params.join("&") : "";
  var iframeSrc = baseUrl + "/" + encodeURIComponent(widgetId) + query;
  if (locale) {
    iframeSrc += "&locale=" + encodeURIComponent(locale);
  }

  var iframe = document.createElement("iframe");
  iframe.src = iframeSrc;
  iframe.sandbox = "allow-scripts allow-forms";
  iframe.allow = "clipboard-write";
  iframe.style.cssText = "border:none;width:100%;height:100%;";
  iframe.title = "Chat Widget";

  container.appendChild(iframe);

  // 260809-ipv: open/close state shared between the FAB-creation IIFE and the
  // relay IIFE — both are separate closures over this outer scope. Declared
  // here (outer-IIFE level) so both can read/write the SAME boolean; declaring
  // it inside either IIFE would give each closure a private copy and break the
  // sync. The FAB click handler toggles it synchronously, so rapid double-clicks
  // stay consistent (the second click sees the flipped value before any async
  // message round-trip).
  var fabOpen = false;

  // G-128-2: the open/close FAB lives on the HOST page, not inside the iframe —
  // the closed container has pointer-events:none (260808-wtz), which would make
  // an iframe-internal FAB unclickable. This button is appended to the embed
  // container (outside the iframe) and is ALWAYS pointer-events:auto, so the
  // widget can always be reopened. Styling mirrors ChatFab.tsx: fixed at the
  // config position, primaryColor background (container data-primary-color or
  // the baked default), logoUrl image (optional data-logo-url) else the botName
  // initial (optional data-bot-name), botName as aria-label. Click TOGGLES the
  // widget (260809-ipv): open posts simmetric:widgetOpen to the iframe and lifts
  // the container's pointer-events; close posts simmetric:widgetClose, restores
  // pointer-events:none and resets the FAB icon + aria-expanded. The iframe's
  // simmetric:widgetClose bridge (below) also resets the FAB when the panel closes
  // itself. SEC-04: no innerHTML — content is built with
  // createElement/textContent/createElementNS only.
  (function() {
    var iframeEl = container.querySelector('iframe');
    if (!iframeEl) return;

    var logoUrl = container.getAttribute("data-logo-url");
    var botName = container.getAttribute("data-bot-name");

    function setFabContent(fab, open) {
      while (fab.firstChild) { fab.removeChild(fab.firstChild); }
      var svg, path, line;
      if (open) {
        // close icon (mirrors ChatFab CloseIcon)
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "20");
        svg.setAttribute("height", "20");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "white");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("aria-hidden", "true");
        line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "4"); line.setAttribute("y1", "4");
        line.setAttribute("x2", "16"); line.setAttribute("y2", "16");
        svg.appendChild(line);
        line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "16"); line.setAttribute("y1", "4");
        line.setAttribute("x2", "4"); line.setAttribute("y2", "16");
        svg.appendChild(line);
        fab.appendChild(svg);
      } else if (logoUrl) {
        var img = document.createElement("img");
        img.src = logoUrl;
        img.alt = "";
        img.style.cssText = "width:28px;height:28px;border-radius:50%;object-fit:contain;";
        fab.appendChild(img);
      } else if (botName) {
        var span = document.createElement("span");
        span.textContent = botName.charAt(0).toUpperCase();
        span.style.cssText = "color:#fff;font-size:18px;font-weight:600;line-height:1;";
        fab.appendChild(span);
      } else {
        // chat icon (mirrors ChatFab ChatIcon)
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "24");
        svg.setAttribute("height", "24");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "white");
        svg.setAttribute("aria-hidden", "true");
        path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z");
        svg.appendChild(path);
        fab.appendChild(svg);
      }
    }

    var fab = document.createElement("button");
    fab.type = "button";
    fab.setAttribute("aria-label", botName || "Chat Widget");
    fab.setAttribute("aria-expanded", "false");
    fab.style.cssText =
      "position:fixed;bottom:20px;" +
      (position === "bottom-left" ? "left:20px;" : "right:20px;") +
      "width:56px;height:56px;border-radius:50%;border:none;outline:none;" +
      "cursor:pointer;z-index:999999;display:flex;align-items:center;justify-content:center;" +
      "box-shadow:0 4px 12px rgba(0,0,0,0.15);pointer-events:auto;" +
      "background-color:" + (primaryColor || "#4c6ef5") + ";";
    setFabContent(fab, false);
    container.appendChild(fab);

    fab.addEventListener("click", function() {
      if (fabOpen) {
        // 260809-ipv: panel is open — close it. The iframe's App.tsx handler
        // now reacts to simmetric:widgetClose (setIsOpen(false)); the container
        // pointer-events and the FAB visual state are reset here directly so
        // the host page never stays blocked.
        if (iframeEl && iframeEl.contentWindow) {
          iframeEl.contentWindow.postMessage({ type: "simmetric:widgetClose" }, "*");
        }
        container.style.pointerEvents = "none";
        fab.setAttribute("aria-expanded", "false");
        setFabContent(fab, false);
        fabOpen = false;
      } else {
        if (iframeEl && iframeEl.contentWindow) {
          iframeEl.contentWindow.postMessage({ type: "simmetric:widgetOpen" }, "*");
        }
        container.style.pointerEvents = "auto";
        fab.setAttribute("aria-expanded", "true");
        setFabContent(fab, true);
        fabOpen = true;
      }
    });
  })();

  // URL change detection: relay to iframe on SPA navigation (per D-03)
  (function() {
    var iframeEl = container.querySelector('iframe');
    if (!iframeEl) return;

    function notifyUrlChange() {
      if (iframeEl && iframeEl.contentWindow) {
        iframeEl.contentWindow.postMessage({
          type: 'simmetric:urlChange',
          url: window.location.href,
          pathname: window.location.pathname
        }, '*');
      }
    }

    // Send initial URL
    notifyUrlChange();

    // Detect pushState/replaceState (SPA navigation)
    var origPushState = history.pushState;
    history.pushState = function() {
      origPushState.apply(this, arguments);
      notifyUrlChange();
    };
    var origReplaceState = history.replaceState;
    history.replaceState = function() {
      origReplaceState.apply(this, arguments);
      notifyUrlChange();
    };

    // Detect popstate (back/forward) and hashchange
    window.addEventListener('popstate', notifyUrlChange);
    window.addEventListener('hashchange', notifyUrlChange);
  })();

  // Exit intent detection: notify iframe when visitor is about to leave (per D-04)
  (function() {
    var iframeEl = container.querySelector('iframe');
    if (!iframeEl) return;
    var exitIntentFired = false;

    document.addEventListener('mouseleave', function(e) {
      if (exitIntentFired) return;
      if (e.relatedTarget === null && e.clientY <= 10) {
        exitIntentFired = true;
        if (iframeEl && iframeEl.contentWindow) {
          iframeEl.contentWindow.postMessage({ type: 'simmetric:exitIntent' }, '*');
        }
      }
    });
  })();

  // WID-03 D-05/D-06: storage handshake. The sandboxed iframe cannot reliably use
  // its own sessionStorage (opaque origin + sandbox may block it). It asks the
  // loader (parent page, stable origin) to read/write namespaced sessionStorage
  // keys on its behalf via postMessage. The iframe validates event.source ===
  // window.parent before accepting storage-data (defense-in-depth; server still
  // validates the token on every chat request). Persistence happens only on
  // done/error/unmount (D-05 — not per-token) to avoid postMessage flooding.
  //
  // WR-01 fix (inbound hardening): the loader MUST validate that the storage
  // request came from OUR iframe (event.source === iframeEl.contentWindow).
  // Without this, any script or sibling iframe on the host page could send
  // simmetric:storage-get to READ cached session tokens, or simmetric:storage-set to
  // INJECT one (session fixation). The outbound reply at the bottom uses '*'
  // because the sandboxed iframe has an opaque origin — postMessage on a
  // specific contentWindow delivers only to that window, so '*' here is safe
  // (sibling iframes have their own contentWindow and never receive it); the
  // real authentication is the inbound source check on both sides.
  (function() {
    var iframeEl = container.querySelector('iframe');
    if (!iframeEl) return;

    function sessionKey(widgetId) { return 'sc-widget-' + widgetId + '-session'; }
    function messagesKey(widgetId) { return 'sc-widget-' + widgetId + '-messages'; }
    function consentKey(widgetId) { return 'sc-widget-' + widgetId + '-consent'; }
    function leadSubmittedKey(widgetId) { return 'sc-widget-' + widgetId + '-lead-submitted'; }
    // 131-05 (G-131-16): the contact-banner dismiss flag persists via the same
    // handshake (sc-widget-{id}-contact-banner-dismissed).
    function contactBannerDismissedKey(widgetId) { return 'sc-widget-' + widgetId + '-contact-banner-dismissed'; }

    // 260809-uxk: single key map for ALL storage keys (session/messages/
    // consent/leadSubmitted). Both the storage-get loop and the storage-set
    // branch consult this map, so no key is silently dropped. Unknown keys
    // map to null and are skipped.
    function storageKey(widgetId, k) {
      if (k === 'session') return sessionKey(widgetId);
      if (k === 'messages') return messagesKey(widgetId);
      if (k === 'consent') return consentKey(widgetId);
      if (k === 'leadSubmitted') return leadSubmittedKey(widgetId);
      if (k === 'contactBannerDismissed') return contactBannerDismissedKey(widgetId);
      return null;
    }

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (!msg || !msg.type) return;
      // D-06 / WR-01: only OUR iframe may request storage ops. Any other sender
      // (host-page script, sibling iframe) is ignored — prevents token read and
      // session-fixation via crafted simmetric:storage-* messages.
      if (!iframeEl || event.source !== iframeEl.contentWindow) return;

      if (msg.type === 'simmetric:storage-get') {
        var data = {};
        var keys = msg.keys || [];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var fullKey = storageKey(msg.widgetId, k);
          if (!fullKey) continue;
          try {
            data[k] = sessionStorage.getItem(fullKey);
          } catch (e) {
            // sessionStorage blocked (private mode etc.) — surface null
            data[k] = null;
          }
        }
        if (iframeEl && iframeEl.contentWindow) {
          // 131-05 (G-131-18): echo the request's requestId so the iframe can
          // correlate this reply to the request that asked for it — concurrent
          // storage-get reads no longer misroute (the leadSubmitted restore
          // after reload is now reliable).
          iframeEl.contentWindow.postMessage({ type: 'simmetric:storage-data', data: data, requestId: msg.requestId }, '*');
        }
      } else if (msg.type === 'simmetric:storage-set') {
        var fullKey = storageKey(msg.widgetId, msg.key);
        if (!fullKey) return;
        try {
          sessionStorage.setItem(fullKey, msg.value);
        } catch (e) {
          // sessionStorage blocked — best-effort, iframe falls back to fresh session
        }
      }
    });
  })();

  // 260808-wtz + G-128-2: open/close state relay. The iframe posts
  // simmetric:widgetOpen / simmetric:widgetClose when the chat opens/closes (App.tsx
  // isOpen effect → widgetStateBridge). The snippet's inline pointer-events:none
  // on the container keeps the host page unblocked when closed; here we override
  // it while the chat is open so the panel is fully interactive, and restore it
  // on close. G-128-2: on close we ALSO reset the host FAB to its closed state
  // (chat icon + aria-expanded=false) — the FAB itself stays pointer-events:auto
  // so the widget can always be reopened. WR-01: only OUR iframe may toggle
  // this — a forged open/close message from a host-page script or sibling iframe
  // would change host-page interactivity (pointer-events takeover).
  (function() {
    var iframeEl = container.querySelector('iframe');
    if (!iframeEl) return;

    var fab = container.querySelector('button[aria-label]');
    var logoUrl = container.getAttribute("data-logo-url");
    var botName = container.getAttribute("data-bot-name");

    function setFabContent(fab, open) {
      while (fab.firstChild) { fab.removeChild(fab.firstChild); }
      var svg, path, line;
      if (open) {
        // close icon (mirrors ChatFab CloseIcon)
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "20");
        svg.setAttribute("height", "20");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "white");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("aria-hidden", "true");
        line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "4"); line.setAttribute("y1", "4");
        line.setAttribute("x2", "16"); line.setAttribute("y2", "16");
        svg.appendChild(line);
        line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "16"); line.setAttribute("y1", "4");
        line.setAttribute("x2", "4"); line.setAttribute("y2", "16");
        svg.appendChild(line);
        fab.appendChild(svg);
      } else if (logoUrl) {
        // closed state restores the logo (mirrors the creation-time content)
        var img = document.createElement("img");
        img.src = logoUrl;
        img.alt = "";
        img.style.cssText = "width:28px;height:28px;border-radius:50%;object-fit:contain;";
        fab.appendChild(img);
      } else if (botName) {
        // closed state restores the botName initial (mirrors creation-time)
        var span = document.createElement("span");
        span.textContent = botName.charAt(0).toUpperCase();
        span.style.cssText = "color:#fff;font-size:18px;font-weight:600;line-height:1;";
        fab.appendChild(span);
      } else {
        // chat icon (mirrors ChatFab ChatIcon)
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "24");
        svg.setAttribute("height", "24");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "white");
        svg.setAttribute("aria-hidden", "true");
        path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z");
        svg.appendChild(path);
        fab.appendChild(svg);
      }
    }

    window.addEventListener('message', function(event) {
      // WR-01: only our iframe's contentWindow may send these messages
      if (!iframeEl || event.source !== iframeEl.contentWindow) return;
      var msg = event.data;
      if (!msg || !msg.type) return;
      if (msg.type === 'simmetric:widgetOpen') {
        container.style.pointerEvents = "auto";
        // 260809-ipv: auto-open sync — the iframe's useTriggers auto-open
        // (autoOpenDelay/URL/exit-intent) posts simmetric:widgetOpen; repaint the
        // host FAB so it reflects the OPEN state (close icon + aria-expanded)
        // instead of staying visually stuck closed.
        if (fab) {
          fab.setAttribute("aria-expanded", "true");
          setFabContent(fab, true);
        }
        fabOpen = true;
      } else if (msg.type === 'simmetric:widgetClose') {
        container.style.pointerEvents = "none";
        if (fab) {
          fab.setAttribute("aria-expanded", "false");
          setFabContent(fab, false);
        }
        fabOpen = false;
      } else if (msg.type === 'simmetric:widgetConfig') {
        // 260809-i6b: the iframe posts its effective per-widget primaryColor
        // (route-resolved into the JSON block) once on mount — repaint the
        // host FAB that LOADER_JS baked with the GLOBAL branding color. The
        // hex regex is the SAME literal as useWidgetConfig.ts (--widget-primary)
        // — the loader re-validates because this message crosses the
        // iframe->host trust boundary and must never apply an arbitrary string
        // as a style value. Overrides just this property (same inline-style
        // layer, later assignment wins). SEC-04 compliant: style property
        // assignment, no innerHTML.
        if (fab && /^#[0-9a-f]{6}$/i.test(msg.primaryColor)) {
          fab.style.backgroundColor = msg.primaryColor;
        }
      } else if (msg.type === 'simmetric:creditsOpen') {
        // 130-01 (D-02, CRD-03): the credits link opens in a new tab via the
        // postMessage bridge — the sandboxed iframe (allow-scripts allow-forms,
        // no allow-popups) cannot window.open itself. This branch lives INSIDE
        // the WR-01-guarded listener (never a second unguarded listener —
        // Pitfall 2). The URL is re-validated across the iframe->host trust
        // boundary with the SAME http/https prefix allowlist as
        // widgetStateBridge + the widgetCreditsSchema refine (defense-in-depth,
        // T-130-02): a javascript:/data:/ftp: payload is a no-op. window.open
        // with 'noopener' — the opened page cannot reach back into the host.
        var u = msg.url;
        if (typeof u === 'string' && (u.indexOf('http://') === 0 || u.indexOf('https://') === 0)) {
          window.open(u, '_blank', 'noopener');
        }
      }
    });
  })();
})();

window.SimmetricChatWidget = {
  init: function() {}
};
`.trim();

// GET /:widgetId.js — serve static loader JS
router.get("/:widgetId.js", (req: Request<{ widgetId: string }>, res: Response) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(LOADER_JS);
});

// GET /:widgetId — serve iframe HTML page that loads Preact bundle
router.get("/:widgetId", async (req: Request<{ widgetId: string }>, res: Response) => {
  const widgetId = req.params.widgetId;

  // Fetch full widget config from main server API (includes trigger and lead capture fields)
  let config: Record<string, any> = {};
  try {
    config = await getWidgetConfig(widgetId);
  } catch (err: any) {
    logger.error("[widget/loader] Failed to fetch widget config for iframe", { error: err.message });
  }

  // Read query params passed by loader JS (overrides from parent page, lower priority than API config)
  const primaryColor = (req.query.primaryColor as string) || config.primaryColor || "#4c6ef5";
  const position = (req.query.position as string) || config.position || "bottom-right";

  // G-128-2: LOADER_JS appends &hostFab=1 for real embeds — the host page owns
  // the FAB (always clickable, outside the pointer-events:none iframe). The
  // admin preview pane (WidgetPreviewPane) loads this route directly WITHOUT
  // the param, so its iframe keeps rendering its own ChatFab. The flag only
  // hides the iframe's own FAB (a cosmetic choice — T-128-04-03 accept).
  const hostFab = req.query.hostFab === "1";

  // D-02 chain: ?locale= (from parent data-locale) → Accept-Language → widget
  // fallbackLocale → legacy scalars (carried by resolveWidgetTexts) → "en".
  // An absent ?locale= is treated as absent — never defaulted to "en" (Pitfall 3).
  const explicitLocale = req.query.locale as string | undefined;
  const headerLocale = resolveFromAcceptLanguage(req.headers["accept-language"]);
  const resolvedLocale =
    explicitLocale && (WIDGET_LOCALES as readonly string[]).includes(explicitLocale)
      ? explicitLocale
      : headerLocale ?? config.fallbackLocale ?? "en";

  // Resolve content via the shared helpers (Phase 125) — do NOT re-implement the
  // fallback chain here.
  const texts = resolveWidgetTexts(config, resolvedLocale);
  const suggestedQuestions = resolveSuggestedQuestions(config, resolvedLocale);

  // Trigger and lead capture config from API (not passed as query params -- comes from DB)
  const name = config.name || "AI Assistant";
  const botName = config.botName || name;
  const logoUrl = config.logoUrl || "";
  const avatarUrl = config.avatarUrl || "";
  // Quick 260826-hx5 (D-02, T-hx5-02): ?autoOpenDelay query overrides the
  // DB config value (query > DB priority, mirroring primaryColor/position at
  // lines 546-547). Number() + isNaN guard so a malformed query param falls
  // back to the DB value rather than injecting NaN into the block JSON (the
  // widget client's useTriggers would treat NaN as truthy and break the
  // timer). Absent/empty query → DB config (Pitfall 3: absent is absent).
  const autoOpenDelayQuery = req.query.autoOpenDelay as string | undefined;
  const parsedDelay =
    autoOpenDelayQuery != null && autoOpenDelayQuery !== ""
      ? Number(autoOpenDelayQuery)
      : null;
  const autoOpenDelay =
    parsedDelay != null && !isNaN(parsedDelay)
      ? parsedDelay
      : config.autoOpenDelay != null
        ? config.autoOpenDelay
        : null;
  // Quick 260826-p0d (D-03, D-05): ?autoOpenUrlPatterns query overrides the
  // DB config value (query > DB priority, mirroring ?autoOpenDelay above).
  // The wire format is the RAW JSON-encoded string of string[] (same shape as
  // the DB column — the widget client JSON.parses it, per the existing Pitfall
  // 7 comment below). Absent/empty query → DB config fallback (Pitfall 3).
  const autoOpenUrlPatternsQuery = req.query.autoOpenUrlPatterns as string | undefined;
  const autoOpenUrlPatterns =
    autoOpenUrlPatternsQuery != null && autoOpenUrlPatternsQuery !== ""
      ? autoOpenUrlPatternsQuery
      : (config.autoOpenUrlPatterns || "");
  // Quick 260826-p0d (D-03, D-05): ?exitIntentEnabled query overrides the DB
  // config boolean (query > DB priority). The wire value is "1" (from the
  // snippet) or "true"; anything else (including absent/empty/"0") falls back
  // to the DB boolean. leadCapture and exitIntentCooldownMs stay DB-only per
  // CONTEXT ("leadCapture and the other options restano DB-only per ora").
  const exitIntentEnabledQuery = req.query.exitIntentEnabled as string | undefined;
  const exitIntentEnabled =
    exitIntentEnabledQuery === "1" || exitIntentEnabledQuery === "true"
      ? true
      : config.exitIntentEnabled === true;
  const exitIntentCooldownMs = config.exitIntentCooldownMs != null ? config.exitIntentCooldownMs : 1800000;
  const leadCaptureEnabled = config.leadCaptureEnabled === true;
  const leadCapturePrompt = config.leadCapturePrompt || "";

  // D-01: the block IS the fully-resolved flat client-shaped config (OQ1). Keyed
  // exactly like the client WidgetConfig interface. autoOpenUrlPatterns is
  // emitted AS-IS (raw JSON-encoded string — Pitfall 7: matchUrlPattern does its
  // own JSON.parse). Defensive `|| default` fallbacks keep the existing mocked
  // getWidgetConfig fixture (which lacks the Phase 125 fields) yielding a valid block.
  const blockConfig = {
    widgetId,
    name,
    primaryColor,
    botName,
    logoUrl,
    avatarUrl,
    position, // API shape "bottom-right"/"bottom-left" — the client maps (Pitfall 5)
    locale: resolvedLocale,
    welcomeMessage: texts.welcomeMessage ?? "",
    fallbackMessage: texts.fallbackMessage ?? "",
    placeholder: texts.placeholder ?? "",
    piiConsent: texts.piiConsent ?? "",
    leadCapturePrompt: texts.leadPrompt ?? leadCapturePrompt,
    suggestedQuestions, // resolver result — null stays null
    autoOpenDelay,
    autoOpenUrlPatterns,
    exitIntentEnabled,
    exitIntentCooldownMs,
    leadCaptureEnabled,
    hostFab, // G-128-2: true only when embedded via LOADER_JS (&hostFab=1)
    // 130-01 (D-02/D-03): credits raw blob pass-through (null-safe — the
    // client owns defaulting) + the server-derived whiteLabel boolean (the
    // flag already arrived via getWidgetConfig from the internal route; the
    // loader does NOT re-derive it from any client input).
    credits: config.credits ?? null,
    whiteLabel: config.whiteLabel === true,
  };

  // Pitfall 1 (T-127-01): escape every `<` as \u003c so an admin string containing
  // `</script>` cannot break out of the block. Verified round-trip in research.
  const configJson = JSON.stringify(blockConfig).replace(/</g, "\\u003c");

  const html = `<!DOCTYPE html>
<html lang="${resolvedLocale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${WIDGET_TITLES[resolvedLocale] ?? WIDGET_TITLES.en}</title>
  <style>
    /* 131-04 (real-embed visual defects): the reset must NOT zero the
       Tailwind v4 padding utilities. An un-layered universal selector rule
       with padding: 0 beats every rule inside @layer utilities (cascade-
       layers spec: un-layered author styles win over layered ones), which
       collapsed px-4/py-3/p-4 to 0 in the real embed. The margin +
       box-sizing halves are also covered by Tailwind's own preflight
       (@layer base) — keep only the layout rule. */
    html, body, #widget-root { width: 100%; height: 100%; overflow: hidden; }
  </style>
</head>
<body>
  <script type="application/json" id="widget-config">${configJson}</script>
  <div id="widget-root"></div>
  <script src="/widget/app.js"></script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(html);
});

export default router;