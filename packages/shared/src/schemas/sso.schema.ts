// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== SSO Config Schemas =====
// Phase 113 (AUTH-01) — Enterprise single sign-on configuration write/response
// contracts. `clientSecret` is PLAINTEXT on input only; the server encrypts it
// at rest (encryptionService) and never returns it — the response schema
// exposes `clientSecretConfigured: boolean` instead of the encrypted blob.

// Treat empty form inputs as null (matches widget.schema.ts convention).
const emptyStringToNull = (val: unknown) => (val === "" ? null : val);

/**
 * @enterpriseConsumed — RUNTIME-imported by the private enterprise repo
 * (routes/sso.ts saveSsoConfigSchema). knip cannot see the root `link:` dep;
 * this tag is the allowlist mechanism (see knip.json `tags`).
 */
export const saveSsoConfigSchema = z.object({
  provider: z.enum(["saml", "oidc", "ldap"]),
  enabled: z.boolean().default(false),
  clientId: z.string().max(500).nullable().optional(),
  // PLAINTEXT secret on input — encrypted server-side at rest.
  clientSecret: z.string().max(2000).nullable().optional(),
  discoveryUrl: z.preprocess(
    emptyStringToNull,
    z.string().url("Invalid discovery URL").nullable().optional()
  ),
  entryPoint: z.preprocess(
    emptyStringToNull,
    z.string().url("Invalid entry point URL").nullable().optional()
  ),
  cert: z.string().max(10000).nullable().optional(),
  entityId: z.string().max(500).nullable().optional(),
  redirectUri: z.preprocess(
    emptyStringToNull,
    z.string().url("Invalid redirect URI").nullable().optional()
  ),
  // ===== Phase 193 (LDAP-01, D-03): additive LDAP provider fields =====
  // PLAINTEXT bind password on input — encrypted server-side at rest via
  // ctx.encrypt (AES-256-GCM "iv:authTag:ciphertext", same as clientSecret).
  // Never returned by any response (ldapBindPasswordConfigured instead).
  ldapBindPassword: z.string().max(2000).nullable().optional(),
  ldapUrl: z.preprocess(
    emptyStringToNull,
    z.string().url("Invalid LDAP URL").nullable().optional()
  ),
  ldapBindDn: z.preprocess(
    emptyStringToNull,
    z.string().max(500).nullable().optional()
  ),
  ldapSearchBase: z.preprocess(
    emptyStringToNull,
    z.string().max(500).nullable().optional()
  ),
  ldapSearchFilter: z.preprocess(
    emptyStringToNull,
    z.string().max(500).nullable().optional()
  ),
  ldapGroupSearchBase: z.preprocess(
    emptyStringToNull,
    z.string().max(500).nullable().optional()
  ),
  ldapGroupSearchFilter: z.preprocess(
    emptyStringToNull,
    z.string().max(500).nullable().optional()
  ),
  ldapUseTls: z.boolean().nullable().optional(),
  ldapAcceptCert: z.string().max(20000).nullable().optional(),
  ldapFallbackToLocal: z.boolean().nullable().optional(),
});

// Phase 193: exported (was module-private) so the additive-widening invariant
// test can safeParse the response arm at runtime — the schema AND its
// inferred type are both part of the public contract per shared conventions.
export const ssoConfigResponseSchema = z.object({
  id: z.string(),
  provider: z.enum(["saml", "oidc", "ldap"]),
  enabled: z.boolean(),
  clientId: z.string().nullable(),
  discoveryUrl: z.string().nullable(),
  entryPoint: z.string().nullable(),
  cert: z.string().nullable(),
  entityId: z.string().nullable(),
  redirectUri: z.string().nullable(),
  // Phase 193 (D-03): additive optional LDAP fields in the response.
  // .optional() (not required-nullable) so LEGACY saml/oidc response payloads
  // — which predate the ldap columns — still parse unchanged (the
  // additive-only invariant pinned by ssoSchemasLdap.test.ts). Live server
  // responses always carry them (the DB columns exist with defaults).
  ldapUrl: z.string().nullable().optional(),
  ldapBindDn: z.string().nullable().optional(),
  ldapSearchBase: z.string().nullable().optional(),
  ldapSearchFilter: z.string().nullable().optional(),
  ldapGroupSearchBase: z.string().nullable().optional(),
  ldapGroupSearchFilter: z.string().nullable().optional(),
  ldapUseTls: z.boolean().nullable().optional(),
  ldapAcceptCert: z.string().nullable().optional(),
  ldapFallbackToLocal: z.boolean().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  clientSecretConfigured: z.boolean(),
  // NEVER the ciphertext — boolean "configured" marker only (T-193-01).
  ldapBindPasswordConfigured: z.boolean().optional(),
});

