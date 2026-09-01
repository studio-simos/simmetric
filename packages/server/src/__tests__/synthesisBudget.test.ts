// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  BudgetTracker,
  SynthesisBudget,
  loadBudgetConfig,
} from "../services/synthesisBudgetService";

describe("BudgetTracker", () => {
  describe("initialization", () => {
    it("initializes with default max limits and per-pass allocation percentages", () => {
      const tracker = new BudgetTracker();
      const snapshot = tracker.getSnapshot();

      // Default max limits
      expect(snapshot.maxPagesRead).toBe(50);
      expect(snapshot.maxPagesWritten).toBe(15);
      expect(snapshot.maxTokens).toBe(100000);
      expect(snapshot.maxLlmCalls).toBe(10);

      // All counters start at 0
      expect(snapshot.pagesRead).toBe(0);
      expect(snapshot.pagesWritten).toBe(0);
      expect(snapshot.tokensUsed).toBe(0);
      expect(snapshot.llmCallsUsed).toBe(0);
    });

    it("accepts optional overrides for max values", () => {
      const tracker = new BudgetTracker({
        maxPagesRead: 30,
        maxPagesWritten: 10,
        maxTokens: 50000,
        maxLlmCalls: 5,
      });
      const snapshot = tracker.getSnapshot();

      expect(snapshot.maxPagesRead).toBe(30);
      expect(snapshot.maxPagesWritten).toBe(10);
      expect(snapshot.maxTokens).toBe(50000);
      expect(snapshot.maxLlmCalls).toBe(5);
    });
  });

  describe("canContinue", () => {
    it("returns true when all limits are within budget", () => {
      const tracker = new BudgetTracker();
      // Pass 1 has 20% of 100000 = 20000 tokens, 2 calls
      expect(tracker.canContinue("pass1")).toBe(true);
    });

    it("returns false when pass token budget is exhausted", () => {
      const tracker = new BudgetTracker({ maxTokens: 100 });
      // Pass 1 has 20% of 100 = 20 tokens
      tracker.consumeTokens(20, "pass1");
      expect(tracker.canContinue("pass1")).toBe(false);
    });

    it("returns false when total token budget is exhausted", () => {
      const tracker = new BudgetTracker({ maxTokens: 100 });
      // Consume all tokens respecting per-pass allocations
      tracker.consumeTokens(40, "pass4"); // pass4: 40%, total: 40
      tracker.consumeTokens(20, "pass1"); // pass1: 20%, total: 60
      tracker.consumeTokens(20, "pass2"); // pass2: 20%, total: 80
      tracker.consumeTokens(10, "pass3"); // pass3: 10%, total: 90
      tracker.consumeTokens(10, "pass5"); // pass5: 10%, total: 100
      expect(tracker.canContinue("pass3")).toBe(false);
    });

    it("returns false when pass LLM call limit is reached", () => {
      const tracker = new BudgetTracker();
      // Pass 4 has 4 LLM calls
      tracker.consumeLlmCall("pass4");
      tracker.consumeLlmCall("pass4");
      tracker.consumeLlmCall("pass4");
      tracker.consumeLlmCall("pass4");
      expect(tracker.canContinue("pass4")).toBe(false);
    });
  });

  describe("consumeTokens", () => {
    it("decrements pass remaining tokens and total tokens; returns true on success", () => {
      const tracker = new BudgetTracker();
      const result = tracker.consumeTokens(500, "pass1");

      expect(result).toBe(true);
      const snapshot = tracker.getSnapshot();
      expect(snapshot.tokensUsed).toBe(500);
      // Pass 1: 20% of 100000 = 20000, remaining = 19500
      expect(snapshot.passRemainingTokens["pass1"]).toBe(19500);
    });

    it("returns false when pass budget is exceeded even if total budget has room", () => {
      const tracker = new BudgetTracker();
      // Pass 3 has 10% of 100000 = 10000 tokens
      const result = tracker.consumeTokens(10001, "pass3");
      expect(result).toBe(false);
    });

    it("returns false when total budget is exceeded", () => {
      const tracker = new BudgetTracker({ maxTokens: 1000 });
      // Consume all tokens respecting per-pass allocations
      tracker.consumeTokens(400, "pass4"); // 400 = 40%, pass4 exhausted
      tracker.consumeTokens(200, "pass1"); // 600 = 20%
      tracker.consumeTokens(200, "pass2"); // 800 = 20%
      tracker.consumeTokens(100, "pass3"); // 900 = 10%
      tracker.consumeTokens(100, "pass5"); // 1000 = 10%, total exhausted
      // Attempt to consume more — total limit should block
      const result = tracker.consumeTokens(1, "pass4");
      expect(result).toBe(false);
    });
  });

  describe("consumeLlmCall", () => {
    it("returns true on first call and increments counters", () => {
      const tracker = new BudgetTracker();
      const result = tracker.consumeLlmCall("pass1");

      expect(result).toBe(true);
      const snapshot = tracker.getSnapshot();
      expect(snapshot.llmCallsUsed).toBe(1);
      // Pass 1: 2 calls max, remaining = 1
      expect(snapshot.passRemainingCalls["pass1"]).toBe(1);
    });

    it("returns false when pass call limit is reached", () => {
      const tracker = new BudgetTracker();
      // Pass 2 has 2 calls max
      tracker.consumeLlmCall("pass2");
      tracker.consumeLlmCall("pass2");
      const result = tracker.consumeLlmCall("pass2");

      expect(result).toBe(false);
    });

    it("returns false when total LLM call limit is reached", () => {
      const tracker = new BudgetTracker({ maxLlmCalls: 2 });
      tracker.consumeLlmCall("pass1");
      tracker.consumeLlmCall("pass2");
      const result = tracker.consumeLlmCall("pass4");

      expect(result).toBe(false);
    });
  });

  describe("consumePageRead", () => {
    it("returns true up to maxPagesRead (50), then false", () => {
      const tracker = new BudgetTracker({ maxPagesRead: 3 });
      expect(tracker.consumePageRead()).toBe(true);
      expect(tracker.consumePageRead()).toBe(true);
      expect(tracker.consumePageRead()).toBe(true);
      expect(tracker.consumePageRead()).toBe(false);
    });
  });

  describe("consumePageWrite", () => {
    it("returns true up to maxPagesWritten (15), then false", () => {
      const tracker = new BudgetTracker({ maxPagesWritten: 3 });
      expect(tracker.consumePageWrite()).toBe(true);
      expect(tracker.consumePageWrite()).toBe(true);
      expect(tracker.consumePageWrite()).toBe(true);
      expect(tracker.consumePageWrite()).toBe(false);
    });
  });

  describe("cumulative tracking", () => {
    it("tracks cumulative counts correctly across multiple passes", () => {
      const tracker = new BudgetTracker();

      // Pass 1: use 2 LLM calls and 10000 tokens
      tracker.consumeLlmCall("pass1");
      tracker.consumeLlmCall("pass1");
      tracker.consumeTokens(10000, "pass1");

      // Pass 2: use 1 LLM call and 5000 tokens
      tracker.consumeLlmCall("pass2");
      tracker.consumeTokens(5000, "pass2");

      const snapshot = tracker.getSnapshot();
      expect(snapshot.llmCallsUsed).toBe(3);
      expect(snapshot.tokensUsed).toBe(15000);
    });
  });

  describe("getSnapshot", () => {
    it("returns current budget state as a SynthesisBudget object with all fields", () => {
      const tracker = new BudgetTracker();
      const snapshot: SynthesisBudget = tracker.getSnapshot();

      expect(snapshot).toHaveProperty("pagesRead");
      expect(snapshot).toHaveProperty("maxPagesRead");
      expect(snapshot).toHaveProperty("pagesWritten");
      expect(snapshot).toHaveProperty("maxPagesWritten");
      expect(snapshot).toHaveProperty("tokensUsed");
      expect(snapshot).toHaveProperty("maxTokens");
      expect(snapshot).toHaveProperty("llmCallsUsed");
      expect(snapshot).toHaveProperty("maxLlmCalls");
      expect(snapshot).toHaveProperty("passRemainingTokens");
      expect(snapshot).toHaveProperty("passRemainingCalls");
    });

    it("reflects consumption state after tokens and calls are used", () => {
      const tracker = new BudgetTracker();
      tracker.consumeTokens(5000, "pass4");
      tracker.consumeLlmCall("pass4");
      tracker.consumePageRead();
      tracker.consumePageWrite();

      const snapshot = tracker.getSnapshot();
      expect(snapshot.tokensUsed).toBe(5000);
      expect(snapshot.llmCallsUsed).toBe(1);
      expect(snapshot.pagesRead).toBe(1);
      expect(snapshot.pagesWritten).toBe(1);
    });
  });

  describe("isExhausted", () => {
    it("returns false when all limits have room", () => {
      const tracker = new BudgetTracker();
      expect(tracker.isExhausted()).toBe(false);
    });

    it("returns true when pagesRead limit reached", () => {
      const tracker = new BudgetTracker({ maxPagesRead: 1 });
      tracker.consumePageRead();
      expect(tracker.isExhausted()).toBe(true);
    });

    it("returns true when pagesWritten limit reached", () => {
      const tracker = new BudgetTracker({ maxPagesWritten: 1 });
      tracker.consumePageWrite();
      expect(tracker.isExhausted()).toBe(true);
    });

    it("returns true when token limit reached", () => {
      const tracker = new BudgetTracker({ maxTokens: 100 });
      tracker.consumeTokens(40, "pass4"); // 40 = 40%
      tracker.consumeTokens(20, "pass1"); // 60 = 20%
      tracker.consumeTokens(20, "pass2"); // 80 = 20%
      tracker.consumeTokens(10, "pass3"); // 90 = 10%
      tracker.consumeTokens(10, "pass5"); // 100 = 10%, total exhausted
      expect(tracker.isExhausted()).toBe(true);
    });

    it("returns true when LLM call limit reached", () => {
      const tracker = new BudgetTracker({ maxLlmCalls: 1 });
      tracker.consumeLlmCall("pass1");
      expect(tracker.isExhausted()).toBe(true);
    });
  });
});

describe("loadBudgetConfig", () => {
  it("returns default budget config for any archive ID", () => {
    const config = loadBudgetConfig("some-archive-id");
    expect(config.maxPagesRead).toBe(50);
    expect(config.maxPagesWritten).toBe(15);
    expect(config.maxTokens).toBe(100000);
    expect(config.maxLlmCalls).toBe(10);
  });
});
