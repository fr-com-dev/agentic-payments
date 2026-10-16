# Data Model: Spending Policy & Authorization (L2)

Cross-layer types (`PaymentIntent`, `AuthorizationDecision`, `PolicyViolation`,
`BudgetStatus`) live in `src/shared/contracts.ts` (SPEC.md §7). The types below are internal
to L2. Ledger entry shapes are owned by
[feature 003](../003-audit-ledger-reconciliation/data-model.md).

## SpendingMandate (L2-1, CFG-3)

| Field | Type | Default | Validation / used by |
|---|---|---|---|
| mandateId | string | `mandate-poc-001` | logged on AUTHORIZED |
| expiresAt | ISO string | `2027-12-31T23:59:59Z` | R1 |
| allowedSchemes | string[] | `["exact"]` | R2 |
| allowedNetworks | string[] | from the network profile (CAIP-2) | R3; never read from JSON |
| allowedAssets | `Record<network, string[]>` (lower-cased) | from the network profile | R4; never read from JSON |
| allowedPayees | string[] (lower-cased) | `[]` (empty means any) | R5; `ALLOWED_PAYEES` overrides |
| allowedHosts | string[] (`host:port`) | `["127.0.0.1:4021"]` | R6; `ALLOWED_HOSTS` overrides |
| autoApproveMaxAtomic | atomic string | `20000` | R14 |
| hardCapPerPaymentAtomic | atomic string | `100000` | R10 and the signer SDK cap |
| sessionBudgetAtomic | atomic string | `100000` | R11 |
| dailyBudgetAtomic | atomic string | `500000` | R12 |
| maxAuthorizationsPerMinute | integer | `10` | R13 |
| maxTimeoutSeconds | integer | `300` | R8 |

Invariant at load time: `autoApproveMax < hardCap ≤ sessionBudget`. Loading fails otherwise
(see research R7).

## PaymentRequirements (input, from the x402 SDK)

Fields used: `scheme`, `network`, `asset`, `amount` (atomic string), `payTo`,
`maxTimeoutSeconds` and `extra`.

## PolicyContext

| Field | Type | Computed by `service.ts` from |
|---|---|---|
| nowMs | number | one `Date.now()` per authorize call (step 1) |
| requestedUrl | string | `intent.resourceUrl` |
| challengeResourceUrl | string | `intent.paymentRequired.resource.url` |
| sessionCommittedAtomic | bigint | ledger `committedAtomic({sessionId}, nowMs)` (003) |
| dailyCommittedAtomic | bigint | ledger `committedAtomic({sinceMs: nowMs − 24h}, nowMs)` (003) |
| authorizationsLastMinute | number | `ledger.authorizedSince(nowMs − 60_000)` (003) |
| humanApprovedFor? | `{ payTo, amount, approvalId }` | `ledger.findOpenApproval(sessionId, resourceKey, nowMs)` (003 impl, 004 semantics: most recent open approval) |

There is deliberately **no** `purpose` field (INV-5).

## RequirementEvaluation (output of `evaluateRequirement`)

`{ requirement, status: "AUTHORIZED" | "DENIED" | "ESCALATE", violations: PolicyViolation[] }`

## Decision (output of `decide`)

`{ status, chosen?: PaymentRequirements, violations: PolicyViolation[] }`. The service maps
this to an `AuthorizationDecision`, adding `authorizationId` and `intentId`. For AUTHORIZED,
it also adds the signer output and `remainingSessionBudgetAtomic`.

## SignedAuthorization (signer output)

`{ headers: Record<string,string>, payer: string, validBefore: number /* seconds */ }`

## Authorize lifecycle (one request, inside the mutex)

```text
validate body ──bad─► 400 (no ledger write)
   ▼
t = now; append INTENT
   ▼
approval lookup → ctx (ledger-derived) → decide
   ├─ DENIED   ─────────────────────────────► append DENIED    → 200 {DENIED}
   ├─ ESCALATE ─────────────────────────────► append ESCALATED → 200 {ESCALATE}
   └─ AUTHORIZED ─► [signerLatencyMs] ─► sign
                       ├─ throws ─► DENIED signer_rejected ─► append DENIED → 200 {DENIED}
                       └─ ok ─────► append AUTHORIZED (approvalRef = approvalId | null) → 200 {AUTHORIZED}
```

Every request that passes validation produces exactly one INTENT entry and one outcome entry
(NFR-009).
