// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passthrough type mirrors the mock factory's any-accepting signature (documented pre-existing pattern across route suites)
    withSoftDelete: (where: any) => where,
  };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn(() => ({ value: "localfs" })),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));

// Phase 184 (SAAS-03): provider mock surface lives in a shared helper so the
// hoisted jest.mock factory and the per-test handles reference the same fns.
jest.mock("../services/storageProvider", () =>
  require("./helpers/mockStorageProvider").mockStorageProviderModule,
);

jest.mock("fs", () => ({
  // fs is used by index.ts (legacy arms) AND many transitive modules — keep
  // the real impl for everything except the read-existence/copy pair the
  // handlers touch; those are controlled per-test via these handles.
  ...jest.requireActual("fs"),
  existsSync: jest.fn(jest.requireActual("fs").existsSync),
  readFileSync: jest.fn(jest.requireActual("fs").readFileSync),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import fs from "fs";
import { mockProviderGet, mockProviderExists, mockGetStorageProvider } from "./helpers/mockStorageProvider";

const app = createApp();
const mockFsExistsSync = fs.existsSync as unknown as jest.Mock;
const mockFsReadFileSync = fs.readFileSync as unknown as jest.Mock;

const USER_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"; // UUID (dash-bearing)
const TIMESTAMP = "1700000000000";
const FILENAME = `${USER_ID}-${TIMESTAMP}.webp`;
const ORG_ID = "org-00000000-0000-0000-0000-000000000001";
const AVATAR_KEY = `${ORG_ID}/avatars/128/${FILENAME}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockProviderExists.mockResolvedValue(false);
  mockProviderGet.mockResolvedValue(Buffer.from("x"));
  // Default: the user's live membership resolves the org (row's-org rule)
  (prisma.organizationMember.findFirst as jest.Mock).mockImplementation((args: {
    where?: { userId?: string };
  }) => {
    if (args?.where?.userId === USER_ID) {
      return Promise.resolve({ organizationId: ORG_ID });
    }
    return Promise.resolve(null);
  });
  // Default: legacy fs arm misses (provider-first path is the one under test)
  mockFsExistsSync.mockReturnValue(false);
});

describe("GET /avatars/:size/:file — provider-first download endpoint (D-03)", () => {
  test("serves provider bytes byte-equal with image/webp content type", async () => {
    mockProviderExists.mockResolvedValue(true);
    mockProviderGet.mockResolvedValue(Buffer.from("provider-bytes-123"));

    const res = await request(app).get(`/avatars/128/${FILENAME}`);

    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("provider-bytes-123");
    expect(res.headers["content-type"]).toMatch(/image\/webp/);
    expect(mockProviderExists).toHaveBeenCalledWith(AVATAR_KEY);
    expect(mockProviderGet).toHaveBeenCalledWith(AVATAR_KEY);
    // row's-org rule: the key prefix comes from the LOOKED-UP membership row
    expect(mockGetStorageProvider).toHaveBeenCalledWith(ORG_ID);
  });

  test("legacy file serves via the fs arm when the provider misses (coexistence)", async () => {
    mockProviderExists.mockResolvedValue(false);
    mockFsExistsSync.mockImplementation((p: string) => p.includes("storage/uploads/avatars"));
    mockFsReadFileSync.mockImplementation(((p: string) => {
      if (p.includes("storage/uploads/avatars")) return Buffer.from("legacy-bytes");
      throw new Error("unexpected read");
    }) as typeof fs.readFileSync);

    const res = await request(app).get(`/avatars/128/${FILENAME}`);

    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("legacy-bytes");
    expect(res.headers["content-type"]).toMatch(/image\/webp/);
  });

  test("both arms miss → 404 (static 404 shape, no JSON body contract)", async () => {
    mockProviderExists.mockResolvedValue(false);

    const res = await request(app).get(`/avatars/128/${FILENAME}`);

    expect(res.status).toBe(404);
  });

  test("traversal payload → rejected (never a read)", async () => {
    // path.basename strips the ".."-segments, but the ".." remnant or the
    // size allowlist must reject before any provider/fs resolution.
    const res = await request(app).get(`/avatars/128/..%2F..%2Fsecrets`);
    expect([400, 404]).toContain(res.status);
    expect(mockProviderGet).not.toHaveBeenCalled();
    expect(mockGetStorageProvider).not.toHaveBeenCalled();

    // Dot-dot INSIDE the sanitized name is rejected outright
    const res2 = await request(app).get(`/avatars/128/x..y-${TIMESTAMP}.webp`);
    expect([400, 404]).toContain(res2.status);
    expect(mockProviderGet).not.toHaveBeenCalled();
  });

  test("non-listed size → 400 allowlist rejection", async () => {
    const res = await request(app).get(`/avatars/512/${FILENAME}`);
    expect(res.status).toBe(400);
    expect(mockProviderGet).not.toHaveBeenCalled();
  });

  test("failure probe: provider throws → fs fallback serves or 404s — never a 500", async () => {
    mockProviderExists.mockRejectedValue(new Error("MinIO down"));

    const res = await request(app).get(`/avatars/128/${FILENAME}`);

    expect(res.status).not.toBe(500);
    expect([200, 404]).toContain(res.status);
  });

  test("failure probe: provider RESOLUTION throws (s3 misconfigured) → fs fallback, never a 500", async () => {
    mockGetStorageProvider.mockRejectedValueOnce(new Error("s3 provider requires S3_BUCKET via system config"));

    const res = await request(app).get(`/avatars/128/${FILENAME}`);

    expect(res.status).not.toBe(500);
  });

  test("membership lookup miss → default-org key attempt, then fs fallback", async () => {
    (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue(null);
    mockProviderExists.mockResolvedValue(false);
    mockFsExistsSync.mockReturnValue(false);

    const res = await request(app).get(`/avatars/128/${FILENAME}`);

    expect(res.status).toBe(404);
    // Key attempted with the default-org fallback prefix
    expect(mockProviderExists).toHaveBeenCalledWith(
      `00000000-0000-0000-0000-000000000000/avatars/128/${FILENAME}`,
    );
  });
});

describe("GET /branding/:file — provider-first download endpoint (D-04)", () => {
  test("serves provider bytes with a global (default-org) key when unauthenticated", async () => {
    mockProviderExists.mockResolvedValue(true);
    mockProviderGet.mockResolvedValue(Buffer.from("branding-bytes"));

    const res = await request(app).get("/branding/app-icon.png");

    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("branding-bytes");
    expect(mockProviderExists).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000000/branding/app-icon.png",
    );
  });

  test("content type is extension-mapped (the enterprise upload route writes app-icon.{png,svg,ico,webp} and the frontend renders via <img>)", async () => {
    mockProviderExists.mockResolvedValue(true);
    mockProviderGet.mockResolvedValue(Buffer.from("svg-bytes"));

    const png = await request(app).get("/branding/app-icon.png");
    expect(png.headers["content-type"]).toMatch(/image\/png/);
    const svg = await request(app).get("/branding/app-icon.svg");
    expect(svg.headers["content-type"]).toMatch(/image\/svg\+xml/);
    const ico = await request(app).get("/branding/app-icon.ico");
    expect(ico.headers["content-type"]).toMatch(/image\/x-icon/);
    const webp = await request(app).get("/branding/app-icon.webp");
    expect(webp.headers["content-type"]).toMatch(/image\/webp/);
  });

  test("missing branding file (both arms) → 404", async () => {
    mockProviderExists.mockResolvedValue(false);

    const res = await request(app).get("/branding/app-icon.png");

    expect(res.status).toBe(404);
  });

  test("branding traversal payload → rejected (never a read)", async () => {
    const res = await request(app).get("/branding/..%2F..%2Fsecrets");
    expect([400, 404]).toContain(res.status);
    expect(mockProviderGet).not.toHaveBeenCalled();
  });

  test("provider throw → fs fallback or 404, never a 500", async () => {
    mockProviderExists.mockRejectedValue(new Error("MinIO down"));

    const res = await request(app).get("/branding/app-icon.png");

    expect(res.status).not.toBe(500);
  });
});

describe("avatar upload legacy suite placeholders (kept from the pre-phase suite)", () => {
  it.todo("should validate MIME type whitelist for avatar upload");
  it.todo("should enforce 512 KB file size limit");
  it.todo("should resize avatar to 32px, 64px, 128px WebP variants");
  it.todo("should sanitize avatar filename to userId-timestamp format");
  it.todo("should delete old avatar files when new avatar is uploaded");
  it.todo("should delete avatar files and clear DB field on avatar removal");
});