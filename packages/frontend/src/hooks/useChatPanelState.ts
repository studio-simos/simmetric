// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useState } from "react";
import type { SourceCitation } from "./useChat";
import type { WikiTooltipData } from "../components/WikiTooltip";

/**
 * Uploaded document metadata attached to an outgoing chat message.
 */
export interface UploadedDoc {
  id: string;
  name: string;
}

/** Shape of a persisted per-chat model selection. */
export interface PersistedModel {
  providerId?: string;
  model?: string;
}

interface UseChatPanelStateArgs {
  /** Persisted model for the active chat, mirrored into the override state. */
  persistedModel: PersistedModel | null;
}

/**
 * Centralizes ChatPanel's pure UI state cluster (input, modals, selection,
 * overrides, panels) so the orchestrator component stays readable.
 *
 * Only state with no external source dependencies lives here. Effects that
 * react to streaming, speech transcript, or window events remain in ChatPanel
 * because they depend on `useChat` / `useSpeechRecognition` / DOM listeners.
 *
 * Phase 80 (D-01): the ephemeral archive-selection state + first-archive seed
 * effect have been removed — `Chat.archiveId` is now the single source of
 * truth for the linked archive, read from the chat list query in ChatPanel.
 *
 * Returns a flat bag of state values + setters so the caller can destructure
 * exactly as if the `useState` calls were inlined. useState setters are stable
 * across renders, so this refactor is behavior-preserving.
 */
export function useChatPanelState({ persistedModel }: UseChatPanelStateArgs) {
  const [input, setInput] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [ttsPlaying, setTtsPlaying] = useState<string | null>(null);
  const [citationPanelSources, setCitationPanelSources] = useState<SourceCitation[] | null>(null);
  const [attachedDoc, setAttachedDoc] = useState<UploadedDoc | null>(null);
  const [uploading, setUploading] = useState(false);
  const [modelOverride, setModelOverride] = useState<PersistedModel | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const [wikiTooltip, setWikiTooltip] = useState<WikiTooltipData | null>(null);
  const [wikiModalSlug, setWikiModalSlug] = useState<string | null>(null);
  const [wikiCreateSlug, setWikiCreateSlug] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editInput, setEditInput] = useState("");
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState<string | null>(null);
  // Quick 260829-spj: global "Show DLP texts" preference for DLPNotice across
  // the conversation. Session-scoped (default OFF, no persistence) — mirrors
  // the isComparing session-state pattern. Rendered deep in ChatMessage via
  // DLPNotice, but the prop chain is short, so no Context is warranted.
  const [showDlpTexts, setShowDlpTexts] = useState(false);

  // Mirror the active chat's persisted model into the override state on chat change.
  useEffect(() => {
    setModelOverride(persistedModel);
  }, [persistedModel]);

  return {
    input,
    setInput,
    editingName,
    setEditingName,
    nameInput,
    setNameInput,
    ttsPlaying,
    setTtsPlaying,
    citationPanelSources,
    setCitationPanelSources,
    attachedDoc,
    setAttachedDoc,
    uploading,
    setUploading,
    modelOverride,
    setModelOverride,
    isComparing,
    setIsComparing,
    wikiTooltip,
    setWikiTooltip,
    wikiModalSlug,
    setWikiModalSlug,
    wikiCreateSlug,
    setWikiCreateSlug,
    editingMessageId,
    setEditingMessageId,
    editInput,
    setEditInput,
    deletingMessageId,
    setDeletingMessageId,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    statusAnnouncement,
    setStatusAnnouncement,
    showDlpTexts,
    setShowDlpTexts,
  };
}

