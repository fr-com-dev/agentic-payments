---

description: "Task list for 002-spending-policy-authorization"
---

# Tasks: Spending Policy & Authorization (Layer 2 — Control)

**Input**: Design documents from `specs/002-spending-policy-authorization/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (policy-rules.md, policy-api.md, signer.md, mandate.schema.json, http-api.md), quickstart.md

**Tests**: REQUESTED. Constitution Principle VIII requires a test for every rule, endpoint and
safety mechanism, and the spec names T-POL-01..14 and T-E2E-04. In each story phase, write the
test tasks first and confirm they fail before implementing.

**Organization**: Tasks are grouped by user story (US1–US5 from spec.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: The user story the task belongs to (US1..US5)

## Path Conventions

Single project (SPEC.md §6). Code lives in `src/layer2-control/`, config in `config/` and tests
in `test/`. These files are shared, and this feature adds only its own parts:

- `src/layer2-control/service.ts`: this feature adds the authorize and budget routes and the
  mutex. Reconcile and ledger-verify belong to 003; approvals belong to 004.
- `src/shared/contracts.ts`: owned by 001 (created by 001 T004).
- `src/shared/config.ts`: owned by 006.
- `src/layer2-control/ledger.ts`: owned by 003.
- `test/e2e.local.test.ts`: the harness is owned by 008.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Mandate config and test scaffolding for this feature.

- [X] T001 Create `config/mandate.json` with the CFG-3 defaults from data-model.md:
  - `mandateId` `"mandate-poc-001"`
  - `expiresAt` `"2027-12-31T23:59:59Z"`
  - `allowedSchemes` `["exact"]`
  - `allowedPayees` `[]`
  - `allowedHosts` `["127.0.0.1:4021"]`
  - `autoApproveMaxAtomic` `"20000"`
  - `hardCapPerPaymentAtomic` `"100000"`
  - `sessionBudgetAtomic` `"100000"`
  - `dailyBudgetAtomic` `"500000"`
  - `maxAuthorizationsPerMinute` `10`
  - `maxTimeoutSeconds` `300`

  Do not include `allowedNetworks` or `allowedAssets`: they are "from the network profile (CAIP-2)" and "never read from JSON".
- [X] T002 [P] Create `test/policy.test.ts` with shared fixtures:
  - a default `SpendingMandate` built in-memory (no file I/O)
  - a `baseRequirement()` that is compliant at `amount: "1000"`, `scheme: "exact"`, `maxTimeoutSeconds: 120` and payTo an allowlisted address
  - a `baseCtx(overrides)` with a fixed `nowMs`, `requestedUrl` and `challengeResourceUrl` of `http://127.0.0.1:4021/api/weather`, committed `0n` and `authorizationsLastMinute: 0`
- [X] T003 [P] Confirm that `env/l2-control.env.example` (owned by 007) lists `ALLOWED_PAYEES` and `ALLOWED_HOSTS`, and record any gap in that feature's tasks. Do not edit 007's files.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The mandate loader, policy types and service skeleton that every story needs.

**⚠️ CRITICAL**: No user-story work can start until this phase is complete.

**External prerequisites**:
- 006: `networkProfile()` with `caip2`, `asset` and `decimals` in `src/shared/config.ts`.
- 003: the `AuditLedger` API (`append`, `committedAtomic`, `authorizedSince`, `findOpenApproval`, entry queries) in `src/layer2-control/ledger.ts`.
- 001 T004: creates `src/shared/contracts.ts` with `PaymentIntent`, `AuthorizationDecision`, `PolicyViolation` and `BudgetStatus`.
- 007: `requireRole(role)` in `src/shared/auth.ts`.
- 008 T000: the SPEC.md v1.1 amendment (gate for every task in this file).

- [X] T004 Implement the `SpendingMandate` type and `loadMandate(net, env)` in `src/layer2-control/mandate.ts`:
  - Read `config/mandate.json`.
  - Set `allowedNetworks = [net.caip2]` and `allowedAssets = { [net.caip2]: [lower(net.asset)] }`.
  - Let `ALLOWED_PAYEES` and `ALLOWED_HOSTS` (comma-separated) replace the JSON values when set.
  - Lower-case payees.
  - Fail loading unless `autoApproveMax < hardCap ≤ sessionBudget` (research R7, fail closed).
