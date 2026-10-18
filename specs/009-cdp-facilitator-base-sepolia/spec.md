# Feature Specification: CDP Facilitator on Base Sepolia

**Feature Branch**: `009-cdp-facilitator-base-sepolia`

**Created**: 2026-10-17

**Status**: Draft

**Input**: User description: "CDP facilitator on Base Sepolia: the seller (counterparty) verifies and settles x402 v2 `exact` EIP-3009 USDC payments on Base Sepolia (eip155:84532) through Coinbase Developer Platform's authenticated hosted x402 facilitator, using a CDP API key (key ID + secret) instead of the unauthenticated public x402.org facilitator. Scope is facilitator only: L2 keeps signing with its local payer key, L1 and L3 are unchanged in authority, and the CDP Server Wallet (EXT-2) is out of scope. The CDP API key is a new secret held only by the seller process. The local demo must stay unchanged."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Paid fetch on Base Sepolia settles through CDP (Priority: P1)

An agent developer runs the system on Base Sepolia. The seller sends every verification and
settlement to Coinbase Developer Platform's (CDP) hosted x402 facilitator and authenticates
with the developer's CDP API key. L2 signs exactly as before, and L3 confirms each payment
from on-chain evidence. The payer needs test USDC only, because CDP pays gas.

**Why this priority**: This is the feature. It moves the testnet path from the best-effort
public facilitator to the authenticated service that CDP also runs on mainnet.

**Independent Test**: Run the scripted plan live on Base Sepolia with CDP credentials, using
the opt-in acceptance run. The outcomes match T-E2E-01: the payee balance rises by exactly
6000 atomic, two settlements are CONFIRMED, and the hash chain verifies.

**Acceptance Scenarios**:

1. **Given** the seller on `base-sepolia` with CDP selected and valid credentials, **When** an unpaid request reaches a priced route, **Then** the 402 challenge has the same shape as with any other facilitator. It holds exactly one option: scheme `exact`, `eip155:84532`, Base Sepolia USDC, EIP-712 domain {"USDC", "2"}, `maxTimeoutSeconds` 120.
2. **Given** a valid `PAYMENT-SIGNATURE`, **When** the paid retry reaches the seller, **Then** the seller verifies and settles it through CDP. It returns 200 with the resource and a `PAYMENT-RESPONSE` of {success, transaction, network `eip155:84532`, payer}.
3. **Given** that payment response, **When** L3 verifies it, **Then** L3 confirms it from on-chain evidence alone: a successful receipt plus a Transfer that matches payer, payee, amount and asset. Which account submitted the transaction is not part of the check.
4. **Given** the scripted plan, **When** it runs live through CDP, **Then** the outcomes are `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`, the payee balance rises by exactly 6000 atomic, two settlements are CONFIRMED and the hash chain verifies.
5. **Given** a payer that holds test USDC and no native ETH, **When** its payments settle through CDP, **Then** they succeed, and the payer's ETH balance does not change.

---

### User Story 2 - The CDP credential stays with the seller and fails closed (Priority: P1)

An operator provisions a CDP API key for the seller. The key reaches only the seller process.
A missing, empty or rejected key stops paid traffic before any payment is signed. The seller
never falls back silently to an unauthenticated facilitator.

**Why this priority**: The system exists to separate credentials (Principle V). A new
third-party secret must not weaken that separation, and a misconfiguration must not cost the
payer money.

**Independent Test**: Offline. Run the architecture and env-template checks, then start the
seller with missing credentials and against a stub facilitator that rejects authentication.
No network access or real CDP key is needed.

**Acceptance Scenarios**:

1. **Given** `base-sepolia` with CDP selected and the key ID or the secret missing or empty, **When** the seller starts, **Then** it exits non-zero with an error that names the missing setting and contains no secret value.
2. **Given** credentials that the facilitator rejects (revoked or wrong), **When** a priced route is requested, **Then** the seller answers 503 with the reason category "authentication", issues no challenge, and the agent asks L2 for no authorization. The ledger is unchanged.
3. **Given** any process other than the seller (L1, L2, L3, the local facilitator, the operator CLI), **Then** neither its env template nor its code references the CDP credential, and the local demo never passes the credential to that process.
4. **Given** any log line, error message, HTTP response, ledger entry or state file, **Then** the CDP API key secret never appears in it.
5. **Given** `NETWORK=local`, **When** CDP is selected, **Then** the seller fails at startup, because CDP cannot settle on the local chain.

