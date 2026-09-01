// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Jest setup for jsdom environment
// Mocks APIs not available in jsdom but required by Radix UI components

import "@testing-library/jest-dom";
import { TextEncoder, TextDecoder } from "util";

// Polyfill TextEncoder/TextDecoder for jsdom (required by react-router-dom v7)
Object.assign(global, { TextEncoder, TextDecoder });

global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}));

// Mock matchMedia for ThemeContext module-level init (jsdom does not implement it)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock scrollIntoView for Radix UI Select in jsdom
Element.prototype.scrollIntoView = jest.fn();

// Suppress console errors/warnings from React 19 in test output that are
// caused by jsdom limitations (e.g., form validation, pointer events)
const originalError = console.error;
console.error = (...args: unknown[]) => {
  if (
    typeof args[0] === "string" &&
    (args[0].includes("not wrapped in act") ||
      args[0].includes("ResizeObserver") ||
      args[0].includes("PointerEvent"))
  ) {
    return;
  }
  originalError.call(console, ...args);
};
