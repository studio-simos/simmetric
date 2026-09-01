// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 125-01 Task 3 — WIDGET_LOCALES ↔ frontend ALL_LANGUAGES parity guard (D-01).
 *
 * The 3-vs-7 locale drift closed in this phase: the widget contract now lists
 * 7 locales and mirrors the frontend's ALL_LANGUAGES. This test asserts
 * SET-equality (order-insensitive — D-01 lists en/it/ru/de/fr/es/zh while
 * ALL_LANGUAGES order is en/de/es/fr/it/ru/zh; order parity is a false
 * constraint).
 *
 * The frontend i18n module must NOT be imported at runtime in a shared test:
 * it runs i18next.init() and reads localStorage (breaks node-env). Instead we
 * read the source file via fs.readFileSync — the sourceCitationSeam.test.ts
 * grep-guard idiom.
 */

import * as fs from "fs";
import * as path from "path";
import { WIDGET_LOCALES } from "../schemas/widget.schema";

describe("WIDGET_LOCALES parity with frontend ALL_LANGUAGES (D-01)", () => {
  it("mirrors every frontend language code", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../frontend/src/i18n/index.ts"),
      "utf-8",
    );
    const codes = [...src.matchAll(/code:\s*"([a-z]{2})"/g)].map((m) => m[1]);
    expect(new Set(codes)).toEqual(new Set(WIDGET_LOCALES));
  });
});
