// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 207 (Plan 03 Task 3 / VALIDATION W0) — consumption-gate battery:
 * widget org-owner principal resolution (D-05/P2), connector owner gate,
 * ingest gate contract, and the fail-loud unresolvable arms (P2 — never the
 * service account).
 */

jest.mock("../utils/prisma", () => {
  const makePrisma = () => ({
    $transaction: jest.fn(),
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    workspace: { findUnique: jest.fn() },
    organizationMember: { findFirst: jest.fn() },
    chatConnector: { findUnique: jest.fn() },
    quotaReset: { findFirst: jest.fn(), create: jest.fn() },
    chatMessage: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
    uploadDraft: { aggregate: jest.fn(), findMany: jest.fn() },
    document: { aggregate: jest.fn() },
    workspaceTokenUsage: { aggregate: jest.fn() },
  });
  return { __esModule: true, default: makePrisma() };
});

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(async (key: string) => ({ key, value: "0", readOnly: false })),
}));

jest.mock("../utils/logger", () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Connector-turn collaborators — the gate must run BEFORE runAgent.
jest.mock("../agent/orchestrator", () => ({
  runAgent: jest.fn(async () => ({ response: "ok-reply", sources: [], toolCalls: [], iterations: 1 })),
}));
jest.mock("../filters/filterChain", () => ({
  runInlet: jest.fn(async (ctx: unknown) => ctx),
  runOutlet: jest.fn(async (ctx: unknown) => ctx),
}));
jest.mock("../filters/plugins/dlp", () => ({
  getDlpBypassRoles: jest.fn(async () => []),
}));
jest.mock("../services/widgetChatPrompt", () => ({
  resolveWidgetSystemPrompt: jest.fn(() => "grounding floor"),
}));

import prisma from "../utils/prisma";
import { QuotaError, resolveWidgetQuotaPrincipal, checkTokenQuota } from "../services/quotaService";
import { runConnectorChatTurn } from "../services/connectors/connectorChatService";
import { runAgent } from "../agent/orchestrator";
import type { ConnectorPipelineRow } from "../services/connectors/base";

const mockedPrisma = jest.mocked(prisma);

beforeEach(() => {
  jest.clearAllMocks();
  // Preset sentinel: unset → unlimited unless an override/limit is mocked.
});

describe("resolveWidgetQuotaPrincipal (D-05 org-owner attribution)", () => {
  it("resolves the org's first admin member (joinedAt asc) as the principal", async () => {
    mockedPrisma.workspace.findUnique.mockResolvedValue({ organizationId: "org-1" } as never);
    mockedPrisma.organizationMember.findFirst.mockResolvedValue({ userId: "owner-1" } as never);
    const principal = await resolveWidgetQuotaPrincipal("ws-1");
    expect(principal).toBe("owner-1");
    expect(mockedPrisma.organizationMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roleInOrg: "admin", deletedAt: null }),
        orderBy: { joinedAt: "asc" },
      }),
    );
  });

  it("fails loud when the workspace has no organization (P2 — never the service account)", async () => {
    mockedPrisma.workspace.findUnique.mockResolvedValue({ organizationId: null } as never);
    await expect(resolveWidgetQuotaPrincipal("ws-1")).rejects.toThrow(/no organization/);
  });

  it("fails loud on the zero-org default sentinel", async () => {
    mockedPrisma.workspace.findUnique.mockResolvedValue({
      organizationId: "00000000-0000-0000-0000-000000000000",
    } as never);
    await expect(resolveWidgetQuotaPrincipal("ws-1")).rejects.toThrow(/no organization/);
  });

  it("fails loud when the org has no admin member", async () => {
    mockedPrisma.workspace.findUnique.mockResolvedValue({ organizationId: "org-1" } as never);
    mockedPrisma.organizationMember.findFirst.mockResolvedValue(null as never);
    await expect(resolveWidgetQuotaPrincipal("ws-1")).rejects.toThrow(/no admin member/);
  });
});

describe("connector turn gate (D-03 site 3 / D-05) — real service seam", () => {
  const connectorRow = {
    id: "conn-1",
    platform: "telegram",
    organizationId: "00000000-0000-0000-0000-000000000000",
    workspaceId: "ws-1",
    archiveId: null,
    responseProviderId: null,
    responseModel: null,
    welcomeMessage: null,
    fallbackMessage: null,
    fallbackLocale: "en",
    rateLimitPerMinute: null,
    sessionLimitPerDay: null,
    healthStatus: "healthy",
    lastError: null,
  } as unknown as ConnectorPipelineRow;

  function mockTurnPrisma({ owner, limit, unlimited, usage }: { owner: string | null; limit: number | null; unlimited: boolean; usage: number }) {
    mockedPrisma.chatConnector.findUnique.mockResolvedValue(owner ? { createdBy: owner } : null);
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: limit,
      tokenQuotaUnlimited: unlimited,
    } as never);
    mockedPrisma.quotaReset.findFirst.mockResolvedValue(null as never);
    mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({ _sum: { totalTokens: usage } } as never);
    // Turn collaborators riding prisma: service-account lookup + history read + rows.
    mockedPrisma.user.findFirst.mockResolvedValue({ id: "svc-account" } as never);
    jest.mocked(mockedPrisma.chatMessage.findMany).mockResolvedValue([] as never);
    jest.mocked(mockedPrisma.chatMessage.create).mockResolvedValue({ id: "m1" } as never);
  }

  beforeEach(() => {
    jest.mocked(runAgent).mockClear();
  });

  it("breached owner → QuotaError BEFORE runAgent (no tokens consumed, no staging)", async () => {
    mockTurnPrisma({ owner: "owner-2", limit: 100, unlimited: false, usage: 200 });
    await expect(runConnectorChatTurn(connectorRow, { chatId: "chat-1" }, "hello"))
      .rejects.toBeInstanceOf(QuotaError);
    expect(jest.mocked(runAgent)).not.toHaveBeenCalled();
    expect(mockedPrisma.chatConnector.findUnique).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      select: { createdBy: true },
    });
  });

  it("allowed turn runs with quotaPrincipal = connector owner (D-05 ledger consistency)", async () => {
    mockTurnPrisma({ owner: "owner-2", limit: null, unlimited: true, usage: 0 });
    const result = await runConnectorChatTurn(connectorRow, { chatId: "chat-1" }, "hello");
    expect(result.replyText).toBe("ok-reply");
    expect(jest.mocked(runAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ quotaPrincipal: "owner-2" }),
    );
  });

  it("unresolvable owner → fail loud BEFORE checkTokenQuota (P2 — never the service account)", async () => {
    mockTurnPrisma({ owner: null, limit: null, unlimited: false, usage: 0 });
    await expect(runConnectorChatTurn(connectorRow, { chatId: "chat-1" }, "hello"))
      .rejects.toThrow(/quota principal unresolvable/);
    expect(jest.mocked(runAgent)).not.toHaveBeenCalled();
  });
});

describe("ingest gate contract (D-03 site 4)", () => {
  it("token quota breach blocks ingestion with the same 409 family as generation (SC-1)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      tokenQuotaLimit: 100,
      tokenQuotaUnlimited: false,
    } as never);
    mockedPrisma.quotaReset.findFirst.mockResolvedValue(null as never);
    mockedPrisma.workspaceTokenUsage.aggregate.mockResolvedValue({
      _sum: { totalTokens: 200 },
    } as never);
    const err = await checkTokenQuota("ingest-user").catch((e) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.payload.quota).toBe("tokens");
  });
});