# Implementation Plan: Human-in-the-Loop Approval of Escalated Payments

**Branch**: `004-human-approval-escalation` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-human-approval-escalation/spec.md`

## Summary

Payments above the mandate's auto-approve limit (20000 atomic) that pass every DENY rule
are escalated (R14). They are recorded as `ESCALATED` and are never signed. A human operator,
holding only `OPERATOR_TOKEN`, approves one escalation by its authorization ID through
`POST /v1/approvals/:authorizationId` on L2, or through the `approve` CLI. This appends a
`HUMAN_APPROVAL` ledger entry with a TTL (default 600 s).

On the next authorize call for the same session and resource key, L2 looks up an open
approval inside the serialized section. If the payee and the exact amount match, R14 is
lifted. The `AUTHORIZED` entry carries `approvalRef = approvalId`, which consumes that one
approval. Each approval pays at most once; several approvals of one escalation pay once each. Approval state is derived from the ledger only. An approval never overrides a DENY
rule.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, NodeNext) on Node.js 22.x, ESM

**Primary Dependencies**: express ^5.3 (L2 HTTP API), `loadEnv()` from `src/shared/config.ts` (007; `ENV_FILE` defaults to `env/operator.env` for the CLI), tsx ^4.23 (CLI runner), and global `fetch` (CLI → L2). No x402 or viem use in this feature.

**Storage**: L2 hash-chained JSONL ledger at `.local/ledger-<network>.jsonl`, owned by feature 003. This feature adds no store and no mutable approval table.

**Testing**: vitest ^5.0. `test/policy.test.ts` covers T-POL-13. `test/e2e.local.test.ts` covers T-E2E-02. `test/agent.test.ts` covers T-AGT-01 (no approve tool).

**Target Platform**: The L2 control service on 127.0.0.1:4020, plus an operator CLI on the same host

**Project Type**: An endpoint in the L2 web service, plus a CLI script

**Performance Goals**: Human-paced. An approval takes one HTTP call. Lookup is a linear scan of the ledger, which is fine at PoC scale.

**Constraints**:
- Approval lookup and consumption happen inside the authorize mutex (INV-8).
- Time is an input to policy (INV-5).
- An approval is single-use and matches one exact tuple.
- Loopback bind only.
- `OPERATOR_TOKEN` only.

**Scale/Scope**: Single operator role, single node. One endpoint, one CLI and one ledger-query helper (`findOpenApproval`).

No `NEEDS CLARIFICATION` items. Behavior is normative in SPEC.md §8.2 (R14, L2-4.2, L2-5) and §13.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | L1 has no approve tool and no operator token. The CLI lives in `scripts/` and talks to L2 only over HTTP. | ✅ | ✅ ([contracts/approvals-api.md](contracts/approvals-api.md), [contracts/approve-cli.md](contracts/approve-cli.md)) |
| II. Pure policy | R14 matching is evaluated inside `policy.ts` from `ctx.humanApprovedFor` (payTo, amount). The service, not the policy, does the lookup. `nowMs` is passed in. `purpose` is ignored. An approval never lifts a DENY (INV-12). | ✅ | ✅ |
| III. Ledger as source of truth | Open, expired and consumed are derived from `HUMAN_APPROVAL` and `AUTHORIZED.approvalRef`. No approvals table and no `consumed` flag mutation. | ✅ | ✅ ([data-model.md](data-model.md) state machine) |
| IV. Trust the chain | Not affected. Approved payments still go through L3 verification (feature 005). | ✅ | ✅ |
| V. Least privilege | `/v1/approvals/*` accepts only `OPERATOR_TOKEN`; the control, settlement and verifier tokens get 401 (INV-13, SEC-8). The CLI env holds only `CONTROL_URL` and `OPERATOR_TOKEN`. | ✅ | ✅ |
| VI. Exact money | The amount is matched as the **exact atomic string**, with no numeric normalization. | ✅ | ✅ |
| VII. Protocol fidelity | Not affected. No x402 headers are involved. | ✅ | ✅ |
| VIII. Proven safety | T-POL-13 checks: matching approval authorizes, different amount escalates, DENY wins. T-E2E-02 checks: agent token gets 401, operator approval leads to PAID+CONFIRMED, and a repeat escalates again. Reuse must fail if the consumption check is removed. | ✅ | ✅ ([quickstart.md](quickstart.md) step 4) |

Result: **PASS**. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/004-human-approval-escalation/
├── plan.md              # This file
├── research.md          # Phase 0 decisions
├── data-model.md        # Approval entities and lifecycle
├── quickstart.md        # Validation guide
├── contracts/
│   ├── approvals-api.md # POST /v1/approvals/:authorizationId
│   └── approve-cli.md   # npm run approve: invocation, env, exit codes
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/layer2-control/
├── policy.ts            # R14 + humanApprovedFor matching (owned by 002; this feature specifies the matching rule)
├── ledger.ts            # findOpenApproval (implemented on AuditLedger by 003; semantics and tests owned here)
└── service.ts           # POST /v1/approvals/:authorizationId; authorize step 6 approvalRef (step 2/3 wiring owned by 002)
scripts/
└── approve.ts           # operator CLI (§13)
env/
└── operator.env.example # CONTROL_URL, OPERATOR_TOKEN (template owned by 007)
test/
├── policy.test.ts       # T-POL-13
└── e2e.local.test.ts    # T-E2E-02
```

**Structure Decision**: Use the single-project layout from SPEC.md §6. This feature owns:
- the approvals route in `service.ts`;
- the semantics and tests of `findOpenApproval` (003 implements it on `AuditLedger`);
- the `approvalRef = approvalId` wiring at authorize step 6;
- `scripts/approve.ts`.

Owned elsewhere and only verified here:
- R14, `PolicyContext.humanApprovedFor` and authorize steps 2–3: [002](../002-spending-policy-authorization/plan.md).
- Ledger schema and `findOpenApproval` implementation: [003](../003-audit-ledger-reconciliation/plan.md).
- `requireRole("operator")` and `env/operator.env.example`: [007](../007-process-isolation-security/plan.md).
- The `approve` npm script: [008](../008-local-demo-regression/plan.md).
- SPEC.md v1.1 amendment for the behavior beyond SPEC: 008 T000.

## Complexity Tracking

No constitution violations to justify.