---

### User Story 3 - Facilitator failures never lose or miscount money (Priority: P2)

CDP can decline a payment (OFAC or KYT screening), throttle the seller, be unreachable, or
report a settlement that is broadcast but not yet confirmed. Each case ends in a defined
outcome, and the budgets stay correct.

**Why this priority**: A hosted third party adds failure modes the local facilitator never
had. Budgets come from the ledger (Principle III), so every failure must leave it accurate.

**Independent Test**: Offline. A stub facilitator returns each failure in turn. For each one,
assert the seller's response, the L1 outcome, the L3 status and the L2 budget.

**Acceptance Scenarios**:

1. **Given** CDP declines verification (for example, after compliance screening), **When** the paid retry is sent, **Then** the seller does not serve the resource and returns an x402-shaped rejection carrying the facilitator's reason. The L1 outcome is `PAYMENT_FAILED`, L3 reports `NOT_SETTLED`, and the committed amount is released only after `validBefore` passes (SEC-9).
2. **Given** CDP throttles the seller or its quota is exhausted, **When** a priced route is requested, **Then** the seller answers 503 with the reason category "rate-limited" before any challenge. If this happens during a paid retry, the resource is not served and the L1 outcome is `PAYMENT_FAILED`.
3. **Given** CDP returns a settlement result with a transaction identifier that is not yet confirmed, **When** L3 verifies the claim, **Then** L3 tracks that transaction on-chain. It reports `PENDING` and re-checks per L3-2, and the amount stays committed until the transaction is CONFIRMED, or is `NOT_SETTLED` and `validBefore` has passed.
4. **Given** a settlement result that reports failure but still carries a transaction identifier, **When** L3 verifies it, **Then** L3 checks that transaction on-chain instead of trusting the failure claim. A transaction that later confirms is counted as spent.
5. **Given** CDP is unreachable or does not answer within the facilitator timeout, **When** a priced route is requested, **Then** the seller answers 503 with the reason category "unavailable". The next request after CDP recovers succeeds without a restart.
6. **Given** any CDP failure, **Then** the seller never retries the payment through the public facilitator or any other facilitator.

---

### User Story 4 - Existing paths stay unchanged (Priority: P2)

The local demo and the public-facilitator path on Base Sepolia keep working as they do today.
Neither needs CDP credentials.

**Why this priority**: The local demo is the regression baseline for every change (definition
of done). The public facilitator stays useful for anyone without a CDP account.

**Independent Test**: Run `npm run check` with no CDP credentials anywhere and no network
access beyond loopback.

**Acceptance Scenarios**:

1. **Given** no CDP credentials anywhere, **When** the local demo runs, **Then** its summary is unchanged (`spent on-chain: 0.006 USDC`, `hash chain ok=true`), and the full test suite passes.
2. **Given** `base-sepolia` with the public facilitator selected explicitly, **When** the seller starts, **Then** it uses the facilitator override if set, otherwise `https://x402.org/facilitator`, exactly as today, and needs no CDP credentials.

### Edge Cases

