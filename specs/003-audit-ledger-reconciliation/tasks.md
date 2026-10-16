# Tasks: Audit Ledger, Committed Spend & Settlement Reconciliation

**Input**: Design documents from `specs/003-audit-ledger-reconciliation/`

**Prerequisites**: 008 T000 (SPEC.md v1.1 amendment), 001 T004 (`src/shared/contracts.ts`), plan.md, spec.md, research.md, data-model.md, contracts/ (ledger-entry.schema.json, ledger-api.md, http-api.md), quickstart.md

**Tests**: REQUIRED. Constitution Principle VIII requires them, and the spec names T-LED-01..03,
T-E2E-01 (L2 side), T-E2E-03 and T-E2E-05. Write each test first and confirm it fails before
implementing. For each safety mechanism, there is also a task that shows its test fails when
the mechanism is removed.

**Organization**: Tasks are grouped by user story (US1–US4 from spec.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: The user story the task belongs to (US1, US2, US3, US4)

## Path Conventions

Single project (SPEC.md §6):
- This feature owns `src/layer2-control/ledger.ts`, `test/ledger.test.ts`, and the
  `/v1/reconcile` and `/v1/ledger/verify` routes in `src/layer2-control/service.ts`.
- This feature also implements `findOpenApproval()` and `authorizedSince()` on `AuditLedger`.
- Feature 002 owns the authorize and budget routes and the L2 service bootstrap (constructing the
  ledger at startup). Feature 004 owns the approvals route and the semantics and tests of
  `findOpenApproval` (004 T005). Feature 007 owns `requireRole()` in `src/shared/auth.ts`.
  Feature 008 owns the e2e harness and the SPEC.md v1.1 amendment (008 T000).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Make sure the shared prerequisites this feature relies on exist

- [X] T001 Confirm `.local/` is listed in `.gitignore`, since the ledger file `.local/ledger-<network>.jsonl` must never be committed (scaffold owned by 008, M0)
- [X] T002 [P] Verify `SettlementReport`, `SettlementStatus`, `FinalityClass` and `ReconciliationPort` exist in `src/shared/contracts.ts` exactly as SPEC.md §7 states (owned by 001 T004); add nothing new for this feature
- [X] T003 [P] Create an empty test file `test/ledger.test.ts` that uses a temporary directory (`fs.mkdtempSync`) for each test's ledger file

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The ledger core that every story and features 002 and 004 depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. This phase depends on 001 T004 (`src/shared/contracts.ts`).

- [X] T004 Define the `EntryType` union `"INTENT" | "AUTHORIZED" | "DENIED" | "ESCALATED" | "HUMAN_APPROVAL" | "SETTLEMENT"` and the `LedgerEntry` type in `src/layer2-control/ledger.ts`, matching contracts/ledger-entry.schema.json. Fields: `seq` ("Starts at 0, increments by 1 per append, no gaps"), `ts` (ISO-8601), `type`, optional `sessionId`/`intentId`/`authorizationId`, `data`, `prevHash` ("`"0"×64` for `seq 0`, otherwise the previous entry's `hash`"), and `hash` ("`sha256(canonicalJSON(entry without hash))`").
- [X] T005 [P] Implement `canonicalJSON(v)` in `src/layer2-control/ledger.ts`: recursively sorted object keys, no whitespace, arrays kept in order, absent optional fields omitted (not written as null), per research R1
- [X] T006 [P] Implement `resourceKey(url)` = `new URL(url).origin + pathname`, without the query string, in `src/layer2-control/ledger.ts` (FR-014)
- [X] T007 Implement the `AuditLedger` constructor and `append()` in `src/layer2-control/ledger.ts`. The constructor reads the JSONL file; a missing file means an empty ledger. `append()` assigns `seq`, `ts`, `prevHash` and `hash`, writes `JSON.stringify(entry)+"\n"` with `fs.appendFileSync`, and only then pushes the entry to memory (research R2). There is no update or delete method (INV-9). Depends on T004 and T005.
- [X] T008 Implement the read-only accessors `entries()` and `findAuthorized(authorizationId)` in `src/layer2-control/ledger.ts` (contracts/ledger-api.md)
- [X] T043 Implement `findOpenApproval(sessionId, resourceKey, nowMs)` in `src/layer2-control/ledger.ts` (contracts/ledger-api.md). It returns the most recent HUMAN_APPROVAL entry for (session, resourceKey) that is open: "`nowMs ≤ data.expiresAtMs`" and "no AUTHORIZED entry has `data.approvalRef === data.approvalId`". Each approval is single-use by its own `approvalId` (`apr_<uuid>`); several approvals for one escalation each pay once. Derive the result from entries only, with no clock read and no mutable map (INV-7, NFR-007). Semantics and unit tests are owned by 004 (T005). Depends on T007 and T008.

**Checkpoint**: The ledger can append and reload entries. User stories can begin.

---

## Phase 3: User Story 1 - Tamper-evident audit trail (Priority: P1) 🎯 MVP

**Goal**: An append-only, hash-chained log in which any edit, deletion or reordering is detected, and L2 refuses to start on a broken chain.

**Independent Test**: Append several entries and check the chain verifies. Edit one stored entry and check that reload throws `integrity` (T-LED-01).

### Tests for User Story 1 ⚠️

- [X] T009 [P] [US1] Write test "T-LED-01 chain verifies; edited entry makes reload throw integrity" in `test/ledger.test.ts`. Cover:
  - The genesis entry has `prevHash` equal to 64 zeros and `seq` 0.
  - `verifyChain()` returns `{entries:N, ok:true}`.
  - Changing one character in any line makes `new AuditLedger(path)` throw `/integrity/`.
- [X] T010 [P] [US1] Write test "T-LED-01b truncated last line / deleted line / reordered lines fail closed" in `test/ledger.test.ts` (spec edge cases; research R3: no silent repair)
- [X] T011 [P] [US1] Write test "verifyChain reports brokenAt" in `test/ledger.test.ts`. `brokenAt` is the 0-based line index of the first line that fails to parse, recompute its hash, or link to the previous hash. On an untampered prefix this equals that entry's `seq` (research R4).
- [X] T012 [P] [US1] Write test "canonicalJSON is key-order independent" in `test/ledger.test.ts`: `{b:1,a:{d:2,c:3}}` and `{a:{c:3,d:2},b:1}` serialize identically

### Implementation for User Story 1

- [X] T013 [US1] Implement `verifyChain(): {entries, ok, brokenAt?}` in `src/layer2-control/ledger.ts`. It recomputes every hash and every `prevHash` link (FR-006).
- [X] T014 [US1] In the `AuditLedger` constructor in `src/layer2-control/ledger.ts`, call `verifyChain()` after load. Throw `Error("integrity: …")` on a parse error or a broken chain (FR-007, INV-9).
- [X] T015 [US1] Write test "tampered ledger → L2 process exits non-zero" in `test/ledger.test.ts`. Spawn `src/layer2-control/service.ts` with its cwd set to a temporary directory whose `.local/ledger-local.jsonl` has one edited line, and assert a non-zero exit code, `integrity` on stderr, and no listener on the control port (FR-005, FR-007). The bootstrap that constructs the ledger before listening is owned by 002.
- [X] T016 [US1] Safety proof: in src/layer2-control/ledger.ts, temporarily remove the `verifyChain()` call from the constructor. Confirm T-LED-01 fails, restore the call, and record the result in the PR description (constitution VIII).

**Checkpoint**: T-LED-01 passes. Tampering is detected at startup.

---

## Phase 4: User Story 2 - Budgets derived from the ledger, released only when safe (Priority: P1)

**Goal**: Committed spend is computed only from ledger entries. An authorization is released only when its effective report is NOT_SETTLED **and** `nowMs > validBefore×1000`.

**Independent Test**: Record an AUTHORIZED entry of 1000 and a NOT_SETTLED report. Check committed spend before and after `validBefore` (T-LED-02).

### Tests for User Story 2 ⚠️

- [X] T017 [P] [US2] Write test "T-LED-02 NOT_SETTLED released only after validBefore" in `test/ledger.test.ts`:
  - With no report, committed spend includes 1000.
  - With NOT_SETTLED and `nowMs ≤ validBefore*1000`, it includes 1000.
  - With NOT_SETTLED and `nowMs > validBefore*1000`, it excludes 1000.
- [X] T018 [P] [US2] Write test "PENDING and MISMATCH keep counting at any time" in `test/ledger.test.ts` (FR-018, NFR-005)
- [X] T019 [P] [US2] Write test "committedAtomic filters by sessionId and sinceMs; authorizedSince counts trailing window" in `test/ledger.test.ts`. Daily window `nowMs − 86_400_000`; velocity window `ts ≥ nowMs − 60_000` (FR-019).
- [X] T020 [P] [US2] Write test "committedAtomic is deterministic in nowMs and uses BigInt" in `test/ledger.test.ts`. Amounts above 2^53 must sum exactly, and no clock read is allowed: stub `Date.now` to throw (NFR-006, NFR-007).

### Implementation for User Story 2

- [X] T021 [US2] Implement `effectiveReport(authorizationId)` in `src/layer2-control/ledger.ts`: "The SETTLEMENT entry with the highest `seq` for `authId` among those with `anomaly !== true`" (FR-016)
- [X] T022 [US2] Implement `committedAtomic({sessionId?, sinceMs?}, nowMs): bigint` in `src/layer2-control/ledger.ts`. It sums `BigInt(data.amount)` over the AUTHORIZED entries in the filter, excluding an entry only when its effective status is NOT_SETTLED and `nowMs > validBefore×1000` (FR-015, FR-017, INV-7)
- [X] T023 [US2] Implement `authorizedSince(sinceMs): number` in `src/layer2-control/ledger.ts` for the velocity count. Expose session, daily and velocity figures for 002's authorize step 3; 002 owns the wiring in `service.ts`.
- [X] T024 [US2] Safety proof: in src/layer2-control/ledger.ts, temporarily drop the `validBefore` condition so that NOT_SETTLED releases immediately. Confirm T-LED-02 fails, restore the condition, and record the result (SEC-9).

**Checkpoint**: T-LED-02 passes. Budgets are derived from the ledger, with no stored counters.

---

## Phase 5: User Story 3 - Settlement reconciliation with sticky confirmation (Priority: P1)

**Goal**: L3 reports are cross-checked against the AUTHORIZED data. Contradictions are stored as anomalies, and CONFIRMED is final.

**Independent Test**: After a CONFIRMED settlement, post a forged report with a different amount. The effective status stays CONFIRMED and the anomaly names `amount` (T-E2E-03, T-LED-03).

### Tests for User Story 3 ⚠️

- [X] T025 [P] [US3] Write test "T-LED-03 anomaly reports are ignored for the effective status" in `test/ledger.test.ts`. After a CONFIRMED report, an `anomaly:true` NOT_SETTLED entry leaves `effectiveReport` CONFIRMED.
- [X] T026 [P] [US3] Write test "reconcile: field mismatch → MISMATCH, anomaly, detail names every field" in `test/ledger.test.ts`. Mismatch on `amount` and `payTo` gives the detail `"verified field mismatch: amount,payTo"`; address casing alone is not a mismatch (FR-021).
- [X] T027 [P] [US3] Write test "reconcile: repeated CONFIRMED same tx is non-anomalous; PENDING→CONFIRMED allowed" in `test/ledger.test.ts` (spec edge cases)
- [X] T044 [P] [US3] Write test "reconcile: malformed body → 400, unknown authorizationId → 404, nothing appended" in `test/ledger.test.ts` (in-process service). A body missing `authorizationId` or any of `verified.{asset, payer, payTo, amount}` returns 400. An unknown `authorizationId` returns 404. In both cases the ledger entry count is unchanged (FR-020, contracts/http-api.md).
- [X] T028 [P] [US3] Add the L2-side assertions to "T-E2E-03 forged PAYMENT-RESPONSE" in `test/e2e.local.test.ts`. L2 keeps the first CONFIRMED and records an anomaly whose detail names `amount`. The L3-side assertions are owned by 005 and the harness by 008.

### Implementation for User Story 3

- [X] T029 [US3] Implement `reconcile(report)` in `src/layer2-control/ledger.ts` following the algorithm in contracts/ledger-api.md:
  1. Look up `findAuthorized`; if there is no entry, return not-found.
  2. Compare the lowercased `asset`, `payer`, `payTo` and `amount`.
  3. On any difference, store `{...r, status:"MISMATCH", detail:"verified field mismatch: "+diff.join(","), anomaly:true}`.
  4. Otherwise, if the effective report is CONFIRMED and the new report is not CONFIRMED with the same `transaction`, set `anomaly:true`.
  5. Otherwise set `anomaly:false`.
  6. Append a `SETTLEMENT` entry (FR-013, FR-020..FR-025, INV-11).
- [X] T030 [US3] Add `POST /v1/reconcile` to `src/layer2-control/service.ts`:
  - Mount `requireRole("verifier-control")` (007, `src/shared/auth.ts`) **before** any body parsing or ledger access. Only `SETTLEMENT_TOKEN` passes; any other token gets 401.
  - Body: a `SettlementReport`. Reject with 400 when `authorizationId` or any of `verified.{asset, payer, payTo, amount}` is missing.
  - Runs inside the same L2 serialized section as authorize (research: a single writer).
  - Returns 200 `{ok:true, anomaly}` or 404 for an unknown `authorizationId` (contracts/http-api.md).
- [X] T031 [US3] Safety proof: in src/layer2-control/ledger.ts, temporarily remove the `anomaly !== true` filter in `effectiveReport`. Confirm T-LED-03 and T-E2E-03 fail, restore the filter, and record the result (INV-11).

**Checkpoint**: T-LED-03 and T-E2E-03 (L2 side) pass. CONFIRMED is sticky.

---

## Phase 6: User Story 4 - Role-separated access to reconciliation and verification (Priority: P2)

**Goal**: Only `SETTLEMENT_TOKEN` can reconcile and only `OPERATOR_TOKEN` can verify the chain. Any other token gets 401, and nothing is appended.

**Independent Test**: Call reconcile with the agent's token and expect 401 (T-E2E-05).

### Tests for User Story 4 ⚠️

- [X] T032 [P] [US4] Write test "T-E2E-05 /v1/reconcile with the agent token returns 401" in `test/e2e.local.test.ts`. Also assert that the ledger entry count is unchanged afterwards (NFR-001).
- [X] T033 [P] [US4] Write test "GET /v1/ledger/verify: operator token → {entries, ok:true}; CONTROL_TOKEN / SETTLEMENT_TOKEN → 401" in `test/e2e.local.test.ts`

### Implementation for User Story 4

- [X] T034 [US4] Verify that T030's guard on `POST /v1/reconcile` in `src/layer2-control/service.ts` rejects `CONTROL_TOKEN`, `VERIFIER_TOKEN` and `OPERATOR_TOKEN` with 401 before any ledger access (guard mounted in T030; `requireRole` owned by 007)
- [X] T035 [US4] Add `GET /v1/ledger/verify` to `src/layer2-control/service.ts`, guarded by `OPERATOR_TOKEN` only, returning `{entries, ok, brokenAt?}` from `verifyChain()` (FR-026)
- [X] T036 [US4] Safety proof: temporarily accept any configured token on `/v1/reconcile`. Confirm T-E2E-05 fails, restore the guard, and record the result (INV-13).

**Checkpoint**: All four stories work. T-E2E-05 passes.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T037 [P] Add the L2-side assertions to T-E2E-01 in `test/e2e.local.test.ts`:
  - session committed spend is exactly `6000`;
  - exactly 2 non-anomalous CONFIRMED settlements;
  - `/v1/ledger/verify` returns `ok:true` (SC-002).

  The harness is owned by 008.
- [X] T038 [P] Add an auditability test "every authorize leaves INTENT + exactly one decision entry; every reconcile leaves one SETTLEMENT" in `test/e2e.local.test.ts` (NFR-008, SC-006)
- [X] T039 [P] Validate sample entries of all six types against `specs/003-audit-ledger-reconciliation/contracts/ledger-entry.schema.json` in `test/ledger.test.ts`
- [X] T040 Confirm with the architecture test (owned by 007) that `src/layer2-control/ledger.ts` imports only `src/shared/*` and node built-ins and holds no key material
- [X] T041 Run quickstart.md sections 1–3, including the manual tamper check, after which L2 exits with `integrity: …`. Then run `npm run typecheck` and `npm test`.
- [X] T042 Verify that these items are covered by 008 T000 (SPEC.md v1.1 amendment, §8.2 L2-4/L2-5) and that the implementation matches the amended text in `SPEC.md`:
  - reconcile runs inside the L2 mutex;
  - reconcile returns 400 on a malformed body;
  - `brokenAt` is the 0-based line index;
  - `seq` starts at 0;
  - mismatch detail format `"verified field mismatch: <fields>"`;
  - canonical JSON omits absent optional fields;
  - `HUMAN_APPROVAL.data.approvalId` and `AUTHORIZED.data.approvalRef` = consumed `approvalId` or `null`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **All tasks depend on 008 T000** (SPEC.md v1.1 amendment gate).
- **Setup (Phase 1)**: none beyond 008 T000
- **Foundational (Phase 2)**: depends on Setup and on 001 T004 (`src/shared/contracts.ts`). It BLOCKS all stories, and also blocks 002 (authorize appends) and 004 (approvals: T043 `findOpenApproval`).
- **US1 (Phase 3)**: depends on Foundational
- **US2 (Phase 4)**: depends on Foundational. It needs `effectiveReport`, so T021 comes before T022. It is independent of US1.
- **US3 (Phase 5)**: depends on Foundational and on T021 (`effectiveReport`) from US2. Its e2e test T028 also needs 005 (L3 verifier), 006 (seller/chain) and the 008 harness.
- **US3 T030** needs 007's `requireRole()` (`src/shared/auth.ts`), so the reconcile route is never unauthenticated, even in the MVP.
- **US4 (Phase 6)**: depends on T030 (reconcile route, already guarded) and T013 (`verifyChain`).
- **Polish (Phase 7)**: depends on all stories. T037 and T038 need 002's authorize route and the 008 harness.

### Cross-feature dependencies

| Needs | From |
|---|---|
| SPEC.md v1.1 amendment gate (T000) | 008 |
| `src/shared/contracts.ts` (T004) | 001 |
| Authorize route writes INTENT, AUTHORIZED (always with `approvalRef`, `null` when unused), DENIED and ESCALATED via `append()`; consumes `committedAtomic`, `authorizedSince` and `findOpenApproval`; L2 service bootstrap constructs the ledger | 002 |
| `findOpenApproval` semantics and tests (T005); HUMAN_APPROVAL writes with `approvalId` | 004 |
| `SettlementReport` producer; L3 → `/v1/reconcile` client | 005 |
| `requireRole()` in `src/shared/auth.ts`; architecture test | 007 |
| e2e harness, scaffold and `.gitignore` | 008 |

### Within each user story

Tests first (they must fail), then implementation, then the safety proof, then the checkpoint.

---

## Parallel Example: User Story 1

```bash
# All US1 tests are in one file but are independent test cases, so draft them together:
Task: "T009 T-LED-01 chain verifies; edited entry → integrity"
Task: "T010 T-LED-01b truncated/deleted/reordered lines fail closed"
Task: "T011 verifyChain reports brokenAt"
Task: "T012 canonicalJSON key-order independent"
```

## Parallel Example: User Stories 2 and 4

```bash
# After Foundational, while US1 is in progress:
Task: "T017 T-LED-02 NOT_SETTLED released only after validBefore"
Task: "T018 PENDING and MISMATCH keep counting"
Task: "T032 T-E2E-05 reconcile with agent token → 401"
```

---

## Implementation Strategy

### MVP first (P1 stories: US1 + US2 + US3)

1. Phase 1 Setup, then Phase 2 Foundational. This unblocks features 002 and 004.
2. US1: hash chain and fail-closed startup (T-LED-01). **Stop and validate.**
3. US2: committed spend derived from the ledger (T-LED-02). This lets 002 enforce the budget rules R11–R13.
4. US3: reconcile with sticky CONFIRMED (T-LED-03, T-E2E-03). The route is guarded by `SETTLEMENT_TOKEN` from the start (T030).
5. MVP demo: the 003 portion of T-E2E-01 passes (`spentOrReserved = 6000`, 2 CONFIRMED, `ok:true`).

### Incremental delivery

- Add US4 (role separation, T-E2E-05). That completes INV-13 for these endpoints.
- Then Polish: schema validation, auditability, the quickstart run, and the check against 008 T000.

### Notes

- Never add an update or delete method to `AuditLedger`, and never cache budget totals (INV-7, INV-9).
- Every safety proof task (T016, T024, T031, T036) must leave the mechanism restored, with its
  test green.
