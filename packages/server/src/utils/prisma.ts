// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { PrismaClient } from "@prisma/client";
import { getEnv } from "../config/env";

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

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter: createAdapter() });
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