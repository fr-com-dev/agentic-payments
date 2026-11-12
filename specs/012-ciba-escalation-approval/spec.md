# Feature Specification: Backchannel Approval of Escalated Payments (CIBA with Auth0)

**Feature Branch**: `012-ciba-escalation-approval`

**Created**: 2026-11-06

**Status**: Draft

**Input**: User description: "Human approval of L2 escalations through CIBA (OpenID Connect Client-Initiated Backchannel Authentication) with Auth0 as the authorization server. When L2's policy decides a payment needs a human (the escalation path between autoApprove and hardCap, and any other rule that escalates), L2 starts a CIBA backchannel request to Auth0 for the payer's approver, with a binding message and Rich Authorization Requests (RAR) authorization_details describing the exact payment (escalation id, amount in atomic units, asset, network, payTo, resource, requirement hash). Auth0 notifies the approver out of band (Guardian push). L2 polls Auth0's token endpoint; an approval resolves the escalation as approved and signs inside the serialized check-sign-append section; access_denied resolves it as human_rejected; expired_token resolves it as expired. Approvals are verified by L2 (issuer, audience, signature, approver identity, authorization_details matching the escalation) before signing, and recorded append-only in the hash-chained ledger with the approver's identity. The existing operator approve/reject CLI stays as a fallback path. L1 gets no keys and no Auth0 credential; L2's Auth0 client credential lives only in L2's env file locally and L2's Key Vault in Azure, seeded by hand."

## Clarifications

### Session 2026-11-07

- Q: When the approver approves, how does the signed payment reach the agent: does the agent's
  authorize call wait for the approver, or does ESCALATED return at once as today, with the
  approved purchase paying on the agent's next request? → A: The call that created the
  escalation waits for at most 120 seconds, outside the serialized section. If the escalation
  reaches a final state within the wait, L2 re-evaluates the request and returns that decision
  in the same call: AUTHORIZED with the signed payment after an approval, DENIED after a refusal.
  Otherwise the call returns ESCALATED, and a later approval pays on the agent's next request.
  The 120 seconds fit inside the hosted agent's 200-second run deadline.

### Session 2026-11-08

- Q: How is the Auth0 tenant provisioned? → A: As code, in Terraform under a new top-level `auth0/` folder (the
  official `auth0/auth0` provider), applied by a tenant administrator by hand, like `infra/pre-deploy.bicep`.
  Azure stays Bicep only. The plan, the approver's Guardian enrollment and L2's private key stay manual.

### Session 2026-11-10

