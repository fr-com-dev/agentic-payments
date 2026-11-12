# Feature Specification: L2 Web Portal: Onboarding, Profile, Wallet and Expense Policies

**Feature Branch**: `013-l2-portal-onboarding`

**Created**: 2026-11-10

**Status**: Draft

**Input**: User description: "As User I want to onboard in new L2 web portal, create my profile, my wallet(for crypto and credit cards) and create my expenses policies(where, how much, how)."

## Clarifications

### Session 2026-11-10

- Q: Agents pay only in USDC today. What does adding a credit card to the wallet do in this
  feature? → A: Register only. The card is saved through a card vault in test mode and shown in
  the wallet. Agents still pay only in USDC. Paying by card is a later feature.
- Q: L2 has one payer and one mandate today, and multi-tenant users are out of scope in SPEC §1.3.
  Who onboards? → A: Many users, self-service. Anyone the organization's sign-in allows gets
  their own profile, wallet and policies. Their agent runs spend only from their wallet, under
  their policies. SPEC is amended to make L2 multi-user.
- Q: A policy sets an auto-approve limit. Who approves a user's payments above it? → A: Unchanged
  for now. The existing paths decide: the deployment's approver by phone (012) and the operator
  (004, 010). The user only sets the threshold. Per-user approval is a later feature.
- Q: How should a user's expense policies combine? → A: Several active policies, each for its own
  sellers with its own budgets, plus one daily ceiling per user across all their policies,
  checked at every payment.
- Q: Which sellers may a user put in a policy's "where"? → A: Only sellers on a list the operator
  maintains. Users pick from it and can't type a seller of their own.
- Q: With the portal on, whose money and rules does a run started by a system identity (a
  pipeline or service, not a person) use? → A: The platform account, under today's mandate,
  unchanged. Such a run has no portal user.
- Q: What can a user do when they want to stop using the portal? → A: Disable their account.
  Nothing is deleted: the account, its policies and its wallet are disabled and kept.
- Q: Who is allowed to sign in to the portal and onboard? → A: Everyone who may start agent runs.
  The same permission gives both; there is no separate portal permission.

### Session 2026-11-10 (identity provider)

The portal was first built against the organization's directory (Microsoft Entra ID). These answers replace it
with Auth0 as the identity provider for people.

- Q: With the portal on Auth0, how does the agent service recognize the same person, so that their
  payments find their policies (FR-003)? → A: People sign in with Auth0 for both the portal and the
  agent service. One identity names the user everywhere. System identities (a pipeline, a service)
  keep the organization's directory, as today.
- Q: A user's identifier is derived from their sign-in, so an Auth0 sign-in is a new user. What
  happens to people who already onboarded? → A: They onboard again. Earlier users stay in the
  ledger untouched, and no sign-in reaches them. Acceptable because wallets hold test funds only.
- Q: Who may sign in to the portal and onboard, now that the permission no longer comes from the
  organization's directory? → A: Whoever holds one permission in Auth0, assigned per person through
  a role and carried in their sign-in. The single-permission rule stays: whoever may start agent
  runs may onboard, and nobody else.

## User Scenarios & Testing *(mandatory)*

Terms used below:
- **User**: a person who signs in to the portal. They own one profile, one wallet and their own
  expense policies. It is the same person, with the same identity, who starts agent runs (the
  requester of feature 011).
- **Portal access**: what a person has when the organization lets them start agent runs. The
  same permission gives both.
- **Portal**: the new web interface where a user manages their profile, wallet and policies. It
  is for people only. The agent never uses it.
- **Wallet**: the user's payment methods: one crypto account, and any cards they registered.
- **Crypto account**: an account on the deployment's network that holds the user's USDC. The
  control layer (L2) creates it and is the only one that can sign with it.
- **Expense policy**: one set of spending rules a user writes. It says **where** the agent may
  pay (which sellers), **how much** (limits and budgets) and **how** (the payment method, when a
  human must approve, how fast, and until when).
- **Platform limits**: the ceilings the operator sets for every user of the deployment. A user's
  policy can be stricter than the platform limits, never looser.
- **Seller list**: the sellers the operator has vetted for the deployment. A policy's "where" is
  chosen from it.
- **User daily ceiling**: the most one user's agent may spend in any 24 hours, across all their
  policies together. It is one of the platform limits.
- **Platform account**: today's single payer and mandate. It stays, for runs that carry no user:
  those started by a system identity (a pipeline or a service), the scripted regression and the
  local demo.

### User Story 1 - A new user signs in and creates their profile (Priority: P1)

A person opens the portal for the first time and signs in with their organization account. The
portal greets them with the three steps that remain: profile, wallet and first policy. They
confirm their name and contact email, acknowledge that the wallet holds test funds only, and
save. If they leave and come back later, the portal takes them to the step they had reached.

**Why this priority**: Nothing else can belong to a user until the user exists. It is also the
first impression: a person must be able to start without an operator.

**Independent Test**: Sign in as a person who has portal access and has never used it. Complete
the profile step, sign out, and sign in again. The profile shows the saved values, and the
onboarding status shows the profile as done and the wallet as the next step. Sign in as a person
without portal access: they are refused and no profile exists for them.

**Acceptance Scenarios**:

1. **Given** a person with portal access who has never signed in, **When** they sign in, **Then**
   the portal shows the onboarding steps (profile, wallet, first policy) with none done, and the
   name and email from their sign-in already filled in.
2. **Given** the profile step, **When** the user saves a valid name and email and acknowledges
   the test-funds notice, **Then** the profile is saved, the step shows as done, and the wallet
   step is offered next.
3. **Given** a user who left onboarding after the profile step, **When** they sign in again,
   **Then** the portal opens on the wallet step, with the profile shown as done.
4. **Given** a person who is not allowed to start agent runs, **When** they try to sign in,
   **Then** they are refused, and no profile, wallet or policy is created for them.
5. **Given** an onboarded user, **When** they change their name or email, **Then** the new values
   show at once and nothing about their wallet or policies changes.

---

### User Story 2 - The user creates their crypto account and funds it (Priority: P1)

The user asks the portal to create their wallet. The control layer creates a crypto account for
them and the portal shows its address, the network and the USDC balance, which starts at zero. It
also tells them how to fund it: send test USDC to that address. After they do, the balance shows
the funds. The user never sees a key, and nobody but the control layer can sign with the account.

**Why this priority**: Without funds of their own, a user's agent has nothing to pay with. The
account is also where the "only L2 signs" rule now applies per user.

