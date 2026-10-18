# Feature Specification: Local Demo, Regression Baseline & Operability

**Feature Branch**: `008-local-demo-regression`

**Created**: 2026-10-16

**Status**: Draft — derived from SPEC.md v1.0 (implemented PoC)

**Input**: Derived from SPEC.md §0 (definition of done), §8.1 L1-4, §12 (T-E2E-01, manual checks), §13 (commands), §14 (build order M0–M7), §16 (known gotchas), and the test-runner settings in §5

This feature specifies how the proof of concept is run, regression-checked, rebuilt and
operated. The deterministic scripted plan is the behavioral baseline. Every change must keep
its outcome, or must update the spec on purpose.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One-command local demo proves the whole flow (Priority: P1)

An agent developer runs one command. It brings up the local chain, the facilitator, the
seller, the Control layer, the Verifier and the agent. The agent runs the scripted plan, and
the demo prints a summary showing exactly 0.006 USDC spent on-chain and an intact audit hash
chain. Afterwards, nothing is left running.

**Why this priority**: The demo is the end-to-end proof that the three-layer design works.
It is also the fastest regression signal.

**Independent Test**: Run the local demo on a clean machine (dependencies installed). Check
the summary lines, then check that no listeners remain on ports 8545 or 4020–4023.

**Acceptance Scenarios**:

1. **Given** dependencies are installed and no services are running, **When** the developer
   runs the local demo, **Then** six processes start, the scripted plan runs, and the summary
   includes `spent on-chain: 0.006 USDC` and `hash chain ok=true`.
2. **Given** the demo has finished or been interrupted, **When** ports 8545 and 4020–4023 are
   checked, **Then** none has a listener.
3. **Given** the developer passes the LLM option to the demo, **When** it runs, **Then** the
   Claude agent drives the purchases in place of the scripted plan, using the same six
   processes.
4. **Given** the local chain prints its known native-binding warning, **When** the demo runs,
   **Then** the warning is filtered from the demo output and the demo still succeeds.

---

### User Story 2 - The scripted plan is a deterministic regression baseline (Priority: P1)

An agent developer changing any layer needs a fixed, LLM-free purchase sequence. Its outcomes
cover a free fetch, auto-approved payments, an escalation and two different denials, so any
behavior change is caught automatically.

**Why this priority**: Every policy, settlement and ledger path is exercised in one run. The
end-to-end test asserts it on every test run (T-E2E-01).

**Independent Test**: Run the end-to-end test suite against the local chain and check the
T-E2E-01 assertions.

**Acceptance Scenarios**:

1. **Given** a fresh local chain with the payer funded with 10 USDC, **When** the scripted
   plan runs, **Then** the six outcomes are, in order, `FREE, PAID, PAID, ESCALATED, DENIED,
   DENIED` (T-E2E-01).
2. **Given** the plan has run, **When** the payer's and seller's on-chain balances are
   compared with their values before the run, **Then** the seller gained exactly 6000 atomic
   units (0.006 USDC) and the payer lost exactly 6000.
3. **Given** the plan has run, **When** the Control ledger is inspected, **Then** it holds
   exactly two CONFIRMED settlements and its hash chain verifies.
4. **Given** the plan has run, **When** the session budget is queried, **Then** the
   spent-or-reserved figure is 6000.
5. **Given** step 4 (premium report, 50000), **When** it is evaluated, **Then** the outcome is
   ESCALATED with rule `human_approval_required`.
6. **Given** step 5 (dataset export, 500000), **When** it is evaluated, **Then** the outcome is
   DENIED, including `hard_cap_exceeded` together with the budget rules.
7. **Given** step 6 (the weather request through host alias `localhost`), **When** it is
   evaluated, **Then** the outcome is DENIED with `host_not_allowed`.

---

### User Story 3 - A clear definition of done gates every change (Priority: P1)

Any contributor, human or AI, needs one objective set of gates that decides whether a change
is complete.

**Why this priority**: SPEC.md is normative and the code must match it. These gates keep the
two aligned.

**Independent Test**: Apply a change, run the gates in order and confirm that each produces
a pass or fail result.

**Acceptance Scenarios**:

1. **Given** a change, **When** type checking runs, **Then** it passes with zero errors.
2. **Given** a change, **When** the full test suite runs, **Then** all suites pass: policy,
   ledger, architecture, agent and on-chain end-to-end.
3. **Given** a change that does not intentionally alter the scripted plan or its prices,
   **When** the local demo runs, **Then** its summary is unchanged (0.006 USDC, chain ok).
