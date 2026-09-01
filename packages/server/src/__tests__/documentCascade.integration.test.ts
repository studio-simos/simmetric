// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Document cascade soft-delete integration tests (D-07, D-08).
 *
 * Runs against a real PostgreSQL database (jest.config.integration.js).
 * Verifies that soft-deleting a document hard-deletes its document_chunks
 * rows (D-07) and that vectorCleanupAt is left null (pending collector
 * purge — the collector is not available in the test environment).
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";

let app: ReturnType<typeof import("../index").createApp>;
let prisma: import("@prisma/client").PrismaClient;
let env: import("../config/env").Env;

let adminUserId: string;
let workspaceId: string;
let documentId: string;
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
      username: "cascade_admin",
      email: "cascade_admin@test.com",
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

  const project = await prisma.project.create({
    data: {
      name: "Cascade Test Project",
      description: "Test project for document cascade",
      createdBy: adminUserId,
    },
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: "Cascade Test Workspace",
      projectId: project.id,
    },
  });
  workspaceId = workspace.id;

  // Create a document with 2 chunk rows
  const doc = await prisma.document.create({
    data: {
      workspaceId,
      name: "cascade-test.pdf",
      type: "pdf",
      filePath: "/tmp/cascade-test.pdf",
      cacheKey: "cascade-test-cache-key",
      chunkCount: 2,
      status: "completed",
    },
  });
  documentId = doc.id;

  await prisma.documentChunk.createMany({
    data: [
      {
        documentId,
        chunkText: "chunk 1 text",
        metadata: JSON.stringify({ pageNumber: 1 }),
        embeddingId: "emb-1",
      },
      {
        documentId,
        chunkText: "chunk 2 text",
        metadata: JSON.stringify({ pageNumber: 2 }),
        embeddingId: "emb-2",
      },
    ],
  });
});

afterAll(async () => {
  // Clean up: hard-delete the test data (document is soft-deleted in the test)
  try {
    await prisma.documentChunk.deleteMany({ where: { documentId } });
    await prisma.document.deleteMany({ where: { id: documentId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    const projects = await prisma.project.findMany({
      where: { createdBy: adminUserId },
    });
    for (const p of projects) {
      await prisma.projectAccess.deleteMany({ where: { projectId: p.id } });
      await prisma.project.deleteMany({ where: { id: p.id } });
    }
    await prisma.userRole.deleteMany({ where: { userId: adminUserId } });
    await prisma.user.deleteMany({ where: { id: adminUserId } });
  } catch {
    // Best-effort cleanup
  }
  await prisma.$disconnect();
});

function generateToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: "1h" });
}

function adminAuth(): Record<string, string> {
  return { Authorization: `Bearer ${generateToken(adminUserId)}` };
}

// ─── DELETE /api/documents/:documentId — cascade hard-delete (D-07) ────

describe("DELETE /api/documents/:documentId — cascade (D-07, D-08)", () => {
  it("cascades chunk delete", async () => {
    // Verify chunks exist before delete
    const chunksBefore = await prisma.documentChunk.findMany({
      where: { documentId },
    });
    expect(chunksBefore).toHaveLength(2);

    const res = await request(app)
      .delete(`/api/documents/${documentId}`)
      .set(adminAuth());

    expect(res.status).toBe(200);

    // D-07: chunk rows are hard-deleted (not just soft-deleted)
    const chunksAfter = await prisma.documentChunk.findMany({
      where: { documentId },
    });
    expect(chunksAfter).toHaveLength(0);

    // Document is soft-deleted (deletedAt set)
    const doc = await prisma.document.findFirst({
      where: { id: documentId },
    });
    expect(doc).not.toBeNull();
    expect(doc!.deletedAt).not.toBeNull();
  });

  it("marks vectorCleanupAt pending", async () => {
    // After the DELETE above, vectorCleanupAt should be null (pending).
    // The collector is not available in the test environment, so the
    // fire-and-forget fetch will fail and vectorCleanupAt stays null.
    const doc = await prisma.document.findFirst({
      where: { id: documentId },
    });
    expect(doc).not.toBeNull();
    expect(doc!.vectorCleanupAt).toBeNull();
  });
});