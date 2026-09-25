// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Artifact-shape test for docker/ollama/glm-ocr-optimized.Modelfile
 * (Phase 205, OCR-01 / D-06).
 *
 * The Modelfile is the phase's hardest-prohibition artifact: the TEMPLATE
 * block must NEVER be added (the bare `{{ .Prompt }}` template inherited from
 * glm-ocr:latest is load-bearing — done-less-stream regression guard,
 * modelRegistry.ts comment + salvage rule 260829-lkq). These tests pin:
 * - FROM glm-ocr:latest (weights + template inheritance)
 * - exactly the 4 PARAMETER lines from D-06
 * - NO template-override line anywhere in the file
 */

import { readFileSync } from "fs";
import path from "path";

// Repo root = packages/server/src/__tests__ → 4 levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const MODELFILE_PATH = path.join(
  REPO_ROOT,
  "docker",
  "ollama",
  "glm-ocr-optimized.Modelfile",
);

describe("docker/ollama/glm-ocr-optimized.Modelfile", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(MODELFILE_PATH, "utf-8");
  });

  it("exists (runbook artifact is committed)", () => {
    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
  });

  it("contains the FROM glm-ocr:latest line", () => {
    expect(content).toMatch(/^FROM glm-ocr:latest$/m);
  });

  it("contains exactly the 4 required PARAMETER lines", () => {
    expect(content).toMatch(/^PARAMETER num_ctx 16384$/m);
    expect(content).toMatch(/^PARAMETER num_predict 8192$/m);
    expect(content).toMatch(/^PARAMETER temperature 0$/m);
    expect(content).toMatch(/^PARAMETER top_k 1$/m);

    // Exactly 4 PARAMETER lines total — no stray tuning params.
    const paramLines = content
      .split("\n")
      .filter((line) => line.startsWith("PARAMETER "));
    expect(paramLines).toHaveLength(4);
  });

  it("contains NO template-override line (bare prompt template is inherited)", () => {
    // Negative check scoped to this artifact file (the precise region): no
    // line may start with the template keyword — any TEMPLATE block here
    // would override the base model's load-bearing bare `{{ .Prompt }}`
    // template and reintroduce the done-less-stream infinite loop.
    const templateLines = content
      .split("\n")
      .filter((line) => line.startsWith("TEMPLATE"));
    expect(templateLines).toEqual([]);
  });
});