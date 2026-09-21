// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * scopedPrisma extension operation matrix (Phase 185, SAAS-04b — Postgres-free).
 *
 * Pins the PURE applyTenantReadScope helper (the single source of the
 * extension's semantics — utils/scopedPrisma.ts) with exact input → expected
 * output assertions. The LIVE client behavior (real AND-merge on real PG,
 * relation-filter protection, findUnique escape, include-subtree observation)
 * is pinned by tenantScopeSpike.integration.test.ts — the D-03 spike.
 *
 * Matrix groups:
 *  1. SCOPED OPS   — findFirst/findFirstOrThrow/findMany/count/aggregate/
 *                    groupBy/updateMany/deleteMany AND-merge the org filter.
 *  2. UNTOUCHED OPS — findUnique/findUniqueOrThrow/upsert/create/createMany/
 *                    update/delete pass through byte-equal.
 *  3. AND-MERGE PRESERVES CALLER FILTERS (compose, never replace).
 *  4. CALLER ORG COEXISTS inside the AND (never overwritten, never dropped).
 *  5. BYPASS STORE — args unmodified for every scoped op (D-05).
 *  6. ABSENT STORE — args unmodified (jobs/boot, Pitfall-8-safe).
 *  7. NON-TENANT MODELS — args unmodified even with an active org store.
 *  8. TENANT_READ_MODELS INVENTORY — exactly the 26 direct non-null-org
 *     models; the 6 documented exclusions absent.
 *  9. DEFAULT-ORG FALLBACK — extension-only rule (empty-string org →
 *     DEFAULT_ORG_ID; NEVER legal in the auth path).
 */
import "./helpers/setupEnv";

import { applyTenantReadScope, TENANT_READ_MODELS } from "../utils/scopedPrisma";
import { DEFAULT_ORG_ID } from "@simmetric-chat/shared";

const ORG_STORE = { organizationId: "org-a", bypass: false };
const BYPASS_STORE = { organizationId: "BYPASS", bypass: true };

/** Exact expected AND-merged where for a given caller where (or none). */
function expectedMergedWhere(callerWhere?: object) {
  return { AND: [{ organizationId: "org-a" }, callerWhere ?? {}] };
}

describe("applyTenantReadScope — SCOPED OPS (group 1)", () => {
  const scopedOps = [
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "count",
    "aggregate",
    "groupBy",
    "updateMany",
    "deleteMany",
  ] as const;

  for (const operation of scopedOps) {
    it(`${operation} on Workspace AND-merges organizationId into top-level where`, () => {
      const args: any = { where: { deletedAt: null } };
      const out = applyTenantReadScope({ model: "Workspace", operation, args, store: ORG_STORE });

      expect(out).toEqual({
        where: expectedMergedWhere({ deletedAt: null }),
      });
    });

    it(`${operation} with NO caller where → AND with empty object`, () => {
      const args: any = {};
      const out = applyTenantReadScope({ model: "Workspace", operation, args, store: ORG_STORE });
      expect(out?.where).toEqual({ AND: [{ organizationId: "org-a" }, {}] });
    });
  }
});

describe("applyTenantReadScope — UNTOUCHED OPS (group 2)", () => {
  const untouchedOps = [
    "findUnique",
    "findUniqueOrThrow",
    "upsert",
    "create",
    "createMany",
    "update",
    "delete",
  ] as const;

  for (const operation of untouchedOps) {
    it(`${operation} passes args through unmodified (PK-keyed / D-04 / single-row ops)`, () => {
      const args: any = { where: { id: "w1" }, data: { name: "x" } };
      const out = applyTenantReadScope({ model: "Workspace", operation, args, store: ORG_STORE });

      expect(out).toBeNull(); // skip signal — args returned unmodified downstream
      // Byte-equal check on the caller's object: untouched.
      expect(args).toEqual({ where: { id: "w1" }, data: { name: "x" } });
    });
  }
});

describe("applyTenantReadScope — AND-MERGE PRESERVES CALLER FILTERS (group 3)", () => {
  it("caller where { id, deletedAt: null } keeps BOTH caller keys inside the AND", () => {
    const out = applyTenantReadScope({
      model: "Workspace",
      operation: "findMany",
      args: { where: { id: "w1", deletedAt: null } },
      store: ORG_STORE,
    });

    const and = (out as any)?.where?.AND;
    expect(and).toHaveLength(2);
    expect(and[0]).toEqual({ organizationId: "org-a" });
    // Compose never replace — deletedAt: null SURVIVED inside the AND.
    expect(and[1]).toEqual({ id: "w1", deletedAt: null });
  });

  it("caller where with nested relation filter survives verbatim inside the AND", () => {
    const out = applyTenantReadScope({
      model: "Workspace",
      operation: "findFirst",
      args: { where: { project: { name: "p" } } },
      store: ORG_STORE,
    });

    const and = (out as any).where.AND;
    expect(and[1]).toEqual({ project: { name: "p" } });
  });
});

describe("applyTenantReadScope — CALLER ORG COEXISTS (group 4)", () => {
  it("caller organizationId: org-x + store org-a → BOTH clauses in the AND array", () => {
    const out = applyTenantReadScope({
      model: "Workspace",
      operation: "findMany",
      args: { where: { organizationId: "org-x" } },
      store: ORG_STORE,
    });

    const and = (out as any).where.AND;
    expect(and).toHaveLength(2);
    expect(and[0]).toEqual({ organizationId: "org-a" });
    expect(and[1]).toEqual({ organizationId: "org-x" }); // never overwritten/dropped
  });
});

describe("applyTenantReadScope — BYPASS STORE (group 5, D-05)", () => {
  const scopedOps = ["findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy", "updateMany", "deleteMany"];

  for (const operation of scopedOps) {
    it(`${operation} with bypass store → args unmodified`, () => {
      const args: any = { where: { deletedAt: null } };
      const out = applyTenantReadScope({ model: "Workspace", operation, args, store: BYPASS_STORE });
      expect(out).toBeNull();
      expect(args.where).toEqual({ deletedAt: null }); // untouched
    });
  }
});

describe("applyTenantReadScope — ABSENT STORE (group 6, jobs/boot)", () => {
  const scopedOps = ["findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy", "updateMany", "deleteMany"];

  for (const operation of scopedOps) {
    it(`${operation} with store undefined → args unmodified (Pitfall-8-safe skip)`, () => {
      const args: any = { where: { id: "w1" } };
      const out = applyTenantReadScope({ model: "Workspace", operation, args, store: undefined });
      expect(out).toBeNull();
      expect(args.where).toEqual({ id: "w1" });
    });
  }
});

describe("applyTenantReadScope — NON-TENANT MODELS (group 7)", () => {
  it("User / SystemConfig / WidgetSession → args unmodified even with an active org store", () => {
    for (const model of ["User", "SystemConfig", "WidgetSession"]) {
      const args: any = { where: { id: "x" } };
      const out = applyTenantReadScope({ model, operation: "findMany", args, store: ORG_STORE });
      expect(out).toBeNull();
      expect(args.where).toEqual({ id: "x" });
    }
  });

  it("unknown/undefined model → args unmodified", () => {
    const out = applyTenantReadScope({
      model: undefined,
      operation: "findMany",
      args: {} as any,
      store: ORG_STORE,
    });
    expect(out).toBeNull();
  });
});

describe("TENANT_READ_MODELS INVENTORY (group 8)", () => {
  it("contains exactly the 26 direct non-null-org models (spot-assert all 26)", () => {
    const expected = [
      "ApiKey",
      "AgentSkill",
      "Archive",
      "ArchiveImportJob",
      "Chat",
      "ChatFolder",
      "ChatMessage",
      // DlpPattern EXCLUDED as of 185-05 CR-02: the extension's outer AND
      // would drop the default-org built-in rows from every non-default
      // org's scan (DLP fail-open); dlpPatternService carries the
      // org-explicit contract (orgs' customs OR isBuiltIn) itself —
      // documented class exemption (ProviderPreset/McpCatalogEntry pattern).
      "Document",
      "MCPConnection",
      "OcrJob",
      "OrganizationMember",
      "Project",
      "ProjectAccess",
      "Provider",
      "ProviderModel",
      "PushSubscription",
      "SynthesisRun",
      "UploadDraft",
      "Webhook",
      "Widget",
      "WidgetWorkspace",
      "Workspace",
      "WorkspaceAccess",
      "WorkspaceAgentConfig",
      "WorkspaceTemplate",
      "WorkspaceTokenUsage",
    ];
    // Phase 190 (SKIL-01 A1): AgentSkill joins the AND-merge (26 models).
    expect(TENANT_READ_MODELS.size).toBe(26);
    for (const name of expected) {
      expect(TENANT_READ_MODELS.has(name)).toBe(true);
    }
    // And nothing beyond the 26:
    expect([...TENANT_READ_MODELS].sort()).toEqual(expected.sort());
  });

  it("does NOT contain User, Role, SystemConfig, WidgetSession, Memory, DocumentChunk, DlpPattern", () => {
    for (const name of ["User", "Role", "SystemConfig", "WidgetSession", "Memory", "DocumentChunk", "DlpPattern"]) {
      expect(TENANT_READ_MODELS.has(name)).toBe(false);
    }
  });
});

describe("DEFAULT-ORG FALLBACK (group 9 — extension-only rule)", () => {
  it("store with EMPTY organizationId string → org filter uses DEFAULT_ORG_ID", () => {
    const out = applyTenantReadScope({
      model: "Workspace",
      operation: "findMany",
      args: {},
      store: { organizationId: "", bypass: false },
    });

    expect((out as any).where.AND[0]).toEqual({ organizationId: DEFAULT_ORG_ID });
    // Comment (pinned by this assertion): the empty-org → DEFAULT_ORG_ID
    // fallback is ONLY legal inside the extension (single-tenant air-gap
    // equivalence arm, absent-store family). It is NEVER legal in the auth
    // path — tenantContextMiddleware 404s on unresolvable membership (D-02);
    // a fail-open default-org escalation is the RESEARCH Anti-Pattern.
  });
});