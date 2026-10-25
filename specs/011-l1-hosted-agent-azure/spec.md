# Feature Specification: Cloud-Hosted Purchasing Agent (L1) on Mastra and Azure

**Feature Branch**: `011-l1-hosted-agent-azure`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "L1, I want to encapusulate L1 as Cloud Hosted AI Agent using Mastra and Azure as Cloud Infrastructure". Elaborated from the draft plan written in the same session: the agent becomes a network service built with Mastra and hosted on Azure. It keeps exactly the two tools it has today and gains no payment authority. The control (L2) and settlement (L3) layers must stay private, because they listen only on loopback today. Callers of the hosted agent authenticate with their own credential, the service assigns sessions, and every deployment is verified by the baseline regression plan.

## Clarifications

### Session 2026-10-21

- Q: Where do the control and settlement layers run once the agent is in Azure? → A: In the same Azure environment as the agent, on a private network only. Each layer keeps its own cloud identity and secret store, and the payer key is stored in the control layer's secret store in Azure.
- Q: Who may call the hosted agent, and how do they authenticate? → A: Both people and other systems, through the organization's identity provider (Microsoft Entra ID): people sign in, systems use service identities. Either kind needs the "run agent" permission.
- Q: How does the agent reach Claude? → A: Either through Claude in Microsoft Foundry or through the Anthropic API, chosen by configuration. Foundry is the default once the chosen model is confirmed available in the deployment region; otherwise the Anthropic API is used.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A requester gets a purchase done by the cloud-hosted agent (Priority: P1)

A requester, a person or system allowed to use the agent, sends a purchasing goal over the
network to the hosted agent. The agent reads the seller's catalog, buys only what the goal needs
through the control layer, has each payment verified by the settlement layer, and returns a
receipt list: resource, USD amount, settlement status and transaction. The result also carries
the session reference and, for any escalated purchase, its authorization ID. The requester gets
the same outcomes they would get from the agent running locally today.

**Why this priority**: This is the feature. Without it there is no hosted agent.

