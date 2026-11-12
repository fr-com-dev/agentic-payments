# Contract: L2-5 delta (control API) and §7 contracts

> **Since 014 (SPEC v1.11).** L2 also serves six administration routes under `/v1/admin/` to a sixth role,
> `portal-admin` (`PORTAL_ADMIN_TOKEN`). They are defined in
> [specs/014 contracts/control-api.md](../../014-portal-l2-control-api/contracts/control-api.md). `PORTAL_TOKEN` is
> refused on all of them, and everything below is unchanged.

Normative for the SPEC L2-5 table, §7 and `docs/l2-control.openapi.yaml`; T-API-01..04 fail until all three match the
service. L2 still binds 127.0.0.1 only. Every route below exists only when user accounts are on (`USER_ACCOUNTS=1`);
off, each answers 404 and `PaymentIntent.userId` is ignored.

## §7: contract changes (`src/shared/contracts.ts`)

```ts
export interface PaymentIntent {
  // … unchanged fields …
  /** 013 FR-033: the verified person who started the run. Set by the hosted agent service only, never from
   *  model text or a tool input. Absent for system identities, the scripted agent and the local demo. */
  userId?: string; // ^usr_[0-9a-f]{32}$
}

export interface BudgetStatus {
  // … unchanged fields …
  /** 013: what the figures count. Absent means "session", as before. */
  scope?: "session" | "user_daily";
}

export interface AuthorizationGatePort {
  authorize(intent: PaymentIntent): Promise<AuthorizationDecision>;
  budget(sessionId: string, userId?: string): Promise<BudgetStatus>;
}
```

`AuthorizationDecision` is unchanged. For a user payment, `remainingSessionBudgetAtomic` is the smallest of what
remains of the policy's session budget, the policy's daily budget and the user daily ceiling, after this payment.

New shared, pure helpers (no layer code): `src/shared/user-id.ts` (`userIdFor(tid, oid)`, `USER_ID_RE`) and
`parseUsdc(text, decimals)` beside `formatAtomic` in `src/shared/config.ts`. The portal's request and response
shapes for L2 (`UserView`, `PolicyView`, `PolicyValues`, `PolicyIssue`, `PlatformView`) are added to
`src/shared/contracts.ts`, because they cross the portal/L2 boundary.

## Roles (INV-13)

| Role | Token variable | Held by | Routes |
|---|---|---|---|
| `portal-control` (new) | `PORTAL_TOKEN` | portal, L2 verifies | every route under "Portal routes" below, and nothing else |

`ENDPOINT_ROLES` gains each route. The `portal-control` token is refused on `/v1/authorize`, `/v1/budget`,
`/v1/reconcile`, `/v1/approvals`, `/v1/rejections`, `/v1/escalations*` and `/v1/ledger/verify`; the four existing
tokens are refused on every portal route (FR-049, T-USR-02). Auth runs before any validation, so 401 precedes 400,
404 and 409.

## Changed routes

### `POST /v1/authorize` (`CONTROL_TOKEN`)

