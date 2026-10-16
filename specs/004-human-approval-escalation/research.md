# Research: Human-in-the-Loop Approval (004)

Technical Context had no `NEEDS CLARIFICATION` items. SPEC.md §8.2 and §13 are normative.
This file records the design decisions and why they were made.

## R1. Approval state is derived from the ledger

- **Decision**: Approval state is computed, never stored:
  - An approval is a `HUMAN_APPROVAL` entry.
  - It is **expired** when `nowMs > expiresAtMs`.
  - It is **consumed** when any `AUTHORIZED` entry has `approvalRef === approvalId`.
- **Rationale**: This follows INV-7 and Principle III. Because the ledger is append-only and
  hash-chained, state can't drift and every transition is auditable (NFR-006).
- **Alternatives considered**: An in-memory approvals map was rejected: it is lost on restart
  and duplicates state. A `CONSUMED` entry type was rejected as redundant, because
  `approvalRef` on `AUTHORIZED` already proves consumption atomically.

## R2. Lookup inside the serialized authorize section

- **Decision**: Authorize step 2 (`findOpenApproval`) and step 6 (append `AUTHORIZED` with
  `approvalRef`) both run inside the authorize mutex.
- **Rationale**: This follows INV-8 and NFR-005. Two concurrent identical requests can't both
  see the approval as open. The second one sees the first one's `AUTHORIZED.approvalRef` and
  escalates.
- **Alternatives considered**: Optimistic lookup outside the lock was rejected because it
  allows double consumption.

## R3. Split between lookup and match

- **Decision**: The service looks up by (session, resourceKey) and passes
  `ctx.humanApprovedFor = { payTo, amount, approvalId }` to the pure policy. R14 is lifted
  only if `lower(payTo)` matches and the `amount` string is identical.
- **Rationale**: The policy stays pure (INV-5): no ledger access, and time is an input.
  Payee and amount matching is a policy decision, so it is unit-tested in T-POL-13.
- **Alternatives considered**: Matching all four fields in the ledger query was rejected
  because it hides the exact-match rule from the policy tests.

## R4. Approvals never override DENY

- **Decision**: `humanApprovedFor` is consulted **only** in the R14 branch, which runs only
  when no DENY violation exists. With a DENY, the decision is DENIED, no `AUTHORIZED` entry is
  written, and the approval stays unconsumed.
- **Rationale**: This follows INV-12 and SC-004.

## R5. Resource key excludes the query string

- **Decision**: `resourceKey = origin + pathname` (owned by feature 003).
- **Rationale**: This follows SPEC L2-4. The trade-off is that an approval for
  `/api/x?a=1` matches `/api/x?a=2` when the payee and amount match. The exact payee and amount
  match, single use and TTL bound the risk.

## R6. Approval endpoint validation

- **Decision**: `POST /v1/approvals/:authorizationId` works as follows:
  1. Find the `ESCALATED` entry with that `authorizationId`, or return 404.
  2. Copy `resourceKey`, `payTo` and `amount` from that entry, never from the request body.
  3. Set `ttlSeconds` (default 600) and `approver` (default `"operator"`).
  4. Append `HUMAN_APPROVAL`.
- **Rationale**: The operator approves *what was escalated*, not an arbitrary tuple, so a
  forged body can't widen the approval.
- **Alternatives considered**: Letting the body specify the amount or payee was rejected
  (SEC-8).

## R7. Approval identifiers and single use

- **Decision**: Each approval has its own ID, `apr_<uuid>`, stored as `data.approvalId` and
  returned by the endpoint. Consumption is keyed on that ID: `AUTHORIZED.data.approvalRef =
  approvalId`. Re-approving an escalation returns 200 and appends a new, independent
  approval. There is no 409.
- **Rationale**: This makes "each approval is single-use" literally true and auditable.
  N operator approvals authorize at most N payments, each tied to the approval that allowed it.
- **SPEC impact**: SPEC.md L2-4.2 originally keyed consumption on `escalationId`. The change
  to `approvalId`, and `HUMAN_APPROVAL.data.approvalId`, are part of the SPEC.md v1.1
  amendment (008 T000).
- **Alternatives considered**: Consumption per escalation (SPEC v1.0) was rejected because one
  payment silently consumed every approval of that escalation. Rejecting a re-approval with 409
  was rejected because each approval is an explicit, separate operator decision.

## R8. Operator CLI

- **Decision**: `scripts/approve.ts <authorizationId> [approver]` loads
  `ENV_FILE=env/operator.env` (`CONTROL_URL`, `OPERATOR_TOKEN`) and POSTs to the approvals
  endpoint. It prints the JSON result. It exits 0 on 200 and non-zero otherwise.
- **Rationale**: This follows §13 and FR-013. The CLI reads only the operator's own env file,
  so it never loads the agent or payer secrets (INV-13). Exit codes 0/1/2 are part of the
  SPEC.md v1.1 amendment (008 T000).
