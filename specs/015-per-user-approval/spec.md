# Feature Specification: Per-User Backchannel Approval

**Feature Branch**: `claude/015-per-user-approval-1a763f`

**Created**: 2026-11-12

**Status**: Draft

**Input**: User description: "Per-user backchannel approval: an escalated payment is approved by the person the
cloud agent is acting for, not by one approver named in the infrastructure." The full description (problem, what
is wanted, the facts established on 2026-11-12, the four open decisions and the constraints) is the owner's
request of 2026-11-12; its content is carried into the sections below.

## Clarifications

### Session 2026-11-12

- Q: SPEC v1.13 leaves no person's run with a token from the tenant anywhere; where should people's runs come
  from (D5)? → A: Keep v1.13. This feature is built and proven against the stand-in approval service only. It
  adds no application to the tenant and changes nothing about who may start a run; giving people a way to start
  runs in a deployed environment is a later decision of its own. Rejected: adding people's runs in this feature
  (reverses `specs/013` research R20), and waiting for a separate feature first.
- Q: When is the owner's own verified answer enough to approve their agent's escalated payment (D1)? → A: For
  every escalated amount. The person's own expense policy, their budgets and the platform limits stay the hard
  bounds and are checked again when the payment is signed. No new limit and no second person. Rejected: a
  platform limit above which a second person decides, and an answer that only notifies.
- Q: How should L2 learn the owner's identity at the approval service, their Auth0 user ID (D3)? → A: The hosted
  agent sends it with each payment request, taken from the verified sign-in token. L2 checks it against the user
  by recomputing the one-way identifier, uses it to address the approval request and keeps nothing: the ledger
  goes on naming people by their one-way identifier only. Rejected: recording it once at portal onboarding,
  which would link each user's identifier to their Auth0 user ID in the ledger for good.
- Q: Must a person's sign-in and their phone approval always come from the same Auth0 tenant (D4)? → A: Yes. A
  person whose sign-in issuer is not the approval service's is never asked by phone; their escalations wait for
  the operator and the portal's administrators. The identity check enforces it, because the one-way identifier
  is made from the issuer and the subject. Local runs with the dev issuer therefore never send a request.
  Rejected: a recorded link between two identities, which is new machinery and a new thing to trust.
- Q: Must everyone enroll a phone at first sign-in (D2)? → A: No, enrollment is optional. A person who skips it
  gets no push; their escalations wait for the operator and the portal's administrators, and they can see why.
  They can set their phone up themselves at any time. Nothing changes at sign-in for people who already have an
  account. Rejected: enrollment required at first sign-in.

## Where approval stands today

| Who can decide an escalation | Today | In this feature |
|---|---|---|
| The operator, from the command line (004, 010) | every escalation | unchanged |
| An administrator, in the portal (014) | every escalation except their own run's | unchanged |
| The one configured approver, by phone (012) | every eligible escalation, whoever started the run | removed: no approver is configured anywhere |
| The person the run is for, by phone | nobody | their own escalations only (User Story 1) |

