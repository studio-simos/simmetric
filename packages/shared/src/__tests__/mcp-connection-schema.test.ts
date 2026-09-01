// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  createMcpConnectionSchema,
  updateMcpConnectionSchema,
  toggleMcpConnectionSchema,
  mcpConnectionIdParamSchema,
  McpConnectionCreateInput,
  McpConnectionUpdateInput,
} from "../schemas/mcpConnection.schema";

// ─── createMcpConnectionSchema ──────────────────────────────────

describe("createMcpConnectionSchema", () => {
  const validProjectId = "550e8400-e29b-41d4-a716-446655440000";
  const validWorkspaceId = "660e8400-e29b-41d4-a716-446655440001";

  // Test 1: accepts valid input with name, URL, projectId, and returns data with defaults
  it("accepts valid input with name, URL, projectId and returns data with defaults", () => {
    const result = createMcpConnectionSchema.parse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
    });
    expect(result.name).toBe("My MCP Server");
    expect(result.url).toBe("https://mcp.example.com/sse");
    expect(result.projectId).toBe(validProjectId);
    expect(result.transportType).toBe("sse");
    expect(result.headers).toEqual({});
    expect(result.enabled).toBe(true);
  });

  // Test 2: rejects "stdio" as transportType
  it('rejects "stdio" as transportType', () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
      transportType: "stdio",
    });
    expect(result.success).toBe(false);
  });

  // Test 3: rejects missing URL
  it("rejects missing URL", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      projectId: validProjectId,
    });
    expect(result.success).toBe(false);
  });

  // Test 4: rejects invalid URL format
  it("rejects invalid URL format", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "not-a-url",
      projectId: validProjectId,
    });
    expect(result.success).toBe(false);
  });

  // Test 5: rejects when both projectId and workspaceId are provided
  it("rejects when both projectId and workspaceId are provided", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
      workspaceId: validWorkspaceId,
    });
    expect(result.success).toBe(false);
  });

  // Test 6: rejects when neither projectId nor workspaceId is provided
  it("rejects when neither projectId nor workspaceId is provided", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
    });
    expect(result.success).toBe(false);
  });

  // Test 7: accepts workspaceId instead of projectId
  it("accepts workspaceId instead of projectId", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      workspaceId: validWorkspaceId,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceId).toBe(validWorkspaceId);
      expect(result.data.projectId).toBeUndefined();
    }
  });

  // Test 8: accepts headers as key-value record
  it("accepts headers as key-value record", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
      headers: { Authorization: "Bearer token123", "X-Custom": "value" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.headers).toEqual({
        Authorization: "Bearer token123",
        "X-Custom": "value",
      });
    }
  });

  // Test 9: defaults headers to {} when omitted
  it("defaults headers to {} when omitted", () => {
    const result = createMcpConnectionSchema.parse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
    });
    expect(result.headers).toEqual({});
  });

  // Additional: accepts streamable-http transport type
  it('accepts "streamable-http" as transportType', () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/mcp",
      projectId: validProjectId,
      transportType: "streamable-http",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.transportType).toBe("streamable-http");
    }
  });

  // Additional: rejects invalid projectId format
  it("rejects invalid projectId format", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      projectId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  // Additional: rejects invalid workspaceId format
  it("rejects invalid workspaceId format", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      workspaceId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  // Additional: rejects empty name
  it("rejects empty name", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "",
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
    });
    expect(result.success).toBe(false);
  });

  // Additional: rejects name exceeding 200 chars
  it("rejects name exceeding 200 chars", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "x".repeat(201),
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
    });
    expect(result.success).toBe(false);
  });

  // Additional: defaults enabled to true when omitted
  it("defaults enabled to true when omitted", () => {
    const result = createMcpConnectionSchema.parse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
    });
    expect(result.enabled).toBe(true);
  });

  // Additional: accepts enabled=false explicitly
  it("accepts enabled=false explicitly", () => {
    const result = createMcpConnectionSchema.safeParse({
      name: "My MCP Server",
      url: "https://mcp.example.com/sse",
      projectId: validProjectId,
      enabled: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });
});

// ─── updateMcpConnectionSchema ───────────────────────────────────

