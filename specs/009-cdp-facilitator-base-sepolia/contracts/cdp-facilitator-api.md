# Contract: Seller → CDP x402 facilitator (outbound)

Third-party interface. This records what the seller relies on, verified against cdp-sdk
1.59.0 and CDP docs on 2026-10-17. The offline stub in `test/helpers/cdp-stub.ts` implements
exactly this contract.

## Endpoint

Base URL: `https://api.cdp.coinbase.com/platform/v2/x402`. Protocol: x402 v2 facilitator,
the same bodies as CP-2 (`specs/006-counterparty-seller-network/contracts/facilitator-api.md`).

| Operation | Method and path | Request body | 2xx body |
|---|---|---|---|
| supported | `GET /supported` | none | `{kinds:[{x402Version, scheme, network, extra?}], extensions:[], signers:{}}` |
| verify | `POST /verify` | `{x402Version, paymentPayload, paymentRequirements}` | `{isValid, invalidReason?, invalidMessage?, payer?}` |
| settle | `POST /settle` | `{x402Version, paymentPayload, paymentRequirements}` | `{success, errorReason?, errorMessage?, payer?, transaction, network, amount?}` |

Required capability (FR-015): `kinds` includes `{x402Version: 2, scheme: "exact", network: "eip155:84532"}`.

## Authentication (every request)

```text
Authorization: Bearer <JWT>
Content-Type: application/json
```

| JWT part | Value |
|---|---|
| header | `{alg: "EdDSA" (Ed25519 key) \| "ES256" (EC key), kid: <apiKeyId>, typ: "JWT", nonce: <random hex>}` |
| `sub` | `<apiKeyId>` |
| `iss` | `"cdp"` |
| `iat`, `nbf` | now (s) |
| `exp` | now + 120 s |
| `uris` | `["<METHOD> api.cdp.coinbase.com/platform/v2/x402/<op>"]` — one per request, bound to that method and path |

Each request gets a fresh JWT, so a JWT is never reused across operations or after expiry. A
JWT is not a secret at rest, but it is never logged.

## Non-2xx responses the seller must categorize (research R4)

| Status | Meaning | Category |
|---|---|---|
| 400 with `{isValid:false,…}` (verify) | invalid payment | verification-rejected (SDK 402) |
| 400 with `{success:false,…}` (settle) | settle failed | settlement-failed (SDK 402) |
| 401, 403 | bad, revoked or expired credential; clock skew | authentication |
| 402, 429 | quota, billing or rate limit (`Retry-After` honoured for `/supported`) | rate-limited |
| 5xx, timeout, network error | CDP unavailable | unavailable |

Compliance (OFAC/KYT) declines come back as a verify or settle failure with a facilitator
reason. The seller passes the reason through unchanged (FR-018).

## Pending settlements

A `settle` result with `errorReason: "settlement_pending"` and a broadcast `transaction` is
retried once by the SDK (`settleWithPendingRetry`). If it is still pending, it reaches the buyer
as a settlement-failed 402 whose `PAYMENT-RESPONSE` carries the hash, and L3 tracks the hash
on-chain (FR-020).

## Offline stub (test-only)

`test/helpers/cdp-stub.ts` serves the three endpoints on loopback.

- It verifies every request's JWT with `node:crypto` against a per-test Ed25519 public key. It checks `alg`, `kid`, `iss`, the `exp` window and that `uris[0]` equals `"<METHOD> <stub host><path>"`. It returns 401 otherwise.
- It advertises `exact` on `eip155:31337` and delegates `verify` and `settle` to `createFacilitatorApp` (CP-2) on ganache, so offline tests settle for real.
- Failure modes are scriptable per test: `401`, `429`, `500`, `hang` (beyond the timeout), `unsupported` (no matching kind), `decline` (`isValid:false, invalidReason:"compliance_declined"`), and `pending` (settle on-chain, then answer `success:false, errorReason:"settlement_pending", transaction:<real hash>`).
- It counts requests per endpoint, for the no-fallback assertion.
