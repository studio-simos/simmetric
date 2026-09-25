// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-02 Task 3, D-07/T-198-06/07/08) — connectorChatService
 * tests. Postgres-free: orchestrator/filterChain/prisma mocked.
 */
// @ts-nocheck
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  (mock.prisma as any).chatMessage = {
    findMany: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
  };
  (mock.prisma as any).user = { findFirst: jest.fn(), findUnique: jest.fn() };
  // Phase 207 (D-03 site 3): quota gate seams — owner fetch + unlimited
  // resolution + empty ledger window (the turn runs ungated by default here;
  // the gate's own battery lives in quotaGates.test.ts).
  (mock.prisma as any).chatConnector = { findUnique: jest.fn() };
  (mock.prisma as any).quotaReset = { findFirst: jest.fn(), create: jest.fn() };
  (mock.prisma as any).workspaceTokenUsage = { aggregate: jest.fn() };
  return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
});

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Orchestrator + filter chain + system config + DLP bypass — all mocked (the
// service's own seam behavior is what this suite pins).
jest.mock("../agent/orchestrator", () => ({
  runAgent: jest.fn(),
}));
jest.mock("../filters/filterChain", () => ({
  runInlet: jest.fn(),
  runOutlet: jest.fn(),
}));
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(async (key: string) => ({ key, value: "true", readOnly: false })),
}));
jest.mock("../filters/plugins/dlp", () => ({
  getDlpBypassRoles: jest.fn(async () => []),
}));
jest.mock("../services/widgetChatPrompt", () => ({
  resolveWidgetSystemPrompt: jest.fn((raw: string | null | undefined) =>
    typeof raw === "string" && raw.trim() ? raw.trim() : "GROUNDING_FLOOR_PROMPT"
  ),
}));
jest.mock("../services/seedService", () => ({ seedServiceAccount: jest.fn() }));

import prisma from "../utils/prisma";
import { runAgent } from "../agent/orchestrator";
import { runInlet, runOutlet } from "../filters/filterChain";
import { getSetting } from "../services/systemConfigService";
import { getDlpBypassRoles } from "../filters/plugins/dlp";
import { resolveWidgetSystemPrompt } from "../services/widgetChatPrompt";
import {
  runConnectorChatTurn,
  resetServiceAccountIdCache,
} from "../services/connectors/connectorChatService";

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-4466554400c1";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-4466554400c2";
const CHAT_ID = "chat-198-c";
const SESSION_ID = "session-198-c";
const ORG_ID = "org-198-c";
const SVC_ID = "svc-198-c";
const CONNECTOR_OWNER = "connector-owner-207";

function connectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR_ID,
    platform: "telegram",
    organizationId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    archiveId: null,
    responseProviderId: "prov-pin",
    responseModel: "model-pin",
    welcomeMessage: null,
    fallbackMessage: "Custom fallback",
    fallbackLocale: "it",
    rateLimitPerMinute: null,
    sessionLimitPerDay: null,
    healthStatus: "unknown",
    lastError: null,
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    connectorId: CONNECTOR_ID,
    platformUserId: "tg-user-1",
    chatId: CHAT_ID,
    messageCount: 1,
    lastMessageAt: new Date(),
    lastResetAt: new Date(),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetServiceAccountIdCache();
  (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SVC_ID });
  // Phase 207 gate defaults: resolvable owner + unlimited quota + empty window.
  (prisma.chatConnector.findUnique as jest.Mock).mockResolvedValue({ createdBy: CONNECTOR_OWNER });
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ tokenQuotaLimit: null, tokenQuotaUnlimited: true });
  (prisma.quotaReset.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.workspaceTokenUsage.aggregate as jest.Mock).mockResolvedValue({ _sum: { totalTokens: 0 } });
  (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
  (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.chatMessage.create as jest.Mock).mockResolvedValue({ id: "msg-1" });
  (runAgent as jest.Mock).mockResolvedValue({
    response: "agent answer",
    sources: [{ documentId: "d1", documentName: "Doc", chunkText: "chunk" }],
    toolCalls: [],
    iterations: 1,
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, model: "m" },
    resolvedModel: "model-pin",
    providerType: "ollama",
  });
  (runInlet as jest.Mock).mockImplementation((ctx: { message: string }) =>
    Promise.resolve({ ...ctx, message: ctx.message })
  );
  (runOutlet as jest.Mock).mockImplementation((ctx: { message: string }) =>
    Promise.resolve({ ...ctx, message: ctx.message })
  );
});

