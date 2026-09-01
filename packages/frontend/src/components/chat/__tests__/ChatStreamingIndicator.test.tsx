// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ChatStreamingIndicator } from "../ChatStreamingIndicator";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_k: string, d?: unknown) => (typeof d === "string" ? d : _k) }),
}));

describe("ChatStreamingIndicator", () => {
  it("shows spinner + status message when only statusMessage is set", () => {
    render(<ChatStreamingIndicator statusMessage="Searching documents..." streamingContent="" />);
    expect(screen.getByText("Searching documents...")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("renders streaming content with a blinking cursor when content available", () => {
    render(<ChatStreamingIndicator statusMessage={null} streamingContent="Hello **world**" />);
    // markdown rendered (bold)
    expect(document.querySelector("strong")?.textContent).toBe("world");
    // 4.2.3: neon cursor appended after the streaming text
    expect(document.querySelector(".chat-cursor")).toBeInTheDocument();
    // live token estimate badge ("~N tok", chars/4 heuristic: 15 chars → 4)
    expect(screen.getByText(/~\d+ tok/)).toBeInTheDocument();
  });

  it("renders skeleton placeholders when no status and no content yet", () => {
    const { container } = render(<ChatStreamingIndicator statusMessage={null} streamingContent="" />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(3);
  });

  it("has role=article with AI response aria-label", () => {
    render(<ChatStreamingIndicator statusMessage={null} streamingContent="x" />);
    expect(screen.getByRole("article")).toHaveAttribute("aria-label", "AI response");
  });
});