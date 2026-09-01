// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive integration tests — runs against a real PostgreSQL database.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";

let app: ReturnType<typeof import("../index").createApp>;
let prisma: import("@prisma/client").PrismaClient;
let env: import("../config/env").Env;

let adminUserId: string;
let archiveId: string;
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
      username: "archive_admin",
      email: "archive_admin@test.com",
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

// ─── GET /api/archives ──────────────────────────────────────────────

describe("GET /api/archives", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/archives");
    expect(res.status).toBe(401);
  });

  it("returns list of non-deleted archives", async () => {
    const res = await request(app).get("/api/archives").set(adminAuth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── POST /api/archives ─────────────────────────────────────────────

describe("POST /api/archives", () => {
  it("creates archive and returns 201", async () => {
    const res = await request(app)
      .post("/api/archives")
      .set(adminAuth())
      .send({
        name: "ACME Corp Wiki",
        description: "Knowledge base for ACME Corporation",
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body.name).toBe("ACME Corp Wiki");
    expect(res.body.slug).toBe("acme-corp-wiki");
    archiveId = res.body.id;
  });

  it("returns 400 with empty name", async () => {
    const res = await request(app)
      .post("/api/archives")
      .set(adminAuth())
      .send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid request body");
  });
});

// ─── GET /api/archives/:archiveId ───────────────────────────────────

describe("GET /api/archives/:archiveId", () => {
  it("returns archive by ID", async () => {
    const res = await request(app)
      .get(`/api/archives/${archiveId}`)
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(archiveId);
    expect(res.body.name).toBe("ACME Corp Wiki");
  });

  it("returns 400 for invalid UUID", async () => {
    const res = await request(app)
      .get("/api/archives/not-a-uuid")
      .set(adminAuth());
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent archive", async () => {
    const res = await request(app)
      .get("/api/archives/550e8400-e29b-41d4-a716-446655440999")
      .set(adminAuth());
    expect(res.status).toBe(404);
  });
});

// ─── PUT /api/archives/:archiveId ───────────────────────────────────

describe("PUT /api/archives/:archiveId", () => {
  it("updates archive name and returns updated archive", async () => {
    const res = await request(app)
      .put(`/api/archives/${archiveId}`)
      .set(adminAuth())
      .send({ name: "ACME Corp Updated" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("ACME Corp Updated");
    expect(res.body.slug).toBe("acme-corp-wiki"); // slug unchanged
  });

  it("returns 400 with empty name", async () => {
    const res = await request(app)
      .put(`/api/archives/${archiveId}`)
      .set(adminAuth())
      .send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid request body");
  });
});

// ─── DELETE /api/archives/:archiveId ────────────────────────────────

describe("DELETE /api/archives/:archiveId", () => {
  it("soft-deletes archive and returns 200", async () => {
    const res = await request(app)
      .delete(`/api/archives/${archiveId}`)
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("deleted");
  });

  it("returns 404 for subsequent GET after delete", async () => {
    const res = await request(app)
      .get(`/api/archives/${archiveId}`)
      .set(adminAuth());
    expect(res.status).toBe(404);
  });
});
