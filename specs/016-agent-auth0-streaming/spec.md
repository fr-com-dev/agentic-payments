# Feature Specification: Auth0 Sign-In, Token Propagation and Streaming for the Hosted Agent

**Feature Branch**: `claude/016-agent-auth0-streaming`

**Created**: 2026-11-15

**Status**: Draft

**Input**: User description: "L1 must support Auth0, not MS Entra anymore, and the token must be propagated from
L1 to L2 to validate and check policies. API docs must also support OAuth2 to test easily from Swagger UI. A new
application in Auth0, with all the changes required. L1 must do text streaming to be compatible with chatbots or
other agents. Update the specs." The owner's request of 2026-11-15; its content, and the five decisions taken the
same day, are carried into the sections below.

## Clarifications

### Session 2026-11-15

- Q: With Entra removed from the hosted agent, who may call it? → A: People and machines. A signed-in person's
  token starts a run for that person's own account. A machine caller's token from the same tenant (client
  credentials) starts a run that the platform account pays for, as a system identity's did. Every machine
  caller, the deployment pipeline's smoke run included, has its own confidential client at the tenant and a
  stored credential. Rejected: people only, with the pipeline's smoke run reduced to health checks.
- Q: Which application does the tenant need, given that verifying a forwarded token needs none at L2? → A: One
  public client for the agent's callers (authorization code with PKCE, no secret), which Swagger UI, chatbots
  and command-line callers sign in through. L1 and L2 both verify its tokens against people's API, which
  already exists. Rejected: a second public client for L2's own Swagger UI.
- Q: Which streaming format should the hosted agent speak? → A: Server-sent events on the existing run route,
  chosen by the request's `Accept` header; the JSON answer stays the default. Rejected: an OpenAI-compatible
  chat route, and the AI SDK's UI message stream.
- Q: Should the deployed agent serve Swagger UI too? → A: Yes, where an environment's parameter file turns it
  on; off by default. Rejected: local only, because a local page can only call the local agent.
- Q: Which people may start a run? → A: People with a role. A person needs the permission `agent:run`, held by
  a new role that a tenant administrator assigns by hand, as the administrator's role is today. Rejected:
  anyone who signs in, because every run uses the platform's model whoever pays for the purchases, and
  sign-ups at the tenant are open.

## Where the hosted agent stands today

| Topic | Today (SPEC v1.16) | In this feature |
|---|---|---|
| Who the deployed agent accepts | System identities from the organization's directory (Entra) only; no person's token from the tenant starts a run there (v1.13) | People with the role, and machine callers, both from the sign-in tenant (Auth0); nothing from Entra |
| Applications at the tenant | Two: L2's approval client and the portal's | Those two, one public client for the agent's callers, and one confidential client per machine caller |
| How L2 learns who a payment is for | L1 writes the user on the payment request; L2 takes L1's word | L1 forwards the caller's token; L2 verifies it and takes the user from it |
| The caller's token after L1 verified it | Deleted, so nothing downstream can forward it | Forwarded to L2 only, on the payment and budget calls of that run |
| Whose phone is asked (015) | The person named by a field L1 fills in, checked against the user | The person in the token L2 verified |
| API docs | Local only; tokens are pasted into the page | The agent's page signs a person in at the tenant; an environment can turn the page on for its deployed agent |
| The answer to a run | One JSON object when the run ends | The same, or a stream of events as the answer is written, at the caller's choice |

Entra stays where it has nothing to do with the agent's callers: the deployment pipeline's sign-in to Azure, the
agent's own access to the model, and the operators' group.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A person signs in and runs the deployed agent for their own account (Priority: P1)

A person who has the agent role signs in at the tenant through the agent's client and sends a goal to the
deployed agent. The run buys what the goal needs from that person's own account, within that person's own
expense policy and the platform limits. Nobody else's money moves, and the platform account pays nothing.

**Why this priority**: It is the reason for the feature. Today no person can start a run on a deployed agent at
all.

**Independent Test**: With a person onboarded at the portal and holding the role, send a goal with their token;
check that the purchases are recorded for that person, signed by that person's account, and counted against that
person's budgets.

