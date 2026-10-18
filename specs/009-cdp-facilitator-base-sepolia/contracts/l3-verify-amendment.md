# Contract: L3-1 step 2 amendment (FR-020)

Owner of L3-1: feature 005. This feature amends one step. L3 stays read-only (INV-4) and
gains no credential.

## SPEC L3-1, step 2 (v1.1 → v1.2)

v1.1:

> 2. No `PAYMENT-RESPONSE` → `NOT_SETTLED`. If decoding fails → `NOT_SETTLED`. If `!success` or there is no `transaction` → `NOT_SETTLED`.

v1.2:

> 2. No `PAYMENT-RESPONSE` → `NOT_SETTLED`. If decoding fails → `NOT_SETTLED`. If `transaction` is not a 32-byte hex hash → `NOT_SETTLED`. Otherwise continue with step 3, **whether `success` is true or false**: a facilitator's failure claim is not proof that nothing settled (INV-10). When `!success`, the report's `detail` starts with `facilitator reported failure (<errorReason>); ` before the step 3–6 outcome.

## Decision table

| `PAYMENT-RESPONSE` | `transaction` | Network matches | Receipt | Transfer matches | Status |
|---|---|---|---|---|---|
| absent or undecodable | — | — | — | — | `NOT_SETTLED` |
| any `success` | missing, empty or not `0x`+64 hex | — | — | — | `NOT_SETTLED` |
| any `success` | hash | no | — | — | `MISMATCH` |
| any `success` | hash | yes | timeout or RPC error | — | `PENDING` (L3-2 re-checks) |
| any `success` | hash | yes | status ≠ success | — | `NOT_SETTLED` |
| any `success` | hash | yes | success | no | `MISMATCH` |
| any `success` | hash | yes | success | yes | `CONFIRMED` or `PENDING` by finality class |

Rows where `success` is `true` behave exactly as in v1.1.

## Tests

- **T-CDP-06 (must-fail proof)**: the stub's `pending` mode settles on ganache, then reports `success:false, errorReason:"settlement_pending"` with the real hash. With the amendment: L3 reports `CONFIRMED`, L2's effective status is `CONFIRMED`, and `spentOrReserved` includes the amount. Without it, L3 reports `NOT_SETTLED`. The test title records "fails without FR-020", and the v1.1 behavior is checked by calling the verifier with the amendment disabled through a test-only option, `verifyFailedClaims: false`.
- **verifier.test.ts unit rows**: `success:false` with no hash → `NOT_SETTLED`. `success:false` with a hash whose receipt failed → `NOT_SETTLED`. `success:false` with a hash whose Transfer mismatches → `MISMATCH`. `success:false` with a hash on the wrong network → `MISMATCH`.

## Compatibility

- `SettlementClaim`, `SettlementReport` and `SettlementStatus` are unchanged, so `contracts.ts` is unchanged.
- T-E2E-03 (a forged `PAYMENT-RESPONSE` gives `MISMATCH`) still holds. A forged failure claim with a real but unrelated hash gives `MISMATCH` through the Transfer match.
- Two reports for one `authorizationId`: CONFIRMED stays final, and a contradiction is an anomaly (INV-11, T-LED-03).
