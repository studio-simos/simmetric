// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import winston from "winston";

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${ts} [${level}]: ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  // Structural exception: read process.env.LOG_LEVEL directly instead of via
  // getEnv(). This module is imported BY config/env.ts (env.ts imports `logger`
  // to log schema-validation errors), so it executes before getEnv() can parse.
  // Calling getEnv() here would create a circular dependency and run before the
  // Zod schema is applied. LOG_LEVEL is still declared in the env schema for
  // documentation and for any caller that reads it via getEnv(); this init path
  // is the accepted exception. See .planning/codebase/CONCERNS.md.
  level: process.env.LOG_LEVEL || "info",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), logFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), logFormat),
    }),
    new winston.transports.File({
      filename: "storage/logs/error.log",
      level: "error",
      maxsize: 5_242_880, // 5MB
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: "storage/logs/combined.log",
      maxsize: 5_242_880,
      maxFiles: 5,
    }),
  ],
});