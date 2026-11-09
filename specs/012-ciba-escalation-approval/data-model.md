# Data Model: Backchannel Approval of Escalated Payments

Every piece of state is derived from the hash-chained ledger (INV-7, INV-9). This feature writes no
other store, and it keeps no counters and no in-memory state that survives a restart. The only
in-memory state is the poll loops and the waiters, and the ledger rebuilds both (research R8). The
envelope is unchanged: `{ seq, ts, type, sessionId?, intentId?, authorizationId?, data, prevHash,
hash }`. Amounts are atomic decimal strings, times are integer milliseconds or ISO strings, and
optional fields are omitted, never written as `null`.

## Constants

All of these are fixed: none is configurable, like the 300 s escalation window. Tests override the
timing ones through test-only dependencies, never through env.

| Name | Value | Where | Source |
|---|---|---|---|
| `BACKCHANNEL_WAIT_MS` | 120 000 | `backchannel.ts` | FR-016, the clarification |
| `APPROVAL_REQUEST_CAP` | 10 | `backchannel.ts` | FR-008 |
| `APPROVAL_REQUEST_CAP_WINDOW_MS` | 3 600 000 | `backchannel.ts` | FR-008, rolling hour |
| `START_RETRY_DELAYS_MS` | `[250, 1000]` | `backchannel.ts` | FR-009: the wait after the 1st and the 2nd transient failure (3 attempts, the first at once) |
| `START_ATTEMPT_TIMEOUT_MS` | 1 500 | `ciba-client.ts` | R10: a hanging service ends the start within 6 s (FR-018) |
| `POLL_TIMEOUT_MS` | 5 000 | `ciba-client.ts` | R10 |
| `REFUSAL_MARGIN_MS` | 5 000 | `backchannel.ts` | the 5 s refusal-or-lapse rule (Edge cases) |
| `DEFAULT_POLL_INTERVAL_S` | 5 | `backchannel.ts` | CIBA Core §7.3 |
| `SLOW_DOWN_STEP_S` | 5 | `backchannel.ts` | CIBA Core §11 |
| `MAX_TRANSIENT_POLL_DELAY_S` | 30 | `backchannel.ts` | R11 |
| `MAX_REQUESTED_EXPIRY_S` | 300 | `payment-details.ts` | Guardian push limit; FR-006 |
| `CLOCK_TOLERANCE_S` | 60 | `approval-evidence.ts` | FR-020, as for L1-6 |
| `BINDING_MESSAGE_MAX` | 64 | `payment-details.ts` | Auth0 limit |
| `REFERENCE_CODE_LENGTH` | 8 | `payment-details.ts` | R4 |
| `DEFAULT_APPROVAL_TTL_SECONDS` | 600 | `approval-routes.ts`, unchanged | A backchannel approval uses the same value |

## Ledger entries

### Changed: new fields on entries written from now on

| Type | New fields in `data` | When |
|---|---|---|
| `INTENT` | `reevaluationOf` (the escalation ID) | Only on the second `INTENT` of an intent, written by the re-evaluation after a wait (FR-017). The first `INTENT` is unchanged. Each `INTENT` is still followed by exactly one outcome entry. |
| `ESCALATED` | `approvalRequest`: `requested` \| `capped` \| `operator_only` \| `reevaluation` | Only when backchannel approval is on. Written inside the same serialized block as the entry (research R9). Absent when off, so the off path writes exactly today's entry. |
| `HUMAN_APPROVAL` | `channel`: `operator` \| `backchannel` | Always. An older entry without it reads as `operator`. |
| `HUMAN_APPROVAL` (backchannel) | `requestId`, `evidence: { issuer, subject, answerId, issuedAt, detailsSource }` | `approver` is the verified `sub`; `expiresAtMs` = entry time + 600 000. |
| `HUMAN_REJECTION` | `channel`: `operator` \| `backchannel` | Always. An older entry without it reads as `operator`. |
| `HUMAN_REJECTION` (backchannel) | `approver` (= `CIBA_APPROVER`), `issuer`, `requestId` | It has no `operator` and no `reason`, so no free text from Auth0 (NFR-006). |

### New

The envelope of each new entry has the escalation's `sessionId` and `authorizationId` = the
escalation's ID. Each entry's `data` starts with `escalationId`, `resourceKey`, `payTo` and `amount`,
**copied from the `ESCALATED` entry**, like the 010 entries. So every event shows the purchase.
Each also holds `channel: "backchannel"`.

