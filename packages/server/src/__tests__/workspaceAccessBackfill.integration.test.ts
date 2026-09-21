// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-01/02, D-24/D-12): real-PG proof of the wsis migration
 * batch — column shapes, the assignedVia implicit backfill (LDAP §3.3), the
 * grantedBy legacy-marker invariant, and the migration-SQL order pin.
 *
 * The D-12 editor backfill itself is only observable against a DB that
 * predates the role column (the template DB is freshly migrated — no legacy
 * rows exist at migration time), so the artifact is pinned instead: the
 * migration SQL is regex-checked for ADD-before-UPDATE order, the grantedBy
 * nullable-no-default shape, and zero row-removal statements. The live-DB
 * legacy spot-check (3 rows → role='editor', grantedBy NULL on the dev DB)
 * is documented in the plan summary.
 *
 * RUN: `pnpm --filter server test:integration -- src/__tests__/workspaceAccessBackfill.integration.test.ts`
 * DB-less environments: beforeAll fails LOUDLY on an unreachable DB
 * (WR-02/G-182-05 discipline — never green-empty).
 */

import fs from "node:fs";
import path from "node:path";

let prisma: import("@prisma/client").PrismaClient;

let dbAvailable = true;

/** Test-local user rows created by this suite (deleted in afterAll; FK cascades clean up user_roles). */
const createdUserIds: string[] = [];

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function createTestUser(prefix: string): Promise<import("@prisma/client").User> {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      username: `wsis_${prefix}_${suffix}`,
      email: `wsis_${prefix}_${suffix}@test.local`,
      passwordHash: "x",
      salt: "x",
    },
  });
  createdUserIds.push(user.id);
  return user;
}

