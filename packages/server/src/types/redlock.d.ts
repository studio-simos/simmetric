// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

declare module "redlock" {
  import { EventEmitter } from "events";
  import { Redis as IORedisClient, Cluster as IORedisCluster } from "ioredis";

  type Client = IORedisClient | IORedisCluster;

  export interface Settings {
    readonly driftFactor: number;
    readonly retryCount: number;
    readonly retryDelay: number;
    readonly retryJitter: number;
    readonly automaticExtensionThreshold: number;
  }

  export class ResourceLockedError extends Error {
    readonly message: string;
    constructor(message: string);
  }

  export class ExecutionError extends Error {
    readonly message: string;
    readonly attempts: ReadonlyArray<Promise<unknown>>;
    constructor(message: string, attempts: ReadonlyArray<Promise<unknown>>);
  }

  export class Lock {
    readonly redlock: Redlock;
    readonly resources: string[];
    readonly value: string;
    readonly attempts: ReadonlyArray<Promise<unknown>>;
    expiration: number;
    constructor(redlock: Redlock, resources: string[], value: string, attempts: ReadonlyArray<Promise<unknown>>, expiration: number);
    release(): Promise<unknown>;
    extend(duration: number): Promise<Lock>;
  }

  export type RedlockAbortSignal = AbortSignal & { error?: Error };

  export default class Redlock extends EventEmitter {
    readonly clients: Set<Client>;
    readonly settings: Settings;
    constructor(clients: Iterable<Client>, settings?: Partial<Settings>);
    quit(): Promise<void>;
    acquire(resources: string[], duration: number, settings?: Partial<Settings>): Promise<Lock>;
    release(lock: Lock, settings?: Partial<Settings>): Promise<unknown>;
    extend(existing: Lock, duration: number, settings?: Partial<Settings>): Promise<Lock>;
    using<T>(resources: string[], duration: number, settings: Partial<Settings>, routine?: (signal: RedlockAbortSignal) => Promise<T>): Promise<T>;
    using<T>(resources: string[], duration: number, routine: (signal: RedlockAbortSignal) => Promise<T>): Promise<T>;
  }
}
