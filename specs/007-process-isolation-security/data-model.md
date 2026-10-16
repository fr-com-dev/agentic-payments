# Data Model: Process Isolation & Security Model

This feature models configuration and governance, not runtime payment data.

## Process

| Process | Role | Port (default / override) | Bind | Env file | Secrets held |
|---|---|---|---|---|---|
| Agent (L1) | client | none | n/a | `env/l1-agent.env` | `ANTHROPIC_API_KEY`, `CONTROL_TOKEN`, `VERIFIER_TOKEN` |
| Control (L2) | service | 4020 / `CONTROL_PORT` | 127.0.0.1 (fixed) | `env/l2-control.env` | `PAYER_PRIVATE_KEY`; verifies `CONTROL_TOKEN`, `SETTLEMENT_TOKEN`, `OPERATOR_TOKEN` |
| Verifier (L3) | service | 4023 / `SETTLEMENT_PORT` | 127.0.0.1 (fixed) | `env/l3-verifier.env` | `SETTLEMENT_TOKEN`; verifies `VERIFIER_TOKEN` |
| Seller | counterparty | 4021 / `SELLER_PORT` | 0.0.0.0 | `env/seller.env` | none |
| Facilitator | counterparty (local only) | 4022 / `FACILITATOR_PORT` | local | `env/facilitator.env` | `FACILITATOR_PRIVATE_KEY` |
| Chain | dev infra (local only) | 8545 | local | none | none |
| Operator CLI | human tool | none | n/a | `env/operator.env` | `OPERATOR_TOKEN` |

## Credential

| Field | Rule |
|---|---|
| name | one of the 7 secrets above |
| holderRole | exactly one role |
| verifierRole | exactly one role, or none for keys |
| devDefault | `dev-<role>-token`, bearer tokens only, allowed only when `NETWORK=local` |

Invariant: a bearer token's `(holderRole, verifierRole)` pair is unique. No token appears
in two rows of [contracts/auth-roles.md](contracts/auth-roles.md).

## Role

`agent-control`, `agent-verifier`, `verifier-control` and `operator`. Each role maps to a
fixed set of endpoints. The sets are disjoint.

## ArchViolation (architecture test output)

| Field | Type |
|---|---|
| rule | `A1`..`A7` |
| file | repository-relative path |
| line | number |
| detail | offending specifier or identifier |

`checkFile(path, source)` returns `ArchViolation[]` and is pure. The test fails if any file
in scope returns a non-empty list.

## Invariant, Threat and ResidualRisk

- **Invariant**: `{id: INV-n, statement, enforcement: test ID | manual}`.
- **Threat**: `{id: SEC-n, threat, controls[], ownerFeature, tests[]}`. See
  [contracts/threat-matrix.md](contracts/threat-matrix.md).
- **ResidualRisk**: `{risk, acceptedFor: "v1", retiredBy: EXT-n | none}`.

## Request authentication state

```text
request ──no/malformed Authorization──► 401 (no handler, no ledger write)
        ──token ≠ route role's token──► 401 (no handler, no ledger write)
        ──token = route role's token──► handler (owned by 002/003/004/005)
```
