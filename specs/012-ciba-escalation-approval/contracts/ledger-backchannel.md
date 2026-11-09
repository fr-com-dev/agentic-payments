# Contract: SPEC text for L2-4, L2-4.3, L2-5 and the new L2-7

This is the normative text that goes into SPEC.md v1.8. [data-model](../data-model.md) has the
field-level detail.

## L2-4 Ledger: table changes

| Type | Written when | `data` fields |
|---|---|---|
| `INTENT` | every authorize call, before deciding, followed by exactly one outcome entry; **and again, with `reevaluationOf`, when a call re-evaluates after its wait ended in a final state (L2-7)** | `resourceUrl, purpose, accepts, reevaluationOf?` |
| `ESCALATED` | decision ESCALATE | `violations, resourceKey, payTo, amount, approvalRequest?` (`requested`, `capped`, `operator_only` or `reevaluation`, written only when backchannel approval is on) |
| `HUMAN_APPROVAL` | the operator approves, **or a verified backchannel answer approves (L2-7)** | `approvalId, escalationId, resourceKey, payTo, amount, approver, expiresAtMs, channel` (`operator` or `backchannel`; an older entry without it is `operator`), plus `requestId` and `evidence {issuer, subject, answerId, issuedAt, detailsSource}` for `backchannel` |
| `HUMAN_REJECTION` | the operator rejects, **or the approver refuses (L2-7)** | `rejectionId, escalationId, resourceKey, payTo, amount, channel`, plus `operator, reason?` for `operator`, or `approver, issuer, requestId` for `backchannel` |
| `APPROVAL_REQUESTED` | L2-7: the approval service accepted the request | `escalationId, resourceKey, payTo, amount, channel, requestId, issuer, approver, referenceCode, bindingMessage, details, requestedExpirySec, requestExpiresAtMs, intervalSec, handleSealed, attempts` |
| `APPROVAL_REQUEST_FAILED` | L2-7: a start, a poll or a resume failed for good | `escalationId, resourceKey, payTo, amount, channel, requestId?, phase, failure, httpStatus?, error?, attempts?` |
| `APPROVAL_REQUEST_LAPSED` | L2-7: the request expired, or a refusal came within 5 s of its expiry | `escalationId, resourceKey, payTo, amount, channel, requestId, cause, requestExpiresAtMs` |
| `APPROVAL_VERIFICATION_FAILED` | L2-7: an answer failed a check | `escalationId, resourceKey, payTo, amount, channel, requestId, check` |

## L2-4.3: amended bullet

- **Notifications.** The lifecycle entries themselves are the notifications. The operator reads
  them through `GET /v1/escalations` and `GET /v1/escalations/events`. L2 makes no outbound
  connection to notify the operator. **Since v1.8, its only outbound connections are to the
  configured approval service (L2-7), which asks the approver.**

## L2-5: authorize algorithm (replaces the numbered list)

1. **Serialized section.** `t = now()`, sweep, append `INTENT`, look up the open approval and the
   rejection, build `ctx`, `decide`, then sign or deny, and append the outcome entry. When
   backchannel approval is on and the outcome is a new `ESCALATED`, record its `approvalRequest`
   in the same entry (L2-7).
2. **Wait, outside the section**, only for `approvalRequest: "requested"`. Start the approval
   request, then wait at most 120 s for the escalation to reach a final state. Nothing is locked;
   every other call proceeds. If the caller disconnects, stop and return nothing.
3. **Second serialized section**, only when the escalation reached `approved` or `denied` during
   the wait. Repeat step 1 with a fresh `t`, an `INTENT` carrying `reevaluationOf`, no approval
   request and no wait. Return its decision.
4. Otherwise, return the decision from step 1.

`PaymentIntent.operatorApprovalOnly`, when present, must be a boolean (400 otherwise).

## L2-7 Backchannel approval (new, v1.8, `specs/012`)

- **Off by default.** It is on only with `CIBA_APPROVAL=1` and a complete configuration (CFG-2).
  With it off, L2 behaves as in v1.7.
- **Approval service.** An Auth0 tenant, reached by OpenID CIBA in poll mode (`specs/012`
  contracts/auth0-ciba.md). One approver per L2 (`CIBA_APPROVER`).
- **Eligibility**, decided in the authorize section that writes the new `ESCALATED`:
  - not a repeat of a pending purchase (L2-4.3);
  - not `operatorApprovalOnly`;
  - fewer than 10 `requested` escalations in the trailing hour.

  It is recorded as `approvalRequest`.
- **Start.** One request per eligible escalation, outside the serialized section, with up to 3
  attempts within 2 s on transient failures, and none after a permanent refusal. The request
  carries a binding message and one `authorization_details` object built only from the escalation
  and the chosen requirement (`specs/012` contracts/payment-details.md). Its lifetime never exceeds
  the escalation's remaining window, nor 300 s.
- **Poll.** At the service's interval; `slow_down` lengthens it. Polling stops when the escalation
  reaches a final state by any path. After a restart, L2 resumes every open request from the
  ledger (`handleSealed`) without sending a new one.
- **Outcomes.** Every check-then-append runs inside the serialized section; no call to the service
  does.
  - **A verified token** gives `HUMAN_APPROVAL`, channel `backchannel`, TTL 600 s. Verification
    checks the signature against the issuer's JWKS, plus the issuer, audience, client, validity
    (60 s tolerance), approver, open request, field-for-field payment details, and single use.
  - **A failed check** gives `APPROVAL_VERIFICATION_FAILED`.
  - **`access_denied` at least 5 s before the request's expiry** gives `HUMAN_REJECTION`, channel
    `backchannel`.
  - **A later refusal, an expiry, or no answer** gives `APPROVAL_REQUEST_LAPSED`.
  - **A permanent error** gives `APPROVAL_REQUEST_FAILED`.

  In every case except approval and rejection, the escalation stays pending and expires at 300 s
  as usual.
- **Equivalence.** A backchannel approval or rejection is consumed by L2-2 exactly like an
  operator one, through `humanApprovedFor` and `humanRejected`. INV-12 is unchanged.
- **Never stored or shown**: the client credential, tokens, request handles and the service's
  free text, whether in the ledger, logs, events, responses, L1 or L3. Only whitelisted OAuth error
  codes are kept.