- [X] T005 [P] Add mandate-loader tests to `test/policy.test.ts`:
  - env overrides replace the JSON lists
  - payees are lower-cased
  - networks and assets come from the profile even if JSON contains them
  - a mandate with `autoApproveMax ≥ hardCap` or `hardCap > sessionBudget` throws
- [X] T006 Create `src/layer2-control/policy.ts` with the exact `PolicyContext`, `EvalStatus` and function signatures from `contracts/policy-api.md`:
  - `nowMs: number`, `requestedUrl`, `challengeResourceUrl`
  - `sessionCommittedAtomic: bigint`, `dailyCommittedAtomic: bigint`
  - `authorizationsLastMinute: number`
  - `humanApprovedFor?: { payTo; amount; approvalId }`
  - deliberately **no** `purpose` field (INV-5)

  Import only types and `./mandate.js`.
- [X] T007 Create the service skeleton in `src/layer2-control/service.ts`:
  - `createControlService({ mandate, signer, ledger, signerLatencyMs? })`, an express app (not bound; T015 binds it)
  - mount `requireRole("agent-control")` (007, `src/shared/auth.ts`) on `/v1/authorize` and `/v1/budget/:sessionId`; the settlement and operator tokens get 401
  - a serialization helper `serialize(fn)` built on a promise chain (`tail = tail.then(run, run)`)
  - wiring of `loadMandate`, `PaymentSigner` and `AuditLedger` from env loaded by `loadEnv()` (`PAYER_PRIVATE_KEY` read only to construct the signer)

**Checkpoint**: The mandate loads and validates, the policy types compile, and the service starts with auth.

---

## Phase 3: User Story 1 — A compliant micro-payment is authorized and signed (Priority: P1) 🎯 MVP

**Goal**: A compliant 1000-atomic payment is AUTHORIZED, signed for exactly the chosen
option, and returned with opaque headers and the remaining budget.

**Independent Test**: T-POL-01 and T-POL-02 pass. `POST /v1/authorize` returns AUTHORIZED
with `paymentHeaders["PAYMENT-SIGNATURE"]`. End to end via T-E2E-01, step 2 settles.

### Tests for User Story 1 ⚠️ (write first, confirm they fail)

- [X] T008 [P] [US1] Add **T-POL-01** ("a compliant $0.001 payment is AUTHORIZED") to `test/policy.test.ts`. `evaluateRequirement(baseRequirement(), mandate, baseCtx())` gives `{status:"AUTHORIZED", violations:[]}`.
- [X] T009 [P] [US1] Add **T-POL-02** ("decide is deterministic and picks the cheapest") to `test/policy.test.ts`:
  - Use three compliant options with amounts `5000`, `1000`, `1000`.
  - `decide` chooses the first `1000` option (ties go to the first offered).
  - Two runs are deep-equal.
  - The inputs are not mutated.
- [X] T010 [P] [US1] Add signer tests to `test/policy.test.ts`, in a separate `describe("PaymentSigner")` block that uses a throwaway test key:
  - `sign(challenge, approved)` passes the SDK a challenge whose `accepts` has length 1 and equals `approved` (INV-6).
  - It returns `{ headers: { "PAYMENT-SIGNATURE": … }, payer, validBefore }`, with `validBefore` a number in seconds.
  - An amount above `hardCapAtomic` makes the SDK throw (the independent second cap, NFR-004).
- [X] T011 [P] [US1] Add authorize HTTP contract tests to `test/policy.test.ts`, as an in-process service with a fake ledger and fake signer:
  - Missing `intentId` or `sessionId` returns 400.
  - `paymentRequired.accepts` that is not an array returns 400.
  - A `resourceUrl` that is not `http:`/`https:` returns 400.
  - A missing or wrong token returns 401.
  - None of these writes to the ledger.
  - A signer that throws a 400-character error gives `DENIED` with `signer_rejected` and `detail.length ≤ 300`.

### Implementation for User Story 1

