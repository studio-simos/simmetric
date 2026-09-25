// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * mcpUninstallService unit tests
 *
 * Tests the atomic uninstall sequence: find -> disconnect -> unregister skills -> hard delete.
 * Covers IDOR protection, D-12 pin survival, and error recovery paths.
 */

// --- Module mocks (must be before all imports) ---

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma().prisma;
  delete (mock as any).chatMCPPin;
  return { __esModule: true, default: mock };
});

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../agent/mcpClient", () => ({
  disconnectMCPServer: jest.fn(),
}));

jest.mock("../agent/skills", () => ({
  unregisterSkillsForConnection: jest.fn(),
}));

jest.mock("../services/oauthTokenLifecycle", () => ({
  decryptTokenBlob: jest.fn(),
  revokeProviderToken: jest.fn(),
  encryptTokenBlob: jest.fn(),
  refreshAccessToken: jest.fn(),
  exchangeAuthorizationCode: jest.fn(),
}));

jest.mock("../services/oauthProviderRegistry", () => ({
  resolveProvider: jest.fn(),
}));

// --- Imports (after mocks) ---

import { uninstallMcpServer, revokeAndWipeCredentials } from "../services/mcpUninstallService";
import prisma from "../utils/prisma";
import { disconnectMCPServer } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";
import { logger } from "../utils/logger";
import { decryptTokenBlob, revokeProviderToken } from "../services/oauthTokenLifecycle";
import { resolveProvider } from "../services/oauthProviderRegistry";

