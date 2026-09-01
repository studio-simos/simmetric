// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

// G-128-2: the hostFab flag decides WHERE the open/close FAB lives. Real
// embeds via LOADER_JS append &hostFab=1 → the host page owns the FAB (created
// by LOADER_JS outside the pointer-events:none iframe) and the iframe app must
// NOT render its own ChatFab. The admin preview pane (WidgetPreviewPane) loads
// the iframe route directly WITHOUT the param → hostFab false → the iframe
// keeps its FAB. Both the flag mapping (parseWidgetConfigBlock) and the
// FAB-visibility decision (shouldRenderFab) are pure helpers in
// useWidgetConfig.ts, so they are unit-tested in the node environment without
// rendering the Preact app (threat model T-65-SC forbids new test deps;
// jest.config.js is testEnvironment node, no jsdom — same pattern as
// useWidgetConfig.test.ts).
import { parseWidgetConfigBlock, shouldRenderFab } from "../widget/hooks/useWidgetConfig";

describe("parseWidgetConfigBlock hostFab mapping (G-128-2)", () => {
  it("maps hostFab:true from a block (real embed via LOADER_JS &hostFab=1)", () => {
    const config = parseWidgetConfigBlock(JSON.stringify({ widgetId: "w1", hostFab: true }));
    expect(config).not.toBeNull();
    expect(config!.hostFab).toBe(true);
  });

  it("defaults hostFab to false when the block omits it (preview pane / direct iframe load)", () => {
    const config = parseWidgetConfigBlock(JSON.stringify({ widgetId: "w1" }));
    expect(config).not.toBeNull();
    expect(config!.hostFab).toBe(false);
  });

  it("maps non-true hostFab values to false (defensive)", () => {
    const config = parseWidgetConfigBlock(JSON.stringify({ widgetId: "w1", hostFab: "1" }));
    expect(config).not.toBeNull();
    expect(config!.hostFab).toBe(false);
  });
});

describe("shouldRenderFab (G-128-2 FAB-visibility decision)", () => {
  it("renders the iframe ChatFab when hostFab is false (preview pane)", () => {
    expect(shouldRenderFab(false)).toBe(true);
  });

  it("hides the iframe ChatFab when hostFab is true (real embed — host FAB owns it)", () => {
    expect(shouldRenderFab(true)).toBe(false);
  });
});
