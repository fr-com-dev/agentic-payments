---

description: "Task list for 015: backchannel approval by the person the run is for"
---

# Tasks: Per-User Backchannel Approval

**Input**: Design documents from `specs/015-per-user-approval/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md) (R1–R19)
- [data-model.md](data-model.md)
- [contracts/](contracts/): control-api, approval-request, portal-api and config-and-secrets
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII requires a test for every field, route, mark and
rule, plus the six must-fail proofs in plan.md "Proofs".
- **Test IDs.** Each test title carries its ID (T-CIBA-15..24, T-USR-13, T-PRT-15, T-WEB-13..14, T-AGT-08,
  T-E2E-15) or `015 USn …`.
- **Order.** Write each story's tests first and confirm they fail before implementing.
- **Switches.** Every must-fail switch (`skipIdentityCheck`, `sharedRequestCap`, `ownerlessSubject` and the
  existing `skipChecks` on the backchannel deps; the existing `skipOwnershipCheck` on the user-account deps) is
  a test-only dep, never an environment variable.
- **Clock.** Tests pass `now` as a dep; nothing in a test sleeps to cross 300 seconds or an hour.
- **People in tests.** A person's identifier is `userIdFor(<the stand-in's issuer>, <their subject>)`, so the
  identity check passes as it would with one tenant (research R17).

**Organization**: tasks are grouped by user story (US1–US7 from spec.md). US1, US2 and US3 are the three P1
stories and one piece of L2: US2 and US3 prove and harden what US1 builds, so they need US1. US4 to US7 need
US1 and are independent of one another.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel: a different file, and no dependency on an incomplete task.
- **[Story]**: the user story the task belongs to (US1–US7).

## Path Conventions

- Single repository: `src/`, `web/`, `auth0/`, `infra/`, `scripts/`, `test/`, `docs/`, `env/` at the root
  (plan.md "Project Structure").
- The feature lives where 012 put backchannel approval: `src/layer2-control/backchannel.ts`, `ciba-client.ts`,
  `approval-evidence.ts` and `escalations.ts`. `policy.ts`, `ledger.ts`, `signer.ts`, `approval-routes.ts` and
  `admin-routes.ts` are not edited.
- **Docs in step.** Any task that adds or changes an L2 route or a field that crosses L2's API also updates
  `docs/l2-control.openapi.yaml` and the SPEC table it belongs to (L2-5, §7, L2-4) in the same task, because
  T-API-01..04 fail otherwise. The same holds for a portal route, `docs/portal.openapi.yaml`, SPEC L2-8 and
  `web/portal/src/api.ts` (T-API-12..15).
- **Off by default.** Backchannel approval stays off unless a test or `CIBA_APPROVAL=1` turns it on, so every
  existing test and `npm run demo:local` stay green after every task.
- **The subject is never written.** No task may put `approvalSubject`, or a token's `sub`, in a ledger entry,
  a log line, an event or a response. T-CIBA-20 scans for it from US2 on.
- **The other paths are not touched.** The operator's routes and scripts and the portal's administration area
  keep their requests, responses and tests (FR-026).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: the contract shapes and the SPEC version that later phases compile and write against. No behavior
changes.

- [ ] T001 [P] Extend the shapes in src/shared/contracts.ts per data-model.md and contracts/control-api.md:
  - `PaymentIntent.approvalSubject?: string`, with the doc comment of contracts/control-api.md "POST /v1/authorize";
  - `ApprovalRequestMark` gains `"no_owner" | "no_identity" | "identity_mismatch"`;
  - `ApprovalRequestState` gains `"unanswered"`;
  - `WAITING_REASONS = ["limit_reached", "sign_in_not_supported", "phone_unreachable", "service_unavailable", "unanswered", "answer_not_accepted"] as const` and `WaitingReason`;
  - `WaitingPayment { authorizationId: string; referenceCode: string; resourceKey: string; payTo: string; amount: string; createdAt: string; expiresAt: string; waitingFor: "phone" | "operator"; reason?: WaitingReason }`;
  - `PlatformView.phoneApproval: boolean`; `platformView` in src/layer2-control/users.ts returns `Omit<PlatformView, "phoneApproval">`, the `GET /v1/platform` route in src/layer2-control/user-routes.ts adds `phoneApproval: false` until T033, and the fake control port in test/helpers/portal.ts adds `false`;
  - the comment on `DecisionChannel` and on `EscalationDecision.decidedBy`: for the backchannel, the owner's `usr_…` (entries written before v1.16 hold the configured approver's subject).

  Make no behavior change; `npm run typecheck` stays green.
- [ ] T002 [P] Open SPEC v1.16 in SPEC.md: the version line (`1.16 (<date>)` and one clause, "v1.16 sends each approval request to the person the run is for and removes the configured approver (L2-7, `specs/015`)"), and an empty "Changes in 1.16" table with the columns of the 1.15 table. Later tasks add their rows.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: what every story needs before it can be tested: the request field accepted by L2, and the test
helpers running backchannel approval with user accounts and two people.

**⚠️ CRITICAL**: no user story work can begin until this phase is complete. L2's behavior does not change in
this phase: T-CIBA-01..14 must pass at its end with their assertions untouched.

- [ ] T003 Accept `approvalSubject` in the authorize body check of src/layer2-control/service.ts (contracts/control-api.md "POST /v1/authorize"), beside the `userId` check and still after the token check:
  - valid only as "a string of 1 to 255 characters with no whitespace and no control character";
  - "never without `userId`": present with no `userId` is 400 malformed;
  - with user accounts off or backchannel approval off it is ignored;
  - it is not copied to `INTENT` or to any other entry, and it is not used yet.

  Add cases to test/users.test.ts (`015 authorize approvalSubject`): each malformed value is 400, 401 precedes 400, a valid value changes no decision and appears in no entry. Update `PaymentIntent` in docs/l2-control.openapi.yaml, the `POST /v1/authorize` row of SPEC L2-5 (the new 400 cases) and SPEC §7.
