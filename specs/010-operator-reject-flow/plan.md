# Implementation Plan: Escalation Lifecycle: Operator Rejection, Expiry and Notification

**Branch**: `010-operator-reject-flow` | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-operator-reject-flow/spec.md`, with clarifications
from session 2026-10-18.

## Summary

Every escalation gets a lifecycle that L2 derives from the ledger. It starts pending and ends exactly
once, as approved, denied or expired. Nothing is reversed.

- **Reject.** The operator rejects a pending escalation through a new operator-only, loopback-only
  route, `POST /v1/rejections/:authorizationId`, or with `npm run reject`. The rejection is a new
  append-only ledger entry. A new DENY rule, R15 `human_rejected`, then refuses that session and
  resource for good. Its violation detail carries only the rejection ID and never operator free
  text.
- **Expire.** Escalations still pending 300 s after creation expire through a sweep. The sweep runs
  before every serialized L2 operation and every 1 s from `main()`.
- **Approve once.** Approve becomes state-aware: idempotent on an approved escalation and 409 on a
  denied or expired one. An escalation therefore pays at most once.
- **Repeat requests.** While an escalation is pending, a repeat of the same purchase returns the
  same authorization ID.
- **Notify.** The operator follows everything through `npm run escalations -- --watch`. It polls two
  operator-only reads built from the ledger, and L2 makes no outbound connection.

The cross-layer contract (`src/shared/contracts.ts`) is unchanged.

## Technical Context

**Language/Version**: TypeScript (strict), ESM, Node.js ≥ 22 (development on Node 26)

**Primary Dependencies**: express (L2 routes), vitest (tests), tsx (scripts). No new dependency.

**Storage**: the existing hash-chained JSONL ledger, `.local/ledger-<network>.jsonl`, with four new
entry types

**Testing**:
- vitest unit tests for the policy and the lifecycle derivation;
- in-process L2 HTTP tests (the `startService` pattern in `test/policy.test.ts`);
- harness e2e tests (`test/helpers/harness.ts`, with a new `controlNow` clock hook);
- the spawned-CLI test pattern (`004 US5`).

**Target Platform**: local multi-process PoC on loopback; `local` and `base-sepolia` networks

**Project Type**: a multi-process service with a three-layer split (L1/L2/L3) plus operator commands

**Performance Goals**:
- an expiry is recorded within 5 s of the 300 s window ending (FR-017);
- a watcher reports events within 5 s (FR-021);
- the design target is about 2 s (a 1 s sweep plus a 1 s poll).

**Constraints**:
- L2 stays loopback-only and makes no outbound connections;
- the policy stays pure;
- the ledger stays append-only;
- the `demo:local` baseline is unchanged;
- no change to the `AuthorizationDecision` contract.

**Scale/Scope**: one operator; tens of escalations per session. A linear scan of the ledger per
operation, as today, is sufficient.

No item is NEEDS CLARIFICATION. [research.md](research.md) records each design decision (R1–R13).

## Constitution Check

*GATE: must pass before Phase 0 research, and again after Phase 1 design.*

| Principle | Check | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of payment authority | New code lives in `src/layer2-control/` (routes, sweep) and `scripts/` (commands that import only `src/shared`). L1 gains no tool. Reject is operator-only. | PASS | PASS. Constitution PATCH 1.1.1 makes "no agent tool that … rejects" explicit (R13). |
| II. Deterministic, pure policy | R15 reads only `ctx.humanRejected`, computed by `service.ts` from the ledger. No clock or I/O in the policy. Operator text is never an input (R5). The serialized check → append sequence is kept for approve, reject and sweep (R9). INV-12 holds, because R15 is a DENY that no approval lifts. | PASS | PASS |
| III. Ledger is the single source of truth | Every state is derived from entries plus the decision time. Expiry, lapse, rejection and repeat are new entry types, with no mutation. Startup chain verification is unchanged. | PASS | PASS (R2, R10) |
| IV. Trust the chain | No change to L3 or to settlement. | PASS | PASS |
| V. Least-privilege credentials | The new routes require `OPERATOR_TOKEN` before the body is parsed. No new secret. Loopback only. No outbound connection from L2 (R3). | PASS | PASS |
| VI. Exact money arithmetic | Amounts are copied as strings and compared exactly; no arithmetic is added. | PASS | PASS |
| VII. Protocol fidelity | No change to x402 header handling. | PASS | PASS |
| VIII. Proven safety | New rule R15 has T-POL-15, including the must-fail control. Lifecycle: T-LED-04. End to end: T-E2E-07 and T-E2E-08. Must-fail proofs are listed under "Proofs" below. | PASS | PASS |
| Quality gates | typecheck, the full suite, an unchanged demo summary, SPEC updated in the same change (v1.3), requirement IDs in test names. | PASS | PASS |

No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/010-operator-reject-flow/
├── spec.md
├── plan.md               # this file
├── research.md           # Phase 0: R1–R13
├── data-model.md         # Phase 1: entries, state machine, derived views
├── quickstart.md         # Phase 1: validation guide
├── contracts/
│   ├── control-api.md        # L2-5 delta: reject, approve (amended), escalation reads
│   ├── policy-r15.md         # L2-2 delta: R15 human_rejected
│   ├── operator-cli.md       # §13 delta: reject and escalations commands
│   └── ledger-lifecycle.md   # L2-4 / L2-4.2 / new L2-4.3 text
├── checklists/requirements.md
└── tasks.md              # Phase 2 (/speckit-tasks)
```

