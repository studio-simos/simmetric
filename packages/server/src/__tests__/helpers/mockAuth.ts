// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Auth test helpers — JWT token generation and user fixtures.
 */

import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "test-jwt-secret-for-unit-tests-32ch";

/** Generate a valid JWT for the given userId */
export function generateTestToken(userId: string): string {
  return jwt.sign({ userId, iat: 1609459200 }, TEST_JWT_SECRET);
}

/** Admin user fixture — has admin:settings permission */
export const adminUser = {
  id: "admin-001",
  username: "admin",
  email: "admin@test.com",
  passwordHash: "hashed",
  roles: [
    {
      role: {
        name: "admin",
        permissions: [
          { permissionName: "admin:settings" },
          { permissionName: "workspace:read" },
          { permissionName: "workspace:write" },
          { permissionName: "chat:read" },
          { permissionName: "chat:write" },
        ],
      },
    },
  ],
};

/** Regular user fixture — has chat:write, document:read, document:write */
export const regularUser = {
  id: "user-001",
  username: "regular",
  email: "user@test.com",
  passwordHash: "hashed",
  roles: [
    {
      role: {
        name: "user",
        permissions: [
          { permissionName: "chat:write" },
          { permissionName: "document:read" },
          { permissionName: "document:write" },
          { permissionName: "workspace:read" },
        ],
      },
    },
  ],
};

/** User with no permissions */
export const noPermUser = {
  id: "user-002",
  username: "noperm",
  email: "noperm@test.com",
  passwordHash: "hashed",
  roles: [],
};

/** User without document:write — can read documents but not upload */
export const noDocWriteUser = {
  id: "user-003",
  username: "nodocwrite",
  email: "nodocwrite@test.com",
  passwordHash: "hashed",
  roles: [
    {
      role: {
        name: "user",
        permissions: [
          { permissionName: "chat:write" },
          { permissionName: "document:read" },
          { permissionName: "workspace:read" },
        ],
      },
    },
  ],
};

/** Backup operator user — has read-only backup permissions but no write/restore */
export const backupOperatorUser = {
  id: "op-001",
  username: "backupop",
  email: "backupop@test.com",
  passwordHash: "hashed",
  roles: [
    {
      role: {
        name: "backup_operator",
        permissions: [
          { permissionName: "backup:destination:read" },
          { permissionName: "backup:job:read" },
          { permissionName: "backup:log:read" },
        ],
      },
    },
  ],
};

/**
 * D-04 fixtures — workspace access scoping for documents.
 * Admin (D-04): requires workspace access, bypasses only allowMemberUploads.
 */
export const adminWithWorkspaceAccess = {
  ...adminUser,
  id: "admin-ws-001",
  workspaceAccess: [{ workspaceId: "ws-1" }],
};

export const adminWithoutWorkspaceAccess = {
  ...adminUser,
  id: "admin-nows-001",
  workspaceAccess: [],
};

export const regularUserWithWorkspaceAccess = {
  ...regularUser,
  id: "user-ws-001",
  workspaceAccess: [{ workspaceId: "ws-1" }],
};

export const regularUserWithoutWorkspaceAccess = {
  ...regularUser,
  id: "user-nows-001",
  workspaceAccess: [],
};