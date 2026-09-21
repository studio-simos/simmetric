// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SkillsPalette component tests — Phase 190 (SKIL-02/D-10).
 * Mirrors the ModelPalette.test.tsx shims (cmdk ResizeObserver + scrollIntoView
 * + react-i18next mock). The component is presentational: open/query/items ride
 * props from ChatPanel — assert callbacks, not internal state.
 */
import "@testing-library/jest-dom";

// cmdk requires ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom does not implement scrollIntoView
global.Element.prototype.scrollIntoView = jest.fn();

// Polyfill TextEncoder/TextDecoder for react-router-dom in jsdom
import { TextEncoder, TextDecoder } from "util";
(global as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
(global as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;

// Mock window.matchMedia for jsdom (radix-ui internals)
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

import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SkillsPalette from "../components/SkillsPalette";
import type { SkillsPaletteItem } from "../components/SkillsPalette";

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string, opts?: Record<string, string>) => {
      const map: Record<string, string> = {
        "chat.skillsPalette.empty": "No matching skills",
        "chat.skillsPalette.hint": "↑↓ to navigate, Enter to insert, Esc to close",
        "chat.skillsPalette.manageLink": "Manage skills",
        "chat.skillsPalette.customGroup": "Skills",
        "chat.skillsPalette.builtinGroup": "Built-in (LLM tools — not slash commands)",
      };
      let out = map[key] || defaultValue || key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
        }
      }
      return out;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const customItems: SkillsPaletteItem[] = [
  { slug: "translate", name: "custom_translate", description: "Translate text" },
  { slug: "summarize-doc", name: "custom_summarize_doc", description: "Summarize a document" },
  { slug: "code-review", name: "custom_code_review", description: "Review code" },
];

const builtinItems: SkillsPaletteItem[] = [
  { slug: "rag_search", name: "RAG Search", description: "Search documents" },
  { slug: "wiki_query", name: "Wiki Query", description: "Query the wiki" },
];

const renderPalette = (props: Partial<Parameters<typeof SkillsPalette>[0]> = {}) => {
  const onClose = jest.fn();
  const onSelect = jest.fn();
  render(
    <MemoryRouter>
      <SkillsPalette
        open={true}
        onClose={onClose}
        onSelect={onSelect}
        query="/"
        items={customItems}
        builtinItems={builtinItems}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onClose, onSelect };
};

describe("SkillsPalette", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the custom items from cached data (no fetch — presentational)", () => {
    renderPalette();
    expect(screen.getByTestId("skills-palette-item-translate")).toBeInTheDocument();
    expect(screen.getByTestId("skills-palette-item-summarize-doc")).toBeInTheDocument();
    expect(screen.getByText("/translate")).toBeInTheDocument();
  });

  it("filters items by the query derived from the input text", () => {
    renderPalette({ query: "/trans" });
    expect(screen.getByTestId("skills-palette-item-translate")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-palette-item-summarize-doc")).not.toBeInTheDocument();
  });

  it("filters case-insensitively on slug, name, and description", () => {
    renderPalette({ query: "/SUMMARIZE" });
    expect(screen.getByTestId("skills-palette-item-summarize-doc")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-palette-item-translate")).not.toBeInTheDocument();
  });

  it("filters on name and description text (not just slug)", () => {
    renderPalette({ query: "/review code" });
    expect(screen.getByTestId("skills-palette-item-code-review")).toBeInTheDocument();
  });

  it("caps selectable rows at 10 (11 custom items → 10 rendered)", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      slug: `skill-${i}`,
      name: `skill_${i}`,
      description: `Skill ${i}`,
    }));
    renderPalette({ items: eleven });
    expect(screen.getAllByTestId(/^skills-palette-item-/)).toHaveLength(10);
  });

  it("shows the empty copy + Manage skills link when nothing matches", () => {
    renderPalette({ query: "/zzz" });
    expect(screen.getByTestId("skills-palette-empty")).toBeInTheDocument();
    expect(screen.getByText("No matching skills")).toBeInTheDocument();
    expect(screen.getAllByText("Manage skills").length).toBeGreaterThanOrEqual(1);
  });

  it("calls onSelect with the slug and closes — the parent inserts, never sends", () => {
    const { onSelect, onClose } = renderPalette();
    fireEvent.click(screen.getByTestId("skills-palette-item-translate"));
    expect(onSelect).toHaveBeenCalledWith("translate");
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape calls onClose", () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the builtin group DISABLED (no onSelect wiring on click)", () => {
    const { onSelect } = renderPalette();
    const builtinRow = screen.getByTestId("skills-palette-builtin-rag_search");
    expect(builtinRow).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Built-in (LLM tools — not slash commands)")).toBeInTheDocument();

    // Clicking a disabled cmdk row must NOT fire onSelect.
    fireEvent.click(builtinRow);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disabled builtin rows do not consume the 10-selectable cap", () => {
    // 10 customs + 2 builtins: exactly 10 selectable rows render (the cap
    // counts SELECTABLE rows only), and both builtin rows still render.
    const ten = Array.from({ length: 10 }, (_, i) => ({
      slug: `skill-${i}`,
      name: `skill_${i}`,
      description: `Skill ${i}`,
    }));
    renderPalette({ items: ten });
    expect(screen.getAllByTestId(/^skills-palette-item-/)).toHaveLength(10);
    expect(screen.getByTestId("skills-palette-builtin-rag_search")).toBeInTheDocument();
    expect(screen.getByTestId("skills-palette-builtin-wiki_query")).toBeInTheDocument();
  });

  it("closes when a space follows the slug (space-disambiguation — args follow)", () => {
    const { onClose } = renderPalette({ query: "/translate " });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not render content when closed", () => {
    render(
      <MemoryRouter>
        <SkillsPalette
          open={false}
          onClose={jest.fn()}
          onSelect={jest.fn()}
          query="/"
          items={customItems}
          builtinItems={[]}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("skills-palette-item-translate")).not.toBeInTheDocument();
  });

  it("renders the footer hint row", () => {
    renderPalette();
    expect(screen.getByText("↑↓ to navigate, Enter to insert, Esc to close")).toBeInTheDocument();
  });

  it("no onSelect fires from the builtin group even after an Escape cycle", () => {
    const { onSelect, onClose } = renderPalette();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});