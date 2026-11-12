# Research: Per-User Backchannel Approval

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-11-12

Each entry is a decision the plan rests on, with its reason and what was rejected. Everything was read from the
code and SPEC v1.15 on `main` (17d9c81), except R13, which also rests on Auth0's documentation and is marked
where it could not be checked against a tenant. The owner's five decisions are in the spec's Clarifications and
are not reopened here.

## R1. The owner's identity travels on the payment request, as one new field

**Decision.** `PaymentIntent` gains `approvalSubject?: string`: the person's subject at the approval service,
which is the `sub` of the sign-in token the hosted agent verified. Only the hosted agent sets it, and only for a
run started by a person (R14).

L2 validates its shape with the rest of the body, whether backchannel approval is on or off, as it does for
`userId`:
- a string of 1 to 255 characters with no whitespace and no control character (an Auth0 user ID is
  `<connection>|<id>`);
- never without `userId`: an identity with nobody to belong to is malformed;
- anything else is 400, after the token check (401 still precedes 400).

The issuer is **not** sent. L2 uses its own configured approval issuer for the check of R2 and for the request,
so no caller can choose which issuer a subject is read under.

**Rationale.** It is what the owner decided (spec Clarifications, D3). One optional field keeps every existing
caller valid: the scripted agent, the command-line agent and a system identity's run send nothing new.

**Alternatives considered.**
- *A request header.* Hides a contract field outside `src/shared/contracts.ts`, against hard rule 1's intent.
- *Sending issuer and subject.* A second input to trust for no gain: the only issuer that can be asked is L2's own.
- *L2 asks the approval service for the user.* Needs a Management API credential in L2 (against FR-005).

## R2. The identity check: recompute the one-way identifier

**Decision.** `userIdFor(<L2's approval issuer>, approvalSubject) === userId`, computed inside the serialized
section that writes the new `ESCALATED`, as part of eligibility (R4). `userIdFor` is pure and already shared
(`src/shared/user-id.ts`), so L1 and L2 compute the same value with no shared secret.

- A match: the subject may be used to address one approval request.
- No match: the escalation is marked `identity_mismatch`. No request is sent on it.
- No subject at all: the escalation is marked `no_identity`.

In the last two cases the payment is decided exactly as without the field, and the escalation waits for the
operator and the administrators.

This one comparison also enforces the owner's "same tenant" decision (D4): the identifier is made from the
issuer's host and the subject, so a person who signed in with any other issuer, the local dev issuer included,
can't match. There is no list of issuers and no recorded link between identities.

**Rationale.** L2 already trusts `userId` from the agent's `CONTROL_TOKEN`; the check ties the new field to that
existing trust and adds none. A caller that holds `CONTROL_TOKEN` and names user A cannot have A's request sent
to another phone: it would need a subject that hashes to A's identifier, which is A's own.

**One thing to keep in mind.** `issuerHost` lowers a web address to its host, so `https://tenant/` and
`https://tenant` are one issuer. A tenant reached by a custom domain at sign-in and by its canonical domain for
approvals would be two issuers: nobody would be asked, which fails closed. The quickstart checks that the
portal's issuer and `CIBA_ISSUER` are the same host.

**Alternatives considered.**
- *Refuse the whole payment request on a mismatch (400 or DENIED).* Breaks every local run with the dev issuer,
  whose subject can never match. The spec's Assumptions record the chosen reading.
- *Check in the hosted agent.* The agent is the caller being checked.

## R3. The approver check becomes an owner check, from the signed answer alone

**Decision.** Verification keeps its ten steps and their order (`approval-evidence.ts`). Step 7 is renamed
`owner` and compares `userIdFor(claims.iss, claims.sub)` with the user recorded on the escalation. Step 3 has
already pinned `claims.iss` to L2's issuer. `ExpectedApproval.approver` becomes `ownerUserId`.

- The check needs nothing stored and nothing configured, so it works the same after a restart.
- The evidence stops carrying `subject`. It becomes `{ issuer, userId, answerId, issuedAt, detailsSource }`.
- `VERIFICATION_CHECKS` gains `owner` and keeps `approver` as a value that is read (entries written before this
  feature) and never produced.

**Rationale.** FR-013 and FR-020. The answer's subject is used for one comparison and dropped.