One consequence follows from the last two rows and from SPEC v1.13, which this feature keeps (FR-028): the
tenant has two applications, none for the agent, so no person's token from the tenant starts a run. A deployed
agent accepts system identities only, and runs as a person exist only locally, with the dev issuer, whose users
are not users of the tenant. A run with no person behind it stays on the operator path. So once the configured
approver is gone, a deployed environment sends no approval request to any phone until a later feature lets people
start runs there. The platform account's escalations are decided by the operator and the administrators. What
was checked live on 2026-11-12 (the platform's escalation approved and refused from one phone) no longer
happens, and this feature has no live check with a real phone: it is proven against the stand-in approval
service.

## User Scenarios & Testing *(mandatory)*

Terms used below:
- **Owner**: the person a hosted agent run acts for. Every payment request of that run, and every escalation it
  creates, records them as its user (013).
- **Approval service**: the sign-in tenant (Auth0), which reaches a person's phone and returns their answer to
  L2 (012).
- **Approval request**: one backchannel request from L2 to the approval service, for one escalation (012).
- **Operator path**: the operator's command line (004, 010). The portal's administration area (014) is a third
  path. Both stay as they are.
- **A run with no person behind it**: the scripted regression, a run started by a system identity, and the local
  command-line agent.

### User Story 1 - A person approves their own agent's payment from their own phone (Priority: P1)

A person starts a hosted agent run. The agent asks for something priced above what that person's expense policy
approves by itself, so L2 escalates the payment. L2 asks the approval service to reach that person, and nobody
else. Their phone shows the amount, the payee, the resource and the reference code. They approve. L2 checks that
the answer is theirs and is about this exact payment, records the approval, and the purchase pays: in the same
request when they answer within two minutes, on the agent's next request otherwise. If they refuse, the
escalation is denied, as an operator's rejection would deny it.

**Why this priority**: This is the feature. The person whose money is spent decides, where they are, and each
person is asked about their own payments only.

**Independent Test**: With a stand-in approval service and two onboarded people, escalate one payment in a run
of the first. Check that exactly one approval request was sent, that it was addressed to the first person, that
the second received nothing, and that the first person's approval pays the purchase exactly once. Repeat with a
refusal: the purchase is DENIED with `human_rejected` and nothing is signed.

**Acceptance Scenarios**:

1. **Given** per-user approval is on and a person's run asks for a payment that needs a human, **When** L2
   escalates it, **Then** L2 sends exactly one approval request, addressed to the owner of that escalation, and
   records that it did.
2. **Given** that request is pending, **When** the owner approves, **Then** L2 verifies the answer (FR-012 to
   FR-014) and records one approval naming the owner and the backchannel path.
3. **Given** the owner approves within 120 seconds, **When** the waiting request is re-evaluated, **Then** it
   returns AUTHORIZED with the signed payment, signed with the owner's own account and with every budget and
   DENY rule checked again at that moment.
4. **Given** the owner refuses, **When** L2 receives the refusal, **Then** one rejection is recorded naming the
   owner, and the same session's next request for that resource is DENIED with `human_rejected`.
5. **Given** two people each have a pending escalation, **When** each answers, **Then** each answer decides only
   that person's own escalation.

---

### User Story 2 - Only the owner's verified answer counts (Priority: P1)

L2 is the only signer, so L2 alone decides whether an answer counts. An answer from another person approves
nothing, even when it is genuine, signed by the approval service and about the same payment. An identity that
does not belong to the user L2 already trusts is never sent a request.

**Why this priority**: Without it, one user could approve another user's spending, or a compromised caller could
point a person's approval request at a phone of its own choosing.

**Independent Test**: With two people, A and B, and a stand-in approval service: return B's signed answer for
A's escalation, and check that nothing is approved. Then give L2 an identity for A that does not match A, and
check that no request is sent on it. Must-fail checks: without the owner check, B's answer approves A's payment;
without the identity check, the request goes to the identity that was given.

**Acceptance Scenarios**:

1. **Given** user A's pending escalation, **When** the approval service returns a valid, signed answer from
   user B about that same payment, **Then** no approval is recorded, one verification failure is recorded naming
   the check, the escalation stays pending and nothing is signed.
2. **Given** L2 is given an identity at the approval service for a user, **When** that identity does not resolve
   to the user L2 already trusts, **Then** L2 refuses it: no approval request is sent on it and it is not kept.
3. **Given** any answer that fails one of today's checks (issuer, signature, audience, client, validity, the open
   request, the payment details, single use), **When** L2 receives it, **Then** it is refused exactly as today.

---

### User Story 3 - A run with no person behind it never reaches anyone's phone (Priority: P1)

The scripted regression, a run started by a system identity and the local command-line agent act for nobody. When
one of them escalates a payment, no approval request is sent to anybody. The escalation waits for the operator
or an administrator, as it does today when backchannel approval is off.

**Why this priority**: With no configured approver there is nobody such a run could rightly ask. Asking some
person anyway would bring the single approver back under another name.

**Independent Test**: With per-user approval on, run the scripted plan, one run as a system identity and one
run of the command-line agent, each with a payment that escalates. Check that the stand-in approval service
received no request, that each escalation is pending for the operator, and that an operator approval still pays.

**Acceptance Scenarios**:

1. **Given** an escalation that records no user, **When** L2 decides whether to send an approval request,
   **Then** it sends none and records the escalation as one that asks nobody.
2. **Given** per-user approval is on, **When** the scripted regression runs, **Then** its outcome is the baseline
   (ESCALATED at step 4) and no phone is notified.
3. **Given** any deployment, **When** its configuration is read, **Then** no setting names a person to ask on
   behalf of runs that have none.

---

### User Story 4 - A person without an enrolled phone can see why their payment waits (Priority: P2)

