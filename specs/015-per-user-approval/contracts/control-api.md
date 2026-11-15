# Contract: L2's control API (delta to SPEC L2-5, L2-7 and §7)

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

What changes on L2's HTTP API. Everything not named here is unchanged. `docs/l2-control.openapi.yaml` changes
with it, and T-API-01..04 fail until both match the service.

## `POST /v1/authorize` (`CONTROL_TOKEN`)

**Request.** `PaymentIntent` gains one optional field:

```ts
/**
 * 015 (L2-7): the person's subject at the approval service, from the sign-in token the hosted agent verified.
 * Set by the hosted agent only, for a person's run, never from model text or a tool input. L2 uses it to address
 * one approval request to the escalation's owner and keeps it nowhere.
 */
approvalSubject?: string;
```

| Case | Answer |
|---|---|
| not a string, empty, longer than 255, or holding whitespace or a control character | 400 malformed |
| present without `userId` | 400 malformed |
| present, user accounts off | ignored, as `userId` is |
| present, backchannel approval off | ignored |

401 still precedes 400. The field is never echoed in a decision and never written to the ledger.

**Response and timing.** Unchanged: an `AuthorizationDecision`; a call that creates an escalation marked
`requested` may take up to 120 s and return the re-evaluated decision. The agent learns nothing new: an
escalation that asks nobody answers `ESCALATE` at once, as it does today when the feature is off.

**Eligibility** is decided inside the serialized section from the request and the ledger, in the order of
[research R4](../research.md#r4-eligibility-three-new-marks-decided-in-the-same-place).

## `GET /v1/users/:userId/escalations` (`PORTAL_TOKEN`), new

A person's own pending escalations. Mounted with the other user-account routes (user accounts on).

- `:userId` must match `^usr_[0-9a-f]{32}$`: otherwise 400. The portal takes it from the verified token.
- 200 with `{ payments: WaitingPayment[] }`, oldest first. An unknown user, or one with nothing pending, gets an
  empty list: the route does not say whether a user exists.
- It reads the entries and one clock value. It does not sweep, takes no lock and appends nothing.
- Every other token: 401 (each endpoint accepts exactly one role).

`WaitingPayment` and `WAITING_REASONS`: [data-model.md](../data-model.md#waitingpayment-new-get-v1usersuseridescalations).

```json
{
  "payments": [
    {
      "authorizationId": "auth_2f0c7a1e-8a53-4d0e-9a39-0d1c6e2b7f11",
      "referenceCode": "2f0c7a1e",
      "resourceKey": "http://127.0.0.1:4021/premium/report",
      "payTo": "0xcccccccccccccccccccccccccccccccccccccccc",
      "amount": "50000",
      "createdAt": "2026-11-12T10:00:00.000Z",
      "expiresAt": "2026-11-12T10:05:00.000Z",
      "waitingFor": "operator",
      "reason": "phone_unreachable"
    }
  ]
}
```

## `GET /v1/platform` (`PORTAL_TOKEN`)

`PlatformView` gains `phoneApproval: boolean`: true when backchannel approval is on in this L2.

## Views that already exist

| Route | Change |
|---|---|
| `GET /v1/escalations`, `GET /v1/admin/escalations`, `GET /v1/admin/escalations/:authorizationId` | `approvalRequest` may be `no_owner`, `no_identity`, `identity_mismatch` or `unanswered` |
| `GET /v1/escalations/events`, `GET /v1/admin/escalations/events` | for a backchannel decision, `approver` and `decidedBy` are the owner's `usr_…`; `check` may be `owner` |
| `POST …/approve`, `POST …/reject` (operator and administration) | unchanged, for every escalation, asked or not |

The 409 bodies that name an earlier decision keep their shape; the decider they name for a backchannel decision
is the `usr_…`.

## What must not appear in any response

`approvalSubject`, a token, a request handle, the approval service's text, a name, an email. T-CIBA-20 scans
every response of a run for a planted subject.

## Tests

| ID | What it proves |
|---|---|
| T-CIBA-15 | one request, addressed to the owner; two people each decide only their own (US1) |
| T-CIBA-16 | B's signed answer for A's escalation approves nothing: `APPROVAL_VERIFICATION_FAILED{owner}`. **Must fail** with the check skipped |
| T-CIBA-17 | a subject that does not resolve to the user: `identity_mismatch`, no request. No subject: `no_identity`. **Must fail** with `skipIdentityCheck` |
| T-CIBA-18 | no user, no request: the scripted run, a system identity's run and the command-line agent (`no_owner`). **Must fail** with `ownerlessSubject` |
| T-CIBA-19 | 11 escalations for A and one for B in an hour: A is asked 10 times, B is asked. **Must fail** with `sharedRequestCap` |
| T-CIBA-20 | the planted subject is in no ledger line, log line, event or response |
| T-CIBA-21 | an unanswered request reads `unanswered`, in a clean timeout and after a restart; no `APPROVAL_REQUEST_LAPSED` is written when the request lives as long as its escalation |
| T-CIBA-22 | a request open at deployment for an escalation with no user is not polled: `APPROVAL_REQUEST_FAILED{resume, no_owner}` |
| T-CIBA-23 | entries written before this feature verify and read: the configured approver's decisions still show who decided |
| T-USR-13 | the waiting-payments route: only the owner's, the reason for each state, the token matrix, no write |
| T-API-01..04 | the OpenAPI document matches the service |
