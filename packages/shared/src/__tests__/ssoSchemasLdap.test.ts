// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 193 (LDAP-01, D-03) — additive-only widening invariant for the SSO
 * schemas. The provider unions gain "ldap" and saveSsoConfigSchema gains the
 * LDAP config fields + ldapBindPassword; every legacy saml/oidc payload must
 * parse byte-unchanged (the widening is additive — nothing pre-existing is
 * removed or made required), and the new ldap arms must parse.
 */

import {
  saveSsoConfigSchema,
  ssoConfigResponseSchema,
  ldapLoginSchema,
  ldapMapRowSchema,
  ldapMapPutSchema,
} from "../schemas/sso.schema";
import type { SsoStatusResponse } from "../schemas/sso.schema";
// ssoStatusResponseSchema is module-private; exercise the status contract via
// its exported inferred type (SsoStatusResponse) + a parse through the
// reconstructed shape.
import { z } from "zod";

// Rebuild the status schema surface for parse-level assertions (the export
// contract is the inferred SsoStatusResponse type consumed by the frontend).
const statusSchemaShape = z.object({
  enabled: z.boolean(),
  provider: z.enum(["saml", "oidc", "ldap"]).nullable(),
  oidcProvider: z.enum(["google", "github", "microsoft", "oidc"]).nullable(),
});

const STATUS_CASES: Array<{ name: string; payload: unknown }> = [
  {
    name: "legacy disabled",
    payload: { enabled: false, provider: null, oidcProvider: null },
  },
  {
    name: "legacy saml",
    payload: { enabled: true, provider: "saml", oidcProvider: null },
  },
  {
    name: "legacy oidc/google",
    payload: { enabled: true, provider: "oidc", oidcProvider: "google" },
  },
  {
    name: "new ldap arm",
    payload: { enabled: true, provider: "ldap", oidcProvider: null },
  },
];

