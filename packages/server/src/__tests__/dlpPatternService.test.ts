// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * dlpPatternService unit tests (quick 260829-ony).
 *
 * Covers: getActivePatterns TTL cache, compileRegex validation failures,
 * testPattern (no persist + zero-length guard), invalidateCache clearing both
 * caches, and the §4.9 max-custom constant.
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

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    dlpPattern: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import prisma from "../utils/prisma";
import {
  compileRegex,
  getActivePatterns,
  getActiveCompiledPatterns,
  invalidateCache,
  testPattern,
  countCustomPatterns,
  MAX_CUSTOM_PATTERNS,
  isCacheWarmForTest,
  expireCacheForTest,
  listPatterns,
} from "../services/dlpPatternService";

const findMany = prisma.dlpPattern.findMany as jest.Mock;
const count = prisma.dlpPattern.count as jest.Mock;

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "row-1",
  name: "email",
  displayName: "Email",
  pattern: "[a-z]+@example\\.com",
  patternFlags: "gu",
  replacement: "[REDACTED]",
  isEnabled: true,
  isBuiltIn: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  invalidateCache();
});

describe("compileRegex", () => {
  it("compiles a valid regex", () => {
    expect(() => compileRegex("[A-Z]{6}", "g")).not.toThrow();
    expect(compileRegex("[A-Z]{6}", "g")).toBeInstanceOf(RegExp);
  });

  it("throws (routes map to 400) on an invalid regex — spec §4.2 mitigate", () => {
    expect(() => compileRegex("([unclosed", "g")).toThrow(/Invalid regex pattern/);
  });

  it("rejects dangerous flag letters via RegExp constructor throw", () => {
    expect(() => compileRegex("abc", "x!")).toThrow(/Invalid regex pattern/);
  });
});

describe("getActivePatterns cache", () => {
  it("queries DB once for repeated calls within the TTL", async () => {
    findMany.mockResolvedValue([row()]);
    await getActivePatterns();
    await getActivePatterns();
    await getActivePatterns();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(isCacheWarmForTest()).toBe(true);
  });

  it("re-queries after invalidateCache", async () => {
    findMany.mockResolvedValue([row()]);
    await getActivePatterns();
    await getActivePatterns();
    invalidateCache();
    await getActivePatterns();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("re-queries after the TTL expires (5-min cross-instance window — spec §4.5)", async () => {
    findMany.mockResolvedValue([row()]);
    await getActivePatterns();
    await getActivePatterns();
    // Force-expire the TTL without touching the rows cache.
    expireCacheForTest();
    await getActivePatterns();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("returns only enabled rows (where isEnabled: true)", async () => {
    findMany.mockResolvedValue([row()]);
    await getActivePatterns();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isEnabled: true },
        orderBy: [{ createdAt: "asc" }, { name: "asc" }],
      }),
    );
  });
});

describe("getActiveCompiledPatterns", () => {
  it("compiles each row and reuses the compiled cache across calls", async () => {
    findMany.mockResolvedValue([row({ id: "r1" }), row({ id: "r2", name: "ssn", pattern: "\\d{3}-\\d{2}-\\d{4}" })]);
    const first = await getActiveCompiledPatterns();
    const second = await getActiveCompiledPatterns();
    expect(first).toHaveLength(2);
    expect(first[0]!.regex).toBe(second[0]!.regex); // same RegExp instance
    expect(first[1]!.regex).not.toBe(first[0]!.regex);
  });

  it("invalidateCache clears the compiled cache (new RegExp instances after)", async () => {
    findMany.mockResolvedValue([row({ id: "r1" })]);
    const first = await getActiveCompiledPatterns();
    invalidateCache();
    findMany.mockResolvedValue([row({ id: "r1" })]);
    const second = await getActiveCompiledPatterns();
    expect(second[0]!.regex).not.toBe(first[0]!.regex);
  });
});

describe("testPattern", () => {
  it("returns matches + redacted preview without persisting", () => {
    const res = testPattern("[a-z]+@example\\.com", "g", "mail me at bob@example.com now");
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]!.matchedText).toBe("bob@example.com");
    expect(res.redactedText).toBe("mail me at [REDACTED] now");
  });

  it("throws on invalid regex (caller maps to 400)", () => {
    expect(() => testPattern("([bad", "g", "sample")).toThrow(/Invalid regex pattern/);
  });

  it("guards against zero-length-match infinite loops", () => {
    // `a*` matches zero chars everywhere — exec loop must terminate (guard
    // advances lastIndex). String.replace itself inserts the replacement at
    // every zero-width boundary — standard JS semantics; we only pin that the
    // call RETURNS rather than hanging.
    const res = testPattern("a*", "g", "bbb");
    expect(typeof res.redactedText).toBe("string");
    expect(res.matches.every((m) => m.length === 0 || m.matchedText.length === m.length)).toBe(true);
  });

  it("returns empty matches for a clean sample", () => {
    const res = testPattern("\\d{5}", "g", "no digits");
    expect(res.matches).toEqual([]);
    expect(res.redactedText).toBe("no digits");
  });
});

describe("countCustomPatterns", () => {
  it("counts only non built-in rows", async () => {
    count.mockResolvedValue(7);
    await expect(countCustomPatterns()).resolves.toBe(7);
    expect(count).toHaveBeenCalledWith({ where: { isBuiltIn: false } });
  });
});

describe("MAX_CUSTOM_PATTERNS", () => {
  it("is 50 per spec §4.9", () => {
    expect(MAX_CUSTOM_PATTERNS).toBe(50);
  });
});

describe("listPatterns", () => {
  it("lists ALL rows (no isEnabled filter) ordered createdAt then name", async () => {
    findMany.mockResolvedValue([row(), row({ id: "r2", isEnabled: false })]);
    const all = await listPatterns();
    expect(all).toHaveLength(2);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    });
  });
});