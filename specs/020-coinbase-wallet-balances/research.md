# Research: Connected Platforms in the L2 Portal: Coinbase Balances

Phase 0 of [plan.md](plan.md). Each section records one decision, why, and what was rejected. Nothing is left as
NEEDS CLARIFICATION. Coinbase's facts were read from its public documentation on 2026-11-25 (sources at the end);
the ones the documentation doesn't settle are marked **unverified** and have a check in
[quickstart.md](quickstart.md) §5. No account was made and nothing was sent to Coinbase.

Inputs: [spec.md](spec.md) with its three clarifications, SPEC.md v1.29.2, constitution v3.1.0, the code as of
`1afefea`.

## R0. A blocker outside the code: Coinbase isn't issuing OAuth clients

**Finding.** Coinbase's OAuth quickstart says that new OAuth client creation "is temporarily disabled", and its
overview that client creation "is currently limited to approved partners", reached through Coinbase's developer
interest form or a Coinbase representative. Coinbase's Developer Platform terms (§1.2) also make OAuth use
conditional on Coinbase's permission and on "the fees associated with OAuth".

**Decision.** Build and test slices 1–4 against the stand-in Coinbase (R13); they need no Coinbase client. Slice 5
(turning it on in dev) waits for a client issued to the project. Requesting one is the owner's step, not the code's:
it means applying through Coinbase's form, accepting its terms and its fees, and is listed as a prerequisite in
[quickstart.md](quickstart.md) §4.

**Consequence.** Until Coinbase issues a client, the feature can't be shown with a real Coinbase account anywhere.
There is no sandbox either (R13).

## R1. Where the code lives

**Decision.** Everything that talks to Coinbase or holds one of its credentials is in the portal, in a new folder
`src/portal/coinbase/`: `client.ts` (every call to Coinbase, the client secret), `grants.ts` (the sealed grant files,
the sealing key), and two pure files, `scopes.ts` and `balances.ts`. `src/portal/connections.ts` orchestrates them
with L2 (start, complete, balances, disconnect, reconcile). L2 only records identifiers (R9).

**Rationale.** The portal is already the process that holds people's outside credentials (the card vault, A10) and
the only public one that serves people. The grant must stay away from L2 (spec FR-023) and from the agent (FR-022).
A folder rather than one file keeps the credential code small and the pure logic testable without it, while rule A18
still names exactly two files that may hold a credential.

**Rejected.** L2 holding the grant: it would put a person's outside credential next to the signer, and Coinbase data
into the process whose ledger must stay free of personal data. A new process for connected platforms: a new unit,
image, vault and pipeline for four routes, with no isolation gain (it would still need the person's token, which
only the portal verifies).

## R2. The OAuth flow

**Decision.** Authorization code, in the same tab:
1. the web app calls `POST /api/connections/coinbase/start` with the person's token and gets Coinbase's authorize
   address with `response_type=code`, the client ID, `redirect_uri`, `scope`, `state` and the PKCE challenge;
2. it sets `window.location` to it; the person signs in and agrees at Coinbase;
3. Coinbase sends the browser to `COINBASE_REDIRECT_URI`, the portal's own `/wallet/coinbase` screen;
4. the web app (signed in again from session storage, where the Auth0 cache lives) takes `code` and `state` from the
   query, removes them from the address, and posts them to `complete` with the person's token;
5. the portal checks the state and exchanges the code (R3).

**Rationale.**
- The portal uses bearer tokens and no cookie (013), so a server-side callback route would not know who the person
  is. Letting the web app hand the code over with the person's token binds the completion to that person's
  verified sign-in, which is what FR-009 asks.
- The Auth0 sign-in survives a same-tab round trip: the SPA client's cache is `sessionStorage`
  (`web/portal/src/auth/auth0.ts`, `sessionCache`), which a navigation in the same tab keeps.
- `Referrer-Policy: no-referrer` is already sent, and the web app replaces the address at once, so the code doesn't
  stay in the history or leak in a referrer.

