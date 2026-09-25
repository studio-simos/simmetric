// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  DLP_ENTITY_CLASSES,
  dlpEntityClassSchema,
  dlpScanJobPayloadSchema,
  dlpEvalResultSchema,
  dlpEvalRunResponseSchema,
  dlpBackfillRequestSchema,
  dlpBackfillResponseSchema,
  dlpUnmaskQuerySchema,
} from "../schemas/dlpDocumentScan.schema";
import { PERMISSION_NAMES, DEFAULT_ROLES } from "../constants/permissions";

const validUUID = "550e8400-e29b-41d4-a716-446655440000";

// ─── DLP_ENTITY_CLASSES / dlpEntityClassSchema ─────────────────────

describe("DLP_ENTITY_CLASSES", () => {
  it("carries the fixed five-class vocabulary in canonical order", () => {
    expect([...DLP_ENTITY_CLASSES]).toEqual([
      "PERSON",
      "ADDRESS",
      "FINANCIAL",
      "GOV_ID",
      "CONTACT",
    ]);
  });

  it("rejects an unknown class value", () => {
    expect(dlpEntityClassSchema.safeParse("SECRET").success).toBe(false);
    expect(dlpEntityClassSchema.safeParse("person").success).toBe(false);
  });

  it("accepts every declared class", () => {
    for (const cls of DLP_ENTITY_CLASSES) {
      expect(dlpEntityClassSchema.safeParse(cls).success).toBe(true);
    }
  });
});

// ─── dlpScanJobPayloadSchema (D-01) ────────────────────────────────

