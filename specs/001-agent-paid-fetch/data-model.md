# Data Model: Agent Paid Fetch (L1)

Cross-layer types are defined once in `src/shared/contracts.ts` (SPEC.md §7). L1 produces
`PaymentIntent` and `SettlementClaim`. It consumes `AuthorizationDecision`,
`SettlementReport` and `BudgetStatus`. `PaidFetchResult` is local to L1.

## PaymentIntent (L1 → L2)

| Field | Type | Rule |
|---|---|---|
| intentId | string | `"int_" + uuid v4`, unique per authorize call |
| sessionId | string | `SESSION_ID`, or `sess_<8 hex>`; constant for the process |
| resourceUrl | string | The URL L1 requested. Must be http or https (L2 returns 400 otherwise) |
| paymentRequired | `PaymentRequired` | The decoded challenge, **verbatim**, with all `accepts[]` entries |
| purpose | string | Model or script text, **audit only** (INV-5) |
| createdAt | string | ISO-8601 timestamp |

## AuthorizationDecision (L2 → L1), consumed

- `AUTHORIZED` carries:
  - `authorizationId`, `intentId`
  - `requirement` (the single chosen option)
  - `paymentHeaders` (opaque)
  - `payer`, `validBefore` (seconds)
  - `remainingSessionBudgetAtomic`
- `DENIED` or `ESCALATE` carries `authorizationId`, `intentId` and `violations[{rule, detail}]`.

## SettlementClaim (L1 → L3)

| Field | Source |
|---|---|
| authorizationId, requirement, payer, validBefore | the AUTHORIZED decision |
| httpStatus | the status of the paid retry |
| paymentResponseHeader | the raw `PAYMENT-RESPONSE` value, or `null` |

## SettlementReport (L3 → L1), consumed

L1 reads `status` (CONFIRMED, PENDING, MISMATCH or NOT_SETTLED), `transaction` and
`finalityClass`.

## PaidFetchResult (L1 internal)

| Field | Type | Present when |
|---|---|---|
| outcome | `FREE \| PAID \| DENIED \| ESCALATED \| PAYMENT_FAILED \| ERROR` | always |
| url | string | always |
| httpStatus | number | a response was received |
| body | unknown | FREE; PAID; PAYMENT_FAILED with a 2xx response |
| payment | `{ authorizationId, amountAtomic, asset, network, payTo, settlement: SettlementReport }` | PAID, PAYMENT_FAILED after authorization |
| violations | `PolicyViolation[]` | DENIED, ESCALATED |
| authorizationId | string | any outcome after L2 answered |
| error | string | ERROR |

### Outcome state machine (one `fetchPaid` call)

```text
GET url ──network error──────────────────────────────► ERROR
   │ status ≠ 402 ───────────────────────────────────► FREE
   ▼ 402
decode challenge ──fail (header and body)────────────► ERROR
   ▼
gate.authorize ──DENIED──────────────────────────────► DENIED     (no retry)
   │           ──ESCALATE────────────────────────────► ESCALATED  (no retry)
   ▼ AUTHORIZED
GET url + paymentHeaders
   ▼
settlement.verify ──2xx and (CONFIRMED | PENDING)────► PAID
                  ──otherwise────────────────────────► PAYMENT_FAILED
```

A thrown `gate.authorize` error (non-2xx from L2) gives `ERROR` with the message. It is never
treated as AUTHORIZED. A thrown `settlement.verify` error after a 2xx paid retry gives
`PAYMENT_FAILED` and keeps `payment` and `authorizationId`, because money may have moved
(SPEC.md v1.1 L1-1, via 008 T000).

## Tool result (`fetch_resource`) shown to the model

`{outcome, httpStatus, body, payment:{authorizationId, amountUsd, settlement:{status, tx, finality}}, violations, authorizationId, error}`

`amountUsd` is a display string derived from `amountAtomic`.

## Agent session

- `sessionId` is fixed per process.
- The budget is owned by L2. `check_budget` returns `BudgetStatus`: `sessionCapAtomic`,
  `spentOrReservedAtomic`, `remainingAtomic`, `perPaymentCapAtomic`, `asset` and `decimals`.
