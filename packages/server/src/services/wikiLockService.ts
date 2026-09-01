// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Per-page async lock primitive for wiki write operations.
 *
 * Prevents concurrent writes to the same archive page by chaining
 * promises on a module-level Map keyed by `${archiveId}:${slug}`.
 *
 * The lock spans filesystem write, database update, and git commit
 * to prevent interleaved writes that could corrupt page state or
 * git history.
 */

const pageLocks = new Map<string, Promise<unknown>>();

/**
 * Acquire a per-page async lock and execute `fn` exclusively.
 *
 * The lock is released in a `.finally()` block once `fn` completes
 * or throws. If multiple callers request the same lock concurrently,
 * they are serialized in FIFO order.
 *
 * @param archiveId - The archive UUID
 * @param slug - The page slug
 * @param fn - The async function to run under the lock
 * @returns The result of `fn`
 */
export async function withPageLock<T>(
  archiveId: string,
  slug: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${archiveId}:${slug}`;
  const previous = pageLocks.get(key);
  const next = (previous || Promise.resolve())
    .then(() => fn())
    .finally(() => {
      if (pageLocks.get(key) === next) {
        pageLocks.delete(key);
      }
    });
  pageLocks.set(key, next);
  return next as Promise<T>;
}
