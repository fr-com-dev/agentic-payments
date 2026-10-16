# Contract: Policy rules R1–R14 (normative)

Rule IDs are a stable public contract. L1, the auditor and the tests match on them. A new
rule needs a new snake_case ID, a row here, a row in SPEC §8.2 and a test.

Rules run in this order. All DENY violations are collected, except where R9 says to return
immediately.

| # | Rule ID | Violation when | Effect | Test |
|---|---|---|---|---|
| R1 | `mandate_expired` | `nowMs > Date.parse(expiresAt)` | DENY | T-POL-14 |
| R2 | `scheme_not_allowed` | `req.scheme ∉ allowedSchemes` | DENY | T-POL-03..10 |
| R3 | `network_not_allowed` | `req.network ∉ allowedNetworks` | DENY | T-POL-03..10 |
| R4 | `asset_not_allowed` | `lower(req.asset) ∉ allowedAssets[req.network]` | DENY | T-POL-03..10 |
| R5 | `payee_not_allowed` | `allowedPayees.length > 0` and `lower(payTo) ∉ allowedPayees` | DENY | T-POL-03..10 |
| R6 | `host_not_allowed` | `host(requestedUrl)` unparsable, or not in `allowedHosts` (host includes the port) | DENY | T-POL-11 |
| R7 | `resource_binding_mismatch` | `host(challengeResourceUrl) ≠ host(requestedUrl)` | DENY | T-POL-11 |
| R8 | `timeout_out_of_range` | not `0 < maxTimeoutSeconds ≤ mandate.maxTimeoutSeconds` | DENY | T-POL-03..10 |
| R9 | `amount_invalid` | `amount` fails `^\d+$`, or `BigInt(amount) ≤ 0` | DENY, **return immediately** | T-POL-03..10 |
| R10 | `hard_cap_exceeded` | `amount > hardCapPerPaymentAtomic` | DENY | T-POL-03..10 |
| R11 | `session_budget_exceeded` | `sessionCommitted + amount > sessionBudgetAtomic` | DENY | T-POL-12 |
| R12 | `daily_budget_exceeded` | `dailyCommitted + amount > dailyBudgetAtomic` | DENY | T-POL-12 |
| R13 | `velocity_limit` | `authorizationsLastMinute ≥ maxAuthorizationsPerMinute` | DENY | T-POL-14, T-E2E-04 |
| R14 | `human_approval_required` | no DENY so far, `amount > autoApproveMaxAtomic`, and no `humanApprovedFor` with the same `lower(payTo)` and exactly the same `amount` string | ESCALATE | T-POL-13 |
| — | (none) | otherwise | AUTHORIZED | T-POL-01 |

Rules applied outside `evaluateRequirement`:

| Rule ID | Raised by | When |
|---|---|---|
| `no_payment_options` | `decide` | `accepts` is empty (T-POL-14) |
| `signer_rejected` | the service's authorize step | the signer throws. Detail ≤ 300 characters |

## `decide(accepts, mandate, ctx)`

1. Evaluate every option.
2. If any option is AUTHORIZED, return the one with the smallest amount (the first offered on
   a tie) → AUTHORIZED.
3. Else, if any option is ESCALATE, return ESCALATE with that option's violations.
4. Else, return DENIED with every option's violations flattened, or `no_payment_options` if
   there were no options.

Budget boundary: `committed + amount == budget` passes. `+1` atomic is denied (T-POL-12).
