# Contract: Roles, tokens and the bearer guard (INV-13)

## Role → token → endpoints

| Role | Holder → Verifier | Token var (dev default) | Endpoints (owner feature) |
|---|---|---|---|
| `agent-control` | L1 → L2 | `CONTROL_TOKEN` (`dev-control-token`) | `POST /v1/authorize`, `GET /v1/budget/:sessionId` ([002](../../002-spending-policy-authorization/contracts/)) |
| `agent-verifier` | L1 → L3 | `VERIFIER_TOKEN` (`dev-verifier-token`) | `POST /v1/settlements` ([005](../../005-settlement-verification/contracts/)) |
| `verifier-control` | L3 → L2 | `SETTLEMENT_TOKEN` (`dev-settlement-token`) | `POST /v1/reconcile` ([003](../../003-audit-ledger-reconciliation/contracts/)) |
| `operator` | human → L2 | `OPERATOR_TOKEN` (`dev-operator-token`) | `POST /v1/approvals/:authorizationId` ([004](../../004-human-approval-escalation/contracts/)), `GET /v1/ledger/verify` ([003](../../003-audit-ledger-reconciliation/contracts/)) |

Each endpoint accepts exactly one role. The endpoint sets do not overlap.

## Guard: `requireRole(role)` (`src/shared/auth.ts`)

007 defines the guard. Each endpoint's owning feature mounts it on its own route: 002 (`/v1/authorize`, `/v1/budget`), 003 (`/v1/reconcile`, `/v1/ledger/verify`), 004 (`/v1/approvals/:authorizationId`), 005 (`/v1/settlements`). The constant-time comparison is hardening beyond SPEC, recorded in 008 T000.

| Input | Result |
|---|---|
| No `Authorization` header, or no `Bearer ` prefix | `401 {"error":"unauthorized"}` |
| Bearer token that is not equal (constant time, compared via SHA-256) to the role's token | `401 {"error":"unauthorized"}` |
| Bearer token equal to the role's token | calls `next()` |

Guarantees:
- The guard runs before body validation and the handler. A 401 never appends a ledger
  entry, triggers a reconcile or consumes an approval.
- The 401 body never says which role was expected.

## Startup configuration

| `NETWORK` | Token var unset | Token var empty string |
|---|---|---|
| `local` | use the dev default | exit 1 |
| any other | exit 1 (`missing <VAR>`) | exit 1 |

## Required negative tests

| Test | Call | Expected |
|---|---|---|
| T-E2E-05 (owner 003, T032) | `POST /v1/reconcile` with `CONTROL_TOKEN` | 401, ledger length unchanged |
| T-E2E-02 (owner 004) | `POST /v1/approvals/:id` with `CONTROL_TOKEN` | 401 |
| T-AUTH-01 (new, this feature) | `POST /v1/authorize` with `SETTLEMENT_TOKEN` | 401 |
| T-AUTH-02 (new; implemented in 005 T031) | `POST /v1/settlements` with `CONTROL_TOKEN` | 401 |
