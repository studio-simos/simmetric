// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

let counter = 0;
const v4 = jest.fn().mockImplementation(() => {
  counter++;
  const hex = counter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
});

module.exports = {
  v4,
  v1: jest.fn(),
  v3: jest.fn(),
  v5: jest.fn(),
  NIL: "00000000-0000-0000-0000-000000000000",
  parse: jest.fn(),
  stringify: jest.fn(),
  validate: jest.fn().mockReturnValue(true),
  version: jest.fn(),
};
