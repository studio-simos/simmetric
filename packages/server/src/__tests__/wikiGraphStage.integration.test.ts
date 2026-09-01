// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * wikiGraphStage.integration.test.ts — Plan 153-02 Task 1 (TDD).
 *
 * End-to-end integration test for `runWikiGraphPipeline(archiveId, userId, runId)`:
 * the orchestrator that wires `buildArchiveGraph` → `detectCommunities` →
 * `generateWikiMarkdown` → `deleteGeneratedPages` (idempotent) →
 * `archivePageService.createPage` (per article) and updates the reused
 * `SynthesisRun` row (PROCESSING → COMPLETED/FAILED).
 *
 * Resolves the locked decisions D-01 (admin-triggered, extends synthesis
 * infrastructure), D-02 (reuse ArchivePage + existing read paths), D-03
 * (generated frontmatter + idempotent hard-delete), and the research
 * resolutions A2 (separate no-LLM pipeline — no BudgetTracker) and A6
 * (createdBy = triggering admin userId).
 *
 * Real Postgres (jest.config.integration.js): the worker DB is cloned from
 * the migration-seeded template, so `searchVectorMulti` (Phase 151
 * inheritance) and the `archive_pages` unique index on (archiveId, slug)
 * behave as in production. The throwaway Postgres container on :5434 with
 * a CREATEDB user + the `vector` extension (per server AGENTS.md + the
 * 152-01 deviation) is the documented integration-test environment.
 */

import bcrypt from "bcryptjs";

let prisma: import("@prisma/client").PrismaClient;

let adminUserId: string;
let archiveId: string;
let runId: string;
const adminPassword = "wiki-graph-admin-pw-153";

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();

  // Seed an admin user + grant the admin role (role + perms come from the
  // seeded template). The admin userId doubles as `createdBy` for generated
  // pages (A6 — the triggering admin's userId is the real signal; the
  // generated:true frontmatter is the machine-generated marker).
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const salt = await bcrypt.genSalt(12);
  const admin = await prisma.user.create({
    data: {
      username: "wiki_graph_admin_153",
      email: "wiki_graph_admin_153@test.local",
      passwordHash: await bcrypt.hash(adminPassword, salt),
      salt,
    },
  });
  adminUserId = admin.id;
  if (adminRole) {
    await prisma.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id },
    });
  }
});

afterAll(async () => {
  // Best-effort cleanup. Generated graph-wiki rows are HARD-deleted by
  // deleteGeneratedPages during the test, but a failed run may leave rows;
  // deleteMany (hard) clears them. Archive + user follow.
  try {
    if (archiveId) {
      await prisma.archivePage.deleteMany({
        where: { archiveId, category: "graph-wiki" },
      });
      await prisma.synthesisRun.deleteMany({ where: { archiveId } });
      await prisma.archive.deleteMany({ where: { id: archiveId } });
    }
  } catch {
    /* best-effort */
  }
  try {
    await prisma.user.delete({ where: { id: adminUserId } });
  } catch {
    /* best-effort */
  }
  await prisma.$disconnect();
});

/**
 * Seed an archive with N pages whose `wikilinks` form a connected graph.
 * Pages are created directly via prisma (not via archivePageService.createPage)
 * so the test fixtures don't themselves write .md files or trigger git —
 * the graph-wiki pipeline is what we're testing, not createPage.
 */
async function seedArchiveWithPages(
  name: string,
  pages: Array<{ slug: string; title: string; wikilinks: string[] }>,
): Promise<string> {
  const archive = await prisma.archive.create({
    data: {
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      createdBy: adminUserId,
    },
  });
  for (const p of pages) {
    await prisma.archivePage.create({
      data: {
        archiveId: archive.id,
        slug: p.slug,
        title: p.title,
        category: "notes",
        bodyText: `# ${p.title}\n\nBody.`,
        contentHash: `hash-${p.slug}`,
        wikilinks: p.wikilinks,
        createdBy: adminUserId,
      },
    });
  }
  return archive.id;
}

async function createRunRow(archiveId: string): Promise<string> {
  const run = await prisma.synthesisRun.create({
    data: {
      archiveId,
      status: "PENDING",
      createdBy: adminUserId,
      name: `Wiki Graph · integration · ${new Date().toISOString()}`,
    },
  });
  return run.id;
}

