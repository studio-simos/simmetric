// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveExportDialog error-toast tests (DBG-01 / D-09 — silent-failure fix).
 *
 * Verifies the fix at packages/frontend/src/components/ArchiveExportDialog.tsx:25-27 —
 * when the useExportArchive mutation rejects, the handleExport catch block
 * surfaces the error via `showError(getErrorMessage(err, "Export failed"))`
 * instead of swallowing it (the original bug was an empty catch block, so
 * clicking Export appeared to "do nothing" on failure).
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockMutateAsync = jest.fn();
jest.mock("../queries/useArchives", () => ({
  useExportArchive: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

jest.mock("../lib/toast", () => ({
  showError: jest.fn(),
  showSuccess: jest.fn(),
}));

// Keep the real getErrorMessage contract: Error instances yield .message,
// anything else falls back to the provided default.
jest.mock("../utils/errorUtils", () => ({
  getErrorMessage: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

import { ArchiveExportDialog } from "../components/ArchiveExportDialog";
import { showError } from "../lib/toast";

describe("ArchiveExportDialog error handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls showError with the error message when the export mutation rejects", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error("403 Forbidden"));
    const onClose = jest.fn();

    render(<ArchiveExportDialog archiveId="a1" archiveName="Demo" onClose={onClose} />);

    fireEvent.click(screen.getByText("export.download"));

    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("403 Forbidden");
    });
    // The dialog must stay open on failure so the user can retry.
    expect(onClose).not.toHaveBeenCalled();
    expect(mockMutateAsync).toHaveBeenCalledWith({ archiveId: "a1", format: "zip" });
  });

  it("falls back to 'Export failed' when the rejection is not an Error", async () => {
    mockMutateAsync.mockRejectedValueOnce("network unreachable");
    const onClose = jest.fn();

    render(<ArchiveExportDialog archiveId="a1" archiveName="Demo" onClose={onClose} />);

    fireEvent.click(screen.getByText("export.download"));

    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("Export failed");
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the dialog without showError when the export succeeds", async () => {
    mockMutateAsync.mockResolvedValueOnce(undefined);
    const onClose = jest.fn();

    render(<ArchiveExportDialog archiveId="a1" archiveName="Demo" onClose={onClose} />);

    fireEvent.click(screen.getByText("export.download"));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(showError).not.toHaveBeenCalled();
  });
});
