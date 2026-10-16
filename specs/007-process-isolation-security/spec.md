# Feature Specification: Process Isolation & Security Model

**Feature Branch**: `007-process-isolation-security`

**Created**: 2026-10-16

**Status**: Draft — derived from SPEC.md v1.0 (implemented PoC)

**Input**: Derived from SPEC.md §3.1, §3.3, §4 (INV-1, INV-2, INV-3, INV-4, INV-13), §5, §9 (CFG-2), §11 (SEC-1..SEC-9, residual risks), §12 (T-ARCH-*, T-E2E-05, manual key-refusal check)

This is a cross-cutting specification. It sets the isolation, credential and threat-model
requirements that every other feature (001–006) must keep. When a control's behavior is
owned by another feature, this spec states the security outcome and cross-references the
owner instead of repeating the detail.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The agent can never sign a payment (Priority: P1)

The payer (mandate owner) runs an LLM agent that buys HTTP resources. They need assurance
that even a fully compromised or prompt-injected agent process cannot move funds. The agent
process never holds the payer key. It can only *ask* the Control layer for an authorization.

**Why this priority**: This is the core security claim of the proof of concept (SPEC §1.1).
Without it, the three-layer split has no value.

**Independent Test**: Start the agent with the payer key present in its environment and
confirm it refuses to start. Run the static architecture checks and confirm that no
agent-layer code references the payer key and that only the signer component creates a
signing account (T-ARCH-*, §12 manual check).

**Acceptance Scenarios**:

1. **Given** the payer key variable is set in the agent's environment, **When** the agent
   process starts (in either scripted or LLM mode), **Then** it prints a refusal message and
   exits with code 1 before doing any work.
2. **Given** the source tree, **When** the architecture checks run, **Then** they find no
   reference to the payer key in agent-layer code (T-ARCH, INV-3).
3. **Given** the source tree, **When** the architecture checks run, **Then** exactly one
   Control-layer signer component turns key material into an account, and nothing else does
   (T-ARCH, INV-2).
4. **Given** the agent's tool set, **When** it is inspected, **Then** it offers exactly two
   tools, neither of which signs, approves or edits policy (T-AGT-01, owned by 001).

---

### User Story 2 - Layer boundaries hold at module level (Priority: P1)

An agent developer changing one layer must not be able to wire in another layer's internals.
That kind of shortcut silently erodes the separation of authority. Layers talk to each other
only through the shared contracts. Only the composition roots, scripts and tests wire layers
together.

**Why this priority**: Module isolation is what makes process and credential isolation
auditable. Static enforcement catches regressions on every test run.

**Independent Test**: Add a deliberate import from one layer into another and confirm the
architecture test fails. Remove it and confirm the test passes (T-ARCH, INV-1).

**Acceptance Scenarios**:

1. **Given** a layer module imports from another layer's folder, **When** the architecture
   test runs, **Then** it fails and names the offending import.
2. **Given** a layer imports only shared contracts and its own folder, **When** the
   architecture test runs, **Then** it passes.
3. **Given** a composition root, script or test imports from several layers, **When** the
   architecture test runs, **Then** it passes.
4. **Given** Settlement-layer (L3) code, **When** the architecture test runs, **Then** it
   finds no wallet-client creation, typed-data signing or contract-write capability (INV-4).

---

### User Story 3 - Each caller role has its own credential (Priority: P1)

The human operator needs each inter-process call to be authenticated with a credential
specific to that caller's role. A leaked agent credential must not let anyone reconcile
settlements or approve escalations. A leaked verifier credential must not let anyone
authorize payments.

**Why this priority**: Per-role credentials stop a compromised agent from forging
settlement reports or approving its own escalations (SEC-5, SEC-8).

**Independent Test**: Call each protected Control endpoint with every other role's
credential and confirm each call is rejected with 401 (T-E2E-05, T-E2E-02).

**Acceptance Scenarios**:

1. **Given** the agent's control credential, **When** it is used to submit a settlement
   reconciliation, **Then** the Control layer returns 401 (T-E2E-05).
2. **Given** the agent's control credential, **When** it is used to approve an escalation,
   **Then** the Control layer returns 401 (T-E2E-02, owned by 004).
3. **Given** the verifier-to-control credential, **When** it is used to request an
   authorization, **Then** the Control layer returns 401 (INV-13).
4. **Given** each role's own credential, **When** it is used on that role's endpoints,
   **Then** the request is accepted.

---

### User Story 4 - Secrets are scoped per process (Priority: P2)

