# Feature Specification: Settlement Verification (Layer 3)

**Feature Branch**: `005-settlement-verification`

**Created**: 2026-10-16

**Status**: Draft (derived from SPEC.md v1.0; implemented PoC)

**Input**: Derived from SPEC.md §8.3 (L3-1, L3-2), §4 (INV-4, INV-10), §11 (SEC-4) and §12 (T-E2E-03)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Confirm a paid request against the chain (Priority: P1)

After the agent pays for a resource, it submits a settlement claim to the verifier. The
verifier does not trust the seller's payment response. It confirms that the transaction
succeeded on-chain and moved exactly the authorized amount of the authorized asset from the
payer to the payee. Only then does it report CONFIRMED.

**Why this priority**: Without independent on-chain verification, a seller could claim
payment without settling. This is the core value of L3.

**Independent Test**: Submit a claim for a payment that really settled. The report is
CONFIRMED and carries the transaction, block number, confirmations and finality class.
Verified by T-E2E-01, which expects two CONFIRMED settlements.

**Acceptance Scenarios**:

1. **Given** a payment of 1000 atomic units settled on-chain with a matching Transfer, **When** the agent submits the claim, **Then** the report is `CONFIRMED` with finality class `included`, a block number and confirmations ≥ 1.
2. **Given** a 5000-unit payment that settled, **When** the claim is verified, **Then** the report is `CONFIRMED` and its `verified` fields equal the claim's asset, payer, payee and amount.
3. **Given** a successful receipt but no Transfer log matching (payer, payee, amount) from the claimed asset, **When** verified, **Then** the report is `MISMATCH`.

---

### User Story 2 - Reject forged or missing settlement evidence (Priority: P1)

A malicious seller returns a forged payment response, for example one that points to an
unrelated or older transaction with a different amount. The seller might also return none.
The verifier must not report the payment as confirmed.

**Why this priority**: This directly mitigates SEC-4 (claim without settling, or replay of an
old transaction).

**Independent Test**: Forge a payment response that references a real transaction with a
different amount. The verifier returns `MISMATCH`. Verified by T-E2E-03 (L3 side).

**Acceptance Scenarios**:

1. **Given** a claim with no payment response, **When** verified, **Then** the status is `NOT_SETTLED`.
2. **Given** a payment response that cannot be decoded, reports `success: false`, or has no transaction, **When** verified, **Then** the status is `NOT_SETTLED`. *(Amended by 009, SPEC v1.2 L3-1 step 2: a `success: false` response that carries a 32-byte transaction hash is checked on-chain like a success claim; only a failure without a hash is `NOT_SETTLED` from the claim alone. SEC-11, T-CDP-06.)*
3. **Given** a payment response whose network differs from the requirement's network, **When** verified, **Then** the status is `MISMATCH`.
4. **Given** a forged payment response that references a transaction whose Transfer amount differs from the claim, **When** verified, **Then** the status is `MISMATCH`.
5. **Given** a referenced transaction that reverted, **When** verified, **Then** the status is `NOT_SETTLED`.

---

### User Story 3 - Finality scaled to amount at risk (Priority: P2)

The payer or mandate owner wants larger payments to wait for stronger finality before they
count as confirmed. Micropayments confirm as soon as they are included in a block.

**Why this priority**: This balances latency for micropayments against reorg risk for larger
amounts.

**Independent Test**: Verify claims of 10,000, 1,000,000 and 1,000,001 atomic units. Each
gets the expected finality class and is CONFIRMED only once its requirement is met.

**Acceptance Scenarios**:

1. **Given** an amount ≤ 10,000 atomic ($0.01), **When** a receipt exists, **Then** the finality class is `included` and the report is CONFIRMED.
2. **Given** an amount ≤ 1,000,000 atomic ($1) and > 10,000, **When** the head is at least the network's confirmation depth past the block (`head − block + 1 ≥ depth`), **Then** the class is `confirmed-depth` and the report is CONFIRMED.
3. **Given** an amount > 1,000,000 on a network that supports a "safe" block tag, **When** the safe block number is ≥ the transaction block, **Then** the class is `l1-safe` and the report is CONFIRMED.
4. **Given** an `l1-safe` amount on a network without a safe tag, **When** the depth reaches 5 × the confirmation depth, **Then** the report is CONFIRMED.
5. **Given** finality is not reached within the wait window, **When** verification ends, **Then** the report is `PENDING`.

