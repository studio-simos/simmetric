// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Wave 0 spike (RAG-04, de-risk Assumption A2): confirms prisma.$queryRaw binds a
// JS array as ONE PostgreSQL text[] param when the placeholder is cast ::text[].
// If the query succeeds and returns 3 rows, the binding is single-param
// (65535 limit respected by construction at BATCH_SIZE=500). If it fails or
// expands per-element, the implementer switches to Prisma.sql or
// $queryRawUnsafe with an explicit array literal.
//
// Run: npx tsx packages/server/src/__tests__/helpers/unnestSpike.ts
// (NOT a jest test — filename does not match *.test.ts; jest.config.js
// testMatch excludes this file from the unit suite.)

import prisma from "../../utils/prisma";

(async () => {
  await prisma.$connect();
  try {
    const sample = ["a", "b", "c"];
    // Three-placeholders variant — mirrors the RAG-04 SQL shape (5 arrays).
    const rows = await prisma.$queryRaw<{ x: string }[]>`
      SELECT * FROM unnest(
        ${sample}::text[],
        ${sample}::text[]
      ) AS t(x, y)
    `;
    console.log("[unnestSpike] rows:", rows);
    console.log("[unnestSpike] rowCount:", rows.length);
    if (rows.length === 3) {
      console.log("[unnestSpike] CONFIRMED: single-param per array (3 rows returned from a 3-element JS array).");
    } else {
      console.log("[unnestSpike] UNEXPECTED row count — investigate per-element expansion.");
    }
  } catch (err) {
    console.error("[unnestSpike] FAILED:", err);
    throw err;
  } finally {
    await prisma.$disconnect();
  }
})();

// OBSERVED: single-param per array — `SELECT * FROM unnest(${["a","b","c"]}::text[], ${["a","b","c"]}::text[]) AS t(x,y)` returned 3 rows `[a,b,c]`. Confirmed Prisma 7.8 binds a JS array as ONE PostgreSQL `text[]` parameter when the placeholder is cast `::text[]` in a `$queryRaw` tagged template. Param count = 5 for the RAG-04 INSERT regardless of batch size. No fallback to `Prisma.sql` / `$queryRawUnsafe` needed.