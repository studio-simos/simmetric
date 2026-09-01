// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { renderHook, act } from "@testing-library/react";
import { useMessageHistory } from "../hooks/useMessageHistory";

const STORAGE_KEY = "chat:history";

describe("useMessageHistory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when history is empty", () => {
    const { result } = renderHook(() => useMessageHistory());
    expect(result.current.navigate("up", "draft")).toBeNull();
    expect(result.current.navigate("down", "draft")).toBeNull();
  });

  it("recalls older entries on up and restores draft on down", () => {
    const { result } = renderHook(() => useMessageHistory());
    act(() => {
      result.current.push("first");
      result.current.push("second");
      result.current.push("third");
    });

    // Up from a draft -> newest ("third"), draft ("hello") stashed.
    expect(result.current.navigate("up", "hello")).toBe("third");
    // Up again -> "second".
    expect(result.current.navigate("up", "third")).toBe("second");
    // Up again -> "first" (oldest).
    expect(result.current.navigate("up", "second")).toBe("first");
    // Up at oldest -> no-op (null).
    expect(result.current.navigate("up", "first")).toBeNull();

    // Down -> "second".
    expect(result.current.navigate("down", "first")).toBe("second");
    // Down -> "third".
    expect(result.current.navigate("down", "second")).toBe("third");
    // Down past newest -> restore the stashed draft.
    expect(result.current.navigate("down", "third")).toBe("hello");
    // Down at draft -> no-op.
    expect(result.current.navigate("down", "hello")).toBeNull();
  });

  it("collapses consecutive duplicates on push", () => {
    const { result } = renderHook(() => useMessageHistory());
    act(() => {
      result.current.push("same");
      result.current.push("same");
      result.current.push("other");
    });
    // Only "same" and "other" -> Up gives "other", Up again gives "same".
    expect(result.current.navigate("up", "")).toBe("other");
    expect(result.current.navigate("up", "other")).toBe("same");
    expect(result.current.navigate("up", "same")).toBeNull();
  });

  it("persists history to localStorage and loads it on next mount", () => {
    const { result, unmount } = renderHook(() => useMessageHistory());
    act(() => {
      result.current.push("persisted-a");
      result.current.push("persisted-b");
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([
      "persisted-a",
      "persisted-b",
    ]);
    unmount();

    const { result: result2 } = renderHook(() => useMessageHistory());
    expect(result2.current.navigate("up", "")).toBe("persisted-b");
    expect(result2.current.navigate("up", "persisted-b")).toBe("persisted-a");
  });

  it("caps history at 100 entries", () => {
    const { result } = renderHook(() => useMessageHistory());
    act(() => {
      for (let i = 0; i < 120; i++) result.current.push(`msg-${i}`);
    });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as string[];
    expect(stored.length).toBe(100);
    // Oldest trimmed, newest retained.
    expect(stored[0]).toBe("msg-20");
    expect(stored[stored.length - 1]).toBe("msg-119");
  });

  it("ignores empty/whitespace-only pushes", () => {
    const { result } = renderHook(() => useMessageHistory());
    act(() => {
      result.current.push("   ");
      result.current.push("");
    });
    expect(result.current.navigate("up", "x")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reset returns navigation to the live draft", () => {
    const { result } = renderHook(() => useMessageHistory());
    act(() => {
      result.current.push("only");
      result.current.navigate("up", "draft"); // enter history
    });
    act(() => {
      result.current.reset();
    });
    // After reset, Down is a no-op (at draft).
    expect(result.current.navigate("down", "")).toBeNull();
    // Up re-enters at the newest entry.
    expect(result.current.navigate("up", "")).toBe("only");
  });
});