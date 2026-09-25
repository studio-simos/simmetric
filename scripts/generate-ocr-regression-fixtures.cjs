/**
 * generate-ocr-regression-fixtures — deterministic OCR-05 fixture generator
 * (Phase 205, OCR-05 / D-13).
 *
 * Renders 4 deterministic SVG text pages through sharp to PNG binaries under
 * packages/server/src/ocr/__tests__/fixtures/regression/:
 *
 *   1. straight.png      — normal A4-proportioned multi-line text page
 *   2. rotated-5deg.png  — the SAME page content pre-rotated ~5° in the SVG
 *   3. table.png         — a bordered grid of known cells (pipe-restore-able)
 *   4. small-text.png    — the same body content at ~half the point size
 *
 * PITFALL 7 (205-RESEARCH): the committed BINARIES are the determinism
 * guarantee — the regression suite reads committed files and NEVER generates
 * at test time. This script exists for reviewability/reproducibility only
 * (T-205-11 provenance: synthetic known-content text, no personal data).
 * Idempotent: re-runs overwrite with equivalent content.
 *
 * KNOWN CONTENT CONTRACT — the suite (ocrReliability.integration.test.ts)
 * asserts transcription content against these EXACT strings; keep them in
 * sync with the constants mirrored at the top of that file:
 *
 *   TITLE_STRAIGHT = "OCR Regression Fixture: Straight Page"
 *   TITLE_TABLE    = "OCR Regression Fixture: Table Page"
 *   BODY_LINES (5 lines, used by straight/rotated-5deg/small-text):
 *     "The quick brown fox jumps over the lazy dog near the riverbank."
 *     "Reliable OCR pipelines need a wide context window to fit the whole prompt."
 *     "Deterministic sampling keeps repeated measurement runs comparable."
 *     "Preprocessing restores skewed pages without thresholding the output."
 *     "A measured regression suite makes the reliability fix provable."
 *   TABLE_HEADER (3 cells): "Item" | "Count" | "Note"
 *   TABLE_ROWS (3 rows):
 *     "alpha" | "12" | "first data row"
 *     "beta"  | "34" | "second data row"
 *     "gamma" | "56" | "third data row"
 *
 * D-03 invariant: NO binarization — fixtures are grayscale text pages (the
 * PNGs are rasterized grayscale for compact size; never thresholded bitmaps).
 *
 * Usage:
 *   node scripts/generate-ocr-regression-fixtures.cjs
 *
 * Dependency resolution: sharp does NOT resolve from scripts/ under the pnpm
 * isolated layout — it is resolved through the server package's node_modules
 * (same pattern as build-glm-ocr-optimized.cjs; importing server dist is
 * forbidden per 205-PATTERNS.md). All fallible work — including the require —
 * lives inside main()'s try/catch: the script never throws uncaught.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const TOOL = "[generate-ocr-regression-fixtures]";

const REPO_ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(
  REPO_ROOT,
  "packages",
  "server",
  "src",
  "ocr",
  "__tests__",
  "fixtures",
  "regression",
);

// A4 proportions (1:1.414) at a width that keeps every fixture < 100KB while
// the ≤1024 long-side downscale remains preprocessing's job (205-03).
const PAGE_WIDTH = 800;
const PAGE_HEIGHT = 1130;

const TITLE_STRAIGHT = "OCR Regression Fixture: Straight Page";
const TITLE_TABLE = "OCR Regression Fixture: Table Page";

const BODY_LINES = [
  "The quick brown fox jumps over the lazy dog near the riverbank.",
  "Reliable OCR pipelines need a wide context window to fit the whole prompt.",
  "Deterministic sampling keeps repeated measurement runs comparable.",
  "Preprocessing restores skewed pages without thresholding the output.",
  "A measured regression suite makes the reliability fix provable.",
];

const TABLE_HEADER = ["Item", "Count", "Note"];
const TABLE_ROWS = [
  ["alpha", "12", "first data row"],
  ["beta", "34", "second data row"],
  ["gamma", "56", "third data row"],
];

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Multi-line text page: bold title + body lines (grayscale text page). */
function textPageSvg({ title, lines, fontSize, lineHeight, rotateDeg }) {
  const body = lines
    .map(
      (line, i) =>
        `<text x='80' y='${140 + i * lineHeight}' font-size='${fontSize}' font-family='sans-serif' fill='black'>${escapeXml(line)}</text>`,
    )
    .join("\n");
  const content =
    `<text x='80' y='80' font-size='${Math.round(fontSize * 1.4)}' font-family='sans-serif' font-weight='bold' fill='black'>${escapeXml(title)}</text>` +
    "\n" +
    body;
  // rotateDeg > 0 wraps the whole content group in an SVG rotate transform
  // (clockwise-positive, matching sharp's convention) about the page center.
  const wrapped =
    rotateDeg && rotateDeg !== 0
      ? `<g transform='rotate(${rotateDeg} ${PAGE_WIDTH / 2} ${PAGE_HEIGHT / 2})'>${content}</g>`
      : content;
  return Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${PAGE_WIDTH}' height='${PAGE_HEIGHT}'>` +
      `<rect width='${PAGE_WIDTH}' height='${PAGE_HEIGHT}' fill='white'/>` +
      wrapped +
      `</svg>`,
  );
}

