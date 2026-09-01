// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * eventLogShim.test.ts — tests the community logEvent() delegating shim
 * (Phase 144 EPA-04 D-01/D-02/D-11/D-12).
 *
 * Coverage:
 *  - no-op: logEvent resolves immediately when no delegate set (community build)
 *  - delegates: logEvent calls the registered delegate with the AuditLogEvent
 *  - never rejects: delegate throwing does not propagate to caller (D-02)
 *  - webhook dispatch fires: dispatchWebhookEvent is called for mapped actions (D-12)
 *
 * Phase 144 (EPA-04) Plan 01
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

jest.mock("../services/webhookService", () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}));

const { logEvent, setAuditLogDelegate } = require("../services/eventLogService");
const { dispatchWebhookEvent } = require("../services/webhookService");

describe("eventLog shim — D-01/D-02/D-11/D-12", () => {
  afterEach(() => {
    setAuditLogDelegate(null);
    jest.clearAllMocks();
  });

  it("no-op: logEvent resolves immediately when no delegate set (community build)", async () => {
    setAuditLogDelegate(null);
    await expect(
      logEvent("chat", "id-1", "message", null, { foo: "bar" }),
    ).resolves.toBeUndefined();
  });

  it("delegates: logEvent calls the registered delegate with the AuditLogEvent", async () => {
    const mockDelegate = jest.fn().mockResolvedValue(undefined);
    setAuditLogDelegate(mockDelegate);

    await logEvent("chat", "id-1", "create", "user-1", { meta: true });

    expect(mockDelegate).toHaveBeenCalledTimes(1);
    expect(mockDelegate).toHaveBeenCalledWith({
      entityType: "chat",
      entityId: "id-1",
      action: "create",
      userId: "user-1",
      metadata: { meta: true },
    });
  });

  it("never rejects: delegate throwing does not propagate to caller (D-02)", async () => {
    setAuditLogDelegate(jest.fn().mockRejectedValue(new Error("DB down")));

    await expect(
      logEvent("chat", "id-1", "message", null),
    ).resolves.toBeUndefined();
  });

  it("webhook dispatch fires: dispatchWebhookEvent is called for mapped actions (D-12)", async () => {
    setAuditLogDelegate(null);

    await logEvent("chat", "id-1", "message", null);

    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      "chat.created",
      expect.objectContaining({
        entityType: "chat",
        entityId: "id-1",
        action: "message",
      }),
    );
  });
});