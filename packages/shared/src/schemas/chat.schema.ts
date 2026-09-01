// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";
import { WIDGET_LOCALES } from "./widget.schema";

// ===== Chat Schemas =====

export const createChatSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  name: z.string().min(1).max(200).optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1, "Message content is required").max(50000),
});

/** Schema for the primary chat endpoints (POST /chat and POST /chat/stream).
 *  Uses `message` field to match the actual API contract and frontend payload. */
export const chatRequestSchema = z.object({
  message: z.string().min(1, "Message is required").max(50000),
  chatId: z.string().uuid().nullable().optional(),
  ragContext: z.string().max(50000).optional(),
  providerId: z.string().uuid().nullable().optional(),
  model: z.string().nullable().optional(),
  attachedDocumentId: z.string().uuid().nullable().optional(),
  isRegeneration: z.boolean().optional(),
  disableRagSearch: z.boolean().optional(),
  // 131-07 (G-131-19): the visitor locale (widget-only field — the frontend
  // never sends it). Additive-optional enum: the JWT route is byte-identical
  // without it, and the WIDGET_LOCALES whitelist is the prompt-injection
  // defense (T-131-15) — no free-form string ever reaches the system prompt.
  locale: z.enum(WIDGET_LOCALES).optional(),
  // D-03 (Phase 94): opt-in flag for the SSE `thinking` event. When `true`,
  // the server emits `event: thinking` for each reasoning chunk (mirror of
  // `token`). When `false`/absent, reasoning is parsed and silently discarded
  // (the onThinking callback still fires upstream, but chat.ts checks the flag
  // before emitting). The widget proxy NEVER sets this flag AND strips
  // `event: thinking` blocks defense-in-depth (Pitfall 4 HIGHEST RISK).
  include_thinking: z.boolean().optional(),
  // 260815-k5s (D-01): the workspace archive the new chat should be scoped
  // to from the very first message. Additive-nullable-optional — mirrors
  // `linkArchiveSchema.archiveId`. The JWT route threads `req.body.archiveId`
  // as the 4th arg to `handleChatStream`, which writes it on chat.create
  // (same path the widget uses). Existing callers that omit it are byte-
  // identical (undefined normalizes to null at the route boundary).
  archiveId: z.string().uuid("Invalid archive ID").nullable().optional(),
});

export const updateChatSchema = z.object({
  name: z.string().min(1).max(200).optional(),
});

export const renameChatSchema = updateChatSchema;

export const updateChatModelSchema = z.object({
  providerId: z.string().uuid().nullable().optional(),
  model: z.string().nullable().optional(),
});
type UpdateChatModelInput = z.infer<typeof updateChatModelSchema>;

/**
 * Schema for `PATCH /:workspaceId/chats/:chatId/archive` (D-09).
 * `archiveId` is a UUID or explicit `null` (unlink). NOT `.optional()` — the
 * endpoint always receives an explicit value (null for unlink).
 */
export const linkArchiveSchema = z.object({
  archiveId: z.string().uuid("Invalid archive ID").nullable(),
});
type LinkArchiveInput = z.infer<typeof linkArchiveSchema>;

/**
 * Workspace agent config update schema (PUT /workspaces/:id/agent-config).
 * All fields optional — the route upserts and only touches provided keys.
 * `planMode` enables the two-phase (plan → execute) orchestrator flow.
 */
const updateWorkspaceAgentConfigSchema = z.object({
  systemPrompt: z.string().max(20000).optional(),
  enabledSkills: z.array(z.string()).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  providerId: z.string().uuid().nullable().optional(),
  planMode: z.boolean().optional(),
});
type UpdateWorkspaceAgentConfigInput = z.infer<typeof updateWorkspaceAgentConfigSchema>;

/**
 * Structured plan emitted by the orchestrator planning phase and forwarded
 * to the frontend as an SSE `plan` event. Stored verbatim in the assistant
 * message metadata so the banner survives chat reloads.
 */
const agentPlanStepSchema = z.object({
  step: z.number().int().min(1),
  action: z.string().min(1).max(1000),
  tool: z.string().nullable().optional(),
});
type AgentPlanStep = z.infer<typeof agentPlanStepSchema>;

const agentPlanSchema = z.object({
  goal: z.string().min(1).max(1000),
  steps: z.array(agentPlanStepSchema).max(5),
});
export type AgentPlan = z.infer<typeof agentPlanSchema>;

type CreateChatInput = z.infer<typeof createChatSchema>;
type SendMessageInput = z.infer<typeof sendMessageSchema>;
type ChatRequestInput = z.infer<typeof chatRequestSchema>;
type UpdateChatInput = z.infer<typeof updateChatSchema>;

export const createFolderSchema = z.object({
  name: z.string().min(1).max(200),
});
type CreateFolderInput = z.infer<typeof createFolderSchema>;

export const updateFolderSchema = z.object({
  name: z.string().min(1).max(200),
});
type UpdateFolderInput = z.infer<typeof updateFolderSchema>;

export const moveChatSchema = z.object({
  folderId: z.string().uuid().nullable(),
});
type MoveChatInput = z.infer<typeof moveChatSchema>;

const chatExportQuerySchema = z.object({
  format: z.enum(["json"]).default("json"),
});

const chatImportPreviewSchema = z.object({
  format: z.enum(["chatgpt", "claude", "openwebui", "generic"]).optional(),
});

export const editMessageSchema = z.object({
  content: z.string().min(1, "Message content is required").max(50000),
});
type EditMessageInput = z.infer<typeof editMessageSchema>;

type ChatExportQueryInput = z.infer<typeof chatExportQuerySchema>;
type ChatImportPreviewInput = z.infer<typeof chatImportPreviewSchema>;