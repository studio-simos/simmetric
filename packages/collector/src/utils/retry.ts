// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { logger } from "./logger";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * @param fn The async function to execute.
 * @param options.maxRetries Maximum number of retry attempts (default: 3).
 * @param options.baseDelayMs Base delay in milliseconds before the first retry (default: 500).
 * @param options.onRetry Optional callback invoked on each retry with the error and attempt number.
 * @returns The result of fn.
 * @throws The last error encountered if all retries are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 500, onRetry } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      if (onRetry) {
        onRetry(lastError, attempt + 1);
      }
      logger.warn(`[retry] Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`);
      await sleep(delay);
    }
  }

  // This line is theoretically unreachable, but satisfies TypeScript.
  throw lastError ?? new Error("Retry loop exhausted with no error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
