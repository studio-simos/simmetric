// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

declare module "pdf-parse" {
  function pdfParse(data: Buffer, options?: any): Promise<{
    numpages: number;
    numrender: number;
    info: Record<string, any>;
    metadata: Record<string, any>;
    version: string;
    text: string;
  }>;
  export default pdfParse;
}

declare module "mammoth" {
  export function extractRawText(input: { buffer: Buffer }): Promise<{
    value: string;
    messages: any[];
  }>;
}

declare module "node-xlsx" {
  export function parse(buffer: Buffer): Array<{
    name: string;
    data: any[][];
  }>;
}

declare module "youtube-transcript-plus" {
  export function fetchTranscript(videoId: string, options?: { lang?: string }): Promise<
    Array<{ text: string; duration: number; offset: number }>
  >;
}

declare module "officeparser" {
  export function parseOfficeFileAsync(filePath: string): Promise<string>;
}