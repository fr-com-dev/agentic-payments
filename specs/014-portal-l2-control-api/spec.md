# Feature Specification: Portal Administration: the Rest of the Control API in the Portal

**Feature Branch**: `014-portal-l2-control-api`

**Created**: 2026-11-10

**Status**: Draft

**Input**: User description: "As x402 portal administrator I want to wire the full portal api with the L2 Control api."

## Clarifications

### Session 2026-11-10

- Q: The portal already uses every user-account route of L2. Which of the remaining control
  capabilities does "the full API" bring into the portal? → A: Everything a person reads or
  decides: the pending escalations, their events, the budget, the ledger check, and approving and
  rejecting. The two machine capabilities (requesting a payment authorization, reporting a
  settlement) stay with the agent and the settlement verifier. The constitution is amended,
  because today the portal may not approve or reject.
- Q: Who may use the new capabilities? → A: Administrators only, through a separate permission
  the organization assigns. They see every user's escalations, by identifier. Users get nothing
  new.

### Session 2026-11-11

- Q: With the administration area off, the portal's answers still carry the new fields that say
  so (the area is unavailable; the person is a user and not an administrator). FR-001 and SC-011
  said "exactly as in 013". Which side changes? → A: The spec. The fields stay, because the web
  app reads them to hide the area; FR-001 and SC-011 now allow additive fields that only say the
  area is unavailable. Nothing else differs from 013 when the area is off.

## Where the portal stands today

Feature 013 wired the portal to every user-account capability of the control layer (L2). The rest
of the control API is not reachable from the portal, on purpose (013 FR-034, FR-049). This feature
is about that rest.

| Control layer capability | Who uses it today | In the portal today | In this feature |
|---|---|---|---|
| User accounts: registration, crypto account, cards, expense policies, disable and enable, platform limits and seller list | each user, through the portal | yes (013) | unchanged |
| List the payments waiting for a human (pending escalations) | the operator, from the command line | no | administrators (User Story 1) |
| Approve a pending escalation | the operator; the approver by phone (012) | no | administrators (User Story 2) |
| Reject a pending escalation | the operator; the approver by phone (012) | no | administrators (User Story 2) |
| Follow what happened to each escalation (events) | the operator, from the command line | no | administrators (User Story 3) |
| Budget status of an agent run and of a user | the agent | only a user's own 24-hour figures, in their wallet | administrators (User Story 4) |
| Check that the ledger's hash chain verifies | the operator, from the command line | no | administrators (User Story 5) |
| Request a payment authorization (the signed payment) | the agent only | no | stays out (FR-027) |
| Report a settlement result | the settlement verifier only | no | stays out (FR-027) |

## User Scenarios & Testing *(mandatory)*

Terms used below:
- **Administrator**: a person the organization has given the portal's administrator permission.
  They look after the deployment's payments as a whole. An administrator may also be a user with
  their own wallet and policies (013); the two are separate permissions.
- **User**: as in 013: a person who signs in to the portal and owns one profile, one wallet and
  their own expense policies.
- **Operator**: the person who today decides escalations and checks the ledger from the command
  line, with the operator's credential (004, 010). That path stays as it is.
- **Administration area**: the part of the portal only administrators see.
- **Escalation**: a payment above the applicable auto-approve limit and within the per-payment
  cap. It waits for a human for up to 300 seconds and ends exactly once: approved, denied or
  expired (010).
- **Decision**: an approval or a rejection of a pending escalation.
- **Decision path**: where a decision came from: the operator's command line, the approver's
  phone (012) or, new here, the portal.
- **Reference code**: the short code every escalation carries, the same on every path, so that
  two people can tell they are looking at the same payment.
- **Machine capability**: a control layer capability meant for another process, never for a
  person: requesting a payment authorization (the agent) and reporting a settlement (the
  settlement verifier).

### User Story 1 - An administrator sees every payment that is waiting for a human (Priority: P1)

