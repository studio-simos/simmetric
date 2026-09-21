// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Agent Skill Registry
 *
 * Defines the interface for agent skills (tools).
 * Each skill must be sandboxed — no arbitrary code execution.
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
// MCP-02 (D-03 / Phase 150): wire the workspace-scoped IDOR-mitigation filter
// into the agent skill resolution path. `getMCPToolsForWorkspace` was
// previously "INTENTIONALLY LATENT" (mcpClient.ts WR-04) — only the test
// suite called it. This import activates the runtime call site and resolves
// WR-04. See packages/server/src/agent/mcpClient.ts:460.
import { getMCPToolsForWorkspace } from "./mcpClient";
// Phase 190 (D-15/D-16): the per-request custom-skill resolver. skillService
// imports only prisma + shared types (type-only AgentSkillDefinition import —
// erased at compile time), so there is no import cycle.
import { resolveCustomSkillsForChat } from "../services/skillService";

export interface AgentSkillDefinition {
  name: string;
  displayName: string;
  description: string;
  /**
   * JSON Schema describing the skill's input parameters. Threaded into
   * `buildProviderTools` → `buildOpenAITools` `function.parameters` and
   * `buildAnthropicTools` `input_schema`. Optional — skills without
   * `inputSchema` fall back to `{ type: "object", properties: {} }`
   * (Ollama infers from description; OpenAI/Anthropic emit empty args
   * without a schema, which is the G-95-7/G-95-8 root cause). MCP skills
   * populate this from `DiscoveredTool.inputSchema` (mcpClient.ts:37).
   *
   * Phase 95-05 (G-95-7/G-95-8 closure): additive optional field — existing
   * skills without it compile and behave identically (backward-compat).
   */
  inputSchema?: Record<string, unknown>;
  // Phase 190 (SKIL-01 D-02): the union widens with "custom" — DB-persisted
  // prompt-template skills resolved per-request (D-15) and merged additively;
  // they never enter the builtinSkills Map (D-15/D-16).
  type: "builtin" | "mcp" | "custom";
  execute: (params: SkillParams) => Promise<SkillResult>;
}

export interface SkillParams {
  workspaceId: string;
  userId: string;
  query?: string;
  content?: string;
  filePath?: string;
  metadata?: Record<string, unknown>;
  sendEvent?: (event: string, data: unknown) => void;
  // D-08: deterministic chat-scoped archiveId threaded from Chat.archiveId through
  // the orchestrator. wiki_query / wiki_write prefer this over metadata.archiveId
  // (LLM-passed) to prevent cross-archive IDOR. rag_search is INVARIANT (D-07).
  archiveId?: string;
  // 131-07 (G-131-19): visitor locale (widget chat) — additive optional,
  // mirroring archiveId. Currently unused by builtin skills; available for
  // future skill-level localization needs.
  locale?: string;
  // Phase 190 (WR-02, D-13): thread the request's DLP masking decision
  // (DLP_ENABLED true AND no bypass role — the SAME dlpScanEnabled the chat
  // route computes) into skill execution so prompt-template skills mask
  // tool-input values BEFORE template compilation on the LLM-invoked path
  // too (the explicit /slug path is masked in the route; both invocation
  // styles share the masking contract through createPromptSkillExecutor).
  // Builtin skills ignore the flag (additive-optional — byte-identical).
  dlpMaskingEnabled?: boolean;
  // Phase 191 (KNOW-01 D-04): chat-attached wiki-archive IDs — org-validated
  // upstream by archiveAttachmentService.resolveAttachedArchives (silent
  // org-scoped filter); skills NEVER re-validate. Only rag_search consumes
  // them (retrieval union over archive:<id> pseudo-workspaces); other skills
  // ignore the field (additive-optional — byte-identical).
  attachedArchiveIds?: string[];
}

export interface SkillResult {
  success: boolean;
  data?: unknown;
  error?: string;
  sources?: SourceCitation[];
}

