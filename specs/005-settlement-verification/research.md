# Research: Settlement Verification (L3)

Technical Context had no `NEEDS CLARIFICATION` items. This file records the design decisions.

## R1. Read-only chain access

- **Decision**: Build a single viem `createPublicClient({ transport: http(net.rpcUrl) })` and
  inject it into the verifier. No wallet client, account or private key exists in L3.
- **Rationale**: This satisfies INV-4, and the static architecture test (007) can check it by
  grepping for `createWalletClient`, `signTypedData` and `writeContract`.
- **Alternatives considered**: A shared client factory in `src/shared` that can also build
  wallets was rejected because it would put write capability within reach of L3.

## R2. One deadline for receipt and finality

- **Decision**: Compute `deadline = start + waitMs` once per `verify` call.
  - `waitForTransactionReceipt` uses `timeout = deadline − Date.now()` and `pollingInterval = pollMs`.
  - The finality loop polls every `pollMs` until the same deadline.
  - Deadline exceeded before the receipt → `PENDING`. Deadline exceeded before finality →
    `PENDING`, with block info filled in.
- **Rationale**: This bounds the agent-facing latency to about 45 s, the value L1 and the
  e2e timeouts assume. SPEC says "until `waitMs`" for both steps, and a shared deadline is
  the conservative reading. Passing the full `waitMs` to the receipt wait would let receipt
  plus finality reach 2 × `waitMs`. This reading is made normative by the SPEC.md v1.1
  amendment (008 T000).
- **Alternatives considered**: Separate 45 s budgets per step were rejected because they
  could reach 90 s and exceed the expected per-call latency.

## R3. Transfer matching with `parseEventLogs`

- **Decision**: Use `parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })`.
  Keep only logs whose `address` lower-cased equals `requirement.asset` lower-cased. Require
  one log with `args.from` = payer, `args.to` = payTo (both lower-case) and
  `args.value === BigInt(amount)`.
- **Rationale**: This satisfies INV-10. Filtering by the emitting contract defeats a fake
  token emitting a look-alike `Transfer`. BigInt equality is exact (Principle VI).
- **Alternatives considered**:
  - Reading `balanceOf` deltas was rejected: it is racy under concurrent payments and
    can't be attributed to a single tx.
  - Trusting `PAYMENT-RESPONSE.payer` was rejected (SEC-4).

## R4. Finality classes

- **Decision**: `finalityClassFor(amount)`:
  - `amount ≤ 10_000n` → `included`
  - `amount ≤ 1_000_000n` → `confirmed-depth`
  - otherwise → `l1-safe`

  The checks are:
  - **included**: the receipt exists.
  - **confirmed-depth**: `head − block + 1 ≥ net.confirmationDepth`.
  - **l1-safe**: if `net.supportsSafeTag`, `getBlock({ blockTag: "safe" }).number ≥ block`.
    Otherwise `head − block + 1 ≥ 5 × confirmationDepth`.

  `confirmations` is always reported as `head − block + 1`.
- **Rationale**: These are the SPEC L3-1 table and the CFG-1 profile values: local has depth
  1 and no safe tag, base-sepolia has depth 2 and a safe tag.
- **Alternatives considered**: Using the `finalized` tag was rejected because it is too slow
  for a testnet demo, and the SPEC defines `safe`.

## R5. Status precedence

- **Decision**: Evaluate in SPEC order and return at the first terminal result:
  1. Missing, undecodable or unsuccessful `PAYMENT-RESPONSE`, or no tx → `NOT_SETTLED`.
  2. Network mismatch → `MISMATCH`.
  3. Receipt timeout → `PENDING`.
  4. Reverted → `NOT_SETTLED`.
  5. No matching Transfer → `MISMATCH`.
  6. Finality not reached → `PENDING`.
  7. Otherwise → `CONFIRMED`.

  A decode exception is caught and becomes `NOT_SETTLED` with the reason in `detail`.
- **Rationale**: This is deterministic and matches SPEC §8.3 one to one. The detail strings
  help T-E2E-03 assertions and audits.

## R6. Reconcile push is best-effort

- **Decision**: After computing the report, `service.ts` calls
  `ReconciliationPort.reconcile(report)`. This is an HTTP POST to L2 `/v1/reconcile` with
  `Bearer SETTLEMENT_TOKEN` (contract owned by 003), bounded by
  `AbortSignal.timeout(5000)`. Errors and timeouts are caught and logged, and the HTTP
  response to L1 is still 200 with the report.
- **Rationale**: This satisfies NFR-006. L2 counts unreconciled authorizations
  conservatively, so a lost push cannot cause overspend. The 5 s bound keeps a hung L2 from
  blocking the L1 response indefinitely.
- **Alternatives considered**: Failing the L1 request on a reconcile error was rejected: it
  would surface infrastructure errors as payment failures.

## R7. PENDING re-check scheduler

- **Decision**: On a `PENDING` report, schedule `setTimeout(recheck, recheckIntervalMs).unref()`.
  - Defaults: `recheckAttempts = 5`, `recheckIntervalMs = 30000`.
  - Each re-check reruns `verify(claim)` and reconciles the result.
  - Rescheduling stops when the status is not PENDING or the attempts are used up.
  - Timers are kept in memory, keyed by `authorizationId`. A second PENDING claim for the
    same id replaces the existing schedule.
- **Rationale**: This satisfies FR-012 and NFR-007. Unref'd timers do not block shutdown or
  vitest teardown. Losing the schedule on restart is accepted, because L2 keeps counting
  PENDING.
- **Alternatives considered**: A durable queue was rejected as out of scope for v1. A
  blocking retry inside the request was rejected because it violates NFR-007.

## R8. Endpoint validation and auth

- **Decision**: Mount 007's shared `requireRole("agent-verifier")` guard (`src/shared/auth.ts`,
  constant-time comparison) before body validation, so 401 always precedes 400. Only
  `VERIFIER_TOKEN` passes; `CONTROL_TOKEN` and `SETTLEMENT_TOKEN` get 401 (T-AUTH-02). With a
  valid token, the body must have a string `authorizationId` and an object `requirement`,
  otherwise 400. `createSettlementService` builds the app without binding; only the entry
  point binds with `listen(port, "127.0.0.1")` after `loadEnv()`.
- **Rationale**: This satisfies L3-2, INV-13 and §3.1, and reuses one guard across services
  instead of a per-service token check. The stricter 400 typing goes into SPEC v1.1 (008 T000).
