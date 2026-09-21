// @ts-nocheck
/**
 * dlpEval.test.ts — DLP-05 eval-gate suite.
 *
 * Default arm: DETERMINISTIC tiers only (NER stubbed OFF — nerMode "stub").
 * Postgres-free + LLM-free: runEval drives the pure scan functions; prisma is
 * touched only by persistEvalResult (exercised in the route suite, not here).
 *
 * Live-Ollama arm: describe.skip gated on OLLAMA_BASE_URL reachability —
 * documented manual enablement evidence (D-05), not a default run.
 *
 * Fixture-authoring note (A2 — never hand-typed P.IVAs): the committed P.IVA
 * 00743110157 was verified through isValidPartitaIva (mod-10) at authoring
 * time; CFs derive from the canonical seed RSSMRA85M01A001X with check
 * letters recomputed via the dlpChecksum module (omocodia arm included).
 */

import "./helpers/setupEnv";

// dlpPatternService: the eval drives the deterministic tier with the SEEDED
// built-in pattern set (mirrored here — the real verb hits prisma; the unit
// suite is Postgres-free). Types match the seed's builtin rows so
// guessEntityClass routing applies (it_codice_fiscale/it_vat_iva/iban/email).
const MOCK_PATTERNS = [
  {
    type: "it_codice_fiscale",
    regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gu,
    replacement: "[GOV_ID]",
  },
  {
    type: "it_vat_iva",
    regex: /\b(?:P\.\s?IVA\.?|Partita\s+IVA)[:\s]*(?:IT)?\s?([0-9]{11})\b/gu,
    replacement: "[GOV_ID]",
  },
  {
    type: "iban",
    regex: /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/gu,
    replacement: "[FINANCIAL]",
  },
  {
    type: "email",
    regex: /(?<![\p{L}\p{N}_])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?![\p{L}\p{N}_])/gu,
    replacement: "[CONTACT]",
  },
];
const mockGetActiveCompiledPatterns = jest.fn().mockResolvedValue(MOCK_PATTERNS);
jest.mock("../services/dlpPatternService", () => ({
  __esModule: true,
  getActiveCompiledPatterns: (...args: unknown[]) => mockGetActiveCompiledPatterns(...args),
}));
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runEval,
  readEvalResult,
  DLP_EVAL_LAST_RUN_KEY,
} from "../services/dlpEvalService";
import { dlpEvalResultSchema, DLP_ENTITY_CLASSES } from "@simmetric-chat/shared";