- Q: Who applies the tenant's Terraform? → A: A pipeline, `.github/workflows/provision-auth0.yml`, started by hand
  (the owner's decision, SPEC v1.9; this replaces "applied by a tenant administrator by hand" above). It runs in its
  own GitHub environment, `auth0-<env>`, which holds the Auth0 Management API credential as the only secrets in
  GitHub, and its Terraform variables as that environment's variables: no tfvars file is kept anywhere. The state
  is a blob in Azure that `infra/pre-deploy.bicep` makes.
- Q: May the pipeline take L2's client secret? → A: No. L2's credential is held by L2 only, so the pipeline
  provisions the key credential alone and GitHub holds only the public half of L2's key (SPEC v1.11).
- Q: How does Azure deliver the CIBA settings? → A: Always present on L2's container. The l2 vault always holds
  `ciba-client-credential`, as the placeholder `off` while the feature is off.

## User Scenarios & Testing *(mandatory)*

Terms used below:
- **Approver**: the one person designated to approve the payer's escalated payments. They hold an
  account at the approval service and have enrolled a phone for its push notifications.
- **Approval service**: the external authorization server (Auth0) that reaches the approver out of
  band and returns their decision to L2.
- **Approval request**: one backchannel request from L2 to the approval service, for one
  escalation.
- **Operator path**: today's `npm run approve`, `npm run reject` and `npm run escalations`, using the
  operator credential. It is unchanged and stays available as the fallback.

### User Story 1 - The approver approves an escalated payment from their phone (Priority: P1)

An agent asks to buy a resource priced above the auto-approve limit. L2 escalates the payment and
immediately asks the approval service to get the approver's decision. The approver's phone shows
what they are being asked to pay: the amount in USDC, the payee, the resource, and a short
reference code. The same code identifies the escalation in the operator's views, and in the
agent's report when the call returns ESCALATED. The approver approves. L2 checks that the
answer proves this exact payment and this approver, then records the approval. If the approver
answers within two minutes, the agent's same request goes on to pay, without asking again. A
later approval pays on the agent's next request for that purchase. Either way, it pays once and
within every budget rule.

**Why this priority**: This is the feature. A human can approve a payment where they are,
without an operator at a terminal, and the payment can still only happen exactly as approved.

**Independent Test**: Use a stand-in approval service that approves. Escalate a 50000-atomic
request, then check four things:
- exactly one approval request was sent, carrying that payment's details;
- the ledger records the approval with the approver's verified identity and the backchannel
  channel;
- the agent's same authorize call returns AUTHORIZED with the signed payment;
- the purchase is AUTHORIZED exactly once.

Run it again with the approval arriving after the 120-second wait. The call returns ESCALATED,
and the agent's next request for that purchase is AUTHORIZED.

**Acceptance Scenarios**:

1. **Given** backchannel approval is on, and a request is above the auto-approve limit but breaks
   no DENY rule, **When** L2 escalates it, **Then** L2 sends exactly one approval request for
   that escalation within 2 seconds and records that it did. The request describes the exact
   payment.
2. **Given** an approval request is pending, **When** the approver approves, **Then** L2 verifies
   the answer (FR-020..FR-023) and appends one approval naming the approver and the channel. The
   escalation is now approved.
3. **Given** the agent's authorize call is waiting (FR-016), **When** the approver approves within
   120 seconds, **Then** the same call returns AUTHORIZED with the signed payment. It is signed
   inside the serialized section, with the budget and every DENY rule re-checked at that moment.
4. **Given** no answer within 120 seconds, **When** the wait ends, **Then** the call returns
   ESCALATED with the escalation ID, as today. **When** the approver approves later and the agent
   asks for the same purchase again, **Then** that request is AUTHORIZED exactly once.
5. **Given** an approved escalation whose purchase no longer fits the session or daily budget at
   payment time, **When** the purchase is authorized, **Then** it is DENIED by the budget rule.
   The approval lifts only the approval requirement (INV-12).

---

### User Story 2 - The approver refuses (Priority: P1)

The approver sees the request and refuses it. The escalation ends as **denied**, exactly as if
the operator had rejected it, and the refusal is recorded with the approver's identity.

**Why this priority**: "No" must be as binding as "yes". It must also be indistinguishable to the
agent from an operator rejection, so the agent cannot learn anything that could be used against
the approver.

**Independent Test**: Use a stand-in approval service that refuses. Escalate a request, then
repeat it in the same session. The repeat is DENIED with `human_rejected`, nothing is signed, and
the ledger shows the escalation, the approval request, and then a rejection by the approver.

**Acceptance Scenarios**:

1. **Given** a pending approval request, **When** the approver refuses, **Then** one rejection
   entry is appended. It names the approver and the channel, and holds the session, resource key,
   payee and amount copied from the escalation. The escalation is denied.
2. **Given** a denied escalation, **When** the same session requests the same resource again,
   **Then** the decision is DENIED with `human_rejected` (R15). The violation detail carries only
   the rejection ID: no approver identity and no text from the approval service.

---

### User Story 3 - No answer: the escalation expires, and the operator can still decide (Priority: P1)

The approver may not answer in time. The escalation then expires at its usual 300 seconds, as it
does today. Until then the operator can still approve or reject through the operator path. The
first decision recorded is final, whichever path it came from.

**Why this priority**: A phone can be off, lost or ignored. Every escalation must still end in
exactly one final state (010 FR-001), and the operator path must keep working as the fallback.

**Independent Test**: Run three variants with a stand-in approval service that never answers:
- let the window pass, and check that the escalation expires and that a late approval changes
  nothing;
- approve with the operator path before the window ends, and check that L2 stops waiting;
- reject with the operator path before the window ends, and check that L2 stops waiting.

**Acceptance Scenarios**:

1. **Given** a pending approval request with no answer, **When** the escalation's 300-second
   window passes, **Then** one `ESCALATION_EXPIRED` entry is appended, as today, and L2 stops
   waiting for the approver.
2. **Given** an approval request is pending, **When** the operator approves or rejects through the
   operator path, **Then** that decision is final and L2 stops waiting. An answer the approver
   gives later does not change the escalation.
3. **Given** the approver already approved, **When** the operator tries to reject, **Then** the
   rejection is refused with a conflict naming the approval, as today (010 FR-003).

---

### User Story 4 - L2 trusts only a verified approval of this exact payment (Priority: P1)

L2 is the only signer, so L2 alone decides whether an answer from the approval service counts.
The answer must come from the configured approval service and name the configured approver. It
must also answer the request L2 made for this escalation and describe exactly this payment.
Anything else approves nothing.

**Why this priority**: Without these checks, a forged, replayed or swapped answer would turn the
human control into a formality (SEC-8).

**Independent Test**: Have the stand-in approval service return, one at a time:
- an answer from another issuer;
- an answer for another audience;
- an answer with a bad signature;
- an expired answer;
- an answer for another user;
- an answer whose payment details differ in amount, payee or escalation;
- an answer to a request L2 never made.

None of them approves: the escalation stays pending, a verification failure is recorded, and
nothing is signed. Must-fail check: with the payment-details match removed, the answer for a
different amount approves.

**Acceptance Scenarios**:

1. **Given** an answer whose issuer, audience, signature or validity time does not check out,
   **When** L2 receives it, **Then** no approval is recorded, one verification failure is
   recorded, and the escalation stays pending.
2. **Given** a valid answer from a user other than the configured approver, **When** L2 receives
   it, **Then** it is refused the same way.
3. **Given** a valid answer whose payment details differ from the escalation in any field,
   **When** L2 receives it, **Then** it is refused the same way.
4. **Given** two pending escalations for the same approver, **When** the approver approves one,
   **Then** only that escalation is approved. The other stays pending.

---

### User Story 5 - An unavailable or misconfigured approval service fails closed (Priority: P2)

If the approval service cannot be reached, or refuses L2's request, no payment happens. The
escalation stays pending, so the operator path still works. The operator can see that the
approver was not asked. Payments that need no human are not slowed down.

**Why this priority**: An outside dependency must never make the system more permissive, and
must never take down the payments that don't need it.

**Independent Test**: Make the stand-in approval service fail in three ways: unreachable, a
transient server error, and a permanent refusal of the request. Then check, for each:
- the escalation is created and stays pending, and the failure is recorded;
- the operator's watch shows it;
- an operator approval still pays;
- an auto-approved purchase made at the same time is decided as quickly as without backchannel
  approval.

**Acceptance Scenarios**:

1. **Given** backchannel approval is on but its configuration is missing or invalid, **When** L2
   starts, **Then** it refuses to start and names the missing or invalid setting, never its value.
2. **Given** the approval service answers with a transient failure, **When** L2 starts an approval
   request, **Then** L2 retries with backoff while the escalation is pending, up to 3 attempts.
3. **Given** the approval service permanently refuses the request (for example: unknown user, or
   client not allowed), **When** L2 starts it, **Then** L2 records the failure, does not retry,
   and the escalation stays pending for the operator.
4. **Given** the approval service is down, **When** a purchase at or below the auto-approve limit
   is requested, **Then** it is decided exactly as today, with no wait on the approval service.

---

### User Story 6 - The approver is not flooded with requests (Priority: P2)

A prompt-injected agent could escalate again and again to wear the approver down until they tap
"approve". Repeated requests for the same purchase reuse the pending escalation, so they send no
new notification. The number of approval requests per approver is capped. Automated deployment
checks never notify the approver.

**Why this priority**: Push fatigue is a known attack on push-based approval. A deployment that
pings a human on every run teaches them to approve without reading.

**Independent Test**: Escalate the same purchase five times, then 11 different purchases within an
hour. Then run the scripted regression plan. Check that the approver was asked once for the
repeated purchase, at most 10 times in the hour, and never by the regression.

**Acceptance Scenarios**:

1. **Given** a pending escalation for a purchase, **When** the same purchase is requested again,
   **Then** it gets the pending escalation's ID (as today) and no new approval request is sent.
2. **Given** 10 approval requests already sent to the approver in the last hour, **When** another
   escalation is created, **Then** no approval request is sent. L2 records that the cap applied,
   and the escalation stays pending for the operator.
3. **Given** the scripted regression plan (L1-4) runs, **When** its premium request escalates,
   **Then** no approval request is sent, and the outcome is ESCALATED as the baseline expects.

---

### User Story 7 - The operator and the auditor see who decided, and how (Priority: P3)

For every escalation, the operator's views show whether the approver was asked and what happened:
asked, failed, refused by verification, or capped. They also show which path decided it and the
verified identity of whoever decided. The ledger alone is enough to reconstruct all of this.

**Why this priority**: The operator needs to know when the fallback is needed. The audit trail
must say who approved each payment, now that two paths can.

**Independent Test**: Drive one escalation through each backchannel outcome, then read the
operator's escalation views and the ledger. Each shows the channel, the request's state and the
deciding identity. Neither shows a token, a request handle or text from the approval service.

**Acceptance Scenarios**:

1. **Given** an escalation decided by the approver, **When** the operator lists or watches
   escalations, **Then** the event shows the final state, the channel `backchannel` and the
   approver's verified identity.
2. **Given** an escalation whose approval request failed or was capped, **When** the operator
   watches, **Then** an event shows it, so the operator knows to decide through the operator path.
3. **Given** any escalation, **When** an auditor reads the ledger, **Then** they can tell when the
   approval request was sent, how it ended, who decided, through which channel, and what was
   paid.

---

### Edge Cases

- **An answer at the end of the window.** An answer L2 receives after the escalation expired
  changes nothing. The expiry is final.
- **"Denied or expired" in one answer.** The approval service may use the same refusal code for
  a refusal and for a lapsed request. L2 classifies it by its own record of the request's
  lifetime:
  - a refusal received more than 5 seconds before the request's expiry is a denial;
  - any later refusal, and any expiry answer, is a lapse: the escalation stays pending until its
    own window ends, then expires as usual.
- **The approval service asks L2 to poll more slowly.** L2 slows down by the interval it is told
  and never polls faster than the service allows.
- **L2 restarts while waiting**, including the Azure lock handover (L2-6):
  - **Window still open:** the new instance resumes waiting from the ledger, without sending a
    new approval request.
  - **Window passed while L2 was down:** the startup sweep expires the escalation, as today.
- **An escalation after an expiry.** A new escalation for the same purchase sends a new approval
  request, which counts toward the cap.
- **The agent's call ends during the wait.** This covers a dropped connection and a hosted run
  that is stopped. L2 signs nothing for that call (FR-019). An approval still gets recorded, and
  the purchase pays on the next request.
- **The operator decides during the wait.** The waiting call returns that decision, as for the
  approver's answer: AUTHORIZED after an operator approval, DENIED after an operator rejection.
- **An approval that no longer fits the budget.** If a DENY rule applies when the waiting call
  re-evaluates the purchase, the call returns DENIED. The approval stays open until its own
  time-to-live ends, as today.
- **Operator and approver decide at the same moment.** Both are recorded inside the serialized
  section. The first decides; the second changes nothing (010 FR-003).
- **Approver identity at the service changes** (the account is disabled, deleted or unenrolled):
  the service refuses to start the request. That is a permanent failure (US5, scenario 3).
- **Clock skew between L2 and the approval service.** Answer validity times are checked with a
  60-second tolerance, as for requester tokens (L1-6).
- **Requests above the hard cap.** These are DENIED, never escalated, so they never reach the
  approver.
- **Agent text.** The agent's `purpose` is LLM text and could be written to talk the approver
  into approving. It is never part of the approval request.
- **The resource address.** It is shown as the resource key, which drops the query string, and is
  length-limited. The host is already on the allow-list (R6); the path is chosen by the seller,
  so the approver judges it as shown.
- **Local development.** Backchannel approval is off unless configured, so the local demo and its
  summary are unchanged.

## Requirements *(mandatory)*

### Functional Requirements

**Activation and configuration**

- **FR-001**: Backchannel approval MUST be off unless the control service is configured for it. In
  that case every behavior in feature 004 and 010 is unchanged. The only differences are additive
  audit fields: `channel: "operator"` on new operator decisions, and the reference code in the
  operator's views. *(SPEC: proposed L2-7, CFG-2)*
- **FR-002**: When it is on, the configuration MUST name all of the following. A missing or
  invalid value MUST stop the control service at startup.
  - the approval service's issuer;
  - L2's own client identity at that service;
  - the audience for the approval;
  - the approver's identity at that service;
  - L2's client credential.

  *(SPEC: proposed L2-7, CFG-2 l2-control.env)*
- **FR-003**: In Azure, every non-secret value in FR-002 MUST come from the environment's
  parameter file. The client credential MUST live only in L2's vault, put there by hand. No value
  comes from GitHub. *(SPEC: §3.1 Azure profile, CFG-2 parameter files, specs/011)*

**Starting an approval request**

- **FR-004**: When L2 records a new escalation and backchannel approval is on, L2 MUST start
  exactly one approval request for it, addressed to the configured approver. It MUST NOT start
  one in three cases:
  - the purchase reuses a pending escalation (L2-4.3);
  - the request asked for the operator path only (FR-007);
  - the cap in FR-008 applies.

  *(SPEC: L2-2 R14, L2-4.3, proposed L2-7)*
- **FR-005**: The approval request MUST describe the payment with values taken only from the
  escalation and the payment requirement L2 evaluated:
  - the escalation ID;
  - the amount in atomic units and in USDC;
  - the asset and the network;
  - the payee;
  - the resource key;
  - a digest of the exact payment requirement.

  It MUST also carry a short human-readable message, within the service's limits, that shows the
  amount, the payee in short form and a reference code derived from the escalation ID. It MUST
  NOT carry the agent's `purpose` or any other agent text. *(SPEC: INV-5, SEC-12, proposed L2-7)*
- **FR-006**: The approval request's lifetime MUST NOT exceed the escalation's remaining window.
  It MUST stay within the limit for push delivery, so the approver is reached by push, never by a
  slower channel. *(SPEC: L2-4.3, proposed L2-7)*
- **FR-007**: A payment intent MAY ask for the operator path only. Such an intent starts no
  approval request. This can only remove an approval path, never add one. The scripted regression
  plan (L1-4) MUST use it, and the hosted agent's tools MUST NOT be able to set it.
  *(SPEC: §7 PaymentIntent, L1-4, L1-6, proposed L2-7)*
- **FR-008**: L2 MUST send at most 10 approval requests to the approver in any rolling hour,
  counted from the ledger. An escalation over the cap stays pending for the operator, and the cap
  is recorded as having applied. *(SPEC: INV-7, proposed L2-7)*
- **FR-009**: A transient failure to start a request MUST be retried with backoff while the
  escalation is pending, up to 3 attempts. A permanent refusal MUST NOT be retried. Either way,
  the escalation stays pending and the failure is recorded. *(SPEC: proposed L2-7)*

**Waiting for the answer**

- **FR-010**: L2 MUST wait for the approver's answer by asking the approval service, never by
  receiving a call from it. The control service gains no inbound route and still listens only on
  the loopback interface. *(SPEC: L2-5, Constitution V)*
- **FR-011**: While waiting, L2 MUST follow the polling interval the approval service gives,
  including any request to slow down. It MUST stop as soon as the escalation reaches a final
  state, whatever path decided it. *(SPEC: proposed L2-7)*
- **FR-012**: After a restart, L2 MUST resume waiting for every escalation that is still pending
  and has an open approval request, using only the ledger, and without sending a new request.
  *(SPEC: L2-4.3, L2-6, proposed L2-7)*

**Outcomes**

- **FR-013**: A verified approval (FR-020..FR-023) MUST resolve the escalation as approved by
  appending one approval entry, with the same time-to-live as an operator approval. The approved
  purchase MUST be signed only inside the serialized check, sign and append section, with every
  rule re-evaluated at that time. That happens either in the waiting call (FR-017) or on the
  agent's next request for the same purchase. *(SPEC: L2-4.2, INV-8, INV-12)*
- **FR-014**: A refusal by the approver, classified as in the edge cases, MUST resolve the
  escalation as denied by appending one rejection entry. The entry names the approver and the
  channel, and holds the session, resource key, payee and amount copied from the escalation. R15
  then applies unchanged. *(SPEC: L2-2 R15, L2-4, SEC-12)*
- **FR-015**: An approval request that lapses MUST leave the escalation pending until its own
  window ends. It then expires through the existing sweep, and nothing new is recorded as a final
  state. *(SPEC: L2-4.3)*

**Waiting in the agent's call**

- **FR-016**: When L2 sends an approval request for a new escalation, the authorize call that
  created the escalation MUST wait at most 120 seconds for the escalation to reach a final state.
  - **No lock:** the wait MUST hold no lock, so authorizations, reconciliations and operator
    actions proceed while it lasts.
  - **Fixed length:** 120 seconds is a constant, below the hosted agent's 200-second run deadline
    (L1-6).

  *(SPEC: L2-5 authorize algorithm, L1-6 limits, INV-8)*
- **FR-017**: If the escalation reaches a final state within the wait, by either path, L2 MUST
  re-evaluate the request inside the serialized section and return that decision in the same
  call:
  - **after an approval:** AUTHORIZED with the signed payment, which consumes the approval; or
    DENIED, if a DENY rule now applies (INV-12);
  - **after a refusal:** DENIED with `human_rejected`.

  The re-evaluated decision MUST be recorded as a new `INTENT` entry for the same intent ID,
  followed by exactly one outcome entry. Every `INTENT` entry is still followed by exactly one
  outcome entry.

  Otherwise, the call MUST return ESCALATED with the escalation ID, as today. That covers three
  cases: the wait ends first, the approval request lapses, or it fails. A later approval then pays
  on the agent's next request for the same purchase. *(SPEC: L1-1 step 5, L2-4 INTENT, L2-4.2,
  L2-5)*
