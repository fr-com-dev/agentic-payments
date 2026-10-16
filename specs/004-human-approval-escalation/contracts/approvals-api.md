# Contract: `POST /v1/approvals/:authorizationId` (L2, owned by 004)

The control service binds to `127.0.0.1:4020` (`CONTROL_PORT`). Other L2 endpoints are
specified elsewhere:
- `/v1/authorize` and `/v1/budget`: [002 contracts](../../002-spending-policy-authorization/contracts/)
- `/v1/reconcile` and `/v1/ledger/verify`: [003 contracts](../../003-audit-ledger-reconciliation/contracts/)

## Request

```http
POST /v1/approvals/{authorizationId}
Authorization: Bearer ${OPERATOR_TOKEN}
Content-Type: application/json

{ "approver": "alice", "ttlSeconds": 600 }
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `authorizationId` (path) | string | — | must identify an `ESCALATED` ledger entry |
| `approver` | string? | `"operator"` | recorded in the ledger |
| `ttlSeconds` | integer? | `600` | must be > 0 |

The body MUST NOT be able to change the payee, amount, resource or session. Those are copied
from the ESCALATED entry.

The route is mounted behind `requireRole("operator")` from `src/shared/auth.ts` (007), which
runs before body validation.

## Responses

| Status | When | Body |
|---|---|---|
| 200 | approval recorded (also on a repeat approval of the same escalation, which creates a new, independent approval) | `{ "ok": true, "approvalId": "apr_<uuid>", "expiresAt": "<ISO-8601>" }` |
| 400 | `ttlSeconds` present but not a positive integer | `{ "error": "..." }` |
| 401 | missing token, or any token other than `OPERATOR_TOKEN` (including `CONTROL_TOKEN`, `SETTLEMENT_TOKEN` and `VERIFIER_TOKEN`) | `{ "error": "unauthorized" }` |
| 404 | no `ESCALATED` entry for that ID (unknown, DENIED or AUTHORIZED) | `{ "error": "not found" }` |

Side effects:
- On 200, exactly one `HUMAN_APPROVAL` entry is appended, with the fields listed in
  [../data-model.md](../data-model.md).
- On any non-200, nothing is appended.

## Effect on `/v1/authorize` (behavior contributed by this feature)

| Step | Behavior |
|---|---|
| 2 | `findOpenApproval(sessionId, resourceKey(intent.resourceUrl), t)` |
| 3 | If an approval was found, set `ctx.humanApprovedFor = { payTo, amount, approvalId }` |
| 6 | If the decision is AUTHORIZED and R14 was lifted by that approval, the `AUTHORIZED` entry has `data.approvalRef = approvalId`. Otherwise it is `null`. |

All three steps run inside the serialized authorize section (INV-8). Steps 2–3 are wired by
002; step 6 by this feature. Each approval is consumed by exactly one AUTHORIZED entry.

The 400 rule, the `approver` default, `data.approvalId` and consumption by `approvalId` are
part of the SPEC.md v1.1 amendment (008 T000).