- [X] T012 [US1] Implement the AUTHORIZED path of `evaluateRequirement` (no violations, returns `AUTHORIZED`) and `decide` in `src/layer2-control/policy.ts`, following research R3:
  - Among AUTHORIZED options, pick the smallest `BigInt(amount)`, ties to the first offered.
  - Else, if any is ESCALATE, return that option's violations.
  - Else return DENIED with all violations flattened.
  - An empty list gives `no_payment_options`.
- [X] T013 [P] [US1] Implement `PaymentSigner` in `src/layer2-control/signer.ts` per `contracts/signer.md`:
  - `privateKeyToAccount` (the only call site in the repo, INV-2)
  - `x402Client().register(net.caip2, new ExactEvmScheme(account))`
  - spend controls `{ maxAmountPerPayment: false, allowedAssets: [{ network: net.caip2, asset: net.asset, maxAmountPerPayment: hardCapAtomic }] }`
  - `sign` calls `x402HTTPClient.createPaymentPayload({ ...challenge, accepts: [approved] })` and then `encodePaymentSignatureHeader`
  - expose `readonly address`; provide no key export or generic sign method
- [X] T014 [US1] Implement the `POST /v1/authorize` handler in `src/layer2-control/service.ts`, all inside `serialize()` (data-model "Authorize lifecycle"):
  1. Validate the body, returning 400 with no ledger write on failure.
  2. Take `t = Date.now()` once.
  3. Append `INTENT` with `{resourceUrl, purpose, accepts}`.
  4. Build `ctx`.
  5. Call `decide`.
  6. On AUTHORIZED, `sign`. A thrown error becomes `DENIED` / `signer_rejected` with the detail truncated to 300 characters.
  7. Append exactly one `AUTHORIZED`, `DENIED` or `ESCALATED` entry, using 003's entry shapes. AUTHORIZED `data` carries the full SPEC L2-4 field set: `amount, asset, network, payTo, payer, validBefore, resourceUrl, mandateId, approvalRef`, with `approvalRef: null` unless an approval was consumed (T034).
  8. Return the `AuthorizationDecision` with `authorizationId`, `intentId` and, for AUTHORIZED, `requirement`, `paymentHeaders`, `payer`, `validBefore` and `remainingSessionBudgetAtomic`.
- [X] T015 [US1] Wire `l2:control` startup in `src/layer2-control/service.ts`:
  - Load env with `loadEnv()` (007; default `env/l2-control.env`).
  - Construct the signer with `mandate.hardCapPerPaymentAtomic`.
  - Listen with `listen(CONTROL_PORT, CONTROL_BIND_HOST)` (007 T039). This is the only L2 bind.
  - Load and verify the ledger before resolving the network profile, so an integrity failure is reported first.
  - Fail startup if the ledger's integrity check throws (003).

**Checkpoint**: The compliant path is AUTHORIZED and signed, and T-POL-01/02, the signer tests and the HTTP contract tests pass.

---

## Phase 4: User Story 2 — Non-compliant payments are denied with every violated rule (Priority: P1)

**Goal**: Rules R1–R10 (plus R13 as a pure check) report every DENY violation, with stable
rule IDs, and R14 escalates payments above the auto-approve limit.

**Independent Test**: T-POL-03..11, T-POL-14 and the T-POL-13 escalation cases each produce exactly their expected rule ID.

### Tests for User Story 2 ⚠️

- [X] T016 [P] [US2] Add **T-POL-03..10** to `test/policy.test.ts`, one `it` per rule:
  - T-POL-03 `network_not_allowed`
  - T-POL-04 `asset_not_allowed` (also checks that a mixed-case allowlisted asset still passes)
  - T-POL-05 `payee_not_allowed` (also checks that an empty allowlist means any payee)
  - T-POL-06 `scheme_not_allowed`
  - T-POL-07 `timeout_out_of_range` for `0`, and for `mandate.maxTimeoutSeconds + 1`
  - T-POL-08 `hard_cap_exceeded` at `"100001"`
  - T-POL-09 `amount_invalid` for `"-5"`
  - T-POL-10 `amount_invalid` for `"1.5"` (no `BigInt` throw)
