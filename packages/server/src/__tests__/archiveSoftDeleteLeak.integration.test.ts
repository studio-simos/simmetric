// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KB-02 / D-09 integration tests — prove no soft-delete leak across archive read paths.
 *
 * Scenarios:
 *   1. Archive tombstoned (deletedAt set) + page active (deletedAt null):
 *      search must return zero hits (raw SQL JOIN on archives.deletedAt filters the page).
 *   2. Archive active + page tombstoned (deletedAt set):
 *      search must return zero hits (existing ap."deletedAt" IS NULL filter).
 *   3. Raw SQL source contains the JOIN on archives.deletedAt (cascata logica).
 *   4. GET /api/archives/:archiveId on a soft-deleted archive returns 404 (archiveIndex no leak).
 *
 * File extension is `.integration.test.ts` to be picked up by jest.config.integration.js
 * (deviation from PLAN.md which named it `.test.ts` — Rule 1: match test infrastructure).
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import fs from "fs";
import path from "path";
import { Prisma } from "@prisma/client";

// Phase 151 (RAG-01): the multi-config fragment is imported dynamically in
// beforeAll — a top-level import would transitively load the prisma singleton
// (via ftsService.ts) BEFORE jest.setup.integration.ts sets the worker
// DATABASE_URL, pinning the client to the wrong database.
let MULTI_CONFIG_TSVECTOR: string;

let app: ReturnType<typeof import("../index").createApp>;
let prisma: import("@prisma/client").PrismaClient;
let env: import("../config/env").Env;

let adminUserId: string;
let tombstonedArchiveId: string;
let activeArchiveId: string;
const adminPassword = "archive-admin-pw-7K";

