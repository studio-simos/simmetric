-- Phase 193 (LDAP-01/02, D-03/D-04): additive-only LDAP substrate.
-- SsoConfig gains the 10 nullable ldap columns (string-union 'ldap' joins
-- the provider set — string column, no constraint migration); the new
-- ldap_group_role_map table backs the LdapGroupRoleMap model with a
-- cascade FK to roles + the (ldapGroupDn, roleId) unique pair.
-- ZERO data-manipulation statements by design (additive-only policy: the
-- statements below are CREATE/ADD only). Existing rows keep NULL ldap
-- fields and the Boolean defaults (ldapUseTls=true, ldapFallbackToLocal=true).
-- Authored via prisma migrate diff --from-migrations (Prisma 7 migrate dev
-- is TTY-locked); applied via prisma migrate deploy.

-- AlterTable
ALTER TABLE "sso_configs" ADD COLUMN     "ldapAcceptCert" TEXT,
ADD COLUMN     "ldapBindDn" TEXT,
ADD COLUMN     "ldapBindPasswordEncrypted" TEXT,
ADD COLUMN     "ldapFallbackToLocal" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ldapGroupSearchBase" TEXT,
ADD COLUMN     "ldapGroupSearchFilter" TEXT,
ADD COLUMN     "ldapSearchBase" TEXT,
ADD COLUMN     "ldapSearchFilter" TEXT,
ADD COLUMN     "ldapUrl" TEXT,
ADD COLUMN     "ldapUseTls" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ldap_group_role_map" (
    "id" TEXT NOT NULL,
    "ldapGroupDn" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "ldap_group_role_map_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ldap_group_role_map_ldapGroupDn_roleId_key" ON "ldap_group_role_map"("ldapGroupDn", "roleId");

-- AddForeignKey
ALTER TABLE "ldap_group_role_map" ADD CONSTRAINT "ldap_group_role_map_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;