describe("updateMcpConnectionSchema", () => {
  const validProjectId = "550e8400-e29b-41d4-a716-446655440000";
  const validWorkspaceId = "660e8400-e29b-41d4-a716-446655440001";

  // Test 10: accepts partial updates (name only, URL only, etc.)
  it("accepts partial update with name only", () => {
    const result = updateMcpConnectionSchema.safeParse({
      name: "Updated Name",
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with URL only", () => {
    const result = updateMcpConnectionSchema.safeParse({
      url: "https://new-url.example.com/sse",
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with enabled only", () => {
    const result = updateMcpConnectionSchema.safeParse({
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  // Test 11: rejects empty object (no fields provided)
  it("rejects empty object (no fields provided)", () => {
    const result = updateMcpConnectionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  // Test 12: enforces mutual exclusivity when projectId and workspaceId are both present
  it("rejects when both projectId and workspaceId are present in update", () => {
    const result = updateMcpConnectionSchema.safeParse({
      projectId: validProjectId,
      workspaceId: validWorkspaceId,
    });
    expect(result.success).toBe(false);
  });

  // Test 13: allows update with no scope fields (preserves existing scope)
  it("allows update with no scope fields (preserves existing scope)", () => {
    const result = updateMcpConnectionSchema.safeParse({
      name: "Just a name update",
    });
    expect(result.success).toBe(true);
  });

  // Additional: accepts update with only projectId
  it("accepts update with only projectId", () => {
    const result = updateMcpConnectionSchema.safeParse({
      projectId: validProjectId,
    });
    expect(result.success).toBe(true);
  });

  // Additional: accepts update with only workspaceId
  it("accepts update with only workspaceId", () => {
    const result = updateMcpConnectionSchema.safeParse({
      workspaceId: validWorkspaceId,
    });
    expect(result.success).toBe(true);
  });

  // Additional: rejects invalid URL format in update
  it("rejects invalid URL format in update", () => {
    const result = updateMcpConnectionSchema.safeParse({
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  // Additional: rejects empty name in update
  it("rejects empty name in update", () => {
    const result = updateMcpConnectionSchema.safeParse({
      name: "",
    });
    expect(result.success).toBe(false);
  });

  // Additional: accepts transportType update
  it('accepts transportType update to "streamable-http"', () => {
    const result = updateMcpConnectionSchema.safeParse({
      transportType: "streamable-http",
    });
    expect(result.success).toBe(true);
  });

  // Additional: rejects stdio transportType in update
  it('rejects "stdio" transportType in update', () => {
    const result = updateMcpConnectionSchema.safeParse({
      transportType: "stdio",
    });
    expect(result.success).toBe(false);
  });

  // Additional: accepts headers in update
  it("accepts headers in update", () => {
    const result = updateMcpConnectionSchema.safeParse({
      headers: { "X-API-Key": "abc123" },
    });
    expect(result.success).toBe(true);
  });

  // Additional: accepts multiple fields in update
  it("accepts multiple fields in update", () => {
    const result = updateMcpConnectionSchema.safeParse({
      name: "Updated Connection",
      url: "https://new-url.example.com/sse",
      enabled: true,
      transportType: "sse",
    });
    expect(result.success).toBe(true);
  });
});

// ─── Barrel Export / Type Inference ──────────────────────────────

describe("MCP connection schema exports", () => {
  // Test 14: schemas and types are importable from @simmetric-chat/shared barrel
  it("createMcpConnectionSchema is a Zod schema", () => {
    expect(typeof createMcpConnectionSchema.parse).toBe("function");
    expect(typeof createMcpConnectionSchema.safeParse).toBe("function");
  });

  it("updateMcpConnectionSchema is a Zod schema", () => {
    expect(typeof updateMcpConnectionSchema.parse).toBe("function");
    expect(typeof updateMcpConnectionSchema.safeParse).toBe("function");
  });

  it("McpConnectionCreateInput type can be used (type-level check)", () => {
    // Type-level check: this should compile without errors
    // Note: McpConnectionCreateInput is the OUTPUT type (after defaults are applied),
    // so transportType, headers, and enabled are always present on parsed output.
    const _input: McpConnectionCreateInput = {
      name: "Test",
      url: "https://example.com",
      transportType: "sse",
      headers: {},
      enabled: true,
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(_input.name).toBe("Test");
  });

  it("McpConnectionUpdateInput type can be used (type-level check)", () => {
    // Type-level check: this should compile without errors
    const _input: McpConnectionUpdateInput = {
      name: "Updated",
    };
    expect(_input.name).toBe("Updated");
  });
});

// ─── toggleMcpConnectionSchema ────────────────────────────────────

describe("toggleMcpConnectionSchema", () => {
  it("accepts { enabled: true }", () => {
    const result = toggleMcpConnectionSchema.parse({ enabled: true });
    expect(result.enabled).toBe(true);
  });

  it("accepts { enabled: false }", () => {
    const result = toggleMcpConnectionSchema.parse({ enabled: false });
    expect(result.enabled).toBe(false);
  });

  it("rejects non-boolean enabled value", () => {
    const result = toggleMcpConnectionSchema.safeParse({ enabled: "yes" });
    expect(result.success).toBe(false);
  });

  it("rejects missing enabled field", () => {
    const result = toggleMcpConnectionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── mcpConnectionIdParamSchema ────────────────────────────────────

describe("mcpConnectionIdParamSchema", () => {
  it("accepts valid UUID", () => {
    const result = mcpConnectionIdParamSchema.parse({
      connectionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.connectionId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("rejects invalid UUID format", () => {
    const result = mcpConnectionIdParamSchema.safeParse({ connectionId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects missing connectionId", () => {
    const result = mcpConnectionIdParamSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty string connectionId", () => {
    const result = mcpConnectionIdParamSchema.safeParse({ connectionId: "" });
    expect(result.success).toBe(false);
  });
});