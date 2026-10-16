# Implementation Plan: Settlement Verification (Layer 3)

**Branch**: `005-settlement-verification` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-settlement-verification/spec.md`

## Summary

Layer 3 independently verifies that an authorized x402 payment actually settled. It accepts
a `SettlementClaim` from L1 and ignores the seller's word. It reads the chain through a
read-only client:

1. Wait for the transaction receipt.
2. Require a token `Transfer` log matching (asset, payer, payTo, amount).
3. Wait for finality, scaled to the amount at risk.
4. Return a `SettlementReport`.

Every report, including background re-check results for PENDING reports, is pushed to L2
reconciliation (owned by feature 003) with a dedicated credential. L3 has no wallet client,
no key and no write path.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, NodeNext) on Node.js 22.x, ESM

**Primary Dependencies**:
- viem ^2.57, read-only: `createPublicClient`, `http`, `waitForTransactionReceipt`, `parseEventLogs` with `erc20Abi`, `getBlockNumber`, `getBlock({ blockTag: "safe" })`.
- `@x402/core` 2.28.0: `decodePaymentResponseHeader` from `@x402/core/http`.
- express ^5.3, dotenv ^18, tsx ^4.23.

**Storage**: None. The re-check schedule is in memory only (spec Assumptions).

**Testing**: vitest ^5.0 (`fileParallelism: false`, 120 s timeouts).
- `test/e2e.local.test.ts`: T-E2E-01 (two CONFIRMED) and T-E2E-03 (forged response → MISMATCH).
- `test/architecture.test.ts`: INV-4 static check, owned by 007.
- Verifier pipeline tests can run against ganache through the 006 local chain.

**Target Platform**: Node.js 22 HTTP service bound to `127.0.0.1:4023` (`SETTLEMENT_PORT`). It is a client of the chain RPC (`net.rpcUrl`) and of L2 `:4020`.

**Project Type**: Internal web service (one process in the multi-process system)

**Performance Goals**:
- Micropayments (`included`) on `local` are CONFIRMED in under 45 s, typically one block.
- One verification makes at most `waitMs / pollMs` ≈ 45 receipt polls, plus finality polls on the same deadline.

**Constraints**:
- `waitMs` 45000 and `pollMs` 1000 by default.
- Re-checks: 5 attempts, 30 s apart, `unref`'d timers.
- Exact BigInt amount comparison and case-insensitive address comparison.
- A reconcile failure never fails the request.
- No signing or write APIs anywhere in `src/layer3-settlement/**`.

**Scale/Scope**: Two modules (`verifier.ts` and `service.ts`). One endpoint. A handful of concurrent claims per demo run.

No `NEEDS CLARIFICATION` items: SPEC.md §8.3 and CFG-1 pin every choice.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | L3 imports only `src/shared/*` and `src/layer3-settlement/*`. No `createWalletClient`, `signTypedData` or `writeContract` (INV-4). No key in `l3-verifier.env`. | ✅ | ✅ Only a public client is constructed ([research R1](research.md)) |
| II. Pure policy | L3 makes no authorization decisions. Its status is derived only from chain facts. | ✅ | ✅ |
| III. Ledger as source of truth | L3 never writes the ledger. It pushes reports to 003's `/v1/reconcile`, and L2 decides whether a report is an anomaly or sticky. | ✅ | ✅ |
| IV. Trust the chain | CONFIRMED requires a success receipt, a matching `Transfer` log from `requirement.asset`, and finality (INV-10). `PAYMENT-RESPONSE` is used only to find the tx hash. | ✅ | ✅ Pipeline in [data-model.md](data-model.md) |
| V. Least privilege | Inbound calls must carry `VERIFIER_TOKEN`. Outbound calls to L2 use `SETTLEMENT_TOKEN` only. Binds to loopback. | ✅ | ✅ [contracts/settlements-api.md](contracts/settlements-api.md) |
| VI. Exact money | `BigInt(requirement.amount)` is compared with the log's `value` (bigint). The finality thresholds are bigint literals. | ✅ | ✅ |
| VII. Protocol fidelity | Decode with `decodePaymentResponseHeader`. Never hand-decode base64. | ✅ | ✅ |
| VIII. Proven safety | T-E2E-03 shows a forged response is MISMATCH. T-ARCH checks INV-4. The finality table and NOT_SETTLED branches need unit tests (see quickstart §2). | ✅ | ✅ |

Result: **PASS**. No violations, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-settlement-verification/
├── plan.md              # This file
├── research.md          # Phase 0 decisions
├── data-model.md        # Report, finality and status state machine
├── quickstart.md        # Validation guide
├── contracts/
│   ├── settlements-api.md   # POST /v1/settlements (owned) + outbound reconcile call
│   └── verifier.md          # SettlementVerifierPort impl, options, finality table
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── contracts.ts         # SettlementClaim, SettlementReport, SettlementStatus,
│   │                        # FinalityClass, SettlementVerifierPort, ReconciliationPort
│   └── config.ts            # networkProfile: rpcUrl, confirmationDepth, supportsSafeTag (006)
└── layer3-settlement/
    ├── verifier.ts          # ChainSettlementVerifier.verify, finalityClassFor (L3-1)
    └── service.ts           # HTTP API, reconcile push, PENDING re-check scheduler (L3-2)

test/
├── verifier.test.ts         # unit: statuses, Transfer match, finality, shared deadline
├── settlement-service.test.ts # service: auth (T-AUTH-02), 400s, reconcile push, re-checks
├── helpers/
│   └── fake-public-client.ts  # scripted read-only client for unit tests
├── e2e.local.test.ts        # T-E2E-01 (2× CONFIRMED), T-E2E-03 (L3 side: MISMATCH)
└── architecture.test.ts     # INV-4 (owned by 007)
```

**Structure Decision**: Use the single-project layout from SPEC.md §6. This feature owns
`src/layer3-settlement/**`. It consumes the shared types and network profile without
redefining them (`contracts.ts` is created by 001 T004). Auth uses 007's `requireRole`, and
env loading uses 007's `loadEnv()`. Reconciliation is a client call into 003's endpoint.
The three new test files are added to SPEC §6/§12 by the v1.1 amendment (008 T000).

## Complexity Tracking

No constitution violations to justify.
