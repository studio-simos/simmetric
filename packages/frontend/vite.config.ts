import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "node:http";

// Root monorepo package.json — the canonical app version (e.g. "0.11.0").
// Read at config load so the value is baked into the build.
const rootPkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8"),
) as { version: string };

// Dev-only: the backend (server :3000, tsx watch) boots slower than Vite — it
// loads the Prisma client, connects to Postgres, runs auto-seed, initializes
// the license, FTS, and the backup scheduler. Vite is ready in ~1s. The React
// app fires its initial GETs (auth/me, license/info, workspaces, projects,
// roles/me/menu-sections) before :3000 is bound, so http-proxy emits
// ECONNREFUSED and Vite's default error handler dumps a scary AggregateError
// stack (Node's Happy Eyeballs `internalConnectMultiple`/`afterConnectMultiple`)
// plus a 502 — on EVERY `pnpm dev` start. This hook replaces that handler and
// retries connection-refused a few times (GET/HEAD only — never replay a
// POST/SSE body). Once the server binds the retry succeeds; if it stays down,
// we fall back to a single concise 502 + one warn line instead of N stack
// dumps, so genuine outages are still visible.
const BACKEND_TARGET = "http://localhost:3000";
// ~4s window covers a typical dev backend boot (Prisma client + Postgres
// connect + auto-seed + license init + FTS + backup scheduler). Bounded so a
// genuinely-down backend doesn't hang the browser indefinitely; TanStack Query
// covers any remaining gap with its own retries once the server binds.
const PROXY_MAX_RETRIES = 8;
const PROXY_RETRY_DELAY_MS = 500;
const retryAttempts = new WeakMap<IncomingMessage, number>();

// `proxy` is an http-proxy Server instance; typed loosely because http-proxy's
// own types are not a direct frontend dependency and `no-explicit-any` is off.
function configureDevProxy(proxy: any, opts: Record<string, unknown>): void {
  const onError = (
    err: NodeJS.ErrnoException,
    req: IncomingMessage,
    res: ServerResponse & { end: () => void },
  ) => {
    // Vite's default handler branches on `"req" in res` (HTTP) vs socket (ws).
    const isHttp = "req" in res;
    const attempts = retryAttempts.get(req) ?? 0;
    const canRetry =
      isHttp &&
      err.code === "ECONNREFUSED" &&
      attempts < PROXY_MAX_RETRIES &&
      (req.method === "GET" || req.method === "HEAD");

    if (canRetry) {
      retryAttempts.set(req, attempts + 1);
      setTimeout(() => {
        // Callback form: http-proxy routes errors to the callback instead of
        // re-emitting the global "error" event, so retries stay quiet.
        proxy.web(req, res, opts, (retryErr: NodeJS.ErrnoException) => {
          if (retryErr) onError(retryErr, req, res);
        });
      }, PROXY_RETRY_DELAY_MS);
      return;
    }

    // Exhausted retries or non-retryable error: terminate the response. Log a
    // single concise line for a real outage (no stack) so the terminal isn't
    // fully silent; for ws sockets just end the stream like Vite does.
    if (isHttp) {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Backend unavailable (dev proxy)" }));
      }
      if (err.code === "ECONNREFUSED") {
        console.warn(
          `[vite-dev-proxy] backend ${BACKEND_TARGET} unavailable after ${attempts} retries for ${req.method} ${req.url}`,
        );
      }
    } else {
      res.end();
    }
  };

  proxy.on("error", onError);
  // Vite attaches its own "error" logger AFTER configure() returns (same
  // tick, vite/dist/node/chunks/node.js). By nextTick both listeners exist:
  // drop them all and keep only ours, so the default AggregateError stack
  // dump never prints during the startup race. nextTick runs before any I/O,
  // so this always wins over the first failing request.
  process.nextTick(() => {
    proxy.removeAllListeners("error");
    proxy.on("error", onError);
  });
}

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    // Injects `window.__APP_VERSION__` into index.html so UserDropdown can
    // display the real version. Dev + build both run this transform; Jest
    // (ts-jest) never loads vite.config, so the global stays undefined there
    // and the dropdown falls back to "—".
    {
      name: "inject-app-version",
      transformIndexHtml(html) {
        const tag = `<script>window.__APP_VERSION__ = ${JSON.stringify(
          rootPkg.version,
        )};</script>`;
        return html.replace("</head>", `${tag}</head>`);
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@simmetric-chat/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Widget service routes (151-02, G-151-1a/1b) — declared BEFORE the
      // generic /api key: Vite matches proxy keys in INSERTION ORDER with
      // startsWith(). Regex keys (^ prefix) with the (/|$) terminator match
      // EXACTLY /widget/... and the widget's four API prefixes, so the SPA's
      // /widgets admin routes and the MCP pin routes (/api/chats,
      // /api/chats/:id/pins) are NOT hijacked.
      "^/widget/": {
        target: "http://localhost:3211",
        changeOrigin: true,
        configure: configureDevProxy,
      },
      "^/api/(sessions|config|chat|lead)(/|$)": {
        target: "http://localhost:3211",
        changeOrigin: true,
        configure: configureDevProxy,
      },
      "/api": {
        target: BACKEND_TARGET,
        changeOrigin: true,
        configure: configureDevProxy,
      },
      "/avatars": {
        target: BACKEND_TARGET,
        changeOrigin: true,
        configure: configureDevProxy,
      },
      // Branding assets (app icon) are served by the backend at :3000 via
      // express.static("storage/branding") — mirror the /avatars proxy so the
      // <img src="/branding/..."> resolves in dev (without this, Vite serves the
      // request itself from :5173 and 404s the icon).
      "/branding": {
        target: BACKEND_TARGET,
        changeOrigin: true,
        configure: configureDevProxy,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    commonjsOptions: {
      include: [/shared\/dist/, /node_modules/],
    },
  },
  preview: {
    port: 5173,
    proxy: {
      // Widget service routes (151-02) — see server.proxy above for why these
      // regex keys must precede the generic /api key.
      "^/widget/": {
        target: "http://localhost:3211",
        changeOrigin: true,
        configure: configureDevProxy,
      },
      "^/api/(sessions|config|chat|lead)(/|$)": {
        target: "http://localhost:3211",
        changeOrigin: true,
        configure: configureDevProxy,
      },
      "/api": {
        target: BACKEND_TARGET,
        changeOrigin: true,
        configure: configureDevProxy,
      },
      "/avatars": {
        target: BACKEND_TARGET,
        changeOrigin: true,
        configure: configureDevProxy,
      },
      "/branding": {
        target: BACKEND_TARGET,
        changeOrigin: true,
        configure: configureDevProxy,
      },
    },
  },
});
