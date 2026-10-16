# Data Model: Audit Ledger & Reconciliation

The JSON Schema is in [contracts/ledger-entry.schema.json](contracts/ledger-entry.schema.json).
`SettlementReport` is defined in `src/shared/contracts.ts` (SPEC.md §7). Its producer is
feature 005.

## LedgerEntry (one JSONL line)

| Field | Type | Rule |
|---|---|---|
| seq | integer | Starts at 0, increments by 1 per append, no gaps |
| ts | string | ISO-8601 timestamp at append time |
| type | enum | `INTENT`, `AUTHORIZED`, `DENIED`, `ESCALATED`, `HUMAN_APPROVAL` or `SETTLEMENT` |
| sessionId? | string | Present on every type except a SETTLEMENT entry whose authorization has no session |
| intentId? | string | Present on INTENT, AUTHORIZED, DENIED and ESCALATED |
| authorizationId? | string | Present on AUTHORIZED, DENIED, ESCALATED and SETTLEMENT. HUMAN_APPROVAL uses `data.escalationId` |
| data | object | Type-specific, see below |
| prevHash | hex64 | `"0"×64` for `seq 0`, otherwise the previous entry's `hash` |
| hash | hex64 | `sha256(canonicalJSON(entry without hash))` |

### `data` by type

| Type | Fields | Written by |
|---|---|---|
| INTENT | `resourceUrl, purpose, accepts[]` | authorize, step 1 (002) |
| AUTHORIZED | `amount, asset, network, payTo, payer, validBefore (s), resourceUrl, mandateId, approvalRef` — `approvalRef` is required: the consumed approval's `approvalId` (`apr_…`), or `null` when no approval was used | authorize (002) |
| DENIED | `violations[{rule, detail}], resourceKey` | authorize (002) |
| ESCALATED | `violations[], resourceKey, payTo, amount` | authorize (002) |
| HUMAN_APPROVAL | `approvalId (apr_<uuid>), escalationId, resourceKey, payTo, amount, approver, expiresAtMs` | approvals (004) |
| SETTLEMENT | `...SettlementReport, anomaly: boolean` (status forced to `MISMATCH` on a field mismatch) | reconcile (this feature) |

`resourceKey = new URL(resourceUrl).origin + pathname`, without the query string.

## Derived views (computed, never stored)

| View | Definition |
|---|---|
| Effective report(authId) | The SETTLEMENT entry with the highest `seq` for `authId` among those with `anomaly !== true` |
| Effective status | `effectiveReport?.status`, or "unreported" |
| Committed spend(filter, nowMs) | Σ `amount` of AUTHORIZED entries in the filter, **excluding** those where effective status = NOT_SETTLED **and** `nowMs > validBefore×1000` |
| Session committed | the filter is `{sessionId}` |
| Daily committed | the filter is `{sinceMs: nowMs − 86_400_000}` |
| Velocity count | the number of AUTHORIZED entries with `ts ≥ nowMs − 60_000` |
| Open approval(session, resourceKey, nowMs) | The most recent HUMAN_APPROVAL for (session, resourceKey) with `nowMs ≤ expiresAtMs` and no AUTHORIZED entry whose `approvalRef` equals its `approvalId`. Each approval is single-use by its own `approvalId`; several approvals for one escalation each pay once (semantics: 004) |
| Chain verification | `{entries, ok, brokenAt?}`; `brokenAt` is the 0-based line index of the first failing line |

## Effective settlement status per authorization

```text
(unreported) ─report→ PENDING ─report→ CONFIRMED  (final; INV-11)
     │                  │  └─report→ NOT_SETTLED ─(nowMs > validBefore)→ released from committed
     │                  └─report→ MISMATCH (counts)
     └─report→ CONFIRMED | NOT_SETTLED | MISMATCH

After CONFIRMED, any report that is not CONFIRMED for the same tx is stored with anomaly=true
and is ignored. A field mismatch at any stage is stored as MISMATCH with anomaly=true, which
also leaves the effective status unchanged.
```

## Validation rules

- An entry is never mutated after append. There is no delete API.
- Amounts are `^\d+$` strings, summed with BigInt.
- Address comparisons in reconcile are case-insensitive.
- A parse failure on any line, a hash mismatch or a link mismatch at load causes `integrity`
  and L2 does not start.