- **FR-018**: Only the call that created the escalation waits. These calls return ESCALATED at
  once, as today:
  - a repeat request for a pending purchase (`ESCALATION_REPEATED`);
  - an operator-only intent (FR-007);
  - an escalation capped under FR-008, which sends no approval request.

  When starting the request fails, the call returns ESCALATED as soon as the failure is recorded:
  within 6 seconds, after at most 3 attempts (FR-009).

  *(SPEC: L2-4.3, proposed L2-7)*
- **FR-019**: If the caller disconnects during the wait, L2 MUST end the wait and sign nothing for
  that call. The escalation and its approval request continue. An approval that arrives is still
  recorded, and pays on the agent's next request. *(SPEC: L1-6 limits, SEC-9)*

**Verification**

- **FR-020**: Before recording an approval, L2 MUST verify that the answer:
  - comes from the configured issuer, checked against that issuer's published signing keys;
  - is addressed to L2's client identity;
  - is valid at L2's clock, within a 60-second tolerance.

  *(SPEC: proposed L2-7, SEC-8)*
- **FR-021**: L2 MUST verify that the answer identifies the configured approver.
  *(SPEC: proposed L2-7, INV-13)*
- **FR-022**: L2 MUST verify that the payment details in the answer equal, field for field, the
  details L2 sent for this escalation (FR-005). L2 MUST also verify that the answer belongs to the
  approval request L2 recorded for it. *(SPEC: INV-12, proposed L2-7)*
