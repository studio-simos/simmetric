// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SSRF guard for the wizard's public probe endpoints (Phase 152 gap G-152-2,
 * CR-01). assertSafeProbeUrl validates an attacker-supplied URL BEFORE any
 * outbound request, blocks non-http(s) protocols, RFC1918 private ranges,
 * link-local 169.254/16, IPv6 unique-local fc00::/7, loopback (unless
 * explicitly allowlisted for the local Ollama default), and the cloud-
 * metadata literal hosts (AWS/GCP/Azure 169.254.169.254, Alibaba
 * 100.100.100.200, IPv6 fd00:ec2::254). DNS-rebinding defense (Warning 2):
 * the resolved IP is PINNED into the returned URL's hostname so the caller
 * connects to the already-validated IP and never re-resolves the original
 * hostname — a TTL-0 rebinding record cannot bypass the guard.
 *
 * Used by /api/system/probe-llm and /api/system/probe-vector. Both are
 * unauthenticated (wizard-gated only) and issue server-side outbound HTTP
 * requests to an attacker-chosen URL during the wizard-active window. This
 * guard is the single choke point that must not be bypassed.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface AssertSafeProbeUrlOpts {
  /** When true, 127.0.0.0/8 and ::1 are allowed (local Ollama default). */
  allowLoopback: boolean;
}

// Cloud-metadata literal hosts — always blocked, regardless of allowLoopback.
const CLOUD_METADATA_LITERALS = new Set<string>([
  "169.254.169.254", // AWS / GCP / Azure IMDS
  "100.100.100.200", // Alibaba
  "metadata.google.internal",
  "metadata.azure.com",
]);

/**
 * Classify a single resolved IP literal as blocked (true) or safe (false).
 * Hostname-level literal block (cloud metadata) is handled by the caller
 * BEFORE resolution; this function only inspects resolved IP literals.
 */
function isBlockedIp(ip: string, allowLoopback: boolean): boolean {
  // IPv6 bracket-stripping (defensive — dns lookup returns bare literals).
  const v6 = ip.startsWith("[") && ip.endsWith("]")
    ? ip.slice(1, -1)
    : ip;
  const family = isIP(v6);
  if (family === 0) return true; // not an IP — reject (defensive)

  if (family === 4) {
    const parts = v6.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const a = parts[0];
    const b = parts[1];
    if (a === undefined || b === undefined) return true; // noUncheckedIndexedAccess
    // Loopback 127.0.0.0/8
    if (a === 127) return !allowLoopback;
    // Link-local 169.254.0.0/16 (includes cloud metadata literals — those
    // are also blocked at hostname level, but a resolved link-local IP must
    // be blocked here too).
    if (a === 169 && b === 254) return true;
    // RFC1918 10.0.0.0/8
    if (a === 10) return true;
    // RFC1918 172.16.0.0/12 (172.16.0.0 – 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // RFC1918 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 0.0.0.0/8 (current network — block, never a valid probe target)
    if (a === 0) return true;
    return false;
  }

  // IPv6 — normalize :: notation so prefix checks are reliable. The input
  // may be "::1", "fd00:ec2::254", "::ffff:127.0.0.1", etc.
  const normV6 = normalizeIPv6(v6.toLowerCase());
  // Loopback ::1
  if (normV6 === "0000:0000:0000:0000:0000:0000:0000:0001") {
    return !allowLoopback;
  }
  // IPv4-mapped ::ffff:a.b.c.d — delegate to the v4 path. The normalized
  // form is 0000:0000:0000:0000:0000:ffff:XXYY:ZZWW where XXYY:ZZWW is the
  // IPv4 address a.b.c.d encoded as four hex octets (XX=a, YY=b, ZZ=c, WW=d).
  // Extract each octet separately and reconstruct the dotted-quad so the v4
  // classifier sees the real a.b.c.d — a naive `${g1}${g2}` concatenation
  // produces a 16-bit value (e.g. 0xa9fe=43518) that matches no blocked range,
  // letting ::ffff:169.254.169.254 (AWS metadata) bypass the guard.
  const v4MappedMatch = normV6.match(/^0000:0000:0000:0000:0000:ffff:([0-9a-f]{2})([0-9a-f]{2}):([0-9a-f]{2})([0-9a-f]{2})$/);
  if (v4MappedMatch) {
    const octets = [
      Number.parseInt(v4MappedMatch[1] ?? "0", 16),
      Number.parseInt(v4MappedMatch[2] ?? "0", 16),
      Number.parseInt(v4MappedMatch[3] ?? "0", 16),
      Number.parseInt(v4MappedMatch[4] ?? "0", 16),
    ];
    return isBlockedIp(`${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`, allowLoopback);
  }
  // Unique-local fc00::/7 — first 7 bits = 1111110 → first byte 0xfc or 0xfd.
  if (normV6.startsWith("fc") || normV6.startsWith("fd")) return true;
  // Link-local fe80::/10 — first 10 bits = 1111111010 → first group fe8X.
  if (
    normV6.startsWith("fe80") || normV6.startsWith("fe9") ||
    normV6.startsWith("fea") || normV6.startsWith("feb")
  ) return true;
  return false;
}

