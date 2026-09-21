// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatInputArea } from "../ChatInputArea";

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

function setup(overrides: Record<string, unknown> = {}) {
  const handlers = {
    onChange: jest.fn(),
    onKeyDown: jest.fn(),
    onSend: jest.fn(),
    onAbort: jest.fn(),
  };
  const props = {
    value: "",
    onChange: handlers.onChange,
    onKeyDown: handlers.onKeyDown,
    onSend: handlers.onSend,
    isStreaming: false,
    onAbort: handlers.onAbort,
    ...overrides,
  };
  return { handlers, props };
}

describe("ChatInputArea", () => {
  it("send button is disabled when input is empty", () => {
    const { props } = setup();
    render(<ChatInputArea {...props} />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("send button is enabled when input has non-whitespace text", () => {
    const { props } = setup({ value: "Hello" });
    render(<ChatInputArea {...props} />);
    expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled();
  });

  it("send button stays disabled for whitespace-only input", () => {
    const { props } = setup({ value: "   " });
    render(<ChatInputArea {...props} />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("calls onSend on click and applies the glow pulse class", () => {
    const { props, handlers } = setup({ value: "Hello" });
    render(<ChatInputArea {...props} />);
    const sendBtn = screen.getByRole("button", { name: "Send message" });
    fireEvent.click(sendBtn);
    expect(handlers.onSend).toHaveBeenCalledTimes(1);
    expect(sendBtn.className).toContain("send-glow");
    expect(sendBtn.className).toContain("send-press");
  });

  it("shows a Stop button that calls onAbort while streaming", () => {
    const { props, handlers } = setup({ isStreaming: true });
    render(<ChatInputArea {...props} />);
    const stopBtn = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stopBtn);
    expect(handlers.onAbort).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  });

  it("textarea has an accessible aria-label", () => {
    const { props } = setup({ value: "hi" });
    render(<ChatInputArea {...props} />);
    expect(screen.getByLabelText("Message input")).toBeInTheDocument();
  });

  it("renders the attached document name with a remove button", () => {
    const onRemoveAttachment = jest.fn();
    const { props } = setup({ attachedDocName: "notes.pdf", onRemoveAttachment });
    render(<ChatInputArea {...props} />);
    expect(screen.getByText("notes.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
  });

  // ── quick 260919-qjg: Knowledge submenu inside the more-actions popover ──
  // (supersedes the 191-05 WR-03 close-on-click contract: the archive list
  // moved INTO the popover, so the Knowledge item now KEEPS it open and
  // reveals the submenu group; the popover close + back row reset it.)

  function submenuProps() {
    return setup({
      onAttachArchive: jest.fn(),
      onKnowledgeBack: jest.fn(),
      archivePickerPanel: <div data-testid="panel-slot">PANEL</div>,
    });
  }

  it("keeps the popover open on the Knowledge item click and reveals the submenu (260919-qjg)", async () => {
    const { props } = submenuProps();
    const { act } = await import("@testing-library/react");
    render(<ChatInputArea {...(props as Record<string, unknown>)} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    });
    const knowledgeItem = screen.getByRole("button", { name: "Knowledge" });
    expect(knowledgeItem).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(knowledgeItem);
    });
    await new Promise((r) => setTimeout(r, 0));
    // The popover stays open and the submenu group renders INSIDE it.
    expect(knowledgeItem).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.getByTestId("panel-slot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect((props as { onAttachArchive: jest.Mock }).onAttachArchive).toHaveBeenCalledTimes(1);
  });

  it("clicking the Back row calls onKnowledgeBack and returns to the main menu", async () => {
    const { props } = submenuProps();
    const { act } = await import("@testing-library/react");
    render(<ChatInputArea {...(props as Record<string, unknown>)} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    });
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
    });
    expect((props as { onKnowledgeBack: jest.Mock }).onKnowledgeBack).toHaveBeenCalledTimes(1);
    // Back to the main menu: Knowledge row visible, submenu group gone.
    expect(screen.getByRole("button", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Knowledge" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("panel-slot")).not.toBeInTheDocument();
  });

  it("hides the DLP toggle slot while the submenu is open", async () => {
    const { props } = submenuProps();
    (props as Record<string, unknown>).dlpToggle = <div data-testid="dlp-slot">DLP</div>;
    const { act } = await import("@testing-library/react");
    render(<ChatInputArea {...(props as Record<string, unknown>)} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    });
    expect(screen.getByTestId("dlp-slot")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    });
    expect(screen.queryByTestId("dlp-slot")).not.toBeInTheDocument();
  });

  it("resets to the main menu after the popover closes and reopens", async () => {
    const { props } = submenuProps();
    const { act } = await import("@testing-library/react");
    render(<ChatInputArea {...(props as Record<string, unknown>)} />);

    // Open, enter the submenu.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    });
    expect(screen.getByTestId("panel-slot")).toBeInTheDocument();

    // Close the popover via Radix's outside-dismiss path: a pointerdown+
    // pointerup OUTSIDE the popover content (jsdom lacks PointerEvent —
    // synthesize it). The controlled state is driven through onOpenChange.
    await act(async () => {
      const evt = new CustomEvent("pointerdown", { bubbles: true });
      (evt as unknown as { pointerId: number }).pointerId = 1;
      document.dispatchEvent(evt);
      const up = new CustomEvent("pointerup", { bubbles: true });
      (up as unknown as { pointerId: number }).pointerId = 1;
      document.dispatchEvent(up);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: "Knowledge" })).not.toBeInTheDocument();

    // Reopen → main menu, not the submenu.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("button", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.queryByTestId("panel-slot")).not.toBeInTheDocument();
  });

  it("renders the attach-document voice with the short 'Attach' label", () => {
    const { props } = setup();
    render(<ChatInputArea {...(props as Record<string, unknown>)} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getAllByText("Attach").length).toBeGreaterThan(0);
  });
});