# Implementation Plan: Backchannel Approval of Escalated Payments (CIBA with Auth0)

**Branch**: `012-ciba-escalation-approval` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-ciba-escalation-approval/spec.md`, with the
clarification of session 2026-11-07 (a bounded 120 s wait in the call that escalates).

## Summary

When L2 escalates a payment and backchannel approval is on, L2 asks the approver directly. It sends
one OpenID CIBA request to Auth0, in poll mode, with a 64-character binding message and RAR
`authorization_details` naming the exact payment. Auth0 reaches the approver through Guardian push.
L2 polls Auth0's token endpoint, outside the serialized section, until it gets an answer.

- **Approve.** L2 verifies the returned access token: issuer, signature through the tenant's JWKS,
  audience, client, validity with 60 s tolerance, the approver's `sub`, and payment details equal,
  field for field, to the ones it sent. Only then, inside the serialized section, does it append
  `HUMAN_APPROVAL` with `channel: "backchannel"` and the verified evidence. The approval is then
  consumed exactly like an operator approval (L2-4.2, INV-12).
- **Refuse.** A refusal more than 5 s before the request's own expiry appends `HUMAN_REJECTION`
  with `channel: "backchannel"`, and R15 applies unchanged. A late refusal or an expiry answer is a
  lapse. The escalation then stays pending and expires at 300 s through the existing sweep.
- **Wait in the call.** The authorize call that created the escalation waits up to 120 s, holding
  no lock. If the escalation reaches a final state in that time, by either path, L2 re-evaluates the
  intent in a second serialized section and returns AUTHORIZED or DENIED in the same call.
  Otherwise the call returns ESCALATED, as today.
- **Fail closed.** If Auth0 is unreachable, refuses the request, or returns an answer that fails
  verification, nothing is approved. The escalation stays pending, and the operator path is
  unchanged.
- **Push fatigue.** Repeat requests for the same purchase reuse the pending escalation. There are
  at most 10 approval requests per rolling hour, counted from the ledger. The scripted regression
  marks its intents operator-only, so it never notifies anyone.

- **The tenant as code.** `auth0/` holds Terraform for the Auth0 side: the API, L2's CIBA client and its
  credential, the grant and Guardian push. A tenant administrator applied it by hand
  ([R17](research.md#r17-the-auth0-tenant-as-code)); since 2026-11-10 (SPEC v1.9 and v1.11, the owner's decision)
  its pipeline does, `.github/workflows/provision-auth0.yml`: key credential only, variables from its GitHub
  environment, state in Azure (`infra/modules/state-storage.bicep`).

Contract change: one optional field, `PaymentIntent.operatorApprovalOnly`. The
`AuthorizationDecision` contract is unchanged. The policy engine is unchanged (FR-032).

## Technical Context

**Language/Version**: TypeScript (strict), ESM, Node.js ≥ 22.13 (development on Node 26)

**Primary Dependencies**:
- `jose` (already pinned, used by the hosted agent). Here it verifies the access token
  (`createRemoteJWKSet`, `jwtVerify`) and signs the `private_key_jwt` client assertion
  (`SignJWT`, `importPKCS8`).
- `node:crypto` for the sealed request handle (HKDF and AES-256-GCM) and the requirement digest.
- Global `fetch` for the two Auth0 endpoints.
- No new package. Auth0's own SDKs are not used ([research R2](research.md#r2-auth0-sdk-or-plain-https)).

**Storage**: the existing hash-chained JSONL ledger. It gains four entry types, new fields on
`ESCALATED`, `HUMAN_APPROVAL` and `HUMAN_REJECTION`, and a second `INTENT` per intent after a wait.
No other store.

**Testing**: vitest.
- Unit tests for payment details, the binding message, verification and config.
- In-process L2 against a stand-in Auth0 (`test/helpers/ciba-stub.ts`, like `cdp-stub.ts`) that
  issues real RS256 tokens from its own JWKS.
- Harness e2e through the real L1 orchestrator.
- An architecture rule with a fixture.
- Updates to T-API-01..03, T-ARCH-ENV, T-IAC-01 and T-IMG-01.

**Target Platform**: the local multi-process PoC on loopback (feature off by default), and the Azure
profile (L2 in Container Apps, with outbound HTTPS to the Auth0 tenant).

**Project Type**: a multi-process service with a three-layer split, plus operator commands.

**Performance Goals**:
- an approval request starts within 2 s of `ESCALATED` (SC-001);
- payments that need no human are not slowed by more than 50 ms with Auth0 down (NFR-005);
- the wait ends within one poll interval of the final state; operator decisions end it at once.

**Constraints**:
- L2 still binds only 127.0.0.1 and gains no inbound route (FR-010);
- no network call inside the serialized section (FR-028);
- the policy stays pure;
- the ledger stays append-only;
- the `demo:local` summary and the L1-4 baseline are unchanged (NFR-008);
- tokens, request handles, the client key and Auth0's error text never reach the ledger, logs,
  events, responses, L1 or L3 (NFR-003).

**Scale/Scope**: one approver per L2, and at most 10 approval requests per hour. A linear ledger scan
per operation, as today, is enough.

No item is NEEDS CLARIFICATION. [research.md](research.md) records each design decision (R1–R17).

## Constitution Check

*GATE: must pass before Phase 0 research, and again after Phase 1 design.*

| Principle | Check | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of payment authority | All new runtime code lives in `src/layer2-control/`. L1 gains one optional, path-removing intent field (FR-007), set only by the scripted agent's composition root; no tool, route or field approves, rejects or reads approval requests (FR-031). L3 is untouched. | PASS | PASS. The hosted agent's tool schemas and orchestrator never carry the field (T-AGT-02, T-CIBA-03). |
| II. Deterministic, pure policy | `policy.ts` is unchanged (FR-032). A backchannel approval reaches it only as `ctx.humanApprovedFor`, and a refusal only as `ctx.humanRejected`, both derived from the ledger as today. Auth0's text is never a decision input (NFR-006). Every check-then-append runs inside the serialized section; the wait, the polling and the token verification run outside it (FR-028, R6). INV-12 holds: an approval lifts only R14, once, for one purchase. | PASS | PASS (R5, R6, R7) |
| III. Ledger is the single source of truth | Every new fact is a new entry type or a new field on a new entry (FR-024). The cap is counted from `ESCALATED` entries (R9). Resume after a restart reads only the ledger, plus the credential L2 already holds to open the sealed handle (R8). | PASS | PASS |
| IV. Trust the chain | No change to L3 or to settlement. | PASS | PASS |
| V. Least-privilege credentials | One new third-party credential, L2's Auth0 client key. It is held by L2 only and read by one module, `ciba-client.ts`, enforced by new rule A9. It lives in L2's vault in Azure, seeded by hand (FR-003, FR-030). It authenticates L2 to Auth0 only, so it can never sign a payment. The only new outbound calls are HTTPS to the configured issuer's three fixed endpoints (NFR-004). Inbound, nothing changes. | PASS, with a MINOR amendment (below) | PASS |
| VI. Exact money arithmetic | Amounts are copied as atomic strings. `amount_usdc` comes from `formatAtomic` (BigInt). Equality is exact string comparison. | PASS | PASS |
| VII. Protocol fidelity | x402 header handling is unchanged. CIBA and RAR follow OpenID CIBA Core 1.0 and RFC 9396, as Auth0 implements them (R1). | PASS | PASS |
| VIII. Proven safety | Must-fail proofs: the issuer, approver and payment-details checks; serialized outcome recording; the cap. See "Proofs". Every new entry, field and route field has a test. | PASS | PASS |
| Quality gates | typecheck, the full suite, an unchanged demo summary, SPEC v1.8 in the same change, and requirement IDs in test names. | PASS | PASS |

**Amendments made in the same change, not violations**:
- **Constitution 1.2.0 → 1.3.0 (MINOR).** Principle V gains the approval-service client credential.
  The stack's `jose` is no longer L1-only. The residual risks gain the approval service and the
  approver's phone.
- **Feature 010 amended.** NFR-005 there, and SPEC L2-4.3's "L2 makes no outbound connection",
  gain the approval-service exception. Operator notification stays pull-based.

No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/012-ciba-escalation-approval/
├── spec.md
├── plan.md                    # this file
├── research.md                # Phase 0: R1–R16
├── data-model.md              # Phase 1: entries, fields, request lifecycle, derived views
├── quickstart.md              # Phase 1: validation guide, Auth0 tenant setup
├── contracts/
│   ├── auth0-ciba.md          # the outbound contract: bc-authorize, token polling, the access token L2 accepts
│   ├── payment-details.md     # authorization_details type, binding message, reference code, digest
│   ├── control-api.md         # L2-5 delta: authorize wait, PaymentIntent field, escalation reads
│   ├── ledger-backchannel.md  # L2-4 / L2-4.3 delta and the new L2-7 text
│   └── config-and-secrets.md  # CFG-2, §3.3, rule A9, Azure parameters and vault secret
│   (the tenant itself: auth0/ at the repository root, research R17)
├── checklists/requirements.md
└── tasks.md                   # Phase 2 (/speckit-tasks)
```

