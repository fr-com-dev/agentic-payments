# Feature Specification: Human-in-the-Loop Approval of Escalated Payments

**Feature Branch**: `004-human-approval-escalation`

**Created**: 2026-10-16

**Status**: Draft (derived from SPEC.md v1.0, an implemented PoC)

**Input**: Derived from SPEC.md §8.2 (L2-2 R14, L2-4.2, L2-5 approvals), §8.1 (L1-1 step 5, L1-3), §3.3, §4 (INV-12, INV-13), §9 (CFG-2 operator.env, CFG-3), §11 (SEC-8), §12 (T-POL-13, T-E2E-02) and §13

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Payments above the auto-approve limit wait for a human (Priority: P1)

The payer (mandate owner) wants payments above a small auto-approve threshold to be held for human approval, not paid automatically. The agent receives an ESCALATED outcome with an authorization ID. It reports that ID to the user and does not pay.

**Why this priority**: This is the core human-oversight control for larger agent purchases.

**Independent Test**: Request a 50000-atomic resource with the default mandate. The outcome is ESCALATED with rule `human_approval_required`, nothing is signed, and an ESCALATED entry is recorded (T-E2E-01 step 4, T-E2E-02).

**Acceptance Scenarios**:

1. **Given** a payment option of 50000 atomic units, **When** it passes every DENY rule, exceeds the auto-approve limit of 20000 and has no matching approval, **Then** the decision is ESCALATE with violation `human_approval_required`. Nothing is signed.
2. **Given** an ESCALATE decision, **When** the agent receives it, **Then** its outcome is ESCALATED with the violations and the authorization ID. The agent does not retry, and it reports the authorization ID to the user.
3. **Given** a payment of 20000 or less that passes every DENY rule, **When** it is evaluated, **Then** it is AUTHORIZED without escalation.

---

### User Story 2 - Operator approves one exact escalated payment (Priority: P1)

A human operator reviews an escalated payment and approves it with their own credential, using its authorization ID. The approval allows the same session to pay that exact resource, payee and amount once, within a limited time window.

**Why this priority**: Without an approval path, escalated payments could never complete.

**Independent Test**: Escalate, approve with the operator credential, repeat the request, observe PAID and CONFIRMED, then repeat once more and observe a new escalation (T-E2E-02).

**Acceptance Scenarios**:

1. **Given** an ESCALATED authorization ID, **When** the operator approves it, **Then** the response is `{ ok, approvalId, expiresAt }` and a HUMAN_APPROVAL entry is recorded. The entry holds the escalation ID, resource key, payee, amount, approver and expiry time.
2. **Given** an open approval, **When** the same session requests the same resource key with the same payee (case-insensitive) and exact amount string, **Then** the decision is AUTHORIZED. The AUTHORIZED entry's approval reference equals the escalation ID (T-POL-13, T-E2E-02).
3. **Given** that approval was consumed, **When** the same request is made again, **Then** it escalates again (T-E2E-02).
4. **Given** an approval, **When** a request differs in amount, **Then** it still escalates (T-POL-13).
5. **Given** no time-to-live is supplied, **When** the operator approves, **Then** the approval expires 600 seconds later.

---

### User Story 3 - The agent cannot approve its own escalations (Priority: P1)

The approval capability is reachable only with the operator's credential. Neither the agent's credential nor any agent tool can create an approval.

**Why this priority**: Self-approval would make human oversight meaningless (SEC-8).

**Independent Test**: Attempt an approval with the agent's credential and expect 401 (T-E2E-02).

**Acceptance Scenarios**:

1. **Given** the agent's credential, **When** it calls the approval operation, **Then** the response is 401 and no approval is recorded (T-E2E-02).
2. **Given** the agent's tool set, **When** it is inspected, **Then** it contains only `fetch_resource` and `check_budget`. No tool approves (T-AGT-01).

---

### User Story 4 - Approval never overrides a hard limit (Priority: P2)

Even with an open approval, a payment that breaks any DENY rule is denied. Examples are the hard cap, budgets, the payee or host allowlist, velocity and expiry.

**Why this priority**: Human approval lifts only the approval requirement; the mandate's hard limits stay absolute (INV-12).