- **FR-023**: An answer that fails any check in FR-020..FR-022 MUST approve nothing. L2 MUST
  record one verification failure, naming which check failed, never the answer itself. The
  escalation stays pending. *(SPEC: INV-9, proposed L2-7)*

**Recording**

- **FR-024**: The ledger MUST record each of these events as new append-only entries, or as new
  fields on existing entries:
  - an approval request was sent;
  - a request failed, or the cap applied;
  - an answer failed verification;
  - which channel decided each approval or rejection: `operator` or `backchannel`.

  Existing entries are never rewritten. *(SPEC: INV-9, L2-4 table)*
- **FR-025**: A backchannel approval MUST record three things: the approver's verified identity,
  the issuer, and the identifier and issue time of the signed answer that proved it.

  A backchannel refusal comes back unsigned, as the answer to L2's own authenticated poll. It MUST
  record the approver the request was addressed to, the issuer, the approval request it answers and
  the time it was received. Accepting an unsigned refusal can only make L2 more restrictive
  (NFR-001).

  Neither MUST ever record tokens, client credentials or the approval service's free text.
  *(SPEC: L2-4, SEC-16)*
- **FR-026**: Whatever L2 needs to resume waiting after a restart (FR-012) MUST be recorded. The
  request handle MUST NOT appear in operator events, logs or any response. *(SPEC: L2-5
  escalation events, proposed L2-7)*