describe("uninstallMcpServer", () => {
  const mockCatalogEntryId = "entry-550e8400-e29b-41d4-a716-446655440000";
  const mockWorkspaceId = "workspace-550e8400-e29b-41d4-a716-446655440000";
  const mockConnectionId = "conn-550e8400-e29b-41d4-a716-446655440000";
  const mockConnectionName = "Test MCP Server";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("success path", () => {
    beforeEach(() => {
      // Seed the mock: findFirst returns a valid marketplace connection
      (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
        id: mockConnectionId,
        name: mockConnectionName,
        catalogEntryId: mockCatalogEntryId,
        workspaceId: mockWorkspaceId,
        source: "marketplace",
        url: "http://localhost:9000/sse",
        enabled: true,
      });
      (disconnectMCPServer as jest.Mock).mockResolvedValue(undefined);
      (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue({
        id: mockConnectionId,
      });
    });

    test("resolves successfully when connection is found", async () => {
      const result = await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

      expect(result).toEqual({
        success: true,
        connectionId: mockConnectionId,
        connectionName: mockConnectionName,
      });
    });

    test("findFirst query includes source filter for IDOR protection", async () => {
      await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

      expect(prisma.mCPConnection.findFirst).toHaveBeenCalledWith({
        where: {
          catalogEntryId: mockCatalogEntryId,
          workspaceId: mockWorkspaceId,
          source: "marketplace",
        },
      });
    });

    test("calls disconnectMCPServer with correct connectionId", async () => {
      await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

      expect(disconnectMCPServer).toHaveBeenCalledWith(mockConnectionId);
      expect(disconnectMCPServer).toHaveBeenCalledTimes(1);
    });

    test("calls unregisterSkillsForConnection with connection id (D-13 UUID prefix)", async () => {
      await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

      expect(unregisterSkillsForConnection).toHaveBeenCalledWith(mockConnectionId);
      expect(unregisterSkillsForConnection).toHaveBeenCalledTimes(1);
    });

    test("deletes the database record after cleanup", async () => {
      await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

      expect(prisma.mCPConnection.delete).toHaveBeenCalledWith({
        where: { id: mockConnectionId },
      });
    });

    test("executes disconnect before delete (ordering check)", async () => {
      const disconnectSpy = disconnectMCPServer as jest.Mock;
      const deleteSpy = prisma.mCPConnection.delete as jest.Mock;

      await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

      // Verify both were called
      expect(disconnectSpy).toHaveBeenCalled();
      expect(deleteSpy).toHaveBeenCalled();

      // Verify disconnect was called before delete
      const disconnectCallOrder = disconnectSpy.mock.invocationCallOrder[0]!;
      const deleteCallOrder = deleteSpy.mock.invocationCallOrder[0]!;
      expect(disconnectCallOrder).toBeLessThan(deleteCallOrder);
    });
  });

  describe("not-found path", () => {
    test("throws with correct error message when no connection found", async () => {
      (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId),
      ).rejects.toThrow(
        "No installed connection found for this catalog entry in the specified workspace.",
      );
    });

    test("does not call disconnect or delete when connection not found", async () => {
      (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId),
      ).rejects.toThrow();

      expect(disconnectMCPServer).not.toHaveBeenCalled();
      expect(unregisterSkillsForConnection).not.toHaveBeenCalled();
      expect(prisma.mCPConnection.delete).not.toHaveBeenCalled();
    });
  });

  describe("error recovery paths", () => {
    beforeEach(() => {
      (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
        id: mockConnectionId,
        name: mockConnectionName,
        catalogEntryId: mockCatalogEntryId,
        workspaceId: mockWorkspaceId,
        source: "marketplace",
      });
    });

    test("completes successfully when disconnectMCPServer rejects", async () => {
      (disconnectMCPServer as jest.Mock).mockRejectedValue(new Error("already disconnected"));
      (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue({ id: mockConnectionId });

      const result = await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

      // The function logs a warning but does NOT throw — it proceeds with cleanup
      expect(logger.warn).toHaveBeenCalledWith(
        "[mcpUninstall] Disconnect had non-fatal error",
        expect.objectContaining({
          connectionId: mockConnectionId,
          error: "already disconnected",
        }),
      );

      // Despite disconnect failure, skills are unregistered and record is deleted
      expect(unregisterSkillsForConnection).toHaveBeenCalledWith(mockConnectionId);
      expect(prisma.mCPConnection.delete).toHaveBeenCalledWith({
        where: { id: mockConnectionId },
      });

      expect(result.success).toBe(true);
    });

    test("propagates error when prisma delete fails", async () => {
      (disconnectMCPServer as jest.Mock).mockResolvedValue(undefined);
      (prisma.mCPConnection.delete as jest.Mock).mockRejectedValue(new Error("DB error"));

      await expect(
        uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId),
      ).rejects.toThrow("DB error");
    });
  });

  describe("D-12 compliance: pins survive uninstall", () => {
    test("does not interact with ChatMCPPin model", async () => {
      (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
        id: mockConnectionId,
        name: mockConnectionName,
        catalogEntryId: mockCatalogEntryId,
        workspaceId: mockWorkspaceId,
        source: "marketplace",
      });
      (disconnectMCPServer as jest.Mock).mockResolvedValue(undefined);
      (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue({ id: mockConnectionId });

      await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

      // Verify ChatMCPPin model was never accessed — pins survive per D-12
      expect(prisma.chatMCPPin).toBeUndefined();
    });
  });
});

// ====================================================================
// Phase 197 (MCPO-03 D-08): revoke+wipe helper + uninstall integration
// ====================================================================

