---

description: "Task list for 001-agent-paid-fetch (Layer 1 — Intent & Orchestration)"
---

# Tasks: Agent Paid Fetch (Layer 1 — Intent & Orchestration)

**Input**: Design documents from `specs/001-agent-paid-fetch/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (l1-ports.md, agent-tools.json, cli.md), quickstart.md

**Tests**: Requested. Constitution Principle VIII requires them, and the spec cites T-AGT-01, T-E2E-01, T-ARCH-* and the §12 manual key-refusal check. Tests come first in every story phase and must fail before implementation.

**Organization**: Tasks are grouped by user story, in priority order: US1, US2, US5 (P1), then US3, US4 (P2).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story from spec.md (US1–US5)

## Path Conventions

Single project per SPEC.md §6. L1 code is in `src/layer1-intent/` and `src/main.ts`. Tests are in `test/`. SPEC §6 fixes the test file list, so orchestrator unit tests live in `test/agent.test.ts` as separate `describe` blocks.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: L1 folder, env template and npm scripts. The repo scaffold (package.json, tsconfig, vitest config) is owned by 008 (M0).

- [X] T001 Create the `src/layer1-intent/` directory with empty modules `orchestrator.ts`, `ports-http.ts`, `agent.ts` and `scripted.ts`, per plan.md Project Structure (requires 008 M0 scaffold)
- [X] T002 [P] Verify `env/l1-agent.env.example` (owned by 007 T044) contains exactly `NETWORK, ANTHROPIC_API_KEY, ANTHROPIC_MODEL?, SELLER_URL, CONTROL_URL, SETTLEMENT_URL, CONTROL_TOKEN, VERIFIER_TOKEN, SESSION_ID?` and no `PAYER_PRIVATE_KEY` line (contracts/cli.md, CFG-2)
- [X] T003 [P] Verify `package.json` (owned by 008 T002) defines `agent` (`tsx src/main.ts`) and `agent:scripted` (`tsx src/main.ts --scripted`) as required by contracts/cli.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared contract types and port adapters that every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 Create `src/shared/contracts.ts` with **every** SPEC §7 type and port: `PaymentIntent`, `PolicyViolation`, `AuthorizationDecision`, `SettlementClaim`, `SettlementStatus`, `FinalityClass`, `SettlementReport`, `BudgetStatus`, `AuthorizationGatePort`, `SettlementVerifierPort`, `ReconciliationPort`. 001 owns this file; other features change it only via a contract-change task (SPEC §7)
- [X] T005 [P] Verify `src/shared/config.ts` exposes `SELLER_URL`, `CONTROL_URL`, `SETTLEMENT_URL`, `CONTROL_TOKEN`, `VERIFIER_TOKEN` (env and topology owned by 007) and `formatAtomic(amount: string, decimals: number)` with BigInt-only math (owned by 006) (Principle VI)
- [X] T006 [P] Write port-adapter tests in `test/agent.test.ts` (`describe("L1-2 ports-http")`) against a stub HTTP server:
  - `authorize` POSTs to `/v1/authorize` with `Bearer CONTROL_TOKEN`.
  - `budget` GETs `/v1/budget/:sessionId` with `Bearer CONTROL_TOKEN`.
  - `verify` POSTs to `/v1/settlements` with `Bearer VERIFIER_TOKEN`.
  - Any non-2xx (400, 401) **throws** and is never returned as a decision.
  - `CONTROL_TOKEN` is never sent to L3, and `VERIFIER_TOKEN` is never sent to L2 (FR-010, FR-011, INV-13)
- [X] T007 Implement `HttpAuthorizationGate` and `HttpSettlementVerifier` in `src/layer1-intent/ports-http.ts`:
  - Implement the port interfaces from `src/shared/contracts.ts`.
  - Each takes one base URL and one token.
  - Use the global `fetch` with JSON bodies, and throw on non-2xx.
  - Add no adapters for `/v1/reconcile`, `/v1/approvals/*` or `/v1/ledger/verify` (contracts/l1-ports.md)

**Checkpoint**: Ports ready. Story phases can begin.

---

## Phase 3: User Story 1 - Agent buys a paid resource without holding payment authority (Priority: P1) 🎯 MVP

**Goal**: `fetchPaid(url, purpose)` covers FREE, the 402 challenge, authorize, the paid retry, verify and PAID/PAYMENT_FAILED/ERROR, with no key material in L1.

**Independent Test**: The $0.001 weather fetch ends PAID with a CONFIRMED settlement and an on-chain delta of exactly 1000 (T-E2E-01 step 2). At unit level, fake ports drive every branch of the state machine in data-model.md.

### Tests for User Story 1 ⚠️

> Write these first and make sure they fail before implementing.

- [X] T008 [P] [US1] Unit tests for the L1-1 FREE and ERROR branches in `test/agent.test.ts` (`describe("L1-1 orchestrator")`):
  - A network error returns `ERROR`.
  - A non-402 returns `FREE` with status and body, and makes no `gate.authorize` call.
  - A non-JSON body is returned as text "truncated to 2000 chars".
  - A missing `PAYMENT-REQUIRED` header with a JSON body uses the v1 fallback.
  - A missing header with a non-JSON body returns `ERROR` (FR-001..FR-003)
- [X] T009 [P] [US1] Unit tests for the L1-1 paid path in `test/agent.test.ts`:
  - The intent has `intentId` = `"int_" + uuid v4`, the `sessionId` constant for the process, and `paymentRequired` = "decoded challenge, **verbatim**, with all `accepts[]` entries".
  - `createdAt` is ISO-8601.
  - The retry carries `decision.paymentHeaders` byte-for-byte.
  - The claim has `paymentResponseHeader` set to the "raw `PAYMENT-RESPONSE` value, or `null`".
  - 2xx with CONFIRMED or PENDING returns `PAID`.
  - Non-2xx, MISMATCH or NOT_SETTLED return `PAYMENT_FAILED`, with the body only on 2xx.
  - A `gate.authorize` that throws gives `ERROR` and is never treated as AUTHORIZED.
  - A `settlement.verify` that throws after a 2xx paid retry gives `PAYMENT_FAILED` and keeps `payment` and `authorizationId` (008 T000, SPEC v1.1 L1-1) (FR-004, FR-006..FR-009)
- [X] T010 [P] [US1] Verify the T-E2E-01 test in `test/e2e.local.test.ts` (owned by 008 T024; harness `test/helpers/harness.ts`, 008) asserts step 2: the weather fetch is `PAID`/`CONFIRMED` and the payer delta is 1000 (requires 002, 003, 005, 006)

### Implementation for User Story 1

- [X] T011 [US1] In `src/layer1-intent/orchestrator.ts`, define the `PaidFetchResult` type with `outcome: FREE | PAID | DENIED | ESCALATED | PAYMENT_FAILED | ERROR`, plus `url`, `httpStatus`, `body`, `payment?: { authorizationId, amountAtomic, asset, network, payTo, settlement: SettlementReport }`, `violations?`, `authorizationId?` and `error?`, following the data-model.md presence rules
- [X] T012 [US1] Implement `PaidResourceOrchestrator` with constructor `{ gate, settlement, sessionId, fetchImpl? }` in `src/layer1-intent/orchestrator.ts`. It covers SPEC L1-1 steps 1–4 and 6–8:
  - Decode with `decodePaymentRequiredHeader` from `@x402/core/http`, never with hand-rolled base64 (R2).
  - Forward the headers opaquely (R3).
  - Always call `settlement.verify` after the paid retry (R4)
- [X] T013 [US1] Make sure `src/layer1-intent/orchestrator.ts` never decodes or re-encodes `PAYMENT-SIGNATURE` or `PAYMENT-RESPONSE`, and that amounts stay atomic strings with no `Number()` money math (NFR-003, NFR-007)

**Checkpoint**: US1 is fully functional against fake ports and, with 002/005/006 running, end to end.

---

## Phase 4: User Story 2 - Agent respects denials and escalations (Priority: P1)

**Goal**: A DENIED or ESCALATE decision stops the fetch and reports the rules and `authorizationId`, with zero follow-up seller requests.

**Independent Test**: In the scripted plan, step 4 is ESCALATED (`human_approval_required`), step 5 is DENIED (`hard_cap_exceeded`) and step 6 is DENIED (`host_not_allowed`), with no paid retry after any of them.

### Tests for User Story 2 ⚠️

- [X] T014 [P] [US2] Unit tests in `test/agent.test.ts`:
  - A DENIED decision returns `DENIED` with `violations` and `authorizationId`.
  - An ESCALATE decision returns `ESCALATED` with the same fields.
  - A counting fake seller sees exactly 1 request (the unpaid GET) in each case.
  - `settlement.verify` is never called (FR-005, SC-005)
- [X] T015 [P] [US2] Verify the T-E2E-01 test in `test/e2e.local.test.ts` (owned by 008 T024) asserts steps 4–6: the outcomes and rule IDs above (requires 002 R6, R10, R14)

### Implementation for User Story 2

- [X] T016 [US2] Implement the L1-1 step 5 early return in `src/layer1-intent/orchestrator.ts`: map `DENIED`→`DENIED` and `ESCALATE`→`ESCALATED`, carry `violations` and `authorizationId`, and do not retry (R5)

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 5 - Agent process refuses to run with the payer key (Priority: P1)

**Goal**: The composition root fails closed when `PAYER_PRIVATE_KEY` is visible. It resolves the session ID and prints the final budget.

**Independent Test**: `PAYER_PRIVATE_KEY=0x1 ENV_FILE=/dev/null npx tsx src/main.ts --scripted` exits with code 1 and a refusal message.

### Tests for User Story 5 ⚠️

- [X] T017 [P] [US5] Key-refusal test in `test/agent.test.ts`: spawn `tsx src/main.ts --scripted` with `PAYER_PRIVATE_KEY=0x1` and `ENV_FILE=/dev/null`. Assert exit code 1, a refusal on stderr, and no network calls (FR-019, SC-004, INV-3)
- [X] T018 [P] [US5] Prove the refusal test can fail: temporarily remove the check in `src/main.ts`, confirm T017 fails, restore the check, and record the result in the PR description (Principle VIII). Result (2026-10-16): with the check disabled, T017 failed (`expected +0 to be 1`); restored byte-for-byte, T017 passes.
- [X] T019 [P] [US5] Unit test in `test/agent.test.ts`: the session ID is `SESSION_ID` when set, and otherwise matches `/^sess_[0-9a-f]{8}$/` (FR-020)
- [X] T020 [P] [US5] Confirm `test/architecture.test.ts` covers L1. `src/layer1-intent/**` must:
  - import only `src/shared/**` and its own folder;
  - never reference `PAYER_PRIVATE_KEY`;
  - never call `privateKeyToAccount` or `mnemonicToAccount`.

  `src/main.ts` may reference the key only in the refusal check. Add L1 cases only; the test is owned by 007 (INV-1, INV-3, NFR-001)

### Implementation for User Story 5

- [X] T021 [US5] In `src/main.ts`, load env with `loadEnv()` (007, `src/shared/config.ts`; default `env/l1-agent.env`). 001 owns this refusal block. The first check after loading is: if `process.env.PAYER_PRIVATE_KEY` is set, print the refusal to stderr and call `process.exit(1)` before any network or LLM activity (R7, contracts/cli.md)
- [X] T022 [US5] In `src/main.ts`, resolve `sessionId = SESSION_ID ?? "sess_" + 8 hex`. Wire `HttpAuthorizationGate(CONTROL_URL, CONTROL_TOKEN)`, `HttpSettlementVerifier(SETTLEMENT_URL, VERIFIER_TOKEN)` and `PaidResourceOrchestrator`. On completion, print the final `BudgetStatus` from `gate.budget(sessionId)` (FR-020, FR-022)

**Checkpoint**: P1 stories are complete. This is the MVP.

---

## Phase 6: User Story 3 - LLM agent completes a goal with a bounded, safe toolset (Priority: P2)

**Goal**: A Claude tool-use loop with exactly two tools, bounded turns and tokens, and the system prompt duties.

**Independent Test**: T-AGT-01: a fake model client issues tool calls. Exactly 2 tools are offered, intents carry the model's `purpose`, and the tool result has PAID and CONFIRMED.

### Tests for User Story 3 ⚠️

- [X] T023 [P] [US3] T-AGT-01 in `test/agent.test.ts`. Use a fake `opts.client` that calls `fetch_resource` and then `end_turn`, and assert:
  - Every model request offers exactly the 2 tools in `specs/001-agent-paid-fetch/contracts/agent-tools.json`, by name and `input_schema`.
  - The recorded `PaymentIntent.purpose` equals the model's `purpose` input.
  - The tool-result JSON has `outcome: "PAID"` and `payment.settlement.status: "CONFIRMED"` (FR-013, FR-016, FR-017, SC-003, SC-006)
- [X] T024 [P] [US3] Unit tests in `test/agent.test.ts`:
  - A fake client that always returns `tool_use` stops after exactly 10 turns.
  - Every request has `max_tokens: 2048`.
  - With no `ANTHROPIC_MODEL`, the model is `claude-sonnet-5-5` (FR-012, NFR-006)
- [X] T025 [P] [US3] Unit test in `test/agent.test.ts`: the tool-result JSON has exactly the keys `{outcome, httpStatus, body, payment:{authorizationId, amountUsd, settlement:{status, tx, finality}}, violations, authorizationId, error}`, and `amountUsd` equals `formatAtomic(amountAtomic, decimals)` (FR-014, R8)
- [X] T026 [P] [US3] Unit test in `test/agent.test.ts`: the system prompt contains every L1-3 duty:
  - start at `<seller>/api/catalog`;
  - treat prices as atomic units;
  - buy only what the goal needs and prefer cheaper items;
  - never retry a DENIED payment and explain the rule;
  - report the `authorizationId` of an ESCALATED payment;
  - end with a receipt list (FR-015)

### Implementation for User Story 3

- [X] T027 [US3] Implement `runClaudeAgent({ goal, orchestrator, gate, sessionId, sellerUrl, client? })` in `src/layer1-intent/agent.ts`:
  - Use the `@anthropic-ai/sdk` Messages API, with `model = ANTHROPIC_MODEL ?? "claude-sonnet-5-5"` and `max_tokens: 2048`.
  - Run at most 10 turns and stop on `end_turn`.
  - Load the tool definitions verbatim from contracts/agent-tools.json, with **no other tools** (R6, SEC-1)
- [X] T028 [US3] Implement the tool dispatch in `src/layer1-intent/agent.ts`. `fetch_resource` calls `orchestrator.fetchPaid(url, purpose)` and maps the result to the tool-result JSON, with `amountUsd` for display only. `check_budget` calls `gate.budget(sessionId)`. An unknown tool name returns an error result and never performs an action
- [X] T029 [US3] Write the system prompt in `src/layer1-intent/agent.ts` with the six L1-3 duties (FR-015)
- [X] T030 [US3] Wire LLM mode in `src/main.ts`: without `--scripted`, call `runClaudeAgent` with the goal from argv, or a default goal, and print the final answer (FR-021)

**Checkpoint**: The LLM agent works with a fake client, and with a real key in `demo:local -- --llm`.

---

## Phase 7: User Story 4 - Deterministic scripted agent as the regression baseline (Priority: P2)

**Goal**: An LLM-free six-step plan that yields `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`.

**Independent Test**: The T-E2E-01 outcome sequence matches exactly on every run.

### Tests for User Story 4 ⚠️

- [X] T031 [P] [US4] Unit test in `test/agent.test.ts`: `runScriptedAgent` requests, in order:
  1. `/api/catalog`
  2. `/api/weather?city=Lima`
  3. `/api/market-brief`
  4. `/api/premium-report`
  5. `/api/dataset-export`
  6. `/api/weather?city=Lima` via host `localhost`

  Assert that it returns the six `PaidFetchResult`s in order (FR-018, NFR-005)
- [X] T032 [P] [US4] Verify the T-E2E-01 test in `test/e2e.local.test.ts` (owned by 008 T024) asserts the full outcome sequence `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]` and that 008 T025 covers repeat-run determinism (SC-001, NFR-005)

### Implementation for User Story 4

- [X] T033 [US4] Implement `runScriptedAgent({ orchestrator, sellerUrl })` in `src/layer1-intent/scripted.ts`. It runs the fixed six-step plan from SPEC L1-4, building step 6 by swapping the seller host to `localhost` (same port), prints one line per step, and returns the results
- [X] T034 [US4] Wire `--scripted` in `src/main.ts` to `runScriptedAgent`, needing no `ANTHROPIC_API_KEY` (FR-021, contracts/cli.md)

**Checkpoint**: All five stories work independently.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T035 [P] Run `npm run typecheck` and fix L1 type errors in `src/layer1-intent/*.ts` and `src/main.ts`
- [X] T036 [P] Search `src/layer1-intent/` and `src/main.ts` for `Number(`, `parseFloat`, `atob`, `btoa` and `Buffer.from(` on amounts or headers, and remove any money or header misuse (Principles VI, VII)
- [ ] T037 Run `specs/001-agent-paid-fetch/quickstart.md` steps 1–5 and record the results (requires 002, 003, 005, 006 and 008 for steps 2–5)
- [X] T038 [P] Verify these items are covered by 008 T000 (SPEC.md v1.1 amendment) in `SPEC.md`: L1-3 tool `description` strings from contracts/agent-tools.json; L1-1 "settlement.verify throws after a 2xx paid retry → `PAYMENT_FAILED` keeping `payment` and `authorizationId`"; §12 automated key-refusal test (T017) (Governance)

---

## Dependencies & Execution Order

### Phase Dependencies

- **All tasks depend on 008 T000** (SPEC.md v1.1 amendment gate).
- **Setup (Phase 1)**: requires the 008 M0 scaffold (package.json, tsconfig, vitest).
- **Foundational (Phase 2)**: requires Setup. T004 creates `src/shared/contracts.ts`, which 001 owns. **The Foundational phases of 002, 003 and 005 depend on 001 T004.** Blocks all stories.
- **US1 (Phase 3)**: requires Foundational. The unit tests run with fake ports. The e2e checks need 002, 005 and 006.
- **US2 (Phase 4)**: requires Foundational. It extends `orchestrator.ts` and runs after T012 because it edits the same file.
- **US5 (Phase 5)**: requires Foundational and T012 for wiring. Its tests do not depend on US2.
- **US3 (Phase 6)**: requires US1 (the orchestrator) and T022 (main wiring).
- **US4 (Phase 7)**: requires US1, plus US2 for steps 4–6 to give the expected outcomes, and T022.
- **Polish (Phase 8)**: after the stories you want are done.

### Cross-feature blockers

- 002: `POST /v1/authorize` and `GET /v1/budget/:sessionId`
- 005: `POST /v1/settlements`
- 006: seller routes, local chain and facilitator
- 006: `formatAtomic` in `src/shared/config.ts`
- 007: architecture test harness and `env/*.env.example`
- 008: T000 SPEC gate, scaffold and `package.json` scripts, the harness `test/helpers/harness.ts`, and the T-E2E-01 test block (T024)

### Within Each User Story

Tests come first and must fail, then types, then implementation, then wiring.

### Parallel Opportunities

- T002 and T003 can run together. T005 and T006 can run together.
- Within each story, all test tasks marked [P] can run together because they are separate `describe` blocks. They share `test/agent.test.ts`, so coordinate the edits or merge them in order.
- The US5 tests (T017–T020) can be written alongside US1 implementation.

---

## Parallel Example: User Story 1

```bash
Task: "T008 Unit tests for L1-1 FREE/ERROR branches in test/agent.test.ts"
Task: "T009 Unit tests for L1-1 paid path in test/agent.test.ts"
Task: "T010 T-E2E-01 step 2 assertion in test/e2e.local.test.ts"
```

## Parallel Example: User Story 3

```bash
Task: "T023 T-AGT-01 in test/agent.test.ts"
Task: "T024 turn and token bounds test in test/agent.test.ts"
Task: "T025 tool-result shape test in test/agent.test.ts"
Task: "T026 system prompt duties test in test/agent.test.ts"
```

---

## Implementation Strategy

### MVP First (P1 stories: US1, US2, US5)

1. Phase 1 Setup, then Phase 2 Foundational (ports).
2. US1: the orchestrator paid path. Validate it with fake ports.
3. US2: no-retry on DENIED and ESCALATE.
4. US5: the composition root with key refusal.
5. **STOP and VALIDATE**: unit tests green, the key refusal exits 1, and the architecture test is green for L1.

### Incremental Delivery

1. MVP: a scripted call path can be driven from `main.ts` with real L2/L3.
2. Add US4: the scripted baseline gives T-E2E-01 `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`.
3. Add US3: the LLM agent passes T-AGT-01, and `demo:local -- --llm` works.

---

## Notes

- `[P]` means a different file or an independent `describe` block, with no dependency on an incomplete task.
- Reference requirement IDs (L1-*, INV-*, T-*) in commit messages and test names.
- Never weaken INV-1, INV-3 or INV-13 to make a test pass.
