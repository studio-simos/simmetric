// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * parseOffice PPTX fallback tests — ING-04
 *
 * Verifies that parseOffice degrades gracefully when officeparser fails
 * (mirrors the parseDocx fallback pattern at parser.ts:159-174).
 */
import fs from "fs";
import os from "os";
import path from "path";

// Mock officeparser — the module under test for the fallback behavior.
jest.mock("officeparser", () => ({
  parseOfficeFileAsync: jest.fn(),
}));

// Mock env to satisfy any transitive config imports without hitting process.exit.
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

import { parseOfficeFileAsync } from "officeparser";
import { parseFile } from "../services/parser";
import { logger } from "../utils/logger";

const mockedParseOffice = parseOfficeFileAsync as unknown as jest.Mock;

describe("parseOffice PPTX fallback", () => {
  let tmpDir: string;
  let pptxPath: string;

  beforeEach(() => {
    mockedParseOffice.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parser-test-"));
    pptxPath = path.join(tmpDir, "sample.pptx");
    // Write a placeholder bytes — parseOffice only forwards the path to officeparser.
    fs.writeFileSync(pptxPath, Buffer.from("placeholder"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns degraded result with parserFallback flag when officeparser rejects", async () => {
    mockedParseOffice.mockRejectedValue(new Error("corrupt pptx payload"));

    const result = await parseFile(pptxPath, "sample.pptx");

    expect(result.text).toBe("");
    expect(result.metadata).toMatchObject({
      title: "sample.pptx",
      source: "sample.pptx",
      parserFallback: true,
    });
  });

  it("returns normal result when officeparser resolves", async () => {
    mockedParseOffice.mockResolvedValue("Slide 1 title\nSlide 1 body");

    const result = await parseFile(pptxPath, "sample.pptx");

    expect(result.text).toBe("Slide 1 title\nSlide 1 body");
    expect(result.metadata).toMatchObject({
      title: "sample.pptx",
      source: "sample.pptx",
    });
    expect(result.metadata).not.toHaveProperty("parserFallback");
  });

  it("logs a warning with the officeparser failure message when falling back", async () => {
    const warnSpy = jest.spyOn(logger, "warn");
    mockedParseOffice.mockRejectedValue(new Error("corrupt pptx payload"));

    await parseFile(pptxPath, "sample.pptx");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as unknown as string;
    expect(msg).toContain('[parser] officeparser failed for "sample.pptx"');
    expect(msg).toContain("falling back to degraded text extraction");
    expect(msg).toContain("corrupt pptx payload");
    warnSpy.mockRestore();
  });
});