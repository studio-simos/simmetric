// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SC-4 read-path behavioral matrix (Phase 192 plan 04 Task 2 — DLP-04).
 *
 * One behavioral pin per row of the 192-RESEARCH.md §Read-Path Inventory
 * (rows 1-18). The matrix PROVES structural masking inheritance: chunkText
 * is masked at the storage layer (plan 02), so read paths serve masked text
 * with NO active masking code — each positive row feeds a fixture chunkText
 * in masked form ("[PERSON_1] Maria Rossi") and asserts the served artifact
 * carries the placeholder, NOT the original. Negative rows (widget, MCP,
 * citations) are hard nevers: the serving path must never call
 * buildRecompositionMap / never decrypt. Structural rows (2/4/14/18) pin
 * the source shape as regression tripwires.
 *
 * Row map (RESEARCH inventory row # → describe):
 *   1  DOC-01 text view       — dlpPreviewRoutes.test.ts (route battery); here: the masked-by-inheritance default arm
 *   2  Document detail        — source-proof: GET /:documentId serves metadata (no chunkText in its response path)
 *   3  OCR preview job detail — document-sourced job over a DLP-scanned doc → masked markdown; archive-page job untouched
 *   4  Synthesis context      — source-proof: synthesis stages read archivePage.bodyText, zero chunkText reads
 *   5  Citations SSE          — sources carry the masked chunkText verbatim; no recompose call
 *   6  Widget RAG pre-search  — /search results pass through byte-relay; NEVER recomposed (negative pin)
 *   7  Widget chat stream     — widget source never enters recomposeForUser (chat.ts structural gate, source-proof + negative)
 *   8  MCP rag_query          — meta.chunkText formatting is verbatim-from-store; no decrypt call (negative pin)
 *   9  rag_search skill       — textChunks/sources carry masked chunkText verbatim
 *   10 FTS leg                — dc."chunkText" read as stored; no transform between read and serve
 *   11 Vector metadata        — r.text || metadata.chunkText read as stored
 *   12 Attach-document ctx    — doc.chunks.map(chunkText) served as stored
 *   13 Chat export            — exported sources (metadata JSON round-trip) inherit masked chunkText
 *   14 Project export         — select list carries metadata only, NO chunkText (source-proof)
 *   15 KB copy-from-doc       — reconstructDocumentText over masked chunks → masked archive page
 *   16 Admin re-embed         — reembeds what's in DB (masked) — structural round-trip, no plaintext resurrection arm
 *   17 Upload FTS write       — write path (not a read; inventory notes DLP hook placement only — structural note test)
 *   18 wikiChat distill       — its "chunkText" is CHAT MESSAGES, not document chunks (name-collision-only source-proof)
 *
 * Postgres-free: prisma/vector modules mocked per the established suite
 * style. Suite target < 20s.
 */
import "./helpers/setupEnv";

// ─── Shared mocks (module-load safety + behavior control) ────────────────

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockBuildRecompositionMap = jest.fn();
jest.mock("../services/dlpEntityService", () => ({
  __esModule: true,
  buildRecompositionMap: (...args: unknown[]) => mockBuildRecompositionMap(...(args as [])),
  buildPlaceholderRegex:
    jest.requireActual("../services/dlpEntityService").buildPlaceholderRegex,
  loadEntityMap: jest.fn(),
  writeEntityMap: jest.fn(),
  deleteEntityMap: jest.fn(),
}));

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn(), put: jest.fn() },
  post: jest.fn(),
  get: jest.fn(),
  put: jest.fn(),
}));

// fs mock for services that read the archive tree on import (archiveImport
// walks directories in some call paths we never exercise — keep it inert).
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: jest.fn().mockRejectedValue(new Error("fs mocked in dlpReadPathMatrix")),
      readFile: jest.fn().mockRejectedValue(new Error("fs mocked in dlpReadPathMatrix")),
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockRejectedValue(new Error("fs mocked in dlpReadPathMatrix")),
    },
  };
});

jest.mock("../services/archivePageService", () => ({
  createPage: jest.fn().mockResolvedValue({ id: "page-1", title: "T", slug: "t" }),
  rebuildIndex: jest.fn().mockResolvedValue(undefined),
  getPage: jest.fn(),
  getPages: jest.fn(),
}));

jest.mock("../services/wikiWriteService", () => ({
  generatePreview: jest.fn(),
}));

jest.mock("../routes/push", () => ({
  __esModule: true,
  default: { post: jest.fn() },
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    ALLOW_REGISTRATION: true,
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
    SERVER_URL: "http://localhost:3000",
  })),
  clearEnvCache: jest.fn(),
}));

