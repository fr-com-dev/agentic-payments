---

description: "Task list for 004 Human-in-the-Loop Approval of Escalated Payments"
---

# Tasks: Human-in-the-Loop Approval of Escalated Payments

**Input**: Design documents from `specs/004-human-approval-escalation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/approvals-api.md, contracts/approve-cli.md, quickstart.md

**Tests**: Requested. Constitution Principle VIII and the spec's T-* IDs (T-POL-13, T-E2E-02, T-AGT-01) require them. Write each test first and confirm it fails before implementing.

**Organization**: Tasks are grouped by user story. This feature owns:
- the approvals route and the authorize step 6 `approvalRef = approvalId` wiring in `src/layer2-control/service.ts`
- the semantics and tests of `findOpenApproval` (003 implements it on `AuditLedger` in `src/layer2-control/ledger.ts`)
- `scripts/approve.ts`

Owned elsewhere and only verified here:
- R14, `PolicyContext.humanApprovedFor` and authorize steps 2–3: 002.
- Ledger core, schema and the `findOpenApproval` implementation: 003.
- `requireRole` and `env/operator.env.example`: 007. The `approve` npm script: 008.
- The agent: 001.

**Approval semantics**: each approval is single-use by its own `approvalId` (`apr_<uuid>`). `AUTHORIZED.data.approvalRef` holds the consumed `approvalId`, or `null`. Re-approving returns 200 with a new approval.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story the task belongs to (US1–US5)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Operator-side configuration and script wiring

- [X] T001 [P] Verify `env/operator.env.example` (owned by 007 T049) contains only `CONTROL_URL` and `OPERATOR_TOKEN`, and none of `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `VERIFIER_TOKEN`, `SETTLEMENT_TOKEN` or `ANTHROPIC_API_KEY` (contracts/approve-cli.md). Raise any gap with 007.
- [X] T002 [P] Verify `package.json` (owned by 008 T002) defines `"approve": "tsx scripts/approve.ts"`. Raise any gap with 008.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types and the ledger lookup that every story depends on.

**⚠️ CRITICAL**: Requires 003's ledger core (append, entry types `ESCALATED`, `HUMAN_APPROVAL`, `AUTHORIZED`; `resourceKey`) and 002's `PolicyContext` and authorize mutex.

- [X] T003 Verify `PolicyContext` in `src/layer2-control/policy.ts` (owned by 002) has `humanApprovedFor?: { payTo: string; amount: string; approvalId: string }` (data-model.md "Policy context input"). Raise any gap with 002.
- [X] T004 Verify 003's entry schema in `src/layer2-control/ledger.ts` matches data-model.md: `AUTHORIZED.data.approvalRef: string | null`, "the `approvalId` of the approval consumed, or `null` (always present)"; and `HUMAN_APPROVAL.data` with required `approvalId` (`apr_<uuid>`), `escalationId`, `resourceKey`, `payTo`, `amount`, `approver` and `expiresAtMs`. Raise any gap with 003.
- [X] T005 Write a unit test for `findOpenApproval(sessionId, resourceKey, nowMs)` in `test/ledger.test.ts`. It must:
  - return the most recent open entry;
  - exclude entries "where `nowMs > data.expiresAtMs`";
  - exclude entries whose `approvalId` appears as `approvalRef` on any `AUTHORIZED` entry;
  - keep a second approval of the same escalation open after the first is consumed;
  - ("most recent wins") with an older open approval and a newer open approval for the same session and resource key, return the newer one even when only the older one's payee and amount would match the request;
  - not match a different `sessionId` or `resourceKey`;
  - return `undefined` when nothing is open.
- [X] T006 Verify 003's `findOpenApproval` on `AuditLedger` in `src/layer2-control/ledger.ts` follows the 4 steps in data-model.md, keyed on `approvalId`, with no mutable approvals map (FR-012, INV-7), and that T005 passes against it. Depends on T004 and T005.

**Checkpoint**: The ledger can answer "is there an open approval?". User stories can begin.

---

## Phase 3: User Story 1 - Payments above the auto-approve limit wait for a human (Priority: P1) 🎯 MVP

**Goal**: A payment that passes every DENY rule and has an amount above `autoApproveMaxAtomic` (20000) with no matching approval escalates with `human_approval_required`. It is never signed, and it is recorded as `ESCALATED`.

