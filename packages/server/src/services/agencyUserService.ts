// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 206 (AGENCY-01..04): web-agency sub-user service.
// D-01 UserSponsorship owns the hierarchy link; D-02 sub-users join the
// sponsor's org as OrganizationMember (memberships are the ONLY org link,
// Phase 182 D-01); D-03 the actor-is-subuser structural guard; D-11/D-12
// the fail-closed ceiling with the { error, quota: "users" } family;
// D-20 sub-user default role = "Utente Cloud" (assignedVia "agency").

import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import type { CreateSubUserInput, PermissionName } from "@simmetric-chat/shared";
import { DELEGATION_DENYLIST, isDelegatable, PERMISSION_NAMES } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getEffectivePermissions } from "../utils/auth";
import { invalidateAuthCache } from "./authService";

const SALT_ROUNDS = 12;

/** Typed service error — the route maps status+payload 1:1 (roles.ts 500
 * catch-all stays the fallback for unexpected throws). */
export class AgencyError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    super(String(payload.error ?? "Agency error"));
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Phase 206 (AGENCY-01/AGENCY-04): create a sub-user for the actor.
 * One transaction: User (+ mustChangePassword) + OrganizationMember in the
 * sponsor's org (D-02 — memberships are the only org link) + UserRole
 * ("Utente Cloud", assignedVia "agency", D-20) + UserSponsorship (D-01).
 * Ceiling pre-check inside the transaction scope (D-13; plan 04 hardens
 * the count+insert TOCTOU arm).
 */
export async function createSubUser(
  actorId: string,
  input: CreateSubUserInput,
  organizationId: string | null,
) {
  // D-03 (structural guard): an actor that appears as a subUserId can never
  // sponsor — nested delegation stays impossible even with hand-granted rows.
  const sponsorRow = await prisma.userSponsorship.findFirst({
    where: { subUserId: actorId },
  });
  if (sponsorRow) {
    throw new AgencyError(403, { error: "Sub-users cannot create sub-users" });
  }

  if (!organizationId) {
    // Fail-closed tenancy: no resolvable membership → nothing to scope to.
    throw new AgencyError(404, { error: "Organization not found" });
  }

  const actor = (await prisma.user.findUnique({
    where: { id: actorId },
    include: {
      roles: {
        include: { role: { include: { permissions: { select: { permissionName: true } } } } },
      },
      permissionOverrides: { select: { permissionName: true } },
    },
  })) as { id: string; maxSponsoredUsers: number | null } | null;
  if (!actor) {
    throw new AgencyError(404, { error: "User not found" });
  }
  // D-12: admin-side creation bypasses the ceiling (admin is terminal —
  // isAdmin = admin:settings per utils/auth.ts:69).
  const isAdminActor = getEffectivePermissions(actor).includes("admin:settings");

  // D-11/D-12: ceiling value read here; the COUNT re-check runs INSIDE the
  // transaction below (Pitfall 9 — the pre-tx count is advisory). Admins
  // bypass (D-12): the in-tx check skips when isAdminActor.
  const ceiling = actor.maxSponsoredUsers ?? 0;

  const plainPassword = input.password ?? randomBytes(12).toString("base64url");
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const passwordHash = await bcrypt.hash(plainPassword, salt);

  const cloudRole = await prisma.role.findFirst({ where: { name: "Utente Cloud" } });
  if (!cloudRole) {
    // Fail-loud: the boot seeding (seedService.seedRoles) must have run.
    logger.error("[agencyUserService] Utente Cloud role missing — seeding did not run");
    throw new AgencyError(500, { error: "Utente Cloud role not seeded" });
  }

  const subUser = await prisma.$transaction(async (tx) => {
    // D-11/D-13 (Pitfall 9): ceiling re-check INSIDE the transaction — two
    // parallel creates cannot both pass count+insert (TOCTOU arm; the
    // tombstone partial-unique is the belt-and-braces backstop). Admins
    // bypass (D-12 — admin is terminal).
    if (!isAdminActor) {
      const inTxCount = await tx.userSponsorship.count({
        where: { sponsorId: actorId, deletedAt: null },
      });
      if (inTxCount >= ceiling) {
        throw new AgencyError(409, {
          error: "User ceiling reached",
          quota: "users",
        });
      }
    }

    // Duplicate guard mirrors authService.register (username/email unique).
    const existing = await tx.user.findFirst({
      where: { OR: [{ username: input.username }, { email: input.email }] },
    });
    if (existing) {
      throw new AgencyError(409, { error: "Username or email already in use" });
    }

    const created = await tx.user.create({
      data: {
        username: input.username,
        email: input.email,
        passwordHash,
        salt,
        // D-06: the sub-user rotates the agency-set password on first login.
        mustChangePassword: true,
      },
    });

    // D-02: membership in the SPONSOR's active org — tenant context resolves
    // from memberships; without this row every sub-user request 404s closed.
    await tx.organizationMember.create({
      data: { organizationId, userId: created.id, roleInOrg: "member" },
    });

    await tx.userRole.create({
      data: { userId: created.id, roleId: cloudRole.id, assignedVia: "agency" },
    });

    // D-01: the ownership row — the ONLY hierarchy link.
    await tx.userSponsorship.create({
      data: { sponsorId: actorId, subUserId: created.id },
    });

    return created;
  });

  return {
    user: {
      id: subUser.id,
      username: subUser.username,
      email: subUser.email,
      mustChangePassword: subUser.mustChangePassword,
    },
    generatedPassword: input.password ? undefined : plainPassword,
  };
}