// D-03 (Phase 87): the canonical `SourceCitation` lives solely in
// @simmetric-chat/shared (D-01 additive superset). Import the type for local use
// (SkillResult.sources) and re-export it verbatim so `builtinSkills.ts` and
// other importers that import `from "./skills"` keep their paths unchanged.
import type { SourceCitation } from "@simmetric-chat/shared";
export type { SourceCitation } from "@simmetric-chat/shared";

/**
 * Builtin skill definitions — registered on server startup.
 * MCP skills are added dynamically via MCPClient.
 */
const builtinSkills: Map<string, AgentSkillDefinition> = new Map();

export function registerSkill(skill: AgentSkillDefinition) {
  builtinSkills.set(skill.name, skill);
}

export function getSkill(name: string): AgentSkillDefinition | undefined {
  return builtinSkills.get(name);
}

export function getAllBuiltinSkills(): AgentSkillDefinition[] {
  return Array.from(builtinSkills.values());
}

export function getSkillsForWorkspace(enabledSkillNames: string[]): AgentSkillDefinition[] {
  const skills: AgentSkillDefinition[] = [];
  for (const name of enabledSkillNames) {
    const skill = builtinSkills.get(name);
    if (skill) {
      skills.push(skill);
    }
  }
  return skills;
}

/**
 * Clear all registered skills. Used only in test teardown
 * to reset the module-level singleton Map between test suites.
 */
export function _clearAllSkills(): void {
  builtinSkills.clear();
}

/**
 * Resolve skills for a chat session, considering per-chat MCP connection pins.
 *
 * D-13 intersection model:
 * - No pins -> workspace-level enabled skills (existing behavior, D-15)
 * - Pins present -> filter to connections BOTH pinned AND enabled AND workspace-matching
 * - All pinned connections disabled -> fallback to workspace defaults with warning (D-15)
 *
 * D-16: Queries database on each call (no in-memory cache).
 * Uses builtinSkills Map for skill lookup by prefixed name.
 *
 * MCP-02 (D-03 / Phase 150): AFTER the pin/intersection logic produces its
 * base result, this function additionally unions in workspace-scoped MCP tools
 * discovered via `getMCPToolsForWorkspace(workspaceId)` (mcpClient.ts:460).
 * This activates the previously "INTENTIONALLY LATENT" IDOR-mitigation
 * filter (WR-04) at runtime: active+connected MCP connections scoped to this
 * workspace (or global) whose tools were NOT captured by the pin mechanism
 * (e.g. unpinned but active connections) are added to the result.
 *
 * D-04 invariant: the MCP-02 union is STRICTLY ADDITIVE — it never removes
 * builtin skills (`rag_search`, `workspace_memory`) or pinned MCP skills
 * already in the result. The D-15 fallback paths (no pins / all pins
 * disabled) return workspace defaults PLUS workspace-scoped MCP tools.
 *
 * Phase 190 (D-15/D-16): AFTER the MCP-02 union, EVERY return path is
 * wrapped with mergeCustomSkills — per-request DB resolution of custom
 * prompt-template skills (D-05 scope filter), strictly additive with
 * skip-and-warn on name collision. Custom definitions NEVER enter the
 * builtinSkills Map (D-15) and never overwrite registry keys (D-16 /
 * Pitfall 6). Custom resolution is NOT governed by
 * WorkspaceAgentConfig.enabledSkills (D-06 — that list controls builtins
 * only); a custom skill is invocable iff scope matches + isEnabled + not
 * deleted. opts.userId (additive-optional trailing param, Plan 02) feeds the
 * D-05 personal arm; the org filter rides the tenant ALS scope.
 */
