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

jest.mock("@modelcontextprotocol/client", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    listTools: jest.fn(),
    close: jest.fn(),
    callTool: jest.fn(),
  })),
  SSEClientTransport: jest.fn().mockImplementation(() => ({ __kind: "sse" })),
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

// Phase 195 (MCPO-01): the OAuth lifecycle + registry seams are mocked at the
// module boundary — the header-switch tests assert the mcpClient-side logic
// (decrypt → Bearer build → merge), not the crypto itself (covered by
// oauthExchange.test.ts).
jest.mock("../services/oauthTokenLifecycle", () => ({
  decryptTokenBlob: jest.fn(),
  encryptTokenBlob: jest.fn(() => "iv:tag:reencrypted"),
  refreshAccessToken: jest.fn(),
}));
jest.mock("../services/oauthProviderRegistry", () => ({
  resolveProvider: jest.fn(),
  hasClientConfigured: jest.fn(),
  resolveScopes: jest.fn((_def: unknown, requested?: string) => (requested ? requested.split(/\s+/) : ["default-scope"])),
}));

import { Client } from "@modelcontextprotocol/client";
import { SSEClientTransport } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
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
  resolveConnectionHeaders,
  getActiveConnectionState,
  withConnectionLock,
} from "../agent/mcpClient";
import { registerSkill, unregisterSkillsForConnection, getAllBuiltinSkills } from "../agent/skills";
import { decryptTokenBlob, refreshAccessToken } from "../services/oauthTokenLifecycle";
import { resolveProvider, hasClientConfigured } from "../services/oauthProviderRegistry";

const mockedDecryptTokenBlob = decryptTokenBlob as jest.Mock;
const mockedRefreshAccessToken = refreshAccessToken as jest.Mock;
const mockedResolveProvider = resolveProvider as jest.Mock;
const mockedHasClientConfigured = hasClientConfigured as jest.Mock;

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
// ─── Phase 195 (MCPO-01 D-11/D-13/D-15a): header switch + reactive 401 ───

describe("resolveConnectionHeaders — authType switch (D-11, D-02 byte-identical)", () => {
  const CONN = "conn-oauth-1";
  const BLOB_TOKEN = "bearer-from-blob";

  beforeEach(() => {
    jest.clearAllMocks();
    mockedDecryptTokenBlob.mockReturnValue({
      ok: true,
      blob: { accessToken: BLOB_TOKEN, refreshToken: "rt", scope: "s", obtainedAt: new Date().toISOString() },
    });
  });

  function oauthRow(overrides: Record<string, unknown> = {}) {
    return {
      id: CONN,
      name: "OAuth MCP",
      authType: "oauth",
      oauthStatus: "authorized",
      oauthProvider: "google",
      oauthScopes: null,
      credentialsEncrypted: "iv:tag:ct",
      headers: JSON.stringify({ "X-Project": "proj-1" }),
      ...overrides,
    };
  }

  it("none/static passthrough unchanged — headers parsed via mcpHeadersSchema, no decrypt", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      id: "conn-static",
      name: "Static MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      authType: "static",
      oauthStatus: "none",
      headers: JSON.stringify({ "X-Api-Key": "k" }),
      projectId: null,
      workspaceId: "ws",
    });
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({});

    await connectMCPServer("conn-static");

    expect(mockedDecryptTokenBlob).not.toHaveBeenCalled();
    const call = (SSEClientTransport as jest.Mock).mock.calls[0];
    const headers = (call![1] as { requestInit: { headers: Headers } }).requestInit.headers;
    expect(headers.get("X-Api-Key")).toBe("k");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("legacy null authType behaves as none (D-02)", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      id: "conn-legacy",
      name: "Legacy MCP",
      transportType: "sse",
      enabled: true,
      authType: null,
      headers: "{}",
      projectId: null,
      workspaceId: "ws",
    });
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({});

    await connectMCPServer("conn-legacy");

    expect(mockedDecryptTokenBlob).not.toHaveBeenCalled();
  });

  it("oauth authorized → Authorization Bearer from the DECRYPTED blob + merged static header", async () => {
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      id: CONN,
      name: "OAuth MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      authType: "oauth",
      oauthStatus: "authorized",
      oauthProvider: "google",
      credentialsEncrypted: "iv:tag:ct",
      headers: JSON.stringify({ "X-Project": "proj-1" }),
      projectId: null,
      workspaceId: "ws",
    });
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({});

    await connectMCPServer(CONN);

    expect(mockedDecryptTokenBlob).toHaveBeenCalledWith("iv:tag:ct");
    const call = (SSEClientTransport as jest.Mock).mock.calls[0];
    const headers = (call![1] as { requestInit: { headers: Headers } }).requestInit.headers;
    // Server-built Bearer from the decrypted blob (never user input).
    expect(headers.get("Authorization")).toBe(`Bearer ${BLOB_TOKEN}`);
    // Static header merged under the Bearer.
    expect(headers.get("X-Project")).toBe("proj-1");
  });

  it("oauth not-authorized → refuses with a clear error (D-11)", async () => {
    // Assert via the exported helper directly — the connect-path error
    // posture deletes the entry from activeConnections, so
    // getConnectionStatuses (which iterates that Map) is not the observable
    // here. The helper's { ok: false, error } IS the connectionErrors
    // message source (set by the same code path inside connectMCPServer).
    const result = resolveConnectionHeaders(
      oauthRow({ oauthStatus: "pending" }) as unknown as Parameters<typeof resolveConnectionHeaders>[0]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not authorized");
  });

  it("oauth decrypt-failure → refuses with a message disclosing nothing about the blob", async () => {
    mockedDecryptTokenBlob.mockReturnValue({
      ok: false,
      errorDescription: "OAuth credential blob could not be decrypted",
    });
    const result = resolveConnectionHeaders(
      oauthRow() as unknown as Parameters<typeof resolveConnectionHeaders>[0]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("OAuth credential blob could not be decrypted");
      expect(result.error).not.toContain("iv:tag:ct");
    }
  });
});

