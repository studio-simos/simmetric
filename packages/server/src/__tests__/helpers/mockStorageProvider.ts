// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 184 (SAAS-03) — shared mock surface for getStorageProvider in route
 * suites. The hoisted jest.mock factory in each suite references
 * `mockStorageProviderModule` (a stable object whose fns the suites mutate
 * per-test via the exported handles).
 */

export const mockProviderPut = jest.fn().mockResolvedValue({ key: "k", size: 0 });
export const mockProviderGet = jest.fn().mockResolvedValue(Buffer.from("x"));
export const mockProviderDelete = jest.fn().mockResolvedValue(undefined);
export const mockProviderExists = jest.fn().mockResolvedValue(false);
export const mockProviderGetReadStream = jest.fn();

export const mockGetStorageProvider = jest.fn().mockResolvedValue({
  put: mockProviderPut,
  get: mockProviderGet,
  getReadStream: mockProviderGetReadStream,
  delete: mockProviderDelete,
  exists: mockProviderExists,
});

export const mockStorageProviderModule = {
  getStorageProvider: (...args: unknown[]) => mockGetStorageProvider(...args),
  LocalFSProvider: class LocalFSProviderStub {},
};