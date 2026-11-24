# Feature Specification: Sign-Up Hardening for the Sign-In Tenant (pentest finding P1)

**Feature Branch**: `claude/pentest-report-fixes-0709b1`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "implement the fixes for the findings in the PENTEST report". The report is the
penetration test addendum for `https://dev.fabriciorojas.com/` dated 2026-11-24 (UTC). Its one new finding, P1, is
about the sign-in tenant (Auth0) the portal depends on. The tester found that the portal's login page offers
"Sign up" and "Continue with Google". Its update adds three facts. Email-and-password sign-up is refused ("Sign-ups
are closed"). The page still advertises it. A first-time Google sign-in was not tested, and the tenant's
pre-registration rule does not cover it. The report also asks the owner to check that Google sign-in uses the
project's own Google credentials, not the identity provider's shared developer keys. It asks for one normal and one
administrator test account, so the signed-in API can be tested. The manual attacks it tried (token forgery, route
exemptions, hidden endpoints, redirects, proxy headers, client-side sinks) found nothing. They are out of this
feature, apart from not regressing.

## Clarifications

### Session 2026-11-24

- Q: Who should be able to get a portal account? The tester was told public sign-up is intended, but the tenant
  refuses every email-and-password sign-up while its page still shows "Sign up". → A: Anyone with a Google
  account. A first Google sign-in creates the account, and that is the intended public way in. Email-and-password
  sign-up stays closed. Rejected: invite-only for everyone; public email-and-password sign-up.
- Q: What should happen to "Continue with Google", given that the tenant's pre-registration rule never runs for
  it? → A: Keep Google. Following the report, it must run on the project's own Google application, not on the
  identity provider's shared developer keys. Rejected: removing Google.
- Q: Should the API also require an explicit role or record, as the report recommends? → A: Not for the portal.
  Creating a profile (and with it a wallet, policies and card setup) needs no role, so decision R21 (SPEC v1.14)
  stands. Starting agent runs needs the role `x402-agent` (`agent:run`), as today, and the administration area
  needs `x402-admin`, as today. Rejected: a role or an admitted list for using the portal.

## Where sign-up stands today

| Topic | Today (dev tenant, SPEC v1.26) | In this feature |
|---|---|---|
| The login page | Shows "Sign up" (email and password) and "Continue with Google" | Shows "Continue with Google" and sign-in for existing email-and-password accounts. No sign-up offer while email-and-password sign-up is closed |
| Email-and-password sign-up | Offered by the page, then refused with "Sign-ups are closed" | Not offered, and still refused at every self-service entry point |
| A first Google sign-in | Creates an account. Not covered by the sign-up switch. Recorded as a residual risk (v1.19). Not verified | Creates an account by design: the public way in. Verified by a live check |
| Google's credentials | Possibly the identity provider's shared developer keys (the tenant is on the free plan) | The project's own Google application. Its secret is nowhere but in the tenant |
| Which applications may use which connection | Set by hand in the tenant's dashboard, outside the checked configuration | Declared with the rest of the tenant and checked offline. A change made by hand shows in the next plan |
| Adding a test account | Needs sign-up reopened, because the pre-registration rule also refuses accounts the operator creates | The operator adds a named person while self-service sign-up stays closed |
| What a brand-new person reaches | Their own profile, wallet, policies and card setup. The agent and the administration area each need a role | Unchanged. Tests now cover a person whose account a first Google sign-in has just made |
| SPEC SEC-26 and its residual risk | "Sign-ups can be turned off". "A social first sign-in is not covered" | Rewritten: Google sign-up is public by design. They state what a stranger can and can't reach, and how to stop new accounts in an emergency |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A visitor sees only the ways in that work (Priority: P1)

A visitor opens the portal's sign-in page, or the agent's docs page sign-in. Email-and-password sign-up is closed
in this environment, so the page offers no way to create an email-and-password account. It offers "Continue with
Google" and sign-in for people who already have an email-and-password account. Someone who goes straight to the
sign-up address, or calls the public sign-up endpoint, is refused as before. No account is made.

**Why this priority**: This is the inconsistency the report names. The page advertises a door the tenant then
shuts. That confuses real people and tells attackers where to push. One setting must decide both what the page
offers and what the tenant accepts.

**Independent Test**: With email-and-password sign-up closed, run the report's two read-only reproduction steps:
the public client settings and the hosted login page. Then try the direct sign-up address and the public sign-up
endpoint with a throwaway address. Expected: no sign-up offer, two refusals, no new account.

**Acceptance Scenarios**:

1. **Given** email-and-password sign-up is closed, **When** a visitor opens the portal's sign-in page, **Then** no
   link, tab or prompt to create an email-and-password account is shown, and "Continue with Google" is.
2. **Given** it is closed, **When** someone opens the sign-up address directly, or posts to the public sign-up
   endpoint, **Then** the sign-in service refuses them with its sign-up-disabled answer, and no account is
   created.
3. **Given** a person who already has an email-and-password account, **When** they sign in, **Then** they get in
   as before, and the page still offers them "Forgot password".
4. **Given** an environment whose switch opens email-and-password sign-up, **When** a visitor opens the page,
   **Then** the sign-up offer is shown and sign-up works. Closing the switch again hides the offer and refuses
   sign-up, in one change, with no second step by hand.
5. **Given** the agent's docs page sign-in (where an environment turns it on), **When** a visitor opens it,
   **Then** it follows the same rules as the portal's.

---

### User Story 2 - A new person signs up with Google and sets up their profile without a role (Priority: P1)

A person who has never used the portal chooses "Continue with Google". Their first sign-in creates their account
in the tenant. The portal then lets them create their profile, which gives them their own wallet, their expense
policies and card setup. Nobody needs to approve them. They hold no role. They can't start agent runs until an
administrator assigns them the agent role. They can't enter the administration area. They reach nobody else's
data and never the platform account.

**Why this priority**: This is the public way in that the owner intends. The report could not test it and warned
about it: if a first Google sign-in gets a token, the whole signed-in API is open to anyone. That is acceptable
only if a brand-new, role-less person reaches exactly their own account and nothing more. That must be shown, not
assumed.

**Independent Test**: In the test suites, use a person whose subject has the Google shape (`google-oauth2|…`) and
no permission. Show that they can create a profile, a wallet and a policy. Show that the agent refuses their run,
the administration area refuses them, and another person's policy answers as an unknown one. Then, once by hand
against the deployed tenant, sign in with a Google account that has never been used there, and repeat the first
two checks.

**Acceptance Scenarios**:

1. **Given** a Google account the tenant has never seen, **When** its owner chooses "Continue with Google" on the
   portal, **Then** the tenant creates their account, the portal signs them in, and they can create their profile,
   wallet and policies and start card setup, with no administrator involved.
2. **Given** that new person, **When** they start a run at the hosted agent, **Then** it is refused with 403, and
   nothing is authorized at L2. Once an administrator assigns them the agent role and they sign in again, a run
   works for their own account.
3. **Given** that new person, **When** they open the administration area, **Then** they are refused.
4. **Given** that new person and another person, **When** the new person asks for the other's profile, wallet,
   policies or cards, **Then** they get the same answer as for something that doesn't exist, and they are never
   paid for by the platform account.
5. **Given** the agent's docs page sign-in, **When** a first-time Google person signs in there, **Then** their
   account is created, but their run is refused, as in scenario 2.

---

### User Story 3 - Google sign-in runs on the project's own Google application (Priority: P2)

When a person chooses "Continue with Google", the sign-in goes through the project's own Google application, not
the identity provider's shared developer application. That application's secret lives only in the tenant. It is
never in the repository, the operator's variables file, a plan, the tenant's state, GitHub or a log. People who
already sign in with Google keep the same account after the switch: the same portal user, wallet and history.

**Why this priority**: The report makes this a condition of keeping Google. Shared developer keys are meant for
trying a connection out. With Google as the public way in, sign-in must run on credentials the project controls.
It ranks below the first two stories because those decide who gets in and what they reach.

**Independent Test**: Start a Google sign-in against the deployed tenant without completing it. Read where it
sends the browser: Google, with the project's own application and the tenant's own return address. Read the
connection's settings and check they name the project's own Google application. Scan the repository, the
variables file, the saved plan and the state for the secret. Sign in as an existing Google person, and compare
their portal user and wallet address with those from before the switch.

**Acceptance Scenarios**:

1. **Given** the deployed tenant, **When** a person chooses "Continue with Google", **Then** Google is asked on
   behalf of the project's own application, with the tenant's own return address. It is never the identity
   provider's shared developer application. The consent screen shows the project's application or its domain,
   never the identity provider's.
2. **Given** the switch to the project's own application, **When** a person who signed in with Google before signs
   in again, **Then** they reach the same portal user, with the same wallet address and history.
3. **Given** the project's own application is missing or misconfigured, **When** a person chooses "Continue with
   Google", **Then** sign-in fails, and no account and no token are created.
4. **Given** the change is planned and applied, **When** the repository, the variables file, the saved plan and the
   state are scanned, **Then** the Google secret appears in none of them.

---

### User Story 4 - The tenant's sign-in connections can't drift unnoticed (Priority: P2)

The ways people sign in (email and password, Google), and the applications allowed to use each, are declared with
the rest of the tenant and checked offline, as its applications, roles and rules already are. Only the portal's
and the agent's applications can sign a person in. An offline check fails if the declaration changes in a
forbidden way. A change someone makes by hand in the tenant's dashboard shows up the next time the operator plans
the tenant.

**Why this priority**: The finding came from configuration that lives outside the checked declaration. Today,
which connections the portal's application may use, and whether the database connection offers sign-up, are set
by hand, so nothing catches a mistake. This story keeps the fixes of Stories 1 and 3 in place.

**Independent Test**: Run the offline check against the declaration and against one must-fail change per rule.
Then change a connection's applications by hand in a test tenant, or on dev with the operator's agreement, and
run the plan. Expected: it reports the difference.

**Acceptance Scenarios**:

1. **Given** the declaration, **When** the offline check runs, **Then** it passes only with two people's
   connections: email and password, and Google. Each is enabled for the portal's and the agent's applications
   only. Email-and-password sign-up follows the environment's switch. Google uses the project's own application
   without a secret written in the declaration.
2. **Given** a third connection, one enabled for L2's approval client or a machine caller, an email-and-password
   connection whose sign-up ignores the switch, or a credential written into a connection, **When** the offline
   check runs, **Then** it fails and names the rule.
3. **Given** someone enables a connection for another application by hand in the tenant, **When** the operator
   next plans the tenant, **Then** the plan shows the difference, and applying it restores the declaration.

---

### User Story 5 - The operator adds named test accounts without opening sign-up (Priority: P3)

The report could not test the signed-in API because it had no account. The operator can create named
email-and-password accounts, such as one normal test person and one test administrator, while self-service sign-up
stays closed the whole time. The test administrator gets the administrator role by hand, after enrolling a second
factor, as every administrator does. The operator can delete both accounts after the test.

**Why this priority**: This unblocks the report's next step, testing the signed-in surface, without reopening the
door this feature closes. It is not itself a fix, so it comes last. A tester with a Google account could also use
Story 2's path.

**Independent Test**: With sign-up closed, the operator creates a named account. Meanwhile, a throwaway address
tries the public sign-up endpoint and is refused. The named account then signs in.

**Acceptance Scenarios**:

1. **Given** email-and-password sign-up is closed, **When** the operator creates a named account, **Then** the
   account exists, and any self-service sign-up attempt before, during and after is refused.
2. **Given** the test administrator has enrolled a second factor and holds the administrator role, **When** they
   sign in, **Then** they reach the administration area, and the normal test person doesn't.
3. **Given** the test is over, **When** the operator deletes both accounts, **Then** neither can sign in again, and
   nothing in L2's ledger is rewritten (their recorded entries stay, as for any user).

---

### User Story 6 - The documents say what is public and what isn't (Priority: P3)

The SPEC's threat row SEC-26, its residual risks, the operating guide and the tenant's README match the decision.
Google sign-up is public by design. Email-and-password sign-up is closed by one switch. They say what a stranger
who signs up reaches and what they don't. They say how to keep one person out (block them in the tenant). They say
how to stop all new Google accounts in an emergency, and what that costs people who already sign in with Google.
The SPEC's change log records finding P1 and how this feature resolves each of its parts.

**Why this priority**: The documents said "to keep strangers out, turn sign-ups off", which no longer matches the
owner's intent. Wrong guidance there would send the next operator the wrong way. It changes no behavior, so it
comes last.

**Independent Test**: Read SEC-26, the residual risks, the operating guide's sign-up notes and the tenant README's
"People" section. Each must state the six points above, and none may still say a social first sign-in is an
uncovered gap.

**Acceptance Scenarios**:

1. **Given** the updated documents, **When** an operator looks up how to keep strangers out, **Then** they learn
   that Google sign-up is public by design, how to block one person, and the emergency stop with its cost.
2. **Given** the SPEC's change log, **When** a reviewer looks for finding P1, **Then** they find each of its parts:
   the page offer is fixed, email-and-password sign-up stays closed, Google sign-up is accepted by design, the
   Google credentials are the project's own, drift is checked, and test accounts are possible.

---

### Edge Cases

- **The same email address, signed up both ways.** A person who has an email-and-password account and later uses
  Google with the same address gets a second, separate account, with its own wallet. Nothing links or merges the
  two by email address, because linking by address would let whoever controls one sign-in take over the other.
- **A wave of new Google accounts.** Each one reaches only its own data and can't run the agent. Each costs ledger
  entries only once it creates a profile. The existing per-address and per-user limits apply. The operator can
  block accounts one by one. The emergency stop (Story 6) turns Google off for the applications, which also stops
  existing Google people from signing in until it is turned back on.
- **A blocked person tries Google again.** They stay refused, and the portal shows its "The sign-in service refused
  this account" message.
- **An old bookmark or a hand-made link to the sign-up screen.** It is refused, as in Story 1, scenario 2.
- **A first Google sign-in through the agent's docs page.** It makes a tenant account that can then use the portal.
  This is expected: it is the same public way in.
- **The project's own Google application is set up after the connection switches to it.** Google sign-in fails
  closed (Story 3, scenario 3) for that time. Existing email-and-password people are unaffected.
- **The administrator role is taken away.** This takes effect when the person's access token expires (an hour at
  most), as today.
