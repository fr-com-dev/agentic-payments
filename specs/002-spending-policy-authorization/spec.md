# Feature Specification: Spending Policy & Authorization (Layer 2 — Control)

**Feature Branch**: `002-spending-policy-authorization`

**Created**: 2026-10-16

**Status**: Draft — derived from SPEC.md v1.0 (implemented PoC)

**Input**: Derived from SPEC.md §4 (INV-5, INV-6, INV-8), §8.2 (L2-1, L2-2, L2-3, L2-5 authorize/budget), §9 (CFG-3), §11 (SEC-1, SEC-3, SEC-6), §12 (T-POL-01..14, T-E2E-04)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Compliant micro-payment is authorized and signed (Priority: P1)

A payer (the mandate owner) has set a spending mandate. The agent submits a payment intent for
a $0.001 resource from an allowlisted host, payee, network and asset. Control evaluates the
mandate and signs exactly the chosen payment option. It returns opaque payment headers plus
the remaining session budget.

**Why this priority**: Without authorization nothing can be bought. This is the minimum
viable control path.

**Independent Test**: Evaluate a compliant 1000-atomic requirement against the default
mandate. The decision is AUTHORIZED (T-POL-01). End to end, the payment settles (T-E2E-01).

**Acceptance Scenarios**:

1. **Given** the default mandate and a compliant requirement of 1000 atomic units, **When** the intent is authorized, **Then** the decision is AUTHORIZED. It includes the requirement, payment headers, payer, validBefore and the remaining session budget.
2. **Given** a challenge with several compliant options, **When** Control decides, **Then** it chooses the cheapest option, with ties going to the first offered. Running the same inputs twice gives deep-equal results (T-POL-02).
3. **Given** an AUTHORIZED decision, **When** Control signs, **Then** the signature covers only the chosen option.

---

### User Story 2 - Non-compliant payments are denied with every violated rule (Priority: P1)

Control denies a payment that breaks any mandate rule. It reports all violated rules (not
just the first) using stable rule IDs, so the agent and auditor can see why.

**Why this priority**: This is the core safety control against overspending, a malicious
seller and prompt injection (SEC-1, SEC-3).

**Independent Test**: Run the policy unit tests T-POL-03..14. Each violation produces the
expected rule ID.

**Acceptance Scenarios**:

1. **Given** a requirement on a non-allowed network, asset, payee or scheme, **When** evaluated, **Then** the decision is DENIED with `network_not_allowed`, `asset_not_allowed`, `payee_not_allowed` or `scheme_not_allowed` respectively (T-POL-03..06).
2. **Given** a timeout outside the allowed range, an amount above the hard cap, a negative amount or a decimal amount, **When** evaluated, **Then** the decision is DENIED with `timeout_out_of_range`, `hard_cap_exceeded` or `amount_invalid` (T-POL-07..10).
3. **Given** a challenge whose resource host differs from the requested host, or a requested host not in the allowlist, **When** evaluated, **Then** the decision is DENIED with `resource_binding_mismatch` or `host_not_allowed` (T-POL-11).
4. **Given** a requirement that breaks several rules, **When** evaluated, **Then** all violated DENY rules are listed.

---

### User Story 3 - Session and daily budgets cap cumulative spend (Priority: P1)

The payer limits total spend per session and per trailing 24 hours. Each new payment's amount
counts toward the budget before it is approved.

**Why this priority**: Per-payment caps alone do not stop many small payments.

**Independent Test**: In T-POL-12, a payment that brings committed spend exactly to the budget
passes, and one more atomic unit is denied.

**Acceptance Scenarios**:

1. **Given** the session's committed spend plus the new amount exceeds the session budget, **When** evaluated, **Then** the decision is DENIED with `session_budget_exceeded`.
2. **Given** the trailing-24h committed spend plus the new amount exceeds the daily budget, **When** evaluated, **Then** the decision is DENIED with `daily_budget_exceeded`.
3. **Given** the committed spend plus the amount equals the budget exactly, **When** evaluated, **Then** the payment is not denied by budget rules.
4. **Given** an agent asks for its budget, **When** queried, **Then** it receives the session cap, spent-or-reserved, remaining, the per-payment auto-approve limit, the asset and the decimals.