A person who has not set up a phone for approvals gets no push. Their escalated payment is not lost: it waits for
the operator or an administrator. The person can see that it is waiting, and why, in words this system chose. They
can set up their phone themselves, with their own sign-in, without asking anyone.

**Why this priority**: The feature must degrade to today's safe behavior for people who are not ready for it,
and they must not be left guessing.

**Independent Test**: Have the stand-in approval service refuse the request for a person with no phone. Check
that the escalation stays pending, that no retry is sent, that the operator can still approve it, and that the
person sees their payment waiting with the reason "we could not send a request to your phone".

**Acceptance Scenarios**:

1. **Given** a person with no enrolled phone, **When** their payment is escalated, **Then** no push reaches
   anyone, the failed request is recorded as permanent and not retried, and the escalation stays pending.
2. **Given** that pending escalation, **When** the person looks at their own waiting payments, **Then** they see
   it, that it waits for the operator, and the reason, taken from a fixed list.
3. **Given** a person signed in with their own account, **When** they set up their phone for approvals, **Then**
   they can finish it themselves, and their next escalation reaches that phone.

---

### User Story 5 - One person's agent cannot use up everyone's allowance (Priority: P2)

The limit on approval requests (10 in any rolling hour) is counted for each person. A prompt-injected agent that
escalates again and again reaches its own owner's limit, and only theirs. Other people's requests are still sent.

**Why this priority**: The limit protects a person from being worn down. Counted for everyone together, it would
let one user's agent silence approval for all the others.

**Independent Test**: In one hour, create 11 different escalations for person A and one for person B. Check
that A was asked 10 times, that the 11th is recorded as capped and waits for the operator, and that B was asked.
Must-fail check: with one count for everybody, B is not asked.

**Acceptance Scenarios**:

1. **Given** 10 approval requests sent to person A in the last hour, **When** another of A's payments is
   escalated, **Then** no request is sent, the cap is recorded as having applied, and the escalation waits for
   the operator.
2. **Given** A is at the limit, **When** one of B's payments is escalated, **Then** B's request is sent.
3. **Given** a pending escalation for a purchase, **When** the same purchase is requested again, **Then** no
   new request is sent and none is counted, as today.

---

### User Story 6 - No approver is configured anywhere (Priority: P2)

Whoever deploys the system no longer names an approver: not in L2's settings, not in an environment's parameter
file, not in the tenant's configuration or its pipeline. Setting up the tenant no longer depends on one person's
account existing. Nothing can bring a fallback approver back by configuration.

**Why this priority**: It removes the thing that does not scale, and it removes a setting that would otherwise
look as if it still mattered.

**Independent Test**: Read every place a deployment is configured and find no approver. Start L2 with a leftover
approver setting and check that it refuses to start and names the setting. Plan the tenant's configuration with
no approver given and check that it succeeds.

**Acceptance Scenarios**:

1. **Given** the feature is delivered, **When** L2's settings, each environment's parameter file, the tenant's
   configuration and its pipeline's variables are read, **Then** none names an approver.
2. **Given** a leftover approver setting, **When** L2 starts with backchannel approval on, **Then** it refuses
   to start and names the setting, never its value.
3. **Given** an environment whose approval settings are complete without an approver, **When** it is validated
   and deployed, **Then** it passes.

---

### User Story 7 - The operator and the auditor see whose phone was asked and how each request ended (Priority: P3)

For every escalation, the operator's and the administrators' views show whether a person was asked, who (by
their identifier, never a name), and what happened. The ledger alone tells how every approval request ended,
including a request nobody answered, in a clean timeout and after L2 restarted.

**Why this priority**: The fallback paths need to know when they are needed, and the audit trail must say who
decided now that the decider changes with every run. It also closes a finding of the 2026-11-12 live run.

**Independent Test**: Drive one escalation through each outcome (approved, refused, unanswered, failed, capped,
not asked), once without a restart and once with L2 restarted while the request is open. Read the views and the
ledger: each shows the owner's identifier, the path and how the request ended. None shows a token, a handle,
text from the approval service, a name or an email.

**Acceptance Scenarios**:

1. **Given** an escalation decided by its owner's phone, **When** the operator lists or watches escalations,
   **Then** the event shows the final state, the backchannel path and the owner's identifier as the decider.
2. **Given** an approval request that nobody answered, **When** an auditor reads the ledger, **Then** they can
   tell that the request ended unanswered, both when L2 ran throughout and when it restarted in between.