- **L2's approval client and the backchannel request.** If asking a person's phone requires their connection to be
  enabled for L2's approval client, that client keeps the connection, but it still can't sign anyone in
  interactively, because its grant types don't allow it (see Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

**The page and email-and-password sign-up**

- **FR-001**: While an environment's email-and-password sign-up is closed, the sign-in page of every application
  that signs people in MUST NOT offer to create an email-and-password account: no link, no tab, no prompt.
- **FR-002**: One setting per environment MUST decide whether email-and-password sign-up is open. It governs both
  what the page offers and what the tenant accepts at every self-service entry point: the page, the direct sign-up
  address and the public sign-up endpoint. Opening or closing it takes one change and no second step by hand.
- **FR-003**: While it is closed, every self-service email-and-password registration MUST be refused with the sign-in
  service's own sign-up-disabled answer, and create no account, whatever the entry point. At no point during the
  rollout may self-service sign-up be open.
- **FR-004**: While it is closed, the operator MUST be able to create a named email-and-password account (for
  example a test account) without opening self-service sign-up to anyone else, even briefly.
- **FR-005**: Existing email-and-password people MUST keep signing in, and keep "Forgot password".

**Google sign-up, public by design**

- **FR-006**: "Continue with Google" MUST stay available on the portal's and the agent's applications. A first
  Google sign-in MUST create the person's account, in every environment where Google is on. It is the intended
  public way in.
