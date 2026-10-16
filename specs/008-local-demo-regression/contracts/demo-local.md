# Contract: `npm run demo:local [-- --llm]`

## Startup order, readiness, environment

| # | Role | Entry | Port | Readiness probe (every 250 ms, ≤ 30 s) | Env passed |
|---|---|---|---|---|---|
| 1 | chain | `scripts/local-chain.ts` | 8545 | JSON-RPC `eth_chainId` returns `0x7a69`, and `.local/deployment.json` exists | — |
| 2 | facilitator | `scripts/facilitator.ts` (wraps the `src/counterparty/facilitator.ts` factory) | 4022 | `GET /supported` returns 200 | `env/facilitator.env` |
| 3 | seller | `src/counterparty/seller.ts` | 4021 | `GET /api/catalog` returns 200 | `env/seller.env` |
| 4 | l2 | `src/layer2-control/service.ts` | 4020 | `GET /v1/budget/<sessionId>` returns 200 (control token) | `env/l2-control.env` (**only child with `PAYER_PRIVATE_KEY`**) |
| 5 | l3 | `src/layer3-settlement/service.ts` | 4023 | TCP connect succeeds | `env/l3-verifier.env` |
| 6 | agent | `src/main.ts --scripted` (or without the flag under `--llm`) | — | runs to exit | `env/l1-agent.env` + `SESSION_ID` |

- If a role's env file (column "Env passed") is missing, the demo builds that child's
  environment from the matching `.example` defaults, including the dev tokens and the local network.
- On `NETWORK=local`, missing keys are derived from the CP-5 mnemonic by 006's
  `scripts/local-chain-lib.ts` helper. Account #2 goes **only** to l2 as `PAYER_PRIVATE_KEY`,
  and account #1 goes **only** to the facilitator as `FACILITATOR_PRIVATE_KEY`. No other child
  gets a key.
- Children inherit only `PATH`, `HOME` and `NODE_*` from the parent, plus their own file.
  This stops a stray `PAYER_PRIVATE_KEY` in the parent shell from reaching the agent. Even if
  it did, INV-3 would make the agent exit 1.
- Endpoint contracts are owned elsewhere: L2 by [002](../../002-spending-policy-authorization/contracts/)
  and [003](../../003-audit-ledger-reconciliation/contracts/), L3 by
  [005](../../005-settlement-verification/contracts/), and the seller and facilitator by
  [006](../../006-counterparty-seller-network/contracts/).

## Shutdown

- Trigger: the agent exits, any child exits unexpectedly, the readiness timeout fires, or
  `SIGINT`/`SIGTERM` reaches the demo.
- For each started child, in reverse order: `process.kill(-pid, "SIGTERM")`. After 3 s,
  send `SIGKILL` to any still alive.
- Ports 8545 and 4020–4023 are free afterwards (NFR-001).

## Output

- Child lines are prefixed `[chain] [fac] [seller] [l2] [l3] [agent]`. The ganache `uws`
  fallback warning is dropped.
- The summary block is printed last and is stable for grepping:

```text
==== demo summary ====
network:            local
session:            sess_xxxxxxxx
outcomes:           FREE, PAID, PAID, ESCALATED, DENIED, DENIED   (scripted only)
spent on-chain: 0.006 USDC
budget:             spentOrReserved=6000 remaining=94000 (atomic)
hash chain ok=true entries=<n>
======================
```

`spent on-chain: 0.006 USDC` and `hash chain ok=true` are the **contract strings** (§0.3,
§12). The other lines are informational.

## Exit codes

| Condition | Code |
|---|---|
| Scripted run with the summary matching the baseline (outcomes, 6000, ok=true) | 0 |
| Scripted run with a baseline mismatch | 2 |
| `--llm` run completed (no baseline asserted) and chain ok | 0 |
| Port busy, readiness timeout, or child crash | 1 |
