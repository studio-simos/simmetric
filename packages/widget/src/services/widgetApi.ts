// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import axios from "axios";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import type { WidgetConfigResponse } from "@simmetric-chat/shared";

// 151-02 (Task 7): a 402 from the internal API means the widget runtime is
// disabled by license (Community tier — widget_enabled=false). Log it clearly
// and rethrow so the caller route maps it to a graceful "widget unavailable"
// response (503) instead of a 500 crash path.
function isWidgetDisabledError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { response?: { status?: number } }).response?.status === 402
  );
}

export async function getWidgetConfig(widgetId: string): Promise<WidgetConfigResponse> {
  const env = getEnv();
  try {
    const { data } = await axios.get(`${env.SERVER_URL}/api/internal/widget/${widgetId}/config`, {
      headers: { "X-Api-Key": env.WIDGET_API_KEY },
    });
    return data;
  } catch (err: unknown) {
    if (isWidgetDisabledError(err)) {
      logger.warn(`[widget] Widget disabled by license (402) — config for ${widgetId}`);
    }
    throw err;
  }
}

export async function validateSession(sessionToken: string) {
  const env = getEnv();
  const { data } = await axios.get(`${env.SERVER_URL}/api/internal/widget/session/${sessionToken}`, {
    headers: { "X-Api-Key": env.WIDGET_API_KEY },
  });
  return data;
}

export async function createSession(widgetId: string, ipAddress?: string) {
  const env = getEnv();
  try {
    const { data } = await axios.post(`${env.SERVER_URL}/api/internal/widget/session`, {
      widgetId,
      ipAddress,
    }, {
      headers: { "X-Api-Key": env.WIDGET_API_KEY },
    });
    return data;
  } catch (err: unknown) {
    if (isWidgetDisabledError(err)) {
      logger.warn(`[widget] Widget disabled by license (402) — session create for ${widgetId}`);
    }
    throw err;
  }
}

export async function incrementSessionCounters(sessionToken: string, field: "messageCount" | "conversationCount") {
  const env = getEnv();
  const { data } = await axios.patch(`${env.SERVER_URL}/api/internal/widget/session/${sessionToken}/increment`, {
    field,
  }, {
    headers: { "X-Api-Key": env.WIDGET_API_KEY },
  });
  return data;
}

// Search widget's linked workspaces via internal API (RAG-02, RAG-03)
// Sends widgetId (not workspaceIds) -- server resolves workspaceIds from DB whitelist (IDOR prevention)
export async function searchWidgetWorkspaces(query: string, widgetId: string, limit: number = 10) {
  const env = getEnv();
  const { data } = await axios.post(`${env.SERVER_URL}/api/internal/widget/search`, {
    query,
    widgetId,
    limit,
  }, {
    headers: { "X-Api-Key": env.WIDGET_API_KEY },
    timeout: 30000,
  });
  return data;
}

// Submit lead data to main server internal API.
// Called by widget service route (server-side only) -- not by Preact client.
// sessionId MUST be the WidgetSession.id (UUID) from req.widgetSession, NOT the sessionToken.
export async function submitLead(
  widgetId: string,
  email: string,
  name: string | undefined,
  transcript: Array<{ role: string; content: string; timestamp?: string }>,
  sessionId: string | null
): Promise<{ id: string; email: string; createdAt: string }> {
  const env = getEnv();
  const { data } = await axios.post(`${env.SERVER_URL}/api/internal/widget/lead`, {
    widgetId,
    email,
    name,
    transcript,
    sessionId,
  }, {
    headers: {
      "X-Api-Key": env.WIDGET_API_KEY,
      "Content-Type": "application/json",
    },
    timeout: 10000,
  });
  return data;
}