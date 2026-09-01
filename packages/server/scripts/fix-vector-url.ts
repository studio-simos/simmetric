// One-shot: set the SystemConfig VECTOR_DB_URL to the host-visible Qdrant
// endpoint for dev (Node services on host, Qdrant in Docker on 127.0.0.1:6333).
// Run: pnpm --filter server exec tsx scripts/fix-vector-url.ts
import { prisma } from "../src/utils/prisma";

async function main() {
  const before = await prisma.systemConfig.findUnique({ where: { key: "VECTOR_DB_URL" } });
  console.log("[fix-vector-url] before:", before?.value ?? "(unset)");
  await prisma.systemConfig.upsert({
    where: { key: "VECTOR_DB_URL" },
    create: { key: "VECTOR_DB_URL", value: "http://localhost:6333" },
    update: { value: "http://localhost:6333" },
  });
  const after = await prisma.systemConfig.findUnique({ where: { key: "VECTOR_DB_URL" } });
  console.log("[fix-vector-url] after :", after?.value);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[fix-vector-url] failed:", e);
  process.exit(1);
});