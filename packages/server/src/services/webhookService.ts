// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import axios from "axios";
import crypto from "crypto";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Dispatch a webhook event to all matching subscribers.
 * Non-blocking: errors are caught and logged, never thrown.
 */
export async function dispatchWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Find all enabled webhooks that subscribe to this event
  const webhooks = await prisma.webhook.findMany({
    where: { enabled: true },
  });

  const matching = webhooks.filter((wh) => {
    try {
      const events: string[] = JSON.parse(wh.events);
      return events.includes(event) || events.includes("*");
    } catch {
      return false;
    }
  });

  if (matching.length === 0) return;

  logger.info(`[webhook] Dispatching event "${event}" to ${matching.length} subscriber(s)`);

  // Fire all deliveries in parallel (non-blocking)
  for (const webhook of matching) {
    deliverWebhook(webhook, event, payload).catch((err: unknown) => {
      logger.warn(`[webhook] Failed to deliver to ${webhook.url}: ${(err instanceof Error ? err.message : String(err))}`);
    });
  }
}

/**
 * Deliver a webhook with retry logic (exponential backoff).
 */
async function deliverWebhook(
  webhook: { id: string; url: string; secret: string | null; failureCount: number },
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Event": event,
  };

  // Sign payload with HMAC if secret is configured
  if (webhook.secret) {
    const signature = crypto
      .createHmac("sha256", webhook.secret)
      .update(body)
      .digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await axios.post(webhook.url, body, {
        headers,
        timeout: 10000,
      });

      // Success — reset failure count
      await prisma.webhook.update({
        where: { id: webhook.id },
        data: { lastSentAt: new Date(), failureCount: 0 },
      });

      logger.info(`[webhook] Delivered "${event}" to ${webhook.url} (attempt ${attempt})`);
      return;
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        `[webhook] Attempt ${attempt}/${MAX_RETRIES} failed for ${webhook.url}: ${message}`
      );

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted — increment failure count
  await prisma.webhook.update({
    where: { id: webhook.id },
    data: { failureCount: { increment: 1 } },
  });

  // Disable after too many failures
  if (webhook.failureCount + 1 >= 10) {
    await prisma.webhook.update({
      where: { id: webhook.id },
      data: { enabled: false },
    });
    logger.warn(`[webhook] Disabled webhook ${webhook.id} after 10 consecutive failures`);
  }
}