**Fallback, concurrency and the operator**

- **FR-027**: The operator path MUST work unchanged for every escalation, whether or not an
  approval request was sent. The first final state recorded, from either path, is the final state
  (010 FR-001..FR-003). *(SPEC: L2-4.3, L2-5)*
- **FR-028**: Every check-then-append of a backchannel outcome MUST run inside the serialized
  section. No network call to the approval service MAY run inside it. *(SPEC: INV-8)*
- **FR-029**: The operator's escalation list and event stream MUST show, for each escalation:
  - whether an approval request was sent, failed, was capped or was refused by verification;
  - the channel that decided it;
  - the deciding identity.

  They MUST be built from the same field whitelist as today. *(SPEC: L2-5 escalation reads)*

**Credentials and isolation**

- **FR-030**: L2's client credential for the approval service MUST be readable only by the
  control service, and only by one module in it, enforced by an architecture rule like A8. L1,
  L3, the seller and the operator never hold it. *(SPEC: §3.3, §4.1, INV-13)*
- **FR-031**: The agent MUST gain no tool, field or route that approves, rejects or reads approval
  requests. Its tools stay `fetch_resource` and `check_budget`. *(SPEC: L1-3, L1-6, Constitution
  I)*
- **FR-032**: The policy engine MUST stay unchanged and pure. A backchannel approval feeds it
  exactly as an operator approval does, through the existing approval context, and a backchannel
  refusal through the existing rejection context. *(SPEC: INV-5, L2-2)*

