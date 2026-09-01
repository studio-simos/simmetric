// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

describe("Chat Export", () => {
  it.todo("should produce valid JSON structure per D-09/D-10 schema");
  it.todo("should include model info per message in export");
  it.todo("should sanitize Content-Disposition filenames");
});

describe("Chat Import", () => {
  it.todo("should detect ChatGPT format from mapping field");
  it.todo("should detect Claude format from chat_messages field");
  it.todo("should detect Open WebUI format from messages + models field");
  it.todo("should detect generic JSON format from messages with role/content");
  it.todo("should skip attachments and report warning count in preview");
  it.todo("should create chats with new UUIDs on import confirm");
});
