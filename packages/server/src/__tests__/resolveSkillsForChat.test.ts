// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * resolveSkillsForChat unit tests
 */

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

// We import the skills module after mocks; the Map is module-level singleton
import {
  resolveSkillsForChat,
  registerSkill,
  getSkillsForWorkspace,
  _clearAllSkills,
  type AgentSkillDefinition,
} from "../agent/skills";

const workspaceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const chatId = "11111111-2222-3333-4444-555555555555";
const enabledSkillNames = ["rag_search", "workspace_memory"];

// D-13: connection IDs are UUIDs. Skill prefix is `mcp_<connId>_<tool>` (collision-free).
const CONN_FS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONN_GH = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONN_EMPTY = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function makeSkill(name: string): AgentSkillDefinition {
  return {
    name,
    displayName: name,
    description: `desc:${name}`,
    type: "mcp",
    execute: jest.fn().mockResolvedValue({ success: true, data: "ok" }),
  };
}

function makeBuiltinSkill(name: string): AgentSkillDefinition {
  return {
    name,
    displayName: name,
    description: `desc:${name}`,
    type: "builtin",
    execute: jest.fn().mockResolvedValue({ success: true, data: "ok" }),
  };
}

describe("resolveSkillsForChat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearAllSkills();
  });

  test("no pins -> delegates to getSkillsForWorkspace, no warning", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([]);
    registerSkill(makeSkill("rag_search"));
    registerSkill(makeSkill("other_tool"));

    const result = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("rag_search");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("pins with enabled connections -> intersection only (prefix mcp_<id>_)", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_FS, connection: { id: CONN_FS, name: "fs", enabled: true, workspaceId } },
    ]);
    registerSkill(makeSkill(`mcp_${CONN_FS}_read`));
    registerSkill(makeSkill(`mcp_${CONN_FS}_write`));
    registerSkill(makeSkill(`mcp_${CONN_GH}_search`)); // unpinned

    const result = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toEqual([`mcp_${CONN_FS}_read`, `mcp_${CONN_FS}_write`]);
  });

  test("all pinned connections disabled -> fallback with warning", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_FS, connection: { id: CONN_FS, name: "fs", enabled: false, workspaceId } },
      { id: "p2", chatId, connectionId: CONN_GH, connection: { id: CONN_GH, name: "gh", enabled: false, workspaceId } },
    ]);
    registerSkill(makeSkill("rag_search"));
    registerSkill(makeSkill(`mcp_${CONN_FS}_read`));

    const result = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("rag_search");
    expect(logger.warn).toHaveBeenCalledWith(
      "[skills] All pinned MCP connections disabled or out-of-scope, falling back to workspace defaults",
      expect.objectContaining({ chatId, workspaceId, pinnedCount: 2 }),
    );
  });

  test("mixed enabled/disabled -> only enabled contribute", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_FS, connection: { id: CONN_FS, name: "fs", enabled: true, workspaceId } },
      { id: "p2", chatId, connectionId: CONN_GH, connection: { id: CONN_GH, name: "gh", enabled: false, workspaceId } },
    ]);
    registerSkill(makeSkill(`mcp_${CONN_FS}_read`));
    registerSkill(makeSkill(`mcp_${CONN_GH}_search`));

    const result = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe(`mcp_${CONN_FS}_read`);
  });

  test("pinned connection has no registered skills -> silently skipped", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_EMPTY, connection: { id: CONN_EMPTY, name: "empty", enabled: true, workspaceId } },
    ]);
    // Register nothing matching mcp_<CONN_EMPTY>_*

    const result = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames);

    expect(result).toHaveLength(0); // no matching skills, but no error
  });

  test("cross-workspace connection -> excluded, falls back", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_FS, connection: { id: CONN_FS, name: "fs", enabled: true, workspaceId: "other-workspace" } },
    ]);
    registerSkill(makeSkill(`mcp_${CONN_FS}_read`));
    registerSkill(makeSkill("rag_search"));

    const result = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames);

    // fs pin excluded (wrong workspace), falls back to workspace defaults
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("rag_search");
    expect(logger.warn).toHaveBeenCalled();
  });

  test("global connection (workspaceId null, projectId null) -> included for any workspace (D-14)", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_FS, connection: { id: CONN_FS, name: "fs", enabled: true, workspaceId: null, projectId: null } },
    ]);
    registerSkill(makeSkill(`mcp_${CONN_FS}_read`));
    registerSkill(makeSkill("rag_search"));

    const result = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames);

    // Global pin is active: pinned MCP skill added alongside workspace builtins.
    expect(result.map((s) => s.name)).toContain(`mcp_${CONN_FS}_read`);
    expect(result.map((s) => s.name)).toContain("rag_search");
  });

  test("project-scoped connection (workspaceId null, projectId set) -> excluded from workspace chat", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_FS, connection: { id: CONN_FS, name: "fs", enabled: true, workspaceId: null, projectId: "proj-1" } },
    ]);
    registerSkill(makeSkill(`mcp_${CONN_FS}_read`));
    registerSkill(makeSkill("rag_search"));

    const result = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames);

    // Project-scoped pin excluded (not usable from a workspace chat per D-14),
    // falls back to workspace defaults.
    expect(result.map((s) => s.name)).not.toContain(`mcp_${CONN_FS}_read`);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("rag_search");
    expect(logger.warn).toHaveBeenCalled();
  });

  // ---- MCP-02: union pinning branch (builtin + pinned MCP) ----

  test("union preserves builtin — pins present, builtins + pinned MCP all included", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_FS, connection: { id: CONN_FS, name: "fs", enabled: true, workspaceId } },
    ]);
    registerSkill(makeBuiltinSkill("rag_search"));
    registerSkill(makeBuiltinSkill("workspace_memory"));
    registerSkill(makeSkill(`mcp_${CONN_FS}_read`));

    const result = await resolveSkillsForChat(workspaceId, chatId, ["rag_search", "workspace_memory"]);

    expect(result.map((s) => s.name).sort()).toEqual(
      [`mcp_${CONN_FS}_read`, "rag_search", "workspace_memory"].sort(),
    );
  });

  test("union with subset enabled — workspace_memory excluded (not in enabledSkillNames), pinned MCP still included", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      { id: "p1", chatId, connectionId: CONN_FS, connection: { id: CONN_FS, name: "fs", enabled: true, workspaceId } },
    ]);
    registerSkill(makeBuiltinSkill("rag_search"));
    registerSkill(makeBuiltinSkill("workspace_memory"));
    registerSkill(makeSkill(`mcp_${CONN_FS}_read`));

    const result = await resolveSkillsForChat(workspaceId, chatId, ["rag_search"]);

    // rag_search (enabled builtin) + mcp_<CONN_FS>_read (pinned MCP via union)
    // workspace_memory is NOT in enabledSkillNames -> excluded from builtin set,
    // but the pinned MCP tool IS included via the union (Pitfall 5 avoided).
    expect(result.map((s) => s.name).sort()).toEqual([`mcp_${CONN_FS}_read`, "rag_search"].sort());
    expect(result.map((s) => s.name)).not.toContain("workspace_memory");
  });
});
