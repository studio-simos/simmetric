// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";
import { ROLE_IN_ORG_VALUES } from "../constants/organization";

// ===== Organization Membership Schemas (Phase 182, SAAS-01d/D-04) =====

/**
 * roleInOrg value validation — enum built from the shared ROLE_IN_ORG_VALUES
 * constant (owner | admin | member). Tier ABOVE the untouched 31-permission
 * RBAC surface (Phase 182 D-04/D-05). V5 input validation seam for
 * `ensureDefaultOrgMembership`.
 */
export const roleInOrgSchema = z.enum(ROLE_IN_ORG_VALUES);

// createOrganizationMemberSchema (Phase 182 member-creation body) had no
// consumer outside this file — the server validates member creation inline
// (organizationService.assertRoleInOrg + Prisma write) — deleted by the
// knip sweep (quick-260921-o5z). roleInOrgSchema stays: the server's
// ensureDefaultOrgMembership validates through it. The org-role VALUE type
// is `RoleInOrg` in constants/organization.ts (server imports that one).