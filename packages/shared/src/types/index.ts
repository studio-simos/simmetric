// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// ===== Role & Permission Types =====
// Note: PermissionName type is defined in constants/permissions.ts
// and re-exported from constants/index.ts to avoid duplication.

import type { PermissionName } from "../constants/permissions";
import type { WidgetLocalizedTexts, WidgetSuggestedQuestions, WidgetCredits } from "../schemas/widget.schema";

interface Role {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface RoleWithPermissions extends Role {
  permissions: PermissionName[];
}

// ===== User Types =====

interface User {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  customInstructions: string | null;
  textSize: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserWithRoles extends User {
  roles: RoleWithPermissions[];
}

// ===== Project Types =====

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ===== Workspace Types =====

interface Workspace {
  id: string;
  projectId: string;
  name: string;
  instructions: string | null;
  embeddingModel: string;
  allowMemberUploads: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ===== Chat Types =====

type MessageRole = "user" | "assistant" | "system";

interface Chat {
  id: string;
  workspaceId: string;
  name: string;
  prompt: string | null;
  model: string;
  temperature: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ChatMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  metadata: ChatMessageMetadata | null;
  createdAt: Date;
}

interface ChatMessageMetadata {
  sources?: SourceCitation[];
  tokensUsed?: number;
  model?: string;
  durationMs?: number;
  /** Phase 115: DLP match data for UI reconstruction — type + original matched text */
  dlpMatches?: Array<{ type: string; text: string }>;
}

export interface SourceCitation {
  documentId: string;
  documentName: string;
  pageNumber?: number;
  lineStart?: number;
  lineEnd?: number;
  paragraph?: number;
  chunkText?: string;
  /** Relevance score from the search engine (vector / FTS / RRF). Optional —
   *  the archive-fallback path does not always compute a score, so consumers
   *  MUST narrow with `!== undefined` before using (D-04). Reconciles the
   *  server's optional score with the frontend's previously-required score
   *  (Phase 87 D-01 additive superset). */
  score?: number;
  /** Provenance tag (D-14, widened Phase 90 D-01). Optional + backward-compatible.
   *  Tags the producer that emitted the citation. Threaded through the SSE
   *  `citations` event. The union was widened **additively** (D-01, D-06 — no
   *  migration, no rename) from the original `"archive" | "workspace"` pair to
   *  the full producer set:
   *    - `"rag"`      — RAG workspace corpus (canonical for the workspace
   *                    document search path; supersedes the legacy `"workspace"`
   *                    value emitted by older producers)
   *    - `"archive"`  — archive-fallback path (kb archive pages)
   *    - `"tool"`     — builtinSkills non-RAG tool results + MCP skill results
   *                    (Phase 90 producer-side tagging, Plan 90-02)
   *    - `"web"`      — web search producer (Phase 99, reserved)
   *    - `"memory"`   — per-user memory producer (Phase 97, reserved)
   *    - `"workspace"`— **legacy alias** kept in the union so persisted
   *                    citations (chat history DB, export JSON, widget iframe
   *                    cached on third-party sites, which cannot be migrated
   *                    atomically) remain valid. New producers MUST emit
   *                    `"rag"`; `normalizeSource()` maps legacy → canonical at
   *                    the producer boundary (read-side, display/telemetry
   *                    only — D-06 no migration, no write-side rewrite). */
  source?: "rag" | "archive" | "tool" | "web" | "memory" | "workspace";
  /** Phase 151 (RAG-02): wiki page slug for archive-bound citations. Optional.
   *  Set by wiki_query (per visited page) and by rag_search's archive-fallback
   *  mapper (from HybridSearchResult.metadata.pageSlug). The citation-layer
   *  dedup (dedupeCitations) keys on `page:<pageSlug>`. */
  pageSlug?: string;
  /** Phase 151 (RAG-02): underlying source document IDs parsed from
   *  `Fonti: [[doc:<id>]]` frontmatter entries. Optional. The citation-layer
   *  dedup keys on `doc:<documentId>` for each entry. */
  sourceDocumentIds?: string[];
}

/**
 * Read-side normalization for `SourceCitation.source` (Phase 90 D-01).
 *
 * Maps the legacy alias `"workspace"` → canonical `"rag"` for display /
 * telemetry / grouping at the producer boundary. Leaves every other value
 * (including `undefined`) unchanged. **Pure function, zero non-zod
 * dependencies** (shared package rule) — type-adjacent helper, no new import.
 *
 * NON riscrive dati persistiti (D-06 no migration): persisted citations with
 * `source: "workspace"` (chat history, export JSON, widget cached) remain
 * valid because `"workspace"` is retained in the union as a legacy alias;
 * `normalizeSource()` is opt-in read-side only.
 */
export function normalizeSource(
  source: SourceCitation["source"],
): SourceCitation["source"] {
  return source === "workspace" ? "rag" : source;
}

// ===== Document Types =====

type DocumentType = "pdf" | "md" | "csv" | "docx" | "xlsx" | "txt" | "pptx" | "youtube";

type DocumentStatus = "pending" | "processing" | "completed" | "failed";

interface Document {
  id: string;
  workspaceId: string;
  name: string;
  type: DocumentType;
  filePath: string;
  cacheKey: string;
  chunkCount: number;
  embeddingModel: string;
  status: DocumentStatus;
  statusMessage: string | null;
  fileSize: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DocumentChunk {
  id: string;
  documentId: string;
  chunkText: string;
  metadata: ChunkMetadata;
  embeddingId: string;
  createdAt: Date;
}

export interface ChunkMetadata {
  pageNumber?: number;
  lineStart?: number;
  lineEnd?: number;
  paragraph?: number;
  charStart?: number;
  charEnd?: number;
}

// ===== Config Types =====

type LLMProvider = "openai" | "anthropic" | "ollama" | "openrouter";
// D-08 (Phase 91-01): widened additively with "pgvector" (Rule 3).
// Phase 114-01: widened additively with "chroma" (Rule 3).
type VectorDBProvider = "lancedb" | "qdrant" | "pgvector" | "chroma";
type EmbeddingProvider = "local" | "openai";

interface SystemConfigEntry {
  id: string;
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SettingsEntry {
  key: string;
  value: string;
  readOnly: boolean;
  // D-08 (Phase 176): presence-only flag — set when an env var exists for a
  // non-readonly key; the DB value still wins. Never carries a value
  // (T-176-01: display-only presence hint; the env VALUE is never exposed).
  envOverridden?: boolean;
}

// ===== Event Log Types =====

export type EntityType = "chat" | "project" | "workspace" | "document" | "user" | "mcp_connection" | "dlp" | "archive" | "archive_page" | "archive_import" | "ocr_job" | "synthesis_run" | "wiki_edit" | "backup_destination" | "backup_job" | "provider" | "memory";

interface EventLog {
  id: string;
  entityType: EntityType;
  entityId: string;
  action: string;
  userId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

// ===== License Types =====

export interface LicenseInfo {
  tier: "community" | "enterprise";
  licensee: string;
  expiresAt: string | null;
  features: Record<string, boolean | number>;
  valid: boolean;
}

// ===== API Key Types =====

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  key_hash: string;
  createdBy: string;
  lastUsed: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
}

// ===== Widget Types =====

export interface Widget {
  id: string;
  name: string;
  welcomeMessage: string | null;
  fallbackMessage: string | null;
  position: "bottom-right" | "bottom-left";
  isActive: boolean;
  logoUrl: string | null;
  primaryColor: string | null;
  botName: string | null;
  avatarUrl: string | null;
  allowedOrigins: string[] | null;
  autoOpenDelay: number | null;
  // Wire format is the RAW JSON-encoded string (widget.schema.ts:311-313);
  // admin GET routes pass it through unparsed. The admin form parses it
  // defensively (WidgetForm.parsePatternList).
  autoOpenUrlPatterns: string[] | null;
  exitIntentEnabled: boolean;
  exitIntentCooldownMs: number;
  leadCaptureEnabled: boolean;
  leadCapturePrompt: string | null;
  createdBy: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  workspaces?: { workspaceId: string }[];
  _count?: { sessions: number; leads: number };
  localizedTexts: WidgetLocalizedTexts | null;
  suggestedQuestions: WidgetSuggestedQuestions | null;
  credits: WidgetCredits | null;
  fallbackLocale: string | null;
  // 260809-uxk T3: bound knowledge archive (D-08 wiki_query). Optional so
  // existing fixtures/tests constructing Widget objects keep compiling.
  archiveId?: string | null;
  // 260831-hgy: per-widget response model pin (provider UUID + model NAME).
  // Optional so existing fixtures/tests constructing Widget objects keep
  // compiling. Null = not configured → existing resolution chain.
  responseProviderId?: string | null;
  responseModel?: string | null;
  // 151-02 (G-151-1b): per-widget daily MESSAGE limit (null = global default
  // of 5/day prod, 50/day dev). Optional so existing fixtures keep compiling.
  sessionLimitPerDay?: number | null;
}

interface WidgetWorkspace {
  widgetId: string;
  workspaceId: string;
}

interface WidgetSession {
  id: string;
  widgetId: string;
  sessionToken: string;
  ipAddress: string | null;
  messageCount: number;
  conversationCount: number;
  lastMessageAt: string | null;
  lastResetAt: string;
  createdAt: string;
  expiresAt: string;
}

export interface WidgetLead {
  id: string;
  widgetId: string;
  sessionId: string | null;
  name: string | null;
  email: string;
  transcript: Array<{ role: "user" | "assistant"; content: string; timestamp?: string }>;
  createdAt: string;
}

// ===== Widget Analytics Types =====

interface WidgetEvent {
  id: string;
  widgetId: string;
  sessionId: string | null;
  query: string;
  topicCategory: string;
  hasCitations: boolean;
  qualityScore: number;
  responseLength: number | null;
  createdAt: string;
}

export interface DailyWidgetAnalytics {
  date: string;
  conversations: number;
  unansweredCount: number;
  qualitySum: number;
  unansweredRate: number;
  qualityRate: number;
}

export interface TopicDistribution {
  topic: string;
  count: number;
}

interface WidgetAnalyticsResponse {
  daily: DailyWidgetAnalytics[];
  topics: TopicDistribution[];
  summary: {
    totalConversations: number;
    unansweredRate: number;
    qualityRate: number;
  };
}

// ===== Chat Export/Import Types =====

export interface ChatExportData {
  exportDate: string;
  version: string;
  workspace: { name: string };
  chats: ChatExportItem[];
}

export interface ChatExportItem {
  id: string;
  title: string;
  folderName: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatExportMessage[];
}

export interface ChatExportMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  model: string | null;
}

export interface ChatImportPreview {
  format: "chatgpt" | "claude" | "openwebui" | "generic";
  chats: { title: string; messageCount: number }[];
  warnings: { type: string; count: number }[];
}

// ===== Provider Types =====

export type { Provider, ProviderModel, ProviderConfig, ProviderPreset } from "./provider";

// ===== Backup Types =====

type DestinationType = "local" | "s3" | "s3_compatible" | "google_drive" | "dropbox" | "sftp" | "ftp" | "email";

type DestinationStatus = "online" | "offline" | "error" | "unknown";

interface BackupDestination {
  id: string;
  name: string;
  type: DestinationType;
  config: string;  // JSON cifrato (AES-256-GCM)
  status: DestinationStatus;
  lastTestedAt: Date | null;
  lastTestError: string | null;
  isEnabled: boolean;
  createdBy: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface BackupJob {
  id: string;
  destinationId: string;
  name: string;
  frequency: string;
  cronExpression: string | null;
  time: string | null;
  retentionDays: number;
  isEnabled: boolean;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  nextRunAt: Date | null;
  createdBy: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface BackupLog {
  id: string;
  destinationId: string;
  jobId: string | null;
  fileName: string | null;
  fileSize: number | null;
  checksum: string | null;
  status: string;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}