# Implementation Plan: Counterparty Seller, Facilitator and Network Profiles

**Branch**: `006-counterparty-seller-network` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-counterparty-seller-network/spec.md`

## Summary

This feature builds the honest x402 counterparty and the networks it runs on:

- **Seller** (CP-1): an Express API on :4021. It has a free catalog and four priced routes,
  each priced with a single `exact` option.
- **Local facilitator** (CP-2): runs on :4022 for `NETWORK=local` only. It verifies and settles
  EIP-3009 authorizations on-chain and pays gas.
- **Hosted facilitator** (CP-3): on `base-sepolia` the seller uses `https://x402.org/facilitator`.
- **MockUSDC** (CP-4): an EIP-3009 token, deployed only on a local ganache chain.
- **Local chain** (CP-5): fixed mnemonic accounts and a 10 USDC mint to the payer.

The feature also owns the network profiles (CFG-1) and the x402 v2 wire-header contract
(§10). Every other feature links to that contract.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, NodeNext) on Node.js 22.x ESM. Solidity 0.8.24 for `MockUSDC.sol`.

**Primary Dependencies**:
- Seller: `@x402/express` 2.28.0 (`paymentMiddleware`, `x402ResourceServer`), `@x402/core/server` (`HTTPFacilitatorClient`), `@x402/evm/exact/server` (`ExactEvmScheme`).
- Facilitator: `@x402/core/facilitator` (`x402Facilitator`), `@x402/evm` (`toFacilitatorEvmSigner`), `@x402/evm/exact/facilitator` (`ExactEvmScheme`).
- Shared: viem ^2.57, express ^5.3, dotenv ^18.
- Local chain (dev only): ganache 7.9.2 (hardfork `shanghai`) and solc 0.8.24 (`evmVersion: shanghai`, optimizer 200 runs).

**Storage**: `.local/deployment.json` (gitignored), written by the local chain setup and read by `networkProfile("local")`.

**Testing**: vitest ^5.0. `test/e2e.local.test.ts` covers T-E2E-01 (payee delta 6000) and T-E2E-03 (forged `PAYMENT-RESPONSE` injection). Milestone checks M2 (payer balance 10 USDC) and M3 (unpaid GET returns 402 with a decodable challenge).

**Target Platform**: Node.js 22 server processes on macOS/Linux, plus a local ganache chain on :8545 or the public Base Sepolia RPC.

**Project Type**: Web services (seller, facilitator), a Solidity contract, and a dev-chain script.

**Performance Goals**: Not throughput-bound. A settle call waits at most 30 s for on-chain confirmation.

**Constraints**:
- Exactly 1 `accepts` entry per priced route, with `maxTimeoutSeconds` 120.
- Prices are explicit `AssetAmount` values with the EIP-712 domain in `extra`, never `"$"` strings.
- The catalog is mounted before the payment middleware.
- The facilitator refuses non-`local` networks.
- MockUSDC and the facilitator key are local-only.

**Scale/Scope**: 2 services, 1 contract, 1 chain script and 2 network profiles. Defaults:

| Item | Default |
|---|---|
| Seller port | 4021 (`SELLER_PORT`) |
| Facilitator port | 4022 (`FACILITATOR_PORT`) |
| Chain port | 8545 |

