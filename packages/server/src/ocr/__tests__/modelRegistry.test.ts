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
