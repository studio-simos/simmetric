// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

export type OnSelectModel = (selection: { providerId: string; model: string } | null) => void;

let onSelectModelCallback: OnSelectModel | null = null;

export function setOnSelectModel(cb: OnSelectModel | null) {
  onSelectModelCallback = cb;
}

export function getOnSelectModel(): OnSelectModel | null {
  return onSelectModelCallback;
}
