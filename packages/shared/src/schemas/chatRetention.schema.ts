// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Chat Retention Schema =====
// Phase 84 (SEED-001, D-08): dedicated write contract for chat_message_retention_days.
// confirmDataLoss MUST be true — the sibling-field contract is enforced at the
// route boundary (PUT /api/system/chat-retention) via this refine.
// retentionDays: positive int (days) | null (OFF). null represented as "" in
// CONFIG_DEFAULTS per Pitfall 4 (Record<string,string> cannot hold null).

export const chatRetentionSchema = z
  .object({
    retentionDays: z.number().int().positive().nullable(),
    confirmDataLoss: z.boolean(),
  })
  .refine((data) => data.confirmDataLoss === true, {
    message: "confirmDataLoss must be true to acknowledge data loss",
    path: ["confirmDataLoss"],
  });

type ChatRetentionInput = z.infer<typeof chatRetentionSchema>;