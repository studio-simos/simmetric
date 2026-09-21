// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * customSkills.registry.test.ts — the SC-1/SC-2 artifact (Plan 02 Task 1).
 *
 * Pins, behaviorally (NOT by grep):
 *  (a) SC-2/T-190-06: the builtinSkills Map is UNCHANGED after a
 *      resolveSkillsForChat call carrying N mock custom rows — customs are
 *      merged per-request, never registered (D-15).
 *  (b) D-16/Pitfall 6: a custom_<slug> whose slug equals a builtin name is
 *      SKIPPED at the merge (the DB-level rejection is Plan 01's schema;
 *      this pins the merge-side backstop).
 *  (c) Q3-c: an mcp_-prefixed registry entry and a custom_<slug> never
 *      collide (distinct prefixes).
 *  (d) SC-1 lifecycle: resolve includes the row → the mock row is soft-deleted
 *      → the SAME resolution excludes it (per-request DB resolution IS the
 *      invalidation contract — no hooks, no cache).
 *  (e) Zero custom rows → the exact pre-phase shape (the MCP-02 strict-union
 *      invariant intact).
 */
// @ts-nocheck

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../agent/mcpClient", () => ({
  __esModule: true,
  getMCPToolsForWorkspace: jest.fn().mockReturnValue([]),
}));

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import {
  resolveSkillsForChat,
  registerSkill,
  getAllBuiltinSkills,
  _clearAllSkills,
  type AgentSkillDefinition,
} from "../agent/skills";
import { getMCPToolsForWorkspace } from "../agent/mcpClient";

const WS = "aaaaaaaa-0000-4000-8000-0000000000aa";
const CHAT = "11111111-2222-3333-4444-555555555555";
const USER = "cccccccc-0000-4000-8000-0000000000cc";
const CONN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeBuiltin(name: string): AgentSkillDefinition {
  return {
    name,
    displayName: name,
    description: `desc:${name}`,
    type: "builtin",
    execute: jest.fn().mockResolvedValue({ success: true, data: "ok" }),
  };
}

function makeCustomRow(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `row-${slug}`,
    name: `custom_${slug}`,
    displayName: slug,
    description: `custom ${slug}`,
    type: "custom",
    config: JSON.stringify({ template: `Template of ${slug} {{x}}`, defaultParams: {} }),
    slug,
    skillMode: "prompt",
    inputSchema: JSON.stringify({ properties: { x: { type: "string" } }, required: [] }),
    isEnabled: true,
    isBuiltIn: false,
    organizationId: "org-default",
    userId: null,
    workspaceId: null,
    createdBy: USER,
    ...overrides,
  };
}

