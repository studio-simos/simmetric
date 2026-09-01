// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * UploadDestinationChooser tests (Phase 71-05 Task 2).
 *
 * Verifies: DST-01 RadioGroup with 4 options, KB→archive picker reveal,
 * D-16 KB+PDF/image → OcrModeSelector reveal, D-12 invalid-MIME disabled
 * + tooltip + image warning badge, destinationToAssignBody mapping, empty
 * archive list helper.
 */

// ── Mocks ────────────────────────────────────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("../queries/useArchives", () => ({
  useArchives: jest.fn(() => ({ data: [], isLoading: false })),
}));

jest.mock("../components/OcrModeSelector", () => ({
  __esModule: true,
  default: ({ value }: { value: string; onChange: (v: string) => void }) => (
    <div data-testid="ocr-mode-selector" data-ocr-value={value} />
  ),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { useArchives } from "../queries/useArchives";
import UploadDestinationChooser, {
  destinationToAssignBody,
} from "../components/UploadDestinationChooser";

// ── Helpers ──────────────────────────────────────────────────────

type ChooserProps = React.ComponentProps<typeof UploadDestinationChooser>;

function renderChooser(props: Partial<ChooserProps> = {}) {
  const defaults: ChooserProps = {
    destination: "unassigned",
    onDestinationChange: jest.fn(),
    onArchiveIdChange: jest.fn(),
    onOcrModeChange: jest.fn(),
  };
  return render(<UploadDestinationChooser {...defaults} {...props} />);
}

const ARCHIVES = [
  { id: "arch-1", name: "My Archive", slug: "my-archive", description: null },
  { id: "arch-2", name: "Other Archive", slug: "other-archive", description: null },
];

// ── Tests ────────────────────────────────────────────────────────

describe("UploadDestinationChooser", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useArchives as unknown as jest.Mock).mockReturnValue({
      data: ARCHIVES,
      isLoading: false,
    });
  });

  it("DST-01 renders RadioGroup with 4 options + helpers", () => {
    renderChooser();
    expect(screen.getByText("uploads.destination.rag.label")).toBeInTheDocument();
    expect(screen.getByText("uploads.destination.kb.label")).toBeInTheDocument();
    expect(screen.getByText("uploads.destination.both.label")).toBeInTheDocument();
    expect(screen.getByText("uploads.destination.unassigned.label")).toBeInTheDocument();
    expect(screen.getByText("uploads.destination.rag.helper")).toBeInTheDocument();
    expect(screen.getByText("uploads.destination.kb.helper")).toBeInTheDocument();
    expect(screen.getByText("uploads.destination.both.helper")).toBeInTheDocument();
    expect(screen.getByText("uploads.destination.unassigned.helper")).toBeInTheDocument();
  });

  it("DST-01 selecting KB reveals archive picker; RAG hides it", () => {
    const { rerender } = renderChooser({ destination: "kb" });
    expect(screen.getByText("uploads.destination.archive.placeholder")).toBeInTheDocument();

    rerender(
      <UploadDestinationChooser
        destination="rag"
        onDestinationChange={jest.fn()}
        onArchiveIdChange={jest.fn()}
        onOcrModeChange={jest.fn()}
      />,
    );
    expect(screen.queryByText("uploads.destination.archive.placeholder")).not.toBeInTheDocument();
  });

  it("D-16 KB+PDF reveals OcrModeSelector; KB+.md hides it", () => {
    const { rerender } = renderChooser({
      destination: "kb",
      draftMimeType: "application/pdf",
    });
    expect(screen.getByTestId("ocr-mode-selector")).toBeInTheDocument();

    rerender(
      <UploadDestinationChooser
        destination="kb"
        draftMimeType="text/markdown"
        onDestinationChange={jest.fn()}
        onArchiveIdChange={jest.fn()}
        onOcrModeChange={jest.fn()}
      />,
    );
    expect(screen.queryByTestId("ocr-mode-selector")).not.toBeInTheDocument();
  });

  it("D-12 image MIME disables RAG option; legacy xls MIME disables KB option (txt/csv KB-eligible since quick 260829-xxx)", () => {
    const { rerender } = renderChooser({
      destination: "unassigned",
      draftMimeType: "image/png",
    });
    const ragRadio = screen.getByRole("radio", {
      name: /uploads.destination.rag.label/,
    });
    expect(ragRadio).toBeDisabled();
    expect(ragRadio.getAttribute("aria-describedby")).toMatch(/tooltip-rag/);

    // quick 260829-xxx: text/plain NO LONGER disables KB (KB_ARCHIVE_MIME
    // now includes text/plain + text/csv). A MIME outside every KB set —
    // the legacy xls MIME — is the one that disables the KB option.
    rerender(
      <UploadDestinationChooser
        destination="unassigned"
        draftMimeType="text/plain"
        onDestinationChange={jest.fn()}
        onArchiveIdChange={jest.fn()}
        onOcrModeChange={jest.fn()}
      />,
    );
    const kbRadioForTxt = screen.getByRole("radio", {
      name: /uploads.destination.kb.label/,
    });
    expect(kbRadioForTxt).not.toBeDisabled();

    rerender(
      <UploadDestinationChooser
        destination="unassigned"
        draftMimeType="application/vnd.ms-excel"
        onDestinationChange={jest.fn()}
        onArchiveIdChange={jest.fn()}
        onOcrModeChange={jest.fn()}
      />,
    );
    const kbRadio = screen.getByRole("radio", {
      name: /uploads.destination.kb.label/,
    });
    expect(kbRadio).toBeDisabled();
    expect(kbRadio.getAttribute("aria-describedby")).toMatch(/tooltip-kb/);
  });

  it("D-12 image rows render warning Badge with imageRagGap text + font-semibold", () => {
    renderChooser({ destination: "unassigned", draftMimeType: "image/png" });
    const warning = screen.getByText("uploads.row.imageRagGap");
    expect(warning).toBeInTheDocument();
    expect(warning.className).toContain("font-semibold");
  });

  it("destinationToAssignBody maps all 4 destinations correctly", () => {
    expect(destinationToAssignBody("both", "archive-1")).toEqual({
      rag: true,
      kb: true,
      archiveId: "archive-1",
    });
    expect(destinationToAssignBody("unassigned")).toEqual({ rag: false, kb: false });
    expect(destinationToAssignBody("rag")).toEqual({ rag: true, kb: false });
    expect(destinationToAssignBody("kb", "archive-1")).toEqual({
      rag: false,
      kb: true,
      archiveId: "archive-1",
    });
    expect(() => destinationToAssignBody("kb")).toThrow();
  });

  it("archive picker empty state shows uploads.destination.archive.empty helper", () => {
    (useArchives as unknown as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
    });
    renderChooser({ destination: "kb" });
    expect(screen.getByText("uploads.destination.archive.empty")).toBeInTheDocument();
  });
});