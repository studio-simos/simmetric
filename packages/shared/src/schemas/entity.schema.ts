// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Entity Response Schemas =====
// These are the shapes returned by API endpoints (no passwords, no sensitive data).

export const userResponseSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  email: z.string().email(),
  createdAt: z.date(),
  updatedAt: z.date(),
  roles: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      isDefault: z.boolean(),
      permissions: z.array(z.string()),
    }),
  ).optional(),
});

export const projectResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string().uuid(),
  deletedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const workspaceResponseSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  instructions: z.string().nullable(),
  embeddingModel: z.string(),
  deletedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const chatResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  model: z.string(),
  temperature: z.number(),
  folderId: z.string().uuid().nullable().optional(),
  isPinned: z.boolean().optional(),
  messageCount: z.number().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const chatMessageResponseSchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  metadata: z.any().nullable(),
  createdAt: z.date(),
});

export const documentResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  name: z.string(),
  type: z.enum(["pdf", "md", "csv"]),
  filePath: z.string(),
  cacheKey: z.string(),
  chunkCount: z.number(),
  deletedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const apiKeyResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  // Never expose key_hash in responses
  createdBy: z.string().uuid(),
  lastUsed: z.date().nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
});

// API key creation response includes the plain key once
export const apiKeyCreateResponseSchema = apiKeyResponseSchema.extend({
  plainKey: z.string(),
});

export const eventLogResponseSchema = z.object({
  id: z.string().uuid(),
  entityType: z.enum(["chat", "project", "workspace", "document", "user", "mcp_connection", "dlp"]),
  entityId: z.string(),
  action: z.string(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  entityName: z.string(),
  metadata: z.any().nullable(),
  createdAt: z.date(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type ChatMessageResponse = z.infer<typeof chatMessageResponseSchema>;
export type DocumentResponse = z.infer<typeof documentResponseSchema>;
export type ApiKeyResponse = z.infer<typeof apiKeyResponseSchema>;
export type ApiKeyCreateResponse = z.infer<typeof apiKeyCreateResponseSchema>;
export type EventLogResponse = z.infer<typeof eventLogResponseSchema>;