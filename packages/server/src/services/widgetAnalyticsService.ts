// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma from "../utils/prisma";
import { classifyTopic } from "./topicClassificationService";
import { logger } from "../utils/logger";
import type { DailyWidgetAnalytics, TopicDistribution } from "@simmetric-chat/shared";

/**
 * Record a widget event after a conversation completes.
 * Calls classifyTopic for topic categorization; falls back to "general" on failure.
 * Non-blocking: errors are logged but never thrown — analytics must not break chat flow.
 */
export async function recordWidgetEvent(data: {
  widgetId: string;
  sessionId?: string | null;
  query: string;
  hasCitations: boolean;
  qualityScore: number;
  responseLength?: number | null;
}): Promise<void> {
  try {
    // Validate widgetId exists in DB before recording (per T-05-05)
    const widget = await prisma.widget.findUnique({
      where: { id: data.widgetId },
      select: { id: true },
    });

    if (!widget) {
      logger.warn("[widgetAnalytics] Widget not found, skipping event recording", {
        widgetId: data.widgetId,
      });
      return;
    }

    // Classify topic — non-blocking, falls back to "general" on failure
    const topicCategory = await classifyTopic(data.query);

    await prisma.widgetEvent.create({
      data: {
        widgetId: data.widgetId,
        sessionId: data.sessionId || null,
        query: data.query,
        topicCategory,
        hasCitations: data.hasCitations,
        qualityScore: data.qualityScore,
        responseLength: data.responseLength || null,
      },
    });

    // Sync WidgetSession.conversationCount to match actual event count (D-06)
    if (data.sessionId) {
      const count = await prisma.widgetEvent.count({
        where: { sessionId: data.sessionId },
      });
      await prisma.widgetSession.update({
        where: { id: data.sessionId },
        data: { conversationCount: count },
      });
    }

    logger.info("[widgetAnalytics] Event recorded", {
      widgetId: data.widgetId,
      topicCategory,
      hasCitations: data.hasCitations,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    const errorMessage = err instanceof Error ? message : "Unknown error";
    logger.error("[widgetAnalytics] Failed to record widget event", { error: errorMessage });
    // Non-blocking: do NOT throw
  }
}

/**
 * Get daily analytics for widget conversations.
 * Uses in-memory date bucketing for date grouping.
 */
export async function getWidgetAnalyticsDaily(
  widgetId: string | null,
  days: number,
): Promise<DailyWidgetAnalytics[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const where: Record<string, unknown> = {
    createdAt: { gte: since },
  };
  if (widgetId) {
    where.widgetId = widgetId;
  }

  const events = await prisma.widgetEvent.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      hasCitations: true,
      qualityScore: true,
    },
  });

  // Group by day
  const dailyMap = new Map<string, DailyWidgetAnalytics>();

  for (const event of events) {
    const day = event.createdAt.toISOString().split("T")[0]!;
    const existing = dailyMap.get(day) ?? {
      date: day,
      conversations: 0,
      unansweredCount: 0,
      qualitySum: 0,
      unansweredRate: 0,
      qualityRate: 0,
    };
    existing.conversations += 1;
    if (!event.hasCitations) {
      existing.unansweredCount += 1;
    }
    existing.qualitySum += event.qualityScore;
    dailyMap.set(day, existing);
  }

  // Calculate rates
  for (const daily of dailyMap.values()) {
    daily.unansweredRate = daily.conversations > 0
      ? Math.round((daily.unansweredCount / daily.conversations) * 100) / 100
      : 0;
    daily.qualityRate = daily.conversations > 0
      ? Math.round((daily.qualitySum / daily.conversations) * 100) / 100
      : 0;
  }

  return Array.from(dailyMap.values());
}

/**
 * Get topic distribution for widget conversations.
 */
export async function getWidgetTopicDistribution(
  widgetId: string | null,
  days: number,
): Promise<TopicDistribution[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const where: Record<string, unknown> = {
    createdAt: { gte: since },
  };
  if (widgetId) {
    where.widgetId = widgetId;
  }

  const events = await prisma.widgetEvent.findMany({
    where,
    select: { topicCategory: true },
  });

  // Group by topic category
  const topicMap = new Map<string, number>();
  for (const event of events) {
    const topic = event.topicCategory;
    topicMap.set(topic, (topicMap.get(topic) || 0) + 1);
  }

  // Sort by count descending
  return Array.from(topicMap.entries())
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get aggregated analytics summary for widget conversations.
 */
export async function getWidgetAnalyticsSummary(
  widgetId: string | null,
  days: number,
): Promise<{
  totalConversations: number;
  unansweredRate: number;
  qualityRate: number;
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const where: Record<string, unknown> = {
    createdAt: { gte: since },
  };
  if (widgetId) {
    where.widgetId = widgetId;
  }

  const events = await prisma.widgetEvent.findMany({
    where,
    select: {
      hasCitations: true,
      qualityScore: true,
    },
  });

  const totalConversations = events.length;
  const unansweredCount = events.filter((e) => !e.hasCitations).length;
  const qualitySum = events.reduce((sum, e) => sum + e.qualityScore, 0);

  return {
    totalConversations,
    unansweredRate: totalConversations > 0
      ? Math.round((unansweredCount / totalConversations) * 100) / 100
      : 0,
    qualityRate: totalConversations > 0
      ? Math.round((qualitySum / totalConversations) * 100) / 100
      : 0,
  };
}