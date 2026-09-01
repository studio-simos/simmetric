// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck
/**
 * Unit tests for chatImportService — CSW-15 (Phase 159-01, D-06).
 *
 * Covers detectImportFormat (8 cases), all 4 pure parsers (parseChatGPT,
 * parseClaude, parseOpenWebUI, parseGeneric), generateImportPreview, and
 * importChats (empty/failure/happy-path). The 4 parsers + detectImportFormat
 * + generateImportPreview are pure (no mocks); importChats mocks prisma +
 * uuid.
 */

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    chat: { create: jest.fn() },
    chatMessage: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock("uuid", () => ({
  __esModule: true,
  v4: jest.fn(() => "test-import-uuid"),
}));

import prisma from "../utils/prisma";
import {
  detectImportFormat,
  parseChatGPT,
  parseClaude,
  parseOpenWebUI,
  parseGeneric,
  generateImportPreview,
  importChats,
} from "../services/chatImportService";

const mockPrisma = prisma as unknown as {
  chat: { create: jest.Mock };
  chatMessage: { create: jest.Mock };
  $transaction: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ===== detectImportFormat (pure) =====
describe("detectImportFormat", () => {
  it("returns null for null input", () => {
    expect(detectImportFormat(null)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(detectImportFormat([])).toBeNull();
  });

  it("wraps single object with 'mapping' (not array) and returns 'chatgpt'", () => {
    const single = { mapping: {}, title: "Chat" };
    expect(detectImportFormat(single)).toBe("chatgpt");
  });

  it("returns 'chatgpt' when array[0] has 'mapping'", () => {
    expect(detectImportFormat([{ mapping: {} }])).toBe("chatgpt");
  });

  it("returns 'claude' when array[0] has 'chat_messages'", () => {
    expect(detectImportFormat([{ chat_messages: [] }])).toBe("claude");
  });

  it("returns 'openwebui' when array[0] has 'messages' + 'models'", () => {
    expect(detectImportFormat([{ messages: [], models: [] }])).toBe("openwebui");
  });

  it("returns 'generic' when array[0] has 'messages' array of {role, content}", () => {
    expect(detectImportFormat([{ messages: [{ role: "user", content: "hi" }] }])).toBe("generic");
  });

  it("returns null when array[0] is non-object", () => {
    expect(detectImportFormat(["not-an-object"])).toBeNull();
  });
});

// ===== parseChatGPT (pure) =====
describe("parseChatGPT", () => {
  it("extracts user/assistant messages from mapping nodes, joins text parts", () => {
    const data = [
      {
        title: "My Chat",
        mapping: {
          n1: { message: { author: { role: "user" }, content: { parts: ["Hello"] } } },
          n2: { message: { author: { role: "assistant" }, content: { parts: ["Hi", "there"] } } },
        },
      },
    ];

    const result = parseChatGPT(data);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("My Chat");
    expect(result[0].messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi\nthere" },
    ]);
    expect(result[0].attachmentCount).toBe(0);
  });

  it("counts non-string parts as attachments, excludes them from messages", () => {
    const data = [
      {
        mapping: {
          n1: {
            message: {
              author: { role: "user" },
              content: { parts: ["text", { image_url: "http://..." }, "more"] },
            },
          },
        },
      },
    ];

    const result = parseChatGPT(data);

    expect(result[0].attachmentCount).toBe(1);
    expect(result[0].messages).toEqual([{ role: "user", content: "text\nmore" }]);
  });

  it("skips mapping nodes with role 'system'", () => {
    const data = [
      {
        mapping: {
          n1: { message: { author: { role: "system" }, content: { parts: ["sys"] } } },
          n2: { message: { author: { role: "user" }, content: { parts: ["hi"] } } },
        },
      },
    ];

    const result = parseChatGPT(data);

    expect(result[0].messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

// ===== parseClaude (pure) =====
describe("parseClaude", () => {
  it("maps sender 'human'→'user' and 'assistant'→'assistant'", () => {
    const data = [
      {
        name: "Claude Chat",
        chat_messages: [
          { sender: "human", text: "Hi" },
          { sender: "assistant", text: "Hello" },
        ],
      },
    ];

    const result = parseClaude(data);

    expect(result[0].title).toBe("Claude Chat");
    expect(result[0].messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("counts non-string text as attachments and skips other senders", () => {
    const data = [
      {
        chat_messages: [
          { sender: "human", text: { obj: true } },
          { sender: "system", text: "sys" },
          { sender: "assistant", text: "ok" },
        ],
      },
    ];

    const result = parseClaude(data);

    expect(result[0].attachmentCount).toBe(1);
    expect(result[0].messages).toEqual([{ role: "assistant", content: "ok" }]);
  });
});

// ===== parseOpenWebUI (pure) =====
describe("parseOpenWebUI", () => {
  it("extracts role+content, skips non-string content as attachments", () => {
    const data = [
      {
        title: "OWUI Chat",
        messages: [
          { role: "user", content: "Question" },
          { role: "assistant", content: 42 },
          { role: "assistant", content: "Answer" },
        ],
      },
    ];

    const result = parseOpenWebUI(data);

    expect(result[0].title).toBe("OWUI Chat");
    expect(result[0].attachmentCount).toBe(1);
    expect(result[0].messages).toEqual([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]);
  });
});

// ===== parseGeneric (pure) =====
describe("parseGeneric", () => {
  it("parses messages with role+content", () => {
    const data = [{ title: "Gen", messages: [{ role: "user", content: "Test" }] }];

    const result = parseGeneric(data);

    expect(result[0].title).toBe("Gen");
    expect(result[0].messages).toEqual([{ role: "user", content: "Test" }]);
  });

  it("falls back to 'user' role when role is non-string (WR-04 tolerance)", () => {
    const data = [{ messages: [{ content: "No role" }] }];

    const result = parseGeneric(data);

    expect(result[0].messages).toEqual([{ role: "user", content: "No role" }]);
  });
});

// ===== generateImportPreview (pure) =====
describe("generateImportPreview", () => {
  it("returns error for unrecognized format", () => {
    const result = generateImportPreview([{ unknown: "shape" }]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Unrecognized import format");
  });

  it("returns format, chats, and warnings for ChatGPT format", () => {
    const data = [{ mapping: { n1: { message: { author: { role: "user" }, content: { parts: ["hi"] } } } } }];
    const result = generateImportPreview(data);

    expect(result).toHaveProperty("format");
    const r = result as { format: string; chats: unknown[]; warnings: { type: string; count: number }[] };
    expect(r.format).toBe("chatgpt");
    expect(r.chats.length).toBe(1);
    expect(r.warnings[0].type).toBe("attachments_skipped");
  });
});

// ===== importChats (mocked prisma + uuid) =====
describe("importChats", () => {
  it("skips chats with empty messages (imported=0, skipped=1)", async () => {
    const data = [{ mapping: {} }]; // parseChatGPT yields 0 messages
    const result = await importChats("ws-1", "user-1", data, "chatgpt");

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("happy path: creates Chat + ChatMessage records in a transaction (imported=1)", async () => {
    mockPrisma.$transaction.mockResolvedValue([]);
    const data = [
      {
        title: "Imported",
        messages: [{ role: "user", content: "Hello" }],
      },
    ];

    const result = await importChats("ws-1", "user-1", data, "generic");

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // The transaction receives an array of Prisma promises
    const txArgs = mockPrisma.$transaction.mock.calls[0][0];
    expect(Array.isArray(txArgs)).toBe(true);
    expect(txArgs.length).toBe(2); // 1 chat.create + 1 chatMessage.create
  });

  it("increments skipped on transaction failure (imported=0, skipped=1)", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("DB error"));
    const data = [{ messages: [{ role: "user", content: "x" }] }];

    const result = await importChats("ws-1", "user-1", data, "generic");

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });
});