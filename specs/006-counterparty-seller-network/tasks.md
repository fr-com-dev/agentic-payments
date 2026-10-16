---

description: "Task list for 006-counterparty-seller-network"
---

# Tasks: Counterparty Seller, Facilitator and Network Profiles

**Input**: Design documents from `specs/006-counterparty-seller-network/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (x402-wire, seller-api, facilitator-api, mockusdc-abi, network-profile), quickstart.md

**Tests**: REQUESTED (constitution Principle VIII; spec references T-E2E-01, T-E2E-03 and milestones M2/M3). Test tasks come before implementation in every story phase and must fail first.

**Organization**: Tasks are grouped by user story so each can be implemented and tested independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label (US1–US4) for story-phase tasks only

## Path Conventions

Single project at the repository root (SPEC.md §6). This feature owns `src/counterparty/**`,
`scripts/facilitator.ts` (the facilitator entry point), `contracts/MockUSDC.sol`,
`scripts/local-chain*.ts`, `scripts/solc.d.ts`, and the network-profile and `formatAtomic`
parts of `src/shared/config.ts`. It does **not** own `package.json` scripts (008 T002),
`env/*.env.example` (007 T044–T049) or `requireRole`/`loadEnv` (007). New counterparty unit
tests go in `test/counterparty.test.ts` (accepted into SPEC §6/§12 by 008 T000); this feature
adds only its own cases to the shared `test/e2e.local.test.ts`.

**INV-2 (unchanged)**: no file under `src/counterparty/**` calls `privateKeyToAccount` or
`mnemonicToAccount`. The facilitator account is derived in `scripts/facilitator.ts` and passed
into the `src/counterparty/facilitator.ts` factory as a ready viem `LocalAccount`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and folders for the counterparty and local chain

- [X] T001 Verify package.json lists the counterparty dependencies: `@x402/core`, `@x402/evm`, `@x402/express` pinned at 2.28.0, viem ^2.57, express ^5.3, and the dev-only ganache 7.9.2 and solc 0.8.24 (owned by 008 T001/T002; raise a contract-change request there if anything is missing)
- [X] T002 Verify the package.json npm scripts (owned by 008 T002): `seller` → `tsx src/counterparty/seller.ts`, `facilitator` → `tsx scripts/facilitator.ts`, `local:chain` → `tsx scripts/local-chain.ts`
- [X] T003 [P] Verify env/seller.env.example (owned by 007 T044–T049) contains `NETWORK`, `SELLER_PAY_TO` and optional `FACILITATOR_URL`, following 007's key and `# local only` conventions
- [X] T004 [P] Verify env/facilitator.env.example (owned by 007 T044–T049) contains `NETWORK=local` and an empty `FACILITATOR_PRIVATE_KEY` per 007's key convention, marked local only. The demo supplies account #1's key via T046, not via the template
- [X] T005 [P] Ensure `.local/` is in .gitignore (it holds `deployment.json`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Network profiles, the mock token and the local chain. Every story depends on these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests for the foundation ⚠️

- [X] T006 [P] Write network-profile tests in test/counterparty.test.ts:
  - `local` gives caip2 `eip155:31337`, chainId 31337, assetDomain `{"USD Coin","2"}`, confirmationDepth 1, supportsSafeTag false.
  - `base-sepolia` gives caip2 `eip155:84532`, chainId 84532, asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, assetDomain `{"USDC","2"}`, confirmationDepth 2, supportsSafeTag true.
  - An unknown name throws.
  - `BASE_SEPOLIA_RPC_URL` and `FACILITATOR_URL` overrides apply.
- [X] T007 [P] Write a deployment-fallback test in test/counterparty.test.ts. With `.local/deployment.json` missing, `local.rpcUrl` is `http://127.0.0.1:8545` and any consumer that needs `local.asset` fails fast.

### Implementation for the foundation

- [X] T008 Implement `networkProfile(name?)` in src/shared/config.ts with every CFG-1 field from data-model.md.
  - Selection is "`NETWORK`, default `local`. An unknown name throws."
  - `decimals` is 6 on both networks.
  - Leave ports, URLs and tokens to 007.
- [X] T009 Implement the `.local/deployment.json` reader in src/shared/config.ts. The fields are `chainId`, `rpcUrl`, `asset`, `accounts{deployer, facilitator, payer, sellerPayTo}` and `deployedAt`, and the file "holds addresses only, never private keys".
- [X] T044 [P] Write the `formatAtomic` test in test/counterparty.test.ts: `formatAtomic("6000", 6)` is `"0.006"`, `formatAtomic("1000000", 6)` is `"1"`, `formatAtomic("0", 6)` is `"0"`, a non-integer string throws, and the function uses BigInt only (no `Number` conversion of the amount)
- [X] T045 Implement `formatAtomic(amountAtomic: string, decimals: number): string` in src/shared/config.ts with BigInt math only (Principle VI). 006 owns it; 001 (`amountUsd`) and 008 (demo summary) consume it
- [X] T010 [P] Write contracts/MockUSDC.sol.
  - Metadata: ERC-20 with name "USD Coin", symbol "USDC", `version()` "2" and 6 decimals.
  - Owner-only `mint`.
  - EIP-712 domain `(name, version, chainId, verifyingContract)` and `DOMAIN_SEPARATOR()`.
  - Both `transferWithAuthorization` overloads, `(…,v,r,s)` and `(…,bytes signature)`, plus `authorizationState(authorizer, nonce)`.
  - Revert conditions: `block.timestamp <= validAfter`, `block.timestamp >= validBefore`, a used nonce, a signer that is not `from`, and an insufficient balance.
  - On success, emit `AuthorizationUsed` and `Transfer`.
- [X] T011 [P] Add the solc type shim in scripts/solc.d.ts
- [X] T012 Implement scripts/local-chain-lib.ts:
  - Start ganache on :8545 with chainId 31337, hardfork `shanghai` and the fixed mnemonic.
  - Compile MockUSDC with solc 0.8.24 (`evmVersion: shanghai`, optimizer 200 runs).
  - Deploy MockUSDC from account #0.
  - Call `mint(#2, 10_000_000n)`.
  - Write `.local/deployment.json`. Regenerate it on every start.

- [X] T046 Export `localDevKeys()` from scripts/local-chain-lib.ts. On `NETWORK=local` only (throws otherwise), it derives the private keys of account #2 (payer) and #1 (facilitator) from the CP-5 mnemonic with `mnemonicToAccount(...).getHdKey()`. It is consumed only by `scripts/**`: 008 T015 passes the payer key **only** to the L2 child as `PAYER_PRIVATE_KEY`, and the facilitator key only to the facilitator child. Keys are never written to `.local/deployment.json`, logs or env templates. This lives in `scripts/**`, so INV-2 is untouched

**Checkpoint**: profiles resolve and a local chain with MockUSDC can be started programmatically.

---

## Phase 3: User Story 1 - Seller charges for resources with x402 (Priority: P1) 🎯 MVP

**Goal**: a conformant x402 v2 seller: a free catalog and four priced routes, each with a single `exact` option.

**Independent Test**: an unpaid GET to a priced route returns 402 with a decodable `PAYMENT-REQUIRED` that has exactly 1 option (M3). A paid GET returns 200 with a decodable `PAYMENT-RESPONSE` (T-E2E-01).

### Tests for User Story 1 ⚠️

- [X] T013 [P] [US1] Write the M3 challenge test in test/counterparty.test.ts. For each of the 4 priced routes, the unpaid GET returns 402. Decoded with `decodePaymentRequiredHeader`, the header has `x402Version` 2 and exactly 1 `accepts` entry with these values:
  - scheme `"exact"`
  - network `net.caip2`
  - asset `net.asset`
  - amount `"1000"`, `"5000"`, `"50000"` or `"500000"`
  - payTo `SELLER_PAY_TO`
  - maxTimeoutSeconds `120`
  - extra `net.assetDomain`
- [X] T014 [P] [US1] Write the catalog test in test/counterparty.test.ts. `GET /api/catalog` returns 200, never 402, with `{network, asset, decimals: 6, items}`. There are 4 items, each `priceAtomic` "is a positive integer string", and the prices match the CATALOG table.
- [X] T015 [P] [US1] Write the mount-order test in test/counterparty.test.ts. Show that the catalog test (T014) fails, with a 402 or an error, when the catalog is registered after the payment middleware. The catalog is safe only because of mount order (research R3).
- [X] T016 [P] [US1] Write the determinism test in test/counterparty.test.ts.
  - Two paid weather calls for `city=Lima` return identical `{city, tempC, condition, source}`.
  - The market brief has exactly 3 bullets.
  - The premium report has `pages: 42`.
  - The dataset export has `rows: 1000000`.
  - The query string never affects the price.
- [X] T017 [US1] Add the seller cases to test/e2e.local.test.ts (T-E2E-01, owned by 008). Each paid response carries a `PAYMENT-RESPONSE` that decodes to `{success:true, transaction, network, payer}`. The seller payTo (#3) balance rises by exactly 6000 atomic (SC-002).

### Implementation for User Story 1

- [X] T018 [US1] Define `CATALOG` in src/counterparty/seller.ts with the 4 routes, atomic string prices and descriptions from data-model.md
- [X] T019 [US1] Implement the deterministic mock handlers in src/counterparty/seller.ts:
  - weather: the seed is the sum of the char codes of `city`; `tempC = seed % 35`; `condition = ["sunny","cloudy","rain","fog"][seed % 4]`.
  - The other three routes return constant bodies.
- [X] T020 [US1] Mount `GET /api/catalog` in src/counterparty/seller.ts before the payment middleware. It returns `{network, asset, decimals, items:[{path, priceAtomic, description}]}`.
- [X] T021 [US1] Wire `x402ResourceServer(new HTTPFacilitatorClient({url: net.facilitatorUrl})).register(net.caip2, new ExactEvmScheme())` and `paymentMiddleware` in src/counterparty/seller.ts.
  - Each route gets one option: `{scheme:"exact", network, payTo, maxTimeoutSeconds:120, price:{asset: net.asset, amount, extra: net.assetDomain}}`.
  - Use an explicit `AssetAmount`, never a `"$"` string.
- [X] T022 [US1] Start the seller in src/counterparty/seller.ts on `SELLER_PORT` (default 4021), bound to all interfaces, with env loaded through `loadEnv()` from src/shared/config.ts (007; reads `ENV_FILE`)

**Checkpoint**: M3 passes. Unpaid requests get a decodable single-option 402, and the catalog is free.

---

## Phase 4: User Story 2 - Local end-to-end network with real on-chain settlement (Priority: P1)

**Goal**: a local chain with a funded payer and a local facilitator that verifies and settles EIP-3009 authorizations, paying gas.

**Independent Test**: after `npm run local:chain`, the payer balance is exactly `10000000` and the deployment record exists (M2). The facilitator settles a valid authorization and refuses to start on non-local networks.

### Tests for User Story 2 ⚠️

- [X] T023 [P] [US2] Write the M2 test in test/counterparty.test.ts:
  - After local chain startup, `balanceOf(#2)` equals `10000000` (SC-003).
  - `.local/deployment.json` matches the contracts/network-profile.md schema and contains no private keys.
  - The roles are #0 deployer, #1 facilitator, #2 payer and #3 sellerPayTo.
- [X] T024 [P] [US2] Write the facilitator API tests in test/counterparty.test.ts:
  - `GET /supported` lists `{x402Version:2, scheme:"exact", network:"eip155:31337"}`.
  - A malformed `POST /verify` body returns 400 with `{isValid:false, invalidReason}`, never a 500.
  - A failing `POST /settle` returns 400 with `{success:false, errorReason}`.
- [X] T025 [P] [US2] Write the facilitator network-guard test in test/counterparty.test.ts. Spawning `scripts/facilitator.ts` with `NETWORK=base-sepolia` exits non-zero with a "local only" message, before any key is read. Show that the test fails when the startup guard is removed (NFR-003). The facilitator API tests (T024) build the app through the T028 factory with a test account, without spawning the entry.

### Implementation for User Story 2

- [X] T026 [US2] Implement the scripts/local-chain.ts CLI wrapper around local-chain-lib. It keeps ganache running and filters the harmless `uws_linux` warning.
- [X] T027 [US2] Create the facilitator entry point scripts/facilitator.ts:
  - Load env through `loadEnv()` (007), which reads `ENV_FILE=env/facilitator.env`.
  - Exit non-zero with a "local only" message unless `NETWORK === "local"`, before reading any key.
  - Derive the account with `privateKeyToAccount(FACILITATOR_PRIVATE_KEY)`. This is the **only** place the facilitator key becomes an account; it is in `scripts/**`, outside the buyer layers.
  - Call `createFacilitatorApp({ account, rpcUrl: net.rpcUrl, caip2: net.caip2 })` (T028) and listen on `FACILITATOR_PORT` (default 4022).
- [X] T028 [US2] Implement the factory `createFacilitatorApp({ account, rpcUrl, caip2 }): express.Express` in src/counterparty/facilitator.ts. `account` is a ready viem `LocalAccount`; the file must not import or call `privateKeyToAccount`/`mnemonicToAccount` and must not read `FACILITATOR_PRIVATE_KEY` (INV-2). Build a viem wallet client with public actions for `account` and call `x402Facilitator().register(caip2, new ExactEvmScheme(toFacilitatorEvmSigner({...walletWithPublicActions, address: account.address}, {confirmationTimeoutMs: 30000})))`.
- [X] T029 [US2] In the T028 factory in src/counterparty/facilitator.ts, register `GET /supported`, `POST /verify` and `POST /settle`. The factory returns the app and does not call `listen` (T027 does).
  - Request body: `{x402Version, paymentPayload, paymentRequirements}`.
  - Map every exception to a 400 with the matching x402-shaped error body (accepted into SPEC CP-2 by 008 T000).

**Checkpoint**: M2 passes. With US1, the T-E2E-01 paid steps settle on-chain (payee +6000).

---

## Phase 5: User Story 3 - Testnet operation on Base Sepolia (Priority: P2)

**Goal**: switching `NETWORK=base-sepolia` uses Circle testnet USDC and the hosted facilitator, changing only configuration.

**Independent Test**: with `NETWORK=base-sepolia`, the seller's challenge has network `eip155:84532` and `extra.name` `"USDC"`, and its facilitator URL is `https://x402.org/facilitator`.

### Tests for User Story 3 ⚠️

- [X] T030 [P] [US3] Write the Base Sepolia challenge test in test/counterparty.test.ts. With `NETWORK=base-sepolia`, an in-process seller's 402 challenge has network `eip155:84532`, asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e` and `extra` `{name:"USDC", version:"2"}`. No chain access is needed.
- [X] T031 [P] [US3] Write the EIP-712 name regression test in test/counterparty.test.ts. The `base-sepolia` domain name is `"USDC"` and the `local` name is `"USD Coin"`. A profile using `"USD Coin"` on base-sepolia fails this test (§16 gotcha).
- [X] T032 [P] [US3] Write the facilitator URL selection test in test/counterparty.test.ts. Without `FACILITATOR_URL`, the seller targets `https://x402.org/facilitator` on base-sepolia and `http://127.0.0.1:4022` on local. The override wins on both.

### Implementation for User Story 3

- [X] T033 [US3] Ensure src/counterparty/seller.ts takes the facilitator URL, asset and domain only from `networkProfile()`, with no network-specific branches in the seller (CP-3, SC-005)
- [X] T034 [US3] Document the Base Sepolia run in env/seller.env.example comments: `NETWORK=base-sepolia`, no local facilitator, and a payer funded through faucet.circle.com

**Checkpoint**: switching networks is configuration-only (SC-005).

---

## Phase 6: User Story 4 - Mock token behaves like USDC's EIP-3009 (Priority: P2)

**Goal**: MockUSDC matches USDC's `transferWithAuthorization` behavior, so signing and settlement are the same locally and on testnet.

**Independent Test**: sign authorizations for the mock's EIP-712 domain. Both overloads succeed, replay and out-of-window authorizations revert, and a non-owner `mint` reverts.

### Tests for User Story 4 ⚠️

- [X] T035 [P] [US4] Write the EIP-3009 success test in test/counterparty.test.ts. A valid authorization moves funds through the `(v,r,s)` overload, and another through the `bytes signature` overload. Each emits `AuthorizationUsed` and `Transfer(from, to, value)`.
- [X] T036 [P] [US4] Write the replay test in test/counterparty.test.ts. Resubmitting a used nonce reverts, and `authorizationState(authorizer, nonce)` returns `true`. Replay succeeds 0 times (SC-004). Show that the test fails if the nonce check is removed from MockUSDC.
- [X] T037 [P] [US4] Write the validity-window test in test/counterparty.test.ts. The token rejects `block.timestamp <= validAfter` and `block.timestamp >= validBefore`. Show that the test fails if the window check is removed.
- [X] T038 [P] [US4] Write the access and signature test in test/counterparty.test.ts. `mint` from a non-owner reverts, and an authorization signed by an account other than `from` reverts.

### Implementation for User Story 4

- [X] T039 [US4] Fix any MockUSDC behavior gaps that T035–T038 find in contracts/MockUSDC.sol. Keep the metadata and domain unchanged so the challenge `extra` stays `{"USD Coin","2"}`.

**Checkpoint**: the token matches the contracts/mockusdc-abi.md surface and revert conditions.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T040 [P] Add a check to test/counterparty.test.ts that no file under src/counterparty/ hand-encodes or decodes base64 for x402 headers. All three headers go through the `@x402/core/http` helpers (NFR-001). The architecture rules themselves belong to 007.
- [X] T041 [P] Verify 007's architecture test passes for src/counterparty/** with **no** INV-2 exemption: it imports only `src/shared/*` and its own folder, never references `PAYER_PRIVATE_KEY`, and contains no `privateKeyToAccount`/`mnemonicToAccount` (owned by 007 rule A3)
- [ ] T042 Run every step of specs/006-counterparty-seller-network/quickstart.md and record the results
- [X] T043 Run `npm run typecheck` and `npm test`. Confirm the `npm run demo:local` summary is unchanged (`spent on-chain: 0.006 USDC`, `hash chain ok=true`).
- [X] T047 Verify that these SPEC.md extensions from this feature are covered by 008 T000 (SPEC.md v1.1), and update specs/006-counterparty-seller-network/ docs if T000 rejects any: `.local/deployment.json` schema and the missing-deployment fail-fast (CP-5, CFG-1); facilitator error bodies (CP-2); the weather seed formula (CP-1); MockUSDC extras `DOMAIN_SEPARATOR()`, wrong-signer and insufficient-balance reverts (CP-4); the new `test/counterparty.test.ts` (§6, §12); and the facilitator entry point moving to `scripts/facilitator.ts` with `src/counterparty/facilitator.ts` as a factory (§3.1, §6)

---

## Dependencies & Execution Order

### Phase dependencies

- **All tasks depend on 008 T000** (SPEC.md v1.1 amendment).
- Setup (Phase 1) needs 008's package.json scaffold (M0) and 007's env templates; its tasks are verification only.
- Foundational (Phase 2) depends on Setup and blocks every story.
- US1 (Phase 3) depends on Foundational. The unpaid challenge (T013–T016) is independent of US2. The paid-path case (T017) also needs US2 plus 001, 002 and 005.
- US2 (Phase 4) depends on Foundational. It is independent of US1 for M2 and the facilitator API tests.
- US3 (Phase 5) depends on US1 (the seller exists).
- US4 (Phase 6) depends on Foundational only (T010, T012).
- Polish depends on all stories.

### Cross-feature dependencies

- 008 owns the package.json scaffold and scripts (T002), the `test/e2e.local.test.ts` harness and demo-local. This feature adds only seller and payee-delta assertions. 008 T015 consumes `localDevKeys()` (T046); 008 T020 and 001 consume `formatAtomic` (T045).
- 007 owns `env/*.env.example`, `loadEnv()`, `requireRole`, the ports, URLs and tokens in `src/shared/config.ts`, and the architecture test (rule A3 has no facilitator exemption).
- 006 owns the M3 check (T013); 008 T033 references it.
- T017 (paid end to end) requires 001 (the L1 orchestrator), 002 (L2 signer) and 005 (L3 verifier).
- 002 and 005 consume `networkProfile()` (caip2, asset, assetDomain, rpcUrl, confirmationDepth, supportsSafeTag). Changing profile fields affects them.

### Within each story

Tests are written first and must fail before implementation. Models and config come before services, and services before endpoints.

---

## Parallel Example: User Story 1

```bash
# Seller tests (all in test/counterparty.test.ts, separate describe blocks):
Task: "T013 M3 challenge test"
Task: "T014 catalog test"
Task: "T015 mount-order test"
Task: "T016 determinism test"
```

## Parallel Example: User Story 4

```bash
Task: "T035 EIP-3009 success (both overloads)"
Task: "T036 nonce replay (SC-004)"
Task: "T037 validity window"
Task: "T038 non-owner mint and wrong signer"
```

## Parallel Example: Setup / Foundational

```bash
Task: "T003 verify env/seller.env.example (007)"
Task: "T004 verify env/facilitator.env.example (007)"
Task: "T044 formatAtomic test"
Task: "T010 contracts/MockUSDC.sol"
Task: "T011 scripts/solc.d.ts"
```

---

## Implementation Strategy

### MVP first (P1 stories: US1 and US2)

1. Phase 1 Setup, then Phase 2 Foundational (profiles, MockUSDC, local chain).
2. Phase 3 US1 → validate M3 (unpaid 402, free catalog).
3. Phase 4 US2 → validate M2 (payer = 10 USDC) and facilitator settlement.
4. **STOP and VALIDATE**: with 001, 002 and 005 in place, T-E2E-01 shows the payee +6000.

### Incremental delivery

1. US1 + US2 → the local counterparty is complete (MVP; unblocks 008's demo).
2. US4 → token parity hardening.
3. US3 → testnet operation, configuration only.

### Notes

- `[P]` tasks touch different files or independent describe blocks with no ordering dependency.
- Never weaken an `INV-*` invariant to make a test pass.
- If a catalog route or price changes, update SPEC.md L1-4 and T-E2E-01 (owned by 008) in the same change.