3. **Given** entries written before this feature, with the configured approver, **When** the ledger is verified
   and read, **Then** the chain verifies and those decisions still show who decided.

---

### Edge Cases

- **The owner's account is disabled while their request is open.** Their answer may still be recorded; the
  payment is decided against their account as it then is, so it is DENIED (013). An approval never lifts that.
- **The owner is blocked or deleted at the approval service.** The service refuses the request: a permanent
  failure, and the escalation waits for the operator.
- **The owner's phone is removed or reset after it was set up.** Same as never enrolled (User Story 4).
- **The same human has two accounts at the sign-in service** (for example, a social sign-in and a password).
  They are two users, each with their own account, policies, phone and limit. An answer from one never decides
  the other's escalation.
- **An identity whose form carries personal data.** Some sign-in methods build the identifier from an email
  address. It is never stored or shown: it travels from the hosted agent to L2 and from L2 to the approval
  service, and nowhere else (FR-020).
- **A compromised hosted agent names another user.** To have a request sent it must also give that user's
  identity at the approval service, which the one-way identifier does not reveal. If it has both, that user
  receives a request about a payment from their own account that they did not start. Only their own tap
  approves it, and their own limit bounds how often.
- **An administrator and the owner decide at the same moment.** Both are recorded inside the serialized section;
  the first decides and the second changes nothing (010, 014).
- **An administrator's own run.** They may not decide it in the portal (SEC-29). Their own phone answer decides
  it, as it does for every other person (FR-014): L2 verifies that answer itself.
- **The owner answers after the escalation expired.** Nothing changes. The expiry is final.
- **L2 restarts with requests open for several people.** Each is resumed for its own owner, from the ledger,
  without a new request and without any setting that names a person.
- **A request that was open when this feature is deployed**, addressed to the old configured approver. It is
  not resumed for anyone else; it ends without an answer and the escalation follows its usual 300 seconds.
- **User accounts are off.** No payment names a user, so per-user approval has nobody to ask (FR-001).
- **A payment the policy auto-approves or denies.** Never escalated, so never sent to anyone, as today.

## Requirements *(mandatory)*

### Functional Requirements

**Activation and configuration**

- **FR-001**: Per-user approval is how backchannel approval works once this feature is delivered: there is no
  other mode and no switch between one approver and per-user. Backchannel approval stays off unless configured,
  and it needs user accounts to be on: with backchannel approval on and user accounts off, L2 MUST refuse to
  start and name the settings. *(SPEC: L2-7, L2-8, CFG-2)*
- **FR-002**: No setting anywhere MAY name an approver. The approver MUST be removed from L2's settings, every
  environment's parameter file, the tenant's configuration and its outputs, the tenant pipeline's variables and
  the script that creates them. *(SPEC: L2-7, CFG-2, §3.1 Azure profile, T-IAC-01 rule 19, T-IAC-02)*
- **FR-003**: A leftover approver setting MUST never be used. With backchannel approval on, L2 MUST refuse to
  start when it sees one, naming the setting and never its value. *(SPEC: L2-7, CFG-2)*
- **FR-004**: An environment's approval settings MUST validate and deploy without an approver. Setting up the
  tenant MUST NOT depend on any one person's account existing. *(SPEC: §3.1 Azure profile, T-IAC-01 rule 19)*
- **FR-005**: This feature MUST NOT add a credential anywhere, and GitHub MUST still hold no credential of
  L2's. If enrollment (FR-018) turns out to need one, the plan MUST stop and justify it before going on.
  *(SPEC: §3.3, Constitution V)*

**Who is asked**

- **FR-006**: When L2 records a new escalation whose owner is a person, and the escalation is eligible, L2 MUST
  send exactly one approval request, addressed to that owner and to nobody else. Eligible means, in addition to
  today's conditions (not a repeat of a pending purchase, not operator-only), that the owner's limit has room
  (FR-015) and that the payment request carries an identity for the owner that passed the check of FR-009. *(SPEC:
  L2-7 eligibility, L2-4.3)*
- **FR-007**: An escalation that records no user MUST never produce an approval request. This covers the
  scripted regression, a run started by a system identity and the local command-line agent. No setting, request
  field or default MAY route such an escalation to a person. *(SPEC: L1-4, L1-6, L2-7, SEC-18)*
