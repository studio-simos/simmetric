// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TDD behavior tests for the refactored seed.ts (Task 2, Phase 138).
 *
 * Verifies that seedRbac() creates + invokes the seed_rbac() SQL procedure
 * via prisma.$executeRaw, that main() calls seedRbac() instead of the old
 * per-permission upsert loop, and that the permission list in the procedure
 * body matches PERMISSION_NAMES.length (36 after the Phase 192 dlp:unmask
 * row) from @simmetric-chat/shared, and the user-role grant list mirrors
 * DEFAULT_USER_ROLE.permissions (15 after WR-04's skill:delete grant).
 *
 * The DB is fully mocked — no live Postgres required. We mock @prisma/client
 * so the module-level `new PrismaClient()` in seed.ts returns a mock.
 */
import "./helpers/setupEnv";

jest.mock("@prisma/adapter-pg", () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({ end: jest.fn() })),
}));

// Create the mock prisma instance INSIDE the jest.mock factory so jest can
// hoist it. The factory runs before imports.
jest.mock("@prisma/client", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    PrismaClient: jest.fn().mockImplementation(() => createMockPrisma().prisma),
  };
});

import { PERMISSION_NAMES, DEFAULT_ROLES } from "@simmetric-chat/shared";
import { seedRbac, main } from "../../prisma/seed";

// The prisma instance created by seed.ts when the module loaded. Because we
// mocked @prisma/client, `new PrismaClient()` returned a createMockPrisma()
// instance. We reach it via the module's internal reference. Since seed.ts
// doesn't export it, we re-import the mocked @prisma/client to get the same
// instance that was constructed. The mock factory's createMockPrisma() is
// called once per `new PrismaClient()` call — seed.ts calls it once at module
// load, so there is exactly one instance. We grab it by requiring the module
// again and inspecting the mock constructor's last result.
const { PrismaClient } = require("@prisma/client");
const mockPrisma = (PrismaClient as jest.Mock).mock.results[0]?.value;

// Capture all $executeRaw + $executeRawUnsafe calls so we can inspect the SQL.
function captureExecuteRaw(): string[] {
  const calls: string[] = [];
  (mockPrisma.$executeRaw as jest.Mock).mockImplementation((sql: unknown) => {
    if (Array.isArray(sql)) {
      calls.push((sql as unknown as string[]).join("$__param"));
    } else {
      calls.push(String(sql));
    }
    return Promise.resolve(1);
  });
  (mockPrisma.$executeRawUnsafe as jest.Mock).mockImplementation((sql: unknown) => {
    calls.push(String(sql));
    return Promise.resolve(1);
  });
  return calls;
}