**Alternatives considered.**
- *Keep the subject in the evidence.* Puts the Auth0 user ID in the append-only ledger, which D3 rejected.
- *Keep the name `approver`.* The views would name a check that no longer says what it checks.

## R4. Eligibility: three new marks, decided in the same place

**Decision.** `ESCALATED.data.approvalRequest` is still decided inside the section that writes the entry, from
the ledger and the request only. The order is fixed:

| Order | Condition | Mark | Request sent |
|---|---|---|---|
| 1 | a re-evaluation after a wait | `reevaluation` | no (as today) |
| 2 | `operatorApprovalOnly` | `operator_only` | no (as today) |
| 3 | the escalation records no user | `no_owner` (new) | no |
| 4 | no `approvalSubject` | `no_identity` (new) | no |
| 5 | the subject does not resolve to the user (R2) | `identity_mismatch` (new) | no |
| 6 | the owner has 10 `requested` escalations in the trailing hour (R5) | `capped` | no |
| 7 | otherwise | `requested` | one, to the owner |

A repeat of a pending purchase is caught earlier and writes `ESCALATION_REPEATED`, as today.

**Rationale.** FR-006 to FR-008. A mark on the entry is how an escalation "is recorded as one that asks nobody",
and it is what the person's view and the operator's view read (R11). The limit is checked last so that an
escalation that could never be sent does not use up anybody's allowance.

**Alternatives considered.**
- *No mark for the three new cases.* The views could not tell "asked nobody" from "feature off".
- *One mark, `not_asked`.* The person could not be told why (FR-019).

## R5. The limit, per person

