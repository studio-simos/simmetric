// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Plan-mode parsing helpers — extracted from orchestrator.ts so they can be
 * unit-tested in isolation (the orchestrator module pulls in Prisma/env and
 * is unsuitable for pure-parser tests).
 *
 * No heavy imports here: only the shared AgentPlan type.
 */
import type { AgentPlan } from "@simmetric-chat/shared";

/**
 * Parse the LLM planning output into an AgentPlan. Strategy:
 *  1. Try to locate a JSON object in the raw text (handles ```json fences
 *     and leading/trailing prose) and validate the shape.
 *  2. If no clean JSON but there is raw text, wrap it as a single-step
 *     plan (per the "JSON piano malformato" fallback in the design spec).
 *  3. Return null only when there is nothing usable, so the caller falls
 *     back to direct execution.
 */
export function parsePlan(raw: string): AgentPlan | null {
  if (!raw || !raw.trim()) return null;

  // Attempt 1: extract the first {...} block.
  const jsonText = extractJsonObject(raw);
  if (jsonText) {
    try {
      const obj = JSON.parse(jsonText) as unknown;
      if (obj && typeof obj === "object") {
        const o = obj as Record<string, unknown>;
        const goal = typeof o.goal === "string" ? o.goal.trim() : "";
        const stepsRaw = Array.isArray(o.steps) ? o.steps : [];
        const steps: AgentPlan["steps"] = [];
        stepsRaw.slice(0, 5).forEach((s) => {
          if (s && typeof s === "object") {
            const step = s as Record<string, unknown>;
            const action = typeof step.action === "string" ? step.action : "";
            const tool = typeof step.tool === "string" ? step.tool : null;
            if (action) steps.push({ step: steps.length + 1, action, tool });
          }
        });
        if (goal && steps.length > 0) {
          return { goal: goal.slice(0, 1000), steps };
        }
      }
    } catch {
      // Fall through to raw-text wrap.
    }
  }

  // Attempt 2: wrap the raw text as a single-step plan.
  const text = raw.trim().slice(0, 500);
  if (text) {
    return {
      goal: raw.trim().slice(0, 200),
      steps: [{ step: 1, action: text, tool: null }],
    };
  }
  return null;
}

/** Extract the first balanced top-level JSON object from a string. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — let JSON.parse surface the error
}

/** Format the plan for injection into the execute-phase system prompt. */
export function formatPlanInjection(plan: AgentPlan): string {
  const stepsText = plan.steps
    .map((s) => `${s.step}. ${s.action}${s.tool ? ` [tool: ${s.tool}]` : ""}`)
    .join("\n");
  return `You previously created this plan:
Goal: ${plan.goal}
Steps:
${stepsText}

Follow this plan. You may deviate if new information requires it, but explain why.`;
}