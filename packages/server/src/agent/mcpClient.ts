// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP Client — connects to external MCP servers and registers their tools as Agent Skills.
 *
 * When an admin configures an MCP connection for a project/workspace,
 * this service connects to the MCP server, discovers available tools,
 * and registers them as skills in the Agent's skill registry.
 *
 * Security: MCP tool execution is sandboxed — tools run in the MCP server's
 * process, not in our server. We only pass the query and workspace context.
 *
 * Phase 63 (D-09/D-10/D-11/D-12/D-17):
 * - Transport fallback: StreamableHTTP primary → 4xx → SSE fallback (D-09).
 * - SSE-declared connections do NOT attempt streamable (D-11 single direction).
 * - 5xx does NOT trigger fallback (D-09).
 * - effectiveTransport cached in runtime state only (D-10, NOT persisted to DB).
 * - Headers read-side validation via mcpHeadersSchema (D-12) — parse failures
 *   surface to connectionErrors, never swallowed to {} (T-63-swallow).
 * - testMCPServerConnection honors transportType (D-17).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpHeadersSchema } from "@simmetric-chat/shared";
import { registerSkill, unregisterSkillsForConnection, type SkillParams, type SkillResult } from "../agent/skills";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

export interface DiscoveredTool {
  name: string;
  description: string;
  // D-08: opaque JSON-schema payload from the MCP server. Narrowed at the
  // registration boundary (registerSkill) where it flows into the skill input
  // shape; the discovered-tool surface itself only carries the raw schema
  // object verbatim. `Record<string, unknown>` matches the downstream cast
  // at line ~266 (`tool.inputSchema as Record<string, unknown>`).
  inputSchema: Record<string, unknown>;
}

type EffectiveTransport = "sse" | "streamable-http";

interface MCPConnectionState {
  client: Client;
  transport: SSEClientTransport | StreamableHTTPClientTransport;
  tools: DiscoveredTool[];
  connected: boolean;
  lastError: string | null;
  // D-10: runtime cache of which transport actually succeeded. NOT persisted to DB.
  effectiveTransport: EffectiveTransport;
  // D-13: human-readable connection name cached at connect time so resolveMcpSourceName
  // can map a UUID-prefixed tool name back to a display name without a DB round-trip.
  connectionName: string;
  // D-14 / MCP-05: scope metadata populated at connect time from the prisma row.
  // Used by getMCPToolsForWorkspace to filter activeConnections by workspaceId
  // (globals — both null — are included for any workspace). Prevents T-63-idor.
  scope: { workspaceId: string | null; projectId: string | null };
}

export interface ConnectionRuntimeStatus {
  liveStatus: "connected" | "disconnected" | "error";
  toolCount: number;
  lastError: string | null;
  effectiveTransport: EffectiveTransport | null;
}

// Active connections cache
const activeConnections = new Map<string, MCPConnectionState>();

// Connection error tracking
const connectionErrors = new Map<string, string>();

// D-06: Per-connection mutex. Each entry is the in-flight gate Promise for that
// connectionId. Serializes concurrent connect/disconnect/probe operations on the
// same connection so toggle/test/reaper cycles cannot race on the same socket
// (T-63-leak mitigation). The Map is keyed by connectionId and the entry is
// deleted in the `withConnectionLock` finally block — no leak across cycles.
const connectionLocks = new Map<string, Promise<void>>();

/**
 * D-06: Serialize an async operation against a single connectionId.
 *
 * - If a lock is already in-flight for this connectionId, AWAIT it first (catch
 *   swallowed — we only care about ordering, not the prior result).
 * - Install a new gate Promise, run `fn`, and in `finally` release the gate +
 *   delete the Map entry so the next caller does not see a stale lock.
 *
 * This prevents the toggle handler's disconnect racing the reaper's probe, the
 * test endpoint's connect+close racing a concurrent toggle, etc. One entry per
 * connectionId at a time; unrelated connectionIds proceed concurrently.
 */
