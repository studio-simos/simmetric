// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 191 (KNOW-01, D-01/D-07/D-08): chatRequestSchema.attachedArchiveIds
 * additive-optional transport boundary + the widget structural strip (D-08).
 *
 * Handlers validate with safeParse (never parse) — a malformed UUID entry or
 * a 6-element array must FAIL here and 400 at the route boundary; a body
 * WITHOUT the field must parse byte-identically (absent = undefined, not null).
 */

import { chatRequestSchema } from "../schemas/chat.schema";
import { widgetChatRequestSchema } from "../schemas/widget.schema";

const ARCHIVE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ARCHIVE_ID_2 = "8c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("chatRequestSchema — attachedArchiveIds (Phase 191 D-01/D-07, additive)", () => {
  it("preserves a valid attachedArchiveIds through safeParse", () => {
    const result = chatRequestSchema.safeParse({
      message: "hi",
      attachedArchiveIds: [ARCHIVE_ID],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachedArchiveIds).toEqual([ARCHIVE_ID]);
    }
  });

  it("preserves multiple valid IDs (union order is caller-supplied)", () => {
    const result = chatRequestSchema.safeParse({
      message: "hi",
      attachedArchiveIds: [ARCHIVE_ID, ARCHIVE_ID_2],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachedArchiveIds).toEqual([ARCHIVE_ID, ARCHIVE_ID_2]);
    }
  });

  it("leaves attachedArchiveIds undefined when omitted (additive — callers byte-identical, absent = undefined not null)", () => {
    const result = chatRequestSchema.safeParse({ message: "hi" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("attachedArchiveIds");
    }
  });

  it("rejects a malformed UUID entry (400 at the route boundary — never mid-chat)", () => {
    const result = chatRequestSchema.safeParse({
      message: "hi",
      attachedArchiveIds: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects 6 entries (max 5 — D-01 fan-out cap)", () => {
    const ids = [
      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "8c9e6679-7425-40de-944b-e07fc1f90ae7",
      "9c9e6679-7425-40de-944b-e07fc1f90ae7",
      "ac9e6679-7425-40de-944b-e07fc1f90ae7",
      "bc9e6679-7425-40de-944b-e07fc1f90ae7",
      "cc9e6679-7425-40de-944b-e07fc1f90ae7",
    ];
    const result = chatRequestSchema.safeParse({
      message: "hi",
      attachedArchiveIds: ids,
    });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 5 entries (cap is inclusive)", () => {
    const ids = [
      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "8c9e6679-7425-40de-944b-e07fc1f90ae7",
      "9c9e6679-7425-40de-944b-e07fc1f90ae7",
      "ac9e6679-7425-40de-944b-e07fc1f90ae7",
      "bc9e6679-7425-40de-944b-e07fc1f90ae7",
    ];
    const result = chatRequestSchema.safeParse({
      message: "hi",
      attachedArchiveIds: ids,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty array (no-op — resolver short-circuits)", () => {
    const result = chatRequestSchema.safeParse({
      message: "hi",
      attachedArchiveIds: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachedArchiveIds).toEqual([]);
    }
  });

  it("rejects a non-string entry", () => {
    const result = chatRequestSchema.safeParse({
      message: "hi",
      attachedArchiveIds: [42],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-array value", () => {
    const result = chatRequestSchema.safeParse({
      message: "hi",
      attachedArchiveIds: ARCHIVE_ID,
    });
    expect(result.success).toBe(false);
  });

  it("coexists with skillCall on the same seam (D-07 — field lands AFTER skillCall)", () => {
    const result = chatRequestSchema.safeParse({
      message: "hi",
      skillCall: { slug: "translate", params: { input: "Ciao" } },
      attachedArchiveIds: [ARCHIVE_ID],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillCall?.slug).toBe("translate");
      expect(result.data.attachedArchiveIds).toEqual([ARCHIVE_ID]);
    }
  });
});

// ─── widgetChatRequestSchema — structural strip (D-08, Pitfall 6) ───────────
// Mirrors the Phase 190 skillCall strip contract: the widget schema keeps its
// 3-field shape (message/chatId/locale) and Zod's default unknown-key
// stripping drops a client-sent attachedArchiveIds before any server code —
// the widget chat path STRUCTURALLY cannot attach archives (widget RAG scope
// byte-identical before/after Phase 191).

describe("widgetChatRequestSchema — attachedArchiveIds structurally stripped (Phase 191 D-08, Pitfall 6)", () => {
  it("strips a client-sent attachedArchiveIds from the parsed data (never a 4xx oracle — the key simply vanishes)", () => {
    const result = widgetChatRequestSchema.safeParse({
      message: "hello",
      chatId: "550e8400-e29b-41d4-a716-446655440000",
      locale: "it",
      attachedArchiveIds: [ARCHIVE_ID],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("attachedArchiveIds");
      expect(result.data.message).toBe("hello");
      expect(result.data.chatId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.data.locale).toBe("it");
    }
  });

  it("keeps parsing widget bodies without the field (byte-identical widget scope)", () => {
    const result = widgetChatRequestSchema.safeParse({
      message: "hello",
      chatId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("attachedArchiveIds");
    }
  });
});