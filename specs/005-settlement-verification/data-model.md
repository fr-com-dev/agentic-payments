# Data Model: Settlement Verification (L3)

Cross-layer types are defined once in `src/shared/contracts.ts` (SPEC.md §7). L3 consumes
`SettlementClaim` and produces `SettlementReport`.

## SettlementClaim (L1 → L3), consumed

| Field | Type | Use in L3 |
|---|---|---|
| authorizationId | string | Required (400 if missing). Key for the report and re-checks |
| requirement | `PaymentRequirements` | Required (400 if missing). Supplies `asset`, `payTo`, `amount` and `network` |
| payer | string | The expected `Transfer.from` |
| validBefore | number (s) | Passed through. L2 uses it for release (003) |
| httpStatus | number | Informational. It does not affect the status |
| paymentResponseHeader | string \| null | Decoded only to obtain `{success, transaction, network}` |

## SettlementReport (L3 → L2, L1)

| Field | Rule |
|---|---|
| authorizationId | copied from the claim |
| status | `CONFIRMED \| PENDING \| MISMATCH \| NOT_SETTLED` |
| transaction | the tx hash, when one was decoded |
| network | `requirement.network` |
| blockNumber | decimal string, when there is a receipt |
| confirmations | `head − block + 1`, when there is a receipt |
| finalityClass | `finalityClassFor(amount)`, always present |
| detail | human-readable reason, e.g. `no matching Transfer(payer→payTo, 1000)` |
| observedAt | ISO-8601 timestamp |
| verified | `{asset, payer, payTo, amount}` from the claim (L2 cross-checks these, see 003) |

## Finality class

| Class | Amount band (atomic) | Reached when |
|---|---|---|
| `included` | ≤ 10,000 | the receipt exists |
| `confirmed-depth` | 10,001 – 1,000,000 | `confirmations ≥ net.confirmationDepth` |
| `l1-safe` | > 1,000,000 | safe block ≥ tx block (`supportsSafeTag`), otherwise `confirmations ≥ 5 × depth` |

Network values come from CFG-1 (owned by 006):

| Network | Confirmation depth | Safe tag |
|---|---|---|
| `local` | 1 | no |
| `base-sepolia` | 2 | yes |

## Verification pipeline and status state machine (one `verify` call)

```text
start: amount = BigInt(req.amount); class = finalityClassFor(amount); deadline = now + waitMs
  │
  ├─ no PAYMENT-RESPONSE / decode error / !success / no tx ──────────► NOT_SETTLED
  ├─ settle.network ≠ req.network ────────────────────────────────────► MISMATCH
  ▼
waitForTransactionReceipt(tx, timeout=deadline − now, poll=pollMs)
  ├─ timeout ─────────────────────────────────────────────────────────► PENDING
  ├─ receipt.status ≠ success ────────────────────────────────────────► NOT_SETTLED
  ▼
Transfer logs from req.asset: any (from=payer, to=payTo, value=amount)?
  ├─ none ────────────────────────────────────────────────────────────► MISMATCH
  ▼
poll finality(class) until deadline
  ├─ reached ─────────────────────────────────────────────────────────► CONFIRMED
  └─ not reached ─────────────────────────────────────────────────────► PENDING
```

## Re-check schedule (in memory)

| Field | Default | Rule |
|---|---|---|
| authorizationId | — | One active schedule per id. A new PENDING replaces it |
| claim | — | The original claim, re-verified as is |
| attemptsLeft | 5 | Decremented per attempt. The schedule stops at 0 |
| intervalMs | 30000 | `setTimeout(...).unref()` |

Transitions:
- `PENDING → (re-check) → PENDING`: reschedule if `attemptsLeft > 0`.
- `PENDING → (re-check) → CONFIRMED`, `MISMATCH` or `NOT_SETTLED`: the schedule ends.

Every re-check result is reconciled. If all attempts end PENDING, L2 keeps counting the
amount (003 L2-4.1).
