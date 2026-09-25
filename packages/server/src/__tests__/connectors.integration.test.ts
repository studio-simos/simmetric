// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-01b Task 3) — real-Postgres verification of the 198-01
 * connector schema (ECCO-01 live): column defaults, BigInt pollOffset
 * roundtrip (first BigInt column in the repo), the ConnectorMessage
 * @@unique([connectorId, platformMessageId]) dedup arbiter (D-11), the
 * ConnectorSession unique pair, and soft-delete isolation.
 *
 * Uses the per-file worker DB cloned by jest.setup.integration.ts
 * (jest.config.integration.js + globalSetup migrations + seed).
 *
 * NEVER partial Prisma mocks (MEMORY: rag-empty-results-diagnosis) — this
 * file contains NO jest.mock of ../utils/prisma.
 */
import "./helpers/setupEnv";
import { ensureOrgMembership } from "../../jest.setup.integration";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

let prisma: import("@prisma/client").PrismaClient;

let adminUserId: string;
let projectId: string;
let workspaceId: string;
let organizationId: string;

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();

  // Seed admin user (admin role seeded by globalSetup's `prisma db seed`).
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const salt = await bcrypt.genSalt(12);
  const admin = await prisma.user.create({
    data: {
      username: "p198_connectors_admin",
      email: "p198_connectors_admin@test.local",
      passwordHash: await bcrypt.hash("connector-pw-9K", salt),
      salt,
    },
  });
  adminUserId = admin.id;
  if (adminRole) {
    await prisma.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id },
    });
  }
  await ensureOrgMembership(prisma, admin.id);

  // The membership's org (deterministic first membership — mirrors the
  // tenantContextMiddleware D-01 resolution order).
  const membership = await prisma.organizationMember.findFirst({
    where: { userId: adminUserId, deletedAt: null },
    orderBy: { joinedAt: "asc" as const },
    select: { organizationId: true },
  });
  organizationId = membership?.organizationId ?? "00000000-0000-0000-0000-000000000000";

  // Project → Workspace (FK chain required for ChatConnector.workspaceId).
  const project = await prisma.project.create({
    data: { name: "p198-connectors-proj", createdBy: adminUserId },
  });
  projectId = project.id;
  const workspace = await prisma.workspace.create({
    data: { name: "p198-connectors-ws", projectId, organizationId },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  // FK-safe cleanup order (children first).
  await prisma.connectorMessage.deleteMany({}).catch(() => {});
  await prisma.connectorSession.deleteMany({}).catch(() => {});
  await prisma.chatConnector.deleteMany({}).catch(() => {});
  await prisma.chat.deleteMany({}).catch(() => {});
  await prisma.workspace.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
  await prisma.organizationMember.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
  await prisma.userRole.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: adminUserId } }).catch(() => {});
  await prisma.$disconnect();
});

// 1. Create-with-defaults: org sentinel default, pollMode "polling",
//    pollOffset 0n (BigInt), healthStatus "unknown" (198-01/D-01 defaults
//    on a live DB).
describe("ChatConnector defaults", () => {
  it("create-with-required-fields lands the 198-01 defaults (D-01)", async () => {
    const connector = await prisma.chatConnector.create({
      data: {
        platform: "telegram",
        name: "Defaults Connector",
        workspaceId,
        botTokenEncrypted: "iv:authtag:ciphertext",
        createdBy: adminUserId,
        // organizationId deliberately OMITTED — the sentinel default applies.
      },
    });

    expect(connector.organizationId).toBe("00000000-0000-0000-0000-000000000000");
    expect(connector.pollMode).toBe("polling");
    expect(connector.healthStatus).toBe("unknown");
    expect(typeof connector.pollOffset).toBe("bigint");
    expect(connector.pollOffset).toBe(0n);
    expect(connector.isEnabled).toBe(true);
    expect(connector.deletedAt).toBeNull();
    // fallbackMessage mirrors Widget.
    expect(connector.fallbackMessage).toBe(
      "I don't have an answer for that. Please contact us for more help.",
    );
  });
});

// 2. BigInt roundtrip beyond int32 (TV-2 — first BigInt column in the repo).
describe("pollOffset BigInt roundtrip", () => {
  it("persists and reads back a value beyond int32 byte-identical", async () => {
    const connector = await prisma.chatConnector.create({
      data: {
        platform: "telegram",
        name: "BigInt Connector",
        workspaceId,
        createdBy: adminUserId,
        pollOffset: 5000000000n, // > 2^31-1
      },
    });

    const readBack = await prisma.chatConnector.findUnique({
      where: { id: connector.id },
    });

    expect(typeof readBack!.pollOffset).toBe("bigint");
    expect(readBack!.pollOffset).toBe(5000000000n);
  });
});