| Type | Written when | Further `data` fields |
|---|---|---|
| `APPROVAL_REQUESTED` | `bc-authorize` succeeded, and the escalation was still pending when its result was recorded | `requestId` (`apq_<uuid>`), `issuer`, `approver`, `referenceCode`, `bindingMessage`, `details` (the `authorization_details` array exactly as sent), `requestedExpirySec`, `requestExpiresAtMs`, `intervalSec`, `handleSealed`, `attempts` |
| `APPROVAL_REQUEST_FAILED` | The start gave up (permanent, or a third transient failure); a poll got a permanent error; or the resume found an interrupted start or a handle it can't open | `requestId?` (absent when nothing was sent), `phase`: `start` \| `poll` \| `resume`; `failure`: `unreachable` \| `transient` \| `permanent` \| `interrupted` \| `unrecoverable`; `httpStatus?`; `error?` (a code from the [fixed list](contracts/auth0-ciba.md#error-codes), or `other`); `attempts?` |
| `APPROVAL_REQUEST_LAPSED` | `expired_token`; an `access_denied` within 5 s of the request's expiry; or the request's expiry passing with no answer | `requestId`, `cause`: `late_refusal` \| `expired`, `requestExpiresAtMs` |
| `APPROVAL_VERIFICATION_FAILED` | A token answer failed a check in [R5](research.md#r5-which-answer-proves-the-approval) | `requestId`, `check`: `malformed` \| `signature` \| `issuer` \| `audience` \| `client` \| `expired` \| `approver` \| `request` \| `details` \| `replay` |

Validation rules:
- **Never stored anywhere**: the `auth_req_id`, any token, the client credential, and Auth0's
  `error_description` or any other free text (NFR-003). `handleSealed` is AES-256-GCM ciphertext
  (research R8).
- **Payment fields** (`details`, `bindingMessage`, `referenceCode`) are built only from the
  `ESCALATED` entry and the requirement L2 chose. They never include `purpose` (FR-005).
  [payment-details](contracts/payment-details.md) defines them.
- **`evidence.answerId`** is the token's `jti`, or `sha256:<64 hex>` of the token. It is unique
  across all `HUMAN_APPROVAL` entries; check `replay` enforces this.
- **`evidence.issuedAt`** is the token's `iat`, as ISO. `evidence.detailsSource` is `token` or
  `response` (research R5).
- **Final-state entries**: at most one per escalation, as in 010. A backchannel outcome is appended
  only if, inside the serialized section, the escalation is still pending and the answer's
  `requestId` is its open request (FR-028).
- **Request entries**: at most one `APPROVAL_REQUESTED` per escalation. At most one ending entry
  (`APPROVAL_REQUEST_FAILED`, `APPROVAL_REQUEST_LAPSED` or `APPROVAL_VERIFICATION_FAILED`) per
  request.

### A backchannel decision is a 004/010 decision

`policy.ts` sees no difference (FR-032).
- A backchannel `HUMAN_APPROVAL` is found by `findOpenApproval` and consumed by `approvalRef`,
  exactly like an operator approval: single use, exact match, a 600 s TTL, and it lapses through
  the sweep (L2-4.2).
- A backchannel `HUMAN_REJECTION` is found by `findRejection` and drives R15. The violation detail
  is still `rejected by the operator (<rejectionId>)`, unchanged, so a refusal can't be told apart
  from an operator rejection (US2).

## Approval request lifecycle

It is derived for one escalation from its `ESCALATED.approvalRequest` and the request entries. It
never changes the escalation's own state machine (010 L2-4.3). It only adds a way to reach
`approved` or `denied`.

```text
ESCALATED.approvalRequest
  absent ............................ feature off: no request (today's behavior)
  operator_only | capped | reevaluation  ── no request, terminal
  requested
     │ start (≤ 3 attempts, outside the lock)
     ├──────────────▶ APPROVAL_REQUEST_FAILED {phase: start}            → failed        (escalation stays pending)
     ├── crash ─────▶ (resume) APPROVAL_REQUEST_FAILED {interrupted}    → failed
     ▼
  APPROVAL_REQUESTED                                                    → open
     │ poll every interval (slow_down adds ≥ 5 s)
     ├─ token, verified ─────▶ HUMAN_APPROVAL {channel: backchannel}     → answered  (escalation approved)
     ├─ token, check fails ──▶ APPROVAL_VERIFICATION_FAILED {check}      → verification_failed (stays pending)
     ├─ access_denied ≥ 5 s before expiry ─▶ HUMAN_REJECTION {backchannel} → answered (escalation denied)
     ├─ access_denied later | expired_token | expiry passes ─▶ APPROVAL_REQUEST_LAPSED → lapsed (stays pending)
     ├─ permanent poll error ─▶ APPROVAL_REQUEST_FAILED {phase: poll}    → failed
     ├─ handle won't open on resume ─▶ APPROVAL_REQUEST_FAILED {unrecoverable} → failed
     └─ escalation reaches a final state another way (operator, expiry) → abandoned (nothing appended)
```

The escalation's state machine is unchanged. Whatever happens to the request, a pending escalation
still ends exactly once, as approved, denied or expired, at the latest after 300 s (SC-004).

## Derived functions (`escalations.ts` and `backchannel.ts`)

All of them are pure over `entries` plus `nowMs`. None reads the clock.

| Function | Returns |
|---|---|
| `referenceCode(escalationId)` | The first 8 hex digits of the UUID in `auth_<uuid>` |
| `approvalRequestCount(entries, nowMs)` | The number of `ESCALATED` entries with `approvalRequest: "requested"` and `ts` within the last hour; this is the cap |
| `approvalRequestState(entries, escalationId)` | `requested` (starting or open) \| `capped` \| `operator_only` \| `reevaluation` \| `failed` \| `verification_failed` \| `lapsed` \| `answered` \| `abandoned` \| `undefined` (feature off) |
| `openApprovalRequest(entries, escalationId, nowMs)` | The `APPROVAL_REQUESTED` entry when the escalation is pending, the request has no ending entry, and `nowMs < requestExpiresAtMs`; else `undefined` |
| `requestsToResume(entries, nowMs)` | `{ open, stale, interrupted }`: requests still open (poll again from the sealed handle); requests past their own expiry while the escalation is pending (record the lapse); and `requested` escalations still pending with no request entry (record `interrupted`) |
| `activeApprovalRequest(entries, escalationId)` | The `APPROVAL_REQUESTED` with no ending entry, whatever the time (used to record a lapse or a failure) |
| `answerIdUsed(entries, answerId)` | Whether any `HUMAN_APPROVAL.evidence.answerId` equals it |

## Operator views (whitelist projections)

`GET /v1/escalations` (pending items) gains two fields:
- `referenceCode`, always;
- `approvalRequest`, only when `ESCALATED` carries the field. It holds `approvalRequestState`,
  which for a pending escalation is one of `requested`, `capped`, `operator_only`, `reevaluation`,
  `failed`, `verification_failed` or `lapsed`.

`GET /v1/escalations/events`:

| Kind | Source entry | Fields beyond the 010 base (`seq, at, kind, authorizationId, sessionId, resourceKey, payTo, amount`) |
|---|---|---|
| `escalated` | `ESCALATED` | `expiresAt`, `referenceCode`, `approvalRequest?` |
| `approved` | `HUMAN_APPROVAL` | `approvalId`, `approver`, `approvalExpiresAt`, `channel`, `decidedBy` (= `approver`) |
| `denied` | `HUMAN_REJECTION` | `rejectionId`, `channel`, `decidedBy` (the operator label, or the approver's `sub`), `operator?` and `reason?` (operator channel only) |
| `expired` | `ESCALATION_EXPIRED` | `expiresAt` (unchanged) |
| `approval_lapsed` | `APPROVAL_LAPSED` | `approvalId` (unchanged) |
| `approval_requested` | `APPROVAL_REQUESTED` | `requestId`, `referenceCode`, `requestExpiresAt` |
| `approval_request_failed` | `APPROVAL_REQUEST_FAILED` | `requestId?`, `failure`, `error?` |
| `approval_request_lapsed` | `APPROVAL_REQUEST_LAPSED` | `requestId`, `cause` |
| `approval_verification_failed` | `APPROVAL_VERIFICATION_FAILED` | `requestId`, `check` |

These never appear in a view or an event: `handleSealed`, `details`, `bindingMessage`, `evidence`
(apart from `decidedBy`), `issuer`, tokens, `accepts` and `purpose` (FR-026, FR-029, NFR-003).
T-LED-04's forbidden-key check is extended to the new kinds.

## Payment details

The `authorization_details` object, binding message, reference code and requirement digest are
defined in [contracts/payment-details.md](contracts/payment-details.md).
