# Contract: the portal API delta (browser → portal): connected platforms

Normative for SPEC L2-8, `docs/portal.openapi.yaml` and the web app's `web/portal/src/api.ts`; T-API-12..15 fail until
they match the service. Everything in [specs/013 contracts/portal-api.md](../../013-l2-portal-onboarding/contracts/portal-api.md)
and the 017 edge rules still holds: a bearer token on every route (no cookie, so no CSRF surface), the per-address and
failed-authentication limits before the token, the token's checks, and no route that takes a user identifier. The
user is always the verified token's.

With connected platforms off (`CONNECTED_PLATFORMS` unset, FR-001) `start`, `complete` and `balances` answer 404
`{ "error": "not found" }` (the same as an unknown route), and `/api/config` doesn't change. One exception, for a user
whose grant file still holds a connection (they connected before the integration was switched off, US5 scenario 4):
`GET /api/wallet` shows their row as `unavailable`, and `DELETE /api/connections/coinbase` forgets the stored
connection and records it at L2, answering `revokedAtPlatform: false` (there is no client secret to revoke with). For
anyone else `GET /api/wallet` has `connections: []` and `DELETE` answers 404 `{ "error": "not found" }`. Nothing here
reaches Coinbase while off.

## Who may use them (FR-002)

The person's L2 user view (013) decides, read in the same request:

