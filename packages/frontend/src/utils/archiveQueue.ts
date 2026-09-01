// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

interface WikiEdit {
  runId: string;
  pageSlug: string;
  archiveId: string;
  destructive: boolean;
  timestamp: string;
}

let pendingEdits: WikiEdit[] = [];
let wikiHistory: WikiEdit[] = [];

export function addWikiEdit(data: unknown) {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const edit: WikiEdit = {
    runId: String(d.runId || d.id || Date.now()),
    pageSlug: String(d.pageSlug || d.slug || "unknown"),
    archiveId: String(d.archiveId || ""),
    destructive: !!d.destructive,
    timestamp: String(d.timestamp || new Date().toISOString()),
  };
  const action = String(d.action || "edit");
  if (action === "preview") {
    pendingEdits = [...pendingEdits, edit];
  }
  wikiHistory = [...wikiHistory, edit];
}

// Phase 180 dead-code sweep: the clearPendingEdits() / getPendingEdits() /
// getWikiHistory() readers were REMOVED — zero consumers (the wiki-edit
// buffer is written by addWikiEdit from the SSE handler; a future consumer
// will re-add a reader when the wiki-edit review UI lands).