---

### User Story 4 - Report every outcome to Control and keep re-checking pending ones (Priority: P2)

Every report the verifier produces is pushed to the Control layer (L2) for reconciliation
into the audit ledger. PENDING settlements are re-checked in the background until they
resolve or the attempts run out.

**Why this priority**: L2's committed spend and audit trail depend on L3's reports.

**Independent Test**: Make a PENDING claim. Up to 5 re-checks run 30 s apart, each result is
reconciled into L2, and the original request returns without waiting for them.

**Acceptance Scenarios**:

1. **Given** any report, **When** it is produced, **Then** it is sent to L2 reconciliation with the verifier-to-control credential.
2. **Given** L2 reconciliation fails, **When** the agent's request completes, **Then** the agent still receives the report and the failure is logged.
3. **Given** a PENDING report, **When** the request returns, **Then** re-checks are scheduled (default 5 attempts, 30 s apart), and each result is reconciled again.
4. **Given** a request missing `authorizationId` or `requirement`, **Then** the API returns 400. **Given** bad or missing auth, **Then** it returns 401.

### Edge Cases

- The receipt does not arrive within the wait window (default 45 s): the report is `PENDING`, not `NOT_SETTLED`.
- The transaction has several Transfer logs: one matching log from the claimed asset contract is enough. Transfers from other contracts are ignored.
- Address case differs between the claim and the chain: comparison is case-insensitive.
- A pending re-check timer is still scheduled when the process exits: timers must not keep the process alive.
- The seller's response claims success but the transaction is from an older, already-reconciled payment: the Transfer amount or parties don't match the claim, so the report is `MISMATCH`. L2 then handles the anomaly (feature 003).
- Very large amounts: they are compared exactly as integers, with no precision loss.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The verifier MUST derive the finality class from the requirement's amount: `included` for ≤ 10,000; `confirmed-depth` for ≤ 1,000,000; `l1-safe` for > 1,000,000 atomic units. *(SPEC: L3-1 step 1, finality table)*
- **FR-002**: Every report MUST include a `verified` object of {asset, payer, payTo, amount} taken from the claim, plus the network, the finality class, a detail message and an observed-at timestamp. *(SPEC: L3-1 step 1, §7 SettlementReport)*
- **FR-003**: The verifier MUST return `NOT_SETTLED` when the payment response is absent, cannot be decoded, reports no success, or has no transaction. *(SPEC: L3-1 step 2)* *(Amended by 009, SPEC v1.2 L3-1 step 2: a `success: false` response that carries a 32-byte transaction hash is checked on-chain like a success claim; only a failure without a hash is `NOT_SETTLED` from the claim alone. SEC-11, T-CDP-06.)*
- **FR-004**: The verifier MUST return `MISMATCH` when the settlement's network differs from the requirement's network. *(SPEC: L3-1 step 3)*
- **FR-005**: The verifier MUST wait for the transaction receipt for up to the wait window, polling at the poll interval. A timeout MUST yield `PENDING`, and a non-success receipt MUST yield `NOT_SETTLED`. *(SPEC: L3-1 step 4)*
- **FR-006**: The verifier MUST require at least one token Transfer event emitted by the requirement's asset contract with `from == payer`, `to == payTo` and `value == amount`, comparing addresses case-insensitively. Otherwise it MUST return `MISMATCH`. *(SPEC: L3-1 step 5, INV-10)*
- **FR-007**: The verifier MUST wait for the finality requirement of the amount's class until the wait window ends. When reached, it returns `CONFIRMED` with the block number and `confirmations = head − block + 1`. Otherwise it returns `PENDING`. *(SPEC: L3-1 step 6)*
- **FR-008**: The finality requirements MUST be:
  - `included`: the receipt exists.
  - `confirmed-depth`: confirmations ≥ the network's confirmation depth (1 local, 2 Base Sepolia).
  - `l1-safe`: the safe block ≥ the transaction block where a safe tag is supported, otherwise confirmations ≥ 5 × depth.

  *(SPEC: L3-1 finality table, CFG-1)*
