// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { FilterPlugin, FilterContext } from "../types";
import { scanContentAsync } from "../../services/dlpFilter";
import { getSetting } from "../../services/systemConfigService";
import { logEvent } from "../../services/eventLogService";

const dlpMatchesByChat = new Map<string, Array<{ type: string; text: string }>>();

export function getAndClearDlpMatches(chatId: string): Array<{ type: string; text: string }> {
  const matches = dlpMatchesByChat.get(chatId) ?? [];
  dlpMatchesByChat.delete(chatId);
  return matches;
}

function addDlpMatches(chatId: string, matches: Array<{ type: string; text: string }>): void {
  const existing = dlpMatchesByChat.get(chatId) ?? [];
  dlpMatchesByChat.set(chatId, existing.concat(matches));
}

/**
 * Intersect the acting user's roles with the DLP_BYPASS_ROLES config list
 * (260829-n95, DLP_FEATURES_SPEC §2.2).
 *
 * Returns the INTERSECTED role names (empty array = no bypass → caller MUST
 * scan). Safe JSON.parse with [] fallback: a malformed value is fail-closed —
 * a broken config can never silently disable redaction. Legacy callers that
 * omit ctx.userRoles (undefined / empty) can never bypass.
 *
 * When the intersection is non-empty this function ALSO fires the
 * `dlp.bypassed` audit event (fire-and-forget), logging WHO bypassed (the
 * intersected role names) + the origin surface — never the content
 * (spec §4.6: the log is for traceability, not content reconstruction).
 */
async function resolveDlpBypassRoles(
  ctx: Pick<FilterContext, "userRoles" | "chatId" | "userId" | "source">,
): Promise<string[]> {
  if (!ctx.userRoles || ctx.userRoles.length === 0) return [];

  let bypassRoles: string[] = [];
  try {
    const parsed: unknown = JSON.parse((await getSetting("DLP_BYPASS_ROLES")).value || "[]");
    if (Array.isArray(parsed)) {
      bypassRoles = parsed.filter((r): r is string => typeof r === "string");
    }
  } catch {
    // Malformed config → no bypass (fail-closed, spec §4.6 audit integrity).
    return [];
  }
  if (bypassRoles.length === 0) return [];

  const intersected = ctx.userRoles.filter(r => bypassRoles.includes(r));
  if (intersected.length > 0) {
    // Fire-and-forget: an audit-log failure must never block the chat (D-03
    // non-blocking convention shared with publishSSEEvent/recordWidgetEvent).
    // Promise.resolve(...) guards mock/void logEvent impls (no .catch on
    // undefined).
    void Promise.resolve(
      logEvent("dlp", ctx.chatId, "dlp.bypassed", ctx.userId, {
        roles: intersected,
        ...(ctx.source ? { source: ctx.source } : {}),
      }),
    ).catch(() => {});
  }
  return intersected;
}

/**
 * Pure READ variant for callers that need the bypass DECISION without firing
 * the `dlp.bypassed` audit (260829-n95). Used by the handleChatStream inline
 * streaming gate: the plugin inlet already emitted the single dlp.bypassed
 * event for the request, so re-evaluating here must not double-log. Same
 * safe-parse/fail-closed semantics as resolveDlpBypassRoles.
 */
export async function getDlpBypassRoles(userRoles: string[]): Promise<string[]> {
  if (!userRoles || userRoles.length === 0) return [];
  let bypassRoles: string[] = [];
  try {
    const parsed: unknown = JSON.parse((await getSetting("DLP_BYPASS_ROLES")).value || "[]");
    if (Array.isArray(parsed)) {
      bypassRoles = parsed.filter((r): r is string => typeof r === "string");
    }
  } catch {
    return [];
  }
  if (bypassRoles.length === 0) return [];
  return userRoles.filter(r => bypassRoles.includes(r));
}

export const dlpPlugin: FilterPlugin = {
  name: "dlp",
  priority: -1,
  description: "DLP PII redaction (email, credit card, API key, SSN, AWS key, private key)",
  outletStreaming: true,

  inlet: async (ctx: FilterContext): Promise<FilterContext | void> => {
    const dlpEnabled = (await getSetting("DLP_ENABLED")).value === "true";
    if (!dlpEnabled) return;

    // 260829-n95: role bypass — skip ALL scanning for this request.
    const bypassRoles = await resolveDlpBypassRoles(ctx);
    if (bypassRoles.length > 0) return;

    const inputScan = await scanContentAsync(ctx.message);
    if (inputScan.hasMatch) {
      const matchTypes = [...new Set(inputScan.matches.map(m => m.type))];
      addDlpMatches(ctx.chatId, inputScan.matches.map(m => ({ type: m.type, text: m.matchedText })));
      await logEvent("dlp", ctx.chatId, "dlp.input_match", ctx.userId, {
        matchTypes,
        matches: inputScan.matches,
        // 260829-ms8: origin surface from FilterContext (chat | widget);
        // undefined for legacy callers → key omitted from metadata.
        ...(ctx.source ? { source: ctx.source } : {}),
      });
      return { ...ctx, message: inputScan.redactedText };
    }
  },

  outlet: async (ctx: FilterContext): Promise<FilterContext | void> => {
    const dlpEnabled = (await getSetting("DLP_ENABLED")).value === "true";
    if (!dlpEnabled) return;

    if (ctx.streaming) return;

    // 260829-n95: role bypass — same semantics as inlet.
    const bypassRoles = await resolveDlpBypassRoles(ctx);
    if (bypassRoles.length > 0) return;

    const outputScan = await scanContentAsync(ctx.message);
    if (outputScan.hasMatch) {
      const matchTypes = [...new Set(outputScan.matches.map(m => m.type))];
      addDlpMatches(ctx.chatId, outputScan.matches.map(m => ({ type: m.type, text: m.matchedText })));
      await logEvent("dlp", ctx.chatId, "dlp.output_match", ctx.userId, {
        matchTypes,
        matches: outputScan.matches,
        // 260829-ms8: origin surface from FilterContext (chat | widget);
        // undefined for legacy callers → key omitted from metadata.
        ...(ctx.source ? { source: ctx.source } : {}),
      });
      return { ...ctx, message: outputScan.redactedText };
    }
  },
};

export default dlpPlugin;