# Research: CDP Facilitator on Base Sepolia

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-17

Sources:

- The pinned SDK in `node_modules/@x402/core` 2.28.0 and `@x402/express` 2.28.0.
- The published `@coinbase/cdp-sdk@1.59.0` tarball. Its type definitions and ESM sources were read; it was not installed.
- CDP docs as of 2026-10-17: network support, facilitator, production configuration and the `createCdpFacilitatorClient` reference.

## R1. How the seller authenticates to CDP

**Decision**: Keep the pinned `HTTPFacilitatorClient` from `@x402/core/server` 2.28.0. Construct it with:

- `url`: the CDP base URL.
- `timeoutMs`: 30000.
- `createAuthHeaders`: returns per-path CDP JWTs built with `generateJwt` from `@coinbase/cdp-sdk/auth`.

Add `@coinbase/cdp-sdk` as an exact-pinned dependency (`1.59.0`) and import only its `./auth` subpath.

**Rationale**:

- `HTTPFacilitatorClient` 2.28.0 already accepts `createAuthHeaders`, which returns headers keyed by path (`verify`, `settle`, `supported`), and `timeoutMs`. The x402 surface stays on the version the constitution pins.
- `generateJwt` is CDP's canonical JWT builder. It supports base64 Ed25519 and PKCS#8 PEM EC keys, uses a 120 s expiry, and binds the `uris` claim to `"<METHOD> <host><path>"`. Using it means we don't own CDP's auth format.
- Caveat: `generateJwt` detects EC keys with `jose`'s `importPKCS8`, which only accepts `-----BEGIN PRIVATE KEY-----`. CDP also issues SEC1 keys (`-----BEGIN EC PRIVATE KEY-----`, the format in cdp-sdk's own doc comment), and those would be rejected. `normalizeCdpSecret` converts SEC1 to PKCS#8 with `node:crypto` before calling `generateJwt`, and T014 tests both forms. This is key *format* handling only; the JWT itself is still built by `generateJwt`.
- The `./auth` subpath imports only `jose`, `uncrypto` and an axios hook module. Its import graph has no x402 or Solana code.
- The header shape mirrors `createCdpFacilitatorClient` in cdp-sdk 1.59.0 (`_esm/x402/facilitator.js`). It sends `Authorization: Bearer <jwt>` per path, with `GET` for `supported` and `POST` for `verify` and `settle`.

**Alternatives considered**:

| Option | Why rejected |
|---|---|
| `createCdpFacilitatorClient` from `@coinbase/cdp-sdk/x402` | The `./x402` barrel statically imports `server-extensions.js`, which imports `@x402/svm/exact/server` and `@x402/svm/upto/server`. `@x402/svm` is an *optional* peer that npm does not install, so loading the module would fail. The function also gives no way to set `timeoutMs`, so FR-017 could not be met. |
| `createX402Server` (CDP SDK) | It replaces our route config with "$" prices, provisions CDP wallets, and needs `CDP_WALLET_SECRET` unless `payToConfig` is set. That conflicts with CP-1's explicit `AssetAmount` options and goes beyond facilitator-only scope. |
| `@coinbase/x402` 2.1.0 | Last published 2025-12. It pins an older cdp-sdk and `@x402/core ^2.0.0`. Superseded by the CDP SDK's own x402 module. |
| Hand-rolled JWT (`node:crypto`/`jose`) | No new dependency, but we would own CDP's claim set, header nonce and key parsing, and drift would surface only as live 401s. |

## R2. CDP endpoint

**Decision**: Use the base URL `https://api.cdp.coinbase.com/platform/v2/x402`, which is `CDP_FACILITATOR_URL` in cdp-sdk 1.59.0. The paths are `/verify` (POST), `/settle` (POST) and `/supported` (GET). The constant lives in `src/shared/config.ts`, because it is not a secret. Only the test factory parameter can override it (R3), never configuration (FR-004).

**Rationale**: Importing the constant from `@coinbase/cdp-sdk/x402` would load the barrel described in R1. The JWT host and path are derived from the same URL, so the URL cannot drift from the claims.

## R3. Configuration and selection

**Decision**:

| Setting (seller only) | Values | Default |
|---|---|---|
| `FACILITATOR` | `local` \| `public` \| `cdp` | `local` on `local`; `cdp` on `base-sepolia` |
| `FACILITATOR_URL` | URL | unchanged: `local` → `http://127.0.0.1:4022`; `public` → `https://x402.org/facilitator` |
| `CDP_API_KEY_ID` | string | none |
| `CDP_API_KEY_SECRET` | base64 Ed25519, or PEM EC as PKCS#8 or SEC1 (quoted; real newlines or literal `\n`) | none |

