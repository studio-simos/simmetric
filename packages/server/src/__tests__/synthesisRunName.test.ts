// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * defaultRunName helper unit tests — Phase 74 Plan 03 (SYN-03, D-11).
 *
 * Validates the computed-at-creation name format:
 *   "Sintesi · {archive.name || "Senza nome"} · {DD/MM/YYYY HH:mm}"
 *
 * Same-day disambiguation relies on the time component (HH:mm), so two runs
 * created at 18:35 and 19:00 on the same day produce different names.
 */

import "./helpers/setupEnv";

import { defaultRunName } from "../services/synthesisService";

describe("defaultRunName", () => {
  it("returns Sintesi · {archive.name} · {DD/MM/YYYY HH:mm}", () => {
    const name = defaultRunName(
      { name: "Ricerche" },
      new Date("2026-07-21T18:35:00Z"),
    );
    // The format must include the literal tokens, the archive name, and the
    // date/time. We don't pin the exact timezone offset (UTC vs local) — the
    // run stores createdAt via @default(now()) which is server-local, so the
    // helper must format using local time to match what the DB would store.
    expect(name).toContain("Sintesi");
    expect(name).toContain("Ricerche");
    expect(name).toMatch(/21\/07\/2026/);
    expect(name).toMatch(/\d{2}:\d{2}/);
  });

  it("disambiguates same-day runs by time", () => {
    const archive = { name: "Ricerche" };
    const a = defaultRunName(archive, new Date("2026-07-21T18:35:00Z"));
    const b = defaultRunName(archive, new Date("2026-07-21T19:00:00Z"));
    expect(a).not.toBe(b);
  });

  it("handles empty archive name with Senza nome fallback", () => {
    const name = defaultRunName(
      { name: "" },
      new Date("2026-07-21T18:35:00Z"),
    );
    // Must not produce "Sintesi ·  · date" (empty segment)
    expect(name).not.toContain("Sintesi ·  ·");
    expect(name).toContain("Senza nome");
  });

  it("handles null archive name with Senza nome fallback", () => {
    const name = defaultRunName(
      { name: null },
      new Date("2026-07-21T18:35:00Z"),
    );
    expect(name).toContain("Senza nome");
  });
});