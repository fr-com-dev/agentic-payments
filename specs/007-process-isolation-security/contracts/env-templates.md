# Contract: Per-process environment templates (CFG-2)

## Loading

- Every entry point loads exactly one file, `ENV_FILE` (default: the role's
  `env/<role>.env`), with dotenv, without override. Variables already in the process
  environment win.
- No code loads a root `.env`. A repository-level `.env` containing `PAYER_PRIVATE_KEY` is
  forbidden and must not be documented.

## Templates (`env/*.env.example`): exact variable sets

| Template | Variables (`?` = optional) | Must NOT contain |
|---|---|---|
| `l1-agent.env.example` | `NETWORK, ANTHROPIC_API_KEY, ANTHROPIC_MODEL?, SELLER_URL, CONTROL_URL, SETTLEMENT_URL, CONTROL_TOKEN, VERIFIER_TOKEN, SESSION_ID?` | `PAYER_PRIVATE_KEY`, `SETTLEMENT_TOKEN`, `OPERATOR_TOKEN`, `FACILITATOR_PRIVATE_KEY` |
| `l2-control.env.example` | `NETWORK, PAYER_PRIVATE_KEY, ALLOWED_PAYEES, ALLOWED_HOSTS, CONTROL_TOKEN, SETTLEMENT_TOKEN, OPERATOR_TOKEN` | `ANTHROPIC_API_KEY`, `VERIFIER_TOKEN`, `FACILITATOR_PRIVATE_KEY` |
| `l3-verifier.env.example` | `NETWORK, BASE_SEPOLIA_RPC_URL?, CONTROL_URL, VERIFIER_TOKEN, SETTLEMENT_TOKEN` | any private key, `CONTROL_TOKEN`, `OPERATOR_TOKEN` |
| `seller.env.example` | `NETWORK, SELLER_PAY_TO, FACILITATOR_URL?` | any private key, any bearer token |
| `facilitator.env.example` | `NETWORK=local, FACILITATOR_PRIVATE_KEY` | `PAYER_PRIVATE_KEY`, any bearer token |
| `operator.env.example` | `CONTROL_URL, OPERATOR_TOKEN` | any private key, other tokens |

Port overrides (`CONTROL_PORT`, `SELLER_PORT`, `FACILITATOR_PORT`, `SETTLEMENT_PORT`) may be
added as optional variables to the matching service template.

Template values are placeholders. Dev tokens are marked `# local only`. Private keys are
always empty with `# set me` (one convention for every template). The local demo derives the
local payer and facilitator keys from the CP-5 mnemonic via 006's `scripts/local-chain-lib.ts`
helper and passes each only to its own child process. 007 owns all six templates.

## Verification

An architecture-suite check (T-ARCH-ENV) parses each template's keys and asserts that the
set matches the table: required keys present, forbidden keys absent. This is SC-005,
6 of 6 templates.