beforeAll(async () => {
  const { createApp } = await import("../index");
  app = createApp();

  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;

  const { getEnv } = await import("../config/env");
  env = getEnv();

  await prisma.$connect();

  // Phase 151 (RAG-01): load the fragment AFTER the worker DB URL is set.
  ({ MULTI_CONFIG_TSVECTOR } = await import("../services/ftsService"));

  // Seed admin user + admin role (role is seeded by prisma db seed in globalSetup)
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const salt = await bcrypt.genSalt(12);
  const admin = await prisma.user.create({
    data: {
      username: "kb02_admin",
      email: "kb02_admin@test.local",
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

  // Seed tombstoned archive
  const tombstoned = await prisma.archive.create({
    data: {
      slug: "kb02-tombstoned-archive",
      name: "KB02 Tombstoned Archive",
      description: "Tombstoned archive fixture",
      createdBy: adminUserId,
      deletedAt: new Date(),
    },
  });
  tombstonedArchiveId = tombstoned.id;

  // Seed active archive
  const active = await prisma.archive.create({
    data: {
      slug: "kb02-active-archive",
      name: "KB02 Active Archive",
      description: "Active archive fixture",
      createdBy: adminUserId,
    },
  });
  activeArchiveId = active.id;

  // Insert archive_pages with searchVector + searchVectorMulti populated via raw
  // SQL (the service layer does not populate searchVector; we bypass it to make
  // the FTS query meaningful). Phase 151 (RAG-01): the archive search route now
  // reads searchVectorMulti — fixtures must populate it or the control test
  // (Test 2b) fails and Tests 1/2 pass vacuously.
  // Page P1: tombstoned archive, page itself NOT tombstoned, unique searchable body.
  await prisma.$executeRaw`
    INSERT INTO "archive_pages"
      ("id", "archiveId", "slug", "title", "category", "bodyText", "contentHash", "createdBy", "searchVector", "searchVectorMulti", "createdAt", "updatedAt")
    VALUES (
      ${crypto.randomUUID()},
      ${tombstonedArchiveId},
      ${"leaky-page-in-tombstoned-archive"},
      ${"Leaky Page"},
      ${"notes"},
      ${"KB02_UNIQUE_TOMBSTONED_ARCHIVE_PAGE_BODY"},
      ${"hash-p1"},
      ${adminUserId},
      to_tsvector('simple', ${"KB02_UNIQUE_TOMBSTONED_ARCHIVE_PAGE_BODY"}),
      (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)} FROM (SELECT ${"KB02_UNIQUE_TOMBSTONED_ARCHIVE_PAGE_BODY"}::text AS t) AS t),
      NOW(),
      NOW()
    )
  `;

  // Page P2: active archive, page itself IS tombstoned, unique searchable body.
  await prisma.$executeRaw`
    INSERT INTO "archive_pages"
      ("id", "archiveId", "slug", "title", "category", "bodyText", "contentHash", "createdBy", "searchVector", "searchVectorMulti", "deletedAt", "createdAt", "updatedAt")
    VALUES (
      ${crypto.randomUUID()},
      ${activeArchiveId},
      ${"tombstoned-page-in-active-archive"},
      ${"Tombstoned Page"},
      ${"notes"},
      ${"KB02_UNIQUE_TOMBSTONED_PAGE_BODY"},
      ${"hash-p2"},
      ${adminUserId},
      to_tsvector('simple', ${"KB02_UNIQUE_TOMBSTONED_PAGE_BODY"}),
      (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)} FROM (SELECT ${"KB02_UNIQUE_TOMBSTONED_PAGE_BODY"}::text AS t) AS t),
      NOW(),
      NOW(),
      NOW()
    )
  `;

  // Page P3: active archive, page active — control. Search for its term must return 1 hit.
  await prisma.$executeRaw`
    INSERT INTO "archive_pages"
      ("id", "archiveId", "slug", "title", "category", "bodyText", "contentHash", "createdBy", "searchVector", "searchVectorMulti", "createdAt", "updatedAt")
    VALUES (
      ${crypto.randomUUID()},
      ${activeArchiveId},
      ${"active-page-control"},
      ${"Active Page Control"},
      ${"notes"},
      ${"KB02_UNIQUE_ACTIVE_CONTROL_BODY"},
      ${"hash-p3"},
      ${adminUserId},
      to_tsvector('simple', ${"KB02_UNIQUE_ACTIVE_CONTROL_BODY"}),
      (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)} FROM (SELECT ${"KB02_UNIQUE_ACTIVE_CONTROL_BODY"}::text AS t) AS t),
      NOW(),
      NOW()
    )
  `;
});

afterAll(async () => {
  // Clean up fixtures (raw DELETE because some pages have searchVector/tsvector)
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "archive_pages" WHERE "archiveId" IN ($1, $2)`,
      tombstonedArchiveId,
      activeArchiveId,
    );
  } catch {
    /* best-effort */
  }
  try {
    await prisma.archive.deleteMany({ where: { id: { in: [tombstonedArchiveId, activeArchiveId] } } });
  } catch {
    /* best-effort — soft-deleted archives still match deleteMany */
  }
  try {
    await prisma.user.delete({ where: { id: adminUserId } });
  } catch {
    /* best-effort */
  }
  await prisma.$disconnect();
});

function generateToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: "1h" });
}

function adminAuth(): Record<string, string> {
  return { Authorization: `Bearer ${generateToken(adminUserId)}` };
}

// ─── Test 1: tombstoned archive's page must not leak via search ──────

describe("KB-02 soft-delete leak prevention", () => {
  it("Test 1: search on a tombstoned archive returns zero hits (JOIN archives.deletedAt)", async () => {
    const res = await request(app)
      .get(`/api/archives/${tombstonedArchiveId}/search`)
      .set(adminAuth())
      .query({ query: "KB02_UNIQUE_TOMBSTONED_ARCHIVE_PAGE_BODY" });

    // Search route returns 200 with an array (it does NOT 404 on tombstoned archive —
    // it goes straight to raw SQL). The JOIN must filter out the page.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
    // Defense: the unique term must not appear anywhere in the response body
    expect(JSON.stringify(res.body)).not.toContain("KB02_UNIQUE_TOMBSTONED_ARCHIVE_PAGE_BODY");
  });

  it("Test 2: search for a tombstoned page's term in an active archive returns zero hits", async () => {
    const res = await request(app)
      .get(`/api/archives/${activeArchiveId}/search`)
      .set(adminAuth())
      .query({ query: "KB02_UNIQUE_TOMBSTONED_PAGE_BODY" });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it("Test 2b (control): search for the active control page's term returns 1 hit", async () => {
    // Proves the search itself works — without this, Tests 1/2 passing could be a false
    // negative (e.g. searchVector not populated, sanitization dropping the term).
    const res = await request(app)
      .get(`/api/archives/${activeArchiveId}/search`)
      .set(adminAuth())
      .query({ query: "KB02_UNIQUE_ACTIVE_CONTROL_BODY" });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].title).toBe("Active Page Control");
  });

  it("Test 3: archiveSearch.ts raw SQL contains JOIN archives a with deletedAt IS NULL", () => {
    const sourcePath = path.resolve(__dirname, "../routes/archiveSearch.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).toContain(
      'JOIN "archives" a ON a."id" = ap."archiveId" AND a."deletedAt" IS NULL',
    );
  });

  it("Test 4: GET /api/archives/:archiveId on a soft-deleted archive returns 404", async () => {
    const res = await request(app)
      .get(`/api/archives/${tombstonedArchiveId}`)
      .set(adminAuth());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Archive not found");
  });
});