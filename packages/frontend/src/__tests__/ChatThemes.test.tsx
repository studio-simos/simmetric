// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 4.10.3 — Visual / theme tests for the 3 chat themes (dark, light, hacker).
 *
 * Lives in the top-level __tests__/ dir (alongside chat-flow.integration.test)
 * because it is a cross-cutting contract test — it parses the global
 * chat-theme.css + index.css and exercises ThemeContext across the app, so it
 * is not a unit test of a single chat component. tsconfig excludes this dir,
 * so the Node `fs`/`path`/`__dirname` usage below is not type-checked (it
 * transpiles via ts-jest and runs under Node, where they exist).
 *
 * Repo convention: NO jest snapshots (0 snapshots exist — see TODO 3.8). We
 * use structural + contract assertions instead. The reason snapshots are
 * non-informative here is architectural: chat theming is CSS-driven, not
 * DOM-driven. The chat components reference `var(--chat-*)` tokens and render
 * IDENTICAL markup in every theme — the per-theme differences live entirely
 * in `styles/chat-theme.css` (selected by the `.dark` / `.theme-hacker`
 * classes that ThemeContext toggles on <html>). A per-theme React snapshot
 * would be three identical trees.
 *
 * So this file tests the real theme contract at three layers:
 *
 *  1. CSS contract (parses the actual `chat-theme.css` + `index.css` source):
 *     - every theme defines the full `--chat-*` variable set
 *     - WCAG AA contrast for the text/background pairs in each theme
 *     - the `@media (prefers-reduced-motion: reduce)` block disables every
 *       animation/transition declared for chat elements
 *
 *  2. Theme application: ThemeContext toggles the right <html> classes
 *     (light → none, dark → `.dark`, hacker → `.dark` + `.theme-hacker`).
 *
 *  3. Component DOM invariance: a chat component renders the same theme hooks
 *     (e.g. `.chat-cursor`) under all three <html> class states — proving the
 *     theme is carried by CSS, not by conditional React rendering.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
// Node builtins — read the real stylesheet source so the contract test
// asserts the shipped artifact, not a copy. Require form avoids the
// esModuleInterop warning (no-require-imports is off in this repo's eslint).
const fs = require("fs");
const path = require("path");
import { ChatStreamingIndicator } from "../components/chat/ChatStreamingIndicator";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_k: string, d?: unknown) => (typeof d === "string" ? d : _k) }),
}));

// --- matchMedia must exist before ThemeContext is imported (it reads
// prefers-color-scheme at module load). jsdom does not implement matchMedia,
// so we stub it once, up front. ThemeContext is imported lazily inside the
// application test so this stub is in place first. -------------------------
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }),
});

// ===========================================================================
//  Color + CSS parsing helpers (oklch → sRGB → WCAG relative luminance)
// ===========================================================================

type Rgb = { r: number; g: number; b: number; a: number };
type VarMap = Map<string, string>;

/** OKLab/OKLCH → linear sRGB → gamma-encoded sRGB (0..1). */
function oklchToSrgb(L: number, C: number, H: number): [number, number, number] {
  const hr = (H * Math.PI) / 180;
  const a = Math.cos(hr) * C;
  const b = Math.sin(hr) * C;
  const l = L + 0.3963377774 * a + 0.2157987536 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l_ = l ** 3;
  const m_ = m ** 3;
  const s_ = s ** 3;
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574051 * m_ - 0.3413193965 * s_;
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  return [r, g, bl].map((c) => Math.max(0, Math.min(1, encode(c)))) as [number, number, number];
}