**Acceptance Scenarios**:

1. **Given** a person with the role and an account, **When** they send a goal with a token obtained through
   the agent's client, **Then** the run completes and every payment of it is recorded for that person and paid
   from that person's account.
2. **Given** the same person, **When** a purchase would exceed their own daily ceiling, **Then** it is denied
   by their policy exactly as it would be for a run started any other way.
3. **Given** a person with the role but no account at the portal, **When** they send a goal, **Then** nothing
   is paid, and the answer says the account is missing.
4. **Given** a completed run, **When** the same person sends a second goal with the session reference they
   were given, **Then** the session's budget carries over; another person's reference is unknown to them.

---

### User Story 2 - L2 takes the user from the token it verified itself (Priority: P1)

L1 forwards the caller's token to L2 with every payment request and every budget question of the run. L2
verifies that token on its own and takes the user from it. A payment request can no longer name a user, so a
faulty or compromised L1 cannot spend from an account whose owner did not call it.

**Why this priority**: It is the security gain the owner asked for: policies are checked for the person the
token proves, not for the person L1 says.

**Independent Test**: Send L2 a payment request with L1's role token and Alice's verified token; check that
Alice's policy decides and Alice's account signs. Then repeat with a request that tries to name Bob; check that
it is refused. The must-fail half removes L2's check and shows Bob's account signing.

**Acceptance Scenarios**:

1. **Given** Alice's valid token forwarded by L1, **When** L2 authorizes a payment, **Then** the decision is
   made under Alice's policy and budgets and, when allowed, signed by Alice's account.
2. **Given** Alice's token, **When** the payment request tries to name another user in any field, **Then** L2
   refuses the request and records no decision.
3. **Given** a token that fails any check (signature, issuer, audience, expiry, client, permission), **When**
   L1 forwards it, **Then** L2 refuses the request, nothing is signed, and nothing is appended to the ledger.
4. **Given** sign-in is configured at L2, **When** a payment request arrives with L1's role token and no
   caller's token, **Then** L2 refuses it.
5. **Given** a person's valid token alone, without L1's role token, **When** it is sent to L2, **Then** L2
   refuses it: the caller's token opens no route by itself.
6. **Given** a token that expires during a run, **When** the next payment is requested, **Then** it is
   refused, nothing is paid, and the answer says the sign-in has expired.

---

### User Story 3 - Only a person with the role, through the agent's client, starts a run (Priority: P1)

The agent refuses everyone else before it reads the request or calls the model: a person without the role, a
token the portal's web app obtained, a token from the organization's directory, and a token from any other
issuer.

**Why this priority**: Opening the deployed agent to people must not open it to everyone who can sign up, and
must not let a portal session start purchases.

**Independent Test**: Send the same goal with five tokens (role and agent's client; no role; the portal's
client; a directory token; another issuer). Only the first starts a run.

**Acceptance Scenarios**:

1. **Given** a person without the role, **When** they send a goal through the agent's client, **Then** the
   agent answers "forbidden" and no model call or L2 call is made.
2. **Given** a token obtained by the portal's web app, **When** it is sent to the agent, **Then** it is
   refused, with or without the role; and when forwarded to L2 it is refused there too.
3. **Given** a token from the organization's directory, **When** it is sent to the agent, **Then** it is
   refused as an unknown issuer, whatever roles it carries.
4. **Given** an administrator of the portal without the agent role, **When** they send a goal, **Then** they
   are refused: the two roles are separate.
5. **Given** a person whose role was taken away, **When** their token expires, **Then** their next token
   starts no run.

---

### User Story 4 - A machine caller runs with its own client, and the platform account pays (Priority: P2)

A machine caller, such as the deployment pipeline's smoke run or another service, gets a token from the tenant
with its own client and credential. The agent runs its goal with no user behind it, so the platform account
pays under the platform mandate, as it did for a system identity.

**Why this priority**: The pipeline's smoke run decides whether a new revision is promoted, and it loses its
caller when Entra goes.