Resolution is a pure function in `src/shared/config.ts`, `facilitatorChoice(net, env)`. It returns `{ kind, url, timeoutMs }` or throws `ConfigError`. It never reads either CDP variable (rule A8, R9).

| Network | `FACILITATOR` | `FACILITATOR_URL` set | Result |
|---|---|---|---|
| local | unset or `local` | any | local, URL override or `:4022` |
| local | `public` or `cdp` | any | ConfigError (FR-003) |
| base-sepolia | unset or `cdp` | no | cdp, CDP URL, 30 s |
| base-sepolia | unset or `cdp` | yes | ConfigError: conflict (FR-004) |
| base-sepolia | `public` | any | public, override or x402.org, 30 s |
| base-sepolia | `local` | any | ConfigError (the local facilitator refuses non-local, CP-2) |
| any | other value | any | ConfigError (unknown choice) |

The CDP credential is read only in `src/counterparty/cdp-facilitator.ts`, and only when `kind === "cdp"`. At startup it checks that the key ID and secret are present and non-empty. It then signs one JWT locally, with no network call, to prove the secret parses. Any failure exits with code 1. The message names the variable and never echoes a value; the CDP error text is not forwarded, because R8 redaction is defence in depth. If `kind !== "cdp"` and a CDP variable is set, the seller logs `CDP credentials set but unused (FACILITATOR=<kind>)` (spec edge case).

**Rationale**: This mirrors CFG-2's fail-closed token rule. Making CDP the default on `base-sepolia` is the spec's FR-002 decision.

## R4. Categorizing facilitator failures

How the SDK behaves (`@x402/core` 2.28.0, `@x402/express` 2.28.0):

- `getSupported()` throws `Error("Facilitator getSupported failed (<status>): …")` on non-2xx. It retries 429 up to 3 times, honouring `Retry-After`, capped at 30 s.
- `x402ResourceServer.initialize()` wraps the last error as `Error("Failed to initialize…", { cause })`.
- A timeout throws `FacilitatorTimeoutError`, a subclass of `FacilitatorResponseError`. A malformed body throws `FacilitatorResponseError`. Network failures surface as a `TypeError` from fetch.
- If CDP does not list `exact` on the route's network, `x402HTTPResourceServer.initialize()` throws `RouteConfigurationError`.
- During a request, the express middleware answers 502 `{ error: message }` for `FacilitatorResponseError` and 500 for any other thrown error.
- A `VerifyError` or `isValid: false` becomes the SDK's 402 rejection. A settle failure (`SettleError` or `success: false`) becomes the SDK's 402 settlement-failure response, with a `PAYMENT-RESPONSE` that carries `transaction`.

**Decision**: Wrap the client in a decorator, `CategorizedFacilitatorClient`, that implements `FacilitatorClient` around the inner client. On any thrown error from `getSupported`, `verify` or `settle`, it rethrows `FacilitatorUnavailableError extends FacilitatorResponseError`, which has a `category` field and the message `facilitator <category>`. `VerifyError`, `SettleError` and well-formed `isValid: false` / `success: false` results pass through untouched, so the SDK's x402 rejections stay byte-identical (FR-013).

| Thrown error | Category |
|---|---|
| `FacilitatorTimeoutError`; fetch `TypeError`; `ECONNREFUSED`/`ENOTFOUND` in the cause chain; status 5xx | `unavailable` |
| status 401 or 403 | `authentication` |
| status 429, or 402 from CDP (billing/quota) | `rate-limited` |
| `RouteConfigurationError` at init | `unsupported` |
| `FacilitatorResponseError` (malformed body) | `unavailable` |

The status comes from the SDK's message pattern `failed \((\d{3})\)`. That format is fixed by the exact pin, and T-CDP-04 asserts each category against a stub. An SDK upgrade that changes the message makes that test fail.

| Phase | Seller response |
|---|---|
| Before a challenge (sync) | 503 `{ error: "facilitator <category>", category }` from the seller's lazy-sync wrapper. This extends today's `facilitator unavailable` body; the `detail` field is removed because it could carry upstream text. |
| During a paid retry | The SDK's 502 `{ error: "facilitator <category>" }`, because the decorator throws a `FacilitatorResponseError`. The resource is not served. |

The authentication category's log line adds: `check CDP_API_KEY_ID/SECRET and the host clock (JWTs expire in 120 s)`.

