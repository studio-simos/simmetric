// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP role-bypass unit tests (DLP_FEATURES_SPEC §2.2 + §4.6, quick 260829-n95).
 *
 * Pins the per-role bypass contract of the dlp filter plugin:
 *   - role in DLP_BYPASS_ROLES → NO redaction, message passes through,
 *     + fire-and-forget `dlp.bypassed` audit event with the INTERSECTED
 *       roles array (WHO bypassed — never the scan content, §4.6)
 *   - role NOT in the list → redaction unchanged (byte-identical legacy path)
 *   - malformed config value → safe [] fallback (fail-closed: no bypass)
 *   - both inlet AND outlet honor the bypass (consistency: every DLP scan
 *     site is gated)
 */
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn(),
}));

import dlpPlugin from "../filters/plugins/dlp";
import { getSetting } from "../services/systemConfigService";
import { logEvent } from "../services/eventLogService";
import type { FilterContext } from "../filters/types";

const baseCtx = (overrides: Partial<FilterContext> = {}): FilterContext => ({
  message: "hello world",
  chatId: "chat-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "user",
  metadata: {},
  streaming: false,
  ...overrides,
});

describe("dlpPlugin — DLP_BYPASS_ROLES (260829-n95, spec §2.2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("inlet", () => {
    it("user role in bypass list → NO redaction (message passes through), dlp.bypassed logged with roles", async () => {
      (getSetting as jest.Mock).mockImplementation(async (key: string) => ({
        value: key === "DLP_ENABLED" ? "true" : '["trusted_analyst"]',
      }));
      const ctx = baseCtx({
        message: "Contact user@example.com please",
        userRoles: ["user", "trusted_analyst"],
      });
      const result = await dlpPlugin.inlet!(ctx);

      expect(result).toBeUndefined(); // pass-through, no redaction rewrite
      expect(logEvent).toHaveBeenCalledTimes(1);
      // Audit logs the INTERSECTED roles — bypassed names only, not the full
      // user role list (spec §4.6: log WHO bypassed, minimal data).
      expect(logEvent).toHaveBeenCalledWith(
        "dlp",
        "chat-1",
        "dlp.bypassed",
        "user-1",
        expect.objectContaining({ roles: ["trusted_analyst"] }),
      );
      // No input_match logged — scanning was skipped entirely
      expect(logEvent).not.toHaveBeenCalledWith(
        "dlp", "chat-1", "dlp.input_match", expect.anything(), expect.anything(),
      );
    });

    it("user role NOT in bypass list → redaction proceeds (unchanged behavior)", async () => {
      (getSetting as jest.Mock).mockImplementation(async (key: string) => ({
        value: key === "DLP_ENABLED" ? "true" : '["trusted_analyst"]',
      }));
      const ctx = baseCtx({
        message: "Contact user@example.com please",
        userRoles: ["user"],
      });
      const result = await dlpPlugin.inlet!(ctx);

      expect(result).toBeDefined();
      expect(result!.message).toContain("[REDACTED]");
      expect(result!.message).not.toContain("user@example.com");
      expect(logEvent).toHaveBeenCalledWith(
        "dlp", "chat-1", "dlp.input_match", "user-1",
        expect.objectContaining({ matchTypes: expect.arrayContaining(["email"]) }),
      );
      expect(logEvent).not.toHaveBeenCalledWith(
        "dlp", expect.anything(), "dlp.bypassed", expect.anything(), expect.anything(),
      );
    });

    it("no userRoles on ctx → no bypass possible (legacy callers unchanged)", async () => {
      (getSetting as jest.Mock).mockImplementation(async (key: string) => ({
        value: key === "DLP_ENABLED" ? "true" : '["trusted_analyst"]',
      }));
      const ctx = baseCtx({ message: "email user@example.com" });
      const result = await dlpPlugin.inlet!(ctx);

      expect(result!.message).toContain("[REDACTED]");
      expect(logEvent).toHaveBeenCalledTimes(1);
      expect(logEvent).toHaveBeenCalledWith(
        "dlp", "chat-1", "dlp.input_match", "user-1",
        expect.objectContaining({ matchTypes: expect.arrayContaining(["email"]) }),
      );
    });

    it("malformed DLP_BYPASS_ROLES JSON → treated as [] (fail-closed, redaction runs)", async () => {
      (getSetting as jest.Mock).mockImplementation(async (key: string) => ({
        value: key === "DLP_ENABLED" ? "true" : "not-json{",
      }));
      const ctx = baseCtx({
        message: "mail user@example.com",
        userRoles: ["admin"],
      });
      const result = await dlpPlugin.inlet!(ctx);

      expect(result!.message).toContain("[REDACTED]");
      expect(logEvent).not.toHaveBeenCalledWith(
        "dlp", expect.anything(), "dlp.bypassed", expect.anything(), expect.anything(),
      );
    });

    it("bypass audit event carries source when ctx.source is set (260829-ms8 tag)", async () => {
      (getSetting as jest.Mock).mockImplementation(async (key: string) => ({
        value: key === "DLP_ENABLED" ? "true" : '["executive"]',
      }));
      const ctx = baseCtx({
        message: "user@example.com",
        userRoles: ["executive"],
        source: "widget",
      });
      await dlpPlugin.inlet!(ctx);

      expect(logEvent).toHaveBeenCalledWith(
        "dlp", "chat-1", "dlp.bypassed", "user-1",
        expect.objectContaining({ roles: ["executive"], source: "widget" }),
      );
    });
  });

  describe("outlet (non-streaming)", () => {
    it("bypass role → assistant output NOT redacted + dlp.bypassed logged", async () => {
      (getSetting as jest.Mock).mockImplementation(async (key: string) => ({
        value: key === "DLP_ENABLED" ? "true" : '["trusted_analyst"]',
      }));
      const ctx = baseCtx({
        role: "assistant",
        message: "The card is 4111111111111111 ok",
        streaming: false,
        userRoles: ["trusted_analyst"],
      });
      const result = await dlpPlugin.outlet!(ctx);

      expect(result).toBeUndefined(); // pass-through — NO redaction
      expect(logEvent).toHaveBeenCalledWith(
        "dlp", "chat-1", "dlp.bypassed", "user-1",
        expect.objectContaining({ roles: ["trusted_analyst"] }),
      );
      expect(logEvent).not.toHaveBeenCalledWith(
        "dlp", "chat-1", "dlp.output_match", expect.anything(), expect.anything(),
      );
    });

    it("non-bypass role → redaction unchanged", async () => {
      (getSetting as jest.Mock).mockImplementation(async (key: string) => ({
        value: key === "DLP_ENABLED" ? "true" : '["trusted_analyst"]',
      }));
      const ctx = baseCtx({
        role: "assistant",
        message: "The card is 4111111111111111 ok",
        streaming: false,
        userRoles: ["user"],
      });
      const result = await dlpPlugin.outlet!(ctx);

      expect(result!.message).toContain("[REDACTED]");
      expect(result!.message).not.toContain("4111111111111111");
    });
  });
});