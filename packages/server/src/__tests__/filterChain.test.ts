// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Filter Chain unit tests (Phase 100-01)
 *
 * Covers runInlet/runOutlet ascending-priority ordering, void pass-through,
 * modification chaining, and crash isolation (D-05 — plugin that throws is
 * caught, logged, and skipped; chat continues).
 */
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { runInlet, runOutlet } from "../filters/filterChain";
import {
  registerFilter,
  _clearAllFilters,
} from "../filters/filterRegistry";
import type { FilterContext, FilterPlugin } from "../filters/types";

const baseCtx = (overrides: Partial<FilterContext> = {}): FilterContext => ({
  message: "hello",
  chatId: "chat-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "user",
  metadata: {},
  streaming: false,
  ...overrides,
});

const makePlugin = (overrides: Partial<FilterPlugin> = {}): FilterPlugin => ({
  name: "p",
  priority: 0,
  enabled: true,
  ...overrides,
});

describe("filterChain", () => {
  beforeEach(() => {
    _clearAllFilters();
  });

  describe("runInlet", () => {
    it("executes plugins in ascending priority order (DLP -1 first)", async () => {
      const order: string[] = [];
      registerFilter(
        makePlugin({
          name: "low",
          priority: 1,
          inlet: async ctx => {
            order.push("low");
            return ctx;
          },
        }),
      );
      registerFilter(
        makePlugin({
          name: "dlp",
          priority: -1,
          inlet: async ctx => {
            order.push("dlp");
            return ctx;
          },
        }),
      );
      registerFilter(
        makePlugin({
          name: "mid",
          priority: 0,
          inlet: async ctx => {
            order.push("mid");
            return ctx;
          },
        }),
      );
      await runInlet(baseCtx());
      expect(order).toEqual(["dlp", "mid", "low"]);
    });

    it("plugin returning undefined (void) = pass-through, ctx unchanged", async () => {
      registerFilter(
        makePlugin({
          name: "noop",
          priority: 0,
          inlet: async () => {},
        }),
      );
      const ctx = baseCtx({ message: "untouched" });
      const result = await runInlet(ctx);
      expect(result.message).toBe("untouched");
      expect(result).toBe(ctx);
    });

    it("plugin returning new ctx = modification applied to subsequent plugins", async () => {
      registerFilter(
        makePlugin({
          name: "mod",
          priority: 0,
          inlet: async ctx => ({ ...ctx, message: "modified" }),
        }),
      );
      const seen: string[] = [];
      registerFilter(
        makePlugin({
          name: "obs",
          priority: 1,
          inlet: async ctx => {
            seen.push(ctx.message);
            return;
          },
        }),
      );
      const result = await runInlet(baseCtx({ message: "orig" }));
      expect(result.message).toBe("modified");
      expect(seen).toEqual(["modified"]);
    });

    it("plugin that throws is caught, logged, skipped — chain continues (D-05)", async () => {
      registerFilter(
        makePlugin({
          name: "crash",
          priority: 0,
          inlet: async () => {
            throw new Error("boom");
          },
        }),
      );
      let downstreamRan = false;
      registerFilter(
        makePlugin({
          name: "next",
          priority: 1,
          inlet: async ctx => {
            downstreamRan = true;
            return ctx;
          },
        }),
      );
      const result = await runInlet(baseCtx({ message: "keep" }));
      expect(downstreamRan).toBe(true);
      expect(result.message).toBe("keep");
    });

    it("skips plugins without an inlet method", async () => {
      registerFilter(
        makePlugin({
          name: "outletOnly",
          priority: 0,
          outlet: async ctx => ctx,
        }),
      );
      let otherRan = false;
      registerFilter(
        makePlugin({
          name: "hasInlet",
          priority: 1,
          inlet: async ctx => {
            otherRan = true;
            return ctx;
          },
        }),
      );
      await runInlet(baseCtx());
      expect(otherRan).toBe(true);
    });

    it("skips disabled plugins (enabled === false)", async () => {
      let disabledRan = false;
      registerFilter(
        makePlugin({
          name: "off",
          priority: 0,
          enabled: false,
          inlet: async ctx => {
            disabledRan = true;
            return ctx;
          },
        }),
      );
      await runInlet(baseCtx());
      expect(disabledRan).toBe(false);
    });
  });

  describe("runOutlet", () => {
    it("executes plugins in ascending priority order (DLP -1 first)", async () => {
      const order: string[] = [];
      registerFilter(
        makePlugin({
          name: "low",
          priority: 1,
          outlet: async ctx => {
            order.push("low");
            return ctx;
          },
        }),
      );
      registerFilter(
        makePlugin({
          name: "dlp",
          priority: -1,
          outlet: async ctx => {
            order.push("dlp");
            return ctx;
          },
        }),
      );
      await runOutlet(baseCtx({ role: "assistant" }));
      expect(order).toEqual(["dlp", "low"]);
    });

    it("void pass-through", async () => {
      registerFilter(
        makePlugin({
          name: "noop",
          priority: 0,
          outlet: async () => {},
        }),
      );
      const ctx = baseCtx({ message: "out" });
      const result = await runOutlet(ctx);
      expect(result.message).toBe("out");
    });

    it("crash isolation (D-05)", async () => {
      registerFilter(
        makePlugin({
          name: "crash",
          priority: 0,
          outlet: async () => {
            throw new Error("outlet boom");
          },
        }),
      );
      let nextRan = false;
      registerFilter(
        makePlugin({
          name: "next",
          priority: 1,
          outlet: async ctx => {
            nextRan = true;
            return ctx;
          },
        }),
      );
      const result = await runOutlet(baseCtx({ message: "keep" }));
      expect(nextRan).toBe(true);
      expect(result.message).toBe("keep");
    });

    it("skips plugins without an outlet method", async () => {
      registerFilter(
        makePlugin({
          name: "inletOnly",
          priority: 0,
          inlet: async ctx => ctx,
        }),
      );
      let otherRan = false;
      registerFilter(
        makePlugin({
          name: "hasOutlet",
          priority: 1,
          outlet: async ctx => {
            otherRan = true;
            return ctx;
          },
        }),
      );
      await runOutlet(baseCtx());
      expect(otherRan).toBe(true);
    });
  });
});