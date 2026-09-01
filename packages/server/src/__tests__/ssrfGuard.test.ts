// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for the SSRF guard (assertSafeProbeUrl) — Phase 152 gap G-152-2.
 *
 * DNS resolution is mocked (jest.mock("node:dns/promises")) so the suite does
 * NOT require a live network — per packages/server/AGENTS.md "unit tests must
 * not require a live network". Each test seeds a deterministic mock lookup
 * table keyed by hostname and asserts the guard accepts or rejects the URL
 * and (when accepted) that the returned URL's hostname is the PINNED
 * validated IP (DNS-rebinding defense, Warning 2).
 */
// @ts-nocheck

import { assertSafeProbeUrl } from "../utils/ssrfGuard";

// Mocked dns/promises — replaced per-test via __setLookup().
const mockLookup = jest.fn();
jest.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

// Helper: install a deterministic lookup that returns the supplied records
// for any hostname (the guard lowercases hostnames but lookup is keyed on
// the raw hostname passed in — we match case-insensitively in the mock).
function __setLookup(
  map: Record<string, Array<{ address: string; family: number }>>,
): void {
  mockLookup.mockImplementation(
    async (hostname: string, _opts: unknown) => {
      const key = hostname.toLowerCase();
      const recs = map[key];
      if (!recs) {
        const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        // Node's lookup attaches code=ENOTFOUND — emulate enough for tests.
        (err as any).code = "ENOTFOUND";
        throw err;
      }
      return recs;
    },
  );
}

beforeEach(() => {
  mockLookup.mockReset();
});

