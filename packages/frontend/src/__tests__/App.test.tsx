// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Frontend shadcn/ui setup verification test.
 * Confirms the component library renders without errors in the test environment.
 */

// Mock i18next before any imports
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";

describe("shadcn/ui setup verification", () => {
  it("renders a Button component and asserts it mounts", () => {
    render(<Button>test</Button>);
    const button = screen.getByRole("button", { name: /test/i });
    expect(button).toBeInTheDocument();
  });
});
