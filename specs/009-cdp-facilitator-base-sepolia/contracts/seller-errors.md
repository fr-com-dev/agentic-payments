# Contract: Seller responses on facilitator failure (CP-1 — amended)

These apply to priced routes only. `GET /api/catalog` always answers 200, whatever the
facilitator's state.

## Before a challenge (lazy sync failed)

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{"error":"facilitator <category>","category":"<category>"}
```

`<category>` ∈ `unavailable | authentication | rate-limited | unsupported`.

- No `PAYMENT-REQUIRED` header is sent, so L1 sees a non-402 status and builds no `PaymentIntent` (L1-1 step 2). L2 signs nothing (SC-003).
- The v1.1 body `{"error":"facilitator unavailable","detail":…}` is replaced. `detail` is removed because it could echo upstream text. `test/counterparty.test.ts` assertions on that body are updated.
- The next priced request retries the sync. There is no back-off state and no restart (SC-009).

## During a paid retry (`PAYMENT-SIGNATURE` present)

| Case | Status | Headers | Body | Resource served |
|---|---|---|---|---|
| unavailable, authentication or rate-limited during verify or settle | 502 | none | `{"error":"facilitator <category>"}` | no |
| verification rejected (including a compliance decline) | 402 | `PAYMENT-REQUIRED` (SDK) | SDK x402 rejection with the facilitator's `invalidReason` | no |
| settlement failed (including `settlement_pending` after the SDK's single retry) | 402 | `PAYMENT-RESPONSE` `{success:false, errorReason, transaction?, network, payer?}` (SDK) | SDK settlement-failure body | no |
| success | 200 | `PAYMENT-RESPONSE` `{success:true, transaction, network, payer}` | resource | yes |

The 402 and 200 rows are unchanged SDK behavior (FR-013). Only the 502 body text is new: the
SDK writes `error.message`, and `FacilitatorUnavailableError` sets it to `facilitator <category>`.

## Seller log lines (stderr, one per failure)

```text
seller: facilitator <category> during <supported|verify|settle>: <redacted excerpt ≤ 200 chars>
seller: facilitator authentication — check CDP_API_KEY_ID/SECRET and the host clock (JWTs expire in 120 s)
```

The second line is logged only for `authentication` when `kind=cdp`, and the CDP variable
names in it are part of `cdp-facilitator.ts` (rule A8). All excerpts pass through `redact()`
(research R8).

## Buyer-side outcomes (unchanged rules, listed for test expectations)

| Seller response | L1 outcome | L3 status | L2 budget |
|---|---|---|---|
| 503 before challenge | `FREE`, `httpStatus: 503` (no payment attempted) | none | unchanged |
| 502 during paid retry | `PAYMENT_FAILED` | `NOT_SETTLED` | committed until `validBefore` (SEC-9) |
| 402 verification rejected | `PAYMENT_FAILED` | `NOT_SETTLED` | committed until `validBefore` |
| 402 settlement failed, with a hash | `PAYMENT_FAILED` | on-chain result: `PENDING`/`CONFIRMED`/`NOT_SETTLED`/`MISMATCH` (FR-020) | per that status |
| 402 settlement failed, without a hash | `PAYMENT_FAILED` | `NOT_SETTLED` | committed until `validBefore` |