**Independent Test**: With a machine client that holds the permission, send a goal; check that the payments
name no user and are signed by the platform account. With a machine client that does not hold it, check the
refusal.

**Acceptance Scenarios**:

1. **Given** a machine caller's token with the permission, **When** it sends a goal, **Then** the run
   completes, its payments name no user, and the platform account pays under the platform mandate.
2. **Given** a machine caller's token without the permission, **When** it sends a goal, **Then** the agent
   refuses it.
3. **Given** a machine caller's token, **When** it is sent to the portal, **Then** the portal refuses it, as
   it refuses every machine token today.
4. **Given** a person's token, **When** the run pays, **Then** the platform account never pays for it,
   whatever fails.
5. **Given** the pipeline deploys a new revision of the agent, **When** its smoke run starts, **Then** it
   calls the agent as its own machine caller, and no credential of that caller is held in GitHub.

---

### User Story 5 - A person tries a run from the API docs without pasting a token (Priority: P2)

On the agent's API docs page a person presses "Authorize", signs in at the tenant, and then tries the run route
from the page. The same works on a deployed agent when its environment turns the page on.

**Why this priority**: It is how the owner wants to test, locally and in the cloud, without copying tokens
between tools.

**Independent Test**: Open the docs page, sign in through "Authorize", send a goal from the page and read the
answer; check that the page held the token in memory only and contacted nothing but its own origin and the
tenant.

**Acceptance Scenarios**:

1. **Given** the docs page of a local agent configured for the tenant, **When** a person presses "Authorize"
   and signs in, **Then** the page obtains a token for people's API through the agent's client and sends it
   with the requests it makes.
2. **Given** the page after a reload, **When** the person tries a request, **Then** they must sign in again:
   the page kept no token.
3. **Given** an environment whose parameter file turns the docs on, **When** its agent is deployed, **Then**
   the page is served there and signs in the same way; with the value absent or off, the page does not exist.
4. **Given** any environment, **When** it is deployed, **Then** L2, the seller and the portal serve no docs
   page there, as today.
5. **Given** the docs page, **When** a person prefers to paste a token, **Then** that still works.

---

### User Story 6 - A chatbot or another agent reads the answer as it is written (Priority: P2)

A caller that asks for a stream receives the agent's text as the model writes it, an event for each finished
purchase step, and a last event with the same result a caller without a stream receives. A caller that does not
ask gets today's JSON answer, unchanged.

**Why this priority**: A run can take a minute or more. A chat interface or a calling agent that sees nothing
until the end is hard to use and is cut off by impatient clients.

**Independent Test**: Send the same goal twice, once asking for a stream and once not; check that the stream's
last event equals the JSON answer in every field but the run's identifier and times, and that text arrived
before the run ended.

**Acceptance Scenarios**:

1. **Given** a request that asks for a stream, **When** the run proceeds, **Then** the caller receives the
   run's identifier first, text as it is written, one event per finished tool step in order, and a last event
   with the full result.
2. **Given** a request that does not ask for a stream, **When** the run ends, **Then** the answer is the JSON
   object of today, field for field.
3. **Given** a request refused before the run starts (no token, no role, too many runs, a bad body), **When**
   it asked for a stream, **Then** it receives the same status and JSON error as without a stream.
4. **Given** a stream in progress, **When** the caller disconnects, **Then** the run stops before its next
   step, and a paid fetch already in progress completes, as today.
5. **Given** a stream in progress, **When** the run reaches its deadline or fails, **Then** the last event
   says so with the same status, stop reason and error a JSON answer would carry.
6. **Given** a quiet period while a purchase settles, **When** nothing is written, **Then** the connection is
   kept alive and no intermediary closes it.

---

### User Story 7 - The owner's phone is asked from the token L2 verified (Priority: P2)

When a person's payment is escalated, L2 asks that person's phone (feature 015). The person it asks is now the
one in the token L2 verified, so the field L1 filled in for this (`approvalSubject`) leaves the payment request.
With people able to start runs on a deployed agent, this is the first time a deployed run can reach its owner's
phone.

**Why this priority**: It finishes what 015 started, with less to trust, and replaces 015's hosted-agent slice.

