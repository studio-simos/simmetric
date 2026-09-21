// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MCP Server — exposes the RAG search capability via the Model Context Protocol.
 *
 * External clients (like Cursor, VS Code, or other IDEs) can connect to this
 * MCP server to query the workspace knowledge base natively.
 *
 * Exposed tools:
 * - rag_query: Search a workspace's documents
 * - list_workspaces: List available workspaces for the authenticated user
 *
 * Transports:
 * - Streamable HTTP (stateless mode, primary): POST /api/mcp/mcp
 *   Each request is self-contained (MCP `2026-07-28` stateless core) — no
 *   initialize handshake, no Mcp-Session-Id, any instance can serve any
 *   request. `enableJsonResponse` keeps responses JSON-only so no SSE stream
 *   is held open behind load balancers.
 * - Legacy SSE (deprecated in v2, kept for old clients during the one-year
 *   grace period): GET /api/mcp/sse + POST /api/mcp/message.
 *
 * Uses the low-level Server class with proper schema imports from
 * `@modelcontextprotocol/core` (the v2 split-package home for schemas).
 */

import { Server } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy";
import type { CallToolRequest, ListToolsResult } from "@modelcontextprotocol/server";
import type { Express, Request, Response } from "express";
import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import axios from "axios";

// MCP-01 (D-01 / Phase 150): per-session SSE state, keyed by the SDK-generated
// sessionId. Only used by the LEGACY SSE surface below. The Streamable HTTP
// endpoint is stateless (v2 `2026-07-28`): a fresh transport per request, no
// session Map, no reaper.
//
// The MCP SDK's low-level `Server` (the class used here, NOT the high-level
// `McpServer`) does NOT support multiple concurrent transports on a single
// instance — `server.connect(transport)` throws "Already connected to a
// transport" if called twice. The SDK's own error message recommends "use a
// separate Protocol instance per connection", which is exactly what this Map
// does: each GET /sse gets its own `Server` + `SSEServerTransport` pair,
// stored together under the sessionId. POST /message looks up the entry by
// sessionId and routes to that entry's transport.
interface McpSession {
  server: Server;
  transport: SSEServerTransport;
}
const sseSessions = new Map<string, McpSession>();

// MCP v2 (SEP-2549): cache hints for the cacheable `2026-07-28` results,
// keyed by operation. The SDK stamps `ttlMs` / `cacheScope` into the result
// `_meta` when the handler does not provide its own values. The tool list is
// static per deployment (workspace filtering happens at tools/call), so a
// 5-minute user-scope cache lets clients skip repeated tools/list round-trips
// without holding a stream open to observe changes.
const TOOLS_LIST_CACHE_HINT = { ttlMs: 300_000, cacheScope: "public" as const };

/**
 * MCP-03 (D-05 / D-06 / Phase 150): auth gate for the MCP server endpoints.
 *
 * - When `MCP_API_KEY` is set (non-empty): require
 *   `Authorization: Bearer <MCP_API_KEY>`. Missing/wrong → 401.
 * - When `MCP_API_KEY` is unset: allow loopback (127.0.0.1 / ::1 / IPv4-mapped
 *   ::ffff:127.0.0.1) only; non-loopback remote → 401. Preserves the local
 *   dev workflow (Cursor → localhost) without exposing an unauthenticated
 *   surface to the network.
 *
 * Returns a discriminated union so callers can `return` early on `!ok`.
 */
function mcpAuthCheck(req: Request): { ok: true } | { ok: false; status: number; message: string } {
  const apiKey = getEnv().MCP_API_KEY;
  if (apiKey && apiKey.length > 0) {
    const expected = `Bearer ${apiKey}`;
    if (req.headers.authorization === expected) return { ok: true };
    return { ok: false, status: 401, message: "Missing or invalid MCP_API_KEY" };
  }
  // MCP_API_KEY unset → loopback-only fallback (D-06).
  // `req.ip` is populated by Express (respects trust proxy). Fall back to
  // `req.socket.remoteAddress` for direct connections.
  const ip = req.ip ?? req.socket?.remoteAddress ?? "";
  const isLoopback =
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1";
  if (isLoopback) return { ok: true };
  return {
    ok: false,
    status: 401,
    message: "MCP_API_KEY not set — remote connections require authentication",
  };
}

/**
 * Create and configure the MCP server.
 */
