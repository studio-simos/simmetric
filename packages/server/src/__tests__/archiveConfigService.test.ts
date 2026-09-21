// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Config Service unit tests.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

import prisma from "../utils/prisma";
import {
  getArchiveConfig,
  setArchiveConfig,
  deleteArchiveConfig,
  getSynthesisOverrides,
} from "../services/archiveConfigService";

describe("archiveConfigService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getArchiveConfig", () => {
    it("returns undefined when no config exists", async () => {
      (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue(null);
      const result = await getArchiveConfig("archive-1");
      expect(result).toBeUndefined();
      expect(prisma.archiveConfig.findUnique).toHaveBeenCalledWith({ where: { archiveId: "archive-1" } });
    });

    it("returns parsed config when record exists", async () => {
      const config = { agentPersona: "balanced", purpose: "Test" };
      (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue({ id: "cfg-1", archiveId: "archive-1", config });
      const result = await getArchiveConfig("archive-1");
      expect(result).toEqual(config);
    });
  });

  describe("setArchiveConfig", () => {
    it("validates input and upserts record", async () => {
      // Phase 187 Pitfall-4 ripple: rawSourcesImmutable is REQUIRED in the
      // z.infer output type (.default(true)) — fixtures carry it explicitly.
      const config = { agentPersona: "balanced" as const, purpose: "Test", rawSourcesImmutable: true };
      (prisma.archiveConfig.upsert as jest.Mock).mockResolvedValue({ id: "cfg-1", archiveId: "archive-1", config });
      const result = await setArchiveConfig("archive-1", config);
      expect(prisma.archiveConfig.upsert).toHaveBeenCalledWith({
        where: { archiveId: "archive-1" },
        create: { archiveId: "archive-1", config },
        update: { config },
      });
      expect(result.config).toEqual(config);
    });

    it("throws on invalid config shape", async () => {
      const invalidConfig = { agentPersona: "invalid_value" } as any;
      await expect(setArchiveConfig("archive-1", invalidConfig)).rejects.toThrow();
    });

    // CR-01 (Phase 187 code review) — read-merge-write at the write seam:
    // a panel-shaped payload WITHOUT localLLMOnly but WITH schemaPrompt must
    // preserve the stored localLLMOnly (synthesis D-15 PHI gate input) and
    // the template-applied governance keys. The Zod parse drops unknown keys,
    // so the merge must read the PREVIOUS stored blob and spread the payload
    // over it (payload keys win; absent keys survive).
    it("CR-01 regression: payload without localLLMOnly but with schemaPrompt preserves stored localLLMOnly", async () => {
      const stored = { agentPersona: "balanced", localLLMOnly: true, schemaPrompt: "Old guidance" };
      (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue({
        id: "cfg-1",
        archiveId: "archive-1",
        config: stored,
      });
      (prisma.archiveConfig.upsert as jest.Mock).mockImplementation(async ({ create, update }) => update);

      // Panel-shaped payload: only the 5 UI-managed fields — no localLLMOnly.
      const payload = {
        agentPersona: "exploratory" as const,
        purpose: "New purpose",
        scope: "New scope",
        linkingDensity: { min: 0.01, max: 0.2 },
        schemaPrompt: "New guidance",
        rawSourcesImmutable: true,
      };
      await setArchiveConfig("archive-1", payload);

      expect(prisma.archiveConfig.findUnique).toHaveBeenCalledWith({
        where: { archiveId: "archive-1" },
        select: { config: true },
      });
      expect(prisma.archiveConfig.upsert).toHaveBeenCalledTimes(1);
      const arg = (prisma.archiveConfig.upsert as jest.Mock).mock.calls[0][0];
      expect(arg.where).toEqual({ archiveId: "archive-1" });
      // The PHI gate flag survives the panel save.
      expect(arg.update.config.localLLMOnly).toBe(true);
      expect(arg.create.config.localLLMOnly).toBe(true);
      // Payload-managed keys win over the stored blob.
      expect(arg.update.config.agentPersona).toBe("exploratory");
      expect(arg.update.config.schemaPrompt).toBe("New guidance");
      expect(arg.update.config.purpose).toBe("New purpose");
    });

    it("CR-01 regression: payload preserves template governance keys (namingConvention, requiredFrontmatter, lintRules)", async () => {
      const stored = {
        agentPersona: "conservative",
        namingConvention: { pattern: "^[a-z0-9-]+$", message: "Kebab-case" },
        requiredFrontmatter: { title: { type: "string", required: true } },
        lintRules: [{ type: "section_required", severity: "error", config: { section: "Abstract" } }],
        localLLMOnly: false,
      };
      (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue({
        id: "cfg-2",
        archiveId: "archive-1",
        config: stored,
      });
      (prisma.archiveConfig.upsert as jest.Mock).mockImplementation(async ({ create, update }) => update);

      const payload = { agentPersona: "balanced" as const, rawSourcesImmutable: true };
      await setArchiveConfig("archive-1", payload);

      const merged = (prisma.archiveConfig.upsert as jest.Mock).mock.calls[0][0].update.config;
      expect(merged.namingConvention).toEqual({ pattern: "^[a-z0-9-]+$", message: "Kebab-case" });
      expect(merged.requiredFrontmatter).toEqual({ title: { type: "string", required: true } });
      expect(merged.lintRules).toEqual([{ type: "section_required", severity: "error", config: { section: "Abstract" } }]);
      expect(merged.localLLMOnly).toBe(false);
      expect(merged.agentPersona).toBe("balanced");
    });

    it("CR-01 regression: first-time write (no stored row) still writes the validated payload", async () => {
      (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.archiveConfig.upsert as jest.Mock).mockImplementation(async ({ create }) => create);

      const payload = { agentPersona: "balanced" as const, schemaPrompt: "First save", rawSourcesImmutable: true };
      await setArchiveConfig("archive-1", payload);

      const arg = (prisma.archiveConfig.upsert as jest.Mock).mock.calls[0][0];
      expect(arg.create.config.agentPersona).toBe("balanced");
      expect(arg.create.config.schemaPrompt).toBe("First save");
    });
  });

  describe("deleteArchiveConfig", () => {
    it("deletes the archive config record", async () => {
      (prisma.archiveConfig.delete as jest.Mock).mockResolvedValue({ id: "cfg-1" });
      await deleteArchiveConfig("archive-1");
      expect(prisma.archiveConfig.delete).toHaveBeenCalledWith({ where: { archiveId: "archive-1" } });
    });
  });

  describe("getSynthesisOverrides", () => {
    it("returns only synthesis-relevant fields", async () => {
      const config = {
        linkingDensity: { min: 0.01, max: 0.15 },
        agentPersona: "conservative" as const,
        maintenanceSchedule: "weekly",
        purpose: "Research",
        scope: "Internal",
        namingConvention: { pattern: "^.*$", message: "Any" },
      };
      (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue({ id: "cfg-1", archiveId: "archive-1", config });
      const result = await getSynthesisOverrides("archive-1");
      expect(result).toEqual({
        linkingDensity: { min: 0.01, max: 0.15 },
        agentPersona: "conservative",
        maintenanceSchedule: "weekly",
        purpose: "Research",
        scope: "Internal",
      });
    });

    it("returns undefined when no config exists", async () => {
      (prisma.archiveConfig.findUnique as jest.Mock).mockResolvedValue(null);
      const result = await getSynthesisOverrides("archive-1");
      expect(result).toBeUndefined();
    });
  });
});
