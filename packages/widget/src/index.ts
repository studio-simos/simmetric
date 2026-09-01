// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { logger } from "./utils/logger";
import chatRoutes from "./routes/chat";
import sessionRoutes from "./routes/session";
import configRoutes from "./routes/config";
import loaderRoutes from "./routes/loader";
import leadRoutes from "./routes/lead";
import { widgetChatLimiter, widgetDailyMessageLimiter, widgetSessionLimiter, widgetLeadLimiter } from "./middleware/rateLimit";
import { sessionMiddleware } from "./middleware/session";

export function createApp(): Express {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: false,
    frameguard: false, // Widget must be embeddable in iframes on external sites
    originAgentCluster: false, // Avoid inconsistent agent cluster keying in iframe context
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Route mounting
  // Serve Preact bundle (dist-widget/ created by Vite build in Plan 05)
  app.use("/widget", express.static(path.join(__dirname, "..", "dist-widget")));
  // Loader routes AFTER static serving so /widget/app.js is served by static middleware
  app.use("/widget", loaderRoutes);
  // D-02: express-rate-limit v8 RateLimitRequestHandler type-pinned — devDep resolved root cause, cast silences residual
  // 151-02 (G-151-1b): the daily per-widget+IP message cap runs BEFORE the
  // per-minute burst cap so the daily budget is always checked first.
  app.use("/api/chat", widgetDailyMessageLimiter as any, widgetChatLimiter as any, sessionMiddleware, chatRoutes);
  app.use("/api/sessions", widgetSessionLimiter as any, sessionRoutes);
  app.use("/api/config", configRoutes);
  app.use("/api/lead", widgetLeadLimiter as any, leadRoutes);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("[widget] Unhandled error", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

// Start server when run directly (not when imported by tests)
const isMainModule = typeof require !== "undefined" && require.main === module;
if (isMainModule) {
  const { getEnv } = require("./config/env");
  const env = getEnv();
  const app = createApp();
  app.listen(env.WIDGET_PORT, () => {
    logger.info(`[widget] Listening on port ${env.WIDGET_PORT}`);
  });
}

export default createApp;