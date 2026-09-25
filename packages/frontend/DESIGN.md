---
name: Simmetric Chat
description: Local-first AI chat workspace — warm paper surfaces, ink-brown text, one burnt-sienna accent
colors:
  paper-bg: "#F7F3ED"
  ink: "#2D2520"
  card-cream: "#FDFAF4"
  burnt-sienna: "#973C00"
  parchment: "#EDE6DB"
  faded-ink: "#75665A"
  sand-accent: "#E8D9C5"
  clay-red: "#B54434"
  sand-border: "#D9CFC1"
  linen-sidebar: "#F2EBE0"
  amber-link: "#A85428"
  obsidian: "#0a0e14"
  neon-green: "#00ff9c"
  neon-cyan: "#00d4ff"
  neon-magenta: "#ff00aa"
  neon-amber: "#ffaa00"
typography:
  display:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  "2xl": "18px"
spacing:
  comfortable: "16px (p-4/gap-4 default rhythm on a 4px base)"
  compact: "12px (density-compact mode scales the same utilities ×0.75)"
components:
  button-primary:
    backgroundColor: "{colors.burnt-sienna}"
    textColor: "{colors.card-cream}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  button-outline:
    backgroundColor: "{colors.paper-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  button-destructive:
    backgroundColor: "rgba(181, 68, 52, 0.1)"
    textColor: "{colors.clay-red}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  input:
    backgroundColor: "{colors.paper-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "36px"
  card:
    backgroundColor: "{colors.card-cream}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "24px"
---

# Design System: Simmetric Chat

## Overview

**Creative North Star: "The Writing Desk"**

Simmetric Chat looks like a well-kept writing desk: warm paper surfaces (cream `#F7F3ED` canvas, off-white `#FDFAF4` cards), ink-brown text (`#2D2520`), and a single burnt-sienna accent (`#973C00`) used like a fountain pen's nib — sparingly, decisively. The interface is a calm workbench for people completing work: quiet, dense, utilitarian, rewarding attention to detail rather than demanding attention. Nothing shouts; hierarchy comes from tonal layering and weight, not from ornament or shadow.

The system is token-first and theme-complete: one set of shadcn-style CSS custom properties drives three full themes — light (paper), dark (warm near-black), and "Hacker Evoluto" (obsidian terminal with neon accents) — so any surface that respects the tokens themes itself for free. Key Characteristics:

- Warm paper neutrals everywhere; a single sienna accent on ≤10% of any screen.
- Flat surfaces, 1px warm-sand borders, depth by tonal layering — no decorative shadows.
- Compact control density: 32px buttons, 36px inputs, small radii (6–14px).
- Geist Variable for UI; Source Serif 4 Variable as the display voice (wordmark, auth titles); JetBrains Mono reserved for code, IDs, and keyboard hints.
- Three themes (light / dark / hacker) from one token set; hacker styling is locked to the `.theme-hacker` class.

## Colors

The palette reads as fired-earth writing materials: paper, parchment, ink, and one burnt-sienna accent, with a sibling clay-red reserved for errors.