/** Parse a single CSS color value (hex / rgb / rgba / oklch) into sRGB 0..1. */
function parseAtomicColor(input: string): Rgb {
  const v = input.trim();
  // oklch(L C H) or oklch(L C H / A)
  const oklch = v.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/i);
  if (oklch) {
    const [r, g, b] = oklchToSrgb(+oklch[1], +oklch[2], +oklch[3]);
    return { r, g, b, a: oklch[4] !== undefined ? +oklch[4] : 1 };
  }
  // #rgb / #rrggbb
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
      a: 1,
    };
  }
  // rgb() / rgba() — accepts legacy comma form `rgba(255, 255, 255, 0.04)`
  // and modern space form `rgb(255 255 255 / 0.04)`.
  const rgx = v.match(
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[, ]\s*([\d.]+)|\s*\/\s*([\d.]+))?\s*\)$/i,
  );
  if (rgx) {
    const a = rgx[4] !== undefined ? +rgx[4] : rgx[5] !== undefined ? +rgx[5] : 1;
    return { r: +rgx[1] / 255, g: +rgx[2] / 255, b: +rgx[3] / 255, a };
  }
  throw new Error(`Unsupported color format: "${input}"`);
}

/** Resolve a CSS value that may be `var(--x)` (with optional fallback) into a
 *  concrete color, recursively walking the theme variable map. */
function resolveColor(value: string, vars: VarMap, seen = new Set<string>()): Rgb {
  const v = value.trim();
  // Bare `--name` (caller passed a variable name directly).
  if (v.startsWith("--")) {
    const raw = vars.get(v);
    if (raw !== undefined) return resolveColor(raw, vars, new Set(seen).add(v));
    throw new Error(`Unresolved var: ${v}`);
  }
  const varRef = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (varRef) {
    const name = varRef[1];
    if (seen.has(name)) throw new Error(`Circular var reference: ${name}`);
    const raw = vars.get(name);
    if (raw !== undefined) return resolveColor(raw, vars, new Set(seen).add(name));
    if (varRef[2] !== undefined) return resolveColor(varRef[2], vars, seen);
    throw new Error(`Unresolved var: ${name}`);
  }
  return parseAtomicColor(v);
}

