// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Mock archiver for Jest — archiver@8 is ESM-only.
 */

export default function archiver(_format: string, _options?: any) {
  return {
    on: jest.fn(),
    pipe: jest.fn(),
    directory: jest.fn(),
    finalize: jest.fn().mockResolvedValue(undefined),
  };
}
