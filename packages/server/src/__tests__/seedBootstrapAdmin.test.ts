// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for seedBootstrapAdmin() — covers the fresh-seed path (admin
 * created with mustChangePassword=true and the admin role), and every skip
 * guard: admin already exists, admin role missing, configured handle already
 * taken, toggle disabled, and custom env credentials honored.
 *
 * The bootstrap password is a single-use credential: it is never persisted as
 * a usable long-term password because mustChangePassword forces a rotation at
 * first login via /api/auth/set-initial-password.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma, withSoftDelete: (w: unknown) => w };
});

import bcrypt from "bcryptjs";
import prisma from "../utils/prisma";
import { seedBootstrapAdmin } from "../services/seedService";
import { clearEnvCache } from "../config/env";

const ADMIN_ROLE = { id: "role-admin-1", name: "admin" };

describe("seedBootstrapAdmin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearEnvCache();
    // Phase 152 (WIZ-02, D-05): default the wizard mode to "completed" so
    // existing tests exercise the historical seed path. The wizard-active
    // skip guard reads setup_wizard_mode via getSetting → prisma mock.
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: "setup_wizard_mode",
      value: "completed",
    });
  });

  afterEach(() => {
    // Restore env vars that individual tests may have overridden.
    delete process.env.SEED_BOOTSTRAP_ADMIN;
    delete process.env.SEED_ADMIN_USERNAME;
    delete process.env.SEED_ADMIN_PASSWORD;
    delete process.env.SEED_ADMIN_EMAIL;
    clearEnvCache();
  });

  it("creates the admin with mustChangePassword=true and assigns the admin role (default credentials)", async () => {
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(ADMIN_ROLE);
    (prisma.userRole.count as jest.Mock).mockResolvedValue(0);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null); // handle free
    (prisma.user.create as jest.Mock).mockResolvedValue({ id: "user-1", username: "admin" });
    (prisma.userRole.create as jest.Mock).mockResolvedValue({});

    await seedBootstrapAdmin();

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    const createArgs = (prisma.user.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      username: "admin",
      email: "admin@example.com",
      mustChangePassword: true,
    });
    // The hash must match the default bootstrap password "admin123".
    expect(await bcrypt.compare("admin123", createArgs.data.passwordHash)).toBe(true);
    // The admin role must be linked.
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: { userId: "user-1", roleId: ADMIN_ROLE.id },
    });
  });

  it("skips seeding when an admin user already exists (never resets a real admin)", async () => {
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(ADMIN_ROLE);
    (prisma.userRole.count as jest.Mock).mockResolvedValue(1);

    await seedBootstrapAdmin();

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.userRole.create).not.toHaveBeenCalled();
    // The handle collision check must not even run once an admin exists.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("skips seeding when the admin role is not found", async () => {
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(null);

    await seedBootstrapAdmin();

    expect(prisma.userRole.count).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.userRole.create).not.toHaveBeenCalled();
  });

  it("skips seeding when the configured username/email is already taken by a non-admin", async () => {
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(ADMIN_ROLE);
    (prisma.userRole.count as jest.Mock).mockResolvedValue(0);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: "other-1", username: "admin" });

    await seedBootstrapAdmin();

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.userRole.create).not.toHaveBeenCalled();
  });

  it("skips seeding when SEED_BOOTSTRAP_ADMIN=false", async () => {
    process.env.SEED_BOOTSTRAP_ADMIN = "false";
    clearEnvCache();

    await seedBootstrapAdmin();

    expect(prisma.role.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.userRole.create).not.toHaveBeenCalled();
  });

  it("honors custom SEED_ADMIN_* env credentials", async () => {
    process.env.SEED_ADMIN_USERNAME = "rootadmin";
    process.env.SEED_ADMIN_PASSWORD = "a-stronger-bootstrap-pw";
    process.env.SEED_ADMIN_EMAIL = "root@example.com";
    clearEnvCache();

    (prisma.role.findFirst as jest.Mock).mockResolvedValue(ADMIN_ROLE);
    (prisma.userRole.count as jest.Mock).mockResolvedValue(0);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue({ id: "user-2", username: "rootadmin" });
    (prisma.userRole.create as jest.Mock).mockResolvedValue({});

    await seedBootstrapAdmin();

    const createArgs = (prisma.user.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      username: "rootadmin",
      email: "root@example.com",
      mustChangePassword: true,
    });
    expect(await bcrypt.compare("a-stronger-bootstrap-pw", createArgs.data.passwordHash)).toBe(true);
    // The default password must NOT validate against the custom hash.
    expect(await bcrypt.compare("admin123", createArgs.data.passwordHash)).toBe(false);
  });

  // Phase 152 (WIZ-02, D-05): the wizard owns admin creation when active.
  // The skip guard MUST run AFTER the SEED_BOOTSTRAP_ADMIN env toggle check
  // (env override still wins for docker/CI) and BEFORE the admin-role lookup,
  // so prisma.role.findFirst / userRole.count / user.create are never called.
  it("skips seeding when setup_wizard_mode=active (wizard owns admin creation)", async () => {
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: "setup_wizard_mode",
      value: "active",
    });

    await seedBootstrapAdmin();

    // The wizard path MUST NOT touch admin-creation queries.
    expect(prisma.role.findFirst).not.toHaveBeenCalled();
    expect(prisma.userRole.count).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.userRole.create).not.toHaveBeenCalled();
  });

  it("still skips when setup_wizard_mode=active and SEED_BOOTSTRAP_ADMIN=true (wizard skip wins over env default)", async () => {
    // SEED_BOOTSTRAP_ADMIN defaults to true. D-05 / WIZ-02 truth: the wizard
    // skip applies even when SEED_BOOTSTRAP_ADMIN=true — the env toggle is
    // only a hard-OFF override (false → skip), never a hard-ON override that
    // bypasses the wizard. The toggle check runs first so SEED_BOOTSTRAP_ADMIN=false
    // still short-circuits before the wizard read.
    (prisma.systemConfig.findUnique as jest.Mock).mockResolvedValue({
      key: "setup_wizard_mode",
      value: "active",
    });
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(ADMIN_ROLE);
    (prisma.userRole.count as jest.Mock).mockResolvedValue(0);

    await seedBootstrapAdmin();

    // Wizard skip wins — admin-creation queries never run.
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.userRole.create).not.toHaveBeenCalled();
  });
});