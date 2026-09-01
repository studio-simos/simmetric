// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck
/**
 * Unit tests for chatExportService — CSW-15 (Phase 159-01, D-07).
 *
 * Covers sanitizeFilename (pure function, 5 edge cases) + exportWorkspaceChats
 * (workspace-not-found + happy path) + exportSingleChat (workspace-not-found,
 * chat-not-found, happy path). Follows the postProcessingService.test.ts mock
 * pattern: jest.mock prisma + withSoftDelete, jest.mock parseMetadata.
 */

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    workspace: { findUnique: jest.fn() },
    chat: { findMany: jest.fn(), findFirst: jest.fn() },
  },
  withSoftDelete: jest.fn((where: unknown) => where),
}));

jest.mock("../utils/parseMetadata", () => ({
  __esModule: true,
  parseMetadata: jest.fn(),
}));

import prisma, { withSoftDelete } from "../utils/prisma";
import { parseMetadata } from "../utils/parseMetadata";
import { sanitizeFilename, exportWorkspaceChats, exportSingleChat } from "../services/chatExportService";

const mockPrisma = prisma as unknown as {
  workspace: { findUnique: jest.Mock };
  chat: { findMany: jest.Mock; findFirst: jest.Mock };
};
const mockWithSoftDelete = withSoftDelete as jest.Mock;
const mockParseMetadata = parseMetadata as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: parseMetadata returns {} (no model)
  mockParseMetadata.mockReturnValue({});
  mockWithSoftDelete.mockImplementation((w: unknown) => w);
});

describe("sanitizeFilename", () => {
  it("replaces spaces and special chars with underscores: 'hello world!' -> 'hello_world_'", () => {
    expect(sanitizeFilename("hello world!")).toBe("hello_world_");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeFilename("")).toBe("");
  });

  it("neutralizes path traversal: '../etc/passwd' -> no '..' in output", () => {
    const result = sanitizeFilename("../etc/passwd");
    expect(result).not.toContain("..");
    // "../etc/passwd" (13 chars): ..  /  etc / passwd → 2 dots + 2 slashes = 4 underscores
    expect(result).toBe("___etc_passwd");
  });

  it("replaces unicode chars with underscores", () => {
    const result = sanitizeFilename("日本語");
    // Each non-ASCII char becomes '_'
    expect(result).toBe("___");
  });

  it("truncates to 50 characters", () => {
    const result = sanitizeFilename("a".repeat(100));
    expect(result.length).toBe(50);
    expect(result).toBe("a".repeat(50));
  });
});

describe("exportWorkspaceChats", () => {
  it("throws 'Workspace not found' when workspace.findUnique returns null", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(null);

    await expect(exportWorkspaceChats("ws-missing")).rejects.toThrow("Workspace not found");
    expect(mockPrisma.chat.findMany).not.toHaveBeenCalled();
  });

  it("happy path: returns ChatExportData with workspace name + mapped chats", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "My Workspace" });
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const updatedAt = new Date("2026-01-02T00:00:00Z");
    const msgDate = new Date("2026-01-01T01:00:00Z");
    mockPrisma.chat.findMany.mockResolvedValue([
      {
        id: "chat-1",
        name: "Chat One",
        folder: { name: "Folder A" },
        createdAt,
        updatedAt,
        messages: [
          { role: "user", content: "Hello", createdAt: msgDate, metadata: null },
          { role: "assistant", content: "Hi there", createdAt: msgDate, metadata: '{"model":"gpt-4"}' },
        ],
      },
    ]);
    mockParseMetadata.mockImplementationOnce(() => ({})).mockImplementationOnce(() => ({ model: "gpt-4" }));

    const result = await exportWorkspaceChats("ws-1");

    expect(result.version).toBe("1.0");
    expect(result.workspace.name).toBe("My Workspace");
    expect(result.chats).toHaveLength(1);
    expect(result.chats[0].title).toBe("Chat One");
    expect(result.chats[0].folderName).toBe("Folder A");
    expect(result.chats[0].messages).toHaveLength(2);
    expect(result.chats[0].messages[0].role).toBe("user");
    expect(result.chats[0].messages[0].content).toBe("Hello");
    expect(result.chats[0].messages[1].model).toBe("gpt-4");
    // withSoftDelete was used to wrap the where clause
    expect(mockWithSoftDelete).toHaveBeenCalled();
  });
});

describe("exportSingleChat", () => {
  it("throws 'Workspace not found' when workspace.findUnique returns null", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(null);

    await expect(exportSingleChat("ws-missing", "chat-1")).rejects.toThrow("Workspace not found");
    expect(mockPrisma.chat.findFirst).not.toHaveBeenCalled();
  });

  it("throws 'Chat not found' when chat.findFirst returns null", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "WS" });
    mockPrisma.chat.findFirst.mockResolvedValue(null);

    await expect(exportSingleChat("ws-1", "chat-missing")).rejects.toThrow("Chat not found");
  });

  it("happy path: returns ChatExportData with a single chat", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "WS" });
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const updatedAt = new Date("2026-01-02T00:00:00Z");
    const msgDate = new Date("2026-01-01T01:00:00Z");
    mockPrisma.chat.findFirst.mockResolvedValue({
      id: "chat-1",
      name: "Solo Chat",
      folder: null,
      createdAt,
      updatedAt,
      messages: [
        { role: "user", content: "Test", createdAt: msgDate, metadata: null },
      ],
    });

    const result = await exportSingleChat("ws-1", "chat-1");

    expect(result.chats).toHaveLength(1);
    expect(result.chats[0].title).toBe("Solo Chat");
    expect(result.chats[0].folderName).toBeNull();
    expect(result.chats[0].messages).toHaveLength(1);
    expect(result.chats[0].messages[0].role).toBe("user");
    expect(result.chats[0].messages[0].model).toBeNull();
  });
});