# Feature Specification: Agent Paid Fetch (Layer 1 — Intent & Orchestration)

**Feature Branch**: `001-agent-paid-fetch`

**Created**: 2026-10-16

**Status**: Draft — derived from SPEC.md v1.0 (implemented PoC)

**Input**: Derived from SPEC.md §1, §3.2, §8.1 (L1-1..L1-5), §10, §11 (SEC-1), §12 (T-AGT-01, T-E2E-01)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent buys a paid resource without holding payment authority (Priority: P1)

An agent developer gives the agent a goal that needs a paid HTTP resource. The agent requests
the resource and gets an x402 payment challenge (HTTP 402). It asks the Control layer to
authorize the payment and retries with the opaque payment headers that Control returns. It
then asks the Settlement layer to verify settlement. Finally it receives the resource with a
receipt. At no point does the agent hold or use a signing key.

**Why this priority**: This is the core value of the PoC: an LLM agent pays for resources while
payment authority stays elsewhere.

**Independent Test**: Run the paid fetch for a $0.001 weather resource against a compliant
seller. The outcome is PAID, the settlement is CONFIRMED, and the payer's on-chain balance
drops by exactly 1000 atomic units (T-E2E-01, step 2).

**Acceptance Scenarios**:

1. **Given** a seller that answers 402 with a valid challenge and a Control layer that authorizes, **When** the agent fetches the resource, **Then** the result is `PAID` with the response body, the authorization ID and a settlement report of CONFIRMED or PENDING.
2. **Given** a resource that does not return 402, **When** the agent fetches it, **Then** the result is `FREE` with the HTTP status and body. No authorization is requested.
3. **Given** Control returns AUTHORIZED, **When** the agent retries the request, **Then** it forwards the returned payment headers unchanged.

---

### User Story 2 - Agent respects denials and escalations (Priority: P1)

When Control denies or escalates a payment, the agent stops for that resource and does not
retry. It reports which rule blocked the payment. For an escalation, it reports the
authorization ID so a human can approve.

**Why this priority**: It is the agent-side half of SEC-1. A prompt-injected or confused agent
cannot get around policy.

**Independent Test**: Run the scripted plan. The premium report (50000 atomic) ends ESCALATED
with `human_approval_required`. The dataset export (500000 atomic) ends DENIED with
`hard_cap_exceeded`. The weather resource requested through the `localhost` alias ends
DENIED with `host_not_allowed` (T-E2E-01).

**Acceptance Scenarios**:

1. **Given** Control returns DENIED, **When** the agent handles the result, **Then** the outcome is `DENIED` with the violations and authorization ID, and no second request is sent to the seller.
2. **Given** Control returns ESCALATE, **When** the agent handles the result, **Then** the outcome is `ESCALATED` with the violations and authorization ID, and no payment is attempted.
3. **Given** the LLM agent receives a DENIED tool result, **When** it continues, **Then** it does not retry that payment and explains the blocking rule in its final answer.

---

### User Story 3 - LLM agent completes a goal with a bounded, safe toolset (Priority: P2)

An agent developer runs the Claude-driven agent with a natural-language goal. The agent
starts at the seller catalog and buys only what the goal needs, preferring cheaper items. It
can check its budget. It ends with a receipt list. It has exactly two tools, and neither can
sign, approve or edit policy.

**Why this priority**: This demonstrates probabilistic reasoning on top of deterministic
control. The scripted agent already covers the payment mechanics.

**Independent Test**: Use a fake model client that issues tool calls (T-AGT-01). Exactly two
tools are offered. Intents carry the model's `purpose`. The tool result contains PAID and
CONFIRMED.

**Acceptance Scenarios**:

1. **Given** the agent is started with a goal, **When** it builds its model request, **Then** it offers exactly `fetch_resource(url, purpose)` and `check_budget()`.
2. **Given** the model calls `fetch_resource`, **When** the paid fetch completes, **Then** the tool result is JSON containing the outcome, HTTP status, body, payment (authorization ID, amount in USD, settlement status, transaction and finality), violations, authorization ID and error.
3. **Given** the model keeps calling tools, **When** 10 turns have run, **Then** the agent stops.

