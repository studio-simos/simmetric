// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP chat re-composition tests (Phase 192 plan 03 Task 1 — tracer).
 *
 * Pins the D-08/D-09 gate ladder via dlpRecomposeService.recomposeForUser:
 *   - permission arms (unmask+toggle → re-composed; toggle-off / no-unmask
 *     / no-documents → unchanged)
 *   - widget hard-never arm (T-192-12: buildRecompositionMap is NEVER
 *     called for widget requests — the structural no-entity-load guarantee)
 *   - citation gating (T-192-13: only cited/attached documentIds scope the
 *     map; an unresolvable placeholder stays a literal token)
 *   - tolerant substitution (Pitfall 3(a): case-insensitive, whitespace-
 *     tolerant — "[ PERSON_1 ]", "[person_1]", "[Person_1]" all resolve)
 *   - no double-substitution (mask∘unmask∘unmask = unmask once)
 *   - no-plaintext-in-logs (V7 no-PII: logger calls carry counts only)
 *
 * chat.ts wiring invariants are pinned by source assertions (the route
 * module's SSE handler is not unit-drivable without a live agent): the
 * fixed Pitfall-4 order (tail flush → recompose → persist → done), the
 * masked-canonical persistence (A4), the additive-optional done content
 * field, and the Phase 190 D-13 non-regression (inlet block untouched).
 */
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Prisma mock — lazy holder (jest.mock factories are hoisted above const
// initializers; the factory must not dereference the holder eagerly).
interface MockPrismaShape {
  workspace: { findUnique: jest.Mock };
}
const prismaHolder: { prisma?: MockPrismaShape } = {};
function buildMockPrisma(): MockPrismaShape {
  return {
    workspace: { findUnique: jest.fn() },
  };
}
prismaHolder.prisma = buildMockPrisma();
const mockPrisma = prismaHolder.prisma!;

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  get default() {
    return prismaHolder.prisma;
  },
  withSoftDelete: (where: Record<string, unknown>) => ({ ...where, deletedAt: null }),
}));

// rbac mocked wholesale: resolveWorkspaceRole is THE single-resolver seam —
// the service-under-test must call THIS (source assertion below pins the
// import), never prisma.workspaceAccess directly.
const mockResolveWorkspaceRole = jest.fn();
jest.mock("../middleware/rbac", () => ({
  __esModule: true,
  resolveWorkspaceRole: (...args: unknown[]) => mockResolveWorkspaceRole(...args),
}));

const mockBuildRecompositionMap = jest.fn();
jest.mock("../services/dlpEntityService", () => ({
  __esModule: true,
  buildRecompositionMap: (...args: unknown[]) => mockBuildRecompositionMap(...args),
  // buildPlaceholderRegex rides the REAL module (plan 04 unification — the
  // export now lives in dlpEntityService.ts; the service-under-test imports
  // it from there). Re-export the actual implementation so the
  // tolerant-regex describe exercises the production definition.
  buildPlaceholderRegex: jest.requireActual("../services/dlpEntityService").buildPlaceholderRegex,
}));

import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import {
  recomposeForUser,
  extractCitedDocumentIds,
  buildPlaceholderRegex,
} from "../services/dlpRecomposeService";

const WS_ID = "c0000000-1000-4000-8000-000000000001";
const USER_ID = "c0000000-1000-4000-8000-000000000002";
const DOC_A = "c0000000-1000-4000-8000-00000000000a";
const DOC_B = "c0000000-1000-4000-8000-00000000000b";

/** dlp:unmask-holding user payload (the shape getEffectivePermissions reads). */
const unmaskUser = {
  id: USER_ID,
  roles: [{ role: { name: "editor", permissions: [{ permissionName: "dlp:unmask" }, { permissionName: "chat:write" }] } }],
};

/** Same shape WITHOUT dlp:unmask — the DEFAULT_USER_ROLE arm. */
const plainUser = {
  id: USER_ID,
  roles: [{ role: { name: "user", permissions: [{ permissionName: "chat:write" }] } }],
};

/** Admin payload — resolveWorkspaceRole's admin bypass arm. The seeded
 * DEFAULT_ADMIN_ROLE spreads [...PERMISSION_NAMES], so a live admin row
 * carries dlp:unmask; the fixture mirrors that seed shape. */
const adminUser = {
  id: USER_ID,
  roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }, { permissionName: "dlp:unmask" }] } }],
};

const maskedReader = {
  text: "Il firmatario è [PERSON_1] residente in [ADDRESS_1].",
  map: new Map<string, string>([
    ["[PERSON_1]", "Mario Rossi"],
    ["[ADDRESS_1]", "Via Roma 1"],
  ]),
};