beforeAll(async () => {
  try {
    const { default: prismaClient } = await import("../utils/prisma");
    prisma = prismaClient;
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // WR-02/G-182-05: a DB outage must NOT surface as a green suite that ran
    // zero assertions. Fail loud instead: rethrowing from beforeAll marks
    // every test in the suite failed with this explanation.
    dbAvailable = false;
    console.error(
      "[workspaceAccessBackfill.integration] DB unavailable — FAILING suite:",
      (err as Error).message,
    );
    throw err;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  try {
    // User deletion cascades user_roles per FK (onDelete: Cascade). Role rows
    // are seeded shared fixtures — never delete them; the created user_role
    // row cascades with the user.
    for (const id of createdUserIds) {
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  } finally {
    await prisma.$disconnect();
  }
});

describe("wsis migration batch on real Postgres (Phase 189 D-24/D-12)", () => {
  test("schema shape: all five columns exist with the exact defaults/nullabilities (information_schema probes)", async () => {
    if (!dbAvailable) return;
    const cols = await prisma.$queryRaw<
      Array<{ column_name: string; column_default: string | null; is_nullable: string }>
    >`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name IN ('workspace_access', 'user_roles', 'users', 'projects')
        AND column_name IN ('role', 'grantedBy', 'hasOnboarded', 'isPersonal', 'assignedVia')`;

    const byName = new Map(cols.map((c) => [c.column_name, c]));

    // workspace_access.role — NOT NULL DEFAULT 'viewer'
    expect(byName.get("role")).toBeDefined();
    expect(byName.get("role")!.is_nullable).toBe("NO");
    expect(byName.get("role")!.column_default).toContain("'viewer'");

    // workspace_access.grantedBy — nullable, NO default (legacy-marker shape)
    expect(byName.get("grantedBy")).toBeDefined();
    expect(byName.get("grantedBy")!.is_nullable).toBe("YES");
    expect(byName.get("grantedBy")!.column_default).toBeNull();

    // users.hasOnboarded / projects.isPersonal — NOT NULL DEFAULT false
    expect(byName.get("hasOnboarded")).toBeDefined();
    expect(byName.get("hasOnboarded")!.is_nullable).toBe("NO");
    expect(byName.get("hasOnboarded")!.column_default).toBe("false");
    expect(byName.get("isPersonal")).toBeDefined();
    expect(byName.get("isPersonal")!.is_nullable).toBe("NO");
    expect(byName.get("isPersonal")!.column_default).toBe("false");

    // user_roles.assignedVia — NOT NULL DEFAULT 'manual' (LDAP §3.3)
    expect(byName.get("assignedVia")).toBeDefined();
    expect(byName.get("assignedVia")!.is_nullable).toBe("NO");
    expect(byName.get("assignedVia")!.column_default).toContain("'manual'");
  });

  test("assignedVia implicit backfill pin: a user_role row inserted WITHOUT assignedVia round-trips as 'manual' (LDAP §3.3, D-24)", async () => {
    if (!dbAvailable) return;
    const user = await createTestUser("assignedvia");
    // Template DB seeds only admin/user roles — create a dedicated fixture
    // role so the probe owns its FK chain (cascaded away with the user).
    const role = await prisma.role.create({
      data: { name: `wsis_role_${uniqueSuffix()}` },
    });
    await prisma.$executeRaw`
      INSERT INTO user_roles ("userId", "roleId") VALUES (${user.id}::text, ${role.id}::text)`;
    const rows = await prisma.$queryRaw<Array<{ assignedVia: string }>>`
      SELECT "assignedVia" FROM user_roles WHERE "userId" = ${user.id}::text AND "roleId" = ${role.id}::text`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assignedVia).toBe("manual");
  });

  test("grantedBy legacy-marker invariant: a workspace_access row inserted WITHOUT grantedBy round-trips NULL (D-12)", async () => {
    if (!dbAvailable) return;
    const user = await createTestUser("grantedby");
    // The template DB carries no workspaces — build the minimal FK chain
    // (project → workspace) owned by this suite, then clean it up explicitly.
    const project = await prisma.project.create({
      data: { name: `wsis_proj_${uniqueSuffix()}`, createdBy: user.id },
    });
    const workspace = await prisma.workspace.create({
      data: { projectId: project.id, name: `wsis_ws_${uniqueSuffix()}` },
    });
    await prisma.$executeRaw`
      INSERT INTO workspace_access ("userId", "workspaceId", "role")
      VALUES (${user.id}::text, ${workspace.id}::text, 'editor')`;
    const rows = await prisma.$queryRaw<Array<{ grantedBy: string | null }>>`
      SELECT "grantedBy" FROM workspace_access WHERE "userId" = ${user.id}::text AND "workspaceId" = ${workspace.id}::text`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grantedBy).toBeNull();
    // Explicit cleanup (workspace_access has no FK cascade from user via
    // workspaceId; delete in reverse-FK order).
    await prisma.$executeRaw`
      DELETE FROM workspace_access WHERE "userId" = ${user.id}::text AND "workspaceId" = ${workspace.id}::text`;
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.project.delete({ where: { id: project.id } });
  });

  test("migration-SQL order pin: ADD COLUMN role BEFORE UPDATE SET role='editor'; grantedBy added WITHOUT default; zero row-removal statements (D-12 — the backfill is only observable pre-migration, so the artifact is pinned)", async () => {
    if (!dbAvailable) return;
    const migrationsDir = path.resolve(__dirname, "../../prisma/migrations");
    const wsisDir = fs
      .readdirSync(migrationsDir)
      .filter((d) => d.includes("wsis"))
      .sort()
      .at(-1);
    expect(wsisDir).toBeDefined();
    const sql = fs.readFileSync(path.join(migrationsDir, wsisDir!, "migration.sql"), "utf8");

    const addIdx = sql.indexOf('ADD COLUMN "role" TEXT NOT NULL DEFAULT ');
    const updateIdx = sql.indexOf('SET "role" = ');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(addIdx);

    // grantedBy: nullable ADD without a DEFAULT clause on the same statement
    const grantedByMatch = sql.match(/ALTER TABLE "workspace_access" ADD COLUMN "grantedBy" TEXT(?! DEFAULT)/);
    expect(grantedByMatch).not.toBeNull();

    // Additive-only: zero INSERT INTO / DROP / DELETE FROM statements
    expect(sql).not.toMatch(/INSERT INTO/);
    expect(sql).not.toMatch(/DROP /);
    expect(sql).not.toMatch(/DELETE FROM/);
  });
});