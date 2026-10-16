# Tasks: Settlement Verification (Layer 3)

**Input**: Design documents from `specs/005-settlement-verification/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/settlements-api.md, contracts/verifier.md, quickstart.md

**Tests**: Requested. Constitution Principle VIII requires them, and the spec cites T-E2E-01, T-E2E-03 and T-ARCH-*. Each story phase lists its tests first; write them so they fail before the implementation exists.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1–US4)

## Path Conventions

Single project (SPEC.md §6):
- `src/layer3-settlement/verifier.ts` and `src/layer3-settlement/service.ts`: owned by this feature.
- `test/verifier.test.ts` and `test/settlement-service.test.ts`: new, owned by this feature.
- `test/e2e.local.test.ts`: shared. This feature adds only the L3 assertions.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the module folder and the test doubles.

- [X] T001 Create `src/layer3-settlement/` with empty `verifier.ts` and `service.ts` modules. Each may import only from `src/shared/*` and its own folder (INV-1).
- [X] T002 [P] Create a stub read-only public client in `test/helpers/fake-public-client.ts`. It returns scripted receipts (`success` or `reverted`), logs, `getBlockNumber` heads and the `safe` block, and lets a test delay receipt arrival so timeouts can be exercised.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared types, the finality class and the verifier skeleton that every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 Verify the L3-facing types exist in `src/shared/contracts.ts` (owned by 001 T004; any change goes through a contract-change task there):
  - `SettlementStatus = "CONFIRMED" | "PENDING" | "MISMATCH" | "NOT_SETTLED"`
  - `FinalityClass = "included" | "confirmed-depth" | "l1-safe"`
  - `SettlementClaim`, `SettlementReport`, `SettlementVerifierPort`, `ReconciliationPort`, exactly as in SPEC §7

  Do not redefine or fork them in L3.
- [X] T004 [P] Write a unit test for `finalityClassFor` in `test/verifier.test.ts`. The boundaries are 10000 → `included`, 10001 → `confirmed-depth`, 1000000 → `confirmed-depth` and 1000001 → `l1-safe`. Inputs are bigint.
- [X] T005 Implement `finalityClassFor(amountAtomic: bigint): FinalityClass` in `src/layer3-settlement/verifier.ts`: "≤ 10_000n → included; ≤ 1_000_000n → confirmed-depth; else l1-safe" (contracts/verifier.md).
- [X] T006 Implement the `ChainSettlementVerifier` constructor and the report builder in `src/layer3-settlement/verifier.ts`.
  - Constructor deps: `{ publicClient, net, waitMs?: 45_000, pollMs?: 1_000 }`. It accepts no wallet client.
  - Report fields:
    - `verified` = `{asset, payer, payTo, amount}` taken from the claim
    - `network` = `requirement.network`
    - `finalityClass` always present
    - `observedAt` as ISO-8601
    - `detail` as a human-readable reason
- [X] T007 Add a read-only client factory in `src/layer3-settlement/service.ts`: `createPublicClient({ transport: http(net.rpcUrl) })` (research R1). It must not use `createWalletClient`, an account or a key.

**Checkpoint**: The foundation is ready. User stories can begin.

---

## Phase 3: User Story 1 - Confirm a paid request against the chain (Priority: P1) 🎯 MVP

**Goal**: A settled payment is reported CONFIRMED only when on-chain receipt and Transfer evidence exist.

**Independent Test**: A claim for a really settled 1000-atomic payment returns CONFIRMED with tx, block number, confirmations and class `included`. T-E2E-01 sees two CONFIRMED reports.

### Tests for User Story 1 ⚠️

- [X] T008 [P] [US1] Unit test in `test/verifier.test.ts`: a successful 1000-atomic tx with a Transfer(payer→payTo, 1000) from `requirement.asset` returns `CONFIRMED`. The report has `finalityClass: "included"`, `blockNumber` set and `confirmations ≥ 1`.
- [X] T009 [P] [US1] Unit test in `test/verifier.test.ts`: for a settled 5000-atomic claim, `verified` deep-equals the claim's `{asset, payer, payTo, amount}`.
- [X] T010 [P] [US1] Unit test in `test/verifier.test.ts`. Three cases:
  - No matching Transfer returns `MISMATCH`.
  - A Transfer emitted by a different contract returns `MISMATCH`.
  - Mixed-case addresses still match and return `CONFIRMED`.
- [X] T011 [US1] Add the L3 assertions for T-E2E-01 to `test/e2e.local.test.ts`. *(Done in-process with a real chain in `test/settlement-service.test.ts`; copy into the 008 harness when it exists.)* exactly two `CONFIRMED` reports, for 1000 and 5000 atomic, both class `included`. The harness is owned by 008.

### Implementation for User Story 1

- [X] T012 [US1] Implement the receipt wait in `src/layer3-settlement/verifier.ts`.
  - Compute one deadline per `verify` call: `deadline = start + waitMs` (research R2).
  - Call `waitForTransactionReceipt({ hash, timeout: deadline − Date.now(), pollingInterval: pollMs })`. The finality wait (T014, T029) stops at the same `deadline`, so a call never exceeds `waitMs` in total.
- [X] T013 [US1] Implement Transfer matching in `src/layer3-settlement/verifier.ts` with `parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs })` (research R3).
  - Keep only logs whose lower-cased `address` equals the lower-cased `requirement.asset`.
  - Require one log with lower-cased `from` equal to the payer, lower-cased `to` equal to `payTo`, and `value === BigInt(amount)`.
  - If no log matches, return `MISMATCH`.
- [X] T014 [US1] Implement the `included` finality check and confirmation count in `src/layer3-settlement/verifier.ts`. Compute `confirmations = head − block + 1` via `getBlockNumber()`, and return `CONFIRMED` with `blockNumber` as a decimal string. Any finality wait stops at the shared `deadline` from T012.
- [X] T015 [US1] Implement `POST /v1/settlements` as an app/router factory `createSettlementService(deps)` in `src/layer3-settlement/service.ts`. It does not call `listen` (binding is only in T040).
  - Mount `requireRole("agent-verifier")` from `src/shared/auth.ts` (owned by 007) **before** body validation, so 401 precedes 400. Do not write a separate bearer middleware.
  - Call `verify(claim)` and respond 200 with the `SettlementReport` for **every** status (contracts/settlements-api.md).

**Checkpoint**: US1 can be tested on its own (T008–T011 pass).

---

## Phase 4: User Story 2 - Reject forged or missing settlement evidence (Priority: P1)

**Goal**: A forged, missing, wrong-network or reverted settlement is never reported CONFIRMED (SEC-4, INV-10).

**Independent Test**: A forged `PAYMENT-RESPONSE` that references a real tx with a different amount yields `MISMATCH` (T-E2E-03, L3 side).

### Tests for User Story 2 ⚠️

- [X] T016 [P] [US2] Unit test in `test/verifier.test.ts`: `paymentResponseHeader: null` returns `NOT_SETTLED`.
- [X] T017 [P] [US2] Unit test in `test/verifier.test.ts`: an undecodable header, `success:false`, or no `transaction` each return `NOT_SETTLED`, with the reason in `detail`.
- [X] T018 [P] [US2] Unit test in `test/verifier.test.ts`: when `settle.network` differs from `requirement.network`, the result is `MISMATCH`.
- [X] T019 [P] [US2] Unit test in `test/verifier.test.ts`: a reverted tx (`receipt.status !== "success"`) returns `NOT_SETTLED`.
- [X] T020 [US2] Add the L3 assertions for T-E2E-03 to `test/e2e.local.test.ts`. *(Done in-process with a real chain in `test/settlement-service.test.ts`; copy into the 008 harness when it exists.)* a forged `PAYMENT-RESPONSE` pointing at a real tx with a different amount returns `MISMATCH` and is never `CONFIRMED`. The L2 side (sticky CONFIRMED, anomaly naming `amount`) is owned by 003.
- [X] T021 [US2] Show the safety check is load-bearing.
  - Temporarily bypass the Transfer match (T013) and confirm that T-E2E-03 and T010 then fail, because the forged claim is reported CONFIRMED.
  - Restore the check, and record the result in the PR description, as the constitution requires (Principle VIII).
  - **Result (2026-10-16):** with the match bypassed, 5 tests failed (both T-E2E-03 cases and three T010 cases: wrong amount, wrong contract, wrong payee). Restored, all pass.

### Implementation for User Story 2

- [X] T022 [US2] In `src/layer3-settlement/verifier.ts`, decode with `decodePaymentResponseHeader` from `@x402/core/http`, inside try/catch.
  - A decode error, a missing header, `!success` or no `transaction` returns `NOT_SETTLED` with the reason in `detail`.
  - Never hand-decode base64 (NFR-009).
- [X] T023 [US2] In `src/layer3-settlement/verifier.ts`, return `MISMATCH` before any chain read when `settle.network ≠ requirement.network`.
- [X] T024 [US2] In `src/layer3-settlement/verifier.ts`, return `NOT_SETTLED` for a non-success receipt. All waits respect the shared `deadline` (T012). Enforce the research R5 precedence, returning at the first terminal result: NOT_SETTLED (header) → MISMATCH (network) → PENDING (receipt timeout) → NOT_SETTLED (reverted) → MISMATCH (Transfer) → PENDING (finality) → CONFIRMED.

**Checkpoint**: US1 and US2 both pass. The P1 MVP is complete.

---

## Phase 5: User Story 3 - Finality scaled to amount at risk (Priority: P2)

**Goal**: Larger amounts wait for stronger finality before they are CONFIRMED.

**Independent Test**: Claims of 10,000, 1,000,000 and 1,000,001 atomic get the expected class, and each is CONFIRMED only once its requirement is met.

### Tests for User Story 3 ⚠️

- [X] T025 [P] [US3] Unit test in `test/verifier.test.ts`: a 1,000,000-atomic claim on the `base-sepolia` profile (`confirmationDepth: 2`) is not confirmed at 1 confirmation and is `CONFIRMED` at 2.
- [X] T026 [P] [US3] Unit test in `test/verifier.test.ts`: an `l1-safe` claim on a profile with `supportsSafeTag: true` is `CONFIRMED` once `getBlock({ blockTag: "safe" }).number ≥ tx block`, and keeps polling while it is lower.
- [X] T027 [P] [US3] Unit test in `test/verifier.test.ts`: an `l1-safe` claim on `local` (no safe tag, depth 1) is `CONFIRMED` only once `confirmations ≥ 5`.
- [X] T028 [P] [US3] Unit test in `test/verifier.test.ts`, with a short `waitMs`:
  - When finality is not reached by the deadline, the result is `PENDING` with block info filled in.
  - When the receipt never arrives, the result is `PENDING`, not `NOT_SETTLED`.
  - When the receipt arrives late and finality is then slow, total `verify` time is ≤ `waitMs` + one `pollMs` (one shared deadline, never 2 × `waitMs`).

### Implementation for User Story 3

- [X] T029 [US3] Implement the finality loop in `src/layer3-settlement/verifier.ts`. Poll every `pollMs` until the shared deadline.
  - `confirmed-depth`: `head − block + 1 ≥ net.confirmationDepth`.
  - `l1-safe`: when `net.supportsSafeTag`, `getBlock({ blockTag: "safe" }).number ≥ block`; otherwise `≥ 5 × confirmationDepth`.
  - Call `getBlock({ blockTag: "safe" })` only when `supportsSafeTag`.
- [X] T030 [US3] In `src/layer3-settlement/verifier.ts`, map a receipt timeout to `PENDING` (no block info), kept separate from other RPC errors. Map a finality timeout to `PENDING` with `blockNumber` and `confirmations` set.

**Checkpoint**: US1–US3 pass.

---

## Phase 6: User Story 4 - Report every outcome to Control and keep re-checking pending ones (Priority: P2)

**Goal**: Every report reaches L2 reconciliation, best-effort. PENDING reports are re-checked in the background.

**Independent Test**: A PENDING claim triggers up to 5 re-checks 30 s apart, each reconciled, and the original request returns without waiting.

### Tests for User Story 4 ⚠️

- [X] T031 [P] [US4] Service test in `test/settlement-service.test.ts`:
  - A missing or wrong token returns 401 `{ error: "unauthorized" }`, even when the body is also malformed (401 precedes 400).
  - **T-AUTH-02**: `CONTROL_TOKEN` returns 401, and `SETTLEMENT_TOKEN` returns 401. Only `VERIFIER_TOKEN` is accepted.
  - With a valid token, a missing `authorizationId` (string) or `requirement` (object) returns 400 `{ error: string }`.
- [X] T032 [P] [US4] Service test in `test/settlement-service.test.ts`.
  - Every report is passed to the injected reconciler.
  - The HTTP reconcile adapter sends `Authorization: Bearer ${SETTLEMENT_TOKEN}` and never `VERIFIER_TOKEN` (INV-13).
- [X] T033 [P] [US4] Service test in `test/settlement-service.test.ts` for SC-005:
  - When the reconciler throws, the response is still 200 with the report and the failure is logged.
  - When L2 hangs (the reconcile call never resolves), L1 still receives the 200 report within `waitMs` + 5 s, and the timeout is logged.
- [X] T034 [P] [US4] Service test in `test/settlement-service.test.ts`, using a small `recheckIntervalMs`.
  - A PENDING report schedules at most `recheckAttempts` (5) re-checks.
  - Re-checking stops at the first non-PENDING result.
  - Each re-check result is reconciled.
  - A second PENDING claim for the same `authorizationId` replaces the existing schedule.
- [X] T035 [P] [US4] Service test in `test/settlement-service.test.ts` for NFR-007: the response returns before any re-check runs, and the re-check timers are `unref`'d so they don't block teardown.

### Implementation for User Story 4

- [X] T036 [US4] Implement the HTTP `ReconciliationPort` adapter in `src/layer3-settlement/service.ts`. It sends `POST {CONTROL_URL}/v1/reconcile` with `Bearer SETTLEMENT_TOKEN` and the body `SettlementReport`. The contract is owned by 003. The `{ ok, anomaly }` response is only logged.
- [X] T037 [US4] Add request validation in `src/layer3-settlement/service.ts`: 400 when `authorizationId` is not a string or `requirement` is not an object (research R8). It runs after `requireRole` (T015); 401 handling is not duplicated here.
- [X] T038 [US4] Implement the best-effort reconcile push in `src/layer3-settlement/service.ts`: await `reconcile(report)` with `signal: AbortSignal.timeout(5000)`. On any error or timeout, log it and continue without changing the 200 response (research R6).
- [X] T039 [US4] Implement the re-check scheduler in `src/layer3-settlement/service.ts`.
  - Keep `Map<authorizationId, schedule>` with `attemptsLeft` (default 5) and `intervalMs` (default 30000), using `setTimeout(...).unref()`.
  - Each attempt re-runs `verify(claim)` and reconciles the result.
  - Constructor options `recheckAttempts`, `recheckIntervalMs` and `reconciler` are injectable.
- [X] T040 [US4] Add the service entry point in `src/layer3-settlement/service.ts`: load env with `loadEnv()` from `src/shared/config.ts` (owned by 007), build the verifier and reconciler, call `createSettlementService` (T015), and `listen(SETTLEMENT_PORT, SETTLEMENT_BIND_HOST)` (007 T039) on `${SETTLEMENT_PORT:-4023}`. This is the only L3 bind. The npm script `l3:verifier` is owned by 008.

**Checkpoint**: All four stories pass.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T041 [P] Confirm the 007 architecture test passes for `src/layer3-settlement/**` (INV-4, SC-004). The folder must contain no `createWalletClient`, `signTypedData`, `writeContract`, `privateKeyToAccount` or `mnemonicToAccount`, and may import only `src/shared/*`.
- [X] T042 [P] Audit `src/layer3-settlement/**` for exact money math (NFR-008): amounts only via `BigInt`, and no `Number(amount)` or float comparisons.
- [X] T043 Run `npm run typecheck`, `npm test` and the steps in `specs/005-settlement-verification/quickstart.md` §1–§5, including the L2-down resilience check.
- [X] T044 [P] Verify these items are covered by the SPEC.md v1.1 amendment (owned by 008 T000) before merging T012, T034, T037, T038 and T039: one shared 45 s deadline for receipt and finality (§8.3 L3-1); a new PENDING schedule replaces the old one and stops at the first terminal status (L3-2); reconcile push timeout of 5 s (L3-2); stricter 400 typing (string `authorizationId`, object `requirement`); new test files `test/verifier.test.ts`, `test/settlement-service.test.ts` and `test/helpers/fake-public-client.ts` (§6, §12); T-AUTH-02. File: `SPEC.md` (read-only check).

---

## Dependencies & Execution Order

### Cross-feature dependencies

- **All tasks depend on 008 T000** (SPEC.md v1.1 amendment).
- **001 T004**: creates `src/shared/contracts.ts`. Foundational (T003) depends on it.
- **006**: local chain, MockUSDC, seller and facilitator. Real settlements for T011, T020 and T043. The network profile (`rpcUrl`, `confirmationDepth`, `supportsSafeTag`) in `src/shared/config.ts`.
- **003**: `POST /v1/reconcile` for the end-to-end reconcile path. The unit and service tests use an injected reconciler and don't need it.
- **002 and 001**: needed only for the e2e tests (T011, T020), to produce authorized, paid claims.
- **007**: `requireRole` in `src/shared/auth.ts` (T015), `loadEnv()` (T040), the architecture test used by T041, and the `env/l3-verifier.env.example` template.
- **008**: the e2e harness, the `l3:verifier` npm script and the demo.

### Phase dependencies

- Setup (Phase 1) has no dependencies.
- Foundational (Phase 2) depends on Setup and on 001 T004, and blocks all stories.
- US1 (Phase 3) depends on Foundational.
- US2 (Phase 4) depends on Foundational. It shares `verifier.ts` with US1, so implement it after T012–T014 to avoid edit conflicts. Its tests can be written in parallel with US1's.
- US3 (Phase 5) depends on US1, because it extends the finality step after T014.
- US4 (Phase 6) depends on Foundational and T015 (the endpoint). It is independent of US2 and US3.
- Polish (Phase 7) depends on all stories.

### Within each story

Tests are written first and must fail before implementation. In US1 the order is receipt (T012), then Transfer match (T013), then finality and count (T014), then endpoint (T015).

## Parallel Examples

```text
# Phase 2: after T003
T004 finalityClassFor boundary test   ‖  T002 fake public client (if not done)

# US1 tests together
T008 ‖ T009 ‖ T010

# US2 tests together (they can be written while US1 is implemented)
T016 ‖ T017 ‖ T018 ‖ T019

# US3 tests together
T025 ‖ T026 ‖ T027 ‖ T028

# US4 tests together (separate file from the verifier tests)
T031 ‖ T032 ‖ T033 ‖ T034 ‖ T035

# Polish
T041 ‖ T042 ‖ T044
```

## Implementation Strategy

### MVP (P1: US1 + US2)

1. Phases 1–2 (T001–T007).
2. US1 (T008–T015). Validate a CONFIRMED report for a real settlement.
3. US2 (T016–T024), including the "fails without the check" demonstration in T021.
4. **Stop and validate**: T-E2E-01 shows two CONFIRMED reports and T-E2E-03 shows MISMATCH. This is enough to close SEC-4.

### Incremental delivery

5. US3 (T025–T030). Finality tiers matter for Base Sepolia and for amounts above $0.01.
6. US4 (T031–T040). Best-effort reconcile and PENDING re-checks complete the L3-2 contract.
7. Polish (T041–T044).