**Alternatives considered**: Inject a custom `fetch` to read status codes directly. Rejected: `HTTPFacilitatorClient` 2.28.0 has no fetch injection, and patching `globalThis.fetch` would affect the whole process.

## R5. Settlements that are broadcast but not confirmed

**Finding**: `x402ResourceServer.settleWithPendingRetry` in 2.28.0 treats `errorReason: "settlement_pending"` with a broadcast transaction hash as non-terminal and retries exactly once. If the result is still pending, the seller returns the settlement-failure 402 with `PAYMENT-RESPONSE { success: false, errorReason: "settlement_pending", transaction: <hash> }`. FR-019's pass-through is therefore SDK behavior, and we do not change it.

**Decision**: Do not alter the seller. Close the gap in L3 instead (R6).

## R6. L3 checks a failed result that carries a transaction (FR-020)

**Decision**: Amend L3-1 step 2. When decoding succeeds, `success === false` and `transaction` is a 32-byte hex hash, continue to steps 3–6: the network check, receipt wait, Transfer match and finality. Only `success === false` without a hash gives `NOT_SETTLED`. The decision table is in [contracts/l3-verify-amendment.md](contracts/l3-verify-amendment.md).

Effects:

- L1-1 step 8 is unchanged. A non-2xx paid retry is `PAYMENT_FAILED` and keeps `payment` and `authorizationId`.
- L2 reconcile is unchanged. A CONFIRMED report counts toward the budget, and a later contradiction is an anomaly (INV-11).
- `SettlementReport.status` gains no new value, and `contracts.ts` is unchanged.

**Proof (Principle VIII)**: In T-CDP-06, a stub reports `settlement_pending` with the hash of a transfer that really settled on ganache. With the amendment, L3 reports CONFIRMED and the budget counts it. Without it, L3 reports NOT_SETTLED. The test records both outcomes, as T-E2E-04 does.

**Residual risk** (spec edge case): a settle that times out without any hash stays indeterminate for every facilitator. A nonce-based check (`authorizationState(payer, nonce)`) would need L2 to record the EIP-3009 nonce, which is a contract change. It is recorded in SPEC §11 as a follow-up and is not implemented here.

## R7. Facilitator timeout

**Decision**: `timeoutMs = 30000` for `public` and `cdp`. The local choice keeps the SDK default (90 s), so the local baseline stays byte-identical (FR-017, NFR-003). The value is a constant in `facilitatorChoice`. It is not configurable, because no requirement asks for that.

## R8. Keeping the secret out of output

**Decision**:

- The secret is held in one closure in `cdp-facilitator.ts`. It is never put on an object that is logged or serialized, and never copied into `process.env` mutations.
- Every string the seller writes from facilitator errors (logs and 503/502 bodies) goes through `redact(text)`. It replaces any occurrence of the secret and of each of its PEM body lines with `[redacted]`. The 503/502 bodies already carry only the category (R4), so redaction is defence in depth.
- The startup log prints `facilitator=cdp host=api.cdp.coinbase.com key=…<last 4 of key ID>`.
- SC-004 is enforced by T-CDP-07. A recognizable fake Ed25519 secret is generated per test, and the test scans captured stdout/stderr, every HTTP response body and header, the ledger file and `.local/` for its base64 text.
- Principle VIII needs a test that fails without the redactor, but the scan above would pass even without it, because no secret normally reaches output. T-CDP-07 therefore also feeds a facilitator error that echoes the secret through the seller's logging path. With the redactor, stderr shows `[redacted]`. With the identity function, stderr contains the secret, so the test fails without the mechanism.
- The live run (`demo:base-sepolia`) scans its own buffered output and the Base Sepolia ledger with `containsCdpSecret` (R10), which covers SC-004's live part.

## R9. Credential isolation checks

**Decision**:

