// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * initFilters unit tests (Phase 100-01)
 *
 * Covers filesystem discovery of plugins/ directory, dynamic import, invalid
 * export skipping with warn log, and SystemConfig filter_<name>_enabled
 * enable/disable (D-01). Filesystem + dynamic import are mocked.
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

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(),
}));

jest.mock("fs", () => ({
  readdirSync: jest.fn(),
  existsSync: jest.fn(),
}));

import { initFilters } from "../filters/initFilters";
import { getFilter, _clearAllFilters } from "../filters/filterRegistry";
import { getSetting } from "../services/systemConfigService";
import type { FilterPlugin } from "../filters/types";

// Re-import the mocked fs module to access the mock functions.
import fs from "fs";
const mockReaddirSync = fs.readdirSync as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;

const validDlp: FilterPlugin = {
  name: "dlp",
  priority: -1,
  description: "DLP",
  inlet: async () => {},
  outlet: async () => {},
};

const validUser: FilterPlugin = {
  name: "profanity",
  priority: 0,
  inlet: async () => {},
};

describe("initFilters", () => {
  beforeEach(() => {
    _clearAllFilters();
    jest.clearAllMocks();
  });

  it("scans plugins/ directory, dynamic imports .ts files, validates export has name + priority", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["dlp.ts"]);
    jest.doMock(
      "../filters/plugins/dlp.ts",
      () => ({ __esModule: true, default: validDlp }),
      { virtual: true },
    );
    (getSetting as jest.Mock).mockResolvedValue({ value: "true" });

    await initFilters();

    expect(getFilter("dlp")).toBe(validDlp);
    expect(validDlp.enabled).toBe(true);
  });

  it("invalid export (missing name) is skipped with warn log", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["broken.ts"]);
    jest.doMock(
      "../filters/plugins/broken.ts",
      () => ({ __esModule: true, default: { priority: 0 } }),
      { virtual: true },
    );
    (getSetting as jest.Mock).mockResolvedValue({ value: "true" });

    await initFilters();

    expect(getFilter("broken")).toBeUndefined();
  });

  it("invalid export (missing priority) is skipped with warn log", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["noPrio.ts"]);
    jest.doMock(
      "../filters/plugins/noPrio.ts",
      () => ({ __esModule: true, default: { name: "noPrio" } }),
      { virtual: true },
    );
    (getSetting as jest.Mock).mockResolvedValue({ value: "true" });

    await initFilters();

    expect(getFilter("noPrio")).toBeUndefined();
  });

  it("SystemConfig filter_<name>_enabled = 'false' sets plugin.enabled = false", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["profanity.ts"]);
    jest.doMock(
      "../filters/plugins/profanity.ts",
      () => ({ __esModule: true, default: validUser }),
      { virtual: true },
    );
    (getSetting as jest.Mock).mockResolvedValue({ value: "false" });

    await initFilters();

    expect(getFilter("profanity")).toBe(validUser);
    expect(validUser.enabled).toBe(false);
  });

  it("SystemConfig filter_<name>_enabled absent (default) sets plugin.enabled = true", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["profanity2.ts"]);
    const plugin: FilterPlugin = { name: "profanity2", priority: 0 };
    jest.doMock(
      "../filters/plugins/profanity2.ts",
      () => ({ __esModule: true, default: plugin }),
      { virtual: true },
    );
    (getSetting as jest.Mock).mockResolvedValue({ value: "true" });

    await initFilters();

    expect(getFilter("profanity2")).toBe(plugin);
    expect(plugin.enabled).toBe(true);
  });

  it("missing plugins directory skips initialization (no crash)", async () => {
    mockExistsSync.mockReturnValue(false);
    await initFilters();
    expect(getFilter("dlp")).toBeUndefined();
  });

  it("dynamic import failure is caught and logged, other plugins still load", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["bad.ts", "good.ts"]);
    jest.doMock(
      "../filters/plugins/bad.ts",
      () => {
        throw new Error("import failed");
      },
      { virtual: true },
    );
    jest.doMock(
      "../filters/plugins/good.ts",
      () => ({ __esModule: true, default: { name: "good", priority: 0 } }),
      { virtual: true },
    );
    (getSetting as jest.Mock).mockResolvedValue({ value: "true" });

    await initFilters();

    expect(getFilter("bad")).toBeUndefined();
    expect(getFilter("good")).toBeDefined();
  });
});