**Independent Test**: Supply a matching approval for a payment that also exceeds the session budget. The decision is DENIED (T-POL-13).

**Acceptance Scenarios**:

1. **Given** a matching open approval, **When** the payment also violates `session_budget_exceeded` (or any DENY rule), **Then** the decision is DENIED. The approval is not consumed.

---

### User Story 5 - Operator approves from a command-line tool (Priority: P3)

The operator runs an approval command with an authorization ID and, optionally, an approver name. The tool uses the operator's own environment (control service URL and operator credential) and nothing else.

**Independent Test**: Run the approve command with an escalated ID and check the printed result and the ledger entry.

**Acceptance Scenarios**:

1. **Given** an operator environment with the control URL and operator credential, **When** the operator runs the approve command with an ID and approver, **Then** the approval is recorded under that approver name.
2. **Given** an ID with no ESCALATED entry, **When** the operator approves, **Then** the result is not found (404).

---

### Edge Cases

- **Approval expired before use**: the next request escalates again; the expired approval is not open.
- **Approval for a resource with a different query string**: the resource key excludes the query, so the approval still matches if the payee and amount match.
- **Request from a different session**: it does not match the approval and escalates.
- **Approval of an authorization ID that was DENIED or AUTHORIZED, not ESCALATED**: 404.
- **Several approvals for the same escalation**: each is a separate entry with its own approval ID and is single-use. Each one pays at most once, so two approvals allow exactly two payments, and a third identical request escalates again.
- **Re-approving an escalation**: returns 200 and records a new, independent approval. It never extends or revives an earlier one.
- **Several open approvals for the same session and resource key**: the lookup uses the most recent open one. An older open approval is not considered until the newer one is consumed or expires.
- **Mandate misconfigured so that the auto-approve limit is not below the hard cap, or the hard cap exceeds the session budget**: L2 refuses to start (feature 002). The constraint `autoApproveMax < hardCap ≤ sessionBudget` therefore always holds at runtime.
- **The agent's purpose text claims prior approval**: ignored; purpose is never a decision input (INV-5).

## Requirements *(mandatory)*

### Functional Requirements

**Escalation**

- **FR-001**: The policy MUST return ESCALATE with rule `human_approval_required` when all three conditions hold:
  - a payment option has no DENY violation;
  - its amount exceeds the auto-approve limit (default 20000 atomic, $0.02);
  - there is no matching human approval.

  *(SPEC: L2-2 R14, CFG-3)*
- **FR-002**: A matching approval MUST have:
  - the same payee, compared case-insensitively;
  - the exact same amount string;
  - the same session and resource key, as found by the open-approval lookup.

  *(SPEC: L2-2 R14, L2-4.2, INV-12)*
- **FR-003**: When no option is AUTHORIZED and at least one is ESCALATE, the overall decision MUST be ESCALATE, with that option's violations. *(SPEC: L2-2 decide)*
- **FR-004**: An ESCALATE decision MUST NOT be signed. It MUST be recorded as an ESCALATED entry with the violations, resource key, payee and amount. *(SPEC: L2-4 table, L2-5 step 6)*
- **FR-005**: On ESCALATE, the agent MUST return outcome ESCALATED with the violations and authorization ID. It MUST NOT retry, and it MUST report the authorization ID to the user. *(SPEC: L1-1 step 5, L1-3)*

**Approval**

- **FR-006**: The operator MUST be able to approve an escalation by its authorization ID, optionally supplying an approver name and a time-to-live in seconds (default 600). *(SPEC: L2-5)*
- **FR-007**: A successful approval MUST respond with `{ ok, approvalId, expiresAt }`. It records a HUMAN_APPROVAL entry with the escalation ID, resource key, payee, amount, approver and expiry time in milliseconds. *(SPEC: L2-5, L2-4 table)*
- **FR-008**: Approving an authorization ID with no ESCALATED entry MUST fail with 404. *(SPEC: L2-5)*
- **FR-009**: During authorization, the system MUST look up an open approval for (session, resource key). An approval is open when it has not expired at the decision time and has not been consumed. *(SPEC: L2-4.2, L2-5 step 2)*
- **FR-010**: An approval MUST be consumed exactly when an AUTHORIZED entry records its approval ID as the approval reference. A consumed approval cannot authorize again; other approvals of the same escalation stay open. *(SPEC: L2-4.2 as amended by SPEC v1.1 (008 T000), INV-12, T-E2E-02)*
- **FR-011**: An approval MUST NEVER override a DENY rule. When any DENY violation is present, the decision is DENIED regardless of approvals. *(SPEC: INV-12, T-POL-13)*
- **FR-012**: Approval state (open, expired or consumed) MUST be derived from ledger entries only. *(SPEC: L2-4.2, INV-7)*