export async function withConnectionLock<T>(
  connectionId: string,
  fn: () => Promise<T>
): Promise<T> {
  const existing = connectionLocks.get(connectionId);
  if (existing) {
    await existing.catch(() => {
      // Swallow — we only need the ordering guarantee, not the prior result.
    });
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connectionLocks.set(connectionId, gate);
  try {
    return await fn();
  } finally {
    release();
    connectionLocks.delete(connectionId);
  }
}

/**
 * D-09: Detect a 4xx HTTP status from a thrown SDK error.
 * SDK 1.29 duck-types the status on `err.code` (StreamableHTTP/SSE) or `err.status`
 * (forward-compatible with v2 SdkHttpError). 5xx returns false → no fallback.
 */
function is4xx(err: unknown): boolean {
  const code =
    (err as { code?: number; status?: number }).code ??
    (err as { status?: number }).status;
  return typeof code === "number" && code >= 400 && code < 500;
}

type TransportKind = "sse" | "streamable-http";

/**
 * D-09/D-10/D-11: Build a transport of the requested kind with optional requestInit headers.
 */
function buildTransport(
  kind: TransportKind,
  url: URL,
  headers: Record<string, string>
): SSEClientTransport | StreamableHTTPClientTransport {
  const requestInit = Object.keys(headers).length > 0
    ? { requestInit: { headers: new Headers(headers) } }
    : undefined;
  return kind === "streamable-http"
    ? new StreamableHTTPClientTransport(url, requestInit)
    : new SSEClientTransport(url, requestInit);
}

interface FallbackResult {
  client: Client;
  transport: SSEClientTransport | StreamableHTTPClientTransport;
  effectiveTransport: EffectiveTransport;
}

/**
 * D-09/D-10/D-11: Connect with transport fallback.
 *
 * - declared="streamable-http": try StreamableHTTP first, fall back to SSE on 4xx (D-09).
 *   5xx does NOT trigger fallback. SSE failure surfaces error (D-11: single fallback, no loops).
 * - declared="sse": try SSE only (D-11 single direction — no streamable attempt).
 *
 * On both transports failing, the error is thrown — caller is responsible for
 * setting connectionErrors + disconnecting.
 */
async function connectWithFallback(
  url: URL,
  headers: Record<string, string>,
  declared: TransportKind
): Promise<FallbackResult> {
  const tryOrder: TransportKind[] =
    declared === "streamable-http" ? ["streamable-http", "sse"] : ["sse"];

  for (let i = 0; i < tryOrder.length; i++) {
    const kind = tryOrder[i];
    if (!kind) continue;
    const transport = buildTransport(kind, url, headers);
    const client = new Client(
      { name: "simmetric-chat-mcp-client", version: "0.1.0" },
      { capabilities: {} }
    );
    try {
      await client.connect(transport);
      return { client, transport, effectiveTransport: kind };
    } catch (err) {
      try { await client.close(); } catch { /* ignore close errors on failed connect */ }
      // D-09: only 4xx on streamable triggers fallback to SSE; 5xx or SSE-fail throws.
      if (kind === "streamable-http" && is4xx(err) && i < tryOrder.length - 1) continue;
      throw err;
    }
  }
  // Unreachable: loop above either returns or throws.
  throw new Error("connectWithFallback exhausted without result");
}

/**
 * D-12 read-side: parse + validate stored headers. Returns validated record or
 * surfaces a descriptive error. NEVER swallows malformed config to {} (T-63-swallow).
 */
function parseAndValidateHeaders(
  raw: string | null | undefined,
  connectionId: string,
  connectionName: string
): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (err) {
    const msg = `Invalid headers JSON for connection ${connectionName}: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(`[mcp-client] ${msg}`);
    activeConnections.delete(connectionId);
    connectionErrors.set(connectionId, msg);
    return { ok: false, error: msg };
  }
  const validation = mcpHeadersSchema.safeParse(parsed);
  if (!validation.success) {
    const msg = `Invalid MCP headers for connection ${connectionName}: ${validation.error.issues.map((i: { message: string }) => i.message).join("; ")}`;
    logger.error(`[mcp-client] ${msg}`);
    activeConnections.delete(connectionId);
    connectionErrors.set(connectionId, msg);
    return { ok: false, error: msg };
  }
  return { ok: true, headers: validation.data };
}

/**
 * Connect to an external MCP server and discover its tools.
 *
 * MCP-03 (D-06): the entire body is serialized per-connectionId by
 * `withConnectionLock`. The `ensureConnected` guard at the top short-circuits
 * a redundant connect when an existing healthy connection is already cached —
 * 2x call = 1 connect under the mutex (T-63-leak mitigation).
 */
export async function connectMCPServer(connectionId: string): Promise<{ tools: DiscoveredTool[] }> {
  // MCP-03 ensureConnected: if a healthy connection is already cached, return its
  // tools without re-connecting. Read the cached state OUTSIDE the lock — the
  // lock below still serializes any caller that actually needs to connect.
  const cached = activeConnections.get(connectionId);
  if (cached && cached.connected && !cached.lastError) {
    return { tools: cached.tools };
  }

  return withConnectionLock(connectionId, async () => {
    // Re-check inside the lock: a concurrent caller may have just connected.
    const recached = activeConnections.get(connectionId);
    if (recached && recached.connected && !recached.lastError) {
      return { tools: recached.tools };
    }

    const connection = await prisma.mCPConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection || !connection.enabled) {
      logger.warn(`[mcp-client] Connection ${connectionId} not found or disabled`);
      return { tools: [] };
    }

    // D-12 read-side: validate headers before forwarding to external MCP server.
    const hdr = parseAndValidateHeaders(connection.headers, connectionId, connection.name);
    if (!hdr.ok) {
      // Error already surfaced to connectionErrors + activeConnections.delete; not swallowed.
      return { tools: [] };
    }
    const parsedHeaders = hdr.headers;

    try {
      const url = new URL(connection.url);
      const declared = (connection.transportType as TransportKind) ?? "sse";
      const { client, transport, effectiveTransport } = await connectWithFallback(url, parsedHeaders, declared);

      // Discover tools
      const toolsResult = await client.listTools();
      const tools: DiscoveredTool[] = ((toolsResult.tools as Array<{ name: string; description?: string; inputSchema: unknown }>) || []).map((tool) => ({
        name: tool.name as string,
        description: (tool.description || "") as string,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));

      // Register each tool as an agent skill
      for (const tool of tools) {
        // D-13: skill name prefix uses connection.id (UUID) — collision-free.
        // UUIDs contain no underscores, so `mcp_<id>_<tool>` prefix matching is unambiguous.
        const skillName = `mcp_${connection.id}_${tool.name}`;
        registerSkill({
          name: skillName,
          displayName: `[MCP] ${tool.name}`,
          description: tool.description,
          // Phase 95-05 (G-95-7/G-95-8 closure): surface the MCP server's
          // declared input schema so buildProviderTools can thread it into
          // OpenAI function.parameters / Anthropic input_schema. MCP tools
          // already carry inputSchema (DiscoveredTool.inputSchema, line 37);
          // this just hands it to the registry.
          inputSchema: tool.inputSchema,
          type: "mcp",
          async execute(params: SkillParams): Promise<SkillResult> {
            try {
              const result = await client.callTool({
                name: tool.name,
                arguments: {
                  query: params.query,
                  workspaceId: params.workspaceId,
                  ...params.metadata,
                },
              });

              const content = (result.content as Array<{ type: string; text?: string }>)?.map((c) => c.text || c.type || "").join("\n") || "No result";

              return {
                success: true,
                data: content,
              };
            } catch (err: unknown) {
              return { success: false, error: `MCP tool error: ${err instanceof Error ? err.message : String(err)}` };
            }
          },
        });
      }

      // Cache the connection state
      connectionErrors.delete(connectionId);
      activeConnections.set(connectionId, {
        client,
        transport,
        tools,
        connected: true,
        lastError: null,
        effectiveTransport,
        connectionName: connection.name,
        // D-14 / MCP-05: capture scope at connect time so getMCPToolsForWorkspace
        // can filter by workspaceId. Globals (both null) included for any workspace.
        scope: { workspaceId: connection.workspaceId, projectId: connection.projectId },
      });

      // Update last sync time
      await prisma.mCPConnection.update({
        where: { id: connectionId },
        data: { lastSyncAt: new Date() },
      });

      logger.info(`[mcp-client] Connected to ${connection.name} via ${effectiveTransport}, discovered ${tools.length} tools`);
      return { tools };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[mcp-client] Failed to connect to ${connection.name}: ${errMsg}`);
      activeConnections.delete(connectionId);
      connectionErrors.set(connectionId, errMsg);
      return { tools: [] };
    }
  });
}