- **FR-007**: Google sign-in MUST use the project's own Google application, never the identity provider's shared
  developer credentials. The live check (FR-019) MUST show which application is used.
- **FR-008**: The Google application's secret MUST NOT appear in the repository, the operator's variables file, a
  saved plan, the tenant's state, GitHub, a log or a command's output. It is held only by the tenant.
- **FR-009**: Moving Google sign-in to the project's own application MUST keep each existing Google person's
  account: the same subject, and so the same portal user, wallet and history.
- **FR-010**: If the project's own Google application is missing or refuses the request, Google sign-in MUST fail
  with no account and no token created.

**What a new person reaches**

- **FR-011**: A person's first sign-in, by Google or otherwise, MUST give them no role and no permission. Nothing in
  the tenant's declaration or its rules may assign one (as today).
- **FR-012**: A person without a role MUST be able to create and use their own profile, wallet, policies and card
  setup in the portal. Decision R21 stands.
- **FR-013**: The hosted agent and L2 MUST refuse a run, with no authorization recorded, from a person without
  `agent:run`. This includes a person whose account a first Google sign-in made a moment earlier.
- **FR-014**: The administration area MUST refuse a person without `portal:admin`.
- **FR-015**: A person whose account came from Google MUST reach only their own profile, wallet, policies and
  cards, and MUST never be paid for by the platform account (SEC-19, and no fallback to the platform account).
  The test suites MUST cover FR-012 to FR-015 with a person whose subject has the Google shape.
