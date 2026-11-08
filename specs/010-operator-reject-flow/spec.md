# Feature Specification: Escalation Lifecycle: Operator Rejection, Expiry and Notification

**Feature Branch**: `010-operator-reject-flow`

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "Operator reject flow for escalated payments: today a human operator (the holder of OPERATOR_TOKEN) can only approve an ESCALATED payment (POST /v1/approvals/:authorizationId, npm run approve); there is no way to say no. Add an explicit rejection: the operator rejects one escalation by its authorizationId through an operator-only L2 endpoint and an `npm run reject -- <authorizationId> [operator] [reason]` CLI. The rejection is recorded as a new append-only ledger entry (hash chain unchanged in form), copies session/resource/payee/amount from the ESCALATED entry (never from the request body), and is final: a rejected escalation can no longer be approved, and an approval that already exists for it cannot be used. The agent must be able to tell "rejected" apart from "still waiting": a later authorize for the same session and resource is DENIED with a new rule (e.g. human_rejected) rather than escalated again. Rejection never makes anything more permissive (INV-12 unchanged: approvals still never override DENY rules); the agent token can never reject or approve (per-role tokens, INV-13); L2 stays loopback-only. Out of scope: per-person operator identity / signed approvals (EXT-7), refunds. The local demo baseline (npm run demo:local summary) and the existing approval flow must stay unchanged."

## Clarifications

### Session 2026-10-18

- Q: How must an escalation end, and can any decision be reversed? → A: Every escalation ends in exactly one final state: approved, denied (rejected by the operator) or expired. The operator is notified in every case, and every flow runs to completion. Nothing can be reversed, so rejecting an escalation after it was approved, or after its payment completed, is not possible.
- Q: How should the operator receive notifications about new escalations and their outcomes? → A: An operator-only watch command (for example `npm run escalations -- --watch`) shows each new escalation and each final state as they happen. The control service builds the notifications from the ledger and makes no outbound calls.
- Q: When an escalation expires without a decision and the same session later asks for the same resource again, what should happen? → A: The request starts a new escalation with a new authorization ID, and the operator is notified again. Expiry means nobody answered, not that someone refused.
- Q: How long should a pending escalation wait for the operator's decision before it expires? → A: 5 minutes (300 seconds), fixed. It is not configurable.
- Q: While an escalation is still waiting for a decision, what should happen if the same session asks again for the same resource, at the same price and from the same payee? → A: The request gets back the pending escalation's authorization ID. No new escalation and no new notification are created.
- Q: What should happen when the operator approves an escalation that is already approved? → A: Return the existing approval (same approval ID), marked as already approved. Nothing is recorded, and each escalation pays at most once. This replaces the SPEC L2-4.2 rule that each repeated approval pays once more.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator says no to a pending escalation (Priority: P1)

An agent asks to buy a resource that costs more than the auto-approve limit, so the payment is
escalated to a human. While the escalation is still pending, the operator decides it should not
be paid and rejects it by its authorization ID, optionally giving a reason. The escalation ends
in the final state **denied**, the decision is recorded permanently in the audit ledger, and the
agent's later attempts to buy that resource in the same session are refused with a distinct
"rejected by a human" reason.

**Why this priority**: This is the feature. Human oversight needs an explicit "no" that is
recorded, enforced and distinguishable from "not decided yet".

**Independent Test**: Escalate a 50000-atomic request, reject it with the operator credential,
then repeat the same request in the same session. The repeat is DENIED with rule
`human_rejected`, nothing is signed, and the ledger shows the escalation followed by its denial
and then the DENIED decision.

**Acceptance Scenarios**:

1. **Given** a pending escalation, **When** the operator rejects it, **Then** the response
   confirms the denial with a rejection ID and the time it was recorded, and one rejection entry
   is appended to the ledger. The entry holds the escalation ID and the session, resource key,
   payee and amount copied from the escalation, plus the operator label and the reason if given.
2. **Given** a denied escalation, **When** the same session requests the same resource again,
   **Then** the decision is DENIED with rule `human_rejected`. Nothing is signed and nothing is
   reserved against the budget.
3. **Given** a denied escalation, **When** the agent receives that DENIED decision, **Then** its
   outcome is DENIED with `human_rejected` listed among the rules, so it can report that a human
   refused the purchase. It does not retry.

