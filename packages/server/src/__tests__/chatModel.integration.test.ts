// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Chat model selection integration tests — runs against a real PostgreSQL database.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";

let app: ReturnType<typeof import("../index").createApp>;
let prisma: import("@prisma/client").PrismaClient;
let env: import("../config/env").Env;

let adminUserId: string;
let workspaceId: string;
let chatId: string;
let providerId: string;
const adminPassword = "adminpassword123";

beforeAll(async () => {
  const { createApp } = await import("../index");
  app = createApp();

  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;

  const { getEnv } = await import("../config/env");
  env = getEnv();

  await prisma.$connect();

  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });

  const salt = await bcrypt.genSalt(12);

  const admin = await prisma.user.create({
    data: {
      username: "chatmodel_admin",
      email: "chatmodel_admin@test.com",
      passwordHash: await bcrypt.hash(adminPassword, salt),
      salt,
    },
  });
  adminUserId = admin.id;

  if (adminRole) {
    await prisma.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id },
    });
  }

  // Create a workspace for the chat
  const project = await prisma.project.create({
    data: {
      name: "Chat Model Test Project",
      description: "Test project",
      createdBy: adminUserId,
    },
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: "Chat Model Test Workspace",
      projectId: project.id,
    },
  });
  workspaceId = workspace.id;

  // Create a provider
  const provider = await prisma.provider.create({
    data: {
      name: "OpenAI Test",
      type: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      isDefault: false,
    },
  });
  providerId = provider.id;

  // Create a chat
  const chat = await prisma.chat.create({
    data: {
      workspaceId,
      name: "Test Chat",
    },
  });
  chatId = chat.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function generateToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: "1h" });
}

function adminAuth(): Record<string, string> {
  return { Authorization: `Bearer ${generateToken(adminUserId)}` };
}

// ─── PATCH /api/workspaces/:workspaceId/chats/:chatId/model ─────────

describe("PATCH /api/workspaces/:workspaceId/chats/:chatId/model", () => {
  it("updates chat with a specific provider and model", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/chats/${chatId}/model`)
      .set(adminAuth())
      .send({ providerId, model: "gpt-4" });

    expect(res.status).toBe(200);
    expect(res.body.providerId).toBe(providerId);
    expect(res.body.model).toBe("gpt-4");
  });

  it("clears the provider override by setting providerId to null", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/chats/${chatId}/model`)
      .set(adminAuth())
      .send({ providerId: null });

    expect(res.status).toBe(200);
    expect(res.body.providerId).toBeNull();
  });

  it("updates only the model without changing providerId", async () => {
    // First set providerId
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/chats/${chatId}/model`)
      .set(adminAuth())
      .send({ providerId, model: "gpt-4" });

    // Then update only model
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/chats/${chatId}/model`)
      .set(adminAuth())
      .send({ model: "gpt-4o" });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("gpt-4o");
  });

  it("returns 404 when chat does not exist", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/chats/550e8400-e29b-41d4-a716-446655440999/model`)
      .set(adminAuth())
      .send({ providerId, model: "gpt-4" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Chat not found");
  });

  it("returns 401 without authentication", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/chats/${chatId}/model`)
      .send({ providerId, model: "gpt-4" });

    expect(res.status).toBe(401);
  });

  it("rejects invalid providerId format (not UUID)", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/chats/${chatId}/model`)
      .set(adminAuth())
      .send({ providerId: "not-a-uuid", model: "gpt-4" });

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/workspaces/:workspaceId/chats ─────────────────────────

describe("GET /api/workspaces/:workspaceId/chats", () => {
  it("returns chats including providerId and model fields", async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/chats`)
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty("id");
    expect(res.body[0]).toHaveProperty("name");
  });
});
