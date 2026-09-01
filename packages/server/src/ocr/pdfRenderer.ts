// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * PDF Page Renderer
 *
 * Renders a single PDF page to a PNG Buffer using
 * pdftoppm (Poppler utils) — a mature, production-grade tool
 * for converting PDF pages to images. No native Node.js canvas
 * dependencies required.
 *
 * pdftoppm is part of the Poppler project (the same rendering
 * engine used by Evince, Chrome PDF viewer, and many others).
 * It is precompiled and available in Alpine via `apk add poppler-utils`.
 */

import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { logger } from "../utils/logger";

/** Default render scale factor (2x for readable OCR input) */
const PAGE_RENDER_SCALE = 2.0;

/**
 * Render a single PDF page to a PNG Buffer.
 *
 * @param pdfPath — Absolute path to the PDF file
 * @param pageNumber — 1-based page number to render
 * @param scale — Render scale factor (default 2.0 for OCR-quality output)
 * @returns PNG-encoded Buffer of the rendered page
 * @throws If the page number is out of range or rendering fails
 */
export async function renderPageToPng(
  pdfPath: string,
  pageNumber: number,
  scale: number = PAGE_RENDER_SCALE,
): Promise<Buffer> {
  if (pageNumber < 1) {
    throw new Error(
      `Invalid page number ${pageNumber}. Page numbers are 1-based.`,
    );
  }

  // Verify PDF file exists and is non-empty before rendering
  try {
    const stats = await fs.stat(pdfPath);
    if (stats.size === 0) {
      throw new Error(`PDF file is empty: ${pdfPath}`);
    }
  } catch (err: unknown) {
    const errCode = (err as { code?: string }).code;
    if (errCode === "ENOENT") {
      throw new Error(`PDF file not found: ${pdfPath}`, { cause: err });
    }
    throw err;
  }

  const dpi = Math.round(72 * scale); // 72 DPI * scale factor
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
  const tmpPrefix = path.join(tmpDir, "page");

  return new Promise((resolve, reject) => {
    const args = [
      "-png",
      "-f", String(pageNumber),
      "-l", String(pageNumber),
      "-r", String(dpi),
      "-singlefile",
      pdfPath,
      tmpPrefix,
    ];

    const proc = spawn("pdftoppm", args);
    let stderr = "";

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", async (err) => {
      await cleanup(tmpDir);
      logger.error("[ocr] Failed to spawn pdftoppm", {
        pageNumber,
        error: err.message,
      });
      reject(err);
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        await cleanup(tmpDir);
        const errMsg = stderr.trim() || `pdftoppm exited with code ${code}`;
        logger.error("[ocr] pdftoppm failed", {
          pageNumber,
          error: errMsg,
        });
        reject(new Error(errMsg));
        return;
      }

      try {
        const outputPath = `${tmpPrefix}.png`;
        const pngBuffer = await fs.readFile(outputPath);
        if (pngBuffer.length === 0) {
          logger.warn("[ocr] pdftoppm wrote empty PNG file", {
            pageNumber,
            stderr: stderr.trim() || undefined,
          });
          reject(new Error("pdftoppm produced empty output"));
          return;
        }
        resolve(pngBuffer);
      } catch (err: unknown) {
        const errCode = (err as { code?: string }).code;
        if (errCode === "ENOENT") {
          logger.error("[ocr] pdftoppm did not create output file", {
            pageNumber,
            expectedPath: `${tmpPrefix}.png`,
            stderr: stderr.trim() || undefined,
          });
          reject(new Error("pdftoppm did not create output file"));
        } else {
          reject(err);
        }
      } finally {
        await cleanup(tmpDir);
      }
    });
  });
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
