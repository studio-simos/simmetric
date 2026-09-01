// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { autoDetectOllama } from "../services/ollamaAutoDetectService";

// ollama-module mock — autoDetectOllama goes through the 92-01
// getOllamaClient() factory (92-02 re-seam). Mock fn declared INSIDE the
// factory (TDZ-safe under @swc/jest), retrieved via require("ollama"). Every
// constructed Ollama instance shares this one list mock, so the factory's
// Map cache is transparent to tests.
jest.mock("ollama", () => {
  const list = jest.fn();
  return {
    __esModule: true,
    Ollama: jest.fn(() => ({ list })),
    default: { list },
    __mockList: list,
  };
});
const mockOllamaList = (require("ollama") as { __mockList: jest.Mock }).__mockList;

jest.mock("../config/env", () => ({
  getEnv: jest.fn().mockImplementation(() => ({
    LLM_PROVIDER: process.env.LLM_PROVIDER,
  })),
  clearEnvCache: jest.fn(),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe("autoDetectOllama", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.LLM_PROVIDER;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("skips when LLM_PROVIDER is already set to non-ollama", async () => {
    process.env.LLM_PROVIDER = "openai";
    await autoDetectOllama();
    expect(mockOllamaList).not.toHaveBeenCalled();
  });

  it("skips when OLLAMA_BASE_URL is already set", async () => {
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";
    await autoDetectOllama();
    expect(mockOllamaList).not.toHaveBeenCalled();
  });

  it("sets env vars when Ollama is reachable with models", async () => {
    mockOllamaList.mockResolvedValue({ models: [{ name: "gemma4:latest" }] });
    await autoDetectOllama();
    expect(process.env.LLM_PROVIDER).toBe("ollama");
    expect(process.env.OLLAMA_BASE_URL).toBe("http://ollama:11434");
    expect(process.env.OLLAMA_MODEL).toBe("gemma4:latest");
  });

  it("skips when Ollama is reachable but has no models", async () => {
    mockOllamaList.mockResolvedValue({ models: [] });
    await autoDetectOllama();
    expect(process.env.LLM_PROVIDER).toBeUndefined();
  });

  it("skips when Ollama is not reachable", async () => {
    mockOllamaList.mockRejectedValue(new Error("Connection refused"));
    await autoDetectOllama();
    expect(process.env.LLM_PROVIDER).toBeUndefined();
  });
});