4. **Given** a change that intentionally alters the plan or prices, **When** it is submitted,
   **Then** SPEC.md (§8.1 L1-4, §12) and the README are updated in the same change.
5. **Given** a new rule, endpoint or contract field, **When** it is submitted, **Then** it
   comes with a test that references its requirement ID.

---

### User Story 4 - Rebuild from scratch by milestones (Priority: P2)

A developer rebuilding the PoC from an empty repository follows eight milestones (M0–M7).
Each has an objective exit criterion, so progress can be verified step by step.

**Why this priority**: This ensures the spec alone is enough to reproduce the system. It is
less urgent than running and regression-checking the existing build.

**Independent Test**: At each milestone, run its exit check and confirm it passes before
moving on.

**Acceptance Scenarios**:

1. **Given** M0 (scaffold), **When** type checking runs on an empty source tree, **Then** it
   passes.
2. **Given** M1 (shared contracts, configuration and the architecture test), **When** the
   architecture tests run, **Then** T-ARCH-* pass.
3. **Given** M2 (mock token and local chain setup), **When** the chain starts, **Then** the
   token deploys and the payer balance is 10 USDC.
4. **Given** M3 (seller and facilitator), **When** a priced route is requested without
   payment, **Then** the response is 402 with a decodable payment-required header.
5. **Given** M4 (Control layer), **When** the policy and ledger tests run, **Then** T-POL-*
   and T-LED-* pass.
6. **Given** M5 (Settlement layer), **When** the forged-response test runs, **Then** T-E2E-03
   passes.
7. **Given** M6 (agent orchestrator, adapters, scripted agent and composition root), **When**
   the end-to-end tests run, **Then** T-E2E-01, T-E2E-02, T-E2E-04 and T-E2E-05 pass.
8. **Given** M7 (Claude agent, demo orchestrator, approval CLI and README), **When** T-AGT-01
   and the demo run, **Then** both pass and the demo summary matches User Story 1.

---

### User Story 5 - Run against Base Sepolia testnet (Priority: P3)

An agent developer runs the same system against the public Base Sepolia testnet with real
test USDC. Each process runs in its own terminal, the hosted facilitator pays gas, and the
operator approves escalations from a CLI.

**Why this priority**: This proves the design on a real network. It is optional, because it
needs external funding and network access.

**Independent Test**: Fund a payer from the Circle faucet. Start the seller, Control,
Verifier and agent in separate terminals with the network set to Base Sepolia, then run one
paid fetch.

**Acceptance Scenarios**:

1. **Given** a payer funded with Base Sepolia test USDC, **When** the seller, Control,
   Verifier and agent are started in separate terminals and the agent is given a goal,
   **Then** paid requests settle through the hosted facilitator and are verified on-chain.
2. **Given** an escalated authorization ID, **When** the operator runs the approval command
   with that ID (and optionally an approver name), **Then** the approval is recorded and the
   agent can retry the purchase (owned by 004).
3. **Given** Base Sepolia, **When** the network profile is selected, **Then** no local
   facilitator or local chain is started.

---

### Edge Cases

- The demo is interrupted (Ctrl-C) or a child process crashes: all children, including the
  local chain, are terminated by process group, so port 8545 is freed.
- Dependencies are installed with a clean-install command on Linux: it fails on a
  platform-specific lockfile entry, so the supported install path is the standard install.
- The host has no IPv6: binding the IPv6 any-address fails. Tests bind the seller to the IPv4
  any-address and use `localhost` as the non-allowlisted host alias.
- Concurrency tests run with near-instant local signing: races are invisible, so a simulated
  signer latency must be injected for T-E2E-04 to be meaningful.
- Ports 8545 or 4020–4023 are already in use before the demo starts: startup fails visibly,
  with no silent fallback to other ports.
- Test files run in parallel against one chain: forbidden, because they share chain and port
  state.
- Base Sepolia token metadata differs from the local mock (`"USDC"` vs `"USD Coin"`): a wrong
  token-domain name makes signatures fail verification (owned by 006).

## Requirements *(mandatory)*

### Functional Requirements

**Scripted regression baseline**

- **FR-001**: The system MUST provide a scripted agent mode that runs a fixed, LLM-free
  six-step plan, in order:
  1. Catalog (free) → FREE.
  2. Weather for Lima (1000 atomic) → PAID, CONFIRMED.
  3. Market brief (5000) → PAID, CONFIRMED.
  4. Premium report (50000) → ESCALATED (`human_approval_required`).
  5. Dataset export (500000) → DENIED (`hard_cap_exceeded` plus budget rules).
  6. Weather through the `localhost` host alias (1000) → DENIED (`host_not_allowed`).

  *(SPEC: L1-4)*
