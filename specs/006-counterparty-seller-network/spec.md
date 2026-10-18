# Feature Specification: Counterparty Seller, Facilitator and Network Profiles

**Feature Branch**: `006-counterparty-seller-network`

**Created**: 2026-10-16

**Status**: Draft (derived from SPEC.md v1.0; implemented PoC)

**Input**: Derived from SPEC.md §8.4 (CP-1..CP-5), §9 CFG-1, §10 (wire formats) and §16 (EIP-712 name gotcha)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Seller charges for resources with x402 (Priority: P1)

A seller exposes paid HTTP resources. An unpaid request gets an HTTP 402 challenge that
describes exactly one way to pay. A request carrying a valid payment signature is verified
and settled through a facilitator, and then the resource is served with a payment response.

**Why this priority**: Without a conformant x402 counterparty there is nothing for the agent
to buy.

**Independent Test**: An unpaid request to a priced route returns 402 with a decodable
payment challenge. A paid request returns 200 with a decodable payment response. This is
milestone M3 and is exercised by T-E2E-01.

**Acceptance Scenarios**:

1. **Given** an unpaid request to `/api/weather?city=Lima`, **When** it is sent, **Then** the response is 402 with a `PAYMENT-REQUIRED` challenge containing exactly one option: scheme `exact`, the active network, the seller's payee, `maxTimeoutSeconds` 120, the network's asset, amount 1000, and the token's EIP-712 domain in `extra`.
2. **Given** a request with a valid `PAYMENT-SIGNATURE`, **When** it is sent, **Then** the seller verifies and settles it through the facilitator and returns 200 with the resource and a `PAYMENT-RESPONSE` of {success, transaction, network, payer}.
3. **Given** a request to `/api/catalog`, **When** it is sent, **Then** it is served free (never 402) and lists the network, asset, decimals and every priced item with its path, atomic price and description.

---

### User Story 2 - Local end-to-end network with real on-chain settlement (Priority: P1)

An agent developer runs the whole system on a local dev chain. The chain has an
EIP-3009-capable mock USDC, a funded payer, a local facilitator that pays gas, and fixed
well-known accounts.

**Why this priority**: The regression baseline and all e2e tests run locally.

**Independent Test**: Start the local chain. The token deploys, the payer holds 10 USDC, and
the deployment record is written. Milestone M2.

**Acceptance Scenarios**:

1. **Given** a fresh local chain, **When** it starts, **Then** the mock USDC is deployed and 10 USDC (10,000,000 atomic) is minted to the payer account. The deployment (RPC, asset address, accounts) is recorded for the other processes.
2. **Given** the fixed dev mnemonic, **Then** the account roles are: #0 deployer, #1 facilitator, #2 payer (held by L2), #3 seller payee.
3. **Given** the local facilitator, **When** it receives verify or settle requests for a valid EIP-3009 authorization, **Then** it verifies the authorization and settles it on-chain, paying gas, waiting up to 30 s for confirmation.
4. **Given** the facilitator is started with a network other than `local`, **Then** it exits.

---

### User Story 3 - Testnet operation on Base Sepolia (Priority: P2)

An agent developer switches the network to `base-sepolia`. The system uses Circle's testnet
USDC and the hosted facilitator, with no local facilitator.

**Why this priority**: This shows the design works on a public chain. It is secondary to the
local baseline.

**Independent Test**: With `NETWORK=base-sepolia` and a funded payer, a paid request settles
through the hosted facilitator and is verified on Base Sepolia.

**Acceptance Scenarios**:

1. **Given** `base-sepolia`, **Then** the profile is chain 84532 (`eip155:84532`), asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, EIP-712 domain {name "USDC", version "2"}, confirmation depth 2, and safe tag supported.
2. **Given** no facilitator override, **Then** the seller uses `https://x402.org/facilitator`. *(Amended by 009, SPEC v1.2: on `base-sepolia` the default is now the CDP facilitator; x402.org is the explicit `FACILITATOR=public` choice. See specs/009-cdp-facilitator-base-sepolia.)*
3. **Given** the EIP-712 name is set to "USD Coin" on Base Sepolia, **Then** signatures fail verification. The profile MUST use "USDC".

---

### User Story 4 - Mock token behaves like USDC's EIP-3009 (Priority: P2)

The local mock token behaves like real USDC for `transferWithAuthorization`, so that
signatures and settlement behave the same locally and on testnet.

**Independent Test**: Sign an authorization for the mock's EIP-712 domain and submit it in
both signature forms. Check the validity window, nonce replay rejection and emitted events.

**Acceptance Scenarios**:

