// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import express from "express";
import cors from "cors";
import { getEnv } from "./config/env";
import { logger } from "./utils/logger";
import ingestRoutes from "./routes/ingest";

const env = getEnv();
const PORT = env.COLLECTOR_PORT;

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "collector", timestamp: new Date().toISOString() });
});

// Ingestion routes
app.use("/api", ingestRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Multer file filter rejection → 415 Unsupported Media Type
  if (err.message && err.message.startsWith("Unsupported file type")) {
    res.status(415).json({ error: err.message });
    return;
  }
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  logger.info(`[collector] Listening on port ${PORT}`);
  logger.info(`[collector] Embedding provider: ${env.EMBEDDING_PROVIDER}`);
  logger.info(`[collector] Vector DB provider: ${env.VECTOR_DB_PROVIDER}`);
});

export default app;