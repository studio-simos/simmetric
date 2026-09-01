/**
 * Inspect an MCP connection by id using a STANDALONE MCP Client + transport.
 *
 * Run: pnpm --filter server exec tsx scripts/inspect-mcp.ts <connectionId> [toolName] [argsJson]
 *
 * Builds a STANDALONE MCP Client (does NOT call the live-server connect helper
 * — no mutation of the live server's activeConnections Map, Pitfall 3). Currently always
 * uses SSEClientTransport — Bug #5 (transportType ignored) is visible in the
 * output: the DB row's transportType is printed next to the actual transport
 * class, and they diverge for any non-sse row.
 *
 * If [toolName] is provided, calls that tool with [argsJson] (default {}).
 * callTool result is truncated to 2000 chars (T-59-04-01 mitigation).
 *
 * DO NOT paste script output into public channels — callTool results may
 * contain data from the upstream MCP server.
 */
import { prisma } from "../src/utils/prisma";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const connectionIdArg = process.argv[2];
  const toolNameArg = process.argv[3];
  const argsJsonArg = process.argv[4];

  if (!connectionIdArg) {
    console.error("Usage: tsx scripts/inspect-mcp.ts <connectionId> [toolName] [argsJson]");
    process.exit(1);
  }

  // 1. Load the connection row.
  const connection = await prisma.mCPConnection.findUnique({
    where: { id: connectionIdArg },
  });

  if (!connection) {
    console.error("[inspect-mcp] connection " + connectionIdArg + " not found");
    process.exit(1);
  }

  if (!connection.enabled) {
    console.warn("[inspect-mcp] connection is disabled in DB — attempting connect anyway");
  }

  console.log("[inspect-mcp] connection: " + connection.name + " (id=" + connection.id + ")");
  console.log("[inspect-mcp] url: " + connection.url);

  // 2. Parse headers (mirror mcpClient.ts:58-60). Surface Bug #24 on parse
  // failure — the live server logs a confusing error; here we print it inline.
  let parsedHeaders: Record<string, string> = {};
  try {
    parsedHeaders = connection.headers ? JSON.parse(connection.headers) : {};
  } catch (e) {
    console.error(
      "[inspect-mcp] headers JSON parse failed: " +
        (e as Error).message +
        " (Bug #24 — confusing error in live server)"
    );
  }

  // 3. Construct the transport (mirror mcpClient.ts:66-75). Bug #5: the DB
  // transportType is IGNORED — SSEClientTransport is always constructed.
  const transportOptions =
    Object.keys(parsedHeaders).length > 0
      ? { requestInit: { headers: new Headers(parsedHeaders) } }
      : undefined;
  const transport = new SSEClientTransport(new URL(connection.url), transportOptions);

  console.log(
    "[inspect-mcp] DB transportType: " +
      connection.transportType +
      " | actual transport: SSEClientTransport (Bug #5 — transportType ignored)"
  );

  // 4. Build a STANDALONE Client (do NOT call the live-server connect helper
  // — Pitfall 3: that mutates the module-level activeConnections Map in the
  // live server. This script is a separate tsx process, standalone client only).
  const client = new Client(
    { name: "simmetric-chat-mcp-inspect", version: "0.1.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
  } catch (err) {
    console.error("[inspect-mcp] connect failed: " + (err as Error).message);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log("[inspect-mcp] connected");

  // 5. List tools. .map is safe under noUncheckedIndexedAccess (no index access).
  const toolsResult = await client.listTools();
  console.log("[inspect-mcp] tools (" + toolsResult.tools.length + "):");
  if (toolsResult.tools.length > 0) {
    console.table(
      toolsResult.tools.map((t) => ({
        name: t.name,
        description: (t.description || "").slice(0, 80),
      }))
    );
  }

  // 6. Optional callTool. Truncate to 2000 chars (T-59-04-01 mitigation).
  if (toolNameArg) {
    let parsedArgs: Record<string, unknown> = {};
    if (argsJsonArg) {
      try {
        parsedArgs = JSON.parse(argsJsonArg) as Record<string, unknown>;
      } catch (e) {
        console.error(
          "[inspect-mcp] argsJson parse failed: " +
            (e as Error).message +
            " — calling tool with {}"
        );
      }
    }
    console.log("[inspect-mcp] calling tool " + toolNameArg + " with args: " + JSON.stringify(parsedArgs));
    const callResult = await client.callTool({ name: toolNameArg, arguments: parsedArgs });
    const resultStr = JSON.stringify(callResult, null, 2);
    console.log("[inspect-mcp] callTool " + toolNameArg + " result:");
    console.log(resultStr.slice(0, 2000) + (resultStr.length > 2000 ? "\n... (truncated)" : ""));
  }

  // 7. Defense-in-depth cleanup (T-59-04-02) even though the tsx process exits.
  await client.close();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("[inspect-mcp] failed:", e);
  process.exit(1);
});