**Independent Test**: With the stand-in approval service, start a person's run that escalates; check that the
request is addressed to the subject of the forwarded token, that a payment request carrying `approvalSubject`
is refused, and that a machine caller's escalation asks nobody.

**Acceptance Scenarios**:

1. **Given** a person's run whose payment escalates, **When** L2 sends the approval request, **Then** it is
   addressed to the subject of the token L2 verified for that request.
2. **Given** a payment request that carries an approval subject, **When** L2 receives it, **Then** L2 refuses
   it: the field no longer exists.
3. **Given** a machine caller's run whose payment escalates, **When** L2 decides eligibility, **Then** nobody
   is asked by phone, and the escalation waits for the operator and the administrators.
4. **Given** a person whose sign-in tenant is not the approval service's, **When** their payment escalates,
   **Then** nobody is asked by phone (015's same-tenant rule, unchanged).

---

### User Story 8 - Entra is gone from the agent, and a leftover setting stops it (Priority: P3)

Nothing about the agent's callers refers to the organization's directory any more: not the agent's settings,
not the environment's parameter files, not the pipeline, not an app registration, role or role assignment made
for callers. An agent started with a leftover directory setting refuses to start and names it.

**Why this priority**: A half-removed second issuer is the kind of leftover that later accepts a token nobody
meant to accept.

**Independent Test**: Start the agent with each old setting in turn and check the refusal; validate an
environment's files and check that no caller-related directory object remains in them.

**Acceptance Scenarios**:

1. **Given** the agent's settings contain the directory's tenant or audience, **When** it starts, **Then** it
   refuses and names the setting, never its value.
2. **Given** an environment's files, **When** they are validated, **Then** they hold no audience, app role or
   role assignment for the agent's callers at the directory.
3. **Given** the agent with no sign-in settings at all, **When** it starts, **Then** it refuses: nobody could
   call it.

### Edge Cases

- **The token expires during a run.** The agent verified it at the start; L2 verifies it on every call. A
  payment requested after expiry is refused, nothing is paid, and the answer says to sign in again. Payments
  already made stand.
- **The person's role is removed during a run, or between runs.** It takes effect when the token expires (an
  hour at most), as for the administrator's role.
- **L1 forwards a valid token of someone other than the caller.** L2 cannot tell. A compromised L1 can therefore
  spend, within that person's own policy and until the token expires, for a person who called it recently. It
  can no longer spend for a person who has not. This is recorded as a residual risk.
- **L2 cannot reach the tenant's keys.** The request is refused; nothing is paid. Keys already known keep
  working until they are refreshed.
- **A payment request names a user, or carries an approval subject.** Refused as malformed; no decision is
  recorded.
- **A machine token carries a claim that looks like a person's.** It is a machine token: no user, the platform
  account, and the machine checks decide.
- **A person with the role has no account at the portal.** The run starts, nothing can be paid, and the answer
  says the account is missing. No account is created by a run.
- **The local scripted demo and the command-line agent.** With sign-in not configured at L2 they run as today:
  no caller's token, no user, the platform account pays.
- **A stream behind a proxy that buffers.** The stream is marked so that intermediaries do not buffer or
  transform it; the keep-alive bounds the silence.
- **A caller sends an `Accept` header naming both forms.** The stream is used only when the event-stream form
  is asked for; anything else gets JSON.
- **A session reference issued before this feature.** It no longer verifies; the caller starts a new session.
- **The docs page on a deployed agent whose origin is not registered at the tenant.** Sign-in fails at the
  tenant with its own message; pasting a token still works.
- **An approved escalation is retried.** The retry is a new payment request and carries the caller's token
  again. An approval never stands in for the token.

## Requirements *(mandatory)*

### Functional Requirements

**Who the hosted agent accepts**

- **FR-001**: The hosted agent MUST accept access tokens from one issuer only, the sign-in tenant, issued for
  people's API. A token from any other issuer, the organization's directory included, MUST be refused as
  unauthenticated. *(SPEC: L1-6, §3.3, SEC-14)*
