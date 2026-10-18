# Research: Escalation Lifecycle (Operator Rejection, Expiry and Notification)

Phase 0 for `specs/010-operator-reject-flow`. Every decision below is grounded in the current L2 code
(`src/layer2-control/{service,ledger,policy,approval-routes,ledger-routes}.ts`), SPEC.md v1.2 and the
clarified spec. The Technical Context has no open NEEDS CLARIFICATION items; this file records how
each design question was settled.

## R1. How does an escalation expire on time?

- **Decision**: A `sweep(nowMs)` step appends the due expiry and lapse entries. It runs at the start
  of every serialized L2 operation: authorize, approve, reject and the escalation reads. `main()` also
  runs it every 1 s on a timer, using `unref()` so the timer never keeps the process alive. Deriving
  the state also treats `nowMs ≥ createdMs + 300 000` as expired even before the entry is written, so
  no decision can act on a stale "pending" state.
- **Rationale**:
  - FR-017 requires expiry within 5 s of the window ending, even if nobody calls L2, and that needs
    a timer.
  - Running the sweep before each operation makes every decision see the correct state without
    depending on timer timing.
  - The ledger and policy stay clock-free (methods take `nowMs`), and tests drive `sweep()` with a
    fake clock and never start a timer.
- **Alternatives considered**:
  - One `setTimeout` per escalation: it is lost on restart and needs one timer per escalation.
  - Lazy expiry only: an escalation nobody asks about would never be recorded or reported, which
    fails FR-017 and SC-001.
  - An external cron: adds a process and a credential.

## R2. How are expiry and approval lapse recorded?

- **Decision**: Two new append-only entry types, `ESCALATION_EXPIRED` and `APPROVAL_LAPSED`. Each
  holds the nominal deadline (`expiresAtMs`), and the entry's own `ts` records when it was written. A
  restart sweeps everything that came due while L2 was down.
- **Rationale**:
  - Rule 6 and INV-9 say new facts are new entry types.
  - Recording the event gives the audit trail an explicit final state (NFR-004).
  - It gives the notification feed a ledger position to point at (R3).
  - Approval openness is still decided from `expiresAtMs`, so `APPROVAL_LAPSED` is informational and
    cannot change a decision.
- **Alternatives considered**:
  - Deriving the events only when they are read: a ledger-position cursor cannot represent an event
    that has no entry, and the audit trail would have no record of it.
  - Mutating the escalation entry: forbidden, because the ledger is append-only.

## R3. How does the operator get notified (pull-based)?

- **Decision**: Two operator-only, loopback-only reads:
  - `GET /v1/escalations` returns the pending escalations and a `cursor`, which is the last ledger
    `seq`.
  - `GET /v1/escalations/events?after=<seq>` returns the lifecycle events newer than the cursor.

  `npm run escalations -- --watch` lists pending escalations once, then polls events every 1 s.
- **Rationale**:
  - A 1 s poll meets the 5 s requirement (FR-021) with margin.
  - The server stays stateless: a disconnect or restart loses nothing, because the watcher resumes
    from its cursor (NFR-007).
  - It needs no new dependency.
  - It is trivially testable with `fetch`.
  - L2 makes no outbound connection (FR-020).
- **Alternatives considered**:
  - Server-sent events: long-lived connections, and tests and timeouts are harder to manage.
  - WebSocket: needs a new dependency.
  - Long-polling: more server state for no gain at this volume.
  - Webhook: an outbound call and a new secret in the process that holds the payer key; the
    clarification ruled it out.

## R4. What does a repeat request return while an escalation is pending?

- **Decision**:
  - A purchase is the same session, resource key, lower-cased payee and exact amount string.
  - When the policy decides ESCALATE and a pending escalation exists for that purchase, L2 appends
    `ESCALATION_REPEATED` with `{ escalationId, resourceKey, payTo, amount, violations }` and the
    request's `intentId`. It returns `ESCALATE` with the pending escalation's `authorizationId`.
  - No `ESCALATED` entry is written, so there is no notification.
- **Rationale**:
  - Every `INTENT` keeps exactly one outcome entry, so the audit trail stays complete (NFR-004).
  - "One `ESCALATED` per escalation" stays true, so creation time and expiry stay unambiguous.
  - The cross-layer contract is unchanged: L1 already receives `authorizationId` on ESCALATE.
- **Alternatives considered**:
  - Recording only the `INTENT`: an intent with no outcome looks like a crash in the middle of
    authorize.
  - Re-appending `ESCALATED` with the same ID: two creation times for one escalation, and every
    lookup must de-duplicate.

## R5. Where does the rejection take effect, and what does the agent see?

