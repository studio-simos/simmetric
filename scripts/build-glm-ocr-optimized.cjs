/**
 * build-glm-ocr-optimized — operator one-shot model creation (Phase 205, OCR-01 / D-06).
 *
 * Creates the `glm-ocr-optimized` model on a reachable Ollama daemon from
 * `glm-ocr:latest`, layering exactly the 4 PARAMETER values from
 * docker/ollama/glm-ocr-optimized.Modelfile via ollama-js create().
 * `template` and `system` are omitted so both inherit from the base model —
 * the bare `{{ .Prompt }}` template is load-bearing (done-less-stream
 * regression guard, modelRegistry.ts comment; salvage rule 260829-lkq).
 *
 * Non-throwing parity with PrewarmResult (packages/server/src/ocr/prewarm.ts):
 * all fallible work — including dependency resolution — lives inside main()'s
 * try/catch; on failure the script logs a structured error and sets
 * process.exitCode = 1 instead of throwing uncaught.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 node scripts/build-glm-ocr-optimized.cjs
 *   # alternative (no node needed): docker exec <ollama-container> \
 *   #   ollama create glm-ocr-optimized -f - < docker/ollama/glm-ocr-optimized.Modelfile
 *
 * Dependency resolution: ollama does NOT resolve from scripts/ under the pnpm
 * isolated layout, so it is resolved through the server package's node_modules.
 * The repo has no precedent for scripts importing server dist
 * (205-PATTERNS.md) — the 5-line ollama-js factory is inlined instead.
 */

"use strict";

const path = require("path");

const TOOL = "[build-glm-ocr-optimized]";

// Inline factory (mirrors packages/server/src/services/ollamaClient.ts):
// ollama-js exports both a named Ollama and a default export — handle the
// interop. Verified live (node): the CJS build's `default` is a plain object
// (module namespace artifact), the CONSTRUCTOR is the named `Ollama` export —
// prefer it, fall back to default only when it is itself callable.
// Called INSIDE main() so a resolution failure is caught, not fatal.
function getOllamaClient() {
  const paths = [path.join(__dirname, "..", "packages", "server")];
  const mod = require(require.resolve("ollama", { paths }));
  const OllamaCtor = typeof mod.Ollama === "function" ? mod.Ollama : mod.default;
  return new OllamaCtor({
    host: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  });
}

async function main() {
  try {
    const client = getOllamaClient();

    // ollama-js create() THROWS on local-path `from` ("Creating with a local
    // path is not currently supported from ollama-js") — `from` MUST be a
    // model name. Omit template + system: both inherit from glm-ocr:latest.
    const result = await client.create({
      model: "glm-ocr-optimized",
      from: "glm-ocr:latest",
      stream: false,
      parameters: {
        num_ctx: 16384,
        num_predict: 8192,
        temperature: 0,
        top_k: 1,
      },
    });

    const status = result && result.status ? result.status : "unknown";
    console.log(`${TOOL} created glm-ocr-optimized from glm-ocr:latest — status: ${status}`);
    console.log(`${TOOL} done. Server registry entry glm-ocr-optimized:* is active after restart is NOT needed (registry is code-side).`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TOOL} failed: ${message}`);
    console.error(
      `${TOOL} hints: is the daemon reachable at OLLAMA_BASE_URL (default http://localhost:11434)? Is glm-ocr pulled (ollama pull glm-ocr:latest)?`,
    );
    process.exitCode = 1;
  }
}

main();