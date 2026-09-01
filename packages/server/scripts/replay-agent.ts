/**
 * Replay a stored chat through the real runAgent ReAct loop with LOG_LEVEL=debug
 * so each iteration, tool call, budget consumption, and termination cause is
 * visible in the orchestrator logs.
 *
 * Run: pnpm --filter server exec tsx scripts/replay-agent.ts <chatId> [message]
 *
 * If [message] is omitted, re-sends the chat's last user message.
 * Sets LOG_LEVEL=debug so orchestrator debug logs fire (CLAUDE.md §Logging —
 * the orchestrator logs via winston at debug level).
 *
 * NOTE: tokenUsage will be undefined until Phase 62 fixes Bug #7 (dead const
 * accumulators — totalPromptTokens/totalCompletionTokens are `const` in
 * orchestrator.ts:152-153 and never incremented). This script IS the
 * diagnostic for that bug: when the fix lands, the tokenUsage line below
 * will start printing real numbers.
 *
 * DO NOT paste script output into public channels — it may contain tool
 * call inputs/outputs from the workspace's RAG knowledge base.
 */
import { prisma } from "../src/utils/prisma";
import { runAgent } from "../src/agent/orchestrator";
import type { ChatMessageEntry } from "../src/agent/agentTypes";

async function main() {
  // Enable debug-level logging in the orchestrator (winston). The orchestrator's
  // logger.debug calls (e.g. "[orchestrator] Ollama call: ...") only fire when
  // LOG_LEVEL=debug. Also set DEBUG=agent:* for any debug-namespace-aware code.
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || "debug";
  process.env.DEBUG = process.env.DEBUG || "agent:*";

  const chatIdArg = process.argv[2];
  const messageArg = process.argv[3];

  if (!chatIdArg) {
    console.error("Usage: tsx scripts/replay-agent.ts <chatId> [message]");
    process.exit(1);
  }

  // 1. Load the chat with its messages ordered oldest → newest.
  const chat = await prisma.chat.findUnique({
    where: { id: chatIdArg },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  if (!chat) {
    console.error("[replay-agent] chat " + chatIdArg + " not found");
    process.exit(1);
  }

  // 2. Build history mirroring routes/chat.ts:319-322 exactly.
  const history: ChatMessageEntry[] = chat.messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  // 3. Resolve the message: explicit arg, else the chat's last user message.
  // noUncheckedIndexedAccess: slice(-1)[0] is T | undefined — guard via ?.
  const lastUserContent = chat.messages
    .filter((m) => m.role === "user")
    .slice(-1)[0]?.content;
  const message = messageArg || lastUserContent;

  if (!message) {
    console.error("[replay-agent] no message to send (chat has no user messages)");
    process.exit(1);
  }

  // 4. Resolve a userId. The plan assumed chat.userId (does NOT exist on the
  // Chat model — Rule 1 auto-fix). Traverse workspace → project.createdBy so
  // runAgent can fetch customInstructions; fall back to env / literal.
  const workspace = await prisma.workspace.findUnique({
    where: { id: chat.workspaceId },
    include: { project: { select: { createdBy: true } } },
  });
  const userId =
    process.env.USER_ID ||
    workspace?.project?.createdBy ||
    "<replay>";
  if (!process.env.USER_ID && !workspace?.project?.createdBy) {
    console.warn(
      "[replay-agent] could not resolve a real userId (workspace/project missing) — using \"" +
        userId +
        "\". customInstructions will be skipped."
    );
  }

  console.log("[replay-agent] chatId=" + chat.id + " workspaceId=" + chat.workspaceId);
  console.log("[replay-agent] userId=" + userId);
  console.log("[replay-agent] history messages=" + history.length);
  console.log(
    "[replay-agent] message (len=" +
      message.length +
      "): " +
      message.slice(0, 120) +
      (message.length > 120 ? "..." : "")
  );
  console.log(
    "[replay-agent] calling runAgent (non-streaming) with LOG_LEVEL=" + process.env.LOG_LEVEL
  );

  // 5. Call the real runAgent ReAct loop (non-streaming — simpler, no SSE harness).
  const result = await runAgent({
    workspaceId: chat.workspaceId,
    userId,
    message,
    chatId: chat.id,
    history,
  });

  // 6. Print the diagnostic fields. abortReason is NOT exposed on AgentRunResult
  // (it lives on the internal AgentBudgetTracker — see orchestrator.ts:166).
  // The plan assumed result.abortReason exists; print "(not exposed)" instead.
  console.log("[replay-agent] iterations: " + result.iterations);
  console.log(
    "[replay-agent] tokenUsage: " +
      JSON.stringify(result.tokenUsage ?? undefined) +
      " (undefined until Phase 62 fixes Bug #7 — dead const accumulators)"
  );
  console.log(
    "[replay-agent] abortReason: (not exposed on AgentRunResult — see orchestrator logs)"
  );
  console.log("[replay-agent] providerType: " + (result.providerType ?? "(none)"));
  console.log("[replay-agent] resolvedModel: " + (result.resolvedModel ?? "(none)"));
  console.log("[replay-agent] toolCalls: " + (result.toolCalls?.length ?? 0));
  if (result.toolCalls && result.toolCalls.length > 0) {
    console.table(
      result.toolCalls.map((tc) => ({
        tool: tc.tool,
        inputPreview: JSON.stringify(tc.input).slice(0, 80),
        outputLen: tc.output.length,
      }))
    );
  }
  console.log("[replay-agent] finalResponse length: " + (result.response?.length ?? 0));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[replay-agent] failed:", e);
  process.exit(1);
});