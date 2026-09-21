// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveAttachPicker component tests (Phase 191 D-11d + quick 260919-qjg).
 *
 * Covers: renders both archive names; clicking a row calls onToggle with its
 * id; chip X calls onToggle (remove); with 5 selected the 6th row is
 * disabled and maxReached renders; empty fixture renders the empty state;
 * panel mode (260919-qjg) renders the list body WITHOUT the chips row and
 * still toggles + caps.
 */

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "chat.attach.pickerTitle": "Attach archive knowledge",
        "chat.attach.empty": "No archives available to attach.",
        "chat.attach.maxReached": "You can attach up to {{max}} archives.",
        "chat.attach.remove": "Remove attached archive",
        "chat.attach.pageCount": "{{count}} pages",
      };
      let out = map[key] ?? key;
      if (out.includes("{{max}}") && typeof out === "string") out = out.replace("{{max}}", String(5));
      if (out.includes("{{count}}") && typeof out === "string") out = out.replace("{{count}}", String(3));
      return out;
    },
  }),
}));

jest.mock("../../../queries/useArchives", () => ({
  useArchives: jest.fn(),
}));

import { render, screen, fireEvent } from "@testing-library/react";
import ArchiveAttachPicker from "../ArchiveAttachPicker";
import { useArchives } from "../../../queries/useArchives";

const mockUseArchives = useArchives as unknown as jest.Mock;

const ARCHIVE_A = { id: "arch-a", slug: "a", name: "Alpha Archive", description: null, createdBy: "u", deletedAt: null, createdAt: "", updatedAt: "", _count: { pages: 3 } };
const ARCHIVE_B = { id: "arch-b", slug: "b", name: "Beta Archive", description: null, createdBy: "u", deletedAt: null, createdAt: "", updatedAt: "", _count: { pages: 7 } };

function fixture(list: unknown[]) {
  (mockUseArchives as jest.Mock).mockReturnValue({ data: list, isLoading: false, error: null });
}

describe("ArchiveAttachPicker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders both archive names in the picker list", () => {
    fixture([ARCHIVE_A, ARCHIVE_B]);
    render(<ArchiveAttachPicker selectedIds={[]} onToggle={jest.fn()} />);
    expect(screen.getByText("Alpha Archive")).toBeInTheDocument();
    expect(screen.getByText("Beta Archive")).toBeInTheDocument();
    expect(screen.getByText("Attach archive knowledge")).toBeInTheDocument();
  });

  it("clicking a row calls onToggle with its id", () => {
    fixture([ARCHIVE_A, ARCHIVE_B]);
    const onToggle = jest.fn();
    render(<ArchiveAttachPicker selectedIds={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByText("Alpha Archive"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("arch-a");
  });

  it("renders a chip per selected archive and its X button calls onToggle (remove)", () => {
    fixture([ARCHIVE_A]);
    const onToggle = jest.fn();
    render(<ArchiveAttachPicker selectedIds={["arch-a"]} onToggle={onToggle} />);
    // The chip label AND the picker row share the name — the chip's remove
    // button is unique by its aria-label.
    const removeBtn = screen.getByRole("button", { name: "Remove attached archive" });
    fireEvent.click(removeBtn);
    expect(onToggle).toHaveBeenCalledWith("arch-a");
  });

  it("chip falls back to the raw id when the archive list has not hydrated", () => {
    fixture([]);
    render(<ArchiveAttachPicker selectedIds={["arch-unknown"]} onToggle={jest.fn()} />);
    expect(screen.getByText("arch-unknown")).toBeInTheDocument();
  });

  it("with 5 selected the 6th row is disabled and maxReached renders", () => {
    fixture([ARCHIVE_A]);
    const five = ["s1", "s2", "s3", "s4", "s5"];
    render(<ArchiveAttachPicker selectedIds={five} onToggle={jest.fn()} max={5} />);
    const row = screen.getByRole("button", { name: /Alpha Archive/ });
    expect(row).toBeDisabled();
    expect(screen.getByText("You can attach up to 5 archives.")).toBeInTheDocument();
  });

  it("empty fixture renders the empty state", () => {
    fixture([]);
    render(<ArchiveAttachPicker selectedIds={[]} onToggle={jest.fn()} />);
    expect(screen.getByText("No archives available to attach.")).toBeInTheDocument();
  });

  it("renders the page count per archive row", () => {
    fixture([ARCHIVE_A]);
    render(<ArchiveAttachPicker selectedIds={[]} onToggle={jest.fn()} />);
    expect(screen.getAllByText("3 pages").length).toBeGreaterThan(0);
  });

  // ── quick 260919-qjg: panel mode (in-popover submenu body) ──

  it('mode="panel" renders the pickerTitle + rows but NOT the chips row even with a non-empty selection', () => {
    fixture([ARCHIVE_A, ARCHIVE_B]);
    render(
      <ArchiveAttachPicker selectedIds={["arch-a"]} onToggle={jest.fn()} mode="panel" />,
    );
    // Panel root distinguishes itself from the full-mode wrapper.
    expect(screen.getByTestId("archive-attach-picker-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("archive-attach-picker")).not.toBeInTheDocument();
    expect(screen.getByText("Attach archive knowledge")).toBeInTheDocument();
    expect(screen.getByText("Alpha Archive")).toBeInTheDocument();
    expect(screen.getByText("Beta Archive")).toBeInTheDocument();
    // The chip (and its remove button) must NOT render in panel mode —
    // chips live with the full/chips instance above the input.
    expect(screen.queryByRole("button", { name: "Remove attached archive" })).not.toBeInTheDocument();
  });

  it('mode="panel" clicking a row still calls onToggle and the max-reached notice renders at the cap', () => {
    fixture([ARCHIVE_A]);
    const onToggle = jest.fn();
    const five = ["s1", "s2", "s3", "s4", "s5"];
    const capped = render(
      <ArchiveAttachPicker selectedIds={five} onToggle={onToggle} max={5} mode="panel" />,
    );
    const row = screen.getByRole("button", { name: /Alpha Archive/ });
    expect(row).toBeDisabled();
    expect(screen.getByText("You can attach up to 5 archives.")).toBeInTheDocument();
    capped.unmount();
    // A selected row stays interactive (deselect works below the cap): pick
    // the same fixture below the cap and toggle it from the panel.
    const onToggleB = jest.fn();
    render(<ArchiveAttachPicker selectedIds={[]} onToggle={onToggleB} mode="panel" />);
    fireEvent.click(screen.getByText("Alpha Archive"));
    expect(onToggleB).toHaveBeenCalledWith("arch-a");
    expect(onToggle).not.toHaveBeenCalled(); // the capped row never fired
  });
});