- **Decision**:
  - A new DENY rule, R15 `human_rejected`, in `evaluateRequirement`. It is collected with R1–R13
    before the DENIED return, so it always takes precedence over R14 and any approval.
  - Its input is a new context field, `PolicyContext.humanRejected?: { rejectionId }`.
    `service.ts` computes it from the ledger as the most recent `HUMAN_REJECTION` for the request's
    session and resource key, whatever the amount or payee.
  - The violation detail is `rejected by the operator (<rejectionId>)`. It never contains the
    operator label or the reason.
- **Rationale**:
  - The policy stays pure, and the decision only reads that a rejection exists (INV-5, rule 3).
  - Collecting it with the other DENY rules keeps one evaluation path (FR-013) and precedence over
    approvals (INV-12).
  - The violation detail reaches the LLM agent, so operator free text in it would be a
    prompt-injection path from an operator channel into L1. That is SEC-12, newly added.
- **Alternatives considered**:
  - Checking in `service.ts` before `decide()`: this bypasses rule collection, and the other
    violations would not be listed.
  - Including the reason in the detail: an injection risk, and the agent has no use for it.
  - Renumbering the rules: R15 keeps R1–R14 stable for every existing test and document. The SPEC
    table lists R15 after R13 because evaluation order follows the table.

## R6. What does the reject operation look like?

- **Decision**: `POST /v1/rejections/:authorizationId` with the operator token and body
  `{ operator? = "operator", reason? }`. The checks run in this order:
  1. 401 before the body is parsed.
  2. 400 when `operator` is not a 1–64 character string or `reason` is not a string of at most 280
     characters.
  3. 404 when no `ESCALATED` entry exists for the ID.
  4. 409 when the escalation is approved or expired.
  5. 200 `{ ok, rejectionId, rejectedAt, alreadyRejected }`. A repeated reject returns the first
     rejection with `alreadyRejected: true` and appends nothing.
- **Rationale**: It mirrors the existing `POST /v1/approvals/:authorizationId` in role, ordering and
  shape. A separate resource name keeps the approve contract stable for existing callers.
- **Alternatives considered**:
  - `POST /v1/approvals/:id` with a `decision` field: changes the approve contract and mixes two
    actions.
  - `DELETE /v1/approvals/:id`: implies removal, and nothing is ever removed.

## R7. How does approve change?

- **Decision**: Approve becomes state-aware. All checks run in one synchronous block inside the
  serialized section:
  - **Pending**: as today; one `HUMAN_APPROVAL` is appended.
  - **Approved**: 200 with the existing approval's `approvalId` and `expiresAt`, plus
    `alreadyApproved: true`. Nothing is appended. A new `ttlSeconds` or `approver` in the request is
    ignored.
  - **Denied or expired**: 409.

  So each escalation has at most one `HUMAN_APPROVAL` and pays at most once.
- **Rationale**: This follows clarification Q5. It is symmetric with a repeated reject (FR-010,
  FR-011). The SPEC L2-4.2 sentence "if one escalation is approved several times, each approval pays
  once" is replaced, and the test "each approval pays once" is rewritten.
- **Alternatives considered**: 409 on re-approve (clarification option A), or keeping several
  approvals per escalation (option C). The user chose B.

## R8. Where does the lifecycle logic live?

- **Decision**:
  - A new module, `src/layer2-control/escalations.ts`, holds the pure derivations over ledger
    entries: `escalationState`, `findPendingEscalation`, `findRejection`, `pendingEscalations` and
    `escalationEvents`. It also holds `sweep(ledger, nowMs)`, the only part that writes, and the
    constants `ESCALATION_TTL_MS = 300_000`, `REASON_MAX = 280` and `OPERATOR_LABEL_MAX = 64`.
  - `approval-routes.ts` gains the reject route.
  - A new `escalation-routes.ts` serves the two reads.
  - `createControlService` returns `sweep` for tests.
  - The harness gains a `controlNow` option and exposes `sweepEscalations()`.
- **Rationale**:
  - It keeps `ledger.ts` focused on storage and its existing derivations.
  - Everything stays inside L2's folder (A1).
  - The ledger API remains "methods take `nowMs`".
  - Tests can drive expiry deterministically.
- **Alternatives considered**:
  - Putting everything in `ledger.ts`: it is already the hub for budget and approvals, and
    lifecycle rules are a separate concern.
  - Putting everything in `service.ts`: harder to unit-test.

## R9. Is concurrency safe without new locking?

- **Decision**: Approve, reject, sweep and authorize each run inside the existing promise-chain
  serializer. In every handler, the state check and the append are one synchronous block, with no
  `await` between them. Test T-E2E-07 fires approve and reject together and asserts exactly one final
  entry.