### Source code (repository root)

```text
src/layer2-control/
├── ciba-client.ts        # NEW: the only reader of CIBA_CLIENT_KEY / CIBA_CLIENT_SECRET (rule A9). cibaConfigFromEnv
│                         #      validates every CIBA_* variable (names, never values); private_key_jwt (RS256) or
│                         #      client_secret_post; startRequest
│                         #      (POST /bc-authorize) and pollToken (POST /oauth/token); seal/open of the request
│                         #      handle (HKDF from the key, AES-256-GCM); HTTPS to issuer-relative fixed paths only
├── approval-evidence.ts  # NEW: verifyApprovalToken(token, expected, keys, nowMs) → evidence | failed check;
│                         #      jose jwtVerify against the issuer JWKS; test-only skipChecks (must-fail proofs)
├── payment-details.ts    # NEW, pure: authorization_details for an escalation, binding message, reference code,
│                         #      requirement digest, field-for-field equality
├── backchannel.ts        # NEW: eligibility and cap (pure, used inside the section); start with retries; poll loop
│                         #      with interval and slow_down; outcome recording inside serialize; resume after restart;
│                         #      waitForFinal(escalationId, ms, signal)
├── escalations.ts        # MOD: referenceCode; approval-request state; cap count; open-request lookup; new event
│                         #      kinds; channel and decidedBy on approved and denied events (whitelist)
├── approval-routes.ts    # MOD: new operator entries record channel: "operator"
├── ledger.ts             # MOD: four EntryTypes; append listeners (subscribe) that wake waiters. No other change
├── service.ts            # MOD: authorize = serialized decision → optional start and wait → optional serialized
│                         #      re-evaluation; validIntent accepts operatorApprovalOnly (boolean); main() builds the
│                         #      backchannel from env and resumes open requests
└── policy.ts             # UNCHANGED (FR-032)
src/shared/contracts.ts   # MOD: PaymentIntent.operatorApprovalOnly?: boolean
src/layer1-intent/orchestrator.ts  # MOD: OrchestratorDeps.operatorApprovalOnly, copied into each intent
src/main.ts               # MOD: --scripted builds the orchestrator with operatorApprovalOnly: true
scripts/escalations.ts    # MOD: prints the new event kinds, channel, decidedBy and referenceCode
env/l2-control.env.example         # MOD: CIBA_* variables, empty
docs/l2-control.openapi.yaml       # MOD: PaymentIntent field, escalation view and event fields, kinds
infra/main.bicep, infra/modules/l2-apps.bicep, infra/main.dev.bicepparam   # MOD: ciba object; vault secret ref
.github/workflows/deploy.yml       # MOD: step 8 (hosted smoke) fails the run if any step ESCALATED (research R14)
auth0/                             # NEW (R17): Terraform for the Auth0 tenant, applied by provision-auth0.yml (2026-11-10)
├── versions.tf                    #   Terraform >= 1.11, auth0/auth0 >= 1.60.0 < 2.0.0; credentials from the env only
├── variables.tf                   #   environment, tenant, API identifier, approver, credential kind, public key path
├── main.tf                        #   API (RAR type, access policy), L2's CIBA client, grant, credential, Guardian push
├── outputs.tf                     #   bicepparam_ciba (the ciba object), l2_env (local CIBA_* lines)
├── README.md                      #   (dev.tfvars.example removed 2026-11-10: variables come from the GitHub environment)
.github/workflows/provision-auth0.yml  # NEW (2026-11-10): plan, and apply when asked; T-IAC-02 checks it
infra/modules/state-storage.bicep  # NEW (2026-11-10): the Terraform state's blob storage (T-IAC-01 rule 20)
.gitignore, .dockerignore          # MOD: auth0 state, plans and tfvars never committed or sent to a build
test/
├── helpers/ciba-stub.ts           # NEW: stand-in Auth0 (bc-authorize, token, JWKS, scripted answers, forgeries)
├── payment-details.test.ts        # NEW: T-CIBA-02 (details, binding message, reference code, digest)
├── ciba-client.test.ts            # NEW: T-CIBA-01, T-CIBA-02 (config, assertion, request shape, sealing)
├── approval-evidence.test.ts      # NEW: T-CIBA-08 (verification matrix and must-fail proofs)
├── helpers/backchannel-l2.ts      # NEW: in-process L2 + stub + fast timing, shared by the files below
├── backchannel-approve.test.ts    # NEW: US1 — T-CIBA-02 (service level), T-CIBA-06, T-CIBA-09
├── backchannel-refuse.test.ts     # NEW: US2 — T-CIBA-07 (refusal)
├── backchannel-lapse.test.ts      # NEW: US3 — T-CIBA-07 (lapse), operator path, T-CIBA-10, T-CIBA-11
├── backchannel-verify.test.ts     # NEW: US4 — T-CIBA-08 through L2
├── backchannel-failures.test.ts   # NEW: US5 — T-CIBA-05, T-CIBA-13, T-CIBA-01 (startup)
├── backchannel-fatigue.test.ts    # NEW: US6 — T-CIBA-03, T-CIBA-04
├── backchannel-views.test.ts      # NEW: US7 — T-CIBA-14, T-CIBA-12
├── fixtures/arch/a9-violation.ts  # NEW
├── architecture.test.ts           # MOD: A9, T-ARCH-A9, T-ARCH-ENV l2-control optional vars, SEC rows
├── e2e.local.test.ts              # MOD: T-E2E-10, T-E2E-11
├── escalations.test.ts            # MOD: new event kinds and view fields in T-LED-04's whitelist check
├── openapi.test.ts                # MOD (document only; the test logic is unchanged)
├── agent.test.ts, hosted-agent.test.ts  # MOD: scripted intents carry the field; hosted ones never do
├── infra.test.ts                  # MOD: T-IAC-01 CIBA rules
├── deploy-workflow.test.ts        # MOD: T-E2E-AZ asserts the smoke step's no-ESCALATED check
├── auth0-iac.test.ts              # NEW: T-IAC-02 (auth0/ offline: least privilege, no secrets, outputs = ciba keys)
└── helpers/harness.ts             # MOD: controlBackchannel option
SPEC.md                            # v1.8 (see "SPEC and governance changes")
.specify/memory/constitution.md    # 1.2.0 → 1.3.0 (MINOR)
specs/010-operator-reject-flow/spec.md, specs/007-…/contracts/threat-matrix.md, specs/README.md,
README.md, CLAUDE.md               # amendment notes, SEC rows, index, operator docs
```

