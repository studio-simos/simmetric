// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SystemConfig composite-unique write behavior (Phase 183, SAAS-02 D-08 swap).
 *
 * Proves the M5 constraint geometry on a real Postgres worker DB (cloned from
 * the migrate+seed template by the jest integration globalSetup — the template
 * already carries the swapped geometry):
 *
 *  1. Global-row uniqueness (Pitfall P1 checkpoint verdict: ADOPT partial
 *     unique): a second helper call for the same global key UPDATES via the
 *     find-first arm (exactly one row); a RAW direct create of a duplicate
 *     global (NULL, key) row is rejected with P2002 by the partial unique
 *     `system_config_key_key_null_org` — the helper's race backstop restored
 *     at the DB level. (Had the checkpoint DECLINED, this probe would instead
 *     document the app-level-only TOCTOU window — the conditional is encoded
 *     as executable documentation of the adopted geometry.)
 *  2. Org-row coexistence: org-a + org-b + a global row for the SAME key all
 *     coexist (the composite is NULLs-distinct, the partial does not touch
 *     org rows); findFirst({ key, organizationId: orgA }) returns org-a's
 *     value; a raw duplicate (org-a, key) create is rejected with P2002 by
 *     the composite unique.
 *  3. Race tolerance end-to-end: two concurrent upsertSystemConfigRow calls
 *     for the SAME fresh global key both resolve (the loser's P2002 catch
 *     re-checks and returns the winner), exactly one row survives, and its
 *     value is one of the two written (no duplicate, no unhandled rejection).
 *  4. Cleanup: deleteMany by non-unique key filter stays legal post-swap.
 *
 * RUN: `pnpm --filter @simmetric-chat/shared build && pnpm --filter server exec
 * jest --config jest.config.integration.js --testPathPatterns=systemConfigCompositeWrite`
 * (integration runs need DATABASE_URL at localhost:5432 — the docker Postgres;
 * `host.docker.internal` does not resolve on dev hosts, see Phase 183-02 note).
 *
 * Dynamic-import doctrine (settings.integration.test.ts file-head comment):
 * NO static top-level imports of prisma-transitive modules — the Prisma
 * singleton must construct AFTER jest.setup.integration.ts sets the worker
 * DATABASE_URL in beforeAll. `await import(...)` only.
 */

let prisma: import("@prisma/client").PrismaClient;

let dbAvailable = true;

/** Test-local rows created by this suite (deleted in afterAll). */
const testKeys: string[] = [];
const createdOrgIds: string[] = [];

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function freshTestKey(prefix: string): string {
  const key = `test_composite_${prefix}_${uniqueSuffix()}`;
  testKeys.push(key);
  return key;
}

async function createTestOrg(prefix: string): Promise<import("@prisma/client").Organization> {
  const suffix = uniqueSuffix();
  const org = await prisma.organization.create({
    data: {
      name: `m5_${prefix}_${suffix}`,
      slug: `m5-${prefix}-${suffix}`,
    },
  });
  createdOrgIds.push(org.id);
  return org;
}

