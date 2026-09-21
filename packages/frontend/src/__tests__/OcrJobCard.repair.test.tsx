// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * OcrJobCard failed-page repair UI tests (260919-kvm)
 *
 * COMPLETED job with result.failedPages > 0 renders the amber badge + retry
 * button; failedPages absent/0 renders neither. Hooks + toast mocked (no
 * network, no sonner render).
 */

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && "count" in opts) return `${key}:${opts.count}`;
      if (opts && "repaired" in opts) return `${key}:${opts.repaired}`;
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
    initReactI18next: { type: "3rdParty", init: jest.fn() },
  }),
}));

const mockRepairMutateAsync = jest.fn();

jest.mock("../queries/useOcrJobs", () => ({
  useDeleteOcrJob: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCancelOcrJob: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRepairOcrPages: () => ({
    mutateAsync: mockRepairMutateAsync,
    isPending: false,
  }),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OcrJobCard from "../components/OcrJobCard";
import type { OcrJob } from "../queries/useOcrJobs";
import { showSuccess, showError } from "../lib/toast";

function makeJob(overrides: Partial<OcrJob> = {}): OcrJob {
  return {
    id: "job-001",
    archiveId: "archive-001",
    type: "OCR",
    status: "COMPLETED",
    progress: 100,
    totalPages: 3,
    processedPages: 3,
    currentPage: 3,
    modelName: "glm-ocr:latest",
    sourceFileName: "doc.pdf",
    contentHash: null,
    result: {
      qualityScore: 4,
      totalTokens: 500,
      totalDurationMs: 12000,
      pageResults: [],
    },
    error: null,
    createdBy: "user-001",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("OcrJobCard — failed-page repair UI (260919-kvm)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the failedPages badge + retry button when result.failedPages = 2", () => {
    render(
      <OcrJobCard
        job={makeJob({
          result: { failedPages: 2, qualityScore: 4 },
        })}
        archiveId="archive-001"
        onPreview={() => {}}
      />,
    );

    expect(screen.getByText("ocr.failedPagesBadge:2")).toBeInTheDocument();
    expect(screen.getByText("ocr.retryFailedPages")).toBeInTheDocument();
  });

  it("renders neither badge nor retry button when failedPages is absent", () => {
    render(
      <OcrJobCard
        job={makeJob()}
        archiveId="archive-001"
        onPreview={() => {}}
      />,
    );

    expect(screen.queryByText(/ocr.failedPagesBadge/)).not.toBeInTheDocument();
    expect(screen.queryByText("ocr.retryFailedPages")).not.toBeInTheDocument();
  });

  it("renders neither badge nor retry button when failedPages = 0", () => {
    render(
      <OcrJobCard
        job={makeJob({ result: { failedPages: 0 } })}
        archiveId="archive-001"
        onPreview={() => {}}
      />,
    );

    expect(screen.queryByText(/ocr.failedPagesBadge/)).not.toBeInTheDocument();
    expect(screen.queryByText("ocr.retryFailedPages")).not.toBeInTheDocument();
  });

  it("retry button posts the repair mutation with no pages (all failed) and toasts success", async () => {
    mockRepairMutateAsync.mockResolvedValue({
      repaired: [{ pageNumber: 1, markdown: "ok", stillFailed: false }],
      failedPages: 0,
      qualityScore: 4,
    });

    render(
      <OcrJobCard
        job={makeJob({ result: { failedPages: 2 } })}
        archiveId="archive-001"
        onPreview={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("ocr.retryFailedPages"));

    await waitFor(() => {
      expect(mockRepairMutateAsync).toHaveBeenCalledWith({
        archiveId: "archive-001",
        jobId: "job-001",
        pages: undefined,
      });
      expect(showSuccess).toHaveBeenCalledWith("ocr.repairSuccess:1");
    });
  });

  it("toasts repairStillFailed when no page was repaired", async () => {
    mockRepairMutateAsync.mockResolvedValue({
      repaired: [{ pageNumber: 1, markdown: "[FAILED:", stillFailed: true }],
      failedPages: 1,
      qualityScore: 1,
    });

    render(
      <OcrJobCard
        job={makeJob({ result: { failedPages: 1 } })}
        archiveId="archive-001"
        onPreview={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("ocr.retryFailedPages"));

    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("ocr.repairStillFailed");
      expect(showSuccess).not.toHaveBeenCalled();
    });
  });

  it("hides the retry affordance on rejected jobs", () => {
    render(
      <OcrJobCard
        job={makeJob({
          result: { failedPages: 2, rejected: true },
        })}
        archiveId="archive-001"
        onPreview={() => {}}
      />,
    );

    expect(screen.queryByText(/ocr.failedPagesBadge/)).not.toBeInTheDocument();
    expect(screen.queryByText("ocr.retryFailedPages")).not.toBeInTheDocument();
  });
});