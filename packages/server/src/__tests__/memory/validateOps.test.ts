// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  validateMemoryOperations,
  memoryOpsSchema,
} from "@simmetric-chat/shared";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";

describe("validateMemoryOperations (MEM-03 Zod gate)", () => {
  describe("accepts valid ops", () => {
    it("accepts a minimal add op with all required fields", () => {
      const ops = validateMemoryOperations({
        operations: [
          {
            op: "add",
            type: "user",
            path: "preferences.theme",
            content: "prefers dark mode",
            sensitivity: "low",
          },
        ],
      });
      expect(ops).toHaveLength(1);
      expect(ops[0]!.op).toBe("add");
    });

    it("accepts add with default sensitivity when omitted", () => {
      const ops = validateMemoryOperations({
        operations: [
          { op: "add", type: "user", path: "facts.name", content: "x" },
        ],
      });
      expect(ops[0]!).toMatchObject({ op: "add", sensitivity: "low" });
    });

    it("accepts add with null path (context memories may have no path)", () => {
      const ops = validateMemoryOperations({
        operations: [
          { op: "add", type: "context", path: null, content: "no path" },
        ],
      });
      expect(ops[0]!.op).toBe("add");
    });

    it("accepts a replace op with uuid + content", () => {
      const ops = validateMemoryOperations({
        operations: [
          { op: "replace", id: VALID_UUID, path: "p", content: "new" },
        ],
      });
      expect(ops[0]!.op).toBe("replace");
    });

    it("accepts a move op with uuid + path", () => {
      const ops = validateMemoryOperations({
        operations: [{ op: "move", id: VALID_UUID, path: "new.path" }],
      });
      expect(ops[0]!.op).toBe("move");
    });

    it("accepts a remove op with uuid", () => {
      const ops = validateMemoryOperations({
        operations: [{ op: "remove", id: VALID_UUID }],
      });
      expect(ops[0]!.op).toBe("remove");
    });

    it("accepts an empty operations array (LLM signals 'nothing to remember')", () => {
      const ops = validateMemoryOperations({ operations: [] });
      expect(ops).toEqual([]);
    });
  });

  describe("rejects invalid ops", () => {
    it("rejects an add op with empty content", () => {
      expect(() =>
        validateMemoryOperations({
          operations: [{ op: "add", type: "user", path: "p", content: "" }],
        }),
      ).toThrow(/Invalid memory operations/);
    });

    it("rejects an add op missing the type field", () => {
      expect(() =>
        validateMemoryOperations({
          operations: [{ op: "add", path: "p", content: "x" }],
        }),
      ).toThrow(/Invalid memory operations/);
    });

    it("rejects a replace op missing the id field", () => {
      expect(() =>
        validateMemoryOperations({
          operations: [{ op: "replace", path: "p", content: "x" }],
        }),
      ).toThrow(/Invalid memory operations/);
    });

    it("rejects a replace op with a non-uuid id", () => {
      expect(() =>
        validateMemoryOperations({
          operations: [{ op: "replace", id: "not-a-uuid", content: "x" }],
        }),
      ).toThrow(/Invalid memory operations/);
    });

    it("rejects a move op missing the id field", () => {
      expect(() =>
        validateMemoryOperations({
          operations: [{ op: "move", path: "p" }],
        }),
      ).toThrow(/Invalid memory operations/);
    });

    it("rejects a remove op missing the id field", () => {
      expect(() =>
        validateMemoryOperations({
          operations: [{ op: "remove" }],
        }),
      ).toThrow(/Invalid memory operations/);
    });

    it("rejects an add op with an invalid dotted path", () => {
      expect(() =>
        validateMemoryOperations({
          operations: [
            { op: "add", type: "user", path: "..invalid", content: "x" },
          ],
        }),
      ).toThrow(/Invalid memory operations/);
    });

    it("rejects more than 50 ops in one turn (DoS guard)", () => {
      const ops = Array.from({ length: 51 }, () => ({
        op: "remove" as const,
        id: VALID_UUID,
      }));
      expect(() => validateMemoryOperations({ operations: ops })).toThrow(
        /Invalid memory operations/,
      );
    });

    it("rejects an unknown op discriminator", () => {
      expect(() =>
        validateMemoryOperations({
          operations: [{ op: "noop", content: "x" } as unknown as never],
        }),
      ).toThrow(/Invalid memory operations/);
    });

    it("rejects a non-object input", () => {
      expect(() => validateMemoryOperations("not-json")).toThrow(
        /Invalid memory operations/,
      );
      expect(() => validateMemoryOperations(42)).toThrow(/Invalid memory operations/);
      expect(() => validateMemoryOperations(null)).toThrow(/Invalid memory operations/);
      expect(() => validateMemoryOperations(undefined)).toThrow(
        /Invalid memory operations/,
      );
    });
  });

  describe("LLM output quirks (fallbacks)", () => {
    it("strips markdown ```json fences and parses the inner JSON object", () => {
      const wrapped = '```json\n{"operations":[{"op":"add","type":"user","path":"p","content":"x"}]}\n```';
      const ops = validateMemoryOperations(wrapped);
      expect(ops).toHaveLength(1);
      expect(ops[0]!.op).toBe("add");
    });

    it("strips markdown fences without the json language tag", () => {
      const wrapped = '```\n{"operations":[{"op":"add","type":"user","path":"p","content":"x"}]}\n```';
      const ops = validateMemoryOperations(wrapped);
      expect(ops).toHaveLength(1);
      expect(ops[0]!.op).toBe("add");
    });

    it("wraps a bare array (LLM returned array not {operations:[]}) into the strict shape", () => {
      const bare = [
        { op: "add", type: "user", path: "p", content: "x" },
      ];
      const ops = validateMemoryOperations(bare);
      expect(ops).toHaveLength(1);
      expect(ops[0]!.op).toBe("add");
    });

    it("wraps a bare array inside markdown fences", () => {
      const wrapped = '```json\n[{"op":"add","type":"user","path":"p","content":"x"}]\n```';
      const ops = validateMemoryOperations(wrapped);
      expect(ops).toHaveLength(1);
      expect(ops[0]!.op).toBe("add");
    });

    it("still rejects a string that is not valid JSON after fence stripping", () => {
      const garbage = "```json\nnot json at all\n```";
      expect(() => validateMemoryOperations(garbage)).toThrow(
        /Invalid memory operations/,
      );
    });
  });

  describe("memoryOpsSchema direct usage", () => {
    it("exports the underlying Zod schema for callers that want safeParse", () => {
      const result = memoryOpsSchema.safeParse({
        operations: [{ op: "remove", id: VALID_UUID }],
      });
      expect(result.success).toBe(true);
    });
  });
});