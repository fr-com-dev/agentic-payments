# Data Model: Human-in-the-Loop Approval (004)

Ledger entry framing (`seq`, `ts`, `type`, `prevHash`, `hash`) and the `resourceKey` rule
are owned by [003](../003-audit-ledger-reconciliation/data-model.md). This feature uses the
three entry types below.

## Escalation (`ESCALATED` entry)

| Field | Value |
|---|---|
| type | `ESCALATED` |
| sessionId, intentId, authorizationId | from the authorize call. `authorizationId` is the **escalation ID** |
| data.violations | includes `{ rule: "human_approval_required", ... }` |
| data.resourceKey | `origin + pathname` of the resource URL |
| data.payTo | payee of the escalated requirement |
| data.amount | atomic decimal string |

## Human Approval (`HUMAN_APPROVAL` entry)

| Field | Value / rule |
|---|---|
| type | `HUMAN_APPROVAL` |
| sessionId | copied from the ESCALATED entry |
| data.approvalId | `apr_<uuid>` (research R7) |
| data.escalationId | the ESCALATED entry's `authorizationId` |
| data.resourceKey, data.payTo, data.amount | **copied from the ESCALATED entry**, never from the request |
| data.approver | request `approver`, or `"operator"` |
| data.expiresAtMs | `now + ttlSeconds × 1000`, with `ttlSeconds` defaulting to 600 |

## Approval reference (`AUTHORIZED` entry, approval fields)

| Field | Value |
|---|---|
| data.approvalRef | the `approvalId` of the approval consumed, or `null` (always present) |

## Policy context input

`ctx.humanApprovedFor?: { payTo: string; amount: string; approvalId: string }`

This is filled by the service from `findOpenApproval`. R14 is lifted iff
`lower(req.payTo) === lower(payTo)` **and** `req.amount === amount`, and there is no DENY
violation.

## Lifecycle (derived, never stored)

```text
             authorize: no DENY, amount > autoApproveMax, no match
  (none) ─────────────────────────────────────────────────────────► ESCALATED
                                                                        │ POST /v1/approvals/:id
                                                                        │ (OPERATOR_TOKEN)
                                                                        ▼
                         nowMs > expiresAtMs                     APPROVED (open)
      EXPIRED ◄────────────────────────────────────────────────────────┤
   (next request                                                        │ authorize: same session + resourceKey,
    escalates again)                                                    │ payTo (ci) + exact amount, no DENY
                                                                        ▼
                                                                    CONSUMED
                                                   (AUTHORIZED.approvalRef = approvalId;
                                                    next identical request uses another open
                                                    approval, or escalates again if none)
```

If the request matches but a DENY rule is present, the decision is DENIED and the approval
stays **open** (INV-12).

Each `HUMAN_APPROVAL` has its own lifecycle. Approving the same escalation again (200)
creates a new, independent approval; N approvals of one escalation allow at most N payments.

## `findOpenApproval(sessionId, resourceKey, nowMs)`

1. Scan `HUMAN_APPROVAL` entries with matching `sessionId` and `data.resourceKey`.
2. Drop those where `nowMs > data.expiresAtMs`.
3. Drop those whose `approvalId` appears as `approvalRef` on any `AUTHORIZED` entry.
4. Return the **most recent** remaining entry, or `undefined`.

"Most recent wins": an older open approval is not considered while a newer one is open,
even if the newer one does not match the request's payee or amount. All approvals of one
escalation share its payee and amount, so this only matters across different escalations of
the same resource key. Implemented on `AuditLedger` by 003; semantics and tests owned here.

## Validation rules

| Rule | Source |
|---|---|
| Only an `ESCALATED` authorization ID can be approved; anything else returns 404 | L2-5, FR-008 |
| `ttlSeconds`, if given, must be a positive integer; otherwise 400 | research R6 |
| Approval matches one session, one resourceKey, payee (case-insensitive) and the exact amount string | INV-12, FR-002 |
| At most one AUTHORIZED per `approvalId` | FR-010, NFR-003 |
| `approvalRef` is always written on AUTHORIZED: an `approvalId` or `null` | 003 schema, 002 T014 |