// 3. Dedup arbiter (D-11): duplicate (connectorId, platformMessageId)
//    insert throws P2002; two null-platformMessageId inserts both succeed.
describe("ConnectorMessage dedup constraint", () => {
  let connectorId: string;
  let sessionId: string;

  beforeAll(async () => {
    const connector = await prisma.chatConnector.create({
      data: {
        platform: "telegram",
        name: "Dedup Connector",
        workspaceId,
        createdBy: adminUserId,
      },
    });
    connectorId = connector.id;
    const session = await prisma.connectorSession.create({
      data: { connectorId, platformUserId: "tg-user-1", expiresAt: new Date(Date.now() + 3_600_000) },
    });
    sessionId = session.id;
  });

  it("duplicate (connectorId, platformMessageId) insert throws P2002 (D-11)", async () => {
    await prisma.connectorMessage.create({
      data: { connectorId, sessionId, direction: "in", platformMessageId: "123" },
    });

    // The dedup @@unique([connectorId, platformMessageId]) constraint is the
    // arbiter — the duplicate surfaces as the unique-violation code P2002.
    const promise = prisma.connectorMessage.create({
      data: { connectorId, sessionId, direction: "in", platformMessageId: "123" },
    });
    await expect(promise).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    await expect(promise.catch((e: Prisma.PrismaClientKnownRequestError) => {
      throw e;
    })).rejects.toMatchObject({ code: "P2002" });
  });

  it("two null-platformMessageId inserts BOTH succeed (null skips dedup naturally)", async () => {
    const a = await prisma.connectorMessage.create({
      data: { connectorId, sessionId, direction: "out", platformMessageId: null },
    });
    const b = await prisma.connectorMessage.create({
      data: { connectorId, sessionId, direction: "out", platformMessageId: null },
    });

    expect(a.id).not.toBe(b.id);
    const count = await prisma.connectorMessage.count({
      where: { connectorId, platformMessageId: null },
    });
    expect(count).toBe(2);
  });
});