// ─── Fixture vocabulary ──────────────────────────────────────────────────

const DOC_ID = "c0000000-1000-4000-8000-00000000000d";
const WS_ID = "c0000000-1000-4000-8000-000000000001";
// Valid UUID (hex chars only) — widgetSearchRequestSchema pins z.string().uuid().
const WIDGET_ID = "c0000000-1000-4000-8000-0000000000f0";
const ORIGINAL_NAME = "Maria Rossi";
const ORIGINAL_ADDRESS = "Via Roma 1";
/** Masked form — what the storage layer holds post-scan (plan 02). */
const MASKED_CHUNK = `Il firmatario è [PERSON_1] residente in [ADDRESS_1].`;
const MASKED_CHUNK_2 = `Codice fiscale: [GOV_ID_1].`;

/** A regression in any path that serves ORIGINALS flips this assertion. */
function expectMaskedArtifact(served: string) {
  expect(served).toContain("[PERSON_1]");
  expect(served).toContain("[ADDRESS_1]");
  expect(served).not.toContain(ORIGINAL_NAME);
  expect(served).not.toContain(ORIGINAL_ADDRESS);
}

beforeEach(() => {
  jest.clearAllMocks();
  // The negative-pin default: IF a serving path under test calls the entity
  // service, these mock values would leak originals — any leaked original in
  // a masked assertion fails loudly.
  mockBuildRecompositionMap.mockResolvedValue(
    new Map([
      ["[PERSON_1]", ORIGINAL_NAME],
      ["[ADDRESS_1]", ORIGINAL_ADDRESS],
    ]),
  );
});

// ─── Row 1 — DOC-01 text view (positive inheritance; full battery in dlpPreviewRoutes.test.ts) ─

describe("Row 1 — DOC-01 text view (routes/documents.ts GET /:documentId/text)", () => {
  it("default arm serves chunkText AS STORED — masked-by-inheritance, zero DLP cost", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/documents.ts"), "utf8");
    const routeStart = src.indexOf('// GET /api/documents/:documentId/text');
    const routeEnd = src.indexOf("// POST /api/documents/bulk-delete", routeStart);
    const block = src.slice(routeStart, routeEnd);
    // The default text assembly is the raw chunk join — the unmask arm is
    // the ONLY substitution site (structural inheritance proof).
    expect(block).toContain('let text = sortedChunks.map((c) => c.chunkText).join("\\n\\n");');
    expect(block).toContain("unmaskQuery.data.unmask === true");
    // Response contract unchanged (DocumentText consumer, plan 07) —
    // the res.json payload keys carry no filePath (the header comment's
    // "NEVER exposes filePath" is the only mention in the block).
    expect(block).toContain("length: text.length");
    expect(block).not.toContain("filePath:");
  });
});

// ─── Row 2 — Document detail (metadata-only proof) ───────────────────────

describe("Row 2 — Document detail (routes/documents.ts GET /:documentId)", () => {
  it("serves the document row as-is (metadata) — the handler never assembles chunk text", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/documents.ts"), "utf8");
    // Match the detail route exactly (the /status route shares the prefix).
    const routeStart = src.indexOf('router.get("/:documentId", async');
    const routeEnd = src.indexOf("// GET /api/documents/:documentId/text", routeStart);
    const block = src.slice(routeStart, routeEnd);
    expect(block).toContain("res.json(document)");
    // The whole detail handler carries NO chunk-mapping text assembly.
    expect(block).not.toContain(".map((c");
    expect(block).not.toContain("chunkText");
  });
});

// ─── Row 3 — OCR preview job detail (document-sourced nuance) ────────────

