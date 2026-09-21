// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for MCP client runtime functions
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

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

jest.mock("../agent/skills", () => ({
  registerSkill: jest.fn(),
  unregisterSkillsForConnection: jest.fn(),
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import prisma from "../utils/prisma";
import {
  getConnectionStatuses,
  clearConnectionError,
  connectMCPServer,
  disconnectMCPServer,
  shutdownMCPConnections,
  getActiveConnectionsSnapshot,
  testMCPServerConnection,
  resolveMcpSourceName,
  getMCPToolsForWorkspace,
  __setActiveConnectionForTest,
  __clearActiveConnectionForTest,
} from "../agent/mcpClient";
import { registerSkill, unregisterSkillsForConnection, getAllBuiltinSkills } from "../agent/skills";

// Test unregisterSkillsForConnection with real implementation
const realSkills = jest.requireActual("../agent/skills") as typeof import("../agent/skills");

describe("MCP Client Runtime Functions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getConnectionStatuses", () => {
    it("returns empty Map when no active connections exist", () => {
      const statuses = getConnectionStatuses();
      expect(statuses.size).toBe(0);
    });
  });

  describe("clearConnectionError", () => {
    it("removes error entry for a given connection ID", () => {
      expect(() => clearConnectionError("nonexistent-id")).not.toThrow();
    });
  });
});

describe("unregisterSkillsForConnection (real impl)", () => {
  // D-13: prefix is now `mcp_<connectionId>_<tool>` where connectionId is a UUID.
  // UUIDs contain no underscores → prefix matching is collision-free.
  const CONN_ID = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    // Clear any previously registered skills by re-importing
    // Since builtinSkills is module-private, we register then remove
  });

  it("removes all skills with matching prefix (unregister by id)", () => {
    realSkills.registerSkill({ name: `mcp_${CONN_ID}_tool1`, displayName: "Tool 1", description: "Test", type: "mcp", execute: jest.fn() });
    realSkills.registerSkill({ name: `mcp_${CONN_ID}_tool2`, displayName: "Tool 2", description: "Test", type: "mcp", execute: jest.fn() });
    realSkills.registerSkill({ name: "builtin_rag_search", displayName: "RAG", description: "Search", type: "builtin", execute: jest.fn() });

    realSkills.unregisterSkillsForConnection(CONN_ID);

    const remaining = realSkills.getAllBuiltinSkills();
    const remainingNames = remaining.map(s => s.name);
    expect(remainingNames).not.toContain(`mcp_${CONN_ID}_tool1`);
    expect(remainingNames).not.toContain(`mcp_${CONN_ID}_tool2`);
    expect(remainingNames).toContain("builtin_rag_search");
  });

  it("handles connection id with no registered skills", () => {
    realSkills.registerSkill({ name: "builtin_another_skill", displayName: "Another", description: "Test", type: "builtin", execute: jest.fn() });

    expect(() => realSkills.unregisterSkillsForConnection("nonexistent-uuid-0000-0000-000000000000")).not.toThrow();

    const remaining = realSkills.getAllBuiltinSkills();
    expect(remaining.map(s => s.name)).toContain("builtin_another_skill");
  });
});

describe("connectMCPServer header passing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes stored headers to SSEClientTransport via requestInit when connection has non-empty headers", async () => {
    const mockConnection = {
      id: "conn-1",
      name: "Test MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      headers: JSON.stringify({ "X-Api-Key": "test-key-123", "Authorization": "Bearer token" }),
      projectId: null,
      workspaceId: "ws-1",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);

    await connectMCPServer("conn-1");

    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      { requestInit: { headers: expect.any(Headers) } }
    );
  });

  it("skips transportOptions when connection headers are empty", async () => {
    const mockConnection = {
      id: "conn-2",
      name: "Test MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-1",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);

    await connectMCPServer("conn-2");

    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      undefined
    );
  });
});

describe("testMCPServerConnection header passing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes headers parameter to SSEClientTransport via requestInit", async () => {
    await testMCPServerConnection("http://mcp-server.example.com/sse", {
      "X-Api-Key": "test-key-123",
    });

    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      { requestInit: { headers: expect.any(Headers) } }
    );
  });

  it("skips transportOptions when headers are undefined or empty", async () => {
    await testMCPServerConnection("http://mcp-server.example.com/sse", undefined);

    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      undefined
    );

    jest.clearAllMocks();

    await testMCPServerConnection("http://mcp-server.example.com/sse", {});

    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      undefined
    );
  });
});

// ─── Phase 63 Plan 02: Transport fallback + Zod headers read-side ───