**Operator tooling**

- **FR-013**: The system MUST provide an operator command that takes an authorization ID and an optional approver name and submits the approval. It reads only the control service URL and the operator credential from the operator's own environment. *(SPEC: §13, CFG-2 operator.env)*

### Non-Functional Requirements

- **NFR-001 (Security, role separation)**: The approval operation MUST accept only the operator credential. The agent, settlement and any other credential MUST receive 401, and no entry is appended. *(SPEC: INV-13, SEC-8, T-E2E-02)*
- **NFR-002 (Security, agent capability)**: The agent MUST have no tool or credential capable of approving. *(SPEC: L1-3, §3.3, SEC-8)*
- **NFR-003 (Security, least scope)**: An approval MUST authorize at most one payment, for one exact tuple (session, resource key, payee, amount), within its time-to-live. *(SPEC: INV-12)*
- **NFR-004 (Time-boundedness)**: Approvals MUST expire after their time-to-live (default 600 seconds). Expiry is evaluated against the decision time passed into the policy. *(SPEC: L2-5, L2-4.2, INV-5)*
- **NFR-005 (Concurrency)**: Approval lookup and consumption MUST happen inside the serialized authorize section, so that two concurrent requests cannot both consume one approval. *(SPEC: INV-8, L2-5)*
- **NFR-006 (Auditability)**: Every escalation, approval and approved payment MUST be traceable in the ledger, from ESCALATED (authorization ID) through HUMAN_APPROVAL (escalation ID, approver) to AUTHORIZED (approval reference). *(SPEC: L2-4)*
- **NFR-007 (Network exposure)**: The approval operation MUST be reachable only on the loopback interface of the control service. *(SPEC: L2-5)*

### Key Entities

- **Escalation**: an ESCALATED decision record, identified by its authorization ID, with the resource key, payee, amount and violations.
- **Human Approval**: a single-use grant tied to one escalation. It has an approval ID, escalation ID, resource key, payee, amount, approver and expiry time.
- **Operator**: the human role holding the operator credential. It is the only role that can approve or verify the ledger.
- **Approval Reference**: the field on an AUTHORIZED entry that holds the approval ID it consumed, or null when no approval was used.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the default mandate, a 50000-atomic request ends ESCALATED with `human_approval_required`. Zero signatures are produced for it (T-E2E-01).
- **SC-002**: 100% of approval attempts with the agent's credential are rejected with 401 (T-E2E-02).
- **SC-003**: After one operator approval, exactly one matching payment is PAID and CONFIRMED. The next identical request escalates again (T-E2E-02).
- **SC-004**: 0 cases in which an approval turns a DENY-rule violation into AUTHORIZED (T-POL-13).
- **SC-005**: A request differing from the approved tuple only in amount escalates in 100% of cases (T-POL-13).
- **SC-006**: An operator can approve an escalation with one command and the authorization ID alone.

## Assumptions

- Thresholds come from the mandate (feature 002 / CFG-3): auto-approve 20000, hard cap 100000, session budget 100000. The constraint `autoApproveMax < hardCap ≤ sessionBudget` is enforced at L2 startup (feature 002).
- No notification channel tells operators about new escalations. The operator learns the authorization ID from the agent's report or the ledger.
- There is no explicit "reject" operation. An unapproved escalation simply never pays.
- A single operator role exists; multi-approver or quorum approval is out of scope.
- Ledger mechanics are in feature 003, the policy engine in feature 002, the agent in feature 001, and credential separation in feature 007.
- HOW (endpoint shape, CLI invocation) is normative in SPEC.md §8.2 L2-5 and §13.
