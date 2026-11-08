# Contract: L2-5 delta (control API)

No route is added or removed (FR-010, T-API-01). Auth, the order of the guards (401 before 400) and
the loopback bind are unchanged. `docs/l2-control.openapi.yaml` is updated with every change below,
and T-API-01..03 check it. When backchannel approval is off, every route behaves exactly as in v1.7,
apart from the additive fields marked †.

## `POST /v1/authorize` (`CONTROL_TOKEN`)

**Request**: `PaymentIntent` gains one optional field.

| Field | Type | Rule |
|---|---|---|
| `operatorApprovalOnly` | boolean, optional | Absent or `false`: no effect. `true`: an escalation this intent creates sends no approval request and returns at once (FR-007). Any non-boolean value is **400** `malformed PaymentIntent`. |

**Response**: `AuthorizationDecision`, unchanged in shape. What changes is when it returns, and
what it can return.

| Case | Returns | Timing |
|---|---|---|
| No escalation, or the feature is off | as today | as today |
| `ESCALATION_REPEATED`, `operator_only`, `capped`, or `reevaluation` | `ESCALATE` with the escalation ID | at once (FR-018) |
| `requested`, and the start fails | `ESCALATE` with the escalation ID | as soon as the failure is recorded: within 6 s (3 attempts with 1.5 s timeouts) |
| `requested`, and the request lapses or fails verification | `ESCALATE` with the escalation ID | as soon as that is recorded |
| `requested`, and the escalation is approved within the wait (by either path) | the re-evaluated decision: `AUTHORIZED` with a **new** `authorizationId`, `paymentHeaders` and `approvalRef` consumed; or `DENIED` if a DENY rule now applies | when the approval is recorded, plus the second serialized section |
| `requested`, and the escalation is denied within the wait (by either path) | `DENIED` with `human_rejected` (detail `rejected by the operator (<rejectionId>)`, unchanged) | when the rejection is recorded |
| `requested`, and no final state within 120 s | `ESCALATE` with the escalation ID | at 120 s |
| The caller disconnects during the wait | nothing is sent and nothing is signed for this call | at once (FR-019) |

Ledger, per authorize call:
- **No re-evaluation**: `INTENT` → one outcome entry (unchanged).
- **With a re-evaluation**: `INTENT` → `ESCALATED` → … (request entries and the final state,
  interleaved with other calls) → `INTENT { reevaluationOf }` → one outcome entry. Both `INTENT`
  entries have the same `intentId`.

L1 needs no change to receive this. `HttpAuthorizationGate` has no client timeout, and undici's
300 s header timeout, the nginx sidecar's 230 s and the ingress's 240 s all exceed 120 s.

## `GET /v1/escalations` (`OPERATOR_TOKEN`)

Each `pending[]` item gains:

| Field | When | Value |
|---|---|---|
| `referenceCode` † | always | 8 hex characters (payment-details) |
| `approvalRequest` | only when the `ESCALATED` entry has the field | `requested` \| `capped` \| `operator_only` \| `reevaluation` \| `failed` \| `verification_failed` \| `lapsed` |

## `GET /v1/escalations/events?after=<seq>` (`OPERATOR_TOKEN`)

The fields and kinds are listed in [data-model](../data-model.md#operator-views-whitelist-projections).
In summary:
- `escalated` gains `referenceCode` † and `approvalRequest?`.
- `approved` and `denied` gain `channel` † and `decidedBy` †. `denied` carries `operator` (and
  `reason?`) only on the operator channel.
- New kinds: `approval_requested`, `approval_request_failed`, `approval_request_lapsed` and
  `approval_verification_failed`. They appear only when the feature is on.
- The whitelist rule is unchanged. No event carries a token, a handle (sealed or not), `details`,
  `bindingMessage`, `evidence`, `issuer`, `accepts`, `purpose` or Auth0 text.

## `POST /v1/approvals/:id` and `POST /v1/rejections/:id` (`OPERATOR_TOKEN`)

Requests, responses and status codes are unchanged. The entries they append now carry
`channel: "operator"` †.

The first final state wins, from either path (FR-027):
- **Approve on an escalation the approver refused**: 409 `{ state: "denied", rejectionId }`.
- **Reject on an escalation the approver approved**: 409 `{ state: "approved", approvalId }`
  (010 FR-003).
- **Repeating an approval**: returns the existing approval, whichever channel created it.

## What the agent never gets (FR-031)

There is no route, field or tool for reading or deciding approval requests. `PaidFetchResult` and
the agent's tool results are unchanged. An ESCALATED result still carries only the escalation's
`authorizationId`, whose first 8 hex characters are the reference code.