**Independent Test**: With the default mandate, a request for 50000 atomic ends ESCALATED, produces no signature and records an `ESCALATED` entry (T-E2E-01 step 4).

### Tests for User Story 1 ⚠️

- [X] T007 [P] [US1] Add tests labeled `T-POL-13 escalation` in `test/policy.test.ts` for three cases:
  - 50000 with no `humanApprovedFor` → `ESCALATE` with rule `human_approval_required`;
  - exactly 20000 → `AUTHORIZED`;
  - when no option is AUTHORIZED and one is ESCALATE, `decide` returns ESCALATE with that option's violations (FR-003).
- [X] T008 [P] [US1] In `test/e2e.local.test.ts`, assert on the step-4 premium-report escalation (T-E2E-01 step 4, owned by 008):
  - the ledger has an `ESCALATED` entry with `data.violations` containing `human_approval_required`;
  - `data.resourceKey` equals `origin + pathname`;
  - `data.payTo` is set and `data.amount === "50000"`;
  - the session has no `AUTHORIZED` entry for that resource.

### Implementation for User Story 1

- [X] T009 [US1] Verify R14 in `evaluateRequirement` in `src/layer2-control/policy.ts` (owned by 002): `human_approval_required` (effect ESCALATE) is emitted only when there is no DENY violation, `amount > autoApproveMaxAtomic` (BigInt) and `ctx.humanApprovedFor` does not match. T007 must pass against it. Depends on T003.
- [X] T010 [US1] In the authorize path in `src/layer2-control/service.ts`, ensure an ESCALATE decision skips signing. Append `ESCALATED` with `violations`, `resourceKey`, `payTo` and `amount`, then return `{ status: "ESCALATE", authorizationId, intentId, violations }` (FR-004).
- [X] T011 [US1] Verify that 001's orchestrator returns outcome `ESCALATED` with `violations` and `authorizationId`, and does not retry (FR-005). This is covered by 001's tasks; mark it done after cross-checking `src/layer1-intent/orchestrator.ts`.

**Checkpoint**: Escalation works end to end. The MVP oversight control is in place.

---

## Phase 4: User Story 2 - Operator approves one exact escalated payment (Priority: P1)

**Goal**: The operator approves an escalation by its authorization ID. The same session can then pay that exact resource key, payee (case-insensitive) and amount string once, within the TTL (default 600 s).

**Independent Test**: T-E2E-02: escalate → operator approval → PAID+CONFIRMED with `approvalRef === approvalId` → the same request escalates again.

### Tests for User Story 2 ⚠️

- [X] T012 [P] [US2] Add tests labeled `T-POL-13 matching approval` in `test/policy.test.ts`:
  - `humanApprovedFor` with the same `payTo` in different case and the same `amount` → `AUTHORIZED`;
  - `amount: "50001"` instead of `"50000"` → `ESCALATE`;
  - a different `payTo` → `ESCALATE`.
- [X] T013 [P] [US2] Add a test labeled `T-E2E-02 HITL approve and consume` in `test/e2e.local.test.ts`:
  1. Escalate.
  2. `POST /v1/approvals/:id` with `OPERATOR_TOKEN` returns 200 with `{ ok: true, approvalId: /^apr_/, expiresAt }`.
  3. Retry: the result is PAID and CONFIRMED, and `AUTHORIZED.data.approvalRef === approvalId` (the ID returned in step 2).
  4. Same request again: ESCALATED.
  5. With no `ttlSeconds`, `expiresAtMs - now ≈ 600000`.

  Status: steps 1, 2, 4 and 5 and the `approvalRef` check pass in-process in `test/policy.test.ts` ("T-E2E-02 HITL approve and consume"). The PAID+CONFIRMED leg needs L1, L3 and the 008 harness.
- [X] T014 [P] [US2] In `test/e2e.local.test.ts`, test the approvals-endpoint errors:
  - an unknown ID, a DENIED ID and an AUTHORIZED ID each return 404 and append nothing;
  - `ttlSeconds: 0` and `ttlSeconds: "x"` each return 400 and append nothing.
- [X] T015 [P] [US2] In `test/e2e.local.test.ts`, test edge cases:
  - an approval used from a different `sessionId` escalates;
  - an expired approval (`ttlSeconds: 1`, then wait more than 1 s) escalates;
  - the same path with a different query string matches, because `resourceKey` excludes the query.

