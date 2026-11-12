# Implementation Plan: Portal Administration: the Rest of the Control API in the Portal

**Branch**: `014-portal-l2-control-api` | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/014-portal-l2-control-api/spec.md`, with the two clarifications of
session 2026-11-10 (everything a person reads or decides, never the two machine capabilities; administrators
only, through a separate permission).

> **Amended at the merge of main, 2026-11-12** ([research R20](research.md#r20-after-the-merge-of-main-the-administrator-is-a-permission-of-the-sign-in-tenant)).
> This plan was written against SPEC v1.10. Where it says the administrator is the app role `Portal.Admin` of the
> organization's directory, assigned through `pre-deploy.bicep` (`portalAdmins`) and checked by T-IAC-01 rule 16,
> read: the permission `portal:admin` of the Auth0 tenant, held by the role `x402-admin`, defined in `auth0/` and
> checked by T-IAC-02. Where it describes a person who is an administrator and not a user, read: there is none,
> since every signed-in person is a user. `auth_time` is the tenant's sign-in time claim, and 013's task T114 is
> its T140. The feature is SPEC v1.15, constitution 1.7.0 and SEC-27..SEC-29. Everything about L2 stands as written.

## Summary

The portal already reaches every user-account route of L2 (013). This feature gives it the rest of what a person
does with the control API: see pending escalations, approve or reject them, follow their events, see the budget
behind one, and check the ledger. Requesting a payment authorization and reporting a settlement stay with the
agent and L3.

- **Six administration routes in L2**, under `/v1/admin/`, for a sixth role, `portal-admin`, with its own token.
  The operator's routes are not touched; both families share one decision core and the same pure derivations
  ([R1](research.md#r1-new-administration-routes-in-l2-or-a-second-role-on-the-operators-routes),
  [R4](research.md#r4-one-decision-core-for-every-path)).
- **No new ledger entry type.** A portal decision is a `HUMAN_APPROVAL` or `HUMAN_REJECTION` with
  `channel: "portal"`, the administrator's identifier and, for a rejection, a reason code from a fixed list
  ([R5](research.md#r5-what-a-portal-decision-records)).
- **L2 keeps the checks that matter**: only a pending escalation can be decided; nobody decides their own
  payment; an approval needs an identity confirmation within 15 minutes; an approval never overrides a rule that
  denies (INV-12).
- **The portal** gains `/api/admin/*`, open only to a person whose token carries a new app role,
  `Portal.Admin`. The decider and the time of their identity confirmation come from the verified token, never
  from the request. A second client module holds the second token; an architecture rule keeps the two halves of
  the portal apart ([R2](research.md#r2-the-portals-second-credential),
  [R3](research.md#r3-who-an-administrator-is)).
- **The web app** gains four screens: the waiting list (polled every 3 s), one payment with its budget and the
  two decisions, the activity trail, and the ledger check.
- **Reads write nothing**: they derive state from the entries and the clock ([R14](research.md#r14-reads-write-nothing)).
- **Azure**: one more app role, one more always-referenced secret in two vaults, one boolean in `userAccounts`.
  No new unit, image or pipeline.

Off by default (`PORTAL_ADMIN=1` in L2 and in the portal turns it on, and it needs `USER_ACCOUNTS=1`), so the
local demo and every existing test are unchanged.

Contract changes: `DecisionChannel` gains `"portal"`, `EscalationEvent.reasonCode?`, the escalation views move
to `src/shared/contracts.ts`, and the administration shapes are added
([control-api.md](contracts/control-api.md)). `PaymentIntent`, `AuthorizationDecision` and `BudgetStatus` are
unchanged.

## Technical Context

**Language/Version**: TypeScript (strict), ESM, Node.js ≥ 22.13 (development on Node 26). The web app is TypeScript
with JSX, compiled for browsers by Vite.

**Primary Dependencies**: nothing new, at run time or at build time. Server: `express`, `jose` (through
`src/shared/entra-token.ts`), `express-rate-limit` (already on `/api`). Web app: React and
`@azure/msal-browser`, as pinned by 013.

**Storage**: the existing hash-chained JSONL ledger, with new field values on two existing entry types
([data-model.md](data-model.md#ledger-entries)). No new store, in L2, the portal or the browser.

**Testing**: vitest. Pure tests for the derivations; in-process L2; in-process portal against a fake
administration client and the dev issuer; component tests in jsdom; one end-to-end test on the local chain; the
architecture, OpenAPI and IaC tests ([R18](research.md#r18-testing-approach)).

**Target Platform**: the local multi-process PoC on loopback (feature off by default), and the Azure profile on
Base Sepolia. Modern evergreen browsers for the web app.

**Project Type**: a multi-process service with a three-layer split, plus the portal (backend and web app) of 013.

**Performance Goals**:
- an open waiting list is at most 5 s old (FR-008): polled every 3 s;
- the list within 2 s of opening the area, and a decision's outcome within 2 s of confirming it (NFR-007): one
  call to L2 each, a linear pass over the ledger;
- a decision within 30 s of opening the area for a signed-in administrator (SC-001);
- the ledger check at most once in 10 s, whoever asks ([R15](research.md#r15-the-ledger-check-from-the-portal)).

**Constraints**:
- L2 still binds 127.0.0.1 only and gains no public route (FR-031);
- every endpoint of L2 still accepts exactly one role; the operator's routes and CLI are unchanged (FR-019);
- a decision's state check and its append are one synchronous block inside the serialized section, with no
  network call inside it;
- the policy engine is not touched; an approval lifts only R14, once, for one exact payment;
- the ledger stays append-only; reads append nothing; no typed text, name, email or token enters it;
- no portal route takes a user identifier (FR-023); the decider comes from the verified token;
- the `demo:local` summary and the L1-4 baseline are unchanged (NFR-006).

**Scale/Scope**: a handful of administrators; escalations live 300 s, so the waiting list holds a few items;
the trail grows with the ledger and is read 50 events at a time. Six L2 routes, six portal routes, four screens.
A linear ledger scan per read, as today.

No item is NEEDS CLARIFICATION. [research.md](research.md) records each decision (R1–R19). One external fact is
inherited, not new: the behavior of Entra's `auth_time`, which 013 still has to confirm (its task T114) and which
approvals now also rely on ([R6](research.md#r6-identity-confirmation-for-approvals)).

## Constitution Check

*GATE: must pass before Phase 0 research, and again after Phase 1 design.*

| Principle | Check | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of payment authority | Deciding and signing stay in `src/layer2-control/`. The portal gains no key and no route to authorize or reconcile (FR-027); rules A1, A4, A11 and A12 still cover it. The agent gains no tool, input, route or credential (FR-005); `CONTROL_TOKEN` is refused on every administration route. L3 is untouched. A person, never the agent, approves or rejects, as today. | PASS, with the amendment below | PASS. T-ADM-02 proves the token matrix |
| II. Deterministic, pure policy | `policy.ts` is not changed. An approval from the portal is the same `HUMAN_APPROVAL` entry: it lifts only the approval requirement, for one exact tuple, once, and never overrides a DENY (INV-12). The decision is recorded in the serialized section (INV-8). The reason code and the decider are never a decision input. | PASS | PASS. T-ADM-03 re-runs the INV-12 cases with a portal approval |
| III. Ledger is the single source of truth | The list, the trail, the detail and the budget are derived from the ledger per request; nothing is cached as truth, and no counter is added. Reads append nothing. Decisions append one entry of an existing type. | PASS | PASS. The portal's 10 s cache holds only the last ledger-check answer, which decides nothing |
| IV. Trust the chain | Settlement and L3 are unchanged. The portal can't report a settlement (FR-027). | PASS | PASS |
| V. Least-privilege credentials | One new credential, `PORTAL_ADMIN_TOKEN`, a sixth role with its own routes; held by the portal and confined to one module (rule A13). `PORTAL_TOKEN` still opens only user accounts, so the constitution's sentence about it stays true as written. The administrator's token is verified by the portal and never forwarded. L2 keeps its loopback bind. | PASS, with the amendment below | PASS. One process now holds two role credentials, each for its own role; no credential authorizes two roles |
| VI. Exact money arithmetic | Budget lines are atomic strings computed with `BigInt` by the decision's own function; the browser formats them with the existing `money.ts`. | PASS | PASS |
| VII. Protocol fidelity | x402 handling is not touched. | PASS | PASS |
| VIII. Proven safety | Five must-fail proofs ([Proofs](#proofs-constitution-viii)). Every new route, field and rule has a test. | PASS | PASS |
| Quality gates | typecheck, the full suite, an unchanged demo summary, SPEC v1.15 in the same change, requirement IDs in test names. | PASS | PASS |

**Amendments made in the same change, not violations** (the spec's Assumptions asked for them):

- **Constitution 1.4.0 → 1.5.0 (MINOR).** No principle or invariant is removed or redefined.
  - Principle V's first bullet lists a sixth caller role (portal→control, administration).
  - Principle V gains one bullet: the administration credential opens only the control layer's administration
    routes; it MUST NOT open a user-account route, authorize or reconcile; it is held by the portal only and
    confined to one module (A13); the portal relays an administrator's decision and never signs.
  - The existing bullet about the portal role credential is kept word for word.
  - Residual risks gain: the portal is trusted to name the administrator who decided; a stolen administrator
    sign-in can approve pending escalations within the policies' limits, after a fresh sign-in.
- **SPEC §11 SEC-8** is amended: the operator's token is no longer the only credential that can decide an
  escalation. The agent still can't.

No unjustified violation, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/014-portal-l2-control-api/
├── spec.md
├── plan.md                      # this file
├── research.md                  # Phase 0: R1–R19
├── data-model.md                # Phase 1: permissions, entries, the decision steps, views
├── quickstart.md                # Phase 1: validation guide, local to Azure
├── contracts/
│   ├── control-api.md           # L2-5 delta and §7: the sixth role, the six administration routes
│   ├── portal-api.md            # browser → portal: access by role, the six routes, the log
│   ├── portal-ui.md             # the four screens
│   └── config-and-secrets.md    # CFG-2, §3.3, rules A12 and A13, Azure
├── checklists/requirements.md
└── tasks.md                     # Phase 2 (/speckit-tasks)
```

### Source code (repository root)

```text
src/
├── shared/
│   ├── contracts.ts             # CHANGED  escalation views moved here; DecisionChannel + "portal"; reasonCode;
│   │                            #          EscalationDetail, EscalationBudget, BudgetLine, EventPage,
│   │                            #          DecisionOutcome, LedgerCheck, REJECTION_REASON_CODES
│   ├── config.ts                # CHANGED  role portal-admin, PORTAL_ADMIN_TOKEN, its dev default
│   └── auth.ts                  # CHANGED  ENDPOINT_ROLES gains the six routes
├── layer2-control/
│   ├── admin-routes.ts          # NEW      the six routes (PORTAL_ADMIN_TOKEN); own-payment and step-up checks
│   ├── approval-routes.ts       # CHANGED  recordApproval, recordRejection: the shared decision core
│   ├── escalations.ts           # CHANGED  re-exports the moved types; channelOf; reasonCode on events;
│   │                            #          escalationDetail, eventPage (pure)
│   ├── service.ts               # CHANGED  budgetLines extracted from decideOnce; adminFromEnv; mounts
│   └── policy.ts, ledger.ts, signer.ts, users.ts, user-routes.ts, backchannel.ts   # unchanged
├── portal/
│   ├── access.ts                # CHANGED  Person.user, Person.admin; either role admits; requireUser, requireAdmin
│   ├── admin-client.ts          # NEW      the only caller of L2's administration routes (A13)
│   ├── admin-routes.ts          # NEW      /api/admin/*; mine; the 10 s ledger-check cache; log labels
│   ├── routes.ts                # CHANGED  the 013 routes require `user`; /api/me gains user and admin
│   ├── server.ts                # CHANGED  /api/config admin flag; mounts the administration routes when on
│   ├── config.ts                # CHANGED  PORTAL_ADMIN, the administration token
│   └── control-client.ts, cards.ts, card-vault.ts, profile-store.ts, balance.ts   # unchanged
├── portal-main.ts               # CHANGED  builds the AdminClient when on
└── layer1-intent/, layer3-settlement/, counterparty/     # unchanged

web/portal/src/
├── api.ts, types.ts             # CHANGED  the six calls and their shapes; Me.user, Me.admin; Config.admin
├── routes.ts, app.tsx           # CHANGED  /admin…; navigation by role; administrator-only people
├── messages.ts                  # CHANGED  the new error codes and reason labels
├── poll.ts                      # NEW      a visibility-aware interval (pure, testable)
└── screens/admin/               # NEW      Waiting.tsx, Payment.tsx, Activity.tsx, LedgerCheck.tsx
web/portal/test/admin.test.tsx   # NEW      T-WEB-09..12

env/l2-control.env.example, env/portal.env.example   # CHANGED
docs/l2-control.openapi.yaml, docs/portal.openapi.yaml   # CHANGED
scripts/
├── demo-lib.ts, stack-local.ts  # CHANGED  --admin
├── dev-issuer-lib.ts, dev-token.ts   # CHANGED  --admin (the Portal.Admin role)
└── escalations.ts               # CHANGED  prints the portal channel, decider and reason code
infra/
├── pre-deploy.bicep, pre-deploy.dev.bicepparam   # CHANGED  the Portal.Admin role, portalAdmins
├── main.bicep, main.dev.bicepparam               # CHANGED  userAccounts.administration; fail() without enabled
└── modules/l2-apps.bicep, portal-apps.bicep      # CHANGED  portal-admin-token, PORTAL_ADMIN

test/
├── admin.test.ts                # NEW      T-ADM-01..10
├── portal-admin.test.ts         # NEW      T-PRT-10..14
├── helpers/portal.ts            # CHANGED  a fake AdminPort; administrator tokens
├── fixtures/arch/a13-violation.ts   # NEW
└── ledger, architecture, e2e.local, openapi, openapi-portal, infra, portal   # CHANGED
```

**Structure Decision**: no new process, folder or image. L2's new code is one route module beside the existing
ones, so the signer, the ledger and the serialized section are shared with nothing new. The portal's
administration half is two new modules, `admin-client.ts` and `admin-routes.ts`, kept apart from the user-account
half by rule A13. The web app's screens sit in their own folder.

## Design

### The decision core (`approval-routes.ts`)

Today's two handlers become two functions that the operator's routes and the administration routes both call
inside `serialize`:

```ts
type By =
  | { channel: "operator"; label: string; ttlSeconds: number; reason?: string }
  | { channel: "portal"; decidedBy: string; identityConfirmedAtMs?: number; reasonCode?: RejectionReasonCode };

recordApproval(ctx, escalationId, by, guards?): { status: number; body: … }
recordRejection(ctx, escalationId, by, guards?): { status: number; body: … }
```

Each sweeps, derives the state, returns the existing outcome for a non-pending escalation, runs `guards` (none
for the operator), and appends one entry. The operator's routes keep their request and response shapes exactly;
their handlers only translate. The steps and their order are in
[data-model.md](data-model.md#a-decision-from-the-portal-step-by-step).

### The administration routes (`admin-routes.ts`)

- Mounted only when `deps.users` and `deps.admin` are both set. Guard: `requireRole("portal-admin")`, before any
  body is read.
- `approve` and `reject` pass two guards to the core: the own-payment check (`escalationOwner(entries, id) ===
  decidedBy`) and, for an approval, `stepUpFresh(identityConfirmedAtMs, t)`.
- The three reads don't sweep and don't serialize: they take `ledger.entries()` and one clock read.
- `GET …/:authorizationId` builds `EscalationDetail` from `escalationDetail(entries, id, t)` (pure, in
  `escalations.ts`) and `budgetLines(…)`.

### The budget (`service.ts`)

The part of `decideOnce` that builds the policy context for an owner, a session and a resource is extracted as
`budgetLines(owner, sessionId, resourceUrl, t)`. `decideOnce` calls it; so does the detail route. One function
means the figures an administrator sees are the ones the retry will be judged against
([R9](research.md#r9-the-budget-behind-an-escalation)). T-ADM-08 compares them.

### The portal (`src/portal/`)

- `access.ts`: after the unchanged token checks, `user` and `admin` are set from `roles`; 403 when neither.
  Two small guards, `requireUser` and `requireAdmin`, answer 403 with the same body.
- `routes.ts`: every 013 route but `/api/me` gets `requireUser`. `/api/me` answers an administrator-only person
  without calling L2.
- `admin-client.ts` implements `AdminPort` with the same `call` shape as `ControlClient` (5 s timeout,
  `redirect: "error"`, 401 and 5xx as "unavailable"), but with `PORTAL_ADMIN_TOKEN` and only the six paths.
- `admin-routes.ts`: maps views (`mine`, `amountAtomic`, no `sessionId`), refuses any body field but
  `reasonCode`, takes `decidedBy` and `identityConfirmedAtMs` from `res.locals.person`, labels the log line.
- `server.ts` mounts the administration routes only when the config has the token and the switch.

### The web app (`web/portal/`)

Screens and behavior are in [portal-ui.md](contracts/portal-ui.md). `poll.ts` is one function: run a callback
every N ms while `document.visibilityState` is `visible`, and stop on unmount. Approving reuses 013's step-up
function behind a "Confirm it's you" button.

### Azure

Per [config-and-secrets.md](contracts/config-and-secrets.md#azure): the role and its assignments in
`pre-deploy.bicep`; the secret and the switch in the two app modules; rule 22.

## Requirement traceability

| Requirement | Where | Test |
|---|---|---|
| FR-001 off by default | `adminFromEnv`, portal `config.ts`, mounts | T-ADM-10, T-PRT-14, T-E2E-01 unchanged |
| FR-002, FR-003 administrators only; a separate permission | `access.ts`, `pre-deploy.bicep` | T-PRT-10, T-IAC-01 rule 16 |
| FR-004 refusals reveal and record nothing | `requireAdmin` before any L2 call | T-PRT-10, T-ADM-02 |
| FR-005 the agent gains nothing | tools unchanged; A12 extended | T-ADM-02, T-ARCH-A12 |
| FR-006 an administrator is not a super-user | `requireUser`; no user-account call in the administration half (A13) | T-PRT-10, T-ARCH-A13 |
| FR-007, FR-008 the waiting list, current | `pendingEscalations`; 3 s poll | T-ADM-08, T-PRT-11, T-WEB-10 |
| FR-009, FR-010 identifiers only; no secret or untrusted markup | view whitelists; text rendering | T-LED-07, T-PRT-13, T-WEB-12 |
| FR-011, FR-012 approve and reject, same effect as the operator's | `recordApproval`, `recordRejection` | T-ADM-03, T-ADM-04, T-E2E-14 |
| FR-013 confirm before deciding | the two dialogs | T-WEB-11 |
| FR-014 identity confirmation for approvals, judged by L2 | `stepUpFresh` in the guard | T-ADM-05, T-PRT-12, T-WEB-11 |
| FR-015 not one's own payment, checked by L2 | the own-payment guard; `mine` | T-ADM-06, T-WEB-11 |
| FR-016 fixed reasons; nothing reaches the agent | `REJECTION_REASON_CODES`; R15 detail unchanged | T-ADM-04, T-PRT-12 |
| FR-017, FR-018 one final state, serialized | the shared core inside `serialize` | T-ADM-07 |
| FR-019 the other paths unchanged | operator routes untouched; 012 untouched | T-E2E-02, T-E2E-07, T-E2E-10 unchanged; T-ADM-07 |
| FR-020, FR-021 the trail, exactly once | `eventPage` | T-ADM-09, T-WEB-12 |
| FR-022 to FR-024 the budget, through an escalation | `budgetLines`, `EscalationDetail` | T-ADM-08, T-PRT-11, T-WEB-11 |
| FR-025, FR-026 the ledger check, read-only | `verifyChain`; the 10 s cache | T-ADM-01, T-PRT-11, T-WEB-12 |
| FR-027 no machine capability | no route, no method, no token | T-ADM-02, T-ARCH-A12, A13 |
| FR-028, FR-029 a credential of its own | role `portal-admin`; A13; T-IAC-01 rule 22 | T-ADM-02, T-ARCH-A13, T-IAC-01 |
| FR-030, FR-031 no forwarded sign-in; no public route in L2 | `access.ts` deletes the header; loopback bind | T-PRT-12, T-PRT-13 |
| FR-032, FR-033 one entry per decision; reads write nothing | the core; reads without sweep | T-ADM-03, T-ADM-04, T-ADM-08 |
| FR-034 the portal's log | fixed labels, the route template | T-PRT-13 |
| NFR-001 fail closed | every refusal before the append; 502 on any L2 failure | T-ADM-01, T-PRT-11 |
| NFR-002 no new payment authority | INV-12 unchanged | T-ADM-03 |
| NFR-003 secrets | whitelists; scans | T-PRT-13, the scan in T-E2E-14 |
| NFR-004 availability | nothing on the decision path; the check cached | T-PRT-11, T-E2E-02 unchanged |
| NFR-005 proven safety | [Proofs](#proofs-constitution-viii) | the must-fail tests |
| NFR-006 regression | switch off | T-E2E-01, `demo:local`, T-PRT-14 |
| NFR-007 responsiveness | one L2 call per screen action | T-E2E-14 (timed), quickstart §2 |
| NFR-008 accessibility | [portal-ui.md](contracts/portal-ui.md#accessibility-and-layout-nfr-008) | T-WEB-10, T-WEB-12, manual pass |
| NFR-009 abuse limits | the existing `/api` limiters cover the new routes | T-PRT-10 |

## Proofs (Constitution VIII)

Each safety mechanism has a test that fails without it. The switches are test-only deps of
`createControlService` or `createPortalApp`, never environment variables.

| Mechanism | Switch | Without it | Test |
|---|---|---|---|
| The administrator permission (FR-002) | `skipAdminCheck` (portal) | a user with only `Agent.Run` approves a payment | T-PRT-10 |
| The own-payment check (FR-015) | `skipOwnPaymentCheck` (L2) | an administrator approves their own run's payment | T-ADM-06 |
| Identity confirmation for approvals (FR-014) | `skipDecisionStepUp` (L2) | a sign-in from a day ago approves | T-ADM-05 |
| Separate portal credentials (FR-028) | `singlePortalRole` (L2: the administration routes guarded by `portal-control`) | the user-account token approves | T-ADM-02 |
| One final state (FR-017, FR-018) | `skipPendingCheck` (L2) | a portal approval is recorded after an operator's rejection of the same escalation | T-ADM-07 |

The last one is worded for what the code does: the state check and the append are one synchronous block, so the
serialized section alone can't be switched off to show a race. Removing the check shows what it prevents.

## Tests defined here

The contracts define T-ADM-01..10, T-LED-07, T-PRT-10..14, T-WEB-09..12, T-E2E-14 and T-ARCH-A13, and the changes
to T-API-01..04 and 12..15, T-ARCH-A12, T-ARCH-ENV and T-IAC-01 (rule 16, new rule 22). Existing tests that must
pass unchanged, because they prove FR-019 and NFR-006: T-E2E-01, T-E2E-02, T-E2E-07, T-E2E-08, T-E2E-10 to 13,
T-LED-04, T-CIBA-01..14, T-USR-01..12, T-PRT-01..09 and T-WEB-01..08. Two of those change in a stated way only:
T-PRT-01's role row (a person with neither role is still 403) and T-USR-02's token matrix, which gains the sixth
token.

## SPEC and governance changes (same change)

SPEC.md v1.10 → **v1.15**, with a "Changes in 1.15" table:

| Section | Change |
|---|---|
| §1.2, §1.3 | administrators decide escalations in the portal; per-user approval, notifications and a payment history stay out |
| §2 | glossary: administrator, administration area, decision path |
| §3.1, §3.2 | the portal relays an administrator's decision to L2; it is still never on the payment decision path |
| §3.3 | the `PORTAL_ADMIN_TOKEN` row ([config-and-secrets.md](contracts/config-and-secrets.md#33-credential-matrix-one-new-row)) |
| §4, §4.1 | INV-13 names the sixth role; rule A12 extended, A13 new |
| §6 | the new files |
| §7 | the moved and new shapes |
| L2-4, L2-4.3 | `channel: "portal"`, `approver`, `identityConfirmedAtMs` and `reasonCode` on the two entries; three decision paths |
| L2-5 | the six administration routes and their token; the note on the operator's reads |
| L2-8 | the administration area: access by role, the portal's six routes, the changed `/api/me` and `/api/config` |
| CFG-2 | `PORTAL_ADMIN` and `PORTAL_ADMIN_TOKEN` in both env files |
| §11 | SEC-8 amended; SEC-25 a person who is not an administrator, or a stolen administrator sign-in, decides an escalation; SEC-27 a compromised portal approves in an administrator's name; SEC-28 an administrator approves their own payment. New residual risks |
| §12, §13 | the tests above; `stack:local -- --users --admin`, `dev-token -- --portal --admin` |

Also in the same change:
- `.specify/memory/constitution.md` → 1.5.0, with a Sync Impact Report.
- `specs/README.md`: the 014 row and the traceability rows (INV-13, L2-4, L2-5, L2-8, SEC-8, SEC-25..27, the new
  test IDs).
- `specs/007` contracts/threat-matrix.md: SEC-25..27 (`SEC_ROWS` goes to 27).
- `specs/013` contracts: a line in control-api.md and portal-api.md pointing to this feature for the
  administration routes and the `roles` row.
- `CLAUDE.md`: "What this repo is" (the portal relays an administrator's decision; it still holds no key), hard
  rule 10 (six roles), the commands, "New or changed portal route" (the administration half and A13), and the
  gotchas (seed `portal-admin-token` as `off`; the administration area needs 013's `auth_time` check).
- `README.md`, `docs/diagrams/x402-architecture.json`: the administration path.

## Delivery

Four slices, each mergeable with the feature off and each leaving `npm run check` green
([R19](research.md#r19-delivery-in-slices)): L2; the portal backend; the web app; Azure and documents.
`/speckit-tasks` orders the tasks along them. Slice 1 holds every authority check and four of the five proofs.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| A compromised portal approves in an administrator's name | pending escalations are released | bounded by INV-12, the policies and the platform limits; only pending items; a separate token confined to one module; every approval in the ledger with its path; accepted residual risk ([R12](research.md#r12-what-a-compromised-portal-can-do)) |
| A stolen administrator sign-in | the same, for as long as the session lasts | an approval needs credentials entered within 15 minutes, judged by L2; the token lives in session storage only; strict CSP |
| `auth_time` does not behave as assumed (013 R5, unverified) | approvals always refused, or accepted when stale | fail-closed default; 013's tenant check is a prerequisite for turning the area on (quickstart §6) |
| The decision core is refactored under the operator's routes | a regression in the existing approval path | the operator's tests are untouched and must pass first; the refactor lands alone, before any new route |
| An approval makes people expect a payment | confusion when the retry is denied | the budget and the "will not make it payable" warning; the confirm dialog says "if it still fits the rules" |
| A single administrator who is also the only user | their own escalations can't be decided in the portal | by design (FR-015); the command line and the phone remain, and the screen says so |
| Polling from many open tabs | load on L2's single thread | reads are one linear pass with no write and no lock; polling stops in hidden tabs; the per-person and per-address limits; the ledger check is cached |
| The secret is not seeded before the first deployment with 014 | the L2 or portal revision fails and is rolled back | the same pattern as 012 and 013; a quickstart step and a `CLAUDE.md` gotcha |
| Operators and administrators decide the same item | one of them sees "already decided" | by design (FR-017); the message names the path that won |

## Complexity Tracking

No violations to justify. The constitution amendment above is part of this change and was called for by the
spec.
