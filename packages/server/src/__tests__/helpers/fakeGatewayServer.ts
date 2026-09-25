// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 199 (199-03 Task 2, A5/A6/D-11) — the fake ws gateway seam for the
 * discordGateway unit suite.
 *
 * NOT a listening server: the manager's GatewayClient opens its socket
 * through the injected setGatewaySocketFactory factory (constructor
 * injection — NO moduleNameMapper, NO __mocks__/ws.ts needed since ws is
 * CJS and loads fine under @swc/jest; A6's fallback is moot). This module
 * provides the FakeGatewaySocket the factory returns plus the
 * FakeGatewayServer harness the tests drive frames/closes with — ZERO real
 * sockets (WS EGRESS BLOCKED discipline).
 *
 * FakeGatewayServer records every frame the client SENDS
 * (identify/resume/heartbeat — JSON.stringify'd by the client) and emits
 * message/close events on demand via driveText/driveClose.
 */

export type GatewayFrameListener = (data: unknown, isBinary: boolean) => void;
export type GatewayCloseListener = (code: number, reason: Buffer) => void;
export type GatewayOpenListener = () => void;
export type GatewayErrorListener = (err: Error) => void;

/** One recorded outgoing client frame (parsed). */
export interface RecordedGatewayFrame {
  op: number;
  d?: unknown;
  t?: string;
  s?: number | null;
}

/**
 * The fake WebSocket the injected factory hands to GatewayClient. Records
 * sent payloads; exposes driver* methods for the test to emit server-side
 * events.
 */
export class FakeGatewaySocket {
  private sent: string[] = [];
  closedCodes: number[] = [];
  terminated = false;

  /** The per-event listener registry (indexable by the on() impl). */
  private listenerMap: Record<string, ((...args: unknown[]) => void)[]> = {};

  on(event: string, listener: (...args: unknown[]) => void): void {
    const bucket = this.listenerMap[event] ?? [];
    bucket.push(listener);
    this.listenerMap[event] = bucket;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedCodes.push(code ?? 1005);
  }

  terminate(): void {
    this.terminated = true;
  }

  // ── fake-server drivers ─────────────────────────────────────────────

  driverOpen(): void {
    for (const l of [...(this.listenerMap.open ?? [])]) l();
  }

  driverText(payload: unknown): void {
    const data = Buffer.from(JSON.stringify(payload));
    for (const l of [...(this.listenerMap.message ?? [])]) l(data, false);
  }

  driverRaw(raw: string, isBinary = false): void {
    const data = Buffer.from(raw);
    for (const l of [...(this.listenerMap.message ?? [])]) l(data, isBinary);
  }

  driverClose(code: number): void {
    for (const l of [...(this.listenerMap.close ?? [])]) l(code, Buffer.alloc(0));
  }

  // ── inspection ──────────────────────────────────────────────────────

  sentFrames(): RecordedGatewayFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as RecordedGatewayFrame);
  }

  framesOfOp(op: number): RecordedGatewayFrame[] {
    return this.sentFrames().filter((f) => f.op === op);
  }
}

/**
 * The harness: the setGatewaySocketFactory body. Collects every created
 * socket; `latest` is the one GatewayClient most recently opened.
 */
export class FakeGatewayServer {
  readonly sockets: FakeGatewaySocket[] = [];
  readonly urls: string[] = [];

  factory = (url: string): FakeGatewaySocket => {
    this.urls.push(url);
    const sock = new FakeGatewaySocket();
    this.sockets.push(sock);
    return sock;
  };

  get latest(): FakeGatewaySocket | undefined {
    return this.sockets[this.sockets.length - 1];
  }

  /** HELLO handshake driver on the latest socket. */
  hello(heartbeatInterval = 41250): void {
    const sock = this.latest;
    if (!sock) throw new Error("no socket created yet");
    sock.driverOpen();
    sock.driverText({ op: 10, d: { heartbeat_interval: heartbeatInterval } });
  }

  reset(): void {
    (this.sockets as unknown as unknown[]).length = 0;
    (this.urls as unknown as unknown[]).length = 0;
  }
}