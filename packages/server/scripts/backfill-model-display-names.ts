import prisma from "../src/utils/prisma";
import { logger } from "../src/utils/logger";

async function backfillModelDisplayNames() {
  logger.info("[backfill] Starting modelDisplayName backfill...");

  // Find all distinct model IDs that have null modelDisplayName
  const records = await prisma.workspaceTokenUsage.findMany({
    where: { modelDisplayName: null },
    select: { model: true },
    distinct: ["model"],
  });

  if (records.length === 0) {
    logger.info("[backfill] No records need backfilling.");
    return;
  }

  let updatedTotal = 0;
  let skippedTotal = 0;

  for (const { model } of records) {
    // Look up displayName in ProviderModel (any provider)
    const providerModel = await prisma.providerModel.findFirst({
      where: { name: model },
      select: { displayName: true },
    });

    if (providerModel?.displayName) {
      const result = await prisma.workspaceTokenUsage.updateMany({
        where: { model, modelDisplayName: null },
        data: { modelDisplayName: providerModel.displayName },
      });
      updatedTotal += result.count;
      logger.info(`[backfill] Updated ${result.count} records for model "${model}" -> "${providerModel.displayName}"`);
    } else {
      skippedTotal += 1;
      logger.warn(`[backfill] No displayName found for model "${model}". Skipping ${model} records.`);
    }
  }

  logger.info(`[backfill] Complete. Updated ${updatedTotal} records. Skipped ${skippedTotal} model types.`);
}

backfillModelDisplayNames()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("[backfill] Failed", { error: err.message });
    process.exit(1);
  });
