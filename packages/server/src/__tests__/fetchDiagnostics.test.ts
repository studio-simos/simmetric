// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { describeFetchFailureCause } from "../utils/fetchDiagnostics";

/** undici's top-level connection failure shape: bare TypeError + cause chain */
function undiciTypeError(cause: unknown): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = cause;
  return err;
}

describe("describeFetchFailureCause (quick 260918-k8n)", () => {
  it("unwraps an undici TypeError whose cause carries a known connection code + address", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:3210");
    (cause as { code?: string }).code = "ECONNREFUSED";
    const detail = describeFetchFailureCause(undiciTypeError(cause));
    expect(detail).not.toBeNull();
    expect(detail).toContain("ECONNREFUSED");
    expect(detail).toContain("127.0.0.1:3210");
  });

  it("unwraps an AggregateError cause to the first entry with a usable code (happy-eyeballs multi-address)", () => {
    const inner = new Error("connect ENOTFOUND collector.internal");
    (inner as { code?: string }).code = "ENOTFOUND";
    const agg = new AggregateError([new Error("no code here"), inner], "connect failed");
    const detail = describeFetchFailureCause(undiciTypeError(agg));
    expect(detail).not.toBeNull();
    expect(detail).toContain("ENOTFOUND");
    expect(detail).toContain("collector.internal");
  });

  it("recognizes the full known connection-code set", () => {
    const codes = [
      "ECONNRESET",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENETDOWN",
      "EPROTO",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ];
    for (const code of codes) {
      const cause = new Error(`boom ${code}`);
      (cause as { code?: string }).code = code;
      expect(describeFetchFailureCause(undiciTypeError(cause))).toContain(code);
    }
  });

  it("returns null for a plain Error with no cause", () => {
    expect(describeFetchFailureCause(new Error("fetch failed"))).toBeNull();
  });

  it("returns null when the cause lacks a known connection code", () => {
    const cause = new Error("some app-level failure");
    (cause as { code?: string }).code = "SOMETHING_ELSE";
    expect(describeFetchFailureCause(undiciTypeError(cause))).toBeNull();
  });

  it("returns null for a DOMException AbortError (timeout arm is handled elsewhere)", () => {
    expect(
      describeFetchFailureCause(new DOMException("This operation was aborted", "AbortError")),
    ).toBeNull();
  });

  it("returns null for non-Error input and never throws", () => {
    expect(describeFetchFailureCause("fetch failed")).toBeNull();
    expect(describeFetchFailureCause(null)).toBeNull();
    expect(describeFetchFailureCause(undefined)).toBeNull();
    expect(describeFetchFailureCause(42)).toBeNull();
  });

  it("returns the code alone when the cause message is empty", () => {
    const cause = new Error("");
    (cause as { code?: string }).code = "ECONNRESET";
    expect(describeFetchFailureCause(undiciTypeError(cause))).toBe("ECONNRESET");
  });
});