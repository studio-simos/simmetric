// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 199 (199-04, ECCO-05 §7.9-1 / UI-SPEC A-11) — ChatSidebar connector
 * platform badge pins.
 *
 * renderChatRow renders a 16px lucide glyph BEFORE the chat name when
 * connectorPlatform is set (telegram → MessageCircle, discord →
 * MessagesSquare — the shared PLATFORM_GLYPHS map from SettingsConnectors,
 * one map per app per the D-10 discretion), text-muted-foreground, wrapped in
 * a Tooltip with the localized platform name, carrying role="img" + a
 * localized aria-label. Both panel and sheet variants share the renderer, so
 * the badge rides every section. Non-connector chats (absent field) render
 * pixel-identically to today — the badge branch keys ONLY on the nullable
 * field's presence.
 */

import "@testing-library/jest-dom";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../__tests__/test-utils";
import ChatSidebar from "../ChatSidebar";

// Mock row shape mirrors ChatSummary plus the additive connectorPlatform
// field (declared locally so RED compiles before GREEN widens ChatSummary).
interface MockChatRow {
  id: string;
  name: string;
  workspaceId: string;
  updatedAt: string;
  createdAt: string;
  isPinned?: boolean;
  folderId?: string | null;
  connectorPlatform?: string | null;
}

let mockChats: MockChatRow[] = [];
let mockFolders: Array<{ id: string; name: string }> = [];

jest.mock("../../queries/useChats", () => ({
  useChats: () => ({ data: mockChats, isLoading: false, error: null }),
  useChatFolders: () => ({ data: mockFolders, isLoading: false, error: null }),
  usePinChat: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
  useUnpinChat: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
  useMoveChat: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
  useCreateFolder: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
  useRenameFolder: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
  useDeleteFolder: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
  useDeleteChat: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
  useRenameChat: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
}));

// Key-passthrough i18n mock (the SettingsMcpConnections/SettingsConnectors
// precedent) — aria-label assertions key on the localized-key string.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

function baseChat(overrides: Partial<MockChatRow> = {}): MockChatRow {
  return {
    id: "chat-badge-1",
    name: "Discord: alice",
    workspaceId: "ws-1",
    updatedAt: "2026-09-23T09:00:00Z",
    createdAt: "2026-09-23T08:00:00Z",
    ...overrides,
  };
}

function renderSidebar() {
  return renderWithProviders(
    <ChatSidebar
      workspaceId="ws-1"
      currentChatId=""
      onSelectChat={() => {}}
      onNewChat={() => {}}
    />,
  );
}

describe("ChatSidebar connector platform badge (199-04, A-11)", () => {
  beforeEach(() => {
    mockChats = [];
    mockFolders = [];
  });

  it("renders the platform glyph (role=img, localized aria-label) for a connectorPlatform 'discord' chat row", () => {
    mockChats = [baseChat({ connectorPlatform: "discord" })];
    renderSidebar();
    const glyph = screen.getByRole("img", {
      name: "settings.connectors.platform.discord",
    });
    expect(glyph).toBeInTheDocument();
  });

  it("renders the platform glyph for a 'telegram' chat row", () => {
    mockChats = [baseChat({ id: "chat-badge-2", connectorPlatform: "telegram" })];
    renderSidebar();
    const glyph = screen.getByRole("img", {
      name: "settings.connectors.platform.telegram",
    });
    expect(glyph).toBeInTheDocument();
  });

  it("renders NO glyph for a plain chat row (absent field → pixel-identical to today)", () => {
    mockChats = [baseChat()];
    renderSidebar();
    // The badge branch keys ONLY on the nullable field's presence — nothing
    // renders for non-connector chats.
    expect(
      screen.queryByRole("img", { name: /settings\.connectors\.platform\./ }),
    ).not.toBeInTheDocument();
    // The row itself still renders its name + date (the unchanged markup).
    expect(screen.getByText("Discord: alice")).toBeInTheDocument();
  });

  it("renders NO glyph for a null connectorPlatform chat row (explicit null = absent)", () => {
    mockChats = [baseChat({ connectorPlatform: null })];
    renderSidebar();
    expect(
      screen.queryByRole("img", { name: /settings\.connectors\.platform\./ }),
    ).not.toBeInTheDocument();
  });
});