export type SaveSsoConfigInput = z.infer<typeof saveSsoConfigSchema>;
export type SsoConfigResponse = z.infer<typeof ssoConfigResponseSchema>;

// ===== SSO Public Status Schema =====
// Quick 260808-p5y — PUBLIC response contract for the unauthenticated login
// page. Deliberately minimal: booleans/enums only. NEVER carries clientId,
// discoveryUrl, cert, entityId, redirectUri, or any secret — the admin-gated
// GET /api/sso/config remains the only source of those fields.

const ssoStatusResponseSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["saml", "oidc", "ldap"]).nullable(),
  oidcProvider: z.enum(["google", "github", "microsoft", "oidc"]).nullable(),
});

export type SsoStatusResponse = z.infer<typeof ssoStatusResponseSchema>;

// ===== LDAP Login + Group-Map Schemas (Phase 193, D-03/D-04) =====
// ldapLoginSchema — public login POST body for /api/auth/ldap/login
// (D-18: the existing username/password form posts credentials; no browser
// redirect). Strings min 1 — no trimming/max-length games on credentials.
export const ldapLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type LdapLoginInput = z.infer<typeof ldapLoginSchema>;

// LdapGroupRoleMap CRUD contracts (D-04) — admin surface for the
// group→role mapping (Plan 02 routes consume these with safeParse).
export const ldapMapRowSchema = z.object({
  ldapGroupDn: z.string().min(1).max(1000),
  roleId: z.string().min(1),
});

export const ldapMapPutSchema = z.object({
  mappings: z.array(ldapMapRowSchema),
});

export type LdapMapRow = z.infer<typeof ldapMapRowSchema>;
export type LdapMapPutInput = z.infer<typeof ldapMapPutSchema>;

// ===== OIDC Provider Derivation (Phase 143 — D-07) =====
// Pure string-match helper: derives the canonical built-in provider name
// from a configured discovery URL, falling back to "oidc" for custom
// providers. No runtime deps (fits the shared kernel — same precedent as
// `normalizeSource()` in types/index.ts + `validateMemoryOperations` etc.).
//
// Single source of truth: the community `packages/server/src/routes/auth.ts`
// `/api/auth/sso/status` endpoint imports this from `@simmetric-chat/shared`
// (Phase 143 Plan 03 — was an inlined local copy after Plans 01/02 moved
// `services/oidcClient.ts` to the enterprise package). The enterprise
// `simmetric-enterprise/src/services/oidcClient.ts` keeps its own local
// copy for now (harmless duplication — the function is pure and ~15 lines);
// Phase 147 can consolidate if the enterprise package ever grows a shared
// runtime dep on `@simmetric-chat/shared` for helpers.
export function getOidcProviderFromDiscoveryUrl(
  discoveryUrl: string | null,
): "google" | "github" | "microsoft" | "oidc" {
  if (!discoveryUrl) return "oidc";
  if (discoveryUrl.includes("accounts.google.com")) return "google";
  if (discoveryUrl.includes("github.com")) return "github";
  if (
    discoveryUrl.includes("login.microsoftonline.com") ||
    discoveryUrl.includes("microsoftonline.com")
  ) {
    return "microsoft";
  }
  return "oidc";
}
