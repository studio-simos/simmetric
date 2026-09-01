// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * OCR routing tests — ING-07 (Plan 66.1-01 Task 2)
 *
 * Verifies the collector-side `ocrMode` signal after the tesseract drop (D-01).
 * The collector receives an explicit `ocrMode` from the server with values:
 * "auto" (default, pre-check), "vision" (force vision — server-side, collector
 * returns D-04), "skip" (D-04 graceful degradation). The collector no longer
 * runs a local OCR tier; vision OCR is always performed server-side.
 *
 * Guardrails (D-03):
 *   - Grep guardrail test asserts `createWorker` and `tesseract` never appear
 *     in production parser source.
 *   - Type-level guardrail asserts `"tesseract"` is not assignable to `OcrMode`.
 */
import fs from "fs";
import os from "os";
import path from "path";

// Mock env to satisfy transitive config imports
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_PORT: 3210,
    COLLECTOR_URL: "http://localhost:3210",
    SERVER_URL: "http://localhost:3000",
    EMBEDDING_PROVIDER: "ollama",
    EMBEDDING_MODEL: "nomic-embed-text-v2-moe:latest",
    OLLAMA_BASE_URL: "http://localhost:11434",
    VECTOR_DB_PROVIDER: "lancedb",
    STORAGE_PATH: "./storage",
    COLLECTOR_SECRET: "test-secret-for-unit-tests",
  })),
  clearEnvCache: jest.fn(),
}));

// Mock pdf-parse — return controllable text length
const mockPdfParse = jest.fn();
jest.mock("pdf-parse", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockPdfParse(...args),
}));

import { parseFile, type OcrMode } from "../services/parser";

describe("OCR routing (ocrMode signal, post-tesseract)", () => {
  let tmpDir: string;
  let pdfPath: string;

  beforeEach(() => {
    mockPdfParse.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parser-ocr-test-"));
    pdfPath = path.join(tmpDir, "sample.pdf");
    // Write a minimal PDF-like buffer — pdf-parse is mocked so content doesn't matter
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4 placeholder"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 1: ocrMode "auto" + pdf-parse > 100 chars → skip OCR, return text-only (existing behavior)
  it("auto mode: skips OCR when pdf-parse extracts > 100 chars", async () => {
    const longText = "A".repeat(200);
    mockPdfParse.mockResolvedValue({ text: longText, numpages: 1 });

    const result = await parseFile(pdfPath, "sample.pdf", undefined, "auto");

    expect(result.text).toBe(longText);
    expect(result.metadata.ocrApplied).toBeUndefined();
    expect(result.metadata.ocrSkipped).toBeUndefined();
  });

  // Test 2: ocrMode "vision" with no server-side OCR reached collector → D-04 degradation
  it("vision mode: returns ocrSkipped (vision OCR is server-side) when reaching collector", async () => {
    mockPdfParse.mockResolvedValue({ text: "", numpages: 1 });

    const result = await parseFile(pdfPath, "sample.pdf", "glm-ocr:latest", "vision");

    expect(result.text).toBe("");
    expect(result.metadata.ocrSkipped).toBe("OCR skipped: vision OCR is server-side");
    expect(result.metadata.ocrApplied).toBe(false);
  });

  // Test 3: ocrMode "skip" → returns empty text + ocrSkipped metadata (D-04)
  it("skip mode: returns empty text with ocrSkipped metadata (D-04)", async () => {
    mockPdfParse.mockResolvedValue({ text: "", numpages: 1 });

    const result = await parseFile(pdfPath, "sample.pdf", undefined, "skip");

    expect(result.text).toBe("");
    expect(result.metadata.ocrSkipped).toBe("OCR skipped: no vision model");
    expect(result.metadata.ocrApplied).toBe(false);
  });

  // Test 4: ocrMode "auto" + pdf-parse < 100 chars + no ocrModel → D-04 graceful degradation
  it("auto mode: returns ocrSkipped when pdf-parse < 100 chars and no ocrModel (D-04)", async () => {
    mockPdfParse.mockResolvedValue({ text: "short", numpages: 1 });

    const result = await parseFile(pdfPath, "sample.pdf", undefined, "auto");

    expect(result.metadata.ocrSkipped).toBe("OCR skipped: no vision model");
    expect(result.metadata.ocrApplied).toBe(false);
  });

  // Test 5 (D-03 grep guardrail): production parser source must not contain `createWorker` or `tesseract`
  it("grep guardrail: parser.ts source does not contain createWorker or tesseract", () => {
    const parserSource = fs.readFileSync(
      path.resolve(__dirname, "../services/parser.ts"),
      "utf-8",
    );
    expect(parserSource).not.toMatch(/createWorker/i);
    expect(parserSource).not.toMatch(/tesseract/i);
  });

  // Test 6 (type-level guardrail): "tesseract" must not be assignable to OcrMode.
  // The @ts-expect-error directive itself is the assertion — if "tesseract"
  // ever re-enters the OcrMode union, this directive becomes unused and tsc
  // reports TS2578 (Unused '@ts-expect-error' directive), failing typecheck.
  it("type guardrail: 'tesseract' is not assignable to OcrMode", () => {
    // @ts-expect-error — "tesseract" is no longer a valid OcrMode literal
    const _: OcrMode = "tesseract";
    expect(_).toBe("tesseract");
  });
});