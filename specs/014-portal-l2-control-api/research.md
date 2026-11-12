# Research: Portal Administration (014)

Phase 0 of [plan.md](plan.md). Each item records one decision, why, and what else was considered. Everything here
was settled from the repository as it stands after 013 (SPEC v1.10); no outside service is new, so no item depends
on an unverified external fact. The one inherited unknown is 013's `auth_time` behavior (013 research R5), which
approvals now also rely on ([R6](#r6-identity-confirmation-for-approvals)).

## R1: New administration routes in L2, or a second role on the operator's routes

**Decision**: six new routes under `/v1/admin/`, each accepting exactly one role, `portal-admin`. The operator's
six routes are not touched.

| Operator route (unchanged) | Administration route (new) |
|---|---|
| `GET /v1/escalations` | `GET /v1/admin/escalations` |
| `GET /v1/escalations/events` | `GET /v1/admin/escalations/events` |
| `POST /v1/approvals/:authorizationId` | `POST /v1/admin/escalations/:authorizationId/approve` |
| `POST /v1/rejections/:authorizationId` | `POST /v1/admin/escalations/:authorizationId/reject` |
| `GET /v1/budget/:sessionId` (agent's) | `GET /v1/admin/escalations/:authorizationId` (the escalation with its budget) |
| `GET /v1/ledger/verify` | `GET /v1/admin/ledger/verify` |

**Rationale**:
- `ENDPOINT_ROLES` maps each endpoint to exactly one role, and T-API-01..04 check the OpenAPI document against it.
  A route that two tokens open would end that rule for the whole table.
- The administration requests are not the operator's. An approval carries who decided and when they confirmed
  their identity; a rejection carries a reason code and never free text; the budget is reached through an
  escalation, never by a session or a user typed by the caller.
- FR-019 wants the operator's path unchanged. Leaving its routes alone proves it with the existing tests.
- Both families call the same pure functions (`escalationState`, `pendingEscalations`, `escalationEvents`) and one
  shared decision core ([R4](#r4-one-decision-core-for-every-path)), so the state machine can't drift.

**Alternatives considered**:
- *Let `portal-admin` open the operator's routes too.* Fewer routes, but two roles per endpoint, optional body
  fields whose meaning depends on the token, and the operator's free text reachable with the portal's credential.
- *Give the portal the operator's token.* Forbidden by INV-13 and rule A12, and it would make the portal able to
  do everything an operator can, with free text.

## R2: The portal's second credential

**Decision**: a sixth role, `portal-admin`, with its own token variable `PORTAL_ADMIN_TOKEN`. L2 verifies it; the
portal holds it beside `PORTAL_TOKEN`. L2 refuses to start if it equals any other role's token. In the portal it
is read by `config.ts` and used by one module, `admin-client.ts` (rule A13,
[config-and-secrets.md](contracts/config-and-secrets.md#41-architecture-rules)).

**Rationale**: FR-028 asks for a credential that opens the administration capabilities and nothing else, while
`PORTAL_TOKEN` still opens only user accounts. Two tokens make both statements checkable at L2 with the existing
guard (`requireRole`), and the constitution's sentence about the user-account credential stays true word for
word. It also gives the off switch a hard edge: without the token, L2 has nothing to accept.

**Alternatives considered**:
- *Widen `PORTAL_TOKEN`.* Redefines Principle V ("MUST NOT … approve, reject"), a MAJOR amendment, and every
  user-account code path in the portal would hold a credential that approves.
- *A separate administration process and Azure unit.* It would keep the public user portal unable to approve
  even when compromised. Rejected for now: the administration screens must be reachable from a browser too, so
  the new process would be just as public; it doubles the unit, image, vault and pipeline work; and the spec asks
  for the capabilities "in the portal". The module confinement (A13) is the cheap part of that isolation. The
  residual risk is recorded ([R12](#r12-what-a-compromised-portal-can-do)).

## R3: Who an administrator is

> **Superseded in its mechanism by [R20](#r20-after-the-merge-of-main-the-administrator-is-a-permission-of-the-sign-in-tenant)** (2026-11-12).
> The decision that stands: a separate permission, assigned by the organization, read from the verified token. What
> follows describes it as an app role of the organization's directory, which is how it was first built.

**Decision**: a second app role on the existing API app registration, `Portal.Admin`, assigned to people by
`pre-deploy.bicep` from a new parameter `portalAdmins` (user principal names), exactly as `agentUsers` assigns
`Agent.Run`. The portal reads it from the verified token's `roles` claim.

- The portal's access check accepts a person who holds `Agent.Run`, `Portal.Admin`, or both, and records which.
  With the administration area off it requires `Agent.Run`, as today.
- The 013 routes require `Agent.Run` (403 otherwise). The `/api/admin/*` routes require `Portal.Admin`.
- `/api/me` gains two additive fields, `user` and `admin`. For a person with `Portal.Admin` only it returns
  `{ userId, user: false, admin: true }` and no onboarding or profile.
- The hosted agent already requires `Agent.Run` (`requester-auth.ts`), so an administrator without it can't start
  runs. Nothing changes there.
- **When the permission is taken away** (spec, Edge Cases): the role is in the token, and the portal makes no
  directory call. The person's next token no longer carries it and every `/api/admin` route refuses them (T-PRT-10).
  A token issued before keeps working until it expires, about an hour with Entra's default lifetime. In that time
  a rejection is possible, and an approval only with a sign-in under 15 minutes old. Revoking the person's sessions
  in Entra, or turning the area off, ends it at once. SPEC §11 records this as a residual risk of v1.15.

**Rationale**: one sign-in, one token, one place where the organization grants access. An app role reaches the
portal in the same `roles` claim it already reads, so no directory lookup and no new package. FR-003's "holding
one MUST NOT give the other" is then a property of two independent role values.

**Alternatives considered**:
- *Membership of the operators' group* (`grp-op-…`). Needs a `groups` claim or a Graph call, and couples the
  portal to who may start the operator job, which is a different permission.
- *A list of administrator identifiers in the portal's env.* A second place to manage people, outside sign-in.
- *A separate route for "who am I" (`/api/session`).* Cleaner in isolation, but the web app already starts from
  `/api/me`; two additive booleans keep one start-up call.

## R4: One decision core for every path

**Decision**: the body of today's approval and rejection handlers moves into two functions in
`approval-routes.ts`, `recordApproval(ctx, escalationId, by)` and `recordRejection(ctx, escalationId, by)`. They
run inside the serialized section: sweep, derive the state, and either return the existing outcome or append one
entry. The operator's routes and the administration routes both call them; only `by` differs:

```text
by = { channel: "operator", label, ttlSeconds, reason? }             // today's operator request
by = { channel: "portal", decidedBy, identityConfirmedAtMs, reasonCode? }   // new
```

The backchannel path (012) keeps its own writer, which already checks the same state in the same section.

**Rationale**: FR-017 and FR-018 are statements about one state machine. One function that both families call is
the simplest way to make "exactly one final state" true by construction, and T-E2E-07 and T-LED-04 keep proving
the operator's half.

**Alternatives considered**: a second handler written beside the first. It would start identical and drift.

## R5: What a portal decision records

**Decision**: no new ledger entry type. The two existing ones gain a third channel value and, for a rejection, a
reason code ([data-model.md](data-model.md#ledger-entries)):

- `HUMAN_APPROVAL.data`: `channel: "portal"`, `approver: <the administrator's usr_ identifier>`,
  `identityConfirmedAtMs`, and the usual `approvalId, escalationId, resourceKey, payTo, amount, expiresAtMs`.
  The validity is the constant 600 s; a portal request can't choose it.
- `HUMAN_REJECTION.data`: `channel: "portal"`, `approver: <usr_ identifier>`, `reasonCode`, and the usual fields.
  No `operator` label and no `reason` text.
- `DecisionChannel` becomes `"operator" | "backchannel" | "portal"`; `channelOf` returns `portal` for the new
  value and still reads an entry without a channel as `operator`.
- Events gain one whitelisted field, `reasonCode`. `decidedBy` is the identifier.

**Rationale**: everything that reads decisions (`escalationState`, `findOpenApproval`, `findRejection`, R15, the
012 wait) keys on the entry type, so a portal decision takes effect through code that is already tested. An
approval is consumed, lapses and is re-evaluated exactly as an operator's is (INV-12). The auditor's question in
SC-007, which path and who, is answered by two fields.

**Alternatives considered**: new types `ADMIN_APPROVAL` and `ADMIN_REJECTION`. Every consumer above would need a
second case, for no gain an extra field doesn't give.

## R6: Identity confirmation for approvals

> The claim is no longer the directory's `auth_time`: see [R20](#r20-after-the-merge-of-main-the-administrator-is-a-permission-of-the-sign-in-tenant). The decision stands.

**Decision**: the portal passes the token's `auth_time` as `identityConfirmedAtMs` on an approval, and L2 judges
it with the existing `stepUpFresh` (15 minutes, 60 s tolerance). A stale or missing value is 403
`step_up_required` with `maxAgeSec: 900`, and nothing is appended. A rejection carries no such field and needs
none. The web app reuses its step-up function: sign in again from a click, then replay the request once.

**Rationale**: FR-014, and the line 013 already draws (loosening needs it, tightening does not). L2 stays the
judge, so a portal bug can't waive it. The check runs after the state check: a person is never asked to sign in
again for an escalation that is already decided or expired.

**Alternatives considered**: judging freshness in the portal (the control layer could then not prove it, and the
must-fail test would have nothing to switch off in L2); a shorter window for approvals (a second constant for no
stated need).

**Inherited unknown**: whether Entra's `auth_time` moves on a forced sign-in and stays put across a silent renewal
is 013's open check (013 research R5, task T114). If it fails, approvals fail closed (always `step_up_required`),
and the fallback discussion there covers this feature too. The administration area must not be turned on in a
deployment until that check has passed.

## R7: Deciding one's own payment

**Decision**: L2 compares the decider with the escalation's owner (`escalationOwner`, from the `ESCALATED`
entry). Equal identifiers: 403 `own_payment`, nothing appended, for an approval and for a rejection alike. The
portal also marks such an item (`mine: true`) and the web app offers no buttons on it. An escalation of the
platform account has no owner, so any administrator may decide it.

**Rationale**: FR-015 says the control layer checks it. Both identifiers are already `usr_` values derived from
the same tenant and object ID, so the comparison is exact. Blocking the rejection too keeps the rule one
sentence; a person can still stop their own spending by pausing the policy or disabling their account (013).

**Alternatives considered**: allowing an administrator to reject their own payment. Harmless in effect, but it
makes the rule depend on the direction of the decision, and the spec says "decide".

## R8: Rejection reasons

**Decision**: five codes, required on every portal rejection: `not_expected`, `amount_too_high`, `wrong_seller`,
`duplicate`, `other`. The web app shows a label for each. An unknown or missing code is a 400. No text field
exists anywhere in the administration area.

**Rationale**: FR-016, and hard rule 11 (no text a person typed in the portal reaches L2 or the ledger). The R15
violation the agent sees already carries only the rejection ID (SEC-12), so the code reaches the ledger and the
trail and nothing else.

**Alternatives considered**: an optional reason (the trail then says nothing about most rejections); free text
kept in the portal's own store (a new store, for text nobody decides on).

## R9: The budget behind an escalation

**Decision**: `GET /v1/admin/escalations/:authorizationId` returns the escalation in any state, its decision when
it has one, and a `budget` object built by the same function the decision uses for its context. That function is
extracted from `decideOnce` in `service.ts` as `budgetLines(owner, sessionId, resourceUrl, nowMs)`:

| Line | A user's payment | The platform account's payment |
|---|---|---|
| `run` | the applicable policy's run budget, for this session | the mandate's session budget, for this session |
| `day` | that policy's daily budget, last 24 h | the mandate's daily budget, last 24 h |
| `userDay` | the user daily ceiling, last 24 h, all policies | absent |

Each line is `{ capAtomic, spentAtomic, remainingAtomic }`. With them come `autoApproveMaxAtomic`,
`hardCapPerPaymentAtomic`, `applies` (false when no active policy lists the seller now, or the user is disabled
or not onboarded) and `fits`: true only when `applies` and the amount is within the cap and within every
remaining amount. The figures are as of the read, against the policy as it is now, which is what the retry will
be judged against (INV-12).

**Rationale**: FR-022 to FR-024. Using the decision's own function means the figures can't disagree with the
decision that follows. Reaching it through the escalation keeps the rule that no portal route takes a user
identifier (FR-023): the owner and the session come from the ledger entry.

**Alternatives considered**: letting `portal-admin` call `GET /v1/budget/:sessionId?userId=`. It needs the
caller to supply a session and a user, returns only one of the three lines at a time, and would be a second role
on the agent's endpoint.

## R10: Keeping the list current

**Decision**: polling, with no new transport. The web app reads the pending list every 3 s and the trail every
5 s, only while the screen is open and the tab is visible. The countdown ticks in the browser from `expiresAt`,
corrected by the difference between the portal's `readAt` and the browser's clock.

**Rationale**: FR-008 asks for 5 s. The operator's own `escalations --watch` polls L2 once a second, and L2's
read is one linear pass. A polling administrator makes about 32 requests a minute, well inside the 120 a minute
each person is allowed. Server-sent events would need a held connection through the Azure ingress, a per-person
connection limit and a second code path, for a list that changes a few times an hour.

**Alternatives considered**: server-sent events; WebSockets (a new dependency and a `connect-src` change); push
notifications (out of scope in the spec).

## R11: Reading the trail in pages

**Decision**: the administration events route takes `limit` (1 to 200, default 50) and one of two cursors:

- `after=<seq>`: up to `limit` events with a higher sequence number, oldest first. This is what polling uses.
- `before=<seq>`: the `limit` events just below it. This is "show earlier".
- neither: the latest `limit` events. This is the first page.

Every answer is oldest first and carries `first` and `last` (the sequence numbers of the page's ends),
`cursor` (the ledger's last sequence number at the read) and `more`. The screen remembers, in memory, the ledger's
position when it opened and marks what arrives after it as new.

**Changed during implementation (2026-11-11)**: the first design kept the highest sequence number shown in
`localStorage`, to mark events "new since your last visit". The web app's standing safety test (T-WEB-07, SEC-21)
forbids `localStorage` in any source file, and a convenience marker is no reason to relax it. The mark now covers
only what arrives while the screen is open. FR-021 is unaffected: reading by cursor still yields every event once.

**Rationale**: the operator's events route returns everything after a cursor, which is right for a watcher that
never stops and wrong for a screen opened once a week on a ledger that only grows. Sequence numbers are the
ledger's own order, so "each exactly once, in order" (FR-021) follows from the cursor arithmetic.

**Alternatives considered**: time-based paging (two entries can share a millisecond); reusing the operator's
route and cutting the list in the portal (the whole trail would cross the wire on every first page).

## R12: What a compromised portal can do

**Decision**: accept the risk, bound it, and write it down. L2 never sees the administrator's sign-in
(Constitution V), so it trusts the portal to name the decider and the time of their identity confirmation. A
portal under an attacker's control could therefore approve pending escalations in any administrator's name.

What still holds, whatever the portal sends:
- an approval lifts only the approval requirement, for one exact payment, once (INV-12);
- the payment must pass every rule again at payment time, under the user's policy and the platform limits;
- only an escalation that is pending can be approved, so an attacker must also get an agent run to ask;
- the portal holds no key and no route to authorize or reconcile (FR-027, rules A4 and A12);
- every such approval is in the ledger with its path, so it is visible afterward.

**Rationale**: the alternative that removes the trust is the 012 design, where L2 verifies the approver's signed
answer itself. Doing that here means forwarding the person's token to L2, which Constitution V forbids, or a
second signing service. Both are larger than this feature. The spec's Assumptions accept the risk.

**Alternatives considered**: L2 verifying the administrator's Entra token (breaks "the requester credential is
never forwarded"); requiring a phone approval as well (that is 012, which already exists beside this).

## R13: Turning it on, and what "off" means

**Decision**: one switch, `PORTAL_ADMIN=1`, read by L2 and by the portal.

- **L2**: on needs `USER_ACCOUNTS=1` and `PORTAL_ADMIN_TOKEN`, checked before the ledger lock; a failure names
  the variable. Off: the six routes are not mounted (404) and the token variable is ignored, its name logged once.
- **Portal**: on needs `PORTAL_ADMIN_TOKEN`. Off: `/api/admin/*` is not mounted, `Portal.Admin` counts for
  nothing, `/api/config` says `admin: { available: false }`, and `/api/me` says `admin: false`.
- **Azure**: `userAccounts.administration` (a boolean in the existing plain object) sets the variable in both
  apps. Both apps always reference a new secret, `portal-admin-token`, seeded as `off` until the feature is
  turned on, like `portal-token` (013) and `ciba-client-credential` (012).

**Rationale**: FR-001. The same shape as 012 and 013, so the local demo, every existing test and an untouched
deployment see no difference (NFR-006). A request without a token still gets 401 from the portal's access check
before any route is matched, on or off.

**Alternatives considered**: deriving "on" from the presence of the token (a seeded `off` value would then need
special-casing in two places); a portal-only switch (L2 would mount routes that accept a default dev token
locally with the feature notionally off).

## R14: Reads write nothing

**Decision**: the three administration reads derive state from the entries and the clock and never call `sweep`.
The two decisions call it first, as the operator's do.

**Rationale**: FR-033. The operator's reads sweep so that a just-expired escalation has its entry before the
CLI prints it. `pendingEscalations` and `escalationState` already apply the 300 s boundary from the clock, so a
read is correct without the entry, and L2's own 1 s timer records the expiry at most a second later. A read
that writes would also put a public, polled route on the ledger's write path.

**Alternatives considered**: sweeping in the reads for symmetry with the operator's (a browser tab left open
would then be what writes expiry entries).

## R15: The ledger check from the portal

**Decision**: `GET /v1/admin/ledger/verify` returns what the operator's route returns. The portal adds
`checkedAt` and keeps the last answer for 10 s, shared by all administrators.

**Rationale**: FR-025. `verifyChain` reads the whole ledger on L2's single thread, the same thread that decides
payments. A 10 s floor means no number of administrators or reloads can make it run more than six times a
minute (NFR-004). The screen runs it on a button, not on a timer.

**Alternatives considered**: no cache (the per-person limit would allow 120 full passes a minute per
administrator); running the check in the portal (it has no ledger, by design).

## R16: Shapes that cross the portal and L2

**Decision**: the escalation view and event types move from `src/layer2-control/escalations.ts` to
`src/shared/contracts.ts`, and `escalations.ts` re-exports them. The new shapes (`EscalationDetail`,
`EscalationBudget`, `BudgetLine`, `DecisionOutcome`, `RejectionReasonCode`, `LedgerCheck`, `EventPage`) are
added there too ([control-api.md](contracts/control-api.md#7-contract-changes-srcsharedcontractsts)).

**Rationale**: hard rule 1 (a layer imports only shared code and its own folder) and "cross-layer types live only
in `contracts.ts`". The portal must not import from L2. The operator's scripts keep compiling through the
re-export.

**Alternatives considered**: redeclaring the shapes in the portal (two definitions of one wire format).

## R17: Local development

**Decision**:
- `npm run stack:local -- --users --admin`: L2 with user accounts and the administration routes on.
- `PORTAL_ADMIN=1 npm run portal`.
- `npm run dev-token -- --subject carol --portal --admin`: a portal token that also carries `Portal.Admin`. With
  `--no-role` it carries only `Portal.Admin`.
- The VS Code launch configurations are unchanged: they pass only `API_DOCS` and the debugger's variables, so the
  administration area stays off there. T-DEV-01..03 are untouched.

**Rationale**: the same flags-over-env pattern as 013's `--users`. Keeping VS Code out avoids changing the
T-DEV tables for a feature that is off by default.

**Alternatives considered**: turning administration on whenever `--users` is given (a local stack would then
differ from "off by default" without anyone asking).

## R18: Testing approach

**Decision**: the 013 pattern, one level per risk.

- **Pure**: channel and event derivations for the new value (T-LED-07).
- **L2 in process** (`test/admin.test.ts`, T-ADM-01..10): routes, the six-token matrix, both decisions, the
  step-up boundary, the own-payment check, races between the three paths, the budget lines against the decision's
  own context, paging, config and the off switch.
- **Portal in process** (`test/portal-admin.test.ts`, T-PRT-10..14) against a fake `AdminPort` and the dev
  issuer: access, mapping, what is taken from the token only, the log, the cache.
- **Web app** (jsdom, T-WEB-09..12): navigation by role, the list and its countdown, deciding, the trail, the
  ledger check, accessibility.
- **End to end** (T-E2E-14) on the local chain: a real escalation approved and another rejected through the
  portal's HTTP API, with L3 confirming the paid one.
- **Architecture, OpenAPI, IaC**: T-ARCH-A13, T-API-01..04 and 12..15, T-IAC-01 rules 16 and 22.

Five must-fail switches, all test-only deps ([plan.md](plan.md#proofs-constitution-viii)).

**Rationale**: Constitution VIII. The authority-bearing checks sit in L2 and are tested there without any UI.

## R19: Delivery in slices

**Decision**: four slices, each mergeable with the feature off and leaving `npm run check` green.

1. **L2**: contracts, the decision core, the six routes, the role, config, T-ADM, T-LED-07. Holds every authority
   check and four of the five proofs.
2. **Portal backend**: access by role, `admin-client.ts`, `/api/admin/*`, rule A13, T-PRT-10..14, T-E2E-14.
3. **Web app**: the four screens, T-WEB-09..12.
4. **Azure and docs**: the app role, the secret, the parameter, T-IAC-01, SPEC v1.15, the constitution, `CLAUDE.md`.

**Rationale**: the same order as 013: authority first and without a screen, the public surface second.

## R20: After the merge of main, the administrator is a permission of the sign-in tenant

**Context**: 014 was built against SPEC v1.10, where people signed in with the organization's directory (Microsoft
Entra ID) and a user was whoever held its app role `Agent.Run`. Before 014 merged, 013 changed that twice on main:

1. v1.12 and v1.13: people sign in with Auth0, and the portal accepts no token of the directory.
2. v1.14 (013 research R21): the portal asks for no role and no permission. Whoever signs in through the portal's
   client is a user, and the tenant had no role and no permission left.

**Decision** (2026-11-12, at the merge):

- An administrator is a person whose portal token carries `portal:admin`, a permission of people's API in the
  Auth0 tenant. It is the only permission that API defines, and it is held by the only role, `x402-admin`, which
  holds nothing else. `auth0/main.tf` defines both and assigns nobody; an administrator of the tenant gives the role
  to a person by hand. T-IAC-02 checks all of it.
- Every signed-in person is a user, so an administrator is one too. The `user` flag, the "administrator who is not
  a user" branches of the portal and the web app, and the `/api/me` answer for such a person are removed. `/api/me`
  gains `admin` only.
- Nothing of 014 is in Entra: no app role, no `portalAdmins` parameter, no change to T-IAC-01 rule 16. Rule 22 (the
  administration token and switch in Azure) is unchanged.
- The time of the identity confirmation comes from the tenant's sign-in time claim (`AUTH_TIME_CLAIM`, set by a
  post-login Action), as for 013's step-up since v1.12. L2's check (R6) is unchanged.
- The numbers 014 first used were taken on main meanwhile: it is SPEC v1.15, constitution 1.7.0 and SEC-27..SEC-29.

**Rationale**: 013's reason for dropping the user role was that a new sign-up should get in without a manual step,
and Auth0 has no default role. That reason doesn't apply to administrators: they are few, and giving someone the
power to release other people's payments should be a deliberate act by whoever runs the tenant. A permission in
the token keeps the portal's check offline, as R3 wanted, and keeps 014 out of the directory, which the portal no
longer trusts for people.

**Consequences**:

- FR-003 is amended (spec.md, session 2026-11-12): signing in gives no administrator permission, and an
  administrator is always a user.
- A role taken away takes effect when the person's access token expires, an hour at most (`token_lifetime` in
  `auth0/`); revoking their sessions or blocking the user in the tenant is immediate (SPEC §11, T-PRT-10).
- In a deployed environment no person's token starts an agent run (v1.13). Administrators there see the platform
  account's escalations only; the rule against deciding one's own payment and the per-user budget line are
  exercised locally.
- The gate for turning the area on is 013's check of the tenant's sign-in time claim (its task T140), no longer T114.

**Alternatives considered**:
- *A list of administrators' identifiers in the portal's configuration.* No tenant change, but a second place to
  manage people, and a redeployment to add or remove one (rejected in R3 already).
- *Keeping the directory's app role for administrators only.* The portal would have to accept two issuers for
  people again, which v1.12 removed on purpose.
- *A custom claim set by a sign-in Action from the user's metadata.* It needs the Action to read who is an
  administrator from somewhere, which is the role assignment under another name, with more code in the tenant.