describe("custom skills — registry invariants (SC-2) + lifecycle (SC-1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearAllSkills();
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([]);
    (getMCPToolsForWorkspace as jest.Mock).mockReturnValue([]);
  });

  it("(a) builtinSkills Map keys are UNCHANGED after a resolution carrying N custom rows (D-15)", async () => {
    registerSkill(makeBuiltin("rag_search"));
    registerSkill(makeBuiltin("workspace_memory"));
    const before = getAllBuiltinSkills().map((s) => s.name).sort();

    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([
      makeCustomRow("alpha"),
      makeCustomRow("beta"),
      makeCustomRow("gamma"),
    ]);

    const resolved = await resolveSkillsForChat(WS, CHAT, ["rag_search", "workspace_memory"], { userId: USER });

    // The resolved array carries the customs…
    expect(resolved.map((s) => s.name)).toContain("custom_alpha");
    expect(resolved.map((s) => s.name)).toContain("custom_beta");
    expect(resolved.map((s) => s.name)).toContain("custom_gamma");
    // …but the registry Map is byte-identical before/after (no registerSkill).
    const after = getAllBuiltinSkills().map((s) => s.name).sort();
    expect(after).toEqual(before);
    expect(after).toEqual(["rag_search", "workspace_memory"]);
  });

  it("(b) a custom row colliding with an EXISTING base name is skipped with a warning (D-16 skip arm)", async () => {
    // The merge's skip arm fires when custom_<slug> equals a name ALREADY in
    // the base — e.g. a registry entry carrying that exact name (the DB-level
    // reserved-slug rejection is Plan 01's schema; this pins the merge-side
    // backstop). A slug equal to a builtin name produces the DISTINCT name
    // custom_<slug> (coexisting, never shadowing) — pinned by (b-bis).
    registerSkill({ ...makeBuiltin("rag_search"), name: "custom_alpha" });
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([makeCustomRow("alpha")]);

    // The colliding sentinel must reach the BASE: getSkillsForWorkspace picks
    // registry entries by enabledSkillNames.
    const resolved = await resolveSkillsForChat(WS, CHAT, ["custom_alpha"], { userId: USER });

    const names = resolved.map((s) => s.name);
    expect(names.filter((n) => n === "custom_alpha")).toHaveLength(1); // the base entry, exactly once
    expect(logger.warn).toHaveBeenCalledWith(
      "[skills] custom skill collision skipped",
      { name: "custom_alpha" },
    );
  });

  it("(b-bis) a custom slug equal to a builtin name never SHADOWS it — distinct names coexist", async () => {
    registerSkill(makeBuiltin("rag_search"));
    // RESERVED_SLUGS rejects this at create (Plan 01 schema); a legacy row
    // predating the gate coexists WITHOUT shadowing the builtin.
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([makeCustomRow("rag_search")]);

    const resolved = await resolveSkillsForChat(WS, CHAT, ["rag_search"], { userId: USER });

    const names = resolved.map((s) => s.name);
    expect(names.filter((n) => n === "rag_search")).toHaveLength(1); // the builtin survives
    expect(names).toContain("custom_rag_search"); // the custom coexists under its own name
  });

  it("(c) an mcp_-prefixed registry entry and a custom_<slug> never collide (distinct prefixes)", async () => {
    registerSkill(makeBuiltin(`mcp_${CONN}_translate`));
    // The MCP-02 union adds registry entries only for in-scope tools —
    // simulate an active connection exposing toolName "translate".
    (getMCPToolsForWorkspace as jest.Mock).mockReturnValue([
      { name: "translate", description: "d", inputSchema: {} } as never,
    ]);
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([makeCustomRow("translate")]);

    const resolved = await resolveSkillsForChat(WS, CHAT, [], { userId: USER });

    const names = resolved.map((s) => s.name).sort();
    expect(names).toEqual([`mcp_${CONN}_translate`, "custom_translate"].sort());
  });

  it("(d) SC-1 lifecycle: the row resolves → the DB excludes the soft-deleted row → the SAME resolution excludes it", async () => {
    registerSkill(makeBuiltin("rag_search"));
    const row = makeCustomRow("ephemeral");
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([row]);

    const first = await resolveSkillsForChat(WS, CHAT, ["rag_search"], { userId: USER });
    expect(first.map((s) => s.name)).toContain("custom_ephemeral");

    // The DELETE route sets deletedAt (soft delete, Plan 02 Task 2); the DB
    // filter (deletedAt: null) then EXCLUDES the row — the mock models the
    // DB's post-delete answer, not the row itself.
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);

    const second = await resolveSkillsForChat(WS, CHAT, ["rag_search"], { userId: USER });
    expect(second.map((s) => s.name)).not.toContain("custom_ephemeral");
    expect(second.map((s) => s.name)).toContain("rag_search");
  });

  it("(d-bis) a disabled row stops resolving (isEnabled filter — the DB's post-disable answer)", async () => {
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([makeCustomRow("paused")]);
    const first = await resolveSkillsForChat(WS, CHAT, [], { userId: USER });
    expect(first.map((s) => s.name)).toContain("custom_paused");

    // PUT isEnabled=false → the DB filter (isEnabled: true) excludes the row.
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);

    const second = await resolveSkillsForChat(WS, CHAT, [], { userId: USER });
    expect(second.map((s) => s.name)).not.toContain("custom_paused");
  });

  it("(e) zero custom rows → the exact pre-phase shape (MCP-02 strict union intact)", async () => {
    registerSkill(makeBuiltin("rag_search"));
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([]);

    const resolved = await resolveSkillsForChat(WS, CHAT, ["rag_search"], { userId: USER });

    expect(resolved.map((s) => s.name)).toEqual(["rag_search"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("customs resolve on the no-pins AND all-pins-disabled fallback paths (D-15 fallbacks carry customs too)", async () => {
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([
      {
        id: "p1",
        chatId: CHAT,
        connectionId: CONN,
        connection: { id: CONN, name: "fs", enabled: false, workspaceId: WS },
      },
    ]);
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([makeCustomRow("fallback-arm")]);

    const resolved = await resolveSkillsForChat(WS, CHAT, [], { userId: USER });
    expect(resolved.map((s) => s.name)).toContain("custom_fallback-arm");
  });

  it("legacy call sites without opts still resolve customs (additive-optional signature)", async () => {
    (prisma.agentSkill.findMany as jest.Mock).mockResolvedValue([makeCustomRow("legacy")]);
    const resolved = await resolveSkillsForChat(WS, CHAT, []);
    expect(resolved.map((s) => s.name)).toContain("custom_legacy");
    // The personal arm falls back to userId:null rows only — asserted at the
    // query layer in skillService.test.ts.
  });
});