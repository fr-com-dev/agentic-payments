# Data Model: Portal Administration (014)

Phase 1 of [plan.md](plan.md). This feature adds no store and no ledger entry type. It adds fields to two
existing entries, one value to an existing enumeration, and views derived from the ledger. The routes that carry
them are in [contracts/control-api.md](contracts/control-api.md) and
[contracts/portal-api.md](contracts/portal-api.md).

## Stores

| Store | Owner | Change |
|---|---|---|
| The hash-chained JSONL ledger | L2 | new field values on `HUMAN_APPROVAL` and `HUMAN_REJECTION`; no new type |
| The profile store (one file per user) | portal | none. An administrator who is not a user has no file |
| The browser | web app | none. The web app stores nothing of its own (T-WEB-07 forbids `localStorage`); the trail's "New" mark lives in memory while the screen is open |

Nothing an administrator types is stored anywhere, because the administration area has no text field
([research R8](research.md#r8-rejection-reasons)).

## People and permissions

A person is identified, as in 013, by `userIdFor(tid, oid)` (`^usr_[0-9a-f]{32}$`), derived from the verified
token and never read from a request.

| `roles` claim holds | `user` | `admin` (feature on) | Can use |
|---|---|---|---|
| `Agent.Run` | true | false | everything of 013; no administration area |
| `Portal.Admin` | false | true | the administration area only; no profile, wallet or policy |
| both | true | true | both; can't decide their own payments |
| neither | — | — | refused (403), as today |

With the feature off, `admin` is always false and a person with only `Portal.Admin` is refused.

```ts
// src/portal/access.ts
export interface Person {
  userId: string;
  identityConfirmedAtMs: number;
  /** 014: holds Agent.Run. The 013 routes require it. */
  user: boolean;
  /** 014: holds Portal.Admin and the administration area is on. The /api/admin routes require it. */
  admin: boolean;
}
```

## Ledger entries

Unchanged types; `data` gains the fields in **bold** when the decision comes from the portal. Session, resource,
payee and amount are still copied from the `ESCALATED` entry, never from a request (INV-12).

| Type | Written when | `data` for `channel: "portal"` |
|---|---|---|
| `HUMAN_APPROVAL` | an administrator approves a pending escalation | `approvalId, escalationId, resourceKey, payTo, amount, expiresAtMs`, `channel: "portal"`, `approver: <usr_…>`, **`identityConfirmedAtMs`** |
| `HUMAN_REJECTION` | an administrator rejects a pending escalation | `rejectionId, escalationId, resourceKey, payTo, amount`, `channel: "portal"`, `approver: <usr_…>`, **`reasonCode`** |

- `expiresAtMs` is the append time plus 600 s (`DEFAULT_APPROVAL_TTL_SECONDS`). A portal request can't set it.
- `approver` is an identifier, never a name. It is the field the backchannel path already uses for its decider.
- A portal rejection has no `operator` and no `reason`. An operator rejection has no `reasonCode`.
- No entry holds a token, the administrator's name or email, or the portal's credential (NFR-003).

```ts
// src/shared/contracts.ts (moved from layer2-control/escalations.ts, extended)
export type DecisionChannel = "operator" | "backchannel" | "portal";
export const REJECTION_REASON_CODES = ["not_expected", "amount_too_high", "wrong_seller", "duplicate", "other"] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];
```

`channelOf(entry)` returns `"portal"` or `"backchannel"` when the entry says so, and `"operator"` otherwise, so an
entry written before 012 still reads as the operator's.

## The escalation state machine (unchanged)

```text
                 ┌─ HUMAN_APPROVAL  (operator | backchannel | portal) ──► approved
ESCALATED ──► pending ─┼─ HUMAN_REJECTION (operator | backchannel | portal) ──► denied
                 └─ 300 s pass, or ESCALATION_EXPIRED ─────────────────► expired
```

- `escalationState` is not changed: it keys on the entry type, so the third channel needs no new case.
- Final states are never left. The first final-state entry wins; a later request reads it and appends nothing.
- With backchannel approval on, a portal decision while a phone request is open leaves the request `abandoned`
  (`approvalRequestState`), exactly as an operator's decision does today. The waiting authorize call sees the
  final state and re-evaluates (012 FR-017).

### A decision from the portal, step by step

Inside the serialized section, in this order. Each refusal appends nothing.

| # | Check | Result when it fails |
|---|---|---|
| 1 | `sweep(ledger, t)`: record due expiries and lapses | — |
| 2 | the escalation exists | 404 `not found` |
| 3 | the state is `pending` | already the same decision: 200 with the first outcome and `already: true`; any other final state: 409 `not_pending` with `state`, `channel` and `decidedBy` |
| 4 | the decider is not the owner (`escalationOwner`) | 403 `own_payment` |
| 5 | approval only: `stepUpFresh(identityConfirmedAtMs, t)` | 403 `step_up_required`, `maxAgeSec: 900` |
| 6 | append one `HUMAN_APPROVAL` or `HUMAN_REJECTION` | 200 with the new outcome, `already: false` |

Steps 2, 3 and 6 are the shared decision core ([research R4](research.md#r4-one-decision-core-for-every-path));
steps 4 and 5 apply to the portal channel only. Step 3 comes before 4 and 5 so that nobody is asked to sign in
again, or told "this is yours", about an escalation that is already over.

## Derived views

All are built field by field from a whitelist, never by spreading entry data, as `EscalationEvent` is today.

### `EscalationView` (unchanged, moved to `contracts.ts`)

`authorizationId, sessionId, resourceKey, payTo, amount, createdAt, expiresAt, referenceCode, approvalRequest?,
userId?`. The pending list is `pendingEscalations(entries, nowMs)`, oldest first.

### `EscalationDetail` (new)

```ts
export interface EscalationDetail extends EscalationView {
  state: "pending" | "approved" | "denied" | "expired";
  /** Present once the escalation has a final-state entry written by a person. */
  decision?: {
    at: string;
    channel: DecisionChannel;
    decidedBy: string;               // usr_… for portal; the approver's subject for backchannel; the label for operator
    approvalId?: string;
    approvalExpiresAt?: string;
    rejectionId?: string;
    reasonCode?: RejectionReasonCode; // portal rejections
    reason?: string;                  // operator rejections: untrusted text, shown as text
  };
  budget: EscalationBudget;
}
```

### `EscalationBudget` (new)

```ts
export interface BudgetLine { capAtomic: string; spentAtomic: string; remainingAtomic: string }

export interface EscalationBudget {
  asset: string;
  decimals: number;
  /** False when no rule set applies to this purchase now. The lines are then zeros. */
  applies: boolean;
  /** Why not, when `applies` is false. */
  notApplying?: "user_not_onboarded" | "user_disabled" | "no_active_policy";
  autoApproveMaxAtomic: string;
  hardCapPerPaymentAtomic: string;
  /** The agent run's budget: the policy's run budget, or the mandate's session budget. */
  run: BudgetLine;
  /** The last 24 hours under the same policy, or under the mandate. */
  day: BudgetLine;
  /** A user's payment only: the user daily ceiling across all their policies. */
  userDay?: BudgetLine;
  /** `applies`, and the amount is within the per-payment cap and within every `remainingAtomic`. */
  fits: boolean;
}
```

- Built by `budgetLines(owner, sessionId, resourceUrl, nowMs)`, the function `decideOnce` uses for its policy
  context ([research R9](research.md#r9-the-budget-behind-an-escalation)). The policy is the one that applies
  **now**, which may differ from the `policyId` and `policyVersion` on the `ESCALATED` entry.
- `spentAtomic` is `committedAtomic` with the same owner, policy, session and time filters the decision uses. It
  does not include the escalation's own amount, which is not authorized yet.
- `remainingAtomic` is never below 0. All arithmetic is `BigInt` over atomic strings.
- `fits: true` is not a promise: the retry is decided again at payment time. `fits: false` means approving
  can't make it payable as things stand (FR-024).

### `EscalationEvent` (one field added) and `EventPage` (new)

`EscalationEvent` gains `reasonCode?: RejectionReasonCode`, set on a `denied` event of the portal channel. For that
channel `decidedBy` is the administrator's identifier and `operator` and `reason` are absent.

```ts
export interface EventPage {
  events: EscalationEvent[];   // oldest first
  first: number;               // seq of events[0], or -1 when empty
  last: number;                // seq of the last event, or -1 when empty
  cursor: number;              // the ledger's last seq at the read; poll with after=cursor
  more: boolean;               // events exist beyond this page in the direction asked
}
```

| Query | Page |
|---|---|
| `after=<seq>` | the first `limit` events with `seq > after`; `more` when later ones remain |
| `before=<seq>` | the last `limit` events with `seq < before`; `more` when earlier ones remain |
| neither | the last `limit` events; `more` when earlier ones remain |

When `more` is true on an `after` page, the caller continues from `last`, not from `cursor`.

### `DecisionOutcome` (new)

```ts
export type DecisionOutcome =
  | { ok: true; state: "approved"; approvalId: string; expiresAt: string; already: boolean; channel: DecisionChannel; decidedBy: string }
  | { ok: true; state: "denied"; rejectionId: string; rejectedAt: string; already: boolean; channel: DecisionChannel; decidedBy: string };
```

### `LedgerCheck` (new)

`{ entries: number; ok: boolean; brokenAt?: number }` from L2, which is what `verifyChain()` returns today. The
portal adds `checkedAt` (ISO time of the check it is showing, at most 10 s old).

## What the browser gets

The portal's views of the above ([portal-api.md](contracts/portal-api.md#administration-routes)):

| L2 shape | Portal shape | Difference |
|---|---|---|
| `EscalationView` | `AdminEscalation` | adds `mine: boolean` (the owner is the signed-in person); `amount` is renamed `amountAtomic`; `authorizationId` stays the route key |
| `EscalationDetail` | `AdminEscalationDetail` | the same, plus `mine` and `readAt` (the portal's clock at the read, for the countdown) |
| `EventPage` | the same | — |
| `DecisionOutcome` | the same | — |
| `LedgerCheck` | `LedgerCheck & { checkedAt }` | — |

Amounts reach the browser as atomic strings; the web app formats them with its existing `money.ts`. A user is
shown by identifier only (FR-009): the portal never looks another person's profile up for an administrator.

## Validation rules

| Input | Rule | Failure |
|---|---|---|
| `:authorizationId` (L2 and portal) | `^auth_[0-9a-f-]{36}$` | 400 |
| `decidedBy` (portal → L2) | `USER_ID_RE` | 400 |
| `identityConfirmedAtMs` (portal → L2, approve) | a safe integer; judged by `stepUpFresh` | 400 when not a number; 403 `step_up_required` when stale |
| `reasonCode` (reject) | one of `REJECTION_REASON_CODES` | 400 |
| `limit` (events) | integer 1 to 200; default 50 | 400 |
| `after`, `before` (events) | integer ≥ -1; not both | 400 |
| any body or query field not listed | refused | 400 |

## Constants

| Name | Value | Where |
|---|---|---|
| escalation window | 300 s | unchanged (`ESCALATION_TTL_MS`) |
| approval validity | 600 s | unchanged (`DEFAULT_APPROVAL_TTL_SECONDS`); fixed for the portal channel |
| identity confirmation | 15 min, 60 s tolerance | unchanged (`STEP_UP_MAX_AGE_MS`, `STEP_UP_TOLERANCE_MS`) |
| pending list poll | 3 s | web app |
| trail poll | 5 s | web app |
| event page size | default 50, at most 200 | L2 |
| ledger check cache | 10 s | portal |
