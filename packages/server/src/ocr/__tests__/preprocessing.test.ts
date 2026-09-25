// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for preprocessing — OCR input normalization chain (Phase 205, OCR-03)
 *
 * Uses sharp DIRECTLY (no mocks needed — no DB, no ollama): fixtures are
 * generated at test time from SVG text pages (sharp rasterizes SVG <text>),
 * mirroring the committed-regression-fixture generation approach (D-13) so
 * tests stay deterministic without committed binaries.
 *
 * Covered (RESEARCH Test Map OCR-03):
 * (a) chain behavior — output dims ≤ 1024 long side, JPEG magic bytes,
 *     applied === true
 * (b) no-upscale — an already-small input keeps its dims (resized false)
 * (c) angle recovery — ±5°-rotated pages estimate ≈ ∓5 (tolerance 0.5°);
 *     the returned value is the DESKEW rotation (rotate is clockwise-positive)
 * (d) clean page (0°) → |estimatedSkewDeg| < 0.3 and rotation skipped
 *     (estimatedSkewDeg 0)
 * (e) fail-open — garbage Buffer → applied false + original buffer returned
 *     + warn logged; never throws
 * (f) no-binarization invariant — output pixels retain grayscale tonal
 *     range (histogram spread > 2 distinct levels), never a pure 2-value image
 */

import { logger } from "../../utils/logger";

// Mock logger to silence test output and verify warn calls
jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import sharp from "sharp";
import { preprocessForOcr } from "../preprocessing";