### Non-Functional Requirements

- **NFR-001 (Security: monotonicity)**: Backchannel approval MUST NEVER make a decision more
  permissive than an operator approval of the same escalation. It can lift only
  `human_approval_required`, once, for one exact purchase. *(SPEC: INV-12)*
- **NFR-002 (Security: fail closed)**: Every failure fails closed: the approval service being
  unreachable, slow, wrong or compromised, or verification failing. No payment results; the
  escalation stays pending or expires. *(SPEC: SEC-8)*
- **NFR-003 (Security: secrets)**: These MUST NEVER appear in the ledger, logs, operator events,
  API responses, the agent's tool results, L1 or L3:
  - the client credential;
  - tokens returned by the approval service;
  - request handles;
  - the service's error text.

  A known-value scan over test output MUST find none. *(SPEC: SEC-10, SEC-16)*
- **NFR-004 (Network exposure)**: The only new outbound connections from the control service MUST
  be HTTPS to the configured approval service's endpoints and its published signing keys. There
  MUST be no new inbound route. *(SPEC: L2-5, Constitution V)*
- **NFR-005 (Availability)**: Payments that need no human approval MUST NOT wait on the approval
  service. An outage of that service MUST NOT change their decisions or delay them by more than
  50 ms. *(SPEC: L2-5)*