**Rejected.**
- A pop-up, as the Auth0 sign-in uses: Coinbase's pages are likely to send their own cross-origin isolation headers,
  which would cut the pop-up's `opener` (the portal sends COOP `same-origin-allow-popups`, but the opener is lost as
  soon as the pop-up visits a page that severs it). A `BroadcastChannel` could work around it but adds a second
  channel to test for no gain.
- A server callback with a cookie: a cookie would bring a CSRF surface the portal doesn't have today.

## R3. PKCE, state and the client secret

**Findings.** PKCE is supported and optional, with `S256` or `plain`, and defaults to `plain`; when a challenge is
sent, the token step requires the verifier. The client secret is required for the code exchange, for renewals and
for revocation, sent in the form body. `state` is optional but must be at least 8 characters when sent; Coinbase's
security guidance says to always send it. `redirect_uri` is required at the token step.

**Decision.**
- Always send `code_challenge_method=S256` (never rely on the `plain` default) with a 32-byte random verifier.
- `state` is 32 random bytes, base64url (43 characters), stored in memory with the person's user identifier, the
  sign-in time of the token that started it (its sign-in time claim, the portal's `identityConfirmedAtMs`), the
  verifier and the time ([data-model.md](data-model.md#pending-start-portal-memory)); single use, 10 minutes. A
  complete from another sign-in of the same person (after a sign-out and back) is refused like another person's.
- The client secret goes only in the body of the three token-endpoint calls, from `client.ts`.

**Rationale.** PKCE ties the code to the start even if the code leaks (the address bar, a log on a proxy); the
state ties it to the person and their sign-in; the secret ties it to the portal. Each covers a different capture (SEC-54). PKCE is
proven by a code-injection test with the must-fail switch `skipPkce` (T-CONN-03).

## R4. Scopes: the read-only allow-list

**Findings.** `wallet:accounts:read` lists a person's accounts and balances. A refresh token comes only with
`offline_access`. The person can untick scopes on Coinbase's consent page, and can also limit which accounts the
application sees. The token response returns the granted `scope` (space-separated in the examples). One example of a
renewal returns `"scope": "all"`. Scopes that move funds include `wallet:transactions:send`, `:transfer`, `:request`,
`wallet:buys:create`, `wallet:sells:create`, `wallet:trades:create`, `wallet:withdrawals:create`,
`wallet:deposits:create` and the `coinbase:stablecoins:*-create` family; and `wallet:transactions:read` is accepted by
one Advanced Trade endpoint that closes a position, so even a "read" scope can act.

**Decision.**
- Ask for exactly `wallet:accounts:read offline_access`. Not `wallet:user:read`: it returns the person's name and
  other profile data the portal doesn't show (FR-007, NFR-002), and the value currency is fixed (R7).
- An **allow-list**, never a deny-list: at the code exchange the granted set must equal the requested set.
  `all`, an unknown name, or any extra name is `too_wide`; a missing `wallet:accounts:read` or a missing refresh
  token (no `offline_access`) is `too_narrow`. Either way the grant is revoked before answering (FR-008).
- At a renewal, a listed scope outside the allow-list makes the connection `reconnect` and revokes it. The literal
  `all` on a renewal is accepted, because a renewal can't widen the original grant (RFC 6749 §6), and logged as
  `coinbase_scope_unverified` (**unverified**: confirm with Coinbase which value its renewals return; quickstart §5).
- The pure check is `scopes.ts`, with a table test of every case and the must-fail switch `skipScopeCheck`.
- The separator Coinbase expects on the authorize address is ambiguous in its pages (comma in the reference, `+` in
  an example); use a space (encoded `+`), the OAuth standard, and check it in quickstart §5 (**unverified**).
- Accounts the person didn't share on the consent page just don't appear: the wallet shows what Coinbase returns.

## R5. Keeping the grant

**Findings.** Access tokens last one hour. A refresh token lasts 1.5 years and can be used once: each renewal returns
a new one, the old one is invalidated, and Coinbase's payment-acceptance guide (same token endpoint) says that sending
an invalidated refresh token ends the link and to run one renewal at a time per customer. Coinbase advises storing
tokens encrypted, with the key in the environment.

**Decision.**
- One file per user under `CONNECTION_DIR`, written by `grants.ts` only, mode 0600, by temporary file and rename.
- The refresh token, with the granted scopes, is sealed with AES-256-GCM under `COINBASE_GRANT_KEY` (32 bytes), a
  random 12-byte IV per seal, and additional data `x402-grant-v1`, the user, the connection and the platform, so a
  sealed grant copied to another user's file or connection doesn't open (must-fail switch `skipGrantBinding`).
- Renewals are serialized per user in the portal (a promise chain keyed by user, as L2 serializes writes): the new
  refresh token is sealed and written **before** the new access token is used. A failed write after a successful
  renewal revokes the new grant and marks the connection `reconnect`, so there is never a live grant on disk that
  the file doesn't hold. The must-fail switch `unserializedRenewals` removes the chain: two concurrent reads then
  reuse a refresh token and the stand-in ends the link, as Coinbase does (T-CONN-09).
- The access token is kept in memory only, until 60 s before it expires.
- The portal runs one replica (`maxReplicas: 1`, already). Two replicas would race on renewals and end links; the
  plan records this as a residual risk, and rule 26 keeps the portal at one replica.
- The key is never rotated in place (the portal refuses to start when a grant file doesn't open with it). Rotating
  means: every user disconnects, or the operator deletes the folder and users reconnect.

**Rejected.** Key Vault secrets per user: the portal's identity would need to write secrets, a far wider permission,
and every read would be a network call. Keeping the refresh token in the browser: it would sit beside the page's
scripts, and Coinbase's client secret is needed to use it anyway.

## R6. Redirect addresses and local development

**Findings.** Redirect addresses must be registered with the client; a client may have several. Production
addresses must use TLS; addresses without TLS are allowed "for development and testing". Coinbase's own sample uses
`http://localhost:8000/callback`; `127.0.0.1` isn't mentioned. Exact matching isn't stated.

**Decision.**
- `COINBASE_REDIRECT_URI` is required and compared exactly; it must be `https://…/wallet/coinbase`, except
  `http://localhost:<port>/wallet/coinbase` with `NETWORK=local`.
- The dev deployment (the VPS) registers `https://dev.fabriciorojas.com/wallet/coinbase`; a local run registers
  `http://localhost:4025/wallet/coinbase` on the same client. `localhost` is a loopback name, so 017's local-only
  check accepts it.
- Tests never need a registration: the stand-in accepts whatever the test sets.

## R7. Balances and Coinbase's valuation

**Findings.**
- `GET https://api.coinbase.com/v2/accounts` lists accounts with `currency { code, name, exponent, type }` and
  `balance { amount, currency }`, the amount a decimal string; `type` is `wallet`, `fiat`, `vault` or `dex_wallet`
  (new values may come).
- Pagination is a cursor: `limit` up to 100, `pagination.next_uri` until it is empty.
- Self-custody accounts appear only with `fetch_all=true`.
- Zero balances are returned (a person has an account per supported currency).
- The current account resource has **no value in the person's currency**: the older `native_balance` is gone from
  the documentation. The person's currency is in `GET /v2/user` (scope `wallet:user:read`), and Coinbase's public
  `GET /v2/exchange-rates?currency=<code>` gives rates as decimal strings, with no authentication.
- 10,000 requests an hour per authorized person.
- `CB-VERSION` should be sent; without it a default version applies with a warning.

**Decision.**
- Read every page with `limit=100`, up to 10 pages (1,000 accounts), never `fetch_all`; drop `dex_wallet`, unknown
  types and zero amounts; list at most 200 funded assets, largest value first. More than 10 pages: the count in
  `more` is "at least", and the wallet says so.
- **Values are in US dollars, from Coinbase's own rates.** One call, `GET /v2/exchange-rates?currency=USD`, cached 60
  s for every user (it is public and the same for all). An asset's value is its amount divided by the rate Coinbase
  gives for its code, computed with scaled `BigInt` and rounded half-to-even to the cent; a missing or zero rate
  means no value (shown, and left out of the total). A USD account's value is its amount. The total is the exact sum
  of the rounded values shown.
- This refines the clarification "in the user's currency": the user picked the option labeled "Units + USD value",
  and USD avoids asking for `wallet:user:read`, which would bring the person's Coinbase profile (FR-007, NFR-002).
  Coinbase's documentation also describes the OAuth flow as primarily for US users. The spec is updated to say USD.
- `CB-VERSION` is a constant in `client.ts`, pinned when slice 3 starts (as the card vault pins Stripe's version),
  never the current date.
- Every figure is validated before use ([data-model.md](data-model.md#balances-portal-memory-20-s)); Coinbase's text
  (names, codes) is cut and rendered as text.

**Rejected.** `currency=<asset>` per asset (an exact multiplication, but up to 200 calls per read); asking for
`wallet:user:read` to follow the person's own currency (more personal data for a label); showing no value (the user
chose values).

## R8. Registering the client, and Coinbase's terms

**Findings.** Clients are made in Coinbase's developer portal under API Keys → OAuth, once Coinbase allows it (R0).
The terms require, before collecting end-user data, a privacy policy that is conspicuously displayed, describes
collection, use and sharing (including with Coinbase) and is at least as strict as Coinbase's; free, easily reached
support contact information; prompt notice to Coinbase of a breach involving end-user data; no Coinbase marks that
suggest endorsement; no users under 13; and data kept only for allowed purposes. People can remove an application's
access at `https://accounts.coinbase.com/security/connections`.

**Decision.**
- Two more settings, required with `CONNECTED_PLATFORMS=coinbase`: `PRIVACY_POLICY_URL` and `SUPPORT_URL` (absolute
  `https` addresses). The Coinbase part of the wallet links both before the person connects, and the start route
  refuses (503 `not_ready`) when either is missing. Writing the policy is the owner's step, not the code's
  (quickstart §4).
- The portal shows "Coinbase" as plain text and no Coinbase logo or button artwork.
- A breach of the grant store is a breach of end-user data: the plan's runbook line in quickstart §6 says to notify
  Coinbase, revoke every grant (delete the folder and rotate the client secret), and tell users.
- The disconnect message links Coinbase's connections page for removing the access there.

## R9. The audit trail in L2

**Decision.** Two new ledger entry types and two user-account routes, mirroring 013's cards
([contracts/control-api.md](contracts/control-api.md)). L2 enforces one active connection per platform (a `PUT` of a
new one replaces the old in the same serialized section) and never reuses an identifier. The portal reconciles its
file with L2's list on every wallet read; the write order makes every partial failure end with fewer connections.

**Rationale.** "Who connected what, and when" belongs in the record people trust (Constitution III), and putting the
replacement inside L2's serialized section makes the one-per-platform rule hold across two tabs. Identifiers only,
so no Coinbase data and no typed text reaches L2 (hard rule 11).

**Rejected.** Recording nothing in L2 (no audit of a credential the system holds for a person); recording in the
portal's own log only (not tamper-evident).

## R10. No new package

**Decision.** Global `fetch` (with `AbortSignal.timeout`), `node:crypto` (`randomBytes`, `createHash` for S256,
`createCipheriv('aes-256-gcm')`), `URLSearchParams` for form bodies. No Coinbase SDK: the official SDKs target API
keys and trading, and a dependency would widen the image's audit (T-IMG-02) for four HTTP calls. The image closure
(T-IMG-01) doesn't change.

## R11. Exact decimals

**Decision.** A new pure module, `src/shared/decimal.ts`: `parseDecimal` (the pattern in the data model, at most 30
digits on each side), `addDecimal`, `compareDecimal`, `divideRounded(amount, rate, places)` (half-to-even), all by
scaled `BigInt`. The web app formats decimal strings with `formatDecimal` (string operations only) in `money.ts`.
Tests T-DEC-01..03 cover parsing, addition and rounding, including 18-decimal amounts and very small rates.

**Rationale.** Constitution VI forbids floating-point money; the web app already fails T-WEB-03 on `Number(`.

## R12. Disabling an account, and the switch turned off

**Decision.** The portal's `POST /api/account/disable` disconnects after L2 records the disabling (FR-019); a failure
is finished by the reconcile. With `CONNECTED_PLATFORMS` turned off after users connected, the portal neither reads
nor renews grants; the wallet row shows `unavailable` and offers Disconnect, which then only forgets the grant and
records it at L2: a revocation needs the client secret, which may be gone, so the message says to remove the access
at Coinbase.

## R13. Testing

**Findings.** Coinbase has no sandbox for OAuth: testing needs real, verified Coinbase accounts.

**Decision.** Every automated test uses `test/helpers/coinbase-stub.ts`: an HTTP server on loopback that implements
the authorize redirect, the token endpoint (code, refresh with rotation and reuse detection), revoke (always 200, as
Coinbase), the accounts list with pagination, exchange rates, and scripted faults (timeouts, 5xx, 429, `invalid_grant`,
wider or narrower scopes, `all`). The portal's test deps take its base addresses; they are never configuration. Tests:
- T-CONN-01..12 (portal): the flow, each refusal, replace, reconcile, disconnect, disable, rate limits, the
  known-value scan (SC-004), two users (SC-006), and the identical-decisions check (SC-005), at L2 with no agent and
  no chain;
- T-USR-15..16 (L2): the entries, replace, reuse;
- T-DEC-01..03; T-WEB-17..21; T-ARCH-A18 with fixtures; T-IAC-01 rule 26; T-API-01..04 and 12..15;
- each must-fail switch ([contracts/portal-api.md](contracts/portal-api.md#must-fail-switches-test-only-deps-of-createportal-never-env-t-arch-switch))
  shown to fail its test.

The manual pass against a real Coinbase account is quickstart §5, once a client exists (R0).

## R14. Delivery in slices

As [plan.md](plan.md#delivery): SPEC and constitution first, then L2, the portal core, the web app, and delivery.
Slices 1–4 are complete and testable without Coinbase. Slice 5 starts only after R0 is resolved.

## R15. Revocation that Coinbase doesn't confirm

**Findings.** Coinbase's revoke endpoint answers 200 "for both successful and unsuccessful requests". Revoking an
access token also revokes its refresh token. An API call with a revoked token answers 401 `revoked_token`.

**Decision.** To disconnect, the portal gets a live access token (from memory, or by one renewal), revokes it, then
calls `GET /v2/accounts?limit=1` with it: a 401 confirms (`revokedAtPlatform: true`); anything else, or a network
failure, doesn't (`false`), and the person is told to remove the access at Coinbase's connections page. The grant is
removed from the file first in every case (FR-018). The same check runs for a refused grant at `complete`; a failed
check there is logged `coinbase_revoke_failed`. The must-fail switch `trustRevokeAnswer` takes the 200 as proof; T-CONN-12
shows that a stand-in answering 200 without revoking then reports a revocation that didn't happen.

## Sources (read 2026-11-25)

- Coinbase App OAuth2: overview, quickstart, reference, access and refresh tokens, scopes, integrations, security
  best practices, code samples — `https://docs.cdp.coinbase.com/coinbase-app/oauth2-integration/…`
- Accounts, exchange rates, pagination, rate limiting, versioning, error messages —
  `https://docs.cdp.coinbase.com/coinbase-app/track-apis/…` and `…/api-architecture/…`
- Advanced Trade REST scopes and OAuth access — `https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/…`
- Payment acceptance with Coinbase (refresh rotation and reuse) —
  `https://docs.cdp.coinbase.com/payments/payment-acceptance/pay-with-coinbase`
- Coinbase Developer Platform terms of service (last modified 2026-06-23) —
  `https://www.coinbase.com/legal/developer-platform/terms-of-service`

The documentation pages open with a banner addressed to AI readers about an index file; nothing in them was followed
beyond reading.
