// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { logger } from "../utils/logger";
import type { EntityType, AuditLogEvent } from "@simmetric-chat/shared";
import { dispatchWebhookEvent } from "./webhookService";

// Map entity actions to webhook event names
const ACTION_TO_WEBHOOK_EVENT: Record<string, string> = {
  message: "chat.created",
  create: "document.uploaded",
  upload: "document.uploaded",
  delete: "document.deleted",
};

// D-11: module-level delegate — set by enterpriseLoader via setAuditLogDelegate.
// null in community builds (no enterprise plugin) → logEvent() no-ops.
let auditLogDelegate: ((event: AuditLogEvent) => Promise<void>) | null = null;

/**
 * D-11: Called by enterpriseLoader.ts when the enterprise plugin calls
 * ctx.registerAuditLogWriter(fn). Injects the enterprise writer into the
 * community shim without the shim importing the enterprise package (IoC).
 */
export function setAuditLogDelegate(fn: ((event: AuditLogEvent) => Promise<void>) | null): void {
  auditLogDelegate = fn;
}

// D-01: signature byte-identical to the original — all 33 call sites unchanged.
export async function logEvent(
  entityType: EntityType,
  entityId: string,
  action: string,
  userId: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    // D-01: delegate the audit write to the enterprise plugin (or no-op in community)
    const writePromise = auditLogDelegate
      ? auditLogDelegate({ entityType, entityId, action, userId, metadata })
      : Promise.resolve();

    // D-12: webhook dispatch stays in community (fire-and-forget, never blocks)
    const webhookEvent = ACTION_TO_WEBHOOK_EVENT[action];
    if (webhookEvent) {
      dispatchWebhookEvent(webhookEvent, {
        entityType,
        entityId,
        action,
        userId,
        ...metadata,
      }).catch(() => {
        // fire-and-forget — never throw
      });
    }

    // Await the write (preserves the await contract for callers that await logEvent)
    await writePromise;

    logger.info("Event logged", { entityType, entityId, action, userId });
  } catch (err: unknown) {
    // D-02: never throw to the caller — a failed audit write must not break the user-facing op
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to log event", { error: message, entityType, entityId, action });
  }
}