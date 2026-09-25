// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 199 (199-04, ECCO-05 §7.9-1 / D-10) — chat-list connector-platform
 * badge unit pins. Wave 0 gap from 199-VALIDATION.md.
 *
 * Postgres-free (prisma mocked per the chatRetention.route.test.ts minimal-app
 * convention): supertest against a minimal Express app mounting ONLY the
 * chatList router with mocked middleware, so the D-10 include extension +
 * nullable connectorPlatform mapping are pinned at the route surface.
 *
 * Pins:
 *  (a) a chat WITH one connectorSession (connector platform "discord")
 *      serializes connectorPlatform === "discord";
 *  (b) a chat with NO connectorSessions serializes connectorPlatform === null
 *      (remaining fields ride unchanged — isPinned/messageCount);
 *  (c) the findMany call carries the extended include (the D-10 join shape
 *      pinned at the call surface);
 *  (d) a "telegram" connector chat serializes "telegram" (the map's other
 *      live platform);
 *  (e) a session row whose connector lost its FK (connector null — the
 *      schema's onDelete: Cascade removes the session with the connector, so
 *      a null connector is a defensive-only shape) serializes null, not a
 *      crash.
 */

import "./helpers/setupEnv";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    chat: {
      findMany: jest.fn(),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));
const mockPrisma = require("../utils/prisma").default;

jest.mock("../middleware/auth", () => ({
  authMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock("../middleware/tenantContext", () => ({
  tenantContextMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock("../middleware/rbac", () => ({
  requireWorkspaceAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import chatListRoutes from "../routes/chatList";

const WS_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const USER_ID = "user-199-04";

function buildApp() {
  const app = express();
  app.use(express.json());
  // The route reads req.userId! for the pins include — seed it the way
  // authMiddleware would.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { userId: string }).userId = USER_ID;
    next();
  });
  app.use("/api/workspaces", chatListRoutes);
  return app;
}

const baseChat = {
  id: "chat-1",
  name: "Support chat",
  workspaceId: WS_ID,
  updatedAt: new Date("2026-09-23T09:00:00Z"),
  createdAt: new Date("2026-09-23T08:00:00Z"),
  _count: { messages: 3 },
  pins: [],
};

describe("GET /api/workspaces/:workspaceId/chats — connectorPlatform badge (D-10)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.chat.findMany as jest.Mock).mockReset();
  });

  it("(c) the findMany include carries connectorSessions.connector.platform (the zero-migration join)", async () => {
    (mockPrisma.chat.findMany as jest.Mock).mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get(`/api/workspaces/${WS_ID}/chats`);

    expect(res.status).toBe(200);
    expect(mockPrisma.chat.findMany).toHaveBeenCalledTimes(1);
    const arg = (mockPrisma.chat.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: WS_ID, deletedAt: null });
    expect(arg.include).toEqual(
      expect.objectContaining({
        _count: { select: { messages: true } },
        pins: expect.objectContaining({ where: { userId: USER_ID } }),
        connectorSessions: {
          include: { connector: { select: { platform: true } } },
        },
      }),
    );
  });

  it("(a) a chat with one connectorSession serializes connectorPlatform 'discord'", async () => {
    (mockPrisma.chat.findMany as jest.Mock).mockResolvedValue([
      {
        ...baseChat,
        connectorSessions: [{ connector: { platform: "discord" } }],
      },
    ]);

    const app = buildApp();
    const res = await request(app).get(`/api/workspaces/${WS_ID}/chats`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].connectorPlatform).toBe("discord");
  });

  it("(d) a telegram connector chat serializes connectorPlatform 'telegram'", async () => {
    (mockPrisma.chat.findMany as jest.Mock).mockResolvedValue([
      {
        ...baseChat,
        connectorSessions: [{ connector: { platform: "telegram" } }],
      },
    ]);

    const app = buildApp();
    const res = await request(app).get(`/api/workspaces/${WS_ID}/chats`);

    expect(res.status).toBe(200);
    expect(res.body[0].connectorPlatform).toBe("telegram");
  });

  it("(b) a plain chat (no connectorSessions) serializes connectorPlatform null with the other fields riding unchanged", async () => {
    (mockPrisma.chat.findMany as jest.Mock).mockResolvedValue([
      { ...baseChat, pins: [{ userId: USER_ID }] },
    ]);

    const app = buildApp();
    const res = await request(app).get(`/api/workspaces/${WS_ID}/chats`);

    expect(res.status).toBe(200);
    const row = res.body[0];
    expect(row.connectorPlatform).toBeNull();
    // (d) the remaining response fields ride unchanged — isPinned,
    // messageCount, identity, timestamps.
    expect(row.isPinned).toBe(true);
    expect(row.messageCount).toBe(3);
    expect(row.id).toBe("chat-1");
    expect(row.name).toBe("Support chat");
    expect(row.workspaceId).toBe(WS_ID);
  });

  it("(e) a connectorSession with a null connector (defensive shape) serializes null — no crash", async () => {
    (mockPrisma.chat.findMany as jest.Mock).mockResolvedValue([
      {
        ...baseChat,
        connectorSessions: [{ connector: null }],
      },
    ]);

    const app = buildApp();
    const res = await request(app).get(`/api/workspaces/${WS_ID}/chats`);

    expect(res.status).toBe(200);
    expect(res.body[0].connectorPlatform).toBeNull();
  });
});