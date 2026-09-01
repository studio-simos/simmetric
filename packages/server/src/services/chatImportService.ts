// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { v4 as uuidv4 } from "uuid";
import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";

// ===== Format Detection =====

/**
 * Detect the import format based on structural sniffing of the JSON data.
 * Returns the format string or null if unrecognized.
 */
export function detectImportFormat(data: unknown): "chatgpt" | "claude" | "openwebui" | "generic" | null {
  if (data === null || data === undefined) return null;

  // Normalize: if single ChatGPT conversation (object with mapping), wrap in array
  if (typeof data === "object" && !Array.isArray(data) && data !== null) {
    if ("mapping" in (data as Record<string, unknown>)) {
      data = [data];
    }
  }

  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0];
  if (typeof first !== "object" || first === null) return null;

  // ChatGPT format: array where first element has "mapping" property
  if ("mapping" in first) {
    return "chatgpt";
  }

  // Claude format: array where first element has "chat_messages" property
  if ("chat_messages" in first) {
    return "claude";
  }

  // Open WebUI format: array where first element has "messages" AND ("models" OR "history")
  if ("messages" in first && ("models" in first || "history" in first)) {
    return "openwebui";
  }

  // Generic JSON format: array where first element has "messages" (array of objects with role and content)
  if ("messages" in first) {
    const msgs = (first as Record<string, unknown>).messages;
    if (Array.isArray(msgs) && msgs.length > 0 && typeof msgs[0] === "object" && msgs[0] !== null) {
      if ("role" in msgs[0] && "content" in msgs[0]) {
        return "generic";
      }
    }
  }

  return null;
}

// ===== Parsers =====

interface ParsedChat {
  title: string;
  messages: { role: string; content: string }[];
  attachmentCount: number;
}

/**
 * Parse ChatGPT export format.
 * Each element has a "mapping" object mapping UUIDs to message nodes,
 * and an optional "title" field.
 */
type ImportElement = Record<string, unknown>;

export function parseChatGPT(data: ImportElement[]): ParsedChat[] {
  return data.map((element: ImportElement) => {
    const title = (element.title as string) || "Untitled Chat";
    let attachmentCount = 0;

    const messages: { role: string; content: string }[] = [];
    const mapping = (element.mapping as Record<string, ImportElement>) || {};

    for (const node of Object.values(mapping)) {
      const n = node as { message?: { author?: { role?: string }; content?: { parts?: unknown[] } } };
      if (!n.message) continue;

      const role = n.message.author?.role;
      if (role !== "user" && role !== "assistant") continue;

      const contentParts = n.message.content?.parts;
      if (!Array.isArray(contentParts)) continue;

      // Join text parts, skip non-text parts (attachments per D-12)
      const textParts: string[] = [];
      for (const part of contentParts) {
        if (typeof part === "string") {
          textParts.push(part);
        } else {
          attachmentCount++;
        }
      }

      const content = textParts.join("\n");
      if (content.trim()) {
        messages.push({ role, content });
      }
    }

    return { title, messages, attachmentCount };
  });
}

/**
 * Parse Claude export format.
 * Each element has "chat_messages" array and optional "name" field.
 */
export function parseClaude(data: ImportElement[]): ParsedChat[] {
  return data.map((element: ImportElement) => {
    const title = (element.name as string) || "Untitled Chat";
    let attachmentCount = 0;

    const messages: { role: string; content: string }[] = [];
    const chatMessages = (element.chat_messages as Array<{ sender?: string; text?: unknown; attachments?: unknown[] }>) || [];

    for (const msg of chatMessages) {
      // Map sender to role ("human" -> "user", "assistant" -> "assistant")
      let role: string;
      if (msg.sender === "human") {
        role = "user";
      } else if (msg.sender === "assistant") {
        role = "assistant";
      } else {
        continue;
      }

      const content = msg.text;
      if (typeof content !== "string") {
        // Skip non-text content (attachments per D-12)
        attachmentCount++;
        continue;
      }

      if (content.trim()) {
        messages.push({ role, content });
      }
    }

    return { title, messages, attachmentCount };
  });
}

/**
 * Parse Open WebUI export format.
 * Each element has "messages" array and optional "title".
 */
export function parseOpenWebUI(data: ImportElement[]): ParsedChat[] {
  return data.map((element: ImportElement) => {
    const title = (element.title as string) || "Untitled Chat";
    let attachmentCount = 0;

    const messages: { role: string; content: string }[] = [];
    const msgs = (element.messages as Array<{ role: string; content: unknown }>) || [];

    for (const msg of msgs) {
      const role = msg.role;
      const content = msg.content;

      if (typeof content !== "string") {
        // Skip non-text content (attachments per D-12)
        attachmentCount++;
        continue;
      }

      if (content.trim()) {
        messages.push({ role, content });
      }
    }

    return { title, messages, attachmentCount };
  });
}

