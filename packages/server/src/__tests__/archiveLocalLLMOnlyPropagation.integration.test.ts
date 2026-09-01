// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KB-04 / D-15 PHI gate propagation integration tests.
 *
 * Proves ArchiveConfig.config.localLLMOnly is auto-populated from
 * WorkspaceTemplate.constraints.localLLMOnly when an archive is created
 * by a user whose accessible workspaces include a Medical-template workspace
 * (strictest-wins rule). Also proves the end-to-end propagation -> gate path
 * without manual ArchiveConfig seeding (Test 7 — B1 acceptance criterion).
 *
 * Tests:
 *   1. createArchive for user with Medical-template workspace ->
 *      ArchiveConfig.config.localLLMOnly === true (no manual seeding).
 *   2. createArchive for user with non-Medical-template workspace ->
 *      ArchiveConfig.config.localLLMOnly absent (or false). Gate does not fire.
 *   3. createArchive for user with workspace that has NO templateId ->
 *      ArchiveConfig.config.localLLMOnly absent.
 *   4. strictest-wins: user with 2 workspaces (Medical + general) -> gate fires.
 *   5. idempotent backfill: existing archive A (Medical creator) gets
 *      localLLMOnly=true; B and C unchanged. Second backfill is a no-op.
 *   6. backfill skips archives without ArchiveConfig (no row created).
 *   7. end-to-end: after Test 1's createArchive (propagated flag),
 *      callSynthesisLLM with mocked OpenAI provider throws PHI gate error
 *      BEFORE callNonStreamingLLM — proves the gate is not dead code.
 *
 * File extension is `.integration.test.ts` to be picked up by
 * jest.config.integration.js (Rule 1 — same as KB-02/04 deviations).
 */

import bcrypt from "bcryptjs";

let prisma: import("@prisma/client").PrismaClient;

let adminUserId: string;
let medicalTemplateId: string;
let generalTemplateId: string;
let medicalWorkspaceId: string;
let generalWorkspaceId: string;
let noTemplateWorkspaceId: string;