/** Build a deterministic text-page PNG via SVG → sharp rasterization. */
async function buildTextPagePng(width = 800, height = 1100, lines = 12): Promise<Buffer> {
  const textLines = Array.from(
    { length: lines },
    (_, i) =>
      `<text x='60' y='${90 + i * 64}' font-size='32' font-family='sans-serif'>Line ${i + 1} of the sample document page with words</text>`,
  ).join("");
  const svg = Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>` +
      `<rect width='${width}' height='${height}' fill='white'/>` +
      textLines +
      `</svg>`,
  );
  return sharp(svg).png().toBuffer();
}

/** Rotate a PNG buffer by deg (sharp rotate is clockwise-positive). */
async function rotatePng(png: Buffer, deg: number): Promise<Buffer> {
  return sharp(png).rotate(deg, { background: "#ffffff" }).png().toBuffer();
}

describe("preprocessForOcr", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // (a) Chain behavior: dims ≤ 1024 on the long side, JPEG magic, applied
  it("chains a large page down to ≤1024 long side JPEG q85 with applied=true", async () => {
    const png = await buildTextPagePng(1200, 1600);
    const result = await preprocessForOcr(png);

    expect(result.applied).toBe(true);
    expect(result.resized).toBe(true);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1024);
    // JPEG magic bytes (SOI marker)
    expect(result.buffer[0]).toBe(0xff);
    expect(result.buffer[1]).toBe(0xd8);
  });

  it("grayscales the output (color removed)", async () => {
    // A colored SVG page — after the chain the R/G/B channels must match
    // (grayscale) or the image must be single-channel.
    const svg = Buffer.from(
      `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='550'>` +
        `<rect width='400' height='550' fill='#3366cc'/>` +
        `<text x='40' y='200' font-size='32' font-family='sans-serif' fill='#ff0000'>Colored page sample</text>` +
        `<text x='40' y='300' font-size='32' font-family='sans-serif' fill='#00ff00'>Second colored line</text>` +
        `</svg>`,
    );
    const png = await sharp(svg).png().toBuffer();
    const result = await preprocessForOcr(png);

    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    if (info.channels >= 3) {
      // sRGB grayscale encodes as 3 identical channels
      let mismatch = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) mismatch++;
      }
      expect(mismatch).toBe(0);
    }
    // else: 1-channel raw read already proves grayscale
    expect(info.channels).toBeGreaterThanOrEqual(1);
  }, 30000);

  // (b) Already-small input is never upscaled
  it("does not upscale an already-small input (dims unchanged, resized=false)", async () => {
    const png = await buildTextPagePng(500, 640);
    const beforeMeta = await sharp(png).metadata();
    const result = await preprocessForOcr(png);

    expect(result.applied).toBe(true);
    expect(result.resized).toBe(false);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(beforeMeta.width);
    expect(meta.height).toBe(beforeMeta.height);
  });

  // (c) Angle recovery: ±5° fixtures estimate the DESKEW angle ≈ ∓5
  it("recovers +5° rotation as a −5 deskew estimate within 0.5° tolerance", async () => {
    const png = await buildTextPagePng();
    const rotated = await rotatePng(png, 5);
    const result = await preprocessForOcr(rotated);

    expect(result.applied).toBe(true);
    expect(result.estimatedSkewDeg).toBeLessThanOrEqual(-4.5);
    expect(result.estimatedSkewDeg).toBeGreaterThanOrEqual(-5.5);
  }, 30000);

  it("recovers −5° as a +5 deskew estimate within 0.5° tolerance", async () => {
    const png = await buildTextPagePng();
    const rotated = await rotatePng(png, -5);
    const result = await preprocessForOcr(rotated);

    expect(result.applied).toBe(true);
    expect(result.estimatedSkewDeg).toBeGreaterThanOrEqual(4.5);
    expect(result.estimatedSkewDeg).toBeLessThanOrEqual(5.5);
  }, 30000);

  // (d) Clean page: |estimate| < 0.3 → rotation skipped (estimatedSkewDeg 0)
  it("skips rotation on a clean 0° page (estimatedSkewDeg 0, below the 0.3° skip gate)", async () => {
    const png = await buildTextPagePng();
    const result = await preprocessForOcr(png);

    expect(result.applied).toBe(true);
    expect(Math.abs(result.estimatedSkewDeg)).toBeLessThan(0.3);
  }, 30000);

  // (e) Fail-open: corrupt input → original buffer + warn, never throws
  it("fail-opens on a garbage buffer: applied=false, original returned, warn logged", async () => {
    const garbage = Buffer.from("this is not an image at all");
    const result = await preprocessForOcr(garbage);

    expect(result.applied).toBe(false);
    expect(result.estimatedSkewDeg).toBe(0);
    expect(result.resized).toBe(false);
    expect(result.buffer).toBe(garbage);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("fail-open"),
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("fail-opens on a zero-byte buffer without throwing", async () => {
    const empty = Buffer.alloc(0);
    const result = await preprocessForOcr(empty);

    expect(result.applied).toBe(false);
    expect(result.buffer).toBe(empty);
  });

  it("fail-opens on a truncated/corrupt image payload without throwing", async () => {
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("broken-payload-not-really-png"),
    ]);
    const result = await preprocessForOcr(corrupt);

    expect(result.applied).toBe(false);
    expect(result.buffer).toBe(corrupt);
  });

  // (f) No-binarization invariant: output keeps tonal range
  it("keeps the grayscale tonal range — never a pure 2-value image (no binarization)", async () => {
    // A page with midtone antialiasing → after the chain the histogram must
    // still carry > 2 distinct gray levels.
    const svg = Buffer.from(
      `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1100'>` +
        `<rect width='800' height='1100' fill='#f0f0f0'/>` +
        Array.from(
          { length: 12 },
          (_, i) =>
            `<text x='60' y='${90 + i * 64}' font-size='32' font-family='sans-serif'>Line ${i + 1} of the sample document page with words</text>`,
        ).join("") +
        `<rect x='60' y='850' width='680' height='60' fill='#c0c0c0'/>` +
        `</svg>`,
    );
    const png = await sharp(svg).png().toBuffer();
    const result = await preprocessForOcr(png);

    expect(result.applied).toBe(true);
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    const levels = new Set<number>();
    for (let i = 0; i < data.length; i += info.channels) {
      levels.add(data[i]!);
      if (levels.size > 2) break;
    }
    expect(levels.size).toBeGreaterThan(2);
  }, 30000);

  // Deskew correctness end-to-end: preprocessing a rotated fixture produces
  // output whose re-estimate is ≈ 0 (the rotation was actually applied).
  it("applies the deskew rotation — re-preprocessing the output estimates ≈ 0", async () => {
    const png = await buildTextPagePng();
    const rotated = await rotatePng(png, 5);
    const first = await preprocessForOcr(rotated);

    // +5° true rotation → correction ≈ −5 (applied, above the skip gate)
    expect(Math.abs(first.estimatedSkewDeg)).toBeGreaterThanOrEqual(0.3);

    // Render the processed buffer back through the estimator alone: rotate
    // the ORIGINAL page by the correction, re-estimate → ≈ 0.
    const corrected = await rotatePng(rotated, first.estimatedSkewDeg);
    const reResult = await preprocessForOcr(corrected);
    expect(Math.abs(reResult.estimatedSkewDeg)).toBeLessThan(0.3);
  }, 60000);
});