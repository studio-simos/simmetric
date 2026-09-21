// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 193 (LDAP-01/02, D-03/D-04) — schema substrate integration pin.
 *
 * Proves the LDAP substrate against REAL Postgres (the template DB built by
 * the integration globalSetup from the applied migrations):
 *
 *  1. LdapGroupRoleMap: two distinct (ldapGroupDn, roleId) rows → findMany
 *     returns both.
 *  2. Duplicate-pair insert → the @@unique([ldapGroupDn, roleId]) constraint
 *     rejects (Prisma P2002).
 *  3. Parent Role deletion → the map row cascades away (onDelete: Cascade).
 *  4. SsoConfig ldap columns: fresh row → defaults (ldapUseTls true,
 *     ldapFallbackToLocal true, strings null); update round-trips.
 *  5. UserRole.assignedVia ("ldap" provenance, Phase 189 substrate): a row
 *     created with assignedVia "ldap" is findable AND deletable via the
 *     composite-PK where clause the role sync uses (userId + roleId).
 *
 * RUN: `pnpm --filter server test:integration -- ldapSchema.integration`
 * (real Postgres required — .env.test points at localhost:5434 in CI; the
 * dev scratch container is reached via a DATABASE_URL override).
 *
 * ADDITIVE-ONLY posture: every row this suite creates is deleted in afterAll
 * (or cascades with its parent); the singleton SsoConfig row uses a unique
 * generated URL so a concurrently-seeded operator row is never touched.
 */

// Module marker + shared substrate import (mirrors membershipBackfill.integration).
import { DEFAULT_ORG_ID } from "@simmetric-chat/shared";

let prisma: import("@prisma/client").PrismaClient;

let dbAvailable = true;

/** Rows created by this suite (cleaned in afterAll). */
const createdRoleIds: string[] = [];
const createdMapIds: string[] = [];
const createdUserIds: string[] = [];
let ssoConfigId: string | null = null;

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function createTestRole(name: string): Promise<import("@prisma/client").Role> {
  const role = await prisma.role.create({
    data: {
      name,
      description: `ldapSchema.integration ${name}`,
    },
  });
  createdRoleIds.push(role.id);
  return role;
}

async function createTestUser(prefix: string): Promise<import("@prisma/client").User> {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      username: `ldap_${prefix}_${suffix}`,
      email: `ldap_${prefix}_${suffix}@test.local`,
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
    // Fail loud on an unreachable DB — a silent green zero-assertion run is
    // the WR-02/G-182-05 anti-pattern (matches membershipBackfill.integration).
    dbAvailable = false;
    console.error(
      "[ldapSchema.integration] DB unavailable — FAILING suite:",
      (err as Error).message,
    );
    throw err;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  try {
    // Map rows first (role deletion would cascade them anyway), then the
    // SsoConfig probe row, then roles (map FK cascade), then users (the
    // user_role FK cascade removes the assignedVia probe row).
    if (createdMapIds.length) {
      await prisma.ldapGroupRoleMap.deleteMany({ where: { id: { in: createdMapIds } } });
    }
    if (ssoConfigId) {
      await prisma.ssoConfig.delete({ where: { id: ssoConfigId } }).catch(() => {});
    }
    for (const id of createdRoleIds) {
      await prisma.role.delete({ where: { id } }).catch(() => {});
    }
    for (const id of createdUserIds) {
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
  } catch {
    // best-effort cleanup — never mask the suite result
  }
});