**Structure decision**: keep the three-layer layout. All backchannel logic stays in
`src/layer2-control/`, so rule A1 holds. The credential is confined to `ciba-client.ts`, mirroring
A8's confinement of the CDP key to `cdp-facilitator.ts`. The other modules see only an interface
(`CibaPort`), so tests replace the network but keep the verification and the recording real.

## Design

### Authorize path (`service.ts`)

```text
POST /v1/authorize
  ├─ serialize(decideOnce(intent))          # unchanged steps 1–6, plus:
  │     ESCALATE, new escalation  → ESCALATED.data.approvalRequest = requested | capped | operator_only
  │     (only when backchannel is on; absent when off, so the off path is byte-for-byte as today)
  ├─ if approvalRequest == requested:
  │     backchannel.start(escalation)       # outside the lock; retries; records APPROVAL_REQUESTED or _FAILED
  │     state = await waitForFinal(id, 120 s, req-closed signal)   # no lock held
  │     if state ∈ {approved, denied} and caller still connected:
  │         serialize(decideOnce(intent, { reevaluation: true }))  # second INTENT, same intentId, one outcome
  └─ respond
```

- **Eligibility** is decided inside the first serialized section, from the ledger only:
  - backchannel is on;
  - the decision is a new `ESCALATED`, not `ESCALATION_REPEATED`;
  - the intent is not `operatorApprovalOnly`;
  - fewer than 10 `ESCALATED` entries with `approvalRequest: "requested"` in the trailing hour.

  Recording the choice on `ESCALATED` makes the cap race-free and auditable ([R9](research.md#r9-where-the-cap-is-counted)).
- **The wait** ends at the first of these: a final-state entry for the escalation (the ledger's
  append listener wakes it), the 120 s deadline, a failed or lapsed approval request, or the
  caller's connection closing. It never holds the mutex, so other authorizations, reconciliations,
  operator actions and the sweep proceed ([R6](research.md#r6-the-bounded-wait-and-the-second-decision)).
- **The re-evaluation** is `decideOnce` again, with a fresh `t`. It appends a new `INTENT` (same
  `intentId`) and exactly one outcome entry. It never starts an approval request and never waits.
  If it escalates again (for example, a concurrent request consumed the approval), that new
  `ESCALATED` records `approvalRequest: "reevaluation"`. The abort signal is checked at the start of
  the second section, before its `INTENT`. A caller that has gone gets nothing appended.
- An `expired` final state never triggers a re-evaluation. The call returns the original ESCALATE,
  so a lapse can't silently start a second escalation.

### Approval request lifecycle (`backchannel.ts`)

1. **Start** (outside the lock):
   - build the payment details from the `ESCALATED` entry and the chosen requirement
     ([payment-details](contracts/payment-details.md));
   - set `requested_expiry` = min(300, seconds left in the escalation's window), which keeps the
     request on Guardian push;
   - `POST /bc-authorize` with fresh client authentication ([R3](research.md#r3-client-authentication)).

   - **Transient failures** (network, timeout, 429, 5xx) wait 250 ms, then 1 s, so there are at
     most 3 attempts. Each attempt has a 1.5 s timeout, so the start ends within 6 s.
   - **A permanent answer** (a 4xx OAuth error) is not retried.

   Each outcome is then recorded inside `serialize`, only if the escalation is still pending:
   - `APPROVAL_REQUESTED`, with the details sent, the reference code and the sealed handle; or
   - `APPROVAL_REQUEST_FAILED`, with the failure category and the protocol error code.

   The error code is kept only if it is on a fixed list; otherwise it is recorded as `other`.
2. **Poll** (outside the lock):
   - wait `interval` seconds (default 5) and add 5 s on each `slow_down`;
   - before each poll, stop if the escalation is no longer pending;
   - transient poll errors back off and continue until the request's own expiry.
3. **Answer**:
   - **Token.** Verify it ([auth0-ciba](contracts/auth0-ciba.md), outside the lock, JWKS cached by
     jose). Then, inside `serialize`: if the escalation is still pending and this is its open
     request, append `HUMAN_APPROVAL { channel: "backchannel", approver: sub, evidence }`.
     Otherwise append nothing (abandoned). A failed check appends `APPROVAL_VERIFICATION_FAILED
     { check }`, and the escalation stays pending.
   - **`access_denied`.** At least 5 s before the request's expiry it appends `HUMAN_REJECTION
     { channel: "backchannel", approver }`. Otherwise it appends `APPROVAL_REQUEST_LAPSED
     { cause: "late_refusal" }`.
   - **`expired_token`, or the request's own expiry passing.** Appends `APPROVAL_REQUEST_LAPSED`.
   - **`invalid_grant` and other permanent errors.** Append `APPROVAL_REQUEST_FAILED`.
4. **Resume** (in `main()`, after the ledger loads): for each pending escalation whose
   `APPROVAL_REQUESTED` has no ending entry and has not reached its `expiresAtMs`, open the sealed
   handle and go back to step 2. An escalation marked `requested` with no request entry at all (a
   crash between the two sections) gets `APPROVAL_REQUEST_FAILED { failure: "interrupted" }`. It is
   never sent twice ([R8](research.md#r8-resuming-after-a-restart-without-storing-the-handle)).

### Operator path and reads

- Approve and reject are unchanged, except that new entries carry `channel: "operator"`. An entry
  without `channel` reads as `operator`.
- `GET /v1/escalations`:
  - each pending item gains `referenceCode`;
  - when the escalation carries the field, it also gains `approvalRequest`, one of `requested`,
    `capped`, `operator_only`, `reevaluation`, `failed`, `verification_failed` or `lapsed`.
- `GET /v1/escalations/events`:
  - gains the kinds `approval_requested`, `approval_request_failed`, `approval_request_lapsed` and
    `approval_verification_failed`;
  - `approved` and `denied` events gain `channel` and `decidedBy`;
  - every event stays a whitelist projection ([control-api](contracts/control-api.md)).
- `npm run escalations -- --watch` prints them.

### Credential and configuration

`CIBA_APPROVAL=1` turns the feature on. With it, these are required, and startup fails naming the
first missing or invalid variable, never its value:
- `CIBA_ISSUER` (`https://…/`);
- `CIBA_CLIENT_ID`;
- `CIBA_AUDIENCE`;
- `CIBA_APPROVER` (the approver's `sub`);
- exactly one client credential:
  - `CIBA_CLIENT_KEY`: an RSA key of 2048 to 4096 bits in PKCS#8 PEM, used for `private_key_jwt`
    with RS256. This is preferred;
  - or `CIBA_CLIENT_SECRET`: the fallback for tenants without `private_key_jwt`, which Auth0 offers
    on Enterprise only ([R3](research.md#r3-client-authentication)).

`CIBA_CLIENT_KEY_ID` is optional (the assertion's `kid`). Any `CIBA_*` variable without
`CIBA_APPROVAL=1` logs one warning naming the variables.

In Azure, the non-secret values come from the `ciba` object in `infra/main.<env>.bicepparam`. The
credential is always a Key Vault reference to `ciba-client-credential` in L2's vault, which every
environment seeds: the placeholder `off` while the feature is off, the real key to turn it on. L2 ignores the
placeholder while off and refuses it while on. T-IAC-01 rule 19 checks the path
([config-and-secrets](contracts/config-and-secrets.md)).

## Requirement traceability

| Requirement | Design element | Test |
|---|---|---|
| FR-001, FR-002 | `cibaConfigFromEnv`; off path writes no new field | T-CIBA-01; NFR-008 suite unchanged |
| FR-003 | `ciba` param object; the always-present `ciba-client-credential` reference in `l2-apps.bicep` | T-IAC-01 rule 19 (must fail on four mutants) |
| FR-004, FR-018 | eligibility inside the section; `approvalRequest` on `ESCALATED` | T-CIBA-02, T-CIBA-03 |
| FR-005, FR-006 | `payment-details.ts`; `requested_expiry` bound | T-CIBA-02 |
| FR-007 | `PaymentIntent.operatorApprovalOnly`; scripted root sets it; hosted never | T-CIBA-03, T-AGT-02, T-E2E-10 |
| FR-008 | cap count over `ESCALATED` entries | T-CIBA-04 (must fail without the cap) |
| FR-009 | retry schedule; permanent vs transient | T-CIBA-05 |
| FR-010, FR-011, NFR-004 | poll mode; interval and `slow_down`; fixed issuer paths | T-CIBA-06; T-API-01 (no new route) |
| FR-012, FR-026 | resume from ledger; sealed handle | T-CIBA-11 |
| FR-013–FR-015 | outcome recording; 5 s refusal rule; lapse | T-CIBA-07 |
| FR-016–FR-019, SC-011 | bounded wait; re-evaluation; abort on close | T-CIBA-09, T-E2E-10 |
| FR-020–FR-023, SC-003 | `verifyApprovalToken` | T-CIBA-08 (must fail without issuer, approver, details checks) |
| FR-024, FR-025, SC-010 | new entries and fields | T-CIBA-07, T-E2E-11 (full trail) |
| FR-027 | operator path unchanged; first final state wins | T-CIBA-09 (operator during wait), T-E2E-07/08 unchanged |
| FR-028 | verify outside, check-then-append inside `serialize` | T-CIBA-10 (must fail without it) |
| FR-029 | views and events | T-CIBA-14, T-LED-04 |
| FR-030 | rule A9; T-ARCH-ENV | T-ARCH-A9 |
| FR-031 | no new L1 tool or route | T-AGT-01/02 unchanged tool lists |
| FR-032 | `policy.ts` untouched | T-POL-* unchanged; A6 |
| NFR-001, NFR-002 | approval only lifts R14; every failure leaves pending | T-CIBA-05, T-CIBA-08, T-CIBA-09 (budget DENY after approval) |
| NFR-003, NFR-006, SC-008 | whitelists; error-code list; sealed handle | T-CIBA-12 (known-value scan) |
| NFR-005, SC-007 | no wait on non-escalated paths; Auth0 calls outside the lock | T-CIBA-13 |
| NFR-007 | test-only switches | see "Proofs" |
| NFR-008, SC-009 | off by default; scripted is operator-only | `npm run check`; T-E2E-01 unchanged |

## Proofs (Constitution VIII)

- **Every verification check** (`signature`, `issuer`, `audience`, `client`, `expired`,
  `approver`, `request`, `details`, `replay`): with only that check in `skipChecks`, its forgery
  verifies (unit, T-CIBA-08). `malformed` has nothing to turn off.
- **Through L2** (the spec's NFR-007 examples; T-CIBA-08):
  - with `skipChecks: ["details"]`, an answer for a different amount approves and pays. With the
    check, it records `APPROVAL_VERIFICATION_FAILED { check: "details" }`;
  - with `["approver"]`, another user's approval pays;
  - with `["issuer"]`, a token from another issuer approves;
  - a token replayed from another escalation already fails `request` (and `details`). With
    `["request", "details"]` off, `replay` still refuses it. With `["request", "details", "replay"]`
    off, one token approves two escalations.
- **Serialized outcome recording**: with the test-only `serializeOutcomes: false`, the backchannel
  path checks the state, awaits verification, then appends. An operator rejection that lands during
  the verification then produces two final-state entries. With the design, it produces exactly one
  (T-CIBA-10).
- **Cap**: with `approvalRequestCap: Infinity`, 11 escalations in an hour send 11 requests. With the
  cap, they send 10 (T-CIBA-04).

The switches are test-only deps of `createControlService` or the backchannel, never env, following
`dedupePendingEscalations: false` (010).

## SPEC and governance changes (same change)

- **SPEC.md v1.8**:
  - a "Changes in 1.8" table;
  - **§3.3**: a `CIBA_CLIENT_KEY` / `CIBA_CLIENT_SECRET` row (L2 only; it authenticates L2 to Auth0
    and is not payment key material);
  - **§5**: `jose` is used by L2 too, for the approval token and the client assertion; Terraform and the
    `auth0/auth0` provider manage the Auth0 tenant (`auth0/`), and Azure stays Bicep only;
  - **§6**: the repository layout gains `ciba-client.ts`, `approval-evidence.ts`,
    `payment-details.ts`, `backchannel.ts`, `test/helpers/ciba-stub.ts` and the top-level `auth0/` folder;
  - **§4.1**: rule A9;
  - **§7**: `operatorApprovalOnly?`;
  - **L1-4**: the scripted intents set the field;
  - **L2-4**: the four entry types, the new fields, and the `INTENT` row allowing a second entry
    after a wait;
  - **L2-4.3**: the outbound exception for the approval service;
  - **L2-5**: the authorize algorithm (wait and second decision), the `PaymentIntent` 400 rule,
    and the escalation-read fields;
  - **new L2-7**, backchannel approval;
  - **CFG-2**: the `CIBA_*` variables;
  - **§11**: SEC-17 (a forged, replayed or swapped approval) and SEC-18 (push fatigue), plus
    residual risks;
  - **§12**: T-CIBA-01..14, T-ARCH-A9, T-E2E-10, T-E2E-11, T-IAC-02 (`auth0/`), and T-IAC-01 rule 19;
  - **§13**: nothing new to run; the live Auth0 check is manual (quickstart §5).
- **Constitution 1.3.0 (MINOR)**: as above, plus Terraform with `auth0/auth0` for the Auth0 tenant only, with a
  Sync Impact Report.
- **Feature specs**:
  - 010 gets an "Amended by 012" note on NFR-005 and its notification assumption;
  - 007's threat matrix gains SEC-17 and SEC-18;
  - `specs/README.md` gains the 012 row and its traceability rows.
- **Docs**:
  - `README.md`'s approval section gains the backchannel path;
  - `CLAUDE.md` gains the `CIBA_*` env note and a gotcha (Guardian push needs `requested_expiry`
    ≤ 300 s);
  - `docs/l2-control.openapi.yaml` is updated with L2-5.

## Risks

| Risk | Mitigation |
|---|---|
| An existing environment deploys L2 before seeding `ciba-client-credential` | The L2 revision fails to provision, and the pipeline rolls L2 back to `last-good`. The 011 quickstart, the 012 quickstart §6 and CLAUDE.md say to seed the placeholder first. |
| Guardian doesn't render custom `authorization_details` | The binding message alone carries the amount, a short payee, a short resource and the reference ([R4](research.md#r4-what-the-approver-sees)); the quickstart's live check confirms the display. |
| The hosted smoke run (`deploy.yml` step 8) escalates and pages the approver | Its goal names only auto-approved items. The step now also fails the run if any step escalated, so a page shows up as a failed deploy ([R14](research.md#r14-deployment-checks-and-the-approver)). The scripted job is operator-only. |
| A crash between `ESCALATED` and `APPROVAL_REQUESTED` loses the handle | Resume records `APPROVAL_REQUEST_FAILED { failure: "interrupted" }`; the operator decides; never sent twice. |
| The client key rotates while a request is open | The sealed handle no longer opens, so resume records it as failed and the operator path remains. |
| The caller disconnects during the second section | The abort signal is checked when the second section starts. A disconnect after that leaves an AUTHORIZED that counts until `validBefore` (SEC-9), and the approval is consumed. Accepted, as for any authorize whose response is lost. |
| A long wait ties up a hosted run | 120 s of the 200 s deadline, under the ingress's 240 s and nginx's 230 s read timeout. |
| JWKS fetch on a cold cache adds latency to verification | It happens outside the lock and only on the backchannel path. jose caches keys and refetches on an unknown `kid`. |

## Complexity Tracking

No Constitution Check violations.