### Source code (repository root)

```text
src/layer2-control/
├── escalations.ts        # NEW: constants, escalationState, findPendingEscalation, findRejection,
│                         #      pendingEscalations, escalationEvents, sweep(ledger, nowMs)
├── escalation-routes.ts  # NEW: GET /v1/escalations, GET /v1/escalations/events (operator)
├── approval-routes.ts    # MOD: state-aware approve; NEW POST /v1/rejections/:authorizationId
├── ledger.ts             # MOD: EntryType gains HUMAN_REJECTION, ESCALATION_EXPIRED, APPROVAL_LAPSED,
│                         #      ESCALATION_REPEATED (no other change)
├── policy.ts             # MOD: PolicyContext.humanRejected; R15 after R13
└── service.ts            # MOD: sweep before each serialized op; ctx.humanRejected; repeat → ESCALATION_REPEATED;
                          #      mount escalation routes; return { app, serialize, sweep }; main() 1 s unref'd sweep timer
scripts/
├── reject.ts             # NEW: npm run reject (mirrors approve.ts)
└── escalations.ts        # NEW: npm run escalations [-- --watch]
package.json              # MOD: "reject", "escalations" scripts
test/
├── policy.test.ts        # MOD: T-POL-15; 004 "each approval pays once" rewritten; 010 in-process reject/approve/watch; CLI tests
├── escalations.test.ts   # NEW: T-LED-04 lifecycle, sweep, restart, events, repeat
├── ledger.test.ts        # MOD: rename the "second approval of the same escalation" test (semantics unchanged)
├── e2e.local.test.ts     # MOD: T-E2E-07 (reject + watch), T-E2E-08 (expiry + repeat + re-escalate)
├── architecture.test.ts  # MOD: SEC rows 1..12 for T-ARCH-TRACE
└── helpers/harness.ts    # MOD: controlNow option; expose sweepEscalations()
SPEC.md                   # v1.3 (see "SPEC and governance changes")
.specify/memory/constitution.md   # 1.1.0 → 1.1.1 (PATCH)
specs/004-human-approval-escalation/spec.md       # "Amended by 010" notes
specs/007-process-isolation-security/contracts/threat-matrix.md   # SEC-12
specs/README.md, README.md, CLAUDE.md             # index row; operator commands; L2 summary line
```

**Structure decision**: keep the existing single-repository, three-layer layout. All runtime logic
stays inside `src/layer2-control/`, so architecture rule A1 holds. Operator tooling stays in
`scripts/`, importing only `src/shared/*`, exactly like `scripts/approve.ts`.

## Design

### Authorize path (`service.ts`, inside `serialize`)

1. `t = now()`, then `sweep(t)` (appends any due `ESCALATION_EXPIRED` and `APPROVAL_LAPSED`).
2. `INTENT` (unchanged).
3. `findOpenApproval` (unchanged), and `findRejection(sessionId, key)`, which gives
   `ctx.humanRejected`.
4. `decide()`. R15 is collected with the other DENY rules.
5. `ESCALATE`: if `findPendingEscalation(sessionId, key, chosen.payTo, chosen.amount, t)` finds one,
   append `ESCALATION_REPEATED` and return `ESCALATE` with that `authorizationId`. Otherwise append
   `ESCALATED` (unchanged).
6. `DENIED` and `AUTHORIZED` are unchanged.

### Operator routes

Each runs inside `serialize`: `sweep(t)`, then a synchronous check followed by the append.

- **Approve**: state-aware, per the [control-api](contracts/control-api.md) contract.
- **Reject**: new.
- **Escalation reads**: built from `ledger.entries()` with the pure functions in `escalations.ts`.
  They read nothing else.

### Sweep timer

`main()` starts `setInterval(() => void serialize(() => sweep(Date.now())), 1000).unref()`.
`createControlService` never starts a timer; it returns `sweep` for tests and the harness.

### Operator commands

[operator-cli](contracts/operator-cli.md) defines both. `escalations --watch` keeps a cursor, so it
resumes after a restart of L2.

## Requirement traceability

