# Contract: L2 Control HTTP API — authorize and budget

The service binds to `127.0.0.1:${CONTROL_PORT:-4020}`. Requests send
`Authorization: Bearer <token>`. Other L2 routes belong to other features:
- `/v1/reconcile` and `/v1/ledger/verify`: [feature 003](../../003-audit-ledger-reconciliation/contracts/)
- `/v1/approvals/:id`: [feature 004](../../004-human-approval-escalation/contracts/)

## POST /v1/authorize

| Item | Value |
|---|---|
| Auth | `CONTROL_TOKEN` only. Any other token, including settlement and operator, gets 401 |
| Request | `PaymentIntent` (SPEC §7) |
| 200 | `AuthorizationDecision`: AUTHORIZED, DENIED or ESCALATE (a policy outcome is never an HTTP error) |
| 400 | missing `intentId` or `sessionId`; `paymentRequired.accepts` is not an array; `resourceUrl` is not `http:`/`https:`. No ledger write |
| 401 | missing or wrong bearer token. No ledger write |

200 examples:

```json
{ "status": "AUTHORIZED", "authorizationId": "auth_…", "intentId": "int_…",
  "requirement": { "scheme": "exact", "network": "eip155:31337", "amount": "1000", "…": "…" },
  "paymentHeaders": { "PAYMENT-SIGNATURE": "<opaque>" },
  "payer": "0x…", "validBefore": 1760000000, "remainingSessionBudgetAtomic": "99000" }
```
```json
{ "status": "DENIED", "authorizationId": "auth_…", "intentId": "int_…",
  "violations": [ { "rule": "hard_cap_exceeded", "detail": "500000 > 100000" } ] }
```

Semantics:
- The request runs serialized (INV-8), in the order INTENT → decide → sign → outcome entry.
- `signerLatencyMs` is a construction option of the service, for tests only (T-E2E-04). It is
  not an HTTP parameter.

## GET /v1/budget/:sessionId

| Item | Value |
|---|---|
| Auth | `CONTROL_TOKEN` only |
| 200 | `BudgetStatus` |
| 401 | bad auth |

```json
{ "sessionId": "sess_ab12cd34", "asset": "0x…", "decimals": 6,
  "sessionCapAtomic": "100000", "spentOrReservedAtomic": "6000",
  "remainingAtomic": "94000", "perPaymentCapAtomic": "20000" }
```

`perPaymentCapAtomic` is the **auto-approve** limit, not the hard cap. `spentOrReservedAtomic`
is the ledger-derived committed spend ([feature 003](../../003-audit-ledger-reconciliation/contracts/)).
An unknown session returns 200 with zero spend.