- **CDP selected and a facilitator URL override also set**: startup fails with an error that explains the conflict. The credential is never sent to an operator-supplied URL.
- **A CDP credential is set but the public facilitator is selected**: the seller starts, ignores the credential and logs a warning that it is set but unused.
- **A secret in multi-line PEM form**: a properly quoted multi-line secret is accepted. A secret that cannot be parsed fails at startup with an error that does not echo the value.
- **The seller host's clock is skewed**: CDP authentication is time-limited, so requests are rejected. The seller reports the reason category "authentication", and the log suggests checking the clock.
- **CDP no longer advertises x402 v2 `exact` on `eip155:84532`**: priced routes answer 503 with the reason category "unsupported". No challenge is issued, and the free catalog stays available.
- **CDP retries a broadcast that has not confirmed, and two transaction identifiers are reported for one authorization**: the EIP-3009 nonce lets at most one transfer succeed. The first CONFIRMED report is final, and a contradicting report is recorded as an anomaly (INV-11).
- **Free-tier exhaustion or a billing error at CDP**: treated as "rate-limited" when the facilitator says so, otherwise as "unavailable". The payer is never charged without a settlement.
- **A 503 on the first, unpaid request**: L1 sees a non-402 status, so no `PaymentIntent` is built and L2 signs nothing.
- **The payment settles after the seller has already answered with an error** (paid but not served): the budget counts the spend once L3 confirms it. Refunds stay out of scope (EXT-9).
- **A settle request times out before any transaction identifier comes back**: the outcome is indeterminate. The amount stays committed until `validBefore` (SEC-9). If the facilitator completed the transfer anyway, the ledger cannot see it. This gap existed before this feature and applies to every facilitator. It is recorded as a residual risk in SPEC §11, and closing it (for example, by checking the EIP-3009 nonce on-chain) is a separate feature.

## Requirements *(mandatory)*

### Functional Requirements

**Facilitator selection (CP-3 and CFG-1, amended)**

- **FR-001**: On `base-sepolia`, the seller MUST support two facilitator choices: **CDP**, the authenticated hosted x402 facilitator, and **public**, the unauthenticated facilitator at the override URL or `https://x402.org/facilitator`. *(SPEC: CP-3, CFG-1 — amended)*
- **FR-002**: On `base-sepolia`, CDP MUST be the default. The public choice MUST be selected explicitly. *(SPEC: CP-3 — amended)*
- **FR-003**: On `local`, the local facilitator MUST remain the only valid choice, and selecting CDP MUST fail at startup. *(SPEC: CP-2, CFG-1)*
- **FR-004**: Selecting CDP together with a facilitator URL override MUST fail at startup with an error that explains the conflict. *(new)*
- **FR-005**: The seller MUST NOT change facilitator at runtime. There is no fallback from CDP to public or the other way round. *(new)*
- **FR-006**: The seller's startup log MUST state the network, the facilitator choice and the facilitator host. It MUST NOT print the secret. It MAY print a truncated, non-secret key identifier. *(new)*

**Authentication and credential handling (CFG-2 and §3.3, amended; proposed SEC-10)**

- **FR-007**: With CDP selected, the seller MUST authenticate every request to the facilitator (supported kinds, verify, settle) with the operator's CDP API key ID and secret. It MUST NOT send unauthenticated requests to CDP. *(new)*
- **FR-008**: With CDP selected, a missing or empty key ID or secret MUST make the seller exit non-zero at startup, with an error that names the missing setting. *(SPEC: CFG-2 fail-closed pattern)*
- **FR-009**: Only the seller process MAY hold the CDP credential. Only the seller's env file and template may declare it. The architecture and env-template checks MUST fail if another process's template or any L1, L2 or L3 code references it. *(SPEC: §3.3, T-ARCH-ENV — amended)*
- **FR-010**: The local demo and the test harnesses MUST NOT pass the CDP credential to any child process other than the seller. *(SPEC: CFG-2 demo child environments)*
- **FR-011**: The CDP secret MUST NOT appear in logs, error messages, HTTP responses (including 503 bodies), ledger entries, the deployment record or any other state file. *(new)*
- **FR-012**: The CDP credential MUST NOT become payment authority. No process uses it to create, sign or approve a payment authorization, and L2 remains the sole signer. *(SPEC: INV-2, INV-6 — unchanged)*

**Wire behavior (CP-1, §10, unchanged)**

- **FR-013**: The 402 challenge, payment signature and payment response MUST have the same formats whichever facilitator is selected: exactly one option per priced route, and the EIP-712 domain {"USDC", "2"} on Base Sepolia. *(SPEC: CP-1, §10, §16)*
- **FR-014**: x402 headers MUST be encoded and decoded only with the official x402 SDK helpers. *(SPEC: §10, Principle VII)*

**Failure handling (CP-1, amended)**

