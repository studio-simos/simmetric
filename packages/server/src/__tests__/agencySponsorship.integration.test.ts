// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 206 (AGENCY-01/04, Plan 02 Task 4) — real-Postgres sponsorship
 * integration (worker-DB pattern, jest.config.integration.js).
 *
 * Journey:
 *  1. Agency creates a sub-user → User + OrganizationMember (sponsor's org,
 *     "member") + UserRole ("Utente Cloud", assignedVia "agency") +
 *     UserSponsorship rows in ONE transaction (D-01/D-02/D-20).
 *  2. Second create OK; third → 409 { error, quota: "users" } (ceiling 2).
 *  3. Sub-user LOGIN works (membership resolves tenant context — Pitfall 2)
 *     and /api/roles/me/menu-sections resolves the Utente Cloud menu set.
 *  4. Sub-user CANNOT create sub-users (D-03 structural guard — even if it
 *     held agency:users:manage, the sponsorship row refuses).
 */

import bcrypt from "bcryptjs";
import request from "supertest";
import {
  DEFAULT_ROLE_MENU_SECTIONS,
  DEFAULT_ROLES,
  PERMISSION_NAMES,
} from "@simmetric-chat/shared";

let prisma: import("@prisma/client").PrismaClient;
let app: { use: unknown } | any; // supertest target (typed loosely — supertest(request(app)))

const ORG_SLUG = "agency-206-int";
const AGENCY_PASSWORD = "agency-206-pass-K1";
const CLOUD_ROLE_NAME = "Utente Cloud";
const AGENCY_ROLE_NAME = "Web Agency";

let agencyUserId = "";
let agencyToken = "";
let orgId = "";

/** Per-test isolated agency (unique org + user + ceiling) — tests stay
 * order-independent under jest's sequential workers. */
