// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { resolveModelConfig, OCR_MODEL_REGISTRY } from "../modelRegistry";
import { logger } from "../../utils/logger";

jest.mock("../../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("modelRegistry", () => {
  describe("resolveModelConfig", () => {
    it("returns exact match for glm-ocr:latest", () => {
      const config = resolveModelConfig("glm-ocr:latest");
      expect(config.namePattern).toBe("glm-ocr:latest");
      expect(config.promptTemplate).toBe("glm-ocr");
      expect(config.inputMode).toBe("base64_array");
    });

    it("matches wildcard glm-ocr:* for glm-ocr:1.0", () => {
      const config = resolveModelConfig("glm-ocr:1.0");
      expect(config.namePattern).toBe("glm-ocr:*");
      expect(config.promptTemplate).toBe("glm-ocr");
    });

    it("matches prefix deepseek-ocr* for deepseek-ocr:7b", () => {
      const config = resolveModelConfig("deepseek-ocr:7b");
      expect(config.namePattern).toBe("deepseek-ocr*");
      expect(config.promptTemplate).toBe("deepseek-ocr");
      expect(config.inputMode).toBe("single_image");
    });

    it("matches wildcard deepseek-ocr:* for deepseek-ocr:14b", () => {
      const config = resolveModelConfig("deepseek-ocr:14b");
      expect(config.namePattern).toBe("deepseek-ocr*");
      expect(config.promptTemplate).toBe("deepseek-ocr");
    });

    it("returns generic fallback for unknown model", () => {
      const config = resolveModelConfig("unknown-model-v99");
      expect(config.name).toBe("generic");
      expect(config.promptTemplate).toBe("generic");
      expect(logger.warn).toHaveBeenCalledWith(
        "[ocr] Unknown OCR model, using generic fallback config",
        { modelName: "unknown-model-v99" }
      );
    });

    // Phase 205 (OCR-01 / D-07): the tuned child model must resolve to the
    // glm-ocr prompt family + chat endpoint + base64_array with the raised
    // 16384 contextWindow — never the generic 4096 fallback (Pitfall 4).
    it("resolves glm-ocr-optimized:latest to the glm-ocr family with contextWindow 16384", () => {
      const config = resolveModelConfig("glm-ocr-optimized:latest");
      expect(config.apiEndpoint).toBe("chat");
      expect(config.inputMode).toBe("base64_array");
      expect(config.promptTemplate).toBe("glm-ocr");
      expect(config.contextWindow).toBe(16384);
      expect(config.name).toBe("glm-ocr-optimized:latest");
    });

    it("resolves glm-ocr-optimized:q8_0 via the glm-ocr-optimized:* wildcard entry", () => {
      const config = resolveModelConfig("glm-ocr-optimized:q8_0");
      expect(config.apiEndpoint).toBe("chat");
      expect(config.promptTemplate).toBe("glm-ocr");
      expect(config.contextWindow).toBe(16384);
    });

    // Regression pin (Pitfall 4 guard): patternToRegex("glm-ocr:*") = ^glm-ocr:.*$
    // must NOT match "glm-ocr-optimized:latest" — the name carries no
    // "glm-ocr:" prefix. The dedicated registry entry is what makes the
    // optimized model findable.
    it("wildcard glm-ocr:* does NOT match glm-ocr-optimized:latest", () => {
      for (const entry of OCR_MODEL_REGISTRY) {
        if (entry.namePattern !== "glm-ocr:*") continue;
        const wildcardRegex = new RegExp(
          "^" +
            entry.namePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") +
            "$",
        );
        expect(wildcardRegex.test("glm-ocr-optimized:latest")).toBe(false);
      }
    });

    // Ordering pin: the optimized entry must sit between the exact
    // glm-ocr:latest entry and the glm-ocr:* wildcard — resolveModelConfig
    // checks exact, then wildcard, in array order.
    it("glm-ocr-optimized entry precedes the glm-ocr:* wildcard entry", () => {
      const optimizedIdx = OCR_MODEL_REGISTRY.findIndex(
        (e) => e.namePattern === "glm-ocr-optimized:*",
      );
      const exactIdx = OCR_MODEL_REGISTRY.findIndex(
        (e) => e.namePattern === "glm-ocr:latest",
      );
      const wildcardIdx = OCR_MODEL_REGISTRY.findIndex(
        (e) => e.namePattern === "glm-ocr:*",
      );
      expect(optimizedIdx).toBeGreaterThan(-1);
      expect(exactIdx).toBeGreaterThan(-1);
      expect(wildcardIdx).toBeGreaterThan(-1);
      expect(optimizedIdx).toBeGreaterThan(exactIdx);
      expect(optimizedIdx).toBeLessThan(wildcardIdx);
    });

    it("is case-sensitive", () => {
      const configLower = resolveModelConfig("glm-ocr:latest");
      const configUpper = resolveModelConfig("GLM-OCR:LATEST");
      expect(configLower.namePattern).toBe("glm-ocr:latest");
      expect(configUpper.name).toBe("generic");
    });
  });

  describe("OCR_MODEL_REGISTRY", () => {
    it("contains at least 5 entries", () => {
      expect(OCR_MODEL_REGISTRY.length).toBeGreaterThanOrEqual(5);
    });

    it("has generic fallback as last entry", () => {
      const last = OCR_MODEL_REGISTRY[OCR_MODEL_REGISTRY.length - 1]!;
      expect(last.namePattern).toBe("*");
      expect(last.name).toBe("generic");
    });
  });
});