export async function resolveSkillsForChat(
  workspaceId: string,
  chatId: string,
  enabledSkillNames: string[],
  opts?: { userId?: string },
): Promise<AgentSkillDefinition[]> {
  const pins = await prisma.chatMCPPin.findMany({
    where: { chatId },
    include: {
      connection: {
        select: { id: true, name: true, enabled: true, workspaceId: true, projectId: true },
      },
    },
  });

  // MCP-02 (D-03): compute the workspace-scoped MCP tools ONCE. A registry
  // skill `mcp_<connId>_<toolName>` is in-scope iff `getMCPToolsForWorkspace`
  // returns a DiscoveredTool with the same `toolName`. `getMCPToolsForWorkspace`
  // already honors the D-14 scope filter (workspaceId match OR global both-null
  // scope) AND the `connected` flag — so this is the source of truth for "which
  // MCP tools can this workspace see right now".
  const workspaceMcpTools = getMCPToolsForWorkspace(workspaceId);
  const inScopeToolNames = new Set(workspaceMcpTools.map((t) => t.name));

  // D-15: no pins -> use workspace defaults
  if (pins.length === 0) {
    const base = getSkillsForWorkspace(enabledSkillNames);
    return mergeCustomSkills(unionWorkspaceMcpSkills(base, inScopeToolNames), workspaceId, opts?.userId);
  }

  // D-13: intersection — pinned AND enabled AND (workspace-matching OR global).
  // Global connections (workspaceId null AND projectId null) are admin-
  // configured tools usable from any workspace — D-14 semantics mirrored from
  // getMCPToolsForWorkspace (mcpClient.ts). Project-scoped connections are
  // excluded: D-14 filters them out of workspace-chat tool resolution.
  const activePins = pins.filter(
    (p: typeof pins[number]) =>
      p.connection.enabled &&
      (p.connection.workspaceId === workspaceId ||
        (p.connection.workspaceId === null && p.connection.projectId === null)),
  );

  // D-15: all pinned connections disabled/out-of-scope -> fallback
  if (activePins.length === 0) {
    logger.warn(
      "[skills] All pinned MCP connections disabled or out-of-scope, falling back to workspace defaults",
      { chatId, workspaceId, pinnedCount: pins.length },
    );
    const base = getSkillsForWorkspace(enabledSkillNames);
    return mergeCustomSkills(unionWorkspaceMcpSkills(base, inScopeToolNames), workspaceId, opts?.userId);
  }

  // D-13: Collect active connection IDs (UUIDs) for prefix matching.
  // UUIDs contain no underscores, so `mcp_<id>_<tool>` prefix matching is unambiguous.
  const activeConnectionIds = new Set(activePins.map((p: typeof activePins[number]) => p.connection.id));

  // Collect all skill names from the registry matching active pinned connections
  const pinnedSkillNames: string[] = [];
  for (const skillName of builtinSkills.keys()) {
    for (const connId of activeConnectionIds) {
      if (skillName.startsWith(`mcp_${connId}_`)) {
        pinnedSkillNames.push(skillName);
        break;
      }
    }
  }

  // MCP-02: union — preserve enabled builtins (rag_search, workspace_memory) AND
  // add pinned MCP skills alongside. Replacing builtins with pinned MCP skills
  // silently dropped the two most important built-in capabilities (Pitfall 5).
  // Option A (registry merge) avoids Pitfall 5: builtins filtered by
  // enabledSkillNames are kept, pinned MCP skills are added from the registry.
  // No duplicate risk: builtin names never start with `mcp_`, pinned names do.
  const builtinSkillsForWorkspace = getSkillsForWorkspace(enabledSkillNames);
  const pinnedMcpSkills: AgentSkillDefinition[] = pinnedSkillNames
    .map((n) => builtinSkills.get(n))
    .filter((s): s is AgentSkillDefinition => s !== undefined);

  const base = [...builtinSkillsForWorkspace, ...pinnedMcpSkills];
  // MCP-02 (D-03): additionally union in workspace-scoped MCP tools that the
  // pin mechanism missed (unpinned but active+connected+in-scope). STRICT
  // UNION — D-04: never removes the pinned skills above; duplicates are
  // skipped by name (a pinned skill already in `base` is not re-added).
  return mergeCustomSkills(unionWorkspaceMcpSkills(base, inScopeToolNames), workspaceId, opts?.userId);
}

