// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { PrismaClient } from "@prisma/client";
import { getEnv } from "../config/env";
import { tenantScope } from "./scopedPrisma";

function createAdapter() {
  const rawUrl = getEnv().DATABASE_URL;
  const { PrismaPg } = require("@prisma/adapter-pg");
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: rawUrl });
  return new PrismaPg(pool);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Base singleton — the ONLY `new PrismaClient()` in the repo (repo hard rule).
 * Cached on globalThis to survive tsx-watch module reloads.
 */
const baseClient = globalForPrisma.prisma ?? new PrismaClient({ adapter: createAdapter() });

/**
 * Phase 185 (SAAS-04b, D-03/D-04): the singleton is exported THROUGH the
 * tenantScope extension — every existing
 * `import prisma from "../utils/prisma"` call site now flows through the
 * defense-in-depth read scoping. The extension AND-merges organizationId into
 * top-level reads of TENANT_READ_MODELS, skips findUnique/upsert/create
 * (PK-keyed + D-04 semantics — see scopedPrisma.ts), honors the bypass
 * sentinel, and skips when the ALS store is absent (jobs/boot). This is the
 * ONLY structural change here; the withSoftDelete passthrough below is
 * untouched (composer discipline: both compose, never replace).
 *
 * The cast is TYPE-ONLY (Rule 3, 185-01): $extends with a pure query component
 * adds no result/model/client behavior, but its DynamicClientExtensionThis
 * type is structurally incompatible with `PrismaClient`/`TransactionClient`
 * (delegate Exact<> variance — verified by probe: the composed tx is not
 * assignable to Prisma.TransactionClient). Callers' types must stay
 * byte-identical (94 importers, `PrismaDbClient = typeof prisma | tx` unions,
 * integration-suite `let prisma: PrismaClient` bindings) — the same
 * type-parity discipline as the removed $use middleware, which never changed
 * the client type. Runtime behavior of the composed client ($connect/
 * $disconnect/$transaction/$queryRaw + every delegate) is verified by the
 * tenantScopeSpike integration suite.
 */
export const prisma = baseClient.$extends(tenantScope()) as unknown as PrismaClient;
export default prisma;

/**
 * Type-preserving no-op for Prisma `where:` clauses that include a
 * `deletedAt: null` soft-delete filter. Many call sites previously
 * wrote `as any` to bypass the Prisma generated-type's strict
 * union on the `deletedAt` field. The generic keeps the input type
 * intact so downstream `findUnique` / `findMany` / `findFirst`
 * overloads continue to resolve to the correct model variant.
 */
export function withSoftDelete<T extends object>(where: T): T {
  return where;
}