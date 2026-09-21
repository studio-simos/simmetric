// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 190 (SKIL-02, D-09) — parseSkillArgs grammar battery.
 * Pure-function tests: positional / key=value / quoted / mixed / defaults /
 * zero-placeholder / missing-required / unknown-key arms.
 */
import { parseSkillArgs } from "../utils/skillArgs";

const schemaWithInput = {
  properties: { input: { type: "string" }, targetLang: { type: "string" } },
  required: ["input"],
};

describe("parseSkillArgs", () => {
  it("fills the first required field from a single positional token", () => {
    expect(parseSkillArgs("Ciao", schemaWithInput, {})).toEqual({
      ok: true,
      params: { input: "Ciao" },
    });
  });

  it("joins multi-word positional text with single spaces into the first required field", () => {
    expect(parseSkillArgs("Ciao   mondo  bello", schemaWithInput, {})).toEqual({
      ok: true,
      params: { input: "Ciao mondo bello" },
    });
  });

  it("supports key=value with quoted values containing spaces", () => {
    expect(
      parseSkillArgs('input="Ciao mondo" targetLang=Spanish', schemaWithInput, {})
    ).toEqual({
      ok: true,
      params: { input: "Ciao mondo", targetLang: "Spanish" },
    });
  });

  it("supports bare key=value tokens", () => {
    expect(parseSkillArgs("input=Ciao", schemaWithInput, {})).toEqual({
      ok: true,
      params: { input: "Ciao" },
    });
  });

  it("unescapes double-quoted values (escaped quotes inside the span)", () => {
    expect(parseSkillArgs('input="say \\"hi\\""', schemaWithInput, {})).toEqual({
      ok: true,
      params: { input: 'say "hi"' },
    });
  });

  it("handles mixed positional and key=value tokens", () => {
    expect(parseSkillArgs("Ciao mondo targetLang=Spanish", schemaWithInput, {})).toEqual({
      ok: true,
      params: { input: "Ciao mondo", targetLang: "Spanish" },
    });
  });

  it("fills every required field from defaultParams when args are empty", () => {
    const schema = {
      properties: { input: {}, targetLang: {} },
      required: ["input", "targetLang"],
    };
    expect(
      parseSkillArgs("", schema, { input: "auto-detect", targetLang: "en" })
    ).toEqual({
      ok: true,
      params: { input: "auto-detect", targetLang: "en" },
    });
  });

  it("fails as missing-required when a required field has neither value nor default", () => {
    expect(parseSkillArgs("", schemaWithInput, {})).toEqual({
      ok: false,
      error: "missing-required",
    });
  });

  it("positional args override defaults for the first required field", () => {
    expect(parseSkillArgs("Ciao", schemaWithInput, { input: "auto" })).toEqual({
      ok: true,
      params: { input: "Ciao" },
    });
  });

  it("ignores key=value tokens whose key is not in inputSchema.properties", () => {
    expect(parseSkillArgs("foo=bar Ciao", schemaWithInput, {})).toEqual({
      ok: true,
      params: { input: "Ciao" },
    });
  });

  it("returns ok with empty params for a placeholder-free skill (zero required)", () => {
    expect(parseSkillArgs("", { properties: {}, required: [] }, {})).toEqual({
      ok: true,
      params: {},
    });
  });

  it("drops positional tokens when the schema has no required field", () => {
    expect(parseSkillArgs("orphan text", { properties: {}, required: [] }, {})).toEqual({
      ok: true,
      params: {},
    });
  });

  it("treats a quoted token containing = as positional text", () => {
    expect(parseSkillArgs('"a=b" Ciao', schemaWithInput, {})).toEqual({
      ok: true,
      params: { input: "a=b Ciao" },
    });
  });
});