The human operator configures six processes. Each process loads exactly one environment
file, holding only the secrets that process needs (per the credential matrix). The payer key
can never sit in a file the agent also reads.

**Why this priority**: Per-process configuration is the operational counterpart of process
isolation. It is lower than P1 because enforcement at agent startup (Story 1) already
contains the worst failure.

**Independent Test**: Check each environment template against the credential matrix.
Confirm the agent template has no payer key and the Control template has no LLM key.

**Acceptance Scenarios**:

1. **Given** the environment templates, **When** they are compared to the credential matrix,
   **Then** every secret appears only in the templates of the processes allowed to hold it.
2. **Given** a process is started, **When** it loads configuration, **Then** it reads only the
   file named by its own environment-file selector.
3. **Given** no tokens are configured, **When** the processes start on the local network,
   **Then** they use the documented development tokens. These tokens are not acceptable
   outside local use.

---

### User Story 5 - The threat model is fully covered by controls (Priority: P2)

An auditor reviewing the proof of concept needs every identified threat (SEC-1..SEC-9)
mapped to at least one implemented control and one verifying test. The residual risks must
be stated explicitly as accepted.

**Why this priority**: This makes the security posture reviewable. It depends on controls
delivered by features 001–006.

**Independent Test**: For each SEC-* threat, find the control and the test named in this
spec and confirm that test passes.

**Acceptance Scenarios**:

1. **Given** the threat table, **When** an auditor traces each SEC-* entry, **Then** each one
   resolves to a control requirement and a passing test ID.
2. **Given** the residual risks, **When** an auditor reviews the Assumptions, **Then** each
   accepted risk is listed with the extension that would retire it.

---

### Edge Cases

- The payer key is present but empty, or set to a dummy value such as `0x1`: the agent still
  refuses to start, because presence alone triggers the refusal.
- The agent is started with an environment-file selector pointing at an empty file such as
  `/dev/null`, while the key is in the parent shell environment: the agent still refuses.
- A port override env var moves a service to another port: Control and Verifier still bind
  only to loopback.
- A test file or script imports several layers: allowed, and not flagged by the architecture
  test.
- A dynamic or re-exported import tries to reach across layers through the shared folder:
  the shared folder MUST hold only contracts and configuration, not re-exports of layer code.
- A request carries a bearer token that is missing, malformed or belongs to another role: it
  is rejected with 401 and has no side effects. In particular, no ledger entry is written.
- The local facilitator is started on a non-local network: it exits (owned by 006).

## Requirements *(mandatory)*

### Functional Requirements

**Process topology**

- **FR-001**: The system MUST run as six separate processes: Agent (L1, client only), Control
  (L2), Settlement Verifier (L3), Seller, local Facilitator (local network only) and local
  chain (local network only). *(SPEC: §3.1)*
- **FR-002**: Default ports MUST be Control 4020, Seller 4021, Facilitator 4022, Verifier 4023
  and local chain 8545. Each service port MUST be overridable through its own variable
  (`CONTROL_PORT`, `SELLER_PORT`, `FACILITATOR_PORT`, `SETTLEMENT_PORT`). *(SPEC: §3.1)*
- **FR-003**: The Agent process MUST NOT open any listening port. *(SPEC: §3.1)*

**Module isolation (static)**

- **FR-004**: Code in each layer (Intent, Control, Settlement) and in the counterparty MUST
  import only the shared contracts/configuration and its own folder. Only composition roots,
  scripts and tests MAY import across layers. *(SPEC: INV-1, §6)*
- **FR-005**: All types that cross a layer boundary MUST be defined only in the shared
  contract module. *(SPEC: §7, INV-1)*
- **FR-006**: Exactly one Control-layer signer component MAY convert key material (private
  key or mnemonic) into a signing account. No other module may do so. *(SPEC: INV-2)*
- **FR-007**: No Intent-layer (L1) code may reference the payer private key variable.
  *(SPEC: INV-3)*
- **FR-008**: Settlement-layer (L3) code MUST NOT create a wallet client, sign typed data or
  write to a contract. Its chain access is read-only. *(SPEC: INV-4, §3.3)*
- **FR-009**: An automated architecture test MUST enforce FR-004, FR-006, FR-007 and FR-008
  on every test run. Any violation fails the suite. *(SPEC: T-ARCH-*, INV-1..INV-4)*

**Runtime key refusal**

- **FR-010**: The Agent composition root MUST exit with code 1 and a refusal message if the
  payer private key variable is present in its environment, whatever its value, before it
  contacts any other process. *(SPEC: INV-3, L1-5, §12 manual check)*