---

### User Story 4 - Deterministic scripted agent as the regression baseline (Priority: P2)

An agent developer runs a scripted agent that uses no LLM. It runs a fixed six-step plan, so
regressions in any layer show up as a changed outcome sequence.

**Why this priority**: It gives a deterministic baseline for CI and the demo.

**Independent Test**: The scripted run yields outcomes `[FREE, PAID, PAID, ESCALATED, DENIED,
DENIED]` (T-E2E-01).

**Acceptance Scenarios**:

1. **Given** a fresh session, **When** the scripted plan runs, **Then** each step produces the expected outcome below:

   | # | Request | Price (atomic) | Expected outcome |
   |---|---|---|---|
   | 1 | catalog | free | FREE |
   | 2 | weather (city=Lima) | 1000 | PAID, CONFIRMED |
   | 3 | market brief | 5000 | PAID, CONFIRMED |
   | 4 | premium report | 50000 | ESCALATED (`human_approval_required`) |
   | 5 | dataset export | 500000 | DENIED (`hard_cap_exceeded` plus budget rules) |
   | 6 | weather via host alias `localhost` | 1000 | DENIED (`host_not_allowed`) |

---

### User Story 5 - Agent process refuses to run with the payer key (Priority: P1)

An operator might misconfigure the environment so that the payer private key is visible to
the agent process. The agent then refuses to start.

**Why this priority**: This enforces process-level isolation of payment authority (INV-3,
SEC-2).

**Independent Test**: Start the agent with the payer key variable set and an empty env file.
It exits with code 1 and a refusal message (SPEC §12 manual check).

**Acceptance Scenarios**:

1. **Given** the payer private key variable is present in the agent's environment, **When** the agent starts, **Then** it exits with code 1 before doing any work.
2. **Given** no session ID is configured, **When** the agent starts, **Then** it generates `sess_<8 hex>`. Otherwise it uses the configured ID.
3. **Given** a run completes, **When** the agent exits, **Then** it prints the final budget status for its session.

---

### Edge Cases

- If the seller is unreachable on the first request (network error), the outcome is `ERROR`.
- If a 402 response has no `PAYMENT-REQUIRED` header, the agent parses the body as JSON (v1 fallback). If that also fails, the outcome is `ERROR`.
- If a non-402 body is not JSON, it is returned as text truncated to 2000 characters.
- If the paid retry returns non-2xx, or settlement is MISMATCH or NOT_SETTLED, the outcome is `PAYMENT_FAILED`. The body is included only if the response was 2xx.
- If the paid retry is 2xx but there is no `PAYMENT-RESPONSE` header, the claim carries a null header and L3 decides (NOT_SETTLED → `PAYMENT_FAILED`).
- If Control or Verifier returns non-2xx (for example 401 because of a wrong token), the port call fails. The agent does not treat that as an authorization.
- If a challenge offers several payment options, the agent forwards the whole challenge verbatim. Option selection belongs to Control (feature 002).

## Requirements *(mandatory)*

### Functional Requirements

**Paid-fetch orchestration (L1-1)**

