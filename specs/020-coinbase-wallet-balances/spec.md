# Feature Specification: Connected Platforms in the L2 Portal: Coinbase Balances

**Feature Branch**: `020-coinbase-wallet-balances`

**Created**: 2026-11-25

**Status**: Draft

**Input**: User description: "As User I want to get access to my wallet and balances from L2 portal. First platform to integrate coinbase, Once I have complete the registration in L2 portal I want to have the option to connect to coinbase and get my balances"

## Clarifications

### Session 2026-11-25

- Q: Which Coinbase does a user connect? → A: Their Coinbase account: the exchange and app, where Coinbase holds
  the funds for them. They sign in at Coinbase and agree to read-only access there. A self-custody wallet
  address (Coinbase Wallet, the Base app) is out of scope.
- Q: How long does a connection last? → A: Until the user disconnects it, their account is disabled, or
  Coinbase stops accepting it. The portal keeps the read-only grant, protected and confined to one place, and
  keeps it usable without asking the user again.
- Q: Which figures does the wallet show for Coinbase? → A: Every asset with funds in its own units, plus
  Coinbase's own value of each in the user's currency and a Coinbase total, labeled as Coinbase's valuation.

## Reading the request against the repository

The portal of feature 013 already gives a user a wallet: one crypto account that the control layer (L2) creates
and signs with, its USDC balance on the network, the amount committed and the amount spent in the last 24 hours
(013 FR-013..FR-017). This feature does not replace that wallet. It adds **connected platforms**: outside accounts
the user already has, whose balances the portal shows next to the wallet. Coinbase is the first such platform and
the only one in this feature. Connecting one gives the portal permission to **read** balances. It never gives
anyone, the agent included, a way to move, spend or sign with those funds.

