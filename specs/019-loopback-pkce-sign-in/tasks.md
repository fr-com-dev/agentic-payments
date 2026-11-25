---

description: "Task list for 019: loopback PKCE sign-in from a desktop client for the hosted agent"
---

# Tasks: Loopback PKCE Sign-In from a Desktop Client for the Hosted Agent

**Input**: Design documents from `specs/019-loopback-pkce-sign-in/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md) (R1–R16)
- [data-model.md](data-model.md)
- [contracts/](contracts/): hosted-agent-api, control-api, tenant-and-config
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII and the spec's NFR-004 require a test for every
route, field, status and rule, plus the must-fail proofs in [plan.md "Proofs"](plan.md#proofs-constitution-viii).
- **Test IDs.** Each test title carries its ID (T-AGT-16..20, T-CTK-10..11, T-API-18, T-IAC-01, T-IAC-02,
  T-E2E-16) or `019 USn …`.
- **Order.** Write each story's tests first and confirm they fail before implementing. The tenant's configuration
  checks are the exception: their must-fail mutants prove them (T-IAC-02's existing pattern).
- **Switches.** Every must-fail switch (`revealCheck`, `skipAccountCheck`, `limitKey` on the hosted agent;
  `singleForbiddenCode` on L2's `caller` dep; the existing `trustIntentUser`) is a test-only dep, never an
  environment variable.
- **Tokens in tests.** A person is a token from `test/helpers/caller-tokens.ts` or the dev issuer. Never print a
  token, a refresh token or a code, in a test, a log line or a command.
- **Not edited.** `src/layer2-control/policy.ts`, `ledger.ts`, `signer.ts`, `approval-routes.ts`,
  `admin-routes.ts`, `src/shared/identity-token.ts`'s checks (`verifyCaller` stays as it is).

**Organization**: tasks are grouped by user story (US1–US7 from spec.md), in priority order. US1 to US3 are P1 and
form the MVP; US4 and US5 are P2; US6 and US7 are P3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task belongs to (US1–US7)

## Path Conventions

Repository root. Source in `src/`, tests in `test/`, the tenant in `auth0/`, Azure templates in `infra/`, OpenAPI
documents in `docs/`, env templates in `env/`, scripts in `scripts/`.

---

## Phase 1: Setup

**Purpose**: Start from the two features this one builds on, and amend the normative documents before code
(spec FR-027, plan.md "Dependencies").

- [X] T001 Rebase `claude/spec-19-implementation-5b3595` onto `main` once the DAST findings remediation (`claude/spec-17-dast-findings-42d580`) and the tenant sign-up hardening (`claude/pentest-report-fixes-0709b1`) are merged. Confirm `bearerChallenge` and `AGENT_REALM` exist in `src/shared/identity-token.ts` and `src/layer1-intent/hosted/requester-auth.ts`, that `auth0/main.tf` declares people's connections with the applications allowed on each, and that `npm run check` is green. Record the SPEC version and the last SEC, T-AGT, T-CTK and T-API IDs they took in `specs/019-loopback-pkce-sign-in/plan.md` "Dependencies". If they took any of this feature's (SPEC 1.29, SEC-49 onward, T-AGT-16..20, T-CTK-10..11, T-API-18), move this feature's to the next free ones in every file of `specs/019-loopback-pkce-sign-in/`, this one included, before T002. Record there too the names of the sign-up hardening's connection resources in `auth0/main.tf` and of the list on each that names the applications allowed on it, for T011 and T015
- [X] T002 Amend `SPEC.md` to the next version after both dependencies (expected 1.29), per plan.md "SPEC and governance changes": a "Changes in 1.29" section; §3.3 the desktop client (native, public, the two loopback callbacks, rotating refresh tokens 30 days / 7 days / leeway 0); L1-6 the 401 `error_code` (`missing_token`, `token_expired`, `invalid_token`), the account question (409 `account_not_onboarded` / `account_disabled` / `accounts_off`, 503 `control_unavailable`), `GET /.well-known/agent-auth`, `client` on run-log lines; L2-5 row 6's new code `user_accounts_off` and the budget user view's `account`; §7 `BudgetStatus.account?: "ready" | "not_onboarded" | "disabled"`; CFG-2 `AGENT_DESKTOP_CLIENT_ID` and the two-client `AGENT_CLIENT_IDS`; §11 new SEC entries from SEC-49 (a captured loopback code, a stolen refresh token, a desktop sign-in without the role, a PKCE downgrade) and, on the DAST remediation's 401 entry, the one exception (the expiry); §12 T-AGT-16..20, T-CTK-10..11, T-API-18, T-IAC-01 and T-IAC-02 amended, T-E2E-16 rewritten, T-E2E-17 amended (a desktop sign-in step; a disabled account refused with 409 before the run). Commit it together with T003, in one commit
- [X] T003 [P] Amend `.specify/memory/constitution.md` as a MINOR version: Technology & Scope ("three fixed applications" becomes four: the desktop client, native and public, with rotating refresh tokens); Principle V (refresh tokens exist only in the portal's web app and the desktop client, held by the person's own client, never sent to a service of this system); a new Sync Impact Report naming SPEC's version. It lands in the same commit as T002: the constitution's governance has SPEC and the constitution change together
- [X] T004 [P] Add row 019 to `specs/README.md` (layer L1 + L2 + tenant; functional and non-functional scope from spec.md) and its traceability rows (L1-6, L2-5, §3.3, §7, CFG-2, the new SEC IDs, the new and amended tests)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared contract field, the dev issuer's desktop client and the test helpers every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 Add `account?: "ready" | "not_onboarded" | "disabled"` to `BudgetStatus` in `src/shared/contracts.ts`, with a comment: 019, present only on L2's user view (`scope: "user_daily"`), from `userGate` of the person in the verified token; the platform view has none
- [X] T006 [P] Add `export const DEV_DESKTOP_CLIENT = "x402-agent-desktop-dev"` in `scripts/dev-issuer-lib.ts` (the desktop client's ID with the dev issuer), and a `--desktop` flag in `scripts/dev-token.ts` that mints a person's agent token from that client (same `sub`, permission and lifetime as today's default); refuse `--desktop` with `--portal` or `--service`, naming the flags; update the usage comment on line 1
- [X] T007 [P] Put both dev clients on every local list as `x402-agent-cli-dev,x402-agent-desktop-dev`: `AGENT_CLIENT_IDS` in `scripts/demo-lib.ts`, `scripts/vscode-local.ts` (and its warning text), `env/l1-hosted.env.example` and `env/l2-control.env.example` (commented line), with a comment naming the desktop client; update `test/vscode-local.test.ts` (T-DEV-01) if it pins the value
- [X] T008 [P] In `test/helpers/caller-tokens.ts`, default `clientIds` to `[DEV_AGENT_CLIENT, DEV_DESKTOP_CLIENT]` and let a test mint a person's token from either client; in `test/helpers/hosted.ts`, set `AGENT_CLIENT_IDS` to both dev clients and make `fakePorts`' default `budget` answer include `account: "ready"` (the client lists are done; the `account` answer waits for T005's contract field)
- [X] T009 Update every test budget fake that a person's run reaches and that answers a budget to include `account: "ready"` (search `test/hosted-*.test.ts` and `test/e2e.local.test.ts` for `budget:`), so the existing suites keep their meaning once the account question lands; run `npm test` green. Leave alone a fake that throws on purpose: T-AGT-05's in `test/hosted-run.test.ts` (line 194) throws an error carrying a planted token so the `check_budget` step's error is shown not to leak (SEC-16). T037 changes it together with the account question, because before T037 its first call is the tool's

**Checkpoint**: Foundation ready. Nothing behaves differently yet.

---

## Phase 3: User Story 1 - A person signs in from their own computer and starts a run, with no copied token (Priority: P1) 🎯 MVP

**Goal**: The tenant has the desktop client, and the agent and L2 accept its tokens in every environment.

**Independent Test**: A token shaped like the desktop client's (dev issuer) starts a run at the hosted agent and
its payments are the person's; T-IAC-02 and T-IAC-01 accept the tenant and the templates; quickstart §5 L1, L2, L15, L17.

### Tests for User Story 1 (write first; they must fail)

- [X] T010 [P] [US1] In `test/auth0-iac.test.ts` (T-IAC-02), change `APPLICATIONS` to `["agent", "desktop", "l2", "machine", "portal"]` and `FOUR_KINDS` to five kinds, and add checks on `auth0_client.desktop`: `app_type = "native"`, `is_first_party = true`, `oidc_conformant = true`, `grant_types` exactly `["authorization_code", "refresh_token"]`, `callbacks` exactly `http://127.0.0.1:53682/callback` and `http://localhost:53682/callback` and not built from `var.local_origins`, no `web_origins`, `allowed_origins`, `allowed_logout_urls` or `initiate_login_uri`, `client_metadata = { x402_client = "agent-desktop" }`, `jwt_configuration` RS256, and `auth0_client_credentials.desktop` with `authentication_method = "none"`; the tenant still has two permissions and two roles and no Action secret; no `default_audience` anywhere (`auth0_tenant.mfa_actions` sets nothing but its MFA setting, spec FR-004; add the mutant `default_audience = local.identity_audience` in that block, reported by `MFA_SETTINGS`); `l1_env`, `l2_env` and `bicepparam_agent` name `auth0_client.desktop.client_id`; the "agent object" test (line 896) expects five keys with `desktopClientId`. One must-fail mutant each: a third grant, a wildcard or third callback, callbacks under `local_origins`, a secret, a missing marker, an Action secret
- [X] T011 [US1] In `test/auth0-iac.test.ts` (T-IAC-02, connections), check that the desktop client is allowed on exactly the people's connections the agent's docs page client is allowed on (the resources T001 recorded in plan.md "Dependencies"), and that the rule "only the portal's and the agent's applications sign a person in" admits the desktop client too; must-fail: the desktop client on a third connection
- [X] T012 [P] [US1] In `test/infra.test.ts` (T-IAC-01), check that every `infra/main.<env>.bicepparam` has `agent.desktopClientId`, that `l1-apps.bicep` and `l2-apps.bicep` set `AGENT_CLIENT_IDS` to `agent.clientId` alone when it is empty and to `<clientId>,<desktopClientId>` when set, and that `l1-apps.bicep` sets `AGENT_DESKTOP_CLIENT_ID`; must-fail: a template that drops the desktop ID from L2's list
- [X] T013 [P] [US1] Create `test/hosted-desktop.test.ts` with `019 US1` cases: a person's token from `DEV_DESKTOP_CLIENT` starts a run through `startHostedApp` and its gate carries that token; the same token forwarded to L2 is accepted on budget and authorize (`test/helpers/users.ts` person onboarded) and the payment is that person's; the same token at the portal is refused; a docs page client token and a machine caller's token still run as before

