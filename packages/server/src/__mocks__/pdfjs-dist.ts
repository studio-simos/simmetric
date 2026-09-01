// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Manual CommonJS mock for pdfjs-dist.
//
// The real `pdfjs-dist/legacy/build/pdf.mjs` is pure ESM and uses `import.meta`,
// which throws `Cannot use 'import.meta' outside a module` under the server's
// CommonJS ts-jest environment. ragOcrService.ts and ocr/ocrPipeline.ts import it
// statically, so every Jest suite fails to load. This stub satisfies exactly the
// surface those modules touch (getDocument + GlobalWorkerOptions) and never imports
// the real package, so suites can load. No test exercises OCR end-to-end.

const getDocument = (_options?: unknown) => ({
  promise: Promise.resolve({
    numPages: 0,
    getPage: (_pageNumber: number) => Promise.resolve({}),
  }),
});

const GlobalWorkerOptions: { workerSrc: string } = {
  workerSrc: "",
};

module.exports = {
  getDocument,
  GlobalWorkerOptions,
};
