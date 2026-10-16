---

description: "Task list for 007 — Process Isolation & Security Model"
---

# Tasks: Process Isolation & Security Model

**Input**: Design documents from `specs/007-process-isolation-security/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (architecture-rules, auth-roles, env-templates, process-topology, threat-matrix), quickstart.md

**Tests**: Tests are REQUIRED here. Constitution Principle VIII demands an automated test for every invariant, and spec IDs T-ARCH-*, T-E2E-05 and SC-001..SC-006 name them. Every safety mechanism also gets a must-fail proof.

**Organization**: Tasks are grouped by user story so each story can be implemented and verified on its own.

**Beyond-SPEC items**: Tasks marked **(depends on 008 T000)** cover the plan's additions: rules A2, A6 and A7, the extra A4 identifiers, tests T-AUTH-01/02 and T-ARCH-ENV, the fail-closed token config, `test/auth.test.ts`, `test/fixtures/arch/` and the constant-time compare. 008 T000 (the SPEC.md v1.1 amendment) accepts or drops each item before any task here merges.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: The user story the task belongs to (US1–US5)

## Path Conventions

Single project (SPEC.md §6): `src/`, `test/`, `env/` and `scripts/` at the repository root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create this feature's folders and confirm the tooling it relies on.

- [X] T001 Create the folders `test/fixtures/arch/` and `env/`, and add `test/fixtures/arch/README.md` saying that the fixtures are never imported by `src/` and are scanned only by virtual path
- [X] T002 [P] Check that `typescript` is a dev dependency in `package.json`. It is needed for the TS-aware import extraction in research.md. If it is missing, raise it against 008, which owns M0 and `package.json`. Do not edit the scripts.
- [X] T003 [P] Check that `.gitignore` (owned by 008) ignores `env/*.env` but not `env/*.env.example`, and ignores any root `.env`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The scanner core and config primitives that every story uses.

**⚠️ CRITICAL**: No user story work starts until this phase is complete.

- [X] T004 Implement a pure `checkFile(path, source): ArchViolation[]` in `test/architecture.test.ts`.
  - It extracts import, export-from and dynamic-import specifiers plus identifiers with the TypeScript compiler API.
  - It must do no file-system or network I/O (NFR-004).
  - `ArchViolation` = `{ rule: "A1".."A7", file: repository-relative path, line: number, detail: offending specifier or identifier }`.
- [X] T005 Add the layer map to `test/architecture.test.ts`, following contracts/architecture-rules.md "Layers and scope":
  - `src/shared/**` → shared, `src/layer1-intent/**` → L1, `src/layer2-control/**` → L2, `src/layer3-settlement/**` → L3, `src/counterparty/**` → CP.
  - `src/main.ts`, `scripts/**` and `test/**` are composition (exempt from A1).
  - Resolve relative specifiers to repository paths before classifying them.
- [X] T006 Add the source walk and the aggregate assertion to `test/architecture.test.ts`. It globs `src/**/*.ts`, runs `checkFile` on each file, and prints every violation as `A<n> <file>:<line> <detail>`, not just the first. It asserts that the list is empty.
- [X] T007 [P] Add `loadEnv()` to `src/shared/config.ts`. It loads exactly one file: `ENV_FILE`, or the role's `env/<role>.env` by default. It uses dotenv without override, so variables already set in the process environment win. It never loads a root `.env` (FR-015).
- [X] T008 [P] Add port and bind constants to `src/shared/config.ts`, following contracts/process-topology.md:
  - Ports: `CONTROL_PORT` (4020), `SELLER_PORT` (4021), `FACILITATOR_PORT` (4022) and `SETTLEMENT_PORT` (4023), each overridable.
  - `CONTROL_BIND_HOST` and `SETTLEMENT_BIND_HOST` are the constant `"127.0.0.1"`, which is not configurable.

**Checkpoint**: the scanner runs (and passes vacuously on an empty tree), and config primitives exist.

---

## Phase 3: User Story 1 - The agent can never sign a payment (Priority: P1) 🎯 MVP

**Goal**: L1 cannot reference the payer key. Only `signer.ts` turns key material into an account. The agent process refuses to start if the payer key is visible.

**Independent Test**: Run `PAYER_PRIVATE_KEY=0x1 ENV_FILE=/dev/null npx tsx src/main.ts --scripted`. It must exit 1 with a refusal message. Rules A3 and A5 must also pass on `src/` and fail on their fixtures (SC-001, SC-002).

### Tests for User Story 1

- [X] T009 [P] [US1] Add the T-ARCH-INV3 rule A5 negative fixture `test/fixtures/arch/a5-violation.ts`. It is given the virtual path `src/layer1-intent/leak.ts` and contains exactly one `PAYER_PRIVATE_KEY` reference.
- [X] T010 [P] [US1] Add the T-ARCH-INV2 rule A3 negative fixture `test/fixtures/arch/a3-violation.ts`. It is given the virtual path `src/layer1-intent/acct.ts` and contains exactly one `privateKeyToAccount` call.
- [X] T011 [US1] Add assertions to `test/architecture.test.ts`:
  - `checkFile(a5 fixture).map(v => v.rule)` deep-equals `["A5"]`.
  - `checkFile(a3 fixture).map(v => v.rule)` deep-equals `["A3"]`.
  - These are the must-fail proofs.
- [X] T012 [US1] Add T-ARCH-INV2 to `test/architecture.test.ts`. Across `src/**`, `privateKeyToAccount` and `mnemonicToAccount` occur only in `src/layer2-control/signer.ts` (SC-002 "exactly 1" module; no exemption, the facilitator derives its account in `scripts/facilitator.ts`). This is a key-to-account count assertion.

### Implementation for User Story 1

- [X] T013 [US1] Implement rule A5 (INV-3) in `checkFile` in `test/architecture.test.ts`. Within `src/layer1-intent/**`, any string literal or identifier `PAYER_PRIVATE_KEY` is a violation.
- [X] T014 [US1] Implement rule A3 (INV-2) in `checkFile` in `test/architecture.test.ts`. The scope is `src/**` except `src/layer2-control/signer.ts`, with no other exemption (`scripts/**` is out of scope). These are violations: the identifiers `privateKeyToAccount` and `mnemonicToAccount`, and any import of `viem/accounts`.
- [X] T015 [US1] Verify the refusal block in `src/main.ts` (owned by 001 T021) matches FR-010. It runs first, right after `loadEnv()`. If `process.env.PAYER_PRIVATE_KEY !== undefined`, it prints the refusal to stderr and calls `process.exit(1)` before any network or LLM activity. It refuses on *presence*, not validity (FR-010).
- [X] T016 [US1] Run the manual check from quickstart.md §4 and record the result in `specs/007-process-isolation-security/quickstart.md`. Expect `exit=1` both with `--scripted` and in LLM mode (SC-001).

**Checkpoint**: The agent cannot sign; A3/A5 are enforced and proven to fail on violation.

---

## Phase 4: User Story 2 - Layer boundaries hold at module level (Priority: P1)

**Goal**: No layer imports another layer's code. L3 has no write or sign capability. Shared code cannot launder layer code.

**Independent Test**: Plant a cross-layer import fixture. The architecture test must report `A1` with file and line. On the real `src/`, the test must report 0 violations (SC-002).

### Tests for User Story 2

- [X] T017 [P] [US2] Add the T-ARCH-INV1 rule A1 fixture `test/fixtures/arch/a1-violation.ts`. It is given the virtual path `src/layer1-intent/x.ts` and contains exactly one `import … from "../layer2-control/policy.js"`.
- [X] T018 [P] [US2] Add the T-ARCH-INV4 rule A4 fixture `test/fixtures/arch/a4-violation.ts`. It is given the virtual path `src/layer3-settlement/x.ts` and contains exactly one `createWalletClient` call.
- [X] T019 [P] [US2] Add the rule A2 fixture `test/fixtures/arch/a2-violation.ts` **(depends on 008 T000)**. It is given the virtual path `src/shared/x.ts` and contains exactly one `export * from "../layer2-control/signer.js"`.
- [X] T020 [P] [US2] Add the rule A6 fixture `test/fixtures/arch/a6-violation.ts` **(depends on 008 T000)**. It is given the virtual path `src/layer2-control/policy.ts` and contains exactly one `Date.now()`.
- [X] T021 [P] [US2] Add the rule A7 fixture `test/fixtures/arch/a7-violation.ts` **(depends on 008 T000)**. It is given the virtual path `src/layer1-intent/x.ts` and contains `Buffer.from(h, "base64")` in a file that mentions `PAYMENT-REQUIRED`.
- [X] T022 [US2] Add must-fail assertions to `test/architecture.test.ts`. For n ∈ {1, 2, 4, 6, 7}, `checkFile(a<n> fixture).map(v => v.rule)` deep-equals `["A<n>"]`.

### Implementation for User Story 2

- [X] T023 [US2] Implement rule A1 (INV-1) in `checkFile` in `test/architecture.test.ts`. An import from a layer folder that resolves into another layer's folder is a violation. Package imports are allowed unless another rule forbids them.
- [X] T024 [US2] Implement rule A4 (INV-4) in `checkFile` in `test/architecture.test.ts`. Within `src/layer3-settlement/**`, these identifiers are violations: `createWalletClient`, `signTypedData`, `writeContract`, `sendTransaction`, `privateKeyToAccount`.
- [X] T025 [US2] Implement rule A2 in `test/architecture.test.ts` **(depends on 008 T000)**. It fails when `src/shared/**` imports or re-exports any layer or counterparty folder.
- [X] T026 [US2] Implement rule A6 (INV-5) in `test/architecture.test.ts` **(depends on 008 T000)**. It applies to `src/layer2-control/policy.ts` only. These are violations:
  - imports of `node:*`, `fs`, `http`, `express`, `viem` and `@anthropic-ai/*`;
  - `Date.now`, `new Date(` with no arguments, `fetch(` and `Math.random`;
  - `console.`, `node:fs`, and identifier access to `purpose` such as `ctx.purpose` (comments ignored). This merges 002 T020's banned list; 007 is the single owner of the purity check.
- [X] T027 [US2] Implement rule A7 (§10) in `test/architecture.test.ts` **(depends on 008 T000)**. Across all layer folders, `Buffer.from(…, "base64")`, `atob` or `btoa` is a violation in a file that also mentions `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` or `PAYMENT-RESPONSE`.
- [X] T028 [US2] Do a negative-control run: temporarily add a real cross-layer import to a scratch file under `src/layer1-intent/`, confirm `npx vitest run test/architecture.test.ts` fails with `A1 <file>:<line>`, then remove the file. Record the result in quickstart.md §2.

**Checkpoint**: INV-1 and INV-4 are enforced in CI; all seven rules have must-fail fixtures.

---

## Phase 5: User Story 3 - Each caller role has its own credential (Priority: P1)

**Goal**: Each of the four roles uses its own bearer token, and each endpoint accepts exactly one role. A wrong or missing token gets a 401 with no side effects. L2 and L3 listen on loopback only.

**Independent Test**: Call each protected endpoint with every other role's token. All calls return 401, and the ledger length is unchanged (SC-003). L2 and L3 are not reachable on a non-loopback interface (SC-006).

### Tests for User Story 3

- [X] T029 [P] [US3] Add a unit test for `requireRole` in `test/auth.test.ts`, following contracts/auth-roles.md "Guard":
  - no `Authorization` header → `401 {"error":"unauthorized"}`;
  - a header without the `Bearer ` prefix → 401;
  - a wrong token → 401;
  - the correct token → `next()` is called;
  - the 401 body never names the expected role.
- [X] T030 [US3] Verify T-E2E-05 in `test/e2e.local.test.ts` (owned by 003 T032): `POST /v1/reconcile` with `CONTROL_TOKEN` returns 401 and the ledger entry count is unchanged. Raise any gap against 003.
- [X] T031 [US3] Add T-AUTH-01 to `test/e2e.local.test.ts` **(depends on 008 T000)**. `POST /v1/authorize` with `SETTLEMENT_TOKEN` returns 401, and the ledger length is unchanged.
- [X] T032 [US3] Verify T-AUTH-02 (owned by 005 T031) in `test/e2e.local.test.ts` **(depends on 008 T000)**: `POST /v1/settlements` with `CONTROL_TOKEN` returns 401, and no reconcile reaches L2. Raise any gap against 005.
- [X] T033 [US3] Add a must-fail proof to `test/auth.test.ts`. Configure the endpoint table so that `/v1/reconcile` accepts the `agent-control` role, and assert that the T-E2E-05 expectation, checked in-process against the route map, then fails. This shows the role separation is what makes it pass.
- [X] T034 [P] [US3] Add a loopback bind test to `test/e2e.local.test.ts`. Start L2 and L3 with `CONTROL_PORT` and `SETTLEMENT_PORT` overridden. Assert that each server's `address().address === "127.0.0.1"`; overriding the port never changes the host (NFR-001, SC-006).

### Implementation for User Story 3

- [X] T035 [US3] Implement `requireRole(role)` in `src/shared/auth.ts`.
  - It is an Express middleware factory.
  - Roles are `agent-control | agent-verifier | verifier-control | operator`.
  - It compares tokens in constant time with `timingSafeEqual` over SHA-256 digests (research.md).
  - It runs before body validation and the handler, so a 401 never appends a ledger entry, triggers a reconcile or consumes an approval.
- [X] T036 [US3] Add role token resolution to `src/shared/config.ts`, following the contracts/auth-roles.md "Startup configuration" table:
  - Map `CONTROL_TOKEN`, `VERIFIER_TOKEN`, `SETTLEMENT_TOKEN` and `OPERATOR_TOKEN` to `dev-control-token`, `dev-verifier-token`, `dev-settlement-token` and `dev-operator-token`.
  - The dev defaults apply only when `NETWORK=local` and the variable is unset.
  - An empty string always exits 1.
  - On other networks, an unset token exits 1 with `missing <VAR>` **(depends on 008 T000: fail-closed beyond "local only")**.
- [X] T037 [US3] Verify that each L2 endpoint owner mounts `requireRole` from `src/shared/auth.ts` on its own route in `src/layer2-control/service.ts` (002 authorize/budget, 003 reconcile/ledger-verify, 004 approvals). Raise any missing or wrong role against the owner:
  - `agent-control` → `POST /v1/authorize`, `GET /v1/budget/:sessionId`
  - `verifier-control` → `POST /v1/reconcile`
  - `operator` → `POST /v1/approvals/:authorizationId`, `GET /v1/ledger/verify`
- [X] T038 [US3] Verify that 005 mounts `requireRole("agent-verifier")` on `POST /v1/settlements` in `src/layer3-settlement/service.ts` (owned by 005 T015), before body validation so 401 precedes 400.
- [X] T039 [US3] Define `CONTROL_BIND_HOST` and `SETTLEMENT_BIND_HOST` (both `"127.0.0.1"`) in `src/shared/config.ts`, then verify that 002 T015 (`src/layer2-control/service.ts`) and 005 T040 (`src/layer3-settlement/service.ts`) bind with them. Use `listen(port, "127.0.0.1")` only; never `listen(port)` with an implicit host.
- [X] T040 [US3] Check that the L1 adapters in `src/layer1-intent/ports-http.ts` (owned by 001) send `CONTROL_TOKEN` only to L2 and `VERIFIER_TOKEN` only to L3. Raise any deviation against 001.

**Checkpoint**: INV-13 is enforced and proven; L2/L3 are loopback-only.

---

## Phase 6: User Story 4 - Secrets are scoped per process (Priority: P2)

**Goal**: There is one env template per process, each holding exactly the variables from the §3.3/CFG-2 matrix. No shared `.env` holds the payer key.

**Independent Test**: The T-ARCH-ENV check passes for 6 of 6 templates with 0 forbidden keys (SC-005).

### Tests for User Story 4

- [X] T041 [US4] Add T-ARCH-ENV to `test/architecture.test.ts` **(depends on 008 T000)**. Parse the keys of each `env/*.env.example` and assert that required keys are present and forbidden keys absent, exactly as in the contracts/env-templates.md "Templates" table. Optional `*_PORT` overrides are allowed on the matching service template.
- [X] T042 [US4] Add a must-fail proof for T-ARCH-ENV to `test/architecture.test.ts`. Feed the template checker an in-memory `l1-agent` key set that includes `PAYER_PRIVATE_KEY` and assert one violation for that key.
- [X] T043 [US4] Add a no-root-`.env` assertion to `test/architecture.test.ts`. A root `.env` must not exist in the repository, and no `src/**` or `scripts/**` file may call dotenv with a root `.env` path (FR-017).

### Implementation for User Story 4

- [X] T044 [P] [US4] Create `env/l1-agent.env.example` with exactly `NETWORK, ANTHROPIC_API_KEY, ANTHROPIC_MODEL?, SELLER_URL, CONTROL_URL, SETTLEMENT_URL, CONTROL_TOKEN, VERIFIER_TOKEN, SESSION_ID?`. Mark dev tokens `# local only`.
- [X] T045 [P] [US4] Create `env/l2-control.env.example` with exactly `NETWORK, PAYER_PRIVATE_KEY, ALLOWED_PAYEES, ALLOWED_HOSTS, CONTROL_TOKEN, SETTLEMENT_TOKEN, OPERATOR_TOKEN`, plus optional `CONTROL_PORT`. Leave `PAYER_PRIVATE_KEY` empty with `# set me`.
- [X] T046 [P] [US4] Create `env/l3-verifier.env.example` with exactly `NETWORK, BASE_SEPOLIA_RPC_URL?, CONTROL_URL, VERIFIER_TOKEN, SETTLEMENT_TOKEN`, plus optional `SETTLEMENT_PORT`.
- [X] T047 [P] [US4] Create `env/seller.env.example` with exactly `NETWORK, SELLER_PAY_TO, FACILITATOR_URL?`, plus optional `SELLER_PORT`.
- [X] T048 [P] [US4] Create `env/facilitator.env.example` with exactly `NETWORK=local, FACILITATOR_PRIVATE_KEY`, plus optional `FACILITATOR_PORT`. Leave the key empty with `# set me`.
- [X] T049 [P] [US4] Create `env/operator.env.example` with exactly `CONTROL_URL, OPERATOR_TOKEN`.
- [X] T050 [US4] Check that every entry point calls `loadEnv()` from `src/shared/config.ts` and never calls dotenv directly. The entry points are `src/main.ts`, both `service.ts` files, `src/counterparty/seller.ts`, `scripts/facilitator.ts` and `scripts/approve.ts`. Raise deviations against the owning features (001, 002, 005, 006, 004).

**Checkpoint**: SC-005 holds; secrets cannot leak through a shared env file.

---

## Phase 7: User Story 5 - The threat model is fully covered by controls (Priority: P2)

**Goal**: Each of SEC-1..SEC-9 traces to a named control, its owning feature, and a passing test. The residual risks are recorded as accepted.

**Independent Test**: For each SEC ID in contracts/threat-matrix.md, the listed tests exist by name in `test/` and pass (SC-004, 9/9).

### Tests for User Story 5

- [X] T051 [US5] Add a traceability test to `test/architecture.test.ts`. For each row of `specs/007-process-isolation-security/contracts/threat-matrix.md`, it asserts that every named test ID (T-AGT-01, T-POL-*, T-E2E-01..05, T-LED-01/02, T-ARCH) appears in a `describe`/`it` title under `test/`. The test fails when a SEC row has no matching test.

### Implementation for User Story 5

- [X] T052 [US5] Make sure test titles in `test/architecture.test.ts` and `test/auth.test.ts` carry their IDs: `T-ARCH-INV1`..`INV4`, `T-ARCH-ENV`, `T-E2E-05`, `T-AUTH-01/02`. Prefixing titles this way makes the T051 check meaningful.
- [X] T053 [US5] Add a "Security model" section to `README.md`. It summarizes the threat matrix and lists the five accepted residual risks with the extension that retires each: EXT-7 (mTLS), EXT-2 (remote signer/KMS), EXT-6 (durable ledger), none planned (facilitator liveness), and EXT-9 (refunds). It links to contracts/threat-matrix.md.
- [X] T054 [US5] Confirm with 001–006 that the tests they own (T-AGT-01, T-POL-05/07/08/11, T-E2E-02/03/04, T-LED-01/02) exist. Record any gaps as blockers in this file's Notes.

**Checkpoint**: SC-004 9/9 holds and is checked automatically.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T055 [P] Time `npx vitest run test/architecture.test.ts` on the full tree and confirm it takes under 5 s with no network or chain access (plan Performance Goals, NFR-004).
- [X] T056 [P] Verify `CLAUDE.md` "Hard rules" stay consistent with SPEC.md §4. INV-2 is unchanged (no facilitator exemption), so no edit is expected unless 008 T000 changes rule wording.
- [X] T057 Verify that the 007 items are covered by 008 T000 (SPEC.md v1.1 amendment) in `SPEC.md`:
  - §4: rules A2, A6 (with 002 T020's tokens) and A7; the extra A4 identifiers `sendTransaction`, `privateKeyToAccount`; INV-2 unchanged
  - §6/§12: `test/auth.test.ts`, `test/fixtures/arch/`, T-AUTH-01, T-AUTH-02 (005 T031) and T-ARCH-ENV
  - §9 CFG-2: fail-closed tokens off `local`; constant-time token compare as hardening

  Raise any missing item against 008 T000.
- [X] T058 Run the full quickstart.md validation (§1–§6) together with `npm run typecheck` and `npm test`, and confirm that the `npm run demo:local` summary is unchanged (`spent on-chain: 0.006 USDC`, `hash chain ok=true`).

---

## Dependencies & Execution Order

### Phase dependencies

- **All tasks depend on 008 T000** (SPEC.md v1.1 amendment gate).
- **Setup (Phase 1)**: none. T002 and T003 depend on 008's M0 scaffold existing.
- **Foundational (Phase 2)**: depends on Setup. It blocks all stories. T004 → T005 → T006 are sequential because they edit the same file. T007 and T008 can run in parallel with them.
- **US1 (Phase 3)**:
  - The architecture rules depend only on Phase 2.
  - T015 needs `src/main.ts` from 001.
- **US2 (Phase 4)**: depends only on Phase 2. It can run alongside US1, but the work is serialized wherever both stories edit `test/architecture.test.ts`.
- **US3 (Phase 5)**:
  - T035 and T036 depend on Phase 2.
  - T037–T039 need the L2 service (002/003/004) and the L3 service (005).
  - T030–T032 and T034 need the e2e harness (008); T030 verifies 003 T032 and T032 verifies 005 T031.
- **US4 (Phase 6)**:
  - The templates (T044–T049) depend on nothing.
  - T041–T043 depend on Phase 2.
- **US5 (Phase 7)**: depends on US1–US4 and on the owning features' tests existing.
- **Polish (Phase 8)**: depends on all stories.

### Cross-feature dependencies

| This feature needs | From |
|---|---|
| `package.json`, vitest config, `.gitignore`, e2e harness (`test/helpers/harness.ts`) | 008 |
| `src/main.ts` composition root, `ports-http.ts` | 001 |
| `src/shared/contracts.ts` | 001 |
| SPEC.md v1.1 amendment (T000) | 008 |
| L2 `service.ts` routes `/v1/authorize`, `/v1/budget` (mounts `requireRole`) | 002 |
| L2 routes `/v1/reconcile`, `/v1/ledger/verify` (mounts `requireRole`), T-E2E-05 (T032) | 003 |
| L2 route `/v1/approvals/:authorizationId`, `scripts/approve.ts`, T-E2E-02 | 004 |
| L3 `service.ts` route `/v1/settlements` (mounts `requireRole`), T-AUTH-02 (T031) | 005 |
| `seller.ts`, `scripts/facilitator.ts` entry point, `src/counterparty/facilitator.ts` server factory | 006 |

### Within each story

Fixtures and tests come first; they must fail. Then implement the rule or guard, then the must-fail proof, then the checkpoint.

---

## Parallel Examples

```text
# Phase 2, after T004–T006 (same file, sequential):
T007 loadEnv() in src/shared/config.ts
T008 ports/bind constants in src/shared/config.ts   # same file as T007: run both in one edit, or one after the other

# US1 + US2 fixtures (all different files):
T009 a5-violation.ts   T010 a3-violation.ts   T017 a1-violation.ts
T018 a4-violation.ts   T019 a2-violation.ts   T020 a6-violation.ts   T021 a7-violation.ts

# US4 templates (all different files):
T044 l1-agent   T045 l2-control   T046 l3-verifier   T047 seller   T048 facilitator   T049 operator

# US3:
T029 test/auth.test.ts  ‖  T034 loopback test (after the harness exists)
```

---

## Implementation Strategy

### MVP first (P1 stories: US1 + US2 + US3)

1. Phase 1 Setup, then Phase 2 Foundational (the scanner core and config).
2. US1: key refusal plus A3 and A5. **Stop and validate:** the manual exit-1 check and the A3/A5 fixtures fail as expected.
3. US2: A1 and A4, plus A2/A6/A7 (depend on 008 T000). **Validate:** 0 violations on `src/`, and every fixture fails.
4. US3: role guard and loopback bind. **Validate:** T-E2E-05 returns 401 and the bind host is `127.0.0.1`.
5. The MVP is reached when INV-1..4 and INV-13 are enforced and proven (SC-001, SC-002, SC-003, SC-006).

### Incremental delivery

- US4 (env templates, SC-005) and then US5 (threat traceability, SC-004) are P2 hardening. They are independent of each other.
- Tasks marked **(depends on 008 T000)** never merge ahead of the SPEC.md v1.1 amendment (Constitution Governance).

---

## Notes

- 58 tasks; [P] marks a different file with no dependency on incomplete work.
- Every safety rule has a must-fail fixture or proof: T011, T022, T028, T033 and T042.
- Do not weaken any INV-* rule to make a test pass (NFR-002).
- Shared files (`src/main.ts`, both `service.ts` files, `src/shared/config.ts`, `test/e2e.local.test.ts`): this feature edits only the guard wiring, bind host, refusal block, env loading and its own named tests.
