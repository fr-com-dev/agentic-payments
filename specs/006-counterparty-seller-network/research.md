# Research: Counterparty Seller, Facilitator and Network Profiles

Technical Context had no `NEEDS CLARIFICATION` items. This file records the design decisions
and why they were made.

## R1. Explicit `AssetAmount` pricing, not `"$0.001"` strings

- **Decision**: Each route's price is
  `{ asset: net.asset, amount: "<atomic>", extra: net.assetDomain }`.
- **Rationale**: A dollar-string price makes the SDK pick the asset and EIP-712 domain from its
  own defaults, which knows nothing about MockUSDC on chain 31337. An explicit amount pins the
  asset and the domain name ("USD Coin" vs "USDC") per network, and keeps money in atomic
  units (Principle VI).
- **Alternatives considered**: `"$"` strings plus SDK asset discovery were rejected: they break
  locally and hide the domain.

## R2. One `exact` option per route

- **Decision**: Each route offers one option:
  `{scheme:"exact", network, payTo, maxTimeoutSeconds:120, price}`.
- **Rationale**: The scripted baseline (L1-4) expects deterministic single-option challenges.
  L2's multi-option selection (feature 002) is tested with synthetic challenges in its own
  tests.
- **Alternatives considered**: Multi-network accepts were rejected as out of scope for v1.

## R3. Catalog mounted before the payment middleware

- **Decision**: Register `GET /api/catalog` on the Express app before `paymentMiddleware(...)`.
- **Rationale**: Express runs middleware in registration order, so the catalog can never get a
  402 (SC-001). Listing the catalog in the middleware's route map with a zero price was
  rejected: x402 has no free price.

## R4. Deterministic mock bodies

- **Decision**: The weather seed is the sum of the char codes of `city`. Then:
  - `tempC = seed % 35`
  - `condition = ["sunny","cloudy","rain","fog"][seed % 4]`
  - the other routes return constant bodies.
- **Rationale**: NFR-004 requires reproducible regression runs without a real data source.
- **Note**: The exact formula is an implementation choice. The spec requires only that the
  body is deterministic per city.

## R5. Local facilitator via the SDK, split into factory and entry point

- **Decision**: Split the facilitator in two:
  - `src/counterparty/facilitator.ts` exports `createFacilitatorApp({ account, rpcUrl, caip2 })`.
    It takes a ready viem `LocalAccount`, calls
    `x402Facilitator().register(caip2, new ExactEvmScheme(toFacilitatorEvmSigner(...)))` with a
    wallet client plus public actions and `confirmationTimeoutMs: 30000`, and registers
    `GET /supported`, `POST /verify` and `POST /settle`. Exceptions map to HTTP 400 with an
    x402-shaped body. It holds no key material and never calls `privateKeyToAccount`.
  - `scripts/facilitator.ts` is the process entry. It calls `loadEnv()`, exits if
    `NETWORK !== "local"` before reading any key, derives the account with
    `privateKeyToAccount(FACILITATOR_PRIVATE_KEY)`, and listens on `FACILITATOR_PORT` (4022).
- **Rationale**: The SDK keeps verification identical to the hosted facilitator, so behavior
  matches on Base Sepolia (CP-3). The startup exit enforces NFR-003. Moving key handling to
  `scripts/**` keeps INV-2 and constitution Principle I word-for-word: within `src/`, only the
  L2 signer turns key material into an account. The factory also lets tests build the app
  in-process with a throwaway account.
- **Alternatives considered**: An INV-2 exemption for `src/counterparty/facilitator.ts` was
  rejected: it weakens a constitution MUST and needs a constitution amendment. Deriving the
  account inside `src/counterparty/` was rejected for the same reason.

## R6. MockUSDC design

- **Decision**: MockUSDC is a minimal ERC-20 plus EIP-3009 subset:
  - name "USD Coin", symbol "USDC", version "2", 6 decimals
  - `Ownable`-style `mint` that only the owner may call
  - EIP-712 domain `(name, version, chainId, verifyingContract)`
  - both `transferWithAuthorization` overloads: `(…,v,r,s)` and `(…,bytes signature)`
  - `authorizationState(authorizer, nonce)` and `AuthorizationUsed`
- **Rationale**: The SDK client and facilitator may use either overload. Matching USDC's
  surface keeps signing identical across networks.
- **Compile settings**: solc 0.8.24 with `evmVersion: shanghai` and optimizer 200, matching
  ganache's `shanghai` hardfork. Ganache does not support Cancun opcodes such as `MCOPY`.
- **Alternatives considered**: Vendoring Circle's FiatToken was rejected: proxies and
  blacklisting add weight a PoC doesn't need.

## R7. Local chain bootstrap

- **Decision**: `local-chain-lib.ts` runs these steps:
  1. Start ganache on 8545 (chainId 31337, the fixed mnemonic).
  2. Compile and deploy MockUSDC from #0.
  3. Mint `10_000_000` to #2.
  4. Write `.local/deployment.json`.
- **Rationale**: Fixed roles (#0 deployer, #1 facilitator, #2 payer, #3 seller payTo) make env
  templates and tests reproducible. The deployment file lets processes discover the asset
  address without hard-coding it.

## R7a. Dev keys for the local demo

- **Decision**: `scripts/local-chain-lib.ts` exports `localDevKeys()`. It throws unless
  `NETWORK=local`, and derives the private keys of #2 (payer) and #1 (facilitator) from the
  CP-5 mnemonic. Only `scripts/**` call it. 008's demo passes the payer key only to the L2 child
  and the facilitator key only to the facilitator child.
- **Rationale**: Env templates leave keys empty (007), so a fresh checkout can still run
  `npm run demo:local`. Derivation stays in `scripts/**`, outside the buyer layers, and the
  keys never touch disk, logs or `.local/deployment.json`.

## R8. Network profiles in `shared/config.ts`

- **Decision**: `networkProfile(name)` returns the CFG-1 fields. `local` reads
  `.local/deployment.json`, and its RPC falls back to `http://127.0.0.1:8545`.
  `base-sepolia` uses constants plus the `BASE_SEPOLIA_RPC_URL` and `FACILITATOR_URL`
  overrides.
- **Rationale**: One source for chain facts. L2 (allowed networks and assets), L3 (depth, safe
  tag, RPC) and the seller all read the same profile.
- **Gotcha**: Base Sepolia USDC's EIP-712 name is "USDC". Using "USD Coin" makes every
  signature fail verification (§16).
