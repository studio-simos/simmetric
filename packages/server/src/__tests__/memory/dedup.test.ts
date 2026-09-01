// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { dedupRewrite } from "../../agent/memoryService";
import type { MemoryOp } from "@simmetric-chat/shared";

const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";

describe("dedupRewrite (MEM-03 cosine ≥0.92 + path-level dedup)", () => {
  const baseAdd: MemoryOp = {
    op: "add",
    type: "user",
    path: "preferences.theme",
    content: "prefers dark mode",
    sensitivity: "low",
  };

  it("rewrites add → replace when an existing memory has the SAME path (path-level @@unique collision)", () => {
    const existing = [
      { id: UUID_A, content: "prefers light mode", path: "preferences.theme", similarity: 0.3 },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.92,
    });
    expect(out.op).toBe("replace");
    if (out.op === "replace") expect(out.id).toBe(UUID_A);
  });

  it("rewrites add → replace when an existing memory has cosine ≥ threshold (semantic dedup) even with a DIFFERENT path", () => {
    const existing = [
      {
        id: UUID_B,
        content: "user likes dark themes",
        path: "appearance.color",
        similarity: 0.95,
      },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.92,
    });
    expect(out.op).toBe("replace");
    if (out.op === "replace") expect(out.id).toBe(UUID_B);
  });

  it("keeps add when no near-duplicate AND no path collision", () => {
    const existing = [
      { id: UUID_A, content: "likes italian food", path: "preferences.cuisine", similarity: 0.4 },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.92,
    });
    expect(out.op).toBe("add");
  });

  it("keeps add when cosine is just below the threshold (boundary)", () => {
    const existing = [
      { id: UUID_A, content: "similar but distinct", path: "other.path", similarity: 0.91 },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.92,
    });
    expect(out.op).toBe("add");
  });

  it("rewrites add → replace when cosine exactly equals the threshold (≥ check)", () => {
    const existing = [
      { id: UUID_A, content: "near-dup", path: "other.path", similarity: 0.92 },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.92,
    });
    expect(out.op).toBe("replace");
    if (out.op === "replace") expect(out.id).toBe(UUID_A);
  });

  it("picks the HIGHEST-similarity match when multiple existing memories cross the threshold", () => {
    const existing = [
      { id: UUID_A, content: "low match", path: "p1", similarity: 0.93 },
      { id: UUID_B, content: "better match", path: "p2", similarity: 0.97 },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.92,
    });
    expect(out.op).toBe("replace");
    if (out.op === "replace") expect(out.id).toBe(UUID_B);
  });

  it("path-level collision takes precedence over cosine (returns the path-match id, not the cosine-match id)", () => {
    const existing = [
      { id: UUID_A, content: "different content", path: "preferences.theme", similarity: 0.3 },
      { id: UUID_B, content: "near-dup content", path: "other.path", similarity: 0.95 },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.92,
    });
    expect(out.op).toBe("replace");
    if (out.op === "replace") expect(out.id).toBe(UUID_A);
  });

  it("leaves replace ops unchanged (already carries an id)", () => {
    const replace: MemoryOp = {
      op: "replace",
      id: UUID_A,
      path: "p",
      content: "x",
    };
    const out = dedupRewrite({
      op: replace,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: [],
      threshold: 0.92,
    });
    expect(out).toBe(replace);
  });

  it("leaves move ops unchanged", () => {
    const move: MemoryOp = { op: "move", id: UUID_A, path: "new.path" };
    const out = dedupRewrite({
      op: move,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: [],
      threshold: 0.92,
    });
    expect(out).toBe(move);
  });

  it("leaves remove ops unchanged", () => {
    const remove: MemoryOp = { op: "remove", id: UUID_A };
    const out = dedupRewrite({
      op: remove,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: [],
      threshold: 0.92,
    });
    expect(out).toBe(remove);
  });

  it("keeps add when the add op has a null path and there is no cosine match", () => {
    const nullPathAdd: MemoryOp = { op: "add", type: "context", path: null, content: "x", sensitivity: "low" };
    const out = dedupRewrite({
      op: nullPathAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: [{ id: UUID_A, content: "y", path: "p", similarity: 0.2 }],
      threshold: 0.92,
    });
    expect(out.op).toBe("add");
  });

  it("handles empty existingMemories (no dedup possible)", () => {
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: [],
      threshold: 0.92,
    });
    expect(out.op).toBe("add");
  });

  it("preserves the op's type/path/content/sensitivity when rewriting add → replace", () => {
    const existing = [
      { id: UUID_A, content: "prefers light", path: "preferences.theme", similarity: 0.95 },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.92,
    });
    expect(out).toMatchObject({
      op: "replace",
      id: UUID_A,
      type: "user",
      path: "preferences.theme",
      content: "prefers dark mode",
      sensitivity: "low",
    });
  });

  it("respects a custom threshold (0.85)", () => {
    const existing = [
      { id: UUID_A, content: "near-dup", path: "other", similarity: 0.87 },
    ];
    const out = dedupRewrite({
      op: baseAdd,
      userId: "u1",
      workspaceId: "w1",
      existingMemories: existing,
      threshold: 0.85,
    });
    expect(out.op).toBe("replace");
  });
});