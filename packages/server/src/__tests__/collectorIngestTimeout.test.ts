// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * quick 260918-gxs — collector ingest timeout contract.
 *
 * The 2026-09-18 incident (two large PDFs dispatched 07:29:38, aborted exactly
 * 300s later with "This operation was aborted") pinned three regressions:
 *   1. The ingest wait cap was a hardcoded 300_000 — below the real wall time
 *      of concurrent large-PDF ingests (parse + chunk + local CPU embedding).
 *   2. The abort error text ("This operation was aborted") is persisted as
 *      statusMessage verbatim — the operator gets no clue what failed or
 *      which knob to turn.
 *   3. A non-timeout failure must keep its raw error message
 *      (message-specificity guard).
 *
 * Contract under test:
 *   - Test 1 (timeout path): COLLECTOR_INGEST_TIMEOUT_MS=50 + a fetch mock
 *     that hangs until aborted → Document failed with a statusMessage naming
 *     the timeout AND the tuning key — never the bare abort text.
 *   - Test 2 (non-timeout failure): fetch rejects immediately (signal never
 *     aborts) → raw error message persisted unchanged.
 *   - Test 3 (happy path + timer cleared): fetch resolves → completed +
 *     chunkCount; the 50ms timer never fires a stray abort/failed write
 *     (proven by an 80ms real-timer wait after the call).
 *
 * Mock scaffold mirrors forwardToCollectorCleanup.test.ts (the proven
 * template for loading documents.ts under jest).
 */
import "./helpers/setupEnv";
// NOTE: default import (NOT `import * as fs`) — documents.ts also imports the
// default (`import fs from "fs"`), and jest.spyOn must mutate the SAME
// module.exports object. The namespace copy has distinct require semantics
// under @swc/jest CJS output; spying on it does not affect documents.ts.
import fs from "fs";

// Mock prisma singleton — createMockPrisma covers document.update etc.
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

// Mock env to satisfy transitive config imports (COLLECTOR_URL/SECRET) PLUS
// the new ingest timeout key (50ms — fast enough to fire inside a unit test).
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
    COLLECTOR_INGEST_TIMEOUT_MS: 50,
  })),
}));

// quick 260918-p3h (D-1): env WITHOUT COLLECTOR_INGEST_TIMEOUT_MS — the
// unlimited-default scenario. Each test overrides the getEnv mock's return
// value and restores the capped one afterwards.
const UNLIMITED_ENV = {
  JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
  NODE_ENV: "test",
  SERVER_PORT: 3000,
  SESSION_EXPIRY: 86400000,
  ALLOW_REGISTRATION: true,
  COLLECTOR_URL: "http://localhost:3210",
  COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
};

// Mock licenseService — transitive import of documents.ts
jest.mock("../services/licenseService", () => ({}));

// Mock systemConfigService — getSetting used by the OCR routing block
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn((key: string) => {
    if (key === "EMBEDDING_MODEL") return { key, value: "Xenova/all-MiniLM-L6-v2" };
    if (key === "OCR_DEFAULT_MODEL") return { key, value: "glm-ocr:latest" };
    return { key, value: "" };
  }),
  getAllSettings: jest.fn(),
  updateSettings: jest.fn(),
  seedConfigDefaults: jest.fn(),
}));

// Mock ragOcrService — cleanupOcrTextFile is called on cleanup paths
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

// Provider mock surface (documents.ts imports getStorageProvider).
jest.mock("../services/storageProvider", () =>
  require("./helpers/mockStorageProvider").mockStorageProviderModule,
);

import { forwardToCollector } from "../routes/documents";
import prisma from "../utils/prisma";
import { cleanupOcrTextFile } from "../services/ragOcrService";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";

void getEnv;

// The bytes must REACH fetch (Buffer → Blob → FormData) — do NOT throw here.
const readFileSyncSpy = jest
  .spyOn(fs, "readFileSync")
  .mockImplementation(() => Buffer.from("hello"));
const existsSyncSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);

const fetchSpy = jest.spyOn(globalThis, "fetch");

afterAll(() => {
  readFileSyncSpy.mockRestore();
  existsSyncSpy.mockRestore();
  fetchSpy.mockRestore();
});

// Deterministic non-PDF call shape: docType "txt" skips the entire OCR
// routing block (no pdfjs, no OCR settings reads) — same 8-arg direct-upload
// form the cleanup template pins.
function callDirectUpload(documentId: string) {
  return forwardToCollector(
    documentId,
    "/tmp/fake-src.bin",
    "f.txt",
    "ws-1",
    "WS",
    "model",
    "txt",
    "ocr",
  );
}

