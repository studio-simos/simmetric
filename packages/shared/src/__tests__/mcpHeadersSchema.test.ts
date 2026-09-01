// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { mcpHeadersSchema, McpHeaders } from "../schemas/mcpConnection.schema";

// ─── mcpHeadersSchema (D-12) ─────────────────────────────────────
// Validates hop-by-hop blocklist, header name regex, and size limits.
// Mitigates T-63-hopbyhop and T-63-oversize threats.

describe("mcpHeadersSchema", () => {
  // Test 1: rejects hop-by-hop "Connection" header
  it("rejects hop-by-hop Connection header", () => {
    const result = mcpHeadersSchema.safeParse({ Connection: "keep-alive" });
    expect(result.success).toBe(false);
  });

  // Test 2: rejects hop-by-hop "Transfer-Encoding" header
  it("rejects hop-by-hop Transfer-Encoding header", () => {
    const result = mcpHeadersSchema.safeParse({ "Transfer-Encoding": "chunked" });
    expect(result.success).toBe(false);
  });

  // Test 3: rejects hop-by-hop "Keep-Alive" header
  it("rejects hop-by-hop Keep-Alive header", () => {
    const result = mcpHeadersSchema.safeParse({ "Keep-Alive": "timeout=5" });
    expect(result.success).toBe(false);
  });

  // Test 4: rejects more than 20 headers
  it("rejects more than 20 headers", () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 21; i++) {
      tooMany[`X-Header-${i}`] = "v";
    }
    const result = mcpHeadersSchema.safeParse(tooMany);
    expect(result.success).toBe(false);
  });

  // Test 5: rejects header names not matching ^[A-Za-z0-9-]+$
  it("rejects header names with underscores", () => {
    const result = mcpHeadersSchema.safeParse({ X_Custom: "v" });
    expect(result.success).toBe(false);
  });

  // Test 6: rejects header values longer than 4096 chars
  it("rejects header values longer than 4096 chars", () => {
    const result = mcpHeadersSchema.safeParse({ Authorization: "x".repeat(4097) });
    expect(result.success).toBe(false);
  });

  // Test 7: accepts valid headers (Authorization, X-Api-Key)
  it("accepts valid headers", () => {
    const result = mcpHeadersSchema.safeParse({
      Authorization: "Bearer abc",
      "X-Api-Key": "secret-key",
    });
    expect(result.success).toBe(true);
  });

  // Test 8: accepts empty headers object
  it("accepts empty headers object", () => {
    const result = mcpHeadersSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // Type-level smoke test (compile-time only)
  it("infers McpHeaders type as Record<string, string>", () => {
    const headers: McpHeaders = { Authorization: "Bearer token" };
    expect(headers.Authorization).toBe("Bearer token");
  });
});