| User view | Answer |
|---|---|
| not registered (no profile) | 409 `{ "error": "profile_required" }`, as `GET /api/wallet` answers (L2's own routes say `not_registered`) |
| `enabled: false` | 409 `{ "error": "account_disabled" }` (`DELETE` is still allowed, FR-019) |
| registered, enabled | the route runs |

## `GET /api/wallet` (013, one additive field)

```json
{
  "connections": [
    { "platform": "coinbase", "status": "not_connected" }
  ]
}
```

One row per platform the deployment offers (only `coinbase`). `status` is `not_connected`, `connected` (with
`connectedAt`), `reconnect` (FR-017) or `unavailable` (the integration is switched off and this user still has a
stored connection, US5 scenario 4; with it off and nothing stored, `connections` is `[]`). Every row also carries `privacyPolicyUrl` and `supportUrl` (FR-030),
the two settings of [config-and-secrets.md](config-and-secrets.md). The wallet's answer never waits for Coinbase: balances come from their own
route, so a slow Coinbase never slows the wallet (FR-016). It reconciles (below): the L2 side of a reconcile is part
of the request, and a revocation it needs runs after the answer is sent.

## `POST /api/connections/coinbase/start`

No body. Makes a pending start ([data-model.md](../data-model.md#pending-start-portal-memory)) and answers:

```json
{ "authorizeUrl": "https://login.coinbase.com/oauth2/auth?response_type=code&client_id=…&redirect_uri=…&scope=wallet%3Aaccounts%3Aread+offline_access&state=…&code_challenge=…&code_challenge_method=S256" }
```

(the call itself is [coinbase.md](coinbase.md#1-authorize-browser) §1).

The web app sets `window.location` to it (a same-tab navigation; the sign-in survives in session storage, research
R2). The address and the scope list are constants of `src/portal/coinbase/client.ts`, never configuration, except
the client ID and the redirect address ([config-and-secrets.md](config-and-secrets.md)).

## The return screen: `/wallet/return`

Coinbase sends the browser to `COINBASE_REDIRECT_URI`, which is the portal's own `/wallet/return` screen (a new row
in `src/shared/portal-screens.ts` and `web/portal/src/routes.ts`, T-WEB-14). The page is the web app; the portal reads
no query there. The web app:
1. reads `code`, `state` and `error` from the query once, then replaces the address with `/wallet/return`
   (`history.replaceState`), so the code leaves the address bar and the history (`Referrer-Policy: no-referrer` is
   already sent);
2. with `error` (the person cancelled or refused at Coinbase), shows "Nothing was connected" and a link back to the
   wallet, and calls nothing (US1 scenario 4); the pending start expires on its own;
3. otherwise posts them to `complete` with the person's token, then shows the wallet.

## `POST /api/connections/coinbase/complete`

```json
{ "code": "<from the query>", "state": "<from the query>" }
```

Both strings, 1–512 characters, no other key (400 `invalid_request` otherwise). In this order:

| Step | Failure |
|---|---|
| `state` names a pending start, made less than 10 minutes ago, by the user and the sign-in time of this token (its sign-in time claim, the portal's `identityConfirmedAtMs`); the start is deleted now whatever follows (single use) | 400 `{ "error": "invalid_state" }`, the same for unknown, expired, used, another person's and another sign-in's (after a sign-out and back) (FR-009). Log `coinbase_state_refused` |
| the account checks above | 409 as above |
| exchange `code` with the start's PKCE verifier and the client secret | 502 `{ "error": "platform_unavailable" }` (timeout 5 s, a 5xx) or 400 `invalid_state` (Coinbase refused the code: used, expired, or not this redirect) |
| the granted scopes, as Coinbase reports them, are exactly the allow-list, and a refresh token came back (research R4) | 400 `{ "error": "scope_refused", "reason": "too_wide" \| "too_narrow" }`; the grant is revoked at Coinbase first, and checked (R15) (FR-008). Log `coinbase_scope_refused` |
| seal the grant and write it as `connected` under a new `connectionId` | 503 `{ "error": "unavailable" }`; the grant is revoked |
| L2 `PUT /v1/users/:userId/connections/:connectionId` (replacing any older one, FR-010) | 502 `{ "error": "control_unavailable" }` when L2 can't be reached; the grant is revoked and the file entry removed first |
| if L2 named a `replaced` connection: revoke its grant at Coinbase and remove it from the file | never fails the request; a failed revocation logs `coinbase_revoke_failed` |

Success: 200 `{ "platform": "coinbase", "status": "connected", "connectedAt": "…" }`. Log `coinbase_connected` (and
`coinbase_replaced`).

## `GET /api/connections/coinbase/balances`

Query: optional `fresh=1`. Answer 200 with [`PlatformBalances`](../data-model.md#balances-portal-memory-20-s), or:

| Case | Answer |
|---|---|
| no connection | 404 `{ "error": "not_connected" }` |
| `reconnect` status, or Coinbase refuses the grant now | 200 `{ "status": "reconnect" }` and no figures; the file entry turns `reconnect` and loses its grant; log `coinbase_reconnect_needed` (FR-017) |
| Coinbase fails or takes more than 4 s, with figures read before | 200 with those figures, `stale: true`; log `coinbase_unavailable` |
| the same, never read | 200 `{ "status": "unreadable" }` |
| Coinbase rate-limits | as a failure, and no read of that user for 60 s; log `coinbase_rate_limited` |

Without `fresh=1`, figures under 20 s old come from memory. `fresh=1` reads again unless the last read of this user
started less than 10 s ago (then it answers the last figures, FR-014). The whole answer takes at most 5 s (FR-016,
SC-009). Reads for one user are serialized with that user's refreshes, so a rotating refresh token is never used
twice (research R5).

## `DELETE /api/connections/coinbase`

No body. Allowed while the account is disabled. In this order (FR-018): take the grant out of the file (so nothing
can read with it any more, keeping it in memory for the next step), revoke it at Coinbase and check the revocation
(research R15: Coinbase's revoke answers 200 whatever happens, so the portal calls the accounts list with the revoked
access token and only a 401 confirms; 5 s in all), then L2 `DELETE …/connections/:connectionId`.

Success: 200 `{ "revokedAtPlatform": true | false }`. `false` means the check didn't confirm (or the integration is
switched off, so there is no client secret to revoke with); the web app then links Coinbase's own connections page. An L2 failure still answers 200: the next wallet read reconciles. Log
`coinbase_disconnected` (and `coinbase_revoke_failed`).

## `POST /api/account/disable` (013, one more step)

After L2 records the disabling, the portal disconnects every connection as `DELETE` does (FR-019). A failure there
never fails the disabling: the reconcile finishes it.

## Reconcile

On every `GET /api/wallet`, the portal compares its file with the user view's `connections` (L2 is the record of what
happened, the file of what can still read):

| File | L2 | Action |
|---|---|---|
| connected or reconnect | active | none |
| connected or reconnect | not active | remove the entry now (fewer, never more), answer, then revoke the grant and check it in the background, serialized with the user's other calls; log `coinbase_reconciled` |
| absent | active | L2 `DELETE` (the grant is already gone); log `coinbase_reconciled` |

So every partial failure ends with fewer connections, never with a grant that the ledger doesn't show.

## Before a start: the deployment's obligations (FR-030)

`start` answers 503 `{ "error": "not_ready" }` when `PRIVACY_POLICY_URL` or `SUPPORT_URL` is missing. The portal
refuses to start in that case anyway ([config-and-secrets.md](config-and-secrets.md)); this is the second check.

## Limits

The existing per-address and failed-authentication limits apply. Also, per user: 10 starts a minute (429
`{ "error": "too many requests" }` with `Retry-After`).

## Must-fail switches (test-only deps in `PortalDeps` of `createPortalApp`, never env; T-ARCH-SWITCH)

| Switch | Turns off | Test that must fail with it on |
|---|---|---|
| `skipStateCheck` | the state's owner, sign-in, age and single-use checks | T-CONN-03 |
| `skipPkce` | the PKCE challenge at `start` and the verifier at the exchange | T-CONN-03 (code injection) |
| `skipScopeCheck` | the scope allow-list | T-CONN-04 |
| `skipGrantBinding` | the sealed grant's additional data (user, connection, platform) | T-CONN-06 |
| `skipConnectionOwner` | taking the connection from the token's user's own file | T-CONN-07 |
| `skipReplaceRevoke` | revoking the replaced grant | T-CONN-05 |
| `unserializedRenewals` | the per-user chain around renewals and reads (research R5) | T-CONN-09 |
| `trustRevokeAnswer` | the revocation check: the revoke call's 200 is taken as proof (research R15) | T-CONN-12 |