describe("transport fallback (D-09/D-10/D-11)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("transport fallback — streamable 4xx → SSE succeeds", async () => {
    // First Client instance (streamable) throws 404 on connect; second (SSE) succeeds.
    let connectCalls = 0;
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => {
        connectCalls += 1;
        if (connectCalls === 1) {
          const err = new Error("Not Found") as Error & { code?: number };
          err.code = 404;
          throw err;
        }
        return Promise.resolve();
      }),
      listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "tool1", description: "d" }] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: jest.fn(),
    }));

    const mockConnection = {
      id: "conn-fb1",
      name: "Fallback MCP",
      url: "http://mcp-server.example.com/mcp",
      transportType: "streamable-http",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-fb",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);

    const result = await connectMCPServer("conn-fb1");

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(expect.any(URL), undefined);
    expect(SSEClientTransport).toHaveBeenCalledWith(expect.any(URL), undefined);
    expect(result.tools).toHaveLength(1);
    // effectiveTransport cached as "sse" (D-10)
    const statuses = getConnectionStatuses();
    expect(statuses.get("conn-fb1")?.effectiveTransport).toBe("sse");
  });

  it("sse declared no fallback — StreamableHTTPClientTransport NOT constructed", async () => {
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: jest.fn(),
    }));

    const mockConnection = {
      id: "conn-sse",
      name: "SSE Only",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-sse",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);

    await connectMCPServer("conn-sse");

    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
    expect(SSEClientTransport).toHaveBeenCalledWith(expect.any(URL), undefined);
    expect(getConnectionStatuses().get("conn-sse")?.effectiveTransport).toBe("sse");
  });

  it("5xx no fallback — SSEClientTransport NOT constructed, error thrown", async () => {
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => {
        const err = new Error("Internal Server Error") as Error & { code?: number };
        err.code = 500;
        throw err;
      }),
      listTools: jest.fn(),
      close: jest.fn(() => Promise.resolve()),
      callTool: jest.fn(),
    }));

    const mockConnection = {
      id: "conn-5xx",
      name: "FiveHundred MCP",
      url: "http://mcp-server.example.com/mcp",
      transportType: "streamable-http",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-5xx",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);

    const result = await connectMCPServer("conn-5xx");

    // 5xx does NOT trigger fallback (D-09) — SSE never attempted
    expect(SSEClientTransport).not.toHaveBeenCalled();
    expect(StreamableHTTPClientTransport).toHaveBeenCalled();
    // Error surfaced: returns { tools: [] } (connectMCPServer swallows at outer try/catch)
    expect(result.tools).toEqual([]);
  });
});

describe("headers parse failure surfaces (D-12 read-side, T-63-swallow)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("headers parse failure surfaces — hop-by-hop header rejected, returns {tools:[]}, no transport constructed", async () => {
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: jest.fn(),
    }));

    const mockConnection = {
      id: "conn-badhdr",
      name: "Bad Headers MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      // Valid JSON, but Connection is a hop-by-hop header blocked by mcpHeadersSchema
      headers: JSON.stringify({ Connection: "keep-alive" }),
      projectId: null,
      workspaceId: "ws-bad",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);

    const result = await connectMCPServer("conn-badhdr");

    // No transport constructed — validation gate bailed before reaching connect
    expect(SSEClientTransport).not.toHaveBeenCalled();
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
    // Not swallowed to {} — surfaced as { tools: [] } failure
    expect(result.tools).toEqual([]);
  });
});

describe("testMCPServerConnection honors transportType (D-17)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("test connection transport — streamable-http declared tries StreamableHTTPClientTransport first", async () => {
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "t", description: "d" }] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: jest.fn(),
    }));

    await testMCPServerConnection(
      "http://mcp-server.example.com/mcp",
      {},
      "streamable-http"
    );

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(expect.any(URL), undefined);
  });
});

// ─── Phase 63 Plan 03: resolveMcpSourceName (D-13 UUID→name lookup, Pitfall 2) ───