- **Rationale**: INV-8 already serializes L2 writes. Keeping check-then-append synchronous makes the
  ordering hold even if a future change awaits elsewhere in the handler. A must-fail proof that drops
  the serializer would not fail on single-threaded Node, so a separate one is not claimed. The
  serializer itself is already proven by T-E2E-04.
- **Alternatives considered**: a per-escalation lock, which is redundant under the global serializer.

## R10. What happens to existing ledgers and the demo?

- **Decision**: No migration. On the first start after upgrade, the sweep derives a state for every
  existing `ESCALATED` entry:
  - an entry with a `HUMAN_APPROVAL` is approved, and the first approval is the decision;
  - one older than 300 s with no decision gets one `ESCALATION_EXPIRED` entry;
  - an approval past `expiresAtMs` and never consumed gets `APPROVAL_LAPSED`.

  The `demo:local` summary is unaffected:
  - `matchesBaseline` checks outcomes, the on-chain delta, chain validity and the budget, not the
    entry count;
  - each run uses a fresh session, so earlier runs' escalations are never "the same purchase".
- **Rationale**: The ledger is append-only, so upgrade is just new facts appended. The current local
  and Base Sepolia ledgers hold 13 and 10 old escalations; each gets one expiry entry on the first
  start.
- **Alternatives considered**: rewriting old ledgers, which is forbidden; or excluding legacy
  escalations, which would leave them pending forever.

## R11. What do notifications carry?

- **Decision**: Each event is `{ seq, at, kind, authorizationId, sessionId, resourceKey, payTo,
  amount }` plus the fields for its kind:
  - `escalated`: `expiresAt`;
  - `approved`: `approvalId`, `approver`, `approvalExpiresAt`;
  - `denied`: `rejectionId`, `operator`, `reason?`;
  - `expired`: `expiresAt`;
  - `approval_lapsed`: `approvalId`.

  An event never carries a token, payment header, signature, `accepts` payload or the agent's
  `purpose`.
- **Rationale**: It is what an operator needs in order to decide or audit (FR-019), and nothing a
  caller could misuse (NFR-007). Showing the operator's own label and reason back to the operator is
  safe, because the operator wrote them.
- **Alternatives considered**: forwarding raw ledger entries, which exposes `accepts` and future
  fields.

## R12. How do the operator commands behave?

- **Decision**:
  - **`scripts/reject.ts`**: mirrors `scripts/approve.ts`. Usage:
    `npm run reject -- <authorizationId> [operator] [reason…]`, where the reason is the remaining
    arguments joined by spaces. It reads only `CONTROL_URL` and the operator token through
    `loadEnv("operator")` and `tokenFor("operator")`. Exit codes: 0 on 200, 1 on an HTTP or network
    error (409 included), 2 on a missing argument.
  - **`scripts/escalations.ts`**: `npm run escalations [-- --watch]`. It prints one line per pending
    escalation. With `--watch`, it then prints one line per event and polls every 1000 ms. Errors
    while watching are printed and retried, and SIGINT exits 0. Without `--watch`, an HTTP or
    network error exits 1.
- **Rationale**: It matches the existing operator command's environment, token handling and exit
  codes, and the architecture rule that scripts import only `src/shared`.
- **Alternatives considered**: one `operator` command with subcommands. The spec and the user named
  `reject` and `escalations`.

## R13. Which SPEC and governance changes are needed?

- **Decision**:
  - SPEC.md moves to v1.3, with a "Changes in 1.3" table and these amendments:
    - L2-2: the context lists `humanRejected?`, and R15 is added to the rule table;
    - L2-4: four entry types are added to the table;
    - L2-4.2: the "several times" sentence is replaced;
    - L2-4.3 "Escalation lifecycle": new section;
    - L2-5: the reject and escalation reads are added, and the approve row is amended;
    - §11: SEC-8 lists the new tests, and SEC-12 is new;
    - §12: T-POL-15, T-LED-04, T-E2E-07 and T-E2E-08 are added;
    - §13: the `reject` and `escalations` commands are added;
    - INV-12 gains the note "since v1.3 an escalation has at most one approval".
  - Constitution 1.1.0 → 1.1.1 (PATCH): Principle I's "a tool that signs, approves or edits policy"
    becomes "signs, approves, rejects or edits policy".
  - Spec 004 gets an "Amended by 010" note, the threat matrix in spec 007 gains SEC-12, and the
    specs index gains a 010 row.
- **Rationale**: Governance requires the SPEC and the constitution to change together. The change is
  a clarification that weakens no invariant, so it is a PATCH. T-ARCH-TRACE requires every test ID
  named in §11 to exist as a test title.
- **Alternatives considered**: leaving the constitution as is. "Approves" alone would leave an
  agent-side reject tool ambiguous.
