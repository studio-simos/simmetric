// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Settings integration tests — runs against a real PostgreSQL database.
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

  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const userRole = await prisma.role.findUnique({ where: { name: "user" } });

  const salt = await bcrypt.genSalt(12);

  const admin = await prisma.user.create({
    data: {
      username: "settings_admin",
      email: "settings_admin@test.com",
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
      username: "settings_user",
      email: "settings_user@test.com",
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

// ─── GET /api/system/settings ───────────────────────────────────────

describe("GET /api/system/settings", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/system/settings");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    const token = generateToken(regularUserId);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns settings array for admin user", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("key");
    expect(res.body[0]).toHaveProperty("value");
    expect(res.body[0]).toHaveProperty("readOnly");
  });
});

// ─── PUT /api/system/settings ───────────────────────────────────────

describe("PUT /api/system/settings", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).put("/api/system/settings").send({});
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid body", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: "not-an-array" });

    expect(res.status).toBe(400);
  });

  it("updates settings and returns updated/rejected lists", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "LLM_TEMPERATURE", value: "0.9" }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("updated");
    expect(res.body).toHaveProperty("rejected");
    expect(res.body.updated.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects readOnly settings in the rejected list", async () => {
    const token = generateToken(adminUserId);
    const res = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        configs: [
          { key: "JWT_SECRET", value: "should-not-change" },
          { key: "LLM_MODEL", value: "new-model" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.rejected.length).toBeGreaterThanOrEqual(1);
    // JWT_SECRET should be rejected because it's ALWAYS_READONLY
    expect(res.body.rejected).toContain("JWT_SECRET");
  });
});

// ─── SC-4: ALLOW_NON_ADMIN_UPLOAD no-restart flip ─────────────────────────
//
// Phase 70 — Plan 70-02 Task 1. The toggle flip via PUT /api/system/settings
// must take effect on the next getSetting() call WITHOUT a server restart
// (systemConfigService uses DB > ENV > Default with no in-memory cache).
// This test runs against the real worker DB so it exercises the actual
// Prisma round-trip. It flips the value to "false", reads it back via the
// settings route (same process, same supertest app), then restores "true"
// in teardown.

// NOTE: do NOT statically `import { getSetting } from "../services/systemConfigService"`
// at module top-level. systemConfigService transitively imports `../utils/prisma`, whose
// singleton constructs its PrismaClient adapter via `getEnv().DATABASE_URL` at first import.
// A static top-level import runs at test-file LOAD time — BEFORE `jest.setup.integration.ts`'s
// `beforeAll` sets `process.env.DATABASE_URL` to the per-file worker DB — so the singleton (and
// the `getEnv()` cache) locks onto the shell-inherited main DB URL and every subsequent
// `await import("../utils/prisma")` returns that same main-DB singleton. The test then writes
// to the main `simmetricchat` dev DB instead of its worker clone (unique-constraint collisions on
// re-run, and dev-DB pollution). Importing dynamically INSIDE the `it` block (after the worker
// URL is set) defers singleton construction until the worker URL is active. This rule applies
// to ANY integration test: avoid static top-level imports of modules that transitively load the
// Prisma singleton (services/, routes/, agent/, ../index) — use dynamic `await import(...)` in
// `beforeAll`/`it` instead.

describe("ALLOW_NON_ADMIN_UPLOAD no-restart flip (SC-4)", () => {
  afterAll(async () => {
    // Teardown: restore the seeded default so other test files see "true".
    const token = generateToken(adminUserId);
    await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "ALLOW_NON_ADMIN_UPLOAD", value: "true" }] });
  });

  it("PUT /api/system/settings flips ALLOW_NON_ADMIN_UPLOAD without restart", async () => {
    const token = generateToken(adminUserId);

    // Flip to "false".
    const putRes = await request(app)
      .put("/api/system/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ configs: [{ key: "ALLOW_NON_ADMIN_UPLOAD", value: "false" }] });

    expect(putRes.status).toBe(200);
    expect(putRes.body.updated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "ALLOW_NON_ADMIN_UPLOAD", value: "false" }),
      ]),
    );
    expect(putRes.body.rejected).not.toContain("ALLOW_NON_ADMIN_UPLOAD");

    // Read the value back directly from systemConfigService (same process,
    // no restart). getSetting queries the DB fresh every call (no cache).
    // Dynamic import (see file-head comment): defers Prisma-singleton
    // construction until after the worker DATABASE_URL is set.
    const { getSetting } = await import("../services/systemConfigService");
    const setting = await getSetting("ALLOW_NON_ADMIN_UPLOAD");
    expect(setting.value).toBe("false");
    expect(setting.readOnly).toBe(false);

    // Also verify the value is reflected via the GET /api/system/settings
    // route (the admin UI's read path).
    const getRes = await request(app)
      .get("/api/system/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    const toggleEntry = getRes.body.find(
      (s: { key: string; value: string }) => s.key === "ALLOW_NON_ADMIN_UPLOAD",
    );
    expect(toggleEntry).toBeDefined();
    expect(toggleEntry.value).toBe("false");
  });
});