function createMCPServer(): Server {
  const server = new Server(
    {
      name: "simmetric-chat-rag",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      // MCP v2 (SEP-2549): cache hints for the cacheable 2026-07-28 results.
      // Applied when the handler result does not provide its own cache fields.
      cacheHints: {
        "tools/list": TOOLS_LIST_CACHE_HINT,
      },
    },
  );

  // Register the tool list handler. v2 typed form: string-key method +
  // typed request payload (replaces the v1 Zod-schema single-arg form).
  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => {
    return {
      tools: [
        {
          name: "rag_query",
          description: "Search documents in a specific workspace. Returns relevant chunks with source citations.",
          inputSchema: {
            type: "object" as const,
            properties: {
              workspaceId: {
                type: "string",
                description: "The ID of the workspace to search in",
              },
              query: {
                type: "string",
                description: "The search query",
              },
              limit: {
                type: "number",
                description: "Maximum number of results (default: 5)",
              },
            },
            required: ["workspaceId", "query"],
          },
        },
        {
          name: "list_workspaces",
          description: "List all workspaces the authenticated user has access to.",
          inputSchema: {
            type: "object" as const,
            properties: {
              userId: {
                type: "string",
                description: "The user ID to list workspaces for",
              },
            },
            required: ["userId"],
          },
        },
      ],
    };
  });

  // Handle tool calls. v2 typed form: string-key method + typed request.
  server.setRequestHandler("tools/call", async (request: CallToolRequest) => {
    const { name, arguments: args } = request.params;
    // D-08: `arguments` is optional in CallToolRequestParams (`Record<string,
    // unknown> | undefined`). The previous `any` annotation destructured
    // `args` directly; when `args` was `undefined` that destructuring threw a
    // `TypeError` which the surrounding `catch` turned into a "Search failed"
    // response. To keep this phase type-only (no behavior change), the
    // non-null assertion `args!` preserves that runtime contract: TS accepts
    // the assignment, but at runtime an absent `arguments` still yields
    // `undefined` and the downstream destructure still throws into the catch.
    const toolArgs: Record<string, unknown> = args!;

    switch (name) {
      case "rag_query": {
        const { workspaceId, query, limit = 5 } = toolArgs as { workspaceId?: string; query?: string; limit?: number };
        const env = getEnv();

        try {
          const response = await axios.post(`${env.COLLECTOR_URL}/api/ingest/query`, {
            query,
            workspaceId,
            limit,
          }, { timeout: 30000 });

          const results = response.data.results || [];
          const text = results.map((r: Record<string, unknown>) => {
            const meta = (r.metadata || {}) as Record<string, unknown>;
            return `[Source: ${meta.documentName || "Unknown"}${meta.pageNumber ? `, p.${meta.pageNumber}` : ""}]\n${meta.chunkText || ""}`;
          }).join("\n\n---\n\n");

          return {
            content: [{ type: "text", text: text || "No results found." }],
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Search failed: ${message}` }],
            isError: true,
          };
        }
      }

      case "list_workspaces": {
        // MCP-03 (D-07 / Phase 150): IDOR mitigation. In authenticated mode
        // (MCP_API_KEY set), the MCP_API_KEY holder is an admin-level
        // integration principal — `toolArgs.userId` is IGNORED and ALL
        // non-deleted workspaces are listed. The client can no longer
        // impersonate arbitrary users by passing a spoofed `userId`.
        // In dev loopback mode (MCP_API_KEY unset), `toolArgs.userId` is
        // honored so local Cursor+session testing still filters to the
        // signed-in user's workspaces.
        const apiKey = getEnv().MCP_API_KEY;
        const authenticated = !!(apiKey && apiKey.length > 0);
        const { userId } = toolArgs as { userId?: string };

        try {
          // Authenticated → admin principal: list ALL non-deleted workspaces.
          // Loopback → honor client userId (dev/testing only).
          const where: Record<string, unknown> = authenticated
            ? { deletedAt: null }
            : {
                deletedAt: null,
                OR: [
                  { project: { createdBy: userId } },
                  { accessGrants: { some: { userId } } },
                ],
              };

          const workspaces = await prisma.workspace.findMany({
            where,
            select: { id: true, name: true, projectId: true },
          });

          const text = workspaces.map((w: { name: string; id: string }) => `- ${w.name} (ID: ${w.id})`).join("\n") || "No workspaces found.";

          return {
            content: [{ type: "text", text }],
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to list workspaces: ${message}` }],
            isError: true,
          };
        }
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  return server;
}

/**
 * Mount the MCP server onto the Express app.
 * Provides:
 * - POST /api/mcp/mcp — Streamable HTTP (stateless, MCP v2 primary)
 * - GET /api/mcp/sse — legacy SSE connection for MCP v1 clients
 * - POST /api/mcp/message — legacy message endpoint for MCP v1 clients
 */
export function mountMCPServer(app: Express): void {
  // MCP-03 (D-06): emit ONE warn log at mount time when MCP_API_KEY is unset
  // so the operator is alerted that the MCP server is running in
  // unauthenticated localhost-only mode.
  if (!getEnv().MCP_API_KEY) {
    logger.warn("[mcp-server] MCP_API_KEY not set — MCP server running in unauthenticated localhost-only mode");
  }

  // ── v2 stateless Streamable HTTP ────────────────────────────────────────
  // Each POST is fully self-contained: a fresh `Server` + stateless
  // `NodeStreamableHTTPServerTransport` per request (sessionIdGenerator
  // undefined → no Mcp-Session-Id is issued or validated). Any server
  // instance can serve any request — no sticky sessions, no session store.
  // `enableJsonResponse: true` keeps responses as plain JSON (no SSE stream).
  app.post("/api/mcp/mcp", async (req: Request, res: Response) => {
    const auth = mcpAuthCheck(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.message });
      return;
    }

    // Phase 185: platform principal — same bypass surface as the legacy
    // endpoints below, set only after the auth gate passes.
    req.tenantBypass = true;

    const server = createMCPServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless (v2)
      enableJsonResponse: true,
    });
    res.on("close", () => {
      // Best-effort teardown; ignore errors — the transport/request ends here.
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      // Express has already parsed the body — pass it so the transport does
      // not attempt to re-read the consumed stream.
      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[mcp-server] Streamable HTTP request failed", { error: message });
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request failed" });
      }
    }
  });

  // ── Legacy SSE (v1 clients, one-year grace period) ─────────────────────
  // MCP-01 (D-01): per-session SSE. Each GET creates a fresh Server +
  // SSEServerTransport pair, stores it in the Map keyed by the SDK-generated
  // sessionId, and removes itself on `res.close`.
  app.get("/api/mcp/sse", (req: Request, res: Response) => {
    // MCP-03 (D-05/D-06): auth gate on the SSE endpoint.
    const auth = mcpAuthCheck(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.message });
      return;
    }

    // Phase 185 (D-05/D-08, T-185-08 — BYPASS SURFACE, citeable in the
    // org-b suite): the MCP principal is platform-level (MCP_API_KEY bearer
    // or loopback-only — mcpAuthCheck above), never a tenant member. The
    // sentinel is set ONLY after the auth gate passes (never on open
    // routes); downstream handlers run with the bypass arm of
    // tenantContextMiddleware if a slot is ever added, and the absent-store
    // extension-skip keeps SSE tool queries unscoped today.
    req.tenantBypass = true;

    const server = createMCPServer();
    const transport = new SSEServerTransport("/api/mcp/message", res);
    sseSessions.set(transport.sessionId, { server, transport });
    logger.info(`[mcp-server] New SSE connection established (sessionId=${transport.sessionId})`);
    server.connect(transport);

    res.on("close", () => {
      logger.info(`[mcp-server] SSE connection closed (sessionId=${transport.sessionId})`);
      const entry = sseSessions.get(transport.sessionId);
      if (entry) {
        // Best-effort close on the per-session server; ignore errors.
        entry.server.close().catch(() => {});
        sseSessions.delete(transport.sessionId);
      }
    });
  });

  // MCP-01 (D-02): route POST messages to the correct session by sessionId.
  // The SDK's SSEServerTransport sends `sessionId` as a query param in the
  // `endpoint` event (see SDK sse.js:74); we also accept the
  // `Mcp-Session-Id` header for forward-compat with streamable HTTP.
  app.post("/api/mcp/message", (req: Request, res: Response) => {
    // MCP-03 (D-05/D-06): auth gate on the message endpoint.
    const auth = mcpAuthCheck(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.message });
      return;
    }

    // Phase 185: same D-05 bypass surface as GET /api/mcp/sse above —
    // platform principal, set only after the auth gate passes.
    req.tenantBypass = true;

    const sessionId =
      (req.query.sessionId as string) ||
      (req.headers["mcp-session-id"] as string);

    const session = sessionId ? sseSessions.get(sessionId) : undefined;
    if (!session) {
      res.status(400).json({ error: "Unknown or expired MCP session" });
      return;
    }
    session.transport.handlePostMessage(req, res);
  });

  logger.info("[mcp-server] MCP server mounted at /api/mcp/mcp (stateless Streamable HTTP, v2) + /api/mcp/sse (legacy SSE)");
}