/** Scoped list: ONLY the actor's own sub-users (AGENCY-01, Pitfall 7). */
export async function listSubUsers(actorId: string) {
  const rows = await prisma.userSponsorship.findMany({
    where: { sponsorId: actorId, deletedAt: null },
    include: {
      subUser: {
        select: {
          id: true,
          username: true,
          email: true,
          disabledAt: true,
          mustChangePassword: true,
          createdAt: true,
          // Phase 206 (owner UAT): current delegated grants ride the list so
          // the permissions picker can PRE-SELECT them on reopen (the write
          // is full-replace — losing the current set on reopen would wipe
          // grants on the next save).
          permissionOverrides: { select: { permissionName: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.subUser.id,
    username: row.subUser.username,
    email: row.subUser.email,
    disabledAt: row.subUser.disabledAt,
    mustChangePassword: row.subUser.mustChangePassword,
    createdAt: row.subUser.createdAt,
    permissions: row.subUser.permissionOverrides.map((o) => o.permissionName),
  }));
}

/**
 * Scoped fetch with 404-hide (D-04/SC-1): a sub-user not owned by the actor
 * resolves to null — the route answers 404, never 403 (existence leak).
 */
export async function getSubUser(actorId: string, subUserId: string) {
  const row = await prisma.userSponsorship.findFirst({
    where: { subUserId, sponsorId: actorId, deletedAt: null },
    include: {
      subUser: {
        select: {
          id: true,
          username: true,
          email: true,
          disabledAt: true,
          mustChangePassword: true,
          createdAt: true,
        },
      },
    },
  });
  return row ? row.subUser : null;
}

/**
 * Phase 206 (AGENCY-03, D-08): the delegation lattice validator.
 * Primary rule: every grant must be ∈ (sponsor's effective permissions ∖
 * DELEGATION_DENYLIST) — subtract-then-test (Pitfall 4: possession alone is
 * not enough; agency:users:manage is non-delegable even when possessed).
 * Fails with 403 naming ONLY the first denied grant (no enumeration oracle).
 */
/** @latentByDesign — invoked by replaceSubUserPermissions (and future bulk flows). */
export async function validateGrantSet(
  actorId: string,
  grants: string[],
): Promise<PermissionName[]> {
  const actor = (await prisma.user.findUnique({
    where: { id: actorId },
    include: {
      roles: {
        include: { role: { include: { permissions: { select: { permissionName: true } } } } },
      },
      permissionOverrides: { select: { permissionName: true } },
    },
  })) as { permissionOverrides?: { permissionName: string }[] } | null;
  if (!actor) throw new AgencyError(404, { error: "User not found" });

  const effective = getEffectivePermissions(actor);
  const delegatable = new Set(effective.filter((p) => isDelegatable(p)));
  const unknown = grants.filter((g) => !PERMISSION_NAMES.includes(g as PermissionName));
  if (unknown.length > 0) {
    throw new AgencyError(400, { error: "Unknown permission in grant set" });
  }
  const invalid = grants.filter((g) => !delegatable.has(g as PermissionName));
  if (invalid.length > 0) {
    throw new AgencyError(403, {
      error: `Grant not permitted: ${invalid[0]}`,
      denied: invalid.length,
    });
  }
  return grants as PermissionName[];
}

/**
 * Phase 206 (D-10): the permission picker's server source — the agency's
 * effective permissions minus the terminal denylist. The client never
 * computes the lattice.
 */
export async function listDelegatablePermissions(actorId: string): Promise<string[]> {
  const actor = (await prisma.user.findUnique({
    where: { id: actorId },
    include: {
      roles: {
        include: { role: { include: { permissions: { select: { permissionName: true } } } } },
      },
      permissionOverrides: { select: { permissionName: true } },
    },
  })) as { permissionOverrides?: { permissionName: string }[] } | null;
  if (!actor) throw new AgencyError(404, { error: "User not found" });
  const effective = getEffectivePermissions(actor);
  return effective.filter((perm) => isDelegatable(perm));
}

/**
 * Phase 206 (AGENCY-03, D-09): full-replace semantics — the sub-user's
 * permission-override set EXACTLY matches the validated grant list (insert
 * new grants, delete removed grants). Composition: role defaults ∪ grants
 * (utils/auth getEffectivePermissions unions overrides).
 */
export async function replaceSubUserPermissions(
  actorId: string,
  subUserId: string,
  grants: string[],
): Promise<number> {
  const ownership = await prisma.userSponsorship.findFirst({
    where: { subUserId, sponsorId: actorId, deletedAt: null },
  });
  if (!ownership) throw new AgencyError(404, { error: "User not found" });

  const validated = await validateGrantSet(actorId, grants);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.userPermissionOverride.findMany({
      where: { userId: subUserId },
      select: { permissionName: true },
    });
    const existingSet = new Set(existing.map((row) => row.permissionName));
    const nextSet = new Set<string>(validated);
    const toDelete = [...existingSet].filter((perm) => !nextSet.has(perm));
    const toAdd = validated.filter((perm) => !existingSet.has(perm));
    if (toDelete.length > 0) {
      await tx.userPermissionOverride.deleteMany({
        where: { userId: subUserId, permissionName: { in: toDelete } },
      });
    }
    for (const perm of toAdd) {
      await tx.userPermissionOverride.create({
        data: { userId: subUserId, permissionName: perm, grantedBy: actorId },
      });
    }
  });

  await invalidateAuthCache(subUserId).catch(() => {});
  return validated.length;
}

/**
 * Phase 206 (AGENCY-02, D-05): disable/enable lifecycle. disabledAt gates
 * login + the auth chain (fail-closed); the sponsorship row SURVIVES a
 * disable (ceiling counts it until a future delete).
 */
export async function setSubUserDisabled(
  actorId: string,
  subUserId: string,
  disabled: boolean,
) {
  const ownership = await prisma.userSponsorship.findFirst({
    where: { subUserId, sponsorId: actorId, deletedAt: null },
  });
  if (!ownership) throw new AgencyError(404, { error: "User not found" });
  const user = await prisma.user.update({
    where: { id: subUserId },
    data: { disabledAt: disabled ? new Date() : null },
  });
  await invalidateAuthCache(subUserId).catch(() => {});
  return { id: user.id, disabledAt: user.disabledAt };
}

/**
 * Phase 206 (AGENCY-02, D-06): agency password reset — temp password +
 * mustChangePassword; returned EXACTLY ONCE, never logged.
 */
export async function resetSubUserPassword(actorId: string, subUserId: string) {
  const ownership = await prisma.userSponsorship.findFirst({
    where: { subUserId, sponsorId: actorId, deletedAt: null },
  });
  if (!ownership) throw new AgencyError(404, { error: "User not found" });

  const plainPassword = randomBytes(12).toString("base64url");
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const passwordHash = await bcrypt.hash(plainPassword, salt);
  await prisma.user.update({
    where: { id: subUserId },
    data: { passwordHash, salt, mustChangePassword: true },
  });
  await invalidateAuthCache(subUserId).catch(() => {});
  return { tempPassword: plainPassword };
}

/** @latentByDesign — plan 04 wires GET /api/agency/ceiling (AGENCY-04).
 * Ceiling read for the agency (D-11 display contract: max/active/remaining).
 * Latent only in plan 02 — the route consumer lands in plan 04 (AGENCY-04). */
export async function getSponsorCeiling(actorId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { maxSponsoredUsers: true },
  });
  const active = await prisma.userSponsorship.count({
    where: { sponsorId: actorId, deletedAt: null },
  });
  const max = actor?.maxSponsoredUsers ?? 0;
  return { maxSponsoredUsers: max, active, remaining: Math.max(0, max - active) };
}