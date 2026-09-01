// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { groupChatsByDate, DATE_BUCKET_ORDER, ChatDateBucket } from "../groupChatsByDate";

// Fixed reference point: 2026-07-13T12:00:00 local time (Monday noon).
const NOW = new Date(2026, 6, 13, 12, 0, 0); // month is 0-indexed → July
const iso = (d: Date) => d.toISOString();

function chat(ts: Date) {
  return { id: ts.getTime().toString(), updatedAt: iso(ts) };
}

describe("groupChatsByDate", () => {
  it("places a chat updated moments ago into today", () => {
    const grouped = groupChatsByDate([chat(new Date(2026, 6, 13, 11, 30))], NOW);
    expect(grouped.today).toHaveLength(1);
    expect(grouped.yesterday).toHaveLength(0);
    expect(grouped.thisWeek).toHaveLength(0);
    expect(grouped.older).toHaveLength(0);
  });

  it("places a chat from the previous calendar day into yesterday", () => {
    const grouped = groupChatsByDate([chat(new Date(2026, 6, 12, 23, 59))], NOW);
    expect(grouped.yesterday).toHaveLength(1);
    expect(grouped.today).toHaveLength(0);
  });

  it("treats the midnight boundary correctly (yesterday vs today)", () => {
    const grouped = groupChatsByDate(
      [
        chat(new Date(2026, 6, 12, 23, 59, 59)), // yesterday 23:59:59
        chat(new Date(2026, 6, 13, 0, 0, 0)), // today 00:00:00
      ],
      NOW,
    );
    expect(grouped.yesterday).toHaveLength(1);
    expect(grouped.today).toHaveLength(1);
  });

  it("places a chat 3 days ago into thisWeek (excluding today/yesterday)", () => {
    const grouped = groupChatsByDate([chat(new Date(2026, 6, 10, 12, 0))], NOW);
    expect(grouped.thisWeek).toHaveLength(1);
  });

  it("places a chat exactly 7 days ago at 00:00 into thisWeek (inclusive lower bound)", () => {
    // startThisWeek = startToday - 7d = 2026-07-06 00:00 local
    const grouped = groupChatsByDate([chat(new Date(2026, 6, 6, 0, 0, 0))], NOW);
    expect(grouped.thisWeek).toHaveLength(1);
    expect(grouped.older).toHaveLength(0);
  });

  it("places a chat just before the 7-day window into older", () => {
    const grouped = groupChatsByDate([chat(new Date(2026, 6, 5, 23, 59, 59))], NOW);
    expect(grouped.older).toHaveLength(1);
  });

  it("buckets are mutually exclusive and exhaustive", () => {
    const chats = [
      chat(new Date(2026, 6, 13, 10, 0)), // today
      chat(new Date(2026, 6, 12, 10, 0)), // yesterday
      chat(new Date(2026, 6, 9, 10, 0)), // thisWeek
      chat(new Date(2026, 0, 1, 10, 0)), // older (Jan)
    ];
    const grouped = groupChatsByDate(chats, NOW);
    const total =
      grouped.today.length +
      grouped.yesterday.length +
      grouped.thisWeek.length +
      grouped.older.length;
    expect(total).toBe(chats.length);
  });

  it("preserves input order within each bucket", () => {
    const chats = [
      chat(new Date(2026, 6, 13, 8, 0)),
      chat(new Date(2026, 6, 13, 9, 0)),
      chat(new Date(2026, 6, 13, 10, 0)),
    ];
    const grouped = groupChatsByDate(chats, NOW);
    expect(grouped.today.map((c) => c.id)).toEqual(chats.map((c) => c.id));
  });

  it("routes malformed timestamps to older instead of dropping them", () => {
    const grouped = groupChatsByDate(
      [{ id: "bad", updatedAt: "not-a-date" }],
      NOW,
    );
    expect(grouped.older).toHaveLength(1);
  });

  it("handles empty input", () => {
    const grouped = groupChatsByDate([], NOW);
    for (const bucket of DATE_BUCKET_ORDER) {
      expect(grouped[bucket]).toHaveLength(0);
    }
  });

  it("defaults to the real current time when now is omitted", () => {
    const recent = { id: "1", updatedAt: new Date().toISOString() };
    const grouped = groupChatsByDate([recent]);
    expect(grouped.today).toHaveLength(1);
  });

  it("DATE_BUCKET_ORDER is most-recent-first and covers all buckets", () => {
    expect(DATE_BUCKET_ORDER).toEqual<readonly ChatDateBucket[]>([
      "today",
      "yesterday",
      "thisWeek",
      "older",
    ]);
  });
});