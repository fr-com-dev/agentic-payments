---

description: "Task list for 017: remediation of the portal's DAST findings"
---

# Tasks: Remediation of the Portal's DAST Findings

**Input**: Design documents from `specs/017-dast-findings-remediation/`

**Prerequisites**:
- [plan.md](plan.md) (slices, knock-on test changes)
- [spec.md](spec.md) (US1–US8, FR-001..FR-028, the 2026-11-23 clarification)
- [research.md](research.md) (R1–R15)
- [data-model.md](data-model.md)
- [contracts/](contracts/): portal-edge, hosted-agent-edge, self-hosted-proxy
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII and spec FR-028 require a test for every new
behavior and a must-fail proof for each new safety check.
- **Test IDs.** Each test title carries its ID: T-EDGE-01..06, T-PRT-16..18, T-WEB-14..16, T-PROXY-01, and the
  amended T-PRT-01, T-PRT-07, T-PRT-08, T-IMG-03, T-API-05..08, T-API-12..15.
- **Order.** Write each story's tests first and confirm they fail before implementing.
- **Red runs.** The checks with no off-switch (the headers in T006 and T040, the challenge in T051, the start-up
  refusals in T010) are proven by their first, failing run: record each one in the PR description (Principle
  VIII). T006 also fails on the old code for good, because it sends a public `Host` with `NETWORK=local`.
- **Switches.** `skipLocalOnly` (portal and agent), `skipFailureLimit` (portal and agent) and `skipNotFoundRules`
  (portal) are test-only deps on `PortalDeps` / `HostedDeps`, never environment variables. The entry points never
  set them.
