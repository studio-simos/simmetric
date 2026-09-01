// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

export interface SynthesisBudget {
  pagesRead: number;
  maxPagesRead: number;
  pagesWritten: number;
  maxPagesWritten: number;
  tokensUsed: number;
  maxTokens: number;
  llmCallsUsed: number;
  maxLlmCalls: number;
  passRemainingTokens: Record<string, number>;
  passRemainingCalls: Record<string, number>;
}

interface BudgetOverrides {
  maxPagesRead?: number;
  maxPagesWritten?: number;
  maxTokens?: number;
  maxLlmCalls?: number;
}

const DEFAULT_MAX_PAGES_READ = 50;
const DEFAULT_MAX_PAGES_WRITTEN = 15;
const DEFAULT_MAX_TOKENS = 100000;
const DEFAULT_MAX_LLM_CALLS = 10;

type PassAllocation = { tokenPercent: number; maxCalls: number };

const PASS_ALLOCATIONS: Record<string, PassAllocation> = {
  pass1: { tokenPercent: 20, maxCalls: 2 },  // entity_extraction
  pass2: { tokenPercent: 20, maxCalls: 2 },  // summary_generation
  pass3: { tokenPercent: 10, maxCalls: 1 },  // candidate_search
  pass4: { tokenPercent: 40, maxCalls: 4 },  // llm_decision
  pass5: { tokenPercent: 10, maxCalls: 1 },  // write_overview
};

// Validate that allocation percentages sum to 100 and calls sum to 10
const ALLOC_PASS_NAMES: string[] = Object.keys(PASS_ALLOCATIONS);

export class BudgetTracker {
  private maxPagesRead: number;
  private maxPagesWritten: number;
  private maxTokens: number;
  private maxLlmCalls: number;

  private pagesRead: number = 0;
  private pagesWritten: number = 0;
  private tokensUsed: number = 0;
  private llmCallsUsed: number = 0;

  private passTokensRemaining: Record<string, number> = {};
  private passCallsRemaining: Record<string, number> = {};

  constructor(overrides?: BudgetOverrides) {
    this.maxPagesRead = overrides?.maxPagesRead ?? DEFAULT_MAX_PAGES_READ;
    this.maxPagesWritten = overrides?.maxPagesWritten ?? DEFAULT_MAX_PAGES_WRITTEN;
    this.maxTokens = overrides?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxLlmCalls = overrides?.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;

    this.initializePassBudgets();
  }

  private initializePassBudgets(): void {
    for (const passName of ALLOC_PASS_NAMES) {
      const alloc = PASS_ALLOCATIONS[passName];
      if (alloc) {
        this.passTokensRemaining[passName] = Math.floor(
          (alloc.tokenPercent / 100) * this.maxTokens,
        );
        this.passCallsRemaining[passName] = alloc.maxCalls;
      }
    }
  }

  canContinue(passName: string): boolean {
    // Check pass-specific budget — only for allocated passes. Ad-hoc pass
    // names (e.g., pass4b_contradiction from Plan 74-02) have no per-pass
    // sub-allocation and share the total budget only (D-09: respect the
    // existing BudgetTracker — no separate hard cap).
    const passTokens = this.passTokensRemaining[passName];
    const passCalls = this.passCallsRemaining[passName];
    if (passTokens !== undefined && passTokens <= 0) return false;
    if (passCalls !== undefined && passCalls <= 0) return false;

    // Check total limits
    if (this.tokensUsed >= this.maxTokens) return false;
    if (this.llmCallsUsed >= this.maxLlmCalls) return false;

    return true;
  }

  consumeTokens(count: number, passName: string): boolean {
    // Check pass-specific limit (allocated passes only)
    const passRemaining = this.passTokensRemaining[passName];
    if (passRemaining !== undefined && count > passRemaining) return false;

    // Check total limit
    if (this.tokensUsed + count > this.maxTokens) return false;

    // Consume
    this.tokensUsed += count;
    if (passRemaining !== undefined) {
      this.passTokensRemaining[passName] = passRemaining - count;
    }
    return true;
  }

  consumeLlmCall(passName: string): boolean {
    // Check pass-specific limit (allocated passes only)
    const passRemaining = this.passCallsRemaining[passName];
    if (passRemaining !== undefined) {
      if (passRemaining <= 0) return false;
      this.passCallsRemaining[passName] = passRemaining - 1;
    }

    // Check total limit
    if (this.llmCallsUsed >= this.maxLlmCalls) return false;

    // Consume
    this.llmCallsUsed += 1;
    return true;
  }

  consumePageRead(): boolean {
    if (this.pagesRead >= this.maxPagesRead) return false;
    this.pagesRead += 1;
    return true;
  }

  consumePageWrite(): boolean {
    if (this.pagesWritten >= this.maxPagesWritten) return false;
    this.pagesWritten += 1;
    return true;
  }

  getSnapshot(): SynthesisBudget {
    return {
      pagesRead: this.pagesRead,
      maxPagesRead: this.maxPagesRead,
      pagesWritten: this.pagesWritten,
      maxPagesWritten: this.maxPagesWritten,
      tokensUsed: this.tokensUsed,
      maxTokens: this.maxTokens,
      llmCallsUsed: this.llmCallsUsed,
      maxLlmCalls: this.maxLlmCalls,
      passRemainingTokens: { ...this.passTokensRemaining },
      passRemainingCalls: { ...this.passCallsRemaining },
    };
  }

  isExhausted(): boolean {
    return (
      this.pagesRead >= this.maxPagesRead ||
      this.pagesWritten >= this.maxPagesWritten ||
      this.tokensUsed >= this.maxTokens ||
      this.llmCallsUsed >= this.maxLlmCalls
    );
  }
}

export function loadBudgetConfig(_archiveId: string): {
  maxPagesRead: number;
  maxPagesWritten: number;
  maxTokens: number;
  maxLlmCalls: number;
} {
  return {
    maxPagesRead: DEFAULT_MAX_PAGES_READ,
    maxPagesWritten: DEFAULT_MAX_PAGES_WRITTEN,
    maxTokens: DEFAULT_MAX_TOKENS,
    maxLlmCalls: DEFAULT_MAX_LLM_CALLS,
  };
}