- **FR-002**: The automated end-to-end suite MUST assert, for one scripted run on a fresh
  local chain:
  - Outcomes exactly `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`.
  - An on-chain balance delta of exactly 6000 atomic units.
  - Exactly two CONFIRMED settlements.
  - Ledger hash-chain verification ok.
  - Session budget spent-or-reserved = 6000.

  *(SPEC: T-E2E-01)*

**Local demo**

- **FR-003**: A single demo command MUST start, in dependency order, six processes: local
  chain, facilitator, seller, Control, Verifier and agent. It runs the scripted plan by
  default. *(SPEC: §13, §3.1)*
- **FR-004**: The demo MUST accept an LLM option (`--llm`) that runs the Claude agent instead
  of the scripted plan. *(SPEC: §13)*
- **FR-005**: The demo MUST end by printing a summary that includes the on-chain spend (the
  baseline is `spent on-chain: 0.006 USDC`) and the ledger chain status (the baseline is
  `hash chain ok=true`). *(SPEC: §0.3, §12)*
- **FR-006**: The demo MUST start child processes detached, in their own process groups, and
  MUST terminate them by process group on completion, error or interrupt. *(SPEC: §16, §12)*
- **FR-007**: The demo MUST filter the local chain's known, harmless native-binding warning
  from its output. *(SPEC: §16)*
- **FR-008**: Local chain setup MUST deploy the mock token, mint 10 USDC to the payer account
  and record the deployment for the other processes to read. *(SPEC: §14 M2, CP-5)*

**Commands**

- **FR-009**: The project MUST expose these commands:
  - Install (standard install, not clean-install).
  - Type check.
  - Full test.
  - Local demo, with the optional `--llm` flag.
  - Individual process starters: seller, Control, Verifier, agent (with a goal argument),
    and the scripted agent.
  - Local chain.
  - Facilitator.
  - Operator approval: `approve <authorizationId> [approver]`.

  *(SPEC: §13, §3.1)*
- **FR-010**: A single named test MUST be runnable in isolation from the policy suite.
  *(SPEC: CLAUDE.md commands; §12)*

**Definition of done**

- **FR-011**: A change MUST be considered done only when:
  - (a) type checking passes;
  - (b) all test suites pass, including the architecture test;
  - (c) the demo summary is unchanged, or the plan or price change is intentional and
    SPEC.md §8.1/§12 and the README are updated;
  - (d) every new rule, endpoint or contract field has a test.

  *(SPEC: §0.3)*
- **FR-012**: Commit messages and test names MUST reference requirement IDs (INV-*, L1-*,
  L2-*, L3-*, CP-*, CFG-*, SEC-*, T-*). *(SPEC: §0.2)*
- **FR-013**: If code and SPEC.md disagree, the code MUST be fixed, or SPEC.md MUST be
  amended first in the same change with a stated reason. *(SPEC: §0.1)*

**Build order**

- **FR-014**: A from-scratch rebuild MUST follow milestones M0–M7. Each MUST meet its exit
  criterion before the next starts:
  - M0: type checking passes on an empty source tree.
  - M1: T-ARCH-* pass.
  - M2: the token deploys and the payer holds 10 USDC.
  - M3: an unpaid GET returns 402 with a decodable payment-required header.
  - M4: T-POL-* and T-LED-* pass.
  - M5: T-E2E-03 passes.
  - M6: T-E2E-01, T-E2E-02, T-E2E-04 and T-E2E-05 pass.
  - M7: T-AGT-01 passes and the demo summary matches.

  *(SPEC: §14)*

**Testnet operation**

- **FR-015**: The system MUST support a Base Sepolia run, with seller, Control, Verifier and
  agent each started in its own terminal. The hosted facilitator pays gas, and no local
  facilitator or local chain runs. *(SPEC: §13, CP-3)*
- **FR-016**: Operator documentation MUST state that the Base Sepolia payer needs test USDC
  from the Circle faucet. *(SPEC: §16; CLAUDE.md environment)*

**Runtime artifacts**

- **FR-017**: Runtime artifacts (the deployment record and the per-network ledger) MUST be
  written to a local, version-control-ignored directory. *(SPEC: §6)*

### Non-Functional Requirements

- **NFR-001 (Operability, clean shutdown)**: After the demo exits, whether it succeeded,
  failed or was interrupted, no process may be listening on ports 8545, 4020, 4021, 4022 or
  4023. *(SPEC: §12 manual, §16)*