- [X] T017 [P] [US2] Add **T-POL-11** to `test/policy.test.ts`:
  - `resource_binding_mismatch` when the challenge resource host differs from the requested host.
  - `host_not_allowed` for `http://localhost:4021/...`. The host includes the port, so `localhost:4021` ≠ `127.0.0.1:4021`.
  - `host_not_allowed` for an unparsable URL.
- [X] T018 [P] [US2] Add **T-POL-14** to `test/policy.test.ts`:
  - `mandate_expired` when `nowMs > Date.parse(expiresAt)`.
  - `velocity_limit` when `authorizationsLastMinute ≥ maxAuthorizationsPerMinute` (`10`).
  - `decide([])` returns DENIED with `no_payment_options`.
- [X] T019 [P] [US2] Add multi-violation tests to `test/policy.test.ts`:
  - A requirement with a wrong network, wrong payee and amount above the hard cap lists all three rule IDs, in R-order.
  - An `amount_invalid` requirement stops after R9: no R10–R14 IDs.
  - `decide` across two denied options flattens both options' violations.
- [X] T020 [P] [US2] Verify that 007's architecture rule A6 (`test/architecture.test.ts`, owned by 007) guards `src/layer2-control/policy.ts` purity (INV-5). Its banned list must include 002's extra tokens so 007 merges them:
  - `Date.now`, `Math.random`, `fetch(`, `console.`, any `node:*` import (incl. `node:fs`)
  - a `purpose` **identifier** (property access such as `ctx.purpose` or a parameter named `purpose`), checked on identifiers, not on raw text, so comments mentioning "purpose" do not fail
  Record any gap in 007's tasks. Do not add a second guard here.
- [X] T032 [P] [US2] Add **T-POL-13 (escalation cases)** to `test/policy.test.ts`:
  1. A compliant amount of `"50000"` with no approval gives ESCALATE with `human_approval_required`.
  2. An amount of `"20000"` (equal to the limit) gives AUTHORIZED without an approval.
  3. An amount of `"200000"` (over the hard cap) gives DENIED with `hard_cap_exceeded`, and `human_approval_required` is not among the violations.

### Implementation for User Story 2

- [X] T021 [US2] Implement R1–R8 in `evaluateRequirement` in `src/layer2-control/policy.ts`, in order and collecting all violations:
  - R1 `mandate_expired`
  - R2 `scheme_not_allowed`
  - R3 `network_not_allowed`
  - R4 `asset_not_allowed` on `lower(req.asset)`
  - R5 `payee_not_allowed` when `allowedPayees.length > 0`
  - R6 `host_not_allowed` on `new URL(requestedUrl).host`, inside try/catch
  - R7 `resource_binding_mismatch`
  - R8 `timeout_out_of_range` for `not 0 < maxTimeoutSeconds ≤ mandate.maxTimeoutSeconds`
- [X] T022 [US2] Implement R9, R10 and R13 in `src/layer2-control/policy.ts`:
  - R9 `amount_invalid`: `amount` fails `^\d+$` or `BigInt(amount) ≤ 0`. Return **immediately** with the violations collected so far.
  - R10 `hard_cap_exceeded`: `BigInt(amount) > BigInt(hardCapPerPaymentAtomic)`.
  - R13 `velocity_limit`.
  - Each violation's `detail` is human-readable, e.g. `"500000 > 100000"`.
- [X] T033 [US2] Implement R14 `human_approval_required` in `src/layer2-control/policy.ts`. It fires only when there are no DENY violations, `BigInt(amount) > BigInt(autoApproveMaxAtomic)`, and there is no `humanApprovedFor` with `lower(payTo)` equal and an exactly equal `amount` string. Its effect is ESCALATE. **Required for the MVP**: without it the 50000-atomic premium report is auto-approved (T-E2E-01 step 4 and the `0.006 USDC` summary fail).

**Checkpoint**: Every DENY rule except the budget rules is covered and green, and R14 escalates.

---

## Phase 5: User Story 3 — Session and daily budgets cap cumulative spend (Priority: P1)

**Goal**: R11 and R12 count the new amount against ledger-derived committed spend, and the
budget endpoint reports it.

