// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import ComparisonFabPicker from "../ComparisonFabPicker";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "chat.comparison.mergePrompt": "Select which response to keep",
      };
      if (key === "chat.comparison.keepResponse" && options?.model) {
        return `Keep ${options.model}`;
      }
      return map[key] || key;
    },
  }),
}));

describe("ComparisonFabPicker", () => {
  const defaultProps = {
    paneAModel: { providerId: "p1", model: "Model A" },
    paneBModel: { providerId: "p2", model: "Model B" },
    onMerge: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders merge prompt when opened", () => {
    render(<ComparisonFabPicker {...defaultProps} />);
    const fab = screen.getByLabelText("Select response to keep");
    fireEvent.click(fab);
    expect(screen.getByText("Select which response to keep")).toBeInTheDocument();
  });

  it("calls onMerge with A when first button clicked", () => {
    const onMerge = jest.fn();
    render(<ComparisonFabPicker {...defaultProps} onMerge={onMerge} />);
    const fab = screen.getByLabelText("Select response to keep");
    fireEvent.click(fab);

    const buttons = screen.getAllByRole("button");
    // First button after FAB is Keep Model A
    const firstButton = buttons[1];
    if (firstButton) fireEvent.click(firstButton);
    expect(onMerge).toHaveBeenCalledWith("A");
  });

  it("calls onMerge with B when second button clicked", () => {
    const onMerge = jest.fn();
    render(<ComparisonFabPicker {...defaultProps} onMerge={onMerge} />);
    const fab = screen.getByLabelText("Select response to keep");
    fireEvent.click(fab);

    const buttons = screen.getAllByRole("button");
    // Second button after FAB is Keep Model B
    const secondButton = buttons[2];
    if (secondButton) fireEvent.click(secondButton);
    expect(onMerge).toHaveBeenCalledWith("B");
  });

  it("closes on Escape key", () => {
    render(<ComparisonFabPicker {...defaultProps} />);
    const fab = screen.getByLabelText("Select response to keep");
    fireEvent.click(fab);

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