| Requirement | Design element | Test |
|---|---|---|
| FR-001–FR-004 (lifecycle, final, state-aware actions, ledger-derived) | `escalationState`; approve and reject state checks | T-LED-04; T-E2E-07; T-E2E-08 |
| FR-005 (one pending per purchase) | `findPendingEscalation`; `ESCALATION_REPEATED` | T-LED-04; T-E2E-08 (must-fail: without it, a second `ESCALATED`) |
| FR-006–FR-010 (reject op, entry, response, 404, idempotent) | `POST /v1/rejections/:id` | 010 in-process reject tests; T-E2E-07 |
| FR-011 (approve idempotent, one payment) | state-aware approve | the rewritten "each approval pays once" test; T-E2E-08 |
| FR-012–FR-015 (R15, collection, pure context, agent surfaces it) | `policy.ts` R15; `service.ts` context; L1 unchanged | T-POL-15; T-E2E-07 (agent outcome `DENIED rules=human_rejected`) |
| FR-016–FR-018 (300 s expiry, timely, no restriction after expiry) | `sweep`; `main()` timer; state derivation | T-LED-04 (boundary at exactly 300 000 ms; restart); T-E2E-08 |
| FR-019–FR-021 (notify, watch only, list then events within 5 s) | escalation routes; event kinds | T-LED-04 (events feed); T-E2E-07 (watch sees each event); CLI watch test |
| FR-022–FR-023 (reject and escalations commands) | `scripts/reject.ts`, `scripts/escalations.ts` | 010 CLI tests (exit codes, static import and token check) |
| NFR-001, NFR-005 (operator-only, loopback, no outbound) | `requireRole("operator")` before parsing; `listenControl` | 010 in-process 401 matrix; T-ARCH-BIND unchanged |
| NFR-002 (monotonic) | R15 is a DENY; expiry restricts nothing | T-POL-15; T-E2E-08 |
| NFR-003 (serialized) | everything inside `serialize`, synchronous check then append | T-E2E-07 (concurrent approve and reject: exactly one final entry) |
| NFR-004, SC-009 (audit trail) | entries link `escalationId` and `intentId` | T-E2E-07 and T-E2E-08 assert the full entry sequence |
| NFR-006 (untrusted text) | length limits; detail carries only the ID | T-POL-15 detail check; 400 tests |
| NFR-007 (notification safety) | event projection whitelist | T-LED-04: events contain no `accepts`, `purpose`, token or header keys |
| NFR-008, SC-008 (regression) | demo unchanged; three intended 004 changes | `npm run check`; rewritten 004 tests |
| NFR-009 (proven safety) | R15 control case | T-POL-15 "without humanRejected → ESCALATE" |

## Proofs (Constitution VIII)

- **R15**: the same request is `ESCALATE` without `ctx.humanRejected` and `DENIED human_rejected`
  with it (T-POL-15).
- **Repeat de-duplication**: a test-only service option, `dedupePendingEscalations: false` (default
  true), restores v1.2 behavior and shows a second `ESCALATED` appears (T-E2E-08). This follows the
  existing test-only switch pattern (`verifyFailedClaims`).
- **Expiry**: with the sweep never called and the clock past 300 s, the state is still derived as
  `expired` and approve is refused. With the sweep, the `ESCALATION_EXPIRED` entry exists. This
  shows that the clock check, not the timer, is what makes expiry safe (T-LED-04).
- **Serialization**: not claimed separately. On single-threaded Node, a synchronous check-then-append
  cannot be shown to fail without the mutex; T-E2E-04 already proves the mutex (research R9).

## SPEC and governance changes (same change)

- **SPEC.md v1.3**:
  - a "Changes in 1.3" table;
  - L2-2: the context lists `humanRejected?`, and R15 is added;
  - L2-4: the four entry types are added, and the INTENT outcome note is amended;
  - L2-4.2: the sentence is replaced;
  - new L2-4.3;
  - L2-5: the reject and escalation-read rows are added, and the approve row is amended;
  - INV-12: the note is added;
  - §11: SEC-8 lists T-E2E-07, and SEC-12 is new ("operator free text reaches the agent: control,
    the R15 detail carries only the ID; test T-POL-15");
  - §12: T-POL-15, T-LED-04, T-E2E-07 and T-E2E-08 are added;
  - §13: `npm run reject` and `npm run escalations` are added.
- **Constitution 1.1.1 (PATCH)**: Principle I's bullet becomes "signs, approves, rejects or edits
  policy". A Sync Impact Report is recorded.
- **Feature specs**: 004 gets "Amended by 010" notes on its Assumptions and its two re-approval edge
  cases; the threat matrix in 007 gains SEC-12; `specs/README.md` gains the 010 row and the
  traceability rows.
- **Docs**: the README human-approval section gains reject, expiry and watch, and `CLAUDE.md` gains
  the new commands.

## Risks

| Risk | Mitigation |
|---|---|
| Old pending escalations in existing ledgers are expired on the first start (R10) | Intended. The baseline does not check the entry count, and each run uses a new session. |
| The sweep timer keeps the process alive, or leaks into tests | `unref()`; tests never call `main()`; `createControlService` starts no timer. |
| The linear ledger scan grows with ledger size | The same as the existing derivations; PoC scale. An index is a later optimization. |
| A watcher misses events during an L2 restart | The cursor is a ledger `seq`, so polling resumes exactly; NFR-007. |
| Clock skew between the operator machine and L2 | Every time is L2's clock. The command prints L2 timestamps and never compares local time. |

## Complexity Tracking

No Constitution Check violations.