describe("assertSafeProbeUrl — protocol allowlist", () => {
  it("rejects file:// URLs", async () => {
    await expect(
      assertSafeProbeUrl("file:///etc/passwd", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("rejects gopher:// URLs", async () => {
    await expect(
      assertSafeProbeUrl("gopher://x/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("rejects ftp:// URLs", async () => {
    await expect(
      assertSafeProbeUrl("ftp://example.com/", { allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — invalid URL", () => {
  it("rejects a non-URL string", async () => {
    await expect(
      assertSafeProbeUrl("not a url", { allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — cloud-metadata literal block (always, regardless of allowLoopback)", () => {
  it("blocks 169.254.169.254 (AWS/GCP/Azure metadata) even with allowLoopback=true", async () => {
    await expect(
      assertSafeProbeUrl("http://169.254.169.254/latest/meta-data/", {
        allowLoopback: true,
      }),
    ).rejects.toThrow();
  });

  it("blocks 100.100.100.200 (Alibaba metadata)", async () => {
    await expect(
      assertSafeProbeUrl("http://100.100.100.200/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("blocks [fd00:ec2::254] (IPv6 AWS metadata)", async () => {
    await expect(
      assertSafeProbeUrl("http://[fd00:ec2::254]/", { allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — RFC1918 block", () => {
  it("blocks 10.0.0.1", async () => {
    await expect(
      assertSafeProbeUrl("http://10.0.0.1/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("blocks 192.168.1.5", async () => {
    await expect(
      assertSafeProbeUrl("http://192.168.1.5/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("blocks 172.16.0.1", async () => {
    await expect(
      assertSafeProbeUrl("http://172.16.0.1/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("blocks 172.31.255.255 (top of 172.16/12)", async () => {
    await expect(
      assertSafeProbeUrl("http://172.31.255.255/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("ALLOWS 172.32.0.1 (outside 172.16/12 — not RFC1918)", async () => {
    __setLookup({
      "172.32.0.1": [{ address: "172.32.0.1", family: 4 }],
    });
    const u = await assertSafeProbeUrl("http://172.32.0.1/", {
      allowLoopback: false,
    });
    expect(u.hostname).toBe("172.32.0.1");
  });
});

describe("assertSafeProbeUrl — link-local 169.254/16 block (non-metadata)", () => {
  it("blocks 169.254.1.1 (link-local, non-metadata)", async () => {
    await expect(
      assertSafeProbeUrl("http://169.254.1.1/", { allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — loopback block when allowLoopback=false", () => {
  it("blocks 127.0.0.1 when allowLoopback=false", async () => {
    await expect(
      assertSafeProbeUrl("http://127.0.0.1:1/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("blocks [::1] when allowLoopback=false", async () => {
    await expect(
      assertSafeProbeUrl("http://[::1]:11434/", { allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — loopback allow when allowLoopback=true", () => {
  it("allows http://127.0.0.1:11434/ for local Ollama", async () => {
    __setLookup({
      "127.0.0.1": [{ address: "127.0.0.1", family: 4 }],
    });
    const u = await assertSafeProbeUrl("http://127.0.0.1:11434/", {
      allowLoopback: true,
    });
    // Pinned to the validated IP (loopback is pinned too).
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.port).toBe("11434");
  });

  it("allows http://localhost:11434/ for local Ollama (resolves to 127.0.0.1, pinned)", async () => {
    __setLookup({
      localhost: [{ address: "127.0.0.1", family: 4 }],
    });
    const u = await assertSafeProbeUrl("http://localhost:11434/", {
      allowLoopback: true,
    });
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.port).toBe("11434");
  });

  it("allows http://[::1]:11434/ (IPv6 loopback)", async () => {
    __setLookup({
      "::1": [{ address: "::1", family: 6 }],
    });
    const u = await assertSafeProbeUrl("http://[::1]:11434/", {
      allowLoopback: true,
    });
    expect(u.hostname).toBe("[::1]");
    expect(u.port).toBe("11434");
  });
});

describe("assertSafeProbeUrl — public host allowed + pinned to resolved IP", () => {
  it("allows http://example.com/ and pins hostname to the resolved A record", async () => {
    __setLookup({
      "example.com": [{ address: "93.184.216.34", family: 4 }],
    });
    const u = await assertSafeProbeUrl("http://example.com/", {
      allowLoopback: false,
    });
    expect(u.hostname).toBe("93.184.216.34");
    expect(u.protocol).toBe("http:");
  });

  it("preserves port + path on the pinned URL", async () => {
    __setLookup({
      "example.com": [{ address: "93.184.216.34", family: 4 }],
    });
    const u = await assertSafeProbeUrl("http://example.com:8080/v1/models", {
      allowLoopback: false,
    });
    expect(u.hostname).toBe("93.184.216.34");
    expect(u.port).toBe("8080");
    expect(u.pathname).toBe("/v1/models");
  });
});

describe("assertSafeProbeUrl — DNS-rebinding defense (Warning 2)", () => {
  it("pins to the FIRST safe resolved IP — a second lookup returning 127.0.0.1 is never consulted", async () => {
    // First lookup returns a public IP; a second lookup (e.g. the caller's
    // own axios re-resolution) would return 127.0.0.1. The guard's
    // validation lookup is the only one that runs, and it pins the public IP
    // into the returned URL's hostname — the caller uses that URL, so axios
    // never re-resolves the original hostname.
    let callCount = 0;
    mockLookup.mockImplementation(async (_h: string, _o: unknown) => {
      callCount += 1;
      // The guard performs exactly ONE lookup (all:true). The mock asserts
      // a second lookup would have returned 127.0.0.1 — but it must NEVER
      // be called, because the guard pins the first IP.
      if (callCount === 1) {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "127.0.0.1", family: 4 }];
    });

    const u = await assertSafeProbeUrl("http://rebind.attacker/", {
      allowLoopback: false,
    });
    expect(u.hostname).toBe("93.184.216.34");
    // The second lookup (which would have returned 127.0.0.1) was never
    // consulted — DNS-rebinding-safe.
    expect(callCount).toBe(1);
  });
});

describe("assertSafeProbeUrl — DNS failure does not fall through to an outbound request", () => {
  it("throws on DNS resolution failure (no fall-through to outbound)", async () => {
    mockLookup.mockImplementation(async (hostname: string) => {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      (err as any).code = "ENOTFOUND";
      throw err;
    });
    await expect(
      assertSafeProbeUrl("http://nonexistent.invalid/", {
        allowLoopback: false,
      }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — IPv6 unique-local fc00::/7 block", () => {
  it("blocks [fd12:3456:789a::1] (fd00::/8 is inside fc00::/7)", async () => {
    await expect(
      assertSafeProbeUrl("http://[fd12:3456:789a::1]/", {
        allowLoopback: false,
      }),
    ).rejects.toThrow();
  });

  it("blocks [fc00::1] (top of fc00::/7)", async () => {
    await expect(
      assertSafeProbeUrl("http://[fc00::1]/", { allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — IPv4-mapped IPv6 bypass (CR-G05-01, G-152-2)", () => {
  // WHATWG URL normalizes ::ffff:a.b.c.d to hex form ::ffff:XXYY:ZZWW. The
  // guard must extract all 4 octets and classify the real dotted-quad — a
  // naive 16-bit concatenation let ::ffff:169.254.169.254 (AWS metadata)
  // through, reopening the exact SSRF vector G-152-2 closed.
  it("blocks [::ffff:169.254.169.254] (AWS metadata via IPv4-mapped IPv6)", async () => {
    await expect(
      assertSafeProbeUrl("http://[::ffff:169.254.169.254]/", {
        allowLoopback: false,
      }),
    ).rejects.toThrow();
  });

  it("blocks [::ffff:127.0.0.1] (loopback via IPv4-mapped IPv6) when allowLoopback=false", async () => {
    await expect(
      assertSafeProbeUrl("http://[::ffff:127.0.0.1]/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("blocks [::ffff:10.0.0.1] (RFC1918 via IPv4-mapped IPv6)", async () => {
    await expect(
      assertSafeProbeUrl("http://[::ffff:10.0.0.1]/", { allowLoopback: false }),
    ).rejects.toThrow();
  });

  it("blocks [::ffff:192.168.1.1] (RFC1918 via IPv4-mapped IPv6)", async () => {
    await expect(
      assertSafeProbeUrl("http://[::ffff:192.168.1.1]/", {
        allowLoopback: false,
      }),
    ).rejects.toThrow();
  });

  it("allows [::ffff:127.0.0.1] when allowLoopback=true (local Ollama via mapped v6)", async () => {
    const u = await assertSafeProbeUrl("http://[::ffff:127.0.0.1]:11434/", {
      allowLoopback: true,
    });
    // WHATWG normalizes ::ffff:127.0.0.1 to hex form ::ffff:7f00:1; the guard
    // pins the resolved literal (hex form) — same address, valid for connect.
    expect(u.hostname).toBe("[::ffff:7f00:1]");
  });
});

describe("assertSafeProbeUrl — 0.0.0.0/8 block (CR-G05-04)", () => {
  it("blocks 0.0.0.0 (current-network, never a valid probe target)", async () => {
    await expect(
      assertSafeProbeUrl("http://0.0.0.0/", { allowLoopback: false }),
    ).rejects.toThrow();
  });
  it("blocks 0.1.2.3 (0.0.0.0/8)", async () => {
    await expect(
      assertSafeProbeUrl("http://0.1.2.3/", { allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — multi-record resolution (ANY blocked IP fails)", () => {
  it("rejects when ANY resolved record is in a blocked range (mixed public + private)", async () => {
    __setLookup({
      "mixed.attacker": [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    });
    await expect(
      assertSafeProbeUrl("http://mixed.attacker/", { allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe("assertSafeProbeUrl — multi-record pin picks the first SAFE resolved IP", () => {
  it("picks the first safe resolved IP when multiple public records exist", async () => {
    __setLookup({
      "multi.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "93.184.216.35", family: 4 },
      ],
    });
    const u = await assertSafeProbeUrl("http://multi.example/", {
      allowLoopback: false,
    });
    expect(u.hostname).toBe("93.184.216.34");
  });
});