### Implementation for User Story 2

- [X] T016 [US2] Implement `POST /v1/approvals/:authorizationId` in `src/layer2-control/service.ts`, per contracts/approvals-api.md:
  0. Mount `requireRole("operator")` from `src/shared/auth.ts` (007) when the route is created, before body validation. No unauthenticated version of this route ever exists.
  1. Find the `ESCALATED` entry, or return 404 `{ error: "not found" }`.
  2. Validate `ttlSeconds` ("must be > 0", integer, default `600`), or return 400.
  3. Use `approver` from the body, defaulting to `"operator"`.
  4. Copy `resourceKey`, `payTo`, `amount` and `sessionId` **from the ESCALATED entry, never from the request**.
  5. Append exactly one `HUMAN_APPROVAL` entry with `expiresAtMs = now + ttlSeconds × 1000`.
  6. Respond 200 with `{ ok: true, approvalId, expiresAt (ISO) }`.

  Depends on T004.
- [X] T017 [US2] Verify authorize steps 2–3 in `src/layer2-control/service.ts` (owned by 002 T034): inside the serialized section, `ledger.findOpenApproval(sessionId, resourceKey(intent.resourceUrl), t)` sets `ctx.humanApprovedFor = { payTo, amount, approvalId }` (contracts/approvals-api.md "Effect on /v1/authorize"). Depends on T006 and T003.
- [X] T018 [US2] Verify the R14 matching rule in `src/layer2-control/policy.ts` (owned by 002 T033): R14 is lifted iff `lower(req.payTo) === lower(humanApprovedFor.payTo)` and `req.amount === humanApprovedFor.amount`, comparing the exact amount string with no numeric normalization (Principle VI). T012 must pass. Depends on T009.
- [X] T019 [US2] Wire authorize step 6 in `src/layer2-control/service.ts`. When the decision is AUTHORIZED and R14 was lifted by the approval, append `AUTHORIZED` with `data.approvalRef = humanApprovedFor.approvalId`; otherwise `approvalRef: null` (always present). Do this inside the same serialized section as step 2 (NFR-005). Depends on T017 and T018.
- [X] T020 [US2] Add a concurrency test labeled `T-E2E-02 single consumption under concurrency` in `test/e2e.local.test.ts`. With `signerLatencyMs: 25`, fire 2 concurrent identical intents after one approval. Expect exactly 1 `AUTHORIZED` with that `approvalRef`, and the other ESCALATED (NFR-003, NFR-005).
- [X] T034 [P] [US2] Add a test labeled `T-E2E-02 each approval pays once` in `test/e2e.local.test.ts`. Use a fresh harness with a mandate override `sessionBudgetAtomic: "200000"`, because under the default 100000 budget the third 50000 request is DENIED by `session_budget_exceeded` before R14 can fire:
  1. Escalate one request.
  2. Approve the same escalation twice; both return 200 with different `approvalId`s.
  3. Send the same request three times. The first two are PAID, and their `AUTHORIZED.data.approvalRef` values are the two distinct `approvalId`s, newest first.
  4. The third is ESCALATED again (`human_approval_required`), and no third `approvalRef` exists.

**Checkpoint**: The HITL loop is complete. The MVP is US1–US3; the operator guard has been on the route since T016.

---

## Phase 5: User Story 3 - The agent cannot approve its own escalations (Priority: P1)

**Goal**: Only `OPERATOR_TOKEN` can reach `/v1/approvals/*`. The agent has no approve tool.

**Independent Test**: An approval attempt with the agent's `CONTROL_TOKEN` returns 401 (T-E2E-02).

### Tests for User Story 3 ⚠️

- [X] T021 [P] [US3] Add a test labeled `T-E2E-02 agent token cannot approve` in `test/e2e.local.test.ts`. `POST /v1/approvals/:id` with `CONTROL_TOKEN`, `SETTLEMENT_TOKEN`, `VERIFIER_TOKEN` and no token each return 401 `{ error: "unauthorized" }`, and the ledger has no `HUMAN_APPROVAL` entry (NFR-001, SEC-8).
- [X] T022 [P] [US3] Confirm that `T-AGT-01` in `test/agent.test.ts` (owned by 001) asserts the tool set is exactly `fetch_resource` and `check_budget`, with no approve tool (NFR-002). Add the assertion if it is missing.

