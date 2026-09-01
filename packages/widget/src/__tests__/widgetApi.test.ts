// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    get: jest.fn(),
    patch: jest.fn(),
  },
}));

import axios from "axios";
import { searchWidgetWorkspaces, getWidgetConfig } from "../services/widgetApi";

const mockedAxiosPost = axios.post as jest.Mock;
const mockedAxiosGet = axios.get as jest.Mock;

describe("searchWidgetWorkspaces", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls POST /api/internal/widget/search with correct body { query, widgetId, limit }", async () => {
    mockedAxiosPost.mockResolvedValue({
      data: { results: [{ chunkId: "c1", chunkText: "text", score: 0.9 }] },
    });

    await searchWidgetWorkspaces("hello world", "widget-123", 5);

    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockedAxiosPost.mock.calls[0];
    expect(url).toContain("/api/internal/widget/search");
    expect(body).toEqual({
      query: "hello world",
      widgetId: "widget-123",
      limit: 5,
    });
  });

  it("sends widgetId (NOT workspaceIds) in request body", async () => {
    mockedAxiosPost.mockResolvedValue({
      data: { results: [] },
    });

    await searchWidgetWorkspaces("test query", "widget-456");

    const body = mockedAxiosPost.mock.calls[0][1];
    // Must NOT contain workspaceIds -- server resolves from DB whitelist
    expect(body).not.toHaveProperty("workspaceIds");
    expect(body.widgetId).toBe("widget-456");
  });

  it("passes X-Api-Key header from env", async () => {
    mockedAxiosPost.mockResolvedValue({
      data: { results: [] },
    });

    await searchWidgetWorkspaces("test", "widget-789");

    const config = mockedAxiosPost.mock.calls[0][2];
    expect(config.headers["X-Api-Key"]).toBe("sk-test-widget-key");
  });

  it("uses 30s timeout", async () => {
    mockedAxiosPost.mockResolvedValue({
      data: { results: [] },
    });

    await searchWidgetWorkspaces("test", "widget-789");

    const config = mockedAxiosPost.mock.calls[0][2];
    expect(config.timeout).toBe(30000);
  });

  it("returns { results } from server response", async () => {
    const mockResults = [
      { chunkId: "c1", documentId: "d1", chunkText: "text 1", score: 0.9 },
      { chunkId: "c2", documentId: "d2", chunkText: "text 2", score: 0.7 },
    ];
    mockedAxiosPost.mockResolvedValue({
      data: { results: mockResults },
    });

    const result = await searchWidgetWorkspaces("test", "widget-789");

    expect(result).toEqual({ results: mockResults });
  });

  it("uses default limit of 10 when not specified", async () => {
    mockedAxiosPost.mockResolvedValue({
      data: { results: [] },
    });

    await searchWidgetWorkspaces("test", "widget-789");

    const body = mockedAxiosPost.mock.calls[0][1];
    expect(body.limit).toBe(10);
  });
});

describe("getWidgetConfig", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls GET /api/internal/widget/{id}/config with the widget id", async () => {
    mockedAxiosGet.mockResolvedValue({
      data: { id: "widget-1" },
    });

    await getWidgetConfig("widget-1");

    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    const [url] = mockedAxiosGet.mock.calls[0];
    expect(url).toContain("/api/internal/widget/widget-1/config");
  });

  it("passes X-Api-Key header from env", async () => {
    mockedAxiosGet.mockResolvedValue({
      data: { id: "widget-1" },
    });

    await getWidgetConfig("widget-1");

    const config = mockedAxiosGet.mock.calls[0][1];
    expect(config.headers["X-Api-Key"]).toBe("sk-test-widget-key");
  });

  it("returns the server response data", async () => {
    mockedAxiosGet.mockResolvedValue({
      data: { id: "w-1", workspaceId: "ws-1" },
    });

    const result = await getWidgetConfig("widget-1");

    expect(result).toEqual({ id: "w-1", workspaceId: "ws-1" });
  });
});