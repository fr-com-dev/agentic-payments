# Research: Local Demo, Regression Baseline & Operability

Technical Context had no `NEEDS CLARIFICATION` items. This file records the design decisions.

## R1. Install with `npm install`, never `npm ci`

- **Decision**: The documented install is `npm install`. CI also uses `npm install`.
- **Rationale**: ganache's lockfile pins a darwin-only `fsevents` entry, so `npm ci` fails on
  Linux (§16).
- **Alternatives considered**: Patching the lockfile was rejected: it is fragile and
  re-breaks on every update. Replacing ganache with anvil was rejected because it changes
  the pinned stack and needs a SPEC update.

## R2. vitest config

- **Decision**: Use `fileParallelism: false`, `testTimeout: 120_000` and
  `hookTimeout: 120_000`. Tests run on a single node environment.
- **Rationale**: Test files share one chain, fixed ports and a ledger file (NFR-003).
  Waiting for on-chain confirmation needs a generous budget (NFR-004).
- **Alternatives considered**: One chain per file on random ports was rejected: it is slower
  and diverges from the fixed-port demo topology.

## R3. In-process e2e harness

- **Decision**: `test/helpers/harness.ts` starts these in one vitest process:
  - ganache with MockUSDC (via feature 006's lib)
  - the facilitator
  - the seller, bound to `0.0.0.0`
  - L2, with a fresh temp ledger path and injectable `signerLatencyMs`
  - L3

  The harness returns typed handles: URLs, tokens, the payer and payTo addresses, a balance
  reader, and `close()`. Ports default to fixed values and can be overridden per suite.
  `close()` runs in `afterAll`.
- **Rationale**: Startup is fast, the harness can inject the L2 test hooks (T-E2E-04), and
  it is a single place to change wiring. This is allowed because `test/**` may import across
  layers (INV-1).
- **Alternatives considered**: Spawning the 6 processes per test, the way the demo does,
  was rejected as slow, and it cannot inject `signerLatencyMs`.

## R4. IPv6-less hosts and the `localhost` alias

- **Decision**: Bind the seller to `0.0.0.0`. The allowlisted host is `127.0.0.1:4021`, and
  plan step 6 uses `http://localhost:4021/...`.
- **Rationale**: Binding `::` fails without IPv6 (§16). `localhost` reaches the same socket
  but differs as a host string, so R6 `host_not_allowed` fires deterministically.
- **Alternatives considered**: A second hostname through `/etc/hosts` was rejected because it
  needs machine setup.

## R5. Demo orchestration: detached children, killed by process group

- **Decision**: Each child is started with
  `spawn("npx", ["tsx", ...], { detached: true, env: { PATH, HOME, NODE_*, ENV_FILE } })`.
  It does not spread the parent's `process.env` into the child.
  - **Readiness**: the orchestrator polls a readiness probe per process, every 250 ms with a
    30 s ceiling. See [contracts/demo-local.md](contracts/demo-local.md).
  - **Shutdown**: `SIGTERM`, then `SIGKILL` after 3 s, each sent with
    `process.kill(-child.pid)`. Shutdown runs from `finally` and from `SIGINT`/`SIGTERM`
    handlers.
- **Rationale**: Killing only the `npx` pid leaves ganache holding port 8545 (§16). Killing
  the process group removes the whole tree (NFR-001).
- **Alternatives considered**: `tree-kill` was rejected as an extra dependency. Fixed
  sleeps instead of readiness probes were rejected as flaky.

## R6. Port preflight

- **Decision**: Before spawning anything, the demo tries to bind each port in turn
  (8545 and 4020–4023, or their overrides). If any bind fails, it aborts with
  `port <n> in use` and exit code 1.
- **Rationale**: This is the spec's edge case: fail visibly and never fall back to another
  port.

## R7. Warning filter

- **Decision**: Child stdout and stderr are piped line by line with a role prefix
  (`[chain]`, `[l2]`, …). Lines matching `/uws_.*\.node|Falling back to a NodeJS
  implementation/` are dropped.
- **Rationale**: Keeps the log readable (FR-007, NFR-007).

## R8. Summary is computed from authoritative sources

- **Decision**: After the agent child exits, the demo computes:
  - the payer and seller `balanceOf` deltas, through a viem public client;
  - `GET /v1/budget/:sessionId` (L2);
  - `GET /v1/ledger/verify` (operator token).

  It then prints the summary block last. The demo passes `SESSION_ID` to the agent so it can
  query that session.
- **Rationale**: This follows Principles III and IV. The summary cannot be faked by agent
  output.

## R9. `--llm` mode

- **Decision**: `demo:local -- --llm` launches the agent without `--scripted`. The agent then
  needs `ANTHROPIC_API_KEY` from `env/l1-agent.env`. If the key is missing, the demo fails
  fast. The summary format is the same, but no 0.006 baseline is asserted.
- **Rationale**: LLM purchases are not deterministic, so only scripted mode is the baseline.
