// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck — Prisma 7 + TS 6 circular type references in mock setup
// Tests for OCR pipeline concurrency limiting via getActiveJobCount()

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    ocrJob: {
      count: jest.fn(),
    },
  },
}));

import prisma from "../utils/prisma";
import { getActiveJobCount } from "../services/ocrJobService";

const mockCount = prisma.ocrJob.count as jest.Mock;

describe("OCR Pipeline Concurrency Limiter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getActiveJobCount", () => {
    it("returns correct count for mixed statuses — only PROCESSING is counted", async () => {
      // Simulate the database having 2 PENDING, 1 PROCESSING, 3 COMPLETED, 1 FAILED, 1 CANCELLED.
      // Since 2026-06-09 getActiveJobCount() counts only PROCESSING — PENDING jobs
      // are waiting to be dispatched, not consuming resources.
      mockCount.mockResolvedValueOnce(1);

      const count = await getActiveJobCount();

      expect(mockCount).toHaveBeenCalledWith({
        where: {
          status: "PROCESSING",
        },
      });
      expect(count).toBe(1);
    });

    it("returns 0 when no active jobs exist", async () => {
      mockCount.mockResolvedValueOnce(0);

      const count = await getActiveJobCount();

      expect(mockCount).toHaveBeenCalledWith({
        where: {
          status: "PROCESSING",
        },
      });
      expect(count).toBe(0);
    });

    it("returns correct count when all jobs are PROCESSING", async () => {
      // 3 jobs, all PROCESSING
      mockCount.mockResolvedValueOnce(3);

      const count = await getActiveJobCount();

      expect(mockCount).toHaveBeenCalledWith({
        where: {
          status: "PROCESSING",
        },
      });
      expect(count).toBe(3);
    });
  });
});
