# Contract: L2-5 delta (control API): connection events

Normative for the SPEC L2-5 table, L2-4's entry types and `docs/l2-control.openapi.yaml`; T-API-01..04 fail until all
three match the service. The two routes below follow the card routes of
[specs/013 contracts/control-api.md](../../013-l2-portal-onboarding/contracts/control-api.md) exactly: they exist only
with user accounts on (`USER_ACCOUNTS=1`), take `PORTAL_TOKEN` and the person's own token in `X-Person-Authorization`
(1.19: the path's `userId` must be the token's user, else 403 `person_mismatch`), go through the person limit, and
write inside L2's serialized section.

L2 learns **identifiers only**: the portal's own `connectionId` and a platform name from a fixed list. It never sees a
grant, a Coinbase account identifier, a balance, a name or an email (spec FR-023), and nothing here is read by a
payment decision, a budget, an approval or a reconciliation (FR-020). In `src/shared/contracts.ts` only `UserView`
changes: it gains `connections` (below), with the new `UserConnectionView` and `ConnectedPlatform`. `PaymentIntent`,
`AuthorizationDecision` and `BudgetStatus` don't move, and `check_budget`'s answer is the same (FR-022).

## Identifiers

| Name | Pattern | Made by |
|---|---|---|
| `connectionId` | `^conn_[0-9a-f-]{36}$` (`conn_` + a random UUID) | the portal, once per connection; a reconnect makes a new one |
| `platform` | `coinbase` (the only value; a fixed list in `users.ts`) | the portal |

## Routes

| Route | Body | Success | Refusals |
|---|---|---|---|
| `PUT /v1/users/:userId/connections/:connectionId` | `{ "platform": "coinbase" }` (no other key) | 200 `{ connections, replaced? }`. Appends `CONNECTION_OPENED` unless this `connectionId` is already active. When another connection of the same platform is active, first appends `CONNECTION_CLOSED` for it with `cause: "replaced"` and names it in `replaced`, in the same serialized section | 400 `invalid connectionId`, 400 `invalid platform`, 400 unknown key, 401, 403 `person_mismatch`, 409 `not_registered`, 409 `account_disabled`, 409 `connection_reused` (this `connectionId` was disconnected before: an identifier is never reused) |
| `DELETE /v1/users/:userId/connections/:connectionId` | none | 200 `{ connections }`. Appends `CONNECTION_CLOSED` if the connection is active; nothing otherwise. Allowed while the account is disabled | 400 `invalid connectionId`, 401, 403 `person_mismatch` |

`connections` is the user's active connections, `[{ "connectionId": "conn_…", "platform": "coinbase" }]`, at most one
per platform after every successful call.

## User view

`GET /v1/users/:userId` (013) gains one field, derived by `userState` in `users.ts` from the ledger like `cards`:

```json
{ "connections": [{ "connectionId": "conn_…", "platform": "coinbase", "connectedAt": "2026-11-25T14:02:11.000Z" }] }
```

`connectedAt` is the ISO time (`ts`) of the connection's `CONNECTION_OPENED` entry. In `src/shared/contracts.ts`
(SPEC §7): `type ConnectedPlatform = "coinbase"`, `interface UserConnectionView { connectionId: string; platform:
ConnectedPlatform; connectedAt: string }`, and `UserView.connections: UserConnectionView[]`.

The portal reconciles its own grant store against this list on every wallet read
([portal-api.md](portal-api.md#reconcile)). The administration routes (`/v1/admin/*`, 014) never return it.

## Ledger entries (L2-4)

Named `CONNECTION_*`, not `PLATFORM_*`: `PLATFORM_CONFIG`, the platform account and the platform limits already name
the deployment's own configuration and payer (013).

| Type | `data` | Written by |
|---|---|---|
| `CONNECTION_OPENED` | `{ userId, connectionId, platform }` | `PUT …/connections/:connectionId` |
| `CONNECTION_CLOSED` | `{ userId, connectionId, platform, cause? }`; `cause` is `"replaced"` or absent | `PUT` (the replaced one) and `DELETE` |

Both are new entry types (hard rule 6): no existing entry changes, and the hash chain, its MAC (1.19) and the head
(1.23) cover them as any other. `npm run ledger-verify` needs no change.

## Order of checks

As the card routes: `requireRole` (`PORTAL_TOKEN`), the person limit, the person's token (`person.ts`), the path's
`userId` against the token's user, the body parser (bounded, 1.18), then the identifier and body checks, then the
serialized write with the account checks (`not_registered`, `account_disabled`).

## Must-fail switches

None on L2. The checks that matter for this feature (ownership, binding, scope, no data at L2) live in the portal; L2's
existing person and ownership checks (`skipPersonCheck`, `skipOwnershipCheck`) already cover these routes, and their
tests gain one row each for them.
