// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { loadRootEnv, resolveRootEnvPath } from "@simmetric-chat/shared";

// OPS-05 (D-12) lineage: env paths resolve __dirname-relative, not
// process.cwd(). The per-package .env file was REMOVED (Phase 177 cleanup)
// — the repo-root .env is THE single runtime config. ENV_PATH points at the
// root file (marker-walk; cwd-adjacent fallback when no
// pnpm-workspace.yaml exists up-chain); it feeds the fail-loud Zod
// diagnostics below (`Expected .env at:`) and is intentionally NOT
// exported (nothing outside this module reads it — Phase 180 sweep).
const ENV_PATH = resolveRootEnvPath(__dirname);

// Root-only loader: fills ONLY keys absent from process.env. loadRootEnv
// logs via bare console, so the z/logger imports below stay exactly where
// they are — do NOT reorder them.
loadRootEnv(__dirname);

import { z } from "zod";
import { logger } from "../utils/logger";

// Phase 178.1 (CF-08): exported for the envExampleParity tripwire's shape
// introspection only — do not mutate (.shape is mutable in Zod).
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  WIDGET_PORT: z.coerce.number().default(3211),
  SERVER_URL: z.string().default("http://localhost:3000"),
  WIDGET_API_KEY: z.string().min(1, "WIDGET_API_KEY is required"),
  LOG_LEVEL: z.string().default("info"),
  REDIS_URL: z.string().optional(),
});

export type WidgetEnv = z.infer<typeof envSchema>;

let parsedEnv: WidgetEnv | null = null;

export function getEnv(): WidgetEnv {
  if (!parsedEnv) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      // OPS-05 (D-13): actionable diagnostic naming resolved .env path +
      // missing keys BEFORE the non-zero exit. No raw secret values logged.
      const missing = result.error.issues
        .filter(
          (i) =>
            i.code === "invalid_type" &&
            i.message.includes("received undefined"),
        )
        .map((i) => i.path.join("."))
        .join(", ");
      logger.error(
        `[widget/env] Invalid environment variables. Expected .env at: ${ENV_PATH}` +
          (missing ? `\n[widget/env] Missing required key(s): ${missing}` : "") +
          `\n[widget/env] Validation errors: ${JSON.stringify(
            result.error.flatten().fieldErrors,
          )}`,
      );
      process.exit(1);
    }
    parsedEnv = result.data;
  }
  return parsedEnv;
}