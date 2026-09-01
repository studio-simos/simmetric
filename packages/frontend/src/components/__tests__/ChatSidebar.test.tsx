// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { renderWithProviders } from "../../__tests__/test-utils";
import ChatSidebar from "../ChatSidebar";

jest.mock("../../queries/useChats", () => ({
  useChats: () => ({ data: [], isLoading: false, error: null }),
  useChatFolders: () => ({ data: [], isLoading: false, error: null }),
  usePinChat: () => ({ mutate: jest.fn() }),
  useUnpinChat: () => ({ mutate: jest.fn() }),
  useMoveChat: () => ({ mutate: jest.fn() }),
  useCreateFolder: () => ({ mutate: jest.fn() }),
  useRenameFolder: () => ({ mutate: jest.fn() }),
  useDeleteFolder: () => ({ mutate: jest.fn() }),
  useDeleteChat: () => ({ mutate: jest.fn() }),
  useRenameChat: () => ({ mutate: jest.fn() }),
}));

// TODO: implement tests for CHAT-04 (drag-and-drop) and CHAT-07 (search)
describe("ChatSidebar", () => {
  it("renders without crashing", () => {
    renderWithProviders(
      <ChatSidebar
        workspaceId="ws-1"
        currentChatId=""
        onSelectChat={() => {}}
        onNewChat={() => {}}
      />
    );
  });
});