/**
 * Disconnect from an MCP server.
 *
 * D-07 (delete-first): removes the entry from `activeConnections` BEFORE
 * awaiting `client.close()`. This prevents a concurrent probe/toggle from
 * observing and reusing a socket that is mid-teardown (T-63-leak).
 * D-06: the entire operation is serialized per-connectionId by
 * `withConnectionLock` so the reaper, toggle handler, and test endpoint
 * cannot race on the same socket.
 * Idempotent: calling on a non-existent connectionId is a no-op (no throw).
 */
export async function disconnectMCPServer(connectionId: string): Promise<void> {
  await withConnectionLock(connectionId, async () => {
    const state = activeConnections.get(connectionId);
    if (!state) return; // idempotent — no-op when not connected
    // DELETE-FIRST (D-07): drop from the Map before awaiting close so a
    // concurrent caller never sees a dying socket in activeConnections.
    activeConnections.delete(connectionId);
    connectionErrors.delete(connectionId);
    unregisterSkillsForConnection(connectionId); // D-13: by-id prefix removal
    try {
      await state.client.close();
    } catch (err: unknown) {
      logger.warn("[mcp-client] close error during disconnect", {
        connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info(`[mcp-client] Disconnected from ${connectionId}`);
  });
}

/**
 * D-08: Close all active MCP connections (delete-first) for graceful shutdown.
 *
 * `shutdownMCPConnections` iterates a snapshot of the connection IDs so
 * concurrent disconnects cannot mutate the iteration. Each disconnect goes
 * through `disconnectMCPServer` (mutex + delete-first + idempotent).
 */
export async function shutdownMCPConnections(): Promise<void> {
  const ids = Array.from(activeConnections.keys());
  for (const id of ids) {
    await disconnectMCPServer(id);
  }
  logger.info(`[mcp-client] Shutdown complete (${ids.length} connections closed)`);
}

/**
 * MCP-03: Return a snapshot of active connections as an array of
 * `{ id, state }` pairs. `getActiveConnectionsSnapshot` is used by the reaper
 * job (`mcpReaperJob.ts`) to iterate connections without holding a reference
 * to the module-private `activeConnections` Map.
 */
export function getActiveConnectionsSnapshot(): Array<{ id: string; state: MCPConnectionState }> {
  return Array.from(activeConnections.entries()).map(([id, state]) => ({ id, state }));
}

/**
 * MCP-03 / WR-07: Look up a single active connection by id. Used by the reaper
 * to re-check `connected` inside `withConnectionLock` after awaiting the gate —
 * a concurrent disconnect may have torn down the client while we waited.
 * Returns `undefined` if the connection is no longer cached.
 */
export function getActiveConnectionState(connectionId: string): MCPConnectionState | undefined {
  return activeConnections.get(connectionId);
}

/**
 * Initialize all enabled MCP connections on server startup.
 */
export async function initializeMCPConnections(): Promise<void> {
  const connections = await prisma.mCPConnection.findMany({
    where: { enabled: true },
  });

  logger.info(`[mcp-client] Initializing ${connections.length} MCP connections...`);

  for (const conn of connections) {
    await connectMCPServer(conn.id);
  }
}

/**
 * Get all discovered tools for a workspace/project's MCP connections.
 *
 * D-14 / MCP-05 (T-63-idor mitigation): filters `activeConnections` by scope.
 * - Workspace-scoped connections (scope.workspaceId set) are included only when
 *   `scope.workspaceId === workspaceId`.
 * - Global connections (both `scope.workspaceId` and `scope.projectId` null) are
 *   included for any workspace — admin-configured global tools remain usable
 *   from any workspace-scoped chat (D-14 discretion, A3 in RESEARCH.md).
 * - Disconnected connections are always excluded.
 *
 * The `workspaceId` argument MUST be honored — never iterate without the filter
 * (that was the latent IDOR this function replaced).
 *
 * WR-04: INTENTIONALLY LATENT. The only callers today are in
 * `packages/server/src/__tests__/mcpClient.test.ts`. No agent/orchestrator/chat
 * route consumes this function — the chat path resolves MCP skills via
 * `resolveSkillsForChat` (skills.ts) using the pin mechanism + the
 * `builtinSkills` registry. The IDOR fix therefore has zero runtime effect
 * until a caller is wired in. F64 (KB) is responsible for wiring this into the
 * agent's tool-resolution path. Do NOT remove the workspaceId filter — it is
 * the whole point of D-14 and must be honored when F64 wires the call site.
 *
 * The `isGlobal` branch below is DEFENSIVE-ONLY: `createMcpConnectionSchema`
 * refine requires exactly one of projectId/workspaceId (both-null is rejected),
 * and `marketplace.ts` install always sets `workspaceId` with `projectId: null`,
 * so a both-null scope cannot be produced through any current write path. The
 * branch is retained to keep the existing unit test ("globals included") green
 * and to remain forward-compatible if a future phase adds explicit global-scope
 * connections via a schema change.
 */
export function getMCPToolsForWorkspace(workspaceId: string): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];

  for (const [, state] of activeConnections) {
    if (!state.connected) continue;
    const isGlobal = !state.scope.workspaceId && !state.scope.projectId;
    if (isGlobal || state.scope.workspaceId === workspaceId) {
      tools.push(...state.tools);
    }
  }

  return tools;
}

/**
 * Get runtime status of all active MCP connections.
 */
export function getConnectionStatuses(): Map<string, ConnectionRuntimeStatus> {
  const result = new Map<string, ConnectionRuntimeStatus>();
  for (const [connectionId, state] of activeConnections) {
    result.set(connectionId, {
      liveStatus: state.connected ? "connected" : "error",
      toolCount: state.tools.length,
      lastError: connectionErrors.get(connectionId) ?? state.lastError ?? null,
      effectiveTransport: state.effectiveTransport,
    });
  }
  return result;
}

/**
 * Clear the stored error for a connection (e.g. before retry).
 */
export function clearConnectionError(connectionId: string): void {
  connectionErrors.delete(connectionId);
}

/**
 * TEST ONLY — populate activeConnections with a synthetic state for IDOR
 * scope-filter tests. Not part of the public runtime API; only used by
 * `mcpClient.test.ts` to set up workspace-scoped / global connection states
 * without going through `connectMCPServer` (which requires a live MCP server).
 *
 * @internal
 */
export function __setActiveConnectionForTest(
  connectionId: string,
  state: {
    tools: DiscoveredTool[];
    connected: boolean;
    scope: { workspaceId: string | null; projectId: string | null };
  }
): void {
  activeConnections.set(connectionId, {
    client: {} as Client,
    transport: {} as SSEClientTransport | StreamableHTTPClientTransport,
    tools: state.tools,
    connected: state.connected,
    lastError: null,
    effectiveTransport: "sse",
    connectionName: "test-connection",
    scope: state.scope,
  });
}

/**
 * TEST ONLY — remove a synthetic state set by `__setActiveConnectionForTest`.
 *
 * @internal
 */
export function __clearActiveConnectionForTest(connectionId: string): void {
  activeConnections.delete(connectionId);
}

/**
 * D-13: Resolve a UUID-prefixed MCP tool name back to the human-readable
 * connection.name for mcpSources reporting.
 *
 * Skill names follow the `mcp_<connectionId>_<toolName>` pattern where
 * `connectionId` is a UUID (8-4-4-4-12 hyphen groups, zero underscores).
 * The UUID is the segment between `mcp_` and the first `_` after it.
 *
 * Lookup order:
 *   1. activeConnections Map (live, O(1)) — populated at connect time
 *   2. prisma.mCPConnection.findUnique — fallback if disconnected mid-stream
 *
 * Returns null for non-mcp tools or unknown UUIDs (caller filters nulls).
 *
 * Pitfall 2 (RESEARCH.md): the old `lastIndexOf("_")` split broke under UUID
 * prefixes because tool names may contain underscores; UUIDs never do, so
 * the FIRST underscore after `mcp_` is the unambiguous UUID boundary.
 */
export async function resolveMcpSourceName(toolName: string): Promise<string | null> {
  if (!toolName.startsWith("mcp_")) return null;
  const rest = toolName.slice(4); // strip "mcp_"
  const uuidEnd = rest.indexOf("_");
  if (uuidEnd <= 0) return null;
  const uuid = rest.slice(0, uuidEnd);

  // 1. Live connection lookup — O(1) Map access, no DB hit.
  const state = activeConnections.get(uuid);
  if (state) return state.connectionName;

  // 2. DB fallback — connection may have been disconnected mid-stream.
  try {
    const row = await prisma.mCPConnection.findUnique({
      where: { id: uuid },
      select: { name: true },
    });
    return row?.name ?? null;
  } catch (err: unknown) {
    logger.warn("[mcp-client] resolveMcpSourceName DB lookup failed", {
      uuid,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Test connectivity to an MCP server without persisting any state.
 * Returns discovered tools on success or an error message on failure.
 *
 * D-17: honors transportType — streamable-http tries StreamableHTTP first with
 * 4xx→SSE fallback (same connectWithFallback helper as the live path).
 */
export async function testMCPServerConnection(
  url: string,
  headers?: Record<string, string>,
  transportType?: TransportKind
): Promise<
  | { success: true; toolCount: number; tools: Array<{ name: string; description: string }> }
  | { success: false; error: string }
> {
  const declared: TransportKind = transportType ?? "sse";
  // WR-03: validate headers at the client boundary so the test path enforces
  // the same hop-by-hop blocklist (D-12) as the live connect path. Legacy DB
  // rows that predate write-side validation, or rows inserted via the
  // marketplace gap (CR-01), would otherwise be forwarded to the transport
  // unvalidated. Admin-only endpoint, so this is defense-in-depth.
  let validatedHeaders: Record<string, string> = {};
  if (headers) {
    const hdr = mcpHeadersSchema.safeParse(headers);
    if (!hdr.success) {
      return {
        success: false,
        error: `Invalid headers: ${hdr.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    validatedHeaders = hdr.data;
  }

  try {
    const { client, effectiveTransport } = await connectWithFallback(new URL(url), validatedHeaders, declared);

    const toolsResult = await client.listTools();
    const tools = (toolsResult.tools || []).map((tool: Record<string, unknown>) => ({
      name: tool.name,
      description: tool.description || "",
    }));

    await client.close();

    logger.info(`[mcp-client] Test connection to ${url} succeeded via ${effectiveTransport}`);
    return {
      success: true,
      toolCount: tools.length,
      tools: tools.map(t => ({ name: t.name as string, description: t.description as string })),
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: (err instanceof Error ? err.message : String(err)) || "Unknown connection error",
    };
  }
}