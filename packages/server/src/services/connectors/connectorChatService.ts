// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-02 Task 3, D-07) — connectorChatService: the widget-seam
// NON-streaming arm for external connectors (spec §7.4 "keep the split").
//
// Reuses the widget seam's PRIMITIVES (runInlet/runOutlet filter chain,
// runAgent non-streaming entry point, resolveWidgetSystemPrompt grounding
// floor) but deliberately does NOT reuse the SSE facade (handleChatStream) —
// simulating the `res` would be fragile; spec §7.4 v1 verdict (D-07). The
// persistence sequence mirrors chat.ts's JWT non-streaming arm (:405-521):
// runInlet → runAgent → runOutlet → chatMessage.create ×2 (org-stamped).
//
// IDENTITY DISCIPLINE (T-198-06 anti-IDOR): workspace/archive identity comes
// from the CONNECTOR ROW only and the acting user is the widget service
// account — NEVER from any webhook/platform-supplied identifier. The model
// pin (responseProviderId/responseModel) threads from the connector columns;
// nulls fall through to the existing resolution chain (D-07).
//
// ERROR OWNERSHIP (D-12): this service re-throws on failure — the
// messageRouter owns the fallback send + health flip (single error owner).

import prisma from "../../utils/prisma";
import { logger } from "../../utils/logger";
import { runAgent } from "../../agent/orchestrator";
// Phase 207 (CLOUD-03, D-03 site 3 / D-05): pre-turn token quota gate on the
// CONNECTOR'S OWNING USER (Connector.createdBy — never widget-service@system,
// P2). Breach throws QuotaError(409, { error, quota: "tokens" }) which the
// messageRouter's fallback path surfaces to the channel (SC-1 clear error).
import { checkTokenQuota } from "../quotaService";
import { runInlet, runOutlet } from "../../filters/filterChain";
import { getSetting } from "../../services/systemConfigService";
import { getDlpBypassRoles } from "../../filters/plugins/dlp";
import { resolveWidgetSystemPrompt } from "../../services/widgetChatPrompt";
import { seedServiceAccount } from "../seedService";
import type { ConnectorPipelineRow } from "./base";

/** History window: NEWEST 20 rows (desc+reverse) → chronological last-10 pairs (D-08, WR-01). */
const HISTORY_TAKE = 20;
const HISTORY_PAIRS = 10;

/**
 * Module-level service-account id cache (D-08: the connector acts AS the
 * widget service account). Resolved lazily once per process.
 */
let serviceAccountId: string | null = null;

async function getServiceAccountId(): Promise<string> {
  if (serviceAccountId) return serviceAccountId;
  const account = await prisma.user.findFirst({
    where: {
      OR: [{ email: "widget-service@system" }, { username: "widget-service" }],
    },
    select: { id: true },
  });
  if (!account) {
    // seedServiceAccount() runs at every boot (index.ts:856) before any
    // connector traffic; a missing account is a boot-order violation — fail
    // loudly so the router surfaces it via the fallback path (D-12).
    throw new Error("widget-service@system account not found — run seedServiceAccount first");
  }
  serviceAccountId = account.id;
  return account.id;
}

/** Reset the module cache (tests only). */
export function resetServiceAccountIdCache(): void {
  serviceAccountId = null;
}

/**
 * D-07: run ONE non-streaming connector chat turn.
 *
 * Persistence sequence (the chat.ts JWT-arm mirror, :405-521 — no SSE res,
 * no handleChatStream import, spec §7.4):
 *  (a) acting user = the widget service account (module-cached id);
 *  (b) history = the chat's NEWEST 20 rows → chronological last-10 entries;
 *  (c) DLP gate: getSetting("DLP_ENABLED") + getDlpBypassRoles — the service
 *      account has no bypass roles, so scanning is ACTIVE whenever DLP_ENABLED;
 *  (d) runInlet({ ..., source: "chat" }) — the same DLP masking/audit chain
 *      as the authenticated chat path (D-21: connectors never bypass it);
 *  (e) runAgent — workspaceId/archiveId/locale from the CONNECTOR ROW (never
 *      input, T-198-06), pin columns threaded (null → resolution chain),
 *      grounding floor always resolveWidgetSystemPrompt(null) (no
 *      per-connector systemPrompt column v1), dlpMaskingEnabled threaded;
 *  (f) runOutlet(result.response);
 *  (g) chatMessage.create ×2 (user + assistant) with EXPLICIT organizationId
 *      (CR-03) — the assistant row carries the result metadata;
 *  (h) return { replyText }.
 *
 * NOTE the persistence ORDER: the user row is created AFTER the DLP inlet
 * (the masked text is what persists — A4 discipline, chat.ts:373-381 parity)
 * and BEFORE the agent (chat.ts's own sequence), so history for the next
 * turn includes the current user message.
 */
