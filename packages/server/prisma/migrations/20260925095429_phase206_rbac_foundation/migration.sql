-- Phase 206 (AGENCY-01..04, CLOUD-01, VIS-01) — RBAC foundation, additive-only.
-- UserSponsorship (D-01), UserPermissionOverride (D-09), RoleSectionVisibility (D-14),
-- User.disabledAt (D-05), User.maxSponsoredUsers (D-11). First migration of the
-- v0.27 sequence (206 → 207 → 208 → 209 coordination point).

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "maxSponsoredUsers" INTEGER;

-- CreateTable
CREATE TABLE "user_sponsorships" (
    "id" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "subUserId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_sponsorships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permission_overrides" (
    "userId" TEXT NOT NULL,
    "permissionName" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("userId","permissionName")
);

-- CreateTable
CREATE TABLE "role_section_visibilities" (
    "roleId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL,

    CONSTRAINT "role_section_visibilities_pkey" PRIMARY KEY ("roleId","sectionKey")
);

-- CreateIndex
CREATE INDEX "user_sponsorships_subUserId_idx" ON "user_sponsorships"("subUserId");

-- CreateIndex
CREATE UNIQUE INDEX "user_sponsorships_sponsorId_subUserId_key" ON "user_sponsorships"("sponsorId", "subUserId") WHERE ("deletedAt" IS NULL);

-- AddForeignKey
ALTER TABLE "user_sponsorships" ADD CONSTRAINT "user_sponsorships_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sponsorships" ADD CONSTRAINT "user_sponsorships_subUserId_fkey" FOREIGN KEY ("subUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_permissionName_fkey" FOREIGN KEY ("permissionName") REFERENCES "permissions"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_section_visibilities" ADD CONSTRAINT "role_section_visibilities_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

