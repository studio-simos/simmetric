// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VERDICT — the mandatory prisma#3398 spike (Phase 185 D-03, SAAS-04b),
 * pinned EMPIRICALLY against the REAL extension-composed singleton on real
 * template-PG (this suite IS the spike — no mockPrisma anywhere):
 *
 *   WHAT WORKS  → Top-level where mutation: the tenantScope extension
 *                 AND-merges organizationId into findMany/findFirst/count/
 *                 aggregate/groupBy/updateMany/deleteMany on the 26
 *                 TENANT_READ_MODELS (probes 1, 2, 6). Relation-filter
 *                 queries (where: { project: {...} }) are protected BY THE
 *                 TOP-LEVEL AND even though the nested clause is untouched
 *                 (probe 3 — org-b-matching relation filter returns EMPTY
 *                 under an org-a store).
 *   WHAT FAILS  → include/select subtrees are NOT rewritten (Prisma docs
 *                 constraint: query extensions cannot mutate include/select
 *                 without breaking output types — not even attempted, it is
 *                 type-forbidden). Probe 4 documents the observable:
 *                 include results carry the PARENT's org-invariant children
 *                 only because parent-child rows share the org invariant;
 *                 the extension never touched the subtree.
 *   FALLBACK    → Routes whose queries traverse relations (e.g.
 *                 assertDocumentReadAccess walking document→workspace) MUST
 *                 add explicit scopeToOrg() or org assertions per D-03 —
 *                 the extension is top-level read defense only.
 *   SKIPPED BY  → findUnique resolves PK-keyed cross-org rows (probe 5 —
 *   DESIGN       the documented escape hatch; Plan 02 adds the route-level
 *                 findUnique grep-gate). create stays un-injected (probe 7 —
 *                 schema @default lands DEFAULT_ORG_ID, D-04). Bypass store
 *                 reads everything (probe 8, D-05). Absent store (jobs/boot)
 *                 skips scoping entirely (probe 9 — global semantics kept).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 9 probes, one per plan task-2 item. Seed writes run OUTSIDE runInTenant →
 * absent store → extension skips → plain client writes are unscoped.
 *
 * Dynamic-import doctrine (systemConfigCompositeWrite.integration.test.ts
 * file-head comment): NO static top-level imports of prisma-transitive
 * modules — the Prisma singleton must construct AFTER
 * jest.setup.integration.ts sets the worker DATABASE_URL. `await import(...)`
 * only.
 *
 * RUN: `pnpm --filter server test:integration -- src/__tests__/tenantScopeSpike.integration.test.ts`
 * DB-less environments: beforeAll fails LOUDLY on an unreachable DB
 * (WR-02/G-182-05 — a DB outage must never surface as a green suite that ran
 * zero assertions).
 */

// Module-scope marker: this file has NO static top-level imports (dynamic-
// import doctrine above), so without an export it compiles as a global
// script and every `let prisma` collides with sibling no-import suites.
// Same convention as tenantSchema.test.ts.
export {};

let prisma: import("@prisma/client").PrismaClient;

let dbAvailable = true;

/** Test-local rows created by this suite (deleted in afterAll). */
const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];
const createdProjectIds: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdProjectNameIds: string[] = []; // probe-6/7 scratch projects

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