**Independent Test**: In T-POL-12, the exact-boundary payment passes and one more atomic unit
is denied. `GET /v1/budget/:sessionId` returns the `BudgetStatus` shape.

### Tests for User Story 3 ⚠️

- [X] T023 [P] [US3] Add **T-POL-12** to `test/policy.test.ts`:
  - `sessionCommittedAtomic: 99000n` plus amount `"1000"` passes, and `"1001"` gives `session_budget_exceeded`.
  - `dailyCommittedAtomic: 499000n` plus `"1000"` passes, and `"1001"` gives `daily_budget_exceeded`.
  - Both rules fire together when both budgets are exceeded.
- [X] T024 [P] [US3] Add budget endpoint tests to `test/policy.test.ts`, using an in-process service with a fake ledger whose `committedAtomic` returns `6000n`:
  - The response is `{sessionId, asset, decimals: 6, sessionCapAtomic: "100000", spentOrReservedAtomic: "6000", remainingAtomic: "94000", perPaymentCapAtomic: "20000"}`. `perPaymentCapAtomic` is the auto-approve limit, not the hard cap.
  - An unknown session returns 200 with `"0"` spend.
  - `remainingAtomic` is floored at `"0"`.
  - The operator token gets 401.

### Implementation for User Story 3

- [X] T025 [US3] Implement R11 `session_budget_exceeded` and R12 `daily_budget_exceeded` in `src/layer2-control/policy.ts`, as `ctx.sessionCommittedAtomic + amount > BigInt(sessionBudgetAtomic)` and the daily equivalent, with BigInt only (NFR-006).
- [X] T026 [US3] In `src/layer2-control/service.ts`, build `ctx` inside `serialize()`:
  - `sessionCommittedAtomic = ledger.committedAtomic({ sessionId }, t)`
  - `dailyCommittedAtomic = ledger.committedAtomic({ sinceMs: t - 86_400_000 }, t)`

  Both are computed from the ledger on every call (INV-7, no counters; the algorithm is owned by 003).
- [X] T027 [US3] Implement `GET /v1/budget/:sessionId` in `src/layer2-control/service.ts` per `contracts/http-api.md` (research R8):
  - `sessionCapAtomic = sessionBudgetAtomic`
  - `spentOrReservedAtomic = committedAtomic({sessionId}, now)`
  - `remainingAtomic = max(0, cap − committed)`
  - `perPaymentCapAtomic = autoApproveMaxAtomic`
  - `asset` and `decimals` from the network profile
  - Compute `remainingSessionBudgetAtomic` in the AUTHORIZED response (T014) the same way, after the new entry.

**Checkpoint**: Cumulative limits hold, and the agent's `check_budget` (feature 001) has a working backend.

---

## Phase 6: User Story 4 — Concurrent bursts cannot bypass limits (Priority: P1)

**Goal**: Serialized check → sign → append, so velocity and budgets always see earlier
authorizations.

**Independent Test**: T-E2E-04 authorizes exactly 10 of 15 concurrent intents with
`signerLatencyMs: 25`, and fails with 15/15 when the mutex is bypassed.

### Tests for User Story 4 ⚠️

- [X] T028 [US4] (Done in-process in `test/policy.test.ts` → `serialization (INV-8)`; move into the 008 harness when it exists.) Add **T-E2E-04** to `test/e2e.local.test.ts`, in this feature's own `describe` block using 008's harness:
  - Start the control service with `signerLatencyMs: 25`.
  - Send 15 concurrent `POST /v1/authorize` for compliant 1000-atomic intents.
  - Assert exactly 10 `AUTHORIZED`, 5 `DENIED` with `velocity_limit`, and 10 AUTHORIZED ledger entries in the trailing 60 s.
- [X] T029 [US4] **Negative control** (Principle VIII):
  1. Temporarily replace `serialize(fn)` with direct `fn()` in `src/layer2-control/service.ts`.
  2. Run `npx vitest run test/e2e.local.test.ts -t "T-E2E-04"`.
  3. Confirm it **fails** with 15/15 AUTHORIZED.
  4. Revert the change.

  Record the observed counts in the PR description. **Observed 2026-10-16:** bypassed → 15/15 AUTHORIZED (test fails); restored → 10/15.