- **FR-016**: Accounts MUST NOT be linked or merged by email address. An email-and-password account and a Google
  account with the same address stay two people.

**The tenant's connections, declared and checked**

- **FR-017**: People's connections (email and password, and Google), and the applications allowed to use each,
  MUST be declared with the rest of the tenant. Only the portal's and the agent's applications may sign a person
  in. An offline check MUST fail on any of these: a third people's connection; a connection enabled for L2's
  approval client or a machine caller beyond what the backchannel approval needs; email-and-password sign-up that
  doesn't follow the switch; a credential or secret written into a connection. Each rule MUST have a must-fail
  case.
- **FR-018**: A change made by hand to those connections in the tenant MUST show up the next time the operator
  plans the tenant:
  - their applications, or whether sign-up is offered, show as a difference that applying the plan restores;
  - which Google application is used makes the plan fail until the tenant again holds the project's own
    application.

  The declaration never writes Google's settings or secret.

**Verification and documents**

- **FR-019**: A live check, run by hand against the deployed tenant and written down with the feature's other
  hand-run checks, MUST cover:
  - the page shows no sign-up offer;
  - the direct address and the endpoint refuse sign-up;
  - a never-seen Google account signs up and creates a profile;
  - that person's run is refused until the role is assigned;
  - a Google sign-in goes to Google for the project's own application;
  - an existing Google person keeps their account;
  - a test account can be created while sign-up stays closed.
