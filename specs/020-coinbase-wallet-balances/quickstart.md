# Quickstart: validating connected platforms (Coinbase balances)

How to prove the feature works, slice by slice. §1–§3 need no Coinbase account and no Coinbase client; §4–§5 need
both, and Coinbase isn't issuing clients at the moment ([research R0](research.md#r0-a-blocker-outside-the-code-coinbase-isnt-issuing-oauth-clients)).

## 1. Offline validation (definition of done)

```bash
npm run typecheck
npm test                      # includes T-CONN-*, T-DEC-*, T-USR-15..16, T-ARCH-A18, T-API-01..04 and 12..15
npx vitest run web/portal     # T-WEB-17..21
BICEP_PATH=~/.azure/bin/bicep npx vitest run test/infra.test.ts   # T-IAC-01 rule 26
npm run demo:local            # unchanged: "spent on-chain: 0.006 USDC", "hash chain ok=true" (NFR-006)
```

| Check | Expect | Proves |
|---|---|---|
| `npx vitest run test/connections.test.ts` | green, including the rows that turn each must-fail switch on and expect the check's test to fail | FR-005, FR-008, FR-009, FR-010, NFR-001 |
| T-CONN-10 (two users, known-value scan) | 0 hits of the stand-in's grant, account values or token in the ledger, L2's request log, the portal's log, the agent's answers | SC-004, SC-006, FR-023 |
| T-CONN-11 (the same intents at L2 for a user with and without a connection; no agent, no chain) | identical decisions and budget answers | SC-005, FR-020 |
| T-DEC-01..03 | 18-decimal amounts, tiny rates, half-to-even at the cent, sums | FR-015, SC-002 |
| T-ARCH-A18 | each fixture under `test/fixtures/` fires its part of the rule | FR-025, FR-026, FR-022 |

## 2. The scenarios, as tests

There is no manual pass against the stand-in: it runs inside the tests only, and the portal never reads a Coinbase
address from its env. Each of the spec's scenarios has its test (T-CONN-01..12 in `test/connections.test.ts`, with
the stand-in scripted per case; T-WEB-17..21 for the screens):

| Scenario | Stand-in script | Expect | Test |
|---|---|---|---|
| US1 1–3: connect | grants `wallet:accounts:read offline_access` | "Connected on <date>", balances with a read time | T-CONN-01, T-WEB-17 |
| US1 4: cancel | answers `error=access_denied` | "Nothing was connected"; nothing kept | T-CONN-02, T-WEB-19 |
| FR-009: another person's, replayed or expired return | — | 400 `invalid_state`, nothing connected | T-CONN-03 |
| FR-008: wider (`… wallet:transactions:send`, `all`) or narrower (no refresh token) | as named | 400 `scope_refused`; the stand-in recorded the revocation | T-CONN-04 |
| US1 6, FR-010: connect twice | two grants | one connection; the first grant revoked; `CONNECTION_CLOSED cause: replaced` | T-CONN-05 |
| US2 2–3: figures | three funded assets (one with 18 decimals), one empty, a USD account, an asset with no rate | exact amounts, values to the cent, total = sum, empty absent, "Not counted" | T-CONN-08, T-DEC-*, T-WEB-18 |
| FR-014: refresh twice in 10 s | — | one read | T-CONN-08 |
| US2 5, FR-016: timeout, 5xx, 429 | as named | within 5 s, stale figures or `unreadable`; L2 account current | T-CONN-09, T-WEB-20 |
| US2 6, FR-017: revoked, `invalid_grant` on renewal, a reused refresh token | as named | `reconnect`, no figures, grant forgotten | T-CONN-09 |
| US4 1–2, FR-018: disconnect, with and without the check's 401 | as named | `revokedAtPlatform` true / false, grant gone in both | T-CONN-12, T-WEB-21 |
| FR-019: disable the account | — | disconnected; L2 shows it | T-CONN-12 |
| Reconcile, every row | L2 or the file fails mid-way | fewer connections, never a grant L2 doesn't show | T-CONN-12 |
| US5: off, missing settings, rotated key | — | 404 routes; startup refusals naming the variable | T-PRT-20, T-PRT-21 |

## 3. Isolation checks