---

### User Story 4 - Concurrent bursts cannot bypass limits (Priority: P1)

A compromised or buggy agent might fire many intents at once. Decisions are serialized, so the
velocity and budget checks always see every earlier authorization.

**Why this priority**: SEC-6. Without serialization a race bypasses every cumulative limit.

**Independent Test**: In T-E2E-04, the signer is given 25 ms latency and 15 intents are sent
concurrently. Exactly 10 are AUTHORIZED in the trailing 60 s. The test must fail (15/15) when
serialization is removed.

**Acceptance Scenarios**:

1. **Given** a velocity limit of 10 per minute and 15 concurrent intents, **When** all are processed, **Then** exactly 10 are AUTHORIZED and 5 are DENIED with `velocity_limit`.

---

### User Story 5 - Payments above the auto-approve threshold escalate to a human (Priority: P2)

A compliant payment above the auto-approve limit is escalated instead of being authorized
automatically. A matching human approval turns it into AUTHORIZED. The approval workflow
itself is in feature 004.

**Why this priority**: It provides human-in-the-loop control for larger amounts while the
deny rules stay absolute.

**Independent Test**: In T-POL-13, a compliant 50000-atomic payment escalates. A matching
approval (same payee and exact amount) authorizes it. A different amount still escalates. An
approval never overrides a DENY.

**Acceptance Scenarios**:

1. **Given** no DENY violation and an amount above 20000, **When** evaluated without an approval, **Then** the decision is ESCALATE with `human_approval_required`.
2. **Given** a matching approval for the same payee (case-insensitive) and the exact amount string, **When** evaluated, **Then** the decision is AUTHORIZED.
3. **Given** an approval exists but a DENY rule is violated, **When** evaluated, **Then** the decision is DENIED.

---

### Edge Cases

- An empty list of offered options is DENIED with `no_payment_options` (T-POL-14).
- A mandate past its expiry time is DENIED with `mandate_expired` (T-POL-14).
- If the velocity count is at or above the per-minute maximum, the decision is DENIED with `velocity_limit` (T-POL-14).
- An amount that is non-numeric, decimal, negative or zero gets only `amount_invalid` from that point. Evaluation returns immediately and skips the amount-dependent rules.
- If no option is AUTHORIZED but one is ESCALATE, the decision is ESCALATE with that option's violations. If all options are denied, every violation is flattened into the response.
- A host comparison includes the port. `localhost:4021` is not the same as `127.0.0.1:4021`.
- If the signer rejects the payment (for example because the independent SDK cap is exceeded), the decision becomes DENIED with `signer_rejected`. The detail is truncated to 300 characters.
- A malformed intent is rejected with 400 and is never evaluated. Malformed means missing IDs, an options list that is not a list, or a non-http(s) URL.
- A wrong or missing credential gets 401.

## Requirements *(mandatory)*

### Functional Requirements

**Mandate (L2-1, CFG-3)**

- **FR-001**: Control MUST load a spending mandate with these fields and defaults:

  | Field | Default |
  |---|---|
  | mandate ID | `mandate-poc-001` |
  | expiry | 2027-12-31T23:59:59Z |
  | allowed schemes | `["exact"]` |
  | allowed payees | `[]` |
  | allowed hosts | `["127.0.0.1:4021"]` |
  | auto-approve max | 20000 |
  | hard cap per payment | 100000 |
  | session budget | 100000 |
  | daily budget | 500000 |
  | max authorizations per minute | 10 |
  | max timeout | 300 s |

  All amounts are atomic-unit strings. *(SPEC: L2-1, CFG-3)*
- **FR-002**: Allowed networks and assets MUST always come from the active network profile, never from the mandate file. *(SPEC: L2-1)*
- **FR-003**: Payee and host allowlists set through the environment MUST override the mandate-file values when present. Payees are compared lower-cased. *(SPEC: L2-1)*
- **FR-004**: The mandate MUST satisfy auto-approve max < hard cap ≤ session budget. Otherwise an approved escalation could never pay. *(SPEC: CFG-3)*

