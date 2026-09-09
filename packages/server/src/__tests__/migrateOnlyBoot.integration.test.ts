// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Migrate-only boot invariants (Phase 182, SAAS-01a/01b).
 *
 * The jest integration globalSetup builds the template DB via `prisma migrate
 * deploy` and seeds it — the worker DB is a clone of that template. The
 * migrate-only assertions below prove the fresh-install letter of SAAS-01a:
 * the default-org row is INSERTed by migration M1 (NOT the seed), so it exists
 * on any DB that has only ever seen migrations. The seed adds users/roles AFTER
 * M1, and the assertions are written to be robust to both states:
 *
 *  - organizations must hold EXACTLY the default-org row (M1 idempotency +
 *    seed's verify-don't-insert discipline keep the count at 1).
 *  - organization_members coverage is asserted with >= users (M3 backfill
 *    covered users existing at migration time; users created by the seed AFTER
 *    M3 also appear — Pattern 3 membership inserts keep them covered; the
 *    >= form tolerates test-order users created by sibling suites).
 *
 * Probes pinned here (182-PLAN-02 must_haves):
 *  - SAAS-01a: default org exists after migrate-only; idempotent re-run.
 *  - SAAS-01b: zero NULL organizationId across the 27 migrated tables
 *    (25 community + backup_destinations strict; system_config strict
 *    NULL-or-default-org with >= 1 NULL global row).
 *  - M4 SET DEFAULT: a create() without organizationId succeeds.
 *  - T-182-06b: multi-role user yields exactly ONE membership row on M3
 *    replay (DISTINCT ON dedupe proven, not assumed).
 *  - TS-04: users_username_key / users_email_key untouched.
 *  - Phase 183 M5 (fulfilled the 182 deferral): system_config carries the
 *    composite (organizationId, key) unique + the P1 partial unique; the
 *    scalar key index is gone (pin inverted in-phase by 183-05).
 */

import { DEFAULT_ORG_ID } from "@simmetric-chat/shared";

let prisma: import("@prisma/client").PrismaClient;

/** The 26 promise-list tables + backup_destinations = 27 migrated tables. */
const MIGRATED_TABLES = [
  "projects",
  "workspaces",
  "workspace_access",
  "project_access",
  "providers",
  "provider_models",
  "archives",
  "widgets",
  "widget_workspaces",
  "workspace_templates",
  "dlp_patterns",
  "webhooks",
  "workspace_token_usage",
  "api_keys",
  "workspace_agent_configs",
  "chats",
  "chat_folders",
  "chat_messages",
  "documents",
  "upload_drafts",
  "ocr_jobs",
  "archive_import_jobs",
  "synthesis_runs",
  "mcp_connections",
  "push_subscriptions",
  "backup_destinations",
] as const;

/** The M3 membership INSERT, replayable verbatim (NOT EXISTS guard = idempotent). */
const M3_MEMBERSHIP_INSERT = `
INSERT INTO "organization_members" ("id", "organizationId", "userId", "roleInOrg", "joinedAt")
SELECT
  gen_random_uuid(),
  $1,
  candidates.uid,
  CASE WHEN candidates.rname = 'admin' THEN 'admin' ELSE 'member' END,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (u."id") u."id" AS uid, r."name" AS rname
  FROM "users" u
  LEFT JOIN "user_roles" ur ON ur."userId" = u."id"
  LEFT JOIN "roles" r ON r."id" = ur."roleId"
  ORDER BY u."id", (r."name" = 'admin') DESC
) candidates
WHERE NOT EXISTS (
  SELECT 1 FROM "organization_members" om
  WHERE om."userId" = candidates.uid
    AND om."organizationId" = $1
)`;

