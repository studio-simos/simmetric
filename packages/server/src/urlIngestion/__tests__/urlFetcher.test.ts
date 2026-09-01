// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import axios from "axios";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

// Import after mocks are configured via jest.config moduleNameMapper
import { fetchUrlToMarkdown, UrlFetchResult } from "../urlFetcher";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedJSDOM = JSDOM as unknown as jest.Mock;
const mockedReadability = Readability as unknown as jest.Mock;
const mockedTurndown = TurndownService as unknown as jest.Mock;

function mockSuccessfulExtraction(
  markdownContent: string,
  title: string = "Test Article",
  siteName: string | null = null,
  byline: string | null = null
) {
  mockedJSDOM.mockReturnValue({
    window: { document: {} },
  });

  mockedReadability.mockReturnValue({
    parse: jest.fn().mockReturnValue({
      content: markdownContent,
      title,
      siteName,
      byline,
    }),
  });

  mockedTurndown.mockReturnValue({
    turndown: jest.fn().mockReturnValue(markdownContent),
  });
}

function mockEmptyExtraction() {
  mockedJSDOM.mockReturnValue({
    window: { document: {} },
  });

  mockedReadability.mockReturnValue({
    parse: jest.fn().mockReturnValue(null),
  });
}

const MOCK_MARKDOWN = `# Test Article

This is a test article with enough content to pass the 100-character threshold for meaningful extraction.

It contains multiple paragraphs that together form a coherent piece of content that Readability can parse.

The Turndown library will convert this HTML into clean Markdown format with proper heading styles.

This ensures the resulting markdown content exceeds the 200-character minimum for the test assertion.`;

describe("fetchUrlToMarkdown", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return non-empty markdown string (> 200 chars) for a valid HTTPS URL", async () => {
    mockSuccessfulExtraction(MOCK_MARKDOWN);

    mockedAxios.get.mockResolvedValueOnce({
      data: "<html>...</html>",
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as any,
    });

    const result = await fetchUrlToMarkdown("https://example.com/article");

    expect(result.markdown).toBe(MOCK_MARKDOWN);
    expect(result.markdown.length).toBeGreaterThan(200);
    expect(result.title).toBe("Test Article");
    expect(result.length).toBe(result.markdown.length);
    expect(result.excerpt).toBe(MOCK_MARKDOWN.slice(0, 200));
  });

  it("should throw descriptive error for HTTP (non-HTTPS) URL", async () => {
    await expect(
      fetchUrlToMarkdown("http://example.com/article")
    ).rejects.toThrow(/Only HTTPS URLs are supported/i);
  });

  it("should throw after timeout for unreachable URL", async () => {
    mockedAxios.get.mockRejectedValue(new Error("timeout of 30000ms exceeded"));

    await expect(
      fetchUrlToMarkdown("https://unreachable.example.com")
    ).rejects.toThrow(/Could not fetch URL/i);
  });

  it("should return error about no extractable content for empty body", async () => {
    mockEmptyExtraction();

    mockedAxios.get.mockResolvedValueOnce({
      data: "<html><head></head><body></body></html>",
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as any,
    });

    await expect(
      fetchUrlToMarkdown("https://empty.example.com")
    ).rejects.toThrow(/Could not extract meaningful content/i);
  });

  it("should include siteName and byline when available", async () => {
    mockSuccessfulExtraction(MOCK_MARKDOWN, "Meta Article", "Test Site", "John Doe");

    mockedAxios.get.mockResolvedValueOnce({
      data: "<html>...</html>",
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as any,
    });

    const result = await fetchUrlToMarkdown("https://meta.example.com/article");

    expect(result.markdown.length).toBeGreaterThan(200);
    expect(result.title).toBe("Meta Article");
    expect(result.siteName).toBe("Test Site");
    expect(result.byline).toBe("John Doe");
  });

  it("should handle AbortSignal parameter", async () => {
    mockedAxios.get.mockRejectedValueOnce({ name: "CanceledError" });

    const abortController = new AbortController();
    await expect(
      fetchUrlToMarkdown("https://example.com", abortController.signal)
    ).rejects.toThrow(/Could not fetch URL/i);
  });
});
