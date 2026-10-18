---

description: "Task list for 009-cdp-facilitator-base-sepolia"
---

# Tasks: CDP Facilitator on Base Sepolia

**Input**: Design documents from `specs/009-cdp-facilitator-base-sepolia/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R11), data-model.md, contracts/ (seller-config, cdp-facilitator-api, seller-errors, l3-verify-amendment, architecture-rule-a8), quickstart.md

**Tests**: REQUESTED. Spec FR-021 and FR-022 and constitution Principle VIII require them. In every story phase, test tasks come before implementation and must fail first. Must-fail proofs: T-CDP-06, T-ARCH-A8 and T-CDP-08.

**Organization**: Tasks are grouped by user story (US1–US4 from spec.md), so each story can be implemented and tested on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label (US1–US4), on story-phase tasks only

## Path Conventions

Single project at the repository root (SPEC.md §6). New test files are split by story, so story phases can run in parallel:

| File | Holds |
|---|---|
| `test/cdp-config.test.ts` | T-CDP-01, US4 public-path checks |
| `test/cdp-auth.test.ts` | JWT units, T-CDP-03 |
| `test/cdp-isolation.test.ts` | T-CDP-02, T-CDP-07, T-CDP-08 |
| `test/cdp-failures.test.ts` | T-CDP-04, 05, 06, 09 |

Every test title starts with its ID (T-ARCH-TRACE). vitest runs files serially (`fileParallelism: false`), so the harness's ganache port 8545 never collides.

Ownership: this feature amends files owned by other features, and records each amendment in their docs (T036):

| Feature | Files |
|---|---|
| 006 | `seller.ts`, `config.ts` network section |
| 005 | `verifier.ts` |
| 007 | `architecture.test.ts`, `env/*.env.example`, `threat-matrix.md` |
| 008 | `demo-local.ts`, npm scripts |

**A8 (new)**: outside `src/counterparty/cdp-facilitator.ts` and `env/seller.env.example`, no file under `src/**` or `scripts/**`, and no env template, may contain `CDP_API_KEY_ID` or `CDP_API_KEY_SECRET` or import `@coinbase/cdp-sdk`. `test/**` is exempt.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Governance amendments in the same change (research R11), the new dependency and the seller template.

- [X] T001 Amend SPEC.md to v1.2 per research R11:
  - Add a "Changes in 1.2" table after "Changes in 1.1".
  - §1.2: in scope gains "CDP hosted facilitator on base-sepolia".
  - §3.3: new credential-matrix row `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`, Seller only (`FACILITATOR=cdp`), copied from specs/009-cdp-facilitator-base-sepolia/contracts/architecture-rule-a8.md.
  - §4.1: A8 row.
  - §5: add `@coinbase/cdp-sdk` 1.59.0 to the stack table, and `generateJwt` from `@coinbase/cdp-sdk/auth` (seller) to the SDK entry-point table.
  - CP-1: the failure categories and the 503/502 bodies from contracts/seller-errors.md.
  - CP-3: rewrite per contracts/seller-config.md.
  - CFG-1: facilitator row becomes `local`: `FACILITATOR_URL` or `http://127.0.0.1:4022`; `base-sepolia`: `FACILITATOR=cdp` (default) → `https://api.cdp.coinbase.com/platform/v2/x402`, or `FACILITATOR=public` → `FACILITATOR_URL` or `https://x402.org/facilitator`.
  - CFG-2: `seller.env` row becomes `NETWORK, SELLER_PAY_TO, FACILITATOR?, FACILITATOR_URL?, CDP_API_KEY_ID?, CDP_API_KEY_SECRET?`.
  - L3-1 step 2: replace with the v1.2 text in contracts/l3-verify-amendment.md, verbatim.
  - §11: SEC-10 and SEC-11 rows. Residual risks gain "CDP sees payer, payee, amount, asset, resource URL and description" and "a settle that times out with no transaction hash is indeterminate; follow-up: EIP-3009 nonce check".
  - §12: T-CDP-01..09 and T-ARCH-A8 rows, plus T-E2E-06 under Manual checks.
  - §13: `npm run demo:base-sepolia`.
  - §16: gotcha "CDP JWTs expire in 120 s; host clock skew gives 401 → category authentication".
  - Header version: 1.2 (2026-10-17).
- [X] T002 [P] Amend .specify/memory/constitution.md to 1.1.0 (MINOR):
  - Technology & Scope stack line gains "CDP SDK 1.59.0 (auth subpath, seller only)".
  - Principle V gains the bullet "A third-party API credential is held by exactly one process and confined by an architecture rule".
  - Accepted residual risks gain "facilitator sees payment metadata".
  - Prepend a Sync Impact Report (1.0.0 → 1.1.0, Principle V amended, Tech & Scope amended, templates reviewed: no change).
  - Set `Last Amended` to 2026-10-17.
- [X] T003 [P] Update CLAUDE.md:
  - Hard rule 2 becomes "Within `src/`, only `src/layer2-control/signer.ts` touches payment key material (`scripts/` may derive local dev keys only). The seller's CDP API credential is an auth credential confined to `src/counterparty/cdp-facilitator.ts` (A8)."
  - Commands gain `npm run demo:base-sepolia  # opt-in live run through CDP; needs env/*.base-sepolia.env`.
  - Environment gains "The CDP API key goes only in the seller's env file".
  - Gotchas gain "CDP JWTs expire in 120 s; a skewed host clock gives facilitator authentication errors".
- [X] T004 Add the dependency with `npm install --save-exact @coinbase/cdp-sdk@1.59.0`. Use `npm install`, not `npm ci`.
  - Confirm package.json has `"@coinbase/cdp-sdk": "1.59.0"`.
  - Confirm `node -e 'import("@coinbase/cdp-sdk/auth").then(m => console.log(typeof m.generateJwt))'` prints `function` with no `@x402/svm` installed.
  - Add the npm script `"demo:base-sepolia": "tsx scripts/demo-base-sepolia.ts"` to package.json.
  - Confirm `npm run typecheck` passes.
- [X] T005 Update env/seller.env.example per contracts/seller-config.md, and the T-ARCH-ENV matrix in test/architecture.test.ts to match:
  - Add `# FACILITATOR=` with the comment `# optional: local | public | cdp (default local on local, cdp on base-sepolia)`.
  - Add `CDP_API_KEY_ID=` and `CDP_API_KEY_SECRET=`, both empty, each with `# set me (FACILITATOR=cdp only)`.
  - Rewrite the trailing Base Sepolia comment block: CDP is the default and needs the key, and `FACILITATOR=public` is the opt-out to x402.org.
  - In test/architecture.test.ts, set `TEMPLATES.seller.optional` to `["FACILITATOR", "FACILITATOR_URL", "SELLER_PORT", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]`, and extend the empty-value check in `checkTemplate` from `/PRIVATE_KEY$/` to `/PRIVATE_KEY$|_SECRET$/`.
  - Other templates need no change. Their allowed sets already reject the new keys.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Facilitator selection, the CDP client factory, failure categorization, an injectable seller facilitator, the offline CDP stub and the shared demo helpers. Every story depends on these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests for the foundation ⚠️

- [X] T006 [P] Write T-CDP-01 in test/cdp-config.test.ts. One `it` per row of the research R3 resolution table, calling `facilitatorChoice(net, env)`:
  - local/unset → `{kind:"local", url:"http://127.0.0.1:4022", authenticated:false}` with no `timeoutMs`.
  - local + `FACILITATOR_URL` → that URL.
  - local + `FACILITATOR=cdp` and local + `FACILITATOR=public` → `ConfigError` with message `FACILITATOR=<kind> is not valid on NETWORK=local`.
  - base-sepolia/unset → `{kind:"cdp", url:"https://api.cdp.coinbase.com/platform/v2/x402", timeoutMs:30000, authenticated:true}`.
  - base-sepolia/unset + `FACILITATOR_URL` → `ConfigError` `FACILITATOR=cdp cannot be combined with FACILITATOR_URL`.
  - `FACILITATOR=public` → `https://x402.org/facilitator`, or the override, with `timeoutMs` 30000.
  - base-sepolia + `FACILITATOR=local` → `FACILITATOR=local is only valid on NETWORK=local`.
  - `FACILITATOR=foo` → `unknown FACILITATOR "foo" (expected local, public or cdp)`.
  - SC-007: adding `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` or any L1/L2/L3 variable to `env` leaves the result deep-equal, and the result never has a credential field.
- [X] T007 [P] Build test/helpers/cdp-stub.ts per contracts/cdp-facilitator-api.md "Offline stub".
  - Export `testEd25519Key()`. It uses `crypto.generateKeyPairSync("ed25519")` and returns `{apiKeyId: "organizations/test/apiKeys/<uuid>", apiKeySecret: base64(seed32 ‖ pub32)` (from the JWK `d` and `x`), `publicKey: KeyObject}`.
  - Export `startCdpStub({publicKey, apiKeyId, innerUrl, mode?, requireAuth = true})` → `{url, baseUrl: url + "/platform/v2/x402", host, setMode, counts: {supported, verify, settle, rejected, authHeaders}, close}`.
  - Serve `GET /platform/v2/x402/supported`, `POST …/verify` and `POST …/settle`. When `requireAuth`:
    - Verify `Authorization: Bearer <jwt>` with `crypto.verify(null, `${h}.${p}`, publicKey, sig)`.
    - Header: `alg === "EdDSA"`, `kid === apiKeyId`, `typ === "JWT"`.
    - Claims: `iss === "cdp"`, `sub === apiKeyId`, `nbf ≤ now ≤ exp`, `exp − nbf ≤ 120`, and `uris[0] === "<METHOD> <host><path>"`.
    - Any failure → 401 `{error:"unauthorized"}` and `counts.rejected++`.
  - When `requireAuth` is false (US4 public-path checks), count requests that carry an `Authorization` header in `counts.authHeaders`.
  - `/supported` in `ok` mode returns `{kinds:[{x402Version:2, scheme:"exact", network:"eip155:31337"}], extensions:[], signers:{}}`. Forward `verify` and `settle` bodies with `fetch` to `innerUrl` (the harness's local CP-2 facilitator).
  - Modes:
    - `401`, `429` (with `Retry-After: 0`), `500`: on every endpoint.
    - `hang`: never respond.
    - `unsupported`: `/supported` lists only `eip155:84532`.
    - `decline`: verify returns 200 `{isValid:false, invalidReason:"compliance_declined", payer}`.
    - `pending`: the first settle for a given nonce forwards to inner and returns 200 `{success:false, errorReason:"settlement_pending", transaction:<inner tx>, network, payer}`. Any repeat for that nonce returns the same body without forwarding.
  - `setMode` switches at runtime.

### Implementation for the foundation

- [X] T008 Implement facilitator selection in src/shared/config.ts (makes T006 pass):
  - `export type FacilitatorKind = "local" | "public" | "cdp"`.
  - `export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402"` and `export const HOSTED_FACILITATOR_TIMEOUT_MS = 30_000`.
  - `export interface FacilitatorChoice { kind: FacilitatorKind; url: string; timeoutMs?: number; authenticated: boolean }`.
  - `export function facilitatorChoice(net: NetworkProfile, env: Env = process.env): FacilitatorChoice`, implementing the research R3 table exactly. Throw `ConfigError` with the reasons listed in contracts/seller-config.md.
  - `facilitatorChoice` MUST NOT read `CDP_API_KEY_ID` or `CDP_API_KEY_SECRET` (A8).
  - Keep `NetworkProfile.facilitatorUrl` unchanged. It remains the `local` and `public` URL source.
- [X] T009 [P] Create src/counterparty/cdp-facilitator.ts, the only A8-allowed file. It imports only `HTTPFacilitatorClient` from `@x402/core/server`, `generateJwt` from `@coinbase/cdp-sdk/auth`, and `ConfigError`, `CDP_FACILITATOR_URL`, `HOSTED_FACILITATOR_TIMEOUT_MS` from `../shared/config.js`. Exports:
  - `interface CdpCredential { apiKeyId: string; apiKeySecret: string }`.
  - `normalizeCdpSecret(raw: string): string` (analysis A1). `generateJwt` parses EC keys with `jose`'s `importPKCS8`, which accepts only PKCS#8 (`-----BEGIN PRIVATE KEY-----`). CDP also hands out SEC1 keys (`-----BEGIN EC PRIVATE KEY-----`). This function:
    1. Trims surrounding whitespace.
    2. Replaces literal `\n` two-character sequences with newlines, for single-quoted or one-line env values.
    3. If the text contains `-----BEGIN EC PRIVATE KEY-----`, converts it with `createPrivateKey({ key, format: "pem" }).export({ type: "pkcs8", format: "pem" })` from `node:crypto`.
    4. Returns base64 Ed25519 and PKCS#8 PEM unchanged.
    5. On a conversion error, throws the same fixed `ConfigError` as `validateCdpSecret`.
  - `cdpCredentialsFromEnv(env)`. Throws `ConfigError` `missing CDP_API_KEY_ID (required for FACILITATOR=cdp)` or `missing CDP_API_KEY_SECRET (required for FACILITATOR=cdp)` for an absent or empty value. It returns `apiKeySecret` already normalized with `normalizeCdpSecret`, and keeps the raw value only for redaction (see `makeRedactor`).
  - `cdpCredentialStatus(values): { keyId: boolean; secret: boolean }`. Presence booleans only.
  - `cdpCredentialsPresent(env): boolean`.
  - `containsCdpSecret(values: Record<string, string | undefined>, text: string): boolean` (analysis G1). Takes the seller env values, and returns true if `text` contains the raw secret, its normalized form, or any PEM body line of 16 or more characters from either. It returns only the boolean, so `scripts/` can scan output without naming the CDP variables (A8).
  - `async validateCdpSecret(cred)`. Calls `generateJwt` once for `GET <host>/platform/v2/x402/supported`. On any error it throws `ConfigError("CDP_API_KEY_SECRET is not a valid Ed25519 (base64) or EC (PEM) key")` and never includes the original error text.
  - `cdpFacilitatorClient(cred, { baseUrl = CDP_FACILITATOR_URL, timeoutMs = HOSTED_FACILITATOR_TIMEOUT_MS } = {})`. Returns `new HTTPFacilitatorClient({ url: baseUrl, timeoutMs, createAuthHeaders })`. `createAuthHeaders` resolves to `{ verify: {Authorization}, settle: {Authorization}, supported: {Authorization} }`, each `Bearer ${await generateJwt({apiKeyId, apiKeySecret, requestMethod, requestHost: new URL(baseUrl).host, requestPath: `${basePath}/<op>`})}`, with method `POST`, `POST` and `GET` respectively (data-model "Auth headers").
  - `makeRedactor(cred): (text: string) => string`. Replaces with `[redacted]` the raw secret, the normalized secret, and every PEM body line of 16 or more characters from either.
  - `keyIdSuffix(cred)` → `…` + the last 4 characters of `apiKeyId`.
  - `CDP_AUTH_HINT = "check CDP_API_KEY_ID/SECRET and the host clock (JWTs expire in 120 s)"`.
  - The secret appears only in the `cred` object and the closures.
- [X] T010 [P] Create src/counterparty/facilitator-client.ts. It holds no credentials and imports from `@x402/core/server` and `../shared/config.js` only.
  - `export type FailureCategory = "unavailable" | "authentication" | "rate-limited" | "unsupported"`.
  - `export class FacilitatorUnavailableError extends FacilitatorResponseError { category; operation }` with message `facilitator ${category}`.
  - `export function categorize(err: unknown): FailureCategory`. Walk `cause` up to 10 levels and apply the research R4 table:
    - `RouteConfigurationError` or `FacilitatorCapabilityError` → `unsupported`.
    - `FacilitatorTimeoutError`, `TypeError` from fetch, `ECONNREFUSED`/`ENOTFOUND`/`ECONNRESET` codes, other `FacilitatorResponseError` → `unavailable`.
    - Message `/failed \((\d{3})\)/` with 401 or 403 → `authentication`; 402 or 429 → `rate-limited`; 5xx → `unavailable`.
    - Default → `unavailable`.
  - `export class CategorizedFacilitatorClient implements FacilitatorClient`. Wraps `verify`, `settle` and `getSupported`. `VerifyError` and `SettleError` are rethrown unchanged. Any other error is rethrown as `FacilitatorUnavailableError(categorize(err), op)`, after calling the optional `onFailure(category, op, err)`.
  - `export function facilitatorClientFor(choice: FacilitatorChoice, opts: { cdp?: FacilitatorClient; onFailure? } = {})`. For `kind === "cdp"` it requires `opts.cdp` and throws otherwise. For other kinds it uses `new HTTPFacilitatorClient({ url: choice.url, ...(choice.timeoutMs !== undefined && { timeoutMs: choice.timeoutMs }) })`. The result is always wrapped in `CategorizedFacilitatorClient`.
- [X] T011 Refactor src/counterparty/seller.ts and update test/counterparty.test.ts (depends on T010).
  - `createSellerApp({ net, payTo, facilitator?, redact? })` and `sellerPaymentMiddleware(net, routes, facilitator, redact)`. The default facilitator is `facilitatorClientFor({ kind: "local", url: net.facilitatorUrl, authenticated: false })`, which keeps the local and harness behavior.
  - Remove the old `facilitatorClientFor(net)` export from seller.ts.
  - On a lazy-sync failure, respond `503` with `{ error: \`facilitator ${category}\`, category }`, where `category = categorize(err)`. Remove the `detail` field.
  - Log one line to stderr: `seller: facilitator <category> during supported: <redact(String(err)).slice(0, 200)>`.
  - In test/counterparty.test.ts, extend the "priced route → 503 while the facilitator is down" test (around line 303) to assert the body `{"error":"facilitator unavailable","category":"unavailable"}`.
  - In test/counterparty.test.ts (around lines 162 and 646–652), replace the `facilitatorClientFor(net).url` assertions with `facilitatorChoice(net, env).url` equivalents. base-sepolia with `FACILITATOR=public` is `https://x402.org/facilitator`; the local default and the override are unchanged.
- [X] T012 Extend test/helpers/harness.ts. Add `HarnessOptions.sellerFacilitator?: (localFacilitatorUrl: string) => Promise<FacilitatorClient>`. When set, the harness awaits it after starting the local facilitator and passes the result to `createSellerApp({ net, payTo, facilitator })`. When unset, behavior is unchanged.
- [X] T013 [P] Extract the shared demo helpers from scripts/demo-local.ts into scripts/demo-lib.ts. No behavior change.
  - Move `parseEnvFile`, `envFileFor`, `childEnv`, `start`, `shutdown` (process-group kill), `portInUse`, `waitPortsFree`, `httpOk`, `waitReady`, `getJson`, `printSummary`, `matchesBaseline` and the `DemoProcess`/`DemoSummary` types. Parameterize the env file name per role (`env/<role>.env` today; `env/<role>.base-sepolia.env` for T017).
  - Give `printSummary(s, extra: string[] = [])` an optional list of extra lines, printed after `hash chain …` and before the closing `======================` line. demo-local passes none, so its output is byte-identical (analysis I1).
  - Capture `npm run demo:local` stdout before the change. After it, the summary lines must be identical apart from `entries=<n>`, and test/demo.local.test.ts must stay green.

**Checkpoint**: `npm run check` is green. T-CDP-01 passes, the local demo summary is unchanged, and the stub and helpers are ready.

---

## Phase 3: User Story 1 - Paid fetch on Base Sepolia settles through CDP (Priority: P1) 🎯 MVP

**Goal**: On `base-sepolia` the seller verifies and settles through CDP with JWT auth. L2 signs as before, and L3 confirms on-chain.

**Independent Test**: Offline, T-CDP-03 runs the scripted plan through the JWT-verifying CDP stub. Live, `npm run demo:base-sepolia` (T-E2E-06) prints the T-E2E-01 outcomes, `spent on-chain: 0.006 USDC` and `payer gas spent: 0 wei`.

### Tests for User Story 1 ⚠️

- [X] T014 [US1] Write JWT unit tests in test/cdp-auth.test.ts, titled "T-CDP-03 auth headers …":
  - With `testEd25519Key()`, `cdpFacilitatorClient(cred, { baseUrl: "https://api.cdp.coinbase.com/platform/v2/x402" }).createAuthHeaders("verify")` gives `Authorization: Bearer <jwt>`.
  - The decoded header is `{alg:"EdDSA", kid:apiKeyId, typ:"JWT"}` and has a `nonce`.
  - The claims are `{sub:apiKeyId, iss:"cdp", uris:["POST api.cdp.coinbase.com/platform/v2/x402/verify"]}` with `exp − nbf === 120`. The `supported` path gives `GET …/supported`.
  - Two calls give different JWTs.
  - EC keys (analysis A1). From one `generateKeyPairSync("ec", {namedCurve:"P-256"})` pair, both the PKCS#8 export (`{type:"pkcs8", format:"pem"}`) and the SEC1 export (`{type:"sec1", format:"pem"}`) yield JWTs with `alg:"ES256"` after `normalizeCdpSecret`, and both verify with the pair's public key. The SEC1 PEM written as one line with literal `\n` sequences also works.
  - Without normalization, the raw SEC1 PEM passed straight to `validateCdpSecret` is rejected. This proves the normalization is needed (Principle VIII).
  - `validateCdpSecret` rejects `"not-a-key"` with exactly the contract message, and the message does not contain `"not-a-key"`.
- [X] T015 [US1] Write T-CDP-03 (offline end-to-end) in test/cdp-auth.test.ts.
  - Start the harness with `sellerFacilitator: async (inner) => { stub = await startCdpStub({ ...key, innerUrl: inner }); return facilitatorClientFor({kind:"cdp", url: stub.baseUrl, timeoutMs: 30000, authenticated: true}, { cdp: cdpFacilitatorClient(key, { baseUrl: stub.baseUrl }) }) }`.
  - Run the scripted plan the way T-E2E-01 does in test/e2e.local.test.ts. Assert:
    - Outcomes `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`.
    - Payee delta `6000n`.
    - 2 CONFIRMED.
    - The hash chain verifies.
    - `stub.counts`: `rejected === 0`, `verify === 2`, `settle === 2`, `supported ≥ 1`.
  - FR-013: the decoded `PAYMENT-REQUIRED` for `/api/weather?city=Lima` deep-equals a default harness's challenge, ignoring `resource.url` host and port.
  - Control: a plain `HTTPFacilitatorClient({ url: stub.baseUrl }).getSupported()` rejects with `(401)`.

### Implementation for User Story 1

- [X] T016 [US1] Wire facilitator selection into `main()` in src/counterparty/seller.ts:
  - `const choice = facilitatorChoice(net)`.
  - If `choice.kind === "cdp"`: `cred = cdpCredentialsFromEnv(process.env)`, then `facilitator = facilitatorClientFor(choice, { cdp: cdpFacilitatorClient(cred) })`. Otherwise `facilitatorClientFor(choice)`.
  - Pass `redact = cred ? makeRedactor(cred) : (s) => s`.
  - The startup log uses the exact format in contracts/seller-config.md: `seller listening on ${SELLER_BIND_HOST}:${port} (${net.caip2}, facilitator=${choice.kind} host=${new URL(choice.url).host}${cred ? " key=" + keyIdSuffix(cred) : ""})`.
  - seller.ts itself must not contain the CDP variable names (A8).
- [X] T017 [US1] Implement scripts/demo-base-sepolia.ts (T-E2E-06) per research R10, using scripts/demo-lib.ts. Never print an env value or name the CDP variables (A8).
  1. **Preflight (exit 2 with one fixed line per failure)**. Use `parseEnvFile` and read only the keys named here.
     - `env/seller.base-sepolia.env`: `facilitatorChoice(networkProfile("base-sepolia"), values).kind === "cdp"` and both `cdpCredentialStatus(values)` flags true. Otherwise: `demo:base-sepolia: seller must use FACILITATOR=cdp with CDP credentials set`.
     - `env/l1-agent.base-sepolia.env`: `SELLER_URL` is exactly `http://127.0.0.1:<SELLER_PORT or 4021>`. Otherwise: `demo:base-sepolia: SELLER_URL must be http://127.0.0.1:<port> (step 6 of the plan uses the localhost alias)`.
     - `env/l2-control.base-sepolia.env`: `ALLOWED_HOSTS` is exactly `127.0.0.1:<port>`, and `ALLOWED_PAYEES` contains `SELLER_PAY_TO` (case-insensitive). Otherwise: `demo:base-sepolia: ALLOWED_HOSTS must be exactly 127.0.0.1:<port> and ALLOWED_PAYEES must include SELLER_PAY_TO`. Read only those two keys from that file; never touch the payer key value (analysis U2).
  2. Start `seller`, `l2:control` and `l3:verifier` with `ENV_FILE=env/<role>.base-sepolia.env` (no chain, no facilitator), then `waitReady`. Capture every line of child and agent stdout/stderr into an in-memory buffer as well as forwarding it.
  3. With a read-only viem public client on `BASE_SEPOLIA_RPC_URL` or `https://sepolia.base.org`, read the payee's USDC `balanceOf` at head before the run (asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, payee = `SELLER_PAY_TO`). No historical-state reads, because public RPCs may prune them.
  4. Run `src/main.ts --scripted` with `ENV_FILE=env/l1-agent.base-sepolia.env`. Parse outcomes with the demo-local regex `/^\d+\. ([A-Z_]+) /`, and collect each PAID line's `tx=<hash>` and `settlement=<status>`.
  5. **Payer and gas (analysis U1)**. The scripted output has no payer field. Fetch each PAID `tx` receipt read-only. The payer is the `from` (topic 1) of the USDC `Transfer` log whose `to` is the payee. `payer gas spent` = Σ `gasUsed × effectiveGasPrice` over those receipts whose `receipt.from` equals the payer, as `bigint`. Expected `0n`, because CDP submits the transactions.
  6. **Summary (analysis I1)**. Build the same `DemoSummary` as demo-local: `network: "base-sepolia"`, the session ID, the outcomes, `spentAtomic` = payee balance after − before, `budget` from `GET /v1/budget/:session`, and `chain` from `GET /v1/ledger/verify`. Print it with `printSummary(summary, extra)`, where `extra` is `settlements:        <n> CONFIRMED`, `payer gas spent:    <wei> wei` and `secret scan:        clean|FOUND`.
  7. **Secret scan (analysis G1, SC-004)**. After shutdown, run `containsCdpSecret(sellerValues, text)` over the captured output buffer and the contents of `.local/ledger-base-sepolia.jsonl`. Print `clean` or `FOUND`, and never print the match.
  8. Exit 0 only when `matchesBaseline(summary)` holds (outcomes, delta `6000n`, chain ok, `spentOrReserved` 6000), 2 PAID lines report `settlement=CONFIRMED`, gas is `0n` and the scan is clean. Otherwise exit 2. Always shut children down by process group.

**Checkpoint**: T-CDP-03 is green offline. With a real CDP key and a funded payer, one `npm run demo:base-sepolia` passes (T039 does 3).

---

## Phase 4: User Story 2 - The CDP credential stays with the seller and fails closed (Priority: P1)

**Goal**: Only the seller can see the CDP key. Every misconfiguration stops the seller before any payment is signed. There is no silent downgrade, and no secret appears in output.

**Independent Test**: Offline: T-ARCH-A8 (the fixture trips and the repo is clean), T-CDP-02 (startup drills), T-CDP-07 (secret scan) and T-CDP-08 (child envs, no fallback).

### Tests for User Story 2 ⚠️

- [X] T018 [P] [US2] Add rule A8 to test/architecture.test.ts, with fixture test/fixtures/arch/a8-violation.ts, per contracts/architecture-rule-a8.md.
  - Extend `Rule` with `"A8"`.
  - Scan `walk("src")`, `walk("scripts")` and `env/*.env.example`. Allow only `src/counterparty/cdp-facilitator.ts` and `env/seller.env.example`.
  - Match `\bCDP_API_KEY_(ID|SECRET)\b` in code or strings, and import specifiers matching `^@coinbase/cdp-sdk`.
  - The fixture contains `process.env.CDP_API_KEY_SECRET` and `import { generateJwt } from "@coinbase/cdp-sdk/auth"`.
  - Tests: "T-ARCH-A8 fixture trips A8" (must fail without the rule) and "T-ARCH-A8 repository is clean".
- [X] T019 [US2] Write T-CDP-02 in test/cdp-isolation.test.ts. Spawn `node_modules/.bin/tsx src/counterparty/seller.ts` with only `PATH`, `HOME`, `NODE_*` and `ENV_FILE=<temp file>` plus a free `SELLER_PORT`. Each case asserts the exit code, the exact stderr line from contracts/seller-config.md, and that the output does not contain the secret:
  - base-sepolia with no CDP vars → exit 1, `seller: missing CDP_API_KEY_ID (required for FACILITATOR=cdp)`.
  - ID set, empty secret → exit 1, `seller: missing CDP_API_KEY_SECRET (required for FACILITATOR=cdp)`.
  - Secret `not-a-key-<random>` → exit 1, `seller: CDP_API_KEY_SECRET is not a valid Ed25519 (base64) or EC (PEM) key`, and the output never contains the random text.
  - cdp + `FACILITATOR_URL` → exit 1, `seller: invalid facilitator config: FACILITATOR=cdp cannot be combined with FACILITATOR_URL`.
  - local + `FACILITATOR=cdp` → exit 1, `seller: invalid facilitator config: FACILITATOR=cdp is not valid on NETWORK=local`.
  - A valid `testEd25519Key()` on base-sepolia → listens. stdout matches `/facilitator=cdp host=api\.cdp\.coinbase\.com key=…\w{4}\)/` and the output never contains `apiKeySecret`. This makes no network call, because of lazy sync. Kill the process.
  - local with CDP vars set and no `FACILITATOR` → listens, and stderr contains `seller: CDP credentials set but unused (FACILITATOR=local)`.
- [X] T020 [US2] Write T-CDP-07 (secret scan, SC-004) in test/cdp-isolation.test.ts.
  - Use a fresh `testEd25519Key()`. Spy on `console.log/warn/error` and collect every response status, header and body.
  - Run, in process: (a) one paid weather fetch through the harness with the CDP stub in `ok` mode; (b) fresh sellers against stub modes `401`, `500`, `decline` and `pending`.
  - Then scan all captured text, the harness ledger file and the harness temp dir. Each must contain neither `apiKeySecret` nor its first 32 characters. Also assert `containsCdpSecret` agrees with the plain scan.
  - Unit-test `makeRedactor`: it replaces the raw secret, the normalized secret, and each PEM body line of P-256 keys in both PKCS#8 and SEC1 form.
  - **Must-fail proof of the redaction wiring (analysis C1, Principle VIII)**. Build a seller whose CDP client wraps a stub `FacilitatorClient` whose `getSupported` throws `new Error(\`Facilitator getSupported failed (500): echo ${apiKeySecret}\`)`. That simulates an upstream that reflects the credential. Request a priced route.
    - (i) With the seller's real redactor, the 503 body and every captured stderr line contain neither the secret nor its first 32 characters, and stderr contains `[redacted]`.
    - (ii) Repeat with `redact` replaced by the identity function, through the `createSellerApp` option. Captured stderr now **does** contain the secret.
    - Title: "T-CDP-07 seller logs are redacted (fails without the redactor)".
- [X] T021 [US2] Write T-CDP-08 (isolation and no fallback) in test/cdp-isolation.test.ts.
  - (a) Set `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` in `process.env`. For every role in scripts/demo-lib.ts, `childEnv(p)` must contain only `PATH`, `HOME`, `NODE_*` and `ENV_FILE` keys, with no CDP key (SC-005). Restore the env afterwards.
  - (b) Wrap `vi.spyOn(globalThis, "fetch")` as a pass-through. Create a seller with `facilitatorClientFor(cdpChoice, { cdp: cdpFacilitatorClient(key, { baseUrl: stub.baseUrl }) })` and the stub in `500` mode. Make 3 priced requests: each gets 503 `facilitator unavailable`.
  - Assert every fetch URL the seller issued has the stub's host, so 0 requests go to `x402.org` or any other host. The title must say "(fails if a fallback is added)".

### Implementation for User Story 2

- [X] T022 [US2] Implement fail-closed startup and failure logging in `main()` in src/counterparty/seller.ts (extends T016). The startup order follows contracts/seller-config.md rows 1–5:
  - A `facilitatorChoice` `ConfigError` → `console.error("seller: invalid facilitator config: " + reason)`, exit 1.
  - For `cdp`: `cdpCredentialsFromEnv` errors print `seller: ` + message and exit 1. Then `await validateCdpSecret(cred)`; its error prints `seller: ` + message and exits 1. Print only these fixed messages, never a nested `err.message`.
  - Then validate `SELLER_PAY_TO` (unchanged).
  - For non-cdp choices, when `cdpCredentialsPresent(process.env)`, warn `seller: CDP credentials set but unused (FACILITATOR=<kind>)` on stderr.
  - Pass `onFailure` to `facilitatorClientFor`. It logs `seller: facilitator <category> during <op>: <redact(excerpt ≤ 200)>`, and appends a second line, `seller: facilitator authentication — ` + `CDP_AUTH_HINT`, when the category is `authentication` and the choice is cdp.
- [X] T023 [P] [US2] Update specs/007-process-isolation-security/contracts/threat-matrix.md with a SEC-10 row naming T-ARCH-A8, T-CDP-02, T-CDP-07 and T-CDP-08, in the existing row format, so T-ARCH-TRACE enforces them. In specs/007-process-isolation-security/contracts/env-templates.md, change the seller row to `NETWORK, SELLER_PAY_TO, FACILITATOR?, FACILITATOR_URL?, CDP_API_KEY_ID?, CDP_API_KEY_SECRET?`, and add `FACILITATOR, CDP_API_KEY_ID, CDP_API_KEY_SECRET` to every other row's "Must NOT contain".

**Checkpoint**: Every misconfiguration exits 1 with a fixed message. A8, T-CDP-02, T-CDP-07 and T-CDP-08 are green, and T-ARCH-TRACE passes with SEC-10.

---

## Phase 5: User Story 3 - Facilitator failures never lose or miscount money (Priority: P2)

**Goal**: Every CDP failure mode ends in a defined seller response, L1 outcome and L3 status. A failure claim that carries a real transaction is checked on-chain (FR-020).

**Independent Test**: Offline: verifier.test.ts FR-020 rows, plus T-CDP-04, T-CDP-05, T-CDP-06 (must-fail) and T-CDP-09 against the stub.

### Tests for User Story 3 ⚠️

- [X] T024 [P] [US3] Add FR-020 rows to test/verifier.test.ts using `fakePublicClient`, titled "L3-1 step 2 v1.2 (FR-020) …":
  - `success:false` with no transaction → `NOT_SETTLED`.
  - `success:false` with transaction `"0x1234"` (not 32 bytes) → `NOT_SETTLED`.
  - `success:false`, a valid hash, receipt `reverted` → `NOT_SETTLED`.
  - `success:false`, a valid hash, Transfer mismatch → `MISMATCH`.
  - `success:false`, a valid hash, `network` ≠ requirement → `MISMATCH`.
  - `success:false`, a valid hash, a matching Transfer → `CONFIRMED`, with `detail` starting `facilitator reported failure (settlement_pending); `.
  - The existing `success:true` rows stay unchanged.
- [X] T025 [US3] Write `categorize()` unit tests and T-CDP-04 in test/cdp-failures.test.ts.
  - Units: one case per research R4 row, using synthetic errors (`FacilitatorTimeoutError`, `new TypeError("fetch failed")`, `Error("Facilitator verify failed (401): …")`, `(403)`, `(429)`, `(402)`, `(503)`, `RouteConfigurationError`, a nested `cause`).
  - T-CDP-04: for stub modes `401`, `429`, `500`, `hang` (client `timeoutMs: 500` via the `cdpFacilitatorClient` option) and `unsupported`, a fresh seller's first `GET /api/market-brief` answers 503 with exactly `{"error":"facilitator <category>","category":"<category>"}`. The categories are authentication, rate-limited, unavailable, unavailable and unsupported.
  - In each case `/api/catalog` answers 200.
  - The L1 orchestrator's `fetchPaid` returns `FREE` with `httpStatus: 503`, and `harness.ledgerEntries()` gains 0 `AUTHORIZED` entries (SC-003, SC-008).
- [X] T026 [US3] Write T-CDP-05 (paid-retry failures) in test/cdp-failures.test.ts. Start the stub in `ok` so the sync succeeds, then:
  - (a) `setMode("decline")`, then fetch weather through the L1 orchestrator. The paid retry gets 402, and its rejection carries `compliance_declined`. The outcome is `PAYMENT_FAILED`, and the L3 report is `NOT_SETTLED`. The L2 budget `spentOrReserved` still includes 1000 before `validBefore` (SEC-9).
  - (b) `setMode("401")` after the sync. The paid retry gets 502 `{"error":"facilitator authentication"}`, the resource is not served, and the outcome is `PAYMENT_FAILED`.
- [X] T027 [US3] Write T-CDP-06 (must-fail proof, FR-019/FR-020, SEC-11) in test/cdp-failures.test.ts, with the stub in `pending` mode and a weather fetch through the harness:
  - The paid retry gets 402 with a `PAYMENT-RESPONSE` that decodes to `{success:false, errorReason:"settlement_pending", transaction:<0x…64>}`.
  - The outcome is `PAYMENT_FAILED`, and the L3 report is `CONFIRMED`. The L2 effective status for that `authorizationId` is `CONFIRMED`. The budget includes 1000, and the payee balance rose by `1000n`.
  - Then verify the same claim with `new ChainSettlementVerifier({ …, verifyFailedClaims: false })`. It reports `NOT_SETTLED`.
  - Title: "T-CDP-06 failure claim with a settled hash is CONFIRMED (fails without FR-020)".
- [X] T028 [US3] Write T-CDP-09 (recovery, SC-009) in test/cdp-failures.test.ts. With the stub in `500`, a priced request gets 503 `facilitator unavailable`. After `setMode("ok")`, the next request to the same seller instance gets 402 with one `accepts` entry, with no restart.

### Implementation for User Story 3

- [X] T029 [US3] Amend step 2 of src/layer3-settlement/verifier.ts per contracts/l3-verify-amendment.md (makes T024 and T027 pass). Replace the `!settle.success` and `!settle.transaction` early returns (around lines 103–104) with:
  - If `!settle.transaction` or it does not match `/^0x[0-9a-fA-F]{64}$/` → `NOT_SETTLED`. The detail is `seller reported failure: <errorReason>` when `!success`, else `PAYMENT-RESPONSE has no transaction`.
  - Otherwise, when `!settle.success`, set `prefix = \`facilitator reported failure (${settle.errorReason ?? "unknown"}); \`` and prepend it to every later report's `detail` (steps 3–6).
  - Add the constructor option `verifyFailedClaims?: boolean` (default `true`, documented as test-only). When it is `false`, the v1.1 early return comes back.
  - Use no new chain calls beyond the existing receipt, log and block reads. A4 must still pass.
- [X] T030 [US3] Confirm the paid-retry category path against `@x402/express` 2.28.0. A `FacilitatorUnavailableError` thrown from `verify` (inside `processHTTPRequest`) and from `settle` (inside `processSettlement`) must reach `sendFacilitatorError`, which returns 502 `{error:"facilitator <category>"}`.
  - If T026(b) shows `verify`-time errors are converted to a 402 inside `x402ResourceServer.verifyPayment` instead, do not patch the SDK. Update contracts/seller-errors.md (the "During a paid retry" row), spec FR-016 and T026(b) to the observed status, and keep the category in the body or headers.
- [X] T031 [P] [US3] Add a SEC-11 row to specs/007-process-isolation-security/contracts/threat-matrix.md: "Facilitator reports failure for a transfer that settled → budget under-count | L3 checks any reported hash on-chain (FR-020) | T-CDP-06".

**Checkpoint**: All failure categories behave as in contracts/seller-errors.md. T-CDP-06 shows CONFIRMED with FR-020 and NOT_SETTLED without it.

---

## Phase 6: User Story 4 - Existing paths stay unchanged (Priority: P2)

**Goal**: The local demo and the public facilitator path on `base-sepolia` work as before, and need no CDP credentials.

**Independent Test**: `npm run check` with no CDP variables anywhere. The public-path checks in test/cdp-config.test.ts.

### Tests for User Story 4 ⚠️

- [X] T032 [P] [US4] Add public-path checks to test/cdp-config.test.ts, titled "T-CDP-01 public path …":
  - (a) Spawn the seller with `NETWORK=base-sepolia`, `FACILITATOR=public`, a `SELLER_PAY_TO` and no CDP variables. It listens, and stdout contains `facilitator=public host=x402.org`.
  - (b) `facilitatorClientFor(publicChoiceWithUrl(stub.url))` against `startCdpStub({ requireAuth: false, … })` in `ok` mode. After `getSupported()`, `verify()` and `settle()`, `stub.counts.authHeaders === 0`, so no credential is sent to a public facilitator.

### Implementation for User Story 4

- [X] T033 [US4] Prove the baseline holds:
  - Run `npm run demo:local` and compare its summary with the capture from T013. Only `entries=<n>` may differ.
  - Run `npx vitest run test/demo.local.test.ts test/e2e.local.test.ts test/counterparty.test.ts`.
  - With `env -u CDP_API_KEY_ID -u CDP_API_KEY_SECRET`, run `npm test`. Everything is green, and no test needs network beyond loopback.
  - If anything differs, fix the code. Do not change the baseline.

**Checkpoint**: The local regression baseline and the public path are unchanged.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, traceability and the final gates.

- [X] T034 [P] Rewrite the "Base Sepolia" section of README.md from quickstart.md §2–§5:
  - CDP key creation with least privilege.
  - `env/seller.base-sepolia.env` with the CDP variables, and the `FACILITATOR=public` opt-out.
  - The startup log line and the fail-closed drills.
  - `npm run demo:base-sepolia` and its expected summary.
  - Note that existing Base Sepolia setups need a CDP key or `FACILITATOR=public` after this change.
- [X] T035 [P] Update specs/README.md:
  - Change the 009 feature row status from "Draft, not yet in SPEC.md" to "SPEC v1.2".
  - Add traceability rows: CP-3, CFG-1 and CFG-2 → 006, 009. SEC-10 → 007, 009. SEC-11 → 005, 009. L3-1 step 2 → 005, 009. A8 → 007, 009. T-CDP-01..09 → 009. T-E2E-06 → 009.
- [X] T036 [P] Annotate the superseded statements in other feature docs with "Amended by 009 (SPEC v1.2)" and a one-line summary:
  - specs/006-counterparty-seller-network/spec.md: FR-010, FR-015 facilitator row, and US3 scenario 2.
  - specs/006-counterparty-seller-network/contracts/network-profile.md: the facilitator row.
  - specs/005-settlement-verification/spec.md: the requirement that restates L3-1 step 2 (find it with `grep -n "NOT_SETTLED" specs/005-settlement-verification/spec.md`).
  - specs/008-local-demo-regression/spec.md: the commands list gains `demo:base-sepolia`.
- [X] T037 Run the offline parts of quickstart.md: §1, and the §4 fail-closed drills with a `testEd25519Key()`-generated key. Write the generated key with a one-off `node -e` into a temporary `ENV_FILE`, never into `env/`. Confirm every expected line verbatim, and fix any doc or code mismatch.
- [X] T038 Run the final gate.
  - `npm run check` must be green, with T-ARCH-TRACE including SEC-10 and SEC-11, and the demo summary unchanged.
  - `grep -rn "@coinbase/cdp-sdk\|CDP_API_KEY_" src scripts env` must show only `src/counterparty/cdp-facilitator.ts` and `env/seller.env.example`.
  - `npm ls @coinbase/cdp-sdk` must show 1.59.0.
- [X] T039 Manual, operator-only (T-E2E-06, SC-001, SC-002, SC-004 live part). It needs a real CDP key in `env/seller.base-sepolia.env`, a payer holding ≥ 0.02 test USDC, and the env layout that T017's preflight enforces.
  - Run `npm run demo:base-sepolia` 3 times in a row. Each run must exit 0 and print:
    - `spent on-chain: 0.006 USDC`
    - `settlements:        2 CONFIRMED`
    - `payer gas spent:    0 wei`
    - `secret scan:        clean`
    - `hash chain ok=true`
  - Record the three summaries and the settlement transaction hashes in the PR description. Never paste env values.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** has no dependencies.
  - T001–T003 are documentation.
  - T004 must come before T009 (dependency).
  - T005 must come before any T-ARCH-ENV run.
- **Foundational (Phase 2)** depends on T004 and T005, and blocks every story.
  - T008 → T009 and T010 (parallel) → T011 → T012.
  - T006, T007 and T013 can be written at any time in this phase.
- **US1 (Phase 3)** needs T007, T009, T010, T011, T012 and T013.
- **US2 (Phase 4)** needs T009, T013 (`childEnv`) and T016. T022 extends T016, so run US2 after US1's T016.
- **US3 (Phase 5)** needs T007, T010, T011 and T012. It is independent of US1 and US2.
- **US4 (Phase 6)** needs T008, T011 and T013. It is independent of the other stories.
- **Polish (Phase 7)** needs all stories. T039 is manual and can be the last step before merge.

### User Story Dependencies

- **US1 (P1)**: after Foundational. It is the MVP.
- **US2 (P1)**: after Foundational plus T016 (shared `main()` in seller.ts). Its tests (T018–T021) can be written in parallel with US1.
- **US3 (P2)**: after Foundational. It touches verifier.ts and the new failure tests, with no file overlap with US1 or US2 except threat-matrix.md (T031 comes after T023).
- **US4 (P2)**: after Foundational. Its checks only.

### Within Each User Story

- Tests first, and they must fail: T014–T015 before T016–T017; T018–T021 before T022; T024–T028 before T029–T030.
- Same-file test tasks run in order: test/cdp-auth.test.ts (T014→T015), test/cdp-isolation.test.ts (T019→T020→T021), test/cdp-failures.test.ts (T025→T026→T027→T028).

### Parallel Opportunities

- Setup: T002 ∥ T003, after or alongside T001.
- Foundational: T006 ∥ T007 ∥ T013, then T009 ∥ T010 after T008.
- Across stories, after Foundational: the US1 tests (test/cdp-auth.test.ts), US2's T018 (architecture.test.ts), the US3 tests (test/cdp-failures.test.ts and test/verifier.test.ts) and US4's T032 (test/cdp-config.test.ts) touch different files.
- Polish: T034 ∥ T035 ∥ T036.

---

## Parallel Example: User Story 3

```bash
# Different files, launch together:
Task: "T024 FR-020 rows in test/verifier.test.ts"
Task: "T025 categorize() units + T-CDP-04 in test/cdp-failures.test.ts"
Task: "T031 SEC-11 row in specs/007-process-isolation-security/contracts/threat-matrix.md"

# Then, sequentially in test/cdp-failures.test.ts: T026 → T027 → T028
# Then implementation: T029 (verifier.ts) → T030 (confirm the paid-retry 502 path)
```

## Parallel Example: Foundational

```bash
Task: "T006 T-CDP-01 matrix in test/cdp-config.test.ts"
Task: "T007 CDP stub in test/helpers/cdp-stub.ts"
Task: "T013 extract scripts/demo-lib.ts"
# after T008:
Task: "T009 src/counterparty/cdp-facilitator.ts"
Task: "T010 src/counterparty/facilitator-client.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup (governance amendments, dependency, template).
2. Phase 2: Foundational. `npm run check` stays green.
3. Phase 3: US1. T-CDP-03 green offline, then one live `npm run demo:base-sepolia`.
4. **STOP and VALIDATE**: the CDP path works end to end.

US1 alone already holds the key in one file. Do not ship it without US2's fail-closed startup (T022) and A8 (T018), because Principle V is non-negotiable. In practice the MVP to merge is US1 + US2.

### Incremental Delivery

1. Setup + Foundational → the local baseline is unchanged.
2. US1 → CDP works (offline proof, plus a live smoke run).
3. US2 → credential confinement and fail-closed behavior. **Minimum mergeable increment.**
4. US3 → failure categories and the FR-020 L3 amendment.
5. US4 → baseline proof and the public path.
6. Polish → docs, traceability, final gate, 3 live runs.

---

## Requirement Coverage

| Requirement | Tasks |
|---|---|
| FR-001..FR-004 | T006, T008 |
| FR-005 | T010, T021 |
| FR-006 | T016, T019 |
| FR-007 | T009, T014, T015 |
| FR-008 | T009, T019, T022 |
| FR-009, FR-022 | T005, T018, T023 |
| FR-010 | T013, T021 |
| FR-011 | T009, T020, T022 |
| FR-012 | T018 (with A3), T009 |
| FR-013, FR-014 | T015 |
| FR-015..FR-017 | T010, T011, T025 |
| FR-016 (paid retry), FR-018 | T026, T030 |
| FR-019, FR-020 | T024, T027, T029 |
| FR-021 | T006, T014–T015, T019–T021, T024–T028, T032 |
| FR-023 | T017, T039 |
| NFR-001 | T018, T038 |
| NFR-002 | T019, T025 |
| NFR-003 | T013, T033, T038 |
| NFR-004 | T022, T025 |
| NFR-005 | T017 (2 settlements per run) |
| NFR-006 | T001, T002 |
| NFR-007 | T001–T003, T023, T031, T034–T036 |
| SC-001, SC-002 | T017, T039 |
| SC-003 | T019, T025 |
| SC-004 | T020 (offline, including the redaction must-fail), T017 + T039 (live scan) |
| SC-005 | T021 |
| SC-006 | T033, T038 |
| SC-007 | T006, T032 |
| SC-008 | T025 |
| SC-009 | T028 |

## Notes

- [P] tasks touch different files and have no dependency on an incomplete task.
- Every test title carries its ID (T-CDP-0x, T-ARCH-A8). The must-fail proofs (T018 fixture, T021 no-fallback, T027 without FR-020) state it in the title.
- Never weaken an invariant or the demo baseline to make a test pass (Principle VIII). If the observed SDK behavior differs from a contract, update the contract and spec (T030), not the SDK.
- Commit after each phase checkpoint. Reference requirement IDs (FR-0xx, SEC-10/11, T-CDP-0x) in commit messages.

## Implementation Notes (2026-10-17, `/speckit-implement`)

Where the code differs from the task text. Each difference is behavior-neutral and covered by the named test.

- **T011, T016, T022 (seller `main()`)**: the CP-3 wiring and the fail-closed startup order were written together with the T011 refactor, because they share `seller.ts`. T019 (T-CDP-02) and T032 test them.
- **T022 (failure hook)**: the verify/settle failure logger is installed by `sellerPaymentMiddleware` through `CategorizedFacilitatorClient.setFailureHook()`, not passed by `main()` as `onFailure`. `/supported` failures are logged by the lazy-sync catch, so each failure gets exactly one line. `facilitatorFailureLogger(redact, authHint)` adds the CDP hint for `authentication`.
- **T018 (fixture name)**: the fixture is `test/fixtures/arch/a8-violation.ts`, following the existing `a<n>-violation.ts` convention, and is checked with `checkCdpConfinement()`.
- **T007 (stub)**: `counts.requests` was added, because failure modes answer before routing. T-CDP-08 uses it.
- **T030 (paid-retry path)**: confirmed against `@x402/core` 2.28.0. `processHTTPRequest` rethrows `FacilitatorResponseError` from verify, and `@x402/express` answers 502 for verify and settle alike (T-CDP-05). The contract and FR-016 needed no change.
- **T024 (existing test T017 in verifier.test.ts)**: its `success:false` case now carries no transaction. Under SPEC v1.2 L3-1 step 2, a failure claim with a hash is checked on-chain (FR-020 rows), so the old case would rightly become CONFIRMED.
- **T-ARCH-TRACE**: the pinned SEC row list in `architecture.test.ts` now covers SEC-1..SEC-11.
- **T037**: the quickstart's targeted test commands run as written. `ENV_FILE=env/seller.base-sepolia.env npm run seller` on the operator's current file (no CDP key yet) exits 1 with `seller: missing CDP_API_KEY_ID (required for FACILITATOR=cdp)`.
- **T039** (2026-10-18, done): five live runs with a production CDP key (`key=…c73f`); runs 3, 4 and 5 passed back to back (exit 0, `spent on-chain: 0.006 USDC`, `settlements: 2 CONFIRMED`, `payer gas spent: 0 wei`, `secret scan: clean`, `hash chain ok=true`). Run 1 also passed.
  - **Run 2 failed (exit 2)**: CDP did not answer the weather `settle` within the 30 s timeout. The seller logged `facilitator unavailable during settle`, answered 502, L3 recorded `NOT_SETTLED`, and the budget kept the 1000-unit reservation until `validBefore` (T-LED-02). A Transfer-log scan of Base Sepolia from signing until after `validBefore` found no late settlement, so the payer was not charged. This is a CDP latency spike handled fail-closed, not a defect.
  - **Sandbox keys**: a first attempt with a CDP Sandbox key got 401 on every call. Keys are environment-scoped, and the Sandbox (`sandbox.cdp.coinbase.com`) has no x402 route (404) and no blockchain. README step 1 and CLAUDE.md now say to use a production key.
