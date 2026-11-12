# Data Model: Per-User Backchannel Approval

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

No new store and no new ledger entry type. One optional field on the payment request, new values on existing
fields, and derivations. Everything about a person is their one-way identifier (`usr_…`, 013).

## People and identifiers

| Term | What it is | Where it exists |
|---|---|---|
| Owner | the user recorded on an escalation (`ESCALATED.data.userId`) | the ledger, since 013 |
| `userId` | `usr_` + 32 hex characters: `userIdFor(issuer, subject)` | the payment request, the ledger, the views |
| `approvalSubject` | the person's subject at the approval service (the `sub` of their sign-in token) | the payment request and L2's memory only ([R7](research.md#r7-where-the-subject-lives-and-for-how-long)) |
| Approval issuer | L2's `CIBA_ISSUER` | L2's settings |

**The identity rule.** `approvalSubject` belongs to `userId` exactly when
`userIdFor(approval issuer, approvalSubject) === userId`. Nothing else links the two, and nothing stores the
link.

## The payment request (`PaymentIntent`, `src/shared/contracts.ts`)

One new optional field:

| Field | Type | Set by | Rules |
|---|---|---|---|
| `approvalSubject?` | string | the hosted agent, for a person's run only | 1 to 255 characters, no whitespace or control character; only together with `userId`; otherwise 400 |

L2 never records it and never returns it. With user accounts off it is ignored, as `userId` is.

## The approval-request mark (`ESCALATED.data.approvalRequest`)

Written once, with the entry, when backchannel approval is on.

| Mark | Since | Meaning |
|---|---|---|
| `requested` | 012 | one request is sent to the owner |
| `capped` | 012 | the owner has 10 `requested` escalations in the trailing hour (per person since this feature) |
| `operator_only` | 012 | the request asked for the operator path only |
| `reevaluation` | 012 | written by a re-evaluation after a wait; never starts a request |
| `no_owner` | 015 | the escalation records no user: nobody is asked |
| `no_identity` | 015 | the request named a user and carried no `approvalSubject` |
| `identity_mismatch` | 015 | the subject does not resolve to the user under L2's approval issuer |

Order of evaluation: [research R4](research.md#r4-eligibility-three-new-marks-decided-in-the-same-place).

## The approval request's state (derived, `approvalRequestState(entries, escalationId, nowMs)`)

`ApprovalRequestState` is every mark above, plus the states a `requested` escalation moves through:

| State | Derived from |
|---|---|
| `requested` | marked `requested`, the escalation pending, no ending entry |
| `answered` | a `HUMAN_APPROVAL` or `HUMAN_REJECTION` with `channel: "backchannel"` |
| `failed` | `APPROVAL_REQUEST_FAILED` |
| `lapsed` | `APPROVAL_REQUEST_LAPSED` (the request ended before its escalation) |
| `verification_failed` | `APPROVAL_VERIFICATION_FAILED` |
| `abandoned` | another path decided while the request was open (narrowed in 015) |
| `unanswered` (new) | no ending entry and the escalation expired, swept or not |

```text
                      ┌─ answer verified ───────────────► answered (approved)
                      ├─ refusal ≥ 5 s before expiry ───► answered (denied)
requested ────────────┼─ answer fails a check ──────────► verification_failed   (escalation stays pending)
(one request, to      ├─ permanent error ───────────────► failed                (escalation stays pending)
 the owner)           ├─ request ends early ────────────► lapsed                (escalation stays pending)
                      ├─ operator or administrator ─────► abandoned
                      └─ the 300 s window passes ───────► unanswered
```

The escalation's own states and their rules are unchanged (010, 014): pending, approved, denied, expired; the
first final state recorded is final.

## Ledger entries

No new type. Field changes on entries written from this feature on
([research R6](research.md#r6-what-the-ledger-writes-the-owners-one-way-identifier-where-the-approvers-subject-was)):

| Entry | Field | Value |
|---|---|---|
| `ESCALATED` | `approvalRequest` | may be `no_owner`, `no_identity`, `identity_mismatch` |
| `APPROVAL_REQUESTED` | `approver` | the owner's `usr_…` |
| `HUMAN_APPROVAL` (`channel: "backchannel"`) | `approver` | the owner's `usr_…` |
| | `evidence` | `{ issuer, userId, answerId, issuedAt, detailsSource }`; no `subject` |
| `HUMAN_REJECTION` (`channel: "backchannel"`) | `approver` | the owner's `usr_…` |
| `APPROVAL_VERIFICATION_FAILED` | `check` | may be `owner`; `approver` is no longer produced |
| `APPROVAL_REQUEST_FAILED` | `failure` | may be `no_owner` (with `phase: "resume"`, [R10](research.md#r10-a-request-that-is-open-when-this-feature-is-deployed)) |
| `INTENT`, every other entry | | unchanged; never `approvalSubject` |

Entries written before this feature are never rewritten. A reader finds either an Auth0 subject (old) or a
`usr_…` (new) in `approver` of a backchannel entry, and shows it as it is.

**Never in the ledger**: `approvalSubject`, a token, an unsealed handle, the approval service's text, a name,
an email.

## The limit (derived)

`approvalRequestCount(entries, nowMs, windowMs, userId)`: the number of `ESCALATED` entries with
`approvalRequest: "requested"` and that `userId` whose time is inside the trailing window. Cap 10, window one
hour, both constants.

## Views

| View | Change |
|---|---|
| `EscalationView` (operator, administrators) | `approvalRequest` may hold the new marks and `unanswered`; `userId` (013) already names the owner, who is the person asked |
| `EscalationEvent` | `approver` and `decidedBy` of a backchannel decision hold `usr_…`; `check` may be `owner` |
| `EscalationDecision` | `decidedBy` for the backchannel is `usr_…` |
| `PlatformView` | gains `phoneApproval: boolean` |
| `WaitingPayment` (new) | below |

### `WaitingPayment` (new; `GET /v1/users/:userId/escalations`)

One pending escalation of the user, built field by field:

| Field | Type | Notes |
|---|---|---|
| `authorizationId` | string | the escalation's ID |
| `referenceCode` | string | the 8 characters the phone shows too |
| `resourceKey`, `payTo`, `amount` | string | as on the escalation; `amount` in atomic units |
| `createdAt`, `expiresAt` | ISO string | |
| `waitingFor` | `"phone"` \| `"operator"` | `phone` only while the request is open |
| `reason?` | `WaitingReason` | only with `operator` |

`WAITING_REASONS` (a constant in `src/shared/contracts.ts`): `limit_reached`, `sign_in_not_supported`,
`phone_unreachable`, `service_unavailable`, `request_expired`, `answer_not_accepted`. `request_expired` is the
reason for a `lapsed` request, whose escalation is still pending; the state `unanswered` belongs to an expired
escalation, which is no longer in the list. The mapping from the request's state is in [research
R11](research.md#r11-what-a-person-sees-their-own-waiting-payments-with-a-reason-from-a-fixed-list).

## Settings

| Setting | Change |
|---|---|
| `CIBA_APPROVER` (L2) | removed; refused when present with `CIBA_APPROVAL=1` |
| `CIBA_APPROVAL=1` | now needs `USER_ACCOUNTS=1` |
| `ciba.approver` (parameter files) | removed |
| `approver_user_id`, `AUTH0_APPROVER_USER_ID` (tenant) | removed |

Details: [contracts/config-and-secrets.md](contracts/config-and-secrets.md).

## Enrollment

Held by the approval service only: which phone a person enrolled, and whether they did. This system stores
nothing about it and learns of a missing phone only from a refused request
([research R12](research.md#r12-no-phone-cannot-be-told-apart-from-other-permanent-refusals)).

## Validation rules, in one place

| Rule | Requirement | Where |
|---|---|---|
| `approvalSubject` shape; never without `userId` | FR-009 | the authorize route's body check |
| the subject resolves to the user | FR-009, FR-011 | eligibility, inside the serialized section |
| one request per eligible escalation, to its owner | FR-006 | eligibility and `Backchannel.start` |
| no user, no request | FR-007 | eligibility (`no_owner`) |
| at most 10 per person per hour | FR-015 | eligibility (`capped`) |
| the answer comes from the owner | FR-013 | verification step 7 (`owner`) |
| a leftover approver setting stops L2 | FR-003 | `cibaConfigFromEnv` |
| backchannel approval needs user accounts | FR-001 | `main()` before the lock; `createControlService`; `main.bicep` |
| a person reads only their own waiting payments | FR-019 | the portal takes the user from the token; L2 filters by owner |