No `NEEDS CLARIFICATION` items. SPEC.md §5, §8.4, §9 and §10 pin every choice.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | INV-2 holds **unchanged**, with no exemption. Counterparty code lives in `src/counterparty/`, imports only `src/shared/*`, never touches `PAYER_PRIVATE_KEY`, and never calls `privateKeyToAccount`/`mnemonicToAccount`. The facilitator key (`FACILITATOR_PRIVATE_KEY`, local only) becomes an account only in the entry point `scripts/facilitator.ts`, which passes a ready `LocalAccount` into the `src/counterparty/facilitator.ts` factory. The demo's dev keys are derived from the CP-5 mnemonic only in `scripts/local-chain-lib.ts`. | ✅ | ✅ [contracts/facilitator-api.md](contracts/facilitator-api.md) |
| II. Pure policy | Not applicable. The seller makes no buyer-side decisions, and its challenge is untrusted input to L2. | ✅ | ✅ |
| III. Ledger as source of truth | Not applicable. The counterparty keeps no buyer ledger. | ✅ | ✅ |
| IV. Trust the chain | MockUSDC emits the standard `Transfer` and `AuthorizationUsed` events. L3 relies on these events, not on the seller's response. | ✅ | ✅ [contracts/mockusdc-abi.md](contracts/mockusdc-abi.md) |
| V. Least privilege | The seller holds no secret (only `SELLER_PAY_TO`). The facilitator key is loaded only by `scripts/facilitator.ts` from `env/facilitator.env` (or handed to that child alone by the demo). The mnemonic is used only in `scripts/`. | ✅ | ✅ |
| VI. Exact money | Prices are atomic strings (`"1000"`, …). The 10 USDC mint is `10_000_000n`. | ✅ | ✅ |
| VII. Protocol fidelity | x402 v2 `exact`. All three headers go through the SDK. The EIP-712 domain in `extra` matches the token on each network ("USD Coin" vs "USDC"). | ✅ | ✅ [contracts/x402-wire.md](contracts/x402-wire.md) |
| VIII. Proven safety | M2 and M3 exit criteria, the T-E2E-01 payee delta, nonce replay rejection and the validity-window checks are all covered by tests. | ✅ | ✅ |

Result: **PASS**. The seller binds to all interfaces, unlike L2 and L3 which bind to loopback.
This is not a violation: Principle V's loopback rule covers the internal control and verifier
services, and the seller plays an external party (SPEC §3.1).

## Project Structure

### Documentation (this feature)

```text
specs/006-counterparty-seller-network/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── x402-wire.md          # §10 headers: canonical wire contract, linked by 001/002/005
│   ├── seller-api.md         # catalog + priced routes
│   ├── facilitator-api.md    # /supported /verify /settle
│   ├── mockusdc-abi.md       # EIP-3009 token surface + EIP-712 domain
│   └── network-profile.md    # CFG-1 profiles + .local/deployment.json schema
└── tasks.md                  # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
contracts/
└── MockUSDC.sol                 # CP-4 (local only)
scripts/
├── facilitator.ts               # CP-2 entry: loadEnv, local-only guard, privateKeyToAccount, listen :4022
├── local-chain-lib.ts           # ganache start, solc compile, deploy, mint 10 USDC to #2, write deployment,
│                                #   localDevKeys() for the demo (#1, #2; local only)
├── local-chain.ts               # CLI wrapper (npm run local:chain)
└── solc.d.ts                    # type shim
src/
├── shared/config.ts             # networkProfile(), deployment reader, formatAtomic (006); ports/URLs/tokens, loadEnv (007)
└── counterparty/
    ├── seller.ts                # CP-1 (CATALOG, paymentMiddleware), CP-3 URL selection
    └── facilitator.ts           # CP-2 factory createFacilitatorApp({account, rpcUrl, caip2}); no key handling
env/                             # templates owned by 007; verified here
├── seller.env.example           # NETWORK, SELLER_PAY_TO, FACILITATOR_URL?
└── facilitator.env.example      # NETWORK=local, FACILITATOR_PRIVATE_KEY (empty)
.local/deployment.json           # runtime artifact (gitignored)
```

**Structure Decision**: Use the single-project layout from SPEC.md §6, with one change accepted
through 008 T000 (SPEC v1.1 §3.1, §6): the facilitator entry point moves from
`src/counterparty/facilitator.ts` to `scripts/facilitator.ts`, and the `src/` file becomes a
key-free factory. This keeps INV-2 unchanged. This feature owns `src/counterparty/**`,
`scripts/facilitator.ts`, `contracts/MockUSDC.sol`, `scripts/local-chain*.ts`, and the
network-profile and `formatAtomic` parts of `src/shared/config.ts`. Ports, URLs, tokens and
`loadEnv()` in `config.ts` belong to 007; `env/*.env.example` belong to 007; npm scripts belong
to 008.

## Complexity Tracking

No constitution violations to justify.