1. **Given** a valid authorization, **When** it is submitted (as v/r/s or as packed signature bytes), **Then** the funds move and both `AuthorizationUsed` and `Transfer` are emitted.
2. **Given** an authorization whose nonce was already used, **When** it is resubmitted, **Then** it is rejected, and `authorizationState(authorizer, nonce)` reports it used.
3. **Given** the current time is not strictly between `validAfter` and `validBefore`, **Then** it is rejected.
4. **Given** a non-owner, **When** it calls mint, **Then** it is rejected.

### Edge Cases

- A catalog request must never be intercepted by payment handling, because it is registered before the payment layer.
- The weather route uses a `city` query parameter. The response is deterministic per city, and the query string does not change the price.
- A facilitator exception becomes an HTTP 400 with an x402-shaped error body, not a 500.
- A missing local deployment record means the local asset address and RPC cannot be resolved. The RPC falls back to `http://127.0.0.1:8545`.
- A wrong EIP-712 domain name in the challenge `extra` (for example "USD Coin" on Base Sepolia) causes signature verification failures.

## Requirements *(mandatory)*

### Functional Requirements

**Seller (CP-1)**

- **FR-001**: The seller MUST register the x402 `exact` scheme for the active network and use the network profile's facilitator for verification and settlement. *(SPEC: CP-1)*
- **FR-002**: Each priced route MUST offer exactly one payment option: scheme `exact`, the active network, the configured payee, `maxTimeoutSeconds` 120, and an explicit asset amount (asset address, atomic amount, EIP-712 domain in `extra`), not a dollar-string price. *(SPEC: CP-1)*
- **FR-003**: `GET /api/catalog` MUST be free and mounted before the payment layer. It returns {network, asset, decimals, items:[{path, priceAtomic, description}]}. *(SPEC: CP-1)*
- **FR-004**: The priced routes and amounts MUST be:
  - `/api/weather?city=` — 1000
  - `/api/market-brief` — 5000
  - `/api/premium-report` — 50000
  - `/api/dataset-export` — 500000

  *(SPEC: CP-1 table)*
- **FR-005**: The route bodies MUST be deterministic mocks:
  - weather: {city, tempC, condition, source}, seeded from the city's characters
  - market brief: {headline, bullets (exactly 3), source}
  - premium report: {title, pages = 42, source}
  - dataset export: {rows = 1000000, source}

  *(SPEC: CP-1 table)*

**Facilitator (CP-2, CP-3)**

- **FR-006**: The local facilitator MUST run only when the network is `local` and MUST exit otherwise. *(SPEC: CP-2)*
- **FR-007**: The local facilitator MUST expose `GET /supported`, `POST /verify` and `POST /settle`. The request body is {x402Version, paymentPayload, paymentRequirements}. *(SPEC: CP-2)*
- **FR-008**: Facilitator exceptions MUST map to HTTP 400 with an x402-shaped error body. *(SPEC: CP-2)*
- **FR-009**: The local facilitator MUST submit settlement on-chain from its own account, paying gas, and wait up to 30 s for confirmation. *(SPEC: CP-2)*
- **FR-010**: On `base-sepolia`, the seller MUST use the facilitator override if set, otherwise `https://x402.org/facilitator`. No local facilitator runs. *(SPEC: CP-3, CFG-1)* *(Amended by 009, SPEC v1.2: on `base-sepolia` the default is now the CDP facilitator; x402.org is the explicit `FACILITATOR=public` choice. See specs/009-cdp-facilitator-base-sepolia.)*

**Mock token (CP-4) and local accounts (CP-5)**

- **FR-011**: The mock token MUST be an ERC-20 with name "USD Coin", symbol "USDC", version "2", 6 decimals and owner-only minting. *(SPEC: CP-4)*
- **FR-012**: The mock token MUST implement EIP-3009 `transferWithAuthorization` in both the (v, r, s) and the packed-signature forms. It uses the EIP-712 domain (name, version, chainId, verifyingContract) and exposes `authorizationState(authorizer, nonce)`. *(SPEC: CP-4)*
- **FR-013**: The mock token MUST reject authorizations outside `validAfter < now < validBefore` and authorizations with a used nonce, and MUST emit `AuthorizationUsed` and `Transfer` on success. *(SPEC: CP-4)*
- **FR-014**: The local chain setup MUST use the fixed dev mnemonic with roles #0 deployer, #1 facilitator, #2 payer and #3 seller payee, mint 10 USDC to #2, and record the deployment for other processes. *(SPEC: CP-5, §6)*

**Network profiles (CFG-1)**

