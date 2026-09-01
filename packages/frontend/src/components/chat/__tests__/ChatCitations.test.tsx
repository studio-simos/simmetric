// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatCitations } from "../ChatCitations";
import type { SourceCitation } from "../../../hooks/useChat";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === "string") return opts;
      if (opts && typeof opts === "object" && "defaultValue" in opts) {
        return String(opts.defaultValue).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts[k] ?? ""));
      }
      return key;
    },
  }),
}));

const sources: SourceCitation[] = [
  { documentId: "d1", documentName: "Doc One", score: 0.91, pageNumber: 3 },
  { documentId: "d2", documentName: "Doc Two", score: 0.8 },
];

describe("ChatCitations", () => {
  it("renders nothing when sources is empty", () => {
    const { container } = render(<ChatCitations sources={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the toggle with count, collapsed by default", () => {
    render(<ChatCitations sources={sources} />);
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Sources (2)");
    // 4.7.2: the list stays mounted but is collapsed (no `is-open` class);
    // expand/collapse is CSS-driven (max-height + opacity transition).
    const list = screen.getByRole("region").querySelector("ul");
    expect(list).not.toHaveClass("is-open");
  });

  it("expands to show source rows and rotates the chevron", () => {
    render(<ChatCitations sources={sources} />);
    const toggle = screen.getByRole("button", { name: /Sources \(2\)/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Doc One")).toBeInTheDocument();
    expect(screen.getByText("Doc Two")).toBeInTheDocument();
    expect(screen.getByText("91.0%")).toBeInTheDocument();
  });

  it("calls onOpenPanel when a source row is clicked", () => {
    const onOpenPanel = jest.fn();
    render(<ChatCitations sources={sources} onOpenPanel={onOpenPanel} />);
    fireEvent.click(screen.getByRole("button", { name: /Sources \(2\)/ }));
    fireEvent.click(screen.getByRole("button", { name: /Open source: Doc One/ }));
    expect(onOpenPanel).toHaveBeenCalledWith(sources);
  });

  it("is wrapped in role=region aria-label=Sources", () => {
    render(<ChatCitations sources={sources} />);
    expect(screen.getByRole("region")).toHaveAttribute("aria-label", "Sources");
  });
});