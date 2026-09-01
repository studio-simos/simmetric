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
  },
});
