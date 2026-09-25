// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 206 (Task 5 / VALIDATION W0): agency schema contracts.

import {
  createSubUserSchema,
  resetSubUserPasswordSchema,
  updateSubUserSchema,
} from "../schemas/agency.schema";
import { roleSectionVisibilitySchema } from "../schemas/role.schema";

describe("Phase 206 agency schemas", () => {
  describe("createSubUserSchema", () => {
    it("accepts a valid sub-user payload", () => {
      const parsed = createSubUserSchema.safeParse({
        username: "mario.rossi",
        email: "mario@example.com",
        password: "supersecret1",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts an omitted password (server generates temp password — D-06)", () => {
      const parsed = createSubUserSchema.safeParse({ username: "mario", email: "m@example.com" });
      expect(parsed.success).toBe(true);
    });

    it("rejects uppercase usernames (regex ^[a-z0-9_.-]+$)", () => {
      const parsed = createSubUserSchema.safeParse({ username: "Mario", email: "m@example.com" });
      expect(parsed.success).toBe(false);
    });

    it("rejects short usernames", () => {
      const parsed = createSubUserSchema.safeParse({ username: "ab", email: "m@example.com" });
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid emails", () => {
      const parsed = createSubUserSchema.safeParse({ username: "mario", email: "not-an-email" });
      expect(parsed.success).toBe(false);
    });

    it("rejects short passwords", () => {
      const parsed = createSubUserSchema.safeParse({
        username: "mario",
        email: "m@example.com",
        password: "short",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("resetSubUserPasswordSchema", () => {
    it("accepts an optional newPassword (server generates when omitted — D-06)", () => {
      expect(resetSubUserPasswordSchema.safeParse({}).success).toBe(true);
      expect(resetSubUserPasswordSchema.safeParse({ newPassword: "longenough1" }).success).toBe(true);
    });

    it("rejects short passwords", () => {
      expect(resetSubUserPasswordSchema.safeParse({ newPassword: "short" }).success).toBe(false);
    });
  });

  describe("updateSubUserSchema", () => {
    it("accepts the disable arm payload", () => {
      expect(updateSubUserSchema.safeParse({ disabled: true }).success).toBe(true);
    });

    it("accepts an empty body", () => {
      expect(updateSubUserSchema.safeParse({}).success).toBe(true);
    });
  });

  describe("roleSectionVisibilitySchema (VIS-01 D-14)", () => {
    it("accepts a section toggle list", () => {
      const parsed = roleSectionVisibilitySchema.safeParse({
        sections: [
          { sectionKey: "llm", visible: false },
          { sectionKey: "security", visible: true },
        ],
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects an empty sections array (min 1)", () => {
      expect(roleSectionVisibilitySchema.safeParse({ sections: [] }).success).toBe(false);
    });

    it("rejects missing visible flag", () => {
      expect(
        roleSectionVisibilitySchema.safeParse({ sections: [{ sectionKey: "llm" }] }).success,
      ).toBe(false);
    });
  });
});