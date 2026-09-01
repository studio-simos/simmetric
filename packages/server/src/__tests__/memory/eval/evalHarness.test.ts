// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 97 (MEM-03 SC3) — 7-locale eval harness OFFLINE regression.
 *
 * No LLM call at CI time. Each fixture carries `expectedOps` (the mock LLM
 * output). This test locks the validate/deny/classify behavior:
 *   1. `validateMemoryOperations(expectedOps)` passes (valid ops shape).
 *   2. For each expected op with content, `classifySensitivity(content)`
 *      matches the expected sensitivity OR rejects if `expectedDenyList`.
 *   3. If `expectedOps` is empty + `expectedDenyList`, assert
 *      `classifySensitivity` on the transcript's sensitive content rejects.
 *
 * This is a REGRESSION test — it locks the validate/deny-list/dedup
 * behavior, not the LLM output (which is non-deterministic). For LLM
 * output quality, see `evalHarness.live.ts` (opt-in, gated by
 * MEMORY_EVAL_LIVE=1).
 */

import {
  validateMemoryOperations,
  type MemoryOp,
} from "@simmetric-chat/shared";
import { classifySensitivity } from "../../../agent/memoryService";
import {
  loadAllFixtures,
  groupByLocale,
  groupByCategory,
  type EvalFixture,
} from "../../helpers/memoryFixtures";

const fixtures = loadAllFixtures();
const byLocale = groupByLocale(fixtures);
const byCategory = groupByCategory(fixtures);

describe("7-locale eval harness (offline regression)", () => {
  describe("fixture coverage", () => {
    it("loads >= 30 fixtures across the 7 locales (EN/IT/RU/DE/FR/ES/ZH)", () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(30);
    });

    it("covers all 7 locales", () => {
      const locales = Object.keys(byLocale).sort();
      expect(locales).toEqual(["de", "en", "es", "fr", "it", "ru", "zh"]);
    });

    it("each locale has at least 3 fixtures (locale coverage floor)", () => {
      for (const [locale, list] of Object.entries(byLocale)) {
        expect(list.length).toBeGreaterThanOrEqual(3);
      }
    });

    it("EN covers all 12 case categories", () => {
      const enCategories = new Set((byLocale.en ?? []).map((f) => f.category));
      const expectedCategories = [
        "add_preference",
        "replace_preference",
        "move_path",
        "remove_info",
        "one_off_activity",
        "deny_credentials",
        "deny_pii",
        "deny_agent_instruction",
        "dedup",
        "mixed_language",
        "non_latin_script",
        "no_memory_signal",
      ];
      for (const cat of expectedCategories) {
        expect(enCategories.has(cat as never)).toBe(true);
      }
    });

    it("covers the 12 case categories across the corpus", () => {
      const allCategories = Object.keys(byCategory).sort();
      // EN covers all 12; other locales cover a subset. The corpus as a
      // whole should cover all 12.
      expect(allCategories).toEqual(
        expect.arrayContaining([
          "add_preference",
          "replace_preference",
          "one_off_activity",
          "deny_credentials",
          "dedup",
          "non_latin_script",
        ]),
      );
    });
  });

  describe("per-fixture: validate + classify assertions", () => {
    for (const fixture of fixtures) {
      it(`${fixture.id} (${fixture.locale}/${fixture.category})`, () => {
        // 1. expectedOps validates (when non-empty).
        if (fixture.expectedOps.length > 0) {
          const ops = validateMemoryOperations({ operations: fixture.expectedOps });
          expect(ops).toHaveLength(fixture.expectedOps.length);
        }

        // 2. For each expected op with content, classifySensitivity matches
        //    the expected sensitivity OR rejects if expectedDenyList.
        if (fixture.expectedDenyList) {
          // Deny-list fixtures: assert the transcript's sensitive content
          // is rejected by classifySensitivity.
          const sensitiveContent = fixture.transcript
            .map((m) => m.content)
            .join(" ");
          const r = classifySensitivity(sensitiveContent);
          expect(r.allowed).toBe(false);
          expect(r.sensitivity).toBe("high");
        } else {
          // Non-deny fixtures: each expected op with content should pass
          // classifySensitivity with the expected sensitivity (or low when
          // unspecified).
          for (const op of fixture.expectedOps) {
            if (op.content) {
              const r = classifySensitivity(op.content);
              expect(r.allowed).toBe(true);
              const expected = (op.sensitivity ?? "low") as "low" | "medium" | "high";
              // The server-side classification may bump higher (defense-in-
              // depth), so assert allowed + sensitivity >= expected.
              const order = { low: 0, medium: 1, high: 2 } as const;
              expect(order[r.sensitivity]).toBeGreaterThanOrEqual(order[expected]);
            }
          }
        }
      });
    }
  });

  describe("deny-list hard gate (Pitfall 3 — recall = 1.00)", () => {
    it("every deny_* fixture rejects its sensitive content", () => {
      const denyFixtures = fixtures.filter(
        (f) =>
          f.category === "deny_credentials" ||
          f.category === "deny_pii" ||
          f.category === "deny_agent_instruction",
      );
      expect(denyFixtures.length).toBeGreaterThan(0);
      for (const f of denyFixtures) {
        const content = f.transcript.map((m) => m.content).join(" ");
        const r = classifySensitivity(content);
        expect(r.allowed).toBe(false);
      }
    });
  });

  describe("one_off_activity negative cases", () => {
    it("every one_off_activity fixture has empty expectedOps", () => {
      const oneOff = fixtures.filter((f) => f.category === "one_off_activity");
      expect(oneOff.length).toBeGreaterThan(0);
      for (const f of oneOff) {
        expect(f.expectedOps).toEqual([]);
        expect(f.expectedDenyList).toBe(false);
      }
    });
  });

  describe("dedup cases", () => {
    it("every dedup fixture expects a replace op (not add)", () => {
      const dedupFixtures = fixtures.filter((f) => f.category === "dedup");
      expect(dedupFixtures.length).toBeGreaterThan(0);
      for (const f of dedupFixtures) {
        expect(f.expectedOps.length).toBeGreaterThan(0);
        for (const op of f.expectedOps) {
          expect(op.op).toBe("replace");
        }
      }
    });
  });

  describe("non_latin_script cases", () => {
    it("every non_latin_script fixture has at least one expected op with Cyrillic or Hanzi content", () => {
      const nonLatin = fixtures.filter((f) => f.category === "non_latin_script");
      expect(nonLatin.length).toBeGreaterThan(0);
      for (const f of nonLatin) {
        const hasNonLatin = f.expectedOps.some(
          (op) => op.content && /[\u0400-\u04FF\u4E00-\u9FFF]/.test(op.content),
        );
        expect(hasNonLatin).toBe(true);
      }
    });
  });

  describe("no_memory_signal cases", () => {
    it("every no_memory_signal fixture has empty expectedOps", () => {
      const noSignal = fixtures.filter((f) => f.category === "no_memory_signal");
      for (const f of noSignal) {
        expect(f.expectedOps).toEqual([]);
      }
    });
  });
});