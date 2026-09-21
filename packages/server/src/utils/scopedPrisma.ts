// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * tenantScope — Prisma $extends query component: defense-in-depth read scoping
 * over the direct non-null-org models (Phase 185, SAAS-04b / D-03).
 *
 * Contract (pinned by scopedPrisma.test.ts + the tenantScopeSpike integration
 * suite — the mandatory prisma#3398 empirical verdict):
 *  - Top-level READ `where` on TENANT_READ_MODELS is AND-merged with the ALS
 *    store's organizationId. AND-merge composes — caller filters (incl.
 *    deletedAt) survive; a caller-supplied organizationId coexists inside the
 *    AND, it is never overwritten or dropped.
 *  - Relation-filter queries (where: { project: {...} }) are protected BY THE
 *    TOP-LEVEL AND: the extension cannot rewrite nested include/select
 *    subtrees (Prisma docs constraint, prisma#3398), but the injected
 *    top-level organizationId already excludes cross-org rows — demonstrated
 *    empirically on real PG in tenantScopeSpike.integration.test.ts.
 *  - findUnique / findUniqueOrThrow / upsert are PK-keyed (WhereUniqueInput
 *    cannot carry the extra filter) → SKIPPED BY DESIGN. The documented
 *    escape hatch; Plan 02 adds the route-level findUnique grep-gate forcing
 *    org assertions on tenant models.
 *  - create / createMany stay out per D-04 (schema @default + explicit set at
 *    the ~250 call sites — no extension-side org injection on writes).
 *  - Bypass store ({ bypass: true }) or ABSENT store (jobs/boot/seeds run
 *    outside ALS) → args pass through unmodified. The absent-store skip is
 *    what keeps global retention/reaper semantics intact (Pitfall-8-safe).
 *  - DEFAULT_ORG_ID fallback for an empty-string org is EXTENSION-ONLY
 *    (single-tenant air-gap equivalence) — never legal in the auth path
 *    (RESEARCH Anti-Patterns: fail-open org resolution).
 */

import { Prisma } from "@prisma/client";
import { DEFAULT_ORG_ID } from "@simmetric-chat/shared";
import { getTenantContext, type TenantStore } from "./tenantContext";

/**
 * Models carrying a DIRECT non-null organizationId column (schema.prisma
 * verified this session — 26 models). EXCLUDED: User/Role (global identity,
 * 182 D-01), SystemConfig (nullable-org geometry — Phase 183 owns it),
 * WidgetSession (no org column), Memory/DocumentChunk (Tier-B transitive
 * scoping via workspace/document), DlpPattern (CR-02, 185-05: the
 * extension's outer AND would exclude the DEFAULT-org built-in rows from
 * every non-default org's scan — DLP would fail open for PHI. Built-ins are
 * GLOBAL safety rails; dlpPatternService.getActivePatterns/listPatterns now
 * carry the org-explicit contract themselves
 * (isEnabled AND (organizationId = org OR isBuiltIn)) and the
 * mutation-route org assertions stay fail-closed — the explicit service
 * filter is the D-03 primary mechanism here, mirroring the
 * ProviderPreset/McpCatalogEntry documented class exemption).
 */
export const TENANT_READ_MODELS = new Set<string>([
  "ApiKey",
  "Archive",
  "ArchiveImportJob",
  "Chat",
  "ChatFolder",
  "ChatMessage",
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
  // Phase 190 (SKIL-01 A1): AgentSkill joins the AND-merge — custom skills are
  // org-created at the route (organizationId set explicitly on create) and
  // seeded builtin rows carry the default org, so no DlpPattern-class exemption
  // entry is needed. Cross-org custom reads fail closed via the AND-merge.
  "AgentSkill",
]);

/** Read + org-pinnable write ops (updateMany/deleteMany carry where). */
const TENANT_SCOPED_OPERATIONS = new Set<string>([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/**
 * Pure decision helper — the single source of the extension's semantics so the
 * unit matrix (scopedPrisma.test.ts) can pin the exact contract without a
 * client. Returns the args to pass downstream, or null to signal "skip".
 */
export function applyTenantReadScope({
  model,
  operation,
  args,
  store,
}: {
  model?: string;
  operation: string;
  args: { where?: unknown } & Record<string, unknown>;
  store?: TenantStore;
}): Record<string, unknown> | null {
  if (
    !model ||
    !TENANT_READ_MODELS.has(model) ||
    !store ||
    store.bypass ||
    !TENANT_SCOPED_OPERATIONS.has(operation)
  ) {
    return null; // skip — pass args through unmodified
  }

  // AND-merge (compose, never replace): caller where incl. deletedAt survives;
  // a caller-supplied organizationId coexists inside the AND — never dropped.
  const orgFilter = { organizationId: store.organizationId || DEFAULT_ORG_ID };
  return {
    ...args,
    where: { AND: [orgFilter, args.where ?? {}] },
  };
}

/**
 * The $extends factory. Composed ONCE on the singleton (utils/prisma.ts) so
 * every existing `import prisma from "../utils/prisma"` call site flows
 * through the scoped extension.
 */
export function tenantScope() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scoped = applyTenantReadScope({
              model,
              operation,
              args: args as { where?: unknown } & Record<string, unknown>,
              store: getTenantContext(),
            });
            if (scoped === null) {
              return query(args);
            }
            return query(scoped as typeof args);
          },
        },
      },
    }),
  );
}