**Independent Test**: As a user with a profile, create the crypto account. Check that an address
is shown and that creating it again yields the same address. Send 1 USDC of test funds to the
address and check that the wallet shows it within 30 seconds. Scan every portal response, the
ledger and the logs for the account's key: it is nowhere.

**Acceptance Scenarios**:

1. **Given** a user with a profile and no crypto account, **When** they create their wallet,
   **Then** one crypto account is created for them and the portal shows its address, the network,
   the asset (USDC) and a balance of 0.
2. **Given** a user who already has a crypto account, **When** they ask to create one again (a
   second tab, a double click, a retry after an error), **Then** they get the same account. A
   user never has two on the same network.
3. **Given** a crypto account, **When** test USDC arrives at its address, **Then** the wallet
   shows the new balance within 30 seconds, with the time it was read.
4. **Given** a funded crypto account, **When** the user opens the wallet, **Then** they see the
   balance on the network, the amount already committed to payments that can still settle, and
   the amount spent in the last 24 hours.
5. **Given** any wallet view, export or error, **When** it is shown, **Then** it never contains
   the account's key.

---

### User Story 3 - The user writes an expense policy and it governs their agent's payments (Priority: P1)

The user creates their first policy in three parts:
- **Where**: the sellers the agent may pay, picked from the operator's seller list.
- **How much**: the amount it may pay without asking, the most it may pay in one payment, and the
  budgets per agent run and per day.
- **How**: the payment method (their crypto account), how many payments per minute, and the date
  the policy stops.

Before saving, the portal states in plain words what the policy will allow. Once saved, the
user's onboarding is complete, and their next agent run pays under that policy, from their own
crypto account.

**Why this priority**: This is the point of the portal. A person, not a configuration file,
decides what their agent may spend, and the decision is enforced by the same deterministic
engine as today.

**Independent Test**: As a user with a funded crypto account, create a policy for one seller
with an auto-approve limit of 0.02 USDC, a per-payment cap of 0.10, a run budget of 0.10 and a
daily budget of 0.50. Then start agent runs as that user:
- a 0.001 USDC purchase at that seller is paid, from the user's own account;
- a 0.05 USDC purchase is escalated to the existing approval paths;
- a 0.20 USDC purchase is refused;
- a purchase at a seller the policy does not list is refused.

**Acceptance Scenarios**:

1. **Given** a user with a crypto account and no policy, **When** they enter where, how much and
   how, **Then** the portal shows a plain-language summary of what the policy allows before they
   save it.
2. **Given** a valid policy, **When** the user saves it, **Then** it is active, the onboarding
   status shows all three steps done, and the next payment decision for that user uses it.
3. **Given** an active policy, **When** the user's agent requests a payment at a listed seller,
   at or below the auto-approve limit and within every budget, **Then** it is authorized and
   signed with the user's own crypto account.
4. **Given** an active policy, **When** the agent requests a payment above the auto-approve limit
   and at or below the per-payment cap, **Then** it is escalated to the existing approval paths,
   exactly as today.
5. **Given** an active policy, **When** the agent requests a payment above the per-payment cap,
   over a budget, too fast, or at a seller no active policy lists, **Then** it is denied with the
   same rule as today.
6. **Given** amounts that break the order "auto-approve limit below per-payment cap, per-payment
   cap at or below run budget", or that exceed a platform limit, **When** the user saves,
   **Then** the policy is refused and the portal names each value to fix.
7. **Given** a user who has not finished onboarding (no profile, no crypto account, or no policy
   saved yet), **When** their agent requests a payment, **Then** it is denied, and the agent is
   told only that the user's setup is incomplete.
8. **Given** the "where" part of a policy, **When** the user chooses sellers, **Then** only
   sellers on the operator's seller list are offered, each by its name and host. A seller that is
   not on the list can't be added by any means.

---

### User Story 4 - Each user spends only their own money, under their own rules (Priority: P1)

Two users have each onboarded. Each sees only their own profile, wallet and policies. An agent
run started by one user pays from that user's crypto account, under that user's policies, and
counts against that user's budgets. Nothing one user does changes what the other may spend.

**Why this priority**: Making L2 multi-user is the largest change this feature brings. If
isolation fails, one person spends another person's money.

**Independent Test**: Onboard users A and B with different policies and fund both accounts. Then
check:
- A's run pays from A's address, and the ledger names A and A's policy;
- A spending their full daily budget leaves B's remaining budget unchanged;
- A, signed in, asking for B's profile, wallet or policy by its identifier gets "not found";
- a seller that only B's policy lists is refused for A's run.

Must-fail check: with the ownership check removed, A reads B's policy.

**Acceptance Scenarios**:

1. **Given** users A and B, both onboarded, **When** A's agent run pays, **Then** the payment is
   signed with A's crypto account, and no payment is ever signed with B's.
2. **Given** A has spent their whole daily budget, **When** B's agent requests a payment within
   B's policy, **Then** it is authorized. B's budgets count only B's payments.
3. **Given** A is signed in, **When** A asks for a profile, wallet, card or policy that belongs to
   B, **Then** the portal answers "not found" and reveals nothing about B.
4. **Given** an agent run, **When** it requests a payment, **Then** the user it pays for is the
   verified person who started the run. It is never taken from the agent's text or tool input.
5. **Given** a run started by a system identity, **When** it requests a payment, **Then** it is
   decided against the platform account and its mandate, as today. No user's account, policy or
   budget is touched.
6. **Given** a run started by a person who has not finished onboarding, **When** it requests a
   payment, **Then** it is denied. It never falls back to the platform account.

---

### User Story 5 - The user changes, pauses and removes policies (Priority: P2)

Needs change. The user adds a seller, lowers a budget, pauses a policy while they investigate
something, or removes one they no longer want. They can keep several policies, each for its own
sellers. A change applies to the next payment decision. The portal shows who changed what and
when, and no past version is lost.

**Why this priority**: A policy that can't be tightened quickly is a risk, and one that can't be
adjusted gets replaced by an over-broad one. It builds on the first policy, so it comes second.

**Independent Test**: With one active policy, lower its daily budget below what was already spent
today, then request a payment: it is denied by the daily budget. Pause the policy and request
again: denied because no active policy lists the seller. Resume it, create a second policy for a
different seller, and try to add the first seller to it: refused, naming the first policy. The
policy's history lists every change in order.

**Acceptance Scenarios**:

