---
description: "Task list for 008 Local Demo, Regression Baseline & Operability"
---

# Tasks: Local Demo, Regression Baseline & Operability

**Input**: Design documents from `specs/008-local-demo-regression/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (npm-scripts, demo-local, e2e-harness, dod-and-milestones), quickstart.md

**Tests**: Required by Constitution Principle VIII and by the spec (T-E2E-01, SC-001..SC-007).
Test tasks come before implementation in each story phase.

**Organization**: Grouped by user story (US1–US4 from spec.md). This feature owns no layer
logic. Where it depends on another feature, the task names that feature's number instead of
repeating its tasks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4

---

## Phase 1: Setup (M0 scaffold, owned by 008)

**Purpose**: The project skeleton that every other feature builds on, plus the SPEC v1.1 gate.

- [X] T000 Write the SPEC.md v1.1 amendment as one change. File: `SPEC.md`. **Every other feature's tasks depend on this gate.** For each item, either accept it into SPEC or drop it from that feature's plan and tasks. The constitution stays at v1.0.0, because no principle changes.
  - §6/§12 test files: `test/helpers/harness.ts`, `test/counterparty.test.ts`, `test/verifier.test.ts`, `test/settlement-service.test.ts`, `test/auth.test.ts`, `test/demo.local.test.ts`, `test/fixtures/arch/`; new IDs T-AUTH-01/02 and T-ARCH-ENV; the automated key-refusal test (001 T017). (`scripts/check-m3.ts` is dropped; 006 T013 owns the M3 check.)
  - §3.1/§6/CP-2: the facilitator entry point moves to `scripts/facilitator.ts`, and `src/counterparty/facilitator.ts` becomes a factory that takes a ready account. INV-2 is unchanged.
  - §8.1 L1-3: the tool description strings (001). L1-1: if verify throws after a 2xx paid retry, the result is `PAYMENT_FAILED` and keeps `payment` (001-U1).
  - §8.2 L2-1: a mandate that breaks the constraint fails startup.
  - §8.2 L2-5: `/v1/budget` for an unknown session returns 200 with zero spend, and `remaining` is floored at 0; reconcile runs inside the mutex; a malformed reconcile body returns 400; approvals return 400 on a bad `ttlSeconds`; `approver` defaults to `"operator"`.
  - §8.2 L2-4: `brokenAt` is the 0-based line index, and `seq` starts at 0. `HUMAN_APPROVAL.data.approvalId` is `apr_<uuid>`.
  - §8.2 L2-4.2/L2-4: each approval is single-use and consumed by its own `approvalId`. `AUTHORIZED.data.approvalRef` is `approvalId` or `null`. Re-approving creates a new approval (200).
  - §8.3 L3-1: one shared 45 s deadline. L3-2: a new PENDING schedule replaces the old one and stops at a terminal status; the reconcile push times out after 5 s.
  - §8.4 CP-1/2/5: the `deployment.json` schema, facilitator error bodies, the weather seed, and the MockUSDC extras.
  - §9 CFG-2: tokens fail closed off local; the `ENV_FILE` defaults; the demo filters each child's environment; the demo derives the local payer and facilitator keys from the CP-5 mnemonic in `scripts/local-chain-lib.ts`.
  - §4 architecture test rules (007): A2 (no re-export of layer code through `shared/`), A6 policy purity (incl. 002's banned tokens `console.`, `node:fs`, code access to `purpose`), A7 (no hand-rolled base64 for x402 headers); A4 adds `sendTransaction` and `privateKeyToAccount` to the INV-4 identifiers; tokens are compared in constant time (hardening). INV-12 clarification: "once" means once per approval, and each approval is a separate human act.
  - §8.2 L2-4 (003): the MISMATCH detail is `"verified field mismatch: <fields>"`; canonical JSON omits absent optional fields. L2-4.2 (003/004): `findOpenApproval` returns the most recent open approval for (session, resourceKey).
  - §8.3 L3-2 (005): auth (401) is checked before body validation (400); 400 when `authorizationId` is not a string or `requirement` is not an object. §6/§12 also add `test/helpers/fake-public-client.ts`.
  - §8.4 CP-5/CFG-1 (006): a missing `.local/deployment.json` fails fast for anything that needs the asset. CP-4 MockUSDC extras are `DOMAIN_SEPARATOR()`, a revert when the signer is not `from`, and a revert on insufficient balance.
  - §11: fix SEC-3's test column from "T-POL-05/07/08" to "T-POL-05/11".
  - §13: the demo exit codes 0/1/2; `npm run check`; the approve CLI exit codes 0/1/2.
- [X] T001 Create `package.json` with `"type": "module"`, Node 22 engines, and dependencies pinned per SPEC.md §5: tsx ^4.23, typescript ^7.0, vitest ^5.0, dotenv ^18, viem ^2.57, express ^5.3, `@x402/core`/`@x402/evm`/`@x402/express` 2.28.0, `@anthropic-ai/sdk` ^0.135, ganache 7.9.2, solc 0.8.24. File: `package.json`
- [X] T002 Add every script from contracts/npm-scripts.md to `package.json`: `typecheck`, `test`, `demo:local`, `local:chain`, `facilitator`, `seller`, `l2:control`, `l3:verifier`, `agent`, `agent:scripted`, `approve`. Each runs through `tsx` with the exact commands in the contract table.
- [X] T003 [P] Create `tsconfig.json` with `strict: true`, `module`/`moduleResolution: "NodeNext"`, `noEmit: true`, and include `src`, `scripts`, `test`. File: `tsconfig.json`
- [X] T004 [P] Create `vitest.config.ts` with `fileParallelism: false`, `testTimeout: 120000` and `hookTimeout: 120000` (NFR-003, NFR-004, research R2). File: `vitest.config.ts`
- [X] T005 [P] Create `.gitignore` covering `node_modules/`, `.local/` and `env/*.env`, while keeping `env/*.env.example` tracked (FR-017). File: `.gitignore`
- [X] T006 Run `npm install` (never `npm ci`, research R1). Create `src/index.ts` containing only `export {};`, so `tsc` has an input and doesn't fail with TS18003 (no inputs). Confirm `npm run typecheck` passes; this is the M0 exit check. Delete `src/index.ts` in M1, once `src/shared/` exists.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared e2e harness that every e2e test uses (US1 and US2 depend on it).

**⚠️ Blocking**: Requires features 006 (local chain lib, seller, facilitator), 002/003 (L2 service), 005 (L3 service) and 001 (scripted agent, port adapters). Stub imports until they land.

- [X] T007 Define the `HarnessOptions` and `Harness` interfaces exactly as in contracts/e2e-harness.md (`signerLatencyMs?`, `ports?`, `mandateOverrides?`; `urls`, `tokens`, `addresses`, `balanceOf`, `ledgerPath`, `close`). File: `test/helpers/harness.ts`
- [X] T008 Implement `startHarness()` in `test/helpers/harness.ts` (research R3):
  - Start the local chain through 006's `scripts/local-chain-lib.ts`.
  - Start the facilitator, seller, L2 and L3 in-process.
  - Bind the seller on `0.0.0.0`; the allowlisted host is `127.0.0.1:<seller>` and the alias is `localhost:<seller>` (research R4).
  - Use a fresh temp ledger file per harness.
- [X] T009 Implement `close()` in `test/helpers/harness.ts`. It stops every server and the chain and frees all ports, and it is called from `afterAll` even when a test fails.
- [X] T010 Add a `balanceOf(addr)` helper that returns `bigint`, using a viem public client (read-only). File: `test/helpers/harness.ts`

**Checkpoint**: A smoke test can start and close the harness, with no listeners left afterwards.

---

## Phase 3: User Story 1 — One-command local demo proves the whole flow (P1) 🎯 MVP

**Goal**: `npm run demo:local` starts all six processes, runs the scripted agent, prints the fixed summary and leaves no listeners behind.

**Independent Test**: On a clean machine, run `npm run demo:local`. It exits 0 and prints `spent on-chain: 0.006 USDC` and `hash chain ok=true`. Afterwards, `lsof -i :8545 -i :4020-4023` is empty (SC-001, SC-002).

### Tests for User Story 1

- [X] T011 [P] [US1] Write a demo smoke test that runs `npm run demo:local` as a child process. It asserts exit code 0, that stdout contains the contract strings `spent on-chain: 0.006 USDC` and `hash chain ok=true`, and that no listener remains on 8545 or 4020–4023 (SC-001, SC-002). File: `test/demo.local.test.ts`
- [X] T012 [P] [US1] Add a port-preflight test: occupy port 4021, run the demo, and expect exit code 1 with a "port busy" message and no fallback port (research R6). File: `test/demo.local.test.ts`

### Implementation for User Story 1

- [X] T013 [US1] Add a port preflight to `scripts/demo-local.ts`. Before spawning anything, check 8545 and 4020–4023 (or the env-overridden ports). Abort with exit 1 if any is busy.
- [X] T014 [US1] Implement the `DemoProcess` table in `scripts/demo-local.ts` from data-model.md: role `chain | facilitator | seller | l2 | l3 | agent`, used only as the log prefix. Command: `npx tsx <entry>`; the facilitator's is `npx tsx scripts/facilitator.ts`. Explicit envFile per role: chain → none, facilitator → `env/facilitator.env`, seller → `env/seller.env`, l2 → `env/l2-control.env`, l3 → `env/l3-verifier.env`, agent → `env/l1-agent.env`. Ports: 8545, 4022, 4021, 4020, 4023.
- [X] T015 [US1] Build each child's environment in `scripts/demo-local.ts`:
  - Children inherit only `PATH`, `HOME` and `NODE_*` from the parent, plus their own `ENV_FILE`.
  - If a role's envFile is missing, fall back to the matching `.example` values. For example, l2 falls back to `env/l2-control.env.example`.
  - On `NETWORK=local`, if `env/l2-control.env` is missing, derive account #2's key with 006's `scripts/local-chain-lib.ts` helper (CP-5 mnemonic) and pass it **only** to the l2 child as `PAYER_PRIVATE_KEY`. Likewise, if `env/facilitator.env` is missing, pass account #1's key **only** to the facilitator child as `FACILITATOR_PRIVATE_KEY`.
  - `PAYER_PRIVATE_KEY` goes only to l2 (contracts/demo-local.md).
- [X] T016 [US1] Spawn children in `scripts/demo-local.ts` with `detached: true`, so pgid = pid. Prefix child output with `[chain] [fac] [seller] [l2] [l3] [agent]` (FR-006).
- [X] T017 [US1] Implement readiness probes in `scripts/demo-local.ts`, polling every 250 ms for up to 30 s. A timeout means exit 1.

  | Role | Ready when |
  |---|---|
  | chain | `eth_chainId` returns `0x7a69` and `.local/deployment.json` exists |
  | facilitator | `GET /supported` returns 200 |
  | seller | `GET /api/catalog` returns 200 |
  | l2 | `GET /v1/budget/<sessionId>` returns 200 |
  | l3 | TCP connect succeeds |

- [X] T018 [US1] Implement shutdown in `scripts/demo-local.ts` (FR-006, NFR-001, research R5).
  - Triggers: the agent exits, a child crashes, readiness times out, or SIGINT/SIGTERM arrives.
  - For every started child, in reverse order: `process.kill(-pid, "SIGTERM")`, then `SIGKILL` after 3 s.
- [X] T019 [US1] Drop the ganache `uws` native-binding fallback warning from forwarded output (FR-007, NFR-007, research R7). File: `scripts/demo-local.ts`
- [X] T020 [US1] Compute `DemoSummary` from authoritative sources only (research R8). File: `scripts/demo-local.ts`
  - Payer `balanceOf` delta in BigInt, formatted with `formatAtomic`, owned by feature 006 in `src/shared/config.ts`; import it, never redefine it.
  - `GET /v1/budget/:sessionId` (feature 002).
  - `GET /v1/ledger/verify` with the operator token (feature 003).
- [X] T021 [US1] Print the summary block in the exact format from contracts/demo-local.md, last in the output. Implement exit codes: 0 when the baseline matches, 2 on a baseline mismatch, 1 for port, readiness or crash failures. File: `scripts/demo-local.ts`
- [ ] T022 [US1] Support `-- --llm` (FR-004, research R9). Run `src/main.ts` without `--scripted`, skip the baseline assertion, and exit 0 when the chain is ok. File: `scripts/demo-local.ts`
- [X] T023 [US1] Safety proof for NFR-001: temporarily kill children by pid instead of process group. Record that port 8545 stays open, so T011 fails. Restore, then note the result in `specs/008-local-demo-regression/quickstart.md`.

**Checkpoint**: US1 is fully runnable, and T011–T012 pass.

---

## Phase 4: User Story 2 — Scripted plan is a deterministic regression baseline (P1)

**Goal**: T-E2E-01 asserts the full baseline on a fresh harness.

**Independent Test**: `npx vitest run test/e2e.local.test.ts -t "T-E2E-01"` passes (SC-003).

### Tests for User Story 2

- [X] T024 [US2] Write `T-E2E-01 scripted baseline` in `test/e2e.local.test.ts` (008's T024 is the **only** writer of the T-E2E-01 block; 001's T010, T015 and T032 review it rather than adding assertions). It runs the scripted agent (feature 001) against `startHarness()` with the default mandate and checks all eight assertions from contracts/e2e-harness.md:

  | # | Assertion |
  |---|---|
  | 1 | outcomes deep-equal `["FREE","PAID","PAID","ESCALATED","DENIED","DENIED"]` |
  | 2 | step 4 violations ⊇ `human_approval_required` |
  | 3 | step 5 violations ⊇ `hard_cap_exceeded` |
  | 4 | step 6 violations ⊇ `host_not_allowed` |
  | 5 | payer delta `=== 6000n`, and payTo gains exactly 6000n |
  | 6 | exactly 2 non-anomalous CONFIRMED `SETTLEMENT` entries |
  | 7 | `/v1/ledger/verify` returns `ok: true` |
  | 8 | `/v1/budget` `spentOrReservedAtomic === "6000"` |

- [X] T025 [US2] Add a determinism check (NFR-002): run the scripted plan twice in fresh harnesses and assert identical outcome sequences and deltas. File: `test/e2e.local.test.ts`
- [X] T026 [US2] Negative control: temporarily change one catalog price (feature 006) or the default mandate's `autoApproveMaxAtomic`. Confirm T-E2E-01 fails, then revert. Record the result in `specs/008-local-demo-regression/quickstart.md`.

### Implementation for User Story 2

- [X] T027 [US2] Encode the `RegressionBaseline` constant from data-model.md: outcomes `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`, `onChainDeltaAtomic` `"6000"`, `confirmedSettlements` 2, `ledgerChainOk` `true`, `spentOrReservedAtomic` `"6000"`. Share it between the T-E2E-01 test and the demo summary check. File: `test/helpers/harness.ts`
- [X] T028 [US2] Make `scripts/demo-local.ts` compare its summary with `RegressionBaseline` (via T027) and exit 2 on a mismatch.

**Checkpoint**: T-E2E-01 is green, and a regression in any layer turns it red.

---

## Phase 5: User Story 3 — A clear definition of done gates every change (P1)

**Goal**: The DoD gates G1–G7 are documented, runnable and enforced by review.

**Independent Test**: Run G1–G3 in order on a clean tree, and each produces its pass condition from contracts/dod-and-milestones.md.

- [X] T029 [P] [US3] Write a `## Definition of done` section in `README.md` listing gates G1–G7 with their exact commands and pass conditions, copied from contracts/dod-and-milestones.md (FR-011, FR-012, FR-013).
- [X] T030 [P] [US3] Add an `npm run check` script to `package.json` that chains `typecheck && test && demo:local`. This is G1–G3 in one command.
- [X] T031 [US3] Verify NFR-005 and SC-004 depend on feature 002's T-E2E-04: confirm it keeps `signerLatencyMs: 25` and that its documented fail-without-mutex result (15/15) is cited in the README DoD section (G6). File: `README.md`

**Checkpoint**: `npm run check` runs G1–G3, and the README states G4–G7.

---

## Phase 6: User Story 4 — Rebuild from scratch by milestones (P2)

**Goal**: Each milestone M0–M7 has a runnable exit check.

**Independent Test**: For each milestone, run its exit command and see the pass condition (SC-005).

- [X] T032 [P] [US4] Add a `## Build order (M0–M7)` section to `README.md` with the milestone table from contracts/dod-and-milestones.md: deliverables, owning features, exit command and pass condition.
- [X] T033 [US4] Verify the M3 milestone gate by running feature 006's T013 test (unpaid `GET /api/weather?city=Lima` → 402, and `PAYMENT-REQUIRED` decodes with the SDK helper) and recording the result in `specs/008-local-demo-regression/contracts/dod-and-milestones.md`. 008 does not add its own M3 script.
- [X] T034 [US4] Walk M0 → M7 on a clean checkout, running each exit check in order. Record pass/fail per milestone in `specs/008-local-demo-regression/quickstart.md` (FR-014).

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T035 [P] Document the Base Sepolia run in `README.md` (FR-015, FR-016, SC-007):
  - one terminal each for `seller`, `l2:control`, `l3:verifier` and `agent`;
  - fund the payer with test USDC at faucet.circle.com;
  - the hosted facilitator pays gas.
- [X] T036 [P] Add a `## Known gotchas` section to `README.md` covering SPEC.md §16: `npm install` not `npm ci`, the uws warning, IPv6-less binding, `signerLatencyMs`, and the Base Sepolia EIP-712 name `"USDC"`.
- [ ] T037 Validate portability (NFR-006, SC-006): run `npm install && npm test` on macOS and on a Linux container without IPv6. Record the results in `specs/008-local-demo-regression/quickstart.md`.
- [X] T038 Run quickstart.md end to end and fix any drift between it and the contracts.

---

## Dependencies & Execution Order

- **T000 (SPEC v1.1 gate)**: no dependencies. Every other feature's tasks wait for it.
- **Setup (T001–T006)**: no dependencies other than T000. This is M0 and blocks every other feature.
- **Foundational (T007–T010)**: needs Setup, plus features 001, 002, 003, 005 and 006 implemented. Blocks US1 and US2.
- **US1 (T011–T023)**: needs Foundational. US1's baseline exit code depends on T027 from US2, so build T027 before T021, or exit 0 unconditionally until then.
- **US2 (T024–T028)**: needs Foundational. It is independent of US1, except that T028 edits the demo script.
- **US3 (T029–T031)**: needs US1 and US2 for G3. T031 needs feature 002's T-E2E-04.
- **US4 (T032–T034)**: needs all features (M1–M7 belong to 001–007).
- **Polish**: after the desired stories.

Within a story, tests come before implementation, and edits to the same file (`scripts/demo-local.ts`) run sequentially.

## Parallel Examples

```text
# Setup
T003 tsconfig.json  |  T004 vitest.config.ts  |  T005 .gitignore

# US1 tests
T011 demo smoke test  |  T012 port-preflight test   (same file; write together, run separately)

# Docs
T029 README DoD  |  T032 README milestones  |  T035 README Base Sepolia  |  T036 README gotchas
(different sections of one file: parallel drafting, then merge sequentially)
```

## Implementation Strategy

- **MVP (P1)**: Setup → Foundational → US2 (T-E2E-01 baseline) → US1 (demo) → US3 (DoD). That gives a one-command demo plus an automated regression gate.
- **Increment 2 (P2)**: US4 milestone checks.
- **Polish**: Base Sepolia docs, gotchas, portability run.
- Stop at each checkpoint and validate the story on its own.
