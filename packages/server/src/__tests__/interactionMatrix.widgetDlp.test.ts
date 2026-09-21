// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 194 interaction matrix — pair 6/6: widget × DLP.
 *
 * ONE owned test (194-CONTEXT D-01) holding BOTH arms of the hard-never
 * contrast against an IDENTICAL masked-document fixture driven through
 * dlpRecomposeService's gate ladder TWICE:
 *   - authorized chat-source arm (dlp:unmask holder, toggle on, cited doc)
 *     → the done payload recomposes (placeholders resolved to originals);
 *   - widget-source request → gate 1 (isWidgetSource) returns the text
 *     UNCHANGED and buildRecompositionMap is NEVER invoked — the
 *     structural ordering (gate 1 fires BEFORE any entity-map load) IS the
 *     security property (T-194-01): the entity map is structurally never
 *     loaded for widget requests, so no code path reachable from the widget
 *     arm can decrypt.
 *
 * What is ALREADY pinned (D-02 — never re-asserted as owned assertions):
 *  - dlpRecompose.test.ts: the gate ladder's single-feature arms (widget
 *    hard-never negative, toggle arms, citation gating, tolerant
 *    substitution, no-double-substitution, V7 no-PII logging).
 *  The 194 owned value: the AUTHORIZED-vs-WIDGET CONTRAST in one test —
 *  same fixture, same options shape, only isWidgetSource differs — proving
 *  the widget exclusion is the SOLE variable and the ladder fails closed.
 *
 * Live-stack twin: e2e/dlp-document-pipeline.spec.ts :445 ("widget-context
 * chat keeps placeholders in the terminal message") runs the committed
 * widget hard-never e2e pin — 194-02 RUNS it; this unit test is the
 * server-side twin (D-01: the pair rides both pins). No e2e edits here.
 *
 * Postgres-free: mockPrisma + the resolver/entity seams mocked as
 * dlpRecompose.test.ts does.
 */
// @ts-nocheck
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Prisma mock — lazy holder (jest.mock factories hoist above const init).
interface MockPrismaShape {
  workspace: { findUnique: jest.Mock };
}
const prismaHolder: { prisma?: MockPrismaShape } = {};
function buildMockPrisma(): MockPrismaShape {
  return { workspace: { findUnique: jest.fn() } };
}
prismaHolder.prisma = buildMockPrisma();

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  get default() {
    return prismaHolder.prisma;
  },
  withSoftDelete: (where: Record<string, unknown>) => ({ ...where, deletedAt: null }),
}));

// rbac mocked wholesale — the single-resolver seam (dlpRecompose.test.ts
// idiom; the resolver's precedence matrix is pinned elsewhere).
const mockResolveWorkspaceRole = jest.fn();
jest.mock("../middleware/rbac", () => ({
  __esModule: true,
  resolveWorkspaceRole: (...args: unknown[]) => mockResolveWorkspaceRole(...args),
}));

const mockBuildRecompositionMap = jest.fn();
jest.mock("../services/dlpEntityService", () => ({
  __esModule: true,
  buildRecompositionMap: (...args: unknown[]) => mockBuildRecompositionMap(...args),
  buildPlaceholderRegex:
    jest.requireActual("../services/dlpEntityService").buildPlaceholderRegex,
}));

import prisma from "../utils/prisma";
import { recomposeForUser, extractCitedDocumentIds } from "../services/dlpRecomposeService";

const WS_ID = "c0000000-1000-4000-8000-000000000001";
const USER_ID = "c0000000-1000-4000-8000-000000000002";
const DOC_ID = "c0000000-1000-4000-8000-00000000000a";

// The IDENTICAL masked-document fixture both arms consume.
const MASKED_TEXT = "Il cliente [PERSON_1] ha una pratica aperta.";
const UNMASKED_TEXT = "Il cliente Mario Rossi ha una pratica aperta.";
const entityMap = new Map<string, string>([["[PERSON_1]", "Mario Rossi"]]);

/** dlp:unmask-holding chat user (the shape getEffectivePermissions reads). */
const chatUser = {
  id: USER_ID,
  roles: [
    {
      role: {
        name: "editor",
        permissions: [{ permissionName: "dlp:unmask" }, { permissionName: "chat:write" }],
      },
    },
  ],
};

/** Options shape shared by BOTH arms — only isWidgetSource differs. */
function baseOptions(isWidgetSource: boolean) {
  return {
    citedDocumentIds: [DOC_ID],
    attachedDocumentIds: [],
    userId: USER_ID,
    workspaceId: WS_ID,
    user: chatUser,
    isWidgetSource,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveWorkspaceRole.mockResolvedValue("editor");
  mockBuildRecompositionMap.mockResolvedValue(entityMap);
  prisma.workspace.findUnique.mockResolvedValue({ dlpDocumentScanEnabled: true });
});

describe("Phase 194 interaction matrix — widget × DLP (the hard-never contrast, one test, both arms)", () => {
  it("authorized chat source recomposes the done payload while the widget-source arm structurally never recomposes (gate 1 fires before any entity-map load) — same fixture, only isWidgetSource differs", async () => {
    // ── Control arm: authorized chat source ──
    const authorized = await recomposeForUser(MASKED_TEXT, baseOptions(false));
    expect(authorized).toBe(UNMASKED_TEXT);
    // Provenance plumbing: the done payload carries the recomposed text only
    // when the run cited/attached documents (extractCitedDocumentIds over the
    // same fixture feeds the gate).
    expect(extractCitedDocumentIds([{ documentId: DOC_ID } as never])).toEqual([DOC_ID]);
    const mapLoadsAfterControl = mockBuildRecompositionMap.mock.calls.length;
    expect(mapLoadsAfterControl).toBe(1);
    expect(mockResolveWorkspaceRole).toHaveBeenCalledWith(USER_ID, WS_ID, chatUser);

    // ── Widget arm: the SAME fixture, the SAME options, isWidgetSource=true ──
    const widget = await recomposeForUser(MASKED_TEXT, baseOptions(true));
    // The text returns UNCHANGED — the widget receives masked placeholders.
    expect(widget).toBe(MASKED_TEXT);
    expect(widget).not.toBe(UNMASKED_TEXT);
    // Structural ordering (T-194-01 mitigation, the security property): the
    // entity map was NOT loaded for the widget arm — gate 1 fired before any
    // entity-map load. Even a full-permission principal cannot override the
    // widget gate.
    expect(mockBuildRecompositionMap.mock.calls.length).toBe(mapLoadsAfterControl);
    expect(mockBuildRecompositionMap).not.toHaveBeenCalledTimes(mapLoadsAfterControl + 1);
    // And no workspace read either — the widget arm pays zero DLP cost.
    expect(prisma.workspace.findUnique).toHaveBeenCalledTimes(1); // control arm only
  });
});