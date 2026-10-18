<!--
Sync Impact Report
- Version change: 1.1.0 → 1.1.1 (PATCH, 2026-10-18, feature 010-operator-reject-flow)
- Modified principles: I. Separation of Payment Authority (clarification: the agent never gets a tool
  that rejects, alongside signs, approves or edits policy). No principle is redefined or removed.
- Modified sections: none
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.3 (Changes in 1.3, L2-2 R15, L2-4.3, L2-5, §11 SEC-8/SEC-12)
- Deferred TODOs: none

Previous report (1.1.0)
- Version change: 1.0.0 → 1.1.0 (MINOR, 2026-10-17, feature 009-cdp-facilitator-base-sepolia)
- Modified principles: V. Least-Privilege Credentials (adds a bullet on third-party API credentials)
- Modified sections: Technology & Scope Constraints (the stack adds the CDP SDK, auth subpath, seller
  only; residual risks add facilitator visibility of payment metadata)
- Removed sections: none
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.2 (Changes in 1.2, §3.3, §4.1 A8, §5, §11 SEC-10/SEC-11)
- Deferred TODOs: none

Previous report (1.0.0)
- Version change: template → 1.0.0 (initial ratification)
- Principles defined: I. Separation of Payment Authority; II. Deterministic, Pure Policy;
  III. Ledger Is the Single Source of Truth; IV. Trust the Chain, Not the Counterparty;
  V. Least-Privilege Credentials; VI. Exact Money Arithmetic; VII. Protocol Fidelity;
  VIII. Proven Safety (Test-Backed Controls)
- Added sections: Technology & Scope Constraints; Development Workflow & Quality Gates; Governance
- Removed sections: none
- Templates reviewed: plan-template.md (Constitution Check gate applies as-is),
  spec-template.md (no change), tasks-template.md (no change)
- Source: SPEC.md v1.0 §0, §4 (INV-1..INV-13), §5, §11, §12; CLAUDE.md "Hard rules"
- Deferred TODOs: none
-->

# x402 Three-Layer Agent Payments Constitution

## Core Principles

### I. Separation of Payment Authority (NON-NEGOTIABLE)

Payment authority is split across three isolated layers: Intent (L1), Control (L2) and
Settlement (L3). The isolation holds at the module, process and credential level.

- A layer MUST depend only on the shared contract module and its own code. Cross-layer
  wiring is allowed only in composition roots, scripts and tests. (INV-1)
- Only the L2 signer component MAY turn key material into a signing account. (INV-2)
- The agent (L1) MUST NOT reference the payer key and MUST refuse to start if the payer
  key is visible in its environment. (INV-3)
- The settlement verifier (L3) MUST be read-only: no signing and no on-chain writes. (INV-4)
- The agent MUST NEVER be given a tool that signs, approves, rejects or edits policy.

Rationale: a prompt-injected or compromised agent can ask for a payment, but it cannot make
one happen.

### II. Deterministic, Pure Policy

- The authorization decision MUST be a pure function of (offered payment options, mandate,
  context). It does no I/O, takes time as an input, and is never influenced by LLM text.
  The agent's stated purpose is logged only. (INV-5)
- L2 MUST sign exactly one payment option: the one the policy chose. (INV-6)
- The check → sign → record sequence MUST be serialized across concurrent requests. (INV-8)
- A human approval MUST NEVER override a DENY rule. It lifts only the approval requirement,
  for one exact (session, resource, payee, amount) tuple, once. (INV-12)

Rationale: authorization must be reproducible, auditable and race-free.

### III. Ledger Is the Single Source of Truth

- Budget figures MUST be derived from the ledger. Mutable spend counters are forbidden. (INV-7)
- The ledger MUST be append-only and hash-chained. Startup MUST fail if the chain does not
  verify. Entries are never rewritten or deleted; new facts are new entry types. (INV-9)
- A CONFIRMED settlement is final. A later contradicting report MUST be recorded as an
  anomaly and MUST NOT change the effective status. (INV-11)

### IV. Trust the Chain, Not the Counterparty

- Settlement is confirmed only by on-chain evidence: a successful transaction receipt plus a
  matching token Transfer of (payer, payee, amount, asset). The seller's own payment
  response is a claim, not proof. (INV-10)