1. **Given** an active policy, **When** the user changes it, **Then** a new version is recorded,
   every later payment decision uses the new version, and no decision mixes two versions.
2. **Given** a change that raises a limit, adds a seller or extends the end date, **When** the
   user's sign-in is older than 15 minutes, **Then** the portal asks them to confirm their
   identity again before saving. A change that only tightens is saved without it.
3. **Given** an active policy, **When** the user pauses it, **Then** no payment is authorized
   under it until they resume it. **When** they remove it, **Then** it never authorizes again and
   stays visible in the history.
4. **Given** two policies of one user, **When** the user tries to list the same seller in both
   while both are active, **Then** the second is refused, naming the policy that already lists
   the seller.
5. **Given** two active policies of one user whose daily budgets add up to more than the user
   daily ceiling, **When** the user's payments under both reach the ceiling within 24 hours,
   **Then** the next payment under either policy is denied by the daily budget, although that
   policy's own daily budget is not used up.
6. **Given** a pending escalation created under an earlier version, **When** it is approved and
   the purchase is paid, **Then** every rule is checked against the policy as it is at payment
   time. If the purchase no longer fits, it is denied.
7. **Given** a policy whose end date has passed, **When** the agent requests a payment under it,
   **Then** it is denied as expired, and the portal shows the policy as expired with the option
   to extend it.

---

### User Story 6 - The user registers a credit card in their wallet (Priority: P2)

The user adds a credit card to their wallet. The card's details go straight to a card vault; the
portal keeps only what is needed to recognize the card: its brand, last four digits, expiry and a
nickname. The wallet lists the card next to the crypto account and says clearly that agents can't
pay with cards yet. The user can remove the card at any time.

**Why this priority**: The user asked for a wallet that holds both crypto and cards. Registering
the card now makes the wallet complete and prepares card payments as a later feature, without
adding a second way to move money in this one.

**Independent Test**: With the card vault in test mode, add one of its test cards. The wallet
shows the brand, last four digits and expiry. Scan the ledger, the logs and every portal response
for the full card number and the security code: they are nowhere. Try to choose the card as a
policy's payment method: it can't be chosen. Remove the card: it leaves the wallet and its vault
reference no longer works.

**Acceptance Scenarios**:

1. **Given** an onboarded user, **When** they add a valid test card, **Then** the wallet lists it
   with its brand, last four digits, expiry and nickname, and a notice that agents can't pay with
   cards yet.
2. **Given** a card being added, **When** its details are submitted, **Then** the full number and
   the security code go only to the card vault. The portal and the control layer never receive,
   store or log them.
3. **Given** a registered card, **When** the user creates or changes a policy, **Then** the card
   can't be chosen as the payment method, and no agent payment uses it.
4. **Given** a registered card, **When** the user removes it, **Then** it leaves the wallet, its
   reference is revoked at the card vault, and the removal is recorded.
5. **Given** the card vault is unavailable, **When** the user tries to add a card, **Then** the
   portal says the card could not be added and to try later. The rest of the portal and every
   agent payment work as usual.
6. **Given** a card the user already registered, or a card whose expiry has passed, **When** they
   try to add it, **Then** it is refused with the reason.

---

### User Story 7 - The user disables their account (Priority: P3)

A user wants to stop. They disable their account in the portal. From that moment their agent can
pay nothing: every policy and the wallet are disabled with the account. Nothing is deleted. The
profile, the policies and their history, the crypto account with its funds, and the registered
cards all stay as they were. The user can still sign in to see them, and can enable the account
again later.

**Why this priority**: A person must be able to stop all spending in one step, and the audit
trail must stay whole. It is used rarely, so it follows the main flows.

**Independent Test**: As an onboarded user with a funded account, an active policy and a card,
disable the account. Start an agent run and request a payment the policy allowed before: it is
denied. Sign in again: the profile, the policy, the balance and the card are all still shown,
marked as disabled. Enable the account: the policy is shown as paused, and after the user resumes
it, the same payment is authorized. Must-fail check: with the disabled check removed, the
disabled user's run pays.

**Acceptance Scenarios**:

1. **Given** an onboarded user, **When** they disable their account and confirm, **Then** the
   account, every policy and the wallet show as disabled, and the next payment decision for that
   user is denied.
2. **Given** a disabled account, **When** the user signs in, **Then** they can still see their
   profile, policies, policy history, balance and cards. They can't create or change a policy,
   create a wallet or add a card.
3. **Given** a disabled account, **When** anything is checked afterwards, **Then** nothing was
   deleted: the profile, every policy version, the crypto account, its funds and the card
   references are all still there.
4. **Given** a disabled account, **When** the user enables it again, having confirmed their
   identity within the last 15 minutes, **Then** the account and the wallet are usable again and
   every policy that was active comes back paused, for the user to resume.
5. **Given** an escalation that was pending when the account was disabled, **When** it is
   approved, **Then** the purchase is still denied at payment time.

---

### User Story 8 - The operator bounds every user, and the auditor sees who spent under which policy (Priority: P3)

The operator sets the platform limits once for the deployment: the highest per-payment cap and
budgets a user may choose, the daily ceiling for each user across all their policies, the sellers
users may list, and the longest a policy may last. No user
policy can go beyond them. For every payment, the ledger tells the auditor which user it was for,
which policy and version decided it, and which account paid. The operator's escalation views show
whose payment each escalation is.

**Why this priority**: Self-service must stay inside limits the organization chose, and the audit
trail must still answer "who allowed this payment" now that there are many users. It adds to the
flows above and can follow them.

**Independent Test**: Set a platform per-payment cap of 0.10 USDC. A user's attempt to save a cap
of 0.20 is refused. Lower the platform cap to 0.05 while a user's saved policy says 0.10: a 0.08
purchase is denied. Then read the ledger: each decision names the user, the policy and its
version, and the policy's whole history can be rebuilt from the ledger alone.

**Acceptance Scenarios**:

1. **Given** platform limits, **When** a user saves a policy with a value beyond one of them,
   **Then** it is refused, naming the limit.
2. **Given** a saved policy and platform limits that were tightened afterwards, **When** a
   payment is decided, **Then** the stricter of the two applies, and the portal flags the policy
   as limited by the platform.
3. **Given** any payment decision for a user, **When** an auditor reads the ledger, **Then** they
   can tell the user (by an identifier, never by name or email), the policy and version that
   decided it, and the account that paid.
4. **Given** a pending escalation for a user's payment, **When** the operator lists or watches
   escalations, **Then** the event shows that user's identifier.