- [ ] T004 [P] Let the stand-in answer as a person in test/helpers/ciba-stub.ts:
  - an approval's token and ID token take their `sub` from the `sub` of the request's `login_hint` (parse the JSON `{ format, iss, sub }`), no longer from `opts.approver`;
  - `Answer` `approve` gains `as?: string`: sign the answer with that subject instead (another person's genuine answer);
  - the forgery `"subject"` keeps its meaning (a subject that is nobody's);
  - `CibaStubOptions.approver` becomes optional and unused once T009 lands; keep it accepted until then.

  With L2 unchanged the hint still carries the configured approver, so every existing test passes.
- [ ] T005 Run backchannel tests with user accounts and two people in test/helpers/backchannel-l2.ts (research R17):
  - user accounts are always on (the `users` and `net` deps that the `admin` option adds today); `admin` keeps adding only the administration routes;
  - export `ALICE_SUB = "auth0|alice-1"`, `BOB_SUB = "auth0|bob-1"`, and build `alice` and `bob` as `userIdFor(stub.issuer, <sub>)` after the stub starts; expose them on `BackchannelL2` as `people: { alice: { userId, subject }, bob: { userId, subject } }`;
  - onboard both before returning (profile, crypto account, one policy), reusing the calls of test/helpers/users.ts `onboard`; choose the policy values so that every amount T-CIBA-01..14 use gets the decision it gets today, and say in a comment which amounts escalate;
  - `intentFor(path, amount, o)` gains `o.as?: "alice" | "bob" | "platform"` (default `"alice"`): a person's intent carries `userId` and `approvalSubject`; `"platform"` carries neither.

  Run `npx vitest run test/backchannel-*.test.ts test/ciba-client.test.ts test/approval-evidence.test.ts`: T-CIBA-01..14 pass with no assertion changed. If one amount can't keep its decision under a user's policy, change that amount only and name it in the commit message.

**Checkpoint**: `npm run check` green; the ledger of a backchannel test now shows a person's `userId` on its entries and the configured approver still deciding.

---

## Phase 3: User Story 1 - A person approves their own agent's payment from their own phone (Priority: P1) 🎯 MVP

**Goal**: an escalation of a person's run sends one approval request to that person, and their verified answer
approves or denies it. The ledger names them by `usr_…`.

**Independent Test**: with the stand-in and two onboarded people, escalate one payment in a run of the first;
exactly one request is sent, its login hint is the first person's subject, the second receives nothing, and the
first person's approval pays once. A refusal gives DENIED with `human_rejected` and nothing is signed.

### Tests for User Story 1 (write first; they must fail)

- [ ] T006 [P] [US1] T-CIBA-15 in test/backchannel-owner.test.ts (new file; use `startBackchannelL2`):
  - an escalation of alice's sends exactly one `bc-authorize` whose `login_hint` is `{ format: "iss_sub", iss: <stub.issuer>, sub: ALICE_SUB }`; bob's subject is in no request;
  - `APPROVAL_REQUESTED.data.approver` is alice's `usr_…`;
  - alice approves within the wait: the call returns AUTHORIZED; one `HUMAN_APPROVAL` with `channel: "backchannel"`, `approver` alice's `usr_…` and `evidence` exactly `{ issuer, userId, answerId, issuedAt, detailsSource }` (no `subject` key);
  - alice refuses: one `HUMAN_REJECTION` with `approver` alice's `usr_…`; the session's next request for that resource is DENIED `human_rejected`; nothing is signed;
  - alice and bob each have a pending escalation and each answers: each answer decides only its own (US1 scenario 5);
  - the INV-12 case: a DENY rule at re-evaluation wins over alice's approval.
- [ ] T007 [P] [US1] T-AGT-08 in test/hosted-access.test.ts: a run started by a person sends intents with `userId` and `approvalSubject` equal to the verified token's `sub`; a system identity's run and a `bypassAuth` run send neither; the subject appears in no model call (instructions, messages, tool definitions, tool results), in no run result and in no line of the run log. Use `fakePorts` to capture the intents.
- [ ] T008 [P] [US1] T-E2E-15 in test/e2e.local.test.ts: the hosted agent, L2 with user accounts and backchannel approval, and the stand-in on the local chain. A person's token is issued under the stand-in's issuer (inject the people's verifier through the hosted helper's deps). The run buys the resource above the person's auto-approve limit; the stand-in approves as that person; the run completes PAID once, signed with the person's own account; the ledger verifies and names the person by `usr_…` only. In the same file, rework the first half of T-E2E-10 (an approval within the wait pays in the same `fetchPaid`): the platform account can no longer be asked, so the purchase becomes a person's (the orchestrator built with the `userId` and `approvalSubject` of an onboarded person whose account holds local test USDC); it still asserts 50000 on-chain and one request.

### Implementation for User Story 1

- [ ] T009 [US1] Address the request to the owner in src/layer2-control/ciba-client.ts (contracts/approval-request.md "The request"): `StartParams` gains `subject: string`; `start` builds `login_hint` from `settings.issuer` and `p.subject`; `CibaSettings` and `publicSettings` lose `approver`; `cibaConfigFromEnv` no longer requires `CIBA_APPROVER` (a present value is ignored here; T041 turns it into a refusal). Update test/ciba-client.test.ts (the form's fields, T-CIBA-02) and the helper of T005 (no `approver` in the settings).
- [ ] T010 [US1] Make verification's step 7 an owner check in src/layer2-control/approval-evidence.ts (contracts/approval-request.md "The answer L2 accepts"):
  - `VERIFICATION_CHECKS` gains `"owner"` in step 7's place and keeps `"approver"` as a value that is read and never produced;
  - `ExpectedApproval.approver` becomes `ownerUserId: string`;
  - step 7: `userIdFor(claims.iss, claims.sub) !== expected.ownerUserId` fails `owner`;
  - `ApprovalEvidence` is `{ issuer, userId, answerId, issuedAt, detailsSource }`, with `userId` the owner's.

  Update test/approval-evidence.test.ts: the step order, the `owner` case, the evidence's keys. Import `userIdFor` from `../shared/user-id.js` only.
- [ ] T011 [US1] Decide eligibility for an owner in src/layer2-control/backchannel.ts (research R4):
  - `BackchannelDeps` loses `approver`;
  - `eligibility(o: { operatorOnly; reevaluation; nowMs; owner?: string; subject?: string })` returns, in this order: `reevaluation`, `operator_only`, `no_owner` (no `owner`), `no_identity` (no `subject`), `identity_mismatch` (`userIdFor(this.d.issuer, subject) !== owner`), `capped` (the existing count, unchanged until T037), `requested`;
  - `StartPlan` gains `owner: string` and `subject: string`; `runStart` passes `subject` to `port.start` and never to `ledger.append` or `this.log`.
- [ ] T012 [US1] Record the owner in src/layer2-control/backchannel.ts (research R6): `APPROVAL_REQUESTED.data.approver`, `HUMAN_APPROVAL.data.approver` and `HUMAN_REJECTION.data.approver` are the `userId` of the escalation's `ESCALATED` entry (copy it as the resource, the payee and the amount are copied); `verify` passes `ownerUserId` from that entry; `HUMAN_APPROVAL.data.evidence` is the new evidence. Update the entry rows of SPEC L2-4 (`approver`, `evidence`, the `check` values).
- [ ] T013 [US1] Pass the owner and the subject from the authorize path in src/layer2-control/service.ts: `decideOnce` calls `backchannel.eligibility` with `owner: u?.userId` and `subject: intent.approvalSubject`, and fills `StartPlan.owner` and `StartPlan.subject` for `requested`; the startup line becomes `backchannel approval on (issuer <issuer>, per user)`. T006 now passes.
- [ ] T014 [US1] Send the subject from the hosted agent (research R14): in src/layer1-intent/hosted/server.ts pass `approvalSubject: requester.subject` beside `userId` when the requester is a person and auth is not bypassed; carry it through `runGoal` and src/layer1-intent/hosted/agent.ts to the orchestrator's deps only (never to `createRunTools`, the instructions, the run record or the log); in src/layer1-intent/orchestrator.ts add `approvalSubject?: string` to the deps and copy it onto each intent beside `userId`. Add the sentence to SPEC L1-6 ("the user"). T007 and T008 now pass.
- [ ] T015 [US1] Adapt the tests of 012 that named the approver, with no change of meaning: in test/backchannel-approve.test.ts, backchannel-refuse.test.ts, backchannel-verify.test.ts, backchannel-views.test.ts and backchannel-failures.test.ts replace `APPROVER` by the person the helper names (`people.alice`), the check name `approver` by `owner`, and the evidence's `subject` by `userId`. No other assertion changes.

**Checkpoint**: US1 works end to end against the stand-in. `npm run check` green; the demo summary unchanged.

---

## Phase 4: User Story 2 - Only the owner's verified answer counts (Priority: P1)

**Goal**: another person's genuine answer approves nothing, and an identity that is not the user's is never
used. Both are proven to matter.

**Independent Test**: return bob's signed answer for alice's escalation: nothing is approved. Give L2 a subject
that does not resolve to alice: no request is sent on it. Each has a must-fail half.

### Tests for User Story 2 (write first; they must fail)

- [ ] T016 [P] [US2] T-CIBA-16 in test/backchannel-owner.test.ts: for alice's pending escalation the stand-in answers `{ approve: { as: BOB_SUB } }` (valid signature, same payment details): no `HUMAN_APPROVAL`; one `APPROVAL_VERIFICATION_FAILED` with `check: "owner"`; the escalation stays pending; nothing is signed; an operator approval still pays. **Must fail**: with `skipChecks: new Set(["owner"])`, bob's answer approves alice's payment.
- [ ] T017 [P] [US2] T-CIBA-17 in test/backchannel-owner.test.ts:
  - an intent with alice's `userId` and bob's subject: `ESCALATED.approvalRequest` is `identity_mismatch`, no `bc-authorize` is sent, the call returns ESCALATE at once (no wait), and an operator approval pays;
  - a subject that would resolve to alice under another issuer (compute alice's `userId` with `userIdFor("urn:x402:dev-issuer", ALICE_SUB)` for a second onboarded person): `identity_mismatch` (FR-011);
  - alice's `userId` and no subject: `no_identity`, no request;
  - the payment itself is decided as without the field (same decision, same violations).

  **Must fail**: with `skipIdentityCheck`, the request is sent with the mismatched subject in its `login_hint`.
- [ ] T018 [P] [US2] T-CIBA-20 in test/backchannel-owner.test.ts: run an approval, a refusal, a mismatch and a failed start with the planted subject `auth0|planted-subject-7f3a91` for a third onboarded person; the string is in no line of the ledger file, in no captured log line, in no response body of authorize, the operator's lists and events, the administration routes and the user-account routes, and in no event. The existing T-CIBA-12 scan stays as it is.

### Implementation for User Story 2

- [ ] T019 [US2] Add the test-only switch `skipIdentityCheck?: boolean` to `BackchannelDeps` in src/layer2-control/backchannel.ts: when set, eligibility skips the `identity_mismatch` branch. Comment it as the must-fail proof of T-CIBA-17, never set outside tests. Confirm `skipChecks` already covers `owner` (T010). T016 and T017 now pass in both halves.
- [ ] T020 [US2] Close what T-CIBA-20 finds: make sure no log line in src/layer2-control/backchannel.ts or service.ts, no error body in service.ts and no view in escalations.ts can carry the subject (the 400 for a malformed `approvalSubject` names the field, never its value). T018 now passes.
- [ ] T021 [US2] Add the threat row SEC-30 in SPEC §11 ("one person's answer approves another person's payment, or a caller points a person's request at another phone"; mitigations: the owner check from the signed answer, the identity check against the one-way identifier, L2's own issuer; tests T-CIBA-16, T-CIBA-17), reword SEC-17 ("the escalation's owner" where it says "approver"), add SEC-30 to specs/007-process-isolation-security/contracts/threat-matrix.md, and raise `SEC_ROWS` in test/architecture.test.ts to 30.

**Checkpoint**: the two authority checks are proven. `npx vitest run test/backchannel-owner.test.ts -t "must fail"` shows both unsafe outcomes.

---

## Phase 5: User Story 3 - A run with no person behind it never reaches anyone's phone (Priority: P1)

**Goal**: the scripted regression, a system identity's run and the command-line agent ask nobody. Nothing can
route them to a person.

**Independent Test**: with backchannel approval on, escalate a platform payment in each of the three ways: the
stand-in receives no request, each escalation is pending for the operator, and an operator approval pays.

### Tests for User Story 3 (write first; they must fail)

- [ ] T022 [P] [US3] T-CIBA-18 in test/backchannel-owner.test.ts: three escalations: a platform intent (`as: "platform"`, what a system identity's run and the command-line agent send), a platform intent with `operatorApprovalOnly: true` (what the scripted regression sends), and a person's intent with `operatorApprovalOnly: true`. `ESCALATED.approvalRequest` is `no_owner` for the first and `operator_only` for the other two, `stub.requests` is empty, each call returns ESCALATE at once, and an operator approval pays each. **Must fail**: with `ownerlessSubject: BOB_SUB`, the platform's escalation sends a request to bob's phone.
- [ ] T023 [P] [US3] T-CIBA-22 in test/backchannel-lapse.test.ts: build a ledger file with `AuditLedger.append` holding an `ESCALATED` marked `requested` with no `userId`, and its `APPROVAL_REQUESTED` with `approver: "auth0|approver-1"` and a sealed handle (the shape entries had before v1.16); start an instance on that file with the clock inside the window: it polls nothing, appends one `APPROVAL_REQUEST_FAILED` with `phase: "resume"` and `failure: "no_owner"`, and the escalation expires at 300 s. A request whose escalation has an owner is still resumed (T-CIBA-11 unchanged).
- [ ] T024 [P] [US3] In test/e2e.local.test.ts, extend the second half of T-E2E-10 (the scripted plan with backchannel approval on matches the baseline): the escalation at step 4 is marked `operator_only` and the stand-in received no request; add one run of a system identity through the hosted agent whose escalation is `no_owner` and waits for the operator.

### Implementation for User Story 3

- [ ] T025 [US3] Add the test-only switch `ownerlessSubject?: string` to `BackchannelDeps` in src/layer2-control/backchannel.ts: when set, an escalation with no owner is treated as `requested` and sent to that subject. Comment it as the must-fail proof of FR-007; `main()` never sets it and no environment variable reaches it. T022 passes in both halves.
- [ ] T026 [US3] Stop resuming ownerless requests (research R10): in src/layer2-control/escalations.ts `requestsToResume` returns a fourth list, `ownerless` (open or stale requests whose escalation records no `userId`); in src/layer2-control/backchannel.ts `resume()` records each with `recordFailure(req, { phase: "resume", failure: "no_owner" })` and logs one line without the old `approver` value. Extend the `failure` values of `APPROVAL_REQUEST_FAILED` in SPEC L2-4. T023 passes.

**Checkpoint**: US1 to US3 are done: this is the whole payment-authority change. `npm run check` green.

---

## Phase 6: User Story 4 - A person without an enrolled phone can see why their payment waits (Priority: P2)

**Goal**: a person sees their own pending payments with a reason from a fixed list, and can set up their phone
themselves.

**Independent Test**: have the stand-in refuse the request permanently for a person: the escalation stays
pending, no retry is sent, the operator can still approve, and the person's list shows the payment with
`phone_unreachable`.

### Tests for User Story 4 (write first; they must fail)

- [ ] T027 [P] [US4] T-USR-13 in test/users.test.ts and test/backchannel-views.test.ts:
  - pure cases for `waitingPayments(entries, userId, nowMs)`: one row per pending escalation of that owner, oldest first; `waitingFor` and `reason` for each state exactly as research R11's table; an expired or decided escalation is absent; the row has exactly the keys of `WaitingPayment`;
  - the route `GET /v1/users/:userId/escalations`: 200 `{ payments }`; an unknown user gets an empty list; a malformed `:userId` is 400; every token but the portal's is 401; the call appends nothing and does not sweep (the entry count is unchanged, and an expired escalation gets no `ESCALATION_EXPIRED` from it);
  - with the stand-in's start set to `{ permanent: "invalid_request" }`: `phone_unreachable`, one attempt, no retry (FR-017);
  - `GET /v1/platform` answers `phoneApproval: true` with backchannel approval on and `false` without.

  **Must fail**: with the user-account dep `skipOwnershipCheck`, alice's list shows bob's payment.
- [ ] T028 [P] [US4] T-PRT-15 in test/portal.test.ts: `GET /api/payments/waiting` calls the control port with the user from the token and nothing from the request (a `?userId=` query and a body are ignored and never forwarded); each item has `amountAtomic` and no `amount`; 401 without a token; 502 when the port fails; `GET /api/platform` passes `phoneApproval` on. Extend the fake control port in test/helpers/portal.ts with `waitingPayments`.
- [ ] T029 [P] [US4] T-WEB-13 in web/portal/test/waiting.test.tsx (new; starts with `// @vitest-environment jsdom` and its own `cleanup`): the card renders one row per payment with the amount, the seller's host, the reference code and the time left; each `reason` shows exactly the sentence of contracts/portal-api.md "Home"; values render as text (a `resourceKey` holding markup is shown literally); the card is absent when `phoneApproval` is false or the list is empty; polling stops while the tab is hidden; the card has no button.
- [ ] T030 [P] [US4] T-WEB-14 in web/portal/test/account.test.tsx: "Set up your phone" is shown only when `phoneApproval` is true and the sign-in mode is `auth0`; it opens the pop-up only from the click, with `prompt: "login"`, `max_age: 0` and the enrollment `acr_values`; a rejected pop-up shows "Nothing was changed." and keeps the session; the dev sign-in never shows the button.
- [ ] T031 [P] [US4] The Action's cases in test/auth0-iac.test.ts (T-IAC-02), run against auth0/enroll-phone.js with a fake `event` and `api`:
  - it calls `api.authentication.enrollWith({ type: "push-notification" })` once when the request's `acr_values` holds the enrollment value, the user has no push factor in `enrolledFactors`, and the latest `authentication.methods` timestamp is at most 5 minutes old;
  - it calls nothing in each other case (no `acr_values`, a push factor present, a method a day old, no methods at all), sets no claim, and never throws;
  - Terraform: one `auth0_action` for the file, bound in the post-login flow with `sign_in_time`; the tenant setting for MFA in Actions on; `guardian_policy` still defaults to `never`; still exactly two applications.

  **Must fail**: the file with its freshness check removed (a day-old session enrolls), with its `acr_values` check removed, and with its enrolled-factor check removed, each as a mutation row in the test's table.

### Implementation for User Story 4

- [ ] T032 [US4] Add the pure derivation `waitingPayments(entries, userId, nowMs): WaitingPayment[]` to src/layer2-control/escalations.ts, built field by field from the `ESCALATED` entry and the request's state (research R11's table; `phone_unreachable` only for an `APPROVAL_REQUEST_FAILED` with `phase: "start"` and `failure: "permanent"`). It takes the clock and appends nothing.
- [ ] T033 [US4] Add `GET /v1/users/:userId/escalations` to src/layer2-control/user-routes.ts with the existing guard and `route` helper (the `:userId` check): it answers `{ payments: waitingPayments(ledger.entries(), userId, now()) }` without `serialize` and without `sweep`. With the test-only `skipOwnershipCheck` of the user-account deps it lists every owner's pending escalations instead (the must-fail half of T027). Set `phoneApproval` on the `GET /v1/platform` answer from whether the service has backchannel deps. Add the route to `ENDPOINT_ROLES` in src/shared/auth.ts, to docs/l2-control.openapi.yaml and to the SPEC L2-5 table; add `waiting(userId)` to test/helpers/backchannel-l2.ts. T027 passes.
- [ ] T034 [US4] Add the portal route in src/portal/routes.ts and src/portal/control-client.ts (contracts/portal-api.md): `ControlPort.waitingPayments(userId)`; `GET /api/payments/waiting` with the `handle` helper, the user from `res.locals.person`, each item mapped with `amountAtomic`; `phoneApproval` added to the `/api/platform` answer. Update docs/portal.openapi.yaml, SPEC L2-8 and web/portal/src/api.ts and types.ts. T028 passes.
- [ ] T035 [US4] Build the card: web/portal/src/components/WaitingPayments.tsx (new) with `poll.ts` every 5 s and `money.ts`; the reason sentences in web/portal/src/messages.ts keyed by `WaitingReason`; mount it in web/portal/src/screens/Home.tsx. Store nothing in the browser (T-WEB-07) and use no `Number(` (T-WEB-03). T029 passes.
- [ ] T036 [US4] Enrollment (research R13):
  - auth0/enroll-phone.js (new): the three conditions and the one call, with a header comment in the style of auth0/sign-in-time.js;
  - auth0/main.tf: the `auth0_action`, its place in the post-login binding, and the tenant setting; check the attribute's name against the locked provider's documentation and keep `prevent_destroy` where the tenant resource is a singleton;
  - web/portal/src/auth/auth0.ts: `enrollPhone()` (the step-up pop-up plus `acr_values: ENROLL_ACR`), exported through the same interface as `stepUp`; the constant's value is the one the Action tests;
  - web/portal/src/screens/Account.tsx: the "Phone approvals" section of contracts/portal-api.md;
  - SPEC §6 (the file), L2-8 (optional enrollment) and §11: the row SEC-31 ("a phone is enrolled from a session nobody just signed in to"; tests T-IAC-02), the threat matrix, and `SEC_ROWS` raised to 31.

  T030 and T031 pass.

**Checkpoint**: a person with no phone sees why and has a way to set one up. `npx vitest run web/portal` green.

---

## Phase 7: User Story 5 - One person's agent cannot use up everyone's allowance (Priority: P2)

**Goal**: the limit of 10 requests in a rolling hour is counted for each person.

**Independent Test**: in one hour create 11 different escalations for alice and one for bob: alice is asked 10
times, the 11th is `capped`, and bob is asked.

### Tests for User Story 5 (write first; they must fail)

- [ ] T037 [P] [US5] T-CIBA-19 in test/backchannel-fatigue.test.ts: 11 escalations of alice's on 11 resources within the hour, then one of bob's: 10 requests carry alice's subject, alice's 11th is `capped` and pending for the operator, bob's is `requested` and sent; an hour and a second after alice's first, alice's next is `requested` again; a repeat of a pending purchase counts nothing (T-CIBA-03 unchanged). Pure cases in test/escalations.test.ts for `approvalRequestCount(entries, nowMs, windowMs, userId)`: entries of another user and entries with no user count for nobody. **Must fail**: with `sharedRequestCap`, bob is not asked.

### Implementation for User Story 5

- [ ] T038 [US5] Count per person: `approvalRequestCount` in src/layer2-control/escalations.ts takes a required `userId` and counts only `ESCALATED` entries with `approvalRequest: "requested"` and that `userId`; `eligibility` in src/layer2-control/backchannel.ts passes the owner. Add the test-only switch `sharedRequestCap?: boolean` (counts every `requested` entry, whoever it is for). Reword SEC-18 in SPEC §11 ("per person") and the eligibility bullet of L2-7. T037 passes; T-CIBA-04 keeps passing with one person.

**Checkpoint**: one person at the limit changes nothing for another.

---

## Phase 8: User Story 6 - No approver is configured anywhere (Priority: P2)

**Goal**: no setting names an approver, a leftover one stops L2, and the tenant's configuration depends on no
one person.

**Independent Test**: read every place a deployment is configured and find no approver; start L2 with a leftover
setting and see it refuse, naming the setting; plan the tenant with no approver given.

### Tests for User Story 6 (write first; they must fail)

- [ ] T039 [P] [US6] T-CIBA-24 in test/ciba-client.test.ts and test/backchannel-failures.test.ts:
  - `CIBA_APPROVAL=1` with `CIBA_APPROVER=auth0|leftover-value-91c2`: `cibaConfigFromEnv` throws a `ConfigError` whose message contains `CIBA_APPROVER` and not the value;
  - `CIBA_APPROVAL` off with `CIBA_APPROVER` set: `ignored` lists it, as today;
  - a complete configuration without `CIBA_APPROVER` is enabled;
  - `main()`'s check: `CIBA_APPROVAL=1` without `USER_ACCOUNTS=1` throws naming both, before the ledger lock is taken (no lock file appears);
  - `createControlService` with backchannel deps and no user-account deps throws.
- [ ] T040 [P] [US6] T-IAC-01 rule 19 in test/infra.test.ts (contracts/config-and-secrets.md "T-IAC-01 rule 19, as amended"): the compiled `ciba` has exactly the keys `audience, clientId, clientKeyId, credential, enabled, issuer`; no app has a `CIBA_APPROVER` environment variable; `main.bicep` calls `fail()` for `ciba.enabled` without `userAccounts.enabled`. **Must fail** rows: an `approver` key, the variable put back in the L2 app, the `fail()` removed.
- [ ] T041 [P] [US6] T-IAC-02 and the setup script in test/auth0-iac.test.ts and test/github-setup.test.ts: `REQUIRED` is `tenant_domain, api_identifier, client_public_key_pem`; `VARIABLES` has no `approver_user_id`; the variables without a default are `api_identifier, environment, tenant_domain`; the output `bicepparam_ciba` has exactly the parameter file's `ciba` keys; `github-setup.sh` creates five variables and never deletes or overwrites one. **Must fail** rows: an `auth0_user` data source, an `auth0_user` resource, `approver` in an output, the pipeline reading `vars.AUTH0_APPROVER_USER_ID`. Replace the existing rows that used `var.approver_user_id` as their example by another variable.

### Implementation for User Story 6

- [ ] T042 [US6] Refuse a leftover approver in src/layer2-control/ciba-client.ts: with `CIBA_APPROVAL=1`, a present `CIBA_APPROVER` throws `ConfigError("CIBA_APPROVER is no longer used: remove it (SPEC L2-7)")`, checked right after the switch; keep the name in the list used for the "ignoring …" line. In src/layer2-control/service.ts, `main()` throws `ConfigError("CIBA_APPROVAL=1 needs USER_ACCOUNTS=1 (SPEC L2-7)")` after both configs are read and before `acquireLedgerLock`, and `createControlService` throws when `deps.backchannel` is set without `deps.users`. T039 passes.
- [ ] T043 [P] [US6] Remove the approver from L2's deployment settings, in the same change as T042 (research R18):
  - env/l2-control.env.example: delete the `# CIBA_APPROVER=` line; test/architecture.test.ts `TEMPLATES`: the `l2-control` spec loses the name (T-ARCH-ENV);
  - infra/main.bicep: `approver` out of the `ciba` comment and of `cibaChecked`, its `fail()` message reworded, and a new `fail()` when `ciba.enabled && !userAccounts.enabled`;
  - infra/main.dev.bicepparam: `approver` out of `ciba`, and the comment above it no longer mentions the approver's enrollment;
  - infra/modules/l2-apps.bicep: the `CIBA_APPROVER` environment variable removed.

  Update SPEC CFG-2 (the `l2-control.env` row) and §3.1's Azure profile. T040 passes.
- [ ] T044 [P] [US6] Remove the approver from the tenant's configuration and its pipeline:
  - auth0/variables.tf: `approver_user_id` deleted; auth0/main.tf: `data "auth0_user" "approver"` and its comment deleted, the client's description reworded ("asks the person a run is for"); auth0/outputs.tf: `approver` out of `bicepparam_ciba` and the `CIBA_APPROVER=` line out of the env output;
  - .github/workflows/provision-auth0.yml: `VAR_approver_user_id`, its `required` entry and its name in the export loop, and the header comment;
  - infra/github-setup.sh: `AUTH0_APPROVER_USER_ID` out of `AUTH0_VARIABLES`.

  Run `terraform -chdir=auth0 validate` if Terraform is installed; the lock file does not change. T041 passes.

**Checkpoint**: quickstart §4's `grep` finds only the refusal in ciba-client.ts.

---

## Phase 9: User Story 7 - The operator and the auditor see whose phone was asked and how each request ended (Priority: P3)

**Goal**: the views show who was asked and how the request ended, and the ledger alone tells it for a request
nobody answered, with or without a restart.

**Independent Test**: drive one escalation through each outcome, once with L2 running throughout and once with
a restart while the request is open; the views and the ledger show the owner's identifier, the path and how
the request ended, and no token, handle, service text, name or email.

### Tests for User Story 7 (write first; they must fail)

- [ ] T045 [P] [US7] T-CIBA-21 in test/backchannel-lapse.test.ts and test/escalations.test.ts:
  - the stand-in grants the full requested lifetime (`{ expiresIn: <the requested_expiry> }`, as Auth0 does) and never answers; the clock passes 300 s with L2 running: the ledger holds `APPROVAL_REQUESTED`, then `ESCALATION_EXPIRED`, and no `APPROVAL_REQUEST_LAPSED`; `approvalRequestState` is `unanswered`;
  - the same with L2 closed and a new instance started on the ledger after the window: `unanswered`, and nothing is appended but the expiry;
  - before any sweep, with the clock past the window, the state is already `unanswered`;
  - an operator approval while the request is open: `abandoned`;
  - the existing case with a shorter lifetime still gives `APPROVAL_REQUEST_LAPSED` and `lapsed`.
- [ ] T046 [P] [US7] T-CIBA-23 in test/backchannel-views.test.ts: load a ledger fixture written by v1.15 (a backchannel `HUMAN_APPROVAL` and a `HUMAN_REJECTION` with `approver: "auth0|approver-1"`, `evidence.subject`, and an `APPROVAL_VERIFICATION_FAILED` with `check: "approver"`): `verifyChain` is ok, the events show `decidedBy: "auth0|approver-1"` and `check: "approver"`, and nothing throws. Build that ledger in the test with `AuditLedger.append` into a temporary file, so its hashes are real; add no fixture file.
- [ ] T047 [P] [US7] Extend T-CIBA-14 in test/backchannel-views.test.ts: for each outcome (approved, refused, unanswered, failed, capped, `no_owner`, `identity_mismatch`) the operator's list and events and the administration list show `userId` (the owner), `approvalRequest` (the state), `channel` and `decidedBy` (the owner's `usr_…` for a phone decision), each from the whitelist; an event row has no key outside `EscalationEvent`.

### Implementation for User Story 7

- [ ] T048 [US7] Give the request's state the clock in src/layer2-control/escalations.ts (research R9): `approvalRequestState(entries, escalationId, nowMs)` returns `unanswered` when the mark is `requested`, no ending entry exists, and `escalationState(entries, escalationId, nowMs)` is `expired`; `abandoned` only when a person's decision on another path exists. Pass `nowMs` from every caller (`viewOf`, `escalationDetail`, src/layer2-control/backchannel.ts, the admin and operator routes). Correct the outcome sentence of SPEC L2-7 ("a request that lives as long as its escalation ends with `ESCALATION_EXPIRED` alone and reads as `unanswered`; `APPROVAL_REQUEST_LAPSED` is written only when the request ends first") and add `unanswered` to SPEC §7 and both OpenAPI documents. T045 passes.
- [ ] T049 [US7] Show the new values to the operator: in scripts/escalations.ts print `approvalRequest` for `no_owner`, `no_identity`, `identity_mismatch` and `unanswered` like the existing states (no new column), and keep `approver=` printing whatever the entry holds. Update the descriptions of `approver`, `decidedBy` and `check` in docs/l2-control.openapi.yaml and docs/portal.openapi.yaml. T046 and T047 pass.

**Checkpoint**: every story is done. The 2026-11-12 finding is closed by T045.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: the documents that must agree with the behavior, and the final validation.

- [ ] T050 [P] Finish SPEC.md v1.16 from plan.md "SPEC and governance changes": §1.2 and §1.3 (per-user approval by phone in scope; approving in the portal as a user and people's runs in a deployed environment out), §2 (owner), §3.3 (the client credential's row), the rest of L2-7 ("one approver per L2" removed; start; resume), §11's residual risks (the four of plan.md's amendment added; "an escalation of a user's payment still goes to the operator and the one configured approver" removed), §12 (T-CIBA-15..24, T-USR-13, T-PRT-15, T-WEB-13..14, T-AGT-08, T-E2E-15 and the amended T-IAC rows) and §13. Complete the "Changes in 1.16" table.
- [ ] T051 [P] Amend .specify/memory/constitution.md to 1.8.0 with a Sync Impact Report (research R16): the scope sentence, Principle V's "the owner's signed answer", the residual risks. No principle or invariant is removed or redefined.
- [ ] T052 [P] Update specs/README.md: the 015 row (SPEC v1.16) and the traceability rows (L2-7, SEC-17, SEC-18, SEC-30, SEC-31, the new test IDs).
- [ ] T053 [P] Point the earlier features here: a dated note at the top of specs/012-ciba-escalation-approval/quickstart.md §5 (research R19) and one line in each of its contracts that names the approver (auth0-ciba.md, config-and-secrets.md, ledger-backchannel.md); one line in specs/013-*/contracts/control-api.md and portal-api.md for the new route.
- [ ] T054 [P] Update CLAUDE.md: "What this repo is" (an escalation of a person's run is approved by that person's phone); the CIBA gotchas (no approver; `CIBA_APPROVAL=1` needs user accounts; a leftover `CIBA_APPROVER` stops L2); the Auth0 gotchas (five variables; the second Action; no `auth0_user`); the user-account route note; the new must-fail switches; hard rule 11's note that the subject is never stored.
- [ ] T055 [P] Update README.md (the "From the approver's phone" section becomes "From your own phone"), auth0/README.md (the variable table, the steps, "the approver enrolls" replaced by "Set up your phone"), and docs/diagrams/x402-approval.json and x402-architecture.json with their rendered HTML (the phone path asks the run's owner).
- [ ] T056 Run quickstart.md §1 to §5 and record each result in its Validation log: `npm run check` (the summary `spent on-chain: 0.006 USDC` and `hash chain ok=true`), the must-fail run, the local walk-through, the `grep`, the compiled `ciba` keys, the two refusals at startup, and "off means off".
- [ ] T057 Check the delivery order against research R18 before opening pull requests: T042 and T043 are in the same pull request; no pull request leaves a deployed L2 with `CIBA_APPROVER` set and `CIBA_APPROVAL=1`. List in the pull request what quickstart §6 and §7 leave for the owner to do by hand (the tenant's plan and apply, deleting `AUTH0_APPROVER_USER_ID`, the seven enrollment checks).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: needs T001. Blocks every story.
- **US1 (Phase 3)**: needs Phase 2. The MVP.
- **US2 (Phase 4)** and **US3 (Phase 5)**: need US1 (they test and harden its eligibility and verification).
  Independent of each other.
- **US4 (Phase 6)**, **US5 (Phase 7)**, **US6 (Phase 8)**, **US7 (Phase 9)**: need US1. Independent of one
  another, with two shared files to watch: `escalations.ts` (T032, T038, T048) and `backchannel.ts` (T038, T026).
- **Polish (Phase 10)**: needs the stories it documents; T056 and T057 need all of them.

### Within each story

- Tests first, failing, then the implementation tasks in order.
- In US1: T009 and T010 before T011; T011 before T012 and T013; T014 after T013.
- In US4: T032 before T033; T033 before T034; T034 before T035. T036 needs only T001 and T034's `phoneApproval`.
- In US6: T042 and T043 together; T044 independent of both.

### Parallel opportunities

- T001 and T002.
- T004 with T003; T005 after both.
- Each story's test tasks are all [P] (different files, or separate `describe` blocks added in one sitting).
- After US1: US2, US3, US5, US6 and US7 by different people, minding the shared files above.
- In US6: T043 and T044. In Polish: T050 to T055.

---

## Parallel example: User Story 4

```bash
# The five test tasks, each in its own file:
Task: "T027 T-USR-13 in test/users.test.ts and test/backchannel-views.test.ts"
Task: "T028 T-PRT-15 in test/portal.test.ts"
Task: "T029 T-WEB-13 in web/portal/test/waiting.test.tsx"
Task: "T030 T-WEB-14 in web/portal/test/account.test.tsx"
Task: "T031 the Action's cases in test/auth0-iac.test.ts"

# Then L2, the portal and the web app in order (T032 → T033 → T034 → T035), with T036 beside them.
```

---

## Implementation Strategy

### MVP first (User Stories 1 to 3)

1. Phase 1 and Phase 2: the shapes, the field accepted, the helpers. T-CIBA-01..14 still green.
2. US1: the request goes to the owner and their answer decides.
3. US2 and US3: the checks are proven, and a run with no person asks nobody.
4. **Stop and validate**: `npm run check`, and `npx vitest run test/backchannel-owner.test.ts`.

US1 alone is not safe to turn on: it has the owner and identity checks, but not their proofs, and a leftover
`CIBA_APPROVER` is silently ignored until US6. The feature is off by default throughout.

### Incremental delivery

1. US1 to US3 with US6's T042 and T043: the payment-authority change and L2's settings.
2. US5: the limit per person.
3. US7: the views and the lapse finding.
4. US4: the person's view and enrollment.
5. US6's T044 and the Polish phase.

### Along the plan's slices

| Slice (plan.md "Delivery") | Tasks |
|---|---|
| 1. L2 and its deployment settings | T001–T006, T009–T013, T015–T023, T025, T026, T037–T040, T042, T043, T045–T049 |
| 2. The hosted agent | T007, T008, T014, T024 |
| 3. A person's view | T027–T030, T032–T035 |
| 4. The tenant | T031, T036, T041, T044 |
| 5. Documents | T050–T057 |

---

## Notes

- [P] tasks touch different files and have no dependency on an incomplete task.
- Every task leaves `npm run typecheck` green; every checkpoint leaves `npm run check` green.
- A must-fail half is part of its test task: a safety check without it is not done (Constitution VIII).
- No task edits `policy.ts`, `ledger.ts`, `signer.ts`, `approval-routes.ts` or `admin-routes.ts`. If one seems
  to need to, stop: the plan's design does not.
- Nothing here can be checked with a real phone for a real person's run (spec FR-028). Quickstart §7's checks
  of enrollment are by hand and are not a gate.
- Commit after each task or small group, with the task IDs in the message.
