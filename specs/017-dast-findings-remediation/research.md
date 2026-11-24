# Research: Remediation of the Portal's DAST Findings

Each entry: the decision, why, and what else was considered. Facts about the code are as of `main` at 13229a9
(SPEC v1.25). External facts are marked with their source and how sure they are.

## R1. HSTS is decided by the request's host name, not the network profile

- **Decision**: The portal sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every answer
  unless the raw `Host` header names a loopback host (R2). The test `config.network !== "local"` in
  `src/portal/server.ts` goes.
- **Rationale**: The dev host runs `NETWORK=local`, which is exactly why the scan saw no HSTS. The raw `Host`
  header is the public name behind any proxy that keeps it (Caddy does by default; the Azure Container Apps
  ingress does too), so the rule needs no `TRUSTED_PROXY_HOPS`. Browsers ignore HSTS received over plain HTTP
  (RFC 6797 §8.1), so sending it on a non-TLS hop is harmless; skipping loopback names keeps a developer's other
  `localhost` servers from being pinned to HTTPS.
- **Alternatives**: `req.secure` (needs `trust proxy` and `X-Forwarded-Proto`; the dev host runs with no proxy
  declared, so it would still miss HSTS); always on (pins `localhost` for a year in a developer's browser);
  proxy only (leaves the portal wrong behind any other proxy).

## R2. One loopback rule, in `src/shared/local-only.ts`

- **Decision**: `isLoopbackHost(hostHeader)` accepts `localhost`, `127.0.0.1` and `[::1]`, any case, with an
  optional port and an optional trailing dot on `localhost`; nothing else (not `127.0.0.2`, `0.0.0.0`,
  `::ffff:127.0.0.1`, an empty or missing header). `isLoopbackBind(address)` accepts `127.0.0.1`, `::1` and
  `localhost`. Both are pure and shared by the portal, the hosted agent and their tests.
- **Rationale**: Three uses (R1, R3 start-up, R3 per request) must agree. The strict list fails closed (spec
  NFR-004); the default bind hosts are already `127.0.0.1` (`PORTAL_BIND_HOST_DEFAULT`, `DEFAULT_AGENT_BIND_HOST`).
- **Alternatives**: DNS resolution of the name (a public name can resolve to loopback: that is DNS rebinding);
  `127.0.0.0/8` (nothing in the repository binds or calls another loopback address).

## R3. The dev sign-in refuses anything that isn't the machine itself

- **Decision**:
  1. Start-up: `loadPortalConfig` and the hosted agent's config throw a `ConfigError` when `AUTH_JWKS_FILE` is set
     and the bind host is not loopback (`PORTAL_BIND_HOST` / `AGENT_BIND_HOST must be a loopback address with
     AUTH_JWKS_FILE (the local dev issuer)`), or `TRUSTED_PROXY_HOPS` is not 0 (`TRUSTED_PROXY_HOPS must be 0
     with AUTH_JWKS_FILE`). The value is never echoed.
  2. Per request: a middleware `localOnly()` from `src/shared/local-only.ts`, mounted first in both apps in dev
     mode only (before the health routes, the docs and the limits), answers `421 { "error": "misdirected request" }`
     when the `Host` header is not loopback (R2) or any of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`,
     `X-Forwarded-Proto`, `Via` is present. With the Auth0 sign-in it is not mounted.
  3. Must-fail: a test-only dep `skipLocalOnly` on both apps (never env) leaves it out; T-EDGE-03 shows a public
     host name is then served.
- **Rationale**: The dev host binds loopback behind its own proxy, so a bind check alone would not catch it; a
  proxy keeps the public `Host` and adds `X-Forwarded-For`, so the request check does. 421 Misdirected Request
  (RFC 9110 §15.5.20) says "wrong server" without naming the sign-in mode. Mounting it before the health routes
  is fail-closed and costs nothing: local probes call `127.0.0.1`.
- **Residual**: a proxy that rewrites `Host` to `localhost` and strips every forwarding header defeats the request
  check; the start-up check (no declared proxy, loopback bind) and the operator's own choice remain. Recorded in
  SPEC §11.
- **Alternatives**: refusing the dev sign-in unless `NODE_ENV=development` (nothing sets it today, and it says
  nothing about who connects); a `DEV_SIGN_IN_ALLOW_REMOTE` escape hatch (rejected: it is the drift the report warns
  about).

## R4. A separate limit on failed authentications, counted per address

- **Decision**: `failedAuthLimit()` in `src/shared/address-limit.ts`, built on the express-rate-limit already in use
  (8.7.5): `windowMs` 60 000, `limit` 20 (`MAX_FAILED_AUTH_PER_ADDRESS`), `skipSuccessfulRequests: true` with
  `requestWasSuccessful: (_req, res) => res.statusCode !== 401`, no counter headers, the same 429 body and
  `Retry-After` as `addressLimit`. It has its own store, so it never shares counts with the 300-a-minute limit.
  It is passed as a direct argument right after `addressLimit` and before the token check: `app.use("/api",
  addressLimit(...))`, `app.use("/api", failedAuthLimit(...))`, `app.use("/api", access, limit)` in the portal;
  `app.use(addressLimit(...))`, `app.use(failedAuthLimit(...))`, then `requesterAuth` in the agent. Must-fail: a
  test-only dep `skipFailureLimit` on both apps.
- **How it counts**: the library increments on each request and, with `skipSuccessfulRequests`, decrements when
  the response finishes with anything but 401. So the count is the number of 401s; once it is over 20, the
  request is refused before the next middleware (the token check) runs. A refused request answers 429, which is
  "successful" by this definition and is decremented, so the address stays refused until its window resets and
  not longer. Windows are per key (the store's reset time per client). The default key is the client address,
  IPv6 grouped by /56 (express-rate-limit 8 `ipv6Subnet`), which is what `addressLimit` already counts by.
- **What doesn't count**: `/api/config`, `/healthz`, `/readyz` and `/docs` are mounted before the limiter, so they
  never reach it (spec FR-008). 403s (a valid token of another client, an ordinary user on `/api/admin`) don't
  count.
- **Burst log**: the limiter's `handler` calls an `onLimit(key, resetTime)` hook; the app keeps a `Map<key,
  resetMs>` of keys already logged, pruned on each call, and writes one line per key per window: the portal
  `{ time, route: "/api/*", status: 429, ms: 0, event: "auth_failure_limit", count: 20 }` (adds `count` to the
  whitelist in `src/portal/log.ts`), the agent `{ event: "auth_failure_limit", count: 20 }` through a new
  `RunLog.event` method. The key stays in memory; no line carries an address, a token or a path value
  (spec FR-009, NFR-003).
- **Threshold**: 20 is far below 300 and far above what a browser makes (auth0-spa-js renews before expiry; a
  401 normally means a signed-out tab). Fixed, not a setting (spec NFR-003).
- **CodeQL**: `js/missing-rate-limiting` recognizes the package when it is a direct argument before a check
  (CLAUDE.md); the new limiter follows the same pattern and doesn't change what CodeQL sees.
- **Alternatives**: a lower `addressLimit` (would refuse people sharing an address on valid use); counting at the
  proxy only (the agent in Azure has no proxy of ours); RateLimit-* headers (kept off: v1.10 decided no counters
  in headers, and `Retry-After` is what the scan looked for).

## R5. A warning when a proxy is in front but not declared

- **Decision**: With `TRUSTED_PROXY_HOPS` 0, the first request carrying any of the R3 forwarding headers makes the
  service write one line per service instance, which is one per process in a deployment
  (`event: "proxy_undeclared"`), then nothing more. The request is served as
  today (unless R3 refuses it). In `src/shared/address-limit.ts` beside `trustProxies`.
- **Rationale**: Behind an undeclared proxy every client shares the proxy's address, so the per-address limits
  bound everyone together: one stranger can spend everybody's 300 and 20. The dev host was probably in this state.
  Refusing would break a working deployment; one line is enough to notice. In Azure the hops are 1 and nothing
  is written; locally nothing adds the headers.

## R6. The bearer challenge on 401

- **Decision**: `bearerChallenge(realm, tokenPresented)` beside `bearerToken` in `src/shared/identity-token.ts`
  returns `Bearer realm="x402-portal"` or `Bearer realm="x402-portal", error="invalid_token"` (realm
  `x402-agent` for the hosted agent). Set on every 401 in `src/portal/access.ts` (no token; a refused token;
  no usable sign-in time) and `src/layer1-intent/hosted/requester-auth.ts`. No `error_description`, nothing about
  which check failed. 403 (insufficient scope in RFC 6750 terms) stays as it is, without a challenge, as do 429
  and 421.
- **Rationale**: RFC 6750 §3 requires the challenge on 401; `invalid_token` is the code for a presented token that
  is refused, whatever the reason. L2's 401s are for role tokens on an internal network and stay as they are.

## R7. 404 for anything that isn't the portal's

- **Decision**: In `src/portal/server.ts`, for paths outside `/api` and the health and docs routes, in this order:
  1. **Dot-paths and traversal** (bare 404): any `/`-separated segment that starts with `.` after percent-decoding,
     or that fails to decode, or that decodes to something containing `/`, `\` or a NUL. Checked before the static
     handler, so `express.static` never sees them.
  2. **Built files**: `express.static(webRoot, { index: false, redirect: false, dotfiles: "ignore", fallthrough:
     true })`, as now.
  3. **Missing built files** (bare 404): any path under `/assets/` that the static handler didn't serve.
  4. **Screens** (200 with the page): GET or HEAD whose path, trailing slashes removed, matches the screen table
     (R8).
  5. **Anything else**: GET or HEAD whose `Accept` includes `text/html` gets the page with status 404 (the web app
     then shows its own "Not found"); every other request gets the existing bare `404 { "error": "not found" }`.
  Must-fail: a test-only dep `skipNotFoundRules` restores today's catch-all, and T-PRT-17 then fails on the
  report's paths.
- **Rationale**: Matches the report's remediation ("404 for unknown paths under /assets/ and for dotfiles; restrict
  the SPA fallback to known client routes") while a person who mistypes still sees the app. `/index.html` stays a
  built file (200). The web app has no `public/` folder, so the only root file is `index.html`. Today's error
  handler turns any thrown error into 400, which is why `fallthrough: false` is not used.
- **The report's paths**: the 56 sensitive paths and 8 traversal payloads are not in the report verbatim; T-PRT-17
  uses its named examples (`/.env`, `/.git/HEAD`, `/backup.zip`, `/assets/..%2f..%2fetc/passwd`,
  `/assets/index-ZtKxaTnm.js.map`) plus a fixed list in the same families (dotfiles and dot-folders, backups and
  archives, config and secrets files, admin consoles, source maps, encoded and double-encoded traversal), 56 and 8
  of them, kept in the test file.

## R8. The screen table lives in `src/shared/portal-screens.ts`

- **Decision**: `PORTAL_SCREENS: readonly { name, pattern, example }[]` with one row per screen of
  `web/portal/src/routes.ts` (fixed ones like `/policies`, and ones with a value like
  `^/policies/[^/]+/history$`, `^/admin/escalations/[^/]+$`), and `isScreenPath(path)`. The portal server uses
  it (R7 step 4). The web app's `matchRoute` stays as it is; its `needs` record is lifted to an exported
  `SCREEN_NEEDS` so a test can list every screen name. T-WEB-14 fails when a name in `SCREEN_NEEDS` (but
  `not-found`) has no row, when a row's `example` doesn't give that name from `matchRoute`, or when a row has no
  screen.
- **Rationale**: the web app already imports from `src/shared` (`types.ts` → `contracts.ts`), and the portal may
  import `src/shared` under hard rule 1, so both sides can see one table; a drift test is still needed because
  the web app keeps its own matcher (rewriting it is out of scope and riskier).
- **Alternatives**: the portal importing `web/portal/src/routes.ts` (breaks rule 1 and drags web code into the
  image); a route manifest written by the Vite build (one more build artefact the image closure must know).

## R9. Browser policy headers

- **Decision**: on every portal answer:
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(),
    payment=(self "https://js.stripe.com")` (the card provider's origin is the first entry of
    `CARD_VAULT_CSP.script`, built from it rather than written twice);
  - `Cross-Origin-Resource-Policy: same-origin`;
  - `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
  The CSP and the other headers stay exactly as T-PRT-07 pins them. No `Cross-Origin-Embedder-Policy`.
- **Rationale**: The sign-in is `loginWithPopup` with a web-message answer; `same-origin` would cut the pop-up off
  from its opener, `same-origin-allow-popups` keeps popups the page opens itself. Community reports confirm
  `same-origin` breaks auth0-spa-js pop-ups and point to `same-origin-allow-popups` (Auth0 Community "loginWithPopup:
  Cross-Origin-Opener-Policy policy would block the window.closed call"; auth0-spa-js issue #703); COEP
  `require-corp` breaks it too, so it is not added. Chrome may log a "COOP would block window.closed" warning
  that the tenant's own pages cause; it doesn't stop the sign-in. Confirmed only by the manual check in the
  quickstart (spec SC-008). CORP `same-origin` is safe because every resource the page loads from the portal is
  same-origin and the card frames load nothing from it. Card registration is a SetupIntent with the card element;
  allowing `payment` for the card provider keeps the DAST's suggested value and costs nothing.
- **Alternatives**: `unsafe-none` (status quo, what the finding is about); `same-origin` (breaks sign-in).

## R10. A smaller public configuration

- **Decision**: `GET /api/config` returns `{ auth: { mode, domain, clientId, audience }, cards: { available,
  publishableKey? } }`. `network` and `admin` go. The web app's `Config` type drops them; `app.tsx` shows the
  administration area from `me.admin` alone, which `portalAccess` already sets only when the area is on and the
  token has `portal:admin` (`src/portal/access.ts`).
- **Rationale**: `config.network` is read nowhere in the web app (the wallet screen shows the account's own
  network); `config.admin.available` only repeats what `me.admin` says. The tenant domain, client ID and
  audience are public by design and the sign-in needs them before anyone signs in.

## R11. Deployment builds carry no dev sign-in

- **Decision**: `web/portal/src/auth/dev-sign-in.ts` exports `DEV_SIGN_IN = import.meta.env.MODE !== "deployment"`.
  `main.tsx` loads `./auth/dev.js` with a dynamic import only under `DEV_SIGN_IN && config.auth.mode === "dev"`,
  and shows "This build of the portal has no local sign-in." when the server says `dev` but the build has none.
  The pasted-token field in `SignedOut.tsx` and the pasted-token identity confirmation in `app.tsx` are guarded
  by the same constant. The portal image builds with `npm run build:web -- --mode deployment`; the self-hosted
  procedure does too. `npm run build:web` (default mode `production`) keeps it for local work, the VS Code runner
  and step 1 of the pipelines. `env.d.ts` declares `ImportMeta.env.MODE` (no `vite/client` types: `types: []`).
- **Found during implementation**: with the constant imported from `dev-sign-in.ts`, the deployment build dropped
  the import from `main.tsx` but still wrote the dev module's chunk, unreferenced: Vite 8's bundler (Rolldown)
  collects dynamic imports before a constant from another module folds. `main.tsx` therefore tests
  `import.meta.env.MODE !== "deployment"` itself around the import; `DEV_SIGN_IN` still guards the interface
  (`SignedOut.tsx`, `app.tsx`). T-WEB-16 checks the chunks' modules as well as the text.
- **Evidence**: an experiment with this repository's Vite 8 (scratch project, same pattern) emitted the dev module
  as its own chunk and kept its inline text in `production` mode, and emitted neither in `deployment` mode: the
  constant folds and the branch, the dynamic import and its chunk are dropped. T-WEB-16 repeats this on the real
  app: a deployment build into a temporary folder contains none of the dev sign-in's marker strings
  (`Development sign-in`, `dev-token`), a default build does (the control).
- **Knock-on**: `test/images.test.ts` (T-IMG-03) finds `npm run build:web` in the Dockerfile and in step 1 by script
  name, so it still passes; its "gained" case replaces the literal `"npm run build:web &&"`, which becomes
  `"npm run build:web -- --mode deployment &&"`. vitest runs with `MODE` `test`, so the web tests keep the dev
  sign-in.
- **Alternatives**: make the default build the deployment one (changes every documented local step); strip at the
  server (it can't change what's in a file already served); lazy chunk only (the chunk is still in the image).

## R12. The reference front proxy is a Caddyfile in `docs/self-hosted/`

- **Decision**: `docs/self-hosted/Caddyfile` and `docs/self-hosted/README.md` (the procedure, FR-022). Not in
  `infra/`, which is Azure only (CLAUDE.md). Outline (contract in `contracts/self-hosted-proxy.md`):
  - global: `admin localhost:2019`, `auto_https disable_redirects` (so the HTTP site below answers instead of
    Caddy's automatic redirect server, which would send `Server: Caddy`);
  - `http://{$PORTAL_HOST}`: allow-list check, `header -Server`, `redir https://{host}{uri} 308`;
  - `{$PORTAL_HOST}`: `tls { protocols tls1.2 tls1.3 }`; `header { Strict-Transport-Security "max-age=31536000;
    includeSubDomains"; -Server; -Via }`; inside one `route` (so the order is literal): `@outside not remote_ip
    {$PORTAL_ALLOW_FROM:192.0.2.1/32}` → `respond 403`, `@internal path /healthz /readyz /docs /docs/*` →
    `respond 404`, then `reverse_proxy 127.0.0.1:4025`.
  - The allow-list is an environment value the owner sets where Caddy runs; its default is a TEST-NET-1 address
    (RFC 5737), so an unset list refuses everyone (spec FR-021). It never enters the repository (personal data).
  - The portal behind it: Auth0 sign-in (no `AUTH_JWKS_FILE`), `PORTAL_BIND_HOST=127.0.0.1`,
    `TRUSTED_PROXY_HOPS=1`, the web app built with `--mode deployment`.
- **External facts** (Caddy docs and forum, medium confidence; the quickstart checks each with curl):
  `reverse_proxy` adds `Via` to the response and Caddy sets `Server: Caddy`; a `header -Field` deletion is
  deferred until the response is written, so a site-level `header -Server -Via` removes both, including from
  `respond` answers; `remote_ip` matches the connection's address and ignores `X-Forwarded-For`; `reverse_proxy`
  replaces an untrusted client's `X-Forwarded-For` with the connection's address, so one declared hop is right;
  `{$VAR:default}` is substituted before parsing, so a space-separated list becomes several ranges.
- **Tests**: T-PROXY-01 reads the file and checks each required directive and the fail-closed default; when
  `CADDY_PATH` points at a Caddy binary it also runs `caddy validate --adapter caddyfile` (skipped otherwise, as the
  Bicep suites need `BICEP_PATH`). Caddy is not a dependency of the system.
- **Alternatives**: nginx (the repository's sidecars use it, but the dev host runs Caddy and the owner adapts this
  file); no reference at all (findings 1, 4 and 6 stay half-closed).

## R13. Health routes stay; the proxy hides them

- **Decision**: `/healthz` and `/readyz` keep answering without a token, status only, on the portal and the agent.
  The reference proxy answers 404 for them (and `/docs`) from outside. In Azure the ingress can't filter by path,
  so they stay reachable there: recorded as a residual (they say `ok`, `ready` or `starting`). Since SPEC 1.26 the
  Azure profile has no environment, so the residual applies only if it is deployed again.
- **Rationale**: Azure's liveness probes (`infra/modules/portal-apps.bicep`, `l1-apps.bicep`) and the smoke client
  (`src/smoke-main.ts`) call them.

## R14. PKCE `plain` stays a recorded residual

- **Decision**: No tenant change. SPEC §11 records: the tenant's discovery document lists `S256` and `plain`; the
  portal's and the agent's sign-in (auth0-spa-js 2.30.0 and the docs page) send `S256`; no tenant setting to drop
  `plain` was found; Auth0's PKCE guide says S256 is the method it supports, which conflicts with the metadata the
  scan saw; a post-login Action could refuse other methods, but post-login Actions also run on refresh-token
  exchanges, where no challenge exists, so it would put every renewal at risk for no gain. If Auth0 adds a
  setting, `auth0/` turns it on.
- **Rationale**: `plain` only matters when a client chooses it; ours don't, and a third party can't make a
  browser's request use it. Sources: Auth0 support "Enforce PKCE with Auth0 Actions"; Auth0 Community "RFC 7636
  violation - Weak enforcement of PKCE parameters". Low confidence that no setting exists: the quickstart's manual
  check includes looking at the tenant's settings and at the sign-in pop-up's address (`code_challenge_method=S256`).

## R15. What else changes with it

- **SPEC.md v1.27**: "Changes in 1.27"; L1-6 (dev sign-in on loopback only, the failure limit, the challenge);
  L2-8 "Limits and headers" (HSTS by host, the three new headers, the failure limit, the challenge, the 404
  rules, the public configuration's fields, the deployment build); CFG-2 notes on `AUTH_JWKS_FILE` with
  `PORTAL_BIND_HOST`, `AGENT_BIND_HOST` and `TRUSTED_PROXY_HOPS` (no new variable); §11 new SEC-43..SEC-48 and the
  v1.27 residual risks; §12 the new tests.
- **Constitution**: no amendment. No principle, invariant or package changes, and 1.18–1.25's security
  remediations were recorded in SPEC §11 only; the residual risks above go there too.
- **Contracts and docs**: `docs/portal.openapi.yaml` and `docs/l1-hosted.openapi.yaml` (the `WWW-Authenticate`
  response header on 401, the 429 descriptions, the config schema); `specs/013` contracts/portal-api.md "Limits and
  headers"; `specs/014` contracts/portal-api.md (`admin.available` is gone); `specs/011` and `specs/016`
  contracts/hosted-agent-api.md; `specs/007` contracts/threat-matrix.md; `specs/README.md` (row 017 and
  traceability); `CLAUDE.md` (the new must-fail switches, the dev sign-in rule, the deployment build, the
  self-hosted docs).