- **Requests in tests.** Both helpers (`test/helpers/portal.ts`, `test/helpers/hosted.ts`) listen on `127.0.0.1` and
  use the dev issuer, so every existing request already passes the dev sign-in's loopback check. A new test that
  needs a public `Host` or a declared proxy uses the Auth0-shaped issuer (the portal's
  `AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: ""`, the agent's `tenant: true`), and a request whose `Host` or raw
  path matters goes through `rawRequest`; both helpers come from T004.
- **Not edited.** Anything in `src/layer2-control/`, `src/layer3-settlement/`, `src/counterparty/`,
  `src/shared/contracts.ts`, the ledger, `infra/`, `auth0/`.

**Organization**: tasks are grouped by user story (US1–US8 of spec.md), in priority order: P1 (US1, US2), P2 (US3,
US4), P3 (US5, US6, US7, US8). Each story also updates the SPEC sections and contracts its behavior touches, so
each phase can merge on its own; the version bump and the closing records are in Phases 2 and 11.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task belongs to (US1–US8)

## Path Conventions

Repository root as in plan.md "Source Code": services in `src/`, the web app in `web/portal/`, Node tests in
`test/`, web tests in `web/portal/test/`, API documents in `docs/`.

---

## Phase 1: Setup

**Purpose**: a known-good baseline.

- [X] T001 Run `npm install` and `npm run check` on the branch before any change; record in the PR description that typecheck and tests are green and the demo summary reads `spent on-chain: 0.006 USDC` and `hash chain ok=true` (the baseline NFR-001 and SC-009 compare against)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the loopback rule every story uses, the new test hooks, and the SPEC version every story appends to.

**⚠️ CRITICAL**: US1 and US2 need T002–T003; every story's SPEC edits go under T005's heading.

- [X] T002 [P] Write T-EDGE-01 in `test/edge-local-only.test.ts`: `isLoopbackHost` returns true for `localhost`, `LOCALHOST`, `localhost.`, `localhost:4025`, `127.0.0.1`, `127.0.0.1:4025`, `[::1]`, `[::1]:4025`, and false for `127.0.0.2`, `0.0.0.0`, `[::ffff:127.0.0.1]`, `portal.example`, `localhost.example`, `""` and `undefined`; `isLoopbackBind` true for `127.0.0.1`, `::1`, `localhost`, false for `0.0.0.0`, `::`, `10.0.0.5`; `hasForwardingHeader` true when any of `forwarded`, `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`, `via` is present (any case), false otherwise (data-model.md "Loopback name")
- [X] T003 Create `src/shared/local-only.ts` with `isLoopbackHost(host: string | undefined)`, `isLoopbackBind(address: string)`, `FORWARDING_HEADERS` (the five lower-case names above) and `hasForwardingHeader(headers: IncomingHttpHeaders)`, pure, importing only types; header comment citing SPEC L1-6, L2-8 and research R2. T-EDGE-01 passes
- [X] T004 [P] Test helpers. (a) Add the three test-only hooks to `StartPortalOptions` in `test/helpers/portal.ts` (`skipLocalOnly?`, `skipFailureLimit?`, `skipNotFoundRules?`, each passed to `createPortalApp` only when true, like `skipAddressLimit`). (b) In `test/helpers/hosted.ts` add `tenant?: true` to `StartHostedOptions`: it starts the agent with the Auth0-shaped issuer instead of the dev one (`AUTH_JWKS_FILE: ""`, `AUTH_ISSUER` an `https://…auth0.com/` test issuer, the same local keys), and `token()` then signs with that issuer, so a test can use `TRUSTED_PROXY_HOPS=1` or a public `Host`, which the dev sign-in refuses once US2 lands; every other `HostedDeps` field is already forwarded. (c) Create `test/helpers/raw-request.ts` exporting `rawRequest(base, { method?, path, headers?, host? })` on `node:http` `request` with `setHost: false`: it sends `path` byte for byte (no normalization of `%2e%2e` or `..`), sends `Host` only when `host` is a string (`null` sends none; omitted sends the base's `host:port`), and resolves `{ status, headers, body }`. T006, T011, T035 and T051 use it for every request whose `Host` or raw path matters
- [X] T005 Bump `SPEC.md` to 1.27 (dated the day of the change): version row, and a new `## Changes in 1.27` section above 1.25 with a one-paragraph summary ("Remediation of the DAST of the self-hosted dev portal", seven findings, no contract type changes) and an empty `| Area | Change |` table that the stories fill; and a `Residual risks added in v1.27:` list after §11's last residual list, in the same plain-paragraph form as the earlier versions'

**Checkpoint**: shared rule and hooks in place; stories can start.

---

## Phase 3: User Story 1 - A visitor's connection to the portal can't be downgraded to plain HTTP (Priority: P1) 🎯 MVP

**Goal**: HSTS on every portal answer to a non-loopback host name, on every network profile (finding 1).

**Independent Test**: start the portal with `NETWORK=local`; a request with `Host: portal.example` carries HSTS on a page, a file, an API answer, a health answer and an error; a request to `127.0.0.1` carries none.

### Tests for User Story 1 (write first; they must fail)

- [X] T006 [US1] Write T-PRT-16 (HSTS part) in `test/portal.test.ts`, new `describe("T-PRT-16 transport and browser policies on every answer")`: with a web root holding `index.html` and `assets/app.js` (the helper's `webRoot` option), send `Host: portal.example` to `/`, `/assets/app.js`, `/api/config`, `/api/me` (no token, 401), `/healthz`, `/nope`, and a 429 (`maxRequestsPerAddress: 1`, second request); each answer has `strict-transport-security: max-age=31536000; includeSubDomains`, and `/healthz`, sent without a token, answers 200 with body exactly `{ "status": "ok" }` (FR-023); the same paths with the default host (`127.0.0.1:<port>`) have none; repeat with `NETWORK: "base-sepolia"` in the helper's env (the balance reader is the helper's stub, so no chain is needed); if the helper can't start that profile, build `createPortalApp` directly with `{ ...config, network: "base-sepolia" }`. Use the Auth0-shaped issuer the file already uses (`AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: ""`) for the public-host requests, because the dev sign-in answers 421 to them once US2 lands (send them with `rawRequest` from `test/helpers/raw-request.ts`, T004)
- [X] T007 [US1] Amend T-PRT-07 in `test/portal.test.ts`: the comment on the HSTS assertion becomes "a loopback host name: no HSTS (R1)"; the assertion itself is unchanged

### Implementation for User Story 1

- [X] T008 [US1] In `src/portal/server.ts` replace `if (config.network !== "local") res.set("Strict-Transport-Security", …)` with `if (!isLoopbackHost(req.headers.host)) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")` (import from `../shared/local-only.js`), keeping it in the first middleware so every answer carries it. T-PRT-16 (HSTS part) and T-PRT-07 pass
- [X] T009 [US1] Update the HSTS rule in `SPEC.md` L2-8 "Limits and headers" ("`Strict-Transport-Security: max-age=31536000; includeSubDomains` on every response to a request whose `Host` is not a loopback name, on every network profile (v1.27)"), in `specs/013-l2-portal-onboarding/contracts/portal-api.md` "Limits and headers" (it says "off loopback": make it say "when the `Host` header is not a loopback name"), add the §11 row **SEC-43** (threat: a network attacker strips a visitor's later plain-HTTP visit to a self-hosted portal on the local profile and captures the sign-in or a bearer token; control: HSTS by host name, and the reference proxy's own HSTS; tests T-PRT-16, T-PROXY-01), a "Changes in 1.27" row, and the T-PRT-16 row in §12

**Checkpoint**: finding 1 closed in the portal; the proxy half comes with US4.

---

## Phase 4: User Story 2 - The local dev sign-in is never reachable from outside the machine (Priority: P1)

**Goal**: the portal and the hosted agent, with `AUTH_JWKS_FILE`, refuse to start off loopback or behind a declared proxy, and answer 421 to any request that isn't from the machine (finding 4, the drift risk).

**Independent Test**: start each service in dev mode with `PORTAL_BIND_HOST=0.0.0.0`, `AGENT_BIND_HOST=0.0.0.0` or `TRUSTED_PROXY_HOPS=1`: each refuses. Start it normally and send `Host: portal.example`, then `X-Forwarded-For`, then nothing special: only the last is served.

### Tests for User Story 2 (write first; they must fail)

- [X] T010 [US2] Write T-EDGE-02 in `test/edge-local-only.test.ts`: `loadPortalConfig` with the dev settings (`AUTH_JWKS_FILE` set, `AUTH_ISSUER` the dev issuer) and `PORTAL_BIND_HOST=0.0.0.0` throws a `ConfigError` whose message is exactly `PORTAL_BIND_HOST must be a loopback address with AUTH_JWKS_FILE (the local dev issuer)` and does not contain `0.0.0.0`; with `TRUSTED_PROXY_HOPS=1` it throws `TRUSTED_PROXY_HOPS must be 0 with AUTH_JWKS_FILE (the local dev issuer)`; with `PORTAL_BIND_HOST` `127.0.0.1`, `::1` or `localhost` it loads; with the Auth0 issuer (no `AUTH_JWKS_FILE`), `PORTAL_BIND_HOST=0.0.0.0` and `TRUSTED_PROXY_HOPS=1` it loads. The same four cases for `loadHostedConfig` with `AGENT_BIND_HOST` (messages `AGENT_BIND_HOST must be a loopback address with AUTH_JWKS_FILE (the local dev issuer)` and the same `TRUSTED_PROXY_HOPS` one)
- [X] T011 [US2] Write T-EDGE-03 in `test/edge-local-only.test.ts` (after T010, same file), for the portal (`startPortal` from `test/helpers/portal.ts`) and the agent (`startHostedApp`), both in dev mode, every request through `rawRequest` (T004): a request to `/healthz`, `/api/config` (portal) or `POST /v1/runs` (agent) with `Host: portal.example`, with `Host` missing (`host: null`), and with each of the five forwarding headers on a loopback host, gets `421` and body exactly `{ "error": "misdirected request" }` (no `dev`, `JWKS` or `issuer` in it), and the portal's 421 carries its CSP and HSTS-by-host headers; a request with `Host: localhost:<port>` and no forwarding header is served (200 on `/healthz`, no token, body exactly `{ "status": "ok" }` for both services, FR-023). Must-fail: with `skipLocalOnly: true` the `Host: portal.example` request to `/healthz` gets 200. With the Auth0-shaped issuer (the portal's `AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: ""`, the agent's `tenant: true`) the `Host: portal.example` request is served (US2 scenario 4)

### Implementation for User Story 2

- [X] T012 [US2] In `src/shared/local-only.ts` add `localOnly(): RequestHandler`, which calls `next()` only when `isLoopbackHost(req.headers.host)` and `!hasForwardingHeader(req.headers)`, and otherwise answers `res.status(421).json({ error: "misdirected request" })` without reading `Authorization` or the body
- [X] T013 [P] [US2] In `src/portal/config.ts` (`loadPortalConfig`), after `bindHost` and `trustedProxyHops` are known and only when `dev` (`AUTH_JWKS_FILE` set): throw `ConfigError("PORTAL_BIND_HOST must be a loopback address with AUTH_JWKS_FILE (the local dev issuer)")` when `!isLoopbackBind(bindHost)`, and `ConfigError("TRUSTED_PROXY_HOPS must be 0 with AUTH_JWKS_FILE (the local dev issuer)")` when `trustedProxyHops > 0`
- [X] T014 [P] [US2] In `src/layer1-intent/hosted/config.ts` (`loadHostedConfig`), the same two checks when `dev`, for `AGENT_BIND_HOST` (default `DEFAULT_AGENT_BIND_HOST`) and `TRUSTED_PROXY_HOPS`, with the messages of T010. T-EDGE-02 passes
- [X] T015 [US2] In `src/portal/server.ts` add `skipLocalOnly?: boolean` to `PortalDeps` (doc comment: T-EDGE-03 must-fail, never set by the entry point) and mount `app.use(localOnly())` right after the header-and-log middleware and before `/healthz`, only when `config.auth.mode === "dev" && !deps.skipLocalOnly`
- [X] T016 [US2] In `src/layer1-intent/hosted/server.ts` add `skipLocalOnly?: boolean` to `HostedDeps` (same comment) and mount `app.use(localOnly())` first, right after `trustProxies`, before `/healthz`, only when `deps.config.auth.jwksFile !== undefined && !deps.skipLocalOnly`. T-EDGE-03 passes
- [X] T017 [US2] Fix the knock-on test in `test/portal.test.ts`, T-PRT-01 "behind a trusted proxy each client address has its own count" (plan.md "Knock-on changes"): start `proxied`, `spoofed` and `direct` with the Auth0-shaped issuer (`AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: ""`) and that issuer's tokens, keeping every assertion; then run `npx vitest run test/portal.test.ts test/hosted*.test.ts test/e2e.local.test.ts` and fix any other test that sends a non-loopback `Host` or a forwarding header to a dev-mode service the same way (never by setting `skipLocalOnly` outside T-EDGE-03)
- [X] T018 [US2] Update `SPEC.md`: L1-6 and L2-8 (with `AUTH_JWKS_FILE`, a loopback bind and no declared proxy, or the service refuses to start; `421 { "error": "misdirected request" }` before anything else for a non-loopback `Host` or any forwarding header), CFG-2 notes on `AUTH_JWKS_FILE` in the `portal.env` and `l1-hosted.env` rows (no new variable), §11 **SEC-44** (threat: a dev-mode portal or agent exposed by a changed bind, a proxy or a public name accepts development tokens from the internet; control: the start-up refusal and the per-request 421; tests T-EDGE-02, T-EDGE-03), the v1.27 residual "a proxy that rewrites `Host` to a loopback name and strips every forwarding header defeats the per-request check; the start-up check and the operator remain" (research R3), a "Changes in 1.27" row and the §12 rows T-EDGE-01..03
- [X] T019 [P] [US2] Add the 421 and the start-up refusals to `specs/011-l1-hosted-agent-azure/contracts/hosted-agent-api.md` ("Startup" and "Anything else"), `specs/016-agent-auth0-streaming/contracts/hosted-agent-api.md` and `specs/013-l2-portal-onboarding/contracts/portal-api.md` "Access", each pointing to `specs/017-dast-findings-remediation/contracts/` for the full table

**Checkpoint**: a dev-mode service can only be used from the machine it runs on.

---

## Phase 5: User Story 3 - Repeated failed authentications from one address are slowed down and noticed (Priority: P2)

**Goal**: 20 failed authentications per address a minute, then 429 before any token check until the window ends; one log line per burst; a warning when a proxy seems undeclared (finding 2).

**Independent Test**: from one address send `Authorization: Bearer a.b.c` until 429; the next request with a valid token is 429 too; another address with a valid token is served; exactly one `auth_failure_limit` line is logged, with no token, address or path.

### Tests for User Story 3 (write first; they must fail)

- [X] T020 [P] [US3] Write T-EDGE-04 in `test/edge-failure-limit.test.ts`, once for the portal (`GET /api/me`) and once for the agent (`POST /v1/runs` with a valid body), each with its log captured (`log` dep): 20 requests with `Bearer a.b.c` get 401, the 21st gets `429 { "error": "too many requests" }` with `Retry-After` between 1 and 60; then a request with a valid token from the same address gets 429 (refused before verification); with `TRUSTED_PROXY_HOPS=1` and the Auth0-shaped issuer (the portal's `AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: ""` and that issuer's tokens; the agent's `tenant: true`, T004), `X-Forwarded-For: 203.0.113.7` exhausted does not stop `X-Forwarded-For: 203.0.113.8` with a valid token; requests that authenticate never count (portal: 20 × `GET /api/me` with a valid token; agent: 3 valid runs, below its run limit), so 20 failures are still needed after them; `/api/config`, `/healthz` and (agent) `/healthz` called 50 times never count; 403s (portal: an agent-client token; agent: no `agent:run`) never count; exactly one captured line has `event: "auth_failure_limit"` and `count: 20`; that line has only the keys of contracts/portal-edge.md (portal: `route` is `/api/*`; agent: only `event` and `count`), so it names no path, header or address; and no captured line at all contains the test's tokens, `203.0.113` or `127.0.0.1` (the request lines' route labels, `/api/me` included, are expected and allowed). Must-fail: with `skipFailureLimit: true` the 21st and 40th failures are 401, never 429. Every request of a case is sent within a few seconds, inside one window; no clock is faked
- [X] T021 [US3] Write T-EDGE-05 in `test/edge-failure-limit.test.ts` (after T020, same file): with the Auth0-shaped issuer (as in T020) and `TRUSTED_PROXY_HOPS` unset, two requests carrying `X-Forwarded-For` to each service produce exactly one captured line with `event: "proxy_undeclared"` and are served as usual; with `TRUSTED_PROXY_HOPS=1` none is written; without forwarding headers none is written
- [X] T022 [P] [US3] Amend T-PRT-08 in `test/portal.test.ts` (the log whitelist): `LOG_KEYS` is `["time", "route", "status", "ms", "userId", "event", "count"]`

### Implementation for User Story 3

- [X] T023 [US3] In `src/shared/address-limit.ts` add `MAX_FAILED_AUTH_PER_ADDRESS = 20` and `failedAuthLimit(o: { onLimit?: (key: string, resetMs: number) => void } = {}): RequestHandler`: `rateLimit({ windowMs: 60_000, limit: MAX_FAILED_AUTH_PER_ADDRESS, skipSuccessfulRequests: true, requestWasSuccessful: (_req, res) => res.statusCode !== 401, standardHeaders: false, legacyHeaders: false, validate: { xForwardedForHeader: false }, handler })` where the handler sends the same `Retry-After` and `429 { "error": "too many requests" }` as `addressLimit` and calls `onLimit` with the request's key (the default key generator's value, e.g. via a `keyGenerator` that wraps `ipKeyGenerator(req.ip)` and stores it on the request) and the reset time; doc comment: research R4, counts 401s only, checked before the token, its own store
- [X] T024 [US3] In `src/shared/address-limit.ts` add `onceInWindow()` (returns `(key, resetMs) => boolean`, true the first time a key is seen for a given reset time, pruning keys whose reset time has passed) and `proxyWarning(hops: number, onProxied: (req: Request, res: Response) => void): RequestHandler`, which, when `hops === 0` and `hasForwardingHeader(req.headers)`, calls `onProxied` for the first such request of that app only (a flag in its closure: one per service instance (each app the service builds; one per process in a deployment)), then calls `next()`; it never refuses
- [X] T025 [US3] In `src/portal/log.ts` add `count?: number` to `PortalLogLine` and `"count"` to `LOG_KEYS`, written only when present. T-PRT-08 passes
- [X] T026 [US3] In `src/portal/server.ts`: add `skipFailureLimit?: boolean` to `PortalDeps`; mount `app.use("/api", failedAuthLimit({ onLimit }))` as a direct argument right after the `addressLimit` line and before `app.use("/api", access, limit)`, unless `skipFailureLimit`; `onLimit` writes, through `onceInWindow`, `{ time, route: "/api/*", status: 429, ms: 0, event: "auth_failure_limit", count: MAX_FAILED_AUTH_PER_ADDRESS }`; mount `proxyWarning(config.trustedProxyHops ?? 0, onProxied)` right after the header middleware (after `localOnly` in dev mode), where `onProxied` registers `res.on("finish")` to write one extra line `{ time, route: <the request's route label>, status: res.statusCode, ms, event: "proxy_undeclared" }` beside that request's usual line
- [X] T027 [US3] In `src/layer1-intent/hosted/run-log.ts` add `event(e: { event: "auth_failure_limit" | "proxy_undeclared"; count?: number }): void` to `RunLog`, writing `{ event, count? }` only; in `src/layer1-intent/hosted/server.ts` add `skipFailureLimit?: boolean` to `HostedDeps`, mount `app.use(failedAuthLimit({ onLimit }))` right after `app.use(addressLimit(...))` and before `requesterAuth`, with `onLimit` writing `runLog.event({ event: "auth_failure_limit", count: MAX_FAILED_AUTH_PER_ADDRESS })` through `onceInWindow`, and mount `proxyWarning(deps.config.trustedProxyHops ?? 0, () => runLog.event({ event: "proxy_undeclared" }))` after `localOnly`. T-EDGE-04 and T-EDGE-05 pass
- [X] T028 [US3] Update `SPEC.md` L1-6 "Limits" and L2-8 "Limits and headers" (the failure limit, what counts and what doesn't, the burst line, the undeclared-proxy line), §11 **SEC-45** (threat: a stream of forged or missing tokens makes a public service verify without bound and leaves no signal; control: 20 failed authentications per address a minute, refused before verification, one line per burst; tests T-EDGE-04, T-EDGE-05), the v1.27 residual "people behind one address share its failure count: 20 failures there refuse all of them for the rest of the minute, valid tokens included", a "Changes in 1.27" row, §12 rows T-EDGE-04, T-EDGE-05 and the amended T-PRT-08
- [X] T029 [P] [US3] Describe the failure 429 in `docs/portal.openapi.yaml` and `docs/l1-hosted.openapi.yaml` (the existing 429 response's description: "too many requests from this address, or 20 failed authentications from it in a minute") and in the contracts' limits sections (`specs/013-l2-portal-onboarding/contracts/portal-api.md`, `specs/011-l1-hosted-agent-azure/contracts/hosted-agent-api.md` `POST /v1/runs`, `specs/016-agent-auth0-streaming/contracts/hosted-agent-api.md`); run `npx vitest run test/openapi-portal.test.ts test/openapi-hosted.test.ts`

**Checkpoint**: floods of bad tokens stop at 20 per address and show up in the log.

---

## Phase 6: User Story 4 - Only the owner's allow-list reaches the dev host, through a proxy set up from a reference (Priority: P2)

**Goal**: a reference Caddyfile and procedure that close the proxy half of findings 1, 4 and 6 (contracts/self-hosted-proxy.md).

**Independent Test**: T-PROXY-01 passes; with Caddy installed, `caddy validate` accepts the file; the manual checks in T058 pass on the dev host.

### Tests for User Story 4 (write first; they must fail)

- [X] T030 [P] [US4] Write T-PROXY-01 in `test/self-hosted.test.ts`: read `docs/self-hosted/Caddyfile` and assert, by directive text, P1–P10 of `contracts/self-hosted-proxy.md`: a site `{$PORTAL_HOST}` with `protocols tls1.2 tls1.3`; a site `http://{$PORTAL_HOST}` with `redir https://{host}{uri} 308` after the allow-list check; `auto_https disable_redirects` and `admin localhost:2019` in the global block; `not remote_ip {$PORTAL_ALLOW_FROM:192.0.2.1/32}` followed by `respond … 403` before `path /healthz /readyz /docs /docs/*` with `respond … 404`, before `reverse_proxy 127.0.0.1:4025`, all inside one `route` block; `Strict-Transport-Security "max-age=31536000; includeSubDomains"`, `-Server` and `-Via` in the HTTPS site's `header` block and `-Server` in the HTTP site; no IP address other than `127.0.0.1` and `192.0.2.1`, and no host name, in the file. When `process.env.CADDY_PATH` is set, also run `<CADDY_PATH> validate --adapter caddyfile --config docs/self-hosted/Caddyfile` with `PORTAL_HOST=portal.example` and expect exit 0 (`it.skipIf(!process.env.CADDY_PATH)`). Also assert `docs/self-hosted/README.md` contains `TRUSTED_PROXY_HOPS=1`, `PORTAL_BIND_HOST=127.0.0.1`, `--mode deployment`, `PORTAL_ALLOW_FROM` and the on-host health check `127.0.0.1:4025/healthz`

### Implementation for User Story 4

- [X] T031 [US4] Create `docs/self-hosted/Caddyfile` per research R12 and `contracts/self-hosted-proxy.md` P1–P10, with a header comment: what it is for (a self-hosted portal on one machine with Caddy in front), that `PORTAL_HOST` and `PORTAL_ALLOW_FROM` come from Caddy's environment, that the default allow-list (TEST-NET-1) refuses everyone, and that the allow-list is personal data and never committed. T-PROXY-01's text checks pass
- [X] T032 [US4] Create `docs/self-hosted/README.md`, the procedure (spec FR-022): prerequisites (Caddy 2, a DNS name, the tenant's `portal_origin` set in the operator's tfvars file and applied with `npm run auth0:tenant`, SPEC 1.26); build (`npm run build` and `npm run build:web -- --mode deployment`); `env/portal.env` as in the contract's settings table (Auth0 sign-in, no `AUTH_JWKS_FILE`, `PORTAL_BIND_HOST=127.0.0.1`, `TRUSTED_PROXY_HOPS=1`); Caddy's environment (`PORTAL_HOST`, `PORTAL_ALLOW_FROM` as space-separated CIDRs, for example the private network's range); reload; then the direct-connection check table of `contracts/self-hosted-proxy.md` (curl, `testssl.sh` or SSL Labs, an outside port scan, and `curl -sS http://127.0.0.1:4025/healthz` on the host itself, which must still answer 200), and what to do if a check fails. No host name, address or account of the owner's. T-PROXY-01 passes
- [X] T033 [US4] Update `SPEC.md` L2-8 with a short "Self-hosted behind a front proxy (v1.27)" paragraph (the portal on one machine behind the owner's proxy: Auth0 sign-in, loopback bind, `TRUSTED_PROXY_HOPS=1`, deployment build; the reference in `docs/self-hosted/`, which this repository doesn't run), the v1.27 residuals "the self-hosted host's exposure depends on the owner's proxy and allow-list, which no test here can see" and "in Azure the ingress can't filter paths, so `/healthz` and `/readyz` stay reachable from the internet; they say only `ok`, `ready` or `starting`" (research R13), a "Changes in 1.27" row and the §12 row T-PROXY-01

**Checkpoint**: the owner has everything needed to put the dev host behind the allow-list (applied in T058).

---

## Phase 7: User Story 5 - A path that isn't part of the portal answers "not found" (Priority: P3)

**Goal**: 200 with the page only for the web app's screens; 404 for everything else; bare 404 for missing built files, dot-paths and traversal (finding 3).

**Independent Test**: the probe list's 56 sensitive paths and 8 traversal payloads (the report's examples and families) all answer 404; every screen example answers 200 with the page.

### Tests for User Story 5 (write first; they must fail)

- [X] T034 [P] [US5] Write T-WEB-14 in `web/portal/test/screens.test.ts` (first line `// @vitest-environment jsdom`): every key of the exported `SCREEN_NEEDS` from `web/portal/src/routes.ts` except `not-found` has exactly one row in `PORTAL_SCREENS` (`src/shared/portal-screens.ts`); for each row, `matchRoute(row.example).name === row.name` and `isScreenPath(row.example)` and `isScreenPath(row.example + "/")` are true; `isScreenPath` is false for `/api/me`, `/assets/x.js`, `/nope`, `/policies/a/b/c`, `/.env`
- [X] T035 [P] [US5] Write T-PRT-17 in `test/portal.test.ts`, new `describe("T-PRT-17 only the portal's own paths answer 200")`, with a web root holding `index.html` (a marker text) and `assets/index-abc.js`: every `PORTAL_SCREENS` example and `/policies/` answer 200 with the page on GET and HEAD; `/index.html` and `/assets/index-abc.js` 200; `/nope` with `Accept: text/html` 404 with the page; `/nope` with `Accept: application/json` and with no `Accept` 404 `{ "error": "not found" }`; `POST /` and `PUT /policies` 404 JSON; a list of 56 sensitive paths kept in the test (the report's examples `/.env`, `/.git/HEAD`, `/backup.zip`, `/assets/index-ZtKxaTnm.js.map`, plus dotfiles and dot-folders, backups and archives, config and secret files, admin consoles and source maps, per research R7) and 8 traversal payloads (`/assets/..%2f..%2fetc/passwd`, `/%2e%2e/%2e%2e/etc/passwd`, `/..%252f..%252fetc/passwd`, `/assets/%2e%2e%5c%2e%2e%5cwindows/win.ini`, `/x/%00`, `/%c0%ae%c0%ae/etc/passwd`, `/assets/....//....//etc/passwd`, `/assets/..;/..;/etc/passwd`) all answer 404 with `Accept: text/html` and never a file's content; the dot-paths and the 8 traversal payloads answer the bare `{ "error": "not found" }` (never the page's marker), the others may carry the page (FR-012). Send the traversal payloads with `rawRequest` (T004), because `fetch` normalizes `%2e%2e` segments before sending. Must-fail: with `skipNotFoundRules: true`, `/.env` with `Accept: text/html` answers 200 (today's catch-all)

### Implementation for User Story 5

- [X] T036 [US5] Create `src/shared/portal-screens.ts`: `PORTAL_SCREENS: readonly { name: string; pattern: RegExp; example: string }[]` with one row per screen of `web/portal/src/routes.ts` (`home ^/$`, `profile-step ^/onboarding/profile$`, `wallet-step ^/onboarding/wallet$`, `policy-step ^/onboarding/policy$`, `profile ^/profile$`, `wallet ^/wallet$`, `policies ^/policies$`, `policy-new ^/policies/new$`, `policy-edit ^/policies/[^/]+$`, `policy-history ^/policies/[^/]+/history$`, `account ^/account$`, `admin-waiting ^/admin$`, `admin-activity ^/admin/activity$`, `admin-ledger ^/admin/ledger$`, `admin-payment ^/admin/escalations/[^/]+$`), and `isScreenPath(path)` that removes trailing slashes (`/` stays `/`) and tests the rows; header comment: research R8, the web app's own matcher stays in `routes.ts` and T-WEB-14 keeps them equal
- [X] T037 [US5] In `web/portal/src/routes.ts` lift the `needs` record out of `resolveRoute` to an exported `SCREEN_NEEDS` constant (typed `Record<Screen["name"], keyof Onboarding | "all" | "none">`), used by `resolveRoute` unchanged. T-WEB-14 passes and the existing web route tests still pass
- [X] T038 [US5] In `src/portal/server.ts` replace the web app block (from `express.static` to the `app.get(/.*/` fallback) with the order of research R7: (1) a middleware for non-API paths that answers `404 { "error": "not found" }` when any `/`-separated segment of `req.path` starts with `.` after `decodeURIComponent`, fails to decode, or decodes to a value containing `/`, `\` or `\0`; (2) `express.static(webRoot, { index: false, redirect: false, dotfiles: "ignore" })`; (3) `app.use("/assets", …)` answering `404 { "error": "not found" }`; (4) `app.get` for `isScreenPath(req.path)` sending the page with 200; (5) GET or HEAD whose `Accept` header contains `text/html` gets the page with status 404; the existing final `404 { "error": "not found" }` stays last. Add `skipNotFoundRules?: boolean` to `PortalDeps` (T-PRT-17 must-fail; never set by the entry point), which mounts today's catch-all instead. T-PRT-17 passes
- [X] T039 [US5] Update `SPEC.md` L2-8 (the portal serves the web app's page with 200 for its screens only; 404 otherwise, with the page for a browser navigation; a bare 404 for missing built files, dot-paths and traversal), `specs/013-l2-portal-onboarding/contracts/portal-api.md` "Routes" (the static files and the page), §11 **SEC-47** (threat: a catch-all 200 hides real 404s from monitoring and makes probes look successful; control: the 404 rules; tests T-PRT-17, T-WEB-14), a "Changes in 1.27" row and §12 rows T-PRT-17, T-WEB-14

**Checkpoint**: probes for files that don't exist get 404; people still land on their screens.

---

## Phase 8: User Story 6 - Browsers are told which features and cross-origin uses the portal allows (Priority: P3)

**Goal**: Permissions-Policy, CORP and COOP on every portal answer, with the sign-in pop-up and card registration still working (finding 5).

**Independent Test**: the three headers on a page, a built file, an API answer, a health answer and an error; then the manual browser check in T058.

### Tests for User Story 6 (write first; they must fail)

- [X] T040 [US6] Extend T-PRT-16 in `test/portal.test.ts` (after T006): on every answer kind of T006, with both host names, `permissions-policy` equals `camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=(self "https://js.stripe.com")`, `cross-origin-resource-policy` equals `same-origin`, `cross-origin-opener-policy` equals `same-origin-allow-popups`, and no `cross-origin-embedder-policy` is sent; T-PRT-07's CSP and other assertions are untouched

### Implementation for User Story 6

- [X] T041 [US6] In `src/portal/server.ts` export `PERMISSIONS_POLICY`, built from `CARD_VAULT_CSP.script[0]` (`https://js.stripe.com`) as in research R9, and set `Permissions-Policy`, `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin-allow-popups` in the first middleware beside the CSP. T-PRT-16 passes
- [X] T042 [US6] Update `SPEC.md` L2-8 "Limits and headers" (the three headers and why COOP is `same-origin-allow-popups`: the pop-up sign-in answers by a web message), `specs/013-l2-portal-onboarding/contracts/portal-api.md` "Limits and headers", §11 **SEC-46** (threat: a page of the portal can be read as a resource by another origin, keep a cross-origin opener, or be granted powerful browser features through an injected frame; control: CORP, COOP and Permissions-Policy on every answer; test T-PRT-16), a "Changes in 1.27" row and the T-PRT-16 §12 row's wording (transport and browser policies)

**Checkpoint**: finding 5 closed, pending the deployed browser check (T058).

---

## Phase 9: User Story 7 - A stranger learns from the portal only what sign-in needs (Priority: P3)

**Goal**: `/api/config` carries `auth` and `cards` only; the administration area comes from `me.admin`; the image's web build has no pasted-token sign-in (finding 4, disclosure).

**Independent Test**: `/api/config` fields; an administrator and an ordinary user see the right navigation; a deployment build contains no dev sign-in text while a default build does.

### Tests for User Story 7 (write first; they must fail)

- [X] T043 [P] [US7] Write T-PRT-18 in `test/portal.test.ts` and amend T-PRT-01 "/api/config needs no token": the body is exactly `{ auth: { mode, domain, clientId, audience }, cards: { available[, publishableKey] } }` with dev and Auth0-shaped sign-in, cards on (`vault`) and off, administration on (`admin: true`) and off; `network` and `admin` are absent in every case. In `test/portal-admin.test.ts` replace the two `/api/config` `admin` expectations (lines asserting `{ available: true }` / `{ available: false }`) with: no `admin` field in `/api/config`, and `GET /api/me` for an administrator gives `admin: true` with the area on and `admin: false` with it off
- [X] T044 [P] [US7] Write T-WEB-15 in `web/portal/test/admin.test.tsx`: drop `admin` and `network` from `CONFIG` in `web/portal/test/helpers.tsx` and `ADMIN_CONFIG`; the administration link and area show when `me.admin` is true and not when it is false (the existing "area off" case now comes from `me.admin: false`)
- [X] T045 [P] [US7] Write T-WEB-16 in `test/web-build.test.ts` (Node environment, timeout 120 s): with Vite's `build()` API and `configFile: "web/portal/vite.config.ts"`, build twice into fresh temporary folders (`build: { outDir, emptyOutDir: true }`, `logLevel: "silent"`): with `mode: "deployment"` no emitted `.js` or `.html` file contains `Development sign-in` or `dev-token`; with the default mode at least one does (the control, research R11). Remove both folders afterwards
- [X] T046 [P] [US7] Amend T-IMG-03's "gained" case in `test/images.test.ts`: the literal it searches for becomes `"npm run build:web -- --mode deployment &&"` and the text it puts in becomes `"npm run build:web -- --mode deployment && npm run build:docs &&"`, so the case's changed Dockerfile keeps the deployment build and differs only by the gained script

### Implementation for User Story 7

- [X] T047 [US7] In `src/portal/server.ts` (`GET /api/config`) drop `network` and `admin` from the body; in `web/portal/src/types.ts` drop them from `Config`; in `web/portal/src/app.tsx` set `const administrator = me.admin;` (comment: `portalAccess` sets it only where the area is on). T-PRT-18, T-PRT-01, the portal-admin test and T-WEB-15 pass
- [X] T048 [US7] In the web app: `web/portal/src/env.d.ts` declares `interface ImportMetaEnv { readonly MODE: string } interface ImportMeta { readonly env: ImportMetaEnv }`; new `web/portal/src/auth/dev-sign-in.ts` exports `DEV_SIGN_IN = import.meta.env.MODE !== "deployment"`; `web/portal/src/main.tsx` drops the static `createDevAuth` import and, when `config.auth.mode === "dev"`, does `if (DEV_SIGN_IN) auth = (await import("./auth/dev.js")).createDevAuth(); else` renders "This build of the portal has no local sign-in." in the same shape as the "can't be reached" message and returns; `web/portal/src/screens/SignedOut.tsx` renders the pasted-token field only under `DEV_SIGN_IN && auth.mode === "dev"`; `web/portal/src/app.tsx` renders `DevConfirm` and takes the dev branch of `confirmIdentity` only under `DEV_SIGN_IN`. `npm run typecheck` and the web tests pass (vitest's `MODE` is `test`)
- [X] T049 [US7] In `docker/portal.Dockerfile` change the build line to `RUN npm run build && npm run build:web -- --mode deployment && npx tsx scripts/image-closure.ts portal /out`, with a comment line (the deployment build has no pasted-token sign-in, SPEC v1.27). T-WEB-16 and T-IMG-03 pass; where Docker is available, build the image once by hand (`docker build -f docker/portal.Dockerfile .`) and note the result in the PR
- [X] T050 [US7] Update the config schema in `docs/portal.openapi.yaml` (no `network`, no `admin`) and run `npx vitest run test/openapi-portal.test.ts`; update `specs/013-l2-portal-onboarding/contracts/portal-api.md` (`/api/config`) and `specs/014-portal-l2-control-api/contracts/portal-api.md` (where it names `admin.available`: the web app reads `me.admin`); update `SPEC.md` L2-8 (the public configuration's fields; the image's web build has no pasted-token sign-in), §11 **SEC-48** (threat: the public configuration and the client tell a stranger the environment, whether an administration area exists and how the dev sign-in works; control: a smaller configuration and a deployment build; tests T-PRT-18, T-WEB-15, T-WEB-16), the v1.27 residual "the administration routes' names are in the client: every one is authorized by the portal and by L2, and hiding them is not a control", a "Changes in 1.27" row, §12 rows T-PRT-18, T-WEB-15, T-WEB-16 and the amended T-IMG-03

**Checkpoint**: finding 4's disclosure half closed.

---

## Phase 10: User Story 8 - A refused caller is told how to authenticate, and the PKCE residual is recorded (Priority: P3)

**Goal**: `WWW-Authenticate: Bearer` on every 401 of both public services; PKCE `plain` recorded (finding 7).

**Independent Test**: no token and a bad token to each service; the challenge with and without `invalid_token`; nothing on 403, 421 or 429.

### Tests for User Story 8 (write first; they must fail)

- [X] T051 [P] [US8] Write T-EDGE-06 in `test/edge-challenge.test.ts`, for the portal (`GET /api/me`) and the agent (`POST /v1/runs`), the 421 case through `rawRequest` (T004): no `Authorization` → 401 with `www-authenticate` exactly `Bearer realm="x402-portal"` / `Bearer realm="x402-agent"`; `Bearer a.b.c`, an expired token and a wrong-audience token → `Bearer realm="…", error="invalid_token"`; a portal token with no sign-in time claim → the portal's `invalid_token` form; a 403 (agent-client token at the portal; no `agent:run` at the agent), a 429 and (dev mode, `Host: portal.example`) a 421 carry no `www-authenticate`; no challenge contains `error_description`

### Implementation for User Story 8

- [X] T052 [US8] In `src/shared/identity-token.ts` add `bearerChallenge(realm: string, tokenPresented: boolean): string` beside `bearerToken` (RFC 6750 §3, research R6); in `src/portal/access.ts` set `res.set("WWW-Authenticate", bearerChallenge("x402-portal", token !== null))` in `refuse(401)` (all three 401 paths); in `src/layer1-intent/hosted/requester-auth.ts` set `bearerChallenge("x402-agent", …)` on both 401 branches. T-EDGE-06 passes
- [X] T053 [US8] Add a `headers: WWW-Authenticate` entry (schema string, description with the two forms) to `components.responses.Unauthorized` in `docs/portal.openapi.yaml` and `docs/l1-hosted.openapi.yaml`; run `npx vitest run test/openapi-portal.test.ts test/openapi-hosted.test.ts`; update `SPEC.md` L1-6 and L2-8 (the challenge on 401), the v1.27 residual on PKCE `plain` with research R14's reasoning, a "Changes in 1.27" row and the §12 row T-EDGE-06; and the contracts' access sections (`specs/013-l2-portal-onboarding/contracts/portal-api.md`, `specs/011-l1-hosted-agent-azure/contracts/hosted-agent-api.md` `POST /v1/runs`, `specs/016-agent-auth0-streaming/contracts/hosted-agent-api.md`)

**Checkpoint**: all seven findings have code, a reference or a recorded residual.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: the records the constitution and FR-026/FR-027 require, the full check, and the owner's manual steps.

- [X] T054 [P] Write `specs/017-dast-findings-remediation/dispositions.md`: one row per finding 1–7 with the fields of data-model.md "Finding disposition" (outcome, the FR IDs, the test IDs or quickstart step, the reason for anything accepted: finding 6's Azure health routes, finding 7's PKCE `plain`, finding 4's route names in the client), and a closing line that SC-001 and SC-002 are confirmed only after T058
- [X] T055 [P] Update `specs/007-process-isolation-security/contracts/threat-matrix.md` with SEC-43..SEC-48 and the v1.27 residuals, and `specs/README.md`: header line (amended through v1.27 by 017), a row for 017 (layer: portal + L1 edge; scope: L2-8 limits and headers, static files, public configuration, the deployment build; L1-6 dev sign-in, failure limit, challenge; the self-hosted reference; NFR: SEC-43..48, the residuals), and the traceability rows (L1-6, L2-8, SEC-43..SEC-48, T-EDGE-01..06, T-PRT-16..18, T-WEB-14..16, T-PROXY-01)
- [X] T056 Update `CLAUDE.md` Gotchas: the dev sign-in works only from the machine (loopback bind, no declared proxy, 421 otherwise; a test sends a public `Host` only with the Auth0-shaped issuer); the failure limit (20 × 401 a minute per address, a direct argument after `addressLimit`, CodeQL's pattern); the portal image builds the web app with `--mode deployment`, which drops the pasted-token sign-in; `docs/self-hosted/` is the reference for a portal behind the owner's proxy (`TRUSTED_PROXY_HOPS=1`), never run by the pipelines; the new must-fail switches (`skipLocalOnly`, `skipFailureLimit` on the portal and the agent, `skipNotFoundRules` on the portal) are test-only deps, never env. Add `npm run build:web -- --mode deployment` and `CADDY_PATH=… npx vitest run test/self-hosted.test.ts` to Commands
- [X] T057 Run `npm run typecheck`, `npm test` and `npm run demo:local` (`npm run check`, defined in `package.json`); expect green and the demo summary of T001 unchanged; then run quickstart.md §2 and §3 by hand and fix anything that differs from the tables
- [ ] T058 Manual, needs the deployed portal and the dev host (the owner): quickstart.md §4 on the Azure portal after `deploy-portal.yml` (headers, the smaller `/api/config`, sign-in through the pop-up with `code_challenge_method=S256`, identity confirmation, a test card, the administration area, sign-out; and the tenant's settings checked for a PKCE method option, research R14); then §5 on the dev host (`docs/self-hosted/README.md` applied with the allow-list, every direct-connection check (the on-host health check included), the report's unauthenticated checks repeated from an allowed address, and `403` from an address off the list). Record the results in `dispositions.md` and tick SC-001, SC-002 and SC-008

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (T001)**: first.
- **Foundational (T002–T005)**: after Setup. T003 blocks US1 and US2; T004 blocks every story that uses a new switch, `tenant: true` or `rawRequest` (US1, US2, US3, US5, US8); T005 blocks every story's SPEC edit.
- **US1 (Phase 3)** and **US2 (Phase 4)**: after Foundational. US1's T006 uses the Auth0-shaped issuer for public-host requests, so it doesn't depend on US2's order.
- **US3, US5, US6, US7, US8**: after Foundational; independent of each other in behavior, but see "Same file" below.
- **US4 (Phase 6)**: independent of every other story (docs and one test file); its manual application (T058) comes last, after the image with US1–US8 is deployed.
- **Polish (Phase 11)**: after the stories chosen for the release. T058 after T057 and a deployment.

### Same file, so one writer at a time

- `src/portal/server.ts`: T008 (US1), T015 (US2), T026 (US3), T038 (US5), T041 (US6), T047 (US7). Do them in that order or serialize by hand.
- `src/layer1-intent/hosted/server.ts`: T016 (US2), T027 (US3).
- `test/portal.test.ts`: T006, T007, T017, T022, T035, T040, T043.
- `SPEC.md`: T005, T009, T018, T028, T033, T039, T042, T050, T053.
- `src/shared/address-limit.ts`: T023, T024. `src/shared/local-only.ts`: T003, T012.
- `test/edge-local-only.test.ts`: T002, T010, T011. `test/edge-failure-limit.test.ts`: T020, T021.

### Within each story

Tests first and failing (Principle VIII), then the shared module, then the service, then SPEC and contracts.
Each must-fail switch is shown in its story's test before the story is done.

### Parallel opportunities

- Foundational: T002 and T004 together, then T003.
- US2: T010 then T011 (same file), before T012; then T013 and T014 together; T019 beside T018.
- US3: T020 then T021 (same file), with T022 beside them.
- US4: entirely parallel to US1–US3 and US5–US8 (T030–T033 touch only `docs/self-hosted/`, `test/self-hosted.test.ts` and, at the end, `SPEC.md`).
- US5: T034 and T035 together; T036 before T037 and T038.
- US7: T043, T044, T045 and T046 together.
- Polish: T054 and T055 together.

---

## Parallel Example: User Story 7

```bash
# Tests first, all different files:
Task: "T043 Write T-PRT-18 in test/portal.test.ts and amend T-PRT-01 and test/portal-admin.test.ts"
Task: "T044 Write T-WEB-15 in web/portal/test/admin.test.tsx (and helpers.tsx CONFIG)"
Task: "T045 Write T-WEB-16 in test/web-build.test.ts"
Task: "T046 Amend T-IMG-03's gained case in test/images.test.ts"

# Then the implementation, in order:
Task: "T047 Smaller /api/config and me.admin"
Task: "T048 DEV_SIGN_IN in the web app"
Task: "T049 Deployment build in docker/portal.Dockerfile"
```

## Parallel Example: User Story 4 beside the others

```bash
# One person on the reference proxy while another works on the portal's server.ts:
Task: "T030 Write T-PROXY-01 in test/self-hosted.test.ts"
Task: "T031 Create docs/self-hosted/Caddyfile"
Task: "T032 Create docs/self-hosted/README.md"
```

---

## Implementation Strategy

### MVP first (User Stories 1 and 2)

1. T001 (baseline), T002–T005 (foundational).
2. US1 (T006–T009): HSTS by host name, the only Low finding with a CVSS score.
3. US2 (T010–T019): the dev sign-in stays on the machine, the risk the report calls "the real risk".
4. **Stop and validate**: `npm run check`; quickstart.md §2 rows for HSTS, 421 and the start-up refusals.
5. These two alone already close finding 1 in the app and the drift half of finding 4.

### Incremental delivery

1. MVP (US1 + US2).
2. US3 (failure limit) and US4 (reference proxy) — the P2 stories; US4 can be written in parallel from the start.
3. US5, US6, US7, US8 — the P3 stories, in any order, one writer on `src/portal/server.ts`.
4. Polish (T054–T057), deploy the portal image, then T058 on Azure and the dev host.

### Parallel team strategy

- Developer A: `src/portal/server.ts` stories in order (US1 → US2 → US3 → US5 → US6 → US7).
- Developer B: US4 (docs and T-PROXY-01), then US8 (access checks, OpenAPI), then the hosted-agent halves of US2 and US3 once A has merged the shared modules.
- One person keeps `SPEC.md` and the contracts, taking each story's text from its tasks.

---

## Notes

- [P] tasks = different files, no dependency on an unfinished task.
- Reference requirement IDs (SEC-43..SEC-48, L1-6, L2-8, CFG-2, T-…) in commit messages and test names
  (constitution, Development Workflow 5).
- Never weaken an existing test to make a story pass; the knock-on changes in plan.md are the only expected
  edits to existing assertions.
- Keep the dev host's name, any address of the owner's and the DAST report out of the repository.
