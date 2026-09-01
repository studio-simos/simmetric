// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";
import { parseMetadata } from "../utils/parseMetadata";

describe("parseMetadata", () => {
  // (a) valid JSON object round-trips intact
  it("returns the parsed object for valid JSON object input", () => {
    expect(parseMetadata('{"a":1}')).toEqual({ a: 1 });
  });

  // (b) null / undefined / empty-string each return {}
  it("returns {} for null", () => {
    expect(parseMetadata(null)).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(parseMetadata(undefined)).toEqual({});
  });

  it("returns {} for empty string", () => {
    expect(parseMetadata("")).toEqual({});
  });

  // (c) malformed JSON returns {}
  it("returns {} for malformed JSON", () => {
    expect(parseMetadata("not-json")).toEqual({});
  });

  it("returns {} for a dangling brace", () => {
    expect(parseMetadata("{")).toEqual({});
  });

  // (d) JSON primitives that are not objects return {} (non-object guard)
  it("returns {} for JSON number primitive", () => {
    expect(parseMetadata("5")).toEqual({});
  });

  it("returns {} for JSON boolean primitive", () => {
    expect(parseMetadata("true")).toEqual({});
  });

  it("returns {} for JSON null primitive", () => {
    expect(parseMetadata("null")).toEqual({});
  });

  // (e) JSON arrays return {} (arrays are not Record<string, unknown>)
  it("returns {} for JSON array", () => {
    expect(parseMetadata("[1,2]")).toEqual({});
  });

  // (f) realistic metadata blob with nested tokenUsage round-trips intact
  it("returns a realistic token-usage blob intact", () => {
    const blob = JSON.stringify({
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      model: "ollama/gpt-oss:latest",
      sources: ["doc-1", "doc-2"],
    });
    expect(parseMetadata(blob)).toEqual({
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      model: "ollama/gpt-oss:latest",
      sources: ["doc-1", "doc-2"],
    });
  });

  // realistic chunk-metadata blob (Chunk.metadata site at system.ts:849)
  it("returns a realistic chunk-metadata blob intact", () => {
    const blob = JSON.stringify({ chunkIndex: 3, chunkText: "hello" });
    expect(parseMetadata(blob)).toEqual({ chunkIndex: 3, chunkText: "hello" });
  });
});