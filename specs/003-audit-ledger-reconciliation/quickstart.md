# Quickstart: validate the Audit Ledger & Reconciliation

## Prerequisites

- Node.js 22. Run `npm install`.
- For the e2e checks: feature 002 (authorize), 005 (L3) and 006 (local chain, seller,
  facilitator), plus the harness from 008.

## 1. Unit checks (no network)

```bash
npm run typecheck
npx vitest run test/ledger.test.ts
```

| Test | Expected |
|---|---|
| T-LED-01 | The chain verifies after several appends. Editing one stored line makes reload throw `integrity`. |
| T-LED-02 | AUTHORIZED 1000 + NOT_SETTLED: committed spend is 1000 before `validBefore` and 0 after it. |
| T-LED-03 | An anomalous SETTLEMENT entry is ignored. The effective status stays CONFIRMED. |

## 2. End-to-end checks

```bash
npx vitest run test/e2e.local.test.ts -t "T-E2E-01"   # L2 side
npx vitest run test/e2e.local.test.ts -t "T-E2E-03"
npx vitest run test/e2e.local.test.ts -t "T-E2E-05"
```

Expected:
- T-E2E-01: session `spentOrReserved = 6000`, 2 non-anomalous CONFIRMED settlements, and the
  chain is ok.
- T-E2E-03: the forged amount is stored as MISMATCH with `anomaly: true`, the detail names
  `amount`, and the first CONFIRMED is kept.
- T-E2E-05: `/v1/reconcile` with the agent token returns 401, and the entry count is
  unchanged.

## 3. Manual tamper check

```bash
npm run demo:local                                          # writes .local/ledger-local.jsonl
curl -s -H "Authorization: Bearer dev-operator-token" http://127.0.0.1:4020/v1/ledger/verify
# → {"entries":N,"ok":true}
# Stop L2, change one character in any line of .local/ledger-local.jsonl, restart L2:
ENV_FILE=env/l2-control.env npm run l2:control              # → exits with "integrity: …"
```

Restore by deleting the ledger file. A fresh ledger starts at the genesis.

Schemas: [contracts/ledger-entry.schema.json](contracts/ledger-entry.schema.json).
Endpoints: [contracts/http-api.md](contracts/http-api.md).

## 4. Safety proofs (recorded 2026-10-16, constitution VIII)

Each mechanism was removed temporarily, the named test failed, and the code was restored byte-for-byte (`npx vitest run test/ledger.test.ts`: 18/18 after restore).

| Task | Mechanism removed | Result without it |
|---|---|---|
| T016 | `verifyChain()` check in the `AuditLedger` constructor | T-LED-01 and T-LED-01b fail (tampered, truncated, deleted and reordered files load silently) |
| T024 | `nowMs > validBefore×1000` condition in `committedAtomic` | T-LED-02 fails (NOT_SETTLED released before the signature expires) |
| T031 | `anomaly !== true` filter in `effectiveReport` | T-LED-03 and the repeated-CONFIRMED test fail (a contradicting report overrides CONFIRMED) |
| T036 | `requireRole("verifier-control")` on `POST /v1/reconcile` | the in-process role test fails (other tokens reach the ledger) |

The routes live in `src/layer2-control/ledger-routes.ts` (`mountLedgerRoutes`); 002's service bootstrap mounts them with its `serialize` mutex.

## Recorded results (2026-10-16, 008 stage)

- §1 `test/ledger.test.ts` green (24 tests).
- §2 `test/e2e.local.test.ts` T-E2E-01 (L2 side: spentOrReserved 6000, 2 CONFIRMED, chain ok), T-E2E-03 (MISMATCH stored with `anomaly: true`, detail names `amount`, first CONFIRMED kept) and T-E2E-05 (agent token → 401, entry count unchanged) all pass.
- §3 After `npm run demo:local`, `GET /v1/ledger/verify` → `{"entries":72,"ok":true}`. One line of `.local/ledger-local.jsonl` was altered; `l2:control` exited 1 with `integrity: ledger .local/ledger-local.jsonl broken at line 36`. The file was restored byte-for-byte from a copy.
