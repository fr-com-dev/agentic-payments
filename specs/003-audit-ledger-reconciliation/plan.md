# Implementation Plan: Audit Ledger, Committed Spend & Settlement Reconciliation

**Branch**: `003-audit-ledger-reconciliation` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-audit-ledger-reconciliation/spec.md`

## Summary

L2 keeps a single append-only, hash-chained JSONL ledger per network. It is the only source of
truth for:

- budgets;
- approvals;
- settlement status.

`AuditLedger` provides these operations:

- **Append**: computes `hash = sha256(canonicalJSON(entry without hash))` and links each entry
  to the previous hash; the genesis previous-hash is 64 zeros.
- **Verify on construction**: throws `integrity` if the chain is broken.
- **`committedAtomic`**: derives committed spend from the entries.
- **`effectiveReport`**: the latest non-anomalous SETTLEMENT entry for an authorization.

The L2 service gets two endpoints in this feature:

- `POST /v1/reconcile` (settlement token), which cross-checks a report against its AUTHORIZED
  entry and records anomalies;
- `GET /v1/ledger/verify` (operator token).

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, NodeNext) on Node.js 22.x, ESM

**Primary Dependencies**: `node:crypto` (`createHash("sha256")`), `node:fs` (sync append and read), express ^5.3 (L2 service routes), shared types from `src/shared/contracts.ts`

**Storage**: JSONL file at `.local/ledger-<network>.jsonl` (gitignored). One JSON entry per line, loaded fully into memory at startup.

**Testing**: vitest ^5.0. `test/ledger.test.ts` covers T-LED-01..03. `test/e2e.local.test.ts` covers T-E2E-01 (L2 side), T-E2E-03 and T-E2E-05.

**Target Platform**: The L2 control process (`src/layer2-control/service.ts`), bound to 127.0.0.1:4020

**Project Type**: Library module (ledger) plus routes in the L2 web service

**Performance Goals**: PoC scale. Committed spend is an in-memory scan, O(entries), on each authorize call. That is acceptable for thousands of entries; EXT-6 (SQLite view) is the scale path.

**Constraints**:
- Append-only.
- Writes happen inside the L2 serialized section (INV-8).
- BigInt sums only.
- Time is passed in as `nowMs`.
- Startup fails closed on any integrity error, including a truncated last line.

**Scale/Scope**: A single node with a single writer process. Six entry types and 2 HTTP endpoints.

No `NEEDS CLARIFICATION` items: SPEC.md §8.2 L2-4, L2-4.1 and L2-5 pin the behavior.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | The ledger lives in `src/layer2-control/` and imports only `src/shared/*` and node built-ins. It holds no key material. | ✅ | ✅ |
| II. Pure policy | `committedAtomic` and `findOpenApproval` take `nowMs` as an argument and read no clock. Ledger appends for a decision happen inside the serialized authorize section. | ✅ | ✅ ([contracts/ledger-api.md](contracts/ledger-api.md)) |
| III. Ledger as source of truth | There is no mutable counter: every budget figure is computed by `committedAtomic`. The API has no update or delete. Integrity is checked at startup. CONFIRMED is sticky through the effective-report rule. | ✅ | ✅ |
| IV. Trust the chain | Reconcile accepts only L3 reports (which are chain-derived). It cross-checks the verified fields against the AUTHORIZED entry. | ✅ | ✅ |
| V. Least privilege | `/v1/reconcile` takes `SETTLEMENT_TOKEN` only. `/v1/ledger/verify` takes `OPERATOR_TOKEN` only. Any other token gets 401 and nothing is appended. | ✅ | ✅ ([contracts/http-api.md](contracts/http-api.md)) |
| VI. Exact money | Amounts are stored as atomic strings and summed as BigInt. | ✅ | ✅ |
| VII. Protocol fidelity | Nothing to check: the ledger stores decoded data and does no x402 header handling. | ✅ | ✅ |
| VIII. Proven safety | T-LED-01 shows tampering is detected. T-LED-02 shows release happens only after `validBefore`. T-LED-03 and T-E2E-03 show anomalies are ignored. T-E2E-05 checks the token. | ✅ | ✅ |

Result: **PASS**. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/003-audit-ledger-reconciliation/
├── plan.md
├── research.md
├── data-model.md          # entry schema, effective report, committed spend
├── quickstart.md
├── contracts/
│   ├── ledger-entry.schema.json   # JSONL line schema (all six types)
│   ├── ledger-api.md              # AuditLedger module interface + algorithms
│   └── http-api.md                # /v1/reconcile, /v1/ledger/verify
└── tasks.md               # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── shared/contracts.ts          # SettlementReport, ReconciliationPort (consumed)
└── layer2-control/
    ├── ledger.ts                # AuditLedger: append, verifyChain, committedAtomic,
    │                            # effectiveReport, authorizedSince, findOpenApproval
    │                            # (implemented here; approval semantics and tests: 004)
    └── service.ts               # + POST /v1/reconcile, GET /v1/ledger/verify (authorize/budget: 002)

test/
├── ledger.test.ts               # T-LED-01..03
└── e2e.local.test.ts            # T-E2E-03, T-E2E-05 (harness owned by 008)

.local/ledger-<network>.jsonl    # runtime artifact, gitignored
```

**Structure Decision**: Use the single-project layout from SPEC.md §6. This feature owns
`ledger.ts`, `test/ledger.test.ts`, and the reconcile and verify routes in `service.ts`.
Feature 002 owns the authorize and budget routes and the service bootstrap in the same
`service.ts`. Feature 004 owns the approvals route and the semantics and tests of
`findOpenApproval`, which this feature implements on `AuditLedger`. The reconcile route mounts
007's `requireRole("verifier-control")`. SPEC.md details this plan fixed are recorded by 008 T000.

## Complexity Tracking

No constitution violations to justify.
