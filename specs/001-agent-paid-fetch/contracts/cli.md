# Contract: Agent process CLI (L1-5)

## Invocation

| Command | Behavior |
|---|---|
| `npm run agent -- "<goal>"` | Run the Claude agent (L1-3) with `<goal>`. If no goal is given, use a default goal. |
| `npm run agent:scripted` (`src/main.ts --scripted`) | Run the six-step scripted plan (L1-4). |

## Environment (`ENV_FILE=env/l1-agent.env`)

| Variable | Required | Notes |
|---|---|---|
| `NETWORK` | yes | `local` or `base-sepolia` |
| `ANTHROPIC_API_KEY` | LLM mode | not needed with `--scripted` |
| `ANTHROPIC_MODEL` | no | default `claude-sonnet-5-5` |
| `SELLER_URL` | yes | e.g. `http://127.0.0.1:4021` |
| `CONTROL_URL`, `CONTROL_TOKEN` | yes | L2 authorize and budget only |
| `SETTLEMENT_URL`, `VERIFIER_TOKEN` | yes | L3 settlements only |
| `SESSION_ID` | no | default `sess_<8 hex>` |
| `PAYER_PRIVATE_KEY` | **forbidden** | if present, print the refusal to stderr and **exit 1** before any work |

## Output and exit codes

| Condition | Exit code | Output |
|---|---|---|
| Normal completion | 0 | per-step outcomes (scripted) or the final model answer with receipts (LLM), then the final `BudgetStatus` |
| `PAYER_PRIVATE_KEY` present | 1 | refusal message |
| Unhandled error (e.g. L2 unreachable at startup) | non-zero | error message |