An administrator signs in to the portal and opens the administration area. It lists every
escalation that is pending right now, for every user and for the platform account, oldest first.
For each one they see what is being bought and from whom, the amount in USDC, whose payment it
is, the reference code, whether the approver's phone has already been asked, and how long is left
before it expires. The list keeps itself current while it is open.

**Why this priority**: An escalation lives for 300 seconds. Today only someone with a terminal and
the operator's credential can see one. Seeing them in the portal is the smallest useful slice and
everything else in this feature builds on it.

**Independent Test**: Start an agent run whose purchase is above the auto-approve limit. Sign in
as an administrator and open the administration area: the escalation is listed within 5 seconds,
with the right seller, amount, user identifier and reference code, and a countdown. Let it expire:
it leaves the list. Sign in as a user who is not an administrator: there is no administration
area and every request for it is refused.

**Acceptance Scenarios**:

1. **Given** two pending escalations, one for a user and one for the platform account, **When** an
   administrator opens the administration area, **Then** both are listed, oldest first, each with
   its seller, payee, amount, owner (the user's identifier, or "platform account"), reference
   code and time left.
2. **Given** the list is open, **When** a new escalation is created, **Then** it appears within 5
   seconds without the administrator reloading the page.
3. **Given** a listed escalation, **When** it is approved, rejected or expires on any path,
   **Then** it leaves the pending list within 5 seconds.
4. **Given** backchannel approval is on and the approver's phone was asked, **When** the
   administrator looks at that escalation, **Then** they see that a phone request is open.
5. **Given** no escalation is pending, **When** the administrator opens the list, **Then** it says
   that nothing is waiting, and when it was last read.
6. **Given** a signed-in user without the administrator permission, **When** they request any part
   of the administration area, **Then** they are refused, nothing about any escalation is
   revealed, and the control layer is not called.

---

### User Story 2 - An administrator approves or rejects a pending payment (Priority: P1)

From the list, the administrator opens one escalation. The portal shows exactly what would be
approved: the seller, the payee, the amount, whose payment it is, the reference code and the time
left. They approve it, after confirming their identity if they have not done so recently, or they
reject it with one of a few fixed reasons. The portal shows the outcome at once. The agent's next
attempt at that purchase goes through if approved, and is refused if rejected.

**Why this priority**: Deciding is the reason an administrator opens the list. It lets a person
unblock or stop a payment from a browser, inside the 300-second window, without the operator's
credential.

**Independent Test**: Create an escalation. As an administrator, approve it in the portal: the
ledger shows one approval that names the portal as the path and the administrator by identifier,
and the agent's retry pays. Create another and reject it: the agent's retry is denied and nothing
is paid. Create a third and try to approve it as an ordinary user, with an agent-service sign-in,
and after it has expired: each attempt is refused and records nothing.

**Acceptance Scenarios**:

1. **Given** a pending escalation, **When** an administrator approves it and has confirmed their
   identity within the last 15 minutes, **Then** one approval is recorded for exactly that
   payment, the escalation shows as approved, and the agent's next attempt at that purchase is
   authorized once.
2. **Given** a pending escalation, **When** an administrator approves it without a recent
   identity confirmation, **Then** nothing is recorded and the portal asks them to confirm their
   identity; after they do, the approval goes through if the escalation is still pending.
3. **Given** a pending escalation, **When** an administrator rejects it with a reason picked from
   the list, **Then** the escalation is denied for good, the agent's next attempt is refused, and
   the agent learns nothing about the reason or about who rejected.
4. **Given** an escalation the operator already rejected from the command line, **When** an
   administrator approves it in the portal, **Then** nothing changes and the portal says it was
   already denied, and on which path.
5. **Given** an escalation that expired while the administrator was reading it, **When** they
   approve or reject it, **Then** nothing is recorded and the portal says it expired.
6. **Given** an administrator who is also a user, **When** an escalation of their own agent run is
   pending, **Then** they can see it and can't decide it.
7. **Given** an approved escalation, **When** the user pauses the policy or disables their account
   before the agent retries, **Then** the retry is denied: an approval never overrides a rule
   that denies.
8. **Given** the same administrator sends the same approval twice, **When** the second arrives,
   **Then** the first approval is returned and nothing new is recorded.

---

### User Story 3 - An administrator follows what happened to each escalation (Priority: P2)

The administration area shows a trail of what happened: each escalation created, each phone
request, each approval and rejection with its path and who decided, each expiry. An administrator
who was away sees everything that happened since they last looked, in order, with nothing missing
and nothing twice.

**Why this priority**: The pending list shows only the present. To answer "what happened to that
payment at 10:42?" or "who approved it?", an administrator needs the trail. It is read-only, so
it carries less risk than deciding and can ship after it.

**Independent Test**: Produce one escalation approved from the portal, one rejected from the
command line and one left to expire. Open the trail: all three appear in order with their final
state, path and decider. Close the portal, produce two more outcomes, reopen: exactly those two
are new.

**Acceptance Scenarios**:

1. **Given** escalations decided on three different paths, **When** the administrator opens the
   trail, **Then** each shows its outcome, the path it was decided on, the decider's identifier
   where there is one, the reference code and the times.
2. **Given** an administrator who last read the trail an hour ago, **When** they open it again,
   **Then** they see every event since then, in order, each exactly once.
3. **Given** any event in the trail, **When** it is shown, **Then** it carries no credential, no
   payment header, no text written by the agent and no text from the approval service.

---

### User Story 4 - An administrator sees the budget behind a payment (Priority: P2)

Before deciding, the administrator wants to know what approving would mean. For an escalation,
the portal shows the budget it counts against: what the agent run has spent and has left, and, for
a user's payment, what that user has spent in the last 24 hours against the user daily ceiling.

**Why this priority**: It makes a decision an informed one. The figures already exist in the
control layer; only the agent can read them today.

**Independent Test**: Create an escalation in a run that has already paid twice. Open it as an
administrator: the run's spent and remaining amounts match the ledger, and for a user's payment
the 24-hour figure matches the one in that user's own wallet view.

**Acceptance Scenarios**:

1. **Given** a pending escalation of a user's run, **When** the administrator opens it, **Then**
   they see the run's budget (limit, spent, remaining), the user's spending in the last 24 hours
   and the user daily ceiling, all in USDC.
2. **Given** an escalation of a run on the platform account, **When** the administrator opens it,
   **Then** they see that run's budget under the deployment's mandate, and no user figures.
3. **Given** the amount of the escalation is more than what remains, **When** the administrator
   opens it, **Then** the portal says that approving will not make it payable.

---

### User Story 5 - An administrator checks the ledger's integrity (Priority: P3)

The administrator asks the portal whether the ledger still verifies. The portal answers with the
number of entries and either "verified" or the position of the first entry that does not verify.

**Why this priority**: The check exists today on the command line and is run rarely. Having it in
the portal completes the picture and costs little, but nobody is blocked without it.

**Independent Test**: With an intact ledger, run the check as an administrator: it reports the
entry count and that the chain verifies. Against a ledger with one altered entry, it reports the
position of the break. As an ordinary user, the check is refused.

**Acceptance Scenarios**:

1. **Given** an intact ledger, **When** an administrator runs the check, **Then** the portal shows
   the number of entries, that the chain verifies, and when it was checked.
2. **Given** a ledger whose chain is broken, **When** an administrator runs the check, **Then**
   the portal shows where it breaks and says that the operator must act; it offers no repair.
3. **Given** any check, **When** it runs, **Then** nothing is written to the ledger.

---

### Edge Cases

- **Two decisions at once.** Two administrators, or an administrator and the operator, or an
  administrator and the approver's phone, decide the same escalation at the same moment. Exactly
  one decision is recorded. The other person is told the actual final state and the path it came
  from; nothing is recorded for them.
- **Expiry during a decision.** The 300 seconds run out between the confirmation screen and the
  click. The decision is refused as expired. A later approval can't revive it.
- **The control layer can't be reached.** The administration area says so. No decision is half
  made. An administrator who retries after a timeout gets the first outcome back, never a second
  one.
- **The permission is taken away** while the administrator is signed in. Their next request is
  refused.
- **Identity confirmation takes too long.** The administrator confirms their identity and the
  escalation expires meanwhile. The portal says it expired.
- **An administrator's own payment.** They see it, marked as theirs, and can't decide it. Another
  administrator, the operator or the phone approver can.
- **Approval that can't pay.** The budget is used up, the policy was paused, the seller left the
  seller list or the account was disabled after the approval. The agent's retry is denied by that
  rule. The approval is spent or lapses, as today.
- **A repeat of the same purchase** while its escalation is pending shows as the same escalation,
  not a second one (010).
- **Many escalations.** Each lives at most 300 seconds, so the pending list stays short. The
  trail grows without bound and is read in pages.
- **A broken ledger.** The check reports the break. The portal changes nothing and keeps showing
  what the control layer answers.
- **The feature is off.** The portal has no administration area, every request for it gets "not
  found", and the control layer refuses the portal on every capability outside user accounts, as
  in 013.
- **User accounts are off.** There is no portal, so there is no administration area. The operator
  and the phone approver work as today.

## Requirements *(mandatory)*

Requirement tags name the SPEC.md section each one amends or relies on.

### Functional Requirements

**Access**

- **FR-001**: The administration area MUST be off unless the deployment turns it on. With it off,
  the portal and the control layer MUST behave exactly as in 013, apart from additive fields in the
  portal's answers that only say the area is unavailable and that the person is not an
  administrator. *(SPEC: L2-8, CFG-2)*
- **FR-002**: Only a signed-in person who holds the portal's administrator permission MAY use the
  administration area. A user without it gets nothing new from this feature, for their own
  payments included (clarified 2026-11-10). *(SPEC: L1-6 auth, SEC-14, SEC-19)*
- **FR-003**: The administrator permission MUST be separate from portal access (the permission to
  start agent runs). Holding one MUST NOT give the other. The organization assigns it through its
  sign-in; the portal offers no way to grant it, request it or take it. A system identity can't
  hold it. *(SPEC: L1-6 auth, L2-8)*
- **FR-004**: A request for any part of the administration area by anyone else MUST be refused
  before the control layer is called, MUST reveal nothing about any escalation, budget or the
  ledger, and MUST record nothing. This covers a user without the permission, a sign-in issued
  for the agent service, and the credentials of the agent, the verifier and the operator.
  *(SPEC: INV-13, SEC-19, SEC-20)*
- **FR-005**: The agent MUST gain no tool, field or route from this feature. Its tools stay
  `fetch_resource` and `check_budget`. *(SPEC: L1-3, L1-6, Constitution I)*
- **FR-006**: An administrator's own user features (profile, wallet, policies) MUST work exactly
  as in 013. Being an administrator MUST NOT let a person read or change another user's profile,
  wallet, cards or policies, change the platform limits or the seller list, or disable another
  user. *(SPEC: SEC-19, L2-8)*

**Seeing what is waiting**

- **FR-007**: The administration area MUST list every pending escalation of the deployment, for
  every user and for the platform account, oldest first. Each item MUST show: the reference code,
  the owner (the user's identifier, or "platform account"), the seller and the resource, the
  payee, the amount in USDC, when it was created, the time left, and the state of a phone
  approval request when there is one. *(SPEC: L2-4.3, L2-5 escalation reads, L2-7)*
- **FR-008**: While it is open, the list MUST be at most 5 seconds old and MUST show when it was
  last read. An escalation that reached a final state MUST leave it. *(SPEC: L2-4.3)*
- **FR-009**: A user MUST be shown to administrators only by their identifier. A user's name and
  email MUST NOT be shown to anyone but that user. *(SPEC: SEC-16, 013 NFR-004)*
- **FR-010**: Nothing shown in the administration area MAY contain a credential, a payment header,
  the agent's stated purpose, the seller's offer text or the approval service's text. Text that
  comes from a seller, such as a resource address, MUST be shown as plain text.
  *(SPEC: L2-5 escalation reads, SEC-12, SEC-16)*

**Deciding**

- **FR-011**: An administrator MUST be able to approve a pending escalation in the portal. The
  approval MUST have exactly the effect an operator's approval has today: it lifts only the
  approval requirement, for one exact session, resource, payee and amount, once, for the same
  limited time. It MUST NEVER override a rule that denies. *(SPEC: INV-12, L2-4.2, L2-5
  approvals)*
- **FR-012**: An administrator MUST be able to reject a pending escalation in the portal, with the
  effect an operator's rejection has today: the escalation is denied for good and the same
  purchase is refused. *(SPEC: L2-2 R15, L2-4.3, L2-5 rejections)*
- **FR-013**: Before a decision is sent, the portal MUST show what is being decided (the seller,
  the payee, the amount, the owner, the reference code and the time left) and ask the
  administrator to confirm. *(SPEC: L2-8)*
- **FR-014**: An approval MUST require the administrator to have confirmed their identity within
  the last 15 minutes. A rejection MUST NOT require it. The control layer judges whether the
  confirmation is recent enough, as it does for a change that loosens a policy.
  *(SPEC: SEC-21, 013 FR-007)*
- **FR-015**: An administrator MUST NOT be able to decide an escalation of their own agent run.
  The check MUST be made by the control layer, from the identifiers, and not only by the portal's
  screens. *(SPEC: SEC-8)*
- **FR-016**: A rejection reason MUST be picked from a short fixed list. No text an administrator
  types MAY reach the control layer or the ledger. The reason and the decider MUST NOT reach the
  agent. *(SPEC: SEC-12, L2-2 R15)*
- **FR-017**: Every escalation MUST still end exactly once. A decision on an escalation that is
  already approved, denied or expired MUST record nothing and MUST tell the administrator its
  actual state and the path it was decided on. Repeating one's own decision MUST return the first
  outcome. *(SPEC: L2-4.3, INV-9)*
- **FR-018**: A decision from the portal MUST be recorded in the same serialized section as
  payment decisions and as decisions from the other paths. *(SPEC: INV-8, L2-7)*
- **FR-019**: The operator's command line and the approver's phone MUST keep working, unchanged,
  whether the administration area is on or off. *(SPEC: L2-4.3, L2-7)*

**Following what happened**

- **FR-020**: The administration area MUST show a trail of escalation events: created, phone
  request sent or failed, approved, denied, expired and approval lapsed. Each event MUST show its
  time, the reference code, the owner, and for a decision the path and the decider's identifier.
  *(SPEC: L2-5 escalation events)*
- **FR-021**: An administrator MUST be able to read the trail from any point onward and receive
  every later event exactly once and in order, however long they were away. *(SPEC: L2-5
  escalation events)*

**Budgets**

- **FR-022**: For any escalation in the list or the trail, an administrator MUST be able to see
  the budget it counts against: the run's limit, spent and remaining amounts and the auto-approve
  limit, and, for a user's payment, the user's spending over the last 24 hours and the user daily
  ceiling. Every figure MUST come from the ledger. *(SPEC: INV-7, L2-5 budget)*
- **FR-023**: A budget MUST be reached only through an escalation. The administration area MUST
  NOT accept a typed user identifier, so that no route of the portal takes one.
  *(SPEC: SEC-19, 013 FR-004)*
- **FR-024**: When an escalation's amount is more than what remains of its budget, the portal MUST
  say that approving it will not make it payable. *(SPEC: L2-2 R11, R12)*

**Ledger integrity**

- **FR-025**: An administrator MUST be able to ask whether the ledger's chain verifies. The answer
  MUST show the number of entries, whether it verifies, the position of the first entry that
  does not, and when it was checked. *(SPEC: INV-9, L2-5 ledger verify)*
- **FR-026**: The check MUST be read-only. The portal MUST offer no way to repair, rewrite or
  delete anything in the ledger. *(SPEC: INV-9)*

**What stays out**

- **FR-027**: The portal MUST NOT offer, in any form, the two machine capabilities: requesting a
  payment authorization and reporting a settlement result. They stay with the agent and with the
  settlement verifier. No credential the portal holds MAY be accepted for them.
  *(SPEC: INV-2, INV-4, INV-10, INV-13, Constitution I and IV)*

**Credentials and isolation**

- **FR-028**: The portal MUST reach the administration capabilities with a role credential of its
  own, different from the one it uses for user accounts. That credential MUST open only: the
  escalation list, the escalation events, approvals, rejections, the budget reads and the ledger
  check. It MUST NOT open a user-account capability or a machine capability. The credential for
  user accounts MUST still open nothing but user accounts. *(SPEC: INV-13, §3.3)*
- **FR-029**: The portal MUST never hold the operator's, the agent's or the verifier's credential,
  and still MUST refuse to start if it can see a payment key. *(SPEC: INV-2, INV-13, §4.1 A12)*
- **FR-030**: The administrator's sign-in MUST NOT be forwarded to the control layer. The portal
  tells the control layer who decided, by identifier, and when that person confirmed their
  identity. *(SPEC: Constitution V, SEC-15)*
- **FR-031**: The control layer MUST gain no public route and keep listening only where it does
  today. *(SPEC: §3.1, Constitution V)*

**Recording**

- **FR-032**: Every decision from the portal MUST be one append-only ledger entry that names the
  portal as the path, the administrator by identifier and, for a rejection, the fixed reason.
  Existing entries are never rewritten. *(SPEC: INV-9, L2-4 table)*
- **FR-033**: Reading the list, the trail, a budget or the ledger check MUST write nothing to the
  ledger. *(SPEC: INV-9)*
- **FR-034**: The portal's own log MUST record each use of the administration area: the time, the
  capability, the outcome and the administrator's identifier. It MUST never record a credential,
  a name, an email or a request body. *(SPEC: SEC-16, 013 NFR-003)*

### Non-Functional Requirements

- **NFR-001 (Security: fail closed)**: Every failure ends in no decision recorded: a missing or
  stale permission, a sign-in that can't be verified, an identity confirmation that is too old, an
  escalation that is no longer pending, and a control layer that can't be reached or answers
  unclearly. *(SPEC: SEC-3)*
- **NFR-002 (Security: no new payment authority)**: Nothing in this feature can sign, move funds
  or raise a limit. The most a portal approval can release is one payment that the applicable
  policy and the platform limits already allow with a human's approval. *(SPEC: INV-2, INV-12)*
- **NFR-003 (Security: secrets)**: No credential, key or sign-in token appears in the ledger, the
  logs, the portal's responses, the trail or the agent's results. A known-value scan over test
  output MUST find none. *(SPEC: SEC-10, SEC-16)*
- **NFR-004 (Availability)**: Payment decisions and the two existing decision paths MUST NOT
  depend on the portal being up. *(SPEC: L2-5, 013 NFR-005)*
- **NFR-005 (Proven safety)**: Each of these checks MUST be shown to fail without it:
  - the administrator permission (FR-002): without it, an ordinary user approves a payment;
  - the own-payment check (FR-015): without it, an administrator approves their own run's payment;
  - the identity confirmation for approvals (FR-014): without it, a sign-in from yesterday
    approves;
  - the separation of the two portal credentials (FR-028): without it, the user-account
    credential approves, or the administration credential changes a policy;
  - the single final state (FR-017, FR-018): without the pending check that runs with the write
    in the serialized section, a portal approval and a command-line rejection of the same
    escalation are both recorded.

  *(Constitution VIII)*
- **NFR-006 (Regression)**: The `npm run demo:local` summary and the L1-4 baseline MUST stay
  unchanged. Every existing test MUST pass; only tests updated for intended additive fields may
  change. *(SPEC: T-E2E-01, definition of done)*
- **NFR-007 (Responsiveness)**: The pending list MUST appear within 2 seconds of opening the
  administration area, and the outcome of a decision within 2 seconds of confirming it, so that a
  decision fits well inside the 300-second window.
- **NFR-008 (Usability and accessibility)**: The administration area MUST meet what 013 requires
  of the portal: phone and desktop widths, full keyboard use and WCAG 2.1 level AA. The time left
  MUST be readable without relying on color. Every refusal tells the administrator what
  happened.
- **NFR-009 (Abuse limits)**: Requests to the administration area MUST be bounded per client
  address before a sign-in is verified and per person after it, as the rest of the portal is.
  *(SPEC: SEC-14, SEC-19)*

### Key Entities

- **Administrator**: a person who holds the administrator permission. Named in the ledger and the
  trail only by the same kind of identifier a user has. May also be a user.
- **Administrator Permission**: what the organization assigns to let a person use the
  administration area. Separate from portal access.
- **Escalation**: a payment waiting for a human. Has an owner (a user or the platform account), a
  seller and resource, a payee, an amount, a reference code, a creation time, an expiry and one
  state: pending, approved, denied or expired.
- **Decision**: an approval or a rejection of one escalation. Has a path, a decider and a time; a
  rejection also has a reason from the fixed list.
- **Decision Path**: the operator's command line, the approver's phone or the portal.
- **Escalation Event**: one step in an escalation's life, with its position in the ledger's
  order, so that the trail can be read from any point.
- **Budget Status**: for a run, its limit, spent and remaining amounts and the auto-approve limit;
  for a user, their spending over the last 24 hours and the user daily ceiling. Derived from the
  ledger.
- **Ledger Check Result**: the number of entries, whether the chain verifies, and where it breaks.
- **Administration Credential**: the portal's second role credential, for the administration
  capabilities only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator who is already signed in decides a pending payment in under 30
  seconds from opening the administration area.
- **SC-002**: 100% of pending escalations appear in an open list within 5 seconds of being
  created, and leave it within 5 seconds of reaching a final state.
- **SC-003**: Across 100 pairs of simultaneous decisions from two different paths, 0 escalations
  end with two recorded decisions.
- **SC-004**: 0 requests by people without the administrator permission, or with another
  service's sign-in, return any escalation, budget or ledger information or record a decision.
- **SC-005**: 0 payments are authorized that the applicable policy or the platform limits deny,
  whatever was approved in the portal.
- **SC-006**: 0 escalations are decided in the portal by the person whose agent run asked for the
  payment.
- **SC-007**: For every decision, an auditor can tell from the ledger alone which path it came
  from and who made it.
- **SC-008**: Every control layer capability meant for a person is reachable from the portal (7 of
  7 in the table above), and 0 of the 2 machine capabilities are.
- **SC-009**: An administrator can tell whether the ledger verifies within 10 seconds of asking.
- **SC-010**: A known-value scan finds 0 occurrences of a credential, a key or a sign-in token in
  the ledger, logs, portal responses or agent results.
- **SC-011**: With the administration area off, the portal and the control layer answer every
  existing request as they do today (apart from the additive fields FR-001 allows), and the `npm run demo:local` summary is unchanged (`spent
  on-chain: 0.006 USDC`, `hash chain ok=true`).
- **SC-012**: With the portal unavailable, 100% of escalations can still be decided from the
  command line and by phone.

## Assumptions

- **"The full portal API" means the capabilities for people** (clarified 2026-11-10). 013
  already connected the portal
  to every user-account capability. What is left of the control API is the escalation reads, the
  two decisions, the budget read, the ledger check and the two machine capabilities. The first
  five are wired for administrators. The two machine capabilities are not: a browser that could
  request a signed payment or report a settlement would undo the separation of payment authority
  and the "trust the chain" rule (Constitution I and IV).
- **The administrator is a new kind of person in the portal** (clarified 2026-11-10). 013 has
  only users, and says that
  one permission gives both portal access and agent runs. This feature adds a second, separate
  permission. Who receives it is the organization's choice; the operators of the deployment are
  the natural first holders.
- **The operator's command line stays.** It needs no portal and no sign-in, so it remains the way
  to decide when the portal is down. The phone approver (012) stays too.
- **Users get nothing new here.** A user seeing or deciding their own escalations, a payment
  history view and notifications stay out of scope, as 013 left them.
- **An administrator can't decide their own payment.** Separation of duties is assumed. In a
  deployment with a single administrator who is also the only user, their own escalations are
  decided from the command line or by phone.
- **Approving needs a fresh identity confirmation; rejecting does not.** Approving loosens,
  rejecting tightens: the same line 013 draws for policy changes, with the same 15 minutes.
- **Rejection reasons are a fixed list.** The operator's command line accepts free text today. The
  portal does not, so that the rule "no text a person typed reaches the control layer" holds for
  everything typed in the portal.
- **Administrators see identifiers, not names.** A profile is visible only to its owner (013
  NFR-004). Showing names to administrators would be a privacy change of its own.
- **Budgets are reached through an escalation.** There is no search by user and no list of users,
  which keeps the rule that no portal route takes a user identifier.
- **No push.** The list refreshes itself while it is open. Telling an administrator about a new
  escalation when the portal is closed is out of scope; the phone approver covers that case.
- **Constants are today's.** The 300-second escalation window, the approval's validity and the
  15-minute identity confirmation are unchanged.
- **Also out of scope:** editing the platform limits or the seller list in the portal, disabling
  another user, an administrator acting on behalf of a user, exporting the ledger, and any view
  of settlements.
- **The portal is trusted to name the administrator.** The control layer can't verify the person
  itself, because their sign-in is never forwarded to it. A compromised portal could approve
  pending escalations in an administrator's name. It could still release only payments that the
  policy and the platform limits allow with approval, one per escalation. This is a new accepted
  residual risk.
- **Constitution amendment** (for the plan to size; MINOR is expected):
  - Principle V gains the administration credential as a sixth role credential. The sentence
    about the portal's user-account credential stays true as written: that credential still
    can't approve or reject.
  - Principle V's description of the portal stays "holds no payment key" and adds that it relays
    an administrator's decision and never signs. The project guide's "decides nothing" is
    reworded the same way.
  - The residual risks gain the one above and a stolen administrator sign-in, bounded by the
    identity confirmation.
- **SPEC.md changes** (for the plan):
  - **§3.3, INV-13, §4.1 A12:** the sixth role and its credential; what the portal may name.
  - **L2-4:** the portal as a decision path on approval and rejection entries; fixed reasons.
  - **L2-5:** which credential opens the escalation reads, approvals, rejections, the budget read
    and the ledger check; the decider and the identity confirmation on a portal decision.
  - **L2-8:** the administration area and its routes.
  - **CFG-2:** the switch and the new credential.
  - **§11:** SEC-8 amended (the operator's credential is no longer the only one that can decide);
    new rows for a compromised portal, a stolen administrator sign-in and self-approval.
  - **§12:** tests for each must-fail check in NFR-005 and for the new routes.
