// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 176 (CF-01/D-01): guard tests for the shared env schema.
 *
 * Pins the provider enum values (additive widening only), the default
 * survival on each schema, the Zod 4 unwrap idiom for defaulted fields
 * (research Pitfall 2: bare `.options` is undefined on a ZodDefault —
 * unwrap via `.def.innerType.options`), the twice-imported module
 * identity (CF-01 idempotency), module purity (CF-01 concurrency), and
 * composition survival inside a z.object (research Pattern 1).
 */
import {
  EMBEDDING_PROVIDERS,
  VECTOR_DB_PROVIDERS,
  embeddingProviderSchema,
  vectorDbProviderSchema,
  ollamaKeepAliveSchema,
} from "../schemas/env.schema";
import { z } from "zod";

describe("env.schema (Phase 176 CF-01)", () => {
  it("pins provider enum values in exact order (additive widening only)", () => {
    expect([...EMBEDDING_PROVIDERS]).toEqual([
      "local",
      "openai",
      "ollama",
      "hf-local",
    ]);
    expect([...VECTOR_DB_PROVIDERS]).toEqual([
      "lancedb",
      "qdrant",
      "pgvector",
      "chroma",
    ]);
  });

  it("survives defaults (parse(undefined) → default)", () => {
    expect(embeddingProviderSchema.parse(undefined)).toBe("local");
    expect(vectorDbProviderSchema.parse(undefined)).toBe("lancedb");
    expect(ollamaKeepAliveSchema.parse(undefined)).toBe("10m");
  });

  it("unwraps Zod 4 default wrapper via .def.innerType.options (Pitfall 2)", () => {
    expect(embeddingProviderSchema.def.innerType.options).toEqual([
      "local",
      "openai",
      "ollama",
      "hf-local",
    ]);
    expect(vectorDbProviderSchema.def.innerType.options).toEqual([
      "lancedb",
      "qdrant",
      "pgvector",
      "chroma",
    ]);
  });

  it("rejects a value outside the enum", () => {
    expect(
      embeddingProviderSchema.safeParse("bogus").success,
    ).toBe(false);
    expect(vectorDbProviderSchema.safeParse("bogus").success).toBe(false);
  });

  it("is twice-imported identical (module cache idempotency, CF-01)", async () => {
    // Two separate require() calls from the same jest module registry hit
    // the require cache, so identity holds; the dynamic import() in a fresh
    // jest.isolateModules context still resolves to the compile-time module
    // through the CJS interop of the same file on disk.
    const required = require("../schemas/env.schema");
    expect(required.embeddingProviderSchema).toBe(embeddingProviderSchema);
    expect(required.vectorDbProviderSchema).toBe(vectorDbProviderSchema);
    expect(required.ollamaKeepAliveSchema).toBe(ollamaKeepAliveSchema);

    const dynamic = await import("../schemas/env.schema");
    expect(dynamic.embeddingProviderSchema).toBe(embeddingProviderSchema);
    expect(dynamic.vectorDbProviderSchema).toBe(vectorDbProviderSchema);
    expect(dynamic.ollamaKeepAliveSchema).toBe(ollamaKeepAliveSchema);
  });

  it("is a pure data module (no IO, no side effects — CF-01 concurrency)", async () => {
    // Requiring the module must not throw, and all five value exports must
    // be defined. Module init performs no IO (no dotenv, no fs, no node
    // builtins — shared zero-dep rule), so import completion IS the purity
    // probe.
    const mod = await import("../schemas/env.schema");
    expect(mod.EMBEDDING_PROVIDERS).toBeDefined();
    expect(mod.VECTOR_DB_PROVIDERS).toBeDefined();
    expect(mod.embeddingProviderSchema).toBeDefined();
    expect(mod.vectorDbProviderSchema).toBeDefined();
    expect(mod.ollamaKeepAliveSchema).toBeDefined();
  });

  it("survives composition into a z.object (defaults intact — Pattern 1)", () => {
    const composed = z.object({
      EMBEDDING_PROVIDER: embeddingProviderSchema,
      VECTOR_DB_PROVIDER: vectorDbProviderSchema,
      OLLAMA_KEEP_ALIVE: ollamaKeepAliveSchema,
    });
    expect(composed.parse({})).toEqual({
      EMBEDDING_PROVIDER: "local",
      VECTOR_DB_PROVIDER: "lancedb",
      OLLAMA_KEEP_ALIVE: "10m",
    });
    // Identity preserved through composition — the composed shape reuses the
    // shared field objects (cheap extension-site guarantee).
    expect(composed.shape.EMBEDDING_PROVIDER).toBe(embeddingProviderSchema);
    expect(composed.shape.VECTOR_DB_PROVIDER).toBe(vectorDbProviderSchema);
    expect(composed.shape.OLLAMA_KEEP_ALIVE).toBe(ollamaKeepAliveSchema);
  });
});