---

### Edge Cases

- **Onboarding left unfinished.** The user's agent runs are denied until the profile, the crypto
  account and a first policy exist. Nothing is spent from the platform account on their behalf.
- **Every policy paused or removed.** The user stays onboarded. Their payments are denied because
  no active policy lists the seller, until they resume or create one.
- **Two tabs, double clicks and retries.** Creating the profile or the crypto account twice
  yields one of each. Saving the same policy change twice records one version.
- **An empty or low wallet.** A payment the policy allows but the account can't cover is signed
  and then refused by the seller's facilitator, as today. Nothing is spent, and the amount stays
  committed until that authorization lapses. The wallet shows a low-balance notice when the
  balance is below an active policy's per-payment cap.
- **Amounts typed with too many decimals.** USDC has 6 decimals. A value with more is refused,
  never rounded. Amounts are shown in USDC and kept exactly.
- **An auto-approve limit of zero.** Allowed: every payment under that policy needs a human.
- **A seller in no active policy.** Denied as a seller that is not allowed, as today.
- **A policy change while a payment is being decided.** The decision uses the version that was
  current when it began, or the new one, never a mix. The change and the decision are recorded in
  a definite order.
- **A policy removed or paused while an escalation is pending.** The escalation can still be
  approved, but the purchase is denied at payment time, because no active policy allows it.
- **The operator takes a seller off the seller list while a user's policy names it.** Payments to
  it are denied. The portal flags the policy.
- **An empty seller list.** No policy can be created. The portal says that no sellers are
  available yet, and the user's onboarding waits at the policy step.
- **The platform lowers a limit below a saved policy's value.** The stricter value applies to each
  field. If the platform's per-payment cap falls to or below the policy's auto-approve limit,
  nothing above the platform cap is paid, with or without approval.
- **The portal is down.** Payments continue under the policies last recorded. No decision waits
  on the portal.
- **The card vault is down or slow.** Only adding and removing cards is affected.
- **The user's organization account is disabled, or they lose the permission to start runs.**
  They can't sign in to the portal or start agent runs, so nothing is spent. Their profile,
  policies and funds stay as they are, and are theirs again if the permission returns.
- **A run with no user.** Runs started by a system identity, the scripted regression and the
  local demo carry no user. They are decided against the platform account, exactly as today.
- **A person who has not onboarded starts a run.** Their payments are denied as incomplete setup.
  They never use the platform account, even if the same person could before the portal was on.
- **Text typed by users.** A profile name, a policy name or a card nickname could be written to
  mislead. None of them is ever an input to a payment decision, and none reaches the agent.
- **The agent tries to reach the portal.** It has no credential the portal accepts and no tool
  for it. A request with the agent's credentials is refused.
- **Disabling with a payment already signed.** A payment authorized before the account was
  disabled can still settle, because a signature can't be taken back. It stays committed until it
  settles or lapses. Nothing new is signed.
- **Disabling twice, or enabling an account that is not disabled.** Nothing changes and nothing
  new is recorded.
- **A disabled user's funds.** They stay in the crypto account. Funds sent to it while it is
  disabled still arrive and show in the wallet.
- **A restart of the control layer.** Every user's account, policies and budgets are the same
  after the restart as before it.
- **Local development.** The portal and multi-user mode are off unless configured, so the local
  demo and its summary are unchanged.

## Requirements *(mandatory)*

### Functional Requirements

**Activation and compatibility**

- **FR-001**: The portal and multi-user mode MUST be off unless the deployment is configured for
  them. With them off, every behavior of features 001 to 012 is unchanged. *(SPEC: §1.3 amended,
  proposed L2-8, CFG-2)*
- **FR-002**: With multi-user mode on, a payment request that carries no user MUST be decided
  against the platform account and its mandate, exactly as today. A request carries no user when
  its run was started by a system identity, by the scripted regression plan (L1-4) or by the
  local demo, which MUST all keep working this way. A request for a person MUST never be decided
  against the platform account, whether or not that person has onboarded. *(SPEC: L2-1, L1-4,
  L1-6 auth, T-E2E-01)*

**Sign-in and access**

- **FR-003**: A person MUST sign in to the portal with the same identity they use to start agent
  runs, at the deployment's identity provider for people (Auth0, clarified 2026-11-10). Everyone
  who is allowed to start agent runs MAY sign in and onboard, and nobody else: one permission at
  the identity provider gives both, and there is no separate portal permission. A system identity
  can't sign in. A refused sign-in MUST create no record. *(SPEC: L1-6 auth, SEC-14, proposed L2-8)*
- **FR-004**: A signed-in user MUST be able to read and change only their own profile, wallet,
  cards and policies. A request for anything that belongs to another user MUST get "not found",
  with nothing revealed. *(SPEC: SEC-15, proposed L2-8)*
- **FR-005**: The portal MUST accept only a person's own portal sign-in. It MUST refuse the
  credentials of the agent, the verifier and the operator, a sign-in issued for the agent
  service, and any sign-in from another identity provider, the organization's directory
  included. *(SPEC: INV-13)*
- **FR-006**: The agent MUST gain no tool, field or route that reads or changes a profile, a
  wallet or a policy. Its tools stay `fetch_resource` and `check_budget`. *(SPEC: L1-3, L1-6,
  Constitution I)*
- **FR-007**: A change that raises a limit, adds a seller, extends a policy's end date,
  or resumes a paused policy MUST require the user to have confirmed their identity within the
  last 15 minutes. Changes that only tighten MUST NOT require it. *(SPEC: proposed L2-8, §11)*

**Onboarding and profile**

- **FR-008**: The portal MUST guide a new user through three steps, in order: profile, crypto
  account, first policy. It MUST show which are done, and reopen on the first step not done when
  the user returns. *(SPEC: proposed L2-8)*
- **FR-009**: A profile MUST hold a display name (1 to 80 characters) and a contact email, both
  prefilled from the sign-in and editable, and the user's acknowledgement that the wallet holds
  test funds only. The profile can't be saved without the acknowledgement. *(SPEC: §1.2 networks,
  proposed L2-8)*
- **FR-010**: A user MUST be able to change their display name and contact email at any time.
  Such a change MUST NOT affect their wallet, policies or budgets. *(SPEC: proposed L2-8)*
- **FR-011**: Onboarding is complete once the user has a profile, a crypto account and has saved
  their first policy. It stays complete if they later pause or remove policies. Registering a
  card is optional. *(SPEC: proposed L2-8)*
