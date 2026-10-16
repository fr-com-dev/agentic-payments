# Data Model: Local Demo, Regression Baseline & Operability

These are tooling-level shapes. None of them crosses a layer boundary. Cross-layer types
belong to `src/shared/contracts.ts` (features 001–005).

## ScriptedPlanStep (baseline)

| # | path | price (atomic) | expected outcome | expected rule(s) |
|---|---|---|---|---|
| 1 | `/api/catalog` | 0 | FREE | — |
| 2 | `/api/weather?city=Lima` | 1000 | PAID (CONFIRMED) | — |
| 3 | `/api/market-brief` | 5000 | PAID (CONFIRMED) | — |
| 4 | `/api/premium-report` | 50000 | ESCALATED | `human_approval_required` |
| 5 | `/api/dataset-export` | 500000 | DENIED | ⊇ `hard_cap_exceeded` |
| 6 | `http://localhost:<sellerPort>/api/weather?city=Lima` | 1000 | DENIED | ⊇ `host_not_allowed` |

The plan itself is owned by 001 (L1-4). This table is the regression oracle.

## RegressionBaseline

| Field | Value |
|---|---|
| outcomes | `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]` |
| onChainDeltaAtomic | `"6000"` (payer −6000, seller payTo +6000) |
| confirmedSettlements | 2 (non-anomalous `SETTLEMENT` entries with status CONFIRMED) |
| ledgerChainOk | `true` |
| spentOrReservedAtomic | `"6000"` |

## DemoProcess

| Field | Type | Notes |
|---|---|---|
| role | `chain \| facilitator \| seller \| l2 \| l3 \| agent` | log prefix only; never used to build file names |
| command | string[] | `npx tsx <entry>`; facilitator: `npx tsx scripts/facilitator.ts` |
| envFile | string \| null | explicit per role: facilitator `env/facilitator.env`, seller `env/seller.env`, l2 `env/l2-control.env`, l3 `env/l3-verifier.env`, agent `env/l1-agent.env`; the chain has none |
| port | number \| null | 8545, 4022, 4021, 4020, 4023; the agent has none |
| readiness | probe | see [contracts/demo-local.md](contracts/demo-local.md) |
| pid / pgid | number | `detached: true`, so pgid = pid |

### Lifecycle

```text
preflight ports ─fail─► abort (exit 1)
   ▼
start chain ► ready ► facilitator ► ready ► seller ► ready ► l2 ► ready ► l3 ► ready
   ▼
run agent (scripted | --llm) ► exit
   ▼
compute summary (balances, budget, ledger verify) ► print
   ▼
finally/SIGINT: kill(-pgid, SIGTERM) → 3 s → kill(-pgid, SIGKILL) for every child, in reverse order
```

## DemoSummary

`{ network, sessionId, outcomes?, spentOnChainAtomic, spentOnChainUsd, budget: BudgetStatus, ledger: { entries, ok, brokenAt? } }`

The printed format is fixed in [contracts/demo-local.md](contracts/demo-local.md).

## Milestone

`{ id: M0..M7, deliverables[], exitCheck: command, owningFeatures[] }`. See
[contracts/dod-and-milestones.md](contracts/dod-and-milestones.md).
