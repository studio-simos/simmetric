// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * preprocessing.ts — OCR input normalization (Phase 205, OCR-03)
 *
 * Fixed chain (D-03): grayscale → resize (long side ≤ 1024, never upscaled)
 * → deskew estimate → rotate → JPEG q85. NO binarization: the fixed
 * threshold lives ONLY inside the deskew estimation matrix — the returned
 * buffer is never thresholded (binarization harms VLM transcription; the
 * evaluation verdict excludes it — the phase's most-load-bearing
 * prohibition).
 *
 * Deskew (D-04, zero new runtime deps): projection-profile row-sum-variance
 * search in pure TS over `sharp.raw()` pixels of the downscaled copy —
 * coarse ±15° at 0.5°, refined ±0.5° at 0.1° around the winner — SEEDED by
 * the second-order central-moments estimate (0.5·atan2(2μ11, μ20−μ02) over
 * ink pixels, ±45° normalized) evaluated as an extra ±2° @ 0.1° candidate
 * window. RESEARCH live probe: the naive moments value carries a +3.6°
 * systematic bias on unrotated layouts (letter-column variance dominates),
 * while the projection profile recovered exactly ±5°/3°/0° on the same
 * fixtures — so the profile variance, never the moments value, picks the
 * final angle (D-04 family honored: moments are a seed candidate only).
 *
 * Angle convention (verified live, sharp rotate is clockwise-positive):
 * the returned `estimatedSkewDeg` is the rotate() argument that DESKEWS the
 * page (applying the chain to a +5°-rotated fixture yields ≈ −5° here, and
 * re-running preprocessing on the deskewed output re-estimates ≈ 0°).
 * |skew| < 0.3° skips rotation entirely (resampling cost avoided on clean
 * pages). The final angle is guarded with Number.isFinite (T-205-10) — a
 * non-finite estimate skips rotation (fail-open posture inside the module).
 *
 * Fail-open (D-05, T-205-01): on ANY error (corrupt/undecodable input,
 * sharp transform failure, decompression bomb rejection) the module logs a
 * warn and returns the ORIGINAL buffer with applied=false — preprocessing
 * never adds a new job-failure mode; libvips's own dimension/format limits
 * bound decode amplification.
 *
 * Payload posture (T-205-01): output is JPEG q85 with the long side ≤ 1024
 * (before the deskew-rotation canvas growth) — typically far smaller than
 * the raw upload; a warn logs when output > input so pathological growth
 * stays observable.
 */

import sharp from "sharp";
import { logger } from "../utils/logger";

/** Long-side limit after normalization (D-03 — CPU budget for estimation). */
const LONG_SIDE_LIMIT = 1024;

/** Output JPEG quality (D-03 — q85: low payload without VLM-confusing artifacts). */
const JPEG_QUALITY = 85;

/** Fixed threshold for the INTERNAL estimation matrix only (never the output). */
const BIN_THRESHOLD = 128;

/** Skip rotation below this |angle| (deg) — avoids resampling cost on clean pages. */
const SKEW_SKIP_THRESHOLD_DEG = 0.3;

/** Moments-seed candidate window half-width (deg) at the fine step. */
const SEED_WINDOW_DEG = 2;

/** Global coarse search window half-width (deg). */
const COARSE_RANGE_DEG = 15;

/** Coarse search step (deg). */
const COARSE_STEP_DEG = 0.5;

/** Fine refinement window half-width around the coarse winner (deg). */
const REFINE_WINDOW_DEG = 0.5;

/** Fine search step (deg) — the estimator returns 0.1°-rounded values. */
const FINE_STEP_DEG = 0.1;

/** Result of preprocessing one OCR input image. */
export interface PreprocessResult {
  /** Processed buffer (JPEG q85) — or the ORIGINAL input when fail-open. */
  buffer: Buffer;
  /** false only when fail-open returned the original buffer unchanged. */
  applied: boolean;
  /** Deskew rotation to apply, deg (sharp rotate is clockwise-positive); 0 on fail-open/skip. */
  estimatedSkewDeg: number;
  /** True when the long side exceeded the limit and was downscaled. */
  resized: boolean;
}

