// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Pure helper that partitions chats into ordered, non-overlapping date buckets.
 *
 * Bucket order (most-recent first):
 *   today      — updatedAt is on the current calendar day
 *   yesterday  — updatedAt is on the previous calendar day
 *   thisWeek   — updatedAt within the last 7 days but before yesterday
 *   older      — everything else
 *
 * `now` is injectable for deterministic testing. Pass a fixed Date in tests;
 * in production it defaults to the current time.
 *
 * Buckets are mutually exclusive and collectively exhaustive: every chat lands
 * in exactly one bucket, regardless of pin/folder state. The date view is an
 * alternative organization that intentionally ignores pin/folder grouping.
 */

export type ChatDateBucket = "today" | "yesterday" | "thisWeek" | "older";

export interface DateGroupable {
  updatedAt: string;
}

export interface GroupedChatsByDate<T extends DateGroupable> {
  today: T[];
  yesterday: T[];
  thisWeek: T[];
  older: T[];
}

/** Ordered list of buckets for stable rendering. */
export const DATE_BUCKET_ORDER: readonly ChatDateBucket[] = [
  "today",
  "yesterday",
  "thisWeek",
  "older",
] as const;

function startOfDay(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupChatsByDate<T extends DateGroupable>(
  chats: readonly T[],
  now: Date = new Date(),
): GroupedChatsByDate<T> {
  const startToday = startOfDay(now);
  const startYesterday = startToday - 24 * 60 * 60 * 1000;
  const startThisWeek = startToday - 7 * 24 * 60 * 60 * 1000;

  const result: GroupedChatsByDate<T> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    older: [],
  };

  for (const chat of chats) {
    const ts = new Date(chat.updatedAt).getTime();
    if (Number.isNaN(ts)) {
      // Malformed timestamps fall back to "older" rather than dropping the chat.
      result.older.push(chat);
      continue;
    }
    if (ts >= startToday) {
      result.today.push(chat);
    } else if (ts >= startYesterday) {
      result.yesterday.push(chat);
    } else if (ts >= startThisWeek) {
      result.thisWeek.push(chat);
    } else {
      result.older.push(chat);
    }
  }

  return result;
}