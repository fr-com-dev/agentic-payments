# Data Model: Escalation Lifecycle

All state is derived from the hash-chained ledger (INV-7, INV-9). This feature adds four entry
types and a state machine derived from the entries. It writes no other store, and the
cross-layer `AuthorizationDecision` contract is unchanged.

## Constants

| Name | Value | Where | Notes |
|---|---|---|---|
| `ESCALATION_TTL_MS` | 300 000 | `src/layer2-control/escalations.ts` | Fixed and not configurable (clarification Q3). |
| `REASON_MAX` | 280 | same | Characters; longer is 400. |
| `OPERATOR_LABEL_MAX` | 64 | same | Characters; must be non-empty when present. |
| `SWEEP_INTERVAL_MS` | 1 000 | `service.ts` `main()` only | Unreferenced timer; tests call `sweep()` directly. |
| `WATCH_POLL_MS` | 1 000 | `scripts/escalations.ts` | Meets the 5 s notification requirement. |
| `DEFAULT_APPROVAL_TTL_SECONDS` | 600 | existing, unchanged | |

## Ledger entries

Envelope unchanged: `{ seq, ts, type, sessionId?, intentId?, authorizationId?, data, prevHash, hash }`.
Every amount is a decimal string, every time is an integer number of ms or an ISO string, and
optional fields are omitted rather than written as `null`.

### Existing, unchanged in shape

| Type | `authorizationId` | Lifecycle role |
|---|---|---|
| `INTENT` | — | Every authorize call. It is followed by exactly one outcome entry, which is now possibly `ESCALATION_REPEATED`. |
| `ESCALATED` | the new escalation's ID | **Creates** an escalation. `createdMs = Date.parse(ts)`, `expiresAtMs = createdMs + ESCALATION_TTL_MS`. |
| `HUMAN_APPROVAL` | the escalation's ID | **Final state: approved.** Now written at most once per escalation. |
| `AUTHORIZED` | new ID | `approvalRef` consumes the approval, unchanged. |
| `DENIED` | new ID | It may now list `human_rejected`. |

### New

| Type | Written by | `sessionId` | `authorizationId` | `data` fields |
|---|---|---|---|---|
| `HUMAN_REJECTION` | `POST /v1/rejections/:id` on a pending escalation | the escalation's | the escalation's ID | `rejectionId` (`rej_<uuid>`), `escalationId`, `resourceKey`, `payTo`, `amount`, `operator`, `reason?` |
| `ESCALATION_EXPIRED` | `sweep(nowMs)` once `nowMs ≥ expiresAtMs` with no decision | the escalation's | the escalation's ID | `escalationId`, `resourceKey`, `payTo`, `amount`, `expiresAtMs` |
| `APPROVAL_LAPSED` | `sweep(nowMs)` once `nowMs > approval.expiresAtMs` with the approval not consumed | the approval's | the escalation's ID | `approvalId`, `escalationId`, `resourceKey`, `payTo`, `amount`, `expiresAtMs` |
| `ESCALATION_REPEATED` | authorize, when ESCALATE matches a pending escalation for the same purchase | the request's | the pending escalation's ID | `escalationId`, `resourceKey`, `payTo`, `amount`, `violations` (also `intentId` on the envelope) |

Validation rules:
- `resourceKey`, `payTo` and `amount` in `HUMAN_REJECTION`, `ESCALATION_EXPIRED` and
  `APPROVAL_LAPSED` are **copied from the escalation entry**, never taken from a request (FR-007).
- `operator` must be 1–`OPERATOR_LABEL_MAX` characters (default `"operator"`). `reason`, when
  present, must be a string of at most `REASON_MAX` characters. Both are stored verbatim as data
  and are never a decision input (NFR-006).
- At most one final-state entry exists per escalation: `HUMAN_APPROVAL`, `HUMAN_REJECTION` or
  `ESCALATION_EXPIRED`. At most one `APPROVAL_LAPSED` exists per approval. The serialized,
  synchronous check-then-append guarantees both (research R9).

## Escalation state machine