/**
 * Round to 0.1° (the estimator's resolution contract).
 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Estimate the deskew angle from raw grayscale pixels.
 *
 * Returns the sharp rotate() argument (clockwise-positive) that deskews the
 * page, or NaN when the estimator cannot produce a usable candidate.
 *
 * Algorithm (probe-verified 2026-09-24, see module header):
 * 1. Binarize into an INTERNAL estimation matrix (ink = gray < threshold).
 * 2. Seed: second-order central moments over ink pixels —
 *    0.5·atan2(2μ11, μ20−μ02), ±45° normalized — evaluated as an extra
 *    candidate window (D-04 algorithm family honored; the +3.6° bias is
 *    neutralized because profile variance picks the final angle).
 * 3. Projection profile: for candidate shear angles, bin ink pixels into
 *    rows via a vertical column shear and compute row-sum variance — the
 *    angle maximizing variance aligns text baselines horizontally.
 * 4. Coarse ±15° @ 0.5° → fine ±0.5° @ 0.1° around the best candidate.
 */
function estimateDeskewDeg(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
): number {
  const cols = width;
  const rows = height;

  // 1. Collect ink pixels from the estimation matrix (internal only —
  // the output buffer is never thresholded). Coordinates are packed into
  // flat arrays (noUncheckedIndexedAccess-safe single reads).
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < rows; y++) {
    const rowOffset = y * cols;
    for (let x = 0; x < cols; x++) {
      const gray = data[(rowOffset + x) * channels];
      if (gray !== undefined && gray < BIN_THRESHOLD) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  const inkCount = xs.length;

  // 2. Moments seed (D-04 family): 0.5·atan2(2μ11, μ20−μ02) over ink pixels,
  //    ±45° normalized (a near-horizontal text baseline reads as ±90° from
  //    the letter-column major axis — normalize into the horizontal family).
  let seedDeg = 0;
  if (inkCount > 0) {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < inkCount; i++) {
      mx += xs[i] ?? 0;
      my += ys[i] ?? 0;
    }
    const cx = mx / inkCount;
    const cy = my / inkCount;
    let mu11 = 0;
    let mu20 = 0;
    let mu02 = 0;
    for (let i = 0; i < inkCount; i++) {
      const dx = (xs[i] ?? 0) - cx;
      const dy = (ys[i] ?? 0) - cy;
      mu11 += dx * dy;
      mu20 += dx * dx;
      mu02 += dy * dy;
    }
    seedDeg = 0.5 * Math.atan2(2 * mu11, mu20 - mu02) * (180 / Math.PI);
    if (seedDeg > 45) seedDeg -= 90;
    else if (seedDeg < -45) seedDeg += 90;
  }

  // 3. Row-sum variance of the sheared estimation matrix per candidate angle.
  //    Vertical column shear: row r = y + tan(θ)·(x − colCenter) — verified
  //    live: a page rotated −5° peaks at θ = +5°, and rotate(+θ) deskews it.
  const profileVariance = (deg: number): number => {
    const t = Math.tan((deg * Math.PI) / 180);
    const colCenter = cols / 2;
    const rowSums = new Float64Array(rows);
    for (let i = 0; i < inkCount; i++) {
      const r = (ys[i] ?? 0) + Math.round(t * ((xs[i] ?? 0) - colCenter));
      if (r >= 0 && r < rows) rowSums[r] = (rowSums[r] ?? 0) + 1;
    }
    let mean = 0;
    for (let j = 0; j < rows; j++) mean += rowSums[j] ?? 0;
    mean /= rows;
    let variance = 0;
    for (let j = 0; j < rows; j++) {
      const d = (rowSums[j] ?? 0) - mean;
      variance += d * d;
    }
    return variance;
  };

  let best = 0;
  let bestVariance = -1;
  const consider = (deg: number): void => {
    const v = profileVariance(deg);
    if (v > bestVariance) {
      bestVariance = v;
      best = deg;
    }
  };

  // 3a. Coarse global search ±15° @ 0.5°.
  for (let d = -COARSE_RANGE_DEG; d <= COARSE_RANGE_DEG + 0.01; d += COARSE_STEP_DEG) {
    consider(round1(d));
  }

  // 3b. Moments-seed candidate window ±2° @ 0.1° (D-04 seed honored —
  //     the variance, not the seed value, decides; on badly-biased seeds
  //     these candidates simply lose to the coarse winner).
  const seedLo = round1(seedDeg - SEED_WINDOW_DEG);
  const seedHi = round1(seedDeg + SEED_WINDOW_DEG);
  for (let d = seedLo; d <= seedHi + 0.01; d += FINE_STEP_DEG) {
    consider(round1(d));
  }

  // 3c. Fine refinement ±0.5° @ 0.1° around the current winner.
  const refineLo = round1(best - REFINE_WINDOW_DEG);
  const refineHi = round1(best + REFINE_WINDOW_DEG);
  for (let d = refineLo; d <= refineHi + 0.01; d += FINE_STEP_DEG) {
    consider(round1(d));
  }

  return round1(best);
}