**Decision.** `approvalRequestCount(entries, nowMs, windowMs, userId)` counts `ESCALATED` entries marked
`requested` **whose `userId` is that person** in the trailing hour. The cap stays 10 and stays a constant.
Entries with no user (the platform account's, written before this feature) count for nobody. There is no
overall limit (spec Assumptions).

**Rationale.** FR-015, SEC-18. Still derived from the ledger on each decision: no counter (hard rule 4).

**Alternatives considered.**
- *Count `APPROVAL_REQUESTED` entries.* A request that was attempted and failed would not count, so a failing
  approval service would lift the limit. Today's rule counts the attempt; it stays.

## R6. What the ledger writes: the owner's one-way identifier, where the approver's subject was

**Decision.** Field names stay; one value changes meaning for new entries.

| Entry | Field | Before | From this feature on |
|---|---|---|---|
| `APPROVAL_REQUESTED` | `approver` | the configured approver's subject | the owner's `usr_…` |
| `HUMAN_APPROVAL` (backchannel) | `approver` | the answer's subject | the owner's `usr_…` |
| `HUMAN_APPROVAL` (backchannel) | `evidence` | `{ issuer, subject, answerId, issuedAt, detailsSource }` | `{ issuer, userId, answerId, issuedAt, detailsSource }` |
| `HUMAN_REJECTION` (backchannel) | `approver` | the configured approver's subject | the owner's `usr_…` |

- The views already read `approver` as "who decided" (`deciderOf`, the `approver` and `decidedBy` fields), so a
  backchannel decision now shows `usr_…`, as a portal decision does.
- Entries written before this feature are not touched and still read: their `approver` is whatever was written.
- `approvalSubject` is written nowhere: not on `INTENT`, not on `ESCALATED`, not on a request entry.

**Rationale.** FR-020 and FR-022. No new entry type and no migration.

**Alternatives considered.**
- *A new field `owner` and no `approver` on new entries.* Every reader would need two branches for one meaning.
- *A hash of the subject.* It is the `usr_…` identifier already.

## R7. Where the subject lives, and for how long

**Decision.** Three places, all in memory:
1. the request body of the authorize call;
2. `StartPlan.subject`, handed from the serialized section to the fire-and-forget start;
3. the `login_hint` of the one request to the approval service (`CibaPort.start({ …, subject })`, replacing the
   configured value in `ciba-client.ts`).

It is never appended, logged, returned or put in an event. L2's lifecycle log lines keep their whitelisted
fields (the escalation ID, the reference code, a failure code). After a restart the subject is gone, and nothing
needs it: polling uses the sealed handle and verification uses R3. A request that was started but never recorded
(`interrupted`) is never resent, as today, which is also why it never needs the subject again.

**Proof.** A known-value scan (T-CIBA-20) plants a recognizable subject and searches the ledger file, L2's log
lines, every response body and every event for it (NFR-004).

## R8. Configuration: the approver goes, and the feature needs user accounts

**Decision.**
- `CIBA_APPROVER` leaves `CibaSettings`, `publicSettings` and `BackchannelDeps`.
- With `CIBA_APPROVAL=1`, a present `CIBA_APPROVER` is a configuration error that names the variable and never
  its value, checked before the ledger lock like the rest of the `CIBA_*` settings (FR-003).
- With the feature off, a present `CIBA_APPROVER` is named in the one "ignoring …" line, as today.
- `CIBA_APPROVAL=1` without `USER_ACCOUNTS=1` is a configuration error naming both, before the lock (FR-001).
  `createControlService` refuses backchannel deps without user-account deps for the same reason.
- The startup line says `backchannel approval on (issuer …, per user)`.

**Rationale.** A setting that looks as if it mattered is worse than a refusal (spec Assumptions). Without user
accounts no payment names a user, so the feature would be on and could ask nobody.

**Alternatives considered.**
- *Ignore a leftover approver with a warning.* An operator would believe a fallback exists.

## R9. The 2026-11-12 finding: an unanswered request usually ends with `ESCALATION_EXPIRED` alone

**What the code does.** The request's lifetime is `min(sent + expires_in, the escalation's expiry)`, and L2 asks
for exactly the escalation's remaining window. So a request normally expires within a second of its escalation.
The poll loop sleeps for the service's interval (5 s), then checks `pendingAt` **before** it checks the
request's own expiry. On the first wake-up after both have passed, the escalation is no longer pending, so the
loop returns and records nothing. `recordLapse` has the same guard. After a restart, `requestsToResume` skips
escalations that are no longer pending. So:

- **A clean timeout behaves like the restart case**: `ESCALATION_EXPIRED` and no `APPROVAL_REQUEST_LAPSED`.
- `APPROVAL_REQUEST_LAPSED` is written only when the request ends **before** its escalation: the service answers
  `expired_token` early, grants a shorter lifetime, or refuses within 5 s of the expiry.
- The existing test (`backchannel-lapse.test.ts`, "no answer until the request's own expiry") passes because its
  stand-in grants a lifetime shorter than the window.

SPEC L2-7 says "no answer gives `APPROVAL_REQUEST_LAPSED`". That sentence is wrong for the usual case.

**Decision.** Fix the reading, not the writing. The ledger already holds the facts; one derived state names them:

- `ApprovalRequestState` gains `unanswered`: the escalation was marked `requested`, no entry ended its request,
  and the escalation expired.
- `abandoned` keeps its meaning for the other half of what it covered: another path decided while the request
  was open.
- `approvalRequestState` takes the clock, so it gives `unanswered` once the window has passed, swept or not.
- SPEC L2-7's sentence is corrected, and T-CIBA-21 proves both cases: L2 running throughout, with a stand-in
  that grants the full window as Auth0 does, and L2 restarted while the request is open.

**Rationale.** FR-023 asks that the ledger tell how every request ended. It does: `APPROVAL_REQUESTED`, no
ending, `ESCALATION_EXPIRED`. Constitution III prefers a derivation to another entry, and nothing is appended
after a final state.

**Alternatives considered.**
- *Append `APPROVAL_REQUEST_LAPSED` beside `ESCALATION_EXPIRED` in the sweep.* Two entries for one fact, and the
  sweep would have to know about approval requests.
- *Check the request's expiry before `pendingAt` in the poll loop.* The lapse would be appended after the
  escalation is already expired by the clock, and still not after a restart.

## R10. A request that is open when this feature is deployed

**Decision.** `resume()` polls only requests whose escalation records a user. A request of an escalation with no
user (addressed to the old configured approver) is not polled: L2 records `APPROVAL_REQUEST_FAILED` with
`phase: "resume"` and the new failure value `no_owner`, and the escalation follows its usual 300 s on the
operator path.

**Rationale.** The spec's edge case: it is not resumed for anyone else. An answer to it could not pass R3
anyway, since there is no owner to compare with. The window is 300 s and dev runs with `ciba.enabled: false`, so
this is about never leaving a request polled with no possible outcome.

## R11. What a person sees: their own waiting payments, with a reason from a fixed list

**Decision.**
- **L2**: `GET /v1/users/:userId/escalations` (`PORTAL_TOKEN`), beside the other user-account routes. It lists
  the pending escalations whose owner is that user. It reads the entries and one clock value; it does not sweep
  and appends nothing, like the administration reads.
- Each item is built from a whitelist: `authorizationId`, `referenceCode`, `resourceKey`, `payTo`, `amount`,
  `createdAt`, `expiresAt`, `waitingFor` and, when it waits for the operator, `reason`.
- **L2** also says whether phone approval is on at all: `phoneApproval: boolean` on the platform view
  (`GET /v1/platform`). It is not a secret, and it saves the portal a setting of its own.
- **The portal**: `GET /api/payments/waiting`. The user comes from the verified token; the route takes no
  identifier (FR-019, SEC-19).
- **The web app**: a "Waiting for approval" card on the home screen, polled with the existing `poll.ts`, and the
  messages for each reason in `messages.ts`.

| The escalation's request state | `waitingFor` | `reason` |
|---|---|---|
| `requested` | `phone` | none |
| `capped` | `operator` | `limit_reached` |
| `no_identity`, `identity_mismatch` | `operator` | `sign_in_not_supported` |
| `failed`, a permanent refusal at start | `operator` | `phone_unreachable` (R12) |
| `failed`, anything else | `operator` | `service_unavailable` |
| `lapsed` | `operator` | `request_expired` |
| `verification_failed` | `operator` | `answer_not_accepted` |
| `operator_only`, `reevaluation`, or no mark (feature off) | `operator` | none |

An expired or decided escalation is not in the list: it is no longer waiting.

**Rationale.** FR-019. The reason is a code chosen by this system; the approval service's text is never kept
(L2-7), so it could not be shown even by mistake. This is a read of pending items only, not the payment history
that stays out of scope.

**Alternatives considered.**
- *Tell the agent, in the decision.* The agent would learn about its owner's phone; FR-010 keeps its view as it is.
- *Reuse the administration list filtered by owner.* It would need the administration token in the user half of
  the portal, against rule A13.

## R12. "No phone" cannot be told apart from other permanent refusals

**What is known.** On 2026-11-12 a user with no Guardian enrollment made Auth0 answer 400 `invalid_request`
(`specs/012` quickstart, "Results so far", on PR #31's branch). L2 keeps the error code and never the
description. `invalid_request` is also what a malformed request would get.

**Decision.** The reason is `phone_unreachable`, worded as: "We could not send a request to your phone. If you
have not set up a phone for approvals, you can do it under Account." It applies to any permanent refusal when
the request is started. The spec's Assumptions allowed this wider wording.

**Alternatives considered.**
- *Keep the error description to tell the cases apart.* Free text from the service in the ledger, against L2-7.
- *Ask the service in advance whether the person enrolled.* Needs a Management API credential (FR-005).

## R13. Enrollment: the tenant's own, asked for by the portal's sign-in

**Decision.** A person sets up their phone through a sign-in pop-up, with their own credentials, and the tenant
enrolls the push factor during that sign-in. Nothing in this system holds the enrollment.

- **The web app.** "Set up your phone" in the Account screen opens the existing step-up pop-up (`prompt=login`,
  `max_age=0`, so credentials are entered again) with one more parameter, `acr_values` set to
  `urn:x402:acr:enroll-phone`. The button is shown only when `phoneApproval` is true (R11) and the person signed
  in with the tenant. It sits behind a click, as every pop-up does.
- **The tenant.** A second post-login Action, `auth0/enroll-phone.js`. It does something only when all three
  hold: the request carries that `acr_values` entry, the person has no push factor in
  `event.user.enrolledFactors`, and the latest entry of `event.authentication.methods` is at most 5 minutes
  old. Then it calls `api.authentication.enrollWith({ type: "push-notification" })`. Otherwise it does nothing
  and never fails a sign-in.
- **Terraform.** The Action and its binding in the post-login flow, and the tenant setting that lets an Action
  choose MFA factors (`customize_mfa_in_postlogin_action`). `guardian_policy` stays `never`: nobody is asked
  for a second factor at sign-in, so enrollment stays optional (D2).
- **No credential.** The pipeline's existing Management API credential installs the Action, as it installs
  `sign-in-time.js`. L2, the portal and GitHub get nothing new (FR-005).

**Why the freshness check.** Without it, whoever sits at a person's open browser session could enroll a phone of
their own without knowing the password, and then approve that person's escalations. `prompt=login` is asked by
the browser, which an attacker controls, so the Action checks the time itself. T-IAC-02 runs the Action and has
a must-fail case for it.

**What the phone does not protect.** Somebody who knows a person's sign-in credentials, where that person never
enrolled, can enroll their own phone. The phone is then no second factor. This is a new residual risk in SPEC
§11, bounded by that person's policies and the platform limits.

**The portal does not know whether a phone is set up.** No claim says so, and adding one is not needed: the
button is always offered, and pressing it with a phone already enrolled is a plain re-confirmation of identity,
because the Action then calls nothing. Removing or replacing a phone is done with the tenant's own means and is
not part of this feature.

**From Auth0's documentation, not yet checked against a tenant** (quickstart §7 lists them as checks):
1. `enrollWith` accepts `push-notification`, and a request for a factor that is already enrolled must be
   avoided, because a request with no factor left to enroll fails the sign-in. Hence the `enrolledFactors` test.
2. `event.transaction.acr_values` carries what the pop-up sent.
3. The Terraform attribute's exact name and place for `customize_mfa_in_postlogin_action`, and that turning it
   on changes nothing else at sign-in while `guardian_policy` is `never`.
4. A push factor enrolled this way receives CIBA requests, as the one enrolled by hand on 2026-11-12 did.
5. A person who closes the pop-up during enrollment keeps their current portal session.

**Alternatives considered.**
- *An enrollment ticket from the Management API.* A new credential in the portal or L2 (against FR-005).
- *The MFA API (`/mfa/associate`).* Needs a grant the single-page client does not have, and an MFA token flow.
- *MFA required at sign-in.* That is "enrollment required", which the owner rejected (D2).
- *Document "enroll in the tenant's own pages" and build nothing.* FR-018 asks that a person can do it
  themselves with no administrator; the tenant has no such page without a prompt from a sign-in.

## R14. The hosted agent: one more value fixed before the run

**Decision.** `server.ts` already computes `userId` from the verified requester when its kind is `user`. It
passes `requester.subject` beside it, down the same path (`runAgent` options, the orchestrator's deps, the
intent). Nothing else changes in L1:

- the tools stay `fetch_resource` and `check_budget`, with no input for it;
- it is not part of the instructions, a tool result, the run result or the run log;
- a system identity's run, a `bypassAuth` test run, the scripted agent and the command-line agent send nothing.

**Rationale.** FR-010. The value is fixed before the model produces anything, like `userId` (013 FR-033).

**Note, not a change.** The hosted agent's own limits and log already key a person by issuer host and subject
(`Requester.key`, 011 and 013). This feature adds no new place where L1 writes the subject.

## R15. The approver leaves the infrastructure

**Decision.** Every place found on `main`:

| Where | What goes |
|---|---|
| `env/l2-control.env.example` | the `CIBA_APPROVER` line |
| `infra/main.bicep` | `approver` in the comment and in `cibaChecked`; new: `fail()` when `ciba.enabled` without `userAccounts.enabled` |
| `infra/main.dev.bicepparam` | `approver` in `ciba`, and the comment that mentions the approver's enrollment |
| `infra/modules/l2-apps.bicep` | the `CIBA_APPROVER` environment variable |
| `auth0/variables.tf`, `main.tf`, `outputs.tf` | `approver_user_id`, `data.auth0_user.approver`, `approver` in `bicepparam_ciba` and in the env output |
| `.github/workflows/provision-auth0.yml` | `VAR_approver_user_id`, its `required` entry and its place in the export loop |
| `infra/github-setup.sh` | `AUTH0_APPROVER_USER_ID` in `AUTH0_VARIABLES` |
| `auth0/README.md`, `README.md`, `CLAUDE.md` | the approver's rows, steps and gotchas |

- **T-IAC-01 rule 19** no longer asks for an approver and fails on a `CIBA_APPROVER` in any app, on an
  `approver` key in `ciba`, and on `ciba.enabled` accepted without user accounts.
- **T-IAC-02** drops the variable from `REQUIRED` and `VARIABLES`, fails on any `auth0_user` data source or
  resource (the tenant's configuration depends on no one person), and runs the new Action (R13).
- The GitHub variable `AUTH0_APPROVER_USER_ID` that exists in `auth0-dev` is no longer read. Deleting it is one
  manual step in the quickstart; `github-setup.sh` creates five variables where it created six.

**Rationale.** FR-002 and FR-004. The L2 change and the Bicep change land in one slice (R18), so no deployed L2
ever starts with a leftover `CIBA_APPROVER` and refuses (R8).

## R16. Versions and governance

**Decision.** SPEC.md 1.15 → **1.16**. Constitution 1.7.0 → **1.8.0** (MINOR), with a Sync Impact Report:
- the scope sentence "a user approving their own payments stays out" becomes: a user approves their own
  payments by phone, and approving them in the portal stays out;
- Principle V's sentence on the approval-service credential says "the owner's signed answer" where it says
  "the approver's";
- residual risks: the three of the spec's Assumptions, plus the one of R13.

No principle or invariant is removed or redefined. New threat rows: **SEC-30** (an answer from another person,
or a request pointed at another phone) and **SEC-31** (enrollment from a session nobody just signed in to).
SEC-17 and SEC-18 are reworded.

## R17. Testing approach

**Decision.**
- **L2, in process** (`test/helpers/backchannel-l2.ts`, the stand-in of `test/helpers/ciba-stub.ts`). The helper
  gains user accounts and two onboarded people whose identifiers are made from the stand-in's own issuer, so the
  identity check passes as it would with one tenant. The stand-in answers as whoever a test names, so it can
  return B's signed answer for A's request.
- **The hosted agent.** T-AGT-08 checks what the agent sends and where it does not appear. T-E2E-15 runs the
  hosted agent, L2 and the stand-in together on the local chain, with a person's token issued under the
  stand-in's issuer (the hosted test helper already injects the people's verifier).
- **The portal and the web app.** In-process portal against a fake control port; components in jsdom.
- **Static.** T-IAC-01 rule 19, T-IAC-02 (variables, no `auth0_user`, the Action run with fake `event` and
  `api`), T-API-01..04 and 12..15 for the changed documents.
- **Must-fail switches** are test-only deps, never environment variables
  ([plan.md](plan.md#proofs-constitution-viii)).
- **No live check with a real phone** (FR-028). Enrollment can be tried by hand in the tenant (quickstart §7);
  it is not a gate.

## R18. Delivery in slices

**Decision.** Five slices. Each leaves `npm run check` green and is safe to merge alone, because backchannel
approval is off unless configured and dev runs with `ciba.enabled: false`.

1. **L2 and its deployment settings**: the scope amendments of R16 first (SPEC §1.2, §1.3, L2-7's one
   approver, §11, and the constitution, in one task); the contract field in L2 and in the orchestrator that
   sends it; R2 to R10; and the Bicep and env-template side of R15. T-E2E-10's approved purchase becomes a
   person's here, because the platform account can no longer be asked. Holds four of the six proofs.
2. **The hosted agent**: R14's pass-through in the service, T-AGT-08, T-E2E-15.
3. **A person's view**: R11 and R12 in L2, the portal and the web app.
4. **The tenant**: the approver out of `auth0/`, the pipeline and `github-setup.sh`; enrollment (R13).
5. **Documents**: what is left of SPEC 1.16, the constitution, `specs/README.md`, the 012 notes (R19), `README.md`,
   `CLAUDE.md`.

Each slice updates the SPEC sections its behavior changes; the version line, the "Changes in 1.16" table and
the scope amendments land first, in slice 1 (Governance: SPEC.md and the constitution change together, in the
same change as the behavior).

## R19. What becomes of 012's live check

**Decision.** `specs/012` quickstart §5 gets a dated note: it ran on 2026-11-12 against SPEC v1.15 with one
configured approver, and it can't be repeated from v1.16 until people can start runs with a token from the
tenant, which is a later feature (FR-028). Its "Results so far" are on PR #31's branch
(`claude/012-live-check`), not on `main`; the note goes where that section is when slice 5 lands. `specs/012`'s
contracts get one line each pointing here for the approver's removal. Nothing in 012 is rewritten.