- **FR-012**: Until onboarding is complete, every payment request for that user MUST be DENIED
  with a rule that says the user's setup is incomplete (proposed rule `user_not_onboarded`). The
  detail MUST NOT say which step is missing. An onboarded user with no active policy for the
  requested seller is covered by FR-029 instead. *(SPEC: L2-2 new rule, SEC-12)*

**Wallet: the crypto account**

- **FR-013**: A user MUST be able to create one crypto account on the deployment's network.
  Creating it MUST be idempotent: a user never has two on the same network. *(SPEC: L2-3,
  proposed L2-8)*
- **FR-014**: The account's key MUST be created and held only by the control layer's signer. It
  MUST NOT be shown, exported, logged or sent to the portal or to any other layer, and it MUST
  survive a restart of the control layer. *(SPEC: INV-2, INV-3, INV-4, §3.3)*
- **FR-015**: The wallet MUST show the account's address, network and asset, and three figures:
  - the USDC balance on the network, at most 30 seconds old, with the time it was read;
  - the amount committed to payments that can still settle;
  - the amount spent in the last 24 hours, the period the daily budget counts, next to the user
    daily ceiling.

  The last two MUST come from the ledger. *(SPEC: INV-7, L2-4.1, L2-5 budget)*
- **FR-016**: The wallet MUST tell the user how to fund the account: by sending USDC on the
  deployment's network to its address. The portal MUST NOT offer a way to move funds out of the
  account. *(SPEC: §1.2, §1.3)*
- **FR-017**: A payment for a user MUST be signed only with that user's crypto account. No user's
  payment is ever signed with another user's account or with the platform account. *(SPEC:
  INV-2, INV-6)*

**Wallet: cards**

- **FR-018**: A user MUST be able to register a credit card through a card vault running in test
  mode. The full card number and the security code MUST go only to the card vault. The portal and
  the control layer MUST never receive, store or log them. *(SPEC: §11 new row, Constitution V)*
- **FR-019**: For each registered card the system MUST keep only: the vault's reference, the
  brand, the last four digits, the expiry month and year, a nickname the user may set, and the
  time it was added. A user MAY register at most 5 cards. A card already registered, or already
  expired, MUST be refused with the reason. *(SPEC: proposed L2-8)*
- **FR-020**: A user MUST be able to remove a card. Removal MUST revoke its reference at the card
  vault and take it out of the wallet. *(SPEC: proposed L2-8)*
- **FR-021**: A registered card MUST NOT pay for anything in this feature:
  - a policy can't name a card as its payment method;
  - no payment decision and no signing step reads a card;
  - wherever a card is shown, the portal says that agents can't pay with cards yet.

  *(SPEC: §1.3, Constitution VII)*
- **FR-022**: The wallet MUST flag a registered card whose expiry has passed. *(SPEC: proposed
  L2-8)*
- **FR-023**: The credential for the card vault MUST be held by exactly one process and confined
  to one module, enforced by an architecture rule like A8 and A9. It MUST never become payment
  authority. *(SPEC: §3.3, §4.1, Constitution V)*

**Expense policies: writing them**

- **FR-024**: A user MUST be able to create a policy with these parts:
  - **a name**, for the user's own reference;
  - **where**: one or more sellers, picked from the operator's seller list (FR-042). The payee
    addresses accepted for a seller come from that list, never from the user;
  - **how much**: an auto-approve limit, a per-payment cap, a budget per agent run and a budget
    per day;
  - **how**: the payment method, the highest number of payments per minute, and the date the
    policy ends.

  In this feature the payment method is always the user's crypto account. *(SPEC: CFG-3, L2-1,
  L2-2 R1, R5, R6, R10..R14)*
- **FR-025**: Amounts MUST be entered and shown in USDC with at most 6 decimals, and kept as
  exact atomic units. A value with more decimals, a negative value or a non-number MUST be
  refused, never rounded. *(Constitution VI)*