// ─── Happy path: the full D-07 persistence sequence ──────────────────

describe("runConnectorChatTurn — happy path (D-07)", () => {
  it("runInlet → runAgent → runOutlet → chatMessage.create ×2, returns replyText", async () => {
    const result = await runConnectorChatTurn(connectorRow(), sessionRow(), "What is ECCO?");

    expect(result).toEqual({ replyText: "agent answer" });
    expect(runInlet).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runOutlet).toHaveBeenCalledTimes(1);
    expect(prisma.chatMessage.create).toHaveBeenCalledTimes(2); // user + assistant
  });

  it("runInlet is called with source 'chat' and the service-account userId (D-21/T-198-08)", async () => {
    await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    const inletCtx = (runInlet as jest.Mock).mock.calls[0][0];
    expect(inletCtx.source).toBe("chat"); // filters/types.ts union untouched
    expect(inletCtx.role).toBe("user");
    expect(inletCtx.userId).toBe(SVC_ID);
    expect(inletCtx.workspaceId).toBe(WORKSPACE_ID);
    expect(inletCtx.chatId).toBe(CHAT_ID);
    expect(inletCtx.streaming).toBe(false);
  });

  it("runAgent receives workspaceId from the CONNECTOR ROW (never input — T-198-06 anti-IDOR)", async () => {
    await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    const params = (runAgent as jest.Mock).mock.calls[0][0];
    expect(params.workspaceId).toBe(WORKSPACE_ID); // the row's binding
    expect(params.userId).toBe(SVC_ID); // service account acting user
    expect(params.chatId).toBe(CHAT_ID);
    // NO strictModelResolution (the widget-style lenient chain, D-07).
    expect(params.strictModelResolution).toBeUndefined();
  });

  it("providerId/model = the connector pin columns; null pins → undefined passthrough (resolution chain, D-07)", async () => {
    await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    let params = (runAgent as jest.Mock).mock.calls[0][0];
    expect(params.providerId).toBe("prov-pin");
    expect(params.model).toBe("model-pin");

    (runAgent as jest.Mock).mockClear();
    await runConnectorChatTurn(
      connectorRow({ responseProviderId: null, responseModel: null }),
      sessionRow(),
      "hi"
    );
    params = (runAgent as jest.Mock).mock.calls[0][0];
    expect(params.providerId).toBeUndefined(); // falls through to the chain
    expect(params.model).toBeUndefined();
  });

  it("archiveId and locale ride the connector row; widgetSystemPrompt = resolveWidgetSystemPrompt(null) (grounding floor, D-07)", async () => {
    await runConnectorChatTurn(
      connectorRow({ archiveId: "arch-1", fallbackLocale: "it" }),
      sessionRow(),
      "hi"
    );

    const params = (runAgent as jest.Mock).mock.calls[0][0];
    expect(params.archiveId).toBe("arch-1");
    expect(params.locale).toBe("it");
    // The grounding floor: resolveWidgetSystemPrompt(null) — the null-arm
    // (no per-connector systemPrompt column v1, D-07).
    expect(resolveWidgetSystemPrompt).toHaveBeenCalledWith(null);
    expect(params.widgetSystemPrompt).toBe("GROUNDING_FLOOR_PROMPT");
    expect(params.dlpMaskingEnabled).toBe(true); // DLP gate consulted below
  });

  it("history = the chat's NEWEST 10 pairs chronological (WR-01: desc take-20 + reverse, system filtered, D-08)", async () => {
    // 24 older rows — the mock returns rows in desc order (newest first),
    // mirroring what the query now asks Prisma for.
    const rows = Array.from({ length: 24 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    })).reverse();
    (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue(rows);

    await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    const findArgs = (prisma.chatMessage.findMany as jest.Mock).mock.calls[0][0];
    expect(findArgs.where).toEqual({ chatId: CHAT_ID });
    // WR-01: NEWEST 20 — orderBy desc, no skip (asc+take:20 loaded the
    // conversation's opening messages and froze context past 20 turns).
    expect(findArgs.orderBy).toEqual({ createdAt: "desc" });
    expect(findArgs.take).toBe(20);
    expect(findArgs.skip).toBeUndefined();

    const params = (runAgent as jest.Mock).mock.calls[0][0];
    // After reverse: chronological, ending at the newest row (m23); the
    // OLDEST 4 (m0..m3) are cut.
    expect(params.history).toHaveLength(20);
    expect(params.history[0]).toEqual({ role: "user", content: "m4" });
    expect(params.history[19]).toEqual({ role: "assistant", content: "m23" });
  });

  it("DLP gate consulted: getSetting(DLP_ENABLED) + getDlpBypassRoles (chat.ts:433 pattern, T-198-08)", async () => {
    (getSetting as jest.Mock).mockResolvedValue({ key: "DLP_ENABLED", value: "true", readOnly: false });
    (getDlpBypassRoles as jest.Mock).mockResolvedValue([]);

    await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    expect(getSetting).toHaveBeenCalledWith("DLP_ENABLED");
    expect(getDlpBypassRoles).toHaveBeenCalledWith([]); // service account: no bypass roles
    const params = (runAgent as jest.Mock).mock.calls[0][0];
    expect(params.dlpMaskingEnabled).toBe(true);
  });

  it("DLP_ENABLED false → dlpScanEnabled false (no scan) but the flag still threads", async () => {
    (getSetting as jest.Mock).mockResolvedValue({ key: "DLP_ENABLED", value: "false", readOnly: false });

    await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    const params = (runAgent as jest.Mock).mock.calls[0][0];
    expect(params.dlpMaskingEnabled).toBe(false);
  });

  it("runOutlet wraps the agent response before persistence (D-21 outlet masking)", async () => {
    (runOutlet as jest.Mock).mockImplementation((ctx: { message: string }) =>
      Promise.resolve({ ...ctx, message: "masked:" + ctx.message })
    );

    const result = await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    const outletCtx = (runOutlet as jest.Mock).mock.calls[0][0];
    expect(outletCtx.message).toBe("agent answer");
    expect(outletCtx.role).toBe("assistant");
    expect(outletCtx.source).toBe("chat");
    expect(result.replyText).toBe("masked:agent answer");
  });

  it("chatMessage.create ×2 carry EXPLICIT organizationId resolved from the WORKSPACE chain (CR-03, T-198-08, WR-05)", async () => {
    // WR-05: the org source is the workspace chain — the same source
    // sessionResolver.createChat stamps the Chat with and the webhook arm's
    // tenant window opens with. The connector row's org can diverge when a
    // cross-org workspaceId slipped through (now blocked at create).
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-from-workspace",
    });

    await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    const userRow = (prisma.chatMessage.create as jest.Mock).mock.calls[0][0].data;
    const assistantRow = (prisma.chatMessage.create as jest.Mock).mock.calls[1][0].data;
    expect(userRow.chatId).toBe(CHAT_ID);
    expect(userRow.role).toBe("user");
    expect(userRow.organizationId).toBe("org-from-workspace");
    expect(assistantRow.role).toBe("assistant");
    expect(assistantRow.organizationId).toBe("org-from-workspace");
    // The stamp queried the workspace chain.
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WORKSPACE_ID } })
    );
    // The assistant row carries the result metadata (+ connector provenance).
    const meta = JSON.parse(assistantRow.metadata);
    expect(meta.connectorId).toBe(CONNECTOR_ID);
    expect(meta.platform).toBe("telegram");
    expect(meta.modelUsed).toBe("model-pin");
  });

  it("mixed-org pin (WR-05 regression): a connector row whose org DIFFERS from the workspace org still stamps chatMessages with the workspace org", async () => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      organizationId: "org-workspace-real",
    });

    await runConnectorChatTurn(
      connectorRow({ organizationId: "org-creator" }),
      sessionRow(),
      "hi"
    );

    const userRow = (prisma.chatMessage.create as jest.Mock).mock.calls[0][0].data;
    const assistantRow = (prisma.chatMessage.create as jest.Mock).mock.calls[1][0].data;
    // The tenant-scoped history read filters on the workspace org — the rows
    // must carry IT, not the connector's (stale) creator org.
    expect(userRow.organizationId).toBe("org-workspace-real");
    expect(assistantRow.organizationId).toBe("org-workspace-real");
  });

  it("the user row persists AFTER the inlet and BEFORE the agent (chat.ts sequence parity)", async () => {
    const order: string[] = [];
    (runInlet as jest.Mock).mockImplementation(async (ctx: { message: string }) => {
      order.push("inlet");
      return { ...ctx, message: ctx.message };
    });
    (prisma.chatMessage.create as jest.Mock).mockImplementation(({ data }) => {
      order.push(`create:${data.role}`);
      return Promise.resolve({ id: "m" });
    });
    (runAgent as jest.Mock).mockImplementation(async () => {
      order.push("agent");
      return { response: "answer", iterations: 1 };
    });
    (runOutlet as jest.Mock).mockImplementation(async (ctx: { message: string }) => {
      order.push("outlet");
      return { ...ctx, message: ctx.message };
    });

    await runConnectorChatTurn(connectorRow(), sessionRow(), "hi");

    expect(order).toEqual(["inlet", "create:user", "agent", "outlet", "create:assistant"]);
  });
});