**Credential matrix**

- **FR-011**: Secrets MUST be distributed exactly per the credential matrix:
  - Payer key: Control only.
  - LLM API key: Agent only.
  - Control token: Agent holds it, Control verifies it.
  - Verifier token: Agent holds it, Verifier verifies it.
  - Settlement token: Verifier holds it, Control verifies it.
  - Operator token: human operator holds it, Control verifies it.
  - Facilitator key: local Facilitator only.

  *(SPEC: §3.3)*
- **FR-012**: Each caller role MUST authenticate with its own bearer token:
  - Agent→Control: authorize and budget.
  - Agent→Verifier: settlement claims.
  - Verifier→Control: reconcile.
  - Operator→Control: approvals and ledger verification.

  A token MUST NOT be accepted for any endpoint outside its role. *(SPEC: INV-13, L2-5, L3-2)*
- **FR-013**: A request with a missing or wrong-role token MUST be rejected with HTTP 401
  and MUST NOT change any state. *(SPEC: INV-13, L2-5, L3-2, T-E2E-05)*
- **FR-014**: The agent MUST NOT be able to reconcile settlements or approve escalations.
  The verifier MUST NOT be able to authorize payments. *(SPEC: INV-13, SEC-5, SEC-8)*

**Per-process configuration**

- **FR-015**: Each process MUST load configuration from exactly one environment file, chosen
  by an environment-file selector (`ENV_FILE=env/<role>.env`). A template MUST exist per
  role: agent, control, verifier, seller, facilitator and operator. *(SPEC: CFG-2)*
- **FR-016**: Each role's template MUST contain only the variables listed for that role in
  CFG-2. In particular, the agent template MUST NOT contain the payer key and the Control
  template MUST NOT contain the LLM API key. *(SPEC: CFG-2, §3.3)*
- **FR-017**: A shared environment file containing the payer private key MUST NOT exist or
  be documented. *(SPEC: CFG-2; constitution Principle V)*
- **FR-018**: Development default tokens (`dev-control-token`, `dev-settlement-token`,
  `dev-verifier-token`, `dev-operator-token`) MUST be documented as local-only.
  *(SPEC: CFG-2)*

**Threat model controls (consolidated)**

- **FR-019**: SEC-1 (prompt injection causes overspend). The agent has no signing tool.
  Every payment is checked by Control rules R1–R14 and by session and daily budgets.
  Owner: 001 (tools), 002 (rules). *(SPEC: SEC-1; verified by T-E2E-01, T-POL-*)*
- **FR-020**: SEC-2 (agent compromise leaks the key). The key exists only in the Control
  process (FR-011), and the agent refuses to start with it present (FR-010). Owner: this
  feature. *(SPEC: SEC-2; verified by T-ARCH, §12 manual)*
- **FR-021**: SEC-3 (malicious seller swaps the payee or redirects). Enforced by the payee
  allowlist (R5), host allowlist (R6) and resource binding (R7). Owner: 002.
  *(SPEC: SEC-3; verified by T-POL-05/07/08, T-POL-11)*
- **FR-022**: SEC-4 (seller claims payment without settling, or replays an old
  transaction). The Verifier confirms only with a successful receipt and a matching Transfer
  of (payer, payee, amount, asset). Owner: 005. *(SPEC: SEC-4, INV-10; verified by T-E2E-03)*
- **FR-023**: SEC-5 (forged or contradictory settlement reports). Control cross-checks the
  verified fields, CONFIRMED is sticky, and the verifier has its own token. Owner: 003
  (cross-check, stickiness) and this feature (token). *(SPEC: SEC-5, INV-11, INV-13;
  verified by T-E2E-03, T-E2E-05)*
- **FR-024**: SEC-6 (a concurrent burst bypasses limits). Authorization decisions are
  serialized. Owner: 002. *(SPEC: SEC-6, INV-8; verified by T-E2E-04)*
- **FR-025**: SEC-7 (audit tampering). The ledger is hash-chained, and startup fails on an
  integrity break. Owner: 003. *(SPEC: SEC-7, INV-9; verified by T-LED-01)*
- **FR-026**: SEC-8 (the agent approves its own escalation). Approvals require the operator
  token, are single-use and match the exact tuple. Owner: 004. *(SPEC: SEC-8, INV-12;
  verified by T-E2E-02)*
- **FR-027**: SEC-9 (a stale signature settles late). Committed spend keeps counting an
  unsettled authorization until its validity window ends. Owner: 003. *(SPEC: SEC-9;
  verified by T-LED-02)*

### Non-Functional Requirements