describe("runWikiGraphPipeline — integration (Plan 153-02)", () => {
  beforeEach(() => {
    // Avoid stale module cache between tests so runWikiGraphPipeline picks
    // up the worker DATABASE_URL set by jest.setup.integration.ts.
    jest.resetModules();
  });

  it("end-to-end: creates graph-wiki ArchivePage rows with generated frontmatter + searchVectorMulti", async () => {
    // 3 pages with a wikilink triangle (A→B, B→C, C→A) — guarantees ≥1
    // community + ≥1 god node + the index article (the pipeline writes
    // index + communities + god nodes).
    archiveId = await seedArchiveWithPages("Wiki Graph E2E", [
      { slug: "alpha", title: "Alpha", wikilinks: ["beta", "gamma"] },
      { slug: "beta", title: "Beta", wikilinks: ["alpha", "gamma"] },
      { slug: "gamma", title: "Gamma", wikilinks: ["alpha", "beta"] },
    ]);
    runId = await createRunRow(archiveId);

    const { runWikiGraphPipeline } = await import("../services/wikiGraphStage");
    const result = await runWikiGraphPipeline(archiveId, adminUserId, runId);

    expect(result.status).toBe("COMPLETED");
    expect(result.pagesWritten).toBeGreaterThan(0);

    // The SynthesisRun row is updated to COMPLETED with pagesWritten.
    const run = await prisma.synthesisRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe("COMPLETED");
    expect(run?.pagesWritten).toBe(result.pagesWritten);

    // Generated rows exist with the right category + frontmatter shape.
    const generated = await prisma.archivePage.findMany({
      where: { archiveId, category: "graph-wiki", deletedAt: null },
    });
    expect(generated.length).toBeGreaterThan(0);

    // At least one row carries the index-article frontmatter (the index
    // article's slug is derived from its title by createPage, so we don't
    // assert on slug `_index` — we assert the frontmatter shape that the
    // markdown writer emits for every article + the index's title marker).
    const indexRow = generated.find(
      (p) => p.title.includes("Knowledge Graph Index"),
    );
    expect(indexRow).toBeDefined();
    const idxFm = (indexRow!.frontmatter as Record<string, unknown>) ?? {};
    expect(idxFm.generated).toBe(true);
    expect(idxFm.generator).toBe("wiki-graph-ts");
    expect(idxFm.archiveId).toBe(archiveId);
    expect(idxFm.runId).toBe(runId);
    expect(typeof idxFm.generatedAt).toBe("string");

    // Every generated row carries the generator frontmatter (D-03).
    for (const row of generated) {
      const fm = (row.frontmatter as Record<string, unknown>) ?? {};
      expect(fm.generated).toBe(true);
      expect(fm.generator).toBe("wiki-graph-ts");
      expect(fm.archiveId).toBe(archiveId);
      expect(fm.runId).toBe(runId);
    }

    // createdBy is the triggering admin (A6).
    for (const row of generated) {
      expect(row.createdBy).toBe(adminUserId);
    }

    // searchVectorMulti is populated (Phase 151 inheritance — createPage's
    // setSearchVector writes it). NULL would mean createPage was bypassed.
    // Cast to ::text because Prisma cannot deserialize `tsvector` directly
    // (it's marked Unsupported in schema.prisma — archiveSoftDeleteLeak's
    // raw inserts follow the same ::text cast convention).
    type SvRow = { v: string | null };
    for (const row of generated) {
      const sv = await prisma.$queryRaw<SvRow[]>`
        SELECT "searchVectorMulti"::text AS v FROM "archive_pages" WHERE "id" = ${row.id}
      `;
      expect(sv[0]?.v).not.toBeNull();
      expect(sv[0]?.v).not.toBe("");
    }
  });

  it("idempotent re-run: prior graph-wiki rows are HARD-DELETED (deletedAt IS NULL on the new set)", async () => {
    // First run already created graph-wiki rows for `archiveId` in the
    // previous test. Capture their IDs, then re-run with a fresh run row.
    const firstRunIds = (
      await prisma.archivePage.findMany({
        where: { archiveId, category: "graph-wiki" },
        select: { id: true },
      })
    ).map((r) => r.id);
    expect(firstRunIds.length).toBeGreaterThan(0);

    const secondRunId = await createRunRow(archiveId);
    const { runWikiGraphPipeline } = await import("../services/wikiGraphStage");
    const result = await runWikiGraphPipeline(archiveId, adminUserId, secondRunId);
    expect(result.status).toBe("COMPLETED");

    // The new set of rows.
    const after = await prisma.archivePage.findMany({
      where: { archiveId, category: "graph-wiki" },
      select: { id: true, deletedAt: true },
    });

    // Count is the SAME (not doubled) — prior rows were hard-deleted, not
    // soft-deleted (soft-deletes would double the row count + leave
    // deletedAt set on the old set).
    expect(after.length).toBe(result.pagesWritten);

    // No row in the new set is soft-deleted (deletedAt is null — the hard
    // delete removed the prior rows entirely; the new rows are live).
    for (const row of after) {
      expect(row.deletedAt).toBeNull();
    }

    // Every prior row ID is GONE from the table (hard delete — not tombstoned).
    for (const oldId of firstRunIds) {
      const stillThere = await prisma.archivePage.findUnique({
        where: { id: oldId },
      });
      expect(stillThere).toBeNull();
    }
  });

  it("empty archive: skips gracefully with pagesWritten=0, status COMPLETED, no rows", async () => {
    const emptyArchiveId = await prisma.archive.create({
      data: {
        slug: "wiki-graph-empty-153",
        name: "Wiki Graph Empty 153",
        createdBy: adminUserId,
      },
    }).then((a) => a.id);
    const emptyRunId = await createRunRow(emptyArchiveId);

    try {
      const { runWikiGraphPipeline } = await import("../services/wikiGraphStage");
      const result = await runWikiGraphPipeline(emptyArchiveId, adminUserId, emptyRunId);
      expect(result.status).toBe("COMPLETED");
      expect(result.pagesWritten).toBe(0);

      const run = await prisma.synthesisRun.findUnique({ where: { id: emptyRunId } });
      expect(run?.status).toBe("COMPLETED");
      expect(run?.pagesWritten).toBe(0);

      const rows = await prisma.archivePage.findMany({
        where: { archiveId: emptyArchiveId, category: "graph-wiki" },
      });
      expect(rows).toHaveLength(0);
    } finally {
      try {
        await prisma.archivePage.deleteMany({
          where: { archiveId: emptyArchiveId, category: "graph-wiki" },
        });
        await prisma.synthesisRun.deleteMany({ where: { archiveId: emptyArchiveId } });
        await prisma.archive.deleteMany({ where: { id: emptyArchiveId } });
      } catch {
        /* best-effort */
      }
    }
  });

  it("CR-02 invariant: re-run on an archive that BECAME empty clears prior generated rows (deleteGeneratedPages before empty-graph guard)", async () => {
    // The CR-02 fix moved deleteGeneratedPages BEFORE the empty-graph guard.
    // This test exercises the exact regression path: an archive that HAD
    // generated graph-wiki rows (from a prior run with pages) is re-run AFTER
    // its authored pages are deleted — the new run is empty, but the stale
    // generated rows must be hard-deleted, not left visible in the UI.
    const crArchiveId = await prisma.archive.create({
      data: {
        slug: "wiki-graph-cr02-153",
        name: "Wiki Graph CR-02 153",
        createdBy: adminUserId,
      },
    }).then((a) => a.id);

    try {
      // 1. Seed 3 authored pages with wikilinks so the first run generates rows.
      for (const slug of ["cr-alpha", "cr-beta", "cr-gamma"]) {
        await prisma.archivePage.create({
          data: {
            archiveId: crArchiveId,
            slug,
            title: slug,
            category: "entities",
            bodyText: `# ${slug}\n\nLink: [[cr-beta]]`,
            contentHash: `hash-${slug}-${Date.now()}`,
            wikilinks: ["cr-beta"],
            createdBy: adminUserId,
          },
        });
      }

      // 2. First run — produces graph-wiki rows.
      const firstRunId = await createRunRow(crArchiveId);
      const { runWikiGraphPipeline } = await import("../services/wikiGraphStage");
      const first = await runWikiGraphPipeline(crArchiveId, adminUserId, firstRunId);
      expect(first.status).toBe("COMPLETED");
      const firstRows = await prisma.archivePage.findMany({
        where: { archiveId: crArchiveId, category: "graph-wiki" },
      });
      expect(firstRows.length).toBeGreaterThan(0);

      // 3. Delete the authored pages (the archive becomes empty).
      await prisma.archivePage.deleteMany({
        where: { archiveId: crArchiveId, category: "entities" },
      });

      // 4. Second run — the archive is now empty. The CR-02 invariant:
      //    deleteGeneratedPages runs BEFORE the empty-graph guard, so the
      //    prior generated rows are hard-deleted (0 remain), not left stale.
      const secondRunId = await createRunRow(crArchiveId);
      const second = await runWikiGraphPipeline(crArchiveId, adminUserId, secondRunId);
      expect(second.status).toBe("COMPLETED");
      expect(second.pagesWritten).toBe(0);

      const remainingRows = await prisma.archivePage.findMany({
        where: { archiveId: crArchiveId, category: "graph-wiki" },
      });
      expect(remainingRows).toHaveLength(0);
    } finally {
      try {
        await prisma.archivePage.deleteMany({ where: { archiveId: crArchiveId } });
        await prisma.synthesisRun.deleteMany({ where: { archiveId: crArchiveId } });
        await prisma.archive.deleteMany({ where: { id: crArchiveId } });
      } catch {
        /* best-effort */
      }
    }
  });

  it("deleteGeneratedPages helper: hard-deletes prior graph-wiki rows for the archive", async () => {
    // The previous tests already created graph-wiki rows for `archiveId`.
    // Call deleteGeneratedPages directly → expect 0 rows afterwards (hard
    // delete, not a soft-delete tombstone).
    const { deleteGeneratedPages } = await import("../services/archivePageService");
    const deletedCount = await deleteGeneratedPages(archiveId, "graph-wiki");
    expect(deletedCount).toBeGreaterThanOrEqual(0);

    const rows = await prisma.archivePage.findMany({
      where: { archiveId, category: "graph-wiki" },
    });
    expect(rows).toHaveLength(0);

    // And there are NO soft-deleted (deletedAt != null) graph-wiki rows
    // either — the hard delete removed them, not tombstoned them.
    const tombstoned = await prisma.archivePage.findMany({
      where: { archiveId, category: "graph-wiki", deletedAt: { not: null } },
    });
    expect(tombstoned).toHaveLength(0);
  });
});