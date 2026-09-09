// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Prisma } from "@prisma/client";
import { DEFAULT_ORG_ID, type RoleInOrg } from "@simmetric-chat/shared";
import { roleInOrgSchema } from "@simmetric-chat/shared";
import type { prisma as prismaSingleton } from "../utils/prisma";

/**
 * Phase 182 (SAAS-01a/D-01/Pitfall 4b) — default-org membership helper.
 *
 * Every core user-creation path (seed ×3, seedService ×2, wizard, self-
 * registration) calls this right after creating the user, so no membership-
 * less user can exist after the M3 migration window. Known gap: enterprise-
 * plugin SCIM provisioning (ctx.prisma, outside the core sites) stays
 * membership-less until Phase 186 PluginContext v2 — see threat model
 * T-182-11b.
 *
 * Semantics (empirically verified on the partial unique index
 * `organization_members_organizationId_userId_key` WHERE deletedAt IS NULL):
 *
 *  1. Idempotent fast path — a live row (deletedAt: null) returns early, so
 *     seed re-runs / boot re-seeds / E2E re-setups are no-ops.
 *  2. Tombstone resurrect (D-04 + D-05) — a soft-deleted row is revived by
 *     clearing deletedAt. This shape works identically with OR without the
 *     partial index (the plain-unique branch would tombstone-block a plain
 *     create, so the explicit resurrect arm is the D-05 fallback that is
 *     safe either way).
 *  3. P2002 race tolerance — two concurrent callers can both pass the
 *     findFirst guards and race the create; the loser catches P2002 (the
 *     partial unique fires on the second live row) and re-checks. Mirrors
 *     the boot-seeding tolerance precedent (seedWidgetApiKey) — never
 *     rethrows a lost race.
 *
 * NOTE on the upsert shape: an `upsert({ where: { organizationId_userId } })`
 * is NOT usable against the partial unique index — Postgres rejects it with
 * 42P10 ("no unique or exclusion constraint matching the ON CONFLICT
 * specification") because a partial index cannot arbitrate plain ON
 * CONFLICT targets. The find-first → resurrect → create-with-catch shape
 * below is the verified replacement (182-PLAN-03 deviation, Rule 1).
 *
 * The db param accepts the PrismaClient singleton OR a transaction client —
 * the system.ts wizard passes tx so the membership insert commits in the
 * SAME Serializable transaction as user creation (T-182-13).
 */
export type PrismaDbClient = typeof prismaSingleton | Prisma.TransactionClient;

/** Error thrown when roleInOrg is not owner|admin|member (programming error — fail-loud, V5). */
function assertRoleInOrg(roleInOrg: RoleInOrg): void {
  const parsed = roleInOrgSchema.safeParse(roleInOrg);
  if (!parsed.success) {
    throw new Error(
      `Invalid roleInOrg "${String(roleInOrg)}" — allowed values: owner | admin | member`,
    );
  }
}

export async function ensureDefaultOrgMembership(
  db: PrismaDbClient,
  userId: string,
  roleInOrg: RoleInOrg = "member",
): Promise<void> {
  assertRoleInOrg(roleInOrg);

  // (1) Idempotency fast path: live membership already present.
  const live = await db.organizationMember.findFirst({
    where: { organizationId: DEFAULT_ORG_ID, userId, deletedAt: null },
  });
  if (live) return;

  // (2) Tombstone resurrect (D-04 removal policy + D-05 spike outcome): a
  // soft-deleted row must not block re-adding the user — flip deletedAt back
  // to null; the update also persists the CALLER's roleInOrg — removal
  // downgrades privileges, re-add is the re-grant moment (WR-02/G-182-02,
  // D-04). With the partial unique index this UPDATE cannot collide with a
  // live row; without it (plain unique), the P2002 catch below tolerates a
  // concurrent resurrect race. P2002 on the update arm = another caller won
  // — their row is live, which is exactly the outcome we want.
  const tombstone = await db.organizationMember.findFirst({
    where: { organizationId: DEFAULT_ORG_ID, userId, deletedAt: { not: null } },
  });
  if (tombstone) {
    try {
      await db.organizationMember.update({
        where: { id: tombstone.id },
        data: { deletedAt: null, roleInOrg }, // re-grant: resurrect honors the caller's role (WR-02/G-182-02)
      });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
    return;
  }

  // (3) Fresh create with P2002 tolerance: a concurrent caller that raced
  // past its own findFirst (the TOCTOU window D-05 documents) already
  // created/resurrected the row — re-check and return normally instead of
  // crashing boot or registration (seedService boot tolerance precedent).
  try {
    await db.organizationMember.create({
      data: { organizationId: DEFAULT_ORG_ID, userId, roleInOrg },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    const winner = await db.organizationMember.findFirst({
      where: { organizationId: DEFAULT_ORG_ID, userId, deletedAt: null },
    });
    if (winner) {
      return;
    }
    throw err;
  }
}