// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatMessageList } from "../ChatMessageList";
import { ChatMessage as ChatMessageComponent } from "../ChatMessage";
import type { ChatMessage } from "../../../hooks/useChat";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === "string") return opts;
      if (opts && typeof opts === "object" && "defaultValue" in opts) {
        return String(opts.defaultValue);
      }
      return key;
    },
  }),
}));

// Stub out the icon/button-heavy subcomponents so the real ChatMessage can
// render in isolation. Only the disclaimer markup + role branching matters
// for the branding assertions; the rest of the footer/header is irrelevant.
jest.mock("../ChatModelBadge", () => ({
  ChatModelBadge: () => <span data-testid="model-badge" />,
}));
jest.mock("../ChatCitations", () => ({
  ChatCitations: () => null,
}));
jest.mock("../PipelineInfo", () => ({
  PipelineInfo: () => null,
}));
jest.mock("../DLPNotice", () => ({
  DLPNotice: () => null,
}));
jest.mock("../../../lib/toast", () => ({ showSuccess: jest.fn() }));
jest.mock("../../../utils/markdown", () => ({
  renderMarkdown: (s: string) => s,
}));
jest.mock("../../SettingsProfile", () => ({ getInitials: () => "U" }));
// Tooltip passthrough (no TooltipProvider in jsdom — avoid Radix noise), mirroring
// the McpHelpPopover test convention.
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

const msgs: ChatMessage[] = [
  { id: "m1", role: "user", content: "Hello", createdAt: "2026-01-01T00:00:00Z" },
  { id: "m2", role: "assistant", content: "Hi there", createdAt: "2026-01-01T00:00:01Z" },
  { id: "m3", role: "user", content: "Bye", createdAt: "2026-01-01T00:00:02Z" },
];

const renderMessage = (m: ChatMessage) => <div data-testid={`msg-${m.role}`}>{m.content}</div>;

describe("ChatMessageList", () => {
  it("renders as a role=log aria-live=polite container", () => {
    render(
      <ChatMessageList
        messages={[]}
        isStreaming={false}
        streamingContent=""
        statusMessage={null}
        renderMessage={renderMessage}
      />
    );
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
  });

  it("renders messages in order and wraps each in role=article", () => {
    render(
      <ChatMessageList
        messages={msgs}
        isStreaming={false}
        streamingContent=""
        statusMessage={null}
        renderMessage={renderMessage}
      />
    );
    const items = screen.getAllByRole("article");
    expect(items).toHaveLength(3);
    expect(items[0]!).toHaveAttribute("aria-label", "User message");
    expect(items[1]!).toHaveAttribute("aria-label", "AI response");
    expect(items[2]!).toHaveAttribute("aria-label", "User message");
    // order preserved
    expect(screen.getAllByTestId(/msg-/).map((e) => e.textContent)).toEqual([
      "Hello",
      "Hi there",
      "Bye",
    ]);
  });

  it("applies the user/assistant animation classes", () => {
    render(
      <ChatMessageList
        messages={msgs}
        isStreaming={false}
        streamingContent=""
        statusMessage={null}
        renderMessage={renderMessage}
      />
    );
    const items = screen.getAllByRole("article");
    expect(items[0]!.className).toContain("chat-msg-user");
    expect(items[1]!.className).toContain("chat-msg-ai");
  });

  it("shows the empty state when there are no messages and not streaming", () => {
    render(
      <ChatMessageList
        messages={[]}
        isStreaming={false}
        streamingContent=""
        statusMessage={null}
        emptyState={<div>empty-marker</div>}
        renderMessage={renderMessage}
      />
    );
    expect(screen.getByText("empty-marker")).toBeInTheDocument();
  });

  it("renders the streaming status spinner while streaming with no content", () => {
    render(
      <ChatMessageList
        messages={[]}
        isStreaming={true}
        streamingContent=""
        statusMessage="Thinking..."
        renderMessage={renderMessage}
      />
    );
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("announces the status once via a visually-hidden role=status region", () => {
    render(
      <ChatMessageList
        messages={[]}
        isStreaming={false}
        streamingContent=""
        statusMessage={null}
        statusAnnouncement="Response complete"
        renderMessage={renderMessage}
      />
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Response complete");
    expect(status).toHaveClass("sr-only");
  });
});

// ─── Phase 149 (Branding) — AI disclaimer assertions ───
// Renders the REAL ChatMessage component (not the renderMessage stub) to verify
// the `chat.aiDisclaimer` markup lives in the assistant branch only. The mock
// `t()` returns the fallback string ("Le risposte…") so we can query for it
// without loading the locale files.
const DISCLAIMER_FALLBACK = "Le risposte sono generate tramite intelligenza artificiale";

const baseAssistantProps = {
  isHackerTheme: false,
  authUser: null,
  isLastUserMessage: false,
  selectionMode: false,
  selected: false,
  ttsPlayingId: null,
  onToggleSelect: jest.fn(),
  onRegenerate: jest.fn(),
  onReadAloud: jest.fn(),
  onEditStart: jest.fn(),
  onDelete: jest.fn(),
  onCitationsOpen: jest.fn(),
  editing: false,
  editInput: "",
  onEditInputChange: jest.fn(),
  onEditSave: jest.fn(),
  onEditCancel: jest.fn(),
};

describe("ChatMessage — AI disclaimer (Phase 149)", () => {
  it("renders the AI disclaimer below an assistant message body", () => {
    render(
      <ChatMessageComponent
        {...baseAssistantProps}
        message={{ id: "a1", role: "assistant", content: "Sure, here is the answer.", createdAt: "2026-01-01T00:00:00Z" }}
      />,
    );
    const disclaimer = screen.getByTestId("ai-disclaimer");
    expect(disclaimer).toBeInTheDocument();
    expect(disclaimer).toHaveClass("text-xs");
    expect(disclaimer).toHaveClass("text-muted-foreground");
    expect(disclaimer).toHaveTextContent(DISCLAIMER_FALLBACK);
  });

  it("does NOT render the AI disclaimer for a user message (D-05)", () => {
    render(
      <ChatMessageComponent
        {...baseAssistantProps}
        message={{ id: "u1", role: "user", content: "Question?", createdAt: "2026-01-01T00:00:00Z" }}
      />,
    );
    expect(screen.queryByTestId("ai-disclaimer")).toBeNull();
    expect(screen.queryByText(DISCLAIMER_FALLBACK)).toBeNull();
  });
});