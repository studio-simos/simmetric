import { defineConfig } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

if (!process.env.DATABASE_URL) {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^DATABASE_URL=(.+)$/m);
    if (match) process.env.DATABASE_URL = match[1].trim().replace(/^["']|["']$/g, "");
  }
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  // retries 2: the rename + synthesis-PENDING specs are historically flaky
  // under degraded CI (Ollama unreachable → slower page loads); they appear
  // as "flaky" (pass-on-retry) in green runs and hard-fail when the single
  // retry also hits the budget. Two retries absorb the variance (Phase 181).
  retries: 2,
  globalSetup: "./e2e/globalSetup.ts",
  use: {
    baseURL: "http://localhost:5173",
  },
  webServer: [
    {
      command: "pnpm --filter server exec tsx src/index.ts",
      port: 3000,
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120000,
      // Phase 169 E2E testability unblock (D-02 from 169-01): signal the server
      // to skip authRateLimiter for the E2E run. See rateLimit.ts isE2ERun.
      // NOTE: reuseExistingServer:true means a stale server started WITHOUT
      // this env (e.g. a prior `pnpm dev`) will NOT see E2E_RUN, and the 429
      // cascade will reproduce — kill stale servers (lsof -ti:3000) before a
      // fresh full-suite run if the cascade reappears. The globalSetup pre-
      // flight does not restart the server.
      env: { E2E_RUN: "1" },
    },
    {
      command: "pnpm --filter frontend exec vite preview",
      port: 5173,
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Same rationale as the server: `tsx watch` stalls on the CI runner, so
      // run the widget service once under plain `tsx`.
      command: "pnpm --filter widget exec tsx src/index.ts",
      port: 3211,
      reuseExistingServer: true,
      timeout: 60000,
    },
  ],
});