/** Composite a (possibly translucent) foreground over an opaque background. */
function compositeOver(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return { ...fg, a: 1 };
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance for an sRGB color (0..1 channels). */
function relativeLuminance(c: Rgb): number {
  const lin = (x: number) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between two colors (1..21). */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of fg text against a (possibly translucent) bg, composited over
 *  the opaque chat panel (`--chat-ai-bg`) so translucent bubble backgrounds
 *  resolve to their effective on-screen color before the ratio is computed. */
function contrastOn(fgVal: string, bgVal: string, vars: VarMap): number {
  const panel = resolveColor("--chat-ai-bg", vars);
  const bg = compositeOver(resolveColor(bgVal, vars), panel);
  const fg = compositeOver(resolveColor(fgVal, vars), bg);
  return contrastRatio(fg, bg);
}

// --- CSS block parsing -----------------------------------------------------

/** Extract the body of the FIRST top-level rule whose selector matches. */
function extractBlock(css: string, selector: string): string {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{");
  const m = re.exec(css);
  if (!m) throw new Error(`Selector not found: ${selector}`);
  let i = css.indexOf("{", m.index) + 1;
  let depth = 1;
  const start = i;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(start, i - 1);
}

/** Parse `--name: value;` declarations from a CSS block into a map. */
function parseVars(block: string): VarMap {
  const out: VarMap = new Map();
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.set(m[1], m[2].trim());
  return out;
}

// --- Load + merge the two stylesheets per theme ----------------------------
const STYLES_DIR = path.resolve(__dirname, "../styles");
const INDEX_CSS = fs.readFileSync(path.resolve(STYLES_DIR, "../index.css"), "utf8");
const CHAT_CSS = fs.readFileSync(path.join(STYLES_DIR, "chat-theme.css"), "utf8");

function themeVars(theme: "light" | "dark" | "hacker"): VarMap {
  const selector = theme === "light" ? ":root" : theme === "dark" ? ".dark" : ".theme-hacker";
  const merged = new Map<string, string>();
  // index.css first (shadcn tokens), then chat-theme.css overrides chat tokens.
  for (const file of [INDEX_CSS, CHAT_CSS]) {
    for (const [k, v] of parseVars(extractBlock(file, selector))) merged.set(k, v);
  }
  return merged;
}

const REQUIRED_CHAT_VARS = [
  "--chat-user-bg",
  "--chat-user-fg",
  "--chat-ai-bg",
  "--chat-input-bg",
  "--chat-border",
  "--chat-accent",
  "--chat-code-bg",
  "--chat-code-header-bg",
  "--chat-cursor-color",
  "--chat-cursor-glow",
  "--chat-citation-glow",
  "--chat-status-banner-bg",
];

// ===========================================================================
//  1. CSS contract — variables, WCAG contrast, reduced motion
// ===========================================================================

describe("chat-theme.css — 3-theme contract", () => {
  const themes = ["light", "dark", "hacker"] as const;

  it.each(themes)("'%s' theme defines every required --chat-* variable", (theme) => {
    const vars = themeVars(theme);
    const missing = REQUIRED_CHAT_VARS.filter((v) => !vars.has(v));
    expect(missing).toEqual([]);
  });

  it.each(themes)(
    "'%s' user-message text meets WCAG AA (>=4.5) against its bubble background",
    (theme) => {
      const vars = themeVars(theme);
      // User bubble bg may be translucent (dark/hacker) → composite over the AI
      // surface, which is the panel the bubble sits on.
      const ratio = contrastOn("--chat-user-fg", "--chat-user-bg", vars);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(themes)(
    "'%s' AI-message body text meets WCAG AA (>=4.5) against the AI background",
    (theme) => {
      const vars = themeVars(theme);
      // The AI document body uses the shadcn --foreground token (prose).
      const ratio = contrastOn("--foreground", "--chat-ai-bg", vars);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(themes)(
    "'%s' code-block text meets WCAG AA (>=4.5) against the code background",
    (theme) => {
      const vars = themeVars(theme);
      const ratio = contrastOn("--foreground", "--chat-code-bg", vars);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(themes)(
    "'%s' streaming cursor / accent meets WCAG UI-component contrast (>=3) on the AI background",
    (theme) => {
      // The cursor is a 1-2px non-text indicator and the accent is used for
      // borders/labels — WCAG 2.5.5 / 1.4.11 UI-component threshold is 3:1.
      const vars = themeVars(theme);
      const ratio = contrastOn("--chat-cursor-color", "--chat-ai-bg", vars);
      expect(ratio).toBeGreaterThanOrEqual(3);
    },
  );

  it("hacker neon-amber citation glow stays readable on the AI background", () => {
    const vars = themeVars("hacker");
    const ratio = contrastOn("--chat-citation-glow", "--chat-ai-bg", vars);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  describe("prefers-reduced-motion", () => {
    // Extract the reduced-motion media block from chat-theme.css (the only
    // file that declares chat animations) and assert it neutralises every
    // motion declaration the component CSS introduces.
    const mediaStart = CHAT_CSS.indexOf("@media (prefers-reduced-motion: reduce)");
    const mediaBlock = (() => {
      if (mediaStart === -1) return "";
      let i = CHAT_CSS.indexOf("{", mediaStart) + 1;
      let depth = 1;
      const start = i;
      while (i < CHAT_CSS.length && depth > 0) {
        if (CHAT_CSS[i] === "{") depth++;
        else if (CHAT_CSS[i] === "}") depth--;
        i++;
      }
      return CHAT_CSS.slice(start, i - 1);
    })();

    it("declares a prefers-reduced-motion media query", () => {
      expect(mediaBlock.length).toBeGreaterThan(0);
    });

    it("disables the streaming cursor blink animation", () => {
      expect(mediaBlock).toMatch(/\.chat-cursor\s*{[^}]*animation:\s*none/);
    });

    it("disables the status banner slide/fade animation", () => {
      expect(mediaBlock).toMatch(/\.chat-status-banner\s*{[^}]*animation:\s*none/);
    });

    it("disables the citations expand/collapse transition", () => {
      expect(mediaBlock).toMatch(/\.chat-citation-list\s*{[^}]*transition:\s*none/);
    });

    it("disables the keyboard-hint fade transition", () => {
      expect(mediaBlock).toMatch(/\.chat-kbd-hint\s*{[^}]*transition:\s*none/);
    });

    it("disables the message-timestamp hover transition", () => {
      expect(mediaBlock).toMatch(/\.chat-msg-timestamp\s*{[^}]*transition:\s*none/);
    });
  });
});

// ===========================================================================
//  2. ThemeContext — applies the right <html> classes
// ===========================================================================

describe("ThemeContext applies the correct <html> classes per theme", () => {
  // Lazy import so the matchMedia stub above is in place before the module's
  // module-level applyTheme() runs.
  let ThemeContext: typeof import("../contexts/ThemeContext");

  beforeAll(async () => {
    ThemeContext = await import("../contexts/ThemeContext");
  });

  beforeEach(() => {
    document.documentElement.classList.remove("dark", "theme-hacker");
    localStorage.removeItem("theme");
  });

  function renderWithTheme(theme: "light" | "dark" | "hacker" | "system") {
    function Consumer() {
      const { setTheme } = ThemeContext.useTheme();
      React.useEffect(() => setTheme(theme), [setTheme]);
      return null;
    }
    render(
      <ThemeContext.ThemeProvider>
        <Consumer />
      </ThemeContext.ThemeProvider>,
    );
  }

  it("light: no theme class on <html>", () => {
    renderWithTheme("light");
    const html = document.documentElement;
    expect(html.classList.contains("dark")).toBe(false);
    expect(html.classList.contains("theme-hacker")).toBe(false);
  });

  it("dark: only .dark on <html>", () => {
    renderWithTheme("dark");
    const html = document.documentElement;
    expect(html.classList.contains("dark")).toBe(true);
    expect(html.classList.contains("theme-hacker")).toBe(false);
  });

  it("hacker: .dark AND .theme-hacker on <html> (hacker layers on dark)", () => {
    renderWithTheme("hacker");
    const html = document.documentElement;
    expect(html.classList.contains("dark")).toBe(true);
    expect(html.classList.contains("theme-hacker")).toBe(true);
  });
});

// ===========================================================================
//  3. Component DOM invariance — theming is CSS-driven, not React-driven
// ===========================================================================

describe("chat components render the same theme hooks under every <html> theme", () => {
  const themes = [
    { name: "light", classes: [] as string[] },
    { name: "dark", classes: ["dark"] },
    { name: "hacker", classes: ["dark", "theme-hacker"] },
  ];

  beforeEach(() => {
    document.documentElement.classList.remove("dark", "theme-hacker");
  });

  it.each(themes)(
    "ChatStreamingIndicator emits .chat-cursor under the '$name' theme",
    ({ classes }) => {
      classes.forEach((c) => document.documentElement.classList.add(c));
      render(<ChatStreamingIndicator statusMessage={null} streamingContent="Hello" />);
      expect(document.querySelector(".chat-cursor")).toBeInTheDocument();
      expect(screen.getByRole("article")).toHaveAttribute("aria-label", "AI response");
    },
  );

  it("the cursor element is structurally identical across all 3 themes", () => {
    // Render under each theme and capture the cursor's own markup. Because
    // theming is CSS-only, the element must be the same in every theme — the
    // theme just restyles it via the stylesheet. This is the snapshot-free
    // equivalent of "snapshot per theme": assert identity, not pixel output.
    const snapshots: string[] = [];
    for (const { classes } of themes) {
      document.documentElement.classList.remove("dark", "theme-hacker");
      classes.forEach((c) => document.documentElement.classList.add(c));
      const { unmount } = render(
        <ChatStreamingIndicator statusMessage={null} streamingContent="x" />,
      );
      const cursor = document.querySelector(".chat-cursor");
      snapshots.push(cursor ? cursor.outerHTML : "<missing>");
      unmount();
    }
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(snapshots[1]).toBe(snapshots[2]);
  });
});