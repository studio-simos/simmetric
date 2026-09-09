// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Membership backfill + per-create membership behavior (Phase 182, D-01/D-04/D-05).
 *
 * Proves the ensureDefaultOrgMembership contract on a real Postgres worker DB
 * (cloned from the migrate+seed template by the jest integration globalSetup):
 *
 *  1. D-01 completeness: a user created AFTER the M3 migration window gets a
 *     default-org membership at creation time; double-call is idempotent
 *     (exactly ONE live row — no duplicate).
 *  2. Tombstone resurrect (D-04 removal + D-05 either-branch): soft-deleting
 *     the membership row then re-adding the same user succeeds — the row is
 *     live again (deletedAt null), still exactly one row for the pair.
 *  3. P2002 race tolerance: two concurrent helper calls both resolve and
 *     exactly one live row exists (the TOCTOU catch path).
 *  4. roleInOrg validation: invalid values rejected fail-loud naming
 *     owner|admin|member (V5); enum members accepted.
 *  5. Global invariant: zero users without default-org membership on the
 *     template DB (M3 backfill + per-create inserts cover every user).
 *  6. Seed verify-only semantics: the seed's org check never mutates
 *     organizations (still exactly one DEFAULT_ORG_ID row — M1-owned).
 *
 * RUN: `pnpm --filter server exec jest --config jest.config.integration.js --testPathPatterns=membershipBackfill`
 * DB-less environments: beforeAll fails LOUDLY on an unreachable DB
 * (WR-02/G-182-05 — rethrowing the probe error marks the suite failed with the
 * connectivity explanation instead of a silent green passed-and-empty run;
 * matches the pre-G-182-04 fail semantics). A collection-time describe.skip
 * cannot work here: the probe is async, so the skip decision is only known
 * inside beforeAll.
 */

import { DEFAULT_ORG_ID } from "@simmetric-chat/shared";

let prisma: import("@prisma/client").PrismaClient;

let dbAvailable = true;

/** Test-local user rows created by this suite (deleted in afterAll; membership cascades per FK). */
const createdUserIds: string[] = [];

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function createTestUser(prefix: string): Promise<import("@prisma/client").User> {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      username: `mb_${prefix}_${suffix}`,
      email: `mb_${prefix}_${suffix}@test.local`,
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
    // zero assertions (the per-test early-returns alone report passed-and-
    // empty — invisible to jest's reporter). Fail loud instead: rethrowing
    // from beforeAll marks every test in the suite failed with this
    // explanation, matching the pre-G-182-04 semantics.
    dbAvailable = false;
    console.error(
      "[membershipBackfill.integration] DB unavailable — FAILING suite:",
      (err as Error).message,
    );
    throw err;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  try {
    // User deletion cascades organization_members per FK (onDelete: Cascade).
    for (const id of createdUserIds) {
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  } finally {
    await prisma.$disconnect();
  }
});

