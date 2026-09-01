// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * buildWidgetSnippet unit tests (Quick 260826-p0d, Task 3 — D-05 omission +
 * conditional inclusion + toggle-gating).
 *
 * Pure-function tests: no React rendering. Asserts on the returned snippet
 * HTML string — presence/absence of query params in the <script src> URL, and
 * correct URL-encoding of the JSON wire format for autoOpenUrlPatterns.
 */

import { buildWidgetSnippet } from "../utils/widgetSnippet";

const WIDGET_ID = "widget-1";
const SERVICE_URL = "https://widget.example.com";

// Extract the <script src="..."> URL from the snippet HTML.
function extractScriptSrc(snippet: string): string {
  const match = snippet.match(/<script[^>]*\ssrc="([^"]*)"[^>]*>/);
  if (!match) throw new Error("script src not found in snippet");
  return match[1];
}

describe("buildWidgetSnippet (260826-p0d)", () => {
  it("omits the query string entirely when all triggers are OFF (D-05, Pitfall 3)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByTimeEnabled: false,
      autoOpenDelay: "5",
      autoOpenByUrlEnabled: false,
      autoOpenUrlPatterns: "/pricing/*",
      exitIntentEnabled: false,
    });
    const src = extractScriptSrc(snippet);
    expect(src).toBe(`${SERVICE_URL}/widget/${WIDGET_ID}.js`);
    expect(src).not.toContain("?");
  });

  it("omits the query string when options is empty (all absent)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL);
    expect(extractScriptSrc(snippet)).toBe(`${SERVICE_URL}/widget/${WIDGET_ID}.js`);
  });

  it("includes autoOpenDelay=5 when autoOpenByTimeEnabled is true and autoOpenDelay is '5'", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByTimeEnabled: true,
      autoOpenDelay: "5",
    });
    const src = extractScriptSrc(snippet);
    expect(src).toBe(`${SERVICE_URL}/widget/${WIDGET_ID}.js?autoOpenDelay=5`);
  });

  it("omits autoOpenDelay when autoOpenByTimeEnabled is false even if autoOpenDelay is '5' (toggle-gating)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByTimeEnabled: false,
      autoOpenDelay: "5",
    });
    expect(extractScriptSrc(snippet)).not.toContain("autoOpenDelay");
  });

  it("omits autoOpenDelay when autoOpenDelay is a non-numeric string (NaN guard, mirrors loader.ts)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByTimeEnabled: true,
      autoOpenDelay: "abc",
    });
    expect(extractScriptSrc(snippet)).not.toContain("autoOpenDelay");
  });

  it("omits autoOpenDelay when autoOpenDelay is empty/whitespace", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByTimeEnabled: true,
      autoOpenDelay: "   ",
    });
    expect(extractScriptSrc(snippet)).not.toContain("autoOpenDelay");
  });

  it("includes URL-encoded JSON autoOpenUrlPatterns when toggle ON and patterns present", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByUrlEnabled: true,
      autoOpenUrlPatterns: "/pricing/*, /contact",
    });
    const src = extractScriptSrc(snippet);
    // The wire format is a URL-encoded JSON-encoded string of string[].
    const paramIdx = src.indexOf("autoOpenUrlPatterns=");
    expect(paramIdx).toBeGreaterThanOrEqual(0);
    const encoded = src.slice(paramIdx + "autoOpenUrlPatterns=".length);
    // The encoded value runs to the end of the query string (no & after it
    // in this single-param case). Decode and assert the JSON shape.
    expect(decodeURIComponent(encoded)).toBe(JSON.stringify(["/pricing/*", "/contact"]));
  });

  it("omits autoOpenUrlPatterns when autoOpenByUrlEnabled is false even if patterns text present (toggle-gating)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByUrlEnabled: false,
      autoOpenUrlPatterns: "/pricing/*, /contact",
    });
    expect(extractScriptSrc(snippet)).not.toContain("autoOpenUrlPatterns");
  });

  it("omits autoOpenUrlPatterns when the field trims to empty (all-whitespace patterns)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByUrlEnabled: true,
      autoOpenUrlPatterns: "  ,  ,  ",
    });
    expect(extractScriptSrc(snippet)).not.toContain("autoOpenUrlPatterns");
  });

  it("trims and filters empty patterns before JSON-encoding (filters Boolean)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByUrlEnabled: true,
      autoOpenUrlPatterns: "/pricing/*, , /contact",
    });
    const src = extractScriptSrc(snippet);
    const paramIdx = src.indexOf("autoOpenUrlPatterns=");
    const encoded = src.slice(paramIdx + "autoOpenUrlPatterns=".length);
    expect(decodeURIComponent(encoded)).toBe(JSON.stringify(["/pricing/*", "/contact"]));
  });

  it("includes exitIntentEnabled=1 when exitIntentEnabled is true", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      exitIntentEnabled: true,
    });
    expect(extractScriptSrc(snippet)).toBe(
      `${SERVICE_URL}/widget/${WIDGET_ID}.js?exitIntentEnabled=1`,
    );
  });

  it("omits exitIntentEnabled when exitIntentEnabled is false", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      exitIntentEnabled: false,
    });
    expect(extractScriptSrc(snippet)).not.toContain("exitIntentEnabled");
  });

  it("joins multiple params with & in query order (all three ON)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {
      autoOpenByTimeEnabled: true,
      autoOpenDelay: "5",
      autoOpenByUrlEnabled: true,
      autoOpenUrlPatterns: "/p/*",
      exitIntentEnabled: true,
    });
    const src = extractScriptSrc(snippet);
    expect(src).toBe(
      `${SERVICE_URL}/widget/${WIDGET_ID}.js?autoOpenDelay=5&autoOpenUrlPatterns=${encodeURIComponent(JSON.stringify(["/p/*"]))}&exitIntentEnabled=1`,
    );
  });

  it("preserves the container-div + script-tag HTML structure (comment, style, data-target)", () => {
    const snippet = buildWidgetSnippet(WIDGET_ID, SERVICE_URL, {});
    // The Italian comment text + container structure is preserved byte-
    // identically from the old EMBED_SNIPPET_TEMPLATE.
    expect(snippet).toContain("<!-- Aggiungi questo container dove vuoi che appaia il widget -->");
    expect(snippet).toContain('id="simmetric-chat-widget"');
    expect(snippet).toContain(`data-widget-id="${WIDGET_ID}"`);
    expect(snippet).toContain(
      'style="position: fixed; bottom: 0; right: 0; width: 400px; height: 600px; z-index: 9999; border: none; pointer-events: none;"',
    );
    expect(snippet).toContain("<!-- Inserisci questo script prima di </body> -->");
    expect(snippet).toContain('data-target="simmetric-chat-widget"');
  });
});