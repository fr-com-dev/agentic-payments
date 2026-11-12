---

description: "Task list for 013: the L2 web portal, user wallets and expense policies"
---

# Tasks: L2 Web Portal: Onboarding, Profile, Wallet and Expense Policies

**Input**: Design documents from `specs/013-l2-portal-onboarding/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md) (R1–R18)
- [data-model.md](data-model.md)
- [contracts/](contracts/): control-api, portal-api, portal-ui, card-vault and config-and-secrets
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII requires a test for every rule, route and contract
field, plus the ten must-fail proofs in plan.md "Proofs".
- **Test IDs.** Each test title carries its ID (T-USR-01..12, T-POL-16..19, T-LED-06, T-PRT-01..09, T-WEB-01..08,
  T-CARD-01..06, T-AGT-06..07, T-API-12..15, T-E2E-12..13, T-ARCH-A10..A12) or `013 USn …`.
- **Order.** Write each story's tests first and confirm they fail before implementing.
- **Switches.** Every must-fail switch (`skipOwnershipCheck`, `sharedSigner`, `sharedBudgets`, `skipPlatformBound`,
  `skipUserCeiling`, `skipUserGate`, `fallbackToPlatform`, `skipSellerOverlapCheck`, `unserializedUserWrites`,
  `bypassAuth`) is a test-only dep, never an environment variable.
- **Clock.** Tests pass `now` as a dep; nothing in a test sleeps to cross 15 minutes or 24 hours.

**Organization**: tasks are grouped by user story (US1–US8 from spec.md). The stories build on one another in
priority order (a wallet needs a profile; a policy needs a wallet), so "independent" here means each story can be
checked on its own once the ones before it are done.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel: a different file, and no dependency on an incomplete task.
- **[Story]**: the user story the task belongs to (US1–US8).

## Path Conventions

- Single repository: `src/`, `web/`, `scripts/`, `test/`, `docs/`, `infra/`, `config/`, `env/` at the root (plan.md
  "Project Structure").
- L2's new code stays in `src/layer2-control/`. The portal's server code is `src/portal/` (entry point
  `src/portal-main.ts`); it imports only `src/shared/` and itself. Browser code is `web/portal/`.
- Only `src/layer2-control/signer.ts` names `USER_WALLET_MNEMONIC` in runtime code (rule A11). Only
  `src/portal/card-vault.ts` names `CARD_VAULT_KEY` (rule A10).
- **Docs in step.** Any task that adds or changes an L2 route also updates `docs/l2-control.openapi.yaml` and the
  SPEC L2-5 table in the same task, because T-API-01..04 fail otherwise. The same holds for a portal route and
  `docs/portal.openapi.yaml` (T-API-12..15) once T034 exists.
- **Off by default.** Until a test or a flag turns user accounts on, every existing test and `npm run demo:local`
  must stay green after every task.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: the contract fields, identifiers, roles, entry types, config files, packages and dev tooling that
later phases compile against.

- [X] T001 [P] Extend src/shared/contracts.ts per contracts/control-api.md "§7":
  - `PaymentIntent.userId?: string` with the comment from the contract (`^usr_[0-9a-f]{32}$`; set by the hosted agent service only);
  - `BudgetStatus.scope?: "session" | "user_daily"`;
  - `AuthorizationGatePort.budget(sessionId: string, userId?: string)`;
  - new exported types `PolicyValues` (`sellers: string[]`, `autoApproveMaxAtomic`, `hardCapPerPaymentAtomic`, `sessionBudgetAtomic`, `dailyBudgetAtomic` as strings, `maxAuthorizationsPerMinute: number`, `expiresAt: string`, `paymentMethod: "crypto_account"`), `PolicyIssue` (`{ field: string; code: string; host?: string; policyId?: string; limitAtomic?: string; limit?: number }`), `PolicyVersion`, `PolicyView`, `UserView`, `PlatformView`, exactly as data-model.md "Views" and "Platform configuration" list their fields.

  Make no behavior change; `npm run typecheck` stays green.
- [X] T002 [P] Create src/shared/user-id.ts: `USER_ID_RE = /^usr_[0-9a-f]{32}$/` and `userIdFor(tid: string, oid: string): string` returning `usr_` + the first 32 hex characters of SHA-256 over the UTF-8 string `x402-user-v1|<tid>|<oid>` (data-model.md "Identifiers"). Pure; imports only `node:crypto`. Add test/user-id.test.ts (`013 shared userIdFor`): deterministic, different for a different `tid` or `oid`, matches `USER_ID_RE`, and a fixed vector computed once and pinned.
- [X] T003 [P] Extend src/shared/config.ts:
  - `Role` gains `"portal-control"`; `ROLE_TOKEN_VAR["portal-control"] = "PORTAL_TOKEN"`; `DEV_TOKENS.PORTAL_TOKEN = "dev-portal-token"`;
  - `EnvRole` gains `"portal"` (file `env/portal.env`); `DEFAULT_PORTS.portal = 4025`; `portalPort(env)` reading `PORTAL_PORT`; `PORTAL_BIND_HOST_DEFAULT = "127.0.0.1"`;
  - `parseUsdc(text: string, decimals: number): string | { error: "not_a_number" | "too_many_decimals" | "negative" }` beside `formatAtomic`: accepts `^\d+(\.\d+)?$` after trimming, refuses more than `decimals` fraction digits (never rounds), returns the atomic string with no leading zeros (`"0"` for zero), `BigInt` only.

  Add tests to test/user-id.test.ts (`013 shared parseUsdc`): `0.02`→`20000`, `1`→`1000000`, `0.000001`→`1`, `0.0000001`→`too_many_decimals`, `-1`, `1e3`, `abc`, empty → errors; round-trip with `formatAtomic`.
- [X] T004 [P] Extend `EntryType` in src/layer2-control/ledger.ts with the 12 types of data-model.md "New entry types" (`PLATFORM_CONFIG`, `USER_REGISTERED`, `WALLET_CREATED`, `CARD_ADDED`, `CARD_REMOVED`, `POLICY_CREATED`, `POLICY_CHANGED`, `POLICY_PAUSED`, `POLICY_RESUMED`, `POLICY_REMOVED`, `USER_DISABLED`, `USER_ENABLED`) under a `// 013 user accounts (L2-8)` comment. No other change in this task.
- [X] T005 [P] Create config/platform.json with exactly the JSON of data-model.md "Platform configuration" (`platformId: "platform-poc-001"`; limits `100000`, `100000`, `500000`, `10`, `365`; one seller `127.0.0.1:4021`, name `Local demo seller`, `payees: []`).
- [X] T006 Update the env templates and their allow-list (contracts/config-and-secrets.md "CFG-2"):
  - env/l2-control.env.example: after the CIBA block, a commented block `# optional, 013 user accounts (L2-8); off unless USER_ACCOUNTS=1` with `# USER_ACCOUNTS=`, `# PORTAL_TOKEN=`, `# USER_WALLET_MNEMONIC=`, `# PLATFORM_FILE=`, `# PLATFORM_SELLERS=`, every value empty;
  - env/portal.env.example (new): `NETWORK=local`, `CONTROL_URL=http://127.0.0.1:4020`, `PORTAL_TOKEN=`, `AUTH_TENANT_ID=dev`, `AUTH_AUDIENCE=api://x402-l1-agent`, `PORTAL_CLIENT_ID=x402-portal-dev`, `AUTH_JWKS_FILE=.local/dev-issuer/jwks.json`, and commented `# PROFILE_DIR=`, `# CARD_VAULT=`, `# CARD_VAULT_KEY=`, `# CARD_VAULT_PUBLISHABLE_KEY=`, `# BASE_SEPOLIA_RPC_URL=`, `# PORTAL_PORT=`, `# PORTAL_BIND_HOST=`, `# API_DOCS=`;
  - env/l1-hosted.env.example: commented `# PORTAL_CLIENT_ID=`;
  - test/architecture.test.ts `TEMPLATES`: add `portal`; add the five names to `l2-control`'s optional list and `PORTAL_CLIENT_ID` to `l1-hosted`'s; change the "7 of 7" title to 8; extend the must-be-empty pattern with `_MNEMONIC$` and `^CARD_VAULT_KEY$`.
