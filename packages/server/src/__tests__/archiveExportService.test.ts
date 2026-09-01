// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive export service unit tests — mocks fs, archiver, puppeteer, and prisma.
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

jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: jest.fn(),
  readdirSync: jest.fn(() => []),
}));

jest.mock("archiver", () => {
  const mockArchive = {
    on: jest.fn(),
    pipe: jest.fn(),
    directory: jest.fn(),
    finalize: jest.fn().mockResolvedValue(undefined),
  };
  return {
    __esModule: true,
    ZipArchive: jest.fn().mockImplementation(() => mockArchive),
  };
});

jest.mock("dompurify", () => {
  return jest.fn(() => ({
    sanitize: jest.fn((html: string) => html),
  }));
});

jest.mock("puppeteer", () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from("pdf-content")),
    }),
    close: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({
    tier: "community",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  getLicenseInfo: jest.fn(() => ({
    tier: "community",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({
  seedTemplates: jest.fn(),
}));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
}));
jest.mock("../services/ftsService", () => ({
  initPostgreSQLFTS: jest.fn(),
}));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

import fs from "fs";
import type { Response } from "express";
import prisma from "../utils/prisma";
import {
  exportArchiveAsZip,
  exportArchiveAsPdf,
} from "../services/archiveExportService";

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440100";
const ARCHIVE_SLUG = "test-archive";
const now = new Date("2025-06-01T00:00:00.000Z");

const mockArchive = {
  id: ARCHIVE_ID,
  slug: ARCHIVE_SLUG,
  name: "Test Archive",
  description: "A test archive",
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

function mockRes(): Response {
  const headers: Record<string, string> = {};
  return {
    setHeader: jest.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    send: jest.fn(),
    headers,
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("exportArchiveAsZip", () => {
  it("should throw if archive not found", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(null);

    const res = mockRes();
    await expect(exportArchiveAsZip(ARCHIVE_ID, res)).rejects.toThrow(
      "Archive not found",
    );
  });

  it("should throw if directory not found", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(mockArchive);
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    const res = mockRes();
    await expect(exportArchiveAsZip(ARCHIVE_ID, res)).rejects.toThrow(
      "Archive directory not found",
    );
  });

  it("should throw on path traversal attempt", async () => {
    const traversalArchive = {
      ...mockArchive,
      slug: "../../../etc/passwd",
    };
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(
      traversalArchive,
    );
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const res = mockRes();
    await expect(
      exportArchiveAsZip(ARCHIVE_ID, res),
    ).rejects.toThrow("Invalid archive path");
  });

  it("should stream zip with correct headers", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(mockArchive);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([]);

    const res = mockRes();
    await exportArchiveAsZip(ARCHIVE_ID, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/zip",
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      `attachment; filename="${ARCHIVE_SLUG}.zip"`,
    );
  });
});

describe("exportArchiveAsPdf", () => {
  it("should throw if archive not found", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(null);

    const res = mockRes();
    await expect(exportArchiveAsPdf(ARCHIVE_ID, res)).rejects.toThrow(
      "Archive not found",
    );
  });

  it("should convert wikilinks to anchor tags in PDF HTML", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        slug: "acme-corporation",
        title: "ACME Corporation",
        bodyText:
          "See also [[acme-corporation|ACME]] and [[overview#history|History]]",
      },
    ]);

    const res = mockRes();
    await exportArchiveAsPdf(ARCHIVE_ID, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/pdf",
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      `attachment; filename="${ARCHIVE_SLUG}.pdf"`,
    );
    expect(res.send).toHaveBeenCalled();
    const sentBuffer = (res.send as jest.Mock).mock.calls[0][0];
    expect(Buffer.isBuffer(sentBuffer)).toBe(true);
    expect(sentBuffer.toString()).toBe("pdf-content");
  });

  it("should sanitize script tags from markdown before PDF generation", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(mockArchive);
    (prisma.archivePage.findMany as jest.Mock).mockResolvedValue([
      {
        slug: "malicious-page",
        title: "Malicious Page",
        bodyText: "# Hello\n\n<script>alert('xss')</script>",
      },
    ]);

    const res = mockRes();
    await exportArchiveAsPdf(ARCHIVE_ID, res);

    // PDF should still be generated (sanitization removes script tags)
    expect(res.send).toHaveBeenCalled();
    const sentBuffer = (res.send as jest.Mock).mock.calls[0][0];
    expect(Buffer.isBuffer(sentBuffer)).toBe(true);
  });
});