### Primary
- **Burnt Sienna** (#973C00): the accent — primary buttons, active sidebar items, focus rings (`--ring`), links inside chat prose. Identical value in light, dark, and hacker themes; it is the visual constant of the product. Darker sibling **Amber Link** (#A85428, `--chat-accent`) is used where sienna sits on cream cards and needs AA contrast (chat links, citation accents).

### Secondary (optional; omit if the project has only one accent)
- **Clay Red** (#B54434): destructive only — delete buttons, error states. Rendered as a 10% tint background with full clay-red text in buttons (soft-danger), full-value for hard errors. Dark theme lifts it to a brighter oklch red for AA.

### Neutral
- **Warm Paper** (#F7F3ED): app background (`--background`).
- **Card Cream** (#FDFAF4): cards, popovers, chat AI bubbles, and the primary-button text — the brightest surface.
- **Linen** (#F2EBE0): sidebar background and code-block backgrounds — a half-step darker than paper.
- **Parchment** (#EDE6DB): secondary/muted surfaces, chat user bubbles, hover fills.
- **Sand** (#D9CFC1): all 1px borders and input strokes.
- **Faded Ink** (#75665A): muted text, placeholders, secondary metadata (~5:1 on paper — an AA-driven lift from an earlier 3.8:1 value).
- **Ink** (#2D2520): all primary text.
- **Sand Accent** (#E8D9C5): accent fills (status banners, selected list rows).

Dark theme: warm near-black `oklch(0.147 0.004 49.25)` background, `oklch(0.216 …)` cards, white/10 borders — same roles, warm hue preserved. Hacker theme: **Obsidian** (#0a0e14) with **Neon Green** (#00ff9c) as primary, cyan (#00d4ff) secondary, magenta (#ff00aa) danger, amber (#ffaa00) warning.

### Named Rules
**The Ember Accent Rule.** Burnt sienna covers ≤10% of any screen — CTAs, active states, links, focus. Its rarity is the point; a wall of sienna is a bug.
**The Ink-Not-Gray Rule.** Text colors come from the warm ink family (`--foreground`/`--muted-foreground`); neutral Tailwind grays are banned on themeable surfaces.

## Typography

**Body Font:** Geist Variable (self-hosted via `@fontsource-variable/geist`), system sans fallback — swapped from Inter (2026-09): Inter read as the default-SaaS face and fought the desk identity; Geist was already in the bundle unused.
**Brand Display Voice:** Source Serif 4 Variable (self-hosted via `@fontsource-variable/source-serif-4`, chosen over Fraunces/Newsreader for Cyrillic coverage — `ru` is a supported locale), exposed as the `font-display` utility. Reserved for the brand moments only — the chat wordmark, login/setup/force-change titles — never for dense UI chrome (`CardTitle` stays Geist).
**Label/Mono Font:** JetBrains Mono → Fira Code → Cascadia Code → ui-monospace

**Character:** One workmanlike grotesque (Geist) carrying the UI, with a single warm serif (Source Serif 4) reserved for brand moments and mono as the technical counterpoint — a desk with one good pen, one fountain pen for the letterhead, and one pencil. UI hierarchy is achieved with weight and size only; the serif is the only display voice and never letter-spaced.

### Hierarchy
- **Display** (600, 24px / text-2xl, 1.3): page titles (Login, page headers). The largest type in the app; rarely used.
- **Title** (500, 16px, 1.4): card titles, section headers, modal titles.
- **Body** (400, 14px / text-sm, 1.5): default UI text, buttons, chat prose.
- **Label** (500, 12px / text-xs, 1.4): badges, meta info, kbd hints.
  - **Kbd exception (codified):** tiny keyboard hints *inside* `<kbd>` elements stay 10px mono (e.g. palette footer shortcuts); every other off-ramp size (9/10/11px) is lifted to the 12px label step.
- **Mono** (400, 13px): code blocks, embed snippets, model IDs, keyboard shortcuts, hacker-theme chrome.

### Named Rules
**The Single Pen Rule.** Geist carries the UI; JetBrains Mono appears only where the content is literally technical (code, IDs, shortcuts, terminal chrome). Source Serif 4 appears only on the brand-voice surfaces listed above — never in dense UI chrome.

## Layout

App shell: fixed left sidebar (w-60 / 240px, linen background, collapsible to a 36px rail persisted in localStorage; below `lg` it becomes a left sheet) + routed main content. Chat: centered single column with chat-list rail left and citations console right (both become sheets below `lg`). Settings: master-detail — 240px menu rail left, detail page that slides in from the right (240ms `cubic-bezier(0.16, 1, 0.3, 1)`) when a voice is opened. Spacing rhythm is the Tailwind 4px base at "comfortable"; `density-compact` rewrites p-4→12px, p-6→18px, gap-4→12px, gap-6→18px. Two independent user scales: `--ui-font-scale` (0.875/1/1.125rem on `<html>`) resizes chrome; `--font-size-multiplier` resizes base font. Breakpoints: Tailwind defaults (sm 640, md 768, lg 1024); 44px minimum touch targets on mobile.

## Elevation & Depth

The system is flat by default: depth is conveyed by tonal layering (paper → linen sidebar → cream cards → popover) plus 1px sand borders — no resting shadows anywhere. Elevation appears only as state: shadcn popovers/dialogs get their framework shadow when they float, and the hacker theme alone uses colored neon glows (`shadow-neon-*`, e.g. `0 0 12px rgba(0,255,156,0.4)`) as active-state feedback.

### Named Rules
**The Flat-At-Rest Rule.** Surfaces carry no shadow at rest; a shadow means "this element is floating" (overlay) or "this element is live" (hacker neon only).

## Shapes

Soft rectangles throughout: base radius 10px (`--radius: 0.625rem`) with a derived scale — sm 6px, md 8px, lg 10px (buttons, inputs), xl 14px (cards), up to 2.6× for hero containers. Every interactive element has a visible radius; nothing is square, nothing is fully round except badges/pills and avatars. 1px borders define every surface edge (warm sand in light, 10% white in dark). Small technical details keep a tighter geometry: kbd hints 3px, scrollbar thumbs 3px, monogram tile 8px.

## Components

The component language is shadcn/ui primitives restyled through theme tokens — quiet, compact, border-defined.

### Buttons
- **Shape:** soft rectangle (10px; xs/sm sizes clamp to 10–12px via `min(var(--radius-md),Npx)`)
- **Primary:** burnt sienna fill, cream text, 32px height, 10px horizontal padding, text-sm/medium
- **Outline:** paper fill, sand border, hover → parchment fill
- **Ghost:** transparent, hover → parchment fill (the dominant sidebar/tool variant)
- **Destructive:** 10% clay-red tint fill with clay-red text — quiet until hover (20% tint)
- **Hover / Focus:** 150ms all-property ease; focus = sienna border + 3px 50%-alpha sienna ring; active = 1px press-down

### Chips (badges)
- **Style:** parchment fill, secondary-foreground text, pill radius, 12px label type; status variants swap fill/text (local=green, fastest=amber, smartest=purple, reasoning=blue — Tailwind accents allowed here as semantic, non-themeable status color)

### Cards / Containers
- **Corner Style:** 14px radius
- **Background:** card cream on paper; sand 1px border
- **Shadow Strategy:** none at rest (see Elevation)
- **Internal Padding:** 24px (p-6; 18px in compact density)

### Inputs / Fields
- **Style:** 36px height, paper fill, sand 1px stroke, 10px radius
- **Focus:** sienna stroke + 3px 50%-alpha sienna ring
- **Error / Disabled:** clay-red stroke + tinted ring; 50% opacity disabled

### Navigation
- **Style:** linen sidebar, ink text, ghost items; active = parchment fill (light) with sienna reserved for primary actions; hacker theme active = neon-green left border + mono uppercase + green text-shadow

### Chat Message Bubbles (signature component)
- **User:** parchment fill (#EDE6DB), ink text, 150ms slide-in from right; dark theme uses a 4% white tint
- **Assistant:** card cream, full-width, fade-rise entrance; markdown body with sienna underlined links
- **Streaming:** 1×16px blinking cursor (sienna; neon-green 2px with glow in hacker)
- **Citations:** inline badges with amber-link accent and soft glow on hover

## Do's and Don'ts

### Do:
- **Do** style every themeable surface through the shadcn tokens (`bg-[var(--card)]`, `bg-background`, `text-muted-foreground`) so light/dark/hacker come free.
- **Do** keep text at AA in both themes — faded ink is #75665A minimum on paper; chat links use amber #A85428, not raw sienna, on cream.
- **Do** gate all non-essential motion behind `prefers-reduced-motion` (fade-only fallbacks, 120–200ms).
- **Do** keep controls compact: 32px buttons, 36px inputs, 44px touch targets on mobile.

### Don't:
- **Don't** use raw Tailwind grays/whites (`bg-white`, `text-gray-500`) on themeable surfaces — they break all three themes.
- **Don't** add shadows to resting surfaces; depth is tonal layering, and neon glow belongs exclusively to `.theme-hacker`.
- **Don't** style the hacker theme with a `data-theme` attribute or leak neon/glitch/scanline effects outside `.theme-hacker` — the class convention is locked.
- **Don't** exceed the sienna budget: if a new screen needs more than one accent color story, use parchment/sand states, not a second hue.