/**
 * Normalize an image for the OCR vision model (OCR-03).
 *
 * Chain (fixed order, D-03): decode → grayscale → resize (long side ≤ 1024,
 * never upscaled) → deskew estimate on the downscaled pixels → rotate (white
 * background — sharp's default is black, Pitfall 3) → JPEG q85. Exactly ONE
 * resize and ONE rotate per sharp pipeline (sharp constraint); rotation is
 * the last geometric step before encoding. Fail-open (D-05): on ANY error
 * the ORIGINAL input buffer is returned with applied=false — never throws.
 */
export async function preprocessForOcr(input: Buffer): Promise<PreprocessResult> {
  try {
    // Header-only metadata (cheap — no full decode) to detect the resize.
    const meta = await sharp(input).metadata();
    const resized =
      typeof meta.width === "number" &&
      typeof meta.height === "number" &&
      Math.max(meta.width, meta.height) > LONG_SIDE_LIMIT;

    // Estimation pass: raw grayscale pixels of the resized copy (bounded
    // pixels — T-205-09). raw() collapses grayscale to 1 channel but the
    // stride is read from info.channels rather than assumed (probed).
    const estimation = await sharp(input)
      .grayscale()
      .resize(LONG_SIDE_LIMIT, LONG_SIDE_LIMIT, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bestThetaDeg = estimateDeskewDeg(
      estimation.data,
      estimation.info.width,
      estimation.info.height,
      estimation.info.channels,
    );

    // T-205-10: the estimator operates on finite integer sums, but guard the
    // final angle anyway — a non-finite value skips rotation entirely.
    const rotationDeg = Number.isFinite(bestThetaDeg) ? bestThetaDeg : 0;
    const rotateApplied = Math.abs(rotationDeg) >= SKEW_SKIP_THRESHOLD_DEG;

    // Output pipeline: one resize + (optionally) one rotate + JPEG q85.
    // rotate ALWAYS carries background #ffffff (default is black — Pitfall 3).
    let pipeline = sharp(input)
      .grayscale()
      .resize(LONG_SIDE_LIMIT, LONG_SIDE_LIMIT, { fit: "inside", withoutEnlargement: true });
    if (rotateApplied) {
      pipeline = pipeline.rotate(rotationDeg, { background: "#ffffff" });
    }
    const buffer = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();

    if (buffer.length > input.length) {
      // T-205-01 payload direction: preprocessing should shrink payloads
      // (RESEARCH probed A4 PNG → ~8KB JPEG); growth stays observable.
      logger.warn("[ocr-preprocess] output larger than input", {
        inputBytes: input.length,
        outputBytes: buffer.length,
      });
    }

    return {
      buffer,
      applied: true,
      estimatedSkewDeg: rotationDeg,
      resized,
    };
  } catch (err: unknown) {
    // D-05 fail-open: preprocessing never introduces a new job-failure mode.
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn("[ocr-preprocess] failed, passing original buffer (fail-open)", {
      error: errorMessage,
    });
    return {
      buffer: input,
      applied: false,
      estimatedSkewDeg: 0,
      resized: false,
    };
  }
}