- 400 also when `userId` is present and does not match `^usr_[0-9a-f]{32}$`.
- With user accounts on and `userId` present, the decision follows
  [data-model.md](../data-model.md#the-decision-for-a-user-payment). The algorithm's steps 1–6 keep their order;
  step 3 builds the user context and the effective mandate, and step 5 signs with the user's account.
- With user accounts on and no `userId`: the platform account, exactly as today (FR-002).
- New violations the agent may see: `user_not_onboarded` and `user_disabled`, each with a fixed detail and no other
  information (FR-012, FR-038, SEC-12).

### `GET /v1/budget/:sessionId?userId=<userId>` (`CONTROL_TOKEN`)

- Without `userId`: unchanged.
- With a well-formed `userId`: the user view of `BudgetStatus` (`scope: "user_daily"`). 400 for a malformed one.

### `GET /v1/escalations`, `GET /v1/escalations/events` (`OPERATOR_TOKEN`)

Pending items and `escalated` events gain `userId` when the `ESCALATED` entry has one (FR-045). Additive.

## Portal routes (`PORTAL_TOKEN`)

`:userId` must match `USER_ID_RE` (else 400). Every write runs inside the serialized section (FR-036, FR-040). All
bodies are JSON, at most 16 KB. No body carries free text: every string is an identifier, a host, an ISO date, or an
atomic amount.

| Method & path | Request | 200 response | Errors |
|---|---|---|---|
| `GET /v1/platform` | — | `PlatformView`: `{ platformId, digest, limits, sellers, network, asset, decimals }` | 401 |
| `GET /v1/users/:userId` | — | `UserView`. An unknown user: `registered: false`, empty lists | 400, 401 |
| `PUT /v1/users/:userId/registration` | `{ acknowledgedTestFunds: true }` | `UserView`. First call appends `USER_REGISTERED`; later calls append nothing | 400 (flag not `true`), 401 |
| `PUT /v1/users/:userId/wallet` | — | `UserView`. First call appends `WALLET_CREATED`; later calls append nothing and return the same address | 401, 409 `not_registered`, 409 `account_disabled` |
| `POST /v1/users/:userId/policies` | `PolicyValues & { identityConfirmedAtMs }` | 201 `PolicyView` (version 1), `POLICY_CREATED` | 401, 403 `step_up_required`, 409 `no_wallet`, 409 `account_disabled`, 422 `invalid_policy` |
| `GET /v1/users/:userId/policies/:policyId` | — | `PolicyView` with `history` | 401, 404 |
| `PUT /v1/users/:userId/policies/:policyId` | `PolicyValues & { expectedVersion, identityConfirmedAtMs? }` | `PolicyView`. New values: `POLICY_CHANGED`. Same values: nothing appended | 401, 403 `step_up_required` (loosening only), 404, 409 `version_conflict` (with the current `PolicyView`), 409 `policy_removed`, 409 `account_disabled`, 422 `invalid_policy` |
| `POST /v1/users/:userId/policies/:policyId/pause` | — | `PolicyView`, `POLICY_PAUSED` (cause `user`) unless already paused | 401, 404, 409 `policy_removed`, 409 `account_disabled` |
| `POST /v1/users/:userId/policies/:policyId/resume` | `{ identityConfirmedAtMs }` | `PolicyView`, `POLICY_RESUMED` unless already active | 401, 403 `step_up_required`, 404, 409 `policy_removed`, 409 `account_disabled`, 422 `invalid_policy` (`seller_conflict`, `seller_not_listed`, `policy_limit`) |
| `POST /v1/users/:userId/policies/:policyId/remove` | — | `PolicyView`, `POLICY_REMOVED` unless already removed | 401, 404, 409 `account_disabled` |
| `POST /v1/users/:userId/disable` | — | `UserView`, `USER_DISABLED` unless already disabled | 401, 409 `not_registered` |
| `POST /v1/users/:userId/enable` | `{ identityConfirmedAtMs }` | `UserView`; one `POLICY_PAUSED` (cause `account_enabled`) per active policy, then `USER_ENABLED`; nothing if already enabled | 401, 403 `step_up_required`, 409 `not_registered` |
| `PUT /v1/users/:userId/cards/:cardId` | — | `{ cards }`, `CARD_ADDED` unless already present | 400 (`cardId` not `^card_[0-9a-f-]{36}$`), 401, 409 `account_disabled`, 409 `card_limit`, 409 `not_registered` |
| `DELETE /v1/users/:userId/cards/:cardId` | — | `{ cards }`, `CARD_REMOVED` if present; allowed while disabled | 401 |

Notes:
- **Ownership (FR-004).** A `policyId` that exists for another user is 404, with the same body as an unknown one.
  The lookup goes through the path's user only; there is no route that reads a policy by ID alone. Test hook
  `skipOwnershipCheck` (a dep, never env) proves the check (T-USR-03 must-fail).
- **`PolicyValues`**: `sellers, autoApproveMaxAtomic, hardCapPerPaymentAtomic, sessionBudgetAtomic,
  dailyBudgetAtomic, maxAuthorizationsPerMinute, expiresAt, paymentMethod`. Unknown fields are a 400.
- **422 body**: `{ error: "invalid_policy", issues: [{ field, code, host?, policyId?, limitAtomic?, limit? }] }`
  with the codes of [data-model.md](../data-model.md#validation-of-a-policy-save-fr-026). All issues at once.
- **403 body**: `{ error: "step_up_required", maxAgeSec: 900 }`. Nothing is appended.
- **While the account is disabled** every policy write is refused with `account_disabled`, removal included
  (FR-038): nothing can pay anyway, and the user enables the account first. Removing a card stays allowed.
- **No route** creates a user by any other means, moves funds, exports a key, approves or rejects an escalation,
  or edits the platform config.

## What the agent never gets (FR-006)

- The hosted agent's tools stay `fetch_resource` and `check_budget`. Neither takes a user, a policy or a wallet as
  input; `userId` is set by the service from the verified requester.
- There is no `HttpAuthorizationGate` method for any portal route, and `CONTROL_TOKEN` is refused on all of them.
- `src/layer1-intent/**` never references `PORTAL_TOKEN` (T-ARCH-ENV, and rule A12 in
  [config-and-secrets.md](config-and-secrets.md)).

## Tests

| ID | Covers |
|---|---|
| T-API-01..04 | the OpenAPI document matches the table, the tokens and the new schemas |
| T-USR-01 | each route's happy path and every listed error; 401 before 400/404/409 |
| T-USR-02 | role isolation: `portal-control` on the other routes, the other four tokens on portal routes |
| T-USR-03 | ownership: user A's token path with user B's `policyId` is 404. **Must fail** with `skipOwnershipCheck` |
| T-USR-04 | idempotency: registration, wallet, card add/remove, pause, remove, an identical change |
| T-USR-05 | step-up: loosening needs a fresh `identityConfirmedAtMs`; tightening does not; boundary at 15 min + 60 s |
| T-USR-06 | off: with `USER_ACCOUNTS` unset every portal route is 404 and `userId` on an intent changes nothing |
