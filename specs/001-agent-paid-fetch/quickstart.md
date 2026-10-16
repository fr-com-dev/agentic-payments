# Quickstart: validate Agent Paid Fetch (L1)

## Prerequisites

- Node.js 22. Run `npm install` (not `npm ci`).
- Features 002/003 (L2), 005 (L3) and 006 (seller, facilitator, local chain) are implemented.
  L1 cannot be validated end to end without them.
- Copy `env/*.env.example` to `env/*.env`. Do not create a shared `.env`.

## 1. Static and unit checks

```bash
npm run typecheck
npx vitest run test/architecture.test.ts   # INV-1 and INV-3 hold for src/layer1-intent and src/main.ts
npx vitest run test/agent.test.ts          # T-AGT-01
```

Expected for T-AGT-01:
- Exactly 2 tools are offered (see [contracts/agent-tools.json](contracts/agent-tools.json)).
- The fake model's `purpose` appears in the recorded intents.
- The tool result shows `PAID` and settlement `CONFIRMED`.

## 2. Scripted regression (T-E2E-01)

```bash
npx vitest run test/e2e.local.test.ts -t "T-E2E-01"
npm run demo:local
```

Expected:
- Outcomes are `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`.
- The payer's on-chain delta is 6000.
- The demo summary shows `spent on-chain: 0.006 USDC` and `hash chain ok=true`.

## 3. Denial and escalation are not retried

In the demo log, check these steps:
- Step 4 (`/api/premium-report`) shows `ESCALATED` with an `authorizationId`.
- Steps 5 and 6 show `DENIED` with `hard_cap_exceeded` and `host_not_allowed`.
- None of the three steps is followed by a second seller request.

## 4. Key refusal (INV-3, manual)

```bash
PAYER_PRIVATE_KEY=0x1 ENV_FILE=/dev/null npx tsx src/main.ts --scripted; echo "exit=$?"
```

Expected: a refusal message and `exit=1`.

## 5. LLM mode (optional)

```bash
npm run demo:local -- --llm
```

Expected:
- The agent starts at `/api/catalog`.
- It buys only what the goal needs.
- It does not retry a DENIED payment.
- It ends with a receipt list (resource, USD, settlement status, tx).
- It stops within 10 turns.

Data shapes: [data-model.md](data-model.md). Port contract: [contracts/l1-ports.md](contracts/l1-ports.md).