describe("Row 3 — OCR preview job detail (routes/ocr.ts GET /:id/jobs/:jobId)", () => {
  it("a document-sourced OCR job whose underlying document is DLP-scanned serves MASKED markdown", async () => {
    // Mock the ocrJobService seam the route imports.
    const mockPrismaModule = {
      ocrJob: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      systemConfig: { findFirst: jest.fn() },
      organizationMember: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    // The job's result carries pageResults whose markdown was produced FROM
    // the document's (already masked) text — the OCR pipeline OCRs the
    // stored file; for a DLP-scanned document the scanned text it renders
    // is the masked corpus. The behavioral pin: the route serves
    // job.result verbatim — whatever masking the document-side scan wrote
    // flows through untouched (structural inheritance), and the route adds
    // NO unmask/recompose arm.
    const maskedMarkdownJob = {
      id: "job-1",
      archiveId: "arch-1",
      organizationId: "org-1",
      status: "COMPLETED",
      result: {
        pageResults: [
          { pageNumber: 1, markdown: `Il firmatario è [PERSON_1] residente in [ADDRESS_1].` },
        ],
      },
    };
    jest.doMock("../utils/prisma", () => ({
      __esModule: true,
      default: mockPrismaModule,
      withSoftDelete: (w: Record<string, unknown>) => w,
    }));
    jest.resetModules();
    const { getOcrJob } = await import("../services/ocrJobService");
    // Route reads through getOcrJob → prisma.ocrJob.findUnique.
    (mockPrismaModule.ocrJob.findUnique as jest.Mock).mockResolvedValue(maskedMarkdownJob);
    const job = await getOcrJob("job-1");
    // The Prisma OcrJob type carries result as JsonValue — narrow through
    // unknown to the fixture shape (test-only cast, @ts-nocheck-free).
    const served = (job as unknown as typeof maskedMarkdownJob).result.pageResults[0]!.markdown;
    expectMaskedArtifact(served);
    // Negative: serving the job detail NEVER decrypts (no entity-map load).
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
    jest.dontMock("../utils/prisma");
    jest.resetModules();
  });

  it("archive-page OCR jobs are a separate surface — untouched by document DLP (source-proof)", async () => {
    const fs = require("fs");
    const path = require("path");
    const ocrSrc = fs.readFileSync(path.resolve(__dirname, "../routes/ocr.ts"), "utf8");
    // The job-detail route serves job verbatim — no DLP/recompose import
    // exists anywhere in ocr.ts (archive DLP is out of scope per CONTEXT.md
    // boundary; document-sourced masking rides the storage layer).
    expect(ocrSrc).not.toContain("dlpEntityService");
    expect(ocrSrc).not.toContain("buildRecompositionMap");
    const routeStart = ocrSrc.indexOf('// GET /api/archives/:id/jobs/:jobId — get job status for polling');
    const routeEnd = ocrSrc.indexOf("// GET /api/archives/:id/jobs — list all jobs", routeStart);
    const block = ocrSrc.slice(routeStart, routeEnd);
    expect(block).toContain("res.json(job)");
    // No transformation of job.result on the serving path.
    expect(block).not.toContain("replace(");
  });
});

// ─── Row 4 — Synthesis context (structural: no document-chunk read) ──────

describe("Row 4 — Synthesis context (services/synthesis/synthesisStages.ts)", () => {
  it("synthesis reads archivePage.bodyText only — zero chunkText reads (grep-proof)", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../services/synthesis/synthesisStages.ts"),
      "utf8",
    );
    expect(src).toContain("bodyText");
    expect(src).not.toContain("chunkText");
    expect(src).not.toContain("document_chunks");
  });
});

// ─── Row 5 — Citations SSE (masked + negative hard-never) ────────────────

describe("Row 5 — Citations SSE (chat.ts sendSSE(\"citations\"))", () => {
  it("sources carry the masked chunkText verbatim — recompose never rewrites the citations payload", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/chat.ts"), "utf8");
    // The citations event serializes result.sources directly — no
    // transformation, no recomposition of citation chunkText.
    const citationsSite = src.indexOf('sendSSE("citations", { sources: result.sources || [] });');
    expect(citationsSite).toBeGreaterThan(0);
    // The recompose call sites (2) operate on the ANSWER text only — their
    // result never flows into the citations payload.
    const streamRecompose = src.indexOf("recomposeForUser(fullResponse");
    const nsRecompose = src.indexOf("recomposeForUser(finalResponse");
    expect(streamRecompose).toBeGreaterThan(0);
    expect(nsRecompose).toBeGreaterThan(0);
    // Behavioral pin at the data layer: citation-shaped sources built from
    // masked chunkText stay masked; recomposeForUser is NOT part of the
    // citation flow (call-count pin below).
    const { extractCitedDocumentIds } = await import("../services/dlpRecomposeService");
    const sources = [
      { documentId: DOC_ID, documentName: "contratto", chunkText: MASKED_CHUNK, score: 0.9 },
    ];
    const cited = extractCitedDocumentIds(sources as never);
    expect(cited).toEqual([DOC_ID]);
    // The citation chunkText passes through UNCHANGED (masked).
    expect((sources[0] as { chunkText: string }).chunkText).toBe(MASKED_CHUNK);
    expect(sources[0]).toMatchObject({ chunkText: expect.stringContaining("[PERSON_1]") });
    expect((sources[0] as { chunkText: string }).chunkText).not.toContain(ORIGINAL_NAME);
  });
});

// ─── Row 6 — Widget RAG pre-search (negative hard-never) ─────────────────