### Implementation for User Story 4

- [X] T030 [US4] In `src/layer2-control/service.ts`, compute `authorizationsLastMinute` inside `serialize()` as `ledger.authorizedSince(t − 60_000)` (implemented by 003). Do not count entries in `service.ts`.
- [X] T031 [US4] Add the `signerLatencyMs` test hook in `src/layer2-control/service.ts`:
  - It is a construction option only, not an HTTP parameter.
  - When it is set, `await` that many milliseconds after `decide` returns AUTHORIZED and before `sign`, inside `serialize()`.
  - The whole of authorize steps 1–8 (T014) must run inside the single `serialize()` call (INV-8).

**Checkpoint**: SEC-6 is closed, with a test proving the mutex is load-bearing.

---

## Phase 7: User Story 5 — Approved escalations pay once (Priority: P2)

**Goal**: A matching approval (same payee case-insensitive, exact amount string) lifts R14
once. An approval never overrides a DENY. R14 itself is part of US2 (MVP).

**Independent Test**: The T-POL-13 approval-match cases pass. The issuance and consumption
flow (T-E2E-02) is verified in feature 004.

### Tests for User Story 5 ⚠️

- [X] T039 [P] [US5] Add **T-POL-13 (approval-match cases)** to `test/policy.test.ts`:
  1. `humanApprovedFor: { payTo: upper(payTo), amount: "50000", approvalId: "apr_test" }` gives AUTHORIZED.
  2. An approval for `"50001"` still gives ESCALATE.
  3. An approval plus `hard_cap_exceeded` (amount `"200000"`) gives DENIED, and `human_approval_required` is not among the violations (INV-12).

### Implementation for User Story 5

- [X] T034 [US5] In `src/layer2-control/service.ts`, inside `serialize()`:
  - Call `ledger.findOpenApproval(sessionId, resourceKey, t)` (implemented by 003 on `AuditLedger`; semantics and tests by 004: the most recent open, i.e. unexpired and unconsumed, approval) before building `ctx`, where `resourceKey` = origin + pathname of `intent.resourceUrl` (003).
  - Map the result to `ctx.humanApprovedFor = { payTo, amount, approvalId: approval.data.approvalId }`.
  - On AUTHORIZED with that approval used, set `approvalRef = approval.data.approvalId` on the AUTHORIZED entry, which consumes that single approval. Otherwise `approvalRef` stays `null` (T014).
  - On ESCALATE, append `ESCALATED` with `{violations, resourceKey, payTo, amount}`.

  The approval lifecycle itself belongs to 004.

**Checkpoint**: All five stories are independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T035 [P] Check that every rule ID in `contracts/policy-rules.md` (R1–R14, `no_payment_options`, `signer_rejected`) appears in at least one `expect` in `test/policy.test.ts` (SC-001). Add any missing case.
- [X] T036 [P] Verify that the items mandate constraint fails startup (research R7), unknown-session budget returns 200 with zero spend, and `remainingAtomic ≥ 0` (research R8) are covered by 008 T000 (SPEC.md v1.1 amendment), and that SPEC.md §8.2 (L2-2 table, L2-3, L2-5 authorize and budget rows) and CFG-3 match the implementation.
- [X] T037 Run `npm run typecheck` and `npm test`. The architecture test (007) must show `privateKeyToAccount` only in `src/layer2-control/signer.ts`, and that `src/layer2-control/**` imports only `src/shared/*` and its own folder.
- [X] T038 Run the quickstart.md §2 curl checks, then `npm run demo:local`. Confirm:
  - step 4 is ESCALATED with `human_approval_required`
  - step 5 is DENIED with `hard_cap_exceeded`
  - step 6 is DENIED with `host_not_allowed`
  - final `spentOrReservedAtomic = 6000` (SC-004, SC-005)
  - the summary is unchanged: `spent on-chain: 0.006 USDC`, `hash chain ok=true`

---

## Dependencies & Execution Order

### Phase Dependencies