/** Bordered table grid with known cells (pipe-restore-able transcription). */
function tablePageSvg() {
  const cols = TABLE_HEADER.length;
  const colWidth = 200;
  const rowHeight = 60;
  const tableX = 100;
  const tableY = 160;
  const tableWidth = cols * colWidth;
  const tableHeight = (TABLE_ROWS.length + 1) * rowHeight;

  const lines = [];
  // Header row: bold, centered in each cell.
  TABLE_HEADER.forEach((cell, c) => {
    lines.push(
      `<text x='${tableX + c * colWidth + 20}' y='${tableY + 40}' font-size='22' font-family='sans-serif' font-weight='bold' fill='black'>${escapeXml(cell)}</text>`,
    );
  });
  // Data rows.
  TABLE_ROWS.forEach((row, r) => {
    row.forEach((cell, c) => {
      lines.push(
        `<text x='${tableX + c * colWidth + 20}' y='${tableY + (r + 1) * rowHeight + 40}' font-size='20' font-family='sans-serif' fill='black'>${escapeXml(cell)}</text>`,
      );
    });
  });

  // Grid: outer border + inner lines (horizontal + vertical), 2px black.
  const gridLines = [];
  for (let r = 0; r <= TABLE_ROWS.length + 1; r++) {
    const y = tableY + r * rowHeight;
    gridLines.push(
      `<line x1='${tableX}' y1='${y}' x2='${tableX + tableWidth}' y2='${y}' stroke='black' stroke-width='2'/>`,
    );
  }
  for (let c = 0; c <= cols; c++) {
    const x = tableX + c * colWidth;
    gridLines.push(
      `<line x1='${x}' y1='${tableY}' x2='${x}' y2='${tableY + tableHeight}' stroke='black' stroke-width='2'/>`,
    );
  }

  return Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${PAGE_WIDTH}' height='${PAGE_HEIGHT}'>` +
      `<rect width='${PAGE_WIDTH}' height='${PAGE_HEIGHT}' fill='white'/>` +
      `<text x='80' y='80' font-size='28' font-family='sans-serif' font-weight='bold' fill='black'>${escapeXml(TITLE_TABLE)}</text>` +
      gridLines.join("\n") +
      "\n" +
      lines.join("\n") +
      `</svg>`,
  );
}

function buildFixtures() {
  return [
    {
      file: "straight.png",
      note: "normal A4-proportioned multi-line text page",
      svg: textPageSvg({
        title: TITLE_STRAIGHT,
        lines: BODY_LINES,
        fontSize: 20,
        lineHeight: 44,
        rotateDeg: 0,
      }),
    },
    {
      file: "rotated-5deg.png",
      note: "same page content pre-rotated ~5° (deskew stress case)",
      svg: textPageSvg({
        title: TITLE_STRAIGHT,
        lines: BODY_LINES,
        fontSize: 20,
        lineHeight: 44,
        rotateDeg: 5,
      }),
    },
    {
      file: "table.png",
      note: "bordered grid of known cells (pipe-restore-able)",
      svg: tablePageSvg(),
    },
    {
      file: "small-text.png",
      note: "same body content at ~half the point size (render-scale/preprocessing stress case)",
      svg: textPageSvg({
        title: TITLE_STRAIGHT,
        lines: BODY_LINES,
        fontSize: 10,
        lineHeight: 22,
        rotateDeg: 0,
      }),
    },
  ];
}

async function main() {
  try {
    // sharp resolves through the server package's node_modules (pnpm isolated
    // layout — see header comment).
    const sharp = require(require.resolve("sharp", {
      paths: [path.join(REPO_ROOT, "packages", "server")],
    }));

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const fixtures = buildFixtures();
    const written = [];
    for (const fixture of fixtures) {
      const outPath = path.join(OUT_DIR, fixture.file);
      // Grayscale PNG (compact, matches the "grayscale text pages" contract;
      // NOT a thresholded bitmap — no binarization, D-03 invariant).
      const buf = await sharp(fixture.svg).grayscale().png({ compressionLevel: 9 }).toBuffer();
      fs.writeFileSync(outPath, buf);
      written.push({ file: fixture.file, bytes: buf.length });
    }

    for (const w of written) {
      console.log(`${TOOL} ${w.file}: ${w.bytes} bytes`);
    }
    const oversized = written.filter((w) => w.bytes > 100 * 1024);
    if (oversized.length > 0) {
      console.error(`${TOOL} FAILED size contract (> 100KB): ${oversized.map((w) => w.file).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${TOOL} done — 4 fixtures under ${OUT_DIR}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TOOL} failed: ${message}`);
    process.exitCode = 1;
  }
}

main();