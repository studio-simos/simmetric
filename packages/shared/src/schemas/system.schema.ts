// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

export const initializeSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(100),
  email: z.string().email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
  config: z
    .object({
      LLM_PROVIDER: z.enum(["ollama", "openai", "anthropic", "openrouter"]).optional(),
      LLM_MODEL: z.string().optional(),
      LLM_API_KEY: z.string().optional(),
      LLM_API_BASE_URL: z.string().optional(),
      OLLAMA_BASE_URL: z.string().optional(),
      EMBEDDING_PROVIDER: z.enum(["local", "openai", "ollama"]).optional(),
      EMBEDDING_MODEL: z.string().optional(),
      // D-08 (Phase 91-01): widened additively with "pgvector" (Rule 3).
      // Optional: this schema drives the setup wizard; default remains "lancedb"
      // in CONFIG_DEFAULTS (packages/shared/src/constants/permissions.ts).
      VECTOR_DB_PROVIDER: z.enum(["lancedb", "qdrant", "pgvector", "chroma"]).optional(),
      VECTOR_DB_URL: z.string().optional(),
    })
    .optional(),
});

export type InitializeInput = z.infer<typeof initializeSchema>;