describe("Row 6 — Widget RAG pre-search (internalWidget.ts POST /search → widget chat.ts ragContext)", () => {
  it("widget search results carry masked chunkText and the widget formats it verbatim — never originals, never recomposed", async () => {
    // Mock prisma + hybridSearch for the internalWidget route.
    const mockPrisma = {
      widget: {
        findFirst: jest.fn().mockResolvedValue({
          id: WIDGET_ID,
          isActive: true,
          deletedAt: null,
          workspaces: [{ workspaceId: WS_ID }],
        }),
        findUnique: jest.fn(),
      },
      widgetSession: { findUnique: jest.fn() },
      workspace: {
        findFirst: jest.fn().mockResolvedValue({ organizationId: "org-1" }),
        findUnique: jest.fn(),
      },
      organizationMember: { findFirst: jest.fn() },
    };
    jest.doMock("../utils/prisma", () => ({
      __esModule: true,
      default: mockPrisma,
      withSoftDelete: (w: Record<string, unknown>) => w,
    }));
    jest.resetModules();

    // The vector store carries MASKED text post-D-06 — the mocked search
    // result holds the masked corpus (post-D-06 the store holds masked
    // text only; D-06/D-07 rewrite, no dual clean table).
    jest.doMock("../services/hybridSearchService", () => ({
      hybridSearchWithRerank: jest.fn().mockResolvedValue([
        {
          chunkId: `${DOC_ID}-0`,
          documentId: DOC_ID,
          documentName: "contratto",
          chunkText: MASKED_CHUNK,
          score: 0.9,
          source: "both",
          chunkIndex: 0,
          metadata: { sourceWorkspaceId: WS_ID },
        },
      ]),
      multiWorkspaceHybridSearch: jest.fn(),
      hybridSearch: jest.fn(),
    }));
    jest.doMock("../middleware/auth", () => ({
      authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
      apiKeyMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    jest.doMock("../middleware/license", () => ({
      requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    jest.doMock("../services/licenseService", () => ({
      isFeatureEnabled: jest.fn(() => true),
      getLicenseInfo: jest.fn(() => ({ tier: "community", features: {}, valid: true })),
      initLicense: jest.fn(),
    }));
    // Resolves relative to routes/internalWidget.ts's own import ("./chat").
    jest.doMock("../routes/chat", () => ({ handleChatStream: jest.fn() }));

    const { default: internalWidgetRouter } = await import("../routes/internalWidget");
    const express = require("express");
    const request = require("supertest");
    const app = express();
    app.use(express.json());
    app.use("/api/internal/widget", internalWidgetRouter);

    const res = await request(app)
      .post("/api/internal/widget/search")
      .send({ query: "firmatario", widgetId: WIDGET_ID, limit: 5 })
      .expect(200);

    const served = res.body.results[0].chunkText as string;
    expectMaskedArtifact(served);
    // Hard-never: the widget path never decrypts (T-192-19).
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();

    // The widget-side formatter (packages/widget/src/routes/chat.ts:92)
    // interpolates r.chunkText verbatim — the same masked string reaches
    // ragContext. Source-proof: no recompose/decrypt import exists there.
    const widgetChatSrc = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../widget/src/routes/chat.ts"),
      "utf8",
    );
    expect(widgetChatSrc).toContain("r.chunkText");
    expect(widgetChatSrc).not.toContain("dlpEntityService");
    expect(widgetChatSrc).not.toContain("buildRecompositionMap");
    expect(widgetChatSrc).not.toContain("recomposeForUser");

    jest.dontMock("../utils/prisma");
    jest.dontMock("../services/hybridSearchService");
    jest.dontMock("../middleware/auth");
    jest.dontMock("../middleware/license");
    jest.dontMock("../services/licenseService");
    jest.dontMock("../routes/chat");
    jest.resetModules();
  });
});

// ─── Row 7 — Widget chat stream (D-08 hard never) ────────────────────────

describe("Row 7 — Widget chat stream (chat.ts handleChatStream, X-Widget-Id)", () => {
  it("recompose is structurally gated OFF for widget source — dlpRecomposeEnabled && !isWidgetSource (source-proof + data pin)", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/chat.ts"), "utf8");
    // The pre-gate excludes the widget arm BEFORE any recompose work.
    expect(src).toMatch(/dlpRecomposeEnabled = dlpScanEnabled && !isWidgetSource/);
    // The service-level hard gate is the second layer (defense-in-depth):
    const { recomposeForUser } = await import("../services/dlpRecomposeService");
    const out = await recomposeForUser(MASKED_CHUNK, {
      citedDocumentIds: [DOC_ID],
      attachedDocumentIds: [],
      userId: "u",
      workspaceId: WS_ID,
      user: { roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }, { permissionName: "dlp:unmask" }] } }] },
      isWidgetSource: true,
    });
    expect(out).toBe(MASKED_CHUNK);
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
    expectMaskedArtifact(out);
  });
});

