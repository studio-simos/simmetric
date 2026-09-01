// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import * as fs from "fs";
import * as path from "path";

describe("OcrJob Prisma Model", () => {
  const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
  const pkgPath = path.resolve(__dirname, "../../package.json");

  let schemaContent: string;
  let pkgContent: any;

  beforeAll(() => {
    schemaContent = fs.readFileSync(schemaPath, "utf-8");
    pkgContent = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  });

  it("should define the OcrJob model", () => {
    expect(schemaContent).toContain("model OcrJob");
  });

  it("should define the OcrJobType enum with OCR and URL values", () => {
    expect(schemaContent).toMatch(/enum\s+OcrJobType\s*\{[^}]*OCR[^}]*URL[^}]*\}/s);
  });

  it("should define the OcrJobStatus enum with all status values", () => {
    expect(schemaContent).toMatch(/enum\s+OcrJobStatus\s*\{/);
    expect(schemaContent).toContain("PENDING");
    expect(schemaContent).toContain("PROCESSING");
    expect(schemaContent).toContain("COMPLETED");
    expect(schemaContent).toContain("FAILED");
    expect(schemaContent).toContain("CANCELLED");
  });

  it('should map the OcrJob model to "ocr_jobs" table', () => {
    // The @@map annotation should appear within the OcrJob model block or nearby
    expect(schemaContent).toContain('@@map("ocr_jobs")');
  });

  it("should have the archiveId+createdAt index", () => {
    expect(schemaContent).toMatch(/@@index\(\[archiveId,\s*createdAt\]\)/);
  });

  it("should have the archiveId+status index", () => {
    expect(schemaContent).toMatch(/@@index\(\[archiveId,\s*status\]\)/);
  });

  it("should include pdfjs-dist as a dependency in package.json", () => {
    expect(pkgContent.dependencies).toBeDefined();
    expect(pkgContent.dependencies["pdfjs-dist"]).toBeDefined();
  });

  it("should include @mozilla/readability as a dependency in package.json", () => {
    expect(pkgContent.dependencies).toBeDefined();
    expect(pkgContent.dependencies["@mozilla/readability"]).toBeDefined();
  });

  it("should include jsdom as a dependency in package.json", () => {
    expect(pkgContent.dependencies).toBeDefined();
    expect(pkgContent.dependencies["jsdom"]).toBeDefined();
  });

  it("should include turndown as a dependency in package.json", () => {
    expect(pkgContent.dependencies).toBeDefined();
    expect(pkgContent.dependencies["turndown"]).toBeDefined();
  });

  it("should include @types/turndown as a devDependency", () => {
    expect(pkgContent.devDependencies).toBeDefined();
    expect(pkgContent.devDependencies["@types/turndown"]).toBeDefined();
  });

  it("should include @types/jsdom as a devDependency", () => {
    expect(pkgContent.devDependencies).toBeDefined();
    expect(pkgContent.devDependencies["@types/jsdom"]).toBeDefined();
  });
});