describe("revokeAndWipeCredentials (Phase 197 D-08)", () => {
  const googleDef = { id: "google", revokeUrl: "https://oauth2.googleapis.com/revoke" };
  const microsoftDef = { id: "microsoft", revokeUrl: null };
  const CONN_ID = "conn-550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    jest.clearAllMocks();
    (resolveProvider as jest.Mock).mockReturnValue(googleDef);
    (revokeProviderToken as jest.Mock).mockResolvedValue({ ok: true });
  });

  it("revokes provider-side for an oauth row with a decryptable blob", async () => {
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "at-token", scope: "https://www.googleapis.com/auth/gmail.readonly", obtainedAt: new Date().toISOString() },
    });

    await revokeAndWipeCredentials({
      id: CONN_ID,
      authType: "oauth",
      oauthProvider: "google",
      credentialsEncrypted: "iv:tag:ct",
    });

    expect(resolveProvider).toHaveBeenCalledWith("google");
    expect(revokeProviderToken).toHaveBeenCalledTimes(1);
    expect(revokeProviderToken).toHaveBeenCalledWith(googleDef, "at-token");
  });

  it("skips revoke for a non-oauth row (no call, no throw)", async () => {
    await revokeAndWipeCredentials({ id: CONN_ID, authType: "none", oauthProvider: null, credentialsEncrypted: null });

    expect(resolveProvider).not.toHaveBeenCalled();
    expect(decryptTokenBlob).not.toHaveBeenCalled();
    expect(revokeProviderToken).not.toHaveBeenCalled();
  });

  it("skips revoke when the row has no stored blob", async () => {
    await revokeAndWipeCredentials({ id: CONN_ID, authType: "oauth", oauthProvider: "google", credentialsEncrypted: null });

    expect(decryptTokenBlob).not.toHaveBeenCalled();
    expect(revokeProviderToken).not.toHaveBeenCalled();
  });

  it("fail-open on decrypt failure: no revoke, no throw (wipe proceeds via delete)", async () => {
    (decryptTokenBlob as jest.Mock).mockReturnValue({ ok: false, errorDescription: "blob undecryptable" });

    await expect(
      revokeAndWipeCredentials({ id: CONN_ID, authType: "oauth", oauthProvider: "google", credentialsEncrypted: "iv:tag:ct" }),
    ).resolves.toBeUndefined();

    expect(revokeProviderToken).not.toHaveBeenCalled();
  });

  it("fail-open on unknown provider: no revoke, no throw", async () => {
    (resolveProvider as jest.Mock).mockReturnValue(null);

    await expect(
      revokeAndWipeCredentials({ id: CONN_ID, authType: "oauth", oauthProvider: "dropbox", credentialsEncrypted: "iv:tag:ct" }),
    ).resolves.toBeUndefined();

    expect(decryptTokenBlob).not.toHaveBeenCalled();
    expect(revokeProviderToken).not.toHaveBeenCalled();
  });

  it("microsoft arm: resolveProvider returns a def without revokeUrl — revoke still called, skipped:true does not block", async () => {
    (resolveProvider as jest.Mock).mockReturnValue(microsoftDef);
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "ms-token", scope: "offline_access", obtainedAt: new Date().toISOString() },
    });
    (revokeProviderToken as jest.Mock).mockResolvedValue({ ok: true, skipped: true });

    await revokeAndWipeCredentials({ id: CONN_ID, authType: "oauth", oauthProvider: "microsoft", credentialsEncrypted: "iv:tag:ct" });

    expect(revokeProviderToken).toHaveBeenCalledWith(microsoftDef, "ms-token");
  });

  it("provider-side revoke failure never blocks (never-throws contract: errorDescription arm resolves)", async () => {
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "at-token", scope: "s", obtainedAt: new Date().toISOString() },
    });
    (revokeProviderToken as jest.Mock).mockResolvedValue({ ok: true, errorDescription: "provider revoke returned 400" });

    await expect(
      revokeAndWipeCredentials({ id: CONN_ID, authType: "oauth", oauthProvider: "google", credentialsEncrypted: "iv:tag:ct" }),
    ).resolves.toBeUndefined();

    expect(revokeProviderToken).toHaveBeenCalledTimes(1);
  });

  it("logs provider + status only — token material never in logs (T-195-05 posture)", async () => {
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "SECRET-TOKEN-MATERIAL", scope: "s", obtainedAt: new Date().toISOString() },
    });
    (revokeProviderToken as jest.Mock).mockResolvedValue({ ok: true, errorDescription: "unreachable" });

    await revokeAndWipeCredentials({ id: CONN_ID, authType: "oauth", oauthProvider: "google", credentialsEncrypted: "iv:tag:ct" });

    for (const call of (logger.info as jest.Mock).mock.calls) {
      expect(JSON.stringify(call)).not.toContain("SECRET-TOKEN-MATERIAL");
    }
    for (const call of (logger.warn as jest.Mock).mock.calls) {
      expect(JSON.stringify(call)).not.toContain("SECRET-TOKEN-MATERIAL");
    }
  });
});

