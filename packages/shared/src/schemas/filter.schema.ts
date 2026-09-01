// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 100 (PLG-01 D-04) — Filter plugin admin API request schema.
 *
 * `updateFilterSchema` validates the body of `PATCH /api/filters/:name`.
 * The single boolean `enabled` field upserts SystemConfig key
 * `filter_<name>_enabled` (written directly via prisma.systemConfig.upsert,
 * NOT via updateSettings — Pitfall 6: dynamic keys are not in
 * configKeySchema). No POST or DELETE routes exist (D-04: filesystem-only
 * plugin discovery, no upload, no API-side deletion).
 */
import { z } from "zod";

export const updateFilterSchema = z.object({
  enabled: z.boolean(),
});

type UpdateFilterInput = z.infer<typeof updateFilterSchema>;