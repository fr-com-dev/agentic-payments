# Contract: SPEC L2-4, L2-4.2 and the new L2-4.3 (proposed text)

## L2-4 table: rows to add

| Type | Written when | `data` fields |
|---|---|---|
| `HUMAN_REJECTION` | operator rejects a pending escalation | `rejectionId` (`rej_<uuid>`), `escalationId, resourceKey, payTo, amount, operator, reason?` |
| `ESCALATION_EXPIRED` | sweep: an escalation was still pending at `expiresAtMs` | `escalationId, resourceKey, payTo, amount, expiresAtMs` |
| `APPROVAL_LAPSED` | sweep: an approval passed `expiresAtMs` without being consumed | `approvalId, escalationId, resourceKey, payTo, amount, expiresAtMs` |
| `ESCALATION_REPEATED` | authorize: ESCALATE for a purchase that already has a pending escalation | `escalationId, resourceKey, payTo, amount, violations` |

Amended row: `INTENT` is still "every authorize call, before deciding". Its single outcome entry is
now one of `AUTHORIZED`, `DENIED`, `ESCALATED` or `ESCALATION_REPEATED`.

## L2-4.2: sentence to replace

The old sentence: "If one escalation is approved several times, each approval pays once."

The replacement: "An escalation has at most one approval (L2-4.3), so it authorizes at most one
payment. Approving an approved escalation returns the existing approval."

## L2-4.3 Escalation lifecycle (new)

An escalation is created by its `ESCALATED` entry at `createdMs = Date.parse(ts)`. It expires at
`expiresAtMs = createdMs + 300 000`, a constant that is not configurable. Its state is derived from
the ledger and the decision time only:

1. `approved` when a `HUMAN_APPROVAL` names it.
2. `denied` when a `HUMAN_REJECTION` names it.
3. `expired` when an `ESCALATION_EXPIRED` names it, or `nowMs ≥ expiresAtMs`.
4. Otherwise `pending`.

**Final states.** `approved`, `denied` and `expired` are final and are never left. Approve and
reject act only on a pending escalation. Repeating the deciding action returns the existing
decision. The opposite action, or any action on an expired escalation, is 409 and appends nothing.

**Sweep.** `sweep(nowMs)` runs at the start of every serialized operation and every 1 s from
`main()`. It appends:
- one `ESCALATION_EXPIRED` for each escalation still pending with `nowMs ≥ expiresAtMs`;
- one `APPROVAL_LAPSED` for each approval with `nowMs > expiresAtMs`, not consumed, and not already
  recorded.

**One pending escalation per purchase.** A purchase is (session, resource key, payee lower-cased,
exact amount). While an escalation for a purchase is pending, an ESCALATE decision for the same
purchase returns that escalation's `authorizationId` and is recorded as `ESCALATION_REPEATED`.

**Denial scope.** A `HUMAN_REJECTION` blocks its (session, resource key) for good, through R15,
whatever the amount or payee. An expiry blocks nothing: the next request for the same purchase
escalates again under a new ID.

**Notifications** are the lifecycle entries themselves. The operator reads them through
`GET /v1/escalations` and `GET /v1/escalations/events?after=`.

## INV-12 row: note to add

"Since v1.3 an escalation has at most one approval, and a `HUMAN_REJECTION` (R15) is a DENY that no
approval can lift."
