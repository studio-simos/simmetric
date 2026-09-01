// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsWebSearch component tests — Phase 99, WEB-01 (Plan 99-02)
 *
 * Covers the provider Select (SearXNG/Tavily options rendered), the
 * SearXNG URL input (visible only when provider === "searxng"), and the
 * Tavily key note (visible only when provider === "tavily").
 *
 * Radix Select primitives are mocked to simple HTML controls so jsdom can
 * drive them without pointer events/portals — same pattern as the Radix Tabs
 * mock in SettingsPage.test.tsx.
 */
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, act } from "@testing-library/react";

const mockGetValue = jest.fn().mockReturnValue("");
const mockUpdateSettings = jest.fn().mockResolvedValue(undefined);

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
}));

jest.mock("../utils/errorUtils", () => ({
  getErrorMessage: (err: unknown) => (err instanceof Error ? err.message : "error"),
}));

jest.mock("../queries/useSettings", () => ({
  useSettingsHelpers: () => ({ getValue: mockGetValue, isReadOnly: jest.fn().mockReturnValue(false) }),
  useUpdateSettings: () => ({ mutateAsync: mockUpdateSettings }),
}));

// Mock the Radix-based shadcn Select primitives with plain HTML controls that
// jsdom can drive (Radix Select uses pointer events + portals that jsdom does
// not support well — same approach as the Radix Tabs mock in SettingsPage.test).
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const Ctx = React.createContext<{ value: string; onValueChange: (v: string) => void }>({
    value: "",
    onValueChange: () => {},
  });
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange?: (v: string) => void;
      children?: ReactNode;
    }) => (
      <Ctx.Provider value={{ value: value ?? "", onValueChange: onValueChange ?? (() => {}) }}>
        {children}
      </Ctx.Provider>
    ),
    SelectTrigger: ({ children, id }: { children?: ReactNode; id?: string }) => (
      <div data-testid="select-trigger" id={id}>
        {children}
      </div>
    ),
    SelectValue: () => {
      const ctx = React.useContext(Ctx);
      return <span data-testid="select-value">{ctx.value}</span>;
    },
    SelectContent: ({ children }: { children?: ReactNode }) => (
      <div data-testid="select-content">{children}</div>
    ),
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return (
        <button
          type="button"
          data-testid={`select-item-${value}`}
          data-value={value}
          data-selected={ctx.value === value}
          onClick={() => ctx.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

jest.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
jest.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
    ...rest
  }: { children?: ReactNode; htmlFor?: string } & React.HTMLAttributes<HTMLLabelElement>) => (
    <label htmlFor={htmlFor} {...rest}>
      {children}
    </label>
  ),
}));

import SettingsWebSearch from "../components/SettingsWebSearch";

describe("SettingsWebSearch (Phase 99, WEB-01)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValue.mockReturnValue("");
    mockUpdateSettings.mockResolvedValue(undefined);
  });

  it("renders the provider Select with SearXNG and Tavily options", () => {
    render(<SettingsWebSearch />);

    expect(screen.getByTestId("select-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("select-item-searxng")).toBeInTheDocument();
    expect(screen.getByTestId("select-item-tavily")).toBeInTheDocument();
  });

  it("provider=searxng: renders the SearXNG URL input and NOT the Tavily key note", () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === "web_search_provider") return "searxng";
      if (key === "searxng_url") return "";
      return "";
    });

    render(<SettingsWebSearch />);

    expect(screen.getByText("settings.webSearch.searxngUrl")).toBeInTheDocument();
    expect(document.getElementById("searxng-url")).toBeInTheDocument();
    expect(screen.queryByText("settings.webSearch.tavilyKeyNote")).not.toBeInTheDocument();
  });

  it("provider=tavily: renders the Tavily key note and NOT the SearXNG URL input", () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === "web_search_provider") return "tavily";
      if (key === "searxng_url") return "";
      return "";
    });

    render(<SettingsWebSearch />);

    expect(screen.getByText("settings.webSearch.tavilyKeyNote")).toBeInTheDocument();
    expect(screen.queryByText("settings.webSearch.searxngUrl")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.webSearch.searxngUrlPlaceholder")).not.toBeInTheDocument();
  });

  it("switching provider to tavily calls updateSettings with web_search_provider=tavily", async () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === "web_search_provider") return "searxng";
      return "";
    });

    render(<SettingsWebSearch />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("select-item-tavily"));
      // Flush the microtask queue so the async handleProviderChange resolves.
      await Promise.resolve();
    });

    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    const callArg = mockUpdateSettings.mock.calls[0][0] as Array<{ key: string; value: string }>;
    expect(callArg).toEqual([{ key: "web_search_provider", value: "tavily" }]);
  });
});