async function makeAgencyUser(ceiling: number) {
  const salt = await bcrypt.genSalt(12);
  const agencyRole = await prisma.role.findUnique({ where: { name: AGENCY_ROLE_NAME } });
  const org = await prisma.organization.create({
    data: { name: `Agency 206 ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, slug: `agency-206-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  const agency = await prisma.user.create({
    data: {
      username: `agency206_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      email: `agency206_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@test.local`,
      passwordHash: await bcrypt.hash(AGENCY_PASSWORD, salt),
      salt,
      maxSponsoredUsers: ceiling,
      organizationMemberships: {
        create: { organizationId: org.id, roleInOrg: "admin" },
      },
      roles: { create: { roleId: agencyRole!.id, assignedVia: "manual" } },
    },
  });
  const { generateToken } = await import("../services/authService");
  return { agency, orgId: org.id, token: generateToken(agency.id) };
}

async function ensureRoles() {
  for (const roleDef of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { name: roleDef.name } });
    if (!existing) {
      await prisma.role.create({ data: { name: roleDef.name, description: roleDef.description, isDefault: roleDef.isDefault } });
    }
    const role = await prisma.role.findUnique({ where: { name: roleDef.name } });
    for (const permName of roleDef.permissions) {
      await prisma.permission.upsert({
        where: { name: permName },
        update: {},
        create: { name: permName, description: `Phase 206 fixture: ${permName}` },
      });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionName: { roleId: role!.id, permissionName: permName } },
        update: {},
        create: { roleId: role!.id, permissionName: permName },
      });
    }
    // Menu sections per the locked defaults (needed for the menu-sections assertion)
    const sections = DEFAULT_ROLE_MENU_SECTIONS[roleDef.name] ?? [];
    for (const section of sections) {
      await prisma.roleMenuSection.upsert({
        where: { roleId_menuSection: { roleId: role!.id, menuSection: section } },
        update: {},
        create: { roleId: role!.id, menuSection: section },
      });
    }
  }
}

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();

  await ensureRoles();

  const org = await prisma.organization.create({
    data: { name: "Agency 206 Org", slug: `agency-206-${Date.now()}` },
  });
  orgId = org.id;

  const salt = await bcrypt.genSalt(12);
  const agencyRole = await prisma.role.findUnique({ where: { name: AGENCY_ROLE_NAME } });
  const agency = await prisma.user.create({
    data: {
      username: `agency206_${Date.now()}`,
      email: `agency206_${Date.now()}@test.local`,
      passwordHash: await bcrypt.hash(AGENCY_PASSWORD, salt),
      salt,
      maxSponsoredUsers: 99,
      organizationMemberships: {
        create: { organizationId: orgId, roleInOrg: "admin" },
      },
      roles: { create: { roleId: agencyRole!.id, assignedVia: "manual" } },
    },
  });
  agencyUserId = agency.id;

  const { generateToken } = await import("../services/authService");
  agencyToken = generateToken(agencyUserId);
}, 60_000);

afterAll(async () => {
  // Fixture teardown (worker DB is isolated, but keep it clean anyway).
  if (orgId) {
    await prisma.user.deleteMany({ where: { organizationMemberships: { some: { organizationId: orgId } } } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
  const { default: prismaClient } = await import("../utils/prisma");
  await prismaClient.$disconnect();
});

function agencyApp() {
  return (async () => {
    const { getTestApp } = await import("./helpers/testApp");
    const app = await getTestApp();
    return request(app);
  })();
}

describe("Phase 206 sponsorship integration (real PG)", () => {
  it("creates sub-users transactionally and enforces the ceiling (AGENCY-01/04)", async () => {
    const agent = await agencyApp();
    const { token, orgId: scopedOrgId } = await makeAgencyUser(2);

    const first = await agent
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: `sub206_a_${Date.now()}`, email: `sub206a${Date.now()}@test.local` });
    expect(first.status).toBe(201);
    expect(first.body.user.mustChangePassword).toBe(true);
    const subA = first.body.user.id as string;

    // Transactional shape assertions (D-01/D-02/D-20)
    const sponsorship = await prisma.userSponsorship.findFirst({
      where: { subUserId: subA },
    });
    expect(sponsorship?.sponsorId).toBeTruthy();
    expect(sponsorship?.deletedAt).toBeNull();
    const membership = await prisma.organizationMember.findFirst({
      where: { userId: subA, organizationId: scopedOrgId, deletedAt: null },
    });
    expect(membership?.roleInOrg).toBe("member");
    const userRole = await prisma.userRole.findFirst({
      where: { userId: subA },
      include: { role: true },
    });
    expect(userRole?.role.name).toBe(CLOUD_ROLE_NAME);
    expect(userRole?.assignedVia).toBe("agency");

    // Second create within the ceiling → 201
    const second = await agent
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: `sub206_b_${Date.now()}`, email: `sub206b@test.local` });
    expect(second.status).toBe(201);

    // Third → ceiling breach (AGENCY-04 D-12)
    const third = await agent
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: `sub206_c_${Date.now()}`, email: `sub206c@test.local` });
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ error: "User ceiling reached", quota: "users" });
  });

  it("sub-user logs in and resolves the Utente Cloud tenant context (Pitfall 2)", async () => {
    const agent = await agencyApp();
    const { token } = await makeAgencyUser(99);
    const username = `sub206_login_${Date.now()}`;
    const create = await agent
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username, email: `${username}@test.local` });
    expect(create.status).toBe(201);
    const tempPassword = create.body.generatedPassword as string;

    // Real login (bcrypt + JWT) — the sub-user's membership resolves tenancy.
    const login = await agent.post("/api/auth/login").send({
      username,
      password: tempPassword,
    });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);

    // Menu sections: the Utente Cloud default set (CLOUD-01 D-18)
    const menus = await agent
      .get("/api/roles/me/menu-sections")
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(menus.status).toBe(200);
    const sections = menus.body as string[];
    for (const expected of DEFAULT_ROLE_MENU_SECTIONS[CLOUD_ROLE_NAME] ?? []) {
      expect(sections).toContain(expected);
    }
    expect(sections).not.toContain("eventLog");
    expect(sections).not.toContain("marketplace");
  });

  it("refuses a sub-user actor structurally even with the permission (D-03)", async () => {
    const agent = await agencyApp();
    const { token, agency } = await makeAgencyUser(99);
    // Grant the sub-user agency:users:manage DIRECTLY (hand-edited rows arm —
    // the structural guard must still refuse).
    const username = `sub206_d_${Date.now()}`;
    const create = await agent
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username, email: `${username}@test.local` });
    expect(create.status).toBe(201);
    const subUserId = create.body.user.id as string;

    const agencyPermName = PERMISSION_NAMES.find((p) => p === "agency:users:manage")!;
    await prisma.userPermissionOverride.create({
      data: { userId: subUserId, permissionName: agencyPermName, grantedBy: agencyUserId },
    });

    const { generateToken } = await import("../services/authService");
    const subToken = generateToken(subUserId);
    const attempt = await agent
      .post("/api/agency/users")
      .set("Authorization", `Bearer ${subToken}`)
      .send({ username: `sponsored_by_sub_${Date.now()}`, email: `x${Date.now()}@test.local` });

    expect(attempt.status).toBe(403);
  });
});
