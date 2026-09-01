// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { toast as sonnerToast } from "sonner";

export const showSuccess = (msg: string) => sonnerToast.success(msg);
export const showError = (msg: string) => sonnerToast.error(msg);
export const showInfo = (msg: string) => sonnerToast.info(msg);

export function toastWithAction(
  msg: string,
  actionLabel: string,
  onClick: () => void,
  type: "success" | "error" | "info" = "info"
) {
  const options = { action: { label: actionLabel, onClick } };
  if (type === "success") return sonnerToast.success(msg, options);
  if (type === "error") return sonnerToast.error(msg, options);
  return sonnerToast.info(msg, options);
}
