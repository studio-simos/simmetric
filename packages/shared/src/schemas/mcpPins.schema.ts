// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// --- Chat ID Param Schema ---

export const chatIdParamSchema = z.object({
  chatId: z.string().uuid("Invalid chat ID"),
});
type ChatIdParam = z.infer<typeof chatIdParamSchema>;

// --- Create Pin Schema (MCP-07, per D-10) ---

export const createMcpPinSchema = z.object({
  connectionId: z.string().uuid("Invalid connection ID"),
});
type CreateMcpPinInput = z.infer<typeof createMcpPinSchema>;

// --- Pin ID Param Schema (MCP-07, per D-10) ---

export const mcpPinIdParamSchema = z.object({
  pinId: z.string().uuid("Invalid pin ID"),
});
type McpPinIdParam = z.infer<typeof mcpPinIdParamSchema>;