**Policy rules (L2-2)**

- **FR-005**: Control MUST evaluate each offered requirement against these rules, in order:

  | # | Rule ID | Violated when | Effect |
  |---|---|---|---|
  | R1 | `mandate_expired` | now > expiry | DENY |
  | R2 | `scheme_not_allowed` | scheme not allowed | DENY |
  | R3 | `network_not_allowed` | network not allowed | DENY |
  | R4 | `asset_not_allowed` | lower(asset) not allowed for that network | DENY |
  | R5 | `payee_not_allowed` | payee allowlist non-empty and lower(payTo) not in it | DENY |
  | R6 | `host_not_allowed` | requested host (with port) invalid or not allowlisted | DENY |
  | R7 | `resource_binding_mismatch` | challenge resource host ≠ requested host | DENY |
  | R8 | `timeout_out_of_range` | not 0 < timeout ≤ mandate max | DENY |
  | R9 | `amount_invalid` | amount not a positive integer string | DENY, return immediately |
  | R10 | `hard_cap_exceeded` | amount > hard cap | DENY |
  | R11 | `session_budget_exceeded` | session committed + amount > session budget | DENY |
  | R12 | `daily_budget_exceeded` | 24h committed + amount > daily budget | DENY |
  | R13 | `velocity_limit` | authorizations in last minute ≥ max | DENY |
  | R14 | `human_approval_required` | no DENY, amount > auto-approve max and no matching approval | ESCALATE |

  *(SPEC: L2-2 R1–R14)*
- **FR-006**: Control MUST collect all DENY violations rather than stop at the first, except for R9, which returns immediately. *(SPEC: L2-2)*
- **FR-007**: R14 MUST be lifted only by an approval that matches the same payee (case-insensitive) and the exact amount string. *(SPEC: L2-2 R14, INV-12)*
- **FR-008**: Across the offered options, Control MUST decide as follows:
  - If any option is AUTHORIZED, choose the smallest amount (ties go to the first offered).
  - Otherwise, if any option is ESCALATE, return ESCALATE with that option's violations.
  - Otherwise, return DENIED with all violations flattened, or `no_payment_options` if nothing was offered.

  *(SPEC: L2-2 decide)*

**Signing (L2-3)**

- **FR-009**: Control MUST sign exactly one requirement, the one chosen by policy. The signing step sees a challenge whose options list contains only that requirement. *(SPEC: L2-3, INV-6)*
- **FR-010**: The signer MUST enforce its own per-payment cap equal to the mandate hard cap, independent of the policy engine. *(SPEC: L2-3)*
- **FR-011**: The signer MUST return the payment headers, the payer address and validBefore (in seconds). *(SPEC: L2-3)*
- **FR-012**: If signing fails, the decision MUST become DENIED with rule `signer_rejected` and the error detail truncated to 300 characters. *(SPEC: L2-3)*

**Authorization service (L2-5)**

- **FR-013**: Control MUST expose an authorize operation that accepts a payment intent and returns a decision: AUTHORIZED with headers, or DENIED/ESCALATE with violations. *(SPEC: L2-5)*
- **FR-014**: The authorize operation MUST return 400 when intent IDs are missing, the options list is not a list, or the URL is not http(s). It MUST return 401 for a bad credential. *(SPEC: L2-5)*
- **FR-015**: Control MUST expose a budget query per session that returns the session cap, spent-or-reserved, remaining, the per-payment cap (the auto-approve limit), the asset and the decimals. *(SPEC: L2-5)*
- **FR-016**: The authorize algorithm MUST run these steps:
  1. Take the time once.
  2. Record the INTENT.
  3. Look up an open approval for (session, resource).
  4. Build the context: session committed spend, trailing-24h committed spend and AUTHORIZED count in the trailing 60 s, all derived from the ledger.
  5. Decide.
  6. If AUTHORIZED, sign.
  7. Record AUTHORIZED, DENIED or ESCALATED.
  8. Return the decision.

  *(SPEC: L2-5)*
