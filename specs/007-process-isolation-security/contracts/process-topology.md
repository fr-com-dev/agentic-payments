# Contract: Process and port topology (§3.1)

| Process | Entry point | npm script | Default port | Override | Bind host | Network |
|---|---|---|---|---|---|---|
| Agent (L1) | `src/main.ts` | `agent`, `agent:scripted` | none (opens no listener) | n/a | n/a | all |
| Control (L2) | `src/layer2-control/service.ts` | `l2:control` | 4020 | `CONTROL_PORT` | `127.0.0.1` (not configurable) | all |
| Verifier (L3) | `src/layer3-settlement/service.ts` | `l3:verifier` | 4023 | `SETTLEMENT_PORT` | `127.0.0.1` (not configurable) | all |
| Seller | `src/counterparty/seller.ts` | `seller` | 4021 | `SELLER_PORT` | `0.0.0.0` | all |
| Facilitator | `scripts/facilitator.ts` (derives the account, then calls the server factory in `src/counterparty/facilitator.ts`) | `facilitator` | 4022 | `FACILITATOR_PORT` | local | `local` only (exits otherwise; owner 006) |
| Chain | `scripts/local-chain.ts` | `local:chain` | 8545 | none | local | `local` only (owner 006) |

Guarantees:
- Changing a port override never changes the bind host (NFR-001).
- The agent never calls `listen` (FR-003).
- Shutdown and port cleanup during the demo are owned by 008.

Call graph. Each edge uses only the listed credential:

```text
L1 ──CONTROL_TOKEN──► L2:4020   (authorize, budget)
L1 ──VERIFIER_TOKEN─► L3:4023   (settlements)
L3 ──SETTLEMENT_TOKEN► L2:4020  (reconcile)
operator ──OPERATOR_TOKEN──► L2:4020 (approvals, ledger/verify)
L1 ──(x402 headers)──► Seller:4021 ──► Facilitator:4022 / hosted ──► Chain
L3 ──(read-only RPC)──► Chain
```