---

### User Story 2 - Every escalation ends in exactly one final state (Priority: P1)

An escalation starts pending and ends exactly once: **approved** by the operator, **denied** by
the operator, or **expired** because no decision arrived in time. A final state is never
changed, replaced or reversed.

**Why this priority**: A decision that can be overturned is not a control, and an escalation
that never ends leaves both the agent and the operator without an answer.

**Independent Test**: For each final state, drive one escalation to it, then try both operator
actions on it. The opposite action is refused with a conflict that names the current state,
repeating the deciding action returns the existing decision, both actions on an expired
escalation are refused, and the ledger gains no entry in any case.

**Acceptance Scenarios**:

1. **Given** a denied escalation, **When** the operator tries to approve it, **Then** the
   approval is refused with a conflict naming the denial, and nothing is appended.
2. **Given** an approved escalation, **When** the operator tries to reject it, **Then** the
   rejection is refused with a conflict naming the approval, and nothing is appended. This holds
   whether or not the approved payment has happened yet.
3. **Given** an expired escalation, **When** the operator tries to approve or reject it, **Then**
   the action is refused with a conflict naming the expiry, and nothing is appended.
4. **Given** an approved escalation, **When** the operator approves it again, **Then** the
   response returns the existing approval with the same approval ID, marked as already
   approved. Nothing is appended, and the escalation still allows at most one payment.
5. **Given** an approve and a reject for the same pending escalation arriving at the same time,
   **When** both are processed, **Then** they are handled one after the other. The first one
   decides the final state, and the second is refused with a conflict.
6. **Given** a pending escalation, **When** the same session requests the same resource again
   with the same payee and amount, **Then** the decision is ESCALATE with the pending
   escalation's authorization ID. No new escalation is created and the operator is not notified
   again.
7. **Given** a pending escalation, **When** the same session requests the same resource with a
   different amount or payee, **Then** that is a different purchase and it escalates separately
   under a new authorization ID.

---

### User Story 3 - Undecided escalations expire (Priority: P1)

If the operator neither approves nor rejects an escalation within 5 minutes of its creation, it
ends in the final state **expired**. The expiry is recorded in the ledger, and no later decision
can change it.

**Why this priority**: Without expiry an escalation can stay open forever, so the flow never
completes and the operator is never told it went unanswered.

**Independent Test**: Escalate a request, let the expiry window pass without a decision, and
check that an expiry entry is recorded, the operator is notified, and a later approve or reject
is refused.

**Acceptance Scenarios**:

1. **Given** a pending escalation, **When** the expiry window passes with no decision, **Then**
   one expiry entry is appended to the ledger and the escalation is expired.
2. **Given** an expired escalation, **When** the same session requests the same resource again,
   **Then** the request starts a new escalation with a new authorization ID, and the operator is
   notified of it. The expired escalation stays expired.
3. **Given** an expired escalation, **When** the agent's next request is evaluated, **Then** no
   `human_rejected` rule fires for it. Expiry means nobody answered, not that someone refused.

---

### User Story 4 - The operator is notified of every escalation and every outcome (Priority: P1)

The operator learns about each new escalation and about each final state (approved, denied or
expired) without having to read the ledger or wait for the agent's report. They run an
operator-only watch command, which lists the escalations still pending and then shows each new
escalation and each state change as it happens. The control service builds these notifications
from the ledger and makes no outbound network calls.

**Why this priority**: The operator can only decide in time if they know an escalation exists,
and every flow must end with the operator informed.

**Independent Test**: Start the watch command, drive one escalation to each final state, and
check that the command showed each escalation and its outcome, each with the authorization ID,
resource, amount and state.

**Acceptance Scenarios**:

1. **Given** the watch command is running, **When** a new escalation is recorded, **Then** the
   command shows its authorization ID, session, resource, payee, amount and expiry time within 5
   seconds.
2. **Given** the watch command is running, **When** an escalation reaches any final state,
   **Then** the command shows the authorization ID and the final state within 5 seconds.
3. **Given** the watch command was not running when events happened, **When** the operator
   starts it, **Then** it first lists every escalation still pending, so no open escalation is
   missed.