- **FR-020**: The SPEC (SEC-26, its residual risks and its change log), the operating guide and the tenant's README
  MUST say:
  - Google sign-up is public by design;
  - email-and-password sign-up is closed by the one switch, and the switch's description says it covers email and
    password only;
  - what a stranger reaches;
  - how to block one person;
  - the emergency stop for new Google accounts, and its cost.

  The v1.19 residual risk "a social connection's first sign-in doesn't run the pre-user-registration trigger" MUST
  be replaced by this decision. The change log MUST name finding P1 and how each part of it is resolved.

### Non-Functional Requirements

- **NFR-001**: The project MUST hold no new secret. The Google application's secret goes only into the tenant, by
  hand, as other tenant-held settings do.
- **NFR-002**: No lock-out. Every person who can sign in before the change, the owner included, MUST be able to sign
  in after it, with the same account, at every step of the rollout.
- **NFR-003**: Every new check MUST have a must-fail case that shows it fails without the fix (the project's
  definition of done).
- **NFR-004**: The report's negative results MUST stay true:
  - a foreign callback address is refused;
  - the implicit flow is refused;
  - the auth-exempt routes match only themselves;
  - nothing new is served outside `/api` on the portal's host.

### Key Entities

- **People's connection**: a way a person signs in to the tenant: email and password, or Google. It has the
  applications allowed to use it. For email and password, it has whether self-service sign-up is open. For Google,
  it has whose Google application it runs on.
