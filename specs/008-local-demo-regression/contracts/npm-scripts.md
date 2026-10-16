# Contract: package.json scripts

`package.json` sets `"type": "module"`. Every runtime script uses `tsx`. Each process reads
only its own `ENV_FILE` (CFG-2, owned by 007).

| Script | Command | Env file | Owner |
|---|---|---|---|
| `typecheck` | `tsc --noEmit` | — | 008 |
| `test` | `vitest run` | — (the harness builds its own config) | 008 |
| `demo:local` | `tsx scripts/demo-local.ts` (accepts `-- --llm`) | per child | 008 |
| `local:chain` | `tsx scripts/local-chain.ts` | — | 006 |
| `facilitator` | `tsx scripts/facilitator.ts` | `env/facilitator.env` | 006 |
| `seller` | `tsx src/counterparty/seller.ts` | `env/seller.env` | 006 |
| `l2:control` | `tsx src/layer2-control/service.ts` | `env/l2-control.env` | 002/003 |
| `l3:verifier` | `tsx src/layer3-settlement/service.ts` | `env/l3-verifier.env` | 005 |
| `agent` | `tsx src/main.ts` (goal from argv) | `env/l1-agent.env` | 001 |
| `agent:scripted` | `tsx src/main.ts --scripted` | `env/l1-agent.env` | 001 |
| `approve` | `tsx scripts/approve.ts <authorizationId> [approver]` | `env/operator.env` | 004 |

Rules:
- Each process entry point defaults `ENV_FILE` to `env/<role>.env` when it is unset, so the
  scripts need no shell prefix. A caller can override it with `ENV_FILE=… npm run <script>`.
  There is never a shared `.env`.
- A single test runs with `npx vitest run <file> -t "<name>"` (FR-010).
- Install with `npm install`, never `npm ci` ([../research.md](../research.md) R1).

Pinned versions are in SPEC.md §5. Exact versions in `package.json` follow that table.
