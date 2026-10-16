# Implementation Plan: Spending Policy & Authorization (Layer 2 — Control)

**Branch**: `002-spending-policy-authorization` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-spending-policy-authorization/spec.md`

## Summary

L2 is the only component that can turn an agent's payment intent into a signed x402
authorization. This feature builds four pieces:

- **Mandate loader** (`SpendingMandate`): reads `config/mandate.json` and applies env overrides.
- **Policy engine**: pure functions `evaluateRequirement` and `decide` that run rules R1–R14.
- **Signer** (`PaymentSigner`): the sole key holder. It signs exactly the chosen option and
  enforces its own SDK spend cap.
- **HTTP endpoints**: `POST /v1/authorize` and `GET /v1/budget/:sessionId`.

Authorization runs inside one serialized critical section (a promise-chain mutex):
INTENT → context from the ledger → decide → sign → outcome entry. Ledger internals and
committed spend come from feature 003. Approval lookup comes from feature 004.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, NodeNext) on Node.js 22.x, ESM

**Primary Dependencies**:
- `@x402/core` 2.28.0: `x402Client` from `/client`; `x402HTTPClient` and `encodePaymentSignatureHeader` from `/http`; types from `/types`
- `@x402/evm` 2.28.0: `ExactEvmScheme` from `/exact/client`
- viem ^2.57: `privateKeyToAccount`, used in `signer.ts` only
- express ^5.3, dotenv ^18

**Storage**: Reads `config/mandate.json`. Appends to the ledger through the `AuditLedger` API (feature 003, `.local/ledger-<network>.jsonl`).

**Testing**: vitest ^5.0. `test/policy.test.ts` covers T-POL-01..14 (pure, no I/O). `test/e2e.local.test.ts` covers T-E2E-04 (concurrency, with `signerLatencyMs: 25`).

**Target Platform**: Node.js 22 service bound to `127.0.0.1:4020` (`CONTROL_PORT` overrides the port)

**Project Type**: Internal web service (one of the three layer processes)

**Performance Goals**: Not throughput-bound. Decisions are serialized by design. With local signing, an authorize call takes well under 100 ms. Correctness under concurrency matters more than latency.

**Constraints**:
- `policy.ts` is pure: no I/O, no `Date.now()`, no `purpose` input.
- BigInt arithmetic only.
- Sign exactly one requirement.
- No mutable spend counters.
- Bind to loopback only.
- The mandate must satisfy `autoApproveMax < hardCap ≤ sessionBudget`.

**Scale/Scope**: One payer key, one mandate, and many sessions per process. Five modules: `mandate`, `policy`, `signer`, and the authorize and budget parts of `service`.

No `NEEDS CLARIFICATION` items: SPEC.md §8.2 and CFG-3 pin every choice.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | Only `signer.ts` calls `privateKeyToAccount`. L2 imports only `src/shared/*` and `src/layer2-control/*`. | ✅ | ✅ The signer is the only module in [contracts/signer.md](contracts/signer.md) that sees the key |
| II. Pure policy | `evaluateRequirement` and `decide` take `(req/accepts, mandate, ctx)` with `ctx.nowMs`. `purpose` is not in `PolicyContext`. A single option is signed. Authorize is serialized. Approvals never override a DENY. | ✅ | ✅ [contracts/policy-rules.md](contracts/policy-rules.md); `PolicyContext` has no free-text field |
| III. Ledger as source of truth | `sessionCommittedAtomic`, `dailyCommittedAtomic` and `authorizationsLastMinute` are computed from the ledger on every call (feature 003). | ✅ | ✅ Nothing in data-model.md stores mutable spend |
| IV. Trust the chain | Not applicable. Settlement is features 003 and 005. | n/a | n/a |
| V. Least privilege | Both endpoints accept only `CONTROL_TOKEN`. The settlement and operator tokens are rejected (401). | ✅ | ✅ [contracts/http-api.md](contracts/http-api.md) |
| VI. Exact money | Amounts must match `^\d+$` and are compared as `BigInt`. Budgets are atomic strings. | ✅ | ✅ |
| VII. Protocol fidelity | Payloads are built with `x402HTTPClient.createPaymentPayload` and encoded with `encodePaymentSignatureHeader`. | ✅ | ✅ |
| VIII. Proven safety | T-POL-01..14 cover every rule ID. T-E2E-04 must fail without the mutex (15/15). | ✅ | ✅ [quickstart.md](quickstart.md) §3 includes the mutex-removal check |

Result: **PASS**. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/002-spending-policy-authorization/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── policy-rules.md     # R1–R14 + decide() — normative rule contract
│   ├── policy-api.md       # evaluateRequirement / decide signatures, PolicyContext
│   ├── signer.md           # PaymentSigner contract + SDK spend controls
│   ├── mandate.schema.json # config/mandate.json schema + env overrides
│   └── http-api.md         # POST /v1/authorize, GET /v1/budget/:sessionId
└── tasks.md                # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
config/mandate.json                 # CFG-3 defaults
src/
├── shared/contracts.ts             # PaymentIntent, AuthorizationDecision, BudgetStatus (owned by 001, T004)
├── shared/config.ts                # network profile → allowedNetworks/allowedAssets
└── layer2-control/
    ├── mandate.ts                  # SpendingMandate type + loader (L2-1)
    ├── policy.ts                   # evaluateRequirement, decide (L2-2), pure
    ├── signer.ts                   # PaymentSigner (L2-3), sole key holder
    ├── ledger.ts                   # owned by feature 003 (consumed here)
    └── service.ts                  # authorize + budget routes, mutex (L2-5);
                                    # reconcile/ledger-verify → 003, approvals → 004
test/
├── policy.test.ts                  # T-POL-01..14
└── e2e.local.test.ts               # T-E2E-04 (shared harness, feature 008)
```

**Structure Decision**: Use the single-project layout from SPEC.md §6. This feature owns
`mandate.ts`, `policy.ts`, `signer.ts`, `config/mandate.json`, the authorize and budget
handlers plus the mutex in `service.ts`, and `test/policy.test.ts`. `service.ts` is shared
with features 003 and 004, which each add their own routes.

## Complexity Tracking

No constitution violations to justify.
