// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// STATE: React Context — UI navigation state (client-only tier, NOT server state)
import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

interface ChatNavContextValue {
  currentWorkspaceId: string | null;
  currentChatId: string | null;
  setWorkspaceId: (id: string | null) => void;
  setChatId: (id: string | null) => void;
  // ── Chat panel action state (quick 260723-nnr follow-up) ──
  // Lifted from useChatPanelState so the controls that trigger them can live in
  // the right console panel (RightPanel), which on desktop is rendered by App
  // as a sibling of the routed ChatPanel — both share only this context.
  // messageCount mirrors useChat's messages.length so the "Select messages"
  // label ("N of M selected") and the Save-to-Wiki gate work from RightPanel.
  selectionMode: boolean;
  setSelectionMode: React.Dispatch<React.SetStateAction<boolean>>;
  selectedMessageIds: Set<string>;
  setSelectedMessageIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  distillDialogOpen: boolean;
  setDistillDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  messageCount: number;
  setMessageCount: React.Dispatch<React.SetStateAction<number>>;
  // 260815-k5s: ephemeral archive selection for a brand-new chat (before the
  // first message). Lives in Context (not ChatPanel useState) because the
  // desktop RightPanel is a sibling of the routed ChatPanel — they share
  // only this context, and RightPanel both displays and mutates this value.
  // Once the chat is created (first message sent), currentChatId transitions
  // to non-null and the reset effect below clears it so the persisted
  // chat.archiveId becomes the source of truth.
  newChatArchiveId: string | null;
  setNewChatArchiveId: React.Dispatch<React.SetStateAction<string | null>>;
}

const ChatNavContext = createContext<ChatNavContextValue | null>(null);

const savedWorkspaceId = typeof localStorage !== "undefined" ? localStorage.getItem("lastWorkspaceId") : null;
const savedChatId = typeof localStorage !== "undefined" ? localStorage.getItem("lastChatId") : null;

// Module-level imperative setters for use in non-React callbacks (e.g. mutations)
let imperativeSetters: {
  setWorkspaceId: (id: string | null) => void;
  setChatId: (id: string | null) => void;
} | null = null;

export function setWorkspaceIdImperative(id: string | null) {
  if (imperativeSetters) {
    imperativeSetters.setWorkspaceId(id);
  } else if (typeof localStorage !== "undefined") {
    // Fallback if provider not mounted yet
    if (id) {
      localStorage.setItem("lastWorkspaceId", id);
    } else {
      localStorage.removeItem("lastWorkspaceId");
      localStorage.removeItem("lastChatId");
    }
  }
}

// Phase 180 dead-code sweep: the `setChatIdImperative()` companion was
// REMOVED — zero callers (chat navigation flows all go through the
// workspace-scoped setter + their own useState).

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(savedWorkspaceId);
  const [currentChatId, setCurrentChatId] = useState<string | null>(savedChatId);

  // Chat panel action state (lifted for RightPanel access — see interface comment).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [distillDialogOpen, setDistillDialogOpen] = useState(false);
  const [messageCount, setMessageCount] = useState(0);
  // 260815-k5s: ephemeral new-chat archive selection (see interface comment).
  const [newChatArchiveId, setNewChatArchiveId] = useState<string | null>(null);

  const setWorkspaceId = useCallback((id: string | null) => {
    setCurrentWorkspaceId(id);
    setCurrentChatId(null);
    if (id) {
      localStorage.setItem("lastWorkspaceId", id);
    } else {
      localStorage.removeItem("lastWorkspaceId");
      localStorage.removeItem("lastChatId");
    }
  }, []);

  const setChatId = useCallback((id: string | null) => {
    setCurrentChatId(id);
    if (id) {
      localStorage.setItem("lastChatId", id);
    } else {
      localStorage.removeItem("lastChatId");
    }
  }, []);

  React.useEffect(() => {
    imperativeSetters = { setWorkspaceId, setChatId };
    return () => { imperativeSetters = null; };
  }, [setWorkspaceId, setChatId]);

  // Reset message selection when the active chat changes so stale ids from a
  // previous chat never leak into WikiDistillDialog for a different chat.
  // 260815-k5s: also clear the ephemeral new-chat archive selection — once a
  // chat exists (currentChatId non-null) the persisted chat.archiveId is the
  // source of truth; and switching to another chat should never carry over
  // the previous new-chat pick.
  useEffect(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
    setNewChatArchiveId(null);
  }, [currentChatId, setSelectionMode, setSelectedMessageIds, setNewChatArchiveId]);

  return (
    <ChatNavContext.Provider
      value={{
        currentWorkspaceId,
        currentChatId,
        setWorkspaceId,
        setChatId,
        selectionMode,
        setSelectionMode,
        selectedMessageIds,
        setSelectedMessageIds,
        distillDialogOpen,
        setDistillDialogOpen,
        messageCount,
        setMessageCount,
        newChatArchiveId,
        setNewChatArchiveId,
      }}
    >
      {children}
    </ChatNavContext.Provider>
  );
}

export function useChatNav(): ChatNavContextValue {
  const ctx = useContext(ChatNavContext);
  if (!ctx) throw new Error("useChatNav must be used within ChatProvider");
  return ctx;
}