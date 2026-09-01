// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

const GLOBAL_DEFAULT_KEY = "globalDefaultModel";

export function getGlobalDefaultModel(): { providerId: string; model: string } | null {
  try {
    const raw = localStorage.getItem(GLOBAL_DEFAULT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setGlobalDefaultModel(selection: { providerId: string; model: string } | null) {
  if (selection) {
    localStorage.setItem(GLOBAL_DEFAULT_KEY, JSON.stringify(selection));
  } else {
    localStorage.removeItem(GLOBAL_DEFAULT_KEY);
  }
}
