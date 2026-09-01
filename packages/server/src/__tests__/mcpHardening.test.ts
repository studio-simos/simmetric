// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 150 — MCP Hardening (MCP-02): getMCPToolsForWorkspace wired into
 * resolveSkillsForChat.
 *
 * Verifies the D-03 wiring: the previously "INTENTIONALLY LATENT" IDOR
 * filter (mcpClient.ts:460 WR-04) is now called from the agent skill
 * resolution path, and its output is unioned into the result WITHOUT
 * dropping any existing builtin or pinned MCP skill (D-04 strict union).
 *
 * Uses the real `builtinSkills` registry (jest.requireActual) so that
 * registerSkill/unregisterSkillsForConnection mutate the live Map, and
 * `__setActiveConnectionForTest` from mcpClient to populate the
 * activeConnections map that `getMCPToolsForWorkspace` reads. prisma is
 * mocked so `chatMCPPin.findMany` returns deterministic pin sets.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    withSoftDelete: (where: unknown) => where,
  };
});

// Mock the MCP SDK client transports so importing mcpClient does not pull in
// heavy ESM. We only need the runtime helpers (__setActiveConnectionForTest,
// getMCPToolsForWorkspace) — not connectMCPServer.
jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    listTools: jest.fn(),
    close: jest.fn(),
    callTool: jest.fn(),
  })),
}));
jest.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({ __kind: "sse" })),
}));
jest.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({ __kind: "streamable-http" })),
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(),
  getLicenseInfo: jest.fn(() => ({ tier: "community" })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

import prisma from "../utils/prisma";
import {
  __setActiveConnectionForTest,
  __clearActiveConnectionForTest,
} from "../agent/mcpClient";
// Use the REAL skills module so registerSkill mutates the live builtinSkills
// Map that resolveSkillsForChat reads.
const realSkills = jest.requireActual("../agent/skills") as typeof import("../agent/skills");
import { resolveSkillsForChat } from "../agent/skills";

const WS_A = "ws-A";
const WS_B = "ws-B";
const CONN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function registerMcpSkill(connId: string, toolName: string): void {
  realSkills.registerSkill({
    name: `mcp_${connId}_${toolName}`,
    displayName: `[MCP] ${toolName}`,
    description: `test mcp tool ${toolName}`,
    type: "mcp",
    execute: jest.fn(),
  });
}

function registerBuiltin(name: string): void {
  realSkills.registerSkill({
    name,
    displayName: name,
    description: `builtin ${name}`,
    type: "builtin",
    execute: jest.fn(),
  });
}

describe("MCP-02: getMCPToolsForWorkspace wired into resolveSkillsForChat", () => {
  beforeEach(() => {
    realSkills._clearAllSkills();
    jest.clearAllMocks();
  });

  afterEach(() => {
    realSkills._clearAllSkills();
    __clearActiveConnectionForTest(CONN_A);
    __clearActiveConnectionForTest(CONN_B);
  });

  // (a) Workspace A has an active connection with tool t1; resolveSkillsForChat
  //     returns builtin skills PLUS mcp_<connA>_t1.
  it("(a) workspace A active connection tool t1 is unioned into the result alongside builtins", async () => {
    // Set up an active, connected, workspace-A-scoped connection exposing tool t1.
    __setActiveConnectionForTest(CONN_A, {
      tools: [{ name: "t1", description: "wsA tool", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: WS_A, projectId: null },
    });
    // Register the corresponding skill in the registry (as connectMCPServer would).
    registerMcpSkill(CONN_A, "t1");
    // And a builtin that the workspace enables.
    registerBuiltin("rag_search");

    // No pins -> D-15 path. enabledSkillNames includes the builtin.
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([]);

    const skills = await resolveSkillsForChat(WS_A, "chat-1", ["rag_search"]);
    const names = skills.map((s) => s.name);

    expect(names).toContain("rag_search");
    expect(names).toContain(`mcp_${CONN_A}_t1`);
  });

  // (b) Workspace B does NOT see Workspace A's tool (IDOR filter).
  it("(b) workspace B does NOT see workspace A's MCP tool (IDOR scope filter)", async () => {
    __setActiveConnectionForTest(CONN_A, {
      tools: [{ name: "t1", description: "wsA tool", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: WS_A, projectId: null },
    });
    registerMcpSkill(CONN_A, "t1");
    registerBuiltin("rag_search");

    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([]);

    const skills = await resolveSkillsForChat(WS_B, "chat-B", ["rag_search"]);
    const names = skills.map((s) => s.name);

    // builtin still present (D-04 — never drop builtins)
    expect(names).toContain("rag_search");
    // A's tool is NOT in scope for B
    expect(names).not.toContain(`mcp_${CONN_A}_t1`);
  });

  // (c) A pinned+enabled MCP skill already in the result is NOT duplicated by
  //     the union.
  it("(c) pinned MCP skill already in result is not duplicated by the MCP-02 union", async () => {
    // Active connection in workspace A with tool t1.
    __setActiveConnectionForTest(CONN_A, {
      tools: [{ name: "t1", description: "wsA tool", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: WS_A, projectId: null },
    });
    registerMcpSkill(CONN_A, "t1");
    registerBuiltin("rag_search");

    // A pin exists for CONN_A — so the D-13 intersection path will already add
    // mcp_<CONN_A>_t1 to the base result. The MCP-02 union must NOT add it
    // a second time.
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      {
        chatId: "chat-1",
        connectionId: CONN_A,
        connection: {
          id: CONN_A,
          name: "A",
          enabled: true,
          workspaceId: WS_A,
          projectId: null,
        },
      },
    ]);

    const skills = await resolveSkillsForChat(WS_A, "chat-1", ["rag_search"]);
    const names = skills.map((s) => s.name);

    expect(names).toContain("rag_search");
    expect(names.filter((n) => n === `mcp_${CONN_A}_t1`)).toHaveLength(1);
  });

  // (d) D-15 fallback: all pins disabled -> result = workspace defaults PLUS
  //     workspace-scoped MCP tools (union, not replace).
  it("(d) D-15 fallback (all pins disabled) still unions workspace-scoped MCP tools", async () => {
    // Active connection in workspace A with tool t1 — NOT pinned, but in scope.
    __setActiveConnectionForTest(CONN_A, {
      tools: [{ name: "t1", description: "wsA tool", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: WS_A, projectId: null },
    });
    registerMcpSkill(CONN_A, "t1");
    registerBuiltin("rag_search");
    registerBuiltin("workspace_memory");

    // A pin exists but the connection is disabled -> activePins.length === 0
    // -> D-15 fallback to workspace defaults, which must STILL union the
    // workspace-scoped MCP tools (MCP-02 is additive on every path).
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      {
        chatId: "chat-1",
        connectionId: CONN_A,
        connection: {
          id: CONN_A,
          name: "A",
          enabled: false, // disabled -> fallback
          workspaceId: WS_A,
          projectId: null,
        },
      },
    ]);

    const skills = await resolveSkillsForChat(WS_A, "chat-1", ["rag_search", "workspace_memory"]);
    const names = skills.map((s) => s.name);

    // workspace defaults preserved
    expect(names).toContain("rag_search");
    expect(names).toContain("workspace_memory");
    // MCP-02 union still adds the in-scope MCP tool on the fallback path
    expect(names).toContain(`mcp_${CONN_A}_t1`);
  });
});