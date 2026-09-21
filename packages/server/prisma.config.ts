import "dotenv/config";
import { defineConfig, env } from "prisma/config";

type Env = {
  DATABASE_URL: string;
};

export default defineConfig({
  // D-08: directory mode — reads ALL .prisma files in prisma/ (setup for
  // Phase 143 schema-enterprise.prisma). Verified byte-identical to the
  // single-file path when only schema.prisma is present.
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  datasource: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://simmetricchat:simmetricchat@localhost:5432/simmetricchat",
    // Shadow DB for `migrate dev`/`migrate diff --from-migrations` (created
    // locally with CREATE DATABASE; dev/CI-only — never used at runtime).
    shadowDatabaseUrl:
      process.env.PRISMA_SHADOW_DATABASE_URL ||
      "postgresql://simmetricchat:simmetricchat@localhost:5432/prisma_shadow",
  },
});