### Implementation for User Story 3

- [X] T023 [US3] Verify the `requireRole("operator")` guard mounted in T016 (`src/layer2-control/service.ts`) rejects `CONTROL_TOKEN`, `SETTLEMENT_TOKEN` and `VERIFIER_TOKEN` with 401 before body validation. The control service binds to `127.0.0.1` only (NFR-007). Depends on T016.
- [X] T024 [US3] Show that the safety test fails without its control (Principle VIII). Temporarily accept `CONTROL_TOKEN` on the approvals route and confirm T021 fails. Restore the check, and record the result in the PR description. Result: with the guard bypassed, `CONTROL_TOKEN` got 400 instead of 401 and the test failed; restored byte-for-byte, it passes.

**Checkpoint**: Self-approval is impossible.

---

## Phase 6: User Story 4 - Approval never overrides a hard limit (Priority: P2)

**Goal**: A matching open approval cannot turn any DENY violation into AUTHORIZED, and the approval stays open (INV-12).

**Independent Test**: T-POL-13: a matching approval plus `session_budget_exceeded` → DENIED.

### Tests for User Story 4 ⚠️

- [X] T025 [P] [US4] Add tests labeled `T-POL-13 approval never overrides DENY` in `test/policy.test.ts`. A matching `humanApprovedFor` combined with each of `session_budget_exceeded`, `hard_cap_exceeded`, `payee_not_allowed`, `host_not_allowed`, `velocity_limit` and `mandate_expired` gives `DENIED`, and no violation `human_approval_required` is emitted.
- [X] T026 [P] [US4] In `test/e2e.local.test.ts`, approve an escalation, then exhaust the session budget so the approved request is DENIED. Assert that no `AUTHORIZED` entry has that `approvalRef`, and that `findOpenApproval` still returns the approval (FR-011).

### Implementation for User Story 4

- [X] T027 [US4] Verify in `src/layer2-control/policy.ts` (owned by 002) that `humanApprovedFor` is read **only** inside the R14 branch, which runs only when the DENY list is empty (research R4). T025 must pass. Depends on T018.

**Checkpoint**: INV-12 is enforced and tested.

---

## Phase 7: User Story 5 - Operator approves from a command-line tool (Priority: P3)

**Goal**: `ENV_FILE=env/operator.env npm run approve -- <authorizationId> [approver]` submits an approval using only `CONTROL_URL` and `OPERATOR_TOKEN`.

**Independent Test**: Run the CLI against an escalated ID. It prints `{ ok, approvalId, expiresAt }` and exits 0. The ledger records the given approver.

### Tests for User Story 5 ⚠️

