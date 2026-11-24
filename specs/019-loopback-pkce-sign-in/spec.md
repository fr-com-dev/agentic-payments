# Feature Specification: Loopback PKCE Sign-In from a Desktop Client for the Hosted Agent

**Feature Branch**: `claude/spec-19-implementation-5b3595`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "Implement spec-19: Loopback PKCE sign-in for the payments agent (Auth0 + L1 API)."
The owner's document `spec-19.md` of 2026-11-24: a person signs in with their own account at the tenant from a
local desktop client (the browser, a return to the computer's loopback address, PKCE) and calls `POST /v1/runs`
with a token of their own, with no hand-copied token. In scope: the tenant's configuration and the hosted agent
(L1) and L2. Out of scope: the client or plugin code, a hosted remote-MCP variant, and the machine path, which
stays as it is. Its content, read against the repository, and one decision taken the same day are carried into
the sections below.

## Clarifications

### Session 2026-11-24

- Q: spec-19 asks the API to also read a person's roles from a custom claim that a new post-login rule writes.
  The agent and L2 already require the permission `agent:run`, which the tenant grants only through the agent
  role. How should a desktop client's token be checked? → A: Permission only. The agent and L2 keep
  `agent:run` as their one check, for every client. The tenant refuses sign-in and renewal through the desktop
  client to anyone without the role. Tokens get no roles claim. Rejected: a roles claim on the desktop
  client's tokens that the agent and L2 also require; and the same claim and refusal on the docs page's client
  as well.
- Q: The DAST findings remediation (`specs/017-dast-findings-remediation`, FR-024), built in parallel, adds a
  bearer challenge to the agent's 401 and says "nothing that says which check failed". spec-19 asks for a code
  per failed check. What should the agent's 401 say? → A: Expired or invalid only. The 401 gains a code that is
  `missing_token`, `token_expired` or `invalid_token`; a wrong audience, issuer or signature are not told apart.
  This narrows that remediation's rule by one fact, the expiry, which the token itself already shows, and which
  is the one case where renewing helps. Rejected: no code at all; spec-19's six codes.

## Reading spec-19 against the repository

spec-19 was written from the published API description. Part of it already holds, two of its values are
corrected to the repository's, and the rest is new. Two features in progress on other branches change the same
ground first: the DAST findings remediation (`specs/017-dast-findings-remediation`: the agent's 401 challenge, a
limit on failed authentications) and the tenant sign-up hardening (pentest finding P1, branch
`claude/pentest-report-fixes-0709b1`: people's connections and the applications allowed on each). This feature
builds on both.

| spec-19 item | Today (SPEC v1.26) | In this feature |
|---|---|---|
| New public application for a local desktop client | The tenant has the docs page's public client (single-page, code with PKCE, no refresh token), the portal's, L2's and one per machine caller. A check fails on any other. | A fifth kind of application, the desktop client: native, public, code with PKCE and refresh tokens. The check admits exactly it as well |
| Audience `agentic-payments-claude-client` | Every service verifies people's API (`AUTH_AUDIENCE`, `https://x402-api/<env>`). An API's identifier can't change. | **Corrected**: the desktop client signs in for people's API (`AUTH_AUDIENCE`). spec-19's own token checks and tests already name `AUTH_AUDIENCE`. No new API |
| Role `agent-runner` holding `agent:run` | The role `x402-agent` holds exactly `agent:run`, assigned per person by hand. The tenant has exactly two roles | **Corrected**: the desktop client uses `x402-agent`. No third role |
| API settings: RBAC, permissions in the token, offline access, RS256, ≤ 3600 s, consent skipped | All already hold for people's API | Unchanged; the feature's checks confirm them |
| Post-login rule: deny without the role; add a roles claim | Post-login rules date the sign-in and its second factor; none refuses a sign-in | A rule refuses sign-in and renewal through the desktop client without the role. No roles claim (Clarifications) |
| The API reads `agent:run` from `scope` | The agent and L2 read it from `permissions` (what the tenant granted, not what the client asked for) | Unchanged. The desktop client still asks for `agent:run`, so the scope carries it too |
| Client read from `azp` and `client_id` | Already: both are read and must agree | Unchanged |
| Add the new client to `AGENT_CLIENT_IDS` | The list holds the docs page's client, at the agent and at L2 | The desktop client joins it, at both |
| Missing payer account: a clear refusal before the agent starts | The run starts, and each purchase is denied by policy (`user_not_onboarded`) | The agent asks L2 first and refuses the run with a reason |
| Limits (2 concurrent, 20 starts an hour) by `sub` | Already keyed by the issuer and `sub` | Unchanged; a test proves that signing in again or renewing resets nothing |
| Machine-readable 401 | `{ "error": "unauthorized" }`. The DAST remediation adds the bearer challenge, saying nothing about which check failed | An `error_code` beside `error`: missing, expired or invalid only (Clarifications) |
| Connections: only the ones people sign in with | The tenant sign-up hardening declares people's connections and allows them on the portal's and the agent's applications only | The desktop client is allowed on the same connections as the agent's docs page client, and on no other |
| PKCE S256 required | The DAST remediation records that the tenant also accepts the `plain` method, as a residual | The desktop client refuses any method but S256, so that residual does not reach it |
| Log `sub`, `azp`, `runId`, `authorizationId` per run | The run log has the requester (issuer host and `sub`), the run, the session and the authorization | The client is added |
| `GET /.well-known/agent-auth`; `signIn` scopes in the API description | Neither | Both, optional (P3) |
| Require a second factor for this application | Administrators' interactive sign-ins only | Every interactive sign-in through the desktop client too |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A person signs in from their own computer and starts a run, with no copied token (Priority: P1)

A person who holds the agent role and has an account runs a desktop client on their own computer. The client
opens the browser at the tenant's sign-in page. The person signs in, with a second factor. The browser returns
to the client on the computer's loopback address, the client exchanges the code with its proof key, and the
client sends goals to the hosted agent with the access token it received. The run pays from that person's own
account, as a run started any other way does.

**Why this priority**: It is the reason for the feature. Today a person can reach a deployed agent only by
signing in on its docs page or by copying a token between tools.

**Independent Test**: With the desktop client registered at the tenant and on the agent's and L2's lists of
clients, follow the sign-in contract with a script that stands in for the client. Check the token's issuer,
audience, client, permission and refresh token. Then send a goal with it and check that the run completes and
that its payments are that person's.

**Acceptance Scenarios**:

1. **Given** a person with the role and an account, **When** they complete the sign-in through the desktop
   client, **Then** they receive an access token whose issuer is the tenant, whose audience contains people's
   API, whose client is the desktop client and which carries `agent:run` both as a permission and in its
   scope, and a refresh token with it.
2. **Given** that access token, **When** the person sends a goal, **Then** the run is accepted and every
   payment of it is recorded for that person and paid from their own account.
3. **Given** the sign-in, **When** the browser returns to `http://localhost:53682/callback` instead of
   `http://127.0.0.1:53682/callback`, **Then** the tenant accepts it too. **When** it would return to any
   other address, port or path, **Then** the tenant refuses it.
4. **Given** a token from the desktop client, **When** it is sent to the portal, **Then** the portal refuses
   it: the portal accepts its own client's tokens only.
5. **Given** the desktop client exists, **When** a person signs in on the agent's docs page or a machine
   caller starts a run, **Then** both work exactly as before.

---

### User Story 2 - The sign-in lasts for days and ends safely (Priority: P1)

The client renews its access token before it expires, without opening the browser again. Each renewal returns
a new refresh token and spends the old one. A refresh token used twice ends the whole sign-in. A sign-in ends
after 7 days without a renewal and 30 days after it started, whichever comes first. A person whose role was
taken away gets no new token.

**Why this priority**: An access token lives an hour. Without renewal the person signs in again every hour,
and a stolen long-lived credential is the main risk of a client that holds one.

**Independent Test**: Renew once and check the new tokens. Present the spent refresh token again and check
that the latest one stops working too. Take the role away and check that the next renewal is refused. Check
the lifetimes in the tenant's configuration.

**Acceptance Scenarios**:

1. **Given** a valid refresh token, **When** the client renews, **Then** it receives a new access token that
   still carries `agent:run` and a new refresh token; the one it spent no longer renews.
2. **Given** a refresh token that was already spent, **When** it is presented again, **Then** the tenant
   refuses it and revokes its whole family: the latest refresh token stops renewing too, and the person must
   sign in again.
3. **Given** a sign-in not renewed for 7 days, or started 30 days ago, **When** the client renews, **Then**
   the tenant refuses, and the person signs in again.
4. **Given** a person whose role was taken away, **When** the client renews, **Then** no new access token is
   issued. The access token already held works until it expires, an hour at most.
5. **Given** an administrator of the tenant revokes the person's refresh tokens, **When** the client renews,
   **Then** it is refused.
6. **Given** a person who signs in again or renews, **When** they start runs, **Then** the run limits count
   them as one person: a third concurrent run and a 21st start in an hour are refused, however many sign-ins
   and tokens they hold.

---

### User Story 3 - Only people allowed to spend get a desktop sign-in (Priority: P1)

The tenant itself turns away whoever may not start a run, before any token exists: a person without the role,
an authorization without a proof key, a code exchanged without its verifier. The agent turns away every token
that is not for it.

**Why this priority**: The desktop client is public: anyone can use its identifier. Who may spend must not
depend on the client behaving well.

**Independent Test**: Try the sign-in as a person without the role, without a code challenge, and with a wrong
verifier; check that no token is issued. Send the agent a token for another audience and a portal token; check
the refusals.

**Acceptance Scenarios**:

1. **Given** a person without the role, **When** they sign in through the desktop client, **Then** the tenant
   ends the sign-in with the error `not_authorized_for_agent` and issues no code and no token.
2. **Given** a person with the role, **When** they sign in interactively through the desktop client,
   **Then** the sign-in asks for a second factor, unless the person's session at the tenant already ends with
   one (FR-007); a renewal needs none.
3. **Given** an authorization request through the desktop client without a code challenge, or with a method
   other than S256, **When** it is completed, **Then** no token is issued.
4. **Given** a code, **When** it is exchanged without the verifier that matches its challenge, **Then** no
   token is issued.
5. **Given** a token for another audience, **When** it is sent to the agent, **Then** the agent answers 401;
   **given** a token from the portal's client, **then** 403, as today.

---

### User Story 4 - A person without a usable account is told before the run starts (Priority: P2)

Before the agent calls the model for a person's run, it asks L2, with the person's own token, whether that
person can pay. When they cannot (no completed setup, an account they turned off at the portal, or no person
accounts at that L2), the run is refused at once with a reason the client can show, and nothing is started.

**Why this priority**: Today the run starts, spends model time, and each purchase is then denied. A person who
signed in from a new desktop client most likely has not finished their setup at the portal yet.

**Independent Test**: As a person with the role who has not onboarded, send a goal; check the refusal and its
reason, and that no model call and no payment request was made. Onboard, send again, check that the run
starts.

**Acceptance Scenarios**:

1. **Given** a person with the role who has not completed their setup, **When** they send a goal, **Then** the
   agent answers 409 with the reason "not onboarded", and makes no model call and no payment request.
2. **Given** a person who turned their account off at the portal, **When** they send a goal, **Then** the same,
   with the reason "disabled". A person whose policies are all paused is not refused here: their run starts and
   each purchase is denied by policy, as today.
3. **Given** an L2 where person accounts are off, **When** a person sends a goal, **Then** the same, with the
   reason "accounts off": a person never falls back to the platform account.
4. **Given** a person whose account is ready, **When** they send a goal, **Then** the run starts as today.
5. **Given** a machine caller, **When** it sends a goal, **Then** no account question is asked: the platform
   account pays, as today.
6. **Given** L2 cannot be reached or gives an unexpected answer, **When** a person sends a goal, **Then** the
   run is refused as unavailable and nothing is started.
7. **Given** a token that expires between the agent's check and L2's, **When** a person sends a goal, **Then**
   the answer is the same as for any expired token (401, `token_expired`), and nothing is started.

---

### User Story 5 - A client can tell from a refusal what to do next (Priority: P2)

When the agent refuses a token, its answer says, in a form a program can read, whether a token was missing,
expired or otherwise invalid: send one, renew, or sign in again. It says nothing more about which check failed.

**Why this priority**: A client that guesses either signs the person in again when a renewal would do, or
loops on renewals that can never help.

**Independent Test**: Send the agent no token, an expired token, a token for another audience, a token from
another issuer, a token with a bad signature and a malformed token. Check the three codes, and that the last
four get the same answer.

**Acceptance Scenarios**:

1. **Given** an expired token, **When** it is sent, **Then** the answer is 401 with the code
   `token_expired`, beside the challenge that names an invalid token.
2. **Given** a token for another audience, from another issuer, with a bad signature or malformed, **When** it
   is sent, **Then** the code is `invalid_token` for each, and nothing else in the answer tells them apart.
3. **Given** no token, **When** a request is sent, **Then** the code is `missing_token`, and the challenge
   names no error.
4. **Given** a token that is both expired and invalid in another way, **When** it is sent, **Then** the code
   is `invalid_token`: only a token whose expiry is its one fault is reported as expired.
5. **Given** any of these, **When** a client reads only the existing `error` field, **Then** it is unchanged.
6. **Given** a request that asks for a stream, **When** it is refused before the run starts, **Then** it gets
   the same status, challenge and JSON body.

---

### User Story 6 - Every run and payment can be traced to a person and the client they used (Priority: P3)

The run log already names the person, the run, the session and each payment's authorization. It also names the
client the person's token came from, so an operator can tell a desktop run from a docs page run.

**Why this priority**: It helps investigate a disputed payment, but nothing is blocked without it.

**Independent Test**: Start one run from each client and read the log lines; check the client in each, and
that no token appears anywhere.

**Acceptance Scenarios**:

1. **Given** a run from the desktop client, **When** it ends, **Then** each of its log lines names the
   desktop client beside the person, the run, the session and, for a payment, its authorization.
2. **Given** any run, **When** the log is scanned for the run's tokens, **Then** none is found.

---

### User Story 7 - A client finds the sign-in settings at the agent (Priority: P3)

A client asks the agent, without a token, where and how to sign in: the tenant, its two addresses, the
audience, the desktop client's identifier, the scopes and the return address. It stops hardcoding the
tenant's values. The API description lists the scopes the sign-in uses.

**Why this priority**: Optional in spec-19. Every value is public, and a client works without it.

**Independent Test**: Read the settings from the agent and run the sign-in with exactly those values; change
the tenant's settings at the agent and check that the answer follows.

**Acceptance Scenarios**:

1. **Given** an agent configured with the desktop client, **When** a client reads its sign-in settings,
   **Then** it receives the issuer, the authorization and token addresses, the audience, the client
   identifier, the scopes `openid`, `offline_access` and `agent:run`, and the return address, and nothing
   else.
2. **Given** an agent without the desktop client configured, **When** a client asks, **Then** the settings do
   not exist there.
3. **Given** the API description, **When** it is read, **Then** its sign-in scheme lists the three scopes,
   and the docs page's own sign-in still works without selecting them.

### Edge Cases

- **Another program on the computer takes the port first, or captures the code.** The code is useless without
  the verifier, which only the client holds. A client that cannot listen on the port fails with a clear error
  (the client's concern; out of scope here).
- **The returned `state` does not match.** The client rejects the return (the sign-in contract's step 3; out
  of scope here).
- **Two processes of the client renew at the same time with the same refresh token.** With no reuse interval
  the second use counts as reuse and ends the sign-in: the client renews from one place at a time.
- **The tenant asks the person to consent to the desktop client.** A tenant may not skip consent for a return
  address on the loopback interface, even for a first-party client. The person then accepts once, on the
  first sign-in, and the acceptance test records whether that happened.
- **A person holds both roles.** Their desktop token also carries `portal:admin`. Nothing changes: the portal
  refuses the desktop client's tokens, and the agent and L2 never read that permission.
- **The access token expires during a run.** As today: L2 refuses the next payment, the answer says the
  sign-in expired, payments already made stand. The client renews and resends the goal in the same session.
- **The agent and L2 disagree on the list of clients.** If L2 does not list the desktop client, the account
  question before the run is refused, so the run is refused before it starts and nothing is paid.
- **An Auth0 custom domain is turned on.** The tenant's addresses and the issuer change together; tokens from
  the old issuer are refused until `AUTH_ISSUER` follows, at the agent and at L2.
- **The person is blocked at the tenant.** Neither sign-in nor renewal succeeds.
- **A token from the desktop client that did not ask for `agent:run`.** It is accepted when the person holds
  the permission: the permission the tenant granted decides, not the scope the client asked for.
- **Rollback.** Taking the desktop client off the agent's and L2's lists refuses its tokens at once. Turning
  the client off at the tenant stops new tokens and renewals at once, while access tokens already issued keep
  passing until they expire, an hour at most. Revoking the refresh tokens at the tenant ends the sign-ins.
- **Local development.** The development issuer can mint tokens that look like the desktop client's, for the
  agent's and L2's checks. The browser sign-in itself exists only at the real tenant.
- **A client keeps resending an expired token.** Each refusal counts toward the agent's limit on failed
  authentications per address (the DAST remediation), as every 401 of the agent does, the account question's
  `token_expired` included (FR-018). A client renews on `token_expired` instead of retrying.
- **A client is misconfigured (wrong audience or tenant).** The agent answers `invalid_token`, as for any other
  invalid token. The client finds the cause by comparing its own token's audience and issuer with the agent's
  sign-in settings (User Story 7), not from the refusal.

## Requirements *(mandatory)*

### Functional Requirements

**The desktop client at the tenant**

- **FR-001**: The tenant MUST gain one new application, the desktop client: native, public (no secret and no
  key), first-party, OIDC conformant, with the grants authorization code and refresh token only. It MUST NOT
  allow the implicit or client-credentials grants. *(SPEC: §3.3, T-IAC-02)*
- **FR-002**: Its allowed return addresses MUST be exactly `http://127.0.0.1:53682/callback` and
  `http://localhost:53682/callback`, matched exactly, in every environment of the tenant, whatever the setting
  for local development addresses. They name the person's own computer, not a served page. It MUST have no web
  origins, no cross-origin origins and no logout addresses. *(SPEC: §3.3, T-IAC-02)*
- **FR-003**: Its refresh tokens MUST rotate with no reuse interval. Reusing a spent one MUST revoke its
  family. They MUST expire after 7 days unused and 30 days after the sign-in at most. *(SPEC: §3.3, new SEC
  entry)*
- **FR-004**: It MUST ask for people's API (`AUTH_AUDIENCE`), and the services MUST accept its tokens for that
  API only. That API keeps its current settings: RS256, permissions enforced and written in the token, offline
  access allowed, a one-hour token, consent skipped for first-party clients where the tenant allows it. The
  tenant's configuration MUST set no default audience. The tenant does not limit which of its APIs a client may
  ask for, for this client as for every other: a token the desktop client obtains for the approval API (five
  minutes, no refresh token) MUST be refused by the agent and L2 with 401 `invalid_token`, and no route of this
  system accepts it from a caller. *(SPEC: §3.3, L1-6)*
- **FR-005**: The tenant's applications MUST be exactly L2's approval client, the portal's client, the agent's
  docs page client, the desktop client and one client per declared machine caller. The check on the tenant's
  configuration MUST fail on any other. The tenant keeps exactly two permissions and two roles: the desktop
  client uses `agent:run` and `x402-agent`. *(SPEC: T-IAC-02, Constitution: Technology & Scope)*
- **FR-006**: A post-login rule MUST refuse, with the error `not_authorized_for_agent`, a sign-in through the
  desktop client by a person without the role `x402-agent`, and MUST refuse a renewal through it the same way,
  so a removed role stops renewals. It MUST leave every other client untouched, assign no role, add no claim,
  hold no secret and call no other service. It recognizes the desktop client by a public marker that the tenant's
  configuration puts in that client's metadata (`x402_client = "agent-desktop"`), so it needs no client
  identifier, no setting and no secret. *(SPEC: §3.3, L1-6, T-IAC-02)*
- **FR-007**: An interactive sign-in through the desktop client MUST end with a fresh second factor (push or a
  one-time code), by the rule administrators' sign-ins follow today: the tenant asks for one unless the person's
  session at the tenant already holds a second factor no older than its other authentications (the password or
  Google sign-in). A renewal MUST NOT ask for one. A person MUST be enrolled in a second factor before receiving
  the agent role. *(SPEC: §3.3, new SEC entry)*
- **FR-008**: The tenant MUST issue no token for an authorization through the desktop client without a code
  challenge, with a method other than S256, or exchanged without the matching verifier. Where the tenant's own
  behavior does not refuse such an authorization, the post-login rule MUST. The tenant's acceptance of the
  `plain` method, recorded as a residual by the DAST remediation, MUST NOT apply to the desktop client.
  *(SPEC: §3.3, new SEC entry)*
- **FR-009**: The desktop client MUST be allowed on exactly the people's connections the agent's docs page
  client is allowed on (email and password, and Google), and on no other. The tenant sign-up hardening's rule
  that only the portal's and the agent's applications may sign a person in MUST admit the desktop client too,
  and its offline check MUST fail on the desktop client allowed on any other connection. *(SPEC: §3.3,
  T-IAC-02, SEC-26)*
- **FR-010**: The feature MUST introduce no new secret anywhere: not at the tenant, the agent, L2, a parameter
  file or GitHub. *(SPEC: Constitution V)*

**The agent and L2 accept the desktop client**

- **FR-011**: The agent and L2 MUST accept a person's token from the desktop client in every environment whose
  tenant has it: its identifier joins the docs page client's on both services' lists of clients, in the
  list's existing format. The portal's client MUST stay off both lists, and both MUST keep refusing to start
  with it there. *(SPEC: L1-6, L2-5, SEC-20, CFG-2)*
- **FR-012**: The checks on a person's token MUST stay those of today, for every client: signature, issuer,
  audience, validity with a 60-second tolerance and a usable subject (else 401); not a machine token, the
  permission `agent:run` among the permissions the tenant granted, and a client, read from `azp` and
  `client_id`, that is on the list (else 403). No roles claim is read or required. *(SPEC: L1-6, SEC-14;
  Clarifications)*
- **FR-013**: The machine callers' path and the docs page's sign-in MUST stay unchanged. *(SPEC: L1-6)*
- **FR-014**: The run limits MUST count per person, whatever client and token they use: signing in again or
  renewing MUST NOT reset a count. A test MUST prove it. *(SPEC: L1-6 limits)*

**The account question before the run**

- **FR-015**: Before the model is called for a person's run, the agent MUST ask L2, with the person's
  forwarded token and never with a user named in the request, whether that person can pay now. This comes after
  the existing checks (token, limits, body, session) and before the run starts. *(SPEC: L1-6, L2-5, L2-8)*
- **FR-016**: L2 MUST answer from its ledger, for the person in the token it verified, with one of: ready, not
  onboarded, disabled, or person accounts off. Ready means set up at the portal and not turned off there: a
  person whose policies are all paused or removed is ready, and each purchase is then denied by policy, as today.
  The answer MUST carry no personal data of the account. *(SPEC: L2-5, L2-8, hard rule 11)*
- **FR-017**: When the answer is not "ready", the agent MUST refuse the run with 409 and a code per reason
  (`account_not_onboarded`, `account_disabled`, `accounts_off`). No model call and no payment request is made,
  no session is created, and the refusal does not count as a run start. *(SPEC: L1-6)*
- **FR-018**: When L2 cannot be reached within the bound (NFR-005), refuses the question for any reason other
  than person accounts being off (FR-017) or the token having expired (below), or answers unexpectedly, the agent
  MUST refuse the run with 503 and the code `control_unavailable`, and start nothing. When L2 answers that the
  forwarded token expired, which can happen when it passed the agent's own check moments before, the agent MUST
  answer as for an expired token: 401 with the code `token_expired` and the challenge (FR-020, FR-021), and start
  nothing. That 401 counts toward the limit on failed authentications per address, as every 401 of the agent
  does. *(SPEC: L1-6, SEC-14)*
- **FR-019**: A machine caller's run MUST skip the question. *(SPEC: L1-6, L2-8)*

**Refusals a client can read**

- **FR-020**: Every 401 of the agent MUST keep the bearer challenge the DAST remediation adds: the agent's
  realm, naming an invalid token when a token was presented, and no error when none was. This feature adds no
  second challenge. *(SPEC: L1-6; specs/017-dast-findings-remediation FR-024)*
- **FR-021**: Every 401 of the agent MUST carry an `error_code` beside the unchanged `error`: `missing_token`
  when no token was presented, `token_expired` when the token's validity period is its only fault, and
  `invalid_token` for every other failure. *(SPEC: L1-6; Clarifications)*
- **FR-022**: A 401 MUST NOT tell apart any failure beyond those three: a wrong audience, a wrong issuer, a bad
  signature, an unusable subject and a malformed token MUST give the same answer, with no description, no claim
  value, no key and no token. This narrows the DAST remediation's "nothing that says which check failed" by the
  expiry only, and the SPEC amendment (FR-027) MUST record it as that exception. The 403 answers stay as they
  are. *(SPEC: SEC-14, SEC-16; specs/017-dast-findings-remediation FR-024)*

**Traceability**

- **FR-023**: Each run and step line of the run log MUST name the client the caller's token was issued to,
  beside the requester, the run, the session and the authorization it already names. It MUST NOT contain an
  authorization header, an access token, a refresh token or a code; NFR-003 says how that is checked.
  *(SPEC: L1-6 logs, SEC-16)*

**The sign-in settings (optional)**

- **FR-024**: Where the agent is configured with the desktop client, it MUST serve its sign-in settings
  without a token: the issuer, the authorization and token addresses, the audience, the desktop client's
  identifier, the scopes `openid`, `offline_access` and `agent:run`, and the return address, all from the
  service's own settings. Where it is not configured, the settings MUST not exist. The agent MUST refuse to
  start when the desktop client it advertises is not on its list of clients. *(SPEC: L1-6, CFG-2)*
- **FR-025**: The settings route MUST sit behind the agent's per-address limit (unlike the health and docs
  routes, which come before it) and MUST reach no model, session, L2 or L3. *(SPEC: L1-6, SEC-13)*
- **FR-026**: The agent's API description MUST list the three scopes under its sign-in scheme. *(SPEC: L1-6
  API docs)*

**Documents**

- **FR-027**: `SPEC.md` and the constitution MUST be amended together, before any code of this feature, to
  record: the desktop client as a fourth fixed application of the tenant, with refresh tokens; the post-login
  refusal and the second factor; the desktop client on people's connections; the account question before a
  run; the readable 401, as the one exception to the DAST remediation's rule on what a 401 says; the client in
  the run log; the sign-in settings route. The amendment MUST come after those of the DAST remediation and the
  tenant sign-up hardening, as the next version after theirs, and MUST NOT undo either.
  *(SPEC: §1.3, §3.3, Constitution governance)*
- **FR-028**: Every route, status, header or field this feature changes MUST be changed in the service, the
  SPEC table it belongs to (L1-6, L2-5) and its OpenAPI document together. *(SPEC: L1-6, L2-5, T-API)*

### Non-Functional Requirements

- **NFR-001 (Fail closed)**: Every failure fails closed: the tenant's keys unreachable, a token that fails any
  check, L2 unable to answer the account question. No run starts and nothing is paid. *(SPEC: SEC-14)*
- **NFR-002 (Least privilege)**: The desktop client can do nothing but sign a person in and renew that sign-in.
  It cannot obtain a machine token, its tokens open nothing at the portal, and a token it obtains for any API but
  people's opens nothing anywhere (FR-004). *(SPEC: INV-13, SEC-20)*
- **NFR-003 (Secrets and personal data)**: This is the one statement of what the token scans cover (FR-023 and
  SC-009 refer to it). A known-value scan MUST find none of a run's access tokens in the run
  log, the JSON answer or the stream events, nor in the ledger after an end-to-end run. Refresh tokens and codes
  never reach a service of this system, since the desktop client sends the agent its access token only; the live
  check MUST find no token-shaped value in the logs the agent and L2 wrote during it. No name or email reaches L2
  or the ledger: the account answer carries none. *(SPEC: SEC-16, hard rule 11)*
- **NFR-004 (Every check is proven)**: Each new check MUST have a test that fails without it. In the services
  (the account question, the readable 401's three codes and its silence on the rest, the run limits counted per
  person across clients, L2's accounts-off code) the check is switched off by a test-only dependency, never by an
  environment variable. The tenant's configuration (the desktop client, its connections, the services' lists in
  its outputs) and the templates (the services' lists) are proven by source mutants in their configuration
  tests. A start-up refusal (an advertised desktop client not on the list) is proven by the test that expects
  it. The post-login rule's code MUST be run by the tenant configuration's test for a person with and without
  the role, through the desktop client, the docs page's client and the portal's client, on sign-in and on
  renewal. *(SPEC: Definition of done, T-IAC-02)*
- **NFR-005 (Responsiveness)**: The account question MUST add at most 1 second to the start of a person's run.
- **NFR-006 (No regression)**: The local scripted demo MUST give the same summary as before
  (`spent on-chain: 0.006 USDC`, `hash chain ok=true`), and a JSON answer MUST keep its fields.

### Key Entities

- **Desktop client**: The tenant's public native application through which a person signs in from their own
  computer, with a fixed loopback return address and no secret.
- **Sign-in contract**: The six steps a desktop client follows: proof key and state, the browser at the
  tenant, the return to the loopback address, the code exchange, calling the agent, renewal.
- **Refresh token family**: The chain of refresh tokens one sign-in produces through rotation; reusing any spent
  member ends the whole chain.
- **Post-login refusal**: The tenant's rule that ends a sign-in or renewal through the desktop client for a
  person without the agent role.
- **Account readiness**: L2's answer about the person in a verified token: ready, not onboarded, disabled, or
  person accounts off.
- **Refusal code**: The machine-readable reason on a 401 (and on a 409 or 503 before a run).
- **Sign-in settings**: The public values a client needs to sign in, as the agent serves them.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person with the role and an account goes from starting the desktop sign-in to a completed
  purchase run in under 2 minutes, second factor included, without copying a token.
- **SC-002**: A person who uses the client at least once a week signs in through the browser at most once
  every 30 days.
- **SC-003**: 0 tokens are issued through the desktop client to a person without the role, for an
  authorization without a code challenge, or for a code exchanged without its verifier, across the acceptance
  set.
- **SC-004**: In 100% of attempts, reusing a spent refresh token ends the sign-in: the next renewal with the
  latest refresh token fails.
- **SC-005**: A person whose account is not ready learns why within 2 seconds of sending a goal, with 0 model
  calls and 0 payment requests made for that goal.
- **SC-006**: In 100% of the acceptance cases a client chooses between sending a token, renewing and signing in
  again from the 401 alone, and the wrong-audience, wrong-issuer, bad-signature and malformed cases give
  identical answers.
- **SC-007**: Taking the desktop client off the agent's and L2's lists stops its tokens at once. Turning it off
  at the tenant stops new tokens at once and existing access tokens within 1 hour.
- **SC-008**: Signing in again or renewing gives a person 0 extra runs: the third concurrent run and the 21st
  start in an hour are refused however many sign-ins they hold.
- **SC-009**: Every scan NFR-003 names finds 0 tokens.
- **SC-010**: The local scripted demo's summary is unchanged, and the machine caller's smoke run and the docs
  page's sign-in pass unchanged.

## Assumptions

- The desktop client (the plugin) is built separately and follows the sign-in contract: a random verifier, its
  S256 challenge and a random state; the browser at the tenant with the desktop client, the fixed loopback
  return address, the scopes `openid offline_access agent:run` and the audience of people's API; a state check
  on return; the code exchange without a secret; the agent called with the access token; renewal near expiry,
  and a new sign-in when renewal fails. It keeps the refresh token in the operating system's keychain, renews
  from one place at a time, and fails clearly when the port is taken. None of this is delivered here.
- spec-19's audience value names the application, not the API. The desktop client signs in for people's API,
  whose identifier is `AUTH_AUDIENCE` and can't change, so the portal, the agent and L2 keep one audience.
- spec-19's role `agent-runner` is the existing role `x402-agent`, which holds exactly `agent:run`. The tenant
  keeps two roles.
- The tenant's addresses are its own domain's, as `AUTH_ISSUER` names it; with a custom domain they move
  together.
- The DAST findings remediation (`specs/017-dast-findings-remediation`) and the tenant sign-up hardening
  (branch `claude/pentest-report-fixes-0709b1`) land before this feature's code: this branch is planned against
  them and rebased onto them once they are merged. Both change what
  this feature changes: the agent's 401, the limit on failed authentications, the tenant's declaration, the
  tenant configuration's check and `SPEC.md`'s version. Their decisions hold except where this spec says
  otherwise (FR-009, FR-021, FR-022).
- The tenant's configuration is applied from the operator's host (SPEC 1.26). The desktop client's identifier
  reaches the agent's and L2's settings in each environment the way the docs page client's does today; the plan
  decides the details.
- Payer accounts and spending caps stay with L2 and the portal, as today. The account question reads them and
  changes nothing.
- The feature is proven against the development issuer, the in-memory test issuer and the tenant
  configuration's test. spec-19's acceptance tests against the real tenant (the full sign-in, renewal and
  reuse, the refusal without the role, the authorization without a code challenge, the code exchanged with
  another verifier, the consent screen, a scan of the services' logs) are run
  once by hand with a script, before any client code exists, and recorded when done.
- The rollout follows spec-19: the tenant's settings first, then the services' lists, then one person's live
  check with the port open, then the remaining people (an account and a cap at the portal, a second factor,
  then the role).