- **All tasks depend on 008 T000** (the SPEC.md v1.1 amendment).
- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup, and on external 001 T004 (`src/shared/contracts.ts`), 006 (network profile), 003 (ledger API) and 007 (`requireRole`). It blocks every story.
- **US1 (Phase 3)**: depends on Foundational. It is the MVP.
- **US2 (Phase 4)**: depends on Foundational only, since `policy.ts` rules are independent of signing. It can run in parallel with US1, but T021/T022 and T012 all edit `policy.ts`, so sequence those edits.
- **US3 (Phase 5)**: depends on Foundational. T026/T027 build on the authorize handler from T014.
- **US4 (Phase 6)**: depends on US1 (T014 handler) and 008's e2e harness plus 006's local chain and seller for T-E2E-04.
- **US5 (Phase 7)**: depends on US1 and US2 (R14, T033). T034 depends on 003's `ledger.findOpenApproval` (semantics from 004); the T039 unit tests need nothing external.
- **Polish (Phase 8)**: depends on all stories.

### User Story Dependencies

- US1 → US3 (budget fields in the authorize response), US4 (mutex wraps the handler) and US5 (approval in ctx).
- US2 is independent of the other stories.

### Within Each User Story

Write the tests first and confirm they fail. Then do `policy.ts`, then `signer.ts`, then the
`service.ts` handler, then wiring.

### Parallel Opportunities

- T002 and T003. T005 alongside T006/T007.
- All `[P]` test tasks inside a story, since they are separate `describe`/`it` blocks. If more than one person edits `test/policy.test.ts`, coordinate merges.
- T013 (signer.ts) alongside T012 (policy.ts).
- US2 test writing (T016–T020) alongside US1 implementation.

---

## Parallel Example: User Story 2

```bash
Task: "T016 [US2] T-POL-03..10 rule tests in test/policy.test.ts"
Task: "T017 [US2] T-POL-11 host/binding tests in test/policy.test.ts"
Task: "T018 [US2] T-POL-14 expiry/velocity/empty tests in test/policy.test.ts"
Task: "T032 [US2] T-POL-13 escalation cases in test/policy.test.ts"
```

## Parallel Example: User Story 1

```bash
Task: "T012 [US1] decide() + AUTHORIZED path in src/layer2-control/policy.ts"
Task: "T013 [US1] PaymentSigner in src/layer2-control/signer.ts"
```

---

## Implementation Strategy

### MVP First (P1 stories: US1 → US2 → US3 → US4, including R14)

1. Phase 1 Setup, then Phase 2 Foundational.
2. US1: the compliant payment is signed. **Stop and validate** with T-POL-01/02 and the signer and HTTP tests.
3. US2 and US3: the full DENY rule set, R14 escalation and budgets. Validate T-POL-03..12, T-POL-14 and the T-POL-13 escalation cases.
4. US4: serialization, plus the negative control (T029).
5. The MVP is the full P1 set. All four stories are needed before any real funds move, because
   a signer without deny rules or serialization is unsafe.
6. **R14 is required in the MVP** (T032, T033). Without it the 50000-atomic premium report is
   auto-approved because it is under the 100000 hard cap, so T-E2E-01 step 4 and the
   `spent on-chain: 0.006 USDC` summary fail.

### Incremental Delivery

- After US1, a demo can pay 1000-atomic resources, but the guardrails are incomplete. Use only on a local chain.
- After US2 and US3, the mandate is enforced for sequential traffic.
- After US4, the mandate holds under concurrency (SEC-6).
- After US2, payments above the auto-approve limit escalate. After US5 together with feature 004, an approved escalation pays once per approval.

### Parallel Team Strategy

- Developer A: `policy.ts`, US2 then US3 rules.
- Developer B: `signer.ts` and the `service.ts` handler (US1), then US4.
- US5 starts once 003's `ledger.findOpenApproval` exists (semantics from 004).

---

## Notes

- `[P]` means a different file or a separate test block with no incomplete dependency.
- Never weaken an INV-* to make a test pass (constitution §VIII).
- Reference requirement IDs (`T-POL-xx`, `INV-8`, `L2-2 Rn`) in commit messages and test names.
- Cross-feature items are referenced, not duplicated: the ledger API and committed spend are 003; approvals are 004; the network profile is 006; the architecture test, env templates and auth middleware are 007; the e2e harness and demo are 008.
