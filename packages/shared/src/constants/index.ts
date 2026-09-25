// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

export { PERMISSION_NAMES, DEFAULT_ROLES, CONFIG_DEFAULTS, MENU_SECTIONS, menuSectionSchema, permissionNameSchema, DEFAULT_ROLE_MENU_SECTIONS, SETTINGS_TAB_PERMISSIONS, DELEGATION_DENYLIST, isDelegatable } from "./permissions";
export type { PermissionName } from "./permissions";

export { COMMUNITY_FEATURE_DEFAULTS, ENTERPRISE_FEATURE_DEFAULTS } from "./license";
export type { FeatureFlag } from "./license";

export { PROVIDER_PRESETS } from "./providerPresets";
export type { ProviderPresetCategory } from "./providerPresets";

// DEFAULT_ORG_SLUG / ROLE_IN_ORG_VALUES are NOT re-exported here: knip
// (quick-260921-o5z) proved neither has a consumer through this barrel —
// the default-org slug contract is pinned by the M1 migration's SQL literal
// (`slug = 'default'`, migrations/20260904120000_m1_create_org) and
// DEFAULT_ORG_ID carries the runtime seam; ROLE_IN_ORG_VALUES is consumed
// only in-file by schemas/organization.schema.ts (z.enum). The source-file
// exports keep the schema's direct import path working.
export { DEFAULT_ORG_ID } from "./organization";
export type { RoleInOrg } from "./organization";