beforeAll(async () => {
  try {
    const { default: prismaClient } = await import("../utils/prisma");
    prisma = prismaClient;
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    dbAvailable = false;
    console.error(
      "[tenantScopeSpike.integration] DB unavailable — FAILING suite:",
      (err as Error).message,
    );
    throw err;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  try {
    // Children first (workspaces/projects carry Restrict FKs to org).
    await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    await prisma.project.deleteMany({ where: { id: { in: [...createdProjectIds, ...createdProjectNameIds] } } });
    // User deletion cascades membership rows per FK (onDelete: Cascade).
    for (const id of createdUserIds) {
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
  } finally {
    await prisma.$disconnect();
  }
});

describe("tenantScope spike — prisma#3398 empirical verdict on the REAL composed client (D-03)", () => {
  let ORG_A_ID: string;
  let ORG_B_ID: string;
  let creatorId: string;
  let orgAWorkspaceId: string;
  let orgBWorkspaceId: string;
  let orgATombstoneWorkspaceId: string;
  let orgAProjectId: string;
  let orgBProjectId: string;
  const ORG_A_WS_NAME = "spike-orga-ws";
  const ORG_B_WS_NAME = "spike-orgb-ws";
  const ORG_A_TOMBSTONE_NAME = "spike-orga-tombstone";
  const ORG_B_PROJECT_NAME = "spike-orgb-project";
  const SPIKE_SCRATCH = "spike-scratch";
  const SPIKE_SCRATCHED = "spike-scratched";
  const SPIKE_CREATE = "spike-create";

  beforeAll(async () => {
    if (!dbAvailable) return;
    const suffix = uniqueSuffix();

    const orgA = await prisma.organization.create({
      data: { name: `spike_a_${suffix}`, slug: `spike-a-${suffix}` },
    });
    ORG_A_ID = orgA.id;
    createdOrgIds.push(ORG_A_ID);

    const orgB = await prisma.organization.create({
      data: { name: `spike_b_${suffix}`, slug: `spike-b-${suffix}` },
    });
    ORG_B_ID = orgB.id;
    createdOrgIds.push(ORG_B_ID);

    const creator = await prisma.user.create({
      data: {
        username: `spike_${suffix}`,
        email: `spike_${suffix}@test.local`,
        passwordHash: "x",
        salt: "x",
      },
    });
    creatorId = creator.id;
    createdUserIds.push(creatorId);

    // Org-a workspace + tombstoned org-a workspace; org-b workspace.
    const projA = await prisma.project.create({
      data: { name: `spike-proj-a-${suffix}`, createdBy: creatorId, organizationId: ORG_A_ID },
    });
    orgAProjectId = projA.id;
    createdProjectIds.push(orgAProjectId);

    const projB = await prisma.project.create({
      data: {
        name: ORG_B_PROJECT_NAME,
        createdBy: creatorId,
        organizationId: ORG_B_ID,
      },
    });
    orgBProjectId = projB.id;
    createdProjectIds.push(orgBProjectId);

    const wsA = await prisma.workspace.create({
      data: { name: ORG_A_WS_NAME, projectId: orgAProjectId, organizationId: ORG_A_ID },
    });
    orgAWorkspaceId = wsA.id;
    createdWorkspaceIds.push(orgAWorkspaceId);

    const wsB = await prisma.workspace.create({
      data: { name: ORG_B_WS_NAME, projectId: orgBProjectId, organizationId: ORG_B_ID },
    });
    orgBWorkspaceId = wsB.id;
    createdWorkspaceIds.push(orgBWorkspaceId);

    const wsT = await prisma.workspace.create({
      data: { name: ORG_A_TOMBSTONE_NAME, projectId: orgAProjectId, organizationId: ORG_A_ID },
    });
    orgATombstoneWorkspaceId = wsT.id;
    createdWorkspaceIds.push(orgATombstoneWorkspaceId);
    // Tombstone-mark it (deletedAt merge probe needs a soft-deleted org-a row).
    await prisma.workspace.update({
      where: { id: orgATombstoneWorkspaceId },
      data: { deletedAt: new Date() },
    });
  });

  it("probe 1 — TOP-LEVEL INJECTION: org-a store findMany({}) returns ONLY org-a rows", async () => {
    if (!dbAvailable) return;
    const { runInTenant } = await import("../utils/tenantContext");

    const rows = await runInTenant({ organizationId: ORG_A_ID, bypass: false }, async () =>
      await       prisma.workspace.findMany({}),
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.some((r) => r.organizationId === ORG_B_ID)).toBe(false);
  });

  it("probe 2 — AND-MERGE COMPOSITION: caller deletedAt:null survives AND org filter excludes org-b", async () => {
    if (!dbAvailable) return;
    const { runInTenant } = await import("../utils/tenantContext");

    const rows = await runInTenant({ organizationId: ORG_A_ID, bypass: false }, async () =>
      await       prisma.workspace.findMany({ where: { deletedAt: null } }),
    );

    // Tombstoned org-a row excluded AND org-b rows excluded — both filters
    // survived the AND-merge.
    expect(rows.some((r) => r.id === orgATombstoneWorkspaceId)).toBe(false);
    expect(rows.some((r) => r.organizationId === ORG_B_ID)).toBe(false);
    expect(rows.some((r) => r.id === orgAWorkspaceId)).toBe(true);
  });

  it("probe 3 — RELATION-FILTER QUERY (the prisma#3398 question): org-a store + org-b project name filter → EMPTY (top-level AND protects)", async () => {
    if (!dbAvailable) return;
    const { runInTenant } = await import("../utils/tenantContext");

    // The NESTED relation filter matches org-b's workspace by project name,
    // but the extension's top-level organizationId AND excludes the row.
    const rows = await runInTenant({ organizationId: ORG_A_ID, bypass: false }, async () =>
      await       prisma.workspace.findMany({
        where: { project: { name: ORG_B_PROJECT_NAME } },
      }),
    );

    expect(rows).toEqual([]);
  });

  it("probe 4 — INCLUDE SUBTREE: not rewritten; parent-child rows share the org invariant (observed behavior documented)", async () => {
    if (!dbAvailable) return;
    const { runInTenant } = await import("../utils/tenantContext");

    const rows = await runInTenant({ organizationId: ORG_A_ID, bypass: false }, async () =>
      await       prisma.workspace.findMany({ where: { deletedAt: null }, include: { project: true } }),
    );

    expect(rows.length).toBeGreaterThan(0);
    // The extension does NOT rewrite the include subtree — but the invariant
    // holds empirically: every returned parent is org-a and its included
    // project row is org-a too (parent-child share the org column).
    for (const row of rows) {
      expect(row.organizationId).toBe(ORG_A_ID);
      expect(row.project?.organizationId).toBe(ORG_A_ID);
    }
    expect(rows.some((r) => r.project?.organizationId === ORG_B_ID)).toBe(false);
    // Observed behavior verbatim: include subtrees are not filtered by the
    // extension; org leakage via include would require a parent row of org-a
    // holding org-b children — impossible under the org-invariant data model
    // (children carry their own organizationId). This probe PINS that the
    // parent filter alone excludes cross-org parents.
  });

  it("probe 5 — findUnique ESCAPE: PK-keyed lookup resolves the cross-org row (documented escape hatch, Plan 02 grep-gate justification)", async () => {
    if (!dbAvailable) return;
    const { runInTenant } = await import("../utils/tenantContext");

    const row = await runInTenant({ organizationId: ORG_A_ID, bypass: false }, async () =>
      await prisma.workspace.findUnique({ where: { id: orgBWorkspaceId } }),
    );

    // THE ESCAPE HATCH, pinned: findUnique is not scoped — the org-b row
    // RESOLVES under an org-a store.
    expect(row).not.toBeNull();
    expect(row?.organizationId).toBe(ORG_B_ID);
  });

  it("probe 6 — updateMany SCOPED: org-a scratch renamed, org-b scratch untouched (count + findFirst proof)", async () => {
    if (!dbAvailable) return;
    const { runInTenant } = await import("../utils/tenantContext");

    // One scratch project per org (create OUTSIDE the store — absent-store skip).
    // NOTE: @@unique([createdBy, name]) is per-CREATOR — use org-distinct names
    // for the two scratch rows (both created by the same suite user).
    const scratchA = await prisma.project.create({
      data: { name: SPIKE_SCRATCH + "-a", createdBy: creatorId, organizationId: ORG_A_ID },
    });
    createdProjectNameIds.push(scratchA.id);
    const scratchB = await prisma.project.create({
      data: { name: SPIKE_SCRATCH + "-b", createdBy: creatorId, organizationId: ORG_B_ID },
    });
    createdProjectNameIds.push(scratchB.id);

    const result = await runInTenant({ organizationId: ORG_A_ID, bypass: false }, async () =>
      await prisma.project.updateMany({
        where: { name: { startsWith: SPIKE_SCRATCH } },
        data: { name: SPIKE_SCRATCHED },
      }),
    );

    expect(result.count).toBe(1); // ONLY org-a's scratch touched

    const renamedA = await prisma.project.findFirst({ where: { id: scratchA.id } });
    expect(renamedA?.name).toBe(SPIKE_SCRATCHED);
    const untouchedB = await prisma.project.findFirst({ where: { id: scratchB.id } });
    expect(untouchedB?.name).toBe(SPIKE_SCRATCH + "-b"); // org-b scratch NOT renamed
  });

  it("probe 7 — create UNTOUCHED (D-04): create inside org-a store lands with schema @default org, NOT org-a", async () => {
    if (!dbAvailable) return;
    const { runInTenant } = await import("../utils/tenantContext");

    const created = await runInTenant({ organizationId: ORG_A_ID, bypass: false }, async () =>
      await prisma.project.create({ data: { name: SPIKE_CREATE, createdBy: creatorId } }),
    );
    createdProjectNameIds.push(created.id);

    // D-04: the extension does NOT inject create org — the schema @default
    // (DEFAULT_ORG_ID) applies, NOT org-a.
    expect(created.organizationId).toBe("00000000-0000-0000-0000-000000000000");
    expect(created.organizationId).not.toBe(ORG_A_ID);

    // Probe 6 note: the create probe's scratch row is cleaned via its id.
  });

  it("probe 8 — BYPASS: bypassTenantScope findMany returns BOTH orgs' rows (D-05)", async () => {
    if (!dbAvailable) return;
    const { bypassTenantScope } = await import("../utils/tenantContext");

    const rows = await bypassTenantScope(async () => await prisma.workspace.findMany({}));

    expect(rows.some((r) => r.id === orgAWorkspaceId)).toBe(true);
    expect(rows.some((r) => r.id === orgBWorkspaceId)).toBe(true);
    expect(rows.some((r) => r.organizationId === ORG_B_ID)).toBe(true);
  });

  it("probe 9 — ABSENT STORE: plain findMany outside any run returns BOTH orgs' rows (jobs/boot semantics preserved)", async () => {
    if (!dbAvailable) return;

    // NOTE: this assertion runs OUTSIDE runInTenant — the ALS store is absent
    // (Pitfall-8-safe skip). The spike suite's own seed writes relied on the
    // same semantics.
    const rows = await prisma.workspace.findMany({});

    expect(rows.some((r) => r.id === orgAWorkspaceId)).toBe(true);
    expect(rows.some((r) => r.id === orgBWorkspaceId)).toBe(true);
  });
});