- **FR-008**: There MUST be no fallback approver. When the owner cannot be asked, for any reason, nobody is
  asked by phone and the escalation waits for the operator path and the portal's administrators. *(SPEC: L2-7)*
- **FR-009**: L2 MUST learn the owner's identity at the approval service only from the payment request: the
  hosted agent sends it with each payment request of a person's run, beside the user it already names. L2 MUST
  check it against that user, by recomputing the user's one-way identifier from the approval service's issuer
  and the identity. An identity that does not match MUST be refused: no approval request is sent on it, and
  the escalation is recorded as one that asks nobody. A payment request that names a user and carries no
  identity is not an error: nobody is asked by phone. In both cases the payment itself is decided as it would
  be without the identity, and the escalation follows FR-008.
  L2 MUST use the identity only to address the approval request and MUST NOT keep it (FR-020). *(SPEC: L1-6 the
  user, L2-5 authorize, §7)*
- **FR-010**: The identity in FR-009 MUST come from a verified sign-in token, fixed before the run begins. No goal
  text, model output or tool input can set or change it, and the agent's tools MUST stay `fetch_resource` and
  `check_budget` with no input for it. *(SPEC: L1-3, L1-6, Constitution I)*
- **FR-011**: A person can be asked by phone only when their sign-in comes from the approval service's own
  issuer. A person who signed in anywhere else, the local dev issuer included, MUST never be sent an approval
  request: their escalations follow FR-008. The check of FR-009 MUST enforce this by itself, with no list of
  issuers and no recorded link between two identities. *(SPEC: L1-6 auth, L2-7)*

**Whose answer counts**

- **FR-012**: Before recording an approval, L2 MUST verify everything it verifies today: the issuer through its
  published signing keys, the audience, L2's client, the validity time with 60 seconds of tolerance, the open
  request, the payment details field for field, and single use. *(SPEC: L2-7 outcomes, SEC-17)*
- **FR-013**: The "approver" check MUST become an owner check: the answer's verified identity MUST be the owner of
  the escalation it answers. L2 decides that from the signed answer alone, by recomputing the one-way identifier
  from the answer's issuer and subject and comparing it with the escalation's user, so the check needs no stored
  identity and works the same after a restart. A genuine, signed answer from any other person MUST approve
  nothing; L2 records one verification failure naming the check, and the escalation stays pending. *(SPEC: L2-7,
  SEC-17, SEC-19)*
- **FR-014**: A verified answer from the owner MUST be enough to approve the escalation, for every escalated
  amount: no amount needs a second person, and this feature adds no limit of its own. The answer lifts only the
  approval requirement, once, for one exact purchase: the person's expense policy, their budgets, the platform
  limits and every DENY rule still apply when the payment is signed. The portal's rule is unchanged: an
  administrator still cannot decide a payment of their own run there (`own_payment`). *(SPEC: INV-12, L2-4.2,
  SEC-29)*

**The limit**

- **FR-015**: L2 MUST send at most 10 approval requests to one person in any rolling hour, counted for that
  person from the ledger. One person reaching the limit MUST NOT stop or delay a request to another person. An
  escalation over its owner's limit stays pending, and the cap is recorded as having applied. *(SPEC: INV-7,
  L2-7 eligibility, SEC-18)*
- **FR-016**: Repeats of a pending purchase MUST still reuse the pending escalation, send nothing and count
  nothing. Automated checks MUST still never notify anyone. *(SPEC: L2-4.3, L1-4, SEC-18)*

**A person who cannot be asked**

- **FR-017**: When the approval service refuses a request because the owner has no enrolled phone, L2 MUST
  record a permanent failure, send no retry and leave the escalation pending. *(SPEC: L2-7 start)*
- **FR-018**: Setting up a phone for approvals is optional. Nobody MUST be made to do it to sign in, to use the
  portal or to start a run, and this feature MUST NOT change sign-in for people who already have an account. A
  person MUST be able to set up their own phone themselves, at any time, with their own sign-in and with no
  administrator's help. A person who has not done so is in a normal state, not an error: FR-017 and FR-019
  apply. *(SPEC: L2-8, `auth0/`)*
- **FR-019**: A person MUST be able to see, for their own pending payments only, that a payment is waiting for
  the operator and why. The reason MUST come from a fixed list written by this system (a request could not be sent to
  the phone, which covers a phone that was never set up; the hourly limit reached; the approval service could
  not be reached; the request went unanswered; the answer could not be accepted; phone approval is not available
  for this sign-in), never from the
  approval service's text. The route MUST take no user identifier: the person comes from the verified token.
  *(SPEC: L2-8, SEC-19, SEC-12)*