- **NFR-002 (Determinism)**: The scripted plan MUST produce the same outcomes, the same
  on-chain delta (6000) and the same budget figures on every run against a fresh local chain.
  *(SPEC: L1-4, T-E2E-01)*
- **NFR-003 (Test isolation)**: Test files MUST run sequentially (no file parallelism),
  because they share the chain and ports. *(SPEC: §5)*
- **NFR-004 (Test timeouts)**: Each test and hook MUST allow up to 120 seconds, to cover
  on-chain confirmation. *(SPEC: §5)*
- **NFR-005 (Concurrency testability)**: The Control layer MUST offer a test-only simulated
  signer latency (25 ms in T-E2E-04). Concurrency tests MUST use it, and the concurrency test
  MUST fail without serialization (15 of 15 authorized without the mutex vs 10 of 15 with
  it). *(SPEC: T-E2E-04, §16)*
- **NFR-006 (Portability)**: The install path MUST work on macOS and Linux with the standard
  install command. Tests MUST pass on hosts without IPv6, by binding the seller to the IPv4
  any-address and using `localhost` as the non-allowlisted alias. *(SPEC: §16)*
- **NFR-007 (Log hygiene)**: Demo output MUST stay readable. The known harmless chain warning
  is suppressed, and the final summary is the last section of output. *(SPEC: §16)*
- **NFR-008 (Reproducibility)**: The local network MUST use a fixed mnemonic and fixed
  account roles (#0 deployer, #1 facilitator, #2 payer, #3 seller payee), so runs are
  reproducible. *(SPEC: CP-5)*

### Key Entities

- **Scripted plan step**: The requested resource, price in atomic units and expected outcome
  (with rule IDs when the step is denied or escalated).
- **Demo run**: The set of six started processes, the plan executed, and the summary (on-chain
  spend, hash-chain status, final budget).
- **Regression baseline**: The expected outcomes list, on-chain delta (6000), CONFIRMED count
  (2) and spent-or-reserved figure (6000).
- **Milestone (M0–M7)**: A deliverable set, with an objective exit criterion.
- **Gate**: One definition-of-done check (type check, tests, demo summary, spec sync, test
  coverage).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The local demo completes from one command and prints `spent on-chain: 0.006
  USDC` and `hash chain ok=true`.
- **SC-002**: 0 listeners remain on ports 8545 and 4020–4023 within the demo's exit, in 100%
  of runs including interrupted ones.
- **SC-003**: The scripted run yields exactly `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`,
  an on-chain delta of 6000 atomic units, 2 CONFIRMED settlements and spent-or-reserved =
  6000, in 100% of fresh-chain runs.
- **SC-004**: The concurrency test authorizes exactly 10 of 15 concurrent intents with
  serialization, and 15 of 15 without it.
- **SC-005**: Each of the 8 milestones (M0–M7) has an exit check that a developer can run and
  confirm in one step.
- **SC-006**: The full test suite passes on a host without IPv6 and on macOS, using the
  standard install command.
- **SC-007**: The Base Sepolia run settles at least one paid request on-chain, verified by the
  Settlement layer, using only faucet-funded test USDC and the hosted facilitator.

## Assumptions

- The local demo needs no external network access, apart from installing dependencies. The
  LLM option additionally needs an LLM API key in the agent's environment.
- The baseline figures (6000 atomic, 0.006 USDC) depend on the seller catalog prices (owned
  by 006) and the default mandate (owned by 002). Changing either is an intentional baseline
  change and requires a SPEC update.
- The Base Sepolia run depends on the public RPC endpoint and the hosted facilitator being
  available. Their downtime is outside the system's control and is not a defect.
- Port defaults may be overridden (owned by 007). The clean-shutdown check uses the ports
  actually configured.
- Dependencies: 001 (scripted and LLM agents), 002 (policy outcomes), 003 (ledger, chain
  verification and budget), 004 (approval CLI), 005 (CONFIRMED status), 006 (seller,
  facilitator, mock token, network profiles), 007 (process topology).
- How the demo, scripts and test runner are configured is specified in SPEC.md §5, §6, §13
  and §16.
- *(Amended by 009, SPEC v1.2.)* The shared demo helpers move to `scripts/demo-lib.ts`, and the local demo's output is byte-identical. A second, opt-in demo, `npm run demo:base-sepolia` (T-E2E-06), reuses them for a live Base Sepolia run through the CDP facilitator. It is not part of `npm run check`, and it never changes the local baseline.
