# Implementation Plan: Local Demo, Regression Baseline & Operability

**Branch**: `008-local-demo-regression` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-local-demo-regression/spec.md`

## Summary

This feature delivers the scaffolding and tooling that let the PoC be built, run,
regression-checked and judged "done":

- the project scaffold: `package.json` scripts, `tsconfig.json`, `vitest.config.ts`,
  `.gitignore`;
- the end-to-end test harness that asserts the scripted baseline (T-E2E-01);
- the 6-process local demo orchestrator (`scripts/demo-local.ts`), with readiness probes,
  process-group shutdown and a fixed summary format;
- the M0–M7 milestone gates and the definition-of-done checklist.

It owns no layer logic. It composes features 001–007.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, `NodeNext`) on Node.js 22.x, ESM (`"type": "module"`)

**Primary Dependencies**: tsx ^4.23 (script runner), vitest ^5.0, dotenv ^18, ganache 7.9.2 + solc 0.8.24 (local chain, via feature 006's `local-chain-lib.ts`), viem ^2.57 (balance reads in the harness and demo summary). `@x402/*` 2.28.0 is used only through the features that own it.

**Storage**: `.local/` (gitignored), holding `deployment.json` (feature 006) and `ledger-<network>.jsonl` (feature 003). Read-only here.

**Testing**: vitest with `fileParallelism: false`, `testTimeout` and `hookTimeout` of 120 000 ms. Suites: `policy`, `ledger`, `architecture`, `agent` and `e2e.local`.

**Target Platform**: macOS and Linux developer hosts. IPv6 is not required.

**Project Type**: Developer tooling and test harness for a multi-process CLI/service system

**Performance Goals**:
- The demo completes in well under 2 minutes on a laptop.
- Each test file stays within the 120 s per-test budget.

**Constraints**:
- Fixed ports: 8545 and 4020–4023, overridable through env.
- Fail visibly if a port is busy; never fall back silently to another port.
- 0 listeners after exit.
- Install with `npm install`, never `npm ci`.
- Children are spawned `detached` and killed with `process.kill(-pid)`.

**Scale/Scope**: 1 orchestrator script, 1 e2e harness module, 3 config files and 1 scripts contract. The baseline is 6 plan steps.

No `NEEDS CLARIFICATION` items: SPEC.md §0, §5, §12–§14 and §16 pin every choice.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | The demo and harness wire layers only from `scripts/**` and `test/**` (INV-1 allows this). Each child process gets its own `ENV_FILE`. The agent child never receives `PAYER_PRIVATE_KEY`. | ✅ | ✅ The per-child env table in [contracts/demo-local.md](contracts/demo-local.md) keeps the payer key in L2 only |
| II. Pure policy | The harness never stubs or bypasses `decide`. It also checks the real policy outcomes. | ✅ | ✅ |
| III. Ledger as source of truth | The summary takes `spentOrReserved` from L2 `/v1/budget` and chain status from `/v1/ledger/verify`. The harness keeps no counters of its own. | ✅ | ✅ |
| IV. Trust the chain | The on-chain spend in the summary and in T-E2E-01 comes from token `balanceOf` deltas. It is not read from receipts the seller returns. | ✅ | ✅ |
| V. Least privilege | The demo passes each token only to its role's processes. It uses `dev-*` tokens for local runs only. | ✅ | ✅ |
| VI. Exact money | Deltas are computed in BigInt. The 0.006 figure is formatted from 6000n with `formatAtomic`. | ✅ | ✅ |
| VII. Protocol fidelity | There is no header handling here. The 402 check for milestone M3 decodes with the SDK helper. | ✅ | ✅ |
| VIII. Proven safety | T-E2E-04 keeps `signerLatencyMs: 25` and documents its fail-without-mutex result (15/15). The DoD requires tests for new behavior. | ✅ | ✅ ([contracts/dod-and-milestones.md](contracts/dod-and-milestones.md)) |

Result: **PASS**. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/008-local-demo-regression/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── npm-scripts.md          # package.json scripts contract
│   ├── demo-local.md           # orchestration, readiness, shutdown, summary format
│   ├── e2e-harness.md          # in-process harness + T-E2E-01 assertions
│   └── dod-and-milestones.md   # definition of done + M0–M7 gates
└── tasks.md                    # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
package.json                 # scripts (contracts/npm-scripts.md), "type": "module"
tsconfig.json                # strict, NodeNext, noEmit
vitest.config.ts             # fileParallelism:false, 120 s timeouts
.gitignore                   # node_modules, .local/, env/*.env (not *.env.example)
README.md                    # quickstart, Base Sepolia faucet note (FR-016)
scripts/
├── demo-local.ts            # 6-process orchestrator (owned here)
├── facilitator.ts           # facilitator entry point (owned by 006; demo runs it)
├── local-chain-lib.ts       # owned by 006, consumed here
└── local-chain.ts           # owned by 006
test/
├── helpers/harness.ts       # in-process e2e harness (owned here)
└── e2e.local.test.ts        # T-E2E-01 owned here; T-E2E-02..05 sections owned by 003/004/002/007
```

**Structure Decision**: Single project, following SPEC.md §6. The only new path beyond §6 is
`test/helpers/harness.ts`, which keeps the e2e setup in one place for every e2e test
([research.md](research.md) R3).

## Complexity Tracking

No constitution violations to justify.
