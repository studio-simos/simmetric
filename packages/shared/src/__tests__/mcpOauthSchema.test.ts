// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 195 (MCPO-01 D-03): OAuth fields + refines on the MCP connection
 * schemas, plus the exported oauthStatusSchema / oauthStartResponseSchema for
 * the Phase 196 UI. Mirrors the colocated mcp-connection-schema.test.ts idiom.
 */

import {
  createMcpConnectionSchema,
  updateMcpConnectionSchema,
  oauthStatusSchema,
  oauthStartResponseSchema,
} from "../schemas/mcpConnection.schema";

const projectId = "550e8400-e29b-41d4-a716-446655440000";
const workspaceId = "660e8400-e29b-41d4-a716-446655440001";

// ─── createMcpConnectionSchema — oauth refines (D-03) ────────────

describe("createMcpConnectionSchema oauth refines", () => {
  it("accepts authType oauth with a provider present", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "Google MCP",
      url: "https://mcp.example.com/sse",
      projectId,
      authType: "oauth",
      oauthProvider: "google",
      oauthScopes: "https://www.googleapis.com/auth/drive.readonly",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authType).toBe("oauth");
      expect(result.data.oauthProvider).toBe("google");
    }
  });

  it("rejects authType oauth without oauthProvider", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "Google MCP",
      url: "https://mcp.example.com/sse",
      projectId,
      authType: "oauth",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("oauthProvider is required when authType is oauth");
    }
  });

  it("rejects authType oauth with an empty-string oauthProvider", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "Google MCP",
      url: "https://mcp.example.com/sse",
      projectId,
      authType: "oauth",
      oauthProvider: "",
    });
    expect(result.success).toBe(false);
  });

  it('rejects authType "static" carrying oauthProvider (spurious oauth fields)', () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "Static MCP",
      url: "https://mcp.example.com/sse",
      projectId,
      authType: "static",
      oauthProvider: "google",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("oauth fields are only allowed when authType is oauth");
    }
  });

  it("rejects absent authType carrying oauthProvider (spurious oauth fields)", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "Static MCP",
      url: "https://mcp.example.com/sse",
      projectId,
      oauthProvider: "google",
    });
    expect(result.success).toBe(false);
  });

  it('accepts authType "static" with NO oauth fields (legacy static path untouched)', () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "Static MCP",
      url: "https://mcp.example.com/sse",
      projectId,
      authType: "static",
      headers: { Authorization: "Bearer abc" },
    });
    expect(result.success).toBe(true);
  });

  it('accepts authType "none" with no oauth fields', () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "Plain MCP",
      url: "https://mcp.example.com/sse",
      projectId,
      authType: "none",
    });
    expect(result.success).toBe(true);
  });
});

// ─── updateMcpConnectionSchema — no-.partial() shape + oauth refines ──

describe("updateMcpConnectionSchema oauth refines", () => {
  it("stays an all-optional object (no .partial()) — partial update with name only still works", () => {
    const result = updateMcpConnectionSchema.safeParse({ name: "Just a rename" });
    expect(result.success).toBe(true);
  });

  it("rejects empty update (refines survive the extension)", () => {
    const result = updateMcpConnectionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects authType oauth without oauthProvider", () => {
    const result = updateMcpConnectionSchema.safeParse({ authType: "oauth" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("oauthProvider is required when authType is oauth");
    }
  });

  it("accepts authType oauth + provider + scopes update", () => {
    const result = updateMcpConnectionSchema.safeParse({
      authType: "oauth",
      oauthProvider: "microsoft",
      oauthScopes: "offline_access https://graph.microsoft.com/Files.Read",
    });
    expect(result.success).toBe(true);
  });

  it("rejects authType static + spurious oauthScopes in update", () => {
    const result = updateMcpConnectionSchema.safeParse({
      authType: "static",
      oauthScopes: "offline_access",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("oauth fields are only allowed when authType is oauth");
    }
  });

  it("skips the oauth refines when authType is absent (name-only update)", () => {
    // oauthScopes absent + authType absent → neither refine trips.
    const result = updateMcpConnectionSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });
});

// ─── oauthStatusSchema (Phase 196 UI consumers) ───────────────────

describe("oauthStatusSchema", () => {
  it("accepts each lifecycle value", () => {
    for (const value of ["none", "pending", "authorized", "error"] as const) {
      expect(oauthStatusSchema.safeParse(value)).toEqual({ success: true, data: value });
    }
  });

  it("rejects unknown status values", () => {
    expect(oauthStatusSchema.safeParse("authorized_ok").success).toBe(false);
    expect(oauthStatusSchema.safeParse("").success).toBe(false);
    expect(oauthStatusSchema.safeParse(undefined).success).toBe(false);
  });
});

// ─── oauthStartResponseSchema (Phase 196 UI consumers) ────────────

describe("oauthStartResponseSchema", () => {
  it("accepts a non-empty authorizeUrl", () => {
    const result = oauthStartResponseSchema.safeParse({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty authorizeUrl", () => {
    expect(oauthStartResponseSchema.safeParse({ authorizeUrl: "" }).success).toBe(false);
  });

  it("rejects a missing authorizeUrl", () => {
    expect(oauthStartResponseSchema.safeParse({}).success).toBe(false);
  });
});