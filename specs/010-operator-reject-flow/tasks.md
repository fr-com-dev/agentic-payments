---

description: "Task list for 010 escalation lifecycle: operator rejection, expiry and notification"
---

# Tasks: Escalation Lifecycle: Operator Rejection, Expiry and Notification

**Input**: Design documents from `specs/010-operator-reject-flow/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md)
- [data-model.md](data-model.md)
- [contracts/](contracts/)
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII requires a test for every rule, endpoint
and contract field, plus must-fail proofs. Test titles carry their IDs (T-POL-15, T-LED-04, T-E2E-07,
T-E2E-08, or `010 USn …`), because T-ARCH-TRACE checks them. Write each story's tests first and confirm
they fail before implementing.

**Organization**: tasks are grouped by user story (US1–US6 from spec.md) so each story can be built
and checked on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel: a different file, and no dependency on an incomplete task.
- **[Story]**: the user story the task belongs to (US1–US6).

## Path Conventions

- Single repository: `src/`, `scripts/`, `test/` and `specs/` at the repository root (see plan.md
  "Project Structure").
- L2 runtime code stays in `src/layer2-control/`, and operator commands in `scripts/`, which import
  only `src/shared/*` (A1).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: register the new entry types, commands and test clock hook, so later phases compile.

- [X] T001 [P] Add `"reject": "tsx scripts/reject.ts"` and `"escalations": "tsx scripts/escalations.ts"` to `scripts` in package.json, next to `"approve"`.
- [X] T002 [P] Extend `EntryType` in src/layer2-control/ledger.ts with `"HUMAN_REJECTION" | "ESCALATION_EXPIRED" | "APPROVAL_LAPSED" | "ESCALATION_REPEATED"`. Make no other change to ledger.ts (data-model.md "New" table).
- [X] T003 [P] Add `controlNow?: () => number` to `HarnessOptions` in test/helpers/harness.ts and pass it as `now` to `createControlService`. When the option is absent the behavior is unchanged, so T-E2E-01..06 are unaffected.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: derive the escalation state from the ledger. Every story depends on it.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

- [X] T004 Create src/layer2-control/escalations.ts:
  - Header comment: "SPEC L2-4.3 (010). Pure derivations over ledger entries; only `sweep` writes. Never reads the clock."
  - Exported constants, values verbatim: `ESCALATION_TTL_MS = 300_000`, `REASON_MAX = 280`, `OPERATOR_LABEL_MAX = 64`.
  - `type EscalationState = "not_found" | "pending" | "approved" | "denied" | "expired"`.
  - `findEscalation(entries, escalationId)`: returns the `ESCALATED` entry whose `authorizationId === escalationId`.
  - `expiresAtMsOf(escalatedEntry) = Date.parse(ts) + ESCALATION_TTL_MS`.
  - `escalationState(entries, escalationId, nowMs)`, evaluated in exactly this order:
    1. `not_found` when there is no `ESCALATED` entry;
    2. `approved` when any `HUMAN_APPROVAL` has `data.escalationId === id` (the first one is the decision);
    3. `denied` when any `HUMAN_REJECTION` has `data.escalationId === id`;
    4. `expired` when an `ESCALATION_EXPIRED` has `data.escalationId === id`, **or** `nowMs >= expiresAtMs`;
    5. otherwise `pending`.
  - `decisionEntry(entries, escalationId)`: returns the first `HUMAN_APPROVAL`, `HUMAN_REJECTION` or `ESCALATION_EXPIRED` for the escalation.
- [X] T005 [P] Create test/escalations.test.ts with a temporary-file `AuditLedger` and small entry writers (`escalate`, `approveEntry`, `rejectEntry`, `expireEntry`). Add `describe("T-LED-04 escalation state")` with these cases:
  - each of the five states;
  - the boundary: `createdMs + 299_999` is pending and `createdMs + 300_000` is expired;
  - when a decision entry exists, `nowMs` beyond 300 s still reports the decision ("final states are never left");
  - an unknown ID is `not_found`.

**Checkpoint**: `npx vitest run test/escalations.test.ts` is green, and `npm run typecheck` passes.

---

## Phase 3: User Story 1 - Operator says no to a pending escalation (Priority: P1) 🎯 MVP

**Goal**:
- The operator rejects a pending escalation, and one `HUMAN_REJECTION` entry is recorded.
- Every later request for that session and resource is DENIED with R15 `human_rejected`.

**Independent Test**: escalate a 50000 request, reject it with the operator token, then repeat the
request in the same session. The repeat is DENIED with `human_rejected`, nothing is signed, and the
ledger shows ESCALATED → HUMAN_REJECTION → DENIED.

### Tests for User Story 1 (write first; they must fail)

- [X] T006 [P] [US1] Add `describe("T-POL-15 human_rejected (R15)")` to test/policy.test.ts, using `evaluateRequirement`, `decide`, `baseCtx` and `baseRequirement`. Implement every row of contracts/policy-r15.md:
  - a 50000 request with `humanRejected` is DENIED with exactly `["human_rejected"]`;
  - a 5000 request is DENIED with `["human_rejected"]`;
  - with a matching `humanApprovedFor`, it is still DENIED;
  - over the session budget, the rules include both `session_budget_exceeded` and `human_rejected`;
  - **the must-fail control**: without `humanRejected`, the same 50000 request is ESCALATE `human_approval_required`;
  - the detail matches `/^rejected by the operator \(rej_[\w-]+\)$/`.
- [X] T007 [P] [US1] Add `describe("T-LED-04 findRejection")` to test/escalations.test.ts:
  - it returns the most recent `HUMAN_REJECTION` for (session, resourceKey), whatever the amount or payee;
  - it returns undefined for another session or another resourceKey;
  - it returns undefined when only approvals or expiries exist.
- [X] T008 [US1] Add `describe("010 US1 operator rejects a pending escalation")` to test/policy.test.ts, using `startService`, `authz`, `intent` and `req50`, plus a new `rejectCall(base, id, body = {}, token = TOKENS.operator)` helper that POSTs to `/v1/rejections/:id`. Cases:
  1. A pending escalation gives 200 `{ ok: true, rejectionId: /^rej_/, rejectedAt, alreadyRejected: false }`. Exactly one `HUMAN_REJECTION` is appended, with `sessionId` and `authorizationId` equal to the escalation's and `data.resourceKey`, `payTo` and `amount` copied from the `ESCALATED` entry. A `payTo` or `amount` in the request body is ignored.
  2. A second reject gives 200 with the same `rejectionId` and `alreadyRejected: true`, and nothing is appended.
  3. An unknown ID, an AUTHORIZED ID and a DENIED ID each give 404 `{ error: "not found" }`, and nothing is appended.
  4. Each of these gives 400 and appends nothing: `operator` of 65 characters, `operator: ""`, `operator: 5`, a `reason` of 281 characters, `reason: 5`.
  5. A label of exactly 64 characters and a reason of exactly 280 characters give 200.
  6. After a rejection, the same session and resource is DENIED with `["human_rejected"]` for the same amount, for 60000, and for 5000 (below auto-approve). Each repeat appends a `DENIED` entry and nothing is signed.
  7. A different session for the same resource is ESCALATE `human_approval_required`.
- [X] T009 [US1] Add `it("T-E2E-07 reject: escalate → operator reject → retry DENIED human_rejected; other session escalates; ledger trail")` to test/e2e.local.test.ts, in a new `describe("T-E2E-07 operator reject")` that has its own `startHarness()`.
  - Use `l1(h, "sess_e2e07")` to fetch `/api/premium-report` and get the outcome `ESCALATED`.
  - POST `/v1/rejections/:id` with the operator token and body `{ operator: "e2e-operator", reason: "too expensive" }`, which gives 200.
  - Fetch again. The outcome is `DENIED` with `rulesOf` equal to `["human_rejected"]`, the payer balance is unchanged, and the violation detail contains neither "e2e-operator" nor "too expensive".
  - `l1(h, "sess_e2e07b")` fetching the same URL gives `ESCALATED`.
  - For `sess_e2e07`, the ledger types for that resource are `[…, ESCALATED, HUMAN_REJECTION, …, DENIED]`.

### Implementation for User Story 1

- [X] T010 [US1] In src/layer2-control/policy.ts:
  - add `humanRejected?: { rejectionId: string }` to `PolicyContext`;
  - in `evaluateRequirement`, after R13 and before `if (v.length > 0) return { status: "DENIED", … }`, add `// R15` with `if (ctx.humanRejected) deny("human_rejected", \`rejected by the operator (${ctx.humanRejected.rejectionId})\`)`;
  - update the doc comment from "rules R1–R14" to "rules R1–R15".

  Never put the operator label or the reason in the detail (SEC-12).
- [X] T011 [US1] Add `findRejection(entries, sessionId, resourceKey)` to src/layer2-control/escalations.ts. It returns the most recent `HUMAN_REJECTION` with a matching `sessionId` and `data.resourceKey`, or undefined.
- [X] T012 [US1] In src/layer2-control/service.ts `authorize()` step 3, compute `const rejection = findRejection(ledger.entries(), sessionId, key)`. Add `...(rejection && { humanRejected: { rejectionId: rejection.data.rejectionId as string } })` to `ctx`. Import from `./escalations.js`.
- [X] T013 [US1] In src/layer2-control/approval-routes.ts, add `parseRejectionBody(body)`:
  - `operator` is optional and defaults to `"operator"`. It must be a string of 1–`OPERATOR_LABEL_MAX` (64) characters, otherwise `{ ok: false, error: "operator must be a string of 1-64 characters" }`.
  - `reason` is optional. It must be a string of at most `REASON_MAX` (280) characters, otherwise `{ ok: false, error: "reason must be a string of at most 280 characters" }`.
- [X] T014 [US1] In src/layer2-control/approval-routes.ts `mountApprovalRoutes`, add `app.post("/v1/rejections/:authorizationId", requireRole("operator", opt), express.json(), handler)`. The handler:
  1. Returns 400 when `parseRejectionBody` fails.
  2. Inside `deps.serialize`, reads `t = deps.now()` once and gets the `escalationState` of the ID.
  3. `not_found` → 404 `{ error: "not found" }`.
  4. `approved` → 409 `{ error: "escalation is approved", state: "approved", approvalId }`.
  5. `expired` → 409 `{ error: "escalation is expired", state: "expired", expiresAt: ISO(expiresAtMs) }`.
  6. `denied` → 200 with the existing rejection: `{ ok: true, rejectionId, rejectedAt: <entry ts>, alreadyRejected: true }`.
  7. `pending` → append `{ type: "HUMAN_REJECTION", sessionId: escalated.sessionId, authorizationId: id, data: { rejectionId: \`rej_${randomUUID()}\`, escalationId: id, resourceKey, payTo, amount (all three copied from the ESCALATED entry), operator, reason? (omit when absent) } }` at `t`, and respond 200 `{ ok: true, rejectionId, rejectedAt: ISO(t), alreadyRejected: false }`.

  The state check and the append form one synchronous block, with no `await` between them. Update the file's header comment to cover L2-4.3 and feature 010.

**Checkpoint**: T006–T009 are green. US1 is a working MVP: the operator can say no, and it is enforced.

---

## Phase 4: User Story 2 - Every escalation ends in exactly one final state (Priority: P1)

**Goal**:
- Approve and reject act only on a pending escalation; repeating the deciding action returns the
  existing decision, and the opposite action is 409.
- An escalation pays at most once.
- A repeat of the same purchase while pending returns the same ID.

**Independent Test**: drive one escalation to each final state, then try both actions on it. The
opposite action is refused with 409 and the deciding action is idempotent. A concurrent approve and
reject yields exactly one final entry.

### Tests for User Story 2

- [X] T015 [P] [US2] Add `describe("T-LED-04 findPendingEscalation")` to test/escalations.test.ts:
  - an exact purchase match returns the pending escalation;
  - the payee comparison is case-insensitive;
  - a different amount string ("50000" vs "50001"), payee, session or resourceKey returns undefined;
  - an approved, denied or expired escalation (by entry or by clock) returns undefined.
- [X] T016 [US2] In test/policy.test.ts, rewrite `it("004 in-process each approval pays once: …")` as `it("004/010 in-process re-approve returns the existing approval: one escalation pays once; the next request escalates under a new ID (FR-011)")`:
  - the second `approveCall` returns the same `approvalId` and `expiresAt` with `alreadyApproved: true`, and `approvals(ledger)` has length 1;
  - `d1` is AUTHORIZED with `approvalRef` equal to that `approvalId`;
  - `d2` is ESCALATE with an `authorizationId` that differs from the original escalation's.

  Keep the `sessionBudgetAtomic: "200000"` mandate.
- [X] T017 [US2] Add `describe("010 US2 final states are never left")` to test/policy.test.ts. Cases:
  1. Approve on a denied escalation gives 409 `{ state: "denied", rejectionId }`, and nothing is appended.
  2. Reject on an approved escalation gives 409 `{ state: "approved", approvalId }`, both before and after the approval is used for a payment. Nothing is appended.
  3. A re-approve with a different `ttlSeconds` and `approver` returns the original `expiresAt`, and nothing is appended.
  4. A first approve on a pending escalation returns exactly the keys `ok`, `approvalId` and `expiresAt` (no `alreadyApproved`), byte-compatible with v1.2.
- [X] T018 [US2] Add `describe("010 US2 one pending escalation per purchase")` to test/policy.test.ts:
  1. Two `authz` calls for the same 50000 purchase in one session return the same `authorizationId`. The ledger has one `ESCALATED` and one `ESCALATION_REPEATED` with `data.escalationId`, `resourceKey`, `payTo`, `amount` and `violations`, and its `intentId` equals the second intent's.
  2. A 60000 request for the same resource gives a new `authorizationId` and a new `ESCALATED`.
  3. **Must-fail proof**: with the service option `dedupePendingEscalations: false`, the same two calls produce two `ESCALATED` entries with different IDs. Title it with "(must fail without de-duplication)".
- [X] T019 [US2] Add `it("T-E2E-07 concurrent approve and reject on one pending escalation: exactly one final entry, the other is 409")` to test/e2e.local.test.ts, inside the T-E2E-07 describe. Escalate, then `Promise.all([approve, reject])`. Exactly one of `HUMAN_APPROVAL` or `HUMAN_REJECTION` exists for the ID, one response is 200 and the other is 409.
- [X] T020 [P] [US2] In test/ledger.test.ts, rename `it("excludes an approval whose approvalId is an AUTHORIZED approvalRef; a second approval of the same escalation stays open")` to `it("excludes an approval whose approvalId is an AUTHORIZED approvalRef; two approvals for the same session and resource are each single-use")`. Leave its body unchanged, because the ledger-level semantics are unchanged (research R7).

### Implementation for User Story 2

- [X] T021 [US2] Add `findPendingEscalation(entries, sessionId, resourceKey, payTo, amount, nowMs)` to src/layer2-control/escalations.ts. It returns the most recent `ESCALATED` with a matching `sessionId` and `data.resourceKey`, `String(data.payTo).toLowerCase() === payTo.toLowerCase()`, `data.amount === amount` and `escalationState(...) === "pending"`.
- [X] T022 [US2] Make the approve handler in src/layer2-control/approval-routes.ts state-aware. Keep the existing 401 and 400 behavior. Inside `deps.serialize`, use one `t = deps.now()` and `escalationState`:
  - `not_found` → 404 `{ error: "not found" }`, as today;
  - `denied` → 409 `{ error: "escalation is denied", state: "denied", rejectionId }`;
  - `expired` → 409 `{ error: "escalation is expired", state: "expired", expiresAt }`;
  - `approved` → 200 `{ ok: true, approvalId, expiresAt: ISO(first approval's expiresAtMs), alreadyApproved: true }`, appending nothing and ignoring the request's `ttlSeconds` and `approver`;
  - `pending` → the existing append path and response, unchanged.

  The check and the append stay one synchronous block.
- [X] T023 [US2] In src/layer2-control/service.ts:
  - add the test-only option `dedupePendingEscalations?: boolean` (default `true`) to `ControlServiceDeps`, with a JSDoc "Test hook (010 must-fail proof)";
  - in the `ESCALATE` branch, when it is enabled and `findPendingEscalation(ledger.entries(), sessionId, key, String(chosen.payTo), chosen.amount, t)` returns `p`, append `{ type: "ESCALATION_REPEATED", sessionId, intentId, authorizationId: p.authorizationId, data: { escalationId: p.authorizationId, resourceKey: key, payTo: chosen.payTo, amount: chosen.amount, violations: d.violations } }` and return `{ status: "ESCALATE", authorizationId: p.authorizationId!, intentId, violations: d.violations }`;
  - otherwise keep the existing `ESCALATED` path.

**Checkpoint**: T015–T020 and every pre-existing test are green, apart from the intentionally rewritten test in T016.

---

## Phase 5: User Story 3 - Undecided escalations expire (Priority: P1)

**Goal**:
- A pending escalation becomes `expired` 300 s after creation, through one `ESCALATION_EXPIRED`
  recorded within 5 s, even if nobody calls L2.
- An unused approval past its time-to-live gets one `APPROVAL_LAPSED`.
- After expiry, the same purchase escalates again under a new ID.

**Independent Test**: with a controlled clock, escalate, advance 300 s and sweep. The expiry entry
exists, approve and reject are 409 `expired`, and a new request escalates under a new ID.

### Tests for User Story 3

- [X] T024 [P] [US3] Add `describe("T-LED-04 sweep")` to test/escalations.test.ts:
  1. `sweep(ledger, createdMs + 299_999)` appends nothing.
  2. `sweep(ledger, createdMs + 300_000)` appends exactly one `ESCALATION_EXPIRED` with `data` `{ escalationId, resourceKey, payTo, amount, expiresAtMs: createdMs + 300_000 }` and the escalation's `sessionId` and `authorizationId`. A second sweep appends nothing.
  3. An approval with `expiresAtMs = A` and no consuming `AUTHORIZED` gets exactly one `APPROVAL_LAPSED` at `nowMs = A + 1` and none at `A`. A consumed approval gets none.
  4. A decided escalation (approved or denied) never gets `ESCALATION_EXPIRED`.
  5. **Restart**: write entries, construct a new `AuditLedger(sameFile)`, and sweep at a later `nowMs`. Due escalations are expired, and `verifyChain().ok` is true.
  6. **Must-fail proof (clock, not timer)**: without any sweep, `escalationState` is already `expired` at `createdMs + 300_000`.
- [X] T025 [US3] Add `describe("T-E2E-08 expiry and re-escalation")` to test/e2e.local.test.ts, with its own `startHarness({ controlNow: () => clock })` where `let clock = Date.now()`, and `it("T-E2E-08 expiry: …")`:
  1. `l1(h, "sess_e2e08")` gets `ESCALATED` with ID `A`.
  2. A second fetch while pending returns the same ID `A` (`ESCALATION_REPEATED` in the ledger).
  3. Set `clock += 300_000` and call `await h.sweepEscalations()`. One `ESCALATION_EXPIRED` exists for `A`.
  4. Approve `A` and reject `A` both give 409 `state: "expired"`.
  5. A new fetch gives `ESCALATED` with an ID `B` that differs from `A`, and no `human_rejected` appears.
  6. Approve `B` twice; both return the same `approvalId`. Fetch gives `PAID`, and the payer is debited 50000 exactly once.

### Implementation for User Story 3

- [X] T026 [US3] Add `sweep(ledger: AuditLedger, nowMs: number): LedgerEntry[]` to src/layer2-control/escalations.ts:
  - for every `ESCALATED` whose `escalationState` is `expired` and that has no `ESCALATION_EXPIRED` entry and no decision entry, append `{ type: "ESCALATION_EXPIRED", sessionId, authorizationId: id, data: { escalationId: id, resourceKey, payTo, amount, expiresAtMs } }` at `nowMs`;
  - for every `HUMAN_APPROVAL` with `nowMs > data.expiresAtMs`, no `AUTHORIZED` whose `approvalRef` equals its `approvalId`, and no `APPROVAL_LAPSED` for that `approvalId`, append `{ type: "APPROVAL_LAPSED", sessionId, authorizationId: data.escalationId, data: { approvalId, escalationId, resourceKey, payTo, amount, expiresAtMs } }` at `nowMs`;
  - return the appended entries;
  - it must be idempotent.
- [X] T027 [US3] In src/layer2-control/service.ts:
  - call `sweep(ledger, t)` as the first statement after `const t = now()` in `authorize()`;
  - return `sweep: () => serialize(() => sweep(ledger, now()))` from `createControlService`, extending the `ControlService` interface;
  - in `main()`, after the service is created, call `void sweepNow()` once, then `setInterval(() => void sweepNow(), 1000).unref()`;
  - `createControlService` itself never starts a timer.
- [X] T028 [US3] In src/layer2-control/approval-routes.ts, call `sweep(deps.ledger, t)` at the start of the serialized body of both the approve and reject handlers, before `escalationState`, using the same `t`.
- [X] T029 [US3] In test/helpers/harness.ts, expose `sweepEscalations(): Promise<unknown>` on `Harness`, calling `control.sweep()`, and add it to the `Harness` interface.

**Checkpoint**: T024–T025 are green, and T-E2E-01..06 still pass.

---

## Phase 6: User Story 4 - The operator is notified of every escalation and every outcome (Priority: P1)

**Goal**:
- `npm run escalations` lists the pending escalations.
- `--watch` reports each new escalation and each state change within 5 s, through operator-only
  reads built from the ledger.
- L2 makes no outbound calls.

**Independent Test**: start a watch, then drive escalations to approved, denied and expired. The
watch prints each creation and outcome with the ID, resource, amount and state.

### Tests for User Story 4

- [X] T030 [P] [US4] Add `describe("T-LED-04 operator views")` to test/escalations.test.ts:
  - `pendingEscalations(entries, nowMs)` returns only pending items, sorted by `createdAt` ascending, each with exactly `{ authorizationId, sessionId, resourceKey, payTo, amount, createdAt, expiresAt }`;
  - `escalationEvents(entries, after)` maps `ESCALATED`, `HUMAN_APPROVAL`, `HUMAN_REJECTION`, `ESCALATION_EXPIRED` and `APPROVAL_LAPSED` to the kinds `escalated`, `approved`, `denied`, `expired` and `approval_lapsed`, with the common and per-kind fields from data-model.md;
  - `ESCALATION_REPEATED`, `INTENT`, `AUTHORIZED`, `DENIED` and `SETTLEMENT` produce no event;
  - only `seq > after` is returned, in order;
  - **no event object contains a key named `accepts`, `purpose`, `paymentHeaders`, `signature` or `token`, at any depth (NFR-007).**
- [X] T031 [US4] Add `describe("010 US4 escalation reads")` to test/policy.test.ts:
  1. `GET /v1/escalations` on an empty ledger gives `{ pending: [], cursor: -1 }`.
  2. After one escalation it gives one pending item, and `cursor` equals the last `seq`.
  3. `GET /v1/escalations/events?after=-1` lists `escalated`. After a reject, `?after=<cursor>` lists only `denied`.
  4. `after=abc` and `after=-2` give 400 `{ error: "after must be an integer >= -1" }`.
  5. Both reads give 401 for the control, settlement and verifier tokens and for no token.
- [X] T032 [US4] Add `it("T-E2E-07 watch: events feed reports escalated, denied and approved within one poll")` to test/e2e.local.test.ts. Take `cursor` from `GET /v1/escalations`, then escalate in two sessions, reject one and approve the other. Polling `events?after=cursor` returns exactly `escalated`, `escalated`, `denied` and `approved` for those IDs, with `operator` and `reason` on `denied`.
- [X] T033 [US4] Add `describe("010 US4 escalations CLI (scripts/escalations.ts)")` to test/policy.test.ts, following the `004 US5` spawn pattern (`node_modules/.bin/tsx`, a child env with only `CONTROL_URL`, the operator token, `PATH` and `HOME`):
  1. List mode with none pending prints `no pending escalations` and exits 0.
  2. With one pending, it prints a line matching `^PENDING auth_\S+ session=\S+ resource=\S+ payTo=0x\S+ amount=50000 expiresAt=\S+$` and exits 0.
  3. An unreachable `CONTROL_URL` exits 1.
  4. `--watch` prints `ESCALATED auth_…` within 5 s of a new escalation, then exits 0 on SIGINT.
  5. A static check: the source imports only `../src/shared/*` and contains neither `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `SETTLEMENT_TOKEN` nor `VERIFIER_TOKEN`.

### Implementation for User Story 4

- [X] T034 [US4] Add these to src/layer2-control/escalations.ts:
  - `pendingEscalations(entries, nowMs): EscalationView[]`;
  - `escalationEvents(entries, after): EscalationEvent[]`;
  - the exported types `EscalationView` and `EscalationEvent`, per data-model.md "Derived operator views".

  Events are built field by field from whitelisted fields; never spread `entry.data`. Field mapping:
  - common fields: `seq`, `at = ts`, `kind`, `authorizationId`, `sessionId`, `resourceKey`, `payTo`, `amount`;
  - `escalated`: `expiresAt`;
  - `approved`: `approvalId`, `approver`, `approvalExpiresAt`;
  - `denied`: `rejectionId`, `operator`, `reason?`;
  - `expired`: `expiresAt`;
  - `approval_lapsed`: `approvalId`.
- [X] T035 [US4] Create src/layer2-control/escalation-routes.ts. Export `mountEscalationRoutes(app, deps: { ledger, serialize, now, tokens?: { operator?: string } })`, with:
  - `GET /v1/escalations`: `requireRole("operator")`; inside `serialize` it runs `sweep(ledger, t)`, then returns `{ pending: pendingEscalations(entries, t), cursor: entries.length - 1 }`;
  - `GET /v1/escalations/events`: `requireRole("operator")`; it parses `after` (default -1; an integer ≥ -1, otherwise 400 `{ error: "after must be an integer >= -1" }`); inside `serialize` it runs `sweep`, then returns `{ events: escalationEvents(entries, after), cursor: entries.length - 1 }`.

  Header comment: "SPEC L2-5 (010): operator-only, loopback (via listenControl), built from the ledger; no outbound calls".
- [X] T036 [US4] Mount `mountEscalationRoutes` in src/layer2-control/service.ts next to `mountApprovalRoutes`, passing `ledger`, `serialize`, `now` and the operator token hook.
- [X] T037 [US4] Create scripts/escalations.ts per contracts/operator-cli.md:
  - `loadEnv("operator")`; use `serviceUrls(env).control` and `tokenFor("operator", env)`;
  - list mode prints a `PENDING …` line per item, or `no pending escalations`, and exits 0, or 1 with `escalations: …` on stderr after an HTTP or network error;
  - `--watch` prints the list, then polls `events?after=<cursor>` every 1000 ms and prints `<KIND upper-case> <authorizationId> session=… resource=… amount=…` plus the per-kind fields (`reason` quoted);
  - while watching, an error prints `escalations: <msg> (retrying)` once per failure streak and keeps polling;
  - SIGINT and SIGTERM exit 0;
  - import only `../src/shared/config.js`, mirroring scripts/approve.ts.

**Checkpoint**: T030–T033 are green, and a manual `npm run escalations -- --watch` shows events live.

---

## Phase 7: User Story 5 - Only the operator can decide (Priority: P1)

**Goal**: reject, and the escalation reads, accept only the operator token. The agent has no way to
decide, and the routes are loopback-only.

**Independent Test**: call reject with the control, settlement and verifier tokens and with no token.
Each is 401 and the ledger length is unchanged.

### Tests for User Story 5

- [X] T038 [US5] Add `describe("010 US5 only the operator can reject (SEC-8, INV-13)")` to test/policy.test.ts. For `TOKENS.control`, `TOKENS.settlement`, `"t-verifier"` and `null`, `rejectCall` with an invalid body (`{ reason: 5 }`) gives 401 `{ error: "unauthorized" }`. 401 precedes the 400 body validation, the ledger length is unchanged, and there is no `HUMAN_REJECTION`.
- [X] T039 [P] [US5] Add `it("010 US5 L1 never references operator routes or the operator token")` to test/architecture.test.ts. No file under `src/layer1-intent/` and neither `src/main.ts` contains `/v1/rejections`, `/v1/approvals`, `/v1/escalations` or `OPERATOR_TOKEN`. The existing T-AGT-01 tool-set test stays unchanged and still passes.

### Implementation for User Story 5

- [X] T040 [US5] Check that the guards in src/layer2-control/approval-routes.ts (from T014) and src/layer2-control/escalation-routes.ts (from T035) are registered before `express.json()` or any query parsing, and that L2 binds only through `listenControl` in src/layer2-control/service.ts. Fix the ordering if T038 fails. No new code is expected.

**Checkpoint**: T038–T039 are green.

---

## Phase 8: User Story 6 - Operator rejects from a command-line tool (Priority: P2)

**Goal**: `npm run reject -- <authorizationId> [operator] [reason…]` behaves like `npm run approve`.

**Independent Test**: run the command against a pending escalation. It exits 0 and prints the JSON
with `rejectionId`. A repeat gives `alreadyRejected: true`, an unknown ID exits 1, and no arguments
exits 2.

### Tests for User Story 6

- [X] T041 [US6] Add `describe("010 US6 operator reject CLI (scripts/reject.ts)")` to test/policy.test.ts, using the `004 US5` spawn pattern:
  1. `reject <id> alice too expensive` exits 0. stdout JSON has `rejectionId` matching `^rej_` and `alreadyRejected: false`, and the ledger entry has `operator: "alice"` and `reason: "too expensive"`.
  2. The same command again exits 0 with `alreadyRejected: true`.
  3. An unknown ID exits 1, and stderr matches `^reject: HTTP 404`.
  4. No arguments exits 2 with `usage: npm run reject -- <authorizationId> [operator] [reason]`.
  5. An unreachable `CONTROL_URL` exits 1 with `reject: control service unreachable at`.
  6. A static check: imports only `../src/shared/*`, with no `PAYER_PRIVATE_KEY` or any other role's token.

### Implementation for User Story 6

- [X] T042 [US6] Create scripts/reject.ts, mirroring scripts/approve.ts:
  - export `async function reject(argv, env = process.env): Promise<number>`;
  - `[authorizationId, operator, ...reasonParts] = argv`; `reason = reasonParts.join(" ")`, omitted when empty;
  - POST `${serviceUrls(env).control}/v1/rejections/${encodeURIComponent(id)}` with `{ operator?, reason? }` and `Bearer ${tokenFor("operator", env)}`;
  - exit codes 0, 1 and 2 with the messages from contracts/operator-cli.md;
  - the entry guard calls `loadEnv("operator")`.

**Checkpoint**: T041 is green. Every user story is complete.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: the SPEC, governance and docs sync required in the same change, then the final
validation.

- [X] T043 Update SPEC.md to v1.3, per contracts/ledger-lifecycle.md, control-api.md, policy-r15.md and operator-cli.md:
  - the version line and a new "Changes in 1.3" table;
  - L2-2: `humanRejected?` in the `ctx` inputs, and an R15 row after R13 with a note that evaluation follows table order;
  - L2-4: four new table rows, and the INTENT outcome note;
  - L2-4.2: the "approved several times" sentence replaced;
  - a new L2-4.3 section;
  - L2-5: rows for `POST /v1/rejections/:authorizationId`, `GET /v1/escalations` and `GET /v1/escalations/events`, and the approve row amended (idempotent re-approve; 409 on denied or expired; "Each call creates a new approval" removed);
  - the INV-12 note;
  - §11: SEC-8 tests plus T-E2E-07, and a new row "SEC-12 | Operator free text (label, reason) reaches the LLM agent | R15 detail carries only the rejectionId | T-POL-15";
  - §12: rows T-POL-15, T-LED-04, T-E2E-07 and T-E2E-08;
  - §13: `npm run reject -- <authorizationId> [operator] [reason]` and `npm run escalations [-- --watch]`;
  - §6 layout: escalations.ts, escalation-routes.ts, scripts/reject.ts, scripts/escalations.ts and test/escalations.test.ts.
- [X] T044 [P] Update .specify/memory/constitution.md to 1.1.1 (PATCH):
  - Principle I bullet: "The agent MUST NEVER be given a tool that signs, approves, rejects or edits policy.";
  - a new Sync Impact Report at the top (1.1.0 → 1.1.1; reason 010; templates unaffected);
  - Last Amended 2026-10-18.
- [X] T045 [P] Update specs/004-human-approval-escalation/spec.md. Add "Amended by 010" notes to:
  - the Assumption "There is no explicit reject operation…";
  - the edge cases "Several approvals for the same escalation" and "Re-approving an escalation" (now idempotent: one approval per escalation);
  - FR-006 and FR-007 (approve is state-aware).
- [X] T046 [P] Add a SEC-12 row and a "Residual risks added in 010" note to specs/007-process-isolation-security/contracts/threat-matrix.md ("operator label is self-declared; escalation reads expose session IDs to the operator"). In test/architecture.test.ts, make T-ARCH-TRACE cover SEC-1..SEC-12 (`SEC_ROWS` length 12).
- [X] T047 [P] Update specs/README.md:
  - add a 010 row ("L2 + operator | L2-2 R15, L2-4 types, L2-4.2, L2-4.3, L2-5, §13 | In SPEC v1.3");
  - add traceability rows for R15, L2-4.3, SEC-12, T-POL-15, T-LED-04, T-E2E-07 and T-E2E-08;
  - amend the L2-4.2 and L2-5 rows to name 010.
- [X] T048 [P] Update README.md and CLAUDE.md:
  - **README.md**:
    - in "Human approval", describe reject (`npm run reject -- <id> [operator] [reason]`), the 5-minute expiry and `npm run escalations -- --watch`, and state that an escalation ends approved, denied or expired, is never reversed and pays at most once;
    - in "Approving an escalated payment", add the reject alternative and the watch command;
    - in the Tests table, add test/escalations.test.ts.
  - **CLAUDE.md**:
    - in Commands, add `npm run reject` and `npm run escalations -- --watch`;
    - in "What this repo is", change the L2 line to "HITL approvals and rejections".
- [X] T049 Run quickstart.md §1 (offline gates): `npm run typecheck`, then the targeted `npx vitest run` commands for T-POL-15, T-LED-04, T-E2E-07, T-E2E-08 and the architecture tests, then `npm run check`. Confirm `spent on-chain: 0.006 USDC`, `hash chain ok=true` and the outcomes `FREE, PAID, PAID, ESCALATED, DENIED, DENIED`. Note in this file's Implementation Notes how many `ESCALATION_EXPIRED` entries the first start appended to `.local/ledger-local.jsonl`, as expected by research R10.
- [ ] T050 Manual, operator-only: run quickstart.md §2–§4 on Base Sepolia (reject flow, expiry and repeat, audit check). Record the results in this file's Implementation Notes. This does not block merge, because offline coverage is complete.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none. T001–T003 are parallel.
- **Foundational (Phase 2)**: depends on T002. It blocks every story.
- **US1 (Phase 3)**: depends on Phase 2. This is the MVP.
- **US2 (Phase 4)**: depends on Phase 2. T022 and T023 build on the same files US1 touches (approval-routes.ts, service.ts), so run them after T014 and T012.
- **US3 (Phase 5)**: depends on Phase 2 and T014 (T028 edits both handlers). T029 depends on T027.
- **US4 (Phase 6)**: depends on Phase 2 and T026, because the routes call `sweep`.
- **US5 (Phase 7)**: depends on T014 and T035.
- **US6 (Phase 8)**: depends on T014. The command can be written in parallel with US2–US4, since it is a separate file.
- **Polish (Phase 9)**: depends on every story. T044–T048 are parallel. T049 comes after them, then T050.

### Within each story

Tests first (they fail), then the escalations.ts functions, then policy and service, then routes, then
commands. Tasks on the same file are sequential, in task-ID order. The shared files are
escalations.ts, approval-routes.ts, service.ts, policy.test.ts, escalations.test.ts and
e2e.local.test.ts.

### Story completion order

```text
Setup → Foundational → US1 (MVP) → US2 → US3 → US4 → US5 → US6 → Polish
                         └── US6 command (T042) can start right after T014
```

## Parallel Examples

```text
# Phase 1
T001 package.json  |  T002 ledger.ts EntryType  |  T003 harness controlNow

# US1 tests, before implementation
T006 test/policy.test.ts (T-POL-15)  |  T007 test/escalations.test.ts (findRejection)

# US2: separate files
T015 test/escalations.test.ts  |  T020 test/ledger.test.ts rename

# US3 / US4 unit tests (same file, but each is its own describe; run sequentially when one agent edits)
T024 → T030 in test/escalations.test.ts

# Cross-story, after T014
T042 scripts/reject.ts  |  T037 scripts/escalations.ts  (different files, no shared state)

# Polish
T044 constitution | T045 specs/004 | T046 threat matrix + architecture test | T047 specs/README | T048 README + CLAUDE.md
```

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1, then Phase 2.
2. Phase 3 (US1): reject, the R15 rule and the in-process and e2e reject tests.
3. **Stop and validate**: `npx vitest run test/policy.test.ts test/escalations.test.ts test/e2e.local.test.ts -t "T-POL-15|T-LED-04|010 US1|T-E2E-07"`, then `npm test`. The operator can now say no.

### Incremental delivery

1. US2: final states, idempotent decisions, one escalation per purchase.
2. US3: expiry and lapse through the sweep. Run the T-E2E-08 check at this point.
3. US4: watch and notification. Run a manual watch here.
4. US5: hardening tests for role separation.
5. US6: the reject command.
6. Polish: SPEC v1.3 and governance docs, then `npm run check`.

### Notes

- Never weaken an invariant or the demo baseline to make a test pass (Constitution VIII). If the
  observed behavior differs from a contract, update the contract and spec.md in the same change.
- Commit after each phase checkpoint, citing requirement IDs (FR-0xx, R15, L2-4.3, SEC-12, T-…). The
  worktree is currently detached, so create a branch first (for example
  `git switch -c devsoftx/010-operator-reject-flow`).
- `createControlService` must never start a timer. Only `main()` does, using `unref()`, so tests and
  the harness stay deterministic.

## Implementation Notes (2026-10-18, `/speckit-implement`)

Places where the work differs from the task text, and the validation results.

- **A third existing test changed (T022)**: `004 US2 … edge cases: another session escalates; an expired approval escalates; a different query string matches` re-approved the original escalation after its first approval lapsed. Under FR-011 that now returns the lapsed approval. The test keeps its purpose (a different query string matches) by approving the new escalation that the expired request created. This is the same intended change as T016; NFR-008 named only two tests.
- **T039 (L1 reference check)**: comments are stripped before searching, as for rule A8, because `src/layer1-intent/ports-http.ts` has a comment documenting that no `/v1/approvals` adapter exists.
- **T041/T042**: the reject command's tests and the command were written in the same step, so the tests were not observed failing first. Every other story's tests were run red before implementation.
- **T026/T034 (performance)**: `sweep` and `pendingEscalations` build the set of decided escalations in one pass (`decidedIds`), so the 1 s sweep and the 1 s watch poll stay linear in the ledger size. `escalationState` (per ID) is unchanged.
- **T049 results**:
  - `npm run check` passes: typecheck clean, 15 test files and 346 tests (up from 316 before this feature), and the demo summary `FREE, PAID, PAID, ESCALATED, DENIED, DENIED`, `spent on-chain: 0.006 USDC`, `hash chain ok=true`.
  - As research R10 expected, starting L2 on the existing `.local/ledger-local.jsonl` (inside the `demo.local` test) appended `ESCALATION_EXPIRED` for the old pending escalations: 16 entries before the final check.
  - `.local/ledger-base-sepolia.jsonl` is unchanged until the next L2 start on Base Sepolia.
- **T050**: still open. The manual Base Sepolia run needs the operator's go-ahead, because it spends test USDC and calls CDP. The offline coverage (T-E2E-07, T-E2E-08) does not depend on it.
