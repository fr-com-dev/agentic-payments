---

description: "Task list for 020: connected platforms in the L2 portal, Coinbase balances"
---

# Tasks: Connected Platforms in the L2 Portal: Coinbase Balances

**Input**: Design documents from `specs/020-coinbase-wallet-balances/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md) (US1–US5, FR-001..FR-030)
- [research.md](research.md) (R0–R15)
- [data-model.md](data-model.md)
- [contracts/](contracts/): portal-api, portal-ui, control-api, coinbase, config-and-secrets
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII and the spec's NFR-001 require a test for every route,
field, status and rule, and a proof that each must-fail switch's test fails with the switch on.
- **Test IDs.** Each test title carries its ID: T-CONN-01..12, T-USR-15..16, T-DEC-01..03, T-WEB-17..21,
  T-PRT-20..21, T-ARCH-A18, T-IAC-01 rule 26; amended: T-API-01..04, T-API-12..15, T-WEB-14, T-AGT-KEY, T-ARCH-SWITCH.
- **Order.** Write each story's tests first and confirm they fail before implementing.
- **Switches.** `skipStateCheck`, `skipPkce`, `skipScopeCheck`, `skipGrantBinding`, `skipConnectionOwner`, `skipReplaceRevoke`, `unserializedRenewals`, `trustRevokeAnswer`
  are test-only deps in `PortalDeps` (`src/portal/server.ts`), never environment variables.
- **No real Coinbase.** Every test uses `test/helpers/coinbase-stub.ts` (NFR-005). Never print a grant, a refresh or
  access token, a code or a `state` value, in a test, a log line or a command.
- **Not edited.** `src/layer2-control/policy.ts`, `signer.ts`, `ledger-key.ts`, `approval-routes.ts`,
  `admin-routes.ts`, `src/shared/contracts.ts`, `src/layer1-intent/` (FR-020, FR-022).

**Organization**: tasks are grouped by user story (US1–US5 from spec.md), in priority order. US1 to US3 are P1 and
form the MVP; US4 is P2; US5 is P3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task belongs to (US1–US5)

## Path Conventions

Repository root. Source in `src/`, the web app in `web/portal/`, tests in `test/` and `web/portal/test/`, Azure
templates in `infra/`, OpenAPI documents in `docs/`, env templates in `env/`.

---

## Phase 1: Setup

**Purpose**: Amend the normative documents before code (Governance: SPEC and the constitution change together).

- [X] T001 Confirm on `main` that the IDs this feature uses are still free (SPEC 1.30, SEC-55..58, T-CONN-*, T-DEC-*, T-USR-15..16, T-WEB-17..21, T-PRT-20..21, rule A18, T-IAC-01 rule 26). If another merged feature took any, move this feature's to the next free ones in every file of `specs/020-coinbase-wallet-balances/`, this one included, before T002
- [X] T002 Amend `SPEC.md` to 1.30 per plan.md "Delivery" slice 1: a "Changes in 1.30" section; §1.3 (a person's own Coinbase balances, read only, in scope; moving funds and any other platform out); L2-8 connected platforms (the wallet's two parts, the four portal routes, the return screen `/wallet/coinbase`, the switch, the refusals, FR-030's links); L2-4 entry types `CONNECTION_OPENED` `{ userId, connectionId, platform }` and `CONNECTION_CLOSED` `{ userId, connectionId, platform, cause? }`; L2-5 rows for `PUT` and `DELETE /v1/users/:userId/connections/:connectionId` and the user view's `connections`; §3.3 the three new credential rows of contracts/config-and-secrets.md; §4.1 rule A18; CFG-2 the seven `portal.env` variables; §11 SEC-55 (a captured or forged return from Coinbase), SEC-56 (a grant wider than read), SEC-57 (a grant or Coinbase data exposed outside the portal), SEC-58 (one user reading another's connection), SEC-59 (a rotating refresh token used twice); §12 the test IDs above. Commit it together with T003
- [X] T003 [P] Amend `.specify/memory/constitution.md` to 3.2.0 (MINOR) exactly as plan.md "Constitution amendment": Technology & Scope, a Principle V bullet for the Coinbase client secret, each person's read-only grant and the sealing key, and the residual risks; a Sync Impact Report naming SPEC 1.30. Same commit as T002
- [X] T004 [P] Add row 020 to `specs/README.md` (layer: portal + L2; functional scope L2-8 connected platforms, L2-4/L2-5 connection events; non-functional SEC-55..58, rule A18, Constitution 3.2.0) and its traceability rows

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: L2's audit trail, the portal's settings, the grant store and the stand-in Coinbase: every story needs
them.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests for the foundation (write first, confirm they fail)

- [X] T005 [P] Add T-USR-15 to `test/users.test.ts`: with user accounts on, `PUT /v1/users/:userId/connections/:connectionId` with body `{ "platform": "coinbase" }` appends `CONNECTION_OPENED`, returns `{ connections: [{ connectionId, platform }] }`, is idempotent for the same active `connectionId`; a second `PUT` with another `connectionId` appends `CONNECTION_CLOSED` with `cause: "replaced"` for the first in the same serialized section and returns `replaced`; `DELETE` appends `CONNECTION_CLOSED` once and nothing when not active. Use the helpers in `test/helpers/users.ts` (`l2.portal()` forwards the person's token)
- [X] T006 Add T-USR-16 to `test/users.test.ts`: refusals 400 `invalid connectionId` (anything not matching `^conn_[0-9a-f-]{36}$`), 400 `invalid platform` (anything but `coinbase`), 400 on an unknown body key, 403 `person_mismatch`, 409 `not_registered`, 409 `account_disabled` on `PUT` (while `DELETE` still works), 409 `connection_reused` for a `connectionId` disconnected before; the user view's `connections` carries `connectedAt` (the ISO time of the entry); `GET /v1/admin/*` answers never contain `connections`; `npm run ledger-verify`'s check still passes with the new entries
- [X] T007 [P] Add T-PRT-21 to `test/portal.test.ts`: with `CONNECTED_PLATFORMS=coinbase`, the portal's config refuses to load, naming the variable and never its value, when `COINBASE_CLIENT_ID`, `COINBASE_CLIENT_SECRET`, `COINBASE_GRANT_KEY` (not exactly 32 bytes of base64, or `off`), `COINBASE_REDIRECT_URI` (not `https://…/wallet/coinbase` with no query or fragment; `http://localhost:<port>/wallet/coinbase` accepted only with `NETWORK=local`), `PRIVACY_POLICY_URL` (not absolute `https`) or `SUPPORT_URL` (not absolute `https` or `mailto:`) is wrong; when `CONNECTION_DIR` is inside `PROFILE_DIR` or the web root; when a grant file in `CONNECTION_DIR` doesn't open with the key (`connection grants don't open with COINBASE_GRANT_KEY`); and refuses any `CONNECTED_PLATFORMS` value but `coinbase` or empty
- [X] T008 [P] Add the sealing tests to `test/connections.test.ts` (new file, under `describe("020 grant store")`): a sealed grant round-trips; a new IV per seal; a grant moved to another user's file, another `connectionId` or another platform fails to open (the additional data `x402-grant-v1\n<userId>\n<connectionId>\n<platform>`); files are mode 0600 and written by temporary file and rename; the file never contains the refresh token in clear (scan for the stand-in's known value)

### Implementation for the foundation

- [X] T009 Add `CONNECTION_OPENED` and `CONNECTION_CLOSED` to the entry type union in `src/layer2-control/ledger.ts` (new entry types only; no existing entry changes, hard rule 6)
- [X] T010 Derive `connections: { connectionId, platform: "coinbase", connectedAtMs }[]` (at most one per platform) and `seenConnectionIds` in `userState` in `src/layer2-control/users.ts`, and add the fixed platform list `["coinbase"]` and `CONNECTION_ID_RE = /^conn_[0-9a-f-]{36}$/` there (depends on T009)
- [X] T011 Add `PUT` and `DELETE /v1/users/:userId/connections/:connectionId` to `src/layer2-control/user-routes.ts`, mounted exactly like the card routes (`role, personLimit, person`, then the bounded body parser), with the replace-in-one-section rule, `connection_reused`, the account checks, and `connections` on the user view, per contracts/control-api.md (depends on T010)
- [X] T012 [P] Add the two routes and the user view's `connections` to `docs/l2-control.openapi.yaml` so T-API-01..04 in `test/openapi.test.ts` match the service
- [X] T013 [P] Add `putConnection(userId, connectionId, platform)` and `deleteConnection(userId, connectionId)` to `ControlPort` and its HTTP client in `src/portal/control-client.ts`, forwarding the person's token as the card calls do; add `connections` to the user view type there
- [X] T014 [P] Create `src/shared/decimal.ts` skeleton exports (`parseDecimal`, `addDecimal`, `compareDecimal`, `divideRounded`) with `throw new Error("not implemented")` bodies, so US2's tests compile; the implementation is T040
- [X] T015 Create `test/helpers/coinbase-stub.ts`: an HTTP server on loopback implementing `GET /oauth2/auth` (redirects to the given `redirect_uri` with `code` and `state`, or `error=access_denied` when scripted), `POST /oauth2/token` (authorization code with the client secret, and PKCE S256 verification whenever the authorize call carried a challenge, as Coinbase does; refresh with rotation, where a reused refresh token kills the grant with `invalid_grant`), `POST /oauth2/revoke` (always 200, revoking the access token and its refresh token, or scripted to answer 200 and revoke nothing), `GET /v2/accounts` (`limit`, `starting_after`, `pagination.next_uri`, 401 `revoked_token`/`expired_token`, 403 `invalid_scope`, 429), `GET /v2/exchange-rates?currency=USD`; scripted faults (timeout, 5xx, 429, wider or narrower scopes, `scope: "all"` on renewal, no `refresh_token`); a recorder of every call; known values for the known-value scan. It is a test helper, never a deployed process
- [X] T016 Create `src/portal/coinbase/grants.ts`: read `COINBASE_GRANT_KEY` (the only file that names it, rule A18), seal and open `GrantSecret` with AES-256-GCM, a random 12-byte IV and the additional data of data-model.md; one file per user `<CONNECTION_DIR>/<userId>.json` holding `{ userId, connections: StoredConnection[] }` with `connectionId` `^conn_[0-9a-f-]{36}$`, `platform: "coinbase"`, `status: "connected" | "reconnect"`, `connectedAt`, `grant?`; mode 0600, temporary file and rename; `openAll()` for the startup check; the test-only dep `skipGrantBinding` drops the additional data (depends on T008)
- [X] T017 Extend `src/portal/config.ts` with `CONNECTED_PLATFORMS`, `CONNECTION_DIR` (default `.local/portal/connections`), `COINBASE_REDIRECT_URI`, `PRIVACY_POLICY_URL`, `SUPPORT_URL` and their checks (T007), asking `src/portal/coinbase/client.ts` for the client ID and secret and `grants.ts` for the key check, as it asks `card-vault.ts` today; unset `CONNECTED_PLATFORMS` means off and the other names are logged once, never their values (depends on T016)
- [X] T018 [P] Add the event labels `coinbase_connected`, `coinbase_disconnected`, `coinbase_replaced`, `coinbase_reconnect_needed`, `coinbase_scope_refused`, `coinbase_state_refused`, `coinbase_unavailable`, `coinbase_revoke_failed`, `coinbase_rate_limited`, `coinbase_bad_amount`, `coinbase_reconciled`, `coinbase_scope_unverified`, `coinbase_grant_write_failed` as the allowed values of `event` in `src/portal/log.ts`; `LOG_KEYS` doesn't change
- [X] T019 [P] Add the seven variables, commented, with empty values and one line each from contracts/config-and-secrets.md, to `env/portal.env.example`
- [X] T020 Create `src/portal/connections.ts` with the per-user serialization helper (a promise chain keyed by user) and the wiring into `PortalDeps` in `src/portal/server.ts` (`connections?`, the stand-in's base addresses as test-only deps, and the eight must-fail switches of contracts/portal-api.md), mounting nothing yet (depends on T013, T016, T017)

**Checkpoint**: L2 records connection events; the portal loads the feature's settings, opens and seals grants, and
the stand-in answers. `npm run typecheck` and `npm test` are green with the feature off.

---

## Phase 3: User Story 1 - A registered user connects their Coinbase account (Priority: P1) 🎯 MVP

**Goal**: From the wallet, a user with a profile goes to Coinbase, agrees to read-only access and comes back
connected; a cancel, a forged or replayed return, or a grant other than read-only connects nothing.

**Independent Test**: With the stand-in, sign in as a user with a profile and connect: the request asked for
`wallet:accounts:read offline_access` with S256, the wallet shows Coinbase as connected, and the stand-in received no
other call. A person with no profile, and a disabled user, get no connection.

### Tests for User Story 1 (write first, confirm they fail)

- [X] T021 [P] [US1] Add T-CONN-01 to `test/connections.test.ts`: `start` returns an `authorizeUrl` on `login.coinbase.com/oauth2/auth` (the stand-in's in tests) with `response_type=code`, the client ID, the redirect, `scope` exactly `wallet:accounts:read offline_access`, a 43-character `state` and `code_challenge_method=S256`; `complete` with the stand-in's code answers 200 `{ platform: "coinbase", status: "connected", connectedAt }`; L2 has `CONNECTION_OPENED`; `GET /api/wallet`'s `connections` row is `connected` with `privacyPolicyUrl` and `supportUrl`; `/api/me`'s onboarding status and L2's budget user view `account` are unchanged (FR-003); 409 `not_registered` for a person with no profile and 409 `account_disabled` for a disabled user on both routes; 503 `not_ready` from `start` when the privacy or support address is missing (deps); 10 starts a minute per user, then 429
- [X] T022 [US1] Add T-CONN-02 to `test/connections.test.ts`: a return with `error=access_denied` makes no `complete` call (web) and the pending start expires after 10 minutes (injected clock) with nothing kept in the grant store or at L2
- [X] T023 [US1] Add T-CONN-03 to `test/connections.test.ts`: `complete` answers 400 `invalid_state` for an unknown `state`, one older than 10 minutes, one already used (single use, deleted on first use whatever follows), one started by another user, and a code the stand-in refuses; a fourth pending start of one user drops the oldest; nothing is connected and the log has `coinbase_state_refused`. With `skipStateCheck` on, the other-user case connects: the test must fail. Code injection (SEC-55): alice starts and her code is captured; bob starts his own connection and completes with alice's code and his own valid `state`: the stand-in refuses the exchange because bob's verifier doesn't match alice's challenge, so 400 `invalid_state` and nothing connected. With `skipPkce` on (no challenge sent, no verifier), bob's portal account ends up connected to alice's Coinbase account: the test must fail
- [X] T024 [US1] Add T-CONN-04 to `test/connections.test.ts`: a granted scope set that adds `wallet:transactions:send`, that is `all`, or that contains any unknown name answers 400 `scope_refused` `too_wide`; one missing `wallet:accounts:read`, or a response without a `refresh_token`, answers `too_narrow`; in every case the stand-in recorded a revocation and the check call (`GET /v2/accounts?limit=1` answered 401) before the answer, and nothing is stored. Table-test `src/portal/coinbase/scopes.ts` for every case. With `skipScopeCheck` on, the wider grant connects: the test must fail
- [X] T025 [US1] Add T-CONN-05 to `test/connections.test.ts`: two completes for one user (two tabs) end with one connection; L2 shows `CONNECTION_CLOSED` `cause: "replaced"` for the first; the stand-in recorded the first grant's revocation; the log has `coinbase_replaced`; a failed revocation of the replaced grant still answers 200 and logs `coinbase_revoke_failed`. With `skipReplaceRevoke` on, the first grant still reads at the stand-in: the test must fail
- [X] T026 [P] [US1] Add T-WEB-17 to `web/portal/test/wallet.test.tsx` (`// @vitest-environment jsdom`, its own `cleanup`): the wallet's first part is headed "Your agent pays from this"; the Coinbase part with `not_connected` shows the read-only sentence, the **Privacy policy** and **Support** links and **Connect Coinbase**, and no Coinbase logo; clicking it calls `start` and sets `window.location` to `authorizeUrl` (stubbed); `connected` shows "Connected on <date>"; a disabled account shows only **Disconnect**
- [X] T027 [P] [US1] Add T-WEB-19 to `web/portal/test/connect.test.tsx` (new, jsdom, own `cleanup`): the return screen reads `code` and `state` once, replaces the address with `/wallet/coinbase` (`history.replaceState`) before calling `complete`, and shows each answer's message from contracts/portal-ui.md "Connecting" (200, query `error` with no call, `invalid_state`, `scope_refused` `too_narrow` and `too_wide`, 409, 502, 503); nothing is written to `localStorage` or `sessionStorage`
- [X] T028 [P] [US1] Amend T-WEB-14 in `web/portal/test/screens.test.ts` for the new row `coinbase-return` (`/wallet/coinbase`)

### Implementation for User Story 1

- [X] T029 [P] [US1] Create `src/portal/coinbase/scopes.ts`: `REQUESTED_SCOPES = ["wallet:accounts:read", "offline_access"]` and a pure `checkGrantedScopes(scope: string | undefined, hasRefreshToken: boolean)` returning `ok`, `too_wide` (`all`, any unknown or extra name) or `too_narrow` (missing `wallet:accounts:read` or no refresh token), and `checkRenewedScopes` (a listed name outside the list → refuse; the literal `all` → accept and flag `coinbase_scope_unverified`), per research R4
- [X] T030 [US1] Create `src/portal/coinbase/client.ts` with the calls of contracts/coinbase.md §1, §2 and §4 and the revocation check of §5 (`?limit=1`, 2 s, only a 401 confirms): constants for `login.coinbase.com` and `api.coinbase.com`, the paths and timeouts (5 s exchange, 3 s revoke); `COINBASE_CLIENT_ID` and `COINBASE_CLIENT_SECRET` read here only (rule A18); form bodies with `URLSearchParams`; `redirect: "error"`; no Coinbase text ever returned to callers, only typed outcomes (depends on T029)
- [X] T031 [US1] Implement `start` and `complete` in `src/portal/connections.ts` in the order of contracts/portal-api.md: pending starts in memory `{ state, userId, codeVerifier, createdAtMs }` (`state` and the verifier 32 random bytes base64url; 10 minutes; single use; at most 3 per user), the account checks from L2's user view, the exchange, the scope check with revoke-and-check on refusal, sealing as `connected` under a new `connectionId` (`conn_` + `randomUUID()`), `putConnection`, then revoking a `replaced` grant; every failure after a grant exists revokes it; the switches `skipStateCheck`, `skipPkce` (no challenge at `start`, no verifier at the exchange), `skipScopeCheck`, `skipReplaceRevoke` (depends on T030, T020)
- [X] T032 [US1] Mount `POST /api/connections/coinbase/start` and `POST /api/connections/coinbase/complete` (body `{ code, state }`, both strings of 1–512 characters, no other key, else 400 `invalid_request`) in `src/portal/routes.ts`, with the per-user start limit; with the feature off they don't exist (404) (depends on T031)
- [X] T033 [US1] Add `connections` to `GET /api/wallet` in `src/portal/routes.ts`: one row per offered platform with `status` (`not_connected`, `connected` with `connectedAt`, `reconnect`, `unavailable`), `privacyPolicyUrl` and `supportUrl`, read from the grant store without calling Coinbase (depends on T031)
- [X] T034 [P] [US1] Add the `coinbase-return` row (`/^\/wallet\/coinbase$/`, example `/wallet/coinbase`) to `src/shared/portal-screens.ts`
- [X] T035 [P] [US1] Add the `connections` types, `startCoinbase()` and `completeCoinbase(code, state)` to `web/portal/src/types.ts` and `web/portal/src/api.ts`, and the `coinbase-return` screen (back: `wallet`) to `web/portal/src/routes.ts`
- [X] T036 [US1] Create `web/portal/src/screens/CoinbaseReturn.tsx` per contracts/portal-ui.md "Connecting", and add its messages as constants to `web/portal/src/messages.ts` (depends on T035)
- [X] T037 [US1] Split `web/portal/src/screens/Wallet.tsx` into the two parts and add the Coinbase part's `not_connected`, `connected`, `reconnect` and `unavailable` states (without balances yet), the links and **Connect Coinbase** / **Reconnect** (a same-tab `window.location` assignment, the button reading "Going to Coinbase…"), per contracts/portal-ui.md (depends on T035)
- [X] T038 [US1] Add `POST /api/connections/coinbase/start`, `POST /api/connections/coinbase/complete` and the `connections` field of `GET /api/wallet` to `docs/portal.openapi.yaml` so T-API-12..15 in `test/openapi-portal.test.ts` match the service

**Checkpoint**: a user connects Coinbase and sees it as connected; every refusal of US1 is proven.

---

## Phase 4: User Story 2 - The user sees their balances in one place (Priority: P1)

**Goal**: The wallet shows Coinbase's funded assets with exact amounts, USD values at Coinbase's rates and a total,
with the read time, apart from the L2 account; a slow, failing or revoked Coinbase never breaks the wallet.

**Independent Test**: Script the stand-in with three funded assets (one with 18 decimal places), one empty asset, a
USD account and an asset with no rate: the wallet lists exactly the funded ones with exact amounts, values rounded
half-to-even to the cent and a total equal to their sum; with the stand-in failing, the L2 account still shows and
the Coinbase part is marked not current.

### Tests for User Story 2 (write first, confirm they fail)

- [X] T039 [P] [US2] Add T-DEC-01..03 to `test/decimal.test.ts` (new): `parseDecimal` accepts `^-?[0-9]{1,30}(\.[0-9]{1,30})?$` only; `addDecimal` and `compareDecimal` are exact for 18- and 30-decimal values; `divideRounded(amount, rate, 2)` rounds half-to-even (cases at exactly half a cent, very small rates such as `0.0000000105`, rate `0` refused); no result ever passes through `Number`
- [X] T040 [US2] Implement `src/shared/decimal.ts` by scaled `BigInt` (strings in, strings out), pure, no I/O (depends on T039; replaces T014's bodies)
- [X] T041 [P] [US2] Add T-CONN-08 to `test/connections.test.ts`: with the scripted accounts, `GET /api/connections/coinbase/balances` returns `PlatformBalances` with only funded `wallet`/`fiat`/`vault` assets (`dex_wallet` and unknown types dropped, zero dropped), amounts exactly as the stand-in's strings, `value: { amount, currency: "USD" }` with exactly 2 places (a USD account's value is its amount), the asset without a rate in `leftOutOfTotal` and without `value`, `total` = `addDecimal` of the values, `name` cut to 60 characters without control characters, `code` matching `^[A-Za-z0-9._-]{1,16}$`, an asset with a bad amount or with `balance.currency` ≠ `currency.code` dropped and logged `coinbase_bad_amount`; at most 200 listed, largest value first, valueless last then by code, `more` counted; pagination followed to 10 pages at most, never `fetch_all`, never a `next_uri` to another host; figures under 20 s old come from memory; `fresh=1` within 10 s of the last read returns the last figures; the answer takes under 3 s with the stand-in answering (NFR-004); 404 `not_connected` without a connection
- [X] T042 [US2] Add T-CONN-09 to `test/connections.test.ts`: a stand-in timeout or 5xx answers within 5 s with the last figures `stale: true` (log `coinbase_unavailable`) or `{ status: "unreadable" }` if never read; a 429 makes the portal skip that user for 60 s (log `coinbase_rate_limited`); a 401 `expired_token` renews once and retries once; a 401 `revoked_token`, a 403 `invalid_scope` or an `invalid_grant` on renewal answers `{ status: "reconnect" }`, turns the file entry `reconnect` without its grant, and logs `coinbase_reconnect_needed`; two concurrent balance reads of one user make one renewal (serialized), never reusing a refresh token; with `unserializedRenewals` on, the same two reads send the old refresh token twice and the stand-in ends the link (`invalid_grant`, the connection turns `reconnect`): the test must fail; the new refresh token is in the file before the new access token is used; a failed write after a renewal revokes the new grant and logs `coinbase_grant_write_failed`; a renewal with a listed scope outside the allow-list ends the connection, and `scope: "all"` is accepted with `coinbase_scope_unverified`; exchange rates older than 60 s with the rates call failing give no values and no total, amounts still shown
- [X] T043 [P] [US2] Add T-WEB-18 to `web/portal/test/wallet.test.tsx`: the balance rows show name, code, amount and USD value from strings via `formatDecimal` (no `Number(` or `parseFloat`), "no rate from Coinbase" for a valueless asset, the total labeled "Total in US dollars (at Coinbase's rates, <time>)", "Not counted: <codes>", "and <n> more assets"; a name such as `<img src=x onerror=alert(1)>` renders as text; the total is never shown summed with the L2 account; **Refresh** calls with `fresh=1` and stays disabled for 10 s
- [X] T044 [US2] Add T-WEB-20 to `web/portal/test/wallet.test.tsx`: the L2 part renders before the balances call resolves; `stale: true` shows "Couldn't reach Coinbase. These figures are from <time>."; `unreadable` and `reconnect` show their messages with no figures
- [X] T045 [P] [US2] Add `formatDecimal` cases to `web/portal/test/money.test.ts`: group separators and the `$` sign inserted by string operations, exact for long fractions

### Implementation for User Story 2

- [X] T046 [US2] Create `src/portal/coinbase/balances.ts`: a pure function from Coinbase's account pages and the USD rates to `PlatformBalances` applying every validation rule of data-model.md "Balances" (depends on T040)
- [X] T047 [US2] Add to `src/portal/coinbase/client.ts` the renewal (contracts/coinbase.md §3: 5 s, the new refresh token returned for sealing before use), the accounts list (§5: `limit=100`, `CB-VERSION` pinned as a constant chosen now and recorded in research R7, 10 pages and 4 s at most, same-host `next_uri` only) and the public exchange rates (§6: `currency=USD`, no `Authorization`, 3 s, a 60 s cache shared by every user) (depends on T030)
- [X] T048 [US2] Implement `balances` in `src/portal/connections.ts`: per-user serialization of renewals and reads (research R5; the test-only switch `unserializedRenewals` bypasses the chain), the access token in memory until 60 s before expiry, the 20 s figures cache, the 10 s fresh limit, the 60 s back-off after a 429, the 5 s overall deadline, stale and unreadable answers, the `reconnect` transition (depends on T046, T047)
- [X] T049 [US2] Mount `GET /api/connections/coinbase/balances` (optional `fresh=1`) in `src/portal/routes.ts` and add it to `docs/portal.openapi.yaml` (depends on T048)
- [X] T050 [P] [US2] Add `formatDecimal` to `web/portal/src/money.ts` and `coinbaseBalances(fresh?: boolean)` to `web/portal/src/api.ts` with its `PlatformBalances` type in `web/portal/src/types.ts`
- [X] T051 [US2] Create `web/portal/src/components/PlatformBalances.tsx` and use it in the Coinbase part of `web/portal/src/screens/Wallet.tsx`, loaded after the wallet, with **Refresh** (depends on T050, T037)

**Checkpoint**: US1 and US2 together: connect, then see the balances; every failure mode of US2 is proven.

---

## Phase 5: User Story 3 - Coinbase balances stay private and never become spending power (Priority: P1)

**Goal**: Nothing of a connection reaches L2 beyond identifiers, the ledger, the agent, the model, a log, the
administration area or browser storage; payments are identical with and without a connection; users can't reach
each other's connections.

**Independent Test**: The known-value scan finds 0 occurrences of the stand-in's grant, account values and tokens
outside the portal's sealed file; the same agent run with and without a connection gives identical decisions, budget
figures and payment ledger entries.

### Tests for User Story 3 (write first, confirm they fail)

- [X] T052 [P] [US3] Add T-CONN-06 to `test/connections.test.ts`: alice's grant file copied over bob's fails to open; bob's wallet shows `reconnect`; nothing reads alice's account as bob. With `skipGrantBinding` on, bob reads alice's balances: the test must fail
- [X] T053 [US3] Add T-CONN-07 to `test/connections.test.ts`: with alice connected, bob's `GET /api/connections/coinbase/balances` answers 404 `not_connected` and bob's `DELETE` touches nothing of alice's. With `skipConnectionOwner` on (the connection looked up without the token's user), bob gets alice's figures: the test must fail
- [X] T054 [US3] Add T-CONN-10 to `test/connections.test.ts`: two users connect and read; a known-value scan of the ledger file, L2's request log, the portal's log lines, the hosted agent's answers and run log, every `/api/admin/*` answer and the web app's storage (T-WEB-07's check) finds 0 occurrences of the stand-in's refresh and access tokens, codes, `state` values, account amounts and asset names; the portal's log lines carry only `LOG_KEYS` with `event` from T018's list; the grant files contain no amount or name (FR-027); across the whole suite the stand-in's recorder shows only the six calls of contracts/coinbase.md, no `POST` to the API host, no `fetch_all`, no `GET /v2/user`, and no call from any process but the portal (FR-021)
- [X] T055 [US3] Add T-CONN-11 to `test/connections.test.ts` (an L2-level run; as built, no agent and no chain): the same intents for a user without and then with a Coinbase connection yield identical decisions and budget answers, and `check_budget` names no platform (FR-020, FR-022, SC-005)
- [X] T056 [P] [US3] Add T-ARCH-A18 to `test/architecture.test.ts` with violating fixtures under `test/fixtures/arch/`: part 1 (`COINBASE_CLIENT_SECRET`, a `coinbase.com` string or the token, revoke or accounts paths in a `src/` file other than `src/portal/coinbase/client.ts`; `COINBASE_GRANT_KEY` outside `src/portal/coinbase/grants.ts`; either file importing the other's credential, `control-client.ts`, `admin-client.ts` or `src/layer*`), part 2 (`COINBASE_` or an import of `src/portal/coinbase/` in `src/layer1-intent/`, `src/layer2-control/`, `src/layer3-settlement/`, `src/counterparty/`, `src/machine-caller/`; the L1 entry points importing `src/portal/`), part 3 (`CONNECTION_OPENED`, `CONNECTION_CLOSED` or `connections` in `policy.ts`, `signer.ts`, `ledger-key.ts`); add `"A18"` to the `Rule` type
- [X] T057 [P] [US3] Amend T-AGT-KEY in `test/agent.test.ts`: each of `src/main.ts`, `src/hosted-main.ts` and `src/smoke-main.ts` exits 1 with `COINBASE_CLIENT_SECRET` or `COINBASE_GRANT_KEY` in its environment and makes no network call
- [X] T058 [US3] Amend T-ARCH-SWITCH in `test/architecture.test.ts` to know the eight new switch names as test-only

### Implementation for User Story 3

- [X] T059 [US3] Implement rule A18 in `test/architecture.test.ts` (the checker beside A10 and A13) so T056 passes against the code of US1–US2 (depends on T056)
- [X] T060 [US3] Add the refusal of `COINBASE_CLIENT_SECRET` and `COINBASE_GRANT_KEY` to the three L1 entry points `src/main.ts`, `src/hosted-main.ts`, `src/smoke-main.ts`, after loading the env file and before anything else, with a fixed refusal text in `src/refusal.ts` (depends on T057)
- [X] T061 [US3] Implement the `skipGrantBinding` and `skipConnectionOwner` switches where T052 and T053 need them (`src/portal/coinbase/grants.ts`, `src/portal/connections.ts`), and fix whatever T054 and T055 find

**Checkpoint**: the MVP (US1–US3) is complete: connect, see balances, and proof that nothing leaks or changes
payments.

---

## Phase 6: User Story 4 - The user disconnects Coinbase (Priority: P2)

**Goal**: Disconnecting forgets the grant, revokes it at Coinbase (checked), records it at L2; disabling the account
disconnects; every partial failure ends with fewer connections.

**Independent Test**: Connect, then disconnect: the balances go, the stand-in recorded the revocation and the check's
401, and the grant no longer works there; with the check failing, the grant is still forgotten and the person is told
to remove the access at Coinbase.

### Tests for User Story 4 (write first, confirm they fail)

- [X] T062 [P] [US4] Add T-CONN-12 to `test/connections.test.ts`: `DELETE /api/connections/coinbase` removes the file entry first, revokes and checks (401 → `revokedAtPlatform: true`; no 401 or a network failure → `false`), then L2 `DELETE`, within 10 s (SC-008); with the stand-in scripted to answer 200 to the revocation without revoking, the answer is `revokedAtPlatform: false` and the person is told to remove the access at Coinbase, and with `trustRevokeAnswer` on (the 200 taken as proof) it is `true`: the test must fail; an L2 failure still answers 200 and the next `GET /api/wallet` reconciles; allowed while disabled; `POST /api/account/disable` disconnects every connection; with the feature switched off after connecting, `DELETE` forgets the grant, records it at L2 and answers `revokedAtPlatform: false`; every reconcile row of contracts/portal-api.md "Reconcile" (file without L2 → revoke and remove; L2 without file → L2 `DELETE`), each logged `coinbase_reconciled`; with the stand-in's revocation scripted to hang, `GET /api/wallet` still answers within 1 s and the revocation completes afterwards
- [X] T063 [P] [US4] Add T-WEB-21 to `web/portal/test/wallet.test.tsx`: **Disconnect** asks for confirmation; `revokedAtPlatform: false` shows the message and the link to `https://accounts.coinbase.com/security/connections`; after disconnecting the wallet offers **Connect Coinbase** again

### Implementation for User Story 4

- [X] T064 [US4] Implement `disconnect` and `reconcile` in `src/portal/connections.ts` per contracts/portal-api.md (the order of steps, the revocation check of research R15 with the test-only switch `trustRevokeAnswer`, a 5 s budget), serialized with the user's reads (depends on T031, T048)
- [X] T065 [US4] Mount `DELETE /api/connections/coinbase` in `src/portal/routes.ts`; call `reconcile` from `GET /api/wallet` (its L2 side within the request; a revocation it needs after the answer is sent, so the wallet never waits for Coinbase); disconnect after L2 records the disabling in `POST /api/account/disable` (a failure there never fails the disabling); add the route to `docs/portal.openapi.yaml` (depends on T064)
- [X] T066 [US4] Add **Disconnect** with its confirmation and messages to `web/portal/src/screens/Wallet.tsx`, `deleteCoinbase()` to `web/portal/src/api.ts`, and the connections page link as a constant in `web/portal/src/messages.ts` (depends on T065)

**Checkpoint**: US1–US4 work together; partial failures are reconciled.

---

## Phase 7: User Story 5 - The operator controls the integration (Priority: P3)

**Goal**: Off by default; the portal refuses to start with the feature on and a setting missing; the Azure and VPS
deliveries carry the settings and secrets with the feature off; Coinbase down changes nothing else.

**Independent Test**: With `CONNECTED_PLATFORMS` unset, no route exists and the wallet has `connections: []`; with it
on and a credential missing, the portal refuses to start naming the variable; T-IAC-01 rule 26 passes; the local demo
summary is unchanged.

### Tests for User Story 5 (write first, confirm they fail)

- [X] T067 [P] [US5] Add T-PRT-20 to `test/portal.test.ts`: with `CONNECTED_PLATFORMS` unset, every `/api/connections/*` route answers 404 `{ "error": "not found" }`, `GET /api/wallet` has `connections: []`, `/api/config` is unchanged (T-PRT-18 still exact), and the stand-in records no call; with the feature turned off after a user connected, the wallet row is `unavailable` and no call reaches the stand-in; a portal with the feature on in front of an L2 without user accounts (404 on the user routes) offers no connection and the stand-in records no call (US5 scenario 3)
- [X] T068 [P] [US5] Add T-IAC-01 rule 26 to `test/infra.test.ts`: the portal app always references the portal vault's `coinbase-client-secret` (`COINBASE_CLIENT_SECRET`) and `coinbase-grant-key` (`COINBASE_GRANT_KEY`) in arrays no flag can empty; no other app references them and no other vault holds them; `CONNECTED_PLATFORMS` comes from `userAccounts.coinbase.enabled`; `main.bicep` fails `coinbase.enabled` without `userAccounts.enabled`, a `clientId`, a `redirectUri` starting with `https://` and ending with `/wallet/coinbase`, a `privacyPolicyUrl` and a `supportUrl`; the portal's `maxReplicas` is 1; `CONNECTION_DIR` is in the portal's share. Every rule-26 mutant makes the test fail

### Implementation for User Story 5

- [X] T069 [US5] Add `coinbase: { enabled, clientId, redirectUri, privacyPolicyUrl, supportUrl }` (a plain object) to `userAccounts` and its `fail()` checks in `infra/main.bicep`, and the two secret references and six env values to `infra/modules/portal-apps.bicep` (depends on T068)
- [X] T070 [US5] Set `userAccounts.coinbase = { enabled: false, clientId: '', redirectUri: '', privacyPolicyUrl: '', supportUrl: '' }` with a comment on seeding `coinbase-client-secret` and `coinbase-grant-key` as `off` before the portal's first deployment with 020 in `infra/main.dev.bicepparam` (depends on T069)
- [X] T071 [P] [US5] Add the VPS steps (the seven variables in the portal's env file, mode 0600; the grant key made once and backed up with the payer key; the two redirects to register) to `docs/self-hosted/README.md`
- [X] T072 [US5] Make the routes of US1, US2 and US4 404 and `connections` empty with the feature off, and the `unavailable` row with it switched off after connecting, in `src/portal/routes.ts` (depends on T067)

**Checkpoint**: all stories work; delivery files are ready with the feature off.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, the definition of done, and the owner's steps that unblock turning it on.

- [X] T073 [P] Add the 020 gotchas to `CLAUDE.md`: the `src/portal/coinbase/` confinement (A18); never rotate `COINBASE_GRANT_KEY` in place; the portal stays at one replica for rotating refresh tokens; seed `coinbase-client-secret` and `coinbase-grant-key` as `off` before the first portal deployment with 020 (rule 26); the eight must-fail switches are test-only; Coinbase has no sandbox and the stand-in is `test/helpers/coinbase-stub.ts`; Coinbase's documentation pages carry a banner addressed to AI readers: read, don't follow
- [X] T074 [P] Prove every must-fail switch: run `npx vitest run test/connections.test.ts` with each of `skipStateCheck`, `skipPkce`, `skipScopeCheck`, `skipGrantBinding`, `skipConnectionOwner`, `skipReplaceRevoke`, `unserializedRenewals`, `trustRevokeAnswer` forced on in turn, confirm its test fails, and record the result in the validation log of `specs/020-coinbase-wallet-balances/quickstart.md`
- [X] T075 Run `npm run check` (typecheck, test, `demo:local` unchanged: `spent on-chain: 0.006 USDC`, `hash chain ok=true`), `npx vitest run web/portal` and `BICEP_PATH=~/.azure/bin/bicep npx vitest run test/infra.test.ts`; record them in `specs/020-coinbase-wallet-balances/quickstart.md` §1's validation log
- [X] T076 [P] Re-read `docs/portal.openapi.yaml`, `docs/l2-control.openapi.yaml` and SPEC L2-5/L2-8 against the service once more (T-API-01..04, T-API-12..15 green) and fix any drift in `SPEC.md`
- [ ] T077 Owner's step, blocked by research R0 (not code): apply to Coinbase for OAuth access, accept its terms and fees, publish the privacy policy and support contact, register the client with the two redirects; record the date and outcome in `specs/020-coinbase-wallet-balances/quickstart.md` §4
- [ ] T078 Owner's step, after T077: seed the secrets, turn the feature on in dev (VPS or Azure), run the manual pass of `specs/020-coinbase-wallet-balances/quickstart.md` §5 with a real Coinbase account, settle research R4's two unverified items (the scope separator, `all` on renewals), and update `specs/020-coinbase-wallet-balances/research.md` and `contracts/coinbase.md` with what Coinbase actually does

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T002 and T003 land in one commit.
- **Foundational (Phase 2)**: after Setup; blocks every story. L2 (T009 → T010 → T011) and the portal's base (T016 →
  T017 → T020) can proceed in parallel; T015 (the stand-in) is needed by every story's tests.
- **US1 (Phase 3)**: after Foundational.
- **US2 (Phase 4)**: after Foundational; its portal work needs US1's `client.ts` (T030) and connections (T031) to
  read a connected user's balances, but its pure parts (T039–T040, T046, T045, T050) can start at once.
- **US3 (Phase 5)**: its tests can be written after Foundational; T054, T055 and T059 need US1 and US2 in place.
- **US4 (Phase 6)**: after US1 (and T048 of US2 for the serialized reads).
- **US5 (Phase 7)**: its IaC and docs tasks (T068–T071) depend only on Foundational; T072 needs the routes of US1, US2
  and US4.
- **Polish (Phase 8)**: after the stories wanted. T077–T078 are the owner's and are blocked outside the code.

### User Story Dependencies

- **US1 (P1)**: no dependency on other stories.
- **US2 (P1)**: needs a connection to read, so it builds on US1's connect flow; its tests stand alone with a stand-in
  connection seeded through US1's routes.
- **US3 (P1)**: proves properties of US1 and US2; it adds no route.
- **US4 (P2)**: builds on US1 (something to disconnect).
- **US5 (P3)**: independent for its delivery files; its gating task touches US1, US2 and US4's routes.

### Within Each User Story

- Tests first, failing; then pure modules (`scopes.ts`, `decimal.ts`, `balances.ts`), then `client.ts`, then
  `connections.ts`, then routes, then the web app.
- `src/portal/coinbase/client.ts`, `src/portal/connections.ts`, `src/portal/routes.ts`, `test/connections.test.ts`
  and `web/portal/src/screens/Wallet.tsx` are each touched by several stories: their tasks run in story order, never
  in parallel.

### Parallel Opportunities

[P] marks only tasks whose file no other unfinished task of the phase touches. Tasks that share a test file (for
example T021–T025 in `test/connections.test.ts`) run one after another; split a file per story if more parallelism is
wanted.

- Phase 1: T003 and T004 beside T002.
- Phase 2: T005, T007 and T008 (three test files) together, then T006; T012, T013, T014, T018, T019 together once T011
  and T016 exist.
- US1: T021, T026, T027, T028 (four files) together; then T022–T025 in `test/connections.test.ts`; T029, T034, T035
  together.
- US2: T039, T041, T043, T045 (four files) together, then T042 and T044; T050 beside T046–T048.
- US3: T052, T056, T057 (three files) together, then T053–T055 and T058.
- US4: T062 and T063 together.
- US5: T067, T068, T071 together.

---

## Parallel Example: User Story 1

```bash
# Tests first, one task per file in parallel:
Task: "T-CONN-01 connect flow in test/connections.test.ts"
Task: "T-WEB-17 wallet Coinbase part in web/portal/test/wallet.test.tsx"
Task: "T-WEB-19 return screen in web/portal/test/connect.test.tsx"
Task: "T-WEB-14 screens row in web/portal/test/screens.test.ts"
# then T-CONN-02..05 in test/connections.test.ts, one after another

# Then the independent pieces:
Task: "scopes.ts in src/portal/coinbase/scopes.ts"
Task: "coinbase-return row in src/shared/portal-screens.ts"
Task: "connections types and api calls in web/portal/src/types.ts and api.ts"
```

## Parallel Example: User Story 2

```bash
Task: "T-DEC-01..03 in test/decimal.test.ts"
Task: "T-WEB-18 balance rows in web/portal/test/wallet.test.tsx"
Task: "formatDecimal cases in web/portal/test/money.test.ts"
Task: "formatDecimal in web/portal/src/money.ts"
```

---

## Implementation Strategy

### MVP First (US1–US3)

1. Phase 1 (SPEC 1.30, constitution 3.2.0) and Phase 2.
2. US1: connect. Validate with T-CONN-01..05 and T-WEB-17, 19.
3. US2: balances. Validate with T-CONN-08..09, T-DEC-*, T-WEB-18, 20.
4. US3: privacy and separation. Validate with T-CONN-06, 07, 10, 11 and T-ARCH-A18.
5. **Stop and validate**: `npm run check` green, demo summary unchanged. Ship with the feature off.

US1 alone is not shippable: without US3's proofs, a connection would be a credential the system holds with no test
that it stays confined.

### Incremental Delivery

Pull requests per plan.md "Delivery": slice 1 (Phase 1), slice 2 (T005, T006, T009–T012), slice 3 (the rest of
Phase 2, US1–US3's portal side), slice 4 (the web app tasks of US1–US4), slice 5 (US5's delivery files, with the
feature off). Turning it on is T077–T078, after Coinbase approves the project.

---

## Notes

- [P] tasks = different files, no dependencies.
- Commit after each task or logical group, with the requirement IDs in the message (Constitution, quality gate 5).
- Stop at any checkpoint to validate a story on its own.
- Never print a token, a grant, a code or a `state` value; the stand-in's known values exist so a scan can look for
  them.