- **Email-and-password sign-up switch**: one setting per environment. It opens or closes self-service sign-up and
  the page's offer of it together.
- **Tenant account (person)**: made by a first Google sign-in, by self-service sign-up where open, or by the
  operator. It has a subject that never changes and no role at creation. Roles (`x402-agent`, `x402-admin`) are
  assigned by hand.
- **Portal user**: derived by L2 from the issuer and the person's subject. A Google account and an
  email-and-password account are always two portal users.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With email-and-password sign-up closed, repeating the report's two read-only reproduction steps on
  the deployed environment shows no sign-up offer for email and password on any application's page.
- **SC-002**: While closed, 100% of self-service email-and-password sign-up attempts are refused, by the page, the
  direct address and the endpoint, and no account is created.
- **SC-003**: A person with a Google account that is new to the tenant goes from the sign-in page to a saved
  profile in under 3 minutes, with no administrator action.
- **SC-004**: Every agent run and every administration request by such a person is refused until a role is
  assigned. They reach no record of another person, which is shown by tests covering profile, wallet, policies and
  cards.
- **SC-005**: Every Google sign-in started on the deployed tenant goes to Google for the project's own application,
  and none for the identity provider's shared one. A secret scan finds the Google secret in none of the repository,
  the variables file, the saved plan or the state.
- **SC-006**: Every person who could sign in before the change signs in after it with the same account, the same
  wallet address and the same history, the owner's Google sign-in included.
- **SC-007**: The offline check fails on each forbidden connection change listed in FR-017, and a change made by
  hand to a connection appears in the next plan every time.
- **SC-008**: The operator creates a named test account in under 5 minutes, while every self-service sign-up
  attempt made at the same time is refused.
- **SC-009**: A retest of finding P1 by the report's author can close it: Info for email-and-password sign-up,
  accepted by design for Google sign-up, with the signed-in surface testable through the test accounts.

## Assumptions

- The public way in is Google only. Email-and-password sign-up stays closed in dev. The existing per-environment
  switch keeps its default, and its meaning narrows to email and password.
- R21 stands. Using the portal needs no role. Starting runs needs `x402-agent`. The administration area needs
  `x402-admin` and a second factor. Roles are assigned by hand. None of this changes here.
- Google gives each Google account the same identifier whichever Google application asks. If so, moving to the
  project's own application keeps existing Google people's accounts (FR-009). Planning must confirm this against
  the identity provider's documentation and on dev with one account before switching. If it is false, the switch
  stops, and the owner decides how to move those people.
- The owner creates the project's own Google application by hand. That includes its consent screen and the tenant's
  callback as its only redirect. The owner enters its credential in the tenant by hand. The tenant's free plan
  accepts custom credentials for a social connection.
- Planning settles whether L2's approval client needs a person's connection enabled for the backchannel approval
  request. If it does, the client keeps it, and its grant types still prevent any interactive sign-in.
- Bot detection and the other attack-protection settings the report saw on the login page stay as they are.
- There is no cap on how many people sign up with Google. This is recorded as a residual risk with the existing
  rate limits and blocking, not solved here.
- The operator plans and applies the tenant on the operator's host with the existing operator command. The
  tenant's state stays local there (SPEC 1.26).
- Out of scope:
  - an invitation or admitted-list mechanism;
  - linking accounts;
  - the authenticated-surface pentest itself, which this feature makes possible;
  - the report's untested areas: request smuggling, host-header attacks on 443, origin TLS and non-web ports;
  - the DAST report's findings 1-7, which the addendum says are unchanged.