**What is recorded**

- **FR-020**: The ledger MUST name the person an approval request was addressed to, and the person who approved
  or refused, by the one-way identifier it already uses for users, and by nothing else. The person's identity at
  the approval service is an identifier taken from a verified token, not text a person typed, and some sign-in
  methods build it from an email address. L2 MUST NOT store it: it MUST NOT appear in the ledger, logs, events
  or responses. It exists in the payment request, in L2's memory while the approval request is sent, and in the
  request to the approval service, which already knows it. This changes what a backchannel decision records:
  today the evidence and the decider name the configured approver by their subject at the approval service;
  from this feature on they name the owner by the one-way identifier. A name or an email MUST never be stored.
  *(SPEC: L2-4, L2-8 three stores, hard rule 11)*
- **FR-021**: Credentials, tokens, request handles (other than sealed, as today) and the approval service's free
  text MUST never appear in the ledger, logs, events, responses, L1 or L3. *(SPEC: L2-7 never stored, SEC-16)*
- **FR-022**: Entries written before this feature MUST stay as they are and MUST still verify and read
  correctly, the decisions of the configured approver included. *(SPEC: INV-9, L2-4)*
- **FR-023**: The ledger MUST tell how every approval request ended: answered, refused, unanswered, failed,
  or closed because another path decided. This MUST hold in a clean timeout and after a restart. The live run of
  2026-11-12 found two unanswered requests that ended in `ESCALATION_EXPIRED` with no `APPROVAL_REQUEST_LAPSED`
  entry, both after a restart; this feature MUST find out whether a clean timeout does the same, and make the
  behavior and SPEC L2-7 agree. *(SPEC: L2-7 outcomes, L2-4.3, INV-9)*
- **FR-024**: The operator's and the administrators' views MUST show, for each escalation, whether a person was
  asked, that person's identifier, the state of the request and the path that decided. They MUST be built from
  a field whitelist, as today. *(SPEC: L2-5 escalation reads, L2-8 administration)*

**What stays as it is**

- **FR-025**: Everything else of backchannel approval MUST hold unchanged: one request per eligible escalation,
  the payment details shown, the retries, polling at the service's pace, the 120-second bounded wait and its
  re-evaluation, resuming open requests after a restart from the ledger, and every outcome checked and recorded
  inside the serialized section with no call to the service inside it. *(SPEC: L2-7, L2-5 authorize, INV-8)*
- **FR-026**: The operator path and the portal's administration area MUST work unchanged for every escalation,
  whether or not its owner was asked. The first final state recorded, from any path, is final. *(SPEC: L2-4.3,
  L2-5, L2-8)*
- **FR-027**: The policy engine MUST stay unchanged and pure. An owner's approval or refusal feeds it exactly as
  an operator's does. *(SPEC: INV-5, L2-2)*
- **FR-028**: This feature MUST NOT change who may start a run. SPEC v1.13 stays: the tenant keeps exactly two
  applications, none for the agent, and a deployed agent accepts system identities only. The feature MUST add no
  application to the tenant and no people's setting to the deployed agent. It MUST be proven against the
  stand-in approval service; a check with a real phone is not part of it. *(SPEC: v1.13, L1-6, T-IAC-01
  rule 21, T-IAC-02)*

### Non-Functional Requirements

- **NFR-001 (Security: monotonicity)**: A person's approval MUST never make a decision more permissive than an
  operator's approval of the same escalation. *(SPEC: INV-12)*
- **NFR-002 (Security: fail closed)**: Every failure fails closed: the approval service unreachable, slow, wrong
  or compromised, an identity that does not match, a person who cannot be asked, a verification failure. No
  payment results, and the escalation stays pending or expires. *(SPEC: SEC-8, SEC-17)*
- **NFR-003 (Isolation between people)**: No person MUST receive, see or decide anything about another person's
  payment through this feature: not a push, not a waiting payment, not a count against their limit.
  *(SPEC: SEC-19)*
- **NFR-004 (Secrets and personal data)**: A known-value scan over test output MUST find no credential, token or
  request handle, and no name or email, in the ledger, logs, events or responses. *(SPEC: SEC-16, hard rule 11)*
