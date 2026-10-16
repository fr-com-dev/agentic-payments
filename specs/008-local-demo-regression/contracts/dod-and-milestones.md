# Contract: Definition of Done and M0–M7 gates

## Definition of Done (per change, SPEC §0.3)

| # | Gate | Command / check | Pass condition |
|---|---|---|---|
| G1 | Types | `npm run typecheck` | 0 errors |
| G2 | Tests | `npm test` | all suites green, including `architecture` |
| G3 | Baseline | `npm run demo:local` | exit 0, with `spent on-chain: 0.006 USDC` and `hash chain ok=true` |
| G4 | Spec sync | review | a behavior or contract change updates SPEC.md in the same change; a plan or price change updates §8.1 L1-4, §12 and the README |
| G5 | Coverage | review | every new rule, endpoint or contract field has a test whose name cites its ID |
| G6 | Safety proof | review | a new safety mechanism has a test shown to fail without it (like T-E2E-04: 15/15 vs 10/15) |
| G7 | Traceability | review | commit message cites requirement IDs |

## Milestones (from-scratch rebuild, SPEC §14)

| M | Deliverables | Owning features | Exit check | Pass |
|---|---|---|---|---|
| M0 | `package.json` (ESM, scripts), `tsconfig.json`, `vitest.config.ts`, `.gitignore` | 008 | `npm run typecheck` | passes on an empty `src/` |
| M1 | `shared/contracts.ts`, `shared/config.ts`, architecture test | 001–005 (types), 006 (config), 007 (arch test) | `npx vitest run test/architecture.test.ts` | T-ARCH-* green |
| M2 | `MockUSDC.sol`, `local-chain-lib.ts` | 006 | `npm run local:chain` | deployed, and the payer holds 10 USDC |
| M3 | seller and facilitator | 006 | unpaid `GET /api/weather?city=Lima` | 402, and `PAYMENT-REQUIRED` decodes via the SDK |
| M4 | L2: mandate, policy, ledger, signer, service | 002, 003, 004 | `npx vitest run test/policy.test.ts test/ledger.test.ts` | T-POL-*, T-LED-* green |
| M5 | L3: verifier, service | 005 | `npx vitest run test/e2e.local.test.ts -t "T-E2E-03"` | green |
| M6 | L1: orchestrator, adapters, scripted agent, `main.ts` | 001 | `-t "T-E2E-01\|T-E2E-02\|T-E2E-04\|T-E2E-05"` | green |
| M7 | Claude agent + T-AGT-01, `demo-local.ts`, `approve.ts`, README | 001, 004, 008 | `npx vitest run test/agent.test.ts && npm run demo:local` | green, and G3 passes |

A milestone must pass its exit check before the next one starts (FR-014).

M3 verification (008 T033, 2026-10-16): 006 T013 in `test/counterparty.test.ts` passes 4/4. An unpaid
`GET /api/weather?city=Lima` returns 402, and `PAYMENT-REQUIRED` decodes with `decodePaymentRequiredHeader`.

