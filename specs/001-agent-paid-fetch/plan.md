# Implementation Plan: Agent Paid Fetch (Layer 1 — Intent & Orchestration)

**Branch**: `001-agent-paid-fetch` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-agent-paid-fetch/spec.md`

## Summary

Layer 1 lets an agent buy x402-priced HTTP resources without holding payment authority. A
transport loop (the orchestrator) works through these steps:

1. Fetch the resource.
2. Decode a 402 challenge.
3. Ask L2 to authorize the payment, through a port.
4. Retry with the opaque payment headers L2 returns.
5. Ask L3 to verify settlement, through a port.

Two agents drive the orchestrator:

- **Claude tool-use agent**: has exactly two tools, `fetch_resource` and `check_budget`.
- **Scripted agent**: deterministic, with no LLM. It is the regression baseline.

The composition root (`src/main.ts`) wires HTTP port adapters to L2 and L3. It refuses to
start if the payer key is visible.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, `module`/`moduleResolution: NodeNext`) on Node.js 22.x, ESM

**Primary Dependencies**: `@x402/core` 2.28.0 (`decodePaymentRequiredHeader` from `@x402/core/http`, types from `@x402/core/types`), `@anthropic-ai/sdk` ^0.135, dotenv ^18, tsx ^4.23. HTTP calls use the global `fetch` in Node 22.

**Storage**: None in L1. The ledger belongs to L2 (feature 003).

**Testing**: vitest ^5.0 (`fileParallelism: false`, 120 s timeouts). Unit tests in `test/agent.test.ts` (T-AGT-01, fake model client). End-to-end tests in `test/e2e.local.test.ts` (T-E2E-01/02/04/05). Static checks in `test/architecture.test.ts` (INV-1, INV-3).

**Target Platform**: Node.js 22 CLI process on macOS/Linux, talking to the L2 (:4020) and L3 (:4023) loopback services and the seller (:4021)

**Project Type**: CLI agent process (a client inside a multi-process system)

**Performance Goals**: Not throughput-bound. Each paid fetch makes 2 seller round trips, 1 call to L2 and 1 call to L3. The L3 call may block up to 45 s for finality (feature 005).

**Constraints**:
- At most 10 model turns, with `max_tokens` 2048.
- A non-JSON body is truncated to 2000 characters.
- No retry after DENIED or ESCALATE.
- Payment headers are forwarded byte-for-byte.
- No key material, and no reference to `PAYER_PRIVATE_KEY` except the refusal check.

**Scale/Scope**: One session per process, and one paid fetch at a time per agent loop. 4 modules plus the composition root.

No `NEEDS CLARIFICATION` items: SPEC.md §5–§8.1 pins every choice.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | L1 imports only `src/shared/*` and `src/layer1-intent/*`. No signer. `main.ts` exits 1 if `PAYER_PRIVATE_KEY` is set. Only 2 tools, neither of which can sign, approve or edit policy. | ✅ | ✅ The adapters depend only on the port interfaces in `contracts.ts` ([contracts/l1-ports.md](contracts/l1-ports.md)) |
| II. Pure policy | L1 makes no decisions. `purpose` is sent to L2 for audit only. Option selection is left to L2: the full `accepts[]` is forwarded verbatim. | ✅ | ✅ |
| III. Ledger as source of truth | L1 keeps no spend counter. `check_budget` asks L2. | ✅ | ✅ |
| IV. Trust the chain | L1 never treats `PAYMENT-RESPONSE` as proof. It forwards the raw header to L3 and uses L3's status for PAID or PAYMENT_FAILED. | ✅ | ✅ |
| V. Least privilege | L1 holds `CONTROL_TOKEN`, `VERIFIER_TOKEN` and `ANTHROPIC_API_KEY` only, each sent to a single destination. | ✅ | ✅ ([contracts/cli.md](contracts/cli.md) env table) |
| VI. Exact money | Amounts stay as atomic strings. `amountUsd` is a display value only, computed with `formatAtomic` (owned by 006 in `src/shared/config.ts`). | ✅ | ✅ |
| VII. Protocol fidelity | Decode with `decodePaymentRequiredHeader`. Never decode or re-encode `PAYMENT-SIGNATURE` or `PAYMENT-RESPONSE` in L1. | ✅ | ✅ |
| VIII. Proven safety | T-AGT-01 checks the tool count. The architecture test covers INV-1 and INV-3. T-E2E-01 covers outcomes. A manual check covers the exit-1 refusal. | ✅ | ✅ |

Result: **PASS**. No violations, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-agent-paid-fetch/
├── plan.md              # This file
├── research.md          # Phase 0 decisions
├── data-model.md        # Phase 1 entities and state
├── quickstart.md        # Phase 1 validation guide
├── contracts/
│   ├── l1-ports.md      # Port interfaces consumed by L1 + HTTP mapping
│   ├── agent-tools.json # The exact two Claude tool definitions
│   └── cli.md           # Agent process CLI and environment contract
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── contracts.ts         # ALL SPEC §7 types and ports (owned by 001 T004;
│   │                        # consumed by 002/003/004/005)
│   └── config.ts            # network profile + formatAtomic (006), URLs/tokens/env (007)
├── layer1-intent/
│   ├── orchestrator.ts      # PaidResourceOrchestrator.fetchPaid (L1-1)
│   ├── ports-http.ts        # HttpAuthorizationGate, HttpSettlementVerifier (L1-2)
│   ├── agent.ts             # runClaudeAgent (L1-3)
│   └── scripted.ts          # runScriptedAgent (L1-4)
└── main.ts                  # composition root (L1-5)

test/
├── agent.test.ts            # T-AGT-01
├── architecture.test.ts     # T-ARCH-* (INV-1, INV-3 for L1)
└── e2e.local.test.ts        # T-E2E-01/02/04/05 (shared with other features)
```

**Structure Decision**: Use the single-project layout from SPEC.md §6. This feature owns
`src/layer1-intent/**`, `src/main.ts` and `test/agent.test.ts`. It owns
`src/shared/contracts.ts` (001 T004 creates every SPEC §7 type and port); other features change
it only through a contract-change task.

## Complexity Tracking

No constitution violations to justify.
