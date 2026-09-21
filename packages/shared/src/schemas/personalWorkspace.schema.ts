// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Personal Workspace Schema (Phase 189, WSIS-01 D-05) =====

/**
 * Phase 189 (D-05): body for POST /api/users/me/personal-workspace — the
 * guided empty-state wizard supplies the workspace name; the personal
 * project is created server-side (isPersonal: true, D-02).
 */
export const createPersonalWorkspaceSchema = z.object({
  workspaceName: z.string().min(1).max(100),
});

export type CreatePersonalWorkspaceInput = z.infer<typeof createPersonalWorkspaceSchema>;