// WR-04/G-182-04 historical note: the skip decision is NOT known at module-load
// time (beforeAll's probe is async — the old `dbAvailable ? describe :
// describe.skip` was evaluated while dbAvailable was still its initial true,
// i.e. dead code: with Postgres down the tests ran against an undefined prisma
// binding and FAILED with TypeError instead of skipping). G-182-04 replaced
// that with unconditional describe + per-test early-return; WR-02/G-182-05
// closes its reporting gap by failing loudly in beforeAll when the probe
// fails (see header + beforeAll), so the per-test early-returns only matter
// for the impossible "beforeAll passed but dbAvailable=false" state and as a
// defensive no-op.
describe("membership backfill + per-create membership (Phase 182 D-01/D-04/D-05)", () => {
  test("D-01 completeness: post-M3 user gets membership; double-call idempotent (exactly ONE live row)", async () => {
    if (!dbAvailable) return;
    const { ensureDefaultOrgMembership } = await import("../services/organizationService");

    const user = await createTestUser("complete");
    await ensureDefaultOrgMembership(prisma, user.id, "member");

    let rows = await prisma.organizationMember.findMany({
      where: { userId: user.id, organizationId: DEFAULT_ORG_ID, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.roleInOrg).toBe("member");
    expect(rows[0]?.deletedAt).toBeNull();

    // Idempotency probe (SAAS-01a): same args again → no duplicate, no crash.
    await ensureDefaultOrgMembership(prisma, user.id, "member");
    rows = await prisma.organizationMember.findMany({
      where: { userId: user.id, organizationId: DEFAULT_ORG_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  test("tombstone resurrect (D-04 + D-05): soft-deleted membership re-adds cleanly, still exactly one row", async () => {
    if (!dbAvailable) return;
    const { ensureDefaultOrgMembership } = await import("../services/organizationService");

    const user = await createTestUser("tombstone");
    await ensureDefaultOrgMembership(prisma, user.id, "member");

    // Soft-delete the membership row (D-04 removal policy).
    const live = await prisma.organizationMember.findFirst({
      where: { userId: user.id, organizationId: DEFAULT_ORG_ID, deletedAt: null },
    });
    expect(live).not.toBeNull();
    await prisma.organizationMember.update({
      where: { id: live!.id },
      data: { deletedAt: new Date() },
    });

    // Re-add the same user — the tombstone must not block reuse.
    await ensureDefaultOrgMembership(prisma, user.id, "member");

    const rows = await prisma.organizationMember.findMany({
      where: { userId: user.id, organizationId: DEFAULT_ORG_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();

    // WR-02/G-182-02: resurrect honors the CALLER's roleInOrg — removal
    // downgrades, re-add is the re-grant moment. The tombstoned row held
    // "member"; re-adding as "admin" must come back with roleInOrg "admin".
    await prisma.organizationMember.update({
      where: { id: rows[0]!.id },
      data: { deletedAt: new Date() },
    });
    await ensureDefaultOrgMembership(prisma, user.id, "admin");
    const regranted = await prisma.organizationMember.findMany({
      where: { userId: user.id, organizationId: DEFAULT_ORG_ID },
    });
    expect(regranted).toHaveLength(1);
    expect(regranted[0]?.deletedAt).toBeNull();
    expect(regranted[0]?.roleInOrg).toBe("admin");
  });

  test("P2002 race tolerance: concurrent double-call resolves, exactly one live row (TOCTOU catch path)", async () => {
    if (!dbAvailable) return;
    const { ensureDefaultOrgMembership } = await import("../services/organizationService");

    const user = await createTestUser("race");
    await Promise.all([
      ensureDefaultOrgMembership(prisma, user.id, "member"),
      ensureDefaultOrgMembership(prisma, user.id, "member"),
    ]);

    const rows = await prisma.organizationMember.findMany({
      where: { userId: user.id, organizationId: DEFAULT_ORG_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  test("roleInOrg validation (V5): invalid value rejected naming owner|admin|member; enum values accepted", async () => {
    if (!dbAvailable) return;
    const { ensureDefaultOrgMembership } = await import("../services/organizationService");

    const user = await createTestUser("roleval");
    await expect(
      ensureDefaultOrgMembership(prisma, user.id, "root" as never),
    ).rejects.toThrow(/owner \| admin \| member/);

    // "owner" accepted at schema level only — no Phase 182 path auto-assigns
    // owner to the default org (owner assignment is Phase 185 provisioning,
    // research Open Question 1). Assert the helper accepts it.
    await ensureDefaultOrgMembership(prisma, user.id, "owner");
    const rows = await prisma.organizationMember.findMany({
      where: { userId: user.id, organizationId: DEFAULT_ORG_ID, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.roleInOrg).toBe("owner");
  });

  test("global invariant (M3 + per-create): ZERO users without default-org membership on the template DB", async () => {
    if (!dbAvailable) return;
    // M3 ran in globalSetup (migrate deploy) and covered users existing at
    // migration time; Plan 03's per-create inserts cover users created after.
    // Together, no membership-less user can exist.
    const orphans = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om."userId" = u.id AND om."organizationId" = ${DEFAULT_ORG_ID}::text
      )`;
    expect(Number(orphans[0]?.count ?? -1)).toBe(0);
  });

  test("seed verify-only semantics: the default-org row count stays exactly 1 (M1-owned, seed never inserts)", async () => {
    if (!dbAvailable) return;
    const orgs = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM organizations WHERE id = ${DEFAULT_ORG_ID}::text`;
    expect(Number(orgs[0]?.count ?? -1)).toBe(1);
  });
});