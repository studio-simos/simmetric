// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (ECCO-01, D-03) — connector Zod contract tests.
// Postgres-free (shared runs pure). Pins: closed platform enum, pollMode
// enum, required create fields, write-only token discipline (botToken NEVER
// on update — unknown-key strip), clear-by-null update fields, no-.partial()
// update shape, validate/webhook/param schemas.

import {
  connectorPlatformSchema,
  connectorPollModeSchema,
  createConnectorSchema,
  updateConnectorSchema,
  validateTokenSchema,
  webhookSetupSchema,
  connectorIdParamSchema,
} from "../schemas/connector.schema";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("connectorPlatformSchema (D-03 closed enum)", () => {
  it("accepts the 4 platform values of the union", () => {
    for (const p of ["telegram", "discord", "slack", "whatsapp"] as const) {
      expect(connectorPlatformSchema.safeParse(p).success).toBe(true);
    }
  });

  it("rejects values outside the closed set (teams, empty, case variants)", () => {
    for (const bad of ["teams", "", "Telegram", "TELEGRAM", "telegram ", 42, null, undefined]) {
      expect(connectorPlatformSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("connectorPollModeSchema", () => {
  it("accepts polling and webhook only", () => {
    expect(connectorPollModeSchema.safeParse("polling").success).toBe(true);
    expect(connectorPollModeSchema.safeParse("webhook").success).toBe(true);
    expect(connectorPollModeSchema.safeParse("long-poll").success).toBe(false);
    expect(connectorPollModeSchema.safeParse("").success).toBe(false);
  });
});

describe("createConnectorSchema", () => {
  const validCreate = {
    platform: "telegram",
    name: "Support bot",
    workspaceId: UUID,
    botToken: "123456:ABC-token",
  };

  it("accepts the minimal create (platform + name + workspaceId + botToken)", () => {
    const parsed = createConnectorSchema.safeParse(validCreate);
    expect(parsed.success).toBe(true);
  });

  it("requires platform, name, workspaceId and botToken", () => {
    const { platform: _p, ...noPlatform } = validCreate;
    const { name: _n, ...noName } = validCreate;
    const { workspaceId: _w, ...noWorkspace } = validCreate;
    const { botToken: _t, ...noToken } = validCreate;
    expect(createConnectorSchema.safeParse(noPlatform).success).toBe(false);
    expect(createConnectorSchema.safeParse(noName).success).toBe(false);
    expect(createConnectorSchema.safeParse(noWorkspace).success).toBe(false);
    expect(createConnectorSchema.safeParse(noToken).success).toBe(false);
  });

  it("rejects an empty botToken (min 1) and a non-uuid workspaceId", () => {
    expect(createConnectorSchema.safeParse({ ...validCreate, botToken: "" }).success).toBe(false);
    expect(createConnectorSchema.safeParse({ ...validCreate, workspaceId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a platform outside the closed set even with valid other fields", () => {
    const parsed = createConnectorSchema.safeParse({
      platform: "teams",
      name: "x",
      workspaceId: UUID,
      botToken: "t",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts optional overrides (limits, pin, locale) with tri-state null", () => {
    const parsed = createConnectorSchema.safeParse({
      ...validCreate,
      rateLimitPerMinute: null,
      sessionLimitPerDay: 30,
      responseProviderId: null,
      responseModel: "gemma4:latest",
      fallbackLocale: "it",
      archiveId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects negative limits and oversized name", () => {
    expect(createConnectorSchema.safeParse({ ...validCreate, rateLimitPerMinute: -1 }).success).toBe(false);
    expect(createConnectorSchema.safeParse({ ...validCreate, name: "x".repeat(201) }).success).toBe(false);
  });
});

describe("updateConnectorSchema (no-.partial() shape, D-03)", () => {
  it("accepts a pollMode change", () => {
    const parsed = updateConnectorSchema.safeParse({ pollMode: "webhook" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.pollMode).toBe("webhook");
  });

  it("accepts clear-by-null limits and pin fields (nullable write contract)", () => {
    const parsed = updateConnectorSchema.safeParse({
      rateLimitPerMinute: null,
      sessionLimitPerDay: null,
      responseProviderId: null,
      responseModel: null,
      archiveId: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.rateLimitPerMinute).toBeNull();
      expect(parsed.data.responseProviderId).toBeNull();
    }
  });

  it("accepts an empty update (all fields optional)", () => {
    expect(updateConnectorSchema.safeParse({}).success).toBe(true);
  });

  it("rejects a non-enum pollMode and a negative limit", () => {
    expect(updateConnectorSchema.safeParse({ pollMode: "push" }).success).toBe(false);
    expect(updateConnectorSchema.safeParse({ rateLimitPerMinute: -5 }).success).toBe(false);
  });

  it("STRIPS botToken (write-only discipline: the key is not in the schema — unknown keys never persist)", () => {
    const parsed = updateConnectorSchema.safeParse({ botToken: "x" });
    // Zod default object behavior strips unknown keys — parse succeeds but
    // the write-only field is gone from parsed.data (pin the stripping).
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.botToken).toBeUndefined();
  });

  it("does NOT derive from createConnectorSchema via .partial() (independent z.object — pollMode has no injected default)", () => {
    // Pin the no-.partial() discipline structurally: parsing {} must NOT
    // inject a pollMode default (a .partial() of a .default()-carrying field
    // would). The route's data spread then preserves partial-update semantics.
    const parsed = updateConnectorSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.pollMode).toBeUndefined();
  });
});

describe("validateTokenSchema", () => {
  it("accepts platform + botToken", () => {
    expect(
      validateTokenSchema.safeParse({ platform: "telegram", botToken: "123456:ABC" }).success,
    ).toBe(true);
  });

  it("rejects missing token or platform outside the set", () => {
    expect(validateTokenSchema.safeParse({ platform: "telegram" }).success).toBe(false);
    expect(validateTokenSchema.safeParse({ platform: "teams", botToken: "t" }).success).toBe(false);
    expect(validateTokenSchema.safeParse({ platform: "telegram", botToken: "" }).success).toBe(false);
  });
});

describe("webhookSetupSchema", () => {
  it("accepts a valid http(s) URL", () => {
    expect(webhookSetupSchema.safeParse({ url: "https://chat.example.com" }).success).toBe(true);
    expect(webhookSetupSchema.safeParse({ url: "http://localhost:3000" }).success).toBe(true);
  });

  it("rejects non-URLs", () => {
    expect(webhookSetupSchema.safeParse({ url: "not a url" }).success).toBe(false);
    expect(webhookSetupSchema.safeParse({}).success).toBe(false);
  });
});

describe("connectorIdParamSchema", () => {
  it("accepts a uuid and rejects anything else", () => {
    expect(connectorIdParamSchema.safeParse({ id: UUID }).success).toBe(true);
    expect(connectorIdParamSchema.safeParse({ id: "abc" }).success).toBe(false);
    expect(connectorIdParamSchema.safeParse({}).success).toBe(false);
  });
});