- **FR-015**: Before it issues the first challenge, the seller MUST confirm that the selected facilitator supports x402 v2 `exact` on `eip155:84532`. If it does not, priced routes MUST answer 503 with the reason category "unsupported". *(SPEC: CP-1 lazy sync — amended)*
- **FR-016**: The facilitator may be unreachable, time out, reject authentication or throttle the seller. Each case has a distinct reason category: "unavailable", "authentication" or "rate-limited". Before a challenge is issued, priced routes MUST answer 503 with that category. During a paid retry, the seller MUST answer with a non-2xx status that carries the same category, and MUST NOT serve the resource. The free catalog MUST stay available. The seller MUST recover on the next request after the facilitator recovers, without a restart. *(SPEC: CP-1 — amended)*
- **FR-017**: Every request to a hosted facilitator (CDP or public) MUST be bounded by a timeout, 30 s by default. A timeout counts as "unavailable" before a challenge, and as a failed payment during a paid retry. The local facilitator keeps its current timing, so the local baseline does not change. *(SPEC: CP-2 30 s window, applied to the hosted facilitator)*
- **FR-018**: When verification is rejected (an invalid payment or a compliance decline), the seller MUST NOT serve the resource. It MUST return an x402-shaped rejection that carries the facilitator's reason. *(SPEC: CP-2 error bodies)*
- **FR-019**: When settlement fails or is not confirmed, the seller MUST NOT serve the resource. If the facilitator's settlement result carries a transaction identifier, the seller MUST pass it through unchanged in `PAYMENT-RESPONSE`, whether the result reports success or failure. *(SPEC: CP-1, §10)*
- **FR-020**: When a `PAYMENT-RESPONSE` reports failure but carries a transaction identifier, L3 MUST check that transaction on-chain as it does in the success path. It MUST NOT report `NOT_SETTLED` from the claim alone. L3 stays read-only. *(SPEC: L3-1 step 2 — amended; INV-4, INV-10)*

**Verification (Principle VIII)**

- **FR-021**: Offline automated tests MUST cover facilitator selection and every startup failure (FR-002 to FR-004, FR-008), credential isolation (FR-009, FR-010), secret redaction (FR-011), each failure category (FR-015 to FR-019) and the L3 path for a failed result that carries a transaction (FR-020). They MUST also show that the seller authenticates to a stub facilitator that rejects unauthenticated requests. These tests MUST NOT need network access or real CDP credentials. *(SPEC: §12 — new test IDs)*
- **FR-022**: The credential-isolation check MUST be shown to fail on a fixture where a non-seller template or layer file references the CDP credential. *(SPEC: §4.1 fixture rule, Principle VIII)*
- **FR-023**: An opt-in live acceptance run on Base Sepolia through CDP MUST exist. It runs only when explicitly requested and credentials are present. It is not part of `npm test` or `npm run check`. It reports the same summary lines as the local demo. *(new; mirrors T-E2E-01)*

### Non-Functional Requirements

- **NFR-001 (Invariants preserved)**: INV-1 to INV-13 MUST hold unchanged. L1 and L3 gain no credential, and L2 remains the only signer. *(Constitution I, III, V)*
- **NFR-002 (Fail closed)**: Every CDP misconfiguration MUST stop paid traffic before L2 signs any authorization. *(Constitution V)*
- **NFR-003 (Offline baseline)**: The default test suite and the local demo MUST need no CDP credentials and no network beyond loopback. The demo summary MUST be unchanged. *(Definition of done)*
- **NFR-004 (Diagnosability)**: An operator MUST be able to tell each failure category apart from the seller's response or log alone, without enabling debug output.
- **NFR-005 (Cost)**: One live acceptance run MUST make at most 2 on-chain settlements, the PAID steps of the scripted plan, so routine testing stays within CDP's free monthly allowance.
- **NFR-006 (Privacy, documented residual risk)**: For each payment, CDP receives the payer, payee, amount, asset and the resource URL and description. This MUST be recorded as an accepted residual risk in SPEC §11, alongside "facilitator trusted for liveness". *(SPEC: §11 — amended)*
- **NFR-007 (Traceability)**: SPEC.md (§3.3, CP-3, CFG-1, CFG-2, L3-1, §11, §12), the seller env template and the README Base Sepolia section MUST be updated in the same change. *(Constitution governance)*

### Key Entities

