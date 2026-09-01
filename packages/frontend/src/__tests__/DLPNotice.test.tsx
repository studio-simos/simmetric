// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLPNotice component tests (Phase 115-02 Wave 2)
 *
 * Covers all 3 visual states: non-admin collapsed, admin collapsed, admin expanded.
 * Also covers empty matches array (returns null).
 *
 * Framework: Jest + @testing-library/react
 * Transform: @swc/jest (per project conventions)
 */

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "dlp.notice.badgeWithCount" && options?.count === 2) return "Sensitive data detected (2 matches)";
      if (key === "dlp.notice.badgeWithCount") return `Sensitive data detected (${options?.count} matches)`;
      if (key === "dlp.notice.matchType" && options?.type && options?.count) return `${options.type} (${options.count})`;
      if (key === "dlp.notice.showText") return "Show matched text";
      if (key === "dlp.notice.hideText") return "Hide matched text";
      if (key === "dlp.notice.badge") return "Sensitive data detected";
      if (key === "dlp.notice.noPermission") return "Sensitive data detected";
      return key;
    },
  }),
}));

jest.mock("lucide-react", () => ({
  ShieldAlert: () => <svg data-testid="shield-alert" />,
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  Eye: () => <svg data-testid="eye" />,
  EyeOff: () => <svg data-testid="eye-off" />,
}));

import { render, screen, fireEvent } from "@testing-library/react";
import { DLPNotice } from "../components/chat/DLPNotice";

describe("DLPNotice", () => {
  const sampleMatches = [
    { type: "email", text: "user@example.com" },
    { type: "credit_card", text: "4111111111111111" },
  ];

  describe("non-admin (isAdmin=false)", () => {
    it("renders badge when matches are provided", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={false} />);
      expect(screen.getByText("Sensitive data detected")).toBeInTheDocument();
    });

    it("does not render expand button", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={false} />);
      // The badge is a role="status" div — should not have aria-expanded or button
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("does not reveal matched text", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={false} />);
      expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
      expect(screen.queryByText("4111111111111111")).not.toBeInTheDocument();
    });
  });

  describe("admin (isAdmin=true)", () => {
    it("renders badge with match count", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} />);
      expect(screen.getByText("Sensitive data detected (2 matches)")).toBeInTheDocument();
    });

    it("renders expand button", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} />);
      const buttons = screen.getAllByRole("button");
      // First button is the expand/collapse header button
      const expandBtn = buttons[0];
      expect(expandBtn).toBeInTheDocument();
      expect(expandBtn).toHaveAttribute("aria-expanded", "true"); // Expanded by default for admins
    });

    it("expanded by default shows match type badges", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} />);
      // D-04: admins see match types expanded by default
      expect(screen.getByText(/email/i)).toBeInTheDocument();
      expect(screen.getByText(/credit_card/i)).toBeInTheDocument();
    });

    it("'Show matched text' button not expanded by default (text hidden)", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} />);
      // Text snippets should NOT be visible initially
      expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
      // "Show matched text" button should be present
      expect(screen.getByText("Show matched text")).toBeInTheDocument();
    });

    it("clicking 'Show matched text' reveals text snippets", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} />);
      const showTextBtn = screen.getByText("Show matched text");
      fireEvent.click(showTextBtn);
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
      expect(screen.getByText("4111111111111111")).toBeInTheDocument();
    });

    it("matched text is rendered in monospace pre block", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} />);
      fireEvent.click(screen.getByText("Show matched text"));
      const codeEl = screen.getByText("user@example.com");
      expect(codeEl.tagName).toBe("CODE");
      expect(codeEl.className).toContain("font-mono");
    });

    it("clicking 'Hide matched text' hides text snippets", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} />);
      fireEvent.click(screen.getByText("Show matched text"));
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Hide matched text"));
      expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
    });
  });

  describe("empty matches", () => {
    it("renders nothing when matches array is empty", () => {
      const { container } = render(<DLPNotice matches={[]} isAdmin={true} />);
      expect(container.innerHTML).toBe("");
    });
  });

  // Quick 260829-spj — global "Show DLP texts" toggle (showTextDefault)
  describe("showTextDefault (global toggle from ChatPanel)", () => {
    it("initializes showText=true when showTextDefault is true (text visible on mount)", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={true} />);
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
      expect(screen.getByText("4111111111111111")).toBeInTheDocument();
    });

    it("keeps text hidden by default when showTextDefault is omitted (default false)", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={true} />);
      expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
    });

    it("reveals text when showTextDefault flips false→true (global toggle ON)", () => {
      const { rerender } = render(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={false} />);
      expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
      rerender(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={true} />);
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
      expect(screen.getByText("4111111111111111")).toBeInTheDocument();
    });

    it("hides text when showTextDefault flips true→false (global toggle OFF)", () => {
      const { rerender } = render(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={true} />);
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
      rerender(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={false} />);
      expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
    });

    it("manual eye override still works after global sync", () => {
      const { rerender } = render(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={false} />);
      // User manually reveals this notice
      fireEvent.click(screen.getByText("Show matched text"));
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
      // Global toggle flips ON then OFF — sync resets the notice
      rerender(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={true} />);
      rerender(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={false} />);
      expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
      // Manual override still possible afterwards
      fireEvent.click(screen.getByText("Show matched text"));
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
    });

    it("ignores an unchanged showTextDefault value (no forced reset on rerender)", () => {
      const { rerender } = render(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={false} />);
      // Manual reveal…
      fireEvent.click(screen.getByText("Show matched text"));
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
      // …survives a rerender with the SAME showTextDefault value.
      rerender(<DLPNotice matches={sampleMatches} isAdmin={true} showTextDefault={false} />);
      expect(screen.getByText("user@example.com")).toBeInTheDocument();
    });

    it("non-admin never reveals text even with showTextDefault=true", () => {
      render(<DLPNotice matches={sampleMatches} isAdmin={false} showTextDefault={true} />);
      expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
  });
});
