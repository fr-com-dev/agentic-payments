# Research: Spending Policy & Authorization (L2)

Technical Context had no `NEEDS CLARIFICATION` items. This file records the design decisions
and why they were made.

## R1. Pure policy with time as an input

- **Decision**: `evaluateRequirement(req, mandate, ctx)` and `decide(accepts, mandate, ctx)`
  are synchronous and pure. `ctx.nowMs` supplies the time. Every ledger-derived figure is
  precomputed into `ctx` by `service.ts`.
- **Rationale**: This follows INV-5. Decisions are deterministic and can be replayed from the
  ledger, and T-POL-02 can deep-equal two runs. `purpose` is not a field of `PolicyContext`,
  so the type system enforces that LLM text never reaches a decision.
- **Alternatives considered**:
  - Passing the ledger into policy was rejected: it adds I/O and harms testability.
  - A rule-engine library was rejected as needless for 14 ordered checks.

## R2. Collect every DENY, but return early on an invalid amount

- **Decision**: R1–R8 always run and append to `violations`. R9 (`amount_invalid`) returns
  immediately, because R10–R14 need a valid BigInt. R10–R13 then run. R14 is evaluated only
  when there is no DENY.
- **Rationale**: Auditors and the agent see every reason at once. Returning early on R9 avoids
  `BigInt("1.5")` throwing.

## R3. Option selection in `decide`

- **Decision**: Among AUTHORIZED options, pick the smallest `BigInt(amount)`, with ties going
  to the first offered. Otherwise return the first ESCALATE option's violations. Otherwise
  return DENIED with all violations flattened. An empty `accepts` gives
  `no_payment_options`.
- **Rationale**: Choosing the cheapest compliant option is what the payer wants. Breaking ties
  by order keeps the result deterministic (T-POL-02).

## R4. Serialization by promise-chain mutex

- **Decision**: `service.ts` holds `let tail = Promise.resolve()`. Each authorize call chains
  onto it, as in `tail = tail.then(run, run)`. The whole of steps 1–6 (INTENT → decide →
  optional `signerLatencyMs` wait → sign → outcome append) runs inside `run`.
- **Rationale**: This follows INV-8. It needs no dependencies, Node is single-process, and the
  ledger is single-node (accepted residual risk). The `signerLatencyMs` hook makes the race
  observable: local ECDSA signing finishes within microtasks, so without the hook the
  unprotected version would pass by accident (§16).
- **Alternatives considered**:
  - The `async-mutex` package was rejected as an extra dependency for the same semantics.
  - Optimistic concurrency with re-checks was rejected as more complex, and the check and
    sign would still need to be atomic.

## R5. Independent second cap in the signer

- **Decision**: `PaymentSigner` configures the x402 client with
  `{ maxAmountPerPayment: false, allowedAssets: [{ network, asset, maxAmountPerPayment: hardCapAtomic }] }`.
  If the SDK throws, the decision becomes `DENIED` with `signer_rejected` and the detail
  truncated to 300 characters.
- **Rationale**: This is defense in depth (NFR-004). A policy bug alone cannot sign above the
  hard cap.

## R6. Sign exactly the chosen option

- **Decision**: `sign(challenge, approved)` passes `{...challenge, accepts: [approved]}` to
  `createPaymentPayload`.
- **Rationale**: This follows INV-6. The SDK's own option selection can never pick a
  different, unvetted option.

## R7. Mandate sourcing

- **Decision**:
  - Load `config/mandate.json`.
  - Always derive `allowedNetworks` and `allowedAssets` from the active network profile
    (feature 006).
  - `ALLOWED_PAYEES` and `ALLOWED_HOSTS` (comma-separated) replace the JSON values when set.
  - Lower-case payees.
  - At load time, validate that `autoApproveMax < hardCap ≤ sessionBudget`.
- **Rationale**: Network and asset values must match what the signer can actually sign.
  Validating at startup surfaces an impossible escalation path early.
- **Open note**: SPEC.md states the constraint but does not say whether a violation fails
  startup. This plan makes it fail startup (fail closed). See [data-model.md](data-model.md).
  Recorded in SPEC.md by 008 T000 (v1.1 amendment).

## R8. Budget endpoint semantics

- **Decision**: `GET /v1/budget/:sessionId` returns `BudgetStatus`:
  - `sessionCapAtomic` = `sessionBudgetAtomic`
  - `spentOrReservedAtomic` = the session's committed spend (feature 003)
  - `remainingAtomic` = `max(0, cap − committed)`
  - `perPaymentCapAtomic` = `autoApproveMaxAtomic`, per SPEC L2-5
- **Rationale**: The agent sees the amount it can spend without escalating. The hard cap is
  not exposed as a target to aim for.