**Independent Test**: On Base Sepolia, submit the default goal ("today's weather for Lima and a
short market brief") as an authorized requester. The result lists two purchases, both PAID and
CONFIRMED, for 0.006 USDC in total, and the session's budget shows 6000 atomic units spent.

**Acceptance Scenarios**:

1. **Given** an authorized requester and running control and settlement layers, **When** the
   requester submits a goal, **Then** the agent runs it and returns the final text with a
   receipt list, one outcome per resource it requested, the session reference and a run ID.
2. **Given** a goal that needs a resource priced above the auto-approve limit, **When** the agent
   requests it, **Then** the result reports it as ESCALATED with its authorization ID, and nothing
   is paid for it.
3. **Given** a goal that needs a resource the policy denies, **When** the agent requests it,
   **Then** the result reports DENIED with the rule that blocked it, and the agent does not retry.

---

### User Story 2 - The hosted agent has no more payment authority than the local agent (Priority: P1)

Hosting the agent in the cloud and exposing it to requesters must not widen what it can do. The
model sees the same two tools as today and nothing else. The agent service never holds or can
obtain the payer key, never calls operator functions, and its cloud identity cannot read any
secret that belongs to the control or settlement layer. A prompt-injected or compromised agent
can still only ask for a payment.

**Why this priority**: The project exists to prove that separation (Constitution Principle I).
A hosted agent that weakens it would defeat the purpose.

**Independent Test**: Inspect every model request made during a run and see exactly the two
tools. Start the agent service with the payer key visible and see it refuse to start. Call an
operator function with the agent's credentials and see it refused. Try to read the control
layer's secrets with the agent's cloud identity and see access denied.

**Acceptance Scenarios**:

1. **Given** any run, **When** the agent calls the model, **Then** the request offers exactly
   `fetch_resource` and `check_budget`, with today's names, descriptions and inputs, and no other
   tool from any source.
2. **Given** the payer key in the agent service's environment, **When** the service starts,
   **Then** it exits with the refusal before any network or model activity.
3. **Given** the agent's credentials, **When** they are used on an approve, reject or escalation
   read operation, **Then** the call is refused with 401 and the ledger is unchanged.
4. **Given** the agent's cloud identity, **When** it requests a secret held for the control or
   settlement layer, **Then** access is denied.

---

### User Story 3 - Only authorized requesters can run the agent (Priority: P1)

Exposing the agent on a network means anyone who can reach it could try to spend from the
budget. Only requesters who authenticate through the organization's identity provider and hold
the "run agent" permission can start a run. That covers people who sign in and other systems
using service identities. Everyone else is refused before the model is called or any payment is
requested.

**Why this priority**: An open endpoint would let anyone use the daily budget. Access control is
required before the service is reachable at all.

**Independent Test**: Call the agent with no credential, an expired credential, a credential for
another audience and a valid credential without the run permission. Each is refused, and the
control layer's ledger gains no entry. A person's sign-in and a service identity, each with the
permission, both succeed.

**Acceptance Scenarios**:

1. **Given** a request with no credential or an invalid or expired one, **When** it reaches the
   agent service, **Then** it is refused with 401, and no model call, payment request or ledger
   entry follows.
2. **Given** an authenticated requester without permission to run the agent, **When** they submit
   a goal, **Then** the request is refused with 403 and nothing else happens.
3. **Given** a requester at their run limit, **When** they submit another goal, **Then** it is
   refused with 429 until a running run finishes or the window passes.

---

### User Story 4 - The control and settlement layers stay private (Priority: P1)

The agent now runs in the cloud, but the control layer (which holds the payer key) and the
settlement layer must not become reachable from the internet. The agent reaches them only over a
private path with its own per-role credentials. The settlement layer reaches the control layer
the same way. The human operator reaches the control layer's operator functions only through a
private path that does not pass through the agent.

**Why this priority**: Exposing the service that signs payments would be a larger risk than
anything the hosted agent adds.

**Independent Test**: From the public internet, send requests to the control and settlement
layers' addresses. None reaches them: the cloud environment itself refuses (404), and no answer
ever comes from the control or settlement service, such as its 401. From the agent's runtime, authorize a payment with the agent credential and succeed.
From the operator's private path, list pending escalations with the operator credential and
succeed.

**Acceptance Scenarios**:

1. **Given** the deployed environment, **When** anyone on the public internet connects to the
   control or settlement layer, **Then** the request never reaches either service. The cloud
   environment refuses it before any control or settlement code runs, and nothing they would
   answer, such as a 401, ever comes back.
2. **Given** the agent's runtime, **When** it calls authorize or budget with the agent→control
   credential, or verify with the agent→verifier credential, **Then** the call succeeds.
3. **Given** the operator on the private path, **When** they approve, reject or list escalations
   with the operator credential, **Then** the call succeeds. The same operations through the agent
   service do not exist.

---

### User Story 5 - A requester continues their own session after an approval (Priority: P2)

Approvals apply to one session and one resource. When the agent escalates a purchase, the
requester passes the authorization ID to the operator. After the operator approves it, the
requester runs the agent again in the same session, and the purchase goes through. A requester
can continue only their own sessions; nobody can use someone else's session or choose a raw
session ID.

**Why this priority**: The human-approval flow (feature 004) must keep working when the agent is
hosted. It is P2 because every P1 story works without it.

**Independent Test**: Run a goal that escalates the premium report. Approve it as the operator.
Run again with the returned session reference: the report is PAID and CONFIRMED. A second
requester presenting the same session reference is refused.

**Acceptance Scenarios**:

1. **Given** a run that ended with an ESCALATED purchase and an operator approval for it,
   **When** the same requester runs again with that session reference, **Then** the purchase is
   authorized once and settled.
2. **Given** a session reference issued to requester A, **When** requester B presents it, **Then**
   the request is refused without revealing whether the session exists.
3. **Given** a request that carries a raw session ID instead of a session reference, **When** it
   arrives, **Then** it is refused.

---

### User Story 6 - Every deployment is reproducible and proven by a regression run (Priority: P2)

The whole cloud environment is described in the repository and can be created from it. Each
deployment comes from one commit. After it, the baseline scripted plan runs through the deployed
environment on Base Sepolia, and the deployment counts as successful only if the outcomes match
the baseline.

**Why this priority**: The local demo is the project's definition of done. The hosted
environment needs the same proof, or regressions reach a live payer unnoticed.

**Independent Test**: Deploy a commit to an empty environment, run the post-deployment
regression and get `FREE, PAID, PAID, ESCALATED, DENIED, DENIED` with two CONFIRMED settlements
and a verified hash chain.

**Acceptance Scenarios**:

1. **Given** an empty cloud subscription and the repository, **When** an operator follows the
   documented steps, **Then** the environment is created and the regression run passes.
2. **Given** a deployment whose regression run does not match the baseline, **When** it finishes,
   **Then** the deployment is reported failed. The previous agent version keeps serving, and the
   previous control and settlement versions are restored.

---

### User Story 7 - Operators can trace a run without seeing secrets (Priority: P3)

When a requester reports a problem, an operator can find the run and follow it from the goal to
each payment request, decision and settlement, using the run ID, session, intent ID and
authorization ID. Logs and traces never contain keys, tokens, requester credentials or payment
headers.

**Why this priority**: Useful for operating the service, but the ledger already gives a complete
audit trail, so the feature works without it.

**Independent Test**: Run a goal, then find every log and trace record for its run ID and follow
the IDs to the ledger entries. Run the secret scan over all of them: it finds nothing.

**Acceptance Scenarios**:

1. **Given** a finished run, **When** an operator searches by its run ID, **Then** they find the
   requester, the session, each tool call's outcome and the IDs that link to the ledger.
2. **Given** all logs and traces from a regression run, **When** the secret scan runs, **Then**
   it finds no key, token, requester credential or payment header.

---

### Edge Cases

- **Model provider unavailable or slow**: the run ends with an error result. Purchases already
  completed in that run are listed. No payment happens without a control-layer decision. The
  service does not switch providers by itself; switching is a configuration change.
- **Control or settlement layer unreachable**: `fetch_resource` returns ERROR for that resource,
  the agent reports it, and nothing is paid. A failure after money may have moved is reported as
  PAYMENT_FAILED with its authorization ID, as today (L1-1 step 8).
- **Requester disconnects mid-run**: the run stops before its next step. A paid fetch already in
  progress completes and appears in the session's ledger and budget.
- **Run exceeds its time limit** (200 seconds) or step limit (10): it stops before the next step
  and returns what it completed. The time limit stays under the cloud ingress's 240-second idle
  timeout, because a run sends nothing until it finishes.
- **Two runs in the same session at once**: the control layer serializes their decisions, so
  budgets hold (INV-8). The run limit per requester bounds how often this happens.
- **Many requesters at once**: one agent instance runs them concurrently, because runs mostly
  wait on the model. The control layer stays a single instance and handles decisions in order.
  Runs take longer but limits stay exact. Scaling the agent out to several instances would need
  the run limits kept in shared storage, which is out of scope here.
- **Seller content tries to instruct the agent** (prompt injection): it can only change which
  resources the agent asks for. Every payment still goes through the control layer's rules.
- **Agent service restarted mid-run**: the run is lost. The requester can check the session's
  budget and continue the session; the ledger has every decision that was made.
- **Control layer restarted or redeployed**: its ledger survives, is verified at startup, and
  budgets continue from it. A second control-layer instance never runs at the same time.
- **Payer key mistakenly configured for the agent service**: the service refuses to start, so the
  deployment fails its health check and the previous version keeps serving.
- **Goal empty or longer than 4,000 characters**: refused with 400 before any model call.

## Requirements *(mandatory)*

### Functional Requirements

**Hosted agent**

- **FR-001**: The agent service MUST accept a goal from an authorized requester and run the
  purchasing agent on it, returning the final text, one outcome per requested resource
  (resource, outcome, USD amount, settlement status, transaction, authorization ID, violations),
  the session reference and a run ID. *(SPEC: L1-3, proposed L1-6)*
- **FR-002**: The hosted agent MUST behave as the agent does today: the same two tools with the
  same names, descriptions and inputs, the same system prompt rules, at most 10 model turns, at
  most 2048 output tokens per turn, and the same tool result format. *(SPEC: L1-3)*
- **FR-003**: Every model request MUST offer exactly the two tools. The framework MUST NOT add
  tools of its own, such as memory, sub-agent or external tool-server tools.
  *(SPEC: L1-3, SEC-1)*
- **FR-004**: The agent service MUST expose only running a goal (new or continued session) and a
  health check. Development consoles, direct tool execution, memory and agent-management
  operations MUST NOT be reachable. *(SPEC: proposed L1-6, SEC-1)*
- **FR-005**: The agent service MUST refuse a goal that is empty or longer than 4,000 characters
  with 400, before any model call. *(SPEC: proposed L1-6)*
- **FR-006**: The agent MUST reach the model either through Claude in Microsoft Foundry or through
  the Anthropic API, chosen by configuration. Foundry is the default once the configured model is
  confirmed available in the deployment region; otherwise the Anthropic API is used. The choice
  never changes automatically at run time, both paths MUST be covered by tests, and the model
  credential is held only by the agent service. *(SPEC: §3.3 ANTHROPIC_API_KEY row, proposed
  CFG-2 row)*

**Authority boundaries**

- **FR-007**: The agent service MUST refuse to start when the payer key is visible to it, before
  any network or model activity. *(SPEC: INV-3, L1-5, SEC-2)*
- **FR-008**: The agent service MUST NOT call, proxy or expose any operator operation (approve,
  reject, escalation reads) and MUST NOT hold the operator credential. *(SPEC: INV-13, SEC-8)*
- **FR-009**: The agent service MUST hold only its own credentials: model access, agent→control
  and agent→verifier, each used only for its role. A requester's credential MUST NEVER be
  forwarded to the control or settlement layer. *(SPEC: INV-13, §3.3)*
- **FR-010**: Each layer MUST have its own cloud identity and its own secret store access. The
  agent's identity MUST NOT be able to read the payer key or any control or settlement secret,
  and this MUST be checked automatically from the environment definition.
  *(SPEC: INV-2, INV-3, proposed T-IAC-01)*
- **FR-011**: The payer key MUST exist only in the control layer's secret store and process. It
  MUST NOT appear in the agent's environment, any container image, any deployment definition or
  output, or any log. *(SPEC: INV-2, SEC-2)*

**Requester access**

- **FR-012**: Every request MUST carry a valid requester credential issued by the organization's
  identity provider (Microsoft Entra ID): a person's sign-in or a service identity for another
  system. A missing, invalid or expired credential, or one issued for another audience, MUST be
  refused with 401 before any model call or payment request.
  *(SPEC: proposed L1-6, proposed SEC-14)*
- **FR-013**: People and service identities MUST both need the "run agent" permission. An
  authenticated requester without it MUST be refused with 403. *(SPEC: proposed SEC-14)*
- **FR-014**: Each requester MUST be limited to 2 concurrent runs and 20 runs per hour. Beyond
  that, requests MUST be refused with 429. *(SPEC: proposed SEC-14)*

**Sessions**

- **FR-015**: The agent service MUST assign each new run's session and return an opaque session
  reference bound to the requester. A raw session ID supplied by a requester MUST be refused.
  *(SPEC: proposed L1-6, proposed SEC-15)*
- **FR-016**: A requester MUST be able to run a new goal in one of their own sessions by
  presenting its session reference. A session reference issued to another requester MUST be
  refused without revealing whether it exists. *(SPEC: L2-4.2, proposed SEC-15)*
- **FR-017**: Budgets MUST stay exactly as today: the session budget applies per session and the
  daily budget across all sessions and requesters. The hosted agent MUST add no spending path.
  *(SPEC: L2-2 R11, R12, INV-7)*

**Cloud environment**

- **FR-018**: The control and settlement layers MUST run in the same Azure environment as the
  agent, on a private network only. They MUST NOT be reachable from the public internet, and
  each keeps its own cloud identity and secret store (FR-010). *(SPEC: §3.1, Principle V)*
- **FR-019**: The control and settlement services MUST keep listening only on the loopback
  interface of their own runtime unit. They MUST be reachable only from inside the private
  environment, and usable only with each calling role's own credential.
  *(SPEC: §3.1, NFR-001, Principle V)*
- **FR-020**: The control layer MUST run as exactly one instance at any time. Its ledger MUST
  survive restarts and redeployments and MUST be verified at startup. *(SPEC: INV-8, INV-9)*
- **FR-021**: The operator MUST reach the control layer's operator operations only through a
  private path that does not pass through the agent service. *(SPEC: SEC-8, INV-13)*
- **FR-022**: The seller remains an external party. It MUST NOT run inside the private network of
  the control and settlement layers. *(SPEC: §3.1, CP-1)*

**Deployment and verification**

- **FR-023**: The whole cloud environment MUST be defined in the repository and created from it.
  Each deployment MUST come from one commit, and every runtime image MUST be traceable to it.
  *(SPEC: proposed §3.1 cloud profile)*
- **FR-024**: After each deployment, the baseline scripted plan MUST run through the deployed
  environment on Base Sepolia. The deployment succeeds only with the baseline outcomes
  (`FREE, PAID, PAID, ESCALATED, DENIED, DENIED`), two CONFIRMED settlements, a verified hash
  chain and a clean secret scan. Otherwise it is reported failed: the previous agent version keeps
  serving, and the previous control and settlement versions are restored, since only one control
  instance may run at a time. *(SPEC: L1-4, T-E2E-01, T-E2E-06, proposed T-E2E-AZ)*
  *Amended 2026-10-25 (one pipeline per layer):* a deployment is one unit's: the platform and
  sellers, or one layer. The plan runs after each, through every layer. One exception: an L2 or L3
  deployment made before L1 exists, on the first deployment only. It is reported as deployed but
  not verified, and it records no restore point. A failed deployment restores that unit's previous
  version.

**Observability**

- **FR-025**: Each run MUST be attributable to its requester and traceable by run ID, session,
  intent ID and authorization ID across the agent, control and settlement layers.
  *(SPEC: EXT-8 subset, proposed SEC-16)*
- **FR-026**: Logs and traces MUST NOT contain keys, tokens, requester credentials or payment
  headers. The secret scan MUST cover them. *(SPEC: proposed SEC-16, T-E2E-06 secret scan)*
- **FR-027**: The health check MUST report liveness and readiness without revealing
  configuration or secrets. *(SPEC: proposed L1-6)*

**Local parity**

- **FR-028**: The hosted agent MUST also run locally against the local stack. The existing
  command-line agent, the scripted agent and the local demo MUST keep working unchanged.
  *(SPEC: L1-4, L1-5, §13)*

### Non-Functional Requirements

- **NFR-001 (Platform, user-mandated)**: The agent MUST be built with the Mastra agent framework
  and hosted on Azure. The control and settlement layers keep their current implementation.
  *(SPEC: proposed §5 row, proposed §3.1 cloud profile)*
- **NFR-002 (Security, invariants)**: INV-1..INV-13 MUST hold, and the architecture test MUST
  pass with the new code. The agent code MUST depend only on the shared contracts and the agent
  layer's own code. *(SPEC: §4, §4.1)*
- **NFR-003 (Security, test-backed)**: Every new control (tool set, requester authentication,
  session binding, identity separation, private reachability, telemetry redaction) MUST have an
  automated test that fails without it. *(SPEC: Principle VIII)*
- **NFR-004 (Performance)**: The default goal MUST complete within 120 seconds at the 95th
  percentile, excluding time waiting for a human approval. Refusals for missing or invalid
  credentials MUST return within 1 second.
- **NFR-005 (Availability)**: Single region, no service-level commitment. The single control
  instance is an accepted residual risk. A restart MUST NOT lose ledger entries.
- **NFR-006 (Cost)**: The agent service MUST be able to scale down to zero instances when idle.
  The control and settlement layers run one instance each.
- **NFR-007 (Compatibility)**: The `npm run demo:local` summary MUST stay unchanged, and T-AGT-01
  and every existing test MUST pass. *(SPEC: §12, constitution quality gate 3)*
- **NFR-008 (Network scope)**: Base Sepolia only. Mainnet stays out of scope.
  *(SPEC: §1.3)*

### Key Entities

- **Requester**: a person or system allowed to use the agent. It has an identity from the
  requester credential and a permission to run the agent.
- **Run**: one execution of a goal. It has a run ID, requester, session, goal, the outcome of each
  tool call, final text, status (completed, failed, stopped) and timestamps.
- **Session reference**: an opaque handle bound to one requester that maps to one control-layer
  session. Approvals and the session budget apply to that session.
- **Layer runtime unit**: the agent, control or settlement service as deployed. Each has its own
  cloud identity, its own secrets and its own network exposure (public for the agent, private for
  the others).
- **Deployment**: one unit (the platform and sellers, or one layer) deployed from one commit. It
  has its image, its environment definition and the result of its regression run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of post-deployment regression runs, the hosted environment produces the
  baseline outcomes, two CONFIRMED settlements and 0.006 USDC spent on-chain.
- **SC-002**: 100% of requests without a valid credential or run permission are refused, and none
  of them adds a ledger entry or makes a model call.
- **SC-003**: 0 attempts succeed at using the agent's credentials or identity for an operator
  operation, a control or settlement secret or the payer key.
- **SC-004**: 100% of model requests made in tests and regression runs offer exactly two tools.
- **SC-005**: The payer key is found in 0 places outside the control layer's secret store and
  process, across images, deployment definitions, agent environment, logs and traces. Images and
  deployment definitions are scanned on every deployment. For logs, a test with known values
  proves that no code path prints the key, because a key can't be told apart from a transaction
  hash by its shape.
- **SC-006**: 0 requests from the public internet reach the control or settlement service.
  Every such request is refused by the cloud environment, and none gets an answer from either
  service.
- **SC-007**: After an operator approval, continuing the session completes the escalated purchase
  on the first attempt in 100% of test runs, and 0 requests succeed with another requester's
  session reference.
- **SC-008**: A new environment can be created from the repository in under 60 minutes by
  following the documented steps, and a new commit can be deployed and verified in under 15
  minutes.
- **SC-009**: The default goal completes within 120 seconds at the 95th percentile.
- **SC-010**: The `npm run demo:local` summary is unchanged, and the existing test suite passes.

## Assumptions

- **Payer key in Azure.** With all three layers in Azure (clarification 1), the payer key is
  stored in the control layer's secret store there. Only the control layer's identity can read
  it. Azure administrators with rights over that store are trusted, which is a new residual risk
  for SPEC §11. A hardware-backed or remote signer (EXT-2) would reduce it later.
- **Single tenant.** One payer, one mandate and one daily budget are shared by all requesters.
  Per-requester budgets and multi-tenancy are out of scope (SPEC §1.3).
- **API only.** Requesters use the service through its API. A chat interface for end users is
  out of scope.
- **No conversation memory.** Each run starts fresh. Continuing a session means running a new
  goal in that session; the agent does not remember earlier runs. This also keeps
  framework-added memory tools out (FR-003).
- **Requester limits**: 4,000-character goals, 2 concurrent runs and 20 runs per hour per
  requester, a 200-second run limit (set in planning to fit the ingress idle timeout).
- **Requester identity stays in the agent layer.** The control layer does not learn who the
  requester is, and the shared contracts do not change. Recording the requester in the ledger
  would be a later feature.
- **Out of scope**: mTLS between layers (EXT-7), a remote or hardware-backed signer (EXT-2), a
  database-backed ledger (EXT-6), full cross-layer telemetry beyond FR-025 (EXT-8), refunds
  (EXT-9), high availability for the control layer, multiple regions and mainnet.
- **Seller on Base Sepolia.** The demo seller is deployed as an external party, and the CDP
  facilitator setup from feature 009 is unchanged.
- **Builds on SPEC v1.4.** PR #5 (API docs, SEC-13) is merged, so the proposed SEC IDs start at
  SEC-14.
- **SPEC.md changes** (for the plan): a new L1-6 "Hosted agent service" section, a cloud profile
  in §3.1, new credential rows in §3.3 (requester credential, model access in the cloud),
  agent-service variables in CFG-2, a §5 row for the agent framework, threats SEC-14 (abuse of
  the public agent endpoint), SEC-15 (use of another requester's session) and SEC-16 (secrets or
  payment headers in telemetry), and new tests (proposed T-AGT-02 tool set, T-AGT-03 requester
  access, T-IAC-01 identity separation, T-E2E-AZ cloud regression).