- **Facilitator Choice**: which facilitator the seller uses: local, public or CDP. Validity depends on the network: local only on `local`; public or CDP on `base-sepolia`. Fixed for the life of the process.
- **CDP API Credential**: a key identifier (not secret) and a key secret. The seller is its only holder. It authenticates the seller to CDP and grants no payment authority.
- **Facilitator Failure Category**: unavailable, authentication, rate-limited, unsupported, verification rejected or settlement failed. Each maps to one seller response and one log message.
- **Settlement Result (`PAYMENT-RESPONSE`)**: unchanged fields {success, transaction, network, payer, errorReason?}. A transaction identifier may now be present on a failure, and L3 then treats it as a claim to check on-chain.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 3 consecutive live runs on Base Sepolia through CDP, all 6 scripted outcomes match T-E2E-01, the payee balance rises by exactly 6000 atomic per run, 2 settlements per run are CONFIRMED and the hash chain verifies.
- **SC-002**: The payer spends 0 native gas across a live run.
- **SC-003**: Across 5 misconfigurations (missing key ID, missing secret, rejected credential, CDP on `local`, CDP plus a URL override), 0 authorizations are signed and 0 `AUTHORIZED` ledger entries are appended.
- **SC-004**: The CDP secret appears 0 times in the logs, HTTP responses, ledger and state files that the offline suite and a live run produce, checked by scanning for the secret value.
- **SC-005**: 0 processes other than the seller receive the CDP credential in their environment, checked for the demo and harness children.
- **SC-006**: `npm run check` passes with no CDP credentials and no network beyond loopback, and the local demo summary is unchanged.
- **SC-007**: Switching `base-sepolia` between CDP and public changes only the seller's env file. No other process's configuration changes.
- **SC-008**: Each of the 6 failure categories maps to a distinct reason that an operator can read from the seller's response or log.
- **SC-009**: After a facilitator outage ends, the first priced request succeeds without restarting any process.

## Assumptions

- "New Coinbase network" means Base Sepolia through CDP's facilitator. The user confirmed this on 2026-10-17. Base mainnet and the other CDP networks (Polygon, Arbitrum, Monad, World, World Sepolia, Solana) are out of scope. Mainnet stays out of scope (SPEC §1.3).
- The scope is the facilitator only, also confirmed by the user. Moving the payer key into a CDP Server Wallet is EXT-2 and needs its own feature. The `upto` and `batch-settlement` schemes stay out of scope (EXT-3).
- CDP authenticates with an API key ID and secret. CDP's convention is to provide them as `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`. The plan chooses the final setting names. It also chooses between CDP's own facilitator client and the existing x402 client with CDP authentication headers. No CDP wallet secret is needed, because the seller's payee is a plain address.
- As of 2026-10-17, CDP's network-support page lists x402 v2 `exact` on `eip155:84532`. The supported-kinds check (FR-015) guards against later changes. Research during planning confirms how CDP represents a settlement that is broadcast but not yet confirmed.
- According to CDP's docs on 2026-10-17, CDP pays gas and screens payments for OFAC and KYT. Verification is free, and the first 1,000 on-chain settlements each month are free.
- Making CDP the default on `base-sepolia` is a deliberate, fail-closed change. An existing Base Sepolia setup without CDP credentials will stop at seller startup until it adds credentials or selects the public facilitator explicitly. The README states this.
- The operator creates the CDP key with the narrowest permissions and access restrictions CDP offers. The key never controls a CDP wallet that holds funds.
- The facilitator stays trusted for liveness, an existing residual risk. CDP is now also trusted to apply its compliance screening. Neither trust affects settlement truth, which L3 takes from the chain (INV-10).
- If the plan adds a CDP SDK dependency, SPEC §5 and the constitution's stack line are updated (a MINOR amendment).
- The live acceptance run needs internet access, a CDP account and a payer funded with at least 0.006 USDC per run plus a margin. An operator runs it, not CI.
- Related features: 006 owns CP-3 and CFG-1. 007 owns the credential matrix, env templates and architecture rules. 005 owns the L3-1 step 2 amendment. 008 owns the demo-summary regression. HOW is in SPEC.md once it is amended.