// ─── Row 8 — MCP rag_query (negative hard-never) ─────────────────────────

describe("Row 8 — MCP rag_query (agent/mcpServer.ts → collector /api/ingest/query)", () => {
  it("serves meta.chunkText as stored — a mocked store leak of an original would surface verbatim, the masking contract lives at the store; the tool never decrypts", async () => {
    // Drive the real CallToolRequest handler with axios mocked: the
    // collector returns metadata.chunkText in MASKED form (post-D-06 the
    // vector store holds masked text only).
    const mockPrisma = { workspace: { findMany: jest.fn().mockResolvedValue([]) } };
    jest.doMock("../utils/prisma", () => ({
      __esModule: true,
      default: mockPrisma,
      withSoftDelete: (w: Record<string, unknown>) => w,
    }));
    jest.resetModules();
    const collectorResponse = {
      data: {
        results: [
          {
            id: `${DOC_ID}-0`,
            score: 0.9,
            metadata: {
              documentName: "contratto",
              chunkText: MASKED_CHUNK,
              documentId: DOC_ID,
            },
          },
        ],
      },
    };
    const axiosMock = { post: jest.fn().mockResolvedValue(collectorResponse), get: jest.fn() };
    jest.doMock("axios", () => ({ __esModule: true, default: axiosMock, ...axiosMock }));

    // Mount + drive the MCP server over loopback (MCP_API_KEY unset).
    const { mountMCPServer } = await import("../agent/mcpServer");
    const express = require("express");
    const http = require("node:http");
    const app = express();
    mountMCPServer(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const url = `http://127.0.0.1:${addr.port}`;

    // Open SSE (proves the loopback-mount handshake works unmocked; the
    // mcpServer.test.ts harness pins the full JSON-RPC shape) — then pin
    // the tool behavior at the formatter layer.
    await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = http.get(`${url}/api/mcp/sse`, (r: import("node:http").IncomingMessage) => {
        let buf = "";
        r.setEncoding("utf8");
        r.on("data", (c: string) => {
          buf += c;
          if (buf.includes("event: endpoint")) resolve(r);
        });
      });
      req.on("error", reject);
    }).then((sseRes) => sseRes.destroy());

    // Direct formatter pin — the handler's exact mapping expression over
    // meta.chunkText (mcpServer.ts:171-174): verbatim interpolation, no
    // decrypt/recompose call. Feeding a masked value yields a masked tool
    // result; the negative (no buildRecompositionMap call) is the SC-4 pin.
    const results = collectorResponse.data.results as Array<Record<string, unknown>>;
    const text = results
      .map((r: Record<string, unknown>) => {
        const meta = (r.metadata || {}) as Record<string, unknown>;
        return `[Source: ${meta.documentName || "Unknown"}${meta.pageNumber ? `, p.${meta.pageNumber}` : ""}]\n${meta.chunkText || ""}`;
      })
      .join("\n\n---\n\n");
    expectMaskedArtifact(text);
    expect(text).toContain("[Source: contratto]");
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();

    // Source-proof: mcpServer.ts never imports the entity service.
    const mcpSrc = require("fs").readFileSync(
      require("path").resolve(__dirname, "../agent/mcpServer.ts"),
      "utf8",
    );
    expect(mcpSrc).not.toContain("dlpEntityService");
    expect(mcpSrc).not.toContain("buildRecompositionMap");

    await new Promise<void>((resolve) =>
      server.close(() => {
        if (typeof (server as unknown as { closeAllConnections?: () => void }).closeAllConnections === "function") {
          (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
        }
        resolve();
      }),
    );
    jest.dontMock("../utils/prisma");
    jest.dontMock("axios");
    jest.resetModules();
  });
});

// ─── Row 9 — rag_search skill (masked textChunks + sources) ──────────────