- **FR-017**: For tests, Control MUST support an optional artificial signer latency that simulates a remote signer. *(SPEC: L2-5, T-E2E-04)*

### Non-Functional Requirements

- **NFR-001 (Determinism, purity)**: The decision MUST be a pure function of (offered options, mandate, context). It does no I/O and reads no clock (time is an input). The intent's purpose text MUST NOT influence any decision. *(SPEC: INV-5, T-POL-02)*
- **NFR-002 (Concurrency)**: The steps from intent record to decision record MUST execute as one serialized critical section across concurrent requests. With 25 ms signer latency and 15 concurrent intents, exactly 10 are AUTHORIZED. Removing serialization MUST make the test fail. *(SPEC: INV-8, SEC-6, T-E2E-04)*
- **NFR-003 (Security, single-option signing)**: No signature may cover an option other than the policy-chosen one. *(SPEC: INV-6)*
- **NFR-004 (Security, defense in depth)**: The per-payment cap is enforced twice: by policy (R10) and independently by the signer. *(SPEC: L2-3)*
- **NFR-005 (Security, payee and host redirection)**: The payee allowlist, host allowlist and resource binding together block payee swaps and redirects. *(SPEC: SEC-3, T-POL-05/07/08/11)*
- **NFR-006 (Money arithmetic)**: All amount comparisons use exact integer arithmetic on atomic-unit strings. *(SPEC: §7)*
- **NFR-007 (State)**: Budget and velocity figures MUST be derived from the ledger. No separate mutable counters are allowed. *(SPEC: INV-7)*
- **NFR-008 (Access control)**: The authorize and budget operations require the agent's control credential. The service listens on loopback only. *(SPEC: L2-5, INV-13)*
- **NFR-009 (Auditability)**: Every authorize call records an INTENT entry before deciding, and exactly one outcome entry after. *(SPEC: L2-5)*

### Key Entities

- **Spending Mandate**: The human-defined rules: expiry, schemes, payees, hosts, caps, budgets, velocity and timeout.
- **Payment Requirement**: One offered option: scheme, network, asset, amount, payee and timeout.
- **Policy Context**: The time, requested URL, challenge resource URL, session and 24h committed spend, the authorization count in the last minute and an optional matching human approval.
- **Policy Violation**: A rule ID and a detail.
- **Authorization Decision**: AUTHORIZED (requirement, headers, payer, validBefore, remaining budget) or DENIED/ESCALATE (violations). Each carries an authorization ID and the intent ID.
- **Budget Status**: The session cap, spent-or-reserved, remaining, per-payment cap, asset and decimals.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Each of the 14 rules plus `no_payment_options` and `signer_rejected` has at least one test that produces exactly that rule ID.
- **SC-002**: Identical inputs give deep-equal decisions in 100% of repeated evaluations.
- **SC-003**: With 15 concurrent intents and a limit of 10 per minute, exactly 10 are authorized. Without serialization, 15 of 15 are.
- **SC-004**: In the scripted plan, the 500000-atomic request is DENIED with `hard_cap_exceeded`, and the 50000-atomic request is ESCALATED with `human_approval_required`.
- **SC-005**: After the scripted run, the session budget reports spent-or-reserved = 6000.
- **SC-006**: A payment bringing committed spend exactly to the budget is authorized. One atomic unit more is denied.

## Assumptions

- Committed-spend computation, ledger format and integrity are specified in feature 003. Approval issuance and consumption are specified in feature 004.
- Network profiles, which supply the allowed networks and assets, are specified in feature 006.
- Any extra budget-rule violations that accompany `hard_cap_exceeded` depend on the session's state at the time. They are not a fixed set.
- Out of scope: an AP2-signed mandate (EXT-1), a remote signer (EXT-2), the `upto` scheme (EXT-3) and Solana (EXT-4).
- HOW (signer construction, mutex technique and SDK spend controls) is in SPEC.md §8.2.
