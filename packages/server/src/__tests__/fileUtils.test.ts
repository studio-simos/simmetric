// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 184 (SAAS-03) — isDraftStorageKey contract (D-08).
 *
 * The cleanup contract migrates from isDraftsPath(filePath) to
 * isDraftStorageKey(storageKey). The new helper carries BOTH arms:
 *
 *   1. NEW-LAYOUT arm — "{orgId}/uploads/drafts/{uuid}-{name}" with a
 *      TRAILING-SEPARATOR prefix guard (anti sibling-prefix "drafts-evil",
 *      A5 Pitfall 5 reborn in key space — same semantics as
 *      uploadDraftReaperJob's base + path.sep and isDraftsPath's
 *      path.resolve + sep).
 *   2. LEGACY arm — backfilled rows carry storageKey = filePath, so the
 *      helper delegates to isDraftsPath (zero behavioral delta for
 *      pre-M6 data, air-gap invariant).
 *
 * False arms pinned: URL sentinels (backfilled URL drafts — matches
 * today's A5-rejects-URL behavior: never deleted), null/undefined/empty.
 */
import "./helpers/setupEnv";

import { isDraftsPath, isDraftStorageKey } from "../utils/fileUtils";

const ORG = "00000000-0000-0000-0000-000000000001";

describe("isDraftStorageKey (Phase 184 D-08)", () => {
  it("new-layout drafts key → true", () => {
    expect(isDraftStorageKey(`${ORG}/uploads/drafts/abc-def-report.pdf`)).toBe(true);
  });

  it("sibling-prefix 'drafts-evil' key → false (trailing-sep guard)", () => {
    expect(isDraftStorageKey(`${ORG}/uploads/drafts-evil/x`)).toBe(false);
  });

  it("non-draft new-layout key → false", () => {
    expect(isDraftStorageKey(`${ORG}/uploads/file.pdf`)).toBe(false);
  });

  it("legacy drafts filePath → true (delegation to isDraftsPath)", () => {
    expect(isDraftStorageKey("storage/uploads/drafts/x.pdf")).toBe(true);
    // Delegation must agree with the legacy helper on the same input
    expect(isDraftStorageKey("storage/uploads/drafts/x.pdf")).toBe(isDraftsPath("storage/uploads/drafts/x.pdf"));
  });

  it("legacy non-draft filePath → false", () => {
    expect(isDraftStorageKey("storage/uploads/file.pdf")).toBe(false);
    expect(isDraftStorageKey("storage/uploads/tmp-abc123.pdf")).toBe(false);
  });

  it("legacy drafts-evil sibling path → false (isDraftsPath trailing-sep semantics preserved)", () => {
    expect(isDraftStorageKey("storage/uploads/drafts-evil/x.pdf")).toBe(false);
  });

  it("URL sentinel (backfilled storageKey = URL) → false (never deleted)", () => {
    expect(isDraftStorageKey("https://example.com/a.pdf")).toBe(false);
  });

  it("null / undefined / empty → false", () => {
    expect(isDraftStorageKey(null)).toBe(false);
    expect(isDraftStorageKey(undefined)).toBe(false);
    expect(isDraftStorageKey("")).toBe(false);
  });

  it("trailing-separator semantics: the drafts DIRECTORY itself does not match", () => {
    // The bare prefix without the trailing separator must not classify —
    // mirrors the A5 base + path.sep rule (a "drafts" key with no file part
    // is not a draft file).
    expect(isDraftStorageKey(`${ORG}/uploads/drafts`)).toBe(false);
  });
});