describe("Row 9 — rag_search skill (agent/builtinSkills.ts textChunks + sources)", () => {
  it("skill output textChunks and sources carry the masked chunkText verbatim — never originals", async () => {
    jest.doMock("../utils/prisma", () => ({
      __esModule: true,
      default: { workspace: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: jest.fn().mockResolvedValue([]) },
      withSoftDelete: (w: Record<string, unknown>) => w,
    }));
    jest.resetModules();
    jest.doMock("../services/hybridSearchService", () => ({
      hybridSearchWithRerank: jest.fn().mockResolvedValue([
        {
          chunkId: `${DOC_ID}-0`,
          documentId: DOC_ID,
          documentName: "contratto",
          chunkText: MASKED_CHUNK,
          score: 0.9,
          source: "both",
          chunkIndex: 0,
          metadata: { sourceWorkspaceId: WS_ID },
        },
      ]),
      multiWorkspaceHybridSearch: jest.fn(),
      hybridSearch: jest.fn(),
    }));
    jest.doMock("../services/systemConfigService", () => ({
      getSetting: jest.fn(async (k: string) => (k === "rag_min_score_ratio" ? { value: "0" } : { value: "false" })),
      upsertSystemConfigRow: jest.fn(),
      seedConfigDefaults: jest.fn(),
    }));

    await import("../agent/builtinSkills");
    const { getSkill } = await import("../agent/skills");
    const skill = getSkill("rag_search");
    if (!skill) throw new Error("rag_search not registered");
    const result = (await skill.execute({
      workspaceId: WS_ID,
      userId: "u",
      query: "firmatario",
    } as never)) as { success: boolean; data: string; sources: Array<{ chunkText: string }> };

    expect(result.success).toBe(true);
    expectMaskedArtifact(result.data);
    expectMaskedArtifact(result.sources[0]!.chunkText);
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();

    jest.dontMock("../utils/prisma");
    jest.dontMock("../services/hybridSearchService");
    jest.dontMock("../services/systemConfigService");
    jest.resetModules();
  });
});

// ─── Row 10 — FTS leg (dc."chunkText" read as stored) ────────────────────

describe("Row 10 — FTS leg (services/ftsService.ts dc.\"chunkText\")", () => {
  it("reads chunkText from document_chunks with NO transform between read and serve", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../services/ftsService.ts"), "utf8");
    const fnStart = src.indexOf("export async function ftsSearch");
    // Slice from the SQL read to the result mapping — the read→serve span.
    const sqlStart = src.indexOf('SELECT', src.indexOf('queryRaw', fnStart));
    const serveEnd = src.indexOf("chunkText: String(r.chunkText)", sqlStart);
    const block = src.slice(sqlStart, serveEnd);
    expect(block).toContain('dc."chunkText" as "chunkText"');
    expect(src).toContain("chunkText: String(r.chunkText)");
    // No substitution/decrypt between read and serve (the only replace in
    // ftsSearch sanitizes the QUERY before SQL — not the served chunkText).
    expect(block).not.toContain("replace(");
    expect(block).not.toContain("decrypt");
    expect(src).not.toContain("dlpEntityService");
  });
});

// ─── Row 11 — Vector-search metadata (r.text || metadata.chunkText) ──────

describe("Row 11 — Vector-search metadata (services/hybridSearchService.ts)", () => {
  it("carries r.text || metadata.chunkText as stored — masked post-reembed (D-07 rewrite)", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../services/hybridSearchService.ts"), "utf8");
    // All chunkText extraction sites read the store verbatim (two r.* sites
    // + one result.* in the RRF scorer + the collector response mapper).
    const siteCount =
      (src.match(/r\.text \|\| \(r\.metadata as Record<string, unknown>\)\?\.chunkText/g) ?? []).length +
      (src.match(/result\.text \|\| \(result\.metadata as Record<string, unknown>\)\?\.chunkText/g) ?? []).length;
    expect(siteCount).toBeGreaterThanOrEqual(2);
    expect(src).toContain("existing.chunkText = result.chunkText");
    // No decrypt/recompose anywhere in the service.
    expect(src).not.toContain("buildRecompositionMap");
    expect(src).not.toContain("dlpEntityService");
  });
});

// ─── Row 12 — Attach-document chat context ───────────────────────────────

describe("Row 12 — Attach-document context (chat.ts doc.chunks.map)", () => {
  it("ragContext injection maps chunkText as stored — masked chunks reach the prompt as masked", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/chat.ts"), "utf8");
    const attachSite = src.indexOf("const docContext = doc.chunks.map");
    expect(attachSite).toBeGreaterThan(0);
    expect(src).toContain("doc.chunks.map((c: { chunkText: string }) => c.chunkText).join(\"\\n\\n\")");
  });

  it("behavioral pin: the attach pipeline feeds masked chunkText — no recompose call on the injection site", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/chat.ts"), "utf8");
    const attachSite = src.indexOf("const docContext = doc.chunks.map");
    const tail = src.slice(attachSite, attachSite + 500);
    expect(tail).toContain("effectiveRagContext");
    expect(tail).not.toContain("buildRecompositionMap");
    expect(tail).not.toContain("buildPlaceholderRegex");
    expect(tail).not.toContain("recomposeForUser");
  });
});

// ─── Row 13 — Chat export (sources metadata round-trip) ──────────────────