| Request | This spec |
|---|---|
| "get access to my wallet and balances from L2 portal" | One wallet view: the L2 account (unchanged, spendable by the user's agent) and every connected platform (view only), each balance with the time it was read (US2). |
| "First platform to integrate coinbase" | Coinbase is the only platform offered. Each connection names its platform, so a later platform is a new feature, not a redesign (FR-004). |
| "Once I have complete the registration in L2 portal" | Offered once the user has a profile and their account is not disabled (FR-002). Connecting is optional: it is not an onboarding step and changes no onboarding status (FR-003). |
| "the option to connect to coinbase and get my balances" | Connect through Coinbase's own sign-in and consent, read-only (US1); see the balances (US2); disconnect at any time (US4). |

## User Scenarios & Testing *(mandatory)*

Terms used below:
- **User**: a person signed in to the portal with a profile (feature 013). Only users connect platforms.
- **Wallet**: the user's payment methods from feature 013: one crypto account held by the control layer, and any
  registered cards. The crypto account is the only thing the user's agent can pay from.
- **Connected platform**: an outside service where the user already holds funds, linked to their portal account
  so the portal can show those balances. Coinbase is the only one in this feature.
- **Connection**: the link between one user and one connected platform. It is connected, needs reconnecting
  (the platform no longer accepts it) or disconnected.
- **Grant**: the permission the user gives at Coinbase, on Coinbase's own pages, for the portal to read their
  balances. It is a credential: whoever holds it can read that Coinbase account.
- **View only**: a balance shown to the user for their information. It never pays for anything and never
  changes what the agent may spend.

### User Story 1 - A registered user connects their Coinbase account (Priority: P1)

A user who has finished registering opens their wallet and sees "Connect Coinbase". They choose it and the
portal sends them to Coinbase. They sign in there, as they always do, and Coinbase shows what the portal asks
for: permission to read their accounts and balances, nothing else. They agree and Coinbase sends them back to
the wallet, where Coinbase shows as connected, with the date. The portal never sees their Coinbase password or
second factor.

**Why this priority**: Nothing else in this feature works without a connection. It is also where the trust is
decided: the user must see that the portal asks only to read.

**Independent Test**: With a stand-in Coinbase, sign in as a user with a profile and connect. Check that the
request asked for read access only, that the wallet shows Coinbase as connected, and that the stand-in received
no request to move funds. Then sign in as a person with no profile, and as a user whose account is disabled:
neither is offered a connection, and a connection request from either is refused.

**Acceptance Scenarios**:

1. **Given** a user with a profile whose account is not disabled, **When** they open the wallet, **Then** they
   see an option to connect Coinbase, with one sentence saying that the portal will only read balances and that
   the agent can't spend Coinbase funds.
2. **Given** that option, **When** the user chooses it, **Then** they go to Coinbase's own sign-in and consent
   page, which lists read access to accounts and balances only.
3. **Given** the consent page, **When** the user agrees, **Then** they return to the wallet, Coinbase shows as
   connected with the date, and its balances follow (User Story 2).
4. **Given** the consent page, **When** the user cancels or refuses, **Then** they return to the wallet with a
   message that nothing was connected, and nothing is kept.
5. **Given** a person signed in with no profile yet, or a user whose account is disabled, **When** they open the
   wallet or send a connection request, **Then** no connection is offered or made.
6. **Given** a user who already has a Coinbase connection, **When** they connect again (a second tab, a retry),
   **Then** they still have one connection: the new grant replaces the old one, and the old one is revoked at
   Coinbase.

---

### User Story 2 - The user sees their balances in one place (Priority: P1)

The wallet now shows two parts. The first is the L2 account, as today, marked "Your agent pays from this".
The second is Coinbase, marked "View only": every asset in the user's Coinbase account that holds funds, with
its amount, Coinbase's value of it in the user's currency, a Coinbase total, and the time it was read. The user
can refresh. If Coinbase can't be reached, the wallet still shows the L2 account and the last Coinbase balances,
marked as not current.

**Why this priority**: Seeing the balances is what the user asked for. Keeping the two parts apart is what keeps
the user from thinking the agent can spend Coinbase funds.

**Independent Test**: Give the stand-in Coinbase a user with three assets that hold funds (one with 18 decimal
places) and one empty asset. Open the wallet: the three appear with their exact amounts and values, the total
is the exact sum of the values, the empty one doesn't appear, and the read time is shown. Make the stand-in fail: the wallet still loads, the L2 account is current and the
Coinbase part is marked as not current with the last read time.

**Acceptance Scenarios**:

1. **Given** a connected user, **When** they open the wallet, **Then** they see the L2 account (address,
   network, USDC balance, committed, spent in the last 24 hours, as in feature 013) and, apart from it, the
   Coinbase balances marked view only.
2. **Given** a Coinbase asset with funds, **When** it is shown, **Then** its amount is exactly the amount
   Coinbase reports, with no rounding, with the asset's name, Coinbase's value of it in the user's currency and
   the time it was read.
3. **Given** the Coinbase part, **When** it is shown, **Then** it ends with a total of those values, labeled as
   Coinbase's valuation at the read time, and never added to the L2 account.
4. **Given** shown balances, **When** the user refreshes, **Then** the Coinbase part is read again, at most once
   every 10 seconds per user, and shows the new read time.
5. **Given** a connected user, **When** Coinbase can't be reached or is slow, **Then** within 5 seconds the
   wallet shows the L2 account as usual and the Coinbase part as not current, with its last read time, or as
   "couldn't be read" if it was never read.
6. **Given** a connection that Coinbase no longer accepts (the user removed the access at Coinbase, or it
   expired), **When** the wallet reads it, **Then** Coinbase shows "Reconnect to see your balances" and no old
   balances.
7. **Given** a user with no connection, **When** they open the wallet, **Then** the wallet looks as it does in
   feature 013, plus the option to connect.

---

### User Story 3 - Coinbase balances stay private and never become spending power (Priority: P1)

Connecting Coinbase changes nothing about what the user's agent can do. The agent still pays only from the L2
account, under the user's own expense policies. It can't see that Coinbase is connected, let alone the
balances. The control layer, its ledger, the administrators and the operator never see them either. Only the
user does.

**Why this priority**: The system's first rule is that payment authority sits in one place, with one signer.
A Coinbase grant that leaked into a payment decision, or a balance that reached the ledger, would break that
rule and expose a person's financial data.

**Independent Test**: Run the same agent run for a user twice, once without a connection and once with one.
Every decision, budget figure and ledger entry about the payments is identical. Then scan the ledger, the
control layer's requests, every log, every agent answer and the browser's storage for the stand-in's known
values (the grant, the Coinbase account identifier, each balance): they appear nowhere. A second user's
requests for the first user's connection get "not found".

**Acceptance Scenarios**:

1. **Given** a connected user, **When** their agent pays, **Then** the payment is decided, signed and counted
   exactly as it would be without the connection.
2. **Given** a connected user, **When** their agent checks its budget, **Then** the answer is the same as
   without the connection and names no platform or balance.
3. **Given** any connection, **When** the ledger, the logs, the control layer or the agent are inspected,
   **Then** none of them holds the grant, a Coinbase account identifier, a balance, or a name or email from
   Coinbase.
4. **Given** two users, **When** one asks for the other's connection or balances, **Then** the answer is "not
   found", the same answer as for a connection that doesn't exist.
5. **Given** an administrator in the portal's administration area, **When** they review an escalated payment,
   **Then** they see nothing of the person's connected platforms.

---

### User Story 4 - The user disconnects Coinbase (Priority: P2)

The user chooses "Disconnect Coinbase". The portal revokes its access at Coinbase, forgets the grant and stops
showing the balances. The user can connect again later.

**Why this priority**: A user must be able to take back a permission as easily as they gave it. It comes after
the first three because a user can already remove the access from Coinbase's own settings.

**Independent Test**: Connect, then disconnect. The wallet no longer shows Coinbase balances, the stand-in
received a revocation for that grant, and the grant no longer works there. Make the stand-in's revocation fail:
the portal still forgets the grant and tells the user to remove the access in Coinbase's settings.

**Acceptance Scenarios**:

1. **Given** a connected user, **When** they disconnect, **Then** within 10 seconds the grant is revoked at
   Coinbase and forgotten by the portal, and the wallet shows the option to connect again.
2. **Given** Coinbase can't be reached, **When** the user disconnects, **Then** the portal still forgets the
   grant, and tells the user that Coinbase didn't confirm and how to remove the access in Coinbase's settings.
3. **Given** a user who disables their portal account (feature 013), **When** the account is disabled, **Then**
   their Coinbase connection is disconnected as in scenario 1.
4. **Given** a disconnected user, **When** they connect again, **Then** it works as a first connection.

---

### User Story 5 - The operator controls the integration (Priority: P3)

Connected platforms are off unless the operator turns them on for a deployment. The operator registers the
project's own Coinbase application by hand and puts its credential in the portal's vault only. When the
integration is off, or Coinbase is down, the rest of the portal and every agent payment work as usual.

**Why this priority**: The feature adds a credential and an outside dependency. The operator must be able to
leave it out, and switch it off, without touching anything else.

**Independent Test**: Start the portal with the integration off: no wallet view offers a connection, and a
connection request is refused. Turn it on without the credential: the portal refuses to start and says which
setting is missing. With it on, stop the stand-in Coinbase and run the regression run: its summary is
unchanged.

**Acceptance Scenarios**:

1. **Given** a deployment with the integration off, **When** a user opens the wallet, **Then** there is no
   option to connect, and a connection request is refused.
2. **Given** the integration on but its credential missing or invalid, **When** the portal starts, **Then** it
   refuses to start and names the missing setting, never its value.
3. **Given** user accounts off, **When** the integration is turned on, **Then** the portal refuses to start:
   connected platforms need user accounts.
4. **Given** the integration turned off after users connected, **When** a user opens the wallet, **Then**
   Coinbase shows as unavailable on this deployment, and no request reaches Coinbase.

---

### Edge Cases

- **The return from Coinbase is not one this user started**: the connection completes only for the person and
  the sign-in that started it, once, within 10 minutes. A return that is forged, replayed, too old or started by
  another person is refused, and nothing is connected.
- **The user signs out, or their sign-in expires, while at Coinbase**: the return is refused; they sign in and
  connect again.
- **The user grants less than asked** (Coinbase lets them untick a permission): if the portal can't read
  balances with what was granted, the connection is refused with that reason and the grant is revoked.
- **The grant comes back with more than read access**: the connection is refused and the grant is revoked at
  once. The portal never keeps a grant that could move funds.
- **Two tabs connect at the same time**: the user ends with one connection; the other grant is revoked.
- **The same Coinbase account is connected by two users**: each connection is that user's own. The portal never
  tells one user that another connected the same account.
- **Many assets**: every asset with funds is shown, up to 200; past that the wallet says how many more there are.
- **Assets with no funds**: not shown.
- **An asset Coinbase gives no value for**: it is shown in its own units with "no value from Coinbase", and the
  total says that it leaves that asset out.
- **Unusual names or amounts from Coinbase** (markup, very long text, many decimal places): names are shown as
  plain text, cut to a readable length; amounts are shown exactly, never through a lossy conversion.
- **Coinbase rate-limits the portal**: the wallet shows the last balances marked not current, and the portal
  waits before reading that user again.
- **The portal restarts**: a connection the user didn't end is still there after the restart (FR-011).
- **The user's portal account is disabled while connected**: the connection is disconnected (US4 scenario 3).
- **An administrator connects their own Coinbase**: like any user, for their own account only.

## Requirements *(mandatory)*

### Functional Requirements

**Access**

- **FR-001**: Connected platforms MUST be off unless the operator turns them on for the deployment, and MUST
  need user accounts on. With them off, no connection is offered or made, and nothing reaches Coinbase.
  *(SPEC: proposed L2-8, CFG-2)*
- **FR-002**: Only a signed-in user with a profile, whose account is not disabled, MAY connect a platform or
  see a connection's balances. *(SPEC: L2-8)*
- **FR-003**: Connecting a platform MUST be optional. It MUST NOT be an onboarding step, and it MUST NOT change
  the user's onboarding status or the answer the hosted agent gets when it asks whether the person can pay
  (feature 019). *(SPEC: L2-8, L1-6 the account question)*
- **FR-004**: Coinbase MUST be the only platform offered. Each connection MUST name its platform, so that a
  later platform adds a connection of its own kind. The Coinbase connection is to the user's Coinbase account,
  where Coinbase holds the funds for them; a self-custody wallet address is not a connection in this feature
  (clarified 2026-11-25). *(SPEC: proposed L2-8)*
- **FR-005**: A user MUST be able to reach only their own connection. A request for another user's connection
  or balances MUST get "not found", the same answer as for one that doesn't exist. No route MAY take a user
  identifier: the user comes from the verified sign-in. *(SPEC: L2-8, SEC-19)*

**Connecting**

- **FR-006**: A connection MUST start only from an action of the user in the portal, and MUST go through
  Coinbase's own sign-in and consent pages. The portal MUST NOT ask for, receive or keep the user's Coinbase
  password, second factor or recovery details. *(SPEC: proposed L2-8)*
- **FR-007**: The portal MUST ask Coinbase for read access to the user's accounts and balances only. It MUST
  NOT ask for any permission to send, trade, buy, sell, convert or withdraw, nor for profile data it doesn't
  show. *(SPEC: proposed §3.3, Constitution I and V)*
- **FR-008**: A grant that carries any permission beyond reading MUST be refused and revoked at once. A grant
  that can't read balances MUST be refused with that reason and revoked. *(SPEC: proposed §11)*
- **FR-009**: A connection MUST complete only for the person and the portal sign-in that started it, only
  once, and only within 10 minutes of the start. Any other return from Coinbase MUST be refused, and nothing is
  connected. *(SPEC: proposed §11)*
- **FR-010**: A user MUST have at most one Coinbase connection. Connecting again MUST replace the grant and
  revoke the old one. *(SPEC: proposed L2-8)*
- **FR-011**: A connection MUST last until the user disconnects it, their account is disabled, or Coinbase
  stops accepting it, and MUST survive a restart of the portal (clarified 2026-11-25). While it lasts, the
  portal MUST keep the grant usable without asking the user to connect again. *(SPEC: proposed L2-8)*

**Balances**

- **FR-012**: For a connected user the wallet MUST show the Coinbase balances apart from the L2 account and
  marked view only, and MUST mark the L2 account as the one the agent pays from. *(SPEC: L2-8, Constitution
  I)*
- **FR-013**: The wallet MUST show each Coinbase asset that holds funds, with its name, its exact amount as
  Coinbase reports it, Coinbase's value of it in the user's currency, and the time it was read. Below them the
  wallet MUST show the total of those values, labeled as Coinbase's valuation at the read time; an asset with
  no value from Coinbase is shown without one and named as left out of the total (clarified 2026-11-25). The
  total MUST NOT include the L2 account. Assets with no funds MUST NOT be shown. At most 200 assets
  are listed; past that the wallet says how many more there are. *(SPEC: proposed L2-8)*
- **FR-014**: Balances MUST be at most 60 seconds old when shown, or marked not current with their read time.
  The user MAY ask for a fresh read, at most once every 10 seconds. *(SPEC: proposed L2-8)*
- **FR-015**: Amounts and values MUST be kept and shown exactly as decimal values, and the total MUST be an
  exact decimal sum, never through floating-point arithmetic. *(SPEC: Constitution VI, hard rule 8)*
- **FR-016**: A failure to read Coinbase MUST NOT fail the wallet view: within 5 seconds the L2 account is shown
  as usual and the Coinbase part as not current or not readable. *(SPEC: proposed L2-8)*
- **FR-017**: When Coinbase no longer accepts a grant, the connection MUST show as needing reconnecting, with
  no old balances, until the user reconnects or disconnects. *(SPEC: proposed L2-8)*

**Disconnecting**

- **FR-018**: A user MUST be able to disconnect at any time. Disconnecting MUST revoke the grant at Coinbase,
  forget it in the portal and stop showing the balances, within 10 seconds. If Coinbase doesn't confirm the
  revocation, the portal MUST still forget the grant and tell the user how to remove the access in Coinbase's
  settings. *(SPEC: proposed L2-8)*
- **FR-019**: Disabling a portal account (013) MUST disconnect its connections as in FR-018. *(SPEC: L2-8)*

**Separation from payments**

- **FR-020**: No connection, grant or Coinbase balance MAY be an input to a payment decision, a budget, an
  expense policy, an approval or a reconciliation. *(SPEC: INV-5, INV-7, Constitution II and III)*
- **FR-021**: No funds MAY move in this feature: no payment, transfer, top-up or withdrawal from or to a
  connected platform. The L2 account stays the only account the agent pays from. *(SPEC: §1.3, INV-2)*
- **FR-022**: The agent MUST NOT get a tool, input, route or credential for connected platforms. Its tools
  stay `fetch_resource` and `check_budget`, and `check_budget`'s answer is unchanged. *(SPEC: L1-3, L1-6,
  Constitution I)*