/** The M1 default-org INSERT, replayable verbatim (ON CONFLICT DO NOTHING). */
const M1_ORG_INSERT = `
INSERT INTO "organizations" ("id","name","slug","plan","updatedAt")
VALUES ($1, 'Default', 'default', 'free', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING`;

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("migrate-only boot invariants (Phase 182 SAAS-01a/01b)", () => {
  test("SAAS-01a: organizations holds exactly the default-org row (M1 INSERT, seed-independent)", async () => {
    const orgs = await prisma.$queryRaw<
      Array<{ id: string; slug: string; plan: string }>
    >`SELECT id, slug, plan FROM organizations`;
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.id).toBe(DEFAULT_ORG_ID);
    expect(orgs[0]?.slug).toBe("default");
    expect(orgs[0]?.plan).toBe("free");
  });

  test("SAAS-01a idempotency: re-running the M1 INSERT leaves organizations at exactly 1", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).$executeRawUnsafe(M1_ORG_INSERT, DEFAULT_ORG_ID);
    const count = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM organizations`;
    expect(Number(count[0]?.count ?? -1)).toBe(1);
  });

  test("SAAS-01b completeness: zero NULL organizationId across the 27 migrated tables; system_config strict NULL-or-default", async () => {
    for (const table of MIGRATED_TABLES) {
      // Table names come from the fixed const above (not user input).
      const rows: Array<{ count: bigint }> = await (prisma as any).$queryRawUnsafe(
        `SELECT count(*)::bigint AS count FROM "${table}" WHERE "organizationId" IS NULL`,
      );
      expect(Number(rows[0]?.count ?? -1)).toBe(0);
    }

    // system_config — Tier A′ global-row substrate: rows stay NULL-org by
    // design (M3 never backfilled, M4 never defaulted). Strict semantics:
    // every row is NULL-org or default-org, nothing else; and at least the
    // seeded global config rows are NULL-org (the no-backfill decision).
    const bad = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM system_config
      WHERE "organizationId" IS NOT NULL AND "organizationId" <> ${DEFAULT_ORG_ID}`;
    expect(Number(bad[0]?.count ?? -1)).toBe(0);
    const nullRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM system_config WHERE "organizationId" IS NULL`;
    expect(Number(nullRows[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  test("SAAS-01b default-fill: a project create WITHOUT organizationId succeeds via the M4 column default", async () => {
    const user = await prisma.user.create({
      data: {
        username: `mbo_user_${Date.now()}`,
        email: `mbo_user_${Date.now()}@test.local`,
        passwordHash: "x",
        salt: "x",
      },
    });
    try {
      const project = await prisma.project.create({
        data: { name: `mbo_project_${Date.now()}`, createdBy: user.id },
      });
      expect(project.organizationId).toBe(DEFAULT_ORG_ID);
      await prisma.project.delete({ where: { id: project.id } });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("M3 membership: replaying the M3 INSERT closes coverage to >= users (idempotent full backfill)", async () => {
    // On a fresh migrate→seed DB the seed users are created AFTER M3 ran, so
    // at this point members < users (Plan 03 adds per-create membership
    // inserts). The invariant that holds on ANY DB state: replaying the M3
    // membership INSERT verbatim (NOT EXISTS guard = idempotent) backfills
    // every user and closes the gap to >= users count. On a DB where all
    // users predate M3 the replay is a no-op and the assertion still holds.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).$executeRawUnsafe(M3_MEMBERSHIP_INSERT, DEFAULT_ORG_ID);
    const members = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM organization_members om
      JOIN users u ON u.id = om."userId"
      WHERE om."organizationId" = ${DEFAULT_ORG_ID}`;
    const users = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM users`;
    expect(Number(members[0]?.count ?? -1)).toBeGreaterThanOrEqual(
      Number(users[0]?.count ?? 0),
    );
  });

  test("T-182-06b: multi-role user + M3 replay yields EXACTLY ONE membership row (DISTINCT ON dedupe)", async () => {
    const user = await prisma.user.create({
      data: {
        username: `mbo_multi_${Date.now()}`,
        email: `mbo_multi_${Date.now()}@test.local`,
        passwordHash: "x",
        salt: "x",
      },
    });
    try {
      // Two distinct non-admin roles (the admin role may or may not be
      // resolvable; two distinct non-admin roles exercise the same 1:N
      // fan-out the dedupe guards against).
      const roleA = await prisma.role.create({
        data: { name: `mbo_role_a_${Date.now()}` },
      });
      const roleB = await prisma.role.create({
        data: { name: `mbo_role_b_${Date.now()}` },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleA.id } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleB.id } });

      // Replay the M3 membership INSERT verbatim — safe on the NOT EXISTS
      // guard, and the fan-out would abort on the composite unique without
      // the DISTINCT ON dedupe.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$executeRawUnsafe(M3_MEMBERSHIP_INSERT, DEFAULT_ORG_ID);

      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM organization_members
        WHERE "userId" = ${user.id} AND "organizationId" = ${DEFAULT_ORG_ID}`;
      expect(Number(rows[0]?.count ?? 0)).toBe(1);
    } finally {
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$executeRaw`DELETE FROM roles WHERE name LIKE 'mbo_role_%'`;
    }
  });

  test("TS-04: users_username_key and users_email_key remain (global uniqueness intact)", async () => {
    // Prisma @unique emits unique INDEXES (not pg constraints) — check
    // pg_indexes where the names actually live (verified empirically).
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'users'`;
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("users_username_key");
    expect(names).toContain("users_email_key");
  });

  test("Phase 183 M5 fulfilled: composite (organizationId, key) + P1 partial unique replace the scalar key unique", async () => {
    // This probe was written during Phase 182-02 as the deferral echo of
    // 182-PLAN-02 must-have 7 ("the scalar `key @unique` survives; the
    // composite arrives in Phase 183"). Phase 183-03 deployed M5 — the
    // deferral is FULFILLED and the pin is inverted to the adopted geometry:
    //   - composite unique index system_config_organizationId_key_key (M5)
    //   - partial unique index system_config_key_key_null_org (M5, P1 ADOPT)
    //   - the scalar system_config_key_key index GONE
    // (tenantSchema.test.ts pins the same geometry at the schema level.)
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'system_config'`;
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("system_config_organizationId_key_key");
    expect(names).toContain("system_config_key_key_null_org");
    expect(names).not.toContain("system_config_key_key");
  });
});