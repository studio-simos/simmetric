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
 * Transport: Server-Sent Events (SSE) for HTTP-based connections.
 *
 * Uses the low-level Server class with proper schema imports.
 * SDK v1.29+ requires schema objects (not string literals) for setRequestHandler.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Express, Request, Response } from "express";
import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import axios from "axios";

// MCP-01 (D-01 / Phase 150): per-session SSE state, keyed by the SDK-generated
// sessionId. Replaces the module-level singleton transport that dropped the
// first IDE when a second connected.
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
    },
  );

  // Register the tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
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

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
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
 * Provides two endpoints:
 * - GET /api/mcp/sse — SSE connection for MCP clients
 * - POST /api/mcp/message — Message endpoint for MCP clients
 */
export function mountMCPServer(app: Express): void {
  // MCP-01: a `Server` is created per SSE connection in the GET handler
  // (the SDK's low-level Server does not support multiple concurrent
  // transports on one instance).

  // MCP-03 (D-06): emit ONE warn log at mount time when MCP_API_KEY is unset
  // so the operator is alerted that the MCP server is running in
  // unauthenticated localhost-only mode.
  if (!getEnv().MCP_API_KEY) {
    logger.warn("[mcp-server] MCP_API_KEY not set — MCP server running in unauthenticated localhost-only mode");
  }

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

  logger.info("[mcp-server] MCP server mounted at /api/mcp/sse");
}