- **NFR-006 (Untrusted text)**: Text from the approval service MUST be treated as untrusted. That
  includes error descriptions and any profile fields. It is never a decision input and never
  reaches the agent. *(SPEC: INV-5, SEC-12)*
- **NFR-007 (Proven safety)**: Each of these checks MUST be shown to fail without it: the issuer,
  approver and payment-details checks (FR-020..FR-022), and the serialization (FR-028). For
  example: without the payment-details match, an answer for a different amount approves; without
  the approver check, another user's approval pays. *(Constitution VIII)*
- **NFR-008 (Regression)**: The `npm run demo:local` summary and the L1-4 baseline MUST stay
  unchanged. Every existing approval, rejection, expiry and escalation-read test MUST pass. Only
  tests updated for intended additive fields may change. *(SPEC: T-E2E-01, T-E2E-02, T-E2E-07,
  T-E2E-08, definition of done)*

### Key Entities

- **Approver**: the person designated to approve the payer's escalated payments. Identified by
  their identity at the approval service, configured once per control service. Enrolled for push
  notifications.
- **Approval Service**: the external authorization server (an Auth0 tenant). It reaches the
  approver and returns a signed answer. Its issuer, published signing keys, L2's client identity
  and the approval audience are configuration.
- **Approval Request**: one backchannel request for one escalation. It holds the escalation ID,
  the payment details sent, the time it was sent, its lifetime and its handle (never shown). It
  ends as answered, refused, lapsed, failed or abandoned (when the escalation reached a final
  state through another path).
- **Payment Details**: the exact payment the approver is asked about. It consists of:
  - the escalation ID;
  - the amount (atomic and USDC);
  - the asset and network;
  - the payee and the resource key;
  - the payment requirement's digest;
  - the short message and reference code.

  The approver's answer must carry the same details back.
- **Verified Approval Evidence**: what L2 keeps from a verified answer: approver identity, issuer,
  answer identifier and issue time. Never the answer itself.
- **Human Approval** (extended): gains its channel (`operator` or `backchannel`) and, for
  `backchannel`, the verified evidence. It is still single-use, exact-match and time-limited.
- **Human Rejection** (extended): gains its channel and, for `backchannel`, the approver's verified
  identity. It still blocks its session and resource key through R15.
- **Approval Request Outcome Entries**: the new ledger facts: request sent, request failed, cap
  applied, and verification failed. Together with the existing lifecycle entries they make the
  full trail.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of eligible escalations, L2 starts an approval request within 2 seconds of
  recording the escalation. Eligible means backchannel approval is on, the purchase is not reused,
  the request is not operator-only, and the cap does not apply.
- **SC-002**: An approver can understand and approve or refuse a payment from the notification
  alone in under 30 seconds. They see the amount in USDC, the payee and the resource, and a
  reference code that matches the escalation in the operator's views.
- **SC-003**: 0 payments result from an answer that fails any verification check. The test set
  covers another issuer, another audience, a bad signature, an expired answer, another user,
  different payment details, and an unknown request.
- **SC-004**: 100% of escalations still end in exactly one final state within 305 seconds. This
  holds whether the approver approves, refuses or never answers, and whether or not the operator
  acts.
- **SC-005**: 0 escalations authorize more than one payment, whichever path approved them.
- **SC-006**: The approver receives at most 10 approval requests in any rolling hour. They receive
  0 from the deployment regression and 0 for repeats of a pending purchase.
- **SC-007**: With the approval service unavailable, 100% of payments that need no human are
  decided as without the feature, and 100% of escalations remain decidable through the operator
  path.
- **SC-008**: A known-value scan finds 0 occurrences of the client credential, issued tokens or
  request handles in the ledger, logs, operator events or agent results.
- **SC-009**: The `npm run demo:local` summary is unchanged (`spent on-chain: 0.006 USDC`,
  `hash chain ok=true`), and the existing approval, rejection and expiry tests pass.
- **SC-010**: For every escalation, an auditor can tell from the ledger alone whether the approver
  was asked, how the request ended, who decided, through which channel, and what was paid.
- **SC-011**: When the approver approves within 120 seconds, 100% of those purchases complete in
  the agent's same request, with no second request and no second run.

## Assumptions

- **One approver per control service.** "The payer's approver" is one person, configured by their
  identity at the approval service. There is one payer and one mandate per L2 (L2-1). Several
  approvers, quorum approvals, and requesters approving their own runs are out of scope.
- **Auth0 is the approval service; requesters keep Entra.** Entra ID offers no backchannel
  authentication. Requesters still sign in to the hosted agent with Entra (L1-6), unchanged.
- **Auth0 plan.** Auth0 offers CIBA on its Enterprise plan or an add-on. Guardian push needs MFA
  configured on the tenant, with the approver enrolled in Guardian.
