# Contract: L2 operator API (SPEC L2-5 delta)

All routes bind to 127.0.0.1 only (`listenControl`). Each route's `requireRole("operator")` guard
runs **before** body parsing, so a wrong or missing token returns 401 `{ "error": "unauthorized" }`
and never appends an entry (INV-13, NFR-001). Every route runs `sweep(nowMs)` and then its own logic
inside the L2 serialized section.

## POST /v1/rejections/:authorizationId (new)

| | |
|---|---|
| Auth | `OPERATOR_TOKEN` |
| Body | `{ operator?: string = "operator", reason?: string }` (JSON; empty or absent body allowed) |

Responses, checked in this order:

| Status | When | Body |
|---|---|---|
| 401 | not the operator token | `{ "error": "unauthorized" }` |
| 400 | `operator` present and not a 1–64 character string, or `reason` present and not a string of at most 280 characters | `{ "error": "<field> ..." }` |
| 404 | no `ESCALATED` entry with that `authorizationId` | `{ "error": "not found" }` |
| 409 | the escalation is `approved` or `expired` | `{ "error": "escalation is approved", "state": "approved", "approvalId": "apr_…" }` or `{ "error": "escalation is expired", "state": "expired", "expiresAt": "<ISO>" }` |
| 200 | pending: appends one `HUMAN_REJECTION` | `{ "ok": true, "rejectionId": "rej_…", "rejectedAt": "<ISO>", "alreadyRejected": false }` |
| 200 | already denied: appends nothing | the first rejection's `{ ok, rejectionId, rejectedAt, "alreadyRejected": true }` |

## POST /v1/approvals/:authorizationId (amended)

The request is unchanged: `{ approver? = "operator", ttlSeconds? = 600 }`. Its 400, 404 and 401
behavior is unchanged.

| Status | When | Body |
|---|---|---|
| 200 | pending: appends one `HUMAN_APPROVAL`, as today | `{ "ok": true, "approvalId", "expiresAt" }`. `alreadyApproved` is omitted, so the existing shape is byte-for-byte the same. |
| 200 | already approved: appends nothing; the request's `ttlSeconds` and `approver` are ignored | `{ "ok": true, "approvalId", "expiresAt", "alreadyApproved": true }` (the first approval) |
| 409 | denied | `{ "error": "escalation is denied", "state": "denied", "rejectionId": "rej_…" }` |
| 409 | expired | `{ "error": "escalation is expired", "state": "expired", "expiresAt": "<ISO>" }` |

This replaces the v1.2 rule that "each call creates a new approval".

## GET /v1/escalations (new)

| | |
|---|---|
| Auth | `OPERATOR_TOKEN` |
| 200 | `{ "pending": EscalationView[], "cursor": <number> }` |

- `pending` is sorted by `createdAt` ascending. Each item is
  `{ authorizationId, sessionId, resourceKey, payTo, amount, createdAt, expiresAt }`.
- `cursor` is the `seq` of the last ledger entry, or `-1` when the ledger is empty. A watcher passes
  it as `after`.

## GET /v1/escalations/events?after=&lt;seq&gt; (new)

| | |
|---|---|
| Auth | `OPERATOR_TOKEN` |
| Query | `after`: an integer ≥ -1 (default -1); otherwise 400 `{ "error": "after must be an integer >= -1" }` |
| 200 | `{ "events": EscalationEvent[], "cursor": <number> }` |

- `events` holds the lifecycle events with `seq > after`, in `seq` order. The event shapes are in
  [data-model.md](../data-model.md#derived-operator-views-not-stored).
- `cursor` is the `seq` of the last ledger entry, so a watcher never re-reads entries it skipped,
  including entries that are not events.
- Responses never contain tokens, payment headers, signatures, `accepts` or `purpose` (NFR-007).

## POST /v1/authorize (behavior delta only; contract unchanged)

- R15 `human_rejected` may appear in `violations` of a `DENIED` decision.
- When the decision is `ESCALATE` and a pending escalation exists for the same purchase (session,
  resource key, payee, amount), `authorizationId` is that pending escalation's ID. The outcome entry
  is `ESCALATION_REPEATED`, not `ESCALATED`.

`AuthorizationDecision` in `src/shared/contracts.ts` is **not** changed.