- **NFR-005 (Network exposure)**: L2 MUST gain no inbound route and no new outbound destination. *(SPEC: L2-5,
  Constitution V)*
- **NFR-006 (Availability)**: Payments that need no human MUST NOT wait on the approval service, as today.
  *(SPEC: L2-5)*
- **NFR-007 (Proven safety)**: Each new safety check MUST have a test that fails without it. At least:
  - without the owner check, user B's answer approves user A's escalation;
  - without the identity check, an identity that does not match the user is used;
  - with one count for everybody, one person reaching the limit blocks another;
  - without the rule of FR-007, a run with no person behind it notifies somebody.

  *(Constitution VIII)*
- **NFR-008 (Regression)**: The `npm run demo:local` summary and the scripted baseline MUST stay unchanged.
  Every existing approval, rejection, expiry and administration test MUST pass, changed only where it named the
  configured approver. *(SPEC: T-E2E-01, definition of done)*

### Key Entities

- **Owner**: the person a run acts for; the user recorded on its payment requests and escalations. The only
  person who can be asked about, and can answer for, those escalations by phone.
- **Identity at the approval service**: the identifier the sign-in tenant gives a person. It arrives with each
  payment request of a person's run, from the hosted agent's verified token. L2 checks it against the user's
  one-way identifier, addresses the approval request to it and does not keep it.
- **Approval request** (changed): addressed to the escalation's owner instead of a configured approver. Counted
  against that owner's hourly limit.
- **Verified approval evidence** (changed): says that the answer came from the escalation's owner, named by the
  one-way identifier, with the issuer, the answer's identifier and its issue time. Never the answer itself, and
  no longer the subject at the approval service.
- **Approval-request state for the owner**: what a person sees about their own waiting payment: waiting, and a
  reason from a fixed list.
- **Enrollment**: a person's phone set up to receive approval requests. Held by the approval service, never by
  this system.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of approval requests are addressed to the owner of the escalation they are about; 0 reach any
  other person.
- **SC-002**: 0 payments result from an answer given by anyone other than the escalation's owner, across a test
  set that includes a genuine, signed answer from another user about the same payment.
- **SC-003**: 0 approval requests are sent for runs with no person behind them: the scripted regression, system
  identities and the command-line agent.
- **SC-004**: A deployment is configured with 0 settings that name an approver, and the tenant can be set up
  before any user exists.
- **SC-005**: Each person receives at most 10 approval requests in any rolling hour, and a person at their limit
  changes the number of requests sent to others by 0.
- **SC-006**: 100% of escalations still end in exactly one final state within 305 seconds, whether the owner
  approves, refuses, cannot be asked or never answers, and whether or not another path acts.
- **SC-007**: A person with no phone set up can find out why their payment is waiting in under 30 seconds,
  without asking anyone, and can set their phone up without help.
- **SC-008**: For 100% of approval requests, an auditor can tell from the ledger alone who was asked, how the
  request ended and who decided, including requests that ended unanswered after a restart.
- **SC-009**: A known-value scan finds 0 credentials, tokens, request handles, names or emails in the ledger,
  logs, events or responses.
- **SC-010**: The `npm run demo:local` summary is unchanged (`spent on-chain: 0.006 USDC`, `hash chain
  ok=true`), and the existing approval, rejection, expiry and administration tests pass.
- **SC-011**: When the owner approves within 120 seconds, 100% of those purchases complete in the agent's same
  request, as today.

## Assumptions

- **The five open decisions (D1 to D5) were made by the owner on 2026-11-12** and are recorded under
  Clarifications, each with what was rejected. The requirements carry them: self-approval in FR-014, enrollment
  in FR-018, the identity in FR-009 and FR-020, the same tenant in FR-011, and SPEC v1.13 in FR-028.
- **Reverses stated scope, on purpose.** SPEC §1.3 lists "per-user approvers" as out of scope, 013 called "a
  user approving their own payments, in the portal or by phone" a later feature, and the constitution (1.7.0)
  says "a user approving their own payments stays out". This feature is that later feature, for the phone only.
  Approving one's own payment in the portal stays out.
- **The portal's rule stays** (FR-014): an administrator cannot decide a payment of their own run there
  (SEC-29), although their phone answer can. The two paths differ in what L2 can check: it trusts the portal to
  name who decided, and it verifies a phone answer itself. Taken as an assumption when self-approval was
  decided; the owner was not asked it as a separate question.
