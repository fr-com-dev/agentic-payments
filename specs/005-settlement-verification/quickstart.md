# Quickstart: validate Settlement Verification (L3)

## Prerequisites

- Node.js 22. Run `npm install` (not `npm ci`).
- 006 (local chain, MockUSDC, seller, facilitator) and 002/003 (L2 with `/v1/reconcile`)
  are implemented.
- Copy `env/l3-verifier.env.example` to `env/l3-verifier.env`. It contains only `NETWORK`,
  `CONTROL_URL`, `VERIFIER_TOKEN`, `SETTLEMENT_TOKEN` and optionally `BASE_SEPOLIA_RPC_URL`,
  with no key.

## 1. Static checks (INV-4)

```bash
npm run typecheck
npx vitest run test/architecture.test.ts
```

Expected: `src/layer3-settlement/**` has no wallet, signing or write calls, and imports only
`src/shared/*`.

## 2. Verifier unit scenarios

These should be covered by tests, against ganache or a stubbed public client:

| Claim | Expected |
|---|---|
| `paymentResponseHeader: null` | `NOT_SETTLED` |
| undecodable header, or `success:false`, or no `transaction` | `NOT_SETTLED` |
| `settle.network` ≠ `requirement.network` | `MISMATCH` |
| a reverted tx | `NOT_SETTLED` |
| a real tx, but `amount` differs from the Transfer | `MISMATCH` |
| a Transfer emitted by a different contract | `MISMATCH` |
| amounts 10000 / 10001 / 1000000 / 1000001 | classes `included` / `confirmed-depth` / `confirmed-depth` / `l1-safe` |
| `l1-safe` on `local` (no safe tag) | CONFIRMED only once `confirmations ≥ 5` |
| a receipt that never arrives (short `waitMs`) | `PENDING` |

## 3. End-to-end (T-E2E-01, T-E2E-03)

```bash
npx vitest run test/e2e.local.test.ts -t "T-E2E-01"
npx vitest run test/e2e.local.test.ts -t "T-E2E-03"
```

Expected:
- **T-E2E-01**: two CONFIRMED reports (1000 and 5000 atomic, class `included`).
- **T-E2E-03**: a forged `PAYMENT-RESPONSE` produces an L3 report with `MISMATCH`. The L2
  side (sticky CONFIRMED, an anomaly naming `amount`) is validated in 003.

## 4. API checks (service running: `npm run l3:verifier`)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4023/v1/settlements \
  -H 'content-type: application/json' -d '{}'                                   # 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4023/v1/settlements \
  -H "authorization: Bearer $VERIFIER_TOKEN" -H 'content-type: application/json' -d '{}'  # 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4023/v1/settlements \
  -H "authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' -d '{}'   # 401 (T-AUTH-02; 401 precedes 400)
```

The service is not reachable on a non-loopback interface.

## 5. Resilience

- Stop L2 and submit a valid claim. L3 still returns 200 with the report and logs a
  reconcile failure (SC-005). If L2 hangs instead of refusing connections, the reconcile
  call times out after 5 s and the report still arrives within `waitMs` + 5 s.
- Submit a PENDING claim with a test `recheckIntervalMs`. Up to 5 re-checks reconcile into
  L2, and the process can exit without waiting for the timers.

Shapes: [data-model.md](data-model.md). API: [contracts/settlements-api.md](contracts/settlements-api.md).

## Recorded results (2026-10-16, 008 stage)

- §1–§2 `test/architecture.test.ts` (INV-4) and `test/verifier.test.ts` green.
- §3 T-E2E-01 (2 CONFIRMED, class `included`) and T-E2E-03 (two forgeries → MISMATCH) pass in `test/e2e.local.test.ts`.
- §4 against a live `l3:verifier` (example env): no token → 401; verifier token with `{}` → 400; control token → 401.
- §5 with L2 down, a valid claim (null `PAYMENT-RESPONSE`) returned 200 with the report, and L3 logged `reconcile failed for auth_x: fetch failed`. The hung-L2 timeout and the PENDING re-check schedule are covered by `test/settlement-service.test.ts`.