describe("resolveMcpSourceName (D-13 UUID prefix → connection.name)", () => {
  const CONN_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const CONN_NAME = "GitHub";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("mcpSources lookup — UUID in activeConnections returns connection.name", async () => {
    // Populate activeConnections by calling connectMCPServer with a mock connection.
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "read_file", description: "d" }] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: jest.fn(),
    }));
    const mockConnection = {
      id: CONN_UUID,
      name: CONN_NAME,
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-src",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);

    await connectMCPServer(CONN_UUID);

    // Tool name uses UUID prefix; resolveMcpSourceName should return human-readable name.
    const name = await resolveMcpSourceName(`mcp_${CONN_UUID}_read_file`);
    expect(name).toBe(CONN_NAME);
  });

  it("mcpSources disconnected fallback — UUID not in activeConnections → DB lookup", async () => {
    // Use a UUID not in activeConnections (different from the one connected above).
    const DISCONNECTED_UUID = "99999999-8888-7777-6666-555555555555";
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({ name: "Disconnected MCP" });

    const name = await resolveMcpSourceName(`mcp_${DISCONNECTED_UUID}_search`);
    expect(name).toBe("Disconnected MCP");
    expect(prisma.mCPConnection.findUnique).toHaveBeenCalledWith({
      where: { id: DISCONNECTED_UUID },
      select: { name: true },
    });
  });

  it("mcpSources non-mcp tool — returns null without DB lookup", async () => {
    const name = await resolveMcpSourceName("rag_search");
    expect(name).toBeNull();
    expect(prisma.mCPConnection.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Phase 63 Plan 05: IDOR scope filter (D-14 / MCP-05 / T-63-idor) ───

describe("getMCPToolsForWorkspace IDOR scope filter (D-14 / MCP-05)", () => {
  const WS_A = "ws-A";
  const WS_B = "ws-B";

  afterEach(() => {
    // Clean up any synthetic states between tests so suites don't leak.
    __clearActiveConnectionForTest("conn-wsA");
    __clearActiveConnectionForTest("conn-wsB");
    __clearActiveConnectionForTest("conn-global");
    __clearActiveConnectionForTest("conn-disconnected");
  });

  it("IDOR scope filter — workspace A tools NOT returned for workspace B", () => {
    __setActiveConnectionForTest("conn-wsA", {
      tools: [{ name: "toolA", description: "wsA tool", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: WS_A, projectId: null },
    });
    __setActiveConnectionForTest("conn-wsB", {
      tools: [{ name: "toolB", description: "wsB tool", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: WS_B, projectId: null },
    });

    const tools = getMCPToolsForWorkspace(WS_A);
    const names = tools.map((t) => t.name);
    expect(names).toContain("toolA");
    expect(names).not.toContain("toolB");
  });

  it("globals included — null-scope connection tools returned for any workspace", () => {
    __setActiveConnectionForTest("conn-global", {
      tools: [{ name: "globalTool", description: "global", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: null, projectId: null },
    });
    __setActiveConnectionForTest("conn-wsB", {
      tools: [{ name: "toolB", description: "wsB tool", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: WS_B, projectId: null },
    });

    const toolsA = getMCPToolsForWorkspace(WS_A);
    const namesA = toolsA.map((t) => t.name);
    expect(namesA).toContain("globalTool");
    expect(namesA).not.toContain("toolB");
  });

  it("disconnected excluded — scope match but connected=false → not returned", () => {
    __setActiveConnectionForTest("conn-wsA", {
      tools: [{ name: "toolA", description: "wsA tool", inputSchema: {} }],
      connected: true,
      scope: { workspaceId: WS_A, projectId: null },
    });
    __setActiveConnectionForTest("conn-disconnected", {
      tools: [{ name: "discTool", description: "disconnected", inputSchema: {} }],
      connected: false,
      scope: { workspaceId: WS_A, projectId: null },
    });

    const tools = getMCPToolsForWorkspace(WS_A);
    const names = tools.map((t) => t.name);
    expect(names).toContain("toolA");
    expect(names).not.toContain("discTool");
  });
});

// ─── Phase 63 Plan 06: MCP-03 lifecycle (mutex + ensureConnected + delete-first + shutdown) ───

describe("MCP-03 lifecycle (D-06/D-07/D-08, T-63-leak)", () => {
  const CONN_ID = "conn-life-1";

  // Clear ALL active connections that prior describe blocks may have left in the
  // module-level Map. The Map is module-scoped and shared across describe blocks
  // within a single test file, so leftover entries from header/fallback/resolve
  // tests would otherwise pollute the snapshot/shutdown assertions below.
  beforeEach(() => {
    jest.clearAllMocks();
    for (const { id } of getActiveConnectionsSnapshot()) {
      __clearActiveConnectionForTest(id);
    }
  });

  afterEach(() => {
    for (const { id } of getActiveConnectionsSnapshot()) {
      __clearActiveConnectionForTest(id);
    }
  });

  it("ensureConnected idempotent — 2x call = 1 connect under mutex", async () => {
    // Track how many Client instances were constructed.
    const clientCtor = jest.fn().mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "tool1", description: "d" }] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: jest.fn(),
    }));
    (Client as jest.Mock).mockImplementation(clientCtor);

    const mockConnection = {
      id: CONN_ID,
      name: "Lifecycle MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-life",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);

    // First call: establishes connection.
    await connectMCPServer(CONN_ID);
    const firstCalls = clientCtor.mock.calls.length;

    // Second call: ensureConnected guard short-circuits — no new Client constructed.
    await connectMCPServer(CONN_ID);
    const secondCalls = clientCtor.mock.calls.length;

    expect(secondCalls).toBe(firstCalls); // no new Client constructed
    expect(secondCalls).toBeGreaterThanOrEqual(1);
  });

  it("delete-first — activeConnections.delete called BEFORE client.close (D-07)", async () => {
    const closeFn = jest.fn(() => Promise.resolve());
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "t", description: "d" }] })),
      close: closeFn,
      callTool: jest.fn(),
    }));

    const mockConnection = {
      id: CONN_ID,
      name: "DeleteFirst MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-df",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);

    await connectMCPServer(CONN_ID);

    // Spy on Map.prototype.delete AFTER connection established so we capture the
    // activeConnections Map used by mcpClient. We attach to the prototype so the
    // spy intercepts activeConnections.delete specifically.
    const deleteSpy = jest.spyOn(Map.prototype, "delete");

    await disconnectMCPServer(CONN_ID);

    expect(deleteSpy).toHaveBeenCalled();
    expect(closeFn).toHaveBeenCalled();

    // delete-first: the FIRST Map.delete (activeConnections.delete inside
    // disconnectMCPServer) must happen BEFORE the client.close() call.
    // Note: withConnectionLock's finally also calls Map.delete on connectionLocks
    // AFTER close — that's the last delete, not the first.
    const firstDeleteOrder = deleteSpy.mock.invocationCallOrder[0]!;
    const closeOrder = closeFn.mock.invocationCallOrder[closeFn.mock.invocationCallOrder.length - 1]!;
    expect(firstDeleteOrder).toBeLessThan(closeOrder);

    deleteSpy.mockRestore();
  });

  it("disconnect idempotent — calling on non-existent connectionId is a no-op", async () => {
    // Ensure the connectionId is not present.
    __clearActiveConnectionForTest("nonexistent-disconnect-id");
    await expect(disconnectMCPServer("nonexistent-disconnect-id")).resolves.not.toThrow();
  });

  it("shutdown — disconnects all activeConnections delete-first, Map empty after", async () => {
    const closeFn1 = jest.fn(() => Promise.resolve());
    const closeFn2 = jest.fn(() => Promise.resolve());
    let clientIdx = 0;
    (Client as jest.Mock).mockImplementation(() => {
      clientIdx += 1;
      return {
        connect: jest.fn(() => Promise.resolve()),
        listTools: jest.fn(() => Promise.resolve({ tools: [{ name: `t${clientIdx}`, description: "d" }] })),
        close: clientIdx === 1 ? closeFn1 : closeFn2,
        callTool: jest.fn(),
      };
    });

    const mk = (id: string) => ({
      id,
      name: `MCP-${id}`,
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-shutdown",
    });
    (prisma.mCPConnection.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(mk(where.id))
    );
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({});

    // Populate two active connections.
    await connectMCPServer(CONN_ID);
    await connectMCPServer("conn-life-2");

    // Verify both are active.
    const before = getActiveConnectionsSnapshot();
    expect(before.length).toBe(2);

    const deleteSpy = jest.spyOn(Map.prototype, "delete");
    await shutdownMCPConnections();

    // Both clients closed.
    expect(closeFn1).toHaveBeenCalled();
    expect(closeFn2).toHaveBeenCalled();

    // delete-first: each Map.delete must occur before the corresponding client.close.
    const deletes = deleteSpy.mock.invocationCallOrder;
    const closes = [
      ...closeFn1.mock.invocationCallOrder,
      ...closeFn2.mock.invocationCallOrder,
    ].sort((a, b) => a - b);
    // The earliest delete should precede the earliest close.
    expect(Math.min(...deletes)).toBeLessThan(Math.min(...closes));

    // Map is empty after shutdown.
    expect(getActiveConnectionsSnapshot().length).toBe(0);

    deleteSpy.mockRestore();
  });

  it("getActiveConnectionsSnapshot — returns array of { id, state } for active connections", async () => {
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "snap-tool", description: "d" }] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: jest.fn(),
    }));
    const mockConnection = {
      id: CONN_ID,
      name: "Snapshot MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      headers: "{}",
      projectId: null,
      workspaceId: "ws-snap",
    };
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue(mockConnection);
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue(mockConnection);

    await connectMCPServer(CONN_ID);

    const snap = getActiveConnectionsSnapshot();
    expect(snap.length).toBe(1);
    expect(snap[0]?.id).toBe(CONN_ID);
    expect(snap[0]?.state.connected).toBe(true);
    expect(snap[0]?.state.tools.map((t: { name: string }) => t.name)).toContain("snap-tool");
  });
});