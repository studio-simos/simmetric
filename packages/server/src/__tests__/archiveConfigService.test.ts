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
      const config = { agentPersona: "balanced" as const, purpose: "Test" };
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