describe("LdapGroupRoleMap — unique pair + cascade (Phase 193 D-04)", () => {
  it("stores two distinct (ldapGroupDn, roleId) pairs and findMany returns both", async () => {
    const roleA = await createTestRole(`ldap_map_a_${uniqueSuffix()}`);
    const roleB = await createTestRole(`ldap_map_b_${uniqueSuffix()}`);
    const suffix = uniqueSuffix();

    await prisma.ldapGroupRoleMap.create({
      data: {
        ldapGroupDn: `cn=eng,ou=groups,dc=test,dc=${suffix}`,
        roleId: roleA.id,
      },
    });
    await prisma.ldapGroupRoleMap.create({
      data: {
        ldapGroupDn: `cn=ops,ou=groups,dc=test,dc=${suffix}`,
        roleId: roleB.id,
      },
    });

    const rows = await prisma.ldapGroupRoleMap.findMany({
      where: { roleId: { in: [roleA.id, roleB.id] } },
    });
    expect(rows).toHaveLength(2);
    const dns = rows.map((r) => r.ldapGroupDn).sort();
    expect(dns).toEqual(
      [`cn=eng,ou=groups,dc=test,dc=${suffix}`, `cn=ops,ou=groups,dc=test,dc=${suffix}`].sort(),
    );
    createdMapIds.push(...rows.map((r) => r.id));
  });

  it("rejects a duplicate (ldapGroupDn, roleId) pair with P2002 (@@unique contract)", async () => {
    const role = await createTestRole(`ldap_dup_${uniqueSuffix()}`);
    const dn = `cn=dup,ou=groups,dc=test,dc=${uniqueSuffix()}`;

    await prisma.ldapGroupRoleMap.create({ data: { ldapGroupDn: dn, roleId: role.id } });

    await expect(
      prisma.ldapGroupRoleMap.create({ data: { ldapGroupDn: dn, roleId: role.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("deleting the parent Role cascades the map row away (onDelete: Cascade)", async () => {
    const role = await createTestRole(`ldap_cascade_${uniqueSuffix()}`);
    const dn = `cn=cascade,ou=groups,dc=test,dc=${uniqueSuffix()}`;

    const mapRow = await prisma.ldapGroupRoleMap.create({
      data: { ldapGroupDn: dn, roleId: role.id },
    });
    createdMapIds.push(mapRow.id);

    await prisma.role.delete({ where: { id: role.id } });
    // Remove from the manual cleanup list — the cascade already removed it.
    const idx = createdMapIds.indexOf(mapRow.id);
    if (idx >= 0) createdMapIds.splice(idx, 1);

    const gone = await prisma.ldapGroupRoleMap.findUnique({ where: { id: mapRow.id } });
    expect(gone).toBeNull();
  });
});

describe("SsoConfig — ldap columns round-trip + defaults (Phase 193 D-03)", () => {
  it("a fresh row carries the Boolean defaults and null strings; updates round-trip", async () => {
    const suffix = uniqueSuffix();
    const row = await prisma.ssoConfig.create({
      data: {
        // Unique probe row — NEVER the seeded singleton (concurrent suites).
        provider: "ldap",
        ldapUrl: `ldap://probe-${suffix}.invalid:389`,
        ldapBindDn: `cn=probe-${suffix},ou=services,dc=test,dc=local`,
        ldapSearchBase: `dc=test,dc=${suffix}`,
        ldapSearchFilter: `(uid={{username}})`,
        ldapGroupSearchBase: `ou=groups,dc=test,dc=${suffix}`,
        ldapGroupSearchFilter: `(member={{dn}})`,
        // ldapUseTls / ldapFallbackToLocal intentionally UNSET — defaults.
        ldapAcceptCert: null,
        ldapBindPasswordEncrypted: null,
      },
    });
    ssoConfigId = row.id;

    // Defaults on a fresh row.
    expect(row.ldapUseTls).toBe(true);
    expect(row.ldapFallbackToLocal).toBe(true);
    expect(row.ldapAcceptCert).toBeNull();
    expect(row.ldapBindPasswordEncrypted).toBeNull();

    // Round-trip: update the ldap columns, read back.
    const updated = await prisma.ssoConfig.update({
      where: { id: row.id },
      data: {
        ldapUrl: `ldaps://probe-${suffix}.invalid:636`,
        ldapUseTls: false, // ldaps:// ⇒ useTls false (D-06 exclusivity substrate)
        ldapFallbackToLocal: false,
        ldapAcceptCert: "-----BEGIN CERTIFICATE-----\nprobe\n-----END CERTIFICATE-----",
        ldapSearchFilter: `(sAMAccountName={{username}})`,
      },
    });
    expect(updated.ldapUrl).toBe(`ldaps://probe-${suffix}.invalid:636`);
    expect(updated.ldapUseTls).toBe(false);
    expect(updated.ldapFallbackToLocal).toBe(false);
    expect(updated.ldapAcceptCert).toContain("BEGIN CERTIFICATE");
    expect(updated.ldapSearchFilter).toBe(`(sAMAccountName={{username}})`);

    // The provider column carries "ldap" (string column — the widened union).
    expect(updated.provider).toBe("ldap");
  });
});

describe("UserRole.assignedVia — Phase 189 substrate the LDAP sync consumes", () => {
  it("an assignedVia 'ldap' row is creatable, findable, and deletable via the composite-PK where clause", async () => {
    // DEFAULT_ORG_ID reference: the module-marker import's substrate anchor —
    // the JIT landing org the enterprise LDAP login provisions into.
    void DEFAULT_ORG_ID;
    const user = await createTestUser("via");
    const role = await createTestRole(`ldap_via_${uniqueSuffix()}`);

    // Create as the sync would (upsert shape with assignedVia "ldap").
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      create: { userId: user.id, roleId: role.id, assignedVia: "ldap" },
      update: { assignedVia: "ldap" },
    });

    const row = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: role.id, assignedVia: "ldap" },
    });
    expect(row).not.toBeNull();
    expect(row!.assignedVia).toBe("ldap");

    // The revoke arm's delete shape: composite-PK where clause restricted to
    // assignedVia "ldap" (manual rows invisible — Phase 189 substrate).
    const deleted = await prisma.userRole.deleteMany({
      where: { userId: user.id, roleId: { in: [role.id] }, assignedVia: "ldap" },
    });
    expect(deleted.count).toBe(1);

    const afterDelete = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: role.id },
    });
    expect(afterDelete).toBeNull();

    // Manual-row invisibility pin: a manual row survives the same delete.
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, assignedVia: "manual" },
    });
    const manualDelete = await prisma.userRole.deleteMany({
      where: { userId: user.id, roleId: { in: [role.id] }, assignedVia: "ldap" },
    });
    expect(manualDelete.count).toBe(0);
    const manualRow = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: role.id },
    });
    expect(manualRow?.assignedVia).toBe("manual");
  });
});