- [X] T007 Add the web toolchain (plan.md "Technical Context", research R10):
  - package.json devDependencies, pinned to the current stable versions at install time: `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `@azure/msal-browser` (5.x), `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/dom`, `axe-core`. Nothing is added to `dependencies`;
    *(Done without `@vitejs/plugin-react`: Vite 8 compiles JSX itself for the build and for vitest, so the plugin, which only adds dev-server fast refresh, was left out to keep one package fewer.)*
  - scripts: `"portal": "tsx src/portal-main.ts"`, `"build:web": "vite build --config web/portal/vite.config.ts"`, `"fund-user": "tsx scripts/fund-user.ts"`, `"wallet-mnemonic": "tsx scripts/wallet-mnemonic.ts"`, and `typecheck` becomes `tsc --noEmit && tsc --noEmit -p web/portal/tsconfig.json`;
  - web/portal/tsconfig.json: strict, `jsx: "react-jsx"`, `lib: ["ES2023","DOM","DOM.Iterable"]`, `moduleResolution: "Bundler"`, `noEmit`, includes `web/portal/src` and `web/portal/test`; the root tsconfig.json keeps excluding `web/`;
  - web/portal/vite.config.ts: root `web/portal`, two inputs (`index.html`, `redirect.html`), `build.outDir` `../../dist/portal-web`, the React plugin;
  - vitest.config.ts: tests under `web/portal/test/**` run in the `jsdom` environment with JSX enabled; every other test keeps the node environment and the decorator plugin unchanged.

  Run `npm install` (not `npm ci`), then `npm run typecheck` and `npm test`: both green with no web source yet (add a placeholder `web/portal/src/main.tsx` that renders nothing).
- [X] T008 [P] Extend scripts/dev-issuer-lib.ts and scripts/dev-token.ts (research R17):
  - token claims gain optional `scp`, `azp`, `auth_time`; a default (non-service) token now carries `scp: "user_impersonation"` and `idtyp: "user"`;
  - `--portal` issues `scp: "Portal.Access"`, `azp: "x402-portal-dev"`, `idtyp: "user"`, `auth_time: now`; `--auth-age <seconds>` backdates `auth_time`; `--service` is unchanged (`idtyp: "app"`, no `scp`).

  Update test/helpers/hosted.ts if it builds tokens through these functions, so every existing hosted test stays green.
- [X] T009 [P] Add the `--users` option to the local stack (research R17) in scripts/demo-lib.ts and scripts/stack-local.ts: with it, L2's child env gets `USER_ACCOUNTS=1` and `USER_WALLET_MNEMONIC` set to a fixed development mnemonic constant `DEV_USER_WALLET_MNEMONIC` (a valid 24-word BIP-39 phrase, different from the chain's mnemonic, declared in scripts/demo-lib.ts with the comment `// local development only`). Without the flag nothing changes; scripts/demo-local.ts never passes it.
- [X] T010 [P] Create scripts/fund-user.ts (`npm run fund-user -- <address> [usdc=1]`): local network only (exit 2 with a usage line otherwise); mints MockUSDC to the address through the local deployment in `.local/deployment.json`, parsing the amount with `parseUsdc`; prints the new balance in atomic units. Reuse the minting helper scripts/local-chain-lib.ts already has; add one there if it does not exist.
- [X] T011 [P] Create scripts/wallet-mnemonic.ts (`npm run -s wallet-mnemonic`): prints exactly one new 24-word mnemonic (`generateMnemonic(english, 256)` from `viem/accounts`) and a newline, nothing else; reads no env file and derives no account. Header comment: the output is a secret; pipe it into the vault, never into a file in the repository.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: L2's user-account core (filters, platform config, derived state, keyring, startup, the portal role),
the shared token verifier, and the portal and web skeletons.

**⚠️ CRITICAL**: no user story work can begin until this phase is complete.

### L2 core

- [X] T012 Write T-LED-06 in test/ledger.test.ts first (it must fail): each of the 12 new entry types appends, hashes and verifies; `committedAtomic({ userId: "usr_…" })` counts only that user's `AUTHORIZED` entries (`data.userId`), `{ userId: null }` counts only entries without `data.userId`, an omitted `userId` counts all (today's behavior); `policyId` narrows further; the same for `authorizedSince(sinceMs, filter)`; a user's entries never change the platform account's figures and the reverse.
- [X] T013 Implement the filters in src/layer2-control/ledger.ts: `committedAtomic(filter: { sessionId?; sinceMs?; userId?: string | null; policyId?: string }, nowMs)` and `authorizedSince(sinceMs, filter?: { userId?: string | null; policyId?: string })`, reading `e.data.userId` and `e.data.policyId`. Existing callers pass no new field and keep their results. T012 passes.
- [X] T014 Write the platform-config tests in test/users.test.ts (`T-USR-07 platform config`, must fail): the checked-in config/platform.json loads; each rule of data-model.md "Platform configuration" is enforced with an error naming the field (`limits.*Atomic` not `^\d+$`; `hardCapPerPaymentAtomic > sessionBudgetAtomic`; `maxAuthorizationsPerMinute` outside 1–600; `maxPolicyDays` outside 1–3650; a duplicate or malformed `host`; more than 200 sellers; a `name` outside 1–60 characters; a payee that is not an address); `PLATFORM_SELLERS` replaces `sellers`; payees are lower-cased; the digest is stable under key order and changes with any value.
- [X] T015 Create src/layer2-control/platform.ts: `PlatformConfig` type, `loadPlatform(env, file = env.PLATFORM_FILE ?? "config/platform.json")`, `buildPlatform(json, env)` (pure), `platformDigest(config)` (SHA-256 of `canonicalJSON`), `PlatformError`. T014 passes.
- [X] T016 Write the user-state tests in test/users.test.ts (`T-USR-09 user state`, must fail), over hand-built entry arrays: `registered`, `enabled` (last of `USER_DISABLED`/`USER_ENABLED`), `wallet`, `cards` (added minus removed, in order), `onboarded` = registered && wallet && at least one `POLICY_CREATED` ever (still true after every policy is removed); an unknown user is all-false with empty lists; one user's entries never appear in another's state.
- [X] T017 Create src/layer2-control/users.ts with the constants of data-model.md "Constants" (`MAX_ACTIVE_POLICIES = 10`, `MAX_SELLERS_PER_POLICY = 20`, `MAX_CARDS = 5`, `STEP_UP_MAX_AGE_MS = 900_000`, `STEP_UP_TOLERANCE_MS = 60_000`, `TERMS_VERSION = "test-funds-v1"`), the `UserState` and `PolicyState` types, and the pure functions `userState(entries, userId, nowMs)`, `userGate(state)` (`"not_onboarded"` when `!onboarded`, else `"disabled"` when `!enabled`, else `undefined`) and `userView(state, figures)`. No I/O, no clock read. T016 passes. Policy functions are added by later tasks.
- [X] T018 Add the keyring to src/layer2-control/signer.ts (research R3) with its tests in test/users.test.ts (`T-USR-08 keyring`):
  - `class WalletKeyring { constructor(mnemonic: string, net); addressOf(index: number): string; signerFor(index: number, hardCapAtomic: string): PaymentSignerLike }`, using `mnemonicToAccount(mnemonic, { addressIndex: index })` and the same SDK spend controls as `PaymentSigner`;
  - `keyringFromEnv(env, net): WalletKeyring` reading `USER_WALLET_MNEMONIC`, throwing an error that names the variable and never its value when it is missing or not a valid 24-word BIP-39 phrase;
  - tests: two indexes give two addresses; the same index is stable; an invalid phrase is refused without echoing it; a signature from `signerFor(i, cap)` has `payer === addressOf(i)`.
- [X] T019 Wire user accounts into src/layer2-control/service.ts (contracts/config-and-secrets.md "CFG-2" startup order) with tests in test/users.test.ts (`T-USR-07 startup`, `T-USR-08 addresses`):
  - `ControlServiceDeps.users?: { platform: PlatformConfig; keyring: WalletKeyring; tokens?: { portal?: string }; /* test-only switches added by later tasks */ }`; absent means off;
  - `userAccountsFromEnv(env, net)` (exported from service.ts): off unless `USER_ACCOUNTS === "1"`, in which case it returns `{ ignored: string[] }` listing which of `PORTAL_TOKEN`, `USER_WALLET_MNEMONIC`, `PLATFORM_FILE`, `PLATFORM_SELLERS` are set; on, it resolves the portal token with `tokenFor("portal-control")`, refuses when it equals any other role's token, loads the platform config and the keyring;
  - `main()`: call it **before** `acquireLedgerLock`; after the ledger loads, compare `keyring.addressOf(walletIndex)` with every `WALLET_CREATED` address and throw `user wallet mnemonic does not match the ledger` on any difference; append `PLATFORM_CONFIG` (`platformId, digest, limits, sellers`) when the digest differs from the last recorded one; log `user accounts on (platform <platformId>, <n> sellers)` or the ignored names, never a value;
  - tests: on without a token, a mnemonic or a valid platform file refuses, naming the setting only; equal tokens refused; off ignores them; a changed mnemonic refuses after the ledger loads; `PLATFORM_CONFIG` is written once per digest.
- [X] T020 Create src/layer2-control/user-routes.ts and mount it from service.ts only when `deps.users` is present; write its tests first in test/users.test.ts (`T-USR-02`, `T-USR-06`, and the two read routes of `T-USR-01`):
  - `mountUserRoutes(app, { ledger, serialize, now, users, mandate, net })`, every route behind `requireRole("portal-control", …)`; `:userId` must match `USER_ID_RE` (400);
  - `GET /v1/platform` → `PlatformView`; `GET /v1/users/:userId` → `UserView` (an unknown user: `registered: false`, empty lists, never 404);
  - src/shared/auth.ts `ENDPOINT_ROLES` gains both routes;
  - tests: the portal token is refused (401) on `/v1/authorize`, `/v1/budget/x`, `/v1/reconcile`, `/v1/approvals/x`, `/v1/rejections/x`, `/v1/escalations`, `/v1/escalations/events`, `/v1/ledger/verify`; the control, settlement and operator tokens are refused on both new routes; 401 precedes 400; with `users` absent both routes are 404 and an intent carrying a well-formed `userId` gets the same decision and ledger entries as one without;
  - add both routes to docs/l2-control.openapi.yaml (a `portalToken` security scheme, the `PlatformView` and `UserView` schemas) and to the SPEC L2-5 table, so T-API-01..04 stay green.
- [X] T021 [P] Extend test/helpers/harness.ts with `users?: { platform?: Partial<PlatformConfig>; mnemonic?: string; switches?: object }` (default off) and create test/helpers/users.ts: a fixed test mnemonic, `TOKENS.portal`, `testPlatform(overrides)`, and helpers that drive the portal routes (`register(userId)`, `createWallet(userId)`, `createPolicy(userId, values, opts)`, `fund(address, atomic)` on the local chain) for later tests.

### Shared token verification

- [X] T022 Move token verification to src/shared/entra-token.ts (research R2): `DEV_ISSUER`, `DEV_TENANT`, `keysFor({ tenantId, jwksFile? })`, and `verifyEntraToken(token, { tenantId, audience, issuer, keys, clockToleranceSec = 60 })` returning the claims after checking signature, `iss`, `aud`, `exp`/`nbf`, `tid` and a non-empty `oid`, or a typed failure. Rebuild src/layer1-intent/hosted/requester-auth.ts on it with identical behavior (same statuses, same `Requester`), and re-export or re-import the dev constants in src/layer1-intent/hosted/config.ts. Every test in test/hosted-access.test.ts, test/hosted-run.test.ts and test/hosted-sessions.test.ts passes unchanged.

### Portal skeleton

- [X] T023 Create src/portal/config.ts and src/portal-main.ts with tests in test/portal.test.ts (`T-PRT-09`, must fail first):
  - `loadPortalConfig(env)`: the variables of contracts/config-and-secrets.md "`env/portal.env`"; `AUTH_JWKS_FILE` only with `NETWORK=local`; off `local`, `AUTH_AUDIENCE` and `PORTAL_CLIENT_ID` must be GUIDs; `CARD_VAULT` is `stripe` or unset (the key checks arrive in T080); errors name the variable only;
  - src/portal-main.ts: `loadEnv("portal")`, then exit 1 with the refusal text if `PAYER_PRIVATE_KEY` or `USER_WALLET_MNEMONIC` is visible, before any other import (dynamic imports, as src/hosted-main.ts does); then build and listen on `PORTAL_BIND_HOST:PORTAL_PORT`; SIGTERM and SIGINT close the server;
  - tests: each config error; a child-process test that the entry point exits 1 with each key name in its environment and prints no value.
- [X] T024 Create src/portal/access.ts with tests in test/portal.test.ts (`T-PRT-01`, must fail first): Express middleware built on `verifyEntraToken` that applies, in order, each row of contracts/portal-api.md "Access" (401 for signature, `iss`, `aud`, `tid`/`oid`, validity and a missing or future `auth_time`; 403 for `idtyp !== "user"`, `scp` without `Portal.Access`, `azp !== PORTAL_CLIENT_ID`, `roles` without `Agent.Run`), sets `res.locals.person = { userId: userIdFor(tid, oid), identityConfirmedAtMs: auth_time * 1000 }`, and deletes the `Authorization` header. Bodies are exactly `{ "error": "unauthorized" }` and `{ "error": "forbidden" }`. Tests cover every row with dev tokens, including a default agent token (403) and a `--service` token (403), and assert 0 calls to the L2 client fake and no file written on every refusal. **Must fail**: with the test-only dep `bypassAuth`, an agent-service token reaches a route.
- [X] T025 [P] Create src/portal/control-client.ts: `ControlClient(baseUrl, portalToken, fetchImpl = fetch)` with one method per route of contracts/control-api.md "Portal routes" (added as the routes arrive; start with `platform()` and `user(userId)`), 5 s timeout, no redirects; a non-2xx becomes `ControlError { status, body }` where `body` is the parsed JSON when it is one of the documented error shapes; a network error or timeout becomes `ControlUnavailable`. It is the only file in src/portal/ that knows L2's paths.
- [X] T026 Create src/portal/log.ts and src/portal/server.ts with tests in test/portal.test.ts (`T-PRT-07`, and the `/api/config` row of `T-PRT-01`), and the helper test/helpers/portal.ts:
  - `createPortalApp(deps: { config; keys; control; profiles; balance; cards?; now?; log?; bypassAuth? })` → `{ app, markReady }`;
  - `GET /healthz`, `GET /readyz`; `GET /api/config` (no token) returning the public values of contracts/portal-api.md; `access` on every other `/api` route; JSON bodies at most 16 KB (413), unknown fields 400; 120 requests per minute per `userId` (429 with `Retry-After`); `ControlUnavailable` → 502 `{ "error": "control_unavailable" }`;
  - the headers of contracts/portal-api.md "Limits and headers" on every response, `Cache-Control: no-store` on `/api`, and the `/redirect.html` exception;
  - static files from `dist/portal-web` when the directory exists; any other non-`/api` GET returns `index.html`;
  - src/portal/log.ts: one JSON line per request with `time, route (template), status, userId?, ms` and nothing else;
  - test/helpers/portal.ts: `startPortal({ l2: harness | fake, vault?: stub, balance?: fake })` returning the app, tokens for named subjects and the captured log lines.
- [X] T027 Extend test/architecture.test.ts (contracts/config-and-secrets.md "§4.1") with fixtures test/fixtures/arch/a11-violation.ts and a12-violation.ts:
  - a new area `PORTAL` = `src/portal/**` in `classify` and `LAYERS`, so A1 applies both ways (the portal imports only `src/shared` and itself; no layer imports the portal);
  - A4's scope gains `src/portal/**`;
  - **A11**: `/\bUSER_WALLET_MNEMONIC\b/` allowed only in `src/layer2-control/signer.ts`, `src/portal-main.ts`, `scripts/demo-lib.ts` and `env/l2-control.env.example`;
  - **A12**: `/\bPORTAL_TOKEN\b/` forbidden in `src/layer1-intent/**`, `src/layer3-settlement/**`, `src/counterparty/**`; `/\b(?:PAYER_PRIVATE_KEY|CONTROL_TOKEN|OPERATOR_TOKEN|SETTLEMENT_TOKEN|VERIFIER_TOKEN)\b/` forbidden in `src/portal/**`;
  - each rule: a fixture that trips only it, a "repository is clean" walk, and a "not vacuous" check; extend the `Rule` union. (A10 arrives with the card vault, T081.)

### Web skeleton

- [X] T028 Create the web app shell in web/portal/ (contracts/portal-ui.md "Screens"): `index.html`, `redirect.html` (loads only the sign-in library's redirect bridge), `src/main.tsx`, `src/app.tsx`, `src/routes.ts` (a route table over the History API, no router package; a `firstStepNotDone(onboarding)` function used for redirects), `src/api.ts` (one function per portal route, attaching the bearer token, mapping error bodies to typed results), `src/styles.css`. `npm run build:web` produces `dist/portal-web/index.html` and `redirect.html`.
- [X] T029 [P] Create the auth adapters in web/portal/src/auth/ (research R2, R5): an `Auth` interface (`signIn()`, `token()`, `confirmIdentity()`, `account()`), `entra.ts` (`@azure/msal-browser`: authority `https://login.microsoftonline.com/<tenantId>`, scope from `/api/config`, `cacheLocation: "sessionStorage"`, redirect URI `<origin>/redirect.html`; `confirmIdentity()` is an interactive request with `prompt: "login"`), `dev.ts` (a pasted token kept in memory; `confirmIdentity()` asks for a new one), and `stepUp.ts` (`withStepUp(call)`: on a `step_up_required` result, `confirmIdentity()` then replay once). The adapter is chosen from `/api/config` `auth.mode`.
- [X] T030 [P] Create web/portal/src/money.ts and web/portal/test/money.test.ts (`T-WEB-03`): `parseUsdcInput(text, decimals)` and `formatUsdc(atomic, decimals)` with the same rules and vectors as `parseUsdc`/`formatAtomic` in T003 (6 decimals accepted, 7 refused, no rounding, `BigInt` only, round-trip). No `Number` arithmetic on amounts anywhere in web/portal/src.
- [X] T031 [P] Create the shared components in web/portal/src/components/ with web/portal/test/components.test.tsx: `Field` (visible label, `aria-describedby` for help and error), `AmountField`, `ErrorSummary` (`role="alert"`, takes focus, links to fields), `Dialog` (focus trap, Escape closes, returns focus), `Banner`, `StatusLabel` (text, never color alone). Tests: labels are associated, the summary takes focus, the dialog traps focus and closes on Escape.

**Checkpoint**: `npm run typecheck`, `npm test` and `npm run demo:local` are green with user accounts off. L2 with `users` set serves two read routes to the portal role only; the portal answers `/api/config` and refuses everything else correctly.

---

## Phase 3: User Story 1 - A new user signs in and creates their profile (Priority: P1) 🎯 MVP

**Goal**: a person with `Agent.Run` signs in, sees the three onboarding steps, saves a profile with the
test-funds acknowledgement, and finds it again later. A person without the permission is refused and leaves no
record.

**Independent Test**: spec.md US1 "Independent Test"; quickstart.md §2 steps 1–3.

### Tests for User Story 1 (write first; they must fail)

- [X] T032 [P] [US1] In test/users.test.ts (`T-USR-01 registration`, `T-USR-04 registration`): `PUT /v1/users/:userId/registration` with `{ acknowledgedTestFunds: true }` appends one `USER_REGISTERED` (`userId, acknowledgedTestFunds: true, termsVersion: "test-funds-v1"`) and returns the `UserView` with `registered: true`; a second call appends nothing; a body without the flag, or with `false`, is 400 and appends nothing; 401 before 400.
- [X] T033 [P] [US1] In test/portal.test.ts (`T-PRT-03`): `GET /api/me` for a new person is `{ userId, enabled: true, onboarding: { profile: false, wallet: false, policy: false } }` with no `profile`; `PUT /api/profile` refuses (422 `invalid_profile`, issues by field) a `displayName` outside 1–80 characters after trimming or containing a control character, a `contactEmail` without exactly one `@` and a dot in the domain or longer than 254 characters, and a first save without `acknowledgedTestFunds: true`; a valid first save writes the file then registers at L2; a later edit writes the file and makes 0 calls to L2's write routes; a person without `Agent.Run` gets 403 and no file exists afterwards; with L2 down the first save answers 502, and `/api/me` then shows the profile step as not done.
- [X] T034 [P] [US1] Create docs/portal.openapi.yaml (OpenAPI 3.1: the bearer scheme, `/api/config`, `/api/me`, `/api/profile`, their schemas and error bodies) and test/openapi-portal.test.ts (`T-API-12..15`), modeled on test/openapi-hosted.test.ts: the document's paths, methods, statuses and schemas match the routes `createPortalApp` mounts; every `/api` route except `/api/config` requires the scheme; Swagger UI and `/openapi.yaml` exist only with `apiDocs: true`. It fails until T037 mounts the routes.
- [X] T035 [P] [US1] In web/portal/test/onboarding.test.tsx (`T-WEB-01`, `T-WEB-02`): with a fake API, a new person lands on the profile step with the three steps shown and none done; a person with a profile lands on the wallet step; a deep link to `/policies` redirects to the first step not done; name and email are prefilled from the sign-in; Save is disabled until both fields are valid and the box "I understand this wallet holds test funds only" is ticked; a 403 from the API shows the refusal text of contracts/portal-ui.md and no form.

### Implementation for User Story 1

- [X] T036 [US1] Add `PUT /v1/users/:userId/registration` to src/layer2-control/user-routes.ts (inside `serialize`), its `ENDPOINT_ROLES` entry, its `ControlClient.register(userId)` method in src/portal/control-client.ts, and its row in docs/l2-control.openapi.yaml and the SPEC L2-5 table. T032 passes.
- [X] T037 [US1] Create src/portal/profile-store.ts and src/portal/routes.ts, and mount the routes in src/portal/server.ts:
  - `ProfileStore(dir)`: `get(userId)`, `put(userId, profile)` writing `<dir>/<userId>.json` through a temporary file and a rename with mode 0600; the path is built only from a value that matches `USER_ID_RE` (anything else throws); fields exactly as data-model.md "Profile store" (`userId`, `displayName`, `contactEmail`, `policyNames`, `cardVaultCustomer?`, `updatedAt`);
  - `GET /api/me` and `PUT /api/profile` per contracts/portal-api.md, with the order of writes "write the profile file, then `PUT …/registration` at L2";
  - src/portal/api-docs.ts and the `apiDocs` dep, mounting `/docs`, `/docs/:asset` and `/openapi.yaml` through src/shared/api-docs.ts.

  T033 and T034 pass.
- [X] T038 [US1] Build the screens in web/portal/src/screens/: `Home.tsx` (the three steps with done/next; opens on the first step not done), `ProfileStep.tsx` and `Profile.tsx` (one form component, prefill from the sign-in's account, the required acknowledgement on the first save only), and `SignedOut.tsx` (sign-in button; the 403 text). Wire them in `routes.ts`. T035 passes.

**Checkpoint**: US1 works end to end against a local L2 with `--users`: quickstart.md §2 steps 1–3.

---

## Phase 4: User Story 2 - The user creates their crypto account and funds it (Priority: P1)

**Goal**: one crypto account per user, created idempotently inside L2's signer; the wallet shows the address, the
on-chain balance with its read time, the committed amount and the last 24 hours' spending. No key is ever shown.

**Independent Test**: spec.md US2 "Independent Test"; quickstart.md §2 steps 4–5.

### Tests for User Story 2 (write first; they must fail)

- [X] T039 [P] [US2] In test/users.test.ts (`T-USR-01 wallet`, `T-USR-04 wallet`): `PUT /v1/users/:userId/wallet` for a registered user appends one `WALLET_CREATED` (`userId, walletIndex, address, network`) where `walletIndex` is the count of earlier `WALLET_CREATED` entries and `address === keyring.addressOf(walletIndex)`; ten concurrent calls for one user append exactly one entry and return one address; two users get indexes 0 and 1 and different addresses; an unregistered user is 409 `not_registered`; the `UserView.wallet` figures (`committedAtomic`, `spent24hAtomic`, `dailyCeilingAtomic`, `dailyRemainingAtomic`) are `"0"`, `"0"`, the platform ceiling and the ceiling for a fresh wallet.
- [X] T040 [P] [US2] In test/portal.test.ts (`T-PRT-04`): `GET /api/wallet` without a profile is 409 `profile_required`; `PUT /api/wallet/account` creates the account and a second call returns the same address; the wallet view carries `balanceAtomic` and `balanceReadAt` from the fake reader; a second read within 20 s does not call the reader again, one after 20 s does; when the reader throws, the last value comes back with `balanceStale: true` and the L2 figures are still present; `lowBalance` is false with no policy; no response contains the test mnemonic or any 64-hex string.
- [X] T041 [P] [US2] In web/portal/test/wallet.test.tsx (`013 US2 web`): the wallet step shows one button, then the address with a copy control, the network, the asset, the balance and the funding sentence with the address; a second click shows the same address; the wallet screen shows balance with "as of <time>", a "couldn't refresh" note when stale, committed, and last-24-hours spending next to the user daily ceiling; there is no control that moves funds out.

### Implementation for User Story 2

- [X] T042 [US2] Add `PUT /v1/users/:userId/wallet` to src/layer2-control/user-routes.ts and compute the wallet figures in `userView` (src/layer2-control/users.ts) from `ledger.committedAtomic({ userId }, t)`, `committedAtomic({ userId, sinceMs: t - 86_400_000 }, t)` and `platform.limits.userDailyCeilingAtomic`; add `ENDPOINT_ROLES`, `ControlClient.createWallet(userId)`, the OpenAPI row and the SPEC L2-5 row. T039 passes.
- [X] T043 [P] [US2] Create src/portal/balance.ts: `BalanceReader` interface (`readContract` for `balanceOf`, as scripts/payer-balance.ts declares it), `createBalanceCache(reader, asset, { maxAgeMs = 20_000, now })` with `get(address)` → `{ balanceAtomic, readAt, stale }`, keeping the last good value per address; the production reader is a viem public client on the network profile's RPC. No wallet client, no signing call (rule A4).
- [X] T044 [US2] Add `GET /api/wallet` and `PUT /api/wallet/account` to src/portal/routes.ts per contracts/portal-api.md and data-model.md "Wallet view" (`cards: []`, `cardsAvailable: false` and `disabled` from the user view for now), and to docs/portal.openapi.yaml. T040 passes.
- [X] T045 [US2] Build `WalletStep.tsx` and `Wallet.tsx` (the account section) in web/portal/src/screens/ per contracts/portal-ui.md "Onboarding" step 2 and "Wallet". T041 passes.

**Checkpoint**: quickstart.md §2 steps 4–5: one address, and funds sent with `npm run fund-user` show within 30 s.

---

## Phase 5: User Story 3 - The user writes an expense policy and it governs their agent's payments (Priority: P1)

**Goal**: a user saves a first policy (where, how much, how) after seeing its plain-language summary; from then on
their agent's payments are decided by that policy, bounded by the platform limits, and signed with their account.

**Independent Test**: spec.md US3 "Independent Test"; quickstart.md §2 steps 6–8 and the payment table.

### Tests for User Story 3 (write first; they must fail)

- [X] T046 [P] [US3] In test/users.test.ts (`T-USR-09 validation`, `T-USR-09 create`), pure, against `validatePolicy` and the state functions: every code of data-model.md "Validation of a policy save" fires on its condition and all issues come back together (`not_atomic`; `order_auto_below_cap` when not `autoApprove < hardCap`; `order_cap_within_session` when not `hardCap ≤ sessionBudget`; `above_platform_limit` with `limitAtomic` or `limit`, `dailyBudgetAtomic` against `userDailyCeilingAtomic`; `rate_invalid`; `no_sellers`; `too_many_sellers` above 20; `seller_not_listed` with `host`; `seller_conflict` with `host` and `policyId`; `expires_in_past`; `expires_too_late` beyond `maxPolicyDays`; `payment_method_unsupported`; `policy_limit` at 10 active policies); `autoApproveMaxAtomic: "0"` is valid; a `POLICY_CREATED` entry yields `version: 1`, `state: "active"`, sorted `sellers`.
- [X] T047 [P] [US3] In test/users.test.ts (`T-USR-10 selection`, `T-USR-10 mandate`), pure: `selectPolicy` returns the one active policy listing the host, `undefined` for a host no active policy lists, for a paused, removed or expired-but-listed case as specified (expiry is R1's job, so an expired active policy is still selected), and for a host no longer on the seller list; `effectiveMandate` produces each field of data-model.md's table (`mandateId` `<policyId>@<version>`, `allowedHosts: [host]`, the seller's payees, the three minimums, schemes and timeout from the platform mandate, networks and assets from the profile); with no policy it has `allowedHosts: []`.
- [X] T048 [P] [US3] In test/policy.test.ts (`T-POL-16`, `T-POL-19`): with `ctx.user.gate === "not_onboarded"` the result is DENIED with exactly one violation, rule `user_not_onboarded`, detail `the user's setup is incomplete`, whatever else would fail; without `ctx.user`, a table-driven re-run of every existing rule case gives the same result as before this change; rule A6 still passes on policy.ts.
- [X] T049 [P] [US3] In test/users.test.ts (`T-USR-11 decisions`, `T-USR-05 create`), in-process through the harness with `users` on and a funded test user with the policy of spec.md US3 (auto-approve 20000, cap 100000, session 100000, daily 500000): a 1000 payment is AUTHORIZED with `payer` equal to the user's address and the `AUTHORIZED` entry carries `userId, policyId, policyVersion: 1, mandateId: "<policyId>@1"`; 50000 is ESCALATE with `userId` and the policy fields on `ESCALATED`; 200000 is DENIED `hard_cap_exceeded`; another host is DENIED `host_not_allowed` with no policy fields; a user with a profile and wallet but no policy is DENIED `user_not_onboarded`, and so is an unknown `userId`; `remainingSessionBudgetAtomic` is the smallest of the three remainders; `GET /v1/budget/:sessionId?userId=` returns `scope: "user_daily"` with the fields of data-model.md "`BudgetStatus` for a user", zeros for a user who is not onboarded, 400 for a malformed `userId`; `POST …/policies` without a fresh `identityConfirmedAtMs` is 403 `step_up_required` and appends nothing; without a wallet it is 409 `no_wallet`.
- [X] T050 [P] [US3] In test/portal.test.ts (`T-PRT-05 create`): `POST /api/policies` parses the four `…Usdc` fields with `parseUsdc` (a seventh decimal → 422 with code `too_many_decimals` on that field, nothing sent to L2), turns `endsOn` into `expiresAt` at the end of that UTC day, passes `identityConfirmedAtMs` from the token's `auth_time`, maps L2's `issues` to the input's field names, relays 403 `step_up_required` with `maxAgeSec: 900`, and stores `name` (1–60 characters) in the profile file only after L2 answered 201; `GET /api/platform` returns limits and `{ host, name }` per seller with no payee address; `GET /api/policies` returns the policy with its name.
- [X] T051 [P] [US3] In test/hosted-run.test.ts (`T-AGT-06`): for a requester of kind `user`, every `PaymentIntent` the run sends carries `userId === userIdFor(tid, oid)` and `check_budget` calls `budget(sessionId, userId)`; a goal text or a tool input that names another `usr_…` value changes neither; the run log lines contain no new field.
- [X] T052 [P] [US3] In web/portal/test/policy.test.tsx (`T-WEB-04`, `T-WEB-05 create`): `summarizePolicy` returns the exact example text of contracts/portal-ui.md "Policy editor" for the example values, "Every payment needs a person's approval." for a zero auto-approve limit, and names every seller when there are several; the editor offers only sellers from `/api/platform` (no free-text host) and shows each platform limit as helper text; 422 issues appear on their fields and in the error summary, which takes focus; with an empty seller list the screen says "No sellers are available yet" and shows no form.

### Implementation for User Story 3

- [X] T053 [US3] Add the policy functions to src/layer2-control/users.ts (pure): `policyStates(entries, userId, nowMs)`, `validatePolicy(values, { platform, others, nowMs, activeCount })` → `PolicyIssue[]`, `isLoosening(previous | undefined, next)` (true for a create; otherwise true when any of the four amounts or the rate rises, a seller is added, or `expiresAt` moves later), `stepUpFresh(identityConfirmedAtMs, nowMs)` (`-STEP_UP_TOLERANCE_MS ≤ now − t ≤ STEP_UP_MAX_AGE_MS`), `selectPolicy(state, host, platform)`, `effectiveMandate(policy | undefined, host, platform, platformMandate, net)`, `policyView(state, platform, nowMs)`. T046 and T047 pass.
- [X] T054 [US3] Extend src/layer2-control/policy.ts: `PolicyContext.user?: { gate?: "not_onboarded" | "disabled"; dailyCommittedAtomic: bigint; dailyCeilingAtomic: string }`; at the top of `evaluateRequirement`, when `ctx.user?.gate === "not_onboarded"`, return DENIED with the single violation `user_not_onboarded` / `the user's setup is incomplete` (rule R16, before R1). Change nothing else; the file stays free of I/O and clock reads. T048 passes.
- [X] T055 [US3] Implement the user decision path in src/layer2-control/service.ts (data-model.md "The decision for a user payment", plan.md "Design"):
  - `validIntent`: `userId` optional; when present it must match `USER_ID_RE` (400);
  - in `decideOnce`, when `deps.users` is set and `intent.userId` is present: put `userId` on `INTENT`; derive the state, the gate, the selected policy and the effective mandate; build the context with the user and policy filters and `ctx.user`; call the unchanged `decide`; sign with `keyring.signerFor(wallet.walletIndex, mandate.hardCapPerPaymentAtomic)` after checking `addressOf(walletIndex) === wallet.address` (else DENIED `signer_rejected`); put `userId`, and `policyId` and `policyVersion` when a policy applied, on `AUTHORIZED`, `DENIED`, `ESCALATED` and `ESCALATION_REPEATED`; `usedApproval` and `remainingSessionBudgetAtomic` use the effective mandate;
  - `GET /v1/budget/:sessionId`: the optional `userId` query and the user view of `BudgetStatus`;
  - with `deps.users` absent, or no `userId`, the code path is the existing one, untouched.

  Update the authorize and budget rows of docs/l2-control.openapi.yaml and SPEC L2-5. The decision cases of T049 pass.
- [X] T056 [US3] Add `POST /v1/users/:userId/policies` and `GET /v1/users/:userId/policies/:policyId` to src/layer2-control/user-routes.ts: inside `serialize`, refuse 409 `not_registered`/`no_wallet`, 403 `step_up_required` (a create is always loosening), 422 `invalid_policy` with all issues, else append `POLICY_CREATED` with `policyId = "pol_" + randomUUID()`, `version: 1`, the values and `identityConfirmedAtMs`, and return 201 `PolicyView`; unknown body fields are 400. Add `ENDPOINT_ROLES`, `ControlClient.createPolicy`/`policy`, the OpenAPI rows and the SPEC rows. All of T049 passes.
- [X] T057 [US3] Name the user in the hosted agent (contracts/portal-api.md "Hosted agent delta"): `OrchestratorDeps.userId?` in src/layer1-intent/orchestrator.ts (copied onto every intent); `HttpAuthorizationGate.budget(sessionId, userId?)` in src/layer1-intent/ports-http.ts (the `userId` query when present); src/layer1-intent/hosted/agent.ts and server.ts pass `userIdFor(tenantId, objectId)` when `requester.kind === "user"` and nothing otherwise; the tools' schemas are unchanged. T051 passes; test/agent.test.ts and the scripted baseline are unchanged.
- [X] T058 [US3] Add `GET /api/platform`, `GET /api/policies`, `POST /api/policies` and `GET /api/policies/:policyId` to src/portal/routes.ts per contracts/portal-api.md (`PolicyInput`, the order of writes "L2, then `policyNames`", "Untitled policy" when a name is missing), with `policyNames` handling in src/portal/profile-store.ts, and the routes in docs/portal.openapi.yaml. T050 passes.
- [X] T059 [US3] Build the policy screens: web/portal/src/summary.ts (`summarizePolicy(values, sellers, limits)`, pure), `screens/PolicyEditor.tsx` (the three fieldsets Where / How much / How of contracts/portal-ui.md, the name field, the live summary panel, the error summary), `screens/PolicyStep.tsx` (the editor as the third onboarding step) and `screens/Policies.tsx` (the list with state, sellers and limits). Saving goes through `withStepUp`. T052 passes.

**Checkpoint**: quickstart.md §2 through the payment table: a user's hosted run pays from their own address under their policy. US1–US3 together are the usable MVP.

---

## Phase 6: User Story 4 - Each user spends only their own money, under their own rules (Priority: P1)

**Goal**: prove, with tests that fail when a check is removed, that users are isolated in data, budgets and
signing, that a person never falls back to the platform account, that a system identity keeps it, and that each
service refuses the other's token.

**Independent Test**: spec.md US4 "Independent Test"; quickstart.md §3.

### Tests for User Story 4 (write first; they must fail)

- [X] T060 [P] [US4] In test/users.test.ts (`T-USR-03`): with user A's path and user B's `policyId`, `GET` (and later every write route) is 404 with the same body as an unknown ID. **Must fail**: with the test-only dep `skipOwnershipCheck`, A reads B's policy.
- [X] T061 [P] [US4] In test/users.test.ts (`T-USR-11 isolation`), two onboarded and funded users with different policies: A's payment has `payer` = A's address and B's = B's; after A commits their whole daily budget, B's payment is still AUTHORIZED and the platform account's budget figures are unchanged; an approval recorded for A's (session, resource) never lifts R14 for B using the same session and resource; an intent with no `userId` is decided by the platform mandate and signed by the platform payer; an intent for a registered person without a wallet or policy is DENIED and nothing is signed. **Must fail**, one test each: `sharedSigner` (A's payment is signed by the platform account), `sharedBudgets` (A's spending exhausts B's budget), `fallbackToPlatform` (a person who has not onboarded pays from the platform account).
- [X] T062 [P] [US4] In test/portal.test.ts (`T-PRT-02`): no route's path, query or body schema accepts a user identifier (assert against docs/portal.openapi.yaml and by sending `userId` in a body: 400 unknown field); A's token with B's `policyId` is 404; A never receives B's profile, wallet or policies under any route. **Must fail** with L2's `skipOwnershipCheck`.
- [X] T063 [P] [US4] In test/hosted-access.test.ts (`T-AGT-07`) and test/hosted-run.test.ts (`T-AGT-06 service`): a `--portal` dev token is refused by the agent service with 403, and so is a user token whose `scp` lacks `user_impersonation`; a `--service` token (`idtyp: "app"`, no `scp`) still runs, and its intents carry no `userId`. **Must fail**: with the `scp`/`azp` check removed (a test-only dep `skipScopeCheck`), the portal token starts a run.
- [X] T064 [P] [US4] In test/e2e.local.test.ts (`T-E2E-12`), on the local chain with the stack helpers and `users` on: two users are registered, given wallets, funded with MockUSDC and given policies through the real routes; each buys the basic resource through the real L1 orchestrator with their `userId`; each payment is signed by its user's address; L3 reports CONFIRMED for each and the verified `payer` is that user's address; the platform payer's balance is unchanged; `ledger-verify` is ok; a known-value scan of the ledger file and the captured process output finds neither the test mnemonic nor any role token.

### Implementation for User Story 4

- [X] T065 [US4] Make ownership and isolation explicit in L2: in src/layer2-control/user-routes.ts, resolve every `:policyId` (and later `:cardId`) through the path user's state only, answering the same 404 as for an unknown ID, with the test-only dep `skipOwnershipCheck`; in src/layer2-control/ledger.ts and escalations.ts, give `findOpenApproval`, `findRejection` and `findPendingEscalation` an optional `userId` (`string | null`) that must match the entry's; in src/layer2-control/service.ts, pass `userId: null` for the platform account's budget, velocity, approval and rejection lookups and the user's ID for a user's, and add the test-only deps `sharedSigner`, `sharedBudgets` and `fallbackToPlatform`. T060, T061 and T062 pass; test/escalations.test.ts and test/ledger.test.ts stay green.
- [X] T066 [US4] Tighten src/layer1-intent/hosted/requester-auth.ts and config.ts (contracts/portal-api.md "Refusing portal tokens"): a token is kind `service` only when `idtyp === "app"`; any other token must have `scp` (space-separated) containing `user_impersonation`, and its `azp` must differ from `PORTAL_CLIENT_ID` when that optional variable is set; otherwise 403. Add the test-only dep `skipScopeCheck`. Update docs/l1-hosted.openapi.yaml (the 403 description) and specs/011-l1-hosted-agent-azure/contracts/hosted-agent-api.md, so T-API-05..08 stay green. T063 passes.
- [X] T067 [US4] Make T064 pass: whatever the end-to-end run reveals in the wiring (the harness's `users` option on the local chain, the L3 claim's `payer`, the orchestrator's `userId`). No production behavior may change beyond what T055–T066 specify; if it must, amend the contract first.

**Checkpoint**: quickstart.md §3. Three P1 proofs fail without their mechanism.

---

## Phase 7: User Story 5 - The user changes, pauses and removes policies (Priority: P2)

**Goal**: several policies per user, one per seller, under the user daily ceiling; changes make versions, apply to
the next decision, and need a fresh sign-in only when they loosen.

**Independent Test**: spec.md US5 "Independent Test"; quickstart.md §2 steps 9–12.

### Tests for User Story 5 (write first; they must fail)

- [X] T068 [P] [US5] In test/users.test.ts (`T-USR-09 lifecycle`, `T-USR-05`, `T-USR-04 policies`): a change appends `POLICY_CHANGED` with `version` n+1 and `loosened`; identical values append nothing and return the current policy; a wrong `expectedVersion` is 409 `version_conflict` with the current `PolicyView`; pause, resume and remove follow the state diagram of data-model.md and are idempotent; a removed policy answers 409 `policy_removed` to change, pause and resume; resume re-validates (`seller_conflict`, `seller_not_listed`, `policy_limit`); loosening (each of: a higher amount, a higher rate, an added seller, a later `expiresAt`, a resume) needs a fresh `identityConfirmedAtMs` and is 403 otherwise, with nothing appended; tightening needs none; the boundary is exactly 15 minutes plus 60 s; the history lists every entry in order with its values.
- [X] T069 [P] [US5] In test/policy.test.ts (`T-POL-18`): with `ctx.user` present and the policy's own daily budget passing, `user.dailyCommitted + amount > user.dailyCeiling` is DENIED `daily_budget_exceeded`; exactly at the ceiling passes and one atomic unit over fails; when the policy's own budget also fails there is one `daily_budget_exceeded` violation, not two. **Must fail** with the test-only switch `skipUserCeiling`.
- [X] T070 [P] [US5] In test/users.test.ts (`T-USR-10 one policy per seller`, `T-USR-11 versions`): a second active policy listing a seller the first lists is refused with `seller_conflict` naming the first (**must fail** with `skipSellerOverlapCheck`: two policies then match one payment); two policies whose daily budgets add up to more than the ceiling stop at the ceiling (spec.md US5 scenario 5); lowering a daily budget below what was spent denies the next payment with `daily_budget_exceeded`; a paused policy gives `host_not_allowed`; an expired one gives `mandate_expired`; an escalation approved after the policy tightened is DENIED at payment time (INV-12); with `signerLatencyMs` set, a change submitted while a decision is in flight is recorded after that decision's outcome entry, and each decision's entries name one version. **Must fail** with `unserializedUserWrites`: a decision's `INTENT`-to-outcome span contains the `POLICY_CHANGED` entry.
- [X] T071 [P] [US5] In test/portal.test.ts (`T-PRT-05 change`) and web/portal/test/policy.test.tsx (`T-WEB-05`): `PUT /api/policies/:id` requires `expectedVersion`, relays 409 `version_conflict` with `current`, and renames without calling L2 when only `name` changed; pause, resume and remove relay their statuses; the history route returns versions with the name; in the editor a 403 `step_up_required` triggers `confirmIdentity()` and exactly one replay with the same values; a version conflict shows both sets of values and overwrites nothing; the list shows state labels as text, the expired flag and the "Already in <policy name>" disabled seller.

### Implementation for User Story 5

- [X] T072 [US5] Complete the policy lifecycle in src/layer2-control/users.ts and user-routes.ts: `PUT …/policies/:policyId` (with `expectedVersion`, `loosened`, the idempotent no-op), `POST …/pause`, `…/resume`, `…/remove`, the history in `PolicyView`, the test-only deps `skipSellerOverlapCheck` and `unserializedUserWrites`; `ENDPOINT_ROLES`, `ControlClient` methods, OpenAPI and SPEC rows. T068 and T070 (except the ceiling case) pass.
- [X] T073 [US5] Extend R12 in src/layer2-control/policy.ts: after the existing check, when `ctx.user` is present and no `daily_budget_exceeded` was recorded, deny with `daily_budget_exceeded` when `ctx.user.dailyCommittedAtomic + amount > BigInt(ctx.user.dailyCeilingAtomic)`; the test-only switch is a field of the context builder in service.ts (`skipUserCeiling` omits `ctx.user`'s ceiling), never a branch in policy.ts. T069 and the ceiling case of T070 pass.
- [X] T074 [US5] Add `PUT /api/policies/:policyId`, `POST …/pause`, `…/resume`, `…/remove` and the `history` field to src/portal/routes.ts and docs/portal.openapi.yaml; build `screens/PolicyHistory.tsx`, the edit mode of `PolicyEditor.tsx` (version conflict view) and the list actions in `Policies.tsx`. T071 passes.

**Checkpoint**: quickstart.md §2 steps 9–12.

---

## Phase 8: User Story 6 - The user registers a credit card in their wallet (Priority: P2)

**Goal**: a card is saved at the card vault through its hosted fields; the wallet lists brand, last four, expiry and
nickname and says agents can't pay with cards yet; nothing about the card is stored here, and it never pays.

**Independent Test**: spec.md US6 "Independent Test"; quickstart.md §4 (with the stand-in in tests, with a Stripe
sandbox by hand).

### Tests for User Story 6 (write first; they must fail)

- [X] T075 [P] [US6] Create test/helpers/card-vault-stub.ts: an HTTP stand-in for the six calls of contracts/card-vault.md "Calls" (customers create; setup_intents create and retrieve with `expand[]=payment_method`; a customer's `payment_methods` list; payment_methods update and detach), form-encoded in, Stripe-shaped JSON out, always `livemode: false` unless told otherwise. It records every request (method, path, headers, parsed form) and offers `confirm(setupIntentId, { last4, brand, expMonth, expYear, fingerprint })`, `fail(setupIntentId, code)`, and modes `down`, `slow`, `status(401 | 429 | 500)`, `live`.
- [X] T076 [P] [US6] In test/card-vault.test.ts (`T-CARD-01`, `T-CARD-05`, `T-CARD-06`): config accepts `rk_test_`/`sk_test_` with `pk_test_` and refuses to start with any `_live_` prefix, a missing key or a missing publishable key, naming the variable only; every request carries `Authorization: Bearer`, `Stripe-Version: 2026-10-28.endive`, a form body, and an `Idempotency-Key` on POSTs, reused on the one retry; `payment_method_types` is never sent and `allowed_payment_method_types[]=card` is; nothing but the fields in the contract's "Sends" column is sent (no name, email, amount, seller or address); vault down, slow (over 10 s, with a fake timer dep), 401 and 429 give 503 `card_vault_unavailable` on card routes only, while `/api/me`, `/api/wallet` and `/api/policies` still answer; `livemode: true` is a failure; a known-value scan of the captured log lines, every response body and the ledger finds no key, client secret, fingerprint, payment-method ID, customer ID or vault `message` text.
- [X] T077 [P] [US6] In test/card-vault.test.ts (`T-CARD-02`, `T-CARD-03`, `T-CARD-04`) and test/users.test.ts (`T-USR-01 cards`, `T-USR-04 cards`): the happy path of contracts/card-vault.md "Add a card" returns 201 with `{ cardId, brand, last4, expMonth, expYear, nickname?, addedAt, expired }` and L2 holds one `CARD_ADDED { userId, cardId }` with no other field; each check of the contract's table gives its status and detaches where it says (`card_not_confirmed`, another user's setup intent → 404, `not_a_card`, `card_expired`, `card_already_registered`, `card_limit`); when L2 refuses or is down after the label, the card is detached and the answer is 502; list reconciles (an unlabeled payment method is detached; a ledger card the vault no longer lists is removed at L2); remove detaches then records `CARD_REMOVED`, and with L2 down the next list reconciles; at L2, `PUT …/cards/:cardId` is idempotent, refuses a malformed `cardId` (400), a sixth card (409 `card_limit`) and an unregistered user (409), and `DELETE` is idempotent; a nickname is at most 40 characters.
- [X] T078 [P] [US6] In web/portal/test/wallet.test.tsx (`T-WEB-06`): the notice "Agents can't pay with cards yet. A card here is saved for later." is present whenever the wallet renders, with or without cards; "Add a card" is disabled with its reason at 5 cards, when `cardsAvailable` is false and when the account is disabled; an expired card shows the "expired" label; a vault failure shows "The card could not be added. Try again later." and the rest of the page still works; Remove asks to confirm; in the policy editor cards appear as "not available yet" and can't be selected (US6 scenario 3).

### Implementation for User Story 6

- [X] T079 [US6] Add `PUT` and `DELETE /v1/users/:userId/cards/:cardId` to src/layer2-control/user-routes.ts (`cardId` must match `^card_[0-9a-f-]{36}$`; `MAX_CARDS = 5`; ownership through the path user), with `ENDPOINT_ROLES`, `ControlClient.addCard`/`removeCard`, OpenAPI and SPEC rows. The L2 part of T077 passes.
- [X] T080 [US6] Create src/portal/card-vault.ts, the only holder of the credential (contracts/card-vault.md "Transport", "Startup checks", "Calls", "Failures"): `cardVaultFromEnv(env)` (reads `CARD_VAULT`, `CARD_VAULT_KEY`, `CARD_VAULT_PUBLISHABLE_KEY`; the prefix checks), `class CardVault { createCustomer(userId); createSetupIntent(customer, userId); getSetupIntent(id); listCards(customer); label(pmId, cardId, nickname?); detach(pmId) }` over global `fetch` with the constants `API_BASE = "https://api.stripe.com"` and `API_VERSION = "2026-10-28.endive"`, a 10 s timeout, one retry with the same `Idempotency-Key`, the `livemode` check, and the error-code whitelist; the base URL is replaceable only through a constructor argument used by tests. Extend src/portal/config.ts to call `cardVaultFromEnv`. T076 passes.
- [X] T081 [US6] Add rule **A10** to test/architecture.test.ts with fixture test/fixtures/arch/a10-violation.ts: `/\bCARD_VAULT_KEY\b/` (not `CARD_VAULT_KEY_…`) and the string `api.stripe.com` allowed only in `src/portal/card-vault.ts` and `env/portal.env.example`; fixture, clean walk and not-vacuous check as for A9.
- [X] T082 [US6] Create src/portal/cards.ts and the card routes in src/portal/routes.ts (`POST /api/cards/setup`, `POST /api/cards`, `DELETE /api/cards/:cardId`; cards in `GET /api/wallet`; `cards: { available, publishableKey }` in `/api/config`): the flow, checks, order of writes and reconcile-on-list of contracts/card-vault.md; `cardVaultCustomer` in the profile file; 503 `cards_unavailable` when cards are off. Add the routes to docs/portal.openapi.yaml. T077 passes.
- [X] T083 [US6] Build the cards section in web/portal/src/screens/Wallet.tsx and `components/AddCard.tsx`: load Stripe.js from `https://js.stripe.com/endive/stripe.js` by script tag only when the user opens "Add a card"; mount the Payment Element with the `clientSecret`; `stripe.confirmSetup({ elements, redirect: "if_required", confirmParams: { return_url: <origin>/wallet } })`; then `POST /api/cards` with the setup intent ID and the optional nickname; remove with a confirm dialog. The card number and code never enter the app's own DOM, state or requests. T078 passes.

**Checkpoint**: the stand-in flow passes in tests; quickstart.md §4 can be walked by hand with a Stripe sandbox.

---

## Phase 9: User Story 7 - The user disables their account (Priority: P3)

**Goal**: one step stops all of a user's spending and deletes nothing; enabling again needs a fresh sign-in and
brings policies back paused.

**Independent Test**: spec.md US7 "Independent Test"; quickstart.md §2 steps 13–14.

### Tests for User Story 7 (write first; they must fail)

- [X] T084 [P] [US7] In test/policy.test.ts (`T-POL-17`) and test/users.test.ts (`T-USR-01 account`, `T-USR-11 disabled`): with `ctx.user.gate === "disabled"` the result is DENIED with the single violation `user_disabled` / `the user's account can't pay`; `POST …/disable` appends one `USER_DISABLED` and is idempotent; while disabled, payments are DENIED and nothing is signed, `PUT …/wallet`, every policy write (create, change, pause, resume, remove) and `PUT …/cards/:cardId` answer 409 `account_disabled`, `DELETE …/cards/:cardId` and every read still work, and no entry is rewritten or removed; `POST …/enable` without a fresh `identityConfirmedAtMs` is 403; with one it appends one `POLICY_PAUSED` (cause `account_enabled`) per active policy and then `USER_ENABLED`, all contiguous in the ledger, and is idempotent; after enable every policy is paused and a payment is DENIED `host_not_allowed` until one is resumed. **Must fail** with `skipUserGate`: a disabled user's payment is AUTHORIZED.
- [X] T085 [P] [US7] In test/e2e.local.test.ts (`T-E2E-13`): through the stack with `users` on, a user's premium purchase escalates; the user disables their account; the operator approves; the agent's next request is DENIED `user_disabled` and nothing is signed; a payment authorized before the disable still settles and is CONFIRMED; after enable the policy is paused; after resume the same purchase is AUTHORIZED once.
- [X] T086 [P] [US7] In test/portal.test.ts and web/portal/test/account.test.tsx (`013 US7`): `POST /api/account/disable` needs `{ confirm: true }` (400 otherwise); `POST /api/account/enable` relays `step_up_required`; while disabled, `/api/me` has `enabled: false`, profile edits still succeed, and policies carry `displayState: "disabled"`; the Account screen's dialog says "Your agent will not be able to pay. Nothing is deleted."; afterwards a "Your account is disabled" banner is on every screen and every create or change control is disabled; enabling shows "Your policies are paused. Resume the ones you want."

### Implementation for User Story 7

- [X] T087 [US7] Implement disable and enable in L2: R17 in src/layer2-control/policy.ts (beside R16, same early return); `POST …/disable` and `…/enable` in src/layer2-control/user-routes.ts, with the enable's entries appended in one serialized section; the `account_disabled` refusals on the wallet, policy and card-add routes; `displayState: "disabled"` in `policyView`; the test-only dep `skipUserGate`; `ENDPOINT_ROLES`, `ControlClient.disable`/`enable`, OpenAPI and SPEC rows. T084 and T085 pass.
- [X] T088 [US7] Add `POST /api/account/disable` and `/enable` to src/portal/routes.ts and docs/portal.openapi.yaml; build `screens/Account.tsx`, the disabled banner in `app.tsx`, and the disabled state of every create and change control (a single `useAccount()` value read by the editor, the list actions, the wallet step and Add a card). T086 passes.

**Checkpoint**: quickstart.md §2 steps 13–14.

---

## Phase 10: User Story 8 - The operator bounds every user, and the auditor sees who spent under which policy (Priority: P3)

**Goal**: platform limits and the seller list bound every decision even after they are tightened; flags tell the
user; the ledger alone tells the auditor the user, the policy and version, the account and the limits in force;
the operator's escalation views show whose payment each is.

**Independent Test**: spec.md US8 "Independent Test".

### Tests for User Story 8 (write first; they must fail)

- [X] T089 [P] [US8] In test/users.test.ts (`T-USR-10 platform bound`): a save above a platform limit is refused naming it; with a saved cap of 100000 and the platform cap then lowered to 50000, an 80000 payment is DENIED `hard_cap_exceeded` and the policy's view has `limitedByPlatform: ["hardCapPerPaymentAtomic"]`; with the platform cap at or below the policy's auto-approve limit, nothing above the platform cap is paid, approved or not; a seller taken off the list gives `host_not_allowed` and `unlistedSellers: [host]`; a lower `userDailyCeilingAtomic` applies at the next decision. **Must fail** with `skipPlatformBound`: the 80000 payment is AUTHORIZED.
- [X] T090 [P] [US8] In test/escalations.test.ts and test/users.test.ts (`013 US8 audit`): `GET /v1/escalations` items and `escalated` events carry `userId` when the `ESCALATED` entry has one and omit it otherwise; from the ledger file alone, a test-local replay rebuilds every policy's versions and states, and for each `AUTHORIZED` entry names the user, `policyId`, `policyVersion`, `payer` and the `PLATFORM_CONFIG` digest in force (the last such entry before it); no ledger line contains a display name, an email, a policy name or a card nickname used in the test.
- [X] T091 [P] [US8] In test/users.test.ts (`T-USR-12`): a ledger built with 100 users, 10 active policies each and five versions per policy; the median added time of a user decision over the platform-account decision on the same ledger is under 50 ms (measure with `performance.now()` around the in-process call, 50 samples, signer latency 0).

### Implementation for User Story 8

- [X] T092 [US8] Complete the bounds and flags in src/layer2-control/users.ts and service.ts: `limitedByPlatform` and `unlistedSellers` in `policyView`; the test-only dep `skipPlatformBound` in the mandate builder's caller; confirm `selectPolicy` drops a seller no longer on the list. T089 passes. If T091 fails, add an index of users and policies derived through `ledger.subscribe` and rebuilt at startup (research R4), never authoritative, and re-run every T-USR test.
- [X] T093 [US8] Show the user to the operator: `userId` on pending items and `escalated` events in src/layer2-control/escalations.ts (through the existing field whitelist) and a `user` column in scripts/escalations.ts; update docs/l2-control.openapi.yaml and the SPEC L2-5 rows. T090 passes.
- [X] T094 [P] [US8] Show the flags in web/portal/src/screens/Policies.tsx and PolicyEditor.tsx ("Limited by the platform: per payment up to 0.05 USDC", "Seller no longer available") and each platform limit as helper text, with cases added to web/portal/test/policy.test.tsx.

**Checkpoint**: all eight stories pass their independent tests locally.

---

## Phase 11: The portal as an Azure unit

**Purpose**: the sixth unit, its image and pipeline, the app registrations, and L2's two new secrets
(contracts/config-and-secrets.md "Azure"; research R16). Needs `BICEP_PATH` for T-IAC-01.

- [X] T095 Add the image: `ImageName` and `IMAGES.portal` in scripts/image-closure.ts (`entries: ["src/portal-main.ts"]`, `allowed: ["src/portal/", "src/shared/"]`, `extraPackages: ["swagger-ui-dist"]`); docker/portal.Dockerfile on the shared pinned base, with `RUN npm run build && npm run build:web && npx tsx scripts/image-closure.ts portal /out`, `COPY --from=build /app/dist/portal-web ./dist/portal-web`, `COPY docs/portal.openapi.yaml ./dist/docs/`, `RUN mkdir -p /app/.local/portal && chown node:node /app/.local/portal`, the module-load check and a final `USER node`; make sure tsconfig.build.json compiles `src/portal-main.ts`. Extend test/images.test.ts (T-IMG-01): the portal image holds no file from `src/layer2-control/`, `src/layer1-intent/`, `src/layer3-settlement/` or `src/counterparty/`, none of the agent's packages, and no `react`. *(Done. `allowed` also lists `src/portal-main.ts`: the closure check refuses an entry point outside the image's folders, as for L1's two. The Dockerfile's build stage also has `COPY web ./web`, which `build:web` needs. tsconfig.build.json already compiled the entry point.)*
- [X] T096 Add the names and parameters: `names.identities.portal`, `names.vaults.portal`, `names.apps.portal` and `param userAccounts = { enabled: false, portalClientId: '', sellerName: 'x402 demo seller', cardVault: 'off', cardVaultPublishableKey: '' }` in infra/main.dev.bicepparam; `names.portalApp` and `param portalOrigin = ''` in infra/pre-deploy.dev.bicepparam; the `MainNames` and `PreDeployNames` types in test/helpers/bicep.ts.
- [X] T097 Extend infra/main.bicep: `unit` allows `portal`; the `units` table gains `{ key: 'portal', subnet: 'x402' }`; `param userAccounts object` with a `fail()` when `enabled` is true without a 36-character `portalClientId`, or `cardVault` is `stripe` without a `pk_test_` publishable key; pass `userAccounts` whole to the l1, l2 and portal modules; a `portal` module under `if (unit == 'portal')` with `dependsOn` identities, registry, vaults and environments; output `portalFqdn`. *(Done. The module also gets `authTenantId: tenantId`, as `l1-apps` does, and `profilesStorageName: 'profiles'`, as `l2-apps` gets `ledgerStorageName`. The `fail()` also refuses a `cardVault` other than `off` or `stripe`.)*
- [X] T098 [P] Create infra/modules/portal-apps.bicep exactly as contracts/config-and-secrets.md "`modules/portal-apps.bicep`" (external ingress on 4025, single revision, 0–1 replicas, identity `id-portal` with lifecycle `None`, command `node dist/src/portal-main.js`, the `profiles` NFS volume at `/app/.local/portal`, probes, the two always-referenced secrets from `kv-portal`, the env list, never `API_DOCS`), looking everything up with `existing`. *(Done. `CARD_VAULT` is always in the env list, empty unless `stripe`, so the array stays literal for T-IAC-01; the portal reads empty as off.)*
- [X] T099 [P] Extend infra/modules/storage.bicep (a second NFS share `profiles`, quota 100) and infra/modules/environments.bicep (the matching environment storage `profiles` in the `x402` environment, `ReadWrite`).
- [X] T100 [P] Extend infra/modules/l2-apps.bicep (secrets `portal-token` and `user-wallet-mnemonic` from `kv-l2`, always referenced, as `PORTAL_TOKEN` and `USER_WALLET_MNEMONIC`; `USER_ACCOUNTS: userAccounts.enabled ? '1' : '0'`; `PLATFORM_SELLERS` as the JSON string of one entry built from the same host expression as `ALLOWED_HOSTS`, `userAccounts.sellerName` and `[sellerPayTo]`) and infra/modules/l1-apps.bicep (`PORTAL_CLIENT_ID` from `userAccounts.portalClientId` on the agent app).
- [X] T101 Extend infra/pre-deploy.bicep: on the API app, a second scope `Portal.Access` (`type: 'Admin'`, a new fixed GUID variable), `optionalClaims.accessToken` = `auth_time` and `idtyp` with `additionalProperties: ['include_user_token']`, and a second `preAuthorizedApplications` entry for the web app with `Portal.Access` only, keeping the existing scope and role IDs; a new `Microsoft.Graph/applications` resource `names.portalApp` (`signInAudience: 'AzureADMyOrg'`, `spa.redirectUris` = `http://localhost:4025/redirect.html` plus `'${portalOrigin}/redirect.html'` when `portalOrigin` is not empty; no credential, role or `requiredResourceAccess`); a fourth line in the `mainParameters` output giving `portalClientId`. Update infra/cleanup.sh to delete three app registrations and test/cleanup.test.ts to expect them.
- [X] T102 Update T-IAC-01 in test/infra.test.ts per contracts/config-and-secrets.md "T-IAC-01 changes": the `UNITS`, `APP_UNIT`, `APPS`, `STANDARD`, `DEPLOY_UNITS` tables; rule 2 (the mnemonic only in `apps.l2`'s `l2` container from `kv-l2`); rule 3 (`EXTERNAL_OK` gains `apps.portal`); rule 4 (the `ledger` storage is mounted by `apps.l2` only, `profiles` by `apps.portal` only); rule 8 (the secret-name pattern gains `MNEMONIC` and `CARD_VAULT_KEY`); rule 16 (one role, two scopes, two pre-authorized clients, the two optional claims; the web app has no credential and no role); new rule 21 (L2 always references both new secrets; `USER_ACCOUNTS` and `PLATFORM_SELLERS` come from `userAccounts` and the seller's own host; the portal reads only `kv-portal` and gets no `PAYER_PRIVATE_KEY`, no `USER_WALLET_MNEMONIC` and no token but `PORTAL_TOKEN`; `main.bicep` passes `userAccounts` whole). Add a must-fail mutant for rules 3, 4, 16 and 20. Run with `BICEP_PATH=~/.azure/bin/bicep npm test`. *(Done. Rules 2, 8 and 12 got a portal mutant too. Run with the five suites named for this phase, not the whole `npm test`.)*
- [X] T103 Add the pipeline: .github/workflows/deploy-portal.yml (a copy of deploy-l2.yml with `name: deploy-portal`, tag `deploy-portal-*`, `unit: portal`); in .github/workflows/deploy.yml, the step 0 case `portal) image=portal dockerfile=docker/portal.Dockerfile ;;`, the unit list in the error text and the input description, `CA_PORTAL` read from the compiled names, the portal in the wait step's revision poll beside l1 and l3, `_MNEMONIC=` and `CARD_VAULT_KEY=` in the step 2b scan, and a new step `portal-smoke` after the hosted smoke (`/healthz` 200, `/api/config` 200 with `"mode":"entra"`, `/api/me` without a token 401), skipped on a first deployment of a unit that precedes the portal. Update test/deploy-workflow.test.ts (T-E2E-AZ): `Unit`, `PIPELINES`, `UNIT_IMAGES`, `ORDER`, `STEP_IF`, the folder's exact file list, and the guard run for `portal`. *(Done. `portal-smoke` runs `if: !inputs.first-deployment || inputs.unit == 'portal'`. It fails any run without `first-deployment` while the portal doesn't exist, so an environment deployed before 013 adds the portal as a first deployment: see specs/011 deploy-pipeline.md, "First deployment".)*
- [X] T104 [P] Update the Azure documentation: specs/011-l1-hosted-agent-azure/contracts/cloud-topology.md and deploy-pipeline.md (the portal app, its vault and share, the new first-deployment order ending "L2, portal, L1 last, then `pre-deploy.bicep` again with `portalOrigin`"), and specs/011-l1-hosted-agent-azure/quickstart.md §4 with a pointer to specs/013-l2-portal-onboarding/quickstart.md §6.

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: the normative documents, the editor tooling, the cross-cutting tests and the final gates.

- [X] T105 Update SPEC.md to v1.10 per plan.md "SPEC and governance changes": the "Changes in 1.10" table; §1.2 and §1.3; the §2 glossary terms; §3.1; §3.3 (the Portal column and four rows); §4 and §4.1 (INV-2, INV-13, A1, A4, A10–A12); §5 and §6; §7; L1-6; L2-1; L2-2 (R16, R17, R12; the table order note); L2-3; L2-4 and L2-4.1; the L2-5 text around the rows the story tasks added; the new L2-8; CFG-2 and CFG-4; §11 SEC-19..SEC-24 and the residual risks; §12 (every test ID of this file) and §13 (the new commands).
- [X] T106 [P] Amend .specify/memory/constitution.md to 1.4.0 (MINOR) with a Sync Impact Report, exactly the four changes listed in plan.md "Constitution Check": multi-tenancy leaves the out-of-scope list; the stack additions for the portal; one sentence on Principle I; three credentials and the second public process on Principle V; the four residual risks.
- [X] T107 [P] Update specs/README.md (the 013 row; traceability rows for L2-8, CFG-4, SEC-19..24, R16, R17 and every new test ID) and specs/007-process-isolation-security/contracts/threat-matrix.md (rows SEC-19..SEC-24 with their mitigations and tests), and raise `SEC_ROWS` to 24 in test/architecture.test.ts so T-ARCH-TRACE passes.
- [X] T108 [P] Add the editor role: `portal` in `RUN_ROLES` of scripts/vscode-local.ts (entry `src/portal-main.ts`, env file `env/portal.env`, `NETWORK=local`, not a stack service; its pre-launch task starts the stack with `--users`), a "Portal" configuration in .vscode/launch.json and the task in .vscode/tasks.json, and the T-DEV-01 and T-DEV-02 maps in test/vscode-local.test.ts.
- [X] T109 [P] Write the cross-cutting portal tests in test/portal.test.ts: `T-PRT-06` (with L2 down every route that needs it answers 502 and nothing is written to the profile store; with the card vault down only card routes fail) and `T-PRT-08` (every log line has only the whitelisted keys; a known-value scan of the log, every response and the ledger for the tokens used, the display name, the email, the policy name, the nickname and the stub's card values finds none outside the profile responses that own them).
- [X] T110 [P] Write the cross-cutting web tests: web/portal/test/safety.test.tsx (`T-WEB-07`: no `dangerouslySetInnerHTML` in any file under web/portal/src; a display name, policy name and nickname containing `<img onerror>` markup render as text) and web/portal/test/a11y.test.tsx (`T-WEB-08`: an axe-core run on each screen in its main states reports no violation; the onboarding flow can be completed with the keyboard alone using Testing Library's `user.tab()` and `user.keyboard()`).
- [X] T111 [P] Update CLAUDE.md (the portal in "What this repo is"; the commands `portal`, `build:web`, `stack:local -- --users`, `dev-token -- --portal`, `fund-user`, `wallet-mnemonic`; hard rule 2 with the mnemonic and "scripts may also generate a new mnemonic"; hard rule 10 with five roles; a "New or changed portal route" entry under common changes; gotchas: always-referenced secrets seeded as `off`, the late redirect URI, never rotate the mnemonic in place, Stripe's pinned version), README.md (the portal process, port and commands) and docs/diagrams/x402-architecture.json (the portal node and its two edges).
- [X] T112 Run the definition of done: `npm run typecheck`, `npm test`, `BICEP_PATH=~/.azure/bin/bicep npm test`, `npm run build && npm run build:web`, `npm run demo:local` (summary unchanged: `spent on-chain: 0.006 USDC`, `hash chain ok=true`), then `npm run check`. Fix what fails within this feature's scope only. *(Done 2026-11-10: typecheck, `BICEP_PATH=… npm test` (1122 passed), both builds and `demo:local` (summary unchanged, exit 0). On the machine it ran on, port 4020 was held by another checkout, so the three `test/demo.local.test.ts` tests failed there, as they did before this feature, and the demo itself was run with L2 on 4120; `npm run check` as one command was therefore not green there. The portal image was not built: Docker was not running.)*
- [X] T113 Walk quickstart.md §2 and §3 by hand against `npm run stack:local -- --users`, `npm run portal` and `npm run agent:hosted`, and record the result of each table row in specs/013-l2-portal-onboarding/quickstart.md under a new "Validation log" heading (date, pass or fail, note).
- [ ] T114 Manual, needs outside accounts (do not block the merge of earlier phases on it): quickstart.md §4 with a Stripe sandbox and §5 against the Entra tenant. Record in research.md R5 and R7 whether each **unverified** item held (`auth_time` after a forced sign-in and across a silent renewal; the restricted key's permission names and the `expand` call). If an `auth_time` check fails, stop and open the fallback discussion before `userAccounts.enabled` is set to true anywhere.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies. T001–T005 and T008–T011 are parallel; T006 and T007 touch shared files
  (test/architecture.test.ts, package.json) and run alone.
- **Phase 2 (Foundational)**: needs Phase 1. Blocks every story.
  - L2 core in order: T012 → T013; T014 → T015; T016 → T017; T018; then T019 → T020 (same file, service.ts and
    users tests). T021 after T020.
  - T022 is independent of the L2 core. T023 → T024 → T026; T025 is parallel with T024.
  - T027 after T018 and T023 (the allowed files must exist for the not-vacuous checks).
  - T028 first in the web group; T029, T030, T031 parallel after it.
- **Phases 3–10 (stories)**: in priority order. Each needs the phases before it:
  US1 → US2 (a wallet needs a registered user) → US3 (a policy needs a wallet) → US4 (isolation proofs need
  decisions). US5, US6, US7 and US8 each need US3 (US6 needs only US2) and are independent of one another.
- **Phase 11 (Azure)**: needs the portal process to exist (Phase 3 at least); best after Phase 8 so the image and
  the env list are final. T096 → T097; T098–T100 parallel after T097; T101; T102 after T096–T101; T103 after T095.
- **Phase 12 (Polish)**: after the stories that are in scope. T105 before T107 (the traceability rows cite SPEC
  IDs). T112 → T113 → T114 last.

### Within each story

- Tests first, and they fail; then L2, then the portal, then the web app.
- Tasks on the same file run in order: src/layer2-control/users.ts, user-routes.ts, service.ts and policy.ts are
  each touched by several stories, as are src/portal/routes.ts, test/users.test.ts and test/portal.test.ts.
- A story is done when its tests pass, the whole suite is green, and `npm run demo:local` is unchanged.

### Parallel opportunities

- Phase 1: T001, T002, T003, T004, T005, T008, T009, T010, T011.
- Phase 2: T022 beside the L2 core; T025 beside T024; T029, T030, T031 after T028; T021 beside the portal skeleton.
- Every story's test tasks marked [P] are in different files or different `describe` blocks added by one person at
  a time; treat tasks that share test/users.test.ts or test/portal.test.ts as parallel in authorship only if the
  edits are merged carefully, otherwise run them in order.
- After US3: US5, US6, US7 and US8 can be built by different people. US6 touches no L2 decision code.
- Phase 11 can start as soon as the portal process exists and proceed beside the later stories.

## Parallel example: User Story 3

```text
# Tests first, together (different files):
T048  test/policy.test.ts          T-POL-16, T-POL-19
T051  test/hosted-run.test.ts      T-AGT-06
T052  web/portal/test/policy.test.tsx   T-WEB-04, T-WEB-05
T050  test/portal.test.ts          T-PRT-05 create
T046, T047, T049  test/users.test.ts    (one author, in order)

# Then implementation, by layer:
T053 → T054 → T055 → T056   L2 (users.ts, policy.ts, service.ts, user-routes.ts)
T057                        hosted agent (independent of T056; needs T001)
T058                        portal routes (needs T056)
T059                        web screens (needs T058's API shape; can start from the contract)
```

## Implementation Strategy

### MVP first (User Stories 1–3)

1. Phase 1 and Phase 2.
2. US1: a person signs in and has a profile. **Stop and check** quickstart.md §2 steps 1–3.
3. US2: the wallet. Check steps 4–5.
4. US3: the first policy governs payments. Check steps 6–8 and the payment table.

US1 alone is demonstrable; US1–US3 together are the first version worth using, and everything in it is off unless
`USER_ACCOUNTS=1`.

### Incremental delivery

Each step leaves `npm run check` green and can merge with the feature off.

1. Setup + Foundational → merge.
2. US1 → US2 → US3 → merge (the MVP).
3. US4 (the isolation proofs and the tightened agent check) → merge before any shared environment turns the
   feature on.
4. US5, US6, US7, US8 in any order → merge each.
5. Phase 11 (Azure) → merge; deploy with `userAccounts.enabled: false` first (quickstart.md §6).
6. Phase 12 → merge; T114's two manual checks gate turning the feature on, not the merge.

### Along the plan's slices

Plan.md "Delivery" names six slices. They map to these tasks: L2 user accounts (T001–T005, T012–T021, and the L2
tasks of every story: T036, T042, T053–T056, T065, T072, T073, T079, T087, T092, T093); the hosted agent and the
shared verifier (T008, T022, T057, T066); the portal backend (T023–T027, T037, T043, T044, T058, T074, T088); the
web app (T007, T028–T031, T038, T045, T059, T074, T083, T088, T094); cards (T075–T083); Azure (T095–T104).

## Notes

- **Never weaken an invariant to make a test pass.** `policy.ts` stays pure, the ledger append-only, budgets
  ledger-derived, and authorize inside the serialized section (CLAUDE.md hard rules 3–6).
- **No user-typed text into L2.** If a task seems to need a name, a nickname or an email in an L2 request or a
  ledger entry, the design is being misread: see research R6.
- **No new environment switch for tests.** Every must-fail switch is a dep.
- **Secrets.** Never print the mnemonic, a token, the card vault key or a client secret in a log, an error or a
  test failure message; assert with known-value scans instead.
- **Stripe facts are pinned to 2026-11-10.** If a card-vault task finds the API differs, update
  contracts/card-vault.md and research R7 first, then the code.
- Commit after each task or logical group, with the requirement and test IDs in the message.

## Phase 13: Convergence

- [X] T115 Add a must-fail test to `T-USR-11` in test/users.test.ts that uses the existing `skipUserCeiling` switch: with two active policies whose daily budgets add up to more than the user daily ceiling, payments under both are AUTHORIZED past the ceiling when the switch is on, and DENIED `daily_budget_exceeded` without it. Today no test sets `skipUserCeiling`, so "two policies together pay more than the ceiling" is proven only in the pure engine (T-POL-18) per NFR-007 (partial)
- [X] T116 Add a case to `T-PRT-01` in test/portal.test.ts: each role token (`CONTROL_TOKEN`, `VERIFIER_TOKEN`, `SETTLEMENT_TOKEN`, `OPERATOR_TOKEN`, and `PORTAL_TOKEN` itself) presented as the bearer on a portal `/api` route gets 401, with no call to L2 and nothing written per FR-005 (partial)
- [ ] T117 Build `docker/portal.Dockerfile` and start the image with the Azure env list (the `off` placeholders, an empty `CARD_VAULT`): the module-load check passes, `/healthz` is 200, `/api/config` reports `entra`, `/api/me` without a token is 401, and the web app is served. Record the result in specs/013-l2-portal-onboarding/quickstart.md "Validation log". The image has never been built per plan: Azure unit, T095 (partial)
- [X] T118 Add an explicit way to extend an expired policy: in web/portal/src/screens/Policies.tsx an "Extend" link on a policy whose end date has passed, and in PolicyEditor.tsx a notice that the policy expired with focus on the end date; add the case to web/portal/test/policy.test.tsx. Today an expired policy only shows the label per US5/AC7 (partial)
- [X] T119 In web/portal/src/screens/PolicyHistory.tsx say what changed in each `changed` entry, compared with the version before it (each value that differs, as "was X, now Y", and sellers added or removed), with a pure helper and cases in web/portal/test/policy.test.tsx. Today each entry shows only that version's full summary per FR-047 (partial)
- [X] T120 Make the sign-in error for a missing redirect URI name the address to register (`<origin>/redirect.html`) in web/portal/src/screens/SignedOut.tsx, with its case in web/portal/test/onboarding.test.tsx per plan: Risks, "the portal's sign-in error says which URI to register" (partial)
- [X] T121 Add a test that a user's payment decision does not depend on the portal or the card vault: with user accounts on, no portal process and an unreachable card vault address, a decision equals the one made with both up and takes at most 50 ms longer; or an architecture check that `src/layer2-control/` makes no outbound call outside `ciba-client.ts`. Today this holds by construction and no test names it per NFR-005, SC-011 (partial)
- [X] T122 Regenerate docs/diagrams/x402-architecture.html from docs/diagrams/x402-architecture.json, which gained the portal node, its two edges and the "User accounts" view; the rendered page still shows the diagram without them per plan: SPEC and governance changes (partial) *(Done 2026-11-10 with archify's `deliver`, showcase profile, 0 errors and 0 warnings. The diagram has one portal edge, to L2: the read-only balance edge to the chain crossed three others and was dropped. Source links are pinned to commit 759a9bb, the first that holds the portal's files.)*
- [ ] T123 Run specs/013-l2-portal-onboarding/quickstart.md §2's payment rows through `npm run agent:hosted` with a model key, as a person and as a system identity, and try a portal token against the agent service (403); record each row in the "Validation log". The 2026-11-10 walk used the orchestrator directly and did not start the agent service per T113, US3/AC3, US4/AC4 (partial)
- [ ] T124 Review the per-address request limit that was added outside the spec, plan and tasks, on the portal and on the hosted agent (src/shared/address-limit.ts, `express-rate-limit` 8.7.1, `TRUSTED_PROXY_HOPS`, T-IAC-01 rule 3): confirm against a deployed environment that the Container Apps ingress is exactly one proxy hop, then either keep it and add it to specs/013-l2-portal-onboarding/plan.md and research.md, or remove it per SPEC L1-6, L2-8 (unrequested)
- [X] T125 Review the settings that the plan and contracts/config-and-secrets.md do not list: `PORTAL_SCOPE` and `PORTAL_WEB_ROOT` in src/portal/config.ts and env/portal.env.example. Add them to the contract's `env/portal.env` table, or remove them per plan: CFG-2 (unrequested)
- [X] T126 Reconcile specs/013-l2-portal-onboarding/plan.md with the build as made: its Technical Context and Constitution Check name `@vitejs/plugin-react`, which is not installed (Vite compiles the JSX); the web app registration is pre-authorized in a second deployment (`portalPreAuthorized`), not in one; the portal's OpenAPI tests are T-API-12..15 per plan: Technical Context (contradicts)

## Phase 14: Auth0 as the identity provider for people

**Goal**: people sign in with Auth0 at the portal and at the hosted agent service; system identities stay on Entra
(spec.md Clarifications "identity provider", plan.md "Change of identity provider", research R19). Tests first, as
before. This phase supersedes the Entra half of T114 and makes the Entra-only parts of earlier tasks history.

**Independent test**: with the dev issuer, a person's token with `permissions: ["agent:run"]` from the portal's
client opens the portal and is refused by the agent service; the same person's token from an agent client starts a
run whose intents carry `userIdFor(issuer, sub)`; an Entra app token starts a run with no user; an Entra person's
token is refused by both.

- [X] T127 [P] Change the user identifier in src/shared/user-id.ts to `userIdFor(issuer, subject)`: `usr_` + the first 32 hex characters of SHA-256 over `x402-user-v2`, the issuer's host and the subject joined by newlines; refuse an empty value or one containing a newline; accept a subject containing `|` (`auth0|abc`). Update test/user-id.test.ts first (new pinned vectors; the v1 vectors go) and every caller per data-model.md "Identifiers"
- [X] T128 Write test/identity-token.test.ts, then replace src/shared/entra-token.ts with src/shared/identity-token.ts: `verifyPersonToken` (Auth0: JWKS at `<issuer>.well-known/jwks.json`, RS256, exact `iss`, `aud` contains the audience, non-empty `sub`, 60 s tolerance, refuses `gty: client-credentials` and a `sub` ending in `@clients`, returns `permissions`, the client as `azp` or `client_id`, and the claim named by `AUTH_TIME_CLAIM`) and `verifyServiceToken` (Entra: today's checks, `idtyp` exactly `app`), plus `issuerOf(token)` that reads `iss` without verifying. Each check gets a refused case and a must-fail per contracts/portal-api.md "Access" *(Done 2026-11-10. The must-fails use a test-only `skipChecks` option of the verifier; the signature and expiry checks are the library's and have refused cases only.)*
- [X] T129 Update the dev issuer in scripts/dev-issuer-lib.ts and scripts/dev-token.ts to the new shape: `sub` `dev|<subject>`, `permissions` (`agent:run` unless `--no-role`), `azp` (an agent client by default, the portal's with `--portal`), the sign-in time claim (`--auth-age`), and `--service` for an Entra-shaped app token (`idtyp: app`, `roles`). Update test/helpers/hosted.ts and test/helpers/portal.ts with it per research R19
- [X] T130 In test/hosted-access.test.ts and test/hosted-sessions.test.ts (`T-AGT-03`, `T-AGT-06`, `T-AGT-07`) expect: a person's Auth0-shaped token from a client on `AGENT_CLIENT_IDS` runs and names `userIdFor(issuer, sub)`; without `agent:run` 403; from the portal's client 403; an Entra person's token 403; an Entra app token runs with no user; an unknown issuer 401; a session reference is bound to issuer and `sub`. Then implement it in src/layer1-intent/hosted/requester-auth.ts, config.ts (`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`, `SERVICE_AUDIENCE`; refuse to start when `PORTAL_CLIENT_ID` is on the list), server.ts and session-ref.ts; keep the must-fail for the client allow-list. Update docs/l1-hosted.openapi.yaml and specs/011-l1-hosted-agent-azure/contracts/hosted-agent-api.md and access-and-sessions.md per contracts/portal-api.md "Hosted agent delta" *(Done 2026-11-10. The must-fail switch is now `skipClientCheck`; the dev issuer signs `--service` tokens under a second issuer name, `urn:x402:dev-directory`.)*
- [X] T131 In test/portal.test.ts (`T-PRT-01`, `T-PRT-07`, `T-PRT-09`) and test/openapi-portal.test.ts expect the new access table row by row (an Entra token 401, a machine token 403, another client 403, no `agent:run` 403, no sign-in time claim 401), the Content-Security-Policy with the issuer's origin and without `login.microsoftonline.com`, and `/api/config` as `{ auth: { mode: "auth0" | "dev", domain, clientId, audience } }`. Then implement it in src/portal/access.ts, config.ts (`AUTH_ISSUER`, `AUTH_TIME_CLAIM`; `AUTH_TENANT_ID` and `PORTAL_SCOPE` go), server.ts and docs/portal.openapi.yaml per contracts/portal-api.md "Access" and "Limits and headers" *(Done 2026-11-10. As built, the tenant's origin is in `connect-src` only, not `frame-src`: the web app never frames the tenant. contracts/portal-api.md says so.)*
- [X] T132 Replace the web sign-in: add web/portal/src/auth/auth0.ts on `@auth0/auth0-spa-js` (pinned at install; pop-up login with the audience; `getTokenSilently`; `confirmIdentity` as a pop-up with `prompt=login` and `max_age=0`; the library's cache hook on session storage with refresh-token rotation; `lastError` from the library's error code), remove web/portal/src/auth/entra.ts and `@azure/msal-browser`, pick the adapter from `/api/config` `auth.mode` in main.tsx, update web/portal/src/types.ts and the hints in screens/SignedOut.tsx for Auth0's error codes. If a pop-up needs no page of the portal's own (R19, check 3), remove web/portal/redirect.html, src/redirect.ts, the second Vite input and the portal's header exception; otherwise keep them. Update web/portal/test/safety.test.tsx (the one file that may name session storage) and onboarding.test.tsx per contracts/portal-ui.md *(Done 2026-11-10. The redirect page, `src/redirect.ts` and the header exception are removed: the library answers a pop-up with a web message (read in its source at 2.30.0). Added: a confirmation by another person signs out, `account_changed`.)*
- [X] T133 [P] Add scripts/user-token.ts and the `user-token` script in package.json: the device authorization flow against the tenant's native client (`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLI_CLIENT_ID` from env/l1-hosted.env), printing the verification address to stderr and only the access token to stdout; with test/user-token.test.ts against a stub tenant (pending, slow-down, denied, expired). It replaces `az account get-access-token` for people per research R19
- [X] T134 [P] Update env/portal.env.example and env/l1-hosted.env.example with the new variables, the `TEMPLATES` lists of T-ARCH-ENV in test/architecture.test.ts, and the portal and hosted warnings in scripts/vscode-local.ts with test/vscode-local.test.ts per contracts/config-and-secrets.md "CFG-2"
- [X] T135 Extend auth0/ (main.tf, variables.tf, outputs.tf, README.md) with the API (RBAC enforced, permissions in the token, the one permission `agent:run`), the role `x402-user`, the portal's single-page client, the agent CLI's native client (device grant only), the post-login Action that sets the sign-in time claim, the `portal_origin` variable and the `identity` and `portalClientId` outputs; no user and no role assignment in code. Extend test/auth0-iac.test.ts (`T-IAC-02`) first, with a must-fail mutant for each new rule per contracts/config-and-secrets.md "`auth0/`" *(Done 2026-11-10. Outputs are named `bicepparam_identity` and `bicepparam_portal_client_id`, like `bicepparam_ciba`, plus `agent_env` and `portal_env`; the portal's origin arrives as the GitHub variable `AUTH0_PORTAL_ORIGIN`. `terraform validate` passes against the pinned provider.)*
- [X] T136 Update the Azure side. infra/main.bicep and infra/main.dev.bicepparam: the `identity` object, its `fail()` checks, and "not empty" for `userAccounts.portalClientId`; infra/modules/l1-apps.bicep and portal-apps.bicep: the new env. infra/pre-deploy.bicep and pre-deploy.dev.bicepparam: take out the `Portal.Access` scope (disable in one deployment, remove in the next), its pre-authorization, `portalPreAuthorized`, `portalOrigin`, `names.portalApp`, the web app registration and the `auth_time` optional claim; keep `idtyp`. infra/cleanup.sh and test/cleanup.test.ts: two app registrations. .github/workflows/deploy.yml: `portal-smoke` expects `"mode":"auth0"`. Update test/infra.test.ts (`T-IAC-01` rules 15, 16, 17 and 21, with mutants) and test/deploy-workflow.test.ts first per contracts/config-and-secrets.md "Azure" *(Done 2026-11-10. The two deployments are chosen by a required bool, `retirePortalScope`; dev is at `true`. Not deployed.)*
- [X] T137 Run the chain suites with the new tokens: test/helpers/harness.ts and test/e2e.local.test.ts (`T-E2E-09`, `T-E2E-12`, `T-E2E-13`) use the dev issuer's new shape, and a person's run is still paid from that person's account per US4/AC1, US4/AC4 *(Done 2026-11-10. Added a T-E2E-12 case through the hosted agent service: a person's token pays from their own account, a system identity's from the platform's, and the portal's token is 403.)*
- [X] T138 [P] Update the normative documents: SPEC.md to v1.11 ("Changes in 1.11"; §2 glossary "user"; §3.1 Azure profile; §3.3 the requester and portal token rows; §5 the sign-in library; §6 files; L1-6 auth; L2-8 access and web app; CFG-2; §11 SEC-14, SEC-19, SEC-20 and SEC-21 with the residual risk of one provider for sign-in and approvals; §12 test rows; §13 `user-token`), .specify/memory/constitution.md to 1.5.0 (Principle V's requester credential), specs/README.md, specs/007-process-isolation-security/contracts/threat-matrix.md, specs/011-l1-hosted-agent-azure/contracts/cloud-topology.md and quickstart.md, CLAUDE.md and README.md per plan.md "Change of identity provider"
- [X] T139 Run the definition of done: `npm run typecheck`, `BICEP_PATH=~/.azure/bin/bicep npm test`, `npm run build && npm run build:web`, `npm run demo:local` (summary unchanged), and a local walk of quickstart.md §2 with the dev issuer; record it in the "Validation log"
- [ ] T140 Manual, needs the Auth0 tenant: run `provision-auth0.yml`, assign `x402-user` to a test person, walk quickstart.md §5 and record each of research R19's five unverified items as held or not. If a sign-in time check fails, stop before `userAccounts.enabled` is true anywhere. This replaces the Entra tenant half of T114
