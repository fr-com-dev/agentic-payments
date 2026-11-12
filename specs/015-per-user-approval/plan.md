# Implementation Plan: Per-User Backchannel Approval

**Branch**: `claude/015-per-user-approval-1a763f` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/015-per-user-approval/spec.md`, with the five clarifications of
session 2026-11-12: SPEC v1.13 stays and the feature is proven against the stand-in approval service; the
owner's answer approves every escalated amount; the owner's identity travels with each payment request and is
not kept; sign-in and approval are the same tenant; enrollment is optional.

## Summary

Backchannel approval (012) asks one approver, named in L2's settings. This feature asks the person the run is
for, and nobody else, and removes the approver from every place a deployment is configured.

- **One new field on the payment request**, `approvalSubject`: the person's subject at the approval service,
  which the hosted agent takes from the sign-in token it verified
  ([R1](research.md#r1-the-owners-identity-travels-on-the-payment-request-as-one-new-field),
  [R14](research.md#r14-the-hosted-agent-one-more-value-fixed-before-the-run)).
- **L2 checks it against the user it already trusts** by recomputing the one-way identifier, inside the
  serialized section. A match addresses one request to that person. Anything else asks nobody
  ([R2](research.md#r2-the-identity-check-recompute-the-one-way-identifier),
  [R4](research.md#r4-eligibility-three-new-marks-decided-in-the-same-place)).
- **The approver check becomes an owner check**, made from the signed answer alone, so it needs nothing stored
  and works the same after a restart ([R3](research.md#r3-the-approver-check-becomes-an-owner-check-from-the-signed-answer-alone)).
- **The ledger names people by `usr_…` only.** The subject is never written, logged or returned. A backchannel
  decision now records the owner's identifier where it recorded the approver's subject
  ([R6](research.md#r6-what-the-ledger-writes-the-owners-one-way-identifier-where-the-approvers-subject-was),
  [R7](research.md#r7-where-the-subject-lives-and-for-how-long)).
- **The limit of 10 requests an hour is counted per person** ([R5](research.md#r5-the-limit-per-person)).
- **No approver setting anywhere**: L2's env, the parameter files, the L2 app module, the tenant's Terraform,
  its pipeline and the setup script. A leftover `CIBA_APPROVER` stops L2, and backchannel approval now needs
  user accounts ([R8](research.md#r8-configuration-the-approver-goes-and-the-feature-needs-user-accounts),
  [R15](research.md#r15-the-approver-leaves-the-infrastructure)).
- **A person sees why a payment of theirs waits**: one read route in L2, one in the portal, one card in the web
  app, with a reason from a fixed list ([R11](research.md#r11-what-a-person-sees-their-own-waiting-payments-with-a-reason-from-a-fixed-list)).
- **A person sets up their own phone** through a sign-in pop-up; a second post-login Action in the tenant
  enrolls the push factor. No credential is added
  ([R13](research.md#r13-enrollment-the-tenants-own-asked-for-by-the-portals-sign-in)).
- **The 2026-11-12 finding is explained and closed**: an unanswered request normally ends with
  `ESCALATION_EXPIRED` alone, in a clean timeout too. A derived state, `unanswered`, names it, and SPEC L2-7's
  sentence is corrected ([R9](research.md#r9-the-2026-11-12-finding-an-unanswered-request-usually-ends-with-escalation_expired-alone)).

Off by default, as before (`CIBA_APPROVAL=1` turns it on). The local demo and the scripted baseline are
unchanged. No new process, image, pipeline, application in the tenant, credential or ledger entry type.

Contract changes: `PaymentIntent.approvalSubject?`; three new values of `ApprovalRequestMark` and one of
`ApprovalRequestState`; `WaitingPayment`, `WAITING_REASONS`; `PlatformView.phoneApproval`
([control-api.md](contracts/control-api.md)). `AuthorizationDecision` and `BudgetStatus` are unchanged.

## Technical Context

**Language/Version**: TypeScript (strict), ESM, Node.js ≥ 22.13 (development on Node 26). The web app is
TypeScript with JSX, compiled for browsers by Vite. The tenant's Action is plain JavaScript run by Auth0.

**Primary Dependencies**: nothing new, at run time or at build time. L2: `express`, `jose`. Web app: React and
`@auth0/auth0-spa-js` as pinned by 013. The tenant: the Auth0 Terraform provider already locked in `auth0/`.

**Storage**: the existing hash-chained JSONL ledger, with new values on existing fields
([data-model.md](data-model.md#ledger-entries)). No new store in L2, the portal, the agent or the browser.

**Testing**: vitest. Pure tests for the derivations; in-process L2 against the stand-in approval service, with
user accounts and two people; the hosted agent with L2 and the stand-in on the local chain; in-process portal
against a fake control port; components in jsdom; the architecture, OpenAPI and IaC tests
([R17](research.md#r17-testing-approach)).

**Target Platform**: the local multi-process PoC on loopback (feature off by default), and the Azure profile on
Base Sepolia, where the feature can be on and asks nobody until people can start runs there (FR-028).

**Project Type**: a multi-process service with a three-layer split, plus the portal (backend and web app) of 013
and the tenant's configuration in `auth0/`.

**Performance Goals**:
- a payment that needs no human never waits on the approval service (NFR-006): unchanged;
- an approval within 120 s completes the purchase in the same request (SC-011): unchanged;
- an escalation that asks nobody answers at once, with no wait;
- a person finds out why a payment waits in under 30 s (SC-007): the card is polled every 5 s.

**Constraints**:
- L2 gains no inbound route open to anyone new and no new outbound destination (NFR-005); it still binds
  127.0.0.1 only;
- the identity check, the limit and every check-then-append stay inside the serialized section, with no network
  call inside it;
- `policy.ts` is not edited; an owner's approval lifts only the approval requirement, once, for one exact
  purchase (INV-12);
- the ledger stays append-only; reads append nothing; the subject, a token, a handle, a name or an email never
  enter it;
- the agent's tools stay `fetch_resource` and `check_budget`; the model never sees the subject;
- the tenant keeps exactly two applications; the deployed agent gets no people's setting (FR-028);
- no new credential anywhere (FR-005);
- the `demo:local` summary and the L1-4 baseline are unchanged (NFR-008).

**Scale/Scope**: a handful of people; escalations live 300 s; at most 10 requests an hour per person. One new
field, one L2 route, one portal route, one card and one button in the web app, one Action. A linear ledger scan
per decision and per read, as today.

No item is NEEDS CLARIFICATION. [research.md](research.md) records each decision (R1–R19). One group of
external facts comes from Auth0's documentation and has not been tried against a tenant: how the Action enrolls
a phone ([R13](research.md#r13-enrollment-the-tenants-own-asked-for-by-the-portals-sign-in), five numbered
points, checked by hand in [quickstart §7](quickstart.md)). Nothing on the payment path depends on them.

## Constitution Check

*GATE: must pass before Phase 0 research, and again after Phase 1 design.*

| Principle | Check | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of payment authority | Deciding and signing stay in `src/layer2-control/`. L1 gains one value on the intent, fixed from the verified token before the run; no key, tool, tool input or route. The portal gains one read. L3 is untouched. A person, never the agent, approves: the answer is verified by L2 against the escalation's owner. | PASS, with the amendment below | PASS. T-AGT-08 proves the model and the tools never see the subject; T-CIBA-16 the owner check |
| II. Deterministic, pure policy | `policy.ts` is not changed. An owner's approval is the same `HUMAN_APPROVAL` entry and reaches the engine through `findOpenApproval`; a refusal through `findRejection`. The subject, the mark and the reason are never a decision input. Eligibility takes time as an input and reads the ledger only. | PASS | PASS. The INV-12 cases of T-CIBA re-run with an owner's approval |
| III. Ledger is the single source of truth | Who was asked, the per-person count, the request's state, `unanswered` and a person's waiting payments are derived from the ledger per call. No counter, no cache, no second store. The one fact not in the ledger, the subject, is not a fact L2 needs later ([R7](research.md#r7-where-the-subject-lives-and-for-how-long)). | PASS | PASS |
| IV. Trust the chain | Settlement and L3 are unchanged. | PASS | PASS |
| V. Least-privilege credentials | No new credential, role or token. The portal reads through the existing `PORTAL_TOKEN` role, on a user-account route. The Auth0 client credential stays in `ciba-client.ts` (A9). GitHub still holds no credential of L2's; the pipeline's existing credential installs one more Action. | PASS | PASS |
| VI. Exact money arithmetic | Amounts in the new view are atomic strings from the ledger; the browser formats them with the existing `money.ts`. | PASS | PASS |
| VII. Protocol fidelity | x402 handling is not touched. The CIBA request changes only whose `sub` is in `login_hint`. | PASS | PASS |
| VIII. Proven safety | Six must-fail proofs ([Proofs](#proofs-constitution-viii)). Every new field, route, mark and rule has a test. | PASS | PASS |
| Quality gates | typecheck, the full suite, an unchanged demo summary, SPEC v1.16 in the same change, requirement IDs in test names. | PASS | PASS |

**Amendments made in the same change, not violations** (the spec's Assumptions asked for them):

- **Constitution 1.7.0 → 1.8.0 (MINOR).** No principle or invariant is removed or redefined.
  - Technology & Scope Constraints: "a user approving their own payments stays out" becomes: a user approves
    their own agent's escalated payments by phone; approving them in the portal stays out.
  - Principle V: an approval counts only when "the owner's signed answer verifies", where it says "the
    approver's".
  - Residual risks: a person approves their own agent's spending, for every amount their policy and the platform
    limits allow; a compromised hosted agent that knows another user's subject can cause a request to that
    user's phone; a deployed environment asks nobody by phone until people can start runs there; whoever knows a
    person's sign-in credentials can enroll a phone where that person never did.
- **SPEC §1.3** loses "per-user approvers" from what is out of scope, and §11 loses the residual risk "an
  escalation of a user's payment still goes to the operator and the one configured approver, not to the user".

No unjustified violation, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/015-per-user-approval/
├── spec.md
├── plan.md                      # this file
├── research.md                  # Phase 0: R1–R19
├── data-model.md                # Phase 1: identifiers, marks, states, entries, views
├── quickstart.md                # Phase 1: validation guide, local to the tenant
├── contracts/
│   ├── control-api.md           # L2-5 and §7: the new field, the waiting-payments route, the views
│   ├── approval-request.md      # L2-7: the request's login hint, the owner check, what is recorded
│   ├── portal-api.md            # L2-8: the portal's route, the card, "Set up your phone"
│   └── config-and-secrets.md    # CFG-2, §3.1, §3.3: the approver removed; the tenant; Azure
├── checklists/requirements.md
└── tasks.md                     # Phase 2 (/speckit-tasks)
```

