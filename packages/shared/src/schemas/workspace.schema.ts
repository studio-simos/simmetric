// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Workspace Schemas =====

export const createWorkspaceSchema = z.object({
  projectId: z.string().uuid("Invalid project ID"),
  name: z
    .string()
    .min(1, "Workspace name is required")
    .max(200, "Workspace name must be under 200 characters"),
  instructions: z.string().max(5000).optional(),
  embeddingModel: z.string().default("Xenova/all-MiniLM-L6-v2"),
  templateId: z.string().uuid("Invalid template ID").optional(),
  // Template override fields — if provided, these take precedence over template defaults
  systemPrompt: z.string().max(10000).optional(),
  skills: z.array(z.string()).optional(),
  constraints: z.object({
    localLLMOnly: z.boolean().optional(),
    hybridSearchForced: z.boolean().optional(),
    citationRequired: z.boolean().optional(),
  }).optional(),
  parsingConfig: z.object({
    ocrRequired: z.boolean().optional(),
  }).optional(),
  allowMemberUploads: z.boolean().default(true),
  icon: z.string().max(50).nullable().optional(),
});

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  instructions: z.string().max(5000).nullable().optional(),
  embeddingModel: z.string().optional(),
  templateId: z.string().uuid().nullable().optional(),
  allowMemberUploads: z.boolean().optional(),
  icon: z.string().max(50).nullable().optional(),
  systemPrompt: z.string().max(10000).optional(),
  skills: z.array(z.string()).optional(),
  constraints: z.object({
    localLLMOnly: z.boolean().optional(),
    hybridSearchForced: z.boolean().optional(),
    citationRequired: z.boolean().optional(),
  }).optional(),
  parsingConfig: z.object({
    ocrRequired: z.boolean().optional(),
  }).optional(),
});

export const permanentDeleteWorkspacesSchema = z.object({
  ids: z.array(z.string().uuid()),
});

type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
type PermanentDeleteWorkspacesInput = z.infer<typeof permanentDeleteWorkspacesSchema>;