function failedUpdateCalls() {
  return (prisma.document.update as jest.Mock).mock.calls.filter(
    (c) => c[0]?.data?.status === "failed",
  );
}

function completedUpdateCalls() {
  return (prisma.document.update as jest.Mock).mock.calls.filter(
    (c) => c[0]?.data?.status === "completed",
  );
}

describe("forwardToCollector ingest timeout (quick 260918-gxs)", () => {
  beforeEach(() => {
    (prisma.document.update as jest.Mock).mockReset().mockResolvedValue({});
    // quick 260918-p3h (T-P3H-04 arm a): the guarded processing claim now
    // issues document.updateMany — default it to a successful claim so the
    // legacy timeout/failure/happy tests keep their exact dispatch flow.
    (prisma.document.updateMany as jest.Mock).mockReset().mockResolvedValue({ count: 1 });
    (cleanupOcrTextFile as jest.Mock).mockReset().mockResolvedValue(undefined);
    jest.clearAllMocks();
    fetchSpy.mockReset();
    (prisma.document.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  // Test 1 (timeout path): fetch hangs until the env-driven AbortController
  // fires (50ms) → the abort is detected via controller.signal.aborted and
  // rethrown as an operator-actionable message naming the timeout and the
  // tuning knob. The catch block persists THAT message into statusMessage —
  // never the bare abort text.
  it("aborted ingest → statusMessage names the timeout + tuning key, not the bare abort text", async () => {
    fetchSpy.mockImplementation((_url, init) => {
      const signal = init?.signal;
      return new Promise((_, reject) => {
        const rejectAbort = () =>
          reject(new DOMException("This operation was aborted", "AbortError"));
        if (signal?.aborted) {
          rejectAbort();
        } else {
          signal?.addEventListener("abort", rejectAbort);
        }
      });
    });

    // forwardToCollector swallows its own errors into the failed-status write
    // — it resolves, it does not reject.
    await expect(callDirectUpload("doc-timeout-1")).resolves.toBeUndefined();

    const failed = failedUpdateCalls();
    expect(failed).toHaveLength(1);
    expect(failed[0][0]).toEqual(
      expect.objectContaining({
        where: { id: "doc-timeout-1" },
      }),
    );
    const statusMessage = failed[0][0].data.statusMessage as string;
    expect(statusMessage).toMatch(/timed out after/);
    expect(statusMessage).toContain("COLLECTOR_INGEST_TIMEOUT_MS");
    // Message-specificity regression guard: the persisted message must NOT be
    // the bare abort error text.
    expect(statusMessage).not.toContain("This operation was aborted");
  });

  // Test 2 (non-timeout failure keeps raw message): fetch rejects immediately
  // and the signal never aborts → the ORIGINAL error is rethrown untouched
  // and persisted verbatim (message-specificity regression guard).
  it("non-timeout fetch failure → raw error message persisted unchanged", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED-mock"));

    await expect(callDirectUpload("doc-refused-1")).resolves.toBeUndefined();

    const failed = failedUpdateCalls();
    expect(failed).toHaveLength(1);
    const statusMessage = failed[0][0].data.statusMessage as string;
    expect(statusMessage).toContain("ECONNREFUSED-mock");
    expect(statusMessage).not.toContain("timed out");
  });

  // Test 3 (happy path + timer cleared): fetch resolves → completed with
  // chunkCount 1; no failed write occurs. The 80ms real-timer wait after the
  // call proves the 50ms timeout timer was cleared (no stray abort / no
  // late "failed" write).
  it("happy path → completed with chunkCount, timer cleared (no stray abort after the call)", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ chunkCount: 1 }),
    });

    await expect(callDirectUpload("doc-happy-1")).resolves.toBeUndefined();

    // Outlast the 50ms timer window under real timers (jest.useRealTimers
    // default): a pending (uncleared) timer would fire here.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const completed = completedUpdateCalls();
    expect(completed).toHaveLength(1);
    expect(completed[0][0]).toEqual(
      expect.objectContaining({
        where: { id: "doc-happy-1" },
        data: expect.objectContaining({ status: "completed", chunkCount: 1 }),
      }),
    );
    expect(failedUpdateCalls()).toHaveLength(0);
  });

  // Test 4 (quick 260918-k8n — connection-cause diagnostics): fetch rejects
  // with an undici-shaped TypeError("fetch failed") whose cause carries
  // ECONNREFUSED + the address. The inner catch now logs the unwrapped
  // cause + a COLLECTOR_URL reachability hint BEFORE rethrowing the original
  // error untouched — so the persisted statusMessage still carries ONLY the
  // raw "fetch failed" text: the enriched log line and the URL/hint text
  // never leak into the user-facing statusMessage.
  it("connection-level fetch failure → logger.error carries cause + COLLECTOR_URL hint; statusMessage keeps the raw text only", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined as never);
    try {
      const cause = new Error("connect ECONNREFUSED 127.0.0.1:3210");
      (cause as { code?: string }).code = "ECONNREFUSED";
      const fetchErr = new TypeError("fetch failed");
      (fetchErr as { cause?: unknown }).cause = cause;
      fetchSpy.mockRejectedValueOnce(fetchErr);

      await expect(callDirectUpload("doc-conn-1")).resolves.toBeUndefined();

      // Enriched log: one error line naming the unwrapped cause code AND the
      // COLLECTOR_URL hint (never the secret).
      const errorLines = errorSpy.mock.calls.map((c) => c.map(String).join(" "));
      const enriched = errorLines.find((line) => line.includes("Collector fetch failed before response"));
      expect(enriched).toBeDefined();
      expect(enriched).toContain("ECONNREFUSED");
      expect(enriched).toContain("COLLECTOR_URL");
      expect(enriched).toContain("http://localhost:3210");
      expect(enriched).not.toContain("test-collector-secret-for-unit-tests");

      // statusMessage semantics preserved: the RAW top-level message is
      // persisted verbatim — no cause detail, no URL, no hint text.
      const failed = failedUpdateCalls();
      expect(failed).toHaveLength(1);
      const statusMessage = failed[0][0].data.statusMessage as string;
      expect(statusMessage).toBe("fetch failed");
      expect(statusMessage).not.toContain("ECONNREFUSED");
      expect(statusMessage).not.toContain("COLLECTOR_URL");
      expect(statusMessage).not.toContain("http://localhost:3210");
      expect(statusMessage).not.toContain("reachable from this container");
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Test 5 (quick 260918-p3h D-1 — unlimited default): env WITHOUT
  // COLLECTOR_INGEST_TIMEOUT_MS → fetch is called with NO signal and no
  // abort ever fires (timer-outlast pattern from Test 3); the dispatch
  // completes with a completed write; the log line reports
  // "timeoutMs=unlimited".
  it("env without COLLECTOR_INGEST_TIMEOUT_MS → no abort timer, fetch without signal, timeoutMs=unlimited logged", async () => {
    const { getEnv: getEnvMock } = jest.requireMock("../config/env") as {
      getEnv: jest.Mock;
    };
    const originalImpl = getEnvMock.getMockImplementation();
    getEnvMock.mockImplementation(() => ({ ...UNLIMITED_ENV }));

    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined as never);
    try {
      // The mocked fetch NEVER resolves (no cap configured → nobody aborts
      // it in production); for the unit test it resolves so the completion
      // write path is observable.
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ chunkCount: 1 }),
      });

      await expect(callDirectUpload("doc-unlimited-1")).resolves.toBeUndefined();

      // Outlast where the old 50ms timer WOULD have fired: no stray
      // abort/failed write proves no timer exists.
      await new Promise((resolve) => setTimeout(resolve, 80));

      // No signal reached fetch (fetch init carries no `signal` key).
      const fetchCalls = fetchSpy.mock.calls;
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0][1]).toBeDefined();
      expect((fetchCalls[0][1] as RequestInit).signal).toBeUndefined();

      // Completion write happened.
      const completed = completedUpdateCalls();
      expect(completed).toHaveLength(1);
      expect(failedUpdateCalls()).toHaveLength(0);

      // Observability: dispatch log prints timeoutMs=unlimited.
      const infoLines = infoSpy.mock.calls.map((c) => c.map(String).join(" "));
      const dispatchLine = infoLines.find((line) => line.includes("Dispatching to collector"));
      expect(dispatchLine).toBeDefined();
      expect(dispatchLine).toContain("timeoutMs=unlimited");
    } finally {
      infoSpy.mockRestore();
      getEnvMock.mockImplementation(originalImpl);
    }
  });
});