/**
 * Module-level orchestrator-seam override (198-04, OQ-1 option (b)
 * companion): the E2E full-mock doctrine (mcp-pin-use.spec.ts header) stubs
 * the agent at the seam the pipeline consumes — the connector pipeline's
 * agent seam is THIS service's runAgent call. The dev-only
 * /api/__tests__/telegram-fake/agent-stub route sets a canned reply;
 * runConnectorChatTurn consults it BEFORE runAgent. null = production
 * semantics (the real orchestrator runs).
 */
let chatTurnOverride: ((userText: string) => Promise<string>) | null = null;

/**
 * Set/clear the agent-seam stub (dev/test harness only — never called by
 * production runtime paths; the stop route clears it).
 */
export function setConnectorChatTurnOverride(
  impl: ((userText: string) => Promise<string>) | null
): void {
  chatTurnOverride = impl;
}

export async function runConnectorChatTurn(
  connector: ConnectorPipelineRow,
  session: { chatId: string | null },
  userText: string
): Promise<{ replyText: string }> {
  // E2E full-mock seam (198-04): when the harness stubbed the orchestrator,
  // return the canned reply WITHOUT touching the real agent chain — the
  // same doctrine as the MCP spec's browser-boundary SSE mock (D-03), moved
  // to the server-side seam there is no browser for.
  if (chatTurnOverride) {
    return { replyText: await chatTurnOverride(userText) };
  }
  if (!session.chatId) {
    // resolveSession guarantees a chatId before the pipeline reaches this
    // service; a null here is a caller-contract violation.
    throw new Error("connector session has no chatId — resolveSession must run first");
  }

  // (a) Acting user — the widget service account (seedServiceAccount's row).
  const userId = await getServiceAccountId();

  // Phase 207 (CLOUD-03, D-03 site 3 / D-05): pre-turn token quota gate on
  // the connector's OWNING user — before any LLM/persistence work so a
  // breached turn never consumes tokens or stages messages. The usage ledger
  // attributes to the same principal (quotaPrincipal below) — gate and
  // ledger stay consistent by construction. createdBy is non-nullable
  // (schema-verified) with a Restrict creator relation; the row type carried
  // by the pipeline (ConnectorPipelineRow) does not project it, so the
  // owner resolves from the row's id (one indexed read per turn).
  const connectorRow = await prisma.chatConnector.findUnique({
    where: { id: connector.id },
    select: { createdBy: true },
  });
  const quotaPrincipal = connectorRow?.createdBy;
  if (!quotaPrincipal) {
    // P2 fail-loud: mis-attribution to the shared service account is worse
    // than a failed turn — the messageRouter fallback surfaces the error to
    // the channel (SC-1 clear-error semantics).
    throw new Error(`Connector ${connector.id} has no resolvable owner — quota principal unresolvable (P2)`);
  }
  await checkTokenQuota(quotaPrincipal);

  // (b) History: the chat's NEWEST 20 rows (WR-01 — `asc` + take:20 with no
  // skip returns the conversation's OPENING messages and freezes agent
  // context past 20 turns; desc + reverse hands the last-10 chronological
  // pairs, D-08: no state outside the DB).
  const rows = await prisma.chatMessage.findMany({
    where: { chatId: session.chatId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TAKE,
  });
  const history = rows
    .reverse()
    .map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }))
    .filter((m: { role: string }) => m.role !== "system")
    .slice(-HISTORY_PAIRS * 2);

  // (c) DLP gate (chat.ts:433-434 pattern) — the service account carries no
  // bypass roles (its only role is "member"), so scan active when DLP_ENABLED.
  const dlpEnabled = (await getSetting("DLP_ENABLED")).value === "true";
  const userRoles: string[] = []; // service account — no bypass roles by contract
  const dlpScanEnabled = dlpEnabled && (await getDlpBypassRoles(userRoles)).length === 0;

  // (d) DLP inlet — source "chat" (filters/types.ts union untouched in 198).
  const inletCtx = await runInlet({
    message: userText,
    chatId: session.chatId,
    workspaceId: connector.workspaceId,
    userId,
    role: "user",
    metadata: {},
    streaming: false,
    source: "chat",
    userRoles,
  });
  const processedMessage = inletCtx.message;

  // Persist the user row AFTER the inlet (masked text is what lands).
  // WR-05: the org stamp resolves from the WORKSPACE chain — the same source
  // sessionResolver.createChat stamps the Chat with and the webhook arm's
  // tenant window opens with (routes/connectors.ts tenantOrgId). Stamping
  // from connector.organizationId diverged when connector org ≠ workspace
  // org (cross-org workspaceId accepted at create): the tenant-scoped
  // history read then excluded the rows and the agent saw empty history
  // every turn. One org source for the feature: the workspace chain.
  const workspaceOrg = await prisma.workspace.findUnique({
    where: { id: connector.workspaceId },
    select: { organizationId: true },
  });
  const organizationId = workspaceOrg?.organizationId ?? connector.organizationId;
  await prisma.chatMessage.create({
    data: {
      chatId: session.chatId,
      role: "user",
      content: processedMessage,
      // CR-03: explicit org stamp — resolved from the workspace chain
      // (never input).
      organizationId,
    },
  });

  // (e) runAgent NON-streaming — identity from the CONNECTOR ROW only
  // (T-198-06): workspace/archive/locale are row columns, the pin falls
  // through to the existing resolution chain when null (D-07), the grounding
  // floor is ALWAYS resolveWidgetSystemPrompt(null) (no per-connector
  // systemPrompt column v1 — D-07), and the reply-language directive composes
  // downstream because widgetSystemPrompt is set (orchestrator :304-307).
  const result = await runAgent({
    workspaceId: connector.workspaceId,
    userId,
    // Phase 207 (D-05): usage ledger attributes to the connector's owner.
    quotaPrincipal,
    message: processedMessage,
    chatId: session.chatId,
    history,
    providerId: connector.responseProviderId ?? undefined,
    model: connector.responseModel ?? undefined,
    archiveId: connector.archiveId ?? undefined,
    locale: connector.fallbackLocale,
    widgetSystemPrompt: resolveWidgetSystemPrompt(null),
    dlpMaskingEnabled: dlpScanEnabled,
  });

  // D-12: an empty response is a failure path — the caller (messageRouter)
  // owns the fallback send + health flip.
  if (!result.response || result.response.trim() === "") {
    throw new Error("agent returned an empty response");
  }

  // (f) DLP outlet on the assistant response.
  const outletCtx = await runOutlet({
    message: result.response,
    chatId: session.chatId,
    workspaceId: connector.workspaceId,
    userId,
    role: "assistant",
    metadata: {},
    streaming: false,
    source: "chat",
    userRoles,
  });
  const finalResponse = outletCtx.message;

  // (g) Assistant row with result metadata + explicit org stamp (CR-03,
  // chat.ts:511-527 pattern).
  await prisma.chatMessage.create({
    data: {
      chatId: session.chatId,
      role: "assistant",
      content: finalResponse,
      metadata: JSON.stringify({
        sources: result.sources,
        toolCalls: result.toolCalls,
        iterations: result.iterations,
        tokenUsage: result.tokenUsage ?? null,
        modelUsed: result.resolvedModel ?? null,
        modelProvider: result.providerType ?? null,
        // Connector provenance (Phase 199 UI badge support).
        connectorId: connector.id,
        platform: connector.platform,
      }),
      // CR-03: explicit org stamp (WR-05: workspace-chain source — same as
      // the user row above + createChat).
      organizationId,
    },
  });

  logger.debug("[connectors] chat turn completed", {
    connectorId: connector.id,
    chatId: session.chatId,
    iterations: result.iterations,
  });

  // (h) Non-streaming contract: the reply text only (no SSE, D-07).
  return { replyText: finalResponse };
}