// ─── Error paths (D-12 single error owner) ───────────────────────────

describe("runConnectorChatTurn — failure paths (D-12)", () => {
  it("runAgent throw → the error PROPAGATES to the caller (messageRouter owns fallback)", async () => {
    (runAgent as jest.Mock).mockRejectedValue(new Error("provider down"));

    await expect(
      runConnectorChatTurn(connectorRow(), sessionRow(), "hi")
    ).rejects.toThrow("provider down");
    // The assistant row was NOT persisted.
    expect(prisma.chatMessage.create).toHaveBeenCalledTimes(1); // user row only
  });

  it("empty result.response → throws (the caller's fallback path, D-12)", async () => {
    (runAgent as jest.Mock).mockResolvedValue({ response: "", iterations: 0 });

    await expect(
      runConnectorChatTurn(connectorRow(), sessionRow(), "hi")
    ).rejects.toThrow("empty response");
  });

  it("whitespace-only result.response → throws (failure path, D-12)", async () => {
    (runAgent as jest.Mock).mockResolvedValue({ response: "   \n", iterations: 0 });

    await expect(
      runConnectorChatTurn(connectorRow(), sessionRow(), "hi")
    ).rejects.toThrow("empty response");
  });

  it("null chatId (caller-contract violation) → throws", async () => {
    await expect(
      runConnectorChatTurn(connectorRow(), { chatId: null }, "hi")
    ).rejects.toThrow("no chatId");
  });

  it("missing service account (boot-order violation) → throws loudly", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      runConnectorChatTurn(connectorRow(), sessionRow(), "hi")
    ).rejects.toThrow("seedServiceAccount");
  });
});

// ─── Source-level contract pins (grep-equivalent, per plan) ──────────

describe("source contract (D-07 seams)", () => {
  it("the service imports runAgent from orchestrator and runInlet/runOutlet from filterChain — NO routes/chat, NO SSE res", async () => {
    const fs = require("fs") as typeof import("fs");
    const src = fs.readFileSync(
      require("path").join(__dirname, "../services/connectors/connectorChatService.ts"),
      "utf8"
    );
    expect(src).toContain('from "../../agent/orchestrator"');
    expect(src).toContain('from "../../filters/filterChain"');
    // Import-statement level checks (the header comment MENTIONS the SSE
    // facade to document the deliberate split — only real code usage is
    // forbidden).
    expect(src).not.toMatch(/from\s+"(\.\.\/)+routes\/chat"/);
    expect(src).not.toMatch(/import\s+.*handleChatStream/);
    expect(src).not.toContain("new PrismaClient()");
    expect(src).not.toMatch(/\bnew\s+PrismaClient\b/);
    expect(src).toContain('from "../../utils/prisma"'); // singleton only
  });
});