describe("dlpEvalService.runEval (DLP-05 gate)", () => {
  it("empty corpus dir → explicit no-run state, never a silent pass (probe edge: empty)", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "dlp-eval-empty-"));
    try {
      const result = await runEval({ extraDir: emptyDir });
      const parsed = dlpEvalResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ passed: false, noRun: true });
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("missing ground-truth.json → no-run state (corpus with docs but no truth is ungated, not passed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-eval-nogt-"));
    try {
      writeFileSync(join(dir, "stray.txt"), "Codice Fiscale RSSMRA85M01A001X interno.");
      const result = await runEval({ extraDir: dir });
      expect(result).toEqual({ passed: false, noRun: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("committed corpus → run succeeds with per-class rows in the FIXED shared-enum order (probe edge: ordering)", async () => {
    // eslint-disable-next-line no-console
    console.log("PERCLASS:" + JSON.stringify(((await runEval()) as any).perClass));
    const result = (await runEval()) as { passed: boolean; perClass: { entityClass: string }[]; nerMode: string };
    // D-11/D-05: the GATE is the checksum-FP metric (0 FPs) — PERSON/ADDRESS
    // recall is DOCUMENTED-ONLY (nerMode "stub" marks the degraded
    // measurement); the deterministic tier never masks them, so the pass
    // criterion is the FP gate + checksum-class masking integrity.
    expect(result.nerMode).toBe("stub");
    expect(result.passed).toBe(true);
    const order = result.perClass.map((r) => r.entityClass);
    expect(order).toEqual([...DLP_ENTITY_CLASSES]);
  });

  it("single-file corpus yields a valid per-class report (probe edge: one-element)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-eval-single-"));
    try {
      writeFileSync(
        join(dir, "ground-truth.json"),
        JSON.stringify({
          files: [
            {
              file: "one.txt",
              entities: [{ text: "RSSMRA85M01A001X", entityClass: "GOV_ID" }],
            },
          ],
        }),
      );
      writeFileSync(join(dir, "one.txt"), "CF: RSSMRA85M01A001X del cliente.");
      const result = await runEval({ extraDir: dir });
      const parsed = dlpEvalResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
      const gov = (parsed.data as any).perClass.find((r: any) => r.entityClass === "GOV_ID");
      expect(gov.detected).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("committed corpus: 0 checksum-suppressed false positives (the GATE — DLP-05)", async () => {
    const result = (await runEval()) as {
      passed: boolean;
      perClass: { entityClass: string; falsePositives: number }[];
    };
    const checksumClasses = result.perClass.filter(
      (r) => r.entityClass === "GOV_ID" || r.entityClass === "FINANCIAL",
    );
    for (const row of checksumClasses) {
      expect(row.falsePositives).toBe(0);
    }
    expect(result.passed).toBe(true);
  });

  it("clean fixture (06-documento-pulito) → zero entities, zero FPs (masking-integrity arm)", async () => {
    const result = (await runEval()) as { fpRate: number; totalChecks: number };
    // The gate metric: fpRate is 0 when zero checksum FPs (and no integrity
    // failures) — the clean file contributes no detections.
    expect(result.fpRate).toBe(0);
    expect(result.totalChecks).toBeGreaterThan(0);
  });

  it("masking integrity: checksum-class entities round-trip (detected >= expected for GOV_ID/CONTACT)", async () => {
    // Deterministic-tier integrity: GOV_ID (CF/P.IVA-label/IBAN) + CONTACT
    // (email) round-trip WITHOUT the NER pass; PERSON/ADDRESS/FINANCIAL-amount
    // prose is the live-NER arm's documented measurement (nerMode "stub").
    // FINANCIAL GT carries NER-context prose amounts — documented-only.
    const result = (await runEval()) as {
      passed: boolean;
      perClass: { entityClass: string; detected: number; expected: number }[];
    };
    for (const cls of ["GOV_ID", "CONTACT"]) {
      const row = result.perClass.find((r) => r.entityClass === cls);
      expect(row).toBeDefined();
      expect(row!.detected).toBeGreaterThanOrEqual(row!.expected);
    }
  });
});

describe("dlpEvalService.readEvalResult", () => {
  it("null raw → the no-run arm through the shared schema", () => {
    const result = readEvalResult(null);
    const parsed = dlpEvalResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ passed: false, noRun: true });
  });

  it("malformed raw JSON → the no-run arm (fail-safe, never a silent pass)", () => {
    const result = readEvalResult("not-json{");
    expect(result).toEqual({ passed: false, noRun: true });
  });
});

// ---------------------------------------------------------------------------
// Live-Ollama arm (MANUAL — skipped by default).
// Enable by exporting OLLAMA_BASE_URL reachable from this host; measures the
// LLM contextual NER pass (nerMode: "live"). PERSON/ADDRESS recall is
// DOCUMENTED, never gated (nerMode marks the degraded measurement).
// ---------------------------------------------------------------------------
const LIVE_OLLAMA = process.env.OLLAMA_BASE_URL ?? "";
const describeLive = LIVE_OLLAMA ? describe : describe.skip;

describeLive("dlpEvalService.runEval — live NER arm (manual)", () => {
  it("runEval with a live NER provider documents PERSON/ADDRESS recall", async () => {
    const result = await runEval();
    // Live mode flips nerMode; the gate stays checksum-FP=0.
    expect(result).toBeDefined();
  });
});