- **NFR-001 (Security, network exposure)**: The Control and Settlement Verifier services
  MUST bind only to the loopback interface (127.0.0.1), whatever port override is set.
  *(SPEC: §3.1, L2-5, L3-2)*
- **NFR-002 (Security, invariant integrity)**: No change may weaken or remove an INV-*
  invariant to make a test pass. Any change to an invariant requires amending SPEC.md first,
  in the same change and with a stated reason. *(SPEC: §0.4, §0.1)*
- **NFR-003 (Security, least privilege)**: Each process MUST be startable with only the
  secrets assigned to it in the credential matrix. No process may need another role's secret
  to start. *(SPEC: §3.3, CFG-2)*
- **NFR-004 (Verifiability)**: The isolation invariants INV-1, INV-2, INV-3 (static part) and
  INV-4 MUST be checked automatically on every full test run, with no network or chain
  access needed. *(SPEC: T-ARCH-*)*
- **NFR-005 (Auditability)**: Every SEC-* threat MUST map to at least one named control and
  at least one test ID, and that mapping MUST be kept up to date in the spec.
  *(SPEC: §11)*
- **NFR-006 (Fail-closed)**: Authentication failures MUST fail closed with HTTP 401. Missing
  configuration for a role's token MUST NOT fall back to accepting unauthenticated requests.
  The documented development default tokens apply only when `NETWORK=local`; otherwise a
  missing or empty token is a startup error.
  *(SPEC: L2-5, L3-2, CFG-2)*
- **NFR-007 (Platform constraint)**: The implementation MUST stay on the pinned stack in
  SPEC §5 (runtime, language mode, x402 SDK version 2.28.0, chain client, HTTP server, LLM
  SDK, test runner). Protocol headers MUST be produced and parsed only through the x402 SDK
  helpers. *(SPEC: §5, §10)*

### Key Entities

- **Process**: One OS process with one role (Agent, Control, Verifier, Seller, Facilitator,
  Chain). Attributes: port (if any), bind interface, environment file, and the secrets it
  holds.
- **Credential**: A secret with exactly one holder role and one verifier role. Kinds: payer
  key, facilitator key, LLM API key, and bearer tokens (control, verifier, settlement,
  operator).
- **Role**: A caller identity (agent, verifier, operator). It is scoped to one set of
  endpoints.
- **Invariant (INV-*)**: A non-negotiable property, enforced by an automated or manual check.
- **Threat (SEC-*)**: An identified attack, mapped to controls, an owning feature and tests.
- **Accepted residual risk**: A known gap, explicitly accepted for v1, with a planned
  extension that would close it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of agent startups with the payer key present exit with code 1, in both
  scripted and LLM modes, and no other process is contacted.
- **SC-002**: The architecture checks report 0 cross-layer imports, exactly 1 module that
  creates a signing account, 0 payer-key references in agent code, and 0 write or signing
  capabilities in Settlement code.
- **SC-003**: Every wrong-role token use tested is rejected with 401. At minimum this covers
  the agent token on reconcile and on approval. No ledger entries are written for these
  calls.
- **SC-004**: 9 of 9 SEC-* threats trace to a control requirement and a passing test.
- **SC-005**: 6 of 6 environment templates match their CFG-2 variable lists exactly, and 0
  templates outside Control contain the payer key.
- **SC-006**: Port scans from a non-loopback interface find Control and Verifier
  unreachable, while the Seller stays reachable.

## Assumptions

- **Accepted residual risks (v1)**: These are documented and not mitigated in this feature:
  - Bearer tokens over loopback instead of mutual TLS (EXT-7 retires this).
  - The payer key held in an environment variable instead of a remote signer or KMS (EXT-2).
  - A single-node JSONL ledger (EXT-6).
  - The facilitator trusted for liveness.
  - No refund path (EXT-9).
- The Seller binds to all interfaces by design: it is the public counterparty. The local
  Facilitator and chain are development-only.
- The §12 manual check (start the agent with a dummy key and an empty env file, and expect
  exit code 1) is the runtime proof of INV-3. The architecture test covers the static part.
- Development default tokens are acceptable on the local network only. No enforcement
  mechanism beyond documentation is required in v1.
- Dependencies: the controls referenced in FR-019 through FR-027 are delivered by features
  001 (agent tools), 002 (policy and serialization), 003 (ledger and reconciliation), 004
  (approvals), 005 (settlement verification) and 006 (counterparty and networks).
- How each control is enforced (file names, the forbidden-API list and test mechanics) is
  specified in SPEC.md §4, §6 and §12.
