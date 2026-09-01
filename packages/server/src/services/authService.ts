// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { getEnv } from "../config/env";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getRedis } from "./redisService";
import { loginSchema, registerSchema } from "@simmetric-chat/shared";
import type { LoginInput, RegisterInput } from "@simmetric-chat/shared";

const SALT_ROUNDS = 12;

// T-DRD-04 (G-5): login timing hardening. A user-not-found path that returns
// without a bcrypt.compare is measurably faster than the user-found path,
// letting an attacker enumerate valid usernames via response timing. This
// fixed throwaway hash (bcrypt of a random-looking constant, SALT_ROUNDS 12)
// is compared against on the not-found branch so both paths cost one bcrypt
// compare and the response is identical (401 "Invalid credentials").
// Computed lazily so importing the module never pays the cost; cached for
// the process lifetime after the first call.
let dummyPasswordHash: string | null = null;
function getDummyPasswordHash(): string {
  if (!dummyPasswordHash) {
    dummyPasswordHash = bcrypt.hashSync(
      "timing-equalization-throwaway-password-constant",
      SALT_ROUNDS,
    );
  }
  return dummyPasswordHash;
}

export async function register(input: RegisterInput) {
  const validated = registerSchema.parse(input);

  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ username: validated.username }, { email: validated.email }],
    },
  });

  if (existingUser) {
    throw new Error("Username or email already exists");
  }

  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const passwordHash = await bcrypt.hash(validated.password, salt);

  const user = await prisma.user.create({
    data: {
      username: validated.username,
      email: validated.email,
      passwordHash,
      salt,
      // Admin-created users must rotate their initial password on first login (D-01).
      mustChangePassword: true,
    },
  });

  // Assign default "user" role
  const defaultRole = await prisma.role.findFirst({ where: { isDefault: true, name: "user" } });
  if (defaultRole) {
    await prisma.userRole.create({
      data: { userId: user.id, roleId: defaultRole.id },
    });
  }

  const token = generateToken(user.id);

  // Fetch roles and permissions for the newly registered user
  const userWithRoles = await getUserWithRoles(user.id);
  const permissions = new Set<string>();
  const roles: { id: string; name: string; isDefault: boolean }[] = [];
  if (userWithRoles) {
    for (const userRole of userWithRoles.roles) {
      roles.push({ id: userRole.role.id, name: userRole.role.name, isDefault: userRole.role.isDefault });
      for (const rp of userRole.role.permissions) {
        permissions.add(rp.permissionName);
      }
    }
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      customInstructions: user.customInstructions,
      textSize: user.textSize,
      mustChangePassword: user.mustChangePassword,
      roles,
      permissions: Array.from(permissions),
    },
    token,
  };
}

export async function login(input: LoginInput) {
  const validated = loginSchema.parse(input);

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ username: validated.username }, { email: validated.username }],
    },
  });

  if (!user) {
    // T-DRD-04: burn the same bcrypt cost as the user-found path so the
    // response timing does not reveal whether the username exists.
    await bcrypt.compare(validated.password, getDummyPasswordHash());
    throw new Error("Invalid credentials");
  }

  const passwordValid = await bcrypt.compare(validated.password, user.passwordHash);
  if (!passwordValid) {
    throw new Error("Invalid credentials");
  }

  const token = generateToken(user.id);

  // Fetch roles and permissions for the logged-in user
  const userWithRoles = await getUserWithRoles(user.id);
  const permissions = new Set<string>();
  const roles: { id: string; name: string; isDefault: boolean }[] = [];
  if (userWithRoles) {
    for (const userRole of userWithRoles.roles) {
      roles.push({ id: userRole.role.id, name: userRole.role.name, isDefault: userRole.role.isDefault });
      for (const rp of userRole.role.permissions) {
        permissions.add(rp.permissionName);
      }
    }
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      customInstructions: user.customInstructions,
      textSize: user.textSize,
      mustChangePassword: user.mustChangePassword,
      roles,
      permissions: Array.from(permissions),
    },
    token,
  };
}

export function generateToken(userId: string): string {
  const env = getEnv();
  return jwt.sign({ userId, jti: crypto.randomUUID() }, env.JWT_SECRET, {
    expiresIn: env.SESSION_EXPIRY / 1000, // convert ms to seconds
  });
}

export function verifyToken(token: string): { userId: string; jti?: string } {
  const env = getEnv();
  return jwt.verify(token, env.JWT_SECRET) as { userId: string; jti?: string };
}

export async function getUserWithRoles(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: { permission: true },
              },
            },
          },
        },
      },
    },
  });
}

// D-07 (Phase 104): Auth context caching via Redis. Cache key: auth:user:{userId}.
// TTL: SESSION_EXPIRY / 1000 (seconds). On cache hit, returns the cached user
// without a DB round-trip. On miss or Redis unavailable, falls through to the
// existing getUserWithRoles() DB query and writes the result to Redis.
// All Redis operations are non-blocking (try/catch with [redis] prefix warnings).
const AUTH_CACHE_PREFIX = "auth:user:";

export async function getCachedUserWithRoles(userId: string) {
  const redis = getRedis();
  const cacheKey = `${AUTH_CACHE_PREFIX}${userId}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err: unknown) {
      logger.warn("[redis] auth cache read failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Cache miss or Redis unavailable → DB query
  const user = await getUserWithRoles(userId);

  if (redis && user) {
    try {
      const ttl = Math.floor(getEnv().SESSION_EXPIRY / 1000);
      await redis.setex(cacheKey, ttl, JSON.stringify(user));
    } catch (err: unknown) {
      logger.warn("[redis] auth cache write failed (non-blocking)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return user;
}

// D-07: Invalidate the auth cache for a user. Called on role change, password
// change, or user delete to prevent stale privilege escalation (Pitfall 3).
// Fire-and-forget (non-blocking) — cache invalidation failure is logged but
// does not throw; the TTL ensures eventual consistency.
export async function invalidateAuthCache(userId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`${AUTH_CACHE_PREFIX}${userId}`);
  } catch (err: unknown) {
    logger.warn("[redis] auth cache invalidation failed (non-blocking)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}