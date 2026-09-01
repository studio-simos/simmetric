// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 70 — Plan 70-01 Task 1 (TDD RED→GREEN).
 *
 * Direct unit tests for the two new middleware helpers:
 *   - assertNonAdminUploadAllowed  (D-02/D-03 toggle OR, fail-closed parse)
 *   - assertArchiveAccess           (D-06 archive ownership, global Archive)
 *
 * These tests exercise the helpers in isolation (no Express, no supertest) so
 * the OR-semantics and the `createdBy === userId || isAdmin` ownership rule are
 * pinned independently of the route integration tests in uploads.test.ts /
 * documentUpload.test.ts (SC-1a/1b/2a/2b, added in Task 2).
 *
 * Mocks:
 *   - systemConfigService.getSetting → per-key flip for `ALLOW_NON_ADMIN_UPLOAD`
 *   - utils/prisma.archive.findUnique → per-test ownership fixture
 *   - utils/auth.isAdmin → explicit admin flag per case
 */
import "./helpers/setupEnv";

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(),
  seedConfigDefaults: jest.fn(),
}));

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    archive: { findUnique: jest.fn() },
  },
  withSoftDelete: (where: unknown) => where,
}));

import { assertNonAdminUploadAllowed } from "../middleware/uploadGate";
import { assertArchiveAccess } from "../middleware/archiveAccess";
import { getSetting } from "../services/systemConfigService";
import prisma from "../utils/prisma";

const REQ: any = {};

describe("assertNonAdminUploadAllowed (D-02/D-03)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("admin bypasses the toggle (returns true) without reading SystemConfig", async () => {
    const allowed = await assertNonAdminUploadAllowed(
      REQ,
      { allowMemberUploads: false },
      true,
    );
    expect(allowed).toBe(true);
    // D-02: admin shortcut — getSetting must NOT be called
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("non-admin: ALLOW_NON_ADMIN_UPLOAD=false + allowMemberUploads=false → denied", async () => {
    (getSetting as jest.Mock).mockResolvedValue({ key: "ALLOW_NON_ADMIN_UPLOAD", value: "false" });
    const allowed = await assertNonAdminUploadAllowed(
      REQ,
      { allowMemberUploads: false },
      false,
    );
    expect(allowed).toBe(false);
  });

  it("non-admin: ALLOW_NON_ADMIN_UPLOAD=true + allowMemberUploads=false → allowed (OR-inclusive)", async () => {
    (getSetting as jest.Mock).mockResolvedValue({ key: "ALLOW_NON_ADMIN_UPLOAD", value: "true" });
    const allowed = await assertNonAdminUploadAllowed(
      REQ,
      { allowMemberUploads: false },
      false,
    );
    expect(allowed).toBe(true);
  });

  it("non-admin: ALLOW_NON_ADMIN_UPLOAD=false + allowMemberUploads=true → allowed (OR-inclusive)", async () => {
    (getSetting as jest.Mock).mockResolvedValue({ key: "ALLOW_NON_ADMIN_UPLOAD", value: "false" });
    const allowed = await assertNonAdminUploadAllowed(
      REQ,
      { allowMemberUploads: true },
      false,
    );
    expect(allowed).toBe(true);
  });

  it("D-03 fail-closed: value !== 'true' (e.g. 'yes', '', undefined, NaN-string) → denied", async () => {
    for (const bad of ["yes", "", "false", "1", "true ", "TRUE"]) {
      (getSetting as jest.Mock).mockResolvedValue({ key: "ALLOW_NON_ADMIN_UPLOAD", value: bad });
      const allowed = await assertNonAdminUploadAllowed(
        REQ,
        { allowMemberUploads: false },
        false,
      );
      expect(allowed).toBe(false);
    }
  });

  it("IN-02: helper signature has no Response param — caller owns WR-01 + 403 write (enforced by TS)", async () => {
    // IN-02 removed the unused Response parameter from the helper signature.
    // The contract "helper does NOT write the HTTP response" is now enforced
    // by the compiler (callers cannot pass `res`), not just by JSDoc. This
    // test pins the new 3-arg shape and verifies denial still returns false
    // without any response object in scope.
    (getSetting as jest.Mock).mockResolvedValue({ key: "ALLOW_NON_ADMIN_UPLOAD", value: "false" });
    const allowed = await assertNonAdminUploadAllowed(
      REQ,
      { allowMemberUploads: false },
      false,
    );
    expect(allowed).toBe(false);
  });
});

describe("assertArchiveAccess (D-06, global Archive — no workspaceId)", () => {
  const ARCHIVE_ID = "33333333-3333-4333-8333-333333333333";
  const OTHER_USER = "user-b";
  const OWNER = "user-a";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("archive missing → { ok:false, reason:'missing' } (caller writes 404)", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(null);
    const result = await assertArchiveAccess(ARCHIVE_ID, OWNER, {});
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("archive soft-deleted (deletedAt !== null) → { ok:false, reason:'missing' }", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: OWNER,
      deletedAt: new Date(),
    });
    const result = await assertArchiveAccess(ARCHIVE_ID, OWNER, {});
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("archive owned by caller (createdBy === userId) → { ok:true, reason:'ok' }", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: OWNER,
      deletedAt: null,
    });
    const result = await assertArchiveAccess(ARCHIVE_ID, OWNER, {});
    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  it("archive not owned by caller, caller is admin → { ok:true, reason:'ok' } (D-06a admin bypass)", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: OTHER_USER,
      deletedAt: null,
    });
    // isAdmin(user) true: user has admin:settings permission
    const adminUser = {
      roles: [{ role: { permissions: [{ permissionName: "admin:settings" }] } }],
    };
    const result = await assertArchiveAccess(ARCHIVE_ID, OWNER, adminUser);
    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  it("archive not owned by caller, caller is NOT admin → { ok:false, reason:'denied' } (403)", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue({
      id: ARCHIVE_ID,
      createdBy: OTHER_USER,
      deletedAt: null,
    });
    const nonAdmin = { roles: [] };
    const result = await assertArchiveAccess(ARCHIVE_ID, OWNER, nonAdmin);
    expect(result).toEqual({ ok: false, reason: "denied" });
  });

  it("uses prisma.archive.findUnique with the singleton (never new PrismaClient)", async () => {
    (prisma.archive.findUnique as jest.Mock).mockResolvedValue(null);
    await assertArchiveAccess(ARCHIVE_ID, OWNER, {});
    expect(prisma.archive.findUnique).toHaveBeenCalledWith({ where: { id: ARCHIVE_ID } });
  });
});