- **FR-002**: A person's token MUST pass, in this order: signature, issuer, audience, validity period and a
  non-empty subject (else unauthenticated); then it is not a machine token, it carries the permission
  `agent:run`, and its client is on the agent's list of clients (else forbidden). *(SPEC: L1-6, SEC-14, SEC-20)*
- **FR-003**: The portal's client MUST never be on the agent's list of clients: the agent MUST refuse to start
  when it is. A token the portal's web app obtained MUST never start a run. *(SPEC: L1-6, SEC-20)*
- **FR-004**: A machine caller's token (client credentials, same tenant, same API) MUST pass the same first
  checks, and then carry the permission `agent:run` (else forbidden). It names no user. *(SPEC: L1-6, SEC-14)*
- **FR-005**: Every refusal MUST happen before the request body is read, before any model call and before any
  call to L2 or L3. *(SPEC: L1-6)*
- **FR-006**: The run limits (concurrent runs, starts per hour, the per-address limit, the deadline) MUST apply
  to both kinds of caller, counted per caller. *(SPEC: L1-6 limits)*
- **FR-007**: A session reference MUST be bound to the caller it was issued to, of either kind; another
  caller's reference MUST be unknown. References issued before this feature need not verify.
  *(SPEC: L1-6 sessions)*
- **FR-008**: Locally only, the development issuer MUST stand in for the tenant for both kinds of caller, with
  tokens of the tenant's shape. It MUST be refused outside local mode. *(SPEC: L1-6, CFG-2)*

**The caller's token reaches L2, and L2 decides from it**

- **FR-009**: L1 MUST send the caller's token to L2 with every payment request and every budget question of
  the run, beside its own role token. It MUST NOT send it anywhere else: not to L3, the seller, the facilitator
  or the model, and not into a tool's input or output. *(SPEC: L1-1, L1-2, L1-6, INV-13)*
- **FR-010**: L2 MUST verify the forwarded token itself, with the same checks as FR-002 and FR-004, against
  the tenant's keys. It MUST NOT rely on any statement by L1 about who the caller is. *(SPEC: L2-5, L2-8)*
- **FR-011**: The user a payment is for MUST come only from the token L2 verified: a person's token names
  that person; a machine caller's token names no user. *(SPEC: L2-8, §7)*
- **FR-012**: A payment request or a budget question MUST NOT be able to name a user or an approval subject.
  L2 MUST refuse one that does, and record no decision. *(SPEC: §7, L2-5)*
- **FR-013**: When the forwarded token fails verification, L2 MUST refuse the request: nothing is decided,
  nothing is signed, nothing is appended to the ledger. L1 MUST report it to the run as an error that says
  whether the sign-in expired, and MUST NOT retry it with another identity. *(SPEC: L2-5, L1-1)*
- **FR-014**: Where sign-in is configured at L2, every payment request and budget question MUST carry a
  caller's token; one without it MUST be refused. Where it is not configured (the local scripted demo and the
  command-line agent), requests carry none and name no user, as today. *(SPEC: L2-5, L1-4, CFG-2)*
- **FR-015**: User accounts MUST need sign-in to be configured at L2: with user accounts on and sign-in not
  configured, L2 MUST refuse to start and name the settings. *(SPEC: L2-8, CFG-2)*
- **FR-016**: The caller's token MUST open no route of L2 by itself. Every route keeps its one role token, and
  the caller's token is accepted only together with L1's role token, on the payment and budget routes.
  *(SPEC: INV-13, L2-5)*
- **FR-017**: A person's payment MUST never be paid by the platform account, whatever fails. A machine
  caller's payment is paid by the platform account under the platform mandate. *(SPEC: L2-8, hard rule 11)*
- **FR-018**: L2 MUST apply to the forwarded token the same client rule as the agent: a token from the
  portal's client, or from any client not on the list, MUST be refused. *(SPEC: SEC-20)*
- **FR-019**: Verifying the token MUST happen before the serialized section and MUST make no network call
  inside it. *(SPEC: hard rule 5)*