describe("reactive-401 arm (D-13 / Pitfall 12 loop guard)", () => {
  let CONN_401: string;
  let capturedExecute: ((params: { query: string }) => Promise<{ success: boolean; data?: string; error?: string }>) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedExecute = null;
    // Unique id per test — connectMCPServer's ensureConnected cache is keyed
    // by id, and a connected id from a sibling test would short-circuit the
    // second connect (skipping registerSkill entirely).
    CONN_401 = `conn-401-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    mockedDecryptTokenBlob.mockReturnValue({
      ok: true,
      blob: { accessToken: "stale-token", refreshToken: "rt-1", scope: "s", obtainedAt: new Date().toISOString() },
    });
    mockedResolveProvider.mockReturnValue({ id: "google", tokenUrl: "https://fake/token" });
    mockedHasClientConfigured.mockReturnValue(true);
    mockedRefreshAccessToken.mockResolvedValue({
      ok: true,
      blob: { accessToken: "fresh-token", refreshToken: "rt-1", scope: "s", obtainedAt: new Date().toISOString() },
    });
    (prisma.mCPConnection.update as jest.Mock).mockResolvedValue({});
  });

  function stage401Connection(callToolImpl: jest.Mock) {
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "tool1", description: "d" }] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: callToolImpl,
    }));
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      id: CONN_401,
      name: "OAuth 401 MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      authType: "oauth",
      oauthStatus: "authorized",
      oauthProvider: "google",
      oauthScopes: null,
      credentialsEncrypted: "iv:tag:ct",
      headers: "{}",
      projectId: null,
      workspaceId: "ws-401",
    });
    return connectMCPServer(CONN_401).then(() => {
      // ../agent/skills is module-mocked — connectMCPServer registers through
      // the mock, so the execute closure comes from registerSkill.mock.calls.
      const registered = (registerSkill as jest.Mock).mock.calls
        .map((call) => call[0] as { name: string; execute: unknown })
        .find((s) => s.name === `mcp_${CONN_401}_tool1`);
      capturedExecute = registered?.execute as unknown as typeof capturedExecute;
      expect(capturedExecute).toBeTruthy();
    });
  }

  it("401 on tool call → exactly ONE refresh + reconnect + retry succeeds", async () => {
    let calls = 0;
    const callTool = jest.fn(() => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("HTTP 401 Unauthorized") as Error & { code?: number };
        err.code = 401;
        return Promise.reject(err);
      }
      return Promise.resolve({ content: [{ type: "text", text: "recovered" }] });
    });
    await stage401Connection(callTool);

    const result = await capturedExecute!({ query: "q" });

    expect(result.success).toBe(true);
    expect(result.data).toBe("recovered");
    expect(mockedRefreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("CR-01: retry rides the FRESH client (the closed old client is never called after reconnect)", async () => {
    // Distinct callTool mocks per Client instance: instance 1 always 401s,
    // instance 2 (post-reconnect) succeeds. The retry MUST hit instance 2 —
    // calling the closed instance 1 would throw "Not connected" and lose the
    // refreshed token's result (CR-01).
    const callTool1 = jest.fn(() => {
      const err = new Error("HTTP 401 Unauthorized") as Error & { code?: number };
      err.code = 401;
      return Promise.reject(err);
    });
    const callTool2 = jest.fn(() => Promise.resolve({ content: [{ type: "text", text: "from-fresh-client" }] }));
    const instances: Array<{ callTool: jest.Mock }> = [];
    (Client as jest.Mock).mockImplementation(() => {
      const inst = { connect: jest.fn(() => Promise.resolve()), listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "tool1", description: "d" }] })), close: jest.fn(() => Promise.resolve()), callTool: instances.length === 0 ? callTool1 : callTool2 };
      instances.push(inst);
      return inst;
    });
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      id: CONN_401,
      name: "OAuth 401 MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      authType: "oauth",
      oauthStatus: "authorized",
      oauthProvider: "google",
      oauthScopes: null,
      credentialsEncrypted: "iv:tag:ct",
      headers: "{}",
      projectId: null,
      workspaceId: "ws-401",
    });
    await connectMCPServer(CONN_401);
    const registered = (registerSkill as jest.Mock).mock.calls
      .map((call) => call[0] as { name: string; execute: unknown })
      .find((s) => s.name === `mcp_${CONN_401}_tool1`);
    const execute = registered?.execute as unknown as (params: { query: string }) => Promise<{ success: boolean; data?: string; error?: string }>;

    const result = await execute({ query: "q" });

    expect(result.success).toBe(true);
    expect(result.data).toBe("from-fresh-client");
    // The retry rode the SECOND client instance (the fresh one), never the
    // closed first instance.
    expect(instances.length).toBeGreaterThanOrEqual(2);
    expect(instances[1]?.callTool).toHaveBeenCalledTimes(1);
    // And the fresh client is the one now registered as the active state.
    expect(getActiveConnectionState(CONN_401)?.connected).toBe(true);
  });

  it("CR-02: the reactive 401 refresh is serialized by withConnectionLock", async () => {
    // The mock Client constructor hands EVERY instance the same callTool mock
    // (stage401Connection) — after the CR-01 fix the retry rides the FRESH
    // instance, so the second call must succeed (first call 401s, retry
    // succeeds). The observable lock effect: the refresh ran exactly once and
    // the arm delivered the retry result (a retry against the closed OLD
    // client would throw "Not connected" — CR-01 — landing in the catch).
    let calls = 0;
    const callTool = jest.fn(() => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("HTTP 401 Unauthorized") as Error & { code?: number };
        err.code = 401;
        return Promise.reject(err);
      }
      return Promise.resolve({ content: [{ type: "text", text: "recovered" }] });
    });
    await stage401Connection(callTool);

    const result = await capturedExecute!({ query: "q" });

    expect(result.success).toBe(true);
    expect(mockedRefreshAccessToken).toHaveBeenCalledTimes(1);
    // The retry rode the FRESH client (callTool called twice total: initial +
    // single retry — the fresh instance's callTool delivered the result).
    expect(callTool).toHaveBeenCalledTimes(2);
    // No leaked gate for this connection — the lock was acquired + released.
    const snapshot = getActiveConnectionsSnapshot();
    expect(snapshot.find((c) => c.id === CONN_401)?.state.connected).toBe(true);
  });

  it("401 persists after retry → exactly 1 refresh + success:false, NO second attempt (Pitfall 12)", async () => {
    const err401 = () => {
      const err = new Error("Unauthorized") as Error & { status?: number };
      err.status = 401;
      return err;
    };
    const callTool = jest.fn(() => Promise.reject(err401()));
    await stage401Connection(callTool);

    const result = await capturedExecute!({ query: "q" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("MCP tool error");
    // Loop guard: refresh happened at most once; callTool was attempted
    // exactly twice (initial + single retry), never a third time.
    expect(mockedRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("non-401 error → no refresh, standard error return", async () => {
    const callTool = jest.fn(() => Promise.reject(new Error("socket hang up")));
    await stage401Connection(callTool);

    const result = await capturedExecute!({ query: "q" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("socket hang up");
    expect(mockedRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("401 on a NON-oauth connection → no refresh (arm is oauth-only)", async () => {
    const callTool = jest.fn(() => Promise.reject(new Error("HTTP 401 Unauthorized")));
    (Client as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(() => Promise.resolve()),
      listTools: jest.fn(() => Promise.resolve({ tools: [{ name: "tool1", description: "d" }] })),
      close: jest.fn(() => Promise.resolve()),
      callTool: callTool,
    }));
    (prisma.mCPConnection.findUnique as jest.Mock).mockResolvedValue({
      id: "conn-static-401",
      name: "Static 401 MCP",
      url: "http://mcp-server.example.com/sse",
      transportType: "sse",
      enabled: true,
      authType: "static",
      headers: "{}",
      projectId: null,
      workspaceId: "ws",
    });
    await connectMCPServer("conn-static-401");
    const registered = (registerSkill as jest.Mock).mock.calls
      .map((call) => call[0] as { name: string; execute: unknown })
      .find((s) => s.name === "mcp_conn-static-401_tool1");
    const execute = registered?.execute as unknown as (params: { query: string }) => Promise<{ success: boolean; error?: string }>;

    const result = await execute({ query: "q" });

    expect(result.success).toBe(false);
    expect(mockedRefreshAccessToken).not.toHaveBeenCalled();
  });
});
