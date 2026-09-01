// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { withPageLock } from "../services/wikiLockService";

describe("wikiLockService.withPageLock", () => {
  test("propagates the fn resolved value", async () => {
    const result = await withPageLock("archive-1", "page-a", async () => 42);
    expect(result).toBe(42);
  });

  test("propagates the fn rejection and releases the lock", async () => {
    await expect(
      withPageLock("archive-1", "page-err", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // After the rejection, a fresh call for the same key must resolve — the lock
    // was released in the finally block.
    const result = await withPageLock("archive-1", "page-err", async () => "ok");
    expect(result).toBe("ok");
  });

  test("serializes concurrent calls for the same key (FIFO ordering)", async () => {
    const order: string[] = [];

    // fn1 sets started, waits a tick, then sets done.
    const fn1 = async () => {
      order.push("fn1-start");
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push("fn1-end");
      return "fn1";
    };

    // fn2 asserts fn1 has completed before it proceeds.
    const fn2 = async () => {
      // fn2 must only run after fn1-end is recorded
      expect(order).toContain("fn1-end");
      order.push("fn2-start");
      order.push("fn2-end");
      return "fn2";
    };

    const [r1, r2] = await Promise.all([
      withPageLock("archive-serial", "page", fn1),
      withPageLock("archive-serial", "page", fn2),
    ]);

    expect(r1).toBe("fn1");
    expect(r2).toBe("fn2");
    expect(order).toEqual(["fn1-start", "fn1-end", "fn2-start", "fn2-end"]);
  });

  test("different keys run concurrently (independent locks)", async () => {
    const order: string[] = [];
    let resolveA: () => void;
    const blockerA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    const fnA = async () => {
      order.push("a-start");
      await blockerA;
      order.push("a-end");
      return "a";
    };
    const fnB = async () => {
      order.push("b-start");
      order.push("b-end");
      return "b";
    };

    const pA = withPageLock("archive-diff", "page-a", fnA);
    // Let fnA start (it holds the lock on page-a). fnB uses a different key so it
    // should not be blocked by fnA.
    const pB = withPageLock("archive-diff", "page-b", fnB);
    await pB;
    expect(order).toContain("b-end");
    // fnA has not finished yet
    expect(order).not.toContain("a-end");

    resolveA!();
    await pA;
    expect(order).toContain("a-end");
  });
});