### Source code (repository root)

```text
src/
├── shared/
│   └── contracts.ts             # CHANGED  PaymentIntent.approvalSubject; ApprovalRequestMark + no_owner,
│                                #          no_identity, identity_mismatch; ApprovalRequestState + unanswered;
│                                #          WaitingPayment, WAITING_REASONS; PlatformView.phoneApproval
├── layer1-intent/
│   ├── orchestrator.ts          # CHANGED  deps.approvalSubject copied to the intent, beside userId
│   └── hosted/server.ts, agent.ts   # CHANGED  the verified requester's subject passed down for a person's run
├── layer2-control/
│   ├── service.ts               # CHANGED  the body check; eligibility inputs; StartPlan.subject; backchannel
│   │                            #          needs users; the startup line; phoneApproval on the platform route
│   ├── backchannel.ts           # CHANGED  eligibility (R4); no approver dep; owner in the entries; resume
│   │                            #          skips ownerless requests; the test-only switches
│   ├── ciba-client.ts           # CHANGED  CIBA_APPROVER refused; start({ subject }); settings without approver
│   ├── approval-evidence.ts     # CHANGED  step 7 `owner`; evidence.userId
│   ├── escalations.ts           # CHANGED  approvalRequestCount per user; approvalRequestState with the clock
│   │                            #          and `unanswered`; waitingPayments (pure); requestsToResume
│   ├── user-routes.ts           # CHANGED  GET /v1/users/:userId/escalations
│   └── policy.ts, ledger.ts, signer.ts, users.ts, approval-routes.ts, admin-routes.ts   # unchanged
├── portal/
│   ├── control-client.ts        # CHANGED  waitingPayments(userId)
│   └── routes.ts                # CHANGED  GET /api/payments/waiting; phoneApproval on /api/platform
└── layer3-settlement/, counterparty/, portal-main.ts, main.ts, hosted-main.ts   # unchanged

web/portal/src/
├── api.ts, types.ts             # CHANGED  the new call and shapes
├── messages.ts                  # CHANGED  the reasons' texts
├── components/WaitingPayments.tsx   # NEW   the card
├── screens/Home.tsx, Account.tsx    # CHANGED  the card; "Phone approvals"
└── auth/auth0.ts, stepUp.ts     # CHANGED  the enrollment pop-up (step-up plus acr_values)
web/portal/test/                 # CHANGED  T-WEB-13, T-WEB-14

auth0/
├── enroll-phone.js              # NEW      the second post-login Action
├── main.tf, variables.tf, outputs.tf   # CHANGED  the approver out; the Action, its binding, the tenant setting
└── README.md                    # CHANGED
infra/
├── main.bicep, main.dev.bicepparam, modules/l2-apps.bicep   # CHANGED  no approver; ciba needs userAccounts
└── github-setup.sh              # CHANGED  five variables
.github/workflows/provision-auth0.yml   # CHANGED  no approver variable
env/l2-control.env.example       # CHANGED
docs/l2-control.openapi.yaml, docs/portal.openapi.yaml   # CHANGED

test/
├── backchannel-owner.test.ts    # NEW      T-CIBA-15..20, 22, 23
├── helpers/backchannel-l2.ts, ciba-stub.ts   # CHANGED  user accounts, two people, answers per person
├── backchannel-*.test.ts, ciba-client.test.ts, approval-evidence.test.ts   # CHANGED  the owner replaces the
│                                #          approver; T-CIBA-21 (lapse), T-CIBA-24 (configuration)
├── users.test.ts                # CHANGED  T-USR-13
├── portal.test.ts               # CHANGED  T-PRT-15
├── hosted-access.test.ts        # CHANGED  T-AGT-08
├── e2e.local.test.ts            # CHANGED  T-E2E-15
└── infra, auth0-iac, github-setup, openapi, openapi-portal   # CHANGED
```