- **New architecture rule A8** (Principle V; proposed SEC-10). Scope: `src/**`, `scripts/**` and `env/*.env.example`. `test/**` is out of scope, because tests must set the variables. Violation: the identifiers or strings `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, or an import of `@coinbase/cdp-sdk` outside `src/counterparty/cdp-facilitator.ts` and `env/seller.env.example`. The fixture `test/fixtures/arch/a8-violation.ts` must trip it.
- **T-ARCH-ENV is extended**. Only `seller.env.example` may declare `FACILITATOR`, `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`, and the secret must be empty.
- **Demo and harness children (SC-005)**. `demo-local.ts` already passes only `PATH`, `HOME`, `NODE_*` and `ENV_FILE` to children, so nothing changes. T-CDP-08 asserts it by spawning the demo's `childEnv` for every role, with CDP variables in the parent environment.
- **No fallback (FR-005)**. T-CDP-08 runs CDP→stub-down next to a counting public stub and asserts that the public stub receives 0 requests.

## R10. Live acceptance run (FR-023, SC-001, SC-002)

**Decision**: Add `scripts/demo-base-sepolia.ts`, run as `npm run demo:base-sepolia`. It is not part of `npm test` or `npm run check`. The script:

1. Refuses to run (exit 2) unless the env files meet two conditions:
   - `env/seller.base-sepolia.env` resolves to `FACILITATOR` cdp with its key ID and secret present. The script checks this with `cdpCredentialStatus(values)`, exported by `cdp-facilitator.ts`, which returns presence booleans only. The script therefore never names the CDP variables (A8) and never prints their values.
   - The layout is pinned: `SELLER_URL=http://127.0.0.1:<port>`, `ALLOWED_HOSTS` exactly `127.0.0.1:<port>`, and `ALLOWED_PAYEES` includes `SELLER_PAY_TO`. Step 6 of the scripted plan depends on the `localhost` alias being DENIED.
2. Spawns the seller, L2 and L3 with `ENV_FILE=env/<role>.base-sepolia.env`, the user's existing naming. No chain or local facilitator is started. All process output is also buffered in memory.
3. Reads the payee's USDC balance at head before and after the run with a read-only public client, so it never reads historical state, which public RPCs may prune. Runs the scripted agent and collects each PAID line's `tx=` and `settlement=`.
4. The scripted output carries no payer field. The payer is the `from` of the USDC `Transfer` log (to the payee) in the first PAID receipt. `payer gas spent` is Σ `gasUsed × effectiveGasPrice` over the settlement receipts whose `from` is the payer. Expected 0, because CDP submits the transactions.
5. Scans the buffered output and `.local/ledger-base-sepolia.jsonl` with `containsCdpSecret(sellerValues, text)`, which returns a boolean only (SC-004, live part).
6. Prints the local demo's `printSummary` lines unchanged, plus three extra lines before the closing rule: `settlements:`, `payer gas spent:` and `secret scan:`. It exits 0 only when `matchesBaseline` holds (outcomes, delta 6000, chain ok, `spentOrReserved` 6000), two settlements are CONFIRMED, gas is 0 and the scan is clean.

It reuses process management from `demo-local.ts` by extracting the shared helpers into `scripts/demo-lib.ts`. That is a refactor, and the local demo output stays byte-identical. The ledger is the existing per-network file `.local/ledger-base-sepolia.jsonl`.

**Cost**: 2 settlements per run, within CDP's 1,000 free settlements a month (NFR-005).

## R11. Governance amendments in the same change

| Document | Change | Version |
|---|---|---|
| SPEC.md | §1.2 adds the CDP facilitator. §3.3 adds a credential matrix row: `CDP_API_KEY_ID/SECRET`, Seller only. §4.1 adds A8. §5 adds `@coinbase/cdp-sdk` 1.59.0 (seller, `./auth` only). CP-1 gets the failure categories. CP-3 is rewritten. CFG-1 changes the facilitator row. CFG-2 changes the `seller.env` row. L3-1 step 2 is amended. §11 adds SEC-10 and SEC-11 and the residual risks (CDP metadata visibility; timeout without a hash). §12 adds T-CDP-01..09, T-ARCH-A8 and T-E2E-06 (manual). §13 adds `demo:base-sepolia`. §16 adds the 120 s JWT clock-skew gotcha. Plus a "Changes in 1.2" table. | 1.1 → 1.2 |
| Constitution | Technology & Scope: the stack adds the CDP SDK (auth only, seller only), and the residual risks add facilitator metadata visibility. Principle V: "third-party API credentials are held by exactly one process". Sync Impact Report. | 1.0.0 → 1.1.0 (MINOR) |
| CLAUDE.md | Hard rule 2 now reads: "only `signer.ts` touches *payment* key material; the seller's CDP API credential is an auth credential confined to `src/counterparty/cdp-facilitator.ts` (A8)". Commands add `demo:base-sepolia`. | n/a |
| README.md | The Base Sepolia section covers CDP key setup, `FACILITATOR`, the public opt-out and the live run. | n/a |
| `env/seller.env.example` | Adds `FACILITATOR`, plus `CDP_API_KEY_ID=` and `CDP_API_KEY_SECRET=` (empty, `# set me`). | n/a |
| `specs/README.md` | Adds the 009 traceability rows for the new IDs. | n/a |