```text
             ESCALATED (createdMs)
                    │
                 pending ──── repeat request for the same purchase ──▶ ESCALATION_REPEATED (state unchanged)
     ┌──────────────┼───────────────────────────┐
HUMAN_APPROVAL   HUMAN_REJECTION        nowMs ≥ createdMs + 300 s
     │              │                            │ (sweep → ESCALATION_EXPIRED)
     ▼              ▼                            ▼
  approved       denied                       expired
     │
     ├─ AUTHORIZED.approvalRef = approvalId  → approval consumed (one payment)
     └─ nowMs > approval.expiresAtMs, unused → sweep → APPROVAL_LAPSED (state stays approved)
```

`escalationState(entries, escalationId, nowMs)` returns one of these:

| Result | Condition (evaluated in this order) |
|---|---|
| `not_found` | no `ESCALATED` with that `authorizationId` |
| `approved` | a `HUMAN_APPROVAL` with `escalationId` exists (the first one is the decision) |
| `denied` | a `HUMAN_REJECTION` with `escalationId` exists |
| `expired` | an `ESCALATION_EXPIRED` exists, **or** `nowMs ≥ expiresAtMs` |
| `pending` | otherwise |

A final state is never left (FR-002). Operator actions on each state:

| State | approve | reject |
|---|---|---|
| pending | append `HUMAN_APPROVAL` → approved | append `HUMAN_REJECTION` → denied |
| approved | 200, existing approval, `alreadyApproved: true` | 409 `state: "approved"` |
| denied | 409 `state: "denied"` | 200, existing rejection, `alreadyRejected: true` |
| expired | 409 `state: "expired"` | 409 `state: "expired"` |
| not_found | 404 | 404 |

## Derived lookups used by authorize

| Function | Returns | Used for |
|---|---|---|
| `findRejection(entries, sessionId, resourceKey)` | the most recent `HUMAN_REJECTION` for that session and resource key, else undefined | `PolicyContext.humanRejected = { rejectionId }` → R15 |
| `findPendingEscalation(entries, sessionId, resourceKey, payTo, amount, nowMs)` | the `ESCALATED` entry whose state is `pending` for that exact purchase (payee lower-cased, amount string exact), else undefined | de-duplication (FR-005) |
| `findOpenApproval(...)` | unchanged (L2-4.2) | R14 lift |

## Policy context delta

```ts
interface PolicyContext {
  // ...existing fields...
  humanRejected?: { rejectionId: string }; // NEW: present ⇔ a HUMAN_REJECTION exists for (session, resourceKey)
}
```

R15 `human_rejected` is a DENY rule, collected with R1–R13: `ctx.humanRejected` present gives the
detail `rejected by the operator (<rejectionId>)`. See
[contracts/policy-r15.md](contracts/policy-r15.md).

## Derived operator views (not stored)

**EscalationView**, one per pending escalation in `GET /v1/escalations`:
`{ authorizationId, sessionId, resourceKey, payTo, amount, createdAt, expiresAt }`.

**EscalationEvent**, one per lifecycle entry in `GET /v1/escalations/events`:

| `kind` | From entry | Extra fields |
|---|---|---|
| `escalated` | `ESCALATED` | `expiresAt` |
| `approved` | `HUMAN_APPROVAL` | `approvalId`, `approver`, `approvalExpiresAt` |
| `denied` | `HUMAN_REJECTION` | `rejectionId`, `operator`, `reason?` |
| `expired` | `ESCALATION_EXPIRED` | `expiresAt` |
| `approval_lapsed` | `APPROVAL_LAPSED` | `approvalId` |

Common fields: `seq`, `at` (the entry's `ts`), `kind`, `authorizationId`, `sessionId`,
`resourceKey`, `payTo`, `amount`. An event never carries a token, payment header, signature,
`accepts` or `purpose`. `ESCALATION_REPEATED` produces no event.

## Relationships

```text
INTENT 1──1 (AUTHORIZED | DENIED | ESCALATED | ESCALATION_REPEATED)
ESCALATED 1──0..1 final state (HUMAN_APPROVAL | HUMAN_REJECTION | ESCALATION_EXPIRED)
ESCALATED 1──0..n ESCALATION_REPEATED (only while pending)
HUMAN_APPROVAL 1──0..1 AUTHORIZED (via approvalRef) ; 1──0..1 APPROVAL_LAPSED
HUMAN_REJECTION (session, resourceKey) ──▶ every later DENIED with human_rejected for that pair
```
