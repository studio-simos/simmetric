// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Echo MCP Server — lightweight test fixture for E2E marketplace lifecycle tests.
 *
 * Provides deterministic tools (echo, list_files) so the E2E test can predict
 * exactly which MCP sources appear in SSE done events.
 *
 * Uses the same SSEServerTransport pattern as mcpServer.ts.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import type { Server as HttpServer } from "http";

let httpServer: HttpServer | null = null;
let server: Server | null = null;
let transport: SSEServerTransport | null = null;

export function createEchoServer(): Server {
  const srv = new Server(
    { name: "echo-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "echo",
          description: "Echoes back the input message. Used for E2E testing.",
          inputSchema: {
            type: "object" as const,
            properties: {
              message: { type: "string", description: "The message to echo back" },
            },
            required: ["message"],
          },
        },
        {
          name: "list_files",
          description: "Returns a deterministic list of test files.",
          inputSchema: {
            type: "object" as const,
            properties: {},
          },
        },
      ],
    };
  });

  srv.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "echo":
        return {
          content: [{ type: "text", text: `Echo: ${args.message}` }],
        };
      case "list_files":
        return {
          content: [{ type: "text", text: JSON.stringify({ files: ["test1.txt", "test2.txt"] }) }],
        };
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  return srv;
}

/**
 * Start the echo MCP server on the given port (or a random available port).
 * Returns the actual port number the server is listening on.
 */
export function start(port?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const app = express();
    server = createEchoServer();

    app.get("/sse", (_req, res) => {
      transport = new SSEServerTransport("/message", res);
      server!.connect(transport);
      res.on("close", () => { transport = null; });
    });

    app.post("/message", (req, res) => {
      if (transport) {
        transport.handlePostMessage(req, res);
      } else {
        res.status(400).json({ error: "No active SSE connection" });
      }
    });

    httpServer = app.listen(port || 0, () => {
      const addr = httpServer!.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server address"));
      }
    });

    httpServer.on("error", reject);
  });
}

/**
 * Stop the echo MCP server and clean up resources.
 */
export function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close();
      server = null;
    }
    if (httpServer) {
      httpServer.close(() => {
        httpServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