- **Auth0 limits that shape the design:**
  - push delivery is used only for requests that live 300 seconds or less, which the 300-second
    escalation window already guarantees;
  - the short message is limited to 64 characters from a restricted character set;
  - payment details are limited in size and in properties per object, and their type must be
    registered on the Auth0 API;
  - Auth0 documents that its refusal code can also mean "expired", hence the edge-case rule.

  The plan must confirm how the Guardian app displays the payment details. If it can't show a
  custom type, the short message alone must carry the amount, the payee and the reference.
- **Poll mode only.** L2 has no reachable inbound address and must not gain one (FR-010). Auth0's
  ping and push token delivery modes are out of scope.
- **Client authentication.** A private-key JWT credential is preferred over a client secret, so no
  shared secret leaves L2's vault. Auth0 also supports a client secret or mTLS.
- **The Auth0 tenant is configured as code** (clarified 2026-11-08), in Terraform under `auth0/`, outside
  Bicep because it is not an Azure resource. Its pipeline, `provision-auth0.yml`, applies it when an administrator
  starts it (clarified 2026-11-10; by hand from a shell until then). It makes:
  - the CIBA grant on L2's client;
  - the API with its payment-details type;
  - Guardian push.

  The approver's account must already exist; their Guardian enrollment and the plan stay manual. `infra/` gains
  no new script (T-E2E-AZ), and its parameter files gain the non-secret values (FR-003). Since 2026-11-10
  `infra/pre-deploy.bicep` also makes the storage for the Terraform state and the deploy app's second sign-in, and
  `infra/github-setup.sh` the pipeline's GitHub environment with its variables.
- **Approval time-to-live.** A backchannel approval uses the operator default, 600 seconds.
- **Resuming without the handle (planning, 2026-11-07).** FR-026 asks for whatever resuming needs
  to be recorded, while NFR-003 and SC-008 keep the request handle out of the ledger. The design
  reconciles them by storing the handle sealed (AES-256-GCM) under a key derived from L2's own
  client credential. "Using only the ledger" (FR-012) therefore means the ledger plus the
  credential L2 already holds. If the credential has rotated, the handle can't be opened; the
  escalation then stays with the operator. See plan research R8.
- **Bounded wait (clarified 2026-11-07).** The authorize call that created the escalation waits
  up to 120 seconds (FR-016..FR-019).
  - **L1's code is unchanged.** Its authorize call just takes longer, and may come back
    AUTHORIZED.
  - **The hosted run:** a hosted run that escalates spends up to 120 of its 200 seconds waiting.
    The ingress's 240-second idle timeout is not reached.
  - **The scripted regression doesn't wait,** because it is operator-only (FR-007).
- **Retries and the cap.** Starting a request is retried at most 3 times for a transient failure.
  The cap is 10 requests per approver per rolling hour. Both are constants, like the 300-second
  window.
- **The operator-only intent field is safe** to accept from an untrusted L1, because it only
  removes an approval path. The hosted agent never sets it; the scripted regression always does.
- **Amends feature 010.** 010 kept notification pull-only, with no outbound connections, because a
  push channel "would add an outbound connection and a new secret to the service that holds the
  payer key". This feature knowingly adds exactly that, limited to one service and one module:
  - L2-4.3's "L2 makes no outbound connection" becomes an exception for the approval service;
  - 010 NFR-005 is amended to match.

  Operator notification stays pull-based.
- **Constitution amendment (MINOR)**: Principle V gains the approval-service client credential, held
  by L2 only and confined to one module. The technology constraints gain Auth0 as the approval
  service. The residual risks gain these:
  - the approval service is trusted to authenticate the approver;
  - the approver's phone is a new place where approvals happen.
- **SPEC.md changes** (for the plan):
  - **L2-7 (new section), Backchannel approval.**
  - **L2-4 entry types:** the new entry types and the `channel` field. The `INTENT` row allows a
    second `INTENT` entry for the same intent ID after a wait (FR-017).
  - **L2-5 authorize algorithm:** the wait outside the serialized section, then the second
    serialized decision.
  - **L2-4.3:** the outbound exception.
  - **L2-5:** the escalation-read fields.
  - **§3.3:** a new credential row.
  - **§4.1:** a new architecture rule confining the credential.
  - **§7:** the operator-only field on `PaymentIntent`.
  - **CFG-2:** the new `l2-control.env` variables.
  - **§11:** new SEC rows for a forged or swapped approval and for push fatigue.
  - **§12:** new tests (proposed T-CIBA-01..), plus T-E2E rows for each outcome against a
    stand-in approval service, like the CDP stub.
  - INV-12 and INV-13 are unchanged.
