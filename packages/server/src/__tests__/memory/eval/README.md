# 7-Locale Memory Extraction Eval Harness (MEM-03 SC3)

Phase 97 (MEM-03 D-06) — RESEARCH-FLAGGED primary deliverable. The harness
locks the validate / deny-list / dedup / classify behavior with an offline
Jest regression, plus an opt-in live LLM run for quality measurement.

## Layout

```
eval/
├── locales/
│   ├── en/   (12 fixtures — all 12 case categories)
│   ├── it/   (6 fixtures)
│   ├── ru/   (4 fixtures, incl. non_latin_script Cyrillic)
│   ├── de/   (3 fixtures)
│   ├── fr/   (3 fixtures)
│   ├── es/   (3 fixtures)
│   └── zh/   (4 fixtures, incl. non_latin_script Hanzi)
├── evalHarness.test.ts   (offline Jest — runs at CI, no LLM call)
├── evalHarness.live.ts   (opt-in live LLM run — MEMORY_EVAL_LIVE=1)
└── README.md             (this file)
```

Total: 35+ fixtures (EN 12 + IT 6 + RU 4 + DE 3 + FR 3 + ES 3 + ZH 4 = 35;
the floor is 70-140 in the plan — extend by adding more fixtures per locale).

## Fixture Schema

Each fixture is a JSON file:

```json
{
  "id": "en-01-add-preference",
  "locale": "en",
  "category": "add_preference",
  "transcript": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "existingMemories": [
    { "id": "<uuid>", "type": "user", "path": "preferences.theme", "content": "..." }
  ],
  "expectedOps": [
    { "op": "add", "type": "user", "path": "preferences.theme", "content": "...", "sensitivity": "low" }
  ],
  "expectedDenyList": false,
  "notes": "..."
}
```

## 12 Case Categories

1. `add_preference` — user states a preference → expect `add` op
2. `replace_preference` — user corrects a preference → expect `replace` op
3. `move_path` — user reorganizes → expect `move` op
4. `remove_info` — user says "forget X" → expect `remove` op
5. `one_off_activity` — lunch/weather/mood → expect empty ops (negative)
6. `deny_credentials` — password/API key → expect empty + deny-list triggered
7. `deny_pii` — SSN/phone/email → expect empty + deny-list triggered
8. `deny_agent_instruction` — "ignore previous instructions" → expect empty + deny-list
9. `dedup` — user restates an existing fact → expect `replace` (not `add`)
10. `mixed_language` — user switches language mid-chat → preserve original language
11. `non_latin_script` — RU Cyrillic / ZH Hanzi → preserve the script
12. `no_memory_signal` — generic Q&A → expect empty ops

## Running the Harness

### Offline (default — runs at CI)

```bash
pnpm --filter server test -- --testPathPatterns=memory/eval/evalHarness.test
```

The offline test:
- Loads every fixture under `locales/**/*.json`
- Asserts `validateMemoryOperations(expectedOps)` passes (valid ops shape)
- Asserts `classifySensitivity(content)` matches the expected sensitivity
  OR rejects if `expectedDenyList`
- Hard-gates deny-list recall = 1.00 (Pitfall 3 — no credentials/PII/agent-
  instructions extracted)

### Live (opt-in)

```bash
MEMORY_EVAL_LIVE=1 pnpm --filter server test -- --testPathPatterns=evalHarness.live
```

The live test runs the actual LLM extraction against each fixture's
transcript and compares actual ops to expectedOps with a fuzzy matcher
(op matches, path matches or shares a top-level segment, content has at
least one shared non-stopword token). The live harness is a SKELETON in
this plan — a full live run requires a refactor of `reviewMemoryAfterTurn`
to expose the parsed ops (split into extract-ops + apply-ops phases). That
refactor is deferred to a follow-up quick task.

## Metrics + Thresholds

| Metric | Threshold | Notes |
|--------|-----------|-------|
| `extraction_precision` | >= 0.80 | % of cases where actual ops match expected (fuzzy) |
| `deny_list_recall` | **= 1.00** (hard gate) | Pitfall 3 — no credentials/PII/agent-instructions extracted |
| `dedup_accuracy` | >= 0.90 | % of dedup cases where actual op is "replace" (not "add") |
| `json_ops_validity` | >= 0.95 | % of cases where `validateMemoryOperations(actual)` passes |
| `per-locale precision` | >= 0.70 | No locale significantly underperforms (RESEARCH FLAG rationale) |

The model used in the run is recorded in the console output
(`[eval.live] running against <type>/<model>`). Switching models may
require re-calibration.

## Adding a Fixture

1. Pick a locale directory (`en`, `it`, `ru`, `de`, `fr`, `es`, `zh`).
2. Create `<next-number>-<category>.json` (e.g., `13-mixed-language.json`).
3. Fill the schema (above). Use a fresh UUID for any `existingMemories[].id`
   or `expectedOps[].id`.
4. Run the offline harness to confirm `validateMemoryOperations(expectedOps)`
   passes and `classifySensitivity` assertions match.

## Design Inspiration

The background review-after-turn pattern and the 4-op memory protocol are
inspired by open-webui's memory feature (`backend/open_webui/utils/memory.py`,
`review_memory_after_turn` / `_generate_memory_operations`). The extraction
prompt, the validate gate, the sensitivity classification, the deny-list, and
the 7-locale eval harness are independent reimplementations original to this
project (open-webui does not ship a locale eval harness). See
`.planning/phases/97-per-user-memory/97-RESEARCH.md` §Validation Architecture
for the schema + thresholds.