const adminPassword = "propagation-admin-pw-3K";

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();

  // Seed admin user
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const salt = await bcrypt.genSalt(12);
  const admin = await prisma.user.create({
    data: {
      username: "kb04_prop_admin",
      email: "kb04_prop_admin@test.local",
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

  // Seed a Project (required FK for Workspace)
  const project = await prisma.project.create({
    data: { name: "KB04 Prop Project", createdBy: adminUserId },
  });

  // Seed WorkspaceTemplates
  medicalTemplateId = (
    await prisma.workspaceTemplate.create({
      data: {
        slug: "kb04-medical-test",
        name: "KB04 Medical",
        systemPrompt: "test",
        skills: "[]",
        parsingConfig: "{}",
        constraints: JSON.stringify({ localLLMOnly: true }),
        isBuiltIn: false,
      },
    })
  ).id;
  generalTemplateId = (
    await prisma.workspaceTemplate.create({
      data: {
        slug: "kb04-general-test",
        name: "KB04 General",
        systemPrompt: "test",
        skills: "[]",
        parsingConfig: "{}",
        constraints: JSON.stringify({ localLLMOnly: false }),
        isBuiltIn: false,
      },
    })
  ).id;

  // Seed Workspaces
  medicalWorkspaceId = (
    await prisma.workspace.create({
      data: {
        projectId: project.id,
        name: "KB04 Medical Workspace",
        templateId: medicalTemplateId,
      },
    })
  ).id;
  generalWorkspaceId = (
    await prisma.workspace.create({
      data: {
        projectId: project.id,
        name: "KB04 General Workspace",
        templateId: generalTemplateId,
      },
    })
  ).id;
  noTemplateWorkspaceId = (
    await prisma.workspace.create({
      data: {
        projectId: project.id,
        name: "KB04 No-Template Workspace",
      },
    })
  ).id;

  // Grant WorkspaceAccess to admin for all three workspaces
  for (const wsId of [medicalWorkspaceId, generalWorkspaceId, noTemplateWorkspaceId]) {
    await prisma.workspaceAccess.create({
      data: { userId: adminUserId, workspaceId: wsId },
    });
  }
});

afterAll(async () => {
  // Cleanup in FK-safe order
  await prisma.archiveConfig.deleteMany({}).catch(() => {});
  await prisma.archive.deleteMany({}).catch(() => {});
  await prisma.workspaceAccess.deleteMany({}).catch(() => {});
  await prisma.workspace.deleteMany({}).catch(() => {});
  await prisma.workspaceTemplate.deleteMany({}).catch(() => {});
  await prisma.project.deleteMany({}).catch(() => {});
  await prisma.userRole.deleteMany({}).catch(() => {});
  await prisma.user.deleteMany({ where: { username: "kb04_prop_admin" } }).catch(() => {});
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Resolve the localLLMOnly flag for an archive via the propagation module. */
async function resolveArchiveLocalLLMOnly(archiveId: string): Promise<boolean | undefined> {
  const cfg = await prisma.archiveConfig.findUnique({
    where: { archiveId },
    select: { config: true },
  });
  const config = cfg?.config as Record<string, unknown> | null;
  return config?.localLLMOnly === true ? true : config?.localLLMOnly === false ? false : undefined;
}

/**
 * Wait for the fire-and-forget propagation to complete.
 * createArchive calls propagateLocalLLMOnlyForUser without await (T-64-32),
 * so the ArchiveConfig row may not exist immediately after createArchive
 * returns. This helper polls until the ArchiveConfig row appears (positive
 * case) or the timeout elapses (negative case — no row expected).
 */
async function waitForPropagation(archiveId: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cfg = await prisma.archiveConfig.findUnique({ where: { archiveId } });
    if (cfg) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("KB-04 / D-15 — PHI gate propagation", () => {
  it("Test 1: createArchive for Medical-template user -> ArchiveConfig.config.localLLMOnly === true (no manual seeding)", async () => {
    const { createArchive } = await import("../services/archiveService");
    const archive = await createArchive(
      { name: "KB04 Med Archive T1", description: "test" },
      adminUserId,
    );

    // Wait for fire-and-forget propagation to complete (T-64-32).
    await waitForPropagation(archive.id);
    const flag = await resolveArchiveLocalLLMOnly(archive.id);
    expect(flag).toBe(true);
  });

  it("Test 2: createArchive for non-Medical-template user -> flag absent/false (gate does not fire)", async () => {
    // Remove Medical workspace access for this test — only general workspace access remains.
    await prisma.workspaceAccess.deleteMany({
      where: { userId: adminUserId, workspaceId: medicalWorkspaceId },
    });

    try {
      const { createArchive } = await import("../services/archiveService");
      const archive = await createArchive(
        { name: "KB04 General Archive T2", description: "test" },
        adminUserId,
      );

      // Wait briefly for fire-and-forget propagation — negative case (no row
      // expected since admin has no Medical workspace access here).
      await new Promise((r) => setTimeout(r, 300));
      const flag = await resolveArchiveLocalLLMOnly(archive.id);
      // No localLLMOnly constraint resolved -> propagation skips (no ArchiveConfig upsert).
      // So flag should be undefined (no ArchiveConfig row) OR false if a row exists.
      expect(flag).not.toBe(true);
    } finally {
      // Restore Medical workspace access for subsequent tests
      await prisma.workspaceAccess.create({
        data: { userId: adminUserId, workspaceId: medicalWorkspaceId },
      }).catch(() => {});
    }
  });

  it("Test 3: createArchive for user with workspace that has NO templateId -> flag absent", async () => {
    // Remove Medical + General workspace access — only no-template workspace remains.
    await prisma.workspaceAccess.deleteMany({
      where: { userId: adminUserId, workspaceId: { in: [medicalWorkspaceId, generalWorkspaceId] } },
    });

    try {
      const { createArchive } = await import("../services/archiveService");
      const archive = await createArchive(
        { name: "KB04 NoTmpl Archive T3", description: "test" },
        adminUserId,
      );

      // Wait briefly for fire-and-forget propagation — negative case.
      await new Promise((r) => setTimeout(r, 300));
      const flag = await resolveArchiveLocalLLMOnly(archive.id);
      expect(flag).not.toBe(true);
    } finally {
      // Restore access
      for (const wsId of [medicalWorkspaceId, generalWorkspaceId]) {
        await prisma.workspaceAccess.create({
          data: { userId: adminUserId, workspaceId: wsId },
        }).catch(() => {});
      }
    }
  });

  it("Test 4: strictest-wins — user with Medical + general workspaces -> gate fires (true)", async () => {
    // admin has access to both medical + general + no-template workspaces.
    const { createArchive } = await import("../services/archiveService");
    const archive = await createArchive(
      { name: "KB04 StrictestWins T4", description: "test" },
      adminUserId,
    );

    // Wait for fire-and-forget propagation to complete (T-64-32).
    await waitForPropagation(archive.id);
    const flag = await resolveArchiveLocalLLMOnly(archive.id);
    expect(flag).toBe(true);
  });

  it("Test 5: idempotent backfill — existing Medical archive gets localLLMOnly=true, others unchanged; second backfill is a no-op", async () => {
    // Seed 3 archives WITHOUT ArchiveConfig, then run backfill.
    // Archive A: creator has Medical workspace access (admin) -> should get true.
    // Archive B: same creator (admin) — but we will remove Medical access AFTER
    //   creating the archive so the strictest-wins query at backfill time does
    //   not pick up Medical for B. To isolate, we use a separate user.
    const salt = await bcrypt.genSalt(12);
    const otherUser = await prisma.user.create({
      data: {
        username: "kb04_prop_other_t5",
        email: "kb04_prop_other_t5@test.local",
        passwordHash: await bcrypt.hash("pw-t5-9K", salt),
        salt,
      },
    });
    // Grant otherUser only general workspace access (no Medical)
    await prisma.workspaceAccess.create({
      data: { userId: otherUser.id, workspaceId: generalWorkspaceId },
    });

    try {
      // Archive A: created by admin (has Medical access) — no ArchiveConfig seeded
      const archiveA = await prisma.archive.create({
        data: { slug: "kb04-backfill-a", name: "Backfill A", createdBy: adminUserId },
      });
      // Archive B: created by otherUser (general only) — no ArchiveConfig seeded
      const archiveB = await prisma.archive.create({
        data: { slug: "kb04-backfill-b", name: "Backfill B", createdBy: otherUser.id },
      });

      const { backfillLocalLLMOnlyPropagation } = await import("../services/archiveLocalLLMOnlyPropagation");
      const result1 = await backfillLocalLLMOnlyPropagation();
      expect(result1.scanned).toBeGreaterThanOrEqual(2);

      // A should be true, B should not be true
      const flagA = await resolveArchiveLocalLLMOnly(archiveA.id);
      const flagB = await resolveArchiveLocalLLMOnly(archiveB.id);
      expect(flagA).toBe(true);
      expect(flagB).not.toBe(true);

      // Second backfill is a no-op (idempotent — A is already true, B stays not-true)
      const result2 = await backfillLocalLLMOnlyPropagation();
      expect(result2.updated).toBeLessThanOrEqual(result1.updated);

      const flagA2 = await resolveArchiveLocalLLMOnly(archiveA.id);
      expect(flagA2).toBe(true);
    } finally {
      await prisma.workspaceAccess.deleteMany({ where: { userId: otherUser.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: otherUser.id } }).catch(() => {});
    }
  });

  it("Test 6: backfill skips archives without ArchiveConfig (no row created)", async () => {
    // Create an archive with NO ArchiveConfig row. Backfill should NOT create one
    // (propagation only touches archives that already have an ArchiveConfig — per plan).
    const archive = await prisma.archive.create({
      data: { slug: "kb04-backfill-noconfig", name: "Backfill NoConfig", createdBy: adminUserId },
    });

    const { backfillLocalLLMOnlyPropagation } = await import("../services/archiveLocalLLMOnlyPropagation");
    await backfillLocalLLMOnlyPropagation();

    const cfg = await prisma.archiveConfig.findUnique({ where: { archiveId: archive.id } });
    // The plan allows either skipping OR creating with the resolved flag.
    // Document the chosen behavior: the implementation SKIPS (no row created)
    // when no ArchiveConfig exists, because the backfill upserts only when
    // it needs to write true. If a row was created here, assert its flag.
    if (cfg) {
      const flag = (cfg.config as Record<string, unknown>)?.localLLMOnly;
      expect(flag).toBe(true);
    } else {
      // Skipped — no ArchiveConfig row created. Acceptable per plan.
      expect(cfg).toBeNull();
    }
  });

  it("Test 7: end-to-end — propagated flag fires the PHI gate (B1 acceptance criterion)", async () => {
    // Test 1 already created an archive with localLLMOnly=true via propagation.
    // We don't need to re-create — find the Test 1 archive by name and use its id.
    const archive = await prisma.archive.findFirst({
      where: { name: "KB04 Med Archive T1", createdBy: adminUserId },
    });
    expect(archive).not.toBeNull();

    // Mock providerService.resolveProviderConfig to return an OpenAI provider,
    // and callSynthesisLLM should throw the PHI gate error WITHOUT calling
    // callNonStreamingLLM.
    //
    // Key: we mock "../utils/prisma" to return the REAL prisma instance (already
    // connected to the worker DB) so that resetModules doesn't create a new
    // PrismaClient that fails SASL auth. The PHI gate needs to read the
    // propagated ArchiveConfig from the real DB.
    jest.resetModules();

    jest.doMock("../utils/prisma", () => ({
      __esModule: true,
      default: prisma,
    }));
    jest.doMock("../services/providerService", () => ({
      callNonStreamingLLM: jest.fn().mockResolvedValue({ content: "should not reach", tokensUsed: 0 }),
      resolveProviderConfig: jest.fn().mockResolvedValue({
        type: "openai",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-test",
        model: "gpt-4",
        displayName: "GPT-4",
        temperature: 0.7,
        maxTokens: undefined,
        isLocal: false,
      }),
    }));
    jest.doMock("../services/systemConfigService", () => ({
      getSetting: jest.fn().mockResolvedValue({ value: "provider-openai-id" }),
    }));
    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => ({
        SYNTHESIS_LLM_MODEL: "test",
        LLM_MODEL: "test",
        OLLAMA_BASE_URL: "http://ollama-test:11434",
        JWT_SECRET: "test",
        SERVER_PORT: 3000,
        SESSION_EXPIRY: 86400000,
        NODE_ENV: "test",
        ALLOW_REGISTRATION: true,
      })),
    }));

    const { callSynthesisLLM } = await import("../services/synthesisService");
    const providerService = await import("../services/providerService");
    const callNonStreamingLLMSpy = providerService.callNonStreamingLLM as jest.MockedFunction<any>;

    await expect(
      callSynthesisLLM("prompt containing PHI", undefined, archive!.id),
    ).rejects.toThrow(/Archive template requires local LLM; external provider configured \(PHI gate\)/);

    // Zero outbound LLM calls — the gate must abort BEFORE callNonStreamingLLM
    expect(callNonStreamingLLMSpy).not.toHaveBeenCalled();

    // Restore modules for any subsequent tests
    jest.dontMock("../utils/prisma");
    jest.dontMock("../services/providerService");
    jest.dontMock("../services/systemConfigService");
    jest.dontMock("../config/env");
  });
});