# DLP Detection Eval Gate (DLP-05)

The per-workspace document-scan toggle is **eval-gated**: admins can enable it only after the detection-quality eval passes.

## What the eval measures

`dlpEvalService.runEval()` drives the deterministic scan tiers (regex + checksum; NER stubbed) over the committed corpus `packages/server/src/__tests__/fixtures/dlp-eval/` (8 synthetic Italian fixtures + `ground-truth.json`):

- **Primary metric:** checksum-suppressed false positives on checksum-validated classes (GOV_ID: CF/P.IVA/IBAN; FINANCIAL: P.IVA). **Gate: 0.**
- **Reported, never gated:** PERSON/ADDRESS recall (nerMode `stub` marks the degraded measurement; the live-Ollama arm is a manual enablement-evidence harness).
- **Fixed per-class order:** PERSON, ADDRESS, FINANCIAL, GOV_ID, CONTACT (stable across runs).
- **Adjacency merge:** overlapping identifier matches inside one checksum span count once.
- **Empty corpus:** explicit `{ passed: false, noRun: true }` — never a silent pass.

## Running

```bash
# Unit suite (Postgres-free, NER stubbed):
pnpm --filter server test -- src/__tests__/dlpEval.test.ts

# Admin endpoints (server running):
curl -X POST -H "Authorization: Bearer <admin-jwt>" http://localhost:3000/api/system/dlp/eval/run
curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3000/api/system/dlp/eval/result
```

## Enablement flow

1. Run the eval (button in Settings → the DlpDocumentScanPanel, or the POST endpoint).
2. Result panel shows pass/fail + per-class rates + FP rate + last-run date.
3. When `passed: true`, the per-workspace toggles unblock (the `gateBlocked` helper clears).
4. The legacy backfill (DLP-06) likewise refuses to run until the gate is green.

## Extending the corpus

Add fixtures + ground-truth entries under the fixtures dir. Rules: synthetic content only (never real person data — D-11); checksum values must pass validation (CF parity verified in `dlpChecksum` — canonical `RSSMRA85M01A001X`, omocodia arm `RSSMRAU5ML1A001X`; P.IVA `00743110157`); the omocodia-CF detection arm is exercised by `dlpChecksum.test.ts` (29/29) since the classic CF regex cannot reach omocodia forms deterministically.