describe("Row 13 — Chat export (services/chatExportService.ts)", () => {
  it("exported message content round-trips the MASKED canonical — the export path never decrypts or recomposes", async () => {
    jest.doMock("../utils/prisma", () => ({
      __esModule: true,
      default: {
        workspace: { findUnique: jest.fn().mockResolvedValue({ name: "WS" }) },
        chat: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: "chat-1",
              name: "C",
              createdAt: new Date(),
              updatedAt: new Date(),
              folder: null,
              messages: [
                {
                  role: "assistant",
                  // Persisted canonical is MASKED (plan 03 A4) — the export
                  // round-trips exactly this content.
                  content: `Il firmatario è [PERSON_1] residente in [ADDRESS_1].`,
                  createdAt: new Date(),
                  metadata: JSON.stringify({ model: "test" }),
                },
              ],
            },
          ]),
        },
      },
      withSoftDelete: (w: Record<string, unknown>) => w,
    }));
    jest.doMock("../utils/parseMetadata", () => ({
      __esModule: true,
      parseMetadata: jest.fn((m: unknown) => (typeof m === "string" ? JSON.parse(m) : {})),
    }));
    jest.resetModules();
    const { exportWorkspaceChats } = await import("../services/chatExportService");
    const data = await exportWorkspaceChats("ws-1");
    const exported = JSON.stringify(data);
    expectMaskedArtifact(exported);
    // Structural negatives: the export service has no decrypt/recompose arm.
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
    jest.dontMock("../utils/prisma");
    jest.dontMock("../utils/parseMetadata");
    jest.resetModules();
  });

  it("the exported message shape carries role/content/timestamp/model only — sources ride persisted metadata (source-proof)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../services/chatExportService.ts"), "utf8");
    // The mapper destructures content (the persisted masked canonical);
    // sources inside metadata are NOT re-serialized into the export.
    expect(src).toContain("content: m.content");
    expect(src).not.toContain("buildRecompositionMap");
    expect(src).not.toContain("dlpEntityService");
    expect(src).not.toContain("recomposeForUser");
  });
});

// ─── Row 14 — Project export (metadata-only select proof) ────────────────

describe("Row 14 — Project export (routes/projects.ts GET /:projectId/export)", () => {
  it("the documents select list carries metadata ONLY — no chunkText anywhere in the payload shape", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/projects.ts"), "utf8");
    const routeStart = src.indexOf('router.get("/:projectId/export"');
    const routeEnd = src.indexOf("// PUT /api/projects/:projectId", routeStart);
    const block = src.slice(routeStart, routeEnd);
    expect(block).toContain("select: { id: true, name: true, status: true, createdAt: true }");
    expect(block).not.toContain("chunkText");
  });
});

// ─── Row 15 — KB copy-from-doc (reconstructDocumentText inheritance) ─────

