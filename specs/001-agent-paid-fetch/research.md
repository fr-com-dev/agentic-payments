# Research: Agent Paid Fetch (L1)

Technical Context had no `NEEDS CLARIFICATION` items. SPEC.md pins the stack. This file
records the design decisions and why they were made.

## R1. Orchestrator depends on ports, not HTTP clients

- **Decision**: `PaidResourceOrchestrator` takes an `AuthorizationGatePort` and a
  `SettlementVerifierPort` (defined in `src/shared/contracts.ts`) in its constructor. HTTP
  adapters live in `ports-http.ts`.
- **Rationale**: This satisfies INV-1. Tests and `main.ts` can wire in-process fakes or the real
  HTTP services, and the orchestrator never sees tokens or URLs of other layers.
- **Alternatives considered**: Calling L2 and L3 with `fetch` directly from the orchestrator
  was rejected: it couples transport and auth, and it is harder to test. Importing the L2/L3
  modules directly was rejected because it breaks INV-1.

## R2. Challenge decoding with a v1 fallback

- **Decision**: Decode the `PAYMENT-REQUIRED` header with `decodePaymentRequiredHeader`. If
  the header is missing, `JSON.parse` the 402 body (the x402 v1 style). If both fail, return
  `ERROR`.
- **Rationale**: Principle VII forbids hand-rolled base64. The body fallback tolerates v1
  sellers at no risk, because L2 still validates every field.
- **Alternatives considered**: Requiring v2 only was rejected because it fails needlessly on
  v1 sellers. Hand-decoding base64 was rejected (Principle VII).

## R3. Payment headers are opaque

- **Decision**: Pass `decision.paymentHeaders` (a `Record<string,string>`) unchanged to the
  retry request. L1 never decodes or edits `PAYMENT-SIGNATURE`.
- **Rationale**: Only L2 understands the signed payload. Treating the headers as opaque
  removes any L1 code path that could tamper with or forge them.

## R4. Settlement status comes from L3

- **Decision**: After the paid retry, always build a `SettlementClaim` with the raw
  `PAYMENT-RESPONSE` header, or `null` when it is absent, and call `settlement.verify`.
  - **PAID**: the response is 2xx and the report is CONFIRMED or PENDING.
  - **PAYMENT_FAILED**: anything else. The body is included only for a 2xx response.
- **Rationale**: This follows INV-10 and Principle IV. PENDING counts as PAID because L3
  re-checks it and reconciles into L2 later (feature 005).
- **Alternatives considered**: Trusting `success:true` from the seller was rejected (SEC-4).

## R5. No retry on DENIED or ESCALATE

- **Decision**: The orchestrator returns immediately. The LLM system prompt forbids retrying
  a DENIED payment and requires reporting the `authorizationId` of an ESCALATED one.
- **Rationale**: This is the agent-side half of SEC-1. Retrying cannot change a pure policy
  result. It only burns velocity budget and pollutes the audit log.

## R6. Claude tool-use loop

- **Decision**: Use the Messages API with the two tools from
  [contracts/agent-tools.json](contracts/agent-tools.json):
  - Model: `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`.
  - `max_tokens` is 2048, with at most 10 turns.
  - The client is injectable (`opts.client`), and the loop ends on `end_turn` or the turn limit.
- **Rationale**: This bounds cost (NFR-006). The injectable client makes T-AGT-01
  deterministic. Two tools is the minimum toolset for SEC-1.
- **Alternatives considered**:
  - An SDK tool-runner helper was rejected because it gives less explicit control over the
    turn cap and the tool set in a security-sensitive loop.
  - A generic HTTP tool was rejected because it would let the model call L2 directly.

## R7. Composition-root key refusal

- **Decision**: The first statement of `main.ts`, after env loading, checks
  `process.env.PAYER_PRIVATE_KEY`. If it is set, `main.ts` prints a refusal and calls
  `process.exit(1)`. Env comes only from `loadEnv()` (007), which reads `ENV_FILE` (default `env/l1-agent.env`).
- **Rationale**: This follows INV-3 and SEC-2. It fails closed before any network or LLM
  activity.

## R8. Display amounts

- **Decision**: `amountUsd` in tool results is `formatAtomic(requirement.amount, decimals)` (from 006's `src/shared/config.ts`),
  which formats a string with BigInt math.
- **Rationale**: Principle VI. The model sees human-readable USD, and the authoritative value
  stays as the atomic string.