- **FR-020**: The caller's token MUST never be stored, logged or returned: not in the ledger, a response, an
  event, a run log line, a step, a stream event or an error. A known-value scan MUST find it nowhere.
  *(SPEC: SEC-16, L1-6 logs)*

**Machine callers and the platform account**

- **FR-021**: Each machine caller MUST have its own confidential client at the tenant, declared in the
  tenant's configuration by name. Its only grant MUST be client credentials for people's API with the
  permission `agent:run`; it MUST NOT be able to sign a person in, and MUST NOT hold the administrator's
  permission. *(SPEC: §3.3, T-IAC-02)*
- **FR-022**: A machine caller's credential MUST be kept where the environment's other secrets are kept. It
  MUST NOT appear in the repository, a template, a parameter file, the tenant configuration's stored state or
  GitHub. *(SPEC: §3.3, Constitution V)*
- **FR-023**: The deployment pipeline's smoke run MUST call the agent as a machine caller of its own. The
  pipeline MUST keep promoting or rolling back on the result of that run. *(SPEC: §3.1 Azure profile)*

**The tenant**

- **FR-024**: The tenant MUST gain one public client for the agent's callers: authorization code with PKCE,
  no secret, signing people in for people's API. Its allowed return addresses MUST be the agent's docs page,
  locally and where an environment's deployed agent serves it, and nothing else. *(SPEC: §3.3, T-IAC-02)*
- **FR-025**: People's API MUST gain the permission `agent:run`, and the tenant one role that holds exactly
  it. A tenant administrator assigns the role per person, by hand; the tenant's configuration assigns it to
  nobody. *(SPEC: L2-8, T-IAC-02)*
- **FR-026**: The tenant's applications MUST be exactly: L2's approval client, the portal's client, the
  agent's client, and one client per declared machine caller. A check MUST fail on any other.
  *(SPEC: T-IAC-02)*
- **FR-027**: The portal MUST keep accepting its own client's tokens only. The agent role MUST give nothing at
  the portal, and the administrator's role MUST give nothing at the agent. *(SPEC: L2-8, SEC-20)*

**API docs**

- **FR-028**: The agent's API docs page MUST let a person sign in at the tenant through the agent's client
  (authorization code with PKCE) and MUST send the resulting token with the requests it makes. Pasting a token
  MUST remain possible. *(SPEC: L1-6 API docs, SEC-13)*
- **FR-029**: The page MUST hold no secret and MUST keep the token in memory only: a reload signs the person
  out of the page. *(SPEC: SEC-13)*
- **FR-030**: The page MUST be able to contact its own origin and the tenant only, and MUST run scripts from
  its own origin only. *(SPEC: SEC-13)*
- **FR-031**: The sign-in addresses the page uses MUST come from the service's own settings, so the served
  document always names the tenant the service verifies against. *(SPEC: L1-6 API docs)*
- **FR-032**: An environment's parameter file MUST be able to turn the docs page on for its deployed agent;
  the value MUST default to off. No other deployed unit MAY serve a docs page. *(SPEC: §3.1 Azure profile,
  T-API-08, T-IAC-01)*
- **FR-033**: The docs routes MUST stay token-free, static and unable to reach the model, a session, L2 or
  L3. *(SPEC: SEC-13)*

**Streaming**

- **FR-034**: The run route MUST answer with a stream of server-sent events when the request asks for the
  event-stream form, and with today's JSON object otherwise. *(SPEC: L1-6 routes)*
- **FR-035**: A stream MUST carry, in order: one event with the run's identifier and start time; the agent's
  text as it is written; one event per finished tool step, in completion order, with the step as the JSON
  answer lists it; and one last event with the full result object of the JSON answer. Nothing follows the last
  event. *(SPEC: L1-6)*
- **FR-036**: A request refused before the run starts MUST get the same status and JSON error with or without
  a stream. Once a stream has started, every way a run can end (completed, stopped, failed) MUST be reported in
  the last event. *(SPEC: L1-6)*
- **FR-037**: A stream MUST carry nothing a JSON answer would not: no token, no model reasoning, no tool input
  beyond the address and the purpose a step already lists. *(SPEC: L1-6, SEC-16)*
