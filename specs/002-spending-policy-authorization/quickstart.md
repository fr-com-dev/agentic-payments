# Quickstart: validate Spending Policy & Authorization (L2)

## Prerequisites

- Node.js 22. Run `npm install`.
- `env/l2-control.env` is created from its template. It holds `PAYER_PRIVATE_KEY`,
  `CONTROL_TOKEN` and the allowlists. This file is the only place the payer key appears.
- For the end-to-end steps you also need features 003 (ledger), 005 (L3) and 006 (seller,
  local chain).

## 1. Pure policy (T-POL-01..14)

```bash
npm run typecheck
npx vitest run test/policy.test.ts
```

Expected:
- Every rule ID in [contracts/policy-rules.md](contracts/policy-rules.md) is produced by at
  least one test, including `no_payment_options`.
- Two `decide` runs on the same inputs are deep-equal.
- `committed + amount == budget` passes, and one more atomic unit is denied.

## 2. Authorize and budget over HTTP (local)

```bash
ENV_FILE=env/l2-control.env npm run l2:control
curl -s -H "Authorization: Bearer $CONTROL_TOKEN" http://127.0.0.1:4020/v1/budget/sess_test
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4020/v1/authorize   # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'content-type: application/json' -d '{}' http://127.0.0.1:4020/v1/authorize      # expect 400
```

Expected:
- The budget call returns `spentOrReservedAtomic: "0"`, `perPaymentCapAtomic: "20000"` and
  `sessionCapAtomic: "100000"`.
- A request with the operator or settlement token returns 401.

## 3. Serialization (T-E2E-04) and its negative control

```bash
npx vitest run test/e2e.local.test.ts -t "T-E2E-04"
```

Expected: with `signerLatencyMs: 25` and 15 concurrent intents, exactly 10 are AUTHORIZED and
5 are DENIED with `velocity_limit`.

Negative control (Principle VIII):
1. Temporarily bypass the mutex in `service.ts`.
2. Re-run the test. It must **fail** with 15/15 AUTHORIZED.
3. Revert the change.

## 4. Scripted plan effects (via feature 008)

```bash
npm run demo:local
```

Expected:
- Step 4 is ESCALATED with `human_approval_required`.
- Step 5 is DENIED with `hard_cap_exceeded`.
- Step 6 is DENIED with `host_not_allowed`.
- The final budget shows `spentOrReservedAtomic = 6000`.

Shapes: [data-model.md](data-model.md). API: [contracts/http-api.md](contracts/http-api.md).
Signer: [contracts/signer.md](contracts/signer.md).

## Recorded results (2026-10-16, 008 stage)

- §2 against a live `l2:control` (example env, derived dev key): budget `sess_test` returned `spentOrReservedAtomic "0"`, `perPaymentCapAtomic "20000"`, `sessionCapAtomic "100000"`; `POST /v1/authorize` with no token → 401; control token with `{}` → 400; operator and settlement tokens on `/v1/budget` → 401.
- §3 T-E2E-04 runs in `test/e2e.local.test.ts` on the 008 harness: 10/15 AUTHORIZED, 5 `velocity_limit`. Without the mutex: 15/15 (002 T029).
- §4 `npm run demo:local`: steps 4–6 ESCALATED `human_approval_required`, DENIED `hard_cap_exceeded`, DENIED `host_not_allowed`; `spentOrReserved=6000`; summary `spent on-chain: 0.006 USDC`, `hash chain ok=true`; exit 0.