/**
 * Parse generic JSON export format.
 * Each element has "messages" array with "role" and "content" string fields.
 */
export function parseGeneric(data: ImportElement[]): ParsedChat[] {
  return data.map((element: ImportElement, index: number) => {
    const title = (element.title as string) || `Imported Chat ${index + 1}`;
    const messages: { role: string; content: string }[] = [];
    // D-08: `element.messages` is `unknown` (ImportElement is a string-keyed
    // record). Narrow to the generic-format message array shape — `role` +
    // `content` are both optional at the parse boundary; the guards below
    // narrow before pushing.
    const msgs = (element.messages as Array<{ role?: string; content?: string }> | undefined) || [];

    for (const msg of msgs) {
      // WR-04: preserve pre-refactor import tolerance. The previous `as any`
      // guard was `typeof msg.content === "string"` — it pushed the message
      // even when `role` was missing/non-string (stored as `undefined`/null on
      // the ChatMessage row). Tightening the guard to also require a string
      // `role` silently dropped those messages with no skipped counter. To
      // keep this phase type-only (no behavior change), restore the looser
      // content-only guard and fall back to `"user"` when `role` is not a
      // string (the `messages` array is typed `{ role: string; content: string }`,
      // so a non-string role must be coerced to a string to compile — `"user"`
      // is the closest sane default and matches the guidance).
      if (typeof msg.content === "string") {
        messages.push({ role: typeof msg.role === "string" ? msg.role : "user", content: msg.content });
      }
    }

    return { title, messages, attachmentCount: 0 };
  });
}

// ===== Preview & Import =====

/**
 * Generate an import preview showing detected format, chat count, message count, and warnings.
 * Returns preview object or error object.
 */
export function generateImportPreview(data: unknown): { format: string; chats: { title: string; messageCount: number }[]; warnings: { type: string; count: number }[] } | { error: string } {
  const format = detectImportFormat(data);
  if (!format) {
    return { error: "Unrecognized import format. Supported formats: ChatGPT, Claude, Open WebUI, and generic JSON." };
  }

  let parsedChats: ParsedChat[];
  const dataArray = data as ImportElement[];
  switch (format) {
    case "chatgpt":
      parsedChats = parseChatGPT(dataArray);
      break;
    case "claude":
      parsedChats = parseClaude(dataArray);
      break;
    case "openwebui":
      parsedChats = parseOpenWebUI(dataArray);
      break;
    case "generic":
      parsedChats = parseGeneric(dataArray);
      break;
    default:
      return { error: "Unrecognized import format. Supported formats: ChatGPT, Claude, Open WebUI, and generic JSON." };
  }

  const totalAttachmentCount = parsedChats.reduce((sum, c) => sum + c.attachmentCount, 0);

  return {
    format,
    chats: parsedChats.map(c => ({ title: c.title, messageCount: c.messages.length })),
    warnings: [{ type: "attachments_skipped", count: totalAttachmentCount }],
  };
}

/**
 * Import chats into a workspace.
 * Creates new Chat and ChatMessage records with new UUIDs per D-13.
 * Skips chats that fail to import and reports the count.
 */
export async function importChats(workspaceId: string, userId: string, data: unknown, format: string): Promise<{ imported: number; skipped: number }> {
  let parsedChats: ParsedChat[];
  const dataArray = data as ImportElement[];
  switch (format) {
    case "chatgpt":
      parsedChats = parseChatGPT(dataArray);
      break;
    case "claude":
      parsedChats = parseClaude(dataArray);
      break;
    case "openwebui":
      parsedChats = parseOpenWebUI(dataArray);
      break;
    case "generic":
      parsedChats = parseGeneric(dataArray);
      break;
    default:
      throw new Error(`Unsupported import format: ${format}`);
  }

  let imported = 0;
  let skipped = 0;

  for (const parsedChat of parsedChats) {
    if (parsedChat.messages.length === 0) {
      skipped++;
      continue;
    }

    try {
      const chatId = uuidv4();
      await prisma.$transaction(
        [
          prisma.chat.create({
            data: {
              id: chatId,
              workspaceId,
              name: parsedChat.title,
              folderId: null,
            },
          }),
          ...parsedChat.messages.map((msg) =>
            prisma.chatMessage.create({
              data: {
                id: uuidv4(),
                chatId,
                role: msg.role,
                content: msg.content,
              },
            })
          ),
        ] as unknown as Array<Prisma.PrismaPromise<unknown>>
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  return { imported, skipped };
}