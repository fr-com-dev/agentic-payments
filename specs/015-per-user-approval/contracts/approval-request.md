# Contract: the approval request and its answer (delta to SPEC L2-7)

**Feature**: [../spec.md](../spec.md) | **Builds on**: `specs/012` contracts/auth0-ciba.md,
ledger-backchannel.md and payment-details.md

What changes between L2 and the approval service, and in what L2 records. The three fixed paths, the client
authentication, the binding message, the payment details, the retries, the polling and the 120 s wait are as
012 left them.

## The request (`bc-authorize`)

One form field changes its source:

| Field | Before | Now |
|---|---|---|
| `login_hint` | `{ "format": "iss_sub", "iss": <CIBA_ISSUER>, "sub": <CIBA_APPROVER> }` | `{ "format": "iss_sub", "iss": <CIBA_ISSUER>, "sub": <the owner's approvalSubject> }` |

- `CibaPort.start` takes the subject as a parameter. `CibaSettings` no longer holds one.
- The subject passed the identity check before it reached the port
  ([research R2](../research.md#r2-the-identity-check-recompute-the-one-way-identifier)).
- The binding message and `authorization_details` are built as today, from the escalation and the chosen
  requirement only. Neither names a person.

## The answer L2 accepts

The ten checks and their order are 012's. Step 7 changes:

| Step | Check | Rule |
|---|---|---|
| 1 | `malformed` | unchanged |
| 2 | `signature` | unchanged (RS256, the issuer's published keys) |
| 3 | `issuer` | unchanged: `iss` is exactly L2's approval issuer |
| 4 | `audience` | unchanged |
| 5 | `client` | unchanged |
| 6 | `expired` | unchanged (60 s tolerance) |
| 7 | **`owner`** (was `approver`) | `userIdFor(iss, sub)` equals the user recorded on the escalation |
| 8 | `request` | unchanged |
| 9 | `details` | unchanged, field for field |
| 10 | `replay` | unchanged |

A refusal (`access_denied`) carries no token. It is recorded for the owner, because the request was addressed
to the owner and the service asks nobody else, with the 5 s rule of 012.

## What L2 records

| Outcome | Entry | Names the person as |
|---|---|---|
| the service accepted the request | `APPROVAL_REQUESTED` | `approver: usr_…` |
| a verified approval | `HUMAN_APPROVAL`, `channel: "backchannel"` | `approver: usr_…`, `evidence.userId` |
| a refusal | `HUMAN_REJECTION`, `channel: "backchannel"` | `approver: usr_…` |
| an answer that fails a check | `APPROVAL_VERIFICATION_FAILED` | nobody; `check` names the step |
| the request ended before its escalation | `APPROVAL_REQUEST_LAPSED` | nobody |
| a permanent error, or a request that can't be resumed | `APPROVAL_REQUEST_FAILED` | nobody |
| nobody answered and the escalation expired | none: `ESCALATION_EXPIRED`, read as `unanswered` | |

The evidence of an approval is `{ issuer, userId, answerId, issuedAt, detailsSource }`.

## After a restart

- A request whose escalation records a user is polled again from its sealed handle. No new request is sent and
  no subject is needed.
- A request whose escalation records no user is not polled
  ([research R10](../research.md#r10-a-request-that-is-open-when-this-feature-is-deployed)).
- An escalation marked `requested` with no request entry is recorded as `interrupted` and never resent, as
  today.

## Equivalence (unchanged)

The policy engine consumes an owner's approval or refusal exactly as an operator's, through
`humanApprovedFor` and `humanRejected`. An approval lifts the approval requirement once, for one exact
purchase; the re-evaluation checks every budget and DENY rule again (INV-12). `policy.ts` is not edited.

## Tests

T-CIBA-15, 16, 21, 22 and 23 ([control-api.md](control-api.md#tests)). T-CIBA-01..14 keep their meaning; they
change only where they named the configured approver (the helper's two people replace it).