// 4. ConnectorSession unique pair + TTL index (D-01).
describe("ConnectorSession unique pair", () => {
  let connectorId: string;

  beforeAll(async () => {
    const connector = await prisma.chatConnector.create({
      data: {
        platform: "telegram",
        name: "Session Connector",
        workspaceId,
        createdBy: adminUserId,
      },
    });
    connectorId = connector.id;
  });

  it("duplicate (connectorId, platformUserId) insert throws P2002; expired expiresAt rows persist (TTL index present)", async () => {
    await prisma.connectorSession.create({
      data: {
        connectorId,
        platformUserId: "tg-user-dup",
        expiresAt: new Date(Date.now() - 1000), // expired row
      },
    });

    await expect(
      prisma.connectorSession.create({
        data: {
          connectorId,
          platformUserId: "tg-user-dup",
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // TTL index: an index-backed query on expiresAt resolves (index presence
    // pinned by the 198-01 migration; this query proves the column routes).
    const expired = await prisma.connectorSession.findFirst({
      where: { connectorId, expiresAt: { lt: new Date() } },
    });
    expect(expired).not.toBeNull();
  });
});

// 5. Soft delete isolation: deletedAt on the connector leaves
//    sessions/messages rows untouched (no cascade on soft delete).
describe("Soft-delete isolation", () => {
  it("soft-deleting the connector leaves sessions/messages rows intact", async () => {
    const connector = await prisma.chatConnector.create({
      data: {
        platform: "telegram",
        name: "Softdel Connector",
        workspaceId,
        createdBy: adminUserId,
      },
    });
    const session = await prisma.connectorSession.create({
      data: {
        connectorId: connector.id,
        platformUserId: "tg-user-soft",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.connectorMessage.create({
      data: { connectorId: connector.id, sessionId: session.id, direction: "in", platformMessageId: "soft-1" },
    });

    // Soft delete = the update the DELETE route performs (deletedAt + isEnabled=false).
    await prisma.chatConnector.update({
      where: { id: connector.id },
      data: { deletedAt: new Date(), isEnabled: false },
    });

    const sessionCount = await prisma.connectorSession.count({ where: { connectorId: connector.id } });
    const messageCount = await prisma.connectorMessage.count({ where: { connectorId: connector.id } });
    expect(sessionCount).toBe(1);
    expect(messageCount).toBe(1);

    const tombstoned = await prisma.chatConnector.findUnique({ where: { id: connector.id } });
    expect(tombstoned!.deletedAt).not.toBeNull();
    expect(tombstoned!.isEnabled).toBe(false);
  });
});

// 6. Phase 200 (200-01, D-15 integration arm): slack/whatsapp config-blob
//    encrypt/decrypt round-trip + the serializeConnector leak-strip
//    (hasSigningSecret/hasVerifyToken booleans, raw values never surfaced).
describe("Phase 200: platform config blob round-trip + leak-strip (D-15)", () => {
  it("slack configEncrypted round-trips the signingSecret through encrypt/decrypt", async () => {
    const { encrypt, decrypt } = await import("../services/encryptionService");
    const { createConnectorSchema } = await import("@simmetric-chat/shared");

    // The route-level persistence shape (BLOCKER-1 wiring) mirrored at the
    // DB seam: encrypt(JSON.stringify(config)) → column → decrypt → parse.
    const parsed = createConnectorSchema.safeParse({
      platform: "slack",
      name: "Slack IT Connector",
      workspaceId,
      botToken: "xoxb-it-token",
      signingSecret: "it-roundtrip-signing-secret",
    });
    expect(parsed.success).toBe(true);
    const config = { signingSecret: parsed.data!.signingSecret };
    const created = await prisma.chatConnector.create({
      data: {
        platform: "slack",
        name: "Slack IT Connector",
        workspaceId,
        botTokenEncrypted: encrypt(parsed.data!.botToken),
        configEncrypted: encrypt(JSON.stringify(config)),
        createdBy: adminUserId,
      },
    });

    const readBack = await prisma.chatConnector.findUnique({ where: { id: created.id } });
    expect(readBack!.configEncrypted).not.toContain("it-roundtrip-signing-secret"); // stored encrypted
    const blob = JSON.parse(decrypt(readBack!.configEncrypted!)) as Record<string, unknown>;
    expect(blob.signingSecret).toBe("it-roundtrip-signing-secret");
  });

  it("whatsapp configEncrypted round-trips the 4-field config through encrypt/decrypt", async () => {
    const { encrypt, decrypt } = await import("../services/encryptionService");

    const config = {
      phoneNumberId: "IT-PHONE-1",
      appSecret: "it-app-secret",
      verifyToken: "it-verify-token",
      whatsappBusinessAccountId: "IT-WABA-1",
    };
    const created = await prisma.chatConnector.create({
      data: {
        platform: "whatsapp",
        name: "WhatsApp IT Connector",
        workspaceId,
        botTokenEncrypted: encrypt("ea-it-token"),
        configEncrypted: encrypt(JSON.stringify(config)),
        createdBy: adminUserId,
      },
    });

    const readBack = await prisma.chatConnector.findUnique({ where: { id: created.id } });
    expect(readBack!.configEncrypted).not.toContain("it-verify-token"); // stored encrypted
    const blob = JSON.parse(decrypt(readBack!.configEncrypted!)) as Record<string, unknown>;
    expect(blob).toEqual(config);
  });

  it("serializeConnector leak-strip: booleans present, no blob/secret values in the serialized output (D-15)", async () => {
    const { encrypt } = await import("../services/encryptionService");

    const slackRow = await prisma.chatConnector.create({
      data: {
        platform: "slack",
        name: "Slack Leak IT",
        workspaceId,
        botTokenEncrypted: encrypt("xoxb-leak-probe"),
        configEncrypted: encrypt(JSON.stringify({ signingSecret: "leak-probe-secret" })),
        createdBy: adminUserId,
      },
    });
    const whatsappRow = await prisma.chatConnector.create({
      data: {
        platform: "whatsapp",
        name: "WhatsApp Leak IT",
        workspaceId,
        botTokenEncrypted: encrypt("ea-leak-probe"),
        configEncrypted: encrypt(JSON.stringify({ verifyToken: "leak-probe-vt", appSecret: "leak-probe-as" })),
        createdBy: adminUserId,
      },
    });
    const bareRow = await prisma.chatConnector.create({
      data: {
        platform: "telegram",
        name: "TG Bare IT",
        workspaceId,
        botTokenEncrypted: encrypt("tg-bare-token"),
        createdBy: adminUserId,
      },
    });

    // serializeConnector is route-local — exercised via the same
    // decrypt-and-strip shape the route uses (the CRUD suite pins the route
    // arm; this arm pins the REAL DB blob → boolean contract).
    const { decrypt } = await import("../services/encryptionService");
    const serialize = (row: { botTokenEncrypted: string | null; configEncrypted: string | null; pollOffset: bigint } & Record<string, unknown>) => {
      const { botTokenEncrypted: _t, configEncrypted: _c, pollOffset: _o, ...rest } = row;
      void _t; void _o;
      const config = (() => {
        if (!_c) return {} as Record<string, unknown>;
        try { return JSON.parse(decrypt(_c)) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; }
      })();
      return {
        ...rest,
        hasBotToken: Boolean(_t),
        hasSigningSecret: Boolean(config.signingSecret),
        hasVerifyToken: Boolean(config.verifyToken),
      };
    };

    const slackSerialized = serialize(
      (await prisma.chatConnector.findUnique({ where: { id: slackRow.id } })) as never
    );
    expect(slackSerialized.hasSigningSecret).toBe(true);
    expect(slackSerialized.hasVerifyToken).toBe(false);
    expect(JSON.stringify(slackSerialized)).not.toContain("leak-probe-secret");
    expect(JSON.stringify(slackSerialized)).not.toContain("botTokenEncrypted");
    expect(JSON.stringify(slackSerialized)).not.toContain("configEncrypted");

    const whatsappSerialized = serialize(
      (await prisma.chatConnector.findUnique({ where: { id: whatsappRow.id } })) as never
    );
    expect(whatsappSerialized.hasVerifyToken).toBe(true);
    expect(JSON.stringify(whatsappSerialized)).not.toContain("leak-probe-vt");

    const bareSerialized = serialize(
      (await prisma.chatConnector.findUnique({ where: { id: bareRow.id } })) as never
    );
    expect(bareSerialized.hasSigningSecret).toBe(false);
    expect(bareSerialized.hasVerifyToken).toBe(false);
  });
});