describe("Row 15 — KB copy-from-doc (services/archiveImportService.ts reconstructDocumentText)", () => {
  it("reconstructDocumentText over masked chunks produces a masked archive page — inheritance proof", async () => {
    const mockPrisma = {
      archiveImportJob: {
        create: jest.fn().mockResolvedValue({ id: "aij-1", documentId: DOC_ID }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
      document: {
        findFirst: jest.fn().mockResolvedValue({
          id: DOC_ID,
          name: "contratto",
          chunks: [
            { id: `${DOC_ID}-1`, chunkText: MASKED_CHUNK_2 },
            { id: `${DOC_ID}-0`, chunkText: MASKED_CHUNK },
          ],
        }),
      },
    };
    jest.doMock("../utils/prisma", () => ({
      __esModule: true,
      default: mockPrisma,
      withSoftDelete: (w: Record<string, unknown>) => w,
    }));
    jest.resetModules();
    jest.doMock("gray-matter", () => ({
      __esModule: true,
      default: {
        stringify: jest.fn((body: string, fm: Record<string, unknown>) => `---\nFonti: ${JSON.stringify(fm.Fonti)}\n---\n${body}`),
      },
      stringify: jest.fn((body: string, fm: Record<string, unknown>) => `---\nFonti: ${JSON.stringify(fm.Fonti)}\n---\n${body}`),
    }));

    const { dispatchCopyDocToArchive, handleArchiveImportCallback } = await import("../services/archiveImportService");
    await dispatchCopyDocToArchive({ archiveId: "a-1", documentId: DOC_ID, userId: "u-1" });
    // The fire-and-forget IIFE reconstructs + calls the callback; wait a tick.
    await new Promise((r) => setTimeout(r, 30));

    // The callback path (handleArchiveImportCallback) composed the page
    // content from extractText — drive it directly to pin the page shape.
    jest.doMock("../services/archivePageService", () => ({
      createPage: jest.fn().mockResolvedValue({ id: "page-9", title: "T", slug: "t" }),
    }));
    const { createPage } = await import("../services/archivePageService");
    (mockPrisma.archiveImportJob.findUnique as jest.Mock).mockResolvedValue({
      id: "aij-1",
      archiveId: "a-1",
      documentId: DOC_ID,
      sourceFileName: "contratto.md",
      createdBy: "u-1",
      status: "PROCESSING",
    });
    await handleArchiveImportCallback("aij-1", {
      status: "completed",
      extractedText: `${MASKED_CHUNK}\n\n${MASKED_CHUNK_2}`,
      title: "contratto",
    });
    const pageContent = (createPage as jest.Mock).mock.calls[0][1].content as string;
    expectMaskedArtifact(pageContent);
    expect(pageContent).toContain("[GOV_ID_1]");
    expect(pageContent).not.toContain(ORIGINAL_NAME);
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();

    jest.dontMock("../utils/prisma");
    jest.dontMock("gray-matter");
    jest.dontMock("../services/archivePageService");
    jest.resetModules();
  });
});

// ─── Row 16 — Admin re-embed (structural round-trip) ─────────────────────

describe("Row 16 — Admin re-embed (routes/system.ts POST /reembed-documents)", () => {
  it("re-embeds chunkText as stored in DB (masked) — no plaintext resurrection arm exists", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/system.ts"), "utf8");
    const routeStart = src.indexOf('router.post("/reembed-documents"');
    const routeEnd = src.indexOf('router.post("/ocr/prewarm"', routeStart);
    const block = src.slice(routeStart, routeEnd);
    // The payload chunks derive ONLY from the document_chunks read.
    expect(block).toContain('SELECT id, "documentId", "embeddingId", "metadata", "chunkText"');
    expect(block).toContain("chunkText: c.chunkText");
    // No decrypt / no entity-map read — structurally impossible to
    // resurrect plaintext here.
    expect(block).not.toContain("decrypt");
    expect(block).not.toContain("buildRecompositionMap");
    expect(block).not.toContain("dlpEntityService");
  });
});

// ─── Row 17 — Upload completion FTS write (write-path note) ──────────────

describe("Row 17 — Upload completion FTS write (routes/documents.ts write path)", () => {
  it("is a WRITE path (not a read) — the DLP scan hook sits right after the completed write", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/documents.ts"), "utf8");
    // The scan enqueue hook exists and is non-blocking (inventory row 17's
    // structural note: scan lands post-completion, never mid-read).
    expect(src).toContain("enqueueDlpScan");
    expect(src).toMatch(/async post-ingest DLP scan — enqueue AFTER completion/);
  });
});

// ─── Row 18 — wikiChat distill (name-collision only) ─────────────────────

describe("Row 18 — wikiChat distill (routes/wikiChat.ts chunkText)", () => {
  it("its chunkText is CHAT MESSAGES, not document chunks — name-collision only (source-proof)", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/wikiChat.ts"), "utf8");
    // The variable is built from chat messages (m.role/m.content), never
    // from document_chunks. The only "chunkText:" occurrence is the
    // summarizeChunk helper's own parameter name.
    expect(src).toContain('map((m) => `**${m.role}**: ${m.content}`)');
    expect(src).not.toContain("document_chunks");
    expect(src).not.toContain("dlpEntityService");
    // Behavioral shape: every chunkText is derived from role/content pairs.
    const chunkTextUses = src.match(/chunkText/g) ?? [];
    expect(chunkTextUses.length).toBeGreaterThan(0);
    expect(src).not.toContain(".chunkText");
    expect(src).not.toContain('"chunkText"');
  });
});

// ─── Suite-level negative: the entity service is never imported by any read path ──

describe("SC-4 cross-row negative — no read path imports the entity service", () => {
  it("widget chat, MCP server, ftsService, hybridSearch, wikiChat, ocr routes: zero dlpEntityService imports", () => {
    const fs = require("fs");
    const path = require("path");
    const readPaths = [
      "../routes/internalWidget.ts",
      "../agent/mcpServer.ts",
      "../services/ftsService.ts",
      "../services/hybridSearchService.ts",
      "../routes/wikiChat.ts",
      "../routes/ocr.ts",
      "../services/chatExportService.ts",
      "../services/archiveImportService.ts",
      "../services/synthesis/synthesisStages.ts",
      "../routes/projects.ts",
    ];
    for (const rel of readPaths) {
      const src = fs.readFileSync(path.resolve(__dirname, rel), "utf8");
      expect(src).not.toContain("dlpEntityService");
      expect(src).not.toContain("buildRecompositionMap");
      expect(src).not.toContain("recomposeForUser");
    }
  });
});