### Implementation for User Story 1

- [X] T014 [US1] In `auth0/main.tf`, add `local.desktop_callbacks = ["http://127.0.0.1:53682/callback", "http://localhost:53682/callback"]` (a constant, with a comment saying why it is not under `var.local_origins`), `auth0_client.desktop` and `auth0_client_credentials.desktop` exactly as in `contracts/tenant-and-config.md` "New: the desktop client" (name `app-agent-desktop-${var.environment}`, native, first-party, OIDC conformant, grants `authorization_code` and `refresh_token`, `client_metadata = { x402_client = "agent-desktop" }`, RS256, the `refresh_token` block: `rotation_type = "rotating"`, `expiration_type = "expiring"`, `token_lifetime = 2592000`, `idle_token_lifetime = 604800`, `infinite_token_lifetime = false`, `infinite_idle_token_lifetime = false`, `leeway = 0`; credentials `authentication_method = "none"`); update the header comment (five kinds of application)
- [X] T015 [US1] In `auth0/main.tf`, add the desktop client to the people's connections' application lists beside the agent's docs page client, in the resources T001 recorded in plan.md "Dependencies", and update that declaration's comment
- [X] T016 [US1] In `auth0/outputs.tf`, make `l1_env` print `AGENT_CLIENT_IDS=<agent>,<desktop>` and a new line `AGENT_DESKTOP_CLIENT_ID=<desktop>`, `l2_env` print `AGENT_CLIENT_IDS=<agent>,<desktop>`, and `bicepparam_agent` carry `desktopClientId = auth0_client.desktop.client_id`; update the three descriptions
- [X] T017 [P] [US1] In `infra/main.dev.bicepparam` (and every other `infra/main.<env>.bicepparam`), add `desktopClientId: ''` to `agent`; in `infra/modules/l1-apps.bicep` and `infra/modules/l2-apps.bicep`, set `AGENT_CLIENT_IDS` to `empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}'`, and in `l1-apps.bicep` add `{ name: 'AGENT_DESKTOP_CLIENT_ID', value: agent.desktopClientId }`; update the comments in `infra/main.bicep` describing `agent`
- [X] T018 [US1] Run `BICEP_PATH=~/.azure/bin/bicep npx vitest run test/auth0-iac.test.ts test/infra.test.ts test/hosted-desktop.test.ts` and `terraform -chdir=auth0 fmt -check` (or `npm run auth0:tenant -- validate` on the operator's host); all green

**Checkpoint**: The desktop client exists in the tenant's configuration and its tokens run at the agent and pay at L2.

---

## Phase 4: User Story 3 - Only people allowed to spend get a desktop sign-in (Priority: P1)

**Goal**: The tenant refuses a desktop sign-in or renewal without `x402-agent`, refuses anything but S256, and asks
the person for a second factor; the agent refuses tokens that aren't for it.

**Independent Test**: T-IAC-02 runs `auth0/sign-in-time.js` against the stand-in `api` for each case;
quickstart §5 L3, L4, L6, L9, L12, L14.

### Tests for User Story 3 (write first; they must fail)

- [X] T019 [P] [US3] In `test/auth0-iac.test.ts` (T-IAC-02, rules run with `runAction`), add an event builder for a client (`event.client.metadata`, `event.transaction.protocol`, `event.request.query`, `event.authorization.roles`) and run the 12 combinations spec NFR-004 asks for: the desktop client (`x402_client = "agent-desktop"`), the docs page's client and the portal's client (no marker), each for a person with and without `x402-agent`, each on `oidc-basic-profile` and on `oauth2-refresh-token`. Expected: the desktop client without the role → `[["accessToken.setCustomClaim", …], ["access.deny", ["not_authorized_for_agent"]]]` on both protocols and no challenge; the desktop client with the role on a sign-in with `S256` and a stale second factor → claim then `authentication.challengeWithAny`; on a renewal → claim only; the other two clients, with or without the role → exactly today's calls. Also, for the desktop client with the role on a sign-in: no `code_challenge` → deny `pkce_required`; `code_challenge_method` `plain` or missing → deny `pkce_required`. Every existing case stays. Must-fail variants: skipping check 1 on renewal, accepting `plain`, challenging before refusing
- [X] T020 [US3] In `test/auth0-iac.test.ts`, update the static pins on `sign-in-time.js` (line 469): `apiUses` becomes `["accessToken.setCustomClaim","access.deny","access.deny","authentication.challengeWithAny"]` (in source order) and `signInStrings` gains the new literals in source order (`x402-agent`, `agent-desktop`, `not_authorized_for_agent`, `oauth2-refresh-token`, `S256`, `pkce_required`, or as written); `loads` still forbids `event.secrets`, `require`, `import`, `fetch`; update the `ONE_CLAIM` message to say the rule refuses for the desktop client only

### Implementation for User Story 3

- [X] T021 [US3] In `auth0/sign-in-time.js`, after writing the sign-in time claim and before the challenge: when `event.client.metadata.x402_client === "agent-desktop"`, (1) if `event.authorization.roles` lacks `"x402-agent"`, call `api.access.deny("not_authorized_for_agent")` and return; (2) if `event.transaction.protocol !== "oauth2-refresh-token"` and `event.request.query` has no `code_challenge` or a `code_challenge_method` other than `"S256"`, call `api.access.deny("pkce_required")` and return; then (3) challenge with `SECOND_FACTORS` when the protocol is a browser protocol and the second factor is not fresh, for an administrator (today) or for the desktop client. Rewrite the header comment: it fails a sign-in only for the desktop client, for these two reasons, and why they run first (Auth0 may reissue `event.request` after a challenge, research R5)
- [X] T022 [US3] In `auth0/main.tf`, update the comments on `auth0_action.sign_in_time` (what it refuses, for which client) and on `auth0_resource_server.identity` (consent may still be asked for a loopback return); the precondition on `local.auth_time_claim` stays
- [X] T023 [US3] Run `npx vitest run test/auth0-iac.test.ts test/hosted-access.test.ts`; T-AGT-07 (portal token 403) and T-AGT-09 (another issuer or audience 401) still pass unchanged

**Checkpoint**: The MVP's safety: a desktop sign-in needs the role, S256 and a second factor.

---

## Phase 5: User Story 2 - The sign-in lasts for days and ends safely (Priority: P1)

**Goal**: Renewal settings are proven, a removed role stops renewals, and signing in again or renewing never
resets a person's run limits.

**Independent Test**: T-IAC-02's refresh mutants; T-AGT-19 with two clients and one `sub`; quickstart §5 L7, L8,
L10, L16.

### Tests for User Story 2 (write first; they must fail)

- [X] T024 [P] [US2] In `test/auth0-iac.test.ts` (T-IAC-02), check `auth0_client.desktop`'s `refresh_token` block exactly (`rotation_type = "rotating"`, `expiration_type = "expiring"`, `token_lifetime = 2592000`, `idle_token_lifetime = 604800`, both `infinite_*` false, `leeway = 0`) and that `idle_token_lifetime` ≤ `token_lifetime`; must-fail mutants: `leeway = 30`, `infinite_token_lifetime = true`, `rotation_type = "non-rotating"`, `idle_token_lifetime = 2592001`
- [X] T025 [P] [US2] In `test/hosted-desktop.test.ts`, add T-AGT-19: one person (`sub`) with a docs page client token and a desktop client token; two concurrent runs through either client, then a third through the other → 429 with `Retry-After`; 20 starts across both clients in an hour, then the 21st → 429. Must-fail: with the test-only `limitKey` dep keying by client and `sub`, the third run starts

### Implementation for User Story 2

- [X] T026 [US2] In `src/layer1-intent/hosted/server.ts`, add the test-only dep `limitKey?: (requester: Requester) => string` to `HostedDeps` (default: `requester.key`, `<issuer host>:<sub>`), use it in `checkLimits` and `limiter.start`, and document it as never set by the entry point; the default behaviour is unchanged
- [X] T027 [US2] Run `npx vitest run test/hosted-desktop.test.ts test/auth0-iac.test.ts` green

**Checkpoint**: US1, US3 and US2 together are the deployable MVP (plan.md "Delivery" steps 4 to 8 can follow).

---

## Phase 6: User Story 4 - A person without a usable account is told before the run starts (Priority: P2)

**Goal**: L2 says whether a person can pay; the agent refuses a person who can't, before any model call.

**Independent Test**: T-CTK-10..11 at L2; T-AGT-17 at the agent; T-E2E-16 end to end; quickstart §3 and §5 L11.

### Tests for User Story 4 (write first; they must fail)

- [X] T028 [P] [US4] In `test/caller-token.test.ts`, add T-CTK-10: the budget user view answers `account: "ready"` for an onboarded person, `"not_onboarded"` for a person who never onboarded, `"disabled"` for a disabled person, each from their own forwarded token; the platform view (a machine caller) has no `account`; nothing is appended to the ledger. Must-fail: with `trustIntentUser` and `?userId=` naming another person, that person's readiness is reported
- [X] T029 [US4] In `test/caller-token.test.ts`, change T-CTK-01 row 6 (line 122) to expect 403 `{ "error": "user_accounts_off" }` on budget and on authorize, and add T-CTK-11: a token from a client not on L2's list is still 403 `caller_forbidden`. Must-fail: with the test-only `singleForbiddenCode` dep on L2's `caller` dep, row 6 answers `caller_forbidden`
- [X] T030 [P] [US4] Create `test/hosted-account.test.ts` with T-AGT-17, one case per row of `contracts/hosted-agent-api.md` "The account question": `account: "ready"` → the run starts; `"not_onboarded"` → 409 `{ "error": "account not ready", "error_code": "account_not_onboarded" }`; `"disabled"` → 409 `account_disabled`; a `PortHttpError` 403 `user_accounts_off` → 409 `accounts_off`; 401 `caller_token_expired` → 401 `token_expired` with `WWW-Authenticate: Bearer realm="x402-agent", error="invalid_token"`, counted by the failed-authentication limit (`MAX_FAILED_AUTH_PER_ADDRESS` of them from one address, then 429); a 200 without `account`, a 403 `caller_forbidden`, a 500, a thrown network error, and an answer after 1,100 ms → 503 `control_unavailable`; a budget fake that throws an error carrying a planted token → the body is exactly `{ "error": "control unavailable", "error_code": "control_unavailable" }`, and the planted value is in neither the body nor any log line. On every refusal: no model call (`modelCalls`), no authorize call, no session reference, and the refusal is not a start (21 refusals, then a run starts); with `Accept: text/event-stream` the refusal is the same JSON; a machine caller's run makes no budget call before the model. Must-fail: with `skipAccountCheck`, the not-onboarded person's run calls the model
- [X] T031 [P] [US4] In `test/e2e.local.test.ts`, rewrite T-E2E-16 (line 1054): a person with the role and no account gets 409 `account_not_onboarded` from the hosted agent before any payment or model call, and nothing is appended for them; keep the session carry-over part with an onboarded person; at the end, a known-value scan of the ledger's entries finds none of the run's caller tokens (spec NFR-003). Beside it, in the same `013 user accounts end to end` block: `019 US4` an account turned off at the portal gets 409 `account_disabled` before any model call, and one whose policies are all paused is ready (the run starts, the purchase is denied `host_not_allowed`); `019 US1, US6` a desktop token and a docs page token of one person both pay from that person's account, the run log's step and run lines name each run's client, and a known-value scan of the run log, the JSON answers, the stream and the ledger finds neither token; `019 US5` the three 401 codes through the whole stack, the invalid ones identical, nothing appended. A new block `019 person accounts off at L2` (`startHarness({ callers: true })`): a person's run from either client gets 409 `accounts_off` before any model call, and a machine caller's run still pays from the platform account. In `test/e2e.full.test.ts` (T-E2E-17): a new step where ana signs in from the desktop client, her run pays from her own wallet and the portal refuses that token (the books' totals at the end gain that payment); and the step where ana disables her account now expects 409 `account_disabled` before the run, instead of a run whose purchase is denied `user_disabled`
- [X] T032 [P] [US4] In `test/hosted-agent.test.ts`, check that `check_budget`'s tool output, as the model sees it and as a step's `result` lists it, has no `account` field even when the gate's budget has one