- **FR-023**: No grant, Coinbase account identifier, balance, or name or email from Coinbase MAY reach the
  control layer, its ledger, the agent, the model, the administration area or a log. *(SPEC: INV-13, rule 11
  of the hard rules, §11)*
- **FR-024**: Connecting and disconnecting MUST be recorded in the audit trail, naming only the user, the
  platform, an identifier the portal makes, and the time. *(SPEC: L2-4 entry types, 013 FR-044's card events)*

**Credentials and data**

- **FR-025**: The project's Coinbase application credential MUST be held by the portal only and confined to one
  module, enforced by an architecture rule like A8, A9 and A10; no other process's settings MAY hold it. It
  MUST never become payment authority. *(SPEC: §3.3, §4.1, Constitution V)*
- **FR-026**: A user's grant MUST be held only where FR-025's credential is, protected at rest, and MUST NOT be
  sent to the browser, another process, the model or a log. *(SPEC: §3.3, Constitution V)*
- **FR-027**: Balances MUST NOT be stored beyond a short-lived cache in the portal's memory, and MUST be shown
  only to the user they belong to. *(SPEC: proposed L2-8, §11)*
- **FR-028**: Text from Coinbase (asset names, account names) MUST be shown as text, never as markup, and the
  web app MUST NOT keep any of it in the browser's storage. *(SPEC: L2-8, T-WEB-07)*
- **FR-029**: The portal's log lines about connections MUST name only the event and the portal's identifier
  for the connection. *(SPEC: L2-8 log whitelist, SEC-16)*

### Non-Functional Requirements

- **NFR-001 (Security)**: Every check in FR-005, FR-008, FR-009, FR-020 and FR-023 MUST have a test that fails
  when the check is switched off, through a test-only switch, never a setting. *(SPEC: Constitution VIII)*
- **NFR-002 (Privacy)**: The feature MUST keep the least Coinbase data that shows the balances: no history, no
  transactions, no profile data. *(SPEC: §11)*
- **NFR-003 (Availability)**: Payment decisions, the regression run and every other portal screen MUST work
  the same with Coinbase down or the integration off. *(SPEC: 013 NFR-005, §13)*
- **NFR-004 (Performance)**: With Coinbase answering, the wallet with balances MUST show within 3 seconds.
- **NFR-005 (Testability)**: Every test MUST use a stand-in Coinbase, as feature 012's tests use a stand-in
  approval service. No test reaches the real Coinbase.
- **NFR-006 (Regression)**: The local demo summary MUST stay unchanged (`spent on-chain: 0.006 USDC`,
  `hash chain ok=true`). *(SPEC: §13, definition of done)*

### Key Entities

- **Connected Platform**: an outside service the portal can read balances from. Coinbase is the only one.
- **Connection**: one user's link to one platform: the platform, the portal's own identifier for it, its status
  (connected, needs reconnecting, disconnected), when it was connected and when it was last read. At most one
  per user and platform.
- **Grant**: the permission the user gave at Coinbase, read only. A credential, held in one place only and
  forgotten on disconnect.
- **Platform Balance**: one asset's amount at the platform, with its name and the time it was read. Shown to the
  user, kept only briefly in memory, never stored or sent to another process.
- **Connection Event**: the audit record of a connect or a disconnect: user, platform, the portal's identifier,
  time. Nothing from Coinbase.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A registered user connects Coinbase and sees their balances in under 2 minutes, from the wallet,
  on the first attempt.
- **SC-002**: For 100% of assets shown, the amount and the value equal what Coinbase reported at the read time,
  and the total equals the exact sum of the values shown, with 0 rounding differences.
- **SC-003**: The connection request asks for 0 permissions beyond reading accounts and balances, and 100% of
  grants with more are refused and revoked.
- **SC-004**: A known-value scan finds 0 occurrences of a grant, a Coinbase account identifier or a balance in
  the ledger, the control layer's requests, the logs, the agent's answers and the browser's storage.
- **SC-005**: With and without a connection, 100% of payment decisions, budget figures and ledger entries about
  payments are identical, and the local demo summary is unchanged.
- **SC-006**: In a two-user test, 0 requests by one user return anything of the other's connection.
- **SC-007**: 100% of forged, replayed, expired or other-person returns from Coinbase connect nothing.
- **SC-008**: After a disconnect, the balances are gone and the grant no longer works at Coinbase within 10
  seconds.
- **SC-009**: With Coinbase down, 100% of wallet views still load within 5 seconds with the L2 account current.

## Assumptions

- **Read only.** "Get my balances" means seeing them. Moving funds between Coinbase and the L2 account (for
  example, topping up the L2 account from Coinbase) moves money and is a later feature with its own decisions.
- **"Registration complete" means a profile.** The user has finished the profile step of feature 013 and their
  account is not disabled. A wallet and a first policy are not needed to connect Coinbase, since seeing
  balances doesn't spend.
- **A real-money account, for the first time.** Until now the system touched test funds only. A Coinbase
  account holds real money. Reading its balances, never moving them, is a scope change that the constitution
  must state (see the amendment below). Networks for payments stay `local` and `base-sepolia`.
- **The project's own Coinbase application.** The operator registers it with Coinbase by hand, as the Google
  application of feature 018 was made. Its credential goes into the portal's vault only, never into a file the
  project keeps, a parameter file or GitHub.
- **Coinbase's consent is the identity check.** Connecting needs no extra identity confirmation in the portal:
  the user signs in to Coinbase and agrees there. Seeing balances needs the user's normal portal sign-in.
- **No check across users.** The portal doesn't stop two users from connecting the same Coinbase account,
  since saying so would tell one user about the other.
- **Constants**: 10 minutes to complete a connection; balances at most 60 seconds old; a fresh read at most
  every 10 seconds per user; 5 seconds before a slow read shows as not current; at most 200 assets listed; one
  connection per user and platform.
- **For the plan**: how the grant is protected at rest and with which key; how the portal reads Coinbase; how
  connection events reach the audit trail without any Coinbase data; the stand-in Coinbase for tests; the
  must-fail switches.
- **Coinbase's valuation, not ours.** The value of each asset and the total are Coinbase's, in the currency
  Coinbase reports for the user, at the read time. The system computes no exchange rate of its own.
- **Out of scope**: other platforms; a self-custody wallet address (clarified 2026-11-25); moving, sending, trading or converting funds; transaction history;
  notifications; letting the agent see or use connected balances; a combined total across the L2 account and
  connected platforms; administrator or operator views of anyone's connected balances.
- **Constitution amendment (MINOR)**:
  - Technology & Scope: reading a user's own balances at a connected platform, read only, comes into scope;
    moving funds to or from it stays out. Coinbase is reached over HTTPS from the portal only.
  - Principle V gains two credentials: the project's Coinbase application credential and each user's read-only
    grant, both held by the portal only and confined to one module.
  - Residual risks gain: a stolen portal sign-in can see that person's connected balances; a compromised portal
    can read the connected accounts of every user, and nothing more; Coinbase learns that the project's
    application reads the account.
- **SPEC.md changes (for the plan)**:
  - **L2-8**: connected platforms in the wallet, their routes, the switch and the refusals.
  - **§1.3**: reading real-money balances in, moving them out of scope.
  - **§3.3, §4.1**: the two credentials and the architecture rule that confines them.
  - **L2-4**: the connection events, if they go to the ledger.
  - **CFG-2**: the portal's settings for the integration.
  - **§11**: new SEC rows: a grant wider than read, a forged return from Coinbase, a grant exposed, Coinbase
    data reaching the control layer, one user seeing another's balances.
  - **§12**: tests for each must-fail check, the portal's new routes and their API description, and the
    wallet view.