describe("Phase 193 sso.schema additive widening (D-03)", () => {
  describe("legacy payloads parse unchanged (additive-only invariant)", () => {
    const legacySamlSave = {
      provider: "saml",
      enabled: true,
      clientId: "client-1",
      clientSecret: "secret-1",
      entryPoint: "https://idp.example.com/sso",
      cert: "-----BEGIN CERTIFICATE-----",
      entityId: "simmetric-chat",
      redirectUri: "https://app.example.com/api/auth/saml/acs",
    };

    const legacyOidcSave = {
      provider: "oidc",
      enabled: false,
      clientId: "oidc-client",
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    };

    it("legacy saml save payload parses without ldap fields", () => {
      const parsed = saveSsoConfigSchema.safeParse(legacySamlSave);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.provider).toBe("saml");
        expect(parsed.data).toEqual(legacySamlSave);
      }
    });

    it("legacy oidc save payload parses without ldap fields", () => {
      const parsed = saveSsoConfigSchema.safeParse(legacyOidcSave);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.provider).toBe("oidc");
        expect(parsed.data).toEqual(legacyOidcSave);
      }
    });

    it("legacy saml/oidc provider unions still parse on the response schema", () => {
      const legacyResponse = {
        id: "cfg-1",
        provider: "saml",
        enabled: true,
        clientId: null,
        discoveryUrl: null,
        entryPoint: "https://idp.example.com/sso",
        cert: null,
        entityId: "simmetric-chat",
        redirectUri: "https://app.example.com/acs",
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
        clientSecretConfigured: true,
      };
      const parsed = ssoConfigResponseSchema.safeParse(legacyResponse);
      expect(parsed.success).toBe(true);
    });

    it("legacy status payloads (saml/oidc/null) parse on the status shape", () => {
      for (const c of STATUS_CASES.slice(0, 3)) {
        const parsed = statusSchemaShape.safeParse(c.payload);
        expect(parsed.success).toBe(true);
      }
    });

    it("SsoStatusResponse type is still the 3-key contract (ldap joins the provider union additively)", () => {
      const ldapStatus: SsoStatusResponse = {
        enabled: true,
        provider: "ldap",
        oidcProvider: null,
      };
      expect(ldapStatus.provider).toBe("ldap");
      expect(statusSchemaShape.safeParse(ldapStatus).success).toBe(true);
    });
  });

  describe("ldap arms parse (new surface)", () => {
    it("provider union accepts 'ldap' in saveSsoConfigSchema", () => {
      const parsed = saveSsoConfigSchema.safeParse({
        provider: "ldap",
        enabled: true,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.provider).toBe("ldap");
      }
    });

    it("saveSsoConfigSchema parses the full ldap config arm", () => {
      const parsed = saveSsoConfigSchema.safeParse({
        provider: "ldap",
        enabled: true,
        ldapUrl: "ldap://directory.example.com:389",
        ldapBindDn: "cn=reader,dc=example,dc=com",
        ldapBindPassword: "plaintext-bind-secret",
        ldapSearchBase: "dc=example,dc=com",
        ldapSearchFilter: "(uid={{username}})",
        ldapGroupSearchBase: "ou=groups,dc=example,dc=com",
        ldapGroupSearchFilter: "(member={{dn}})",
        ldapUseTls: true,
        ldapAcceptCert: "-----BEGIN CERTIFICATE-----",
        ldapFallbackToLocal: true,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ldapBindPassword).toBe("plaintext-bind-secret");
        expect(parsed.data.ldapUseTls).toBe(true);
      }
    });

    it("ldapBindPassword rejects over max 2000 (plaintext input guard)", () => {
      const parsed = saveSsoConfigSchema.safeParse({
        provider: "ldap",
        ldapBindPassword: "x".repeat(2001),
      });
      expect(parsed.success).toBe(false);
    });

    it("empty-string ldap URL form inputs preprocess to null (emptyStringToNull)", () => {
      const parsed = saveSsoConfigSchema.safeParse({
        provider: "ldap",
        ldapUrl: "",
        ldapBindDn: "",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ldapUrl).toBeNull();
        expect(parsed.data.ldapBindDn).toBeNull();
      }
    });

    it("invalid ldapUrl rejects (.url guard mirroring discoveryUrl)", () => {
      const parsed = saveSsoConfigSchema.safeParse({
        provider: "ldap",
        ldapUrl: "not-a-url",
      });
      expect(parsed.success).toBe(false);
    });

    it("response schema accepts the ldap arm + ldapBindPasswordConfigured marker", () => {
      const parsed = ssoConfigResponseSchema.safeParse({
        id: "cfg-1",
        provider: "ldap",
        enabled: true,
        clientId: null,
        discoveryUrl: null,
        entryPoint: null,
        cert: null,
        entityId: null,
        redirectUri: null,
        ldapUrl: "ldaps://directory.example.com:636",
        ldapBindDn: "cn=reader,dc=example,dc=com",
        ldapSearchBase: null,
        ldapSearchFilter: null,
        ldapGroupSearchBase: null,
        ldapGroupSearchFilter: null,
        ldapUseTls: true,
        ldapAcceptCert: null,
        ldapFallbackToLocal: true,
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
        clientSecretConfigured: false,
        ldapBindPasswordConfigured: true,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ldapBindPasswordConfigured).toBe(true);
      }
    });
  });

  describe("ldapLoginSchema", () => {
    it("accepts username + password", () => {
      const parsed = ldapLoginSchema.safeParse({
        username: "jdoe",
        password: "secret",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects empty username / password (min 1)", () => {
      expect(ldapLoginSchema.safeParse({ username: "", password: "x" }).success).toBe(false);
      expect(ldapLoginSchema.safeParse({ username: "jdoe", password: "" }).success).toBe(false);
      expect(ldapLoginSchema.safeParse({ username: "jdoe" }).success).toBe(false);
    });
  });

  describe("ldapMapRowSchema / ldapMapPutSchema", () => {
    it("row parses with ldapGroupDn + roleId", () => {
      const parsed = ldapMapRowSchema.safeParse({
        ldapGroupDn: "cn=developers,ou=groups,dc=example,dc=com",
        roleId: "role-uuid",
      });
      expect(parsed.success).toBe(true);
    });

    it("row rejects empty ldapGroupDn / roleId", () => {
      expect(
        ldapMapRowSchema.safeParse({ ldapGroupDn: "", roleId: "r" }).success
      ).toBe(false);
      expect(
        ldapMapRowSchema.safeParse({ ldapGroupDn: "cn=x", roleId: "" }).success
      ).toBe(false);
    });

    it("put parses a mappings array", () => {
      const parsed = ldapMapPutSchema.safeParse({
        mappings: [
          { ldapGroupDn: "cn=devs,dc=example,dc=com", roleId: "role-1" },
          { ldapGroupDn: "cn=ops,dc=example,dc=com", roleId: "role-2" },
        ],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.mappings).toHaveLength(2);
      }
    });

    it("put rejects a missing mappings array", () => {
      expect(ldapMapPutSchema.safeParse({}).success).toBe(false);
      expect(ldapMapPutSchema.safeParse({ mappings: "nope" }).success).toBe(false);
    });
  });
});