### Implementation for User Story 4

- [X] T033 [US4] In `src/layer2-control/caller.ts`, answer row 6 (a person's token while user accounts are off) with 403 `{ "error": "user_accounts_off" }`; add the test-only `singleForbiddenCode` dep that restores `caller_forbidden`; update the file's comment on the order of checks
- [X] T034 [US4] In `src/layer2-control/service.ts`, in `GET /v1/budget/:sessionId`'s user view, add `account: userGate(state) ?? "ready"` (values exactly `"ready" | "not_onboarded" | "disabled"`), computed in the same read, appending nothing; the platform view stays without `account`
- [X] T035 [P] [US4] In `docs/l2-control.openapi.yaml`, add `account` (enum `ready`, `not_onboarded`, `disabled`; on the user view only) to the budget answer's schema and the 403 `user_accounts_off` to `/v1/authorize` and `/v1/budget/{sessionId}`; run `npx vitest run test/openapi.test.ts` (T-API-01..04)
- [X] T036 [US4] Create `src/layer1-intent/hosted/account-check.ts`: `checkAccount(gate: Pick<AuthorizationGatePort, "budget">, sessionId: string, o?: { timeoutMs?: number }): Promise<{ ok: true } | { ok: false; status: 401 | 409 | 503; body: { error: string; error_code: string }; challenge?: true }>` implementing the mapping table of `contracts/hosted-agent-api.md` exactly (default bound 1,000 ms, by racing the call against a timer); import only `../../shared/*` and `../ports-http.js`'s `PortHttpError` type (hard rule 1; it never names the caller header, rule A14)
- [X] T037 [US4] In `src/layer1-intent/hosted/server.ts`, for a requester of kind `user`, call `checkAccount(gate, sessionId)` after the session check and before `limiter.start`, `runId` and the stream; on a refusal answer its status and body (with the DAST remediation's `bearerChallenge(AGENT_REALM, true)` when `challenge`) and return; add the test-only `skipAccountCheck` dep; make the gate once (`deps.gate.forCaller`) and use it for both the check and the run; update the order comment at the top of the file. In the same change, update T-AGT-05's throwing budget fake in `test/hosted-run.test.ts` (line 194): answer `{ …, account: "ready" }` on its first call (the account question) and throw on every later call, so the test keeps its three log lines, the `check_budget` step's `error` outcome and its scan for the planted token
- [X] T038 [US4] In `src/layer1-intent/hosted/agent.ts`, make `check_budget` return the budget without `account` (the model and a step's `result` keep today's fields); the `fetch_resource` path that reads `decimals` is unaffected
- [X] T039 [P] [US4] In `docs/l1-hosted.openapi.yaml`, add `409` (`account not ready`, the three codes) and `503` (`control unavailable`) to `/v1/runs`, described as answered before the run starts, as JSON with or without a stream; update the route's description of the order of checks
- [X] T040 [US4] Run `npx vitest run test/caller-token.test.ts test/hosted-account.test.ts test/hosted-agent.test.ts test/openapi-hosted.test.ts test/openapi.test.ts` and `npm run test:e2e`; all green

**Checkpoint**: A not-ready person learns why within a second, and nothing is spent.

---

## Phase 7: User Story 5 - A client can tell from a refusal what to do next (Priority: P2)

**Goal**: Every agent 401 carries `missing_token`, `token_expired` or `invalid_token`, and nothing more.

**Independent Test**: T-AGT-16; quickstart §3 and §5 L5, L6.

### Tests for User Story 5 (write first; they must fail)

- [X] T041 [P] [US5] Create `test/hosted-refusals.test.ts` with T-AGT-16: no header → 401 `{ "error": "unauthorized", "error_code": "missing_token" }` with `WWW-Authenticate: Bearer realm="x402-agent"`; an expired token whose other checks pass → `token_expired` with `error="invalid_token"`; a bad signature, another issuer, another audience, an empty `sub`, a machine token whose `sub` is not its client's, and a malformed token → byte-identical bodies with `invalid_token`; a token that is expired and has another audience → `invalid_token`; the same answers with `Accept: text/event-stream`; 403 unchanged. Must-fail: with the test-only `revealCheck` dep, the identical-bodies assertion fails

### Implementation for User Story 5

- [X] T042 [US5] In `src/layer1-intent/hosted/requester-auth.ts`, answer 401 with `{ error: "unauthorized", error_code }`: `missing_token` when `bearerToken` finds none, else `token_expired` when `verifyCaller`'s `reason` is `expired` and `invalid_token` otherwise; keep the DAST remediation's `WWW-Authenticate` lines as they are; add the test-only `revealCheck` option (puts a description of the failure in the body; never set by the entry point) and pass it through `createHostedApp` in `src/layer1-intent/hosted/server.ts`
- [X] T043 [P] [US5] In `docs/l1-hosted.openapi.yaml`, add `error_code` (optional; enum `missing_token`, `token_expired`, `invalid_token`, `account_not_onboarded`, `account_disabled`, `accounts_off`, `control_unavailable`) to `Error`, and describe the three 401 codes and the challenge in `responses.Unauthorized`; bump `info.version` to SPEC's version
- [X] T044 [US5] Run `npx vitest run test/hosted-refusals.test.ts test/hosted-access.test.ts test/openapi-hosted.test.ts` green

**Checkpoint**: A client renews on `token_expired` and signs in again on `invalid_token`.

---

## Phase 8: User Story 6 - Every run and payment can be traced to a person and the client they used (Priority: P3)

**Goal**: Each run-log line names the client; no token ever appears.

**Independent Test**: T-AGT-20.

### Tests for User Story 6 (write first; they must fail)

- [X] T045 [P] [US6] Create `test/hosted-run-log.test.ts` with T-AGT-20: a run from the desktop client, one from the docs page client and one from a machine caller each write step and run lines whose `client` is that token's client, beside `runId`, `requester`, `sessionId` and, for a payment, `authorizationId`; a known-value scan of the log lines, the JSON answer and a stream finds none of the run's tokens (and no `eyJ` JWT prefix)

### Implementation for User Story 6

- [X] T046 [US6] In `src/layer1-intent/hosted/requester-auth.ts`, add `client: string` to `Requester` (from `Caller.client`); in `src/layer1-intent/hosted/run-log.ts`, add `client` to `StepLine` and `RunLine` and write it in both lines; in `src/layer1-intent/hosted/server.ts`, pass `requester.client` (and `"bypass"` in `BYPASS_REQUESTER`); update the run-log header comment; add `client` to `STEP_KEYS` and `RUN_KEYS` in `test/hosted-run.test.ts` (T-AGT-05's list of allowed keys) and expect the dev agent client there
- [X] T047 [US6] Run `npx vitest run test/hosted-run-log.test.ts test/hosted-run.test.ts test/hosted-stream.test.ts` green

**Checkpoint**: An operator can tell a desktop run from a docs page run in the log.

---

## Phase 9: User Story 7 - A client finds the sign-in settings at the agent (Priority: P3)

**Goal**: `GET /.well-known/agent-auth` serves the seven public values; the API description lists the scopes.

**Independent Test**: T-AGT-18; quickstart §5 L13.

### Tests for User Story 7 (write first; they must fail)

- [X] T048 [P] [US7] Create `test/hosted-sign-in-settings.test.ts` with T-AGT-18: with `AGENT_DESKTOP_CLIENT_ID` set, `GET /.well-known/agent-auth` without a token answers 200 with exactly `issuer` (= `AUTH_ISSUER`), `authorization_endpoint` (`<issuer>authorize`), `token_endpoint` (`<issuer>oauth/token`), `audience` (= `AUTH_AUDIENCE`), `client_id`, `scopes` (`["openid", "offline_access", "agent:run"]`) and `redirect_uri` (`http://127.0.0.1:53682/callback`), `Cache-Control: public, max-age=300`, and makes no gate, settlement or model call; without the variable the path is 401 without a token and 404 with one; `loadHostedConfig` refuses `AGENT_DESKTOP_CLIENT_ID` not on `AGENT_CLIENT_IDS`, equal to `PORTAL_CLIENT_ID`, or with `AUTH_JWKS_FILE`, naming the variable and never its value; the route is counted by the per-address limit

### Implementation for User Story 7

- [X] T049 [US7] In `src/layer1-intent/hosted/config.ts`, read `AGENT_DESKTOP_CLIENT_ID` into `auth.desktopClientId` with the checks of T048, mirroring `API_DOCS_CLIENT_ID`'s
- [X] T050 [US7] In `src/layer1-intent/hosted/server.ts`, mount `GET /.well-known/agent-auth` after the per-address and failed-authentication limits and before `requesterAuth`, only when `config.auth.desktopClientId` is set, answering the seven fields from the settings (endpoints built from `AUTH_ISSUER`) with `Cache-Control: public, max-age=300`; update the order comment
- [X] T051 [P] [US7] In `src/layer1-intent/hosted/api-docs.ts` and `docs/l1-hosted.openapi.yaml`, list `openid`, `offline_access` and `agent:run` (each described) under the `signIn` scheme's `scopes`, saying the docs page's own client still gets no refresh token; add `/.well-known/agent-auth` with `security: []`, `tags: [docs]` or a new `sign-in` tag, and an `AgentAuthSettings` schema with `additionalProperties: false` and the seven required fields
- [X] T052 [US7] Run `npx vitest run test/hosted-sign-in-settings.test.ts test/openapi-hosted.test.ts` green

**Checkpoint**: All seven stories work on their own.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: The API description test, the operating guides, the definition of done, the tenant on the operator's
host and the live check.

- [X] T053 [P] In `test/openapi-hosted.test.ts`, add T-API-18: the document's 401 carries `error_code` with the three codes, `/v1/runs` documents 409 and 503 with their codes, `/.well-known/agent-auth` and `AgentAuthSettings` match the service's answer, and `signIn` lists the three scopes; each fails on its existing T-API-05..08 mutants
- [X] T054 [P] Update `CLAUDE.md`: the gotcha listing the tenant's applications (five kinds: the desktop client added; T-IAC-02), a new gotcha for the desktop client (fixed port 53682, both loopback callbacks in every environment, rotating refresh tokens 30 d / 7 d / leeway 0, `sign-in-time.js` refuses without `x402-agent` or S256 and asks a second factor, enroll a second factor before giving the role), the account question (409 before the run; L2's `user_accounts_off`; the fake L2 answers `account: "ready"`), the 401 codes beside the DAST challenge, and `AGENT_DESKTOP_CLIENT_ID`; add `npm run dev-token -- --subject alice --desktop` to Commands
- [X] T055 [P] Update `auth0/README.md`: the desktop client's row in the objects table (outputs `l1_env`, `l2_env`, `bicepparam_agent`), the rollout (step 7 copies both client IDs to the agent's and L2's env files; enroll a second factor, an account at the portal, then the role), the rollback (off the lists first, then off at the tenant; revoke refresh tokens), and the consent note
- [X] T056 [P] Update `README.md` where it describes who may call the hosted agent and how, adding the desktop sign-in in one paragraph that links `specs/019-loopback-pkce-sign-in/quickstart.md`
- [X] T057 Run `npm run check` (`package.json` scripts) (typecheck, `npm test`, `demo:local`): expect `spent on-chain: 0.006 USDC` and `hash chain ok=true` unchanged; then `BICEP_PATH=~/.azure/bin/bicep npm test`; then `npx vitest run -t "must fail"` and confirm each unsafe outcome in plan.md "Proofs"
- [X] T058 Before committing, scan the diff (`git diff --cached`, every file under `specs/019-loopback-pkce-sign-in/`, `auth0/`, `src/`, `test/`, `docs/`, `env/`) for secrets and tokens (`gitleaks` or a grep for `eyJ`, `sk_`, `rk_`, `-----BEGIN`); stage no `.env`, tfvars, state or `.local/` file
- [ ] T059 On the operator's host (the VPS), `npm run auth0:tenant -- plan`: the plan adds `auth0_client.desktop` and `auth0_client_credentials.desktop`, updates `auth0_action.sign_in_time` and the connections' application lists, and changes the outputs, and nothing else; then `npm run auth0:tenant -- apply`; copy `l1_env`'s `AGENT_CLIENT_IDS` and `AGENT_DESKTOP_CLIENT_ID` to the VPS agent's `env/l1-hosted.env` and `l2_env`'s `AGENT_CLIENT_IDS` to L2's `env/l2-control.env`; restart L2, then the agent (quickstart §4)
- [ ] T060 Run the live check, quickstart §5 (`specs/019-loopback-pkce-sign-in/quickstart.md`) L1–L18, from the owner's computer with one test person (second factor enrolled, account at the portal, role `x402-agent`), with L17 putting the desktop client back on both lists and L18's log scan on the VPS last, printing counts only; record each result, the consent screen (L12) and the refused-renewal error (L7, role removal) in the quickstart's Validation log; delete `.local/desktop.*` and revoke the test person's refresh tokens
- [ ] T061 If T060's L7 shows `event.authorization.roles` empty on a renewal (every renewal refused), apply plan.md "Risks" fallback: in `auth0/sign-in-time.js` skip check 1 on `oauth2-refresh-token`, update T019's renewal cases, amend spec.md US2 scenario 4 and FR-006 ("no run", not "no token") and SPEC's §3.3; re-run T057 and L7. If L9 shows the tenant ignoring `pkce_required`, stop and report it as a finding before rollout
- [ ] T062 Mark `specs/019-loopback-pkce-sign-in/spec.md` Status as Implemented with the date and the live check's date

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: T001 first (needs both dependencies merged); T002 after T001; T003 and T004 in parallel with T002. T002 and T003 are written apart and committed together.
- **Foundational (Phase 2)**: after Setup; T005 first (the contract field); T006, T007, T008 in parallel; T009 after T008.
- **US1 (Phase 3)**: after Foundational.
- **US3 (Phase 4)**: after US1 (its rule recognizes the desktop client by the marker T014 adds).
- **US2 (Phase 5)**: after US1 (the refresh block T014 adds); independent of US3.
- **US4 (Phase 6)**: after Foundational; independent of US1–US3 (the dev issuer's desktop client is enough).
- **US5 (Phase 7)**: after Foundational; independent. Shares `requester-auth.ts` with US6 and `server.ts` with US2, US4, US6, US7: do those edits one story at a time.
- **US6 (Phase 8)**: after Foundational; independent.
- **US7 (Phase 9)**: after Foundational; its config check needs nothing else.
- **Polish (Phase 10)**: after the stories wanted; T059–T061 on the operator's host after T057 and T058, and after the branch is merged or deployed to the VPS.

### User story dependencies

- **US1 (P1)**: none beyond Foundational.
- **US3 (P1)**: US1 (the desktop client and its marker).
- **US2 (P1)**: US1 (the refresh settings).
- **US4 (P2)**, **US5 (P2)**, **US6 (P3)**, **US7 (P3)**: none beyond Foundational; they touch the agent only (US4 also L2).

### Within each story

- Tests first, failing; then the code; then the story's run command.
- L2 before L1 in US4 (T033–T035 before T036–T039): the agent's mapping reads L2's new code and field.
- One edit of a shared file at a time: `src/layer1-intent/hosted/server.ts` (T026, T037, T042, T046, T050), `src/layer1-intent/hosted/requester-auth.ts` (T042, T046), `docs/l1-hosted.openapi.yaml` (T039, T043, T051), `auth0/main.tf` (T014, T015, T022), `test/auth0-iac.test.ts` (T010, T011, T019, T020, T024).

### Parallel opportunities

- Setup: T003, T004 beside T002.
- Foundational: T006, T007, T008.
- US1 tests: T010–T013 are in different files except T010/T011 (same file: write them together); T017 beside T014–T016.
- US4 tests: T028/T029 (same file, together), T030, T031, T032 in parallel; T035 and T039 beside the code tasks.
- After Foundational, US4, US5, US6 and US7 can proceed in parallel with US1–US3 if their shared-file edits are sequenced.

---

## Parallel Example: User Story 4

```bash
# Tests first, together:
Task: "T028+T029 T-CTK-10, row 6 and T-CTK-11 in test/caller-token.test.ts"
Task: "T030 T-AGT-17 in test/hosted-account.test.ts"
Task: "T031 T-E2E-16 rewrite in test/e2e.local.test.ts"
Task: "T032 check_budget drops account in test/hosted-agent.test.ts"

# Then L2, with its OpenAPI beside it:
Task: "T033 row 6 code in src/layer2-control/caller.ts"
Task: "T034 account on the budget user view in src/layer2-control/service.ts"
Task: "T035 docs/l2-control.openapi.yaml"
```

## Parallel Example: User Story 1

```bash
Task: "T010+T011 the desktop client and its connections in test/auth0-iac.test.ts"
Task: "T012 T-IAC-01 in test/infra.test.ts"
Task: "T013 019 US1 in test/hosted-desktop.test.ts"
# Then:
Task: "T014–T016 auth0/main.tf and auth0/outputs.tf"
Task: "T017 infra/ parameter files and modules"
```

---

## Implementation Strategy

### MVP first (User Stories 1, 3 and 2)

1. Phase 1 (rebase, SPEC, constitution) and Phase 2 (contract field, dev client, helpers).
2. US1: the desktop client exists and its tokens run.
3. US3: only people with the role, S256 and a second factor get one.
4. US2: renewals proven; limits per person.
5. **Stop and validate**: `npm run check`, then on the operator's host T059 and quickstart §5 L1–L4, L6–L10, L12, L14–L18.

US1 alone must not reach the tenant: without US3 the tenant would issue a desktop token without PKCE. Deploy US1
and US3 together.

### Incremental delivery

1. MVP (US1 + US3 + US2) → apply the tenant, update the VPS's lists, live check.
2. US4 → a person without an account gets 409 (L11).
3. US5 → readable 401 (L5, L6 with codes).
4. US6 → the client in the log.
5. US7 → the settings route (L13).

Each story leaves `npm run check` green and the demo's summary unchanged.

---

## Notes

- [P] tasks = different files, no dependency on an unfinished task.
- [Story] maps a task to its user story for traceability.
- Commit after each task or logical group, never with a token, a tfvars file, state or `.local/` in it.
- T059–T061 change the live tenant and the VPS: an operator runs them by hand, on the operator's host.