describe("seedRbac", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("Test 1: creates the seed_rbac() procedure via prisma.$executeRaw and invokes SELECT seed_rbac()", async () => {
    const calls = captureExecuteRaw();
    await seedRbac();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    const allSql = calls.join("\n");
    expect(allSql).toContain("CREATE OR REPLACE FUNCTION seed_rbac()");
    expect(allSql).toContain("SELECT seed_rbac()");
  });

  it("Test 2: procedure body contains ON CONFLICT (name) DO NOTHING for idempotent permission inserts", async () => {
    const calls = captureExecuteRaw();
    await seedRbac();
    const allSql = calls.join("\n");
    expect(allSql).toContain('INSERT INTO "permissions"');
    expect(allSql).toContain('ON CONFLICT ("name") DO NOTHING');
  });

  it("Test 3: procedure body contains ON CONFLICT for idempotent role inserts", async () => {
    const calls = captureExecuteRaw();
    await seedRbac();
    const allSql = calls.join("\n");
    expect(allSql).toContain('INSERT INTO "roles"');
    expect(allSql).toContain('ON CONFLICT ("name") DO NOTHING');
    expect(allSql).toContain('INSERT INTO "role_permissions"');
    expect(allSql).toContain('ON CONFLICT ("roleId", "permissionName") DO NOTHING');
  });

  it("Test 4: the number of INSERT INTO \"permissions\" value tuples matches PERMISSION_NAMES.length (41, runtime-derived)", async () => {
    const calls = captureExecuteRaw();
    await seedRbac();
    const allSql = calls.join("\n");
    const permissionNames: string[] = [...PERMISSION_NAMES];
    for (const name of permissionNames) {
      expect(allSql).toContain(name);
    }
    // Phase 198 (ECCO-01 D-04): 37 → 39 with connector:manage + connector:view.
    // Phase 202 (PLGM-05 D-08): 39 → 40 with plugins:manage.
    // Phase 206 (AGENCY-03 D-07): 40 → 41 with agency:users:manage.
    expect(permissionNames.length).toBe(41);
  });

  it("Test 5: the admin role is linked to all 41 permissions, the user role to 15 (11 base + 4 Phase 190 skill grants — WR-04 includes skill:delete, DEFAULT_USER_ROLE.permissions length; Phase 192 dlp:unmask, Phase 195 mcp:oauth:manage, Phase 198 connector:manage/connector:view and Phase 202 plugins:manage stay admin-only)", async () => {
    const calls = captureExecuteRaw();
    await seedRbac();
    const allSql = calls.join("\n");
    expect(allSql).toMatch(/admin/);
    expect(allSql).toMatch(/user/);
    const userPerms = [
      "workspace:read", "chat:read", "chat:write", "document:read",
      "document:write", "archive:read", "provider:read", "project:create",
      "workspace:create", "memory:read", "memory:write",
      // Phase 190 skill grants (WR-04: delete rides the user role).
      "skill:create", "skill:read", "skill:write", "skill:delete",
    ];
    for (const p of userPerms) {
      expect(allSql).toContain(p);
    }
    expect(userPerms.length).toBe(15);
    // The elevated dlp:unmask grant (Phase 192), the mcp:oauth:manage grant
    // (Phase 195) and the connector:manage/connector:view grants (Phase 198)
    // ride the ADMIN role only: they appear in the seed SQL and are NOT part
    // of DEFAULT_USER_ROLE (D-04 — DEFAULT_USER_ROLE gains neither connector
    // permission). The connector grants must appear in the permission-INSERT
    // block but NOT in the user-role grant list (mirrors the dlp:unmask pin).
    expect(allSql).toContain("dlp:unmask");
    expect(allSql).toContain("mcp:oauth:manage");
    expect(allSql).toContain("connector:manage");
    expect(allSql).toContain("connector:view");
    const userGrantBlock = allSql.slice(allSql.indexOf('WHERE "name" IN'));
    expect(userGrantBlock).not.toContain("connector:manage");
    expect(userGrantBlock).not.toContain("connector:view");
    const userRole = DEFAULT_ROLES.find((r) => r.name === "user");
    expect(userRole?.permissions).toHaveLength(15);
    expect(userRole?.permissions).toContain("skill:delete");
    expect(userRole?.permissions).not.toContain("dlp:unmask");
    expect(userRole?.permissions).not.toContain("mcp:oauth:manage");
    expect(userRole?.permissions).not.toContain("connector:manage");
    expect(userRole?.permissions).not.toContain("connector:view");
  });
});

describe("main", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("Test 6: main() calls seedRbac() (the new SQL-procedure path) and does NOT call the old per-permission seedPermissions loop", async () => {
    // Mock all the seed functions that main() calls so it runs without error.
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockPrisma.$executeRawUnsafe as jest.Mock).mockResolvedValue(1);
    (mockPrisma.permission.upsert as jest.Mock).mockResolvedValue(undefined);
    (mockPrisma.role.upsert as jest.Mock).mockResolvedValue({ id: "role-1" });
    (mockPrisma.rolePermission.upsert as jest.Mock).mockResolvedValue(undefined);
    (mockPrisma.roleMenuSection.upsert as jest.Mock).mockResolvedValue(undefined);
    (mockPrisma.mcpCatalogEntry.upsert as jest.Mock).mockResolvedValue(undefined);
    (mockPrisma.providerPreset.upsert as jest.Mock).mockResolvedValue(undefined);
    // Phase 183 (SAAS-02): seed.ts's config loop writes via the inline
    // find-first shape — wire the findFirst/create delegates (existing rows
    // return undefined here, so the loop attempts creates).
    (mockPrisma.systemConfig.findFirst as jest.Mock).mockResolvedValue(undefined);
    (mockPrisma.systemConfig.create as jest.Mock).mockResolvedValue(undefined);
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: "existing" });
    (mockPrisma.user.create as jest.Mock).mockResolvedValue({ id: "u-1" });
    (mockPrisma.userRole.create as jest.Mock).mockResolvedValue(undefined);
    (mockPrisma.role.findUnique as jest.Mock).mockResolvedValue({ id: "role-admin" });

    await main();

    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    expect(mockPrisma.permission.upsert).not.toHaveBeenCalled();
  });
});