- **FR-009**: The verifier MUST expose a settlement-verification endpoint that accepts a settlement claim and returns a settlement report. *(SPEC: L3-2)*
- **FR-010**: The endpoint MUST return 400 when `authorizationId` or `requirement` is missing. *(SPEC: L3-2)*
- **FR-011**: The verifier MUST push every report it produces, including re-check results, to L2 reconciliation. *(SPEC: L3-2)*
- **FR-012**: The verifier MUST schedule re-checks for a PENDING report, by default 5 attempts 30 s apart. Each re-check result MUST be reconciled. *(SPEC: L3-2)*
- **FR-013**: The settlement statuses MUST be exactly `CONFIRMED`, `PENDING`, `MISMATCH` and `NOT_SETTLED`. The finality classes MUST be exactly `included`, `confirmed-depth` and `l1-safe`. *(SPEC: §7)*

### Non-Functional Requirements

- **NFR-001 (Security, read-only)**: The verifier MUST hold no signing key and MUST have no capability to sign or write to the chain. *(SPEC: INV-4; verified by T-ARCH-*)*
- **NFR-002 (Security, trust model)**: A CONFIRMED status MUST NEVER be based on the seller's payment response alone. On-chain receipt and Transfer evidence are required. *(SPEC: INV-10, SEC-4; T-E2E-03)*
- **NFR-003 (Security, authentication)**: The endpoint MUST require the agent-to-verifier credential and return 401 otherwise. Reconciliation calls MUST use the separate verifier-to-control credential. *(SPEC: L3-2, INV-13, §3.3)*
- **NFR-004 (Network exposure)**: The verifier service MUST listen on the loopback interface only (default port 4023). *(SPEC: L3-2, §3.1)*
- **NFR-005 (Timeouts)**: The defaults MUST be a 45,000 ms wait window and a 1,000 ms poll interval. *(SPEC: L3-1 defaults)*
- **NFR-006 (Reliability)**: A reconciliation failure MUST be logged and MUST NOT fail the agent's verification request. *(SPEC: L3-2)*
- **NFR-007 (Operability)**: Re-check timers MUST NOT block the request or keep the process alive. *(SPEC: L3-2 "unref'd")*
- **NFR-008 (Exactness)**: Amount comparisons MUST use exact integer arithmetic on atomic units. *(SPEC: §7, constitution VI)*
- **NFR-009 (Protocol fidelity)**: The payment response MUST be decoded with the official x402 helpers. *(SPEC: §10, CLAUDE.md rule 9)*

### Key Entities

- **Settlement Claim**: the agent's assertion that an authorization was paid. It contains the authorization ID, the approved payment requirement, the payer, the signature's valid-before time, the HTTP status and the seller's raw payment response (or none).
- **Settlement Report**: the verifier's verdict. It contains the authorization ID, status, transaction, network, block number, confirmations, finality class, detail, observed-at timestamp and verified {asset, payer, payTo, amount}.
- **Finality Class**: the confirmation strength required for an amount band.
- **Re-check Schedule**: up to N follow-up verifications of a PENDING report, each reconciled.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the scripted regression run, both paid requests (1000 and 5000 atomic) are reported CONFIRMED, giving 2 CONFIRMED settlements. *(T-E2E-01)*
- **SC-002**: 100% of forged payment responses with a mismatched amount are reported `MISMATCH`, and none are reported `CONFIRMED`. *(T-E2E-03)*
- **SC-003**: A micropayment (≤ $0.01) on the local network is CONFIRMED within the 45 s wait window.
- **SC-004**: Static analysis finds zero signing or chain-write capabilities in the verifier. *(T-ARCH-*)*
- **SC-005**: A reconciliation outage causes 0 failed verification requests.

## Assumptions

- The chain RPC is honest about receipts and logs. L3 trusts the chain node it reads from.
- Re-checks are kept in memory. Re-checks pending at a restart are lost, and L2 counts PENDING conservatively anyway (feature 003).
- How L2 stores reports, detects anomalies and keeps CONFIRMED sticky is specified in 003-audit-ledger-reconciliation. Agent-side use of reports is in 001-agent-paid-fetch.
- Network profile values (confirmation depth, safe-tag support, RPC) come from 006-counterparty-seller-network (CFG-1).
- Out of scope: Solana SPL verification (EXT-4), `upto` settled-amount handling (EXT-3), mTLS (EXT-7) and OpenTelemetry (EXT-8).
- HOW is in SPEC.md §8.3.
