// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for pdfRenderer — PDF page to PNG Buffer via pdftoppm
 *
 * pdftoppm (Poppler utils) is a system binary; we mock child_process.spawn
 * and fs/promises to test argument construction, file-based output handling,
 * and error paths.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { renderPageToPng } from "../pdfRenderer";

// Mock child_process.spawn
jest.mock("child_process");

// Mock fs/promises
jest.mock("fs/promises", () => ({
  __esModule: true,
  default: {
    stat: jest.fn(),
    mkdtemp: jest.fn(),
    readFile: jest.fn(),
    rm: jest.fn(),
  },
}));

import fs from "fs/promises";

const mockFs = fs as unknown as {
  stat: jest.Mock;
  mkdtemp: jest.Mock;
  readFile: jest.Mock;
  rm: jest.Mock;
};

function createMockSpawn(
  exitCode: number = 0,
  stderrData: string = "",
): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  Object.assign(proc, { stdout, stderr });

  // Emit data after a microtask so listeners can attach
  process.nextTick(() => {
    stdout.emit("end");
    if (stderrData) {
      stderr.emit("data", Buffer.from(stderrData));
    }
    stderr.emit("end");
    proc.emit("close", exitCode);
  });

  return proc;
}

describe("renderPageToPng", () => {
  const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default fs mocks: file exists and is non-empty, tmp dir created, PNG read
    mockFs.stat.mockResolvedValue({ size: 1024 } as any);
    mockFs.mkdtemp.mockResolvedValue("/tmp/ocr-abc123");
    mockFs.readFile.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    mockFs.rm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should call pdftoppm with correct arguments and return PNG buffer", async () => {
    mockSpawn.mockImplementation(() => createMockSpawn(0));

    const result = await renderPageToPng("/tmp/test.pdf", 1, 2.0);

    expect(mockSpawn).toHaveBeenCalledWith("pdftoppm", [
      "-png",
      "-f", "1",
      "-l", "1",
      "-r", "144",
      "-singlefile",
      "/tmp/test.pdf",
      "/tmp/ocr-abc123/page",
    ]);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("should use default scale of 2.0 (144 DPI)", async () => {
    mockSpawn.mockImplementation(() => createMockSpawn(0));

    await renderPageToPng("/tmp/test.pdf", 1);

    const args = mockSpawn.mock.calls[0]![1]!;
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("144");
  });

  it("should respect custom scale factor", async () => {
    mockSpawn.mockImplementation(() => createMockSpawn(0));

    await renderPageToPng("/tmp/test.pdf", 1, 1.5);

    const args = mockSpawn.mock.calls[0]![1]!;
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("108");
  });

  it("should throw when page number is zero", async () => {
    await expect(renderPageToPng("/tmp/test.pdf", 0)).rejects.toThrow(
      "Invalid page number 0. Page numbers are 1-based.",
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("should throw when page number is negative", async () => {
    await expect(renderPageToPng("/tmp/test.pdf", -1)).rejects.toThrow(
      "Invalid page number -1. Page numbers are 1-based.",
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("should throw when PDF file does not exist", async () => {
    const enoent = new Error("ENOENT") as any;
    enoent.code = "ENOENT";
    mockFs.stat.mockRejectedValue(enoent);

    await expect(renderPageToPng("/tmp/missing.pdf", 1)).rejects.toThrow(
      "PDF file not found: /tmp/missing.pdf",
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("should throw when PDF file is empty", async () => {
    mockFs.stat.mockResolvedValue({ size: 0 } as any);

    await expect(renderPageToPng("/tmp/empty.pdf", 1)).rejects.toThrow(
      "PDF file is empty: /tmp/empty.pdf",
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("should throw when pdftoppm exits with non-zero code", async () => {
    mockSpawn.mockImplementation(() =>
      createMockSpawn(1, "Syntax Error: Could not parse PDF"),
    );

    await expect(renderPageToPng("/tmp/test.pdf", 1)).rejects.toThrow(
      "Syntax Error: Could not parse PDF",
    );
    expect(mockFs.rm).toHaveBeenCalledWith("/tmp/ocr-abc123", { recursive: true, force: true });
  });

  it("should throw when pdftoppm produces empty output", async () => {
    mockSpawn.mockImplementation(() => createMockSpawn(0));
    mockFs.readFile.mockResolvedValue(Buffer.alloc(0));

    await expect(renderPageToPng("/tmp/test.pdf", 1)).rejects.toThrow(
      "pdftoppm produced empty output",
    );
    expect(mockFs.rm).toHaveBeenCalledWith("/tmp/ocr-abc123", { recursive: true, force: true });
  });

  it("should throw when pdftoppm does not create output file", async () => {
    mockSpawn.mockImplementation(() => createMockSpawn(0));
    const enoent = new Error("ENOENT") as any;
    enoent.code = "ENOENT";
    mockFs.readFile.mockRejectedValue(enoent);

    await expect(renderPageToPng("/tmp/test.pdf", 1)).rejects.toThrow(
      "pdftoppm did not create output file",
    );
    expect(mockFs.rm).toHaveBeenCalledWith("/tmp/ocr-abc123", { recursive: true, force: true });
  });

  it("should reject when spawn itself errors (e.g., ENOENT)", async () => {
    const error = new Error("spawn pdftoppm ENOENT");
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as ChildProcess;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(proc, { stdout, stderr });
      process.nextTick(() => proc.emit("error", error));
      return proc;
    });

    await expect(renderPageToPng("/tmp/test.pdf", 1)).rejects.toThrow(
      "spawn pdftoppm ENOENT",
    );
    expect(mockFs.rm).toHaveBeenCalledWith("/tmp/ocr-abc123", { recursive: true, force: true });
  });
});