- **FR-038**: The deadline, the run limits, the step limit, the abort on disconnect and the rule that a paid
  fetch in progress completes MUST apply to a stream as they do to a JSON answer. *(SPEC: L1-6 limits)*
- **FR-039**: A stream MUST send a keep-alive at least every 15 seconds while nothing else is sent, and MUST
  be marked so that intermediaries neither buffer nor transform it. *(SPEC: L1-6, §3.1 Azure profile)*
- **FR-040**: The agent MUST keep exactly its two tools, its limits and its model rules. Streaming MUST NOT add
  a memory, a workspace, a sub-agent or a tool. *(SPEC: L1-6 agent, hard rule 2)*

**Feature 015 follows**

- **FR-041**: The person asked by phone for an escalated payment MUST be the subject of the token L2 verified
  for that payment request. The check that the subject is the escalation's owner stays, and now always holds
  by construction. *(SPEC: L2-7; specs/015 FR-009, FR-013)*
- **FR-042**: The approval subject MUST leave the payment request (FR-012). A machine caller's escalation
  MUST ask nobody by phone. 015's same-tenant rule stays. *(SPEC: §7, L2-7)*
- **FR-043**: 015's task list MUST record that its hosted-agent slice (T007, T008, T015, T025) is replaced by
  this feature, and that its other open tasks are to be read against it. *(specs/015 tasks.md)*

**Entra leaves the agent**

- **FR-044**: The agent's settings for the organization's directory MUST be removed. An agent that sees one
  MUST refuse to start and name it, never its value. *(SPEC: L1-6, CFG-2)*
- **FR-045**: An environment's files MUST hold nothing of the directory for the agent's callers: no audience,
  no app role, no role assignment, no list of people who may run the agent. The deployed agent MUST receive
  the sign-in settings instead. *(SPEC: §3.1 Azure profile, T-IAC-01)*
- **FR-046**: Entra MUST stay for the pipeline's sign-in to Azure, the agent's access to the model and the
  operators' group, unchanged. *(SPEC: §3.1 Azure profile)*

**Scope amendments and documents**

- **FR-047**: `SPEC.md` and the constitution MUST be amended together, before any code of this feature, to
  record: Auth0 as the agent's only issuer; the caller's token forwarded to L2 and what it may and may not
  open; the agent's client, the permission, the role and machine callers at the tenant; the stored credential
  of a machine caller; the docs page in a deployed environment; streaming. *(SPEC: §1.3, §3.3, INV-13,
  Constitution V and governance)*
- **FR-048**: Every route, field, status or header this feature changes MUST be changed in the service, the
  SPEC table it belongs to and its OpenAPI document together. *(SPEC: L1-6, L2-5, T-API)*

### Non-Functional Requirements

- **NFR-001 (Fail closed)**: Every failure fails closed: the tenant's keys unreachable, a token that fails any
  check, a missing token where one is required, a request that names a user. No payment results.
  *(SPEC: SEC-8, SEC-14)*
- **NFR-002 (Least privilege)**: The caller's token gives L2 nothing but the identity of the caller; L1's role
  token gives nothing but the payment and budget routes; a machine caller's client can do nothing but ask for
  its own token. *(SPEC: INV-13)*
- **NFR-003 (Isolation between people)**: Nothing in this feature lets one person pay from, see or count
  against another person's account, session or budget. *(SPEC: SEC-19)*
- **NFR-004 (Secrets and personal data)**: A known-value scan over test output MUST find no token, credential
  or session MAC, and no name or email, in the ledger, logs, events, stream events or responses.
  *(SPEC: SEC-16, hard rule 11)*