beforeAll(async () => {
  try {
    const { default: prismaClient } = await import("../utils/prisma");
    prisma = prismaClient;
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // WR-02/G-182-05: a DB outage must NOT surface as a green suite that ran
    // zero assertions — fail loud (rethrow marks every test failed).
    dbAvailable = false;
    console.error(
      "[systemConfigCompositeWrite.integration] DB unavailable — FAILING suite:",
      (err as Error).message,
    );
    throw err;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  try {
    // Probe 4: deleteMany by non-unique filter stays legal post-swap (unique
    // inputs only constrain findUnique/upsert-style where clauses).
    // Config rows FIRST — systemConfig.organizationId FK is onDelete: Restrict,
    // so the org rows below can only be removed once their config rows are gone.
    await prisma.systemConfig.deleteMany({ where: { key: { in: testKeys } } });
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
  } finally {
    await prisma.$disconnect();
  }
});

/** Extract the Prisma known-request error code (P2002 etc.) from a rejection. */
function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

describe("SystemConfig composite-unique write geometry (Phase 183 SAAS-02, M5)", () => {
  test("global-row uniqueness (P1 ADOPT): helper second call updates via find-first; raw duplicate global create rejected with P2002", async () => {
    if (!dbAvailable) return;
    const { upsertSystemConfigRow } = await import("../services/systemConfigService");

    const key = freshTestKey("global");

    // First helper call: fresh create of the global row.
    const first = await upsertSystemConfigRow(prisma, { key, value: "v1" });
    expect(first.organizationId).toBeNull();
    expect(first.value).toBe("v1");

    // Second helper call: find-first HITS → id-anchored update (no duplicate).
    const second = await upsertSystemConfigRow(prisma, { key, value: "v2" });
    expect(second.id).toBe(first.id);
    expect(second.value).toBe("v2");

    const rows = await prisma.systemConfig.findMany({ where: { key } });
    expect(rows).toHaveLength(1);

    // RAW direct-insert probe: a duplicate (NULL, key) row must be rejected by
    // the PARTIAL unique index (system_config_key_key_null_org) — the DB-level
    // race backstop the Task-1 checkpoint ADOPTED. (With a DECLINE verdict this
    // create would succeed and the window would be app-level-only — the suite
    // name is the executable documentation of the adopted geometry.)
    let rejectionCode: string | undefined;
    try {
      await prisma.systemConfig.create({
        data: { key, value: "x", organizationId: null },
      });
    } catch (err) {
      rejectionCode = errorCode(err);
    }
    expect(rejectionCode).toBe("P2002");

    // The rejected insert left no residue.
    const rowsAfter = await prisma.systemConfig.findMany({ where: { key } });
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]?.value).toBe("v2");
  });

  test("org-row coexistence (composite): org-a + org-b + global coexist for one key; duplicate org-row create raises P2002", async () => {
    if (!dbAvailable) return;
    const { upsertSystemConfigRow } = await import("../services/systemConfigService");

    const key = freshTestKey("coexist");
    const orgA = await createTestOrg("a");
    const orgB = await createTestOrg("b");

    // Three coexisting rows for the SAME key: global, org-a, org-b.
    const globalRow = await upsertSystemConfigRow(prisma, { key, value: "global" });
    const orgARow = await upsertSystemConfigRow(prisma, {
      key,
      value: "org-a",
      organizationId: orgA.id,
    });
    const orgBRow = await upsertSystemConfigRow(prisma, {
      key,
      value: "org-b",
      organizationId: orgB.id,
    });

    expect(globalRow.organizationId).toBeNull();
    expect(orgARow.organizationId).toBe(orgA.id);
    expect(orgBRow.organizationId).toBe(orgB.id);

    const rows = await prisma.systemConfig.findMany({ where: { key } });
    expect(rows).toHaveLength(3);

    // Per-org read returns the org's own value (no bleed).
    const readA = await prisma.systemConfig.findFirst({
      where: { key, organizationId: orgA.id },
    });
    expect(readA?.value).toBe("org-a");

    // Composite constraint: a raw duplicate (org-a, key) create is rejected
    // with P2002 by system_config_organizationId_key_key.
    let rejectionCode: string | undefined;
    try {
      await prisma.systemConfig.create({
        data: { key, value: "dup", organizationId: orgA.id },
      });
    } catch (err) {
      rejectionCode = errorCode(err);
    }
    expect(rejectionCode).toBe("P2002");

    const rowsAfter = await prisma.systemConfig.findMany({ where: { key } });
    expect(rowsAfter).toHaveLength(3);
  });

  test("race tolerance end-to-end: two concurrent helper calls for the SAME fresh global key — both resolve, exactly one row, value is one of the two", async () => {
    if (!dbAvailable) return;
    const { upsertSystemConfigRow } = await import("../services/systemConfigService");

    const key = freshTestKey("race");
    const valueA = `race-a_${uniqueSuffix()}`;
    const valueB = `race-b_${uniqueSuffix()}`;

    const settled = await Promise.allSettled([
      upsertSystemConfigRow(prisma, { key, value: valueA }),
      upsertSystemConfigRow(prisma, { key, value: valueB }),
    ]);

    // Both promises RESOLVE — the P2002 loser re-checks and returns the
    // winner (no unhandled rejection, no crash). A rejected entry here means
    // the helper's race backstop failed.
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(rejected).toEqual([]);

    const rows = await prisma.systemConfig.findMany({ where: { key } });
    expect(rows).toHaveLength(1);
    expect([valueA, valueB]).toContain(rows[0]?.value);
  });
});