4. **Given** a notification, **When** it is shown, **Then** it contains no credential, payment
   header or key material.

---

### User Story 5 - Only the operator can decide (Priority: P1)

Rejecting, like approving, is reserved for the human operator's credential. The agent cannot
reject or approve, and a failed attempt leaves the ledger untouched.

**Why this priority**: If the agent could decide its own escalations, human oversight would be
meaningless (SEC-8). Per-role credentials are a non-negotiable principle (INV-13).

**Independent Test**: Attempt a rejection with the agent's credential, the settlement credential
and no credential. Each is refused with 401 and the ledger length is unchanged.

**Acceptance Scenarios**:

1. **Given** the agent's credential, **When** it calls the reject operation, **Then** the response
   is 401 and no entry is appended.
2. **Given** the agent's tool set, **When** it is inspected, **Then** it still contains only
   `fetch_resource` and `check_budget`. No tool rejects or approves.
3. **Given** the reject operation, **When** it is called from anywhere other than the control
   service's own machine, **Then** it is unreachable, because the control service listens only on
   the loopback interface.

---

### User Story 6 - Operator rejects from a command-line tool (Priority: P2)

The operator runs one command with the authorization ID and, optionally, an operator label and a
reason. The tool uses the operator's own environment file (control service URL and operator
credential) and nothing else, exactly like the existing approve command.

**Why this priority**: The operation must be usable by a human without hand-written HTTP
requests, but the control itself (stories 1–5) is what matters most.

**Independent Test**: Run the reject command against a pending escalation and check the printed
confirmation, the exit code and the ledger entry. Run it again and check that no second entry is
appended.

**Acceptance Scenarios**:

1. **Given** an operator environment with the control URL and operator credential, **When** the
   operator runs the reject command with an ID, an operator label and a reason, **Then** the
   denial is recorded under that label and reason, the confirmation is printed, and the command
   exits 0.
2. **Given** an ID with no escalation, **When** the operator rejects it, **Then** the result is
   not found, nothing is appended and the command exits non-zero.
3. **Given** an escalation the operator already denied, **When** the operator rejects it again,
   **Then** the response returns the existing denial, marked as already denied, and no second
   entry is appended.
4. **Given** no authorization ID, **When** the operator runs the command, **Then** it prints its
   usage line and exits with the usage error code, as the approve command does.

---

### Edge Cases

- **Reject an authorization ID that was AUTHORIZED or DENIED, not escalated**: not found;
  nothing is appended. Only escalations can be rejected.
- **Same resource, different query string** (for example the same report for another city):
  the resource key ignores the query, as it does for approvals, so a denial covers it.
- **Same resource, different price or payee in the same session after a denial**: still DENIED
  with `human_rejected`. A denial covers the session and resource, not one exact amount, so a
  changed price cannot escape it.
- **Same resource, different session**: unaffected. The request escalates or is authorized
  exactly as it would be without the denial.
- **A request that is denied by the operator and also breaks other DENY rules** (for example the
  session budget): DENIED, and every violated rule is listed, `human_rejected` included.
- **A request below the auto-approve limit for a denied resource in the same session**: DENIED
  with `human_rejected`. The denial is about the resource, not the price.
- **An approved escalation whose approval is never used**: the escalation stays approved. The
  approval itself lapses after its own time-to-live (600 seconds by default, as today), the
  operator is notified that it lapsed unused, and a later request for the same purchase starts a
  new escalation.
- **An open approval from an earlier escalation when a later escalation for the same session and
  resource is denied**: the denial's DENY rule takes precedence, so the earlier approval can no
  longer pay (INV-12: an approval never overrides a DENY rule).
- **Reason text**: optional, length-limited and stored as given. It is never an input to any
  decision, like the agent's stated purpose.
- **Missing or malformed body**: the operator label defaults to `operator` and the reason is
  absent. A label or reason of the wrong type is refused with 400 and nothing is appended.
- **Control service restarts**: escalation states are rebuilt from the ledger, so a denial or
  expiry recorded before the restart still holds after it, and the hash chain still verifies.
  An escalation whose expiry window passed while the service was down expires when the service
  starts again.

## Requirements *(mandatory)*

### Functional Requirements