**Structure Decision**: no new process, folder or image. The feature lives where 012 put backchannel approval
(`backchannel.ts`, `ciba-client.ts`, `approval-evidence.ts`, `escalations.ts`). The person's read is one more
user-account route, so it shares the existing role and guard. The tenant's side is one file beside
`sign-in-time.js`.

## Design

### The authorize path (`service.ts`)

- The body check accepts `approvalSubject` under the rules of
  [control-api.md](contracts/control-api.md#post-v1authorize-control_token), beside the `userId` check.
- `decideOnce` passes eligibility what it already holds: the user it resolved (`u?.userId`) and the subject.

  ```ts
  backchannel?.eligibility({
    operatorOnly, reevaluation, nowMs: t,
    owner: u?.userId,                 // undefined: the escalation records no user
    subject: intent.approvalSubject,  // undefined: no identity was sent
  }) // → ApprovalRequestMark
  ```

- For `requested`, `StartPlan` gains `owner` and `subject`. The subject is in the plan and nowhere else.
- `main()` refuses `CIBA_APPROVAL=1` without user accounts before the lock; `createControlService` refuses
  backchannel deps without user-account deps.

### Eligibility and the limit (`backchannel.ts`, `escalations.ts`)

The order of [R4](research.md#r4-eligibility-three-new-marks-decided-in-the-same-place). The identity test is
one line, `userIdFor(this.d.issuer, subject) === owner`, and the count is
`approvalRequestCount(entries, nowMs, window, owner)`. Both are synchronous and read only the ledger and the
request.

### The request and the answer

- `CibaPort.start({ bindingMessage, requestedExpiry, authorizationDetails, subject })`. The client builds
  `login_hint` from its own issuer and that subject.
- `APPROVAL_REQUESTED`, `HUMAN_APPROVAL` and `HUMAN_REJECTION` copy the owner from the `ESCALATED` entry, as
  they already copy the resource, the payee and the amount. `Backchannel` reads no person from its deps.
- `verify` passes `ownerUserId` (from the escalation) where it passed the configured approver; step 7 is
  [approval-request.md](contracts/approval-request.md#the-answer-l2-accepts).
- `resume()` polls requests whose escalation has an owner and closes the others
  ([R10](research.md#r10-a-request-that-is-open-when-this-feature-is-deployed)).

### Derived views (`escalations.ts`)

- `approvalRequestState(entries, escalationId, nowMs)`: as today, plus `unanswered`
  ([data-model.md](data-model.md#the-approval-requests-state-derived-approvalrequeststateentries-escalationid-nowms)).
  Every caller already has a clock value.
- `waitingPayments(entries, userId, nowMs)`: the pending escalations of one owner, each with `waitingFor` and
  `reason` from the table of [R11](research.md#r11-what-a-person-sees-their-own-waiting-payments-with-a-reason-from-a-fixed-list).
  Pure, built field by field.

### The hosted agent (`src/layer1-intent/hosted/`)

`server.ts` passes `requester.subject` with `userId` when the requester is a person and auth is not bypassed.
`runAgent` hands it to the orchestrator's deps; the orchestrator copies it onto each intent. It is not given to
`createRunTools`, the instructions, the run record or the log.

### The portal and the web app

Per [portal-api.md](contracts/portal-api.md). The route is a thin map of L2's view. The card reuses `poll.ts`
and `money.ts`. "Set up your phone" reuses the step-up pop-up with one more authorization parameter, behind a
click.

### The tenant (`auth0/`)

`enroll-phone.js`, in outline:

```js
exports.onExecutePostLogin = async (event, api) => {
  if (!asked(event)) return;            // the project's acr_values entry is in the request
  if (hasPush(event.user)) return;      // already enrolled: nothing to do
  if (!fresh(event, 5 * 60)) return;    // the latest authentication method is at most 5 minutes old
  api.authentication.enrollWith({ type: "push-notification" });
};
```

Terraform adds the Action, binds it in the post-login flow and turns on the tenant setting that lets an Action
choose MFA factors. The approver's variable, data source and outputs are removed
([config-and-secrets.md](contracts/config-and-secrets.md#the-tenant-auth0-terraform)).

### Azure

Per [config-and-secrets.md](contracts/config-and-secrets.md#azure-infra): three files lose the approver, and
`main.bicep` refuses an enabled `ciba` without user accounts.

## Requirement traceability

| Requirement | Where | Test |
|---|---|---|
| FR-001 per-user is the only mode; needs user accounts | `main()`, `createControlService`, `main.bicep` | T-CIBA-24, T-IAC-01 rule 19 |
| FR-002 no approver setting anywhere | env template, Bicep, Terraform, pipeline, setup script | T-IAC-01 rule 19, T-IAC-02, T-E2E-AZ |
| FR-003 a leftover setting stops L2, value never printed | `cibaConfigFromEnv` | T-CIBA-24 |
| FR-004 the tenant needs no one person | `auth0/` without `auth0_user` | T-IAC-02 |
| FR-005 no new credential | nothing added to a vault, an env file or GitHub | T-IAC-01, T-IAC-02, T-ARCH-ENV unchanged |
| FR-006 one request, to the owner | eligibility, `Backchannel.start` | T-CIBA-15 |
| FR-007 no user, no request | eligibility (`no_owner`) | T-CIBA-18, T-E2E-01, T-E2E-10 |
| FR-008 no fallback | no setting, no default subject | T-CIBA-17, T-CIBA-18 |
| FR-009 the identity, checked and not kept | the body check, eligibility, `StartPlan` | T-CIBA-17, T-CIBA-20 |
| FR-010 from the verified token; the agent gains nothing | `hosted/server.ts`; tools unchanged | T-AGT-08 |
| FR-011 same issuer or nobody is asked | the identity check | T-CIBA-17 (a subject under another issuer) |
| FR-012 every existing check | `verifyApprovalToken` steps 1–6, 8–10 | T-CIBA-08, unchanged in meaning |
| FR-013 the owner check | step 7 | T-CIBA-16 |
| FR-014 every amount; SEC-29 unchanged | no new limit; `admin-routes.ts` untouched | T-CIBA-15, T-ADM-06 unchanged |
| FR-015 10 an hour per person | `approvalRequestCount` with the user | T-CIBA-19 |
| FR-016 repeats count nothing | unchanged | T-CIBA-03, T-CIBA-04 |
| FR-017 no phone: permanent, no retry, pending | unchanged start path | T-CIBA-05 (as a person), T-USR-13 |
| FR-018 optional, self-service enrollment | `enroll-phone.js`, the Account screen | T-IAC-02, T-WEB-14, quickstart §7 |
| FR-019 the person sees why | `waitingPayments`, the two routes, the card | T-USR-13, T-PRT-15, T-WEB-13 |
| FR-020 `usr_…` only; the subject never stored | the entries of R6; R7 | T-CIBA-15, T-CIBA-20 |
| FR-021 no credential, token, handle or service text | whitelists, unchanged | T-CIBA-12, T-CIBA-20 |
| FR-022 old entries still verify and read | no rewrite; readers take both | T-CIBA-23 |
| FR-023 how every request ended | `unanswered`; SPEC L2-7 corrected | T-CIBA-21 |
| FR-024 the operator's and administrators' views | the views' new values | `backchannel-views.test.ts`, T-ADM-08 |
| FR-025 the rest of 012 | untouched code paths | T-CIBA-01..14 |
| FR-026 the other paths, first final state wins | untouched | T-E2E-02, T-E2E-07, T-ADM-07 |
| FR-027 the policy engine | `policy.ts` not edited | T-POL unchanged |
| FR-028 SPEC v1.13 stays | no agent client, no people's setting in Azure | T-IAC-01 rule 21, T-IAC-02 (two applications) |
| NFR-001 monotonicity | INV-12 unchanged | the INV-12 cases with an owner's approval |
| NFR-002 fail closed | every refusal leaves the escalation pending | T-CIBA-16, 17, 21 |
| NFR-003 isolation between people | owner on every step; the route's filter | T-CIBA-15, T-CIBA-19, T-USR-13, T-PRT-15 |
| NFR-004 secrets and personal data | the scan | T-CIBA-20 |
| NFR-005 network exposure | no new listener or destination | T-CIBA-20 (the stand-in is the only peer), T-ARCH unchanged |
| NFR-006 availability | nothing new on the path of a payment that needs no human | T-E2E-01 unchanged |
| NFR-007 proven safety | [Proofs](#proofs-constitution-viii) | the must-fail tests |
| NFR-008 regression | feature off by default | T-E2E-01, `demo:local` |

## Proofs (Constitution VIII)

Each safety mechanism has a test that fails without it. The switches are test-only deps of the backchannel or
of the user-account routes, never environment variables.

| Mechanism | Switch | Without it | Test |
|---|---|---|---|
| The owner check (FR-013) | `skipChecks` holding `owner` | B's signed answer approves A's payment | T-CIBA-16 |
| The identity check (FR-009) | `skipIdentityCheck` | a request is sent to a subject that is not the user's | T-CIBA-17 |
| The per-person count (FR-015) | `sharedRequestCap` | A at the limit stops B from being asked | T-CIBA-19 |
| No user, no request (FR-007) | `ownerlessSubject` (a fallback subject) | the scripted run's escalation notifies somebody | T-CIBA-18 |
| A person's own payments only (FR-019) | `skipOwnershipCheck` (the existing switch of 013) | A's list shows B's payment | T-USR-13 |
| Enrollment needs a fresh sign-in (R13) | the Action's source with the check removed | a day-old session enrolls a phone | T-IAC-02 |

## Tests defined here

T-CIBA-15..24, T-USR-13, T-PRT-15, T-WEB-13..14, T-AGT-08 and T-E2E-15, and the changes to T-API-01..04 and
12..15, T-IAC-01 rule 19, T-IAC-02 and the setup script's test. Existing tests that must pass with no change of
meaning: T-E2E-01, T-E2E-02, T-E2E-07, T-E2E-10 to 14, T-CIBA-01..14, T-USR-01..12, T-ADM-01..10,
T-PRT-01..14, T-WEB-01..12, T-AGT-01..07 and T-LED-01..07. T-CIBA-01..14 change in one stated way: the helper's
two onboarded people replace the configured approver, and the payments they test are a person's.

## SPEC and governance changes (same change)

SPEC.md v1.15 → **v1.16**, with a "Changes in 1.16" table:

| Section | Change |
|---|---|
| §1.2, §1.3 | a person approves their own agent's escalated payments by phone; "per-user approvers" leaves the out-of-scope list; approving in the portal as a user, and people's runs in a deployed environment, stay out |
| §2 | glossary: owner; the approver is no longer a configured person |
| §3.3 | the Auth0 client credential's row says "the owner's signed answer" |
| §6 | `auth0/enroll-phone.js` |
| §7 | `PaymentIntent.approvalSubject`; the new marks and `unanswered`; `WaitingPayment`; `phoneApproval` |
| L1-6 | the hosted agent sends the verified subject for a person's run; nothing about routes or tools changes |
| L2-4 | the backchannel entries name the owner by `usr_…`; `evidence.userId`; the new `check` and `failure` values |
| L2-5 | the authorize row's new field and its 400 cases; `GET /v1/users/:userId/escalations`; `phoneApproval` |
| L2-7 | "one approver per L2" goes; eligibility with the owner conditions and the per-person limit; the owner check; the corrected sentence on unanswered requests; resume |
| L2-8 | a person's waiting payments; optional enrollment and "Set up your phone" |
| CFG-2, §3.1 Azure | `CIBA_APPROVER` removed; `CIBA_APPROVAL` needs `USER_ACCOUNTS`; T-IAC-01 rule 19 as amended |
| §11 | SEC-17 "the escalation's owner"; SEC-18 "per person"; new SEC-30 (another person's answer, or a request pointed at another phone) and SEC-31 (enrollment from a session nobody just signed in to); residual risks as in the amendment above, and the old one removed |
| §12, §13 | the tests above; the quickstart's commands |

Also in the same change:
- `.specify/memory/constitution.md` → 1.8.0, with a Sync Impact Report.
- `specs/README.md`: the 015 row and the traceability rows (L2-7, SEC-17, SEC-18, SEC-30, SEC-31, the new tests).
- `specs/007` contracts/threat-matrix.md: SEC-30 and SEC-31.
- `specs/012`: the dated note on quickstart §5 and one line in each contract that names the approver
  ([R19](research.md#r19-what-becomes-of-012s-live-check)).
- `specs/013` contracts/control-api.md and portal-api.md: a line pointing here for the new route.
- `CLAUDE.md`: the CIBA and Auth0 gotchas (no approver; the Action; five variables), the user-account route
  note, and the new must-fail switches.
- `README.md`, `auth0/README.md`, `docs/diagrams/x402-architecture.json`: the phone path asks the run's owner.

## Delivery

Five slices, each mergeable alone and each leaving `npm run check` green
([R18](research.md#r18-delivery-in-slices)): L2 with its deployment settings; the hosted agent; a person's
view; the tenant; documents. `/speckit-tasks` orders the tasks along them. Slice 1 holds every authority check
and four of the six proofs. The L2 change and the Bicep change that drops `CIBA_APPROVER` are in the same slice,
so a deployed L2 never starts with a leftover setting.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| A person approves their own agent's spending | a prompt-injected agent's escalation is released by its own owner | decided by the owner (D1); the phone shows the exact payment; the person's policy, budgets and the platform limits are checked again at signing; 10 requests an hour per person; residual risk in SPEC §11 |
| A compromised hosted agent names another user and knows their subject | that user's phone gets a request for a payment from their own account that they did not start | the one-way identifier does not reveal the subject; only that user's tap approves; their own limit bounds it; residual risk |
| Sign-in credentials alone are enough to enroll a phone | for a person who never enrolled, the phone is no second factor | enrollment needs credentials entered within 5 minutes, checked by the Action; bounded by the person's policies; residual risk ([R13](research.md#r13-enrollment-the-tenants-own-asked-for-by-the-portals-sign-in)) |
| The Action's behavior differs from the documentation | enrollment does not start, or a sign-in with the enrollment parameter fails | it acts only on that parameter, so a normal sign-in is never touched; the five points are checked by hand before anyone relies on it (quickstart §7); nothing on the payment path depends on it |
| The tenant setting for MFA in Actions changes sign-in for everyone | people are asked for a second factor | `guardian_policy` stays `never`; quickstart §7 checks 1 and 6; the plan step shows the diff before any apply |
| The portal's issuer and `CIBA_ISSUER` are different hosts (a custom domain) | nobody is ever asked | fails closed; quickstart §7 check 7; the person's card says why |
| A deployed environment asks nobody by phone | the 2026-11-12 capability is gone until a later feature | accepted by the owner (D5); the operator job and the administration area decide; stated in SPEC §11 |
| The helper change touches every T-CIBA test | a regression in 012's behavior hides in the churn | the helper changes first, alone, with T-CIBA-01..14 passing before any new behavior lands |
| A leftover `CIBA_APPROVER` in an environment | L2's new revision refuses to start and the pipeline rolls back | the Bicep module drops it in the same slice; quickstart §4 and §6; a `CLAUDE.md` gotcha |
| `PR #31` (012's live results) is not merged when slice 5 lands | the note of R19 has no section to sit under | the note goes to 012's quickstart §5 heading, which is on `main`; the results are referenced by branch |

## Complexity Tracking

No violations to justify. The constitution amendment above is part of this change and was called for by the
spec.
