// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { ChunkMetadata } from "@simmetric-chat/shared";

export interface ChunkResult {
  text: string;
  metadata: ChunkMetadata;
}

/**
 * Split text into semantically coherent chunks using LangChain's
 * RecursiveCharacterTextSplitter.
 *
 * This splitter tries to split on paragraphs, then sentences, then characters,
 * keeping semantic coherence as much as possible.
 */
export async function chunkText(
  text: string,
  documentId: string,
  options?: {
    chunkSize?: number;
    chunkOverlap?: number;
  },
): Promise<ChunkResult[]> {
  const chunkSize = options?.chunkSize || 1000;
  const chunkOverlap = options?.chunkOverlap || 200;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  const docs = await splitter.createDocuments([text]);

  return docs.map((doc, index) => ({
    text: doc.pageContent,
    metadata: {
      documentId,
      charStart: 0, // approximate — LangChain doesn't track this
      paragraph: index + 1,
    },
  }));
}