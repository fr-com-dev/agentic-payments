# Contract: L2-5 delta (control API) and §7 contracts

Normative for the SPEC L2-5 table, §7 and `docs/l2-control.openapi.yaml`; T-API-01..04 fail until all three match
the service. L2 still binds 127.0.0.1 only. Every route below exists only when user accounts and the
administration area are both on (`USER_ACCOUNTS=1` and `PORTAL_ADMIN=1`); otherwise each answers 404.

## §7: contract changes (`src/shared/contracts.ts`)

Moved here from `src/layer2-control/escalations.ts`, which re-exports them (hard rule 1: the portal can't import
from L2): `EscalationView`, `EscalationEvent`, `EscalationEventKind`, `ApprovalRequestState`, `DecisionChannel`.

Changed:

```ts
export type DecisionChannel = "operator" | "backchannel" | "portal";   // was "operator" | "backchannel"
export interface EscalationEvent { /* … */ reasonCode?: RejectionReasonCode }
```

New, as defined in [data-model.md](../data-model.md#derived-views): `REJECTION_REASON_CODES`,
`RejectionReasonCode`, `BudgetLine`, `EscalationBudget`, `EscalationDetail`, `EventPage`, `DecisionOutcome`,
`LedgerCheck`.

`PaymentIntent`, `AuthorizationDecision`, `BudgetStatus`, `SettlementReport` and `AuthorizationGatePort` are
unchanged: the agent and L3 see no difference.

## Roles (INV-13)

| Role | Token variable | Held by | Routes |
|---|---|---|---|
| `portal-admin` (new, the sixth) | `PORTAL_ADMIN_TOKEN` | portal, L2 verifies | the six routes under "Administration routes", and nothing else |

`ENDPOINT_ROLES` gains each route; every endpoint still accepts exactly one role.

| Token | `/v1/admin/*` | `/v1/users/*`, `/v1/platform` | operator's routes | authorize, budget | reconcile |
|---|---|---|---|---|---|
| `PORTAL_ADMIN_TOKEN` | ✅ | 401 | 401 | 401 | 401 |
| `PORTAL_TOKEN` | 401 | ✅ | 401 | 401 | 401 |
| `OPERATOR_TOKEN` | 401 | 401 | ✅ | 401 | 401 |
| `CONTROL_TOKEN` | 401 | 401 | 401 | ✅ | 401 |
| `SETTLEMENT_TOKEN` | 401 | 401 | 401 | 401 | ✅ |

Auth runs before any validation, so 401 precedes 400, 403, 404 and 409, and a wrong token never appends an entry.

## Unchanged routes

`POST /v1/authorize`, `GET /v1/budget/:sessionId`, `POST /v1/reconcile`, `POST /v1/approvals/:authorizationId`,
`POST /v1/rejections/:authorizationId`, `GET /v1/escalations`, `GET /v1/escalations/events`,
`GET /v1/ledger/verify` and every 013 portal route keep their token, request, response and errors.

One additive response detail on the operator's reads: an event or a decision made in the portal shows
`channel: "portal"`, `decidedBy: <usr_…>` and, for a rejection, `reasonCode`. The operator's CLI prints them.

## Administration routes (`PORTAL_ADMIN_TOKEN`)

`:authorizationId` must match `^auth_[0-9a-f-]{36}$` (else 400). Bodies are JSON, at most 16 KB. No body carries
free text: every string is an identifier or a code. Unknown body or query fields are a 400.

| Method & path | Request | 200 response | Errors |
|---|---|---|---|
| `GET /v1/admin/escalations` | — | `{ pending: EscalationView[], cursor, readAt }`, oldest first; `cursor` is the last ledger `seq` (-1 when empty) | 401 |
| `GET /v1/admin/escalations/events` | query `after` or `before` (integer ≥ -1, not both), `limit` (1–200, default 50) | `EventPage` | 400, 401 |
| `GET /v1/admin/escalations/:authorizationId` | — | `EscalationDetail`: the escalation in any state, its decision if any, its budget | 400, 401, 404 |
| `POST /v1/admin/escalations/:authorizationId/approve` | `{ decidedBy, identityConfirmedAtMs }` | `DecisionOutcome` (`state: "approved"`). Pending: one `HUMAN_APPROVAL`, `already: false`. Already approved, on any path: the first approval, `already: true`, nothing appended | 400, 401, 403 `own_payment`, 403 `step_up_required` (`maxAgeSec: 900`), 404, 409 `not_pending` |
| `POST /v1/admin/escalations/:authorizationId/reject` | `{ decidedBy, reasonCode }` | `DecisionOutcome` (`state: "denied"`). Pending: one `HUMAN_REJECTION`, `already: false`. Already denied, on any path: the first rejection, `already: true`, nothing appended | 400, 401, 403 `own_payment`, 404, 409 `not_pending` |
| `GET /v1/admin/ledger/verify` | — | `LedgerCheck`: `{ entries, ok, brokenAt? }`. At most 30 a minute from one address | 401, 429 `{ "error": "too many requests" }` with `Retry-After` |

Notes:

- **Reads write nothing** (FR-033). The three `GET` routes derive state from the entries and the clock and don't
  call `sweep`; L2's 1 s timer records expiries. The two `POST` routes sweep first, inside the serialized
  section, then follow [the six steps](../data-model.md#a-decision-from-the-portal-step-by-step).
- **409 body**: `{ error: "not_pending", state: "approved" | "denied" | "expired", channel?, decidedBy?,
  approvalId?, rejectionId?, expiresAt? }`. `approve` on a denied or expired escalation, and `reject` on an
  approved or expired one.
- **403 `own_payment`**: `decidedBy` equals the escalation's owner. Checked by L2 from the `ESCALATED` entry
  (FR-015). An escalation of the platform account has no owner.
- **403 `step_up_required`**: approvals only; judged by `stepUpFresh`, as for a loosening policy change.
- **The approval's validity** is 600 s, a constant. `ttlSeconds` is not accepted.
- **`decidedBy` and `identityConfirmedAtMs` are trusted** as the portal sends them: L2 never sees the person's
  sign-in ([research R12](../research.md#r12-what-a-compromised-portal-can-do)).
- **No route** here authorizes a payment, reports a settlement, changes a policy, a wallet or the platform
  config, or takes a session or a user chosen by the caller.

## What the agent never gets (FR-005)

- The hosted agent's tools stay `fetch_resource` and `check_budget`. `HttpAuthorizationGate` gains no method.
- `CONTROL_TOKEN` is refused on every administration route.
- The R15 violation a rejected purchase returns still carries only the rejection ID: no reason code, no decider,
  no channel (SEC-12).
- `src/layer1-intent/**`, `src/layer3-settlement/**` and `src/counterparty/**` never reference
  `PORTAL_ADMIN_TOKEN` (rule A12, extended).

## Tests

| ID | Covers |
|---|---|
| T-API-01..04 | the OpenAPI document matches the table, the sixth token and the new schemas |
| T-ADM-01 | each route's happy path and every listed error; 401 before 400, 403, 404 and 409; unknown fields refused |
| T-ADM-02 | the token matrix above, all six roles' tokens on all route families. **Must fail** with `singlePortalRole`: the user-account token approves |
| T-ADM-03 | approval: the entry's fields; the effect equals an operator's (one exact payment, once, 600 s); a policy paused, an account disabled or a budget used up after the approval still denies (INV-12) |
| T-ADM-04 | rejection: the entry's fields; R15 denies the same purchase; the violation the agent sees carries only the rejection ID; each reason code accepted, anything else 400 |
| T-ADM-05 | identity confirmation: fresh, the 15 min + 60 s boundary, stale, missing; a rejection needs none; refused before nothing is appended. **Must fail** with `skipDecisionStepUp` |
| T-ADM-06 | own payment: approve and reject both refused; another administrator succeeds; a platform-account escalation has no owner. **Must fail** with `skipOwnPaymentCheck` |
| T-ADM-07 | one final state: portal against operator and against the backchannel stand-in, in both orders and for both decisions; repeats return the first outcome; the 300 s boundary; an open phone request ends `abandoned`. **Must fail** with `skipPendingCheck`: a portal approval is recorded after an operator rejection |
| T-ADM-08 | reads: the pending list; the detail's budget lines equal the figures the decision's context uses, for a user and for the platform account, and `fits` at the limit and one atomic unit over; `applies: false` for a paused policy and a disabled user; the ledger length is unchanged by any read |
| T-ADM-09 | events paging: `after`, `before` and neither; `limit` bounds; walking the whole trail by pages yields every event once, in order; the field whitelist holds for portal decisions |
| T-ADM-10 | config and the off switch: `PORTAL_ADMIN=1` without `USER_ACCOUNTS=1`, without the token off `local`, or with a token equal to another role's, refuses to start before the ledger lock and names only the variable; off, every route is 404 and the token is ignored |
| T-LED-07 | `channelOf` for the three values and for an entry with none; `escalationEvents` and `approvalRequestState` with portal decisions; no secret-bearing key in any view |