- **NFR-005 (Every check is proven)**: Each new check (the user from the token, the required token, the client
  rule at L2, the permission, the refused fields, the role token beside the caller's token) MUST have a test
  that fails without it, switched by a test-only dependency, never by an environment variable.
  *(SPEC: Definition of done)*
- **NFR-006 (Responsiveness)**: With a stream, the caller MUST receive the run's identifier within 2 seconds
  of the request being accepted, and text no later than the model produces it plus 1 second.
- **NFR-007 (No regression)**: The local scripted demo MUST give the same summary as before
  (`spent on-chain: 0.006 USDC`, `hash chain ok=true`), and a JSON answer MUST keep its fields.

### Key Entities

- **Caller**: Whoever sends a goal to the hosted agent. Either a person (their subject at the tenant) or a
  machine caller (its client at the tenant). Never both.
- **Caller's token**: The access token the caller presented, issued by the tenant for people's API. It lives
  for the run only, in L1's memory and on its calls to L2.
- **Agent's client**: The public application at the tenant through which people sign in to call the agent.
- **Machine caller's client**: A confidential application at the tenant, one per machine caller, with one
  stored credential.
- **Agent role**: The role at the tenant that holds the permission `agent:run`, assigned to people by hand.
- **Forwarded identity**: What L2 derives from the verified token: the user (for a person) or none (for a
  machine caller), and, for a person, the subject used to address a phone approval.
- **Run stream**: The sequence of events a caller receives for one run when it asks for a stream.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person with the role and an account completes a purchase run on a deployed agent with their own
  sign-in, and 100% of that run's payments are recorded for them and paid from their own account.
- **SC-002**: 0 payments are made for a user whose verified token did not accompany the payment request,
  across a test set that includes a request naming another user, a request with no token, and tokens failing
  each check in turn.
- **SC-003**: 0 runs are started by a person without the role, by a token from the portal's client, or by a
  token from any issuer but the tenant.
- **SC-004**: The pipeline's smoke run completes as a machine caller, and 0 credentials of any machine caller
  are found in the repository, the parameter files or GitHub.
- **SC-005**: A person goes from opening the docs page to a completed run in under 2 minutes without copying a
  token, locally and on a deployed agent whose environment turned the page on.
- **SC-006**: With a stream, the caller sees the first text at least 5 seconds before the run ends in 95% of
  runs that make a purchase, and the last event equals the JSON answer in every field but the run's
  identifier and times.
- **SC-007**: A known-value scan finds the caller's token in 0 places: ledger, logs, events, stream events,
  responses and errors.
- **SC-008**: An escalated payment of a person's deployed run sends its approval request to that person and to
  nobody else, with no field of the payment request naming them.
- **SC-009**: 0 settings, parameters or directory objects for the agent's callers remain at the organization's
  directory after the feature is delivered, and an agent started with a leftover setting does not start.
- **SC-010**: The local scripted demo's summary is unchanged.

## Assumptions

- The portal keeps relaying its own users' requests to L2 as it does today, with its own role tokens; forwarding
  the person's token from the portal to L2 is not part of this feature.
- A person must already have an account, made at the portal, before a run can pay for them. A run creates no
  account.
- People's API at the tenant stays one API for the portal and the agent. The agent's client gets no refresh
  tokens: a token lives an hour, and a caller signs in again after that.
- Machine callers are few and are declared by name in the tenant's configuration. The first is the pipeline's
  smoke run. How its credential reaches the place that uses it, without GitHub holding it, is decided in the
  plan.
- A machine caller is authorized by the permission in its token, which the tenant gives only through that
  client's grant; machine clients are not listed again at the agent or at L2.
- A token is verified at L1 when the run starts and at L2 on every call. A run lasts at most 200 seconds, so a
  token rarely expires inside one; when it does, the run reports it.
- The stream is one-way, from the agent to the caller, over the same request. There is no resumption: a caller
  that loses the connection starts a new run, in the same session if it kept the reference from an earlier
  run.
- The docs page in a deployed environment is meant for development environments. It exposes the API's
  description and the agent's public client identifier, both of which are public by nature.
- The object registered for the agent's callers at the organization's directory is retired by an administrator
  following the steps the plan gives; the environment keeps working while it still exists.
- 015's tasks other than its hosted-agent slice (the person's view of waiting payments, the tenant's clean-up,
  the final documents) stay with 015 and are delivered there.
- The feature is proven against the development issuer and the stand-in approval service. One live check with
  the real tenant (a person's run on the deployed agent) closes it and is recorded when done.