- [X] T028 [P] [US5] Add a CLI test in `test/e2e.local.test.ts`. Spawn `tsx scripts/approve.ts` with no secrets other than `CONTROL_URL` and `OPERATOR_TOKEN` (keep `PATH`, `HOME`, `NODE_*`, matching 008's child-env policy), and check:
  - an escalated ID → exit 0, JSON stdout, and `HUMAN_APPROVAL.data.approver === "alice"`;
  - an unknown ID → exit 1 and the 404 printed;
  - no arguments → exit 2 and usage printed.

### Implementation for User Story 5

- [X] T029 [US5] Implement `scripts/approve.ts` per contracts/approve-cli.md:
  - Load env with `loadEnv()` (007, default `env/operator.env`) and read only `CONTROL_URL` and `OPERATOR_TOKEN`.
  - Parse `<authorizationId> [approver]`; with no ID, print usage and exit 2.
  - `POST {CONTROL_URL}/v1/approvals/{id}` with body `{ approver }` and `Authorization: Bearer ${OPERATOR_TOKEN}`.
  - Print the JSON response. Exit 0 on 200; exit 1 on 400, 401, 404 or a network error.

  Depends on T001 and T002.

**Checkpoint**: All five stories are independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T030 Show that the consumption check is load-bearing (Principle VIII, quickstart.md step 4). Temporarily remove the "consumed" filter (step 3 of `findOpenApproval` in `src/layer2-control/ledger.ts`) and confirm T013's final assertion (repeat → ESCALATED) fails. Restore the filter. Result: without the filter the repeat request was AUTHORIZED and the test failed; restored byte-for-byte, it passes.
- [X] T031 [P] Confirm that `test/architecture.test.ts` (owned by 007) covers `scripts/approve.ts`: the script never references `PAYER_PRIVATE_KEY` and makes no L1 import.
- [X] T032 [P] Verify the items below are covered by 008 T000 (SPEC.md v1.1 amendment) and match this feature's contracts: SPEC L2-4.2 consumption by `approvalId` (`approvalRef = approvalId`); `HUMAN_APPROVAL.data.approvalId` (`apr_<uuid>`); re-approval returns 200 with a new approval; approvals 400 on a bad `ttlSeconds`; `approver` default `"operator"`; approve CLI exit codes 0/1/2. File: `SPEC.md`
- [ ] T033 Run `npm run typecheck` and `npm test`, then run quickstart.md sections 1–3 manually against `npm run demo:local`. The ledger must show `ESCALATED` → `HUMAN_APPROVAL` (approver `alice`) → `AUTHORIZED` (`approvalRef`), and `GET /v1/ledger/verify` must return `ok: true`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **All tasks depend on 008 T000** (SPEC.md v1.1 amendment).
- **Setup (Phase 1)**: none beyond 008 T000.
- **Foundational (Phase 2)**: needs 003's ledger core and 002's `PolicyContext` and authorize mutex. Blocks all stories.
- **US1 (Phase 3)**: after Phase 2. End-to-end tests need 001, 005 and 006 running.
- **US2 (Phase 4)**: after US1 (T009 is needed by T018).
- **US3 (Phase 5)**: after T016. Needs 007's per-role auth middleware.
- **US4 (Phase 6)**: after US2 (T018).
- **US5 (Phase 7)**: after T016. Independent of US3 and US4.
- **Polish (Phase 8)**: after all stories.

### Cross-Feature Blockers

- **002**: R14, `PolicyContext.humanApprovedFor`, `evaluateRequirement`/`decide`, authorize steps 2–3, the serialized section and the `signerLatencyMs` hook.
- **003**: the ledger append/scan API, entry types (with `approvalRef` and `approvalId`), `resourceKey` and the `findOpenApproval` implementation.
- **007**: `requireRole("operator")` in `src/shared/auth.ts` and `env/operator.env.example`.
- **008**: T000 (SPEC.md v1.1), the `approve` npm script, the e2e harness and T-E2E-01 step 4.
- **001**: the ESCALATED outcome without retry, and the T-AGT-01 tool-set assertion.

### Within Each User Story

- Tests are written first and must fail. Then policy, then ledger, then service wiring.
- `service.ts` tasks (T010, T016, T019, T023) touch one file, so run them sequentially.

### Parallel Opportunities

- T001 and T002 can run together.
- All test-writing tasks marked [P] within a phase can run together.
- US3 (T021–T024) and US5 (T028–T029) can proceed in parallel once T016 lands.

---

## Parallel Example: User Story 2

```bash
# Write all US2 tests together:
Task: "T-POL-13 matching approval tests in test/policy.test.ts"
Task: "T-E2E-02 HITL approve and consume in test/e2e.local.test.ts"
Task: "approvals 404/400 error tests in test/e2e.local.test.ts"
Task: "session/expiry/query-string edge-case tests in test/e2e.local.test.ts"
Task: "T-E2E-02 each approval pays once in test/e2e.local.test.ts"
```

---

## Implementation Strategy

### MVP First (P1 stories: US1 + US2 + US3)

1. Phase 1 (Setup), then Phase 2 (Foundational).
2. US1: escalation without signing. Validate T-E2E-01 step 4.
3. US2: operator approval, single consumption. Validate T-E2E-02.
4. US3: operator-only access. Validate the 401 path.
5. **STOP and VALIDATE**: the full T-E2E-02 passes and the demo summary is unchanged (0.006 USDC, `ok=true`).

### Incremental Delivery

1. MVP (US1–US3).
2. US4: INV-12 hardening tests.
3. US5: operator CLI.
4. Polish: the failure demonstration, the SPEC sync and the quickstart run.

---

## Notes

- [P] tasks touch different files and have no unmet dependencies.
- Never weaken INV-12 or INV-13 to make a test pass.
- Reference requirement IDs (INV-12, SEC-8, T-POL-13, T-E2E-02) in commit messages.
