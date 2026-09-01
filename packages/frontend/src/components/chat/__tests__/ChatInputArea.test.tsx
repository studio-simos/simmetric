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
});