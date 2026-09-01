// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Permission gating helper for the 6 backup:* permissions defined in
 * `@simmetric-chat/shared`. Pattern mirrors `useFeature` (boolean from a single
 * object) but reads from `useMe().permissions` instead of the license store.
 *
 * Usage:
 *   const canWrite = useBackupPermission("backup:destination:write");
 *   <Button disabled={!canWrite} title={t("settings.backups.permissionDenied")}>
 *
 * The `BackupAction` type is derived from `PermissionName` so any typo in
 * the action argument is a compile-time error rather than a silent
 * always-disabled button.
 */

import { useMe } from "../queries/useAuth";
import type { PermissionName } from "@simmetric-chat/shared";

export type BackupAction = Extract<
  PermissionName,
  `backup:${string}`
>;

export function useBackupPermission(action: BackupAction): boolean {
  const { data: user } = useMe();
  if (!user) return false;
  return (user.permissions as readonly string[]).includes(action);
}