- **FR-001**: The orchestrator MUST issue the initial request for the URL. On a network error it MUST return outcome `ERROR`. *(SPEC: L1-1.1)*
- **FR-002**: If the response status is not 402, the orchestrator MUST return `FREE` with the status and body. The body is parsed as JSON when possible, otherwise returned as text truncated to 2000 characters. *(SPEC: L1-1.2)*
- **FR-003**: On 402, the orchestrator MUST decode the `PAYMENT-REQUIRED` header with the x402 SDK decoder. If the header is absent, it MUST parse the body as JSON (v1 fallback). If both fail, it MUST return `ERROR`. *(SPEC: L1-1.3, §10)*
- **FR-004**: The orchestrator MUST build a payment intent with ID `int_<uuid>`, the session ID, the requested URL, the verbatim decoded challenge, the agent's purpose text and a creation timestamp. It then submits the intent to the Control layer's authorization port. *(SPEC: L1-1.4, §7)*
- **FR-005**: If the decision is DENIED or ESCALATE, the orchestrator MUST return `DENIED` or `ESCALATED` with the violations and authorization ID. It MUST NOT retry. *(SPEC: L1-1.5)*
- **FR-006**: If the decision is AUTHORIZED, the orchestrator MUST re-request the URL with the decision's payment headers, forwarded unchanged and treated as opaque. *(SPEC: L1-1.6, §10)*
- **FR-007**: The orchestrator MUST build a settlement claim from the decision (authorization ID, requirement, payer, validBefore), the HTTP status and the raw `PAYMENT-RESPONSE` header (or null). It then submits the claim to the Settlement layer's verification port. *(SPEC: L1-1.7, §7)*
- **FR-008**: The orchestrator MUST return `PAID` only when the paid response is 2xx and the settlement report is CONFIRMED or PENDING. Otherwise it MUST return `PAYMENT_FAILED`, including the body only for a 2xx response. *(SPEC: L1-1.8)*
- **FR-009**: Every paid-fetch result MUST have the shape `{outcome ∈ FREE|PAID|DENIED|ESCALATED|PAYMENT_FAILED|ERROR, url, httpStatus, body, payment?, violations?, authorizationId?, error?}`. *(SPEC: L1-1)*

**Port adapters (L1-2)**

- **FR-010**: The authorization adapter MUST call Control's authorize operation and budget-query operation. The verification adapter MUST call the Settlement layer's verify operation. Each uses its own bearer credential. *(SPEC: L1-2, INV-13)*
- **FR-011**: The adapters MUST raise an error on any non-2xx response. They MUST NOT interpret it as a decision. *(SPEC: L1-2)*

**LLM agent (L1-3)**

- **FR-012**: The LLM agent MUST use the configured model, defaulting to `claude-sonnet-5-5`. It uses a 2048-token output limit and runs at most 10 turns. *(SPEC: L1-3)*
- **FR-013**: The LLM agent MUST offer exactly two tools: `fetch_resource` (required `url` and `purpose` strings) and `check_budget` (no inputs). It MUST NOT be given any tool that signs, approves or edits policy. *(SPEC: L1-3, SEC-1, T-AGT-01)*
- **FR-014**: The `fetch_resource` tool result MUST be JSON `{outcome, httpStatus, body, payment:{authorizationId, amountUsd, settlement:{status, tx, finality}}, violations, authorizationId, error}`. *(SPEC: L1-3)*
- **FR-015**: The system prompt MUST instruct the agent to:
  - start at the seller catalog;
  - treat prices as atomic units;
  - buy only what the goal needs and prefer cheaper items;
  - never retry a DENIED payment, and explain the rule that blocked it;
  - report the authorization ID of any ESCALATED payment;
  - end with a receipt list (resource, USD, settlement status, tx).

  *(SPEC: L1-3)*
- **FR-016**: The model client MUST be replaceable, so that tests can use a deterministic fake model. *(SPEC: L1-3, T-AGT-01)*
- **FR-017**: The agent's purpose text MUST travel in the intent for audit only (see feature 002, INV-5). *(SPEC: L1-3, T-AGT-01)*

**Scripted agent (L1-4)**

- **FR-018**: A scripted, LLM-free agent MUST run the six-step plan in User Story 4. It MUST produce outcomes `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]` against the default mandate. *(SPEC: L1-4, T-E2E-01)*

**Composition root (L1-5)**

