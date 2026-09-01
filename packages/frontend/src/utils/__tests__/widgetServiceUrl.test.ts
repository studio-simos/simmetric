// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * resolveWidgetServiceUrl unit tests (151-02, G-151-1a/1b).
 *
 * Contract: configured non-empty wins (trailing slash stripped); configured ""
 * falls back to origin; origin trailing slash stripped; both empty → "".
 */
import { resolveWidgetServiceUrl } from "../widgetServiceUrl";

describe("resolveWidgetServiceUrl", () => {
  it("returns the configured value when non-empty (override wins)", () => {
    expect(resolveWidgetServiceUrl("https://widget.example.com", "https://app.example.com")).toBe(
      "https://widget.example.com"
    );
  });

  it("strips trailing slashes from the configured value", () => {
    expect(resolveWidgetServiceUrl("https://widget.example.com/", "https://app.example.com")).toBe(
      "https://widget.example.com"
    );
    expect(resolveWidgetServiceUrl("https://widget.example.com///", "https://app.example.com")).toBe(
      "https://widget.example.com"
    );
  });

  it("falls back to the origin when configured is empty", () => {
    expect(resolveWidgetServiceUrl("", "https://app.example.com")).toBe("https://app.example.com");
  });

  it("strips trailing slashes from the origin fallback", () => {
    expect(resolveWidgetServiceUrl("", "https://app.example.com/")).toBe("https://app.example.com");
  });

  it("returns empty string when both inputs are empty", () => {
    expect(resolveWidgetServiceUrl("", "")).toBe("");
  });
});
