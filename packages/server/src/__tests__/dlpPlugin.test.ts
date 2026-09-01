// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP Filter Plugin unit tests (Phase 100-01)
 *
 * Covers the dlp.ts wrapper plugin (D-07): inlet scan + outlet non-streaming
 * scan, DLP_ENABLED toggle, priority/name/outletStreaming fields. The pure
 * scanContent function from dlpFilter.ts is used unmodified (PLG-02 contract).
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

import dlpPlugin, { getAndClearDlpMatches } from "../filters/plugins/dlp";
import { getSetting } from "../services/systemConfigService";
import { logEvent } from "../services/eventLogService";
import type { FilterContext } from "../filters/types";

/**
 * Quick 260829-ony: the plugin now scans via scanContentAsync →
 * dlpPatternService.getActiveCompiledPatterns (DB-backed patterns). The unit
 * suite mocks the service to return the built-in-equivalent set so assertions
 * on email/credit-card redaction keep passing without a DB.
 */
const mockGetActiveCompiledPatterns = jest.fn().mockResolvedValue([
  { type: "email", regex: /(?<![\p{L}\p{N}_])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?![\p{L}\p{N}_])/gu, replacement: "[REDACTED]" },
  { type: "credit_card", regex: /(?<![\p{L}\p{N}_])(?:\p{N}[ -]*?){13,16}(?![\p{L}\p{N}_])/gu, replacement: "[REDACTED]" },
  { type: "api_key", regex: /\b(sk-[a-zA-Z0-9]{32,})\b/g, replacement: "[REDACTED]" },
]);

jest.mock("../services/dlpPatternService", () => ({
  __esModule: true,
  getActiveCompiledPatterns: (...args: unknown[]) => mockGetActiveCompiledPatterns(...args),
  logDbFallback: jest.fn(),
}));

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

describe("dlpPlugin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("priority is -1, name is 'dlp', outletStreaming is true", () => {
    expect(dlpPlugin.name).toBe("dlp");
    expect(dlpPlugin.priority).toBe(-1);
    expect(dlpPlugin.outletStreaming).toBe(true);
  });

  describe("inlet", () => {
    it("DLP_ENABLED='false' → void return (pass-through)", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "false" });
      const ctx = baseCtx({ message: "user@example.com" });
      const result = await dlpPlugin.inlet!(ctx);
      expect(result).toBeUndefined();
      expect(logEvent).not.toHaveBeenCalled();
    });

    it("DLP_ENABLED='true' + message with email → redacted message + logs dlp.input_match", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({ message: "Contact user@example.com please" });
      const result = await dlpPlugin.inlet!(ctx);
      expect(result).toBeDefined();
      expect(result!.message).toContain("[REDACTED]");
      expect(result!.message).not.toContain("user@example.com");
      expect(logEvent).toHaveBeenCalledWith(
        "dlp",
        "chat-1",
        "dlp.input_match",
        "user-1",
        expect.objectContaining({ matchTypes: expect.arrayContaining(["email"]) }),
      );
    });

    it("DLP_ENABLED='true' + clean message → void return (pass-through)", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({ message: "no PII here" });
      const result = await dlpPlugin.inlet!(ctx);
      expect(result).toBeUndefined();
      expect(logEvent).not.toHaveBeenCalled();
    });
  });

  describe("match text forwarding (Phase 115 DLP Visibility)", () => {
    beforeEach(() => {
      getAndClearDlpMatches("chat-1");
    });

    it("getAndClearDlpMatches returns empty array when no DLP matches occurred", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({ message: "clean text with no PII" });
      await dlpPlugin.inlet!(ctx);
      const matches = getAndClearDlpMatches("chat-1");
      expect(matches).toEqual([]);
    });

    it("inlet captures match text after scanContent finds PII", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({ message: "email user@example.com found" });
      await dlpPlugin.inlet!(ctx);
      const matches = getAndClearDlpMatches("chat-1");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]).toMatchObject({ type: "email", text: "user@example.com" });
    });

    it("getAndClearDlpMatches clears the buffer after reading", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({ message: "email user@example.com found" });
      await dlpPlugin.inlet!(ctx);
      getAndClearDlpMatches("chat-1");
      const matches = getAndClearDlpMatches("chat-1");
      expect(matches).toEqual([]);
    });

    it("outlet captures match text for non-streaming DLP scans", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({
        role: "assistant",
        message: "The card is 4111111111111111 ok",
        streaming: false,
      });
      await dlpPlugin.outlet!(ctx);
      const matches = getAndClearDlpMatches("chat-1");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]).toMatchObject({ type: "credit_card", text: "4111111111111111" });
    });

    it("DLP_ENABLED=false does not populate match buffer", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "false" });
      const ctx = baseCtx({ message: "email user@example.com" });
      await dlpPlugin.inlet!(ctx);
      const matches = getAndClearDlpMatches("chat-1");
      expect(matches).toEqual([]);
    });
  });

  describe("outlet (non-streaming)", () => {
    it("DLP_ENABLED='false' → void return", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "false" });
      const ctx = baseCtx({ role: "assistant", message: "card 4111111111111111" });
      const result = await dlpPlugin.outlet!(ctx);
      expect(result).toBeUndefined();
    });

    it("ctx.streaming=true → void return (streaming handled inline in chat.ts per Pitfall 4)", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({ role: "assistant", message: "x", streaming: true });
      const result = await dlpPlugin.outlet!(ctx);
      expect(result).toBeUndefined();
    });

    // quick 260829-m6p: pin the single-writer contract for dlp.output_match.
    // The streaming chat path (routes/chat.ts) is the SOLE dlp.output_match
    // writer for streaming runs — the plugin's outlet bails on streaming:true
    // and never runs there (chat.ts handles the progressive flush inline per
    // Phase 100 Pitfall 4; runOutlet is only invoked with streaming:false on
    // the non-streaming route, where chat.ts does NOT fire its own
    // dlp.output_match). One event per run, no double-writes.
    it("ctx.streaming=true → no dlp.output_match logged (chat.ts is the sole streaming writer)", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({ role: "assistant", message: "mail@example.com", streaming: true });
      await dlpPlugin.outlet!(ctx);
      expect(logEvent).not.toHaveBeenCalledWith(
        "dlp",
        expect.anything(),
        "dlp.output_match",
        expect.anything(),
        expect.anything(),
      );
    });

    it("ctx.streaming=false + DLP_ENABLED='true' + response with credit card → redacted + logs dlp.output_match", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({
        role: "assistant",
        message: "The card is 4111111111111111 ok",
        streaming: false,
      });
      const result = await dlpPlugin.outlet!(ctx);
      expect(result).toBeDefined();
      expect(result!.message).toContain("[REDACTED]");
      expect(result!.message).not.toContain("4111111111111111");
      expect(logEvent).toHaveBeenCalledWith(
        "dlp",
        "chat-1",
        "dlp.output_match",
        "user-1",
        expect.objectContaining({ matchTypes: expect.arrayContaining(["credit_card"]) }),
      );
    });

    it("ctx.streaming=false + DLP_ENABLED='true' + clean response → void return", async () => {
      (getSetting as jest.Mock).mockResolvedValue({ value: "true" });
      const ctx = baseCtx({ role: "assistant", message: "clean answer", streaming: false });
      const result = await dlpPlugin.outlet!(ctx);
      expect(result).toBeUndefined();
      expect(logEvent).not.toHaveBeenCalled();
    });
  });
});