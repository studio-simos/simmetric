// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DlpTextsToggle component tests (quick 260829-spj)
 *
 * The admin-gated "Show/Hide DLP texts" menu item for the chat more-actions
 * Popover. Covers: hidden for non-admins, label/icon/aria-checked flip,
 * onToggle callback with the NEXT value.
 *
 * Framework: Jest + @testing-library/react
 * Transform: @swc/jest (per project conventions)
 */

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "chat.dlp.showTexts": "Show DLP texts",
        "chat.dlp.hideTexts": "Hide DLP texts",
      };
      return map[key] ?? key;
    },
  }),
}));

jest.mock("lucide-react", () => ({
  Eye: () => <svg data-testid="eye" />,
  EyeOff: () => <svg data-testid="eye-off" />,
}));

import { render, screen, fireEvent } from "@testing-library/react";
import { DlpTextsToggle } from "../DlpTextsToggle";

describe("DlpTextsToggle", () => {
  it("renders nothing for non-admins (visible=false)", () => {
    const { container } = render(
      <DlpTextsToggle visible={false} checked={false} onToggle={jest.fn()} />,
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
  });

  it("renders the OFF state: 'Show DLP texts' label + Eye icon + aria-checked=false", () => {
    render(<DlpTextsToggle visible={true} checked={false} onToggle={jest.fn()} />);
    const item = screen.getByRole("menuitemcheckbox");
    expect(item).toHaveAttribute("aria-checked", "false");
    expect(item).toHaveAccessibleName("Show DLP texts");
    expect(screen.getByTestId("eye")).toBeInTheDocument();
    expect(screen.queryByTestId("eye-off")).not.toBeInTheDocument();
    expect(screen.getByText("Show DLP texts")).toBeInTheDocument();
  });

  it("renders the ON state: 'Hide DLP texts' label + EyeOff icon + aria-checked=true", () => {
    render(<DlpTextsToggle visible={true} checked={true} onToggle={jest.fn()} />);
    const item = screen.getByRole("menuitemcheckbox");
    expect(item).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("eye-off")).toBeInTheDocument();
    expect(screen.queryByTestId("eye")).not.toBeInTheDocument();
    expect(screen.getByText("Hide DLP texts")).toBeInTheDocument();
  });

  it("calls onToggle(true) when clicked while OFF", () => {
    const onToggle = jest.fn();
    render(<DlpTextsToggle visible={true} checked={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("menuitemcheckbox"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("calls onToggle(false) when clicked while ON", () => {
    const onToggle = jest.fn();
    render(<DlpTextsToggle visible={true} checked={true} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("menuitemcheckbox"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});