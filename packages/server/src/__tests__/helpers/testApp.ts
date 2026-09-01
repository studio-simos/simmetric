// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Test app / prisma helpers for integration tests.
 *
 * These live inside src/ so they can be imported by both the Jest setup file
 * and integration test files without breaking the TypeScript rootDir constraint.
 */

export async function getTestApp() {
  jest.resetModules();
  const { createApp } = await import("../../index");
  return createApp();
}

export async function getTestPrisma() {
  jest.resetModules();
  const { default: prisma } = await import("../../utils/prisma");
  return prisma;
}

/**
 * Clear all mutable data from the worker database.
 * Run this in `afterAll` to avoid leaking data between test files that share
 * the same worker process.
 */
export async function clearTestData() {
  const { default: prisma } = await import("../../utils/prisma");

  const tables = [
    "ChatMessage",
    "ChatMCPPin",
    "ChatPin",
    "ChatFolder",
    "Chat",
    "WidgetSession",
    "WidgetWorkspace",
    "Widget",
    "McpCatalogEntry",
    "MCPConnection",
    "DocumentChunk",
    "Document",
    "ProviderModel",
    "Provider",
    "ProjectAccess",
    "WorkspaceAccess",
    "ApiKey",
    "RoleMenuSection",
    "UserRole",
    "Role",
    "SystemConfig",
    "EventLog",
    "PushSubscription",
    "Template",
    "WorkspaceAgentConfig",
    "Workspace",
    "Project",
    "User",
  ];

  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    } catch {
      // Table may not exist in some migration states; ignore
    }
  }
}