- **Where a person sees why** (FR-019): in the portal, among their own things. The agent's result stays as it
  is today (ESCALATED, with the reference code), so the agent learns nothing new about its owner. This is a
  small read of one's own pending payments, not the payment history that stays out of scope.
- **"No phone" is learned from a refused request.** L2 has no way to ask the approval service in advance whether
  a person has enrolled, and getting one would need a credential (FR-005). So the reason in FR-019 is known only
  after a first escalation was refused. The 2026-11-12 run showed that refusal as a permanent failure with the
  error code `invalid_request`; if that code alone cannot tell "no phone" from other refusals, the reason shown
  is the wider "could not send a request to your phone".
- **An identity that does not match is not an error of the payment** (FR-009): the request is decided as usual
  and nobody is asked by phone. A reading taken while writing the answers in, not asked: it is what makes a
  local run with the dev issuer keep working (FR-011), and it fails closed. In tests, people's tokens are issued
  under the stand-in approval service's own issuer, so the check passes there.
- **How a person enrolls** is for the plan to research, within FR-005 and FR-018: through the sign-in tenant's
  own enrollment, reached with the person's own sign-in.
- **No overall limit.** Only the per-person limit applies. The number of people who can be asked in an hour is
  bounded by the number of users, as other per-user limits are.
- **A leftover approver setting stops L2** (FR-003) rather than being ignored, so nobody believes a fallback
  exists. Backchannel approval without user accounts stops L2 too (FR-001), as the administration area does
  without user accounts.
- **Reading of the 2026-11-12 finding** (FR-023), from the code and not yet from a run: a request's lifetime
  ends with its escalation's window, and a lapse is recorded only while the escalation is still pending, so an
  unanswered request probably ends with `ESCALATION_EXPIRED` alone in a clean timeout as well. The plan confirms
  it with a test and then changes either the behavior or SPEC L2-7's sentence.
- **A deployed environment asks nobody by phone until people can start runs there** (see "Where approval stands
  today" and FR-028). The owner accepted that on 2026-11-12, by keeping SPEC v1.13 and removing the configured
  approver with no fallback. The live check of 012 (its quickstart §5) can no longer be repeated as written; the
  plan says what becomes of that section.
- **Out of scope**: people starting runs in a deployed environment with a token from the tenant (FR-028),
  organizations or teams, approval by someone other than the run's owner (a delegate, a
  manager, a second approver chosen by the user), card payments, approving in the portal as a user, and
  notifying a person by any channel other than the approval service's push.
- **Constitution amendment (MINOR, proposed)**: the scope sentence "a user approving their own payments stays
  out" changes; Principle V's sentence on the approval-service credential says "the owner's signed answer"
  where it says "the approver's"; the residual risks change as below. No principle or invariant is removed or
  redefined.
- **SPEC.md changes** (for the plan):
  - **§1.2, §1.3:** per-user approval by phone comes into scope; the "per-user approvers" sentence goes.
  - **§2:** glossary: owner; "approver" no longer means a configured person.
  - **L2-7:** "one approver per L2" goes; eligibility gains the owner conditions and the per-person limit; the
    approver check becomes the owner check; the sentence on unanswered requests (FR-023).
  - **§7:** the owner's identity at the approval service on the payment request (FR-009); the views of FR-019
    and FR-024.
  - **L2-4:** the entries that name an approver now name the owner by the one-way identifier; nothing new is
    stored of a person's identity (FR-020).
  - **L2-5:** the authorize request's new field, with `docs/l2-control.openapi.yaml`.
  - **L2-8:** the person's view of their own waiting payments; optional enrollment (FR-018).
  - **CFG-2 and §3.1 Azure profile:** the approver setting is removed everywhere; T-IAC-01 rule 19 no longer asks
    for one; T-IAC-02's variable list loses it. Rule 21 and T-IAC-02's two-application rule stay as they are
    (FR-028).
  - **§11:** SEC-17 says "the escalation's owner" where it says "approver"; SEC-18 says "per person"; the residual
    risk "an escalation of a user's payment still goes to the operator and the one configured approver, not to the
    user" is removed. New residual risks: a person approves their own agent's spending, for every amount their
    policy and the platform limits allow (FR-014); a compromised hosted agent can cause a request to another
    user's phone; a deployed environment asks nobody by phone until people can start runs there (FR-028).
  - **§12:** new tests for NFR-007 (proposed T-CIBA-15 onward) and for FR-003, FR-019 and FR-023.