**Lifecycle**

- **FR-001**: Every escalation MUST start pending and end in exactly one final state: approved,
  denied or expired. *(SPEC: proposed L2-4.3)*
- **FR-002**: Final states MUST be permanent. No operation removes, replaces or reverses one.
  *(SPEC: INV-9)*
- **FR-003**: Approve and reject MUST decide only a pending escalation. On an escalation in a
  final state, repeating the action that decided it MUST return the existing decision, marked as
  already decided (see FR-010 for reject, FR-011 for approve). The opposite action, or any action
  on an expired escalation, MUST be refused with a conflict that names the current state. In
  every one of these cases nothing is appended. *(SPEC: L2-5)*
- **FR-004**: The current state of every escalation MUST be derived from ledger entries only.
  *(SPEC: INV-7, L2-4.2)*
- **FR-005**: At most one escalation MAY be pending per purchase, where a purchase is the same
  session, resource key, payee (case-insensitive) and exact amount string. A request that would
  escalate while such an escalation is pending MUST return ESCALATE with that escalation's
  authorization ID. It creates no new escalation and no new notification, and the request itself
  is still recorded in the ledger. *(SPEC: L2-2 R14, L2-4, proposed L2-4.3)*

**Rejection**

- **FR-006**: The operator MUST be able to reject a pending escalation by its authorization ID,
  optionally supplying an operator label (default `operator`) and a reason. *(SPEC: L2-5)*
- **FR-007**: A successful rejection MUST append exactly one rejection entry to the ledger. The
  entry MUST hold a new rejection ID, the escalation ID, the operator label, the reason if given,
  and the session, resource key, payee and amount copied from the escalation. Those four values
  MUST NEVER be taken from the request. *(SPEC: L2-4 table, INV-9)*
- **FR-008**: A successful rejection MUST respond with the rejection ID and the time it was
  recorded. *(SPEC: L2-5)*
- **FR-009**: Rejecting an authorization ID that has no escalation MUST fail as not found and
  append nothing. *(SPEC: L2-5)*
- **FR-010**: Rejecting an escalation the operator already denied MUST return the existing
  denial, marked as already denied, and append nothing. *(SPEC: L2-5)*
- **FR-011**: Approving an escalation the operator already approved MUST return the existing
  approval (same approval ID and expiry), marked as already approved, and append nothing. An
  escalation MUST authorize at most one payment, which replaces the SPEC L2-4.2 rule that "if
  one escalation is approved several times, each approval pays once". *(SPEC: L2-4.2, L2-5,
  INV-12)*

**Enforcement**

- **FR-012**: The policy MUST include a new DENY rule, `human_rejected`. It fires when the
  request's session and resource key match a denied escalation, whatever the amount or payee.
  *(SPEC: proposed L2-2 R15)*
- **FR-013**: `human_rejected` MUST be evaluated with the other DENY rules. It is collected with
  them rather than stopping evaluation, and, like them, it takes precedence over escalation and
  over any approval. *(SPEC: L2-2, INV-12)*
- **FR-014**: Whether a session and resource are denied MUST be passed to the policy as context
  derived from the ledger. The policy stays a pure function and reads no storage.
  *(SPEC: INV-5, INV-7)*
- **FR-015**: The agent MUST surface `human_rejected` like any other DENY rule: outcome DENIED
  with the rule listed, no retry. *(SPEC: L1-1, L1-3)*

**Expiry**

- **FR-016**: A pending escalation MUST expire when its expiry window, a fixed 300 seconds from
  its creation, passes without a decision. The window is not configurable. Exactly one expiry
  entry is appended, holding the escalation ID and the time it expired.
  *(SPEC: proposed L2-4.3)*
- **FR-017**: Expiry MUST be evaluated against the control service's clock, independently of
  any agent or operator request, so that an unanswered escalation ends even if nobody asks
  about it again. The expiry MUST be recorded within 5 seconds of the window ending.
  *(SPEC: proposed L2-4.3)*
- **FR-018**: An expired escalation MUST NOT restrict later requests. A later request for the
  same session and resource is evaluated as if the expired escalation never existed, so it
  escalates again under a new authorization ID. *(SPEC: L2-2 R14, proposed L2-4.3)*