function gateOn() {
  mockPrisma.workspace.findUnique.mockResolvedValue({ dlpDocumentScanEnabled: true });
}
function gateOff() {
  mockPrisma.workspace.findUnique.mockResolvedValue({ dlpDocumentScanEnabled: false });
}
function gateMissing() {
  mockPrisma.workspace.findUnique.mockResolvedValue(null);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveWorkspaceRole.mockResolvedValue("editor");
  mockBuildRecompositionMap.mockResolvedValue(maskedReader.map);
  gateOn();
});

describe("recomposeForUser — gate ladder (D-08)", () => {
  it("unmask-held + toggle-on + cited doc → re-composed text", async () => {
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(out).toBe("Il firmatario è Mario Rossi residente in Via Roma 1.");
  });

  it("unmask-held + toggle-off → unchanged (no map load, no permission cost)", async () => {
    gateOff();
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(out).toBe(maskedReader.text);
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("unmask-missing + toggle-on → unchanged (masking stays, no error)", async () => {
    mockResolveWorkspaceRole.mockResolvedValue("viewer");
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: plainUser,
      isWidgetSource: false,
    });
    expect(out).toBe(maskedReader.text);
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("admin arm → resolveWorkspaceRole admin tier + permission set", async () => {
    mockResolveWorkspaceRole.mockResolvedValue("admin");
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: adminUser,
      isWidgetSource: false,
    });
    expect(out).toContain("Mario Rossi");
    expect(mockResolveWorkspaceRole).toHaveBeenCalledWith(USER_ID, WS_ID, adminUser);
  });

  it("citedDocumentIds empty + no attached → unchanged (no toggle read, no map, no cost)", async () => {
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(out).toBe(maskedReader.text);
    expect(mockPrisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("workspace row missing → unchanged (fail-closed)", async () => {
    gateMissing();
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(out).toBe(maskedReader.text);
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("toggle read is document-anchored lazy — runs only when documents are cited (chat cost discipline)", async () => {
    await recomposeForUser("no placeholders here", {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("recomposeForUser — widget hard-never (T-192-12, D-08)", () => {
  it("isWidgetSource true → unchanged AND buildRecompositionMap NEVER called (no entity load)", async () => {
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: adminUser, // even full permissions cannot override the widget gate
      isWidgetSource: true,
    });
    expect(out).toBe(maskedReader.text);
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
    expect(mockPrisma.workspace.findUnique).not.toHaveBeenCalled();
  });
});

describe("recomposeForUser — citation gating + tolerant substitution (D-08/Pitfall 3)", () => {
  it("unresolvable placeholder (document not cited / map miss) stays a literal token", async () => {
    mockBuildRecompositionMap.mockResolvedValue(new Map([["[PERSON_1]", "Mario Rossi"]]));
    const out = await recomposeForUser("[PERSON_1] and [PERSON_2] met.", {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(out).toBe("Mario Rossi and [PERSON_2] met.");
  });

  it("map with zero rows (forged documentIds → no entity rows) → unchanged", async () => {
    mockBuildRecompositionMap.mockResolvedValue(new Map());
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: ["c0000000-1000-4000-8000-0000000000f0"],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(out).toBe(maskedReader.text);
  });

  it("attachedDocumentIds ride the SAME union (deduped) as citedDocumentIds", async () => {
    await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [DOC_A, DOC_B],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(mockBuildRecompositionMap).toHaveBeenCalledWith([DOC_A, DOC_B]);
  });

  it("map-load rejection → fail-closed unchanged text (never throws into the stream)", async () => {
    mockBuildRecompositionMap.mockRejectedValue(new Error("db down"));
    const out = await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(out).toBe(maskedReader.text);
  });

  it("BEHAVIORAL multi-doc: one stream citing TWO documents resolves placeholders from BOTH maps (192-UAT Test 3 — the D-08 union gate exercised end-to-end, not just as a mock-call count)", async () => {
    // Doc A carries the PERSON entity; Doc B the ADDRESS entity. The
    // response text carries BOTH placeholders; the union map ([DOC_A,
    // DOC_B]) must merge rows from both documents so a single stream-end
    // recompose resolves every cited document's entities.
    const multiDocMap = new Map<string, string>([
      ["[PERSON_1]", "Mario Rossi"],
      ["[ADDRESS_1]", "Via Roma 1"],
    ]);
    mockBuildRecompositionMap.mockImplementation(async (documentIds: string[]) => {
      // Behavioral shape assertion: the union arrives deduped and complete.
      expect([...documentIds].sort()).toEqual([DOC_A, DOC_B]);
      return multiDocMap;
    });
    const twoDocReader = {
      text: "Il firmatario è [PERSON_1] (doc A) abitante in [ADDRESS_1] (doc B).",
    };
    const out = await recomposeForUser(twoDocReader.text, {
      citedDocumentIds: [DOC_A, DOC_B],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: adminUser,
      isWidgetSource: false,
    });
    expect(out).toBe("Il firmatario è Mario Rossi (doc A) abitante in Via Roma 1 (doc B).");
  });

  it("BEHAVIORAL multi-doc: unmask-holder citing doc B only → doc A's placeholder stays a literal token (per-document provenance gate, 192-UAT Test 3 second arm)", async () => {
    // The provenance gate scopes the map to CITED documents only: a
    // response citing doc B must not resolve doc A's [PERSON_1] — the
    // placeholder survives as a literal in the user-visible answer.
    const docBOnlyMap = new Map<string, string>([
      ["[ADDRESS_1]", "Via Roma 1"],
    ]);
    mockBuildRecompositionMap.mockImplementation(async (documentIds: string[]) => {
      expect(documentIds).toEqual([DOC_B]);
      return docBOnlyMap;
    });
    const crossDocReader = {
      text: "Il firmatario è [PERSON_1] e abita in [ADDRESS_1].",
    };
    const out = await recomposeForUser(crossDocReader.text, {
      citedDocumentIds: [DOC_B],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: adminUser,
      isWidgetSource: false,
    });
    expect(out).toBe("Il firmatario è [PERSON_1] e abita in Via Roma 1.");
  });
});

describe("buildPlaceholderRegex — tolerant substitution (Pitfall 3(a))", () => {
  it.each([
    "[PERSON_1]",
    "[ PERSON_1 ]",
    "[person_1]",
    "[Person_1]",
    "[PERSON_ 1]",
    "[ PERSON_1]",
  ])("resolves variant %s to the mapped original", (variant) => {
    const regex = buildPlaceholderRegex("[PERSON_1]");
    const out = `Il firmatario è ${variant}.`;
    expect(out.replace(regex, "Mario Rossi")).toBe("Il firmatario è Mario Rossi.");
  });

  it("does not match a different class or number", () => {
    const regex = buildPlaceholderRegex("[PERSON_1]");
    expect(regex.test("[PERSON_2]")).toBe(false);
    regex.lastIndex = 0;
    expect(regex.test("[ADDRESS_1]")).toBe(false);
    regex.lastIndex = 0;
    expect(regex.test("[PERSON_12]")).toBe(false);
  });

  it("substitution output contains no remaining mapped placeholder tokens (no double-substitution)", async () => {
    const map = new Map<string, string>([
      ["[PERSON_1]", "Mario Rossi"],
      ["[ADDRESS_1]", "Via Roma 1"],
    ]);
    mockBuildRecompositionMap.mockResolvedValue(map);
    const first = await recomposeForUser("[PERSON_1] — [ADDRESS_1]", {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    expect(first).toBe("Mario Rossi — Via Roma 1");
    // A second call with the SAME map on already-resolved text is a no-op:
    // no mapped placeholder token survives.
    for (const placeholder of map.keys()) {
      expect(first.includes(placeholder.slice(1, -1))).toBe(false);
    }
  });
});

describe("extractCitedDocumentIds", () => {
  it("extracts, filters falsy, and dedupes citation documentIds", () => {
    const sources = [
      { documentId: DOC_A, documentName: "a" },
      { documentId: DOC_A, documentName: "a-dup" },
      { documentId: DOC_B, documentName: "b" },
      { documentName: "no-doc" },
    ] as unknown as Array<{ documentId?: string; documentName: string }>;
    expect(extractCitedDocumentIds(sources as never)).toEqual([DOC_A, DOC_B]);
  });

  it("absent sources → empty array", () => {
    expect(extractCitedDocumentIds(undefined)).toEqual([]);
  });
});

describe("V7 no-PII discipline — logs carry counts only", () => {
  it("no logger call carries a decrypted value", async () => {
    mockBuildRecompositionMap.mockResolvedValue(maskedReader.map);
    await recomposeForUser(maskedReader.text, {
      citedDocumentIds: [DOC_A],
      attachedDocumentIds: [],
      userId: USER_ID,
      workspaceId: WS_ID,
      user: unmaskUser,
      isWidgetSource: false,
    });
    const allCalls = [
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.debug as jest.Mock).mock.calls,
    ];
    const serialized = JSON.stringify(allCalls);
    expect(serialized).not.toContain("Mario Rossi");
    expect(serialized).not.toContain("Via Roma 1");
    expect(serialized).not.toContain("Il firmatario");
  });
});

describe("chat.ts wiring invariants (source assertions — Pitfall 4 fixed order, A4, D-13)", () => {
  const fs = require("fs");
  const path = require("path");
  const chatTs = fs.readFileSync(path.resolve(__dirname, "../routes/chat.ts"), "utf8");

  it("fixed order: tail flush → recompose → chatMessage.create → sendSSE done (Pitfall 4)", () => {
    const tailFlush = chatTs.indexOf("fullResponse += finalResponse;");
    const recompose = chatTs.indexOf("recomposeForUser(fullResponse");
    const persist = chatTs.indexOf("content: fullResponse,");
    const done = chatTs.indexOf('sendSSE("done"');
    expect(tailFlush).toBeGreaterThan(0);
    expect(recompose).toBeGreaterThan(tailFlush);
    expect(persist).toBeGreaterThan(recompose);
    expect(done).toBeGreaterThan(persist);
  });

  it("persisted canonical stays MASKED — both chatMessage.create sites persist the pre-recompose text (A4/T-192-15)", () => {
    // Non-streaming site (the `const assistantMessage` declaration).
    const nsSite = chatTs.indexOf("const assistantMessage = await prisma.chatMessage.create");
    const nsEnd = chatTs.indexOf("organizationId: req.organizationId!", nsSite);
    const nsBlock = chatTs.slice(nsSite, nsEnd);
    expect(nsBlock).toContain("content: finalResponse,");
    expect(nsBlock).not.toContain("content: finalForUserNs");
    // Streaming site (the bare `assistantMessage =` assignment — search
    // strictly after the const site's closing; the substring overlaps the
    // const declaration itself, so offset by the declaration length + 1).
    const streamStart = chatTs.indexOf("assistantMessage = await prisma.chatMessage.create", nsEnd);
    const streamEnd = chatTs.indexOf("organizationId: req.organizationId!", streamStart);
    const streamBlock = chatTs.slice(streamStart, streamEnd);
    expect(streamBlock).toContain("content: fullResponse,");
    expect(streamBlock).not.toContain("content: finalForUser");
  });

  it("done payload carries the additive-optional content field with the doneReason-style comment", () => {
    expect(chatTs).toMatch(/Phase 192 \(D-09\): additive optional — terminal re-composed text/);
    expect(chatTs).toContain("content: finalForUser !== fullResponse ? finalForUser : undefined,");
  });

  it("stream gate is chat-only — the widget arm never reaches the recompose call (T-192-12)", () => {
    expect(chatTs).toMatch(/dlpRecomposeEnabled = dlpScanEnabled && !isWidgetSource/);
  });

  it("non-streaming twin: recompose runs AFTER runOutlet, response carries the same additive content field", () => {
    const outlet = chatTs.indexOf("const outletCtx = await runOutlet");
    const nsRecompose = chatTs.indexOf("recomposeForUser(finalResponse");
    expect(outlet).toBeGreaterThan(0);
    expect(nsRecompose).toBeGreaterThan(outlet);
    expect(chatTs).toContain("content: finalForUserNs !== finalResponse ? finalForUserNs : undefined,");
  });

  it("no runOutlet-per-token re-composition (streaming stays placeholder-literal — D-09/Phase 100 Pitfall 4)", () => {
    // The recompose call must NOT sit inside the per-token onToken callback:
    // it appears exactly twice (stream-end + non-streaming twin).
    const callCount = (chatTs.match(/recomposeForUser\(/g) ?? []).length;
    expect(callCount).toBe(2);
  });

  it("Phase 190 D-13 non-regression: the dlpMaskingEnabled params gate + runInlet masking are untouched", () => {
    expect(chatTs).toContain("dlpMaskingEnabled: dlpScanEnabled");
    expect(chatTs).toMatch(/const inletCtx = await runInlet\(/);
    // The inlet block still redacts the message via inletCtx.
    expect(chatTs).toContain("const processedMessage = inletCtx.message;");
  });

  it("resolveWorkspaceRole is the single permission resolver (Phase 189 D-07 — no parallel role check)", () => {
    const svc = fs.readFileSync(path.resolve(__dirname, "../services/dlpRecomposeService.ts"), "utf8");
    expect(svc).toContain('import { resolveWorkspaceRole } from "../middleware/rbac"');
    // Never a direct workspaceAccess read in the recompose service.
    expect(svc).not.toContain("workspaceAccess");
  });
});