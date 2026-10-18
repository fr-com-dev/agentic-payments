# Data Model: CDP Facilitator on Base Sepolia

**Feature**: [spec.md](spec.md) | **Research**: [research.md](research.md)

This feature adds no ledger entry type, no field in `src/shared/contracts.ts` and no persisted
state. The entities below are in-process values and wire interpretations.

## FacilitatorChoice (seller, in-process)

The resolved facilitator for one seller process. It is computed once at startup by
`facilitatorChoice(net, env)` in `src/shared/config.ts` and never changes for the life of the
process (FR-005).

| Field | Type | Rule |
|---|---|---|
| `kind` | `"local" \| "public" \| "cdp"` | From `FACILITATOR`, defaulting by network (research R3) |
| `url` | string | `local`: `FACILITATOR_URL` or `http://127.0.0.1:4022`. `public`: `FACILITATOR_URL` or `https://x402.org/facilitator`. `cdp`: always `https://api.cdp.coinbase.com/platform/v2/x402` |
| `timeoutMs` | number | `local`: SDK default (90000). `public` and `cdp`: 30000 (R7) |
| `authenticated` | boolean | `true` only for `cdp` |

Validity: see the resolution table in research R3. Every invalid combination throws
`ConfigError`, and the seller exits 1 before listening.

## CdpCredential (seller, in-process only)

| Field | Type | Rule |
|---|---|---|
| `apiKeyId` | string | Non-empty. Not secret. Logged only as `…<last 4>` |
| `apiKeySecret` | string | Non-empty. Either a base64 Ed25519 key that decodes to 64 bytes, or a PEM EC (P-256) private key in PKCS#8 or SEC1 form. `normalizeCdpSecret` trims it, expands literal `\n`, and converts SEC1 to PKCS#8 (`generateJwt`/`jose` accept only PKCS#8). The normalized value must sign one JWT locally at startup. The raw and normalized values are **never** logged, serialized, returned or copied into another environment |

Lifecycle: it is read from `process.env` only inside `src/counterparty/cdp-facilitator.ts`,
and only when `FacilitatorChoice.kind === "cdp"`. It is captured in a closure that produces
auth headers, and dies with the process. No other module receives either field (rule A8).

## Auth headers (outbound, per request)

`createAuthHeaders()` returns a fresh set on every facilitator call. The SDK calls it once per
request.

| Path key | Method | `Authorization` | JWT `uris` claim |
|---|---|---|---|
| `supported` | GET | `Bearer <jwt>` | `GET api.cdp.coinbase.com/platform/v2/x402/supported` |
| `verify` | POST | `Bearer <jwt>` | `POST api.cdp.coinbase.com/platform/v2/x402/verify` |
| `settle` | POST | `Bearer <jwt>` | `POST api.cdp.coinbase.com/platform/v2/x402/settle` |

JWT: header `{alg: EdDSA|ES256, kid: apiKeyId, typ: "JWT", nonce}`. Claims
`{sub: apiKeyId, iss: "cdp", nbf, iat, exp: iat+120, uris: [...]}`. Built by `generateJwt`
(`@coinbase/cdp-sdk/auth`). See [contracts/cdp-facilitator-api.md](contracts/cdp-facilitator-api.md).

## FacilitatorFailureCategory

| Category | Raised when (research R4) | Before challenge | During paid retry |
|---|---|---|---|
| `unavailable` | timeout, network error, 5xx, malformed body | 503 | 502 |
| `authentication` | 401 or 403 | 503 | 502 |
| `rate-limited` | 429, or 402 (quota/billing) | 503 | 502 |
| `unsupported` | `exact` on the route's network is not in `/supported` | 503 | n/a (no challenge was issued) |
| `verification-rejected` | `isValid: false` or `VerifyError` | n/a | SDK 402 with the facilitator's `invalidReason` |
| `settlement-failed` | `success: false` or `SettleError`, including `settlement_pending` | n/a | SDK 402 with a `PAYMENT-RESPONSE` that carries `errorReason` and `transaction` when present |

The first four are produced by `CategorizedFacilitatorClient` as a
`FacilitatorUnavailableError` (with a `category` field, extending
`FacilitatorResponseError`). The last two are the SDK's own x402 rejections, passed through
unchanged. Response bodies are in [contracts/seller-errors.md](contracts/seller-errors.md).

## Settlement result (`PAYMENT-RESPONSE`): reinterpretation only

The fields are unchanged (§10): `{success, transaction, network, payer, errorReason?}`.

| Decoded result | Before (L3-1 v1.1) | After (FR-020) |
|---|---|---|
| `success: true`, `transaction` is a hash | verify on-chain | verify on-chain (unchanged) |
| `success: false`, `transaction` is a hash | `NOT_SETTLED` | **verify on-chain** (network check, receipt, Transfer match, finality) |
| `success: false`, `transaction` empty or not a hash | `NOT_SETTLED` | `NOT_SETTLED` (unchanged) |
| header absent or undecodable | `NOT_SETTLED` | `NOT_SETTLED` (unchanged) |

"A hash" means `/^0x[0-9a-fA-F]{64}$/`. Full decision table:
[contracts/l3-verify-amendment.md](contracts/l3-verify-amendment.md).

## State transitions

Seller sync state. It extends CP-1's lazy sync and is not persisted.

```text
UNSYNCED --priced request--> SYNCING --ok--> SYNCED
SYNCING --error(category)--> UNSYNCED   (that request gets 503 {category}; the next request retries)
SYNCED  --verify/settle error(category)--> SYNCED   (that request gets 502 {category}; no re-sync)
```

There is no transition to a different `FacilitatorChoice` (FR-005).

The settlement status lifecycle in L2 and L3 is unchanged. FR-020 only lets a
`success: false` claim that carries a hash reach `PENDING` or `CONFIRMED` through the existing
L3 path, instead of stopping at `NOT_SETTLED`.