describe("dlpScanJobPayloadSchema", () => {
  const validPayload = {
    documentId: validUUID,
    workspaceId: "ws-1",
    organizationId: "org-1",
  };

  it("accepts a valid payload", () => {
    const result = dlpScanJobPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid documentId", () => {
    const result = dlpScanJobPayloadSchema.safeParse({
      ...validPayload,
      documentId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty workspaceId", () => {
    const result = dlpScanJobPayloadSchema.safeParse({
      ...validPayload,
      workspaceId: "",
    });
    expect(result.success).toBe(false);
  });
});

// ─── dlpEvalResultSchema (D-11, discriminated noRun union) ─────────

describe("dlpEvalResultSchema", () => {
  it("parses the no-run arm ({ noRun: true, passed: false })", () => {
    const result = dlpEvalResultSchema.safeParse({ noRun: true, passed: false });
    expect(result.success).toBe(true);
  });

  it("parses the full-result arm in the fixed perClass order", () => {
    const result = dlpEvalResultSchema.safeParse({
      passed: true,
      fpRate: 0,
      totalChecks: 42,
      perClass: [
        { entityClass: "PERSON", detected: 5, expected: 5, falsePositives: 0 },
        { entityClass: "ADDRESS", detected: 3, expected: 3, falsePositives: 0 },
        { entityClass: "FINANCIAL", detected: 2, expected: 2, falsePositives: 0 },
        { entityClass: "GOV_ID", detected: 4, expected: 4, falsePositives: 0 },
        { entityClass: "CONTACT", detected: 1, expected: 1, falsePositives: 0 },
      ],
      lastRun: "2026-09-19T06:00:00.000Z",
      nerMode: "stub",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a perClass row with an unknown entityClass", () => {
    const result = dlpEvalResultSchema.safeParse({
      passed: true,
      fpRate: 0,
      totalChecks: 1,
      perClass: [
        { entityClass: "NOPE", detected: 0, expected: 0, falsePositives: 0 },
      ],
      lastRun: "2026-09-19T06:00:00.000Z",
      nerMode: "stub",
    });
    expect(result.success).toBe(false);
  });

  it("rejects the flat shape without noRun semantics (missing metrics)", () => {
    // A flat object that is neither arm: no noRun discriminator + no metrics.
    const result = dlpEvalResultSchema.safeParse({ passed: false });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed no-run arm (missing the passed literal)", () => {
    // noRun=true without passed:false matches NEITHER arm (the full-result
    // arm requires noRun false/absent) — the discriminator rejects it.
    const result = dlpEvalResultSchema.safeParse({ noRun: true });
    expect(result.success).toBe(false);
  });
});

// ─── dlpEvalRunResponseSchema ──────────────────────────────────────

describe("dlpEvalRunResponseSchema", () => {
  it("parses a full result carrying durationSeconds", () => {
    const result = dlpEvalRunResponseSchema.safeParse({
      passed: true,
      fpRate: 0.1,
      totalChecks: 10,
      perClass: [],
      lastRun: "2026-09-19T06:00:00.000Z",
      nerMode: "live",
      durationSeconds: 12.5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response without durationSeconds", () => {
    const result = dlpEvalRunResponseSchema.safeParse({
      passed: true,
      fpRate: 0.1,
      totalChecks: 10,
      perClass: [],
      lastRun: "2026-09-19T06:00:00.000Z",
      nerMode: "live",
    });
    expect(result.success).toBe(false);
  });
});

// ─── dlpBackfillRequestSchema / dlpBackfillResponseSchema (D-12) ───

describe("dlpBackfillRequestSchema", () => {
  it("accepts an absent body (empty-body trigger)", () => {
    expect(dlpBackfillRequestSchema.safeParse(undefined).success).toBe(true);
  });

  it("accepts an empty object", () => {
    expect(dlpBackfillRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe("dlpBackfillResponseSchema", () => {
  it("accepts { enqueued, skipped, totalEligible, errors }", () => {
    const result = dlpBackfillResponseSchema.safeParse({
      enqueued: 3,
      skipped: 1,
      totalEligible: 4,
      errors: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative enqueued count", () => {
    const result = dlpBackfillResponseSchema.safeParse({
      enqueued: -1,
      skipped: 0,
      totalEligible: 0,
      errors: [],
    });
    expect(result.success).toBe(false);
  });
});

// ─── dlpUnmaskQuerySchema (D-10) ───────────────────────────────────

describe("dlpUnmaskQuerySchema", () => {
  it("coerces ?unmask=true", () => {
    const result = dlpUnmaskQuerySchema.safeParse({ unmask: "true" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unmask).toBe(true);
  });

  it("rejects ?unmask=1 (strict literal union — no truthy-string coercion)", () => {
    const result = dlpUnmaskQuerySchema.safeParse({ unmask: "1" });
    expect(result.success).toBe(false);
  });

  it("tolerates an absent query param", () => {
    const result = dlpUnmaskQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("coerces ?unmask=false to FALSE (never the Boolean()-inverse trap)", () => {
    const result = dlpUnmaskQuerySchema.safeParse({ unmask: "false" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unmask).toBe(false);
  });

  it("rejects a non-boolean value — ?unmask=banana is NOT an unmask attempt (T-192-21, plan 04 tightening)", () => {
    const result = dlpUnmaskQuerySchema.safeParse({ unmask: "banana" });
    expect(result.success).toBe(false);
  });
});

// ─── dlp:unmask permission (D-10 / Phase 190 D-07 precedent) ──────

describe("dlp:unmask permission", () => {
  it("is declared in PERMISSION_NAMES", () => {
    expect(PERMISSION_NAMES).toContain("dlp:unmask");
  });

  it("is the 36th permission entry (37th is Phase 195 mcp:oauth:manage; 38th/39th are Phase 198 connector:manage/connector:view; 40th is Phase 202 plugins:manage; 41st is Phase 206 agency:users:manage)", () => {
    expect(PERMISSION_NAMES[35]).toBe("dlp:unmask");
    // Phase 195 (MCPO-01 D-15): the array grew to 37 with mcp:oauth:manage
    // appended AFTER dlp:unmask — dlp:unmask keeps its index-36 position.
    // Phase 198 (ECCO-01 D-04): 37 → 39 with connector:manage/connector:view.
    // Phase 202 (PLGM-05 D-08): 39 → 40 with plugins:manage appended.
    // Phase 206 (AGENCY-03 D-07): 40 → 41 with agency:users:manage appended.
    expect(PERMISSION_NAMES.length).toBe(41);
    expect(PERMISSION_NAMES[36]).toBe("mcp:oauth:manage");
    expect(PERMISSION_NAMES[37]).toBe("connector:manage");
    expect(PERMISSION_NAMES[38]).toBe("connector:view");
    expect(PERMISSION_NAMES[39]).toBe("plugins:manage");
    expect(PERMISSION_NAMES[40]).toBe("agency:users:manage");
  });

  it("DEFAULT_ADMIN_ROLE auto-gains it via the spread", () => {
    const admin = DEFAULT_ROLES.find((r) => r.name === "admin");
    expect(admin?.permissions).toContain("dlp:unmask");
  });

  it("DEFAULT_USER_ROLE does NOT include it (elevated capability)", () => {
    const user = DEFAULT_ROLES.find((r) => r.name === "user");
    expect(user?.permissions).not.toContain("dlp:unmask");
  });
});