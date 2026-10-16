# Quickstart: validate Local Demo, Regression Baseline & Operability

## Prerequisites

- Node.js 22 on macOS or Linux. IPv6 is not required.
- `npm install` (not `npm ci`).
- Features 001–007 are implemented.
- Optionally, copy `env/*.env.example` to `env/*.env`. The demo falls back to the example
  defaults.

## 1. Definition-of-done gates

```bash
npm run typecheck
npm test
```

Expected:
- 0 type errors.
- The policy, ledger, architecture, agent and e2e.local suites are all green.
- Files run sequentially, each test with a 120 s budget.

## 2. Regression baseline (T-E2E-01)

```bash
npx vitest run test/e2e.local.test.ts -t "T-E2E-01"
```

Expected: all 8 assertions in [contracts/e2e-harness.md](contracts/e2e-harness.md) pass:
- the outcomes list;
- a delta of 6000;
- 2 CONFIRMED settlements;
- `ok: true`;
- spentOrReserved `"6000"`.

## 3. Local demo

```bash
npm run demo:local; echo "exit=$?"
```

Expected:
- The summary is printed last and contains `spent on-chain: 0.006 USDC` and
  `hash chain ok=true`.
- `exit=0`.
- No `uws` warning lines appear.

## 4. Clean shutdown (NFR-001)

```bash
lsof -nP -iTCP:8545 -iTCP:4020-4023 -sTCP:LISTEN || echo "no listeners"
```

Expected: `no listeners`. Repeat after pressing Ctrl-C partway through a demo run.

## 5. Busy-port failure

```bash
nc -l 4021 & sleep 1; npm run demo:local; echo "exit=$?"; kill %1
```

Expected:
- `demo: port busy: 4021 (seller)` and `exit=1` (automated as T012 in `test/demo.local.test.ts`).
- No child process is left running.

## 6. LLM mode (optional; requires `ANTHROPIC_API_KEY` in `env/l1-agent.env`)

```bash
npm run demo:local -- --llm
```

Expected:
- The same six processes start.
- The summary prints `hash chain ok=true`.
- The spend varies with the model's choices, and no baseline is asserted.

## 7. Base Sepolia (optional)

1. Fund the payer with test USDC at faucet.circle.com.
2. Set `NETWORK=base-sepolia` in each env file.
3. Run `npm run seller`, `npm run l2:control`, `npm run l3:verifier` and
   `npm run agent -- "<goal>"`, each in its own terminal.
4. Approve an escalation with `npm run approve -- <authorizationId> [approver]`.

Expected:
- No local chain or facilitator is started.
- At least one payment reaches CONFIRMED through the hosted facilitator.

Gates and milestones: [contracts/dod-and-milestones.md](contracts/dod-and-milestones.md).

## Recorded results (2026-10-16, macOS, Node 26.3)

| Check | Result |
|---|---|
| T011 demo smoke | `npm run demo:local` exits 0; prints `spent on-chain: 0.006 USDC` and `hash chain ok=true entries=…`; no listeners on 8545/4020–4023 afterwards |
| T012 busy port | 4021 occupied → `demo: port busy: 4021 (seller)`, exit 1, nothing started |
| Ctrl-C mid-run | SIGINT 2.5 s into a run → `demo: SIGINT received, stopping all processes`, exit 1, no listeners left |
| T023 shutdown proof | Literal edit (`process.kill(pid)` instead of `process.kill(-pid)`), then T011: still passes, because the demo spawns `tsx` directly and `tsx` forwards SIGTERM to its node child. The group kill is therefore defense in depth on this path. The failure it prevents (a leader that dies without forwarding, as with `npx`/`sh` wrappers) is reproduced by the automated T023 test: killing the pid leaves the grandchild's port open; killing the group frees it. Demo restored byte-for-byte. |
| T026 negative control | `autoApproveMaxAtomic` 20000 → 60000 in `config/mandate.json`: T-E2E-01 fails (step 4 `ESCALATED` → `PAID`). Reverted; T-E2E-01 passes. |
| T034 milestones | M0 typecheck pass · M1 architecture 19/19 · M2 `local:chain` payer 10 USDC · M3 006 T013 4/4 · M4 policy+ledger 77/77 · M5 T-E2E-03 pass · M6 T-E2E-01/02/04/05 pass · M7 agent 31/31 + demo exit 0 |
| Full gate | `npm run typecheck` clean; `npm test` 223/223 across 10 files |
| T037 portability | macOS only. The Linux-without-IPv6 run has not been done. |
| `--llm` | Not run (no `ANTHROPIC_API_KEY` in this environment). |

