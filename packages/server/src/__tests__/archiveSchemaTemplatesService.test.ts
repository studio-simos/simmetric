// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Schema Templates Service unit tests.
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
  listTemplates,
  getTemplate,
  createTemplate,
  applyTemplate,
  seedBuiltInTemplates,
} from "../services/archiveSchemaTemplatesService";

describe("archiveSchemaTemplatesService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("listTemplates", () => {
    it("returns templates ordered by isBuiltIn desc then name asc", async () => {
      const mockTemplates = [
        { id: "t1", name: "Built-in A", isBuiltIn: true },
        { id: "t2", name: "Custom B", isBuiltIn: false },
      ];
      (prisma.archiveSchemaTemplate.findMany as jest.Mock).mockResolvedValue(mockTemplates);
      const result = await listTemplates("archive-1");
      expect(result).toEqual(mockTemplates);
      expect(prisma.archiveSchemaTemplate.findMany).toHaveBeenCalledWith({
        where: { OR: [{ archiveId: null }, { archiveId: "archive-1" }] },
        orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
      });
    });

    it("works without archiveId filter", async () => {
      (prisma.archiveSchemaTemplate.findMany as jest.Mock).mockResolvedValue([]);
      await listTemplates();
      expect(prisma.archiveSchemaTemplate.findMany).toHaveBeenCalledWith({
        where: { OR: [{ archiveId: null }, { archiveId: undefined }] },
        orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
      });
    });
  });

  describe("getTemplate", () => {
    it("returns a template by ID", async () => {
      const template = { id: "t1", name: "Test" };
      (prisma.archiveSchemaTemplate.findUnique as jest.Mock).mockResolvedValue(template);
      const result = await getTemplate("t1");
      expect(result).toEqual(template);
      expect(prisma.archiveSchemaTemplate.findUnique).toHaveBeenCalledWith({ where: { id: "t1" } });
    });
  });

  describe("createTemplate", () => {
    it("creates a template with config and pageTypes", async () => {
      const data = {
        name: "Custom",
        description: "My template",
        config: { agentPersona: "balanced" as const },
        pageTypes: [{ name: "Note", requiredSections: [], optionalSections: [] }],
        archiveId: "archive-1",
      };
      (prisma.archiveSchemaTemplate.create as jest.Mock).mockResolvedValue({ id: "t-new", ...data });
      const result = await createTemplate(data);
      expect(prisma.archiveSchemaTemplate.create).toHaveBeenCalledWith({
        data: {
          name: "Custom",
          description: "My template",
          config: data.config,
          pageTypes: data.pageTypes,
          archiveId: "archive-1",
        },
      });
      expect(result.name).toBe("Custom");
    });

    it("handles optional fields", async () => {
      const data = {
        name: "Minimal",
        config: {},
      };
      (prisma.archiveSchemaTemplate.create as jest.Mock).mockResolvedValue({ id: "t-min", ...data });
      await createTemplate(data);
      expect(prisma.archiveSchemaTemplate.create).toHaveBeenCalledWith({
        data: {
          name: "Minimal",
          description: null,
          config: {},
          // Omitted (undefined) rather than null: Prisma treats undefined as
          // "leave the Json column at its default" — null would be JsonNull.
          pageTypes: undefined,
          archiveId: null,
        },
      });
    });
  });

  describe("applyTemplate", () => {
    it("copies template config to archive config", async () => {
      const template = { id: "t1", name: "Research", config: { agentPersona: "conservative" } };
      (prisma.archiveSchemaTemplate.findUnique as jest.Mock).mockResolvedValue(template);
      (prisma.archiveConfig.upsert as jest.Mock).mockResolvedValue({ id: "cfg-1", archiveId: "archive-1" });
      const result = await applyTemplate("archive-1", "t1");
      expect(prisma.archiveConfig.upsert).toHaveBeenCalledWith({
        where: { archiveId: "archive-1" },
        create: { archiveId: "archive-1", config: template.config },
        update: { config: template.config },
      });
      expect(result).toEqual(template);
    });

    it("throws when template not found", async () => {
      (prisma.archiveSchemaTemplate.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(applyTemplate("archive-1", "missing")).rejects.toThrow("Template not found");
    });
  });

  describe("seedBuiltInTemplates", () => {
    it("returns existing templates if already seeded", async () => {
      const existing = [{ id: "t1", name: "Research", isBuiltIn: true }];
      (prisma.archiveSchemaTemplate.findMany as jest.Mock).mockResolvedValue(existing);
      const result = await seedBuiltInTemplates();
      expect(result).toEqual(existing);
      expect(prisma.archiveSchemaTemplate.create).not.toHaveBeenCalled();
    });

    it("creates built-in templates when none exist", async () => {
      (prisma.archiveSchemaTemplate.findMany as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: "t1", name: "Research", isBuiltIn: true },
          { id: "t2", name: "Project", isBuiltIn: true },
          { id: "t3", name: "Personal", isBuiltIn: true },
        ]);
      (prisma.archiveSchemaTemplate.create as jest.Mock).mockImplementation((args: any) =>
        Promise.resolve({ id: `id-${args.data.name}`, ...args.data })
      );
      const result = await seedBuiltInTemplates();
      expect(result.length).toBe(3);
      expect(prisma.archiveSchemaTemplate.create).toHaveBeenCalledTimes(3);
      const names = result.map((r: any) => r.name);
      expect(names).toContain("Research");
      expect(names).toContain("Project");
      expect(names).toContain("Personal");
    });
  });
});