/**
 * Expand an IPv6 address to its full canonical 8-group form so prefix checks
 * are reliable (the input may be `::1`, `fd00:ec2::254`, etc.). Returns the
 * lowercased full form (e.g. "::1" → "0000:0000:0000:0000:0000:0000:0000:0001").
 */
function normalizeIPv6(addr: string): string {
  let segments: string[];
  if (addr.includes("::")) {
    const [head, tail] = addr.split("::");
    const headParts = (head ?? "").split(":").filter(Boolean);
    const tailParts = (tail ?? "").split(":").filter(Boolean);
    const missing = 8 - headParts.length - tailParts.length;
    segments = [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts];
  } else {
    segments = addr.split(":");
  }
  while (segments.length < 8) segments.push("0");
  return segments.slice(0, 8).map((s) => s.padStart(4, "0")).join(":");
}

/**
 * Validate an attacker-supplied URL for an outbound probe. Throws on any
 * validation failure (the throw is caught by the probe handler and mapped
 * to a generic "Could not reach the configured endpoint" — the validation
 * message is never sent to the client). On success, returns a NEW URL whose
 * hostname is the PINNED first safe resolved IP, so the caller connects to
 * the validated IP and never re-resolves the original hostname (DNS-
 * rebinding-safe, Warning 2).
 */
export async function assertSafeProbeUrl(
  raw: string,
  opts: AssertSafeProbeUrlOpts,
): Promise<URL> {
  // 1. Parse — throw on invalid URL.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }

  // 2. Protocol allowlist — http/https only.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https protocols are allowed");
  }

  // 3. Hostname-level literal block — cloud metadata is always blocked,
  //    regardless of allowLoopback. WHATWG URL keeps brackets in .hostname
  //    for IPv6 literals, so normalize once: strip the brackets for the
  //    literal-check and the DNS lookup (which wants the bare literal).
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;
  if (CLOUD_METADATA_LITERALS.has(hostname)) {
    throw new Error("Cloud-metadata endpoints are blocked");
  }
  if (hostname === "fd00:ec2::254") {
    throw new Error("Cloud-metadata endpoints are blocked");
  }

  // 4. Resolve hostname via node:dns/promises (all:true → every A/AAAA
  //    record). For an IP literal, dns.lookup returns the literal itself
  //    (no network) — but we short-circuit here to make the IP-classification
  //    path explicit and testable without mocking dns's IP-literal handling.
  //    If ANY resolved IP is in a blocked range, throw. If DNS fails, throw
  //    (do NOT fall through to an outbound request).
  let records: Array<{ address: string; family: number }>;
  if (isIP(hostname) !== 0) {
    records = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      const raw_records = await dnsLookup(hostname, { all: true });
      records = (raw_records as Array<{ address: string; family: number }>) ?? [];
    } catch {
      throw new Error("Could not resolve hostname");
    }
  }
  if (records.length === 0) {
    throw new Error("Could not resolve hostname");
  }
  for (const r of records) {
    if (isBlockedIp(r.address, opts.allowLoopback)) {
      throw new Error("Resolved address is in a blocked range");
    }
  }

  // 5. PIN THE RESOLVED IP (DNS-rebinding defense, Warning 2): rewrite the
  //    returned URL's hostname to the first safe resolved IP so the caller
  //    connects to the validated IP and never re-resolves the hostname.
  //    IPv6 literals are bracket-wrapped per RFC 3986 / WHATWG URL.
  const firstSafe = records[0]!.address;
  let pinnedHost: string;
  if (isIP(firstSafe) === 6) {
    pinnedHost = `[${firstSafe}]`;
  } else {
    pinnedHost = firstSafe;
  }
  parsed.hostname = pinnedHost;
  // Setting .hostname alone leaves .host stale in some URL implementations
  // (it recomputes host from hostname+port). Force a clean rebuild by
  // constructing a fresh URL from the components.
  const port = parsed.port ? `:${parsed.port}` : "";
  const rebuilt = new URL(
    `${parsed.protocol}//${pinnedHost}${port}${parsed.pathname}${parsed.search}${parsed.hash}`,
  );
  return rebuilt;
}