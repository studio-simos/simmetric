# Model Costs

## Pricing setup

1. Open **Settings → Providers** → select a provider → click the model's **pricing** action.
2. Enter the **per-1M-token** cost for input and output (e.g. `1.50` and `6.00`).
3. Select the currency. Click **Save pricing**.

The dialog converts to per-token internally: `perToken = perMillion / 1_000_000`.

## Formula

`cost = tokens × rate` (computed server-side on every token-usage write, snapshot-frozen at run time — later rate edits never rewrite history).

## Currency support

Per-currency totals — no conversion in v1. Supported: USD, EUR, GBP, JPY, CNY, INR.

## N/A vs $0.00

- **N/A** = pricing not configured (unset cloud models). The UI shows "N/A" — the admin should configure the rate.
- **$0.00** = explicit free (local/Ollama models are backfilled to 0 at migration time). The admin can override.

## v1 limitations

- Per-currency totals, no conversion
- Main-iteration cost only (tool/MCP/synthesis sub-pipeline costs excluded)
- Cost available at the `done` event (not mid-stream)
