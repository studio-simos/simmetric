// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Prisma mock factory — creates a deep-mocked Prisma client for unit tests.
 * Usage: const { prisma, resetAll } = createMockPrisma();
 */

export function createMockPrisma() {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    project: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    workspace: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    projectAccess: {
      findFirst: jest.fn(),
      // Phase 190 (SKIL-03): the skills list resolves the caller's
      // ProjectAccess-implied editor workspaces via findMany — the factory
      // needs the delegate or the routes suite crashes on the missing mock.
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    workspaceAccess: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      // Phase 189 (WSIS-03): grant/bulk endpoints upsert WorkspaceAccess —
      // the factory needs the delegate so workspaceAccess suites mock it.
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    // Phase 189 (WSIS-01): the personal-workspace service issues a
    // workspaceAgentConfig.upsert (POST /workspaces parity) inside its
    // transaction — the factory needs the delegate so personalWorkspace
    // suites mock it.
    workspaceAgentConfig: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    apiKey: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    role: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    permission: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    rolePermission: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    roleMenuSection: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    userRole: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
      // 182-REVIEW WR-01 fix: seed.ts's exists-path admin heal now probes the
      // user's actual admin-role holding via userRole.findFirst — unit tests
      // that drive prisma/seed.ts (seed.test.ts) go through this factory, so
      // the delegate must exist (bare jest.fn() → undefined findFirst result
      // → heals as "member", the conservative branch).
      findFirst: jest.fn(),
    },
    systemConfig: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    // Phase 182 (182-04 Task 2, Rule 1): ensureDefaultOrgMembership is wired
    // into all 6 core user-creation sites (182-03); unit tests that exercise
    // seed/seedService/auth paths hit db.organizationMember via the shared
    // mock factory — without these delegates the deep mock hands back
    // undefined and every such suite throws (TypeError reading 'findFirst').
    organization: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn(),
    },
    organizationMember: {
      findUnique: jest.fn(),
      // Phase 185 (185-02): routes now mount tenantContextMiddleware in the
      // chain (D-09) — the JWT arm resolves the org via findFirst here.
      // Default: a live default-org membership so single-org suites keep
      // their pre-tenant responses byte-identical ("1 org ⇒ behavior
      // unchanged" equivalence). Suites probing org-b override per-test.
      findFirst: jest.fn().mockResolvedValue({ organizationId: "org-default" }),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    widget: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    widgetWorkspace: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    widgetSession: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    // Phase 185 (185-05): the widgetLead.create CR-01 probe (internalWidget
    // suite) drives the POST /lead handler — the factory needs the delegate.
    widgetLead: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    mCPConnection: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      // quick 260918-qts (T-QTS-02): the DELETE /:entryId in-use guard probes
      // mCPConnection.count — the delegate must exist or the route crashes
      // with "count is not a function".
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      // Phase 195 (WR-01): the CAS pending→authorized transition rides
      // updateMany — default resolves { count: 1 } (CAS won).
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      delete: jest.fn(),
    },
    mcpCatalogEntry: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    providerPreset: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    provider: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    providerModel: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    ocrJob: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    chat: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    chatFolder: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    chatPin: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    chatMCPPin: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    chatMessage: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    workspaceTokenUsage: {
      aggregate: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    // Phase 207 (D-02): quota reset ledger delegate — suites stub the arms
    // they need; jest.fn() default keeps non-quota suites unchanged.
    quotaReset: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    archive: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    archivePage: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    archiveConfig: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    archiveSchemaTemplate: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    archiveImportJob: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    eventLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    backupLog: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    backupDestination: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    backupJob: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    document: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      // quick 260918-p3h (T-P3H-04 arm a): forwardToCollector's guarded
      // processing claim issues document.updateMany — the delegate must
      // exist or the route crashes with "updateMany is not a function".
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    documentChunk: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    ssoConfig: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    identityProvider: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    scimGroup: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    // Quick 260829-ony — DlpPattern CRUD (routes + pattern service unit tests).
    dlpPattern: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      // Phase 192 (Rule 1/2): seedBuiltinDlpPatterns (seed.ts + boot
      // seedService) upserts the built-in rows keyed (organizationId, name).
      upsert: jest.fn(),
    },
    // Phase 204 (DEBT-SW-05): the DlpEntity delegate — the document text-edit
    // route's re-scan arm calls dlpEntityService.deleteEntityMap
    // (prisma.dlpEntity.deleteMany) to refresh stale entity rows; without the
    // delegate the deep mock hands back undefined and the documentsTextEdit
    // suite crashes with "deleteMany is not a function" (the missing-delegate
    // class documented in server AGENTS.md).
    dlpEntity: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    // Phase 190 (SKIL-01, Pitfall 7): the AgentSkill delegate — Plan 02
    // (skillService/skills.routes/registry suites) and Plan 03
    // (chatStreamSkillDlp) drive prisma.agentSkill.* through this factory;
    // without it the deep mock hands back undefined and those suites crash
    // (the "Cannot read properties of undefined" class documented in
    // server AGENTS.md for missing delegates).
    agentSkill: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    // Phase 202 (PLGM-01/02): the PluginInstall delegate — the 202-01 tracer
    // battery (pluginManager.test.ts: installFromZip + loadManagedPlugins)
    // and the 202-02+ route/loader suites drive prisma.pluginInstall.*
    // through this factory; without it the deep mock hands back undefined
    // and those suites crash (the missing-delegate class above).
    pluginInstall: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  } as any;

  function resetAll() {
    for (const model of Object.values(prisma)) {
      if (typeof model === "object" && model !== null) {
        for (const fn of Object.values(model)) {
          if (jest.isMockFunction(fn)) {
            fn.mockReset();
          }
        }
      }
    }
  }

  return { prisma, resetAll };
}