- **FR-019**: The agent entry point MUST exit with code 1 if the payer private key variable is present in its environment. *(SPEC: L1-5, INV-3)*
  *Extended by 011 (SPEC v1.5): a second L1 entry point, `src/hosted-main.ts` (L1-6), obeys the same rule. Both roots load their env file first and then refuse, so a key placed in the env file is refused too; the shared refusal text lives in `src/refusal.ts`.*
- **FR-020**: The session ID MUST be the configured `SESSION_ID`, or else a generated `sess_<8 hex>`. *(SPEC: L1-5)*
- **FR-021**: A `--scripted` switch MUST select the scripted agent. Otherwise the LLM agent runs, with the goal taken from the command arguments or a default goal. *(SPEC: L1-5)*
- **FR-022**: On completion, the entry point MUST print the session's final budget status. *(SPEC: L1-5)*

### Non-Functional Requirements

- **NFR-001 (Security, isolation)**: Layer 1 MUST hold no signing key. It MUST NOT reference the payer key, except to check for it and refuse. It MUST depend only on the shared contracts and its own code. *(SPEC: INV-1, INV-3, SEC-2)*
- **NFR-002 (Security, prompt injection)**: No model output can cause a payment except through a Control-layer AUTHORIZED decision. *(SPEC: SEC-1)*
- **NFR-003 (Protocol fidelity)**: x402 headers MUST be decoded and encoded only with the x402 SDK helpers, never with hand-written base64. *(SPEC: §10)*
- **NFR-004 (Least privilege)**: The agent holds only its Control credential and its Verifier credential (plus the LLM API key). It MUST NOT hold the settlement or operator credentials. *(SPEC: §3.3, INV-13)*
- **NFR-005 (Determinism)**: The scripted agent's outcome sequence MUST be identical on every run with the same mandate and seller catalog. *(SPEC: L1-4, §12)*
- **NFR-006 (Bounded cost)**: An LLM run MUST NOT exceed 10 model turns or 2048 output tokens per turn. *(SPEC: L1-3)*
- **NFR-007 (Money representation)**: Amounts are handled as atomic-unit decimal strings. USD figures shown to the model are derived for display only. *(SPEC: §7)*

### Key Entities

- **Payment Intent**: L1's request to pay one challenge. It holds the intent ID, session ID, resource URL, verbatim challenge, purpose (audit only) and creation time.
- **Paid Fetch Result**: The outcome of one fetch attempt. It holds the outcome, URL, status, body, optional payment receipt, violations, authorization ID and error.
- **Settlement Claim**: L1's request to L3 to verify a payment. It holds the authorization ID, requirement, payer, validBefore, HTTP status and raw payment-response header.
- **Agent Session**: A run identified by a session ID. Its budget is enforced by Control.
- **Agent Tools**: `fetch_resource` and `check_budget`. These are the only capabilities the model has.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The scripted plan produces exactly `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]` on 100% of runs.
- **SC-002**: The payer's on-chain balance decreases by exactly 6000 atomic units (0.006 USDC) per scripted run. The run records two CONFIRMED settlements.
- **SC-003**: The LLM agent is offered exactly 2 tools in 100% of model requests.
- **SC-004**: Starting the agent with the payer key in its environment exits with code 1 in 100% of attempts.
- **SC-005**: A DENIED or ESCALATED decision causes 0 follow-up paid requests to the seller.
- **SC-006**: Every LLM-agent intent records the model's purpose text (T-AGT-01).

## Assumptions

- Control (feature 002), Settlement verification (feature 005) and the seller (feature 006) are reachable and configured. The ledger and approvals are covered by features 003 and 004.
- The scripted plan's expected outcomes assume the default mandate (CFG-3) and the default catalog prices. Changing either requires updating SPEC.md L1-4 and T-E2E-01.
- The "budget rules" that accompany `hard_cap_exceeded` on step 5 are those the mandate triggers. They are not enumerated as a fixed set.
- Out of scope: an MCP front-end (EXT-5) and refund handling for paid-but-not-served (EXT-9).
- HOW (module layout and SDK entry points) is in SPEC.md §5, §6 and §8.1.