- **FR-026**: A policy MUST be refused, naming each value to fix, when:
  - the auto-approve limit is not below the per-payment cap, or the per-payment cap is above the
    run budget (CFG-3's constraint);
  - any value is beyond a platform limit (FR-041);
  - a seller is not on the operator's seller list;
  - the end date is in the past, or later than the platform allows;
  - a seller is already listed by another active policy of the same user (FR-028).

  *(SPEC: CFG-3, L2-1)*
- **FR-027**: Before a policy is saved or changed, the portal MUST show a plain-language summary
  of what it allows: for which sellers, how much without asking, how much with a human's
  approval, how much per run and per day, and until when. *(SPEC: proposed L2-8)*
- **FR-028**: A user MAY have at most 10 active policies, each with at most 20 sellers. A seller
  MUST be listed by at most one active policy of a user, so that exactly one policy can apply to
  any payment. *(SPEC: proposed L2-8)*

**Expense policies: deciding with them**

- **FR-029**: For a payment request that carries a user, the policy that applies MUST be that
  user's active policy that lists the requested seller. If none does, the request MUST be DENIED
  with `host_not_allowed`. *(SPEC: L2-2 R6)*
- **FR-030**: The applicable policy, bounded by the platform limits (FR-041), MUST be given to the
  policy engine as the mandate. The engine MUST stay pure, with time as an input and no agent
  text, and keep today's rules in today's order. The only additions are the incomplete-setup rule
  (FR-012), the disabled-account rule (FR-038) and the user daily ceiling (FR-032). *(SPEC:
  INV-5, L2-2)*
- **FR-031**: Budgets and the payments-per-minute count MUST be computed from the ledger, per user
  and per policy. One user's payments MUST never count against another's. No mutable counter is
  added. *(SPEC: INV-7, L2-2 R11..R13)*
- **FR-032**: At every decision, the user's committed spending over the last 24 hours across all
  their policies, plus the requested amount, MUST NOT exceed the user daily ceiling. A request
  over it MUST be DENIED with `daily_budget_exceeded`, whatever the applicable policy's own daily
  budget allows. The figure MUST come from the ledger. *(SPEC: INV-7, L2-2 R12, L2-4.1)*
- **FR-033**: The user a payment request is for MUST be the verified person who started the agent
  run, set by the agent service. It MUST NOT come from the model's text or a tool's input. The
  person's sign-in credential MUST NOT be forwarded to the control layer. For a run started by a
  system identity, the agent service MUST set no user (FR-002). *(SPEC: L1-6, SEC-15,
  Constitution V)*
- **FR-034**: A payment above a policy's auto-approve limit and within its per-payment cap MUST be
  escalated to the existing approval paths, unchanged (features 004, 010 and 012). The portal
  offers no way to approve or reject. *(SPEC: L2-2 R14, L2-4.3, L2-7)*

**Expense policies: changing them**

- **FR-035**: A user MUST be able to change, pause, resume and remove their policies.
  - Every change makes a new version. Earlier versions stay readable.
  - A paused or removed policy authorizes nothing.
  - A removed policy can't be resumed.

  *(SPEC: INV-9, proposed L2-8)*
- **FR-036**: A policy change MUST apply to every payment decision recorded after it, and each
  decision MUST use exactly one version. Recording a change and deciding a payment MUST be
  serialized with each other. An approved escalation MUST be re-evaluated against the policy as it
  is at payment time. *(SPEC: INV-8, INV-12)*

**Disabling an account**

- **FR-037**: A user MUST be able to disable their own account in the portal, after confirming
  the action. Disabling MUST delete nothing: the profile, every policy and version, the crypto
  account and its key, its funds and the registered cards are all kept. *(SPEC: INV-9, proposed
  L2-8)*
- **FR-038**: While an account is disabled:
  - every payment request for that user MUST be DENIED with a rule that says the account can't
    pay (proposed rule `user_disabled`), from the next decision on;
  - nothing MUST be signed with the user's crypto account;
  - every policy and the wallet MUST show as disabled, and the user can't create or change a
    policy, create a wallet or add a card;
  - the user can still sign in and read everything they own, and can still correct their name
    and email.

  *(SPEC: L2-2 new rule, L2-3, SEC-12)*
- **FR-039**: A user MUST be able to enable their disabled account again, having confirmed their
  identity within the last 15 minutes. Every policy that was active when the account was disabled
  MUST come back paused, so that spending restarts only when the user resumes a policy (FR-007).
  *(SPEC: proposed L2-8)*
- **FR-040**: Disabling and enabling MUST be serialized with payment decisions, like a policy
  change (FR-036), and each MUST be idempotent. *(SPEC: INV-8)*

**Platform limits**

- **FR-041**: The operator MUST be able to set platform limits for all users: the highest
  per-payment cap and run budget, the user daily ceiling (which is also the highest daily budget
  one policy may have), the highest payments per minute, the longest a policy may last, and the
  seller list (FR-042). They are checked when a policy is saved and
  again at every decision, where the stricter of the policy and the platform limits applies.
  Users can't change them. *(SPEC: L2-1, CFG-3)*
- **FR-042**: The operator MUST maintain the seller list. Each entry holds the seller's host, a
  name shown to users, and the payee addresses accepted for it. Users can read the list and
  can't change it. A seller that is not on it MUST NOT be accepted in a policy, and a payment to a
  seller taken off the list MUST be denied with `host_not_allowed`, even if a saved policy still
  names it. *(SPEC: L2-1, L2-2 R5, R6)*
- **FR-043**: The portal MUST flag a policy that the platform limits currently make stricter than
  the user wrote it. *(SPEC: proposed L2-8)*

**Recording**

- **FR-044**: The ledger MUST record each of these as a new append-only entry:
  - a user completed their profile, named only by their identifier;
  - a crypto account was created, with its address;
  - a card was added or removed, named only by an identifier (no brand, digits or expiry);
  - a policy was created, changed, paused, resumed or removed, with its version and every value;
  - an account was disabled or enabled, named only by the user's identifier.

  Existing entries are never rewritten. *(SPEC: INV-9, L2-4 table)*
- **FR-045**: Every ledger entry about a user's payment MUST name the user's identifier, and every
  decision MUST also name the policy and version that decided it and the account that paid. The
  operator's escalation list and event stream MUST show the user's identifier. *(SPEC: L2-4,
  L2-5 escalation reads)*
- **FR-046**: A user's name and email MUST NOT be written to the ledger. They are kept apart from
  it, so they can be corrected. The ledger names users only by an identifier that reveals neither.
  *(SPEC: INV-9, SEC-16)*
- **FR-047**: The portal MUST show a user the history of each of their policies: every version,
  when it was made and what changed. *(SPEC: proposed L2-8)*

**Isolation and credentials**

- **FR-048**: The part of the portal that browsers reach MUST run apart from the process that
  holds the signer. It MUST hold no payment key. The control layer MUST gain no public route and
  keep listening only where it does today. *(SPEC: §3.1, INV-2, Constitution V)*
- **FR-049**: The portal MUST reach the control layer with its own role credential. That
  credential MUST NOT be able to authorize, approve, reject or reconcile a payment. No other
  role's credential MAY change a profile, a wallet or a policy. *(SPEC: INV-13, §3.3)*

### Non-Functional Requirements

- **NFR-001 (Security: monotonicity)**: No user policy can allow what the platform limits forbid.
  Anything done in the portal takes effect only inside them. *(SPEC: L2-1, INV-5)*
- **NFR-002 (Security: fail closed)**: Every failure fails closed. An unknown user, a user who has
  not finished onboarding, a disabled account, a seller no active policy lists, a policy that
  can't be read, and a failed ownership check all end in no payment. *(SPEC: SEC-3)*
- **NFR-003 (Security: secrets)**: These MUST NEVER appear in the ledger, logs, portal responses,
  operator events, the agent's tool results, L1 or L3:
  - any crypto account's key;
  - a full card number or a security code;
  - the card vault credential and the portal's role credential;
  - a user's sign-in credential.

  A known-value scan over test output MUST find none. *(SPEC: SEC-10, SEC-16)*
- **NFR-004 (Privacy)**: The system keeps only the personal data the profile needs: a name and an
  email. It is visible only to its owner, kept out of the ledger and the logs, and can be
  corrected by its owner. It is kept while the account exists, disabled or not; this feature has
  no deletion. *(SPEC: SEC-16)*
- **NFR-005 (Availability)**: Payment decisions MUST NOT depend on the portal or the card vault
  being up. An outage of either MUST NOT change a decision or delay it by more than 50 ms.
  *(SPEC: L2-5)*
- **NFR-006 (Untrusted text)**: Text typed in the portal (names, nicknames) is untrusted. It is
  never a decision input, never reaches the agent, and is always shown as plain text. *(SPEC:
  INV-5, SEC-12)*
- **NFR-007 (Proven safety)**: Each of these checks MUST be shown to fail without it:
  - the ownership check (FR-004): without it, user A reads user B's policy;
  - the per-user account (FR-017): without it, A's payment is signed with B's account;
  - the per-user budget (FR-031): without it, A's spending uses up B's budget;
  - the platform bound (FR-041): without it, a policy over the limit pays;
  - the user daily ceiling (FR-032): without it, two policies together pay more than the ceiling;
  - the disabled-account rule (FR-038): without it, a disabled user's run pays;
  - the no-fallback rule (FR-002): without it, a person who has not onboarded pays from the
    platform account;
  - the one-policy-per-seller check (FR-028): without it, two policies apply to one payment;
  - the serialized policy change (FR-036): without it, a decision mixes two versions.

  *(Constitution VIII)*
- **NFR-008 (Regression)**: The `npm run demo:local` summary and the L1-4 baseline MUST stay
  unchanged. Every existing test MUST pass; only tests updated for intended additive fields may
  change. *(SPEC: T-E2E-01, definition of done)*
- **NFR-009 (Usability and accessibility)**: The portal MUST work on a phone-width and a
  desktop-width screen, be fully usable with a keyboard, and meet WCAG 2.1 level AA for contrast,
  labels and focus. Every refusal tells the user what to fix.
- **NFR-010 (Capacity)**: With 100 onboarded users and 10 active policies each, a payment that
  needs no human MUST be decided within 50 ms of the time it takes today. *(SPEC: L2-5)*

### Key Entities

- **User**: a person with portal access. Identified by their identity at the identity provider for people, and in the
  ledger by an identifier that reveals neither name nor email. Their account is enabled or
  disabled; a disabled account keeps everything and pays nothing. Owns one profile, one wallet and
  up to 10 active policies. The same identity starts their agent runs.
- **Profile**: the user's display name, contact email and test-funds acknowledgement. Kept
  outside the ledger. Editable by its owner only.
- **Onboarding Status**: which of the three steps (profile, crypto account, first policy) are
  done. Derived from what exists and from the policy history, not stored as its own flag.
- **Wallet**: the user's payment methods together: one crypto account and up to 5 registered
  cards.
- **Crypto Account**: one per user and network. Has an address, a network and an asset; its key
  never leaves the signer. Its balance is read from the network; its committed and spent amounts
  come from the ledger.
- **Registered Card**: a reference to a card held at the card vault, with the brand, last four
  digits, expiry, nickname and time added. It can't pay in this feature.
- **Card Vault**: the outside service that holds card details, in test mode. The system sends it
  nothing about payments.
- **Seller List**: the operator's vetted sellers: for each, a host, a display name and its
  accepted payee addresses. The only source of a policy's "where".
- **Expense Policy**: a user's named set of rules: sellers picked from the seller list (where); the
  auto-approve limit, per-payment cap, run budget and daily budget (how much); the payment
  method, payments per minute and end date (how). It has a state (active, paused, removed) and
  versions.
- **Policy Version**: one recorded state of a policy, with every value, the time and the user who
  made it. Decisions name the version they used.
- **User Daily Ceiling**: the limit on one user's spending in any 24 hours across all their
  policies. Set by the operator as a platform limit, the same for every user.
- **Platform Limits**: the operator's ceilings for all users, together with the seller list. The
  effective rules for a payment are the user's policy, made no looser than these.
- **Platform Account**: today's payer and mandate, used only for runs that carry no user: system
  identities, the scripted regression and the local demo.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user completes onboarding (profile, crypto account, first policy) in under 5
  minutes, without help from an operator.
- **SC-002**: 90% of new users finish onboarding on their first attempt, and 100% of those who
  leave midway resume at the step they had reached.
- **SC-003**: A user's first agent payment after onboarding succeeds with no operator action, as
  long as their account is funded and the purchase fits their policy.
- **SC-004**: 100% of payment decisions made after a policy change use the new version. A user
  sees the change in effect on their next agent request.
- **SC-005**: 0 payments are signed with an account other than the paying user's. 0 requests by
  one user return another user's profile, wallet, card or policy.
- **SC-006**: 0 payments go beyond the user's applicable policy or the platform limits: none to a
  seller not listed, none above a cap, none over a budget, none over the user daily ceiling.
- **SC-007**: Funds sent to a user's crypto account show in their wallet within 30 seconds.
- **SC-008**: A known-value scan finds 0 occurrences of an account key, a full card number, a
  security code or a credential in the ledger, logs, portal responses or agent results.
- **SC-009**: 0 agent payments use a registered card, and every place a card is shown says so.
- **SC-010**: For every payment, an auditor can tell from the ledger alone which user it was for,
  which policy and version decided it, and which account paid. They can rebuild every policy's
  full history.
- **SC-011**: With the portal or the card vault unavailable, 100% of payments are decided as they
  would be with both available.
- **SC-012**: The `npm run demo:local` summary is unchanged (`spent on-chain: 0.006 USDC`,
  `hash chain ok=true`), and the existing tests pass.
- **SC-013**: A user can tell from the policy summary alone, in under 30 seconds, what their
  agent may spend, where, and when a human will be asked.
- **SC-014**: After a user disables their account, 0 payments are authorized for them, starting
  with the next decision, and 100% of their profile, policies, funds and cards are still there
  when they enable it again.

## Assumptions

- **"Wallet" means the user's payment methods.** It holds one crypto account that the system
  creates, plus any cards. The user's words were "create my wallet", so the account is created by
  the system and its key held by L2's signer, which keeps L2 the sole signer (INV-2). Connecting
  an outside wallet the user already owns is out of scope: with the `exact` scheme the payer
  signs every payment, so L2 can't pay from an account whose key it does not hold.
- **Cards are registered, not charged** (clarified 2026-11-10). No card payment, top-up or charge
  happens in this feature. Card payments (for example Visa TAP or Mastercard Agent Pay) stay out
  of scope and would be their own feature.
- **Test funds and test cards only.** Networks stay `local` and `base-sepolia`; mainnet stays out
  of scope. The card vault runs in test mode. The profile's acknowledgement says so.
- **No withdrawals.** A user funds their account by sending test USDC to it. Moving funds out
  through the portal is out of scope.
- **Disable, never delete** (clarified 2026-11-10). A user who wants to stop disables their
  account, which disables their policies and wallet with it. Nothing is deleted, so closing an
  account for good and erasing a profile are out of scope. Two details are assumed: the user can
  enable the account again themself, and their policies then come back paused, so that enabling
  alone never restarts spending. Only the user disables their own account; an operator disabling
  a user is out of scope, and the organization can still block the person's sign-in.
- **Many users, self-service** (clarified 2026-11-10). Portal access comes with the
  organization's permission to start agent runs, so nobody can start runs without being able to
  set up payment. The permission is granted in the identity provider for people, per person, as
  one permission (clarified 2026-11-10). There is no invitation or operator approval step in the
  portal, and no separate portal permission.
- **One identity for the portal and for agent runs** (clarified 2026-11-10). People sign in with
  Auth0, the identity provider for people, at the portal and at the hosted agent (011, amended by
  this feature), so a run's verified requester names the user. System identities keep the
  organization's directory and never name a user. Locally, the existing dev issuer stands in. The
  plan chooses the sign-in mechanics.
- **People who onboarded under the earlier sign-in start again** (clarified 2026-11-10). A user's
  identifier comes from their sign-in, so the move to Auth0 gives everyone a new one. Earlier
  users, wallets and policies stay in the ledger, untouched and unreachable; nothing is migrated
  or linked. Funds left in an earlier test account are not moved.
- **One provider for sign-in and for approvals is accepted.** The deployment's approver already
  answers through Auth0 (012). Using the same provider for people's sign-in means one service
  now stands behind both who may change a policy and who approves a payment. Their credentials,
  clients and permissions stay separate, and an approval still has to verify against the exact
  payment.
- **The agent service is trusted to name the user.** L2 can't verify the person itself, because
  their credential is never forwarded to it (Constitution V). A compromised agent service could
  name another user; it would still be bound by that user's policy and by the platform limits.
  It could also name no user and spend from the platform account, within today's mandate, as any
  run can today. This is a new accepted residual risk.
- **System identities keep today's behavior** (clarified 2026-11-10). A pipeline or service
  allowed to start runs spends from the platform account under the deployment's mandate, so the
  deployment's regression check needs no user, wallet or policy. Tying a system identity to a
  person's wallet is out of scope.
- **Several policies, split by seller, under one user daily ceiling** (clarified 2026-11-10).
  One active policy per seller keeps the decision deterministic: exactly one policy, or none,
  applies to any payment. Budgets are per policy. The user daily ceiling bounds what all of a
  user's policies can spend together, so a user's exposure in 24 hours is never more than that
  ceiling. It starts as today's daily budget (0.50 USDC), is the same for every user, and is not
  editable by users.
- **Policy fields are today's mandate fields.** Where: allowed hosts, picked from the operator's
  seller list, which also supplies the allowed payees (clarified 2026-11-10). How much:
  auto-approve limit, per-payment cap, session ("run") budget and daily budget. How: payments per
  minute, end date, and the payment method. Schemes, networks, assets and the timeout range come
  from the deployment and the platform limits, not from the user.
- **Approvals are unchanged** (clarified 2026-11-10). Escalations go to the deployment's approver
  by phone (012) and to the operator (004, 010). A user approving their own payments, in the
  portal or by phone, is a later feature.
- **Platform limits start from today's mandate** (planning, 2026-11-10: they live in their own
  file, `config/platform.json`, with today's values; the mandate file stays the platform
  account's rules, unchanged; plan research R12). The deployment's mandate values are the
  starting point for both. With one mandate today, the
  default limits are today's values, and the seller list starts as today's allowed hosts and
  payees.
- **Constants.** At most 10 active policies per user, 20 sellers per policy and 5 cards per user;
  balances at most 30 seconds old; identity confirmed within 15 minutes for loosening changes.
  They are constants, like the 300-second escalation window.
- **Where profiles are kept is for the plan.** Profiles must stay out of the append-only ledger
  (FR-046). The plan chooses the store, and says whether "no persistent database beyond JSONL"
  needs amending. Planning, 2026-11-10: one small file per user, owned by the portal; no
  database, so that constraint stays (plan research R9). Policy names and card nicknames are kept
  there or at the card vault too, so no text a user types reaches the control layer (R6).
- **Where user account keys are kept is for the plan.** Today the single payer key is an
  environment variable, in Key Vault in Azure. The plan chooses how per-user keys are created and
  kept inside the signer's boundary. Planning, 2026-11-10: one mnemonic held by the signer, and
  each user's account derived at an index recorded in the ledger; nothing is stored per user
  (plan research R3).
- **"Per day" means the last 24 hours,** as the daily budget counts today (L2-5).
- **Out of scope:** a payment history view (the wallet shows the balance, the committed amount
  and the last 24 hours' spending), notifications, shared or team wallets, delegating a policy to
  another person, spending reports, and editing platform limits in the portal.
- **Not AP2.** A policy written in the portal is not an AP2 mandate (EXT-1). EXT-1 remains a
  separate extension.
- **Constitution amendment (MINOR)**:
  - multi-tenancy leaves the out-of-scope list;
  - Principle I's "the agent never edits policy" is restated for the portal: people edit policy
    there, the agent never does;
  - Principle V gains two credentials: the portal's role credential and the card vault credential,
    each held by one process;
  - the residual risks gain: the agent service is trusted to name the user; the portal is a new
    public entry point, where a stolen sign-in could loosen a policy up to the platform limits.
- **SPEC.md changes** (for the plan):
  - **§1.2, §1.3:** multi-user in scope; cards registered only; card payments still out.
  - **§3.1, §3.3:** the portal process, its role credential and the card vault credential.
  - **§4.1:** an architecture rule confining the card vault credential, and one for per-user keys.
  - **§7:** the user on `PaymentIntent`, and the user, policy and version on decisions.
  - **L2-1:** the mandate per user and policy, bounded by the platform limits.
  - **L2-2:** the new rules `user_not_onboarded` and `user_disabled`; the context computed per
    user and policy; the user daily ceiling, checked with `daily_budget_exceeded`.
  - **L2-3:** one signing account per user.
  - **L2-4:** the new entry types (FR-044) and fields (FR-045).
  - **L2-5:** the routes the portal uses, with the portal's token; the user's identifier in the
    escalation reads.
  - **L2-8 (new section):** the portal.
  - **L1-6:** the agent service passes the verified requester as the user.
  - **CFG-2, CFG-3:** the portal's settings; the mandate file as platform limits.
  - **§11:** new SEC rows: cross-user access, a stolen portal sign-in, card data exposure, a
    forged user on a payment request.
  - **§12:** new tests for each must-fail check in NFR-007, the portal's routes, and an end-to-end
    run with two users.