- Finality requirements scale with the amount at risk.

### V. Least-Privilege Credentials

- Every caller role (agent→control, agent→verifier, verifier→control, operator→control) MUST
  use its own credential. One credential MUST NEVER authorize two roles. (INV-13)
- Secrets are scoped per process. A shared environment file containing the payer key is
  forbidden.
- A third-party API credential (for example, the seller's CDP facilitator key) is held by
  exactly one process and confined to one file by an architecture rule. It must never become
  payment authority.
- Internal control and verifier services listen only on the loopback interface.

### VI. Exact Money Arithmetic

- All amounts are integer atomic units represented as decimal strings. Arithmetic MUST use
  arbitrary-precision integers. Floating-point money math is forbidden.

### VII. Protocol Fidelity

- Payments follow x402 protocol v2, scheme `exact`, with EIP-3009 USDC authorizations.
- Protocol headers MUST be encoded and decoded with the official x402 SDK helpers, never by
  hand.
- Payment headers produced by L2 are opaque to L1 and are forwarded unchanged.

### VIII. Proven Safety (Test-Backed Controls)

- Every invariant, policy rule, endpoint and contract field MUST have an automated test.
- Every new safety mechanism MUST be shown to fail without the mechanism. For example, the
  concurrency test authorizes 15/15 without the mutex and 10/15 with it.
- Never weaken an invariant to make a test pass.

## Technology & Scope Constraints

- Stack (pinned, SPEC.md §5): Node.js 22 ESM, strict TypeScript, x402 SDK 2.28.0, viem,
  express, Anthropic SDK and vitest. Ganache and solc are used for the local chain only. The
  CDP SDK 1.59.0 is used by the seller only, through its auth subpath, to sign facilitator JWTs.
- Networks in scope: `local` (dev chain with a mock EIP-3009 USDC) and `base-sepolia`
  (testnet USDC). Mainnet is out of scope.
- Out of scope for v1: refunds and disputes, the `upto` and `batch-settlement` schemes,
  Solana, AP2, ACP, Visa TAP, Mastercard Agent Pay, multi-tenancy, a persistent DB beyond
  JSONL, and mTLS. Each extension (EXT-1..EXT-9) is delivered one per change and MUST
  preserve every invariant.
- Cross-layer types live only in the shared contract module. Changing them is a contract
  change: update every producer, consumer and test together.
- Accepted residual risks (v1): bearer tokens over loopback, key in an environment variable,
  single-node JSONL ledger, facilitator trusted for liveness, no refund path. Added in 1.1.0:
  the hosted facilitator sees payment metadata (payer, payee, amount, resource), and a settle
  timeout without a transaction hash is indeterminate.

## Development Workflow & Quality Gates

A change is done only when:

1. Type checking passes.
2. The full test suite passes, including the architecture test.
3. The local demo summary is unchanged (`spent on-chain: 0.006 USDC`, `hash chain ok=true`).
   An intentional plan or price change is allowed only together with an updated SPEC.md.
4. SPEC.md is updated for any behavior or contract change, in the same change.
5. Requirement IDs (INV-*, L1-*, L2-*, L3-*, CP-*, CFG-*, SEC-*, T-*) are referenced in
   commit messages and test names.

New policy rules get a snake_case rule ID, a row in the SPEC rule table and a policy test.

## Governance

- SPEC.md is normative. If code and spec disagree, the spec wins. Fix the code, or amend the
  spec first in the same change with a stated reason. This constitution captures the
  non-negotiable subset of SPEC.md; the feature specs under `specs/` decompose it by area.
- Amendments: change SPEC.md and this file together, bump the version and record a Sync
  Impact Report.
- Versioning: MAJOR when a principle or invariant is removed or redefined; MINOR when a
  principle or section is added; PATCH for clarifications.
- Compliance: every plan MUST pass a Constitution Check against Principles I–VIII before
  design and again before implementation. Every review verifies the quality gates above.
- Runtime guidance for agents lives in `CLAUDE.md`.

**Version**: 1.1.1 | **Ratified**: 2026-10-16 | **Last Amended**: 2026-10-18
