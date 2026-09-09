// One-shot: set the SystemConfig VECTOR_DB_URL to the host-visible Qdrant
// endpoint for dev (Node services on host, Qdrant in Docker on 127.0.0.1:6333).
// Run: pnpm --filter server exec tsx scripts/fix-vector-url.ts
import { prisma } from "../src/utils/prisma";

async function main() {
  // Phase 183 (SAAS-02): inline find-first-then-write — no settings-service
  // import (standalone tsx CLI layering, mirrors seed.ts precedent); the
  // explicit null-org filter keeps the read composite-unique-safe (Plan 03
  // swap), the id-anchored update keeps the write swap-agnostic.
  const before = await prisma.systemConfig.findFirst({
    where: { key: "VECTOR_DB_URL", organizationId: null },
  });
  console.log("[fix-vector-url] before:", before?.value ?? "(unset)");
  const existing = await prisma.systemConfig.findFirst({
    where: { key: "VECTOR_DB_URL", organizationId: null },
  });
  if (existing) {
    await prisma.systemConfig.update({
      where: { id: existing.id },
      data: { value: "http://localhost:6333" },
    });
  } else {
    await prisma.systemConfig.create({
      data: { key: "VECTOR_DB_URL", value: "http://localhost:6333", organizationId: null },
    });
  }
  const after = await prisma.systemConfig.findFirst({
    where: { key: "VECTOR_DB_URL", organizationId: null },
  });
  console.log("[fix-vector-url] after :", after?.value);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[fix-vector-url] failed:", e);
  process.exit(1);
});