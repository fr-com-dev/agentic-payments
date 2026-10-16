# Contract: L3 Settlement API (L3-2)

The service binds to `127.0.0.1:${SETTLEMENT_PORT:-4023}` (loopback only, §3.1).

## `POST /v1/settlements` (owned by 005)

| Item | Value |
|---|---|
| Auth | `Authorization: Bearer ${VERIFIER_TOKEN}` (the L1 → L3 role only), enforced by `requireRole("agent-verifier")` from 007, which runs **before** body validation |
| Request body | `SettlementClaim` (SPEC §7, [data-model.md](../data-model.md)) |
| 200 | `SettlementReport`. Returned for **every** status, including MISMATCH, NOT_SETTLED and PENDING |
| 401 | missing or wrong token, including `CONTROL_TOKEN` or `SETTLEMENT_TOKEN`: `{ error: "unauthorized" }`. Checked first, so 401 precedes 400 |
| 400 | valid token, but `authorizationId` is not a string or `requirement` is not an object: `{ error: string }` |

Side effects, in order:
1. Run `verify(claim)` (see [verifier.md](verifier.md)).
2. Call `reconcile(report)` on L2 with a 5 s timeout (`AbortSignal.timeout(5000)`). Await it,
   but catch and log any error or timeout; the 200 response to L1 is unaffected.
3. If `report.status === "PENDING"`, schedule re-checks (5 × 30 s, unref'd). A new PENDING
   claim for the same `authorizationId` replaces the existing schedule, and re-checking stops
   at the first non-PENDING result. Each result is reconciled again.
4. Respond 200 with the report. Worst-case latency is `waitMs` (one shared deadline) plus the
   5 s reconcile timeout.

Example request:

```json
{
  "authorizationId": "auth_7c1e…",
  "requirement": { "scheme": "exact", "network": "eip155:31337", "asset": "0x5Fb…",
                   "payTo": "0x90F…", "amount": "1000", "maxTimeoutSeconds": 120,
                   "extra": { "name": "USD Coin", "version": "2" } },
  "payer": "0x3C4…",
  "validBefore": 1792141200,
  "httpStatus": 200,
  "paymentResponseHeader": "eyJzdWNjZXNzIjp0cnVl…"
}
```

Example 200 response:

```json
{
  "authorizationId": "auth_7c1e…", "status": "CONFIRMED", "transaction": "0xab12…",
  "network": "eip155:31337", "blockNumber": "42", "confirmations": 1,
  "finalityClass": "included", "detail": "Transfer matched; finality included reached",
  "observedAt": "2026-10-16T12:00:00.000Z",
  "verified": { "asset": "0x5Fb…", "payer": "0x3C4…", "payTo": "0x90F…", "amount": "1000" }
}
```

## Outbound: L3 → L2 reconcile (client only)

L3 calls `POST {CONTROL_URL}/v1/reconcile` with `Authorization: Bearer ${SETTLEMENT_TOKEN}`
and body `SettlementReport`. The endpoint, its responses and the anomaly rules are owned by
**003**: see
[`specs/003-audit-ledger-reconciliation/contracts/`](../../003-audit-ledger-reconciliation/contracts/).
L3 does not interpret the `{ ok, anomaly }` response beyond logging it.

## Token rules (INV-13)

- `VERIFIER_TOKEN` is accepted inbound only.
- `SETTLEMENT_TOKEN` is used outbound only.
- L3 never holds `CONTROL_TOKEN`, `OPERATOR_TOKEN` or any private key.

The full credential matrix is owned by
[007](../../007-process-isolation-security/contracts/).
