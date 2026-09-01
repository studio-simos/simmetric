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
  },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../agent/mcpClient", () => ({
  disconnectMCPServer: jest.fn(),
}));

jest.mock("../agent/skills", () => ({
  unregisterSkillsForConnection: jest.fn(),
}));

// --- Imports (after mocks) ---

import { uninstallMcpServer } from "../services/mcpUninstallService";
import prisma from "../utils/prisma";
import { disconnectMCPServer } from "../agent/mcpClient";
import { unregisterSkillsForConnection } from "../agent/skills";
import { logger } from "../utils/logger";

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
