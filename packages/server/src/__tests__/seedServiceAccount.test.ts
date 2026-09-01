// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for seedServiceAccount() — covers fresh-seed, weak-password
 * rotation, and strong-password no-op paths. Verifies the widget-service
 * account is never seeded with a legacy hardcoded password and that BOTH
 * historical weak defaults ("testpassword123" from this seeder, "widget123"
 * from prisma/seed.ts) get rotated on existing installs.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma, withSoftDelete: (w: unknown) => w };
});

import bcrypt from "bcryptjs";
import prisma from "../utils/prisma";
import { seedServiceAccount } from "../services/seedService";

const WEAK_PASSWORDS = ["testpassword123", "widget123"] as const;
const WEAK_PASSWORD = WEAK_PASSWORDS[0];

describe("seedServiceAccount", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates account with a non-weak random password when none exists", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue({ email: "widget-service@system" });

    await seedServiceAccount();

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();

    const createArgs = (prisma.user.create as jest.Mock).mock.calls[0][0];
    const seededHash = createArgs.data.passwordHash;
    expect(seededHash).toBeTruthy();
    expect(await bcrypt.compare(WEAK_PASSWORD, seededHash)).toBe(false);
  });

  it.each(WEAK_PASSWORDS)(
    "rotates the password when existing account still has the weak hash (%s)",
    async (weakPassword) => {
      const weakHash = await bcrypt.hash(weakPassword, await bcrypt.genSalt(12));
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({
        id: "svc-1",
        email: "widget-service@system",
        passwordHash: weakHash,
      });
      (prisma.user.update as jest.Mock).mockResolvedValue({ id: "svc-1" });

      await seedServiceAccount();

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).not.toHaveBeenCalled();

      const updateArgs = (prisma.user.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: "svc-1" });

      const rotatedHash = updateArgs.data.passwordHash;
      expect(rotatedHash).toBeTruthy();
      expect(rotatedHash).not.toBe(weakHash);
      expect(await bcrypt.compare(weakPassword, rotatedHash)).toBe(false);
    },
  );

  it("leaves a strong existing password untouched", async () => {
    const strongHash = await bcrypt.hash("a-very-strong-unique-secret", await bcrypt.genSalt(12));
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: "svc-2",
      email: "widget-service@system",
      passwordHash: strongHash,
    });

    await seedServiceAccount();

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