- As bob, call `GET /api/connections/coinbase/balances` with alice connected: 404 `not_connected` (FR-005).
- Complete with alice's `state` while signed in as bob: 400 `invalid_state` (FR-009).
- Copy alice's grant file over bob's: the portal refuses to open it (the grant's additional data), bob's wallet shows
  `reconnect` (T-CONN-06).
- `grep -ri coinbase` over the agent's run log and L2's request log after a run: nothing but L2's two route
  templates.

## 4. Turning it on in dev (needs a Coinbase client)

Prerequisites, all the owner's (research R0, R8):
1. Coinbase approves the project for OAuth (its developer interest form) and the owner accepts Coinbase's terms
   and its OAuth fees.
2. A privacy policy and a support contact are published (Coinbase's terms §10), at `https` addresses.
3. In Coinbase's developer portal (API Keys → OAuth), a client with the redirects
   `https://dev.fabriciorojas.com/wallet/return` and `http://localhost:4025/wallet/return`.

Then, on the VPS (`docs/self-hosted/README.md`):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"   # COINBASE_GRANT_KEY, once
```

Put `CONNECTED_PLATFORMS=coinbase`, the client ID, the two secrets, the redirect and the two addresses in the
portal's env file (mode 0600), restart the portal, and back the grant key up where the payer key is backed up (a lost
key means every user reconnects). For Azure: seed `coinbase-client-secret` and `coinbase-grant-key` in the portal
vault (`off` first, real values when turning on), set `userAccounts.coinbase` in `infra/main.dev.bicepparam`, and
deploy the portal unit.

## 5. Manual pass against Coinbase (once per client, with a real, verified Coinbase account)

Coinbase has no sandbox for this. Use the owner's own account; nothing moves, but the account is real. Locally, run
the stack with user accounts (`npm run stack:local -- --users`), a portal token (`npm run -s dev-token -- --subject
alice --portal`), `npm run build:web`, and `npm run portal` with the §4 settings and
`COINBASE_REDIRECT_URI=http://localhost:4025/wallet/return`; open `http://localhost:4025`. Or use the VPS.

| Check | Expect | Settles |
|---|---|---|
| Connect; read the consent page | it lists reading accounts (and the refresh), nothing else | FR-007 |
| The token response's `scope` at the exchange | exactly `wallet:accounts:read offline_access` (log line `coinbase_connected`, no scope logged: inspect with the stand-in's recorder off and a debugger) | research R4 separator and scope format (**unverified**) |
| Wait an hour; refresh the balances | a renewal; the log has no `coinbase_scope_unverified`, or it has it and the format is noted here | research R4 `all` on renewals (**unverified**) |
| Untick "offline access" at the consent page, if offered | refused `too_narrow` | FR-008 |
| Compare with Coinbase's own app | same funded assets and amounts; values within a cent of Coinbase's own display at that moment | SC-002 |
| Remove the access at `https://accounts.coinbase.com/security/connections`; refresh | `reconnect` | FR-017 |
| Disconnect | `revokedAtPlatform: true`; the app is gone from Coinbase's connections page | FR-018, research R15 |

Record the results in the validation log below, with the date.

## 6. If the grant store leaks

Coinbase's terms ask for prompt notice of a breach of end-user data (research R8). The response: set
`CONNECTED_PLATFORMS` off and restart (no more reads); rotate the client secret in Coinbase's developer portal
(every grant made with it stops working at the next renewal); delete the `CONNECTION_DIR` folder; notify Coinbase;
tell the users who had connected (the ledger's `CONNECTION_OPENED` entries without a later disconnect say who).

## Validation log

| Date | Section | Result |
|---|---|---|
| 2026-11-25 | §1 | `npm run check` green: typecheck, 86 test files (2,257 passed, 2 skipped), `demo:local` unchanged (`spent on-chain: 0.006 USDC`, `hash chain ok=true`). `npm run build` and `npm run build:web` green. |
| 2026-11-25 | §1 must-fail | Each of the eight switches has a test in `test/connections.test.ts` that turns it on and shows the damage the check prevents: `skipStateCheck` (Bob completes Alice's start), `skipPkce` (Bob connected to Alice's captured grant), `skipScopeCheck` (a send-capable grant kept), `skipReplaceRevoke` (the replaced grant still reads), `skipGrantBinding` (Bob reads Alice's copied grant), `skipConnectionOwner` (Bob gets Alice's figures), `unserializedRenewals` (a reused refresh token ends the link), `trustRevokeAnswer` (reported revoked while it still reads). The matching tests without the switch pass. |
| 2026-11-25 | §1 OpenAPI | T-API-01..04 and T-API-12..15 green: both documents equal the mounted routes, and a scenario reaches every documented status of the new routes. |
| — | §4, §5 | Not run: Coinbase isn't issuing OAuth clients (research R0). |
