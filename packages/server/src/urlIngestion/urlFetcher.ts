// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import axios from "axios";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { logger } from "../utils/logger";

// D-09 constraints: 30s timeout, 10MB response limit, 2 retries with exponential backoff
const URL_FETCH_TIMEOUT = 30_000;
const URL_MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const URL_RETRY_COUNT = 2;
const URL_RETRY_BACKOFF = [1000, 4000]; // 1s, 4s

// D-09 / AI-SPEC 4b.4: max markdown before truncation
const MAX_MARKDOWN_LENGTH = 50_000;

export interface UrlFetchResult {
  markdown: string;
  title: string;
  siteName: string | null;
  byline: string | null;
  length: number;
  excerpt: string;
}

/**
 * Fetch an HTTPS URL, extract main content via Readability,
 * and convert to Markdown via Turndown.
 *
 * Constraints: HTTPS only, 30s timeout, 10MB max, 2 retries.
 * Truncates markdown output at 50,000 characters.
 */
export async function fetchUrlToMarkdown(
  url: string,
  signal?: AbortSignal
): Promise<UrlFetchResult> {
  // 1. Validate URL scheme: HTTPS only (SSRF prevention per T-29-08)
  if (!url.startsWith("https://")) {
    throw new Error(
      "Only HTTPS URLs are supported for security reasons."
    );
  }

  let lastError: unknown;

  // 2. Retry loop: URL_RETRY_COUNT attempts with exponential backoff
  for (let attempt = 0; attempt < URL_RETRY_COUNT; attempt++) {
    try {
      // Wait for backoff before retry (skip on first attempt)
      if (attempt > 0) {
        const delay = URL_RETRY_BACKOFF[attempt - 1] || 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // 3. axios GET with constraints
      const response = await axios.get<string>(url, {
        timeout: URL_FETCH_TIMEOUT,
        maxContentLength: URL_MAX_CONTENT_LENGTH,
        maxRedirects: 0,
        responseType: "text",
        headers: {
          "User-Agent": "SimmetricChat/1.0 (URL Ingestion Bot)",
          "Accept": "text/html,application/xhtml+xml",
        },
        signal,
      });

      // 4. JSDOM + Readability extraction
      const dom = new JSDOM(response.data, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      // 5. Validate extraction — require at least 100 chars of content
      if (!article?.content || article.content.length < 100) {
        throw new Error(
          `Could not extract meaningful content from ${url}. The page may require JavaScript to render. Try pasting the text manually.`
        );
      }

      // 6. Turndown HTML → Markdown conversion
      const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
      });

      let markdown = turndown.turndown(article.content);

      // 7. Truncate if needed (paragraph-boundary for readability)
      if (markdown.length > MAX_MARKDOWN_LENGTH) {
        const truncationMarker = `\n\n[TRUNCATED: Content exceeds 50,000 characters. Original length: ${markdown.length}]`;

        // Find the last paragraph boundary before the limit
        const cutoff = markdown.lastIndexOf("\n\n", MAX_MARKDOWN_LENGTH);
        if (cutoff > 0) {
          markdown = markdown.slice(0, cutoff) + truncationMarker;
        } else {
          // No paragraph boundary found, just hard truncate
          markdown = markdown.slice(0, MAX_MARKDOWN_LENGTH) + truncationMarker;
        }
      }

      // 8. Build and return result
      const result: UrlFetchResult = {
        markdown,
        title: article.title || "Untitled",
        siteName: article.siteName ?? null,
        byline: article.byline ?? null,
        length: markdown.length,
        excerpt: markdown.slice(0, 200),
      };

      // 9. Log success
      logger.debug("[urlFetcher] Successfully fetched URL", {
        url,
        title: result.title,
        length: result.length,
      });

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = err;

      // Don't retry if it was a validation error (bad URL scheme, empty content)
      if (
        message.includes("Only HTTPS URLs are supported") ||
        message.includes("Could not extract meaningful content")
      ) {
        throw err;
      }

      // Continue to next retry if attempts remain
    }
  }

  // All retries exhausted
  throw new Error(
    `Could not fetch URL: ${url} after ${URL_RETRY_COUNT} attempts${
      lastError ? `. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""
    }`
  );
}
