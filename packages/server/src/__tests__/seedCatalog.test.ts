// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for MCP catalog seed entries (MCP-06 / D-16 AUGMENT).
 *
 * Verifies that:
 *  - 15 new curated entries with real URLs are appended (IDs 0013..0027)
 *  - 12 existing placeholder entries are kept unchanged (D-16)
 *  - New entries carry no runtime/phone-home fields (D-03 air-gap)
 *  - The upsert update branch does not clobber admin/runtime-owned fields (D-04)
 *  - Seed is idempotent (upsert called once per entry per run)
 */
import "./helpers/setupEnv";

import { MCP_CATALOG_ENTRIES, seedCatalogEntries } from "../../prisma/seed";

const PLACEHOLDER_IDS = Array.from(
  { length: 12 },
  (_, i) =>
    `b1e3f4a2-${String(i + 1).padStart(4, "0")}-4000-8000-0000000000${String(i + 1).padStart(2, "0")}`,
);

const NEW_IDS = Array.from(
  { length: 15 },
  (_, i) =>
    `b1e3f4a2-${String(i + 13).padStart(4, "0")}-4000-8000-0000000000${String(i + 13).padStart(2, "0")}`,
);

function makeMockPrisma() {
  return {
    mcpCatalogEntry: { upsert: jest.fn().mockResolvedValue({}) },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
}

describe("mcp catalog seed", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("seeds 15 new curated entries with IDs b1e3f4a2-0013 through b1e3f4a2-0027", () => {
    const ids = MCP_CATALOG_ENTRIES.map((e) => e.id);
    for (const id of NEW_IDS) {
      expect(ids).toContain(id);
    }
    const newEntries = MCP_CATALOG_ENTRIES.filter((e) =>
      NEW_IDS.includes(e.id),
    );
    expect(newEntries).toHaveLength(15);
  });

  it("keeps the 12 existing placeholder entries unchanged (D-16 AUGMENT)", () => {
    const ids = MCP_CATALOG_ENTRIES.map((e) => e.id);
    for (const id of PLACEHOLDER_IDS) {
      expect(ids).toContain(id);
    }
    // Verify a known placeholder URL is still present (not replaced)
    const githubPlaceholder = MCP_CATALOG_ENTRIES.find(
      (e) => e.id === "b1e3f4a2-0001-4000-8000-000000000001",
    );
    expect(githubPlaceholder).toBeDefined();
    expect(githubPlaceholder?.url).toBe("https://mcp.github.com/sse");
    expect(githubPlaceholder?.name).toBe("GitHub MCP Server");
  });

  it("new entries have no phone-home fields and headers='{}' (D-03 air-gap)", () => {
    const newEntries = MCP_CATALOG_ENTRIES.filter((e) =>
      NEW_IDS.includes(e.id),
    );
    expect(newEntries).toHaveLength(15);
    for (const entry of newEntries) {
      expect(entry).not.toHaveProperty("installCount");
      expect(entry).not.toHaveProperty("healthStatus");
      expect(entry).not.toHaveProperty("consecutiveFailures");
      expect(entry).not.toHaveProperty("lastHealthCheck");
      expect(entry.headers).toBe("{}");
    }
  });

  it("uses real URLs for new entries (not placeholder)", () => {
    const github = MCP_CATALOG_ENTRIES.find(
      (e) => e.id === "b1e3f4a2-0013-4000-8000-000000000013",
    );
    expect(github?.url).toBe("https://api.githubcopilot.com/mcp");
    const semgrep = MCP_CATALOG_ENTRIES.find(
      (e) => e.id === "b1e3f4a2-0027-4000-8000-000000000027",
    );
    expect(semgrep?.url).toBe("https://mcp.semgrep.ai/sse");
  });

  it("upsert update branch does not include runtime fields (D-04)", async () => {
    const mockPrisma = makeMockPrisma();
    await seedCatalogEntries(mockPrisma);
    const calls = (mockPrisma.mcpCatalogEntry.upsert as jest.Mock).mock.calls;
    expect(calls.length).toBe(MCP_CATALOG_ENTRIES.length);
    for (const call of calls) {
      const update = call[0].update;
      expect(update).not.toHaveProperty("installCount");
      expect(update).not.toHaveProperty("healthStatus");
      expect(update).not.toHaveProperty("consecutiveFailures");
      expect(update).not.toHaveProperty("lastHealthCheck");
    }
  });

  it("is idempotent — upsert called once per entry per run", async () => {
    const mockPrisma = makeMockPrisma();
    await seedCatalogEntries(mockPrisma);
    expect(mockPrisma.mcpCatalogEntry.upsert).toHaveBeenCalledTimes(
      MCP_CATALOG_ENTRIES.length,
    );
    await seedCatalogEntries(mockPrisma);
    expect(mockPrisma.mcpCatalogEntry.upsert).toHaveBeenCalledTimes(
      MCP_CATALOG_ENTRIES.length * 2,
    );
  });
});