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
      // Phase 195 (MCPO-01 D-16): point the OAUTH_GOOGLE_* registry overrides
      // at the in-spec fake IdP/token endpoint (fixed port — the same
      // constant e2e/mcp-oauth-flow.spec.ts spawns its fake server on). The
      // spec skips with a documented reason when a stale server without
      // these overrides is reused (never phones home to real IdP hosts).
      // Phase 196 (MCPO-04 D-11): the connector full-mock arm — the same
      // env object also carries GDRIVE_API_BASE_URL / GRAPH_API_BASE_URL /
      // COLLECTOR_URL / OLLAMA_BASE_URL (+ the microsoft OAUTH_* /
      // MICROSOFT_CLIENT_* twins) pointing at the in-spec fakes spawned by
      // e2e/mcp-connector-tools.spec.ts (fixed ports 45913/45914/45915).
      // The probe in that spec gates every connector fetch on the same
      // override-pickup proof (stale server ⇒ skip with reason, never
      // phone home).
      env: {
        E2E_RUN: "1",
        OAUTH_GOOGLE_AUTH_URL: "http://127.0.0.1:45912/authorize",
        OAUTH_GOOGLE_TOKEN_URL: "http://127.0.0.1:45912/token",
        // Phase 196: microsoft rides the SAME fake IdP endpoint (the spec's
        // microsoft connection arm asserts the authorizeUrl shape the same
        // way; the fake token endpoint echoes scopes — full-URL form).
        OAUTH_MICROSOFT_AUTH_URL: "http://127.0.0.1:45912/authorize",
        OAUTH_MICROSOFT_TOKEN_URL: "http://127.0.0.1:45912/token",
        // D-06: the start route 400-gates without client creds — arbitrary
        // E2E-only values (never real secrets; the fake token endpoint does
        // not validate them).
        GOOGLE_CLIENT_ID: "test-google-id",
        GOOGLE_CLIENT_SECRET: "test-google-secret",
        MICROSOFT_CLIENT_ID: "test-ms-id",
        MICROSOFT_CLIENT_SECRET: "test-ms-secret",
        // Phase 196 connector fakes (fixed ports — the same constants
        // e2e/mcp-connector-tools.spec.ts listens on).
        GDRIVE_API_BASE_URL: "http://127.0.0.1:45913",
        GRAPH_API_BASE_URL: "http://127.0.0.1:45914",
        // Phase 197 (MCPO-05): the fake Gmail API listener (fixed port — the
        // same constant e2e/gmail-marketplace-oauth.spec.ts listens on).
        // The probe in that spec gates every gmail fetch on the same
        // override-pickup proof (stale server ⇒ skip with reason, never
        // phone home).
        GMAIL_API_BASE_URL: "http://127.0.0.1:45916",
        // The collector is NOT in the webServer trio — point the ingest
        // bridge at the in-spec fake Graph+collector listener (every other
        // E2E spec already tolerates collector absence; fire-and-forget
        // dispatches fail fast exactly as they do against an absent :3210).
        COLLECTOR_URL: "http://127.0.0.1:45914",
        // The fake ollama daemon (scripted NDJSON /api/chat) — the agent
        // loop runs REAL while the LLM seam stays in-process full-mock.
        OLLAMA_BASE_URL: "http://127.0.0.1:45915",
        LLM_PROVIDER: "ollama",
      },
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