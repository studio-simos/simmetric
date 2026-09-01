// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Shared types for the agent orchestration layer.
 *
 * Extracted from `orchestrator.ts` to avoid a circular dependency between
 * `agentBudgetService.ts` and `orchestrator.ts`.
 */

export interface ChatMessageEntry {
  role: "user" | "assistant" | "system";
  content: string;
}