describe("uninstallMcpServer revoke+wipe integration (Phase 197 D-08)", () => {
  const mockCatalogEntryId = "entry-550e8400-e29b-41d4-a716-446655440000";
  const mockWorkspaceId = "workspace-550e8400-e29b-41d4-a716-446655440000";
  const mockConnectionId = "conn-550e8400-e29b-41d4-a716-446655440000";
  const mockConnectionName = "Test MCP Server";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uninstall of an oauth row: revoke BEFORE delete (order pinned), then delete called", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
      id: mockConnectionId,
      name: mockConnectionName,
      catalogEntryId: mockCatalogEntryId,
      workspaceId: mockWorkspaceId,
      source: "marketplace",
      authType: "oauth",
      oauthProvider: "google",
      credentialsEncrypted: "iv:tag:ct",
    });
    (disconnectMCPServer as jest.Mock).mockResolvedValue(undefined);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue({ id: mockConnectionId });
    (resolveProvider as jest.Mock).mockReturnValue({ id: "google", revokeUrl: "https://oauth2.googleapis.com/revoke" });
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "at", scope: "s", obtainedAt: new Date().toISOString() },
    });
    (revokeProviderToken as jest.Mock).mockResolvedValue({ ok: true });

    await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

    expect(revokeProviderToken).toHaveBeenCalledTimes(1);
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
    expect((revokeProviderToken as jest.Mock).mock.invocationCallOrder[0]!).toBeLessThan(
      (prisma.mCPConnection.delete as jest.Mock).mock.invocationCallOrder[0]!,
    );
  });

  it("uninstall of a non-oauth row: revoke NOT called, delete still called", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
      id: mockConnectionId,
      name: mockConnectionName,
      catalogEntryId: mockCatalogEntryId,
      workspaceId: mockWorkspaceId,
      source: "marketplace",
      authType: "none",
      oauthProvider: null,
      credentialsEncrypted: null,
    });
    (disconnectMCPServer as jest.Mock).mockResolvedValue(undefined);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue({ id: mockConnectionId });

    await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

    expect(revokeProviderToken).not.toHaveBeenCalled();
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
  });

  it("decrypt-failure row: revoke NOT called AND delete STILL called (fail-open-to-wipe pin)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
      id: mockConnectionId,
      name: mockConnectionName,
      catalogEntryId: mockCatalogEntryId,
      workspaceId: mockWorkspaceId,
      source: "marketplace",
      authType: "oauth",
      oauthProvider: "google",
      credentialsEncrypted: "iv:tag:ct",
    });
    (disconnectMCPServer as jest.Mock).mockResolvedValue(undefined);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue({ id: mockConnectionId });
    (resolveProvider as jest.Mock).mockReturnValue({ id: "google", revokeUrl: "https://r" });
    (decryptTokenBlob as jest.Mock).mockReturnValue({ ok: false, errorDescription: "undecryptable" });

    await uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId);

    expect(revokeProviderToken).not.toHaveBeenCalled();
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
  });

  it("provider-side revoke failure does not block the wipe (delete still called)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
      id: mockConnectionId,
      name: mockConnectionName,
      catalogEntryId: mockCatalogEntryId,
      workspaceId: mockWorkspaceId,
      source: "marketplace",
      authType: "oauth",
      oauthProvider: "google",
      credentialsEncrypted: "iv:tag:ct",
    });
    (disconnectMCPServer as jest.Mock).mockResolvedValue(undefined);
    (prisma.mCPConnection.delete as jest.Mock).mockResolvedValue({ id: mockConnectionId });
    (resolveProvider as jest.Mock).mockReturnValue({ id: "google", revokeUrl: "https://r" });
    (decryptTokenBlob as jest.Mock).mockReturnValue({
      ok: true,
      blob: { accessToken: "at", scope: "s", obtainedAt: new Date().toISOString() },
    });
    (revokeProviderToken as jest.Mock).mockResolvedValue({ ok: true, errorDescription: "provider revoke unreachable: ECONNREFUSED" });

    await expect(uninstallMcpServer(mockCatalogEntryId, mockWorkspaceId)).resolves.toEqual({
      success: true,
      connectionId: mockConnectionId,
      connectionName: mockConnectionName,
    });

    expect(revokeProviderToken).toHaveBeenCalledTimes(1);
    expect(prisma.mCPConnection.delete).toHaveBeenCalledTimes(1);
  });
});