/**
 * MCP-02 (D-03 / Phase 150): union workspace-scoped MCP skills from the
 * `builtinSkills` registry into `base`, without dropping any existing entry.
 *
 * A registry skill `mcp_<connId>_<toolName>` is included iff:
 *   1. its `toolName` (the segment after `mcp_<connId>_`) appears in
 *      `inScopeToolNames` (i.e. `getMCPToolsForWorkspace` returned it for this
 *      workspace — which already enforces the D-14 scope filter + connected
 *      flag), AND
 *   2. it is NOT already present in `base` (by name) — D-04 strict union,
 *      no duplicates.
 *
 * The connectionId is recovered by splitting on the first underscore after
 * `mcp_` (UUIDs contain no underscores, so the split is unambiguous — same
 * invariant documented at mcpClient.ts:538). The trailing segment is the
 * tool name, which may itself contain underscores.
 */
function unionWorkspaceMcpSkills(
  base: AgentSkillDefinition[],
  inScopeToolNames: Set<string>,
): AgentSkillDefinition[] {
  if (inScopeToolNames.size === 0) return base;
  const present = new Set(base.map((s) => s.name));
  const additions: AgentSkillDefinition[] = [];
  for (const skillName of builtinSkills.keys()) {
    if (!skillName.startsWith("mcp_")) continue;
    if (present.has(skillName)) continue;
    // Strip `mcp_` then split on the FIRST underscore → [connId, toolName].
    // toolName may contain underscores; connId (UUID) never does.
    const rest = skillName.slice(4);
    const uuidEnd = rest.indexOf("_");
    if (uuidEnd <= 0) continue;
    const toolName = rest.slice(uuidEnd + 1);
    if (inScopeToolNames.has(toolName)) {
      const skill = builtinSkills.get(skillName);
      if (skill) additions.push(skill);
    }
  }
  if (additions.length === 0) return base;
  return [...base, ...additions];
}

/**
 * Phase 190 (D-15/D-16) — merge per-request custom skills into the resolved
 * base, STRICTLY ADDITIVE:
 *  - resolveCustomSkillsForChat hits the DB per request (SC-1 lifecycle
 *    invalidation: edit/delete propagates on the next chat with no hooks and
 *    no cache — Pitfall 7 rejected).
 *  - A custom definition is appended only when its `custom_<slug>` name is
 *    NOT already present (skip-and-warn on collision — D-16 / Pitfall 6). A
 *    custom slug equal to a builtin name cannot reach here via a DB create
 *    (RESERVED_SLUGS rejects it at the schema layer, Plan 01), so the skip
 *    arm is the registry-invariant backstop, not the primary gate.
 *  - Customs NEVER call registerSkill and NEVER touch builtinSkills — the
 *    Map is only ever mutated by registerSkill/unregisterSkillsForConnection
 *    (pinned behaviorally by customSkills.registry.test.ts).
 *  - MCP tools carry the `mcp_<connId>_<tool>` prefix, custom skills the
 *    `custom_<slug>` prefix — distinct namespaces, never colliding (Q3-c).
 */
async function mergeCustomSkills(
  base: AgentSkillDefinition[],
  workspaceId: string,
  userId?: string,
): Promise<AgentSkillDefinition[]> {
  const customDefinitions = await resolveCustomSkillsForChat(userId, workspaceId);
  if (customDefinitions.length === 0) {
    return base;
  }
  const present = new Set(base.map((s) => s.name));
  const additions: AgentSkillDefinition[] = [];
  for (const definition of customDefinitions) {
    if (present.has(definition.name)) {
      logger.warn("[skills] custom skill collision skipped", { name: definition.name });
      continue;
    }
    additions.push(definition);
  }
  if (additions.length === 0) return base;
  return [...base, ...additions];
}

/**
 * Remove all skills registered for a given MCP connection.
 * Used when disconnecting or deleting an MCP connection.
 *
 * D-13: accepts connectionId (UUID) — prefix is `mcp_<id>_<tool>`. UUIDs contain
 * no underscores, so prefix matching is collision-free (T-63-spoof mitigated).
 */
export function unregisterSkillsForConnection(connectionId: string): void {
  const prefix = `mcp_${connectionId}_`;
  for (const key of Array.from(builtinSkills.keys())) {
    if (key.startsWith(prefix)) {
      builtinSkills.delete(key);
    }
  }
}