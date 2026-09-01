// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import * as en from "../en/translation.json";
import * as itLocale from "../it/translation.json";
import * as ruLocale from "../ru/translation.json";

function getLeafPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const child = obj[key];
    if (typeof child === "object" && child !== null) {
      paths.push(...getLeafPaths(child as Record<string, unknown>, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function getValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

describe("i18n key parity", () => {
  const locales = [
    { name: "it", data: itLocale },
    { name: "ru", data: ruLocale },
  ];

  it("has matching settings.mcpConnections keys across all locales", () => {
    const enKeys = getLeafPaths(en.settings?.mcpConnections || {});
    expect(enKeys.length).toBeGreaterThan(0);

    for (const locale of locales) {
      for (const key of enKeys) {
        const value = getValue(locale.data.settings?.mcpConnections || {}, key);
        expect(value).toBeDefined();
      }
    }
  });

  it("has matching settings.tabs.mcpConnections across all locales", () => {
    expect(itLocale.settings?.tabs?.mcpConnections).toBeDefined();
    expect(ruLocale.settings?.tabs?.mcpConnections).toBeDefined();
  });

  it("has matching chat.fallback keys across all locales", () => {
    const enKeys = getLeafPaths(en.chat?.fallback || {});
    expect(enKeys.length).toBeGreaterThan(0);

    for (const locale of locales) {
      for (const key of enKeys) {
        const value = getValue(locale.data.chat?.fallback || {}, key);
        expect(value).toBeDefined();
      }
    }
  });
});