- **FR-015**: The network MUST be selected by name, defaulting to `local`. The profile fields MUST be:

  | Field | local | base-sepolia |
  |---|---|---|
  | CAIP-2 / chain ID | `eip155:31337` / 31337 | `eip155:84532` / 84532 |
  | RPC | from the deployment record, else `http://127.0.0.1:8545` | the RPC override, else `https://sepolia.base.org` |
  | Asset | from the deployment record | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
  | Asset domain | {"USD Coin", "2"} | {"USDC", "2"} |
  | Facilitator | the override, else `http://127.0.0.1:4022` | the override, else `https://x402.org/facilitator` |

  *(Amended by 009, SPEC v1.2: the base-sepolia facilitator row applies to `FACILITATOR=public`; the default is CDP, `https://api.cdp.coinbase.com/platform/v2/x402`.)*
  | Confirmation depth | 1 | 2 |
  | Safe tag supported | false | true |

  *(SPEC: CFG-1, §16)*

**Wire formats (§10)**

- **FR-016**: The 402 challenge MUST be carried in `PAYMENT-REQUIRED` as {x402Version: 2, resource:{url,…}, accepts:[requirements], extensions?}. *(SPEC: §10)*
- **FR-017**: The payment MUST be carried in `PAYMENT-SIGNATURE` as {x402Version: 2, accepted, payload:{signature, authorization:{from, to, value, validAfter, validBefore, nonce}}}. *(SPEC: §10)*
- **FR-018**: The settlement result MUST be carried in `PAYMENT-RESPONSE` as {success, transaction, network, payer, errorReason?}. *(SPEC: §10)*

### Non-Functional Requirements

- **NFR-001 (Protocol fidelity)**: All three headers MUST be encoded and decoded only with the official x402 SDK helpers, never with hand-rolled base64. *(SPEC: §10, CLAUDE.md rule 9)*
- **NFR-002 (Interoperability)**: The challenge's EIP-712 domain MUST match the token's on-chain domain on each network ("USD Coin" locally, "USDC" on Base Sepolia). *(SPEC: §16, CFG-1)*
- **NFR-003 (Safety of test assets)**: The mock token and local facilitator key MUST be used only on the local network, never on a public chain. Mainnet is out of scope. *(SPEC: CP-4 "Local only", §1.3)*
- **NFR-004 (Determinism)**: Mock resource bodies MUST be deterministic for the same input so that regression runs are reproducible. *(SPEC: CP-1)*
- **NFR-005 (Exactness)**: Prices MUST be atomic-unit decimal strings (USDC has 6 decimals; 1000 = $0.001). *(SPEC: §2, §7)*
- **NFR-006 (Operability)**: The default ports MUST be seller 4021 (all interfaces) and facilitator 4022, both overridable by configuration (`SELLER_PORT`, `FACILITATOR_PORT`). The local chain port is fixed at 8545 and is not overridable. *(SPEC: §3.1)*
- **NFR-007 (Timeouts)**: The facilitator's on-chain confirmation timeout MUST be 30 s. *(SPEC: CP-2)*

### Key Entities

- **Catalog Item**: a priced path, its atomic price and a description.
- **Payment Requirement (accepts entry)**: scheme, network, asset, amount, payee, max timeout, and `extra` (EIP-712 domain).
- **Network Profile**: CAIP-2 ID, chain ID, RPC, asset, asset domain, facilitator URL, confirmation depth and safe-tag support.
- **EIP-3009 Authorization**: from, to, value, validAfter, validBefore, nonce, and a signature over the token's EIP-712 domain.
- **Local Deployment Record**: RPC, asset address and role accounts for the local chain.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of unpaid requests to the 4 priced routes return 402 with a decodable challenge containing exactly 1 option. 0% of catalog requests return 402.
- **SC-002**: After the scripted run, the seller's payee balance increases by exactly 6000 atomic units (0.006 USDC). *(T-E2E-01)*
- **SC-003**: After local chain startup, the payer balance is exactly 10 USDC (10,000,000 atomic). *(M2)*
- **SC-004**: Replaying a used EIP-3009 authorization succeeds 0 times.
- **SC-005**: Switching between `local` and `base-sepolia` requires only a configuration change: the network name and the env files.

## Assumptions

- The seller and facilitator are counterparties outside the buyer's trust boundary. The buyer side (features 002 and 005) defends against a malicious seller, and this feature only models honest behavior. Forged responses are injected by tests.
- The hosted Base Sepolia facilitator is trusted for liveness only. This is an accepted residual risk (SPEC §11).
- On Base Sepolia, the payer is funded with test USDC from a faucet before use.
- Out of scope: the `upto` scheme (EXT-3), Solana (EXT-4), mainnet, and refunds (EXT-9).
- How the seller challenge is consumed by the agent is in 001-agent-paid-fetch. How the verifier uses the profile's depth and safe tag is in 005-settlement-verification.
- HOW is in SPEC.md §8.4, §9 and §10.
