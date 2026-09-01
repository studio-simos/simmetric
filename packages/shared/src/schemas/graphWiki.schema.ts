// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Phase 153 (WIKI-01) — graph-wiki trigger request schema =====
//
// Dedicated Zod schema for the POST /api/synthesis/trigger-graph-wiki
// endpoint (Plan 153-02 Task 2). The shape mirrors `synthesisTriggerSchema`
// ({ archiveId: UUID }) but is a separate schema for the separate endpoint
// so the two trigger paths (LLM synthesis vs. graph-wiki generation) can
// diverge later without coupling (D-01 — extend the synthesis infrastructure
// additively; a graph-wiki run is a separate, no-LLM pipeline per A2).
//
// Per shared AGENTS.md: zero runtime deps beyond zod; handlers validate
// with `safeParse` (not `parse`) so bad input returns 400, never 500.

export const graphWikiTriggerSchema = z.object({
  archiveId: z.string().uuid("Invalid archive ID"),
});
type GraphWikiTriggerInput = z.infer<typeof graphWikiTriggerSchema>;