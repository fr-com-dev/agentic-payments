# Contract: every call the portal makes to Coinbase

The portal makes exactly the calls below, all from `src/portal/coinbase/client.ts` (rule A18), over HTTPS with TLS
verification on, each with `AbortSignal.timeout`. No other process calls Coinbase. The stand-in
(`test/helpers/coinbase-stub.ts`) implements the same six, and the tests check that the portal calls nothing else.
Facts are from Coinbase's documentation read on 2026-11-25 ([research.md](../research.md), sources at its end);
**unverified** items have a check in [quickstart.md](../quickstart.md) §5.

Constants in `client.ts` (never configuration): the two hosts, the paths, the scope list, `CB-VERSION` (pinned at
slice 3) and the timeouts. Configuration: the client ID, the client secret and the redirect address only.

Nothing about the person (their portal identity, name, email, policies, the L2 account) is ever sent to Coinbase.
Coinbase learns what any OAuth client's calls show: that this application reads this account.

## 1. Authorize (browser)

`GET https://login.coinbase.com/oauth2/auth`, built by the portal and opened by the browser:

| Parameter | Value |
|---|---|
| `response_type` | `code` |
| `client_id` | `COINBASE_CLIENT_ID` |
| `redirect_uri` | `COINBASE_REDIRECT_URI` |
| `scope` | `wallet:accounts:read offline_access` (space, encoded `+`; the separator is **unverified**, research R4) |
| `state` | 43 characters, base64url of 32 random bytes |
| `code_challenge` | base64url(SHA-256(verifier)), no padding |
| `code_challenge_method` | `S256`, always (Coinbase defaults to `plain` without it) |

Back at `redirect_uri` with `code` and `state`, or `error` (and `error_description`, which is never shown or logged).

## 2. Exchange the code

`POST https://login.coinbase.com/oauth2/token`, `application/x-www-form-urlencoded`, timeout 5 s:
`grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`, `code_verifier`.

| Answer | Portal |
|---|---|
| 200 `{ access_token, refresh_token, expires_in, scope, token_type }` | scope check (research R4); seal the refresh token; keep the access token in memory |
| 400/401 OAuth error (`invalid_grant`, `invalid_request`, …) | `invalid_state` to the browser (the code is spent, expired or not this redirect) |
| other, or timeout | `platform_unavailable` |

## 3. Renew

`POST https://login.coinbase.com/oauth2/token`: `grant_type=refresh_token`, `refresh_token`, `client_id`,
`client_secret`. Timeout 5 s. **One at a time per user** (research R5): a renewal starts only after the previous
one's new refresh token is sealed and written.

| Answer | Portal |
|---|---|
| 200 with a new `refresh_token` | seal and write it first, then use the access token; a listed scope outside the allow-list → revoke, `reconnect`; `all` → accept, log `coinbase_scope_unverified` |
| 200 without a `refresh_token` | keep the old one (**unverified** whether Coinbase ever does this; logged) |
| 400/401 `invalid_grant` (revoked, expired, reused) | `reconnect`; forget the grant (FR-017) |
| other, or timeout | the read fails: stale figures (FR-016); the grant is kept |

## 4. Revoke

`POST https://login.coinbase.com/oauth2/revoke`: `token=<access token>`, `client_id`, `client_secret`, with
`Authorization: Bearer <access token>`. Timeout 3 s. Revoking the access token also revokes its refresh token.
Coinbase answers 200 whether or not it worked, so the answer proves nothing; the check is call 5 with the same
token, expecting 401 (research R15).

## 5. List accounts

`GET https://api.coinbase.com/v2/accounts?limit=100[&starting_after=<id>]`, `Authorization: Bearer <access token>`,
`CB-VERSION: <pinned>`. Never `fetch_all`. Follow `pagination.next_uri` (only if it is a path on the same host) until
it is empty, at most 10 pages, 4 s for all of them.

Fields read per account (anything else is ignored): `type`, `currency.code`, `currency.name`, `balance.amount`,
`balance.currency`. Not read, not kept: `id`, `name` (the person's own label), `resource_path`, timestamps.

| Answer | Portal |
|---|---|
| 200 | [the validation rules](../data-model.md#balances-portal-memory-20-s) |
| 401 (`expired_token`) | renew once (call 3), then retry once |
| 401 (`revoked_token`, `invalid_token`) | `reconnect` |
| 403 `invalid_scope` | `reconnect` (the person narrowed the grant at Coinbase) |
| 429 `rate_limit_exceeded` | stale figures; no read of that user for 60 s |
| other, or timeout | stale figures |

As the revocation check (call 4): `?limit=1`, timeout 2 s, and only a 401 counts as confirmed.

## 6. Exchange rates (public)

`GET https://api.coinbase.com/v2/exchange-rates?currency=USD`, no `Authorization` header, timeout 3 s. Cached 60 s
for every user. `data.rates` maps a code to how many units of it one US dollar buys, as a decimal string. When the
call fails and the cached rates are older than 60 s, that read has no values and no total (every code goes in
`leftOutOfTotal`); the amounts still show. Rates are never older than the figures they value by more than 60 s.

## Never

- a call that sends, buys, sells, trades, converts, withdraws or deposits; any `POST` to `api.coinbase.com`;
- `GET /v2/user` or any profile call (no `wallet:user:read`);
- following a redirect (`redirect: "error"`), or a `next_uri` to another host;
- putting Coinbase's `error_description`, `message` or any response text into a log line or an answer to the
  browser: only the fixed event labels of the data model.
