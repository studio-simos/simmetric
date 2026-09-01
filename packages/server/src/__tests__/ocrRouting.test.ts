// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * OCR routing decision tree tests — ING-03/ING-07 (Plan 60-05 Task 1 + Plan 66.1-02 Task 2)
 *
 * Verifies the `resolveOcrRouting` decision tree that replaces the legacy
 * `"eng"` sentinel at documents.ts:333. The routing is config-driven via
 * SystemConfig keys (D-07) with a pdf-parse pre-check threshold (D-08),
 * a server-side vision OCR path (D-01), and D-04 graceful degradation.
 *
 * Phase 66.1-02 (ING-07) closed the server + shared side: the tesseract
 * branch was removed and the OcrRoutingResult union was reduced to three
 * values. These tests codify the never-returns-tesseract guardrail via a
 * parameterized matrix, a type-level @ts-expect-error, and a grep guard
 * over the production source.
 */
import "./helpers/setupEnv";
import * as fs from "fs";
import * as path from "path";

// Mock prisma singleton — required for documents.ts to load
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

// Mock env to satisfy transitive config imports
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    COLLECTOR_URL: "http://localhost:3210",
  })),
}));

// Mock ragOcrService — not exercised in routing unit tests
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

// Mock eventLogService — avoids transitive TS errors in eventLogService.ts
jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn(),
  queryEvents: jest.fn(),
}));

// Mock systemConfigService — not exercised in routing unit tests
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(),
  getAllSettings: jest.fn(),
  updateSettings: jest.fn(),
  seedConfigDefaults: jest.fn(),
}));

import { resolveOcrRouting, type OcrRoutingResult } from "../routes/documents";

// Type-level guardrail (Test 6): if the "tesseract" literal ever re-enters
// the OcrRoutingResult["ocrMode"] union, the @ts-expect-error directive
// becomes unused (TS2578) and typecheck fails. Kept outside the suite so it
// is evaluated at compile time, not at runtime.
// @ts-expect-error "tesseract" is not assignable to OcrRoutingResult["ocrMode"] post-ING-07
const _TYPE_GUARD: OcrRoutingResult["ocrMode"] = "tesseract";
void _TYPE_GUARD;

describe("OCR routing decision tree (resolveOcrRouting)", () => {
  // Test 1: OCR_ENABLED="false" → skip OCR entirely
  it("returns skip when OCR_ENABLED is false", () => {
    const result = resolveOcrRouting({
      ocrEnabled: "false",
      precheckThreshold: 200,
      ocrModel: "glm-ocr:latest",
      pdfTextLength: 10,
    });
    expect(result.ocrMode).toBe("skip");
    expect(result.ocrSkipped).toBe("OCR skipped: disabled by config");
  });

  // Test 2: OCR_ENABLED="true" + pdf-parse > threshold → skip vision OCR, text-only
  it("returns text-only when pdf-parse extracts more than threshold chars", () => {
    const result = resolveOcrRouting({
      ocrEnabled: "true",
      precheckThreshold: 200,
      ocrModel: "glm-ocr:latest",
      pdfTextLength: 500,
    });
    expect(result.ocrMode).toBe("text-only");
    expect(result.ocrSkipped).toBeUndefined();
  });

  // Test 3: OCR_ENABLED="true" + pdf-parse < threshold + vision model available → vision OCR
  it("returns vision when pdf-parse < threshold and vision model is available", () => {
    const result = resolveOcrRouting({
      ocrEnabled: "true",
      precheckThreshold: 200,
      ocrModel: "glm-ocr:latest",
      pdfTextLength: 50,
    });
    expect(result.ocrMode).toBe("vision");
    expect(result.ocrSkipped).toBeUndefined();
  });

  // Test 4: OCR_ENABLED="true" + pdf-parse < threshold + no vision model → D-04 skip
  it("returns skip with ocrSkipped message when no vision model is configured", () => {
    const result = resolveOcrRouting({
      ocrEnabled: "true",
      precheckThreshold: 200,
      ocrModel: "",
      pdfTextLength: 50,
    });
    expect(result.ocrMode).toBe("skip");
    expect(result.ocrSkipped).toBe("OCR skipped: no vision model");
  });

  // Edge: threshold 0 means any extracted text skips vision OCR
  it("returns text-only when threshold is 0 and pdf has text", () => {
    const result = resolveOcrRouting({
      ocrEnabled: "true",
      precheckThreshold: 0,
      ocrModel: "glm-ocr:latest",
      pdfTextLength: 1,
    });
    expect(result.ocrMode).toBe("text-only");
  });

  // Test 5: guardrail — never returns "tesseract" across the input matrix
  it.each([
    // enabled × vision/empty × pdf above/below threshold
    { ocrEnabled: "false", ocrModel: "glm-ocr:latest", pdfTextLength: 0 },
    { ocrEnabled: "false", ocrModel: "glm-ocr:latest", pdfTextLength: 500 },
    { ocrEnabled: "false", ocrModel: "", pdfTextLength: 0 },
    { ocrEnabled: "false", ocrModel: "", pdfTextLength: 500 },
    { ocrEnabled: "true", ocrModel: "glm-ocr:latest", pdfTextLength: 0 },
    { ocrEnabled: "true", ocrModel: "glm-ocr:latest", pdfTextLength: 500 },
    { ocrEnabled: "true", ocrModel: "", pdfTextLength: 0 },
    { ocrEnabled: "true", ocrModel: "", pdfTextLength: 500 },
  ] as const)("never returns tesseract for input %j", (input) => {
    const result = resolveOcrRouting({ ...input, precheckThreshold: 200 });
    expect(result.ocrMode).not.toBe("tesseract");
    // Type-narrowed sanity: union is skip|text-only|vision
    expect(["skip", "text-only", "vision"]).toContain(result.ocrMode);
  });

  // Test 7 + 8: grep guardrails over the production source file
  it("documents.ts source has no tesseract reference and no OCR_TESSERACT_FALLBACK read", () => {
    const docsPath = path.resolve(__dirname, "../routes/documents.ts");
    const source = fs.readFileSync(docsPath, "utf-8");
    // No occurrence of "tesseract" (case-insensitive)
    expect(source).not.toMatch(/tesseract/i);
    // No occurrence of the orphaned config key
    expect(source).not.toMatch(/OCR_TESSERACT_FALLBACK/);
  });
});