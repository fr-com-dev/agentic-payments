# Contract: L1 ports and HTTP adapters

These interfaces are defined in `src/shared/contracts.ts` (SPEC.md §7). L1 consumes them and
must not redefine them.

```ts
interface AuthorizationGatePort {
  authorize(intent: PaymentIntent): Promise<AuthorizationDecision>;
  budget(sessionId: string): Promise<BudgetStatus>;
}
interface SettlementVerifierPort {
  verify(claim: SettlementClaim): Promise<SettlementReport>;
}
```

## HTTP mapping (`ports-http.ts`, L1-2)

| Port method | HTTP call | Auth header | Success | Failure |
|---|---|---|---|---|
| `authorize(intent)` | `POST {CONTROL_URL}/v1/authorize`, JSON body `PaymentIntent` | `Authorization: Bearer ${CONTROL_TOKEN}` | 200 → `AuthorizationDecision` | any non-2xx **throws** (400 malformed, 401) |
| `budget(sessionId)` | `GET {CONTROL_URL}/v1/budget/:sessionId` | `Bearer ${CONTROL_TOKEN}` | 200 → `BudgetStatus` | non-2xx throws |
| `verify(claim)` | `POST {SETTLEMENT_URL}/v1/settlements`, JSON body `SettlementClaim` | `Bearer ${VERIFIER_TOKEN}` | 200 → `SettlementReport` | non-2xx throws (400, 401) |

Rules:
- Each adapter receives exactly one token. `CONTROL_TOKEN` is never sent to L3, and
  `VERIFIER_TOKEN` is never sent to L2 (INV-13).
- L1 has no adapter for `/v1/reconcile`, `/v1/approvals/*` or `/v1/ledger/verify`. Those
  belong to the L3 and operator roles.

## Orchestrator API (L1-1)

```ts
class PaidResourceOrchestrator {
  constructor(deps: { gate: AuthorizationGatePort; settlement: SettlementVerifierPort;
                      sessionId: string; fetchImpl?: typeof fetch });
  fetchPaid(url: string, purpose: string): Promise<PaidFetchResult>;
}
```

Behavior is normative in SPEC.md §8.1 L1-1, steps 1–8. The state machine is in
[../data-model.md](../data-model.md).

## Seller-facing wire contract (§10, L1 side)

| Header | L1 action |
|---|---|
| `PAYMENT-REQUIRED` (on 402) | decode with `decodePaymentRequiredHeader` |
| `PAYMENT-SIGNATURE` (on the retry) | send exactly as returned in `decision.paymentHeaders` |
| `PAYMENT-RESPONSE` (on the paid response) | pass the raw string to L3, without decoding it |
