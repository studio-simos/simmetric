// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ComparisonPane component tests — Card presence and streaming skeleton
 */
import "@testing-library/jest-dom";

// Polyfill TextEncoder/TextDecoder for react-router-dom in jsdom
import { TextEncoder, TextDecoder } from "util";
(global as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
(global as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;

// Mock window.matchMedia for jsdom
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

import { screen } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import ComparisonPane from "../components/ComparisonPane";

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue || key,
    i18n: { language: "en" },
  }),
}));

jest.mock("../queries/useProviders", () => ({
  useAvailableModels: () => ({ data: [], isLoading: false, error: null }),
}));

// Mock auth hooks
jest.mock("../queries/useAuth", () => ({
  useMe: () => ({ data: { id: "u1", username: "Test User", avatar: null } }),
  useLogout: () => ({ mutate: jest.fn() }),
}));

// Mock ModelSelector
jest.mock("../components/ModelSelector", () => ({
  __esModule: true,
  default: () => null,
}));

// Mock markdown renderer
jest.mock("../utils/markdown", () => ({
  renderMarkdown: (text: string) => text,
}));

const mockChat = (overrides?: Record<string, unknown>) => ({
  messages: [],
  isStreaming: false,
  streamingContent: "",
  statusMessage: null,
  currentChatId: null,
  chatName: null,
  error: null,
  persistedModel: null,
  sendMessage: jest.fn(),
  loadChat: jest.fn(),
  clearChat: jest.fn(),
  abortStream: jest.fn(),
  removeMessage: jest.fn(),
  renameChat: jest.fn(),
  updateChatModel: jest.fn(),
  setMessages: jest.fn(),
  ...overrides,
});

describe("ComparisonPane", () => {
  it("renders messages inside Card containers with sender badges", () => {
    const chat = mockChat({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello",
          metadata: {},
          createdAt: new Date().toISOString(),
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "Hi there",
          metadata: { modelUsed: "gemma4:latest" },
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const { container } = renderWithProviders(
      <ComparisonPane
        chat={chat}
        modelOverride={{ providerId: "p1", model: "gemma4:latest" }}
        onModelChange={jest.fn()}
        isStale={false}
      />
    );

    const cards = container.querySelectorAll('[data-slot="card"]');
    expect(cards.length).toBeGreaterThanOrEqual(2);

    expect(screen.getByText("common.you")).toBeInTheDocument();
    expect(screen.getByText("common.assistant")).toBeInTheDocument();
    expect(screen.getByText("gemma4:latest")).toBeInTheDocument();
  });

  it("renders Skeleton placeholder during streaming before content arrives", () => {
    const chat = mockChat({
      isStreaming: true,
      streamingContent: "",
      statusMessage: null,
    });

    const { container } = renderWithProviders(
      <ComparisonPane
        chat={chat}
        modelOverride={null}
        onModelChange={jest.fn()}
        isStale={false}
      />
    );

    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it("renders streaming content inside Card with Assistant badge", () => {
    const chat = mockChat({
      isStreaming: true,
      streamingContent: "Some streamed text",
      statusMessage: null,
    });

    const { container } = renderWithProviders(
      <ComparisonPane
        chat={chat}
        modelOverride={null}
        onModelChange={jest.fn()}
        isStale={false}
      />
    );

    const cards = container.querySelectorAll('[data-slot="card"]');
    expect(cards.length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText("common.assistant")).toBeInTheDocument();
    expect(screen.getByText("Some streamed text")).toBeInTheDocument();
  });
});
