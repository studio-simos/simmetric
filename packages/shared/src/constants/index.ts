// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

export { PERMISSION_NAMES, DEFAULT_ROLES, CONFIG_DEFAULTS, MENU_SECTIONS, menuSectionSchema, DEFAULT_ROLE_MENU_SECTIONS, SETTINGS_TAB_PERMISSIONS } from "./permissions";
export type { PermissionName } from "./permissions";

export { COMMUNITY_FEATURE_DEFAULTS, ENTERPRISE_FEATURE_DEFAULTS } from "./license";
export type { FeatureFlag } from "./license";

export { PROVIDER_PRESETS } from "./providerPresets";
export type { ProviderPresetCategory } from "./providerPresets";

export { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG, ROLE_IN_ORG_VALUES } from "./organization";
export type { RoleInOrg } from "./organization";