**Notification**

- **FR-019**: The operator MUST be notified when an escalation is created, when it reaches each
  final state, and when an approval lapses unused. Each notification carries the authorization
  ID, session, resource, payee, amount and the new state. *(SPEC: proposed L2-4.3)*
- **FR-020**: Notifications MUST be delivered through an operator-only watch operation on the
  control service and built from ledger entries only. The control service MUST NOT send
  notifications to any outside service. *(SPEC: L2-5, Constitution V)*
- **FR-021**: The watch operation MUST first list every pending escalation with its expiry time,
  then report each new escalation and state change within 5 seconds of it being recorded.
  *(SPEC: L2-5)*

**Operator tooling**

- **FR-022**: The system MUST provide an operator command, `reject`, that takes an authorization
  ID and an optional operator label and reason. It reads only the control service URL and the
  operator credential from the operator's own environment file. Its exit codes match the approve
  command: 0 on success, 1 on an HTTP or network error, 2 on a missing argument.
  *(SPEC: §13, CFG-2 operator.env)*
- **FR-023**: The system MUST provide an operator command, `escalations`, that lists pending
  escalations and, with `--watch`, keeps reporting new escalations and state changes until
  stopped. It uses the same operator environment file as `approve` and `reject`.
  *(SPEC: §13, CFG-2 operator.env)*

### Non-Functional Requirements

- **NFR-001 (Security, role separation)**: The reject and watch operations MUST accept only the
  operator credential. Every other credential, or none, MUST receive 401, and no entry is
  appended. The credential check happens before the request body is read.
  *(SPEC: INV-13, SEC-8)*
- **NFR-002 (Security, monotonicity)**: A denial MUST only ever make decisions more restrictive,
  and an expiry MUST NOT make them more permissive. No combination of denials, expiries and
  approvals may AUTHORIZE a request that would be DENIED or ESCALATED without them.
  *(SPEC: INV-12)*
- **NFR-003 (Concurrency)**: Reject, approve, expiry and authorize MUST be serialized against each
  other, so each escalation gets exactly one final state and a decision never sees a
  half-recorded one. *(SPEC: INV-8)*
- **NFR-004 (Auditability)**: Every escalation MUST be traceable in the ledger from creation
  (authorization ID) to its final state (who decided, why and when, or when it expired) and on to
  every later decision it affected. *(SPEC: L2-4)*
- **NFR-005 (Network exposure)**: The reject and watch operations MUST be reachable only on the
  loopback interface of the control service, and the control service makes no new outbound
  connections. *(SPEC: L2-5)*
  *Amended by 012 (SPEC v1.8, L2-7):* L2 makes one kind of outbound connection, to the configured approval
  service (Auth0), to ask the approver. Operator notification stays pull-based, and L2 gains no inbound route.
- **NFR-006 (Untrusted text)**: The reason and operator label are free text. They MUST be
  length-limited, stored as data only, and never used as a decision input. *(SPEC: INV-5)*
- **NFR-007 (Notification safety)**: Notifications MUST NOT carry credentials, payment headers or
  key material. Serving or reading them MUST NOT block, delay or change any decision, and a
  watcher that disconnects loses nothing, because the ledger is the record.
- **NFR-008 (Regression)**: The local demo summary MUST stay unchanged. The existing approval
  behavior MUST stay unchanged except for three intended changes, each to be reflected in SPEC
  and the affected tests:
  - approve is refused on a denied or expired escalation;
  - approving an approved escalation returns the existing approval instead of granting another
    payment (today covered by the existing tests "each approval pays once" and "a second
    approval of the same escalation stays open");
  - a repeat request while an escalation is pending returns that escalation instead of creating
    a new one.

  *(SPEC: T-E2E-01, T-E2E-02, T-POL-13, L2-4.2, definition of done)*
- **NFR-009 (Proven safety)**: The enforcement MUST be shown to fail without the new rule: with
  the rule removed, a request for a denied session and resource escalates again.
  *(Constitution VIII)*

### Key Entities

- **Escalation**: an ESCALATED decision, identified by its authorization ID, holding the session,
  resource key, payee, amount and violations. It now has a state: pending, then exactly one of
  approved, denied or expired.
- **Human Rejection**: the entry that moves a pending escalation to denied. It holds a rejection
  ID, the escalation ID, the operator label, an optional reason, and the session, resource key,
  payee and amount copied from the escalation.
- **Escalation Expiry**: the entry that moves a pending escalation to expired. It holds the
  escalation ID and the time of expiry.
- **Human Approval**: unchanged in shape. It moves a pending escalation to approved and grants
  one payment within its own time-to-live.
- **`human_rejected` rule**: a new DENY rule that fires for any request whose session and
  resource key match a denied escalation.
- **Operator Notification**: a report to the operator about a new escalation or a state change,
  carrying the authorization ID, session, resource, payee, amount and state. It is built from
  ledger entries and shown by the watch command; it is not stored separately.
- **Operator**: unchanged. The human role holding the operator credential, now able to approve,
  reject and verify the ledger, and the recipient of notifications.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of escalations reach exactly one final state (approved, denied or expired),
  and none stays pending longer than 305 seconds after it was created.
- **SC-002**: 0 final states are changed afterwards. On a non-pending escalation, every opposite
  action is refused, every repeat of the deciding action returns the existing decision, and the
  ledger gains no entry in either case. 0 escalations authorize more than one payment.
- **SC-003**: After a denial, 100% of later requests for that resource in that session are
  refused with `human_rejected`. 0 are escalated, signed or paid.
- **SC-004**: 100% of reject attempts with a non-operator credential, or none, are refused, and
  the ledger length is unchanged after each one.
- **SC-005**: For 100% of escalations, a running watch command shows the escalation and its final
  state, each within 5 seconds of it being recorded, and a newly started watch command lists
  100% of escalations still pending.
- **SC-006**: An operator can reject a pending escalation with one command and the authorization
  ID alone, and sees a confirmation with the rejection ID.
- **SC-007**: A request for the same resource from a different session behaves exactly as it
  would without the denial in 100% of cases.
- **SC-008**: The `npm run demo:local` summary is unchanged, and every existing approval test
  passes, apart from the tests for the three intended changes listed in NFR-008, which are
  updated to the new behavior.
- **SC-009**: For every escalation, an auditor can follow the trail from creation to final state
  (who, why, when) to each later decision it affected, using the ledger alone.

## Assumptions

- **Amends feature 004.** 004 states "There is no explicit reject operation. An unapproved
  escalation simply never pays." This feature adds rejection, expiry and notification. It also
  changes three 004 behaviors: approve is refused on a denied or expired escalation, re-approving
  returns the existing approval (004's edge cases "Several approvals for the same escalation" and
  "Re-approving an escalation" no longer apply), and a repeat request while an escalation is
  pending reuses it. Everything else in 004 stands.
- **Scope of a denial is (session, resource key).** This follows the description ("a later
  authorize for the same session and resource is DENIED") and matches how approvals are keyed.
  It deliberately ignores amount and payee, so that a changed price cannot escape a denial.
- **No reversals.** A final state is never undone. To buy a denied resource, the agent must
  start a new session. Refunds are out of scope (EXT-9).
- **Repeated rejections are idempotent.** The first rejection decides; repeating it returns the
  existing denial and appends nothing.
- **Fixed expiry window.** Escalations expire 300 seconds after creation. The window is a
  constant, not a mandate field, so the mandate format and its startup checks are unchanged.
- **Pull-based notification only.** Push channels (webhook, Slack, email) are out of scope. They
  would add an outbound connection and a new secret to the service that holds the payer key, and
  can be a later feature.
- **One shared operator credential.** Per-person identity and signed approvals or rejections are
  out of scope (EXT-7). The operator label is self-declared and recorded as given.
- **Reason length limit**: 280 characters; operator label limit: 64 characters. Longer values are
  refused with 400.
- **SPEC.md changes** (for the plan): new ledger entry types in L2-4, a new L2-4.3 "Escalation
  lifecycle" section, the "approved several times" sentence in L2-4.2 replaced, the reject and
  watch operations in L2-5, rule R15 `human_rejected` in L2-2, the `reject` and `escalations`
  commands in §13, and new tests (proposed T-POL-15 for the rule, T-E2E-07 for the end to
  end flow). INV-12 and INV-13 are unchanged.
