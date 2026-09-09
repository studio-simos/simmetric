// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 182 (Tenant Data Model) — default-org constants.
 *
 * The default org is the tenancy root for air-gap / single-tenant installs:
 * its UUID is FIXED (`00000000-0000-0000-0000-000000000000`) so migrations
 * (M1 org INSERT, M3 backfill), seed.ts, E2E fixtures, and generated Prisma
 * `@default` literals all pin the exact same value — the literal is the
 * load-bearing contract that keeps the M1-M4 migration chain idempotent.
 *
 * Request/job code MUST import DEFAULT_ORG_ID from `@simmetric-chat/shared`
 * instead of hardcoding the literal. The raw literal is allowed ONLY in
 * migrations, `prisma/seed.ts`, and e2e/test fixtures (repo debt-table rule,
 * Phase 182 CONTEXT.md Specifics).
 */

/** Fixed UUID of the default Organization — the air-gap tenancy root. */
export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000000";

/** Stable slug of the default Organization (M1 INSERT pins the same value). */
export const DEFAULT_ORG_SLUG = "default";

/**
 * roleInOrg value set (OrganizationMember.roleInOrg) — enum-as-string pattern
 * (NO Prisma enum, mirrors Chat.titleSource). Tier ABOVE the 31-permission
 * RBAC surface, which stays untouched (Phase 182 D-04/D-05).
 */
export const ROLE_IN_ORG_VALUES = ["owner", "admin", "member"] as const;

export type RoleInOrg = (typeof ROLE_IN_ORG_VALUES)[number];