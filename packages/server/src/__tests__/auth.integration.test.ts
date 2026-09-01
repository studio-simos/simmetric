// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Auth integration tests — runs against a real PostgreSQL database.
 *
 * Replaces auth.test.ts unit tests with integration tests that exercise
 * real bcrypt, JWT, Prisma, and RBAC middleware against the actual DB.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";

let app: ReturnType<typeof import("../index").createApp>;
let prisma: import("@prisma/client").PrismaClient;
let env: import("../config/env").Env;

let adminUserId: string;
let regularUserId: string;
const adminPassword = "adminpassword123";
const regularPassword = "userpassword123";

beforeAll(async () => {
  const { createApp } = await import("../index");
  app = createApp();

  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;

  const { getEnv } = await import("../config/env");
  env = getEnv();

  await prisma.$connect();

  // Seed real users with bcrypt-hashed passwords
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const userRole = await prisma.role.findUnique({ where: { name: "user" } });

  const salt = await bcrypt.genSalt(12);

  const admin = await prisma.user.create({
    data: {
      username: "integration_admin",
      email: "integration_admin@test.com",
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

  const regular = await prisma.user.create({
    data: {
      username: "integration_user",
      email: "integration_user@test.com",
      passwordHash: await bcrypt.hash(regularPassword, salt),
      salt,
    },
  });
  regularUserId = regular.id;

  if (userRole) {
    await prisma.userRole.create({
      data: { userId: regular.id, roleId: userRole.id },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

function generateToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: "1h" });
}

// ─── authMiddleware ───────────────────────────────────────────────

describe("authMiddleware", () => {
  it("returns 401 when no authorization header", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 on malformed header", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "InvalidFormat");
    expect(res.status).toBe(401);
  });

  it("returns 401 on expired token", async () => {
    const expiredToken = jwt.sign(
      { userId: adminUserId },
      env.JWT_SECRET,
      { expiresIn: "0s" }
    );
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });

  it("returns 401 on invalid token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer invalid.token.here");
    expect(res.status).toBe(401);
  });

  it("returns 401 when user not found", async () => {
    const token = jwt.sign({ userId: "nonexistent-user-id" }, env.JWT_SECRET, {
      expiresIn: "1h",
    });
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("succeeds with valid token and existing user", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("integration_admin");
  });
});

// ─── POST /api/auth/login ─────────────────────────────────────────

describe("POST /api/auth/login", () => {
  it("returns 401 for non-existent user", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "ghost", password: "secret123" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
  });

  it("returns 401 for wrong password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "integration_user", password: "wrongpassword" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with token for valid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "integration_admin", password: adminPassword });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(res.body.user.username).toBe("integration_admin");
  });
});

// ─── GET /api/auth/users ──────────────────────────────────────────

describe("GET /api/auth/users", () => {
  it("returns 403 for non-admin user", async () => {
    const token = generateToken(regularUserId);
    const res = await request(app)
      .get("/api/auth/users")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 200 for admin user", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .get("/api/auth/users")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2); // admin + regular
  });
});

// ─── GET /api/health ──────────────────────────────────────────────

describe("GET /api/health", () => {
  it("returns ok status", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
