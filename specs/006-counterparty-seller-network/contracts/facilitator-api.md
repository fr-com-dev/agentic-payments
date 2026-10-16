# Contract: Local facilitator API (CP-2)

## Code split (INV-2 unchanged)

| File | Role | Key handling |
|---|---|---|
| `src/counterparty/facilitator.ts` | `createFacilitatorApp({ account: LocalAccount, rpcUrl, caip2 }): express.Express`. Registers the routes below; does not call `listen`. | None. Never imports `privateKeyToAccount`/`mnemonicToAccount`, never reads `FACILITATOR_PRIVATE_KEY`. |
| `scripts/facilitator.ts` | Process entry (`npm run facilitator`). `loadEnv()`, local-only guard, then `listen(FACILITATOR_PORT)`. | `privateKeyToAccount(FACILITATOR_PRIVATE_KEY)`, after the guard. |

## Process rules

- It runs only when `NETWORK=local`. Otherwise `scripts/facilitator.ts` prints a "local only"
  error and exits non-zero at startup, before reading any key.
- Its port is `FACILITATOR_PORT`, default 4022.
- Its environment comes from `env/facilitator.env` via `loadEnv()`: `NETWORK=local` and
  `FACILITATOR_PRIVATE_KEY` (account #1). In the local demo, 008 hands the key, derived by
  `localDevKeys()` in `scripts/local-chain-lib.ts`, to this child only.
- On Base Sepolia, the seller uses the hosted `https://x402.org/facilitator` (CP-3) instead,
  with the same API.

## Endpoints

| Method & path | Request body | 200 response | Error |
|---|---|---|---|
| `GET /supported` | — | `{kinds:[{x402Version:2, scheme:"exact", network:"eip155:31337"}], …}` | — |
| `POST /verify` | `{x402Version, paymentPayload, paymentRequirements}` | `{isValid, invalidReason?, payer?}` | 400, x402-shaped error body |
| `POST /settle` | `{x402Version, paymentPayload, paymentRequirements}` | `{success, transaction, network, payer, errorReason?}` | 400, x402-shaped error body |

Rules:
- Settlement submits `transferWithAuthorization` from account #1, which pays gas. It waits for
  the receipt for up to `confirmationTimeoutMs: 30000`.
- Every thrown exception becomes a 400, never a 500. The body uses the matching response
  shape with `isValid:false` and `invalidReason`, or `success:false` and `errorReason`.
- The facilitator never holds the payer key.
