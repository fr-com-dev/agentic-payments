# Research: Loopback PKCE Sign-In from a Desktop Client for the Hosted Agent

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

Each section records a decision, why it was taken, and what else was weighed. The technical context had no open
question left after these. Auth0's behaviour was checked against its documentation on 2026-11-24. Where the
documentation is silent, the section says so and names the live check that settles it
([quickstart §5](quickstart.md#5-the-live-check-spec-19s-acceptance-tests-by-hand)).

## R1. The owner's decisions and the two corrections

- **Decision**: (a) The agent and L2 keep `agent:run` in `permissions` as their only check for a person; no roles
  claim. (b) The agent's 401 tells missing, expired and invalid apart, nothing more. (c) The audience is people's
  API (`AUTH_AUDIENCE`, `https://x402-api/<env>`), not `agentic-payments-claude-client`. (d) The role is the
  existing `x402-agent`, not a new `agent-runner`.
- **Rationale**: (a) and (b) are the owner's answers (spec Clarifications). (c) spec-19's own token checks and
  tests name `AUTH_AUDIENCE`; an API's identifier can't change, and one audience serves the portal, the agent and
  L2. (d) The tenant has exactly two roles (T-IAC-02, the constitution's Technology & Scope), and `x402-agent`
  holds exactly `agent:run`, which is what spec-19's role is for.
- **Alternatives considered**: a second API for the desktop client (two audiences at the agent and L2, and the
  portal's token rules split); a third role (breaks the two-role rule for a synonym).

## R2. What the two parallel features leave in place

- **Decision**: Build on both, after they merge. From the DAST remediation: `bearerChallenge(realm,
  tokenPresented)` and `AGENT_REALM = "x402-agent"` on every agent 401, the failed-authentication limit per
  address before the token is read, the dev issuer served to this machine only, and the `plain` PKCE residual.
  From the tenant sign-up hardening: people's connections (email and password, Google) declared in `auth0/` with
  the applications allowed on each, and the offline check that only the portal's and the agent's applications
  may sign a person in.
- **Rationale**: Both change files this feature changes (`requester-auth.ts`, `server.ts`, `auth0/main.tf`,
  `test/auth0-iac.test.ts`, `SPEC.md`). Writing the same challenge twice, or declaring connections in two places,
  would conflict at merge and leave two sources of truth.
- **Alternatives considered**: implementing in parallel and resolving at merge (the challenge and the
  connections would be written twice, and the SPEC version three times).

## R3. The desktop client at the tenant

- **Decision**: `auth0_client.desktop`, native, first-party, OIDC conformant, grants `authorization_code` and
  `refresh_token`, callbacks exactly `http://127.0.0.1:53682/callback` and `http://localhost:53682/callback` (a
  constant, not under `local_origins`), no origins or logout URLs, refresh tokens rotating and expiring with an
  absolute lifetime of 30 days, an idle lifetime of 7 days and `leeway = 0`. A separate
  `auth0_client_credentials.desktop` with `authentication_method = "none"`.
- **Rationale**: spec-19's values, which fit the provider: both lifetimes are under its maximum of 365.25 days,
  and the idle lifetime may not exceed the absolute one
  ([refresh token expiration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration)).
  With no leeway, presenting a spent refresh token revokes it with the whole grant
  ([rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)), and leeway
  is off by default ([Management API, create client](https://auth0.com/docs/api/management/v2/clients/post-clients)).
  The provider dropped `token_endpoint_auth_method` from the client and takes `none` on the credentials resource
  ([provider docs](https://registry.terraform.io/providers/auth0/auth0/latest/docs/resources/client)); the
  default without that resource isn't documented, so it is declared, as for the portal and the docs page client.
  `local_origins` keeps localhost out of deployed environments' browser clients (SPEC 1.19); a loopback return to
  a native client is the person's own computer and is needed in every environment.
- **Alternatives considered**: a custom URI scheme (needs OS registration by the client, out of scope); a
  variable loopback port (the tenant matches callbacks exactly); one callback only (browsers and OSes differ on
  `localhost` and `127.0.0.1`, and spec-19 registers both).

## R4. How the tenant's rules recognize the desktop client

- **Decision**: `client_metadata = { x402_client = "agent-desktop" }` on the desktop client; the rule checks
  `event.client.metadata.x402_client`.
- **Rationale**: The metadata is readable in the post-login event on sign-in and on a refresh (Auth0's own refresh
  examples read `event.client.metadata`;
  [refresh tokens with Actions](https://auth0.com/docs/secure/tokens/refresh-tokens/manage-refresh-tokens-actions)).
  It is set only by the tenant's configuration, needs no secret, and leaves the rule's code a static file that
  T-IAC-02 can run. The provider allows up to 10 metadata keys of 255 characters
  ([provider docs](https://registry.terraform.io/providers/auth0/auth0/latest/docs/resources/client)).
- **Alternatives considered**: spec-19's Action secret `CLI_CLIENT_ID` (an Action secret's value sits in the
  Terraform state as plain text, per the
  [provider docs](https://registry.terraform.io/providers/auth0/auth0/latest/docs/resources/action); a public ID
  stored as a "secret" also muddles T-IAC-02's no-secret rule); templating the client ID into the code (the file
  T-IAC-02 runs would no longer be the file deployed); matching on the client's name (editable in the dashboard
  without a trace in the plan's intent).

## R5. The post-login rule: refusal and PKCE

- **Decision**: The two refusals go into `sign-in-time.js`, the first rule of the post-login flow, before its
  second-factor challenge: (1) no `x402-agent` in `event.authorization.roles`, on any protocol →
  `api.access.deny("not_authorized_for_agent")`; (2) any protocol but `oauth2-refresh-token` with no
  `code_challenge`, or a `code_challenge_method` other than `S256`, in `event.request.query` →
  `api.access.deny("pkce_required")`. Desktop client only. No new Action.
- **Rationale**:
  - The tenant has no setting that requires PKCE, and its code flow works with or without it (Auth0 staff on
    the community forum; Auth0's support article on enforcing PKCE with Actions). So the rule is the only
    enforcement, and Auth0's documented way is an Action reading `event.request.query.code_challenge`
    ([support article](https://support.auth0.com/center/s/article/Enforce-PKCE-with-Actions)).
  - `event.request.query` holds the authorization request's parameters
    ([post-login event](https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/login-trigger/post-login-event-object)).
    `code_challenge_method` beside it is likely but not shown in the docs; refusing when it is missing fails
    closed.
  - Auth0 documents S256 as its only supported method
    ([authorize with PKCE](https://auth0.com/docs/api/authentication/authorization-code-flow-with-pkce/authorize-with-pkce)),
    while the DAST remediation found `plain` in the tenant's metadata; refusing anything but `S256` settles it
    for the desktop client.
  - `api.access.deny` stops the login flow
    ([post-login api](https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/login-trigger/post-login-api-object)),
    and the trigger also runs when a refresh token is used
    ([login trigger](https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/login-trigger)),
    so one check covers sign-in and renewal.
  - **Why not a new Action bound after `mfa-time.js`**: Auth0 issues a new `event.request` whenever a trigger is
    suspended, and a second-factor challenge suspends it
    ([Actions limitations](https://auth0.com/docs/customize/actions/limitations)). A PKCE check placed after the
    challenge may no longer see the original query. Placing the refusals first also means a person without the
    role is never asked for a second factor. Binding a new Action first would mean re-creating the existing
    bindings (the configuration appends bindings so that others' stay), with a moment where the flow lacks the
    sign-in time claim.
- **Undocumented, settled live**: whether `event.authorization.roles` is filled on a refresh (L7, with the
  fallback in plan.md Risks: the services still refuse a renewed token without `agent:run`), what error a client
  gets from a refused renewal (L7, role removal), and the exact `plain` behaviour (L9).
- **Alternatives considered**: `api.refreshToken.revoke` for renewals (documented, but an Enterprise feature);
  relying on the tenant to refuse a code exchange without a verifier (it doesn't).

## R6. The second factor for desktop sign-ins

- **Decision**: `sign-in-time.js`'s existing challenge (push or a one-time code, when the latest second factor is
  older than the rest of the sign-in, on browser protocols only) also applies to the desktop client, after the
  two refusals. Renewals are never challenged. `mfa-time.js` writes the second factor's time as today.
- **Rationale**: spec-19 asks for a second factor for this application; a refresh token lasting up to 30 days
  makes the interactive sign-in the one place to ask. The rule and factors already exist for administrators and
  are tested; the authorization-code flow of a native client runs on the same browser protocol
  (`oidc-basic-profile`). Every holder of `x402-agent` must be enrolled first (FR-007), as administrators are.
- **Alternatives considered**: a tenant-wide MFA policy (would ask every portal user); the second factor on every
  renewal (Auth0 can't show a challenge on a refresh).

## R7. The services' lists and settings

- **Decision**: `AGENT_CLIENT_IDS` holds both clients at the agent and at L2, in its existing comma-separated
  format. A new optional `AGENT_DESKTOP_CLIENT_ID` at the agent feeds the settings route and must be on the list,
  must not be the portal's, and is refused with the dev issuer. Terraform's `l1_env`, `l2_env` and
  `bicepparam_agent` carry the desktop ID; `infra/` gains `agent.desktopClientId`, appended to the list by
  `l1-apps.bicep` and `l2-apps.bicep` when set.
- **Rationale**: The list already exists for exactly this, and the agent and L2 must agree on it (spec Edge
  Cases). `AGENT_DESKTOP_CLIENT_ID` mirrors `API_DOCS_CLIENT_ID`'s checks. The VPS takes its env lines from the
  outputs (auth0/README.md step 7); the Azure templates stay correct though the environment is deleted.
- **Alternatives considered**: deriving the desktop client from the list (the list doesn't say which entry is
  which); a separate list at L2 (two lists to keep equal).

## R8. The account question reuses the budget route

- **Decision**: L2's `GET /v1/budget/:sessionId` user view gains `account: "ready" | "not_onboarded" |
  "disabled"` from `userGate(state)`. L2's caller check, row 6 (a person's token while user accounts are off),
  answers 403 `user_accounts_off` instead of `caller_forbidden`. `BudgetStatus.account?` joins the shared
  contract.
- **Rationale**: The route already carries the caller's token, already computes `userGate` for the person in the
  verified token, and already appends nothing; the agent already calls it. A distinct code for row 6 lets the
  agent tell "this L2 has no person accounts" (an answer: 409) from "L2 refuses this token" (a misconfiguration:
  503), which one code could not.
- **Alternatives considered**: a new route `GET /v1/account` (a new route for the same read, with its own role
  wiring, rate bound and OpenAPI entry); inferring readiness from zero caps (a spent budget also shows zero).

## R9. Where the question sits, and what it answers

- **Decision**: `account-check.ts` makes one budget call through the run's gate, bounded at 1 s, for a person's
  run, after the session check and before the limiter counts a start. Mapping: `ready` → run; `not_onboarded`,
  `disabled`, 403 `user_accounts_off` → 409 with `account_not_onboarded`, `account_disabled`, `accounts_off`; 401
  `caller_token_expired` → 401 `token_expired`; anything else → 503 `control_unavailable`. `check_budget` drops
  `account` from what the model sees.
- **Rationale**: After the cheap local checks and before any model call (SC-005, FR-016). Before `limiter.start`
  so a refusal isn't counted. Before the stream opens, so every refusal is JSON (016). A 409 keeps "finish your
  setup" apart from "you may not" (403). The 1 s bound meets NFR-005, and failing closed meets NFR-001. Dropping
  `account` from the tool keeps the JSON answer's steps unchanged and gives the model nothing new (Principle I).
- **Alternatives considered**: asking in parallel with the model's first call (the model would already have
  spent); 403 for a missing account (indistinguishable from the role refusal); no bound (a slow L2 would hold the
  request until the run's deadline).

## R10. The readable 401

- **Decision**: `{ "error": "unauthorized", "error_code": … }`, with `missing_token` when there is no bearer
  token and otherwise `verifyCaller`'s existing reason (`expired` → `token_expired`, `invalid` →
  `invalid_token`). The DAST remediation's challenge stays as it is. 403 unchanged.
- **Rationale**: The owner's decision (R1 b). `verifyCaller` already reports `expired` only when `jose` throws
  `JWTExpired`, and `jose` 6.2 checks the signature, then the issuer, the audience, `nbf` and last `exp`
  (`node_modules/jose/dist/webapi/lib/jwt_claims_set.js`), so "expired" means every other check passed. A token's
  expiry is readable from the token itself, so the code adds no oracle. Keeping `error` lets existing clients
  ignore the new field.
- **Alternatives considered**: spec-19's six codes (rejected by the owner); `error_description` in the challenge
  (forbidden by the DAST remediation).

## R11. The client in the run log

- **Decision**: `Requester.client` from `Caller.client`; `client` on every step and run line.
- **Rationale**: The run log already has the requester (issuer host and `sub`), the run, the session and the
  authorization, which covers spec-19's row 6 except the client. The client is public. No token, header or code
  ever reaches the log (SEC-16).
- **Alternatives considered**: logging the raw `azp` claim separately from the requester (the same value, twice).

## R12. The sign-in settings route

- **Decision**: `GET /.well-known/agent-auth`, token-free, mounted only with `AGENT_DESKTOP_CLIENT_ID`, after the
  per-address and failed-authentication limits and before the token check. Seven fields, all derived from
  settings; `Cache-Control: public, max-age=300`.
- **Rationale**: spec-19's optional row 7. The per-address limit covers it as every route after it; it has no
  token check, so the failed-authentication limit never counts it. Deriving the endpoints from `AUTH_ISSUER` keeps
  a custom domain consistent.
- **Alternatives considered**: RFC 8414 metadata at the agent (that describes an authorization server, which the
  agent isn't; the tenant already publishes its own); serving it from the docs routes (they exist only with
  `API_DOCS=1`).

## R13. The dev issuer and the tests

- **Decision**: `DEV_DESKTOP_CLIENT = "x402-agent-desktop-dev"` in `scripts/dev-issuer-lib.ts`, on every local
  list (`demo-lib.ts`, `vscode-local.ts`, `test/helpers/hosted.ts`, the env examples) and in
  `test/helpers/caller-tokens.ts`'s defaults; `npm run dev-token -- --desktop`. Must-fail switches are test-only
  deps: `revealCheck`, `skipAccountCheck`, `limitKey`, `singleForbiddenCode`.
- **Rationale**: The agent's and L2's checks are testable offline with tokens shaped like the desktop client's;
  only the browser sign-in needs the real tenant (spec Edge Cases). Constitution VIII and CLAUDE.md require
  must-fail proofs through test-only deps.
- **Alternatives considered**: a fake tenant with `/authorize` and `/oauth/token` for an offline end-to-end
  sign-in (it would test the fake, not Auth0, and spec-19 scopes client code out).

## R14. The live check against the tenant

- **Decision**: spec-19's acceptance tests run once by hand from the owner's computer, with `openssl`, `curl`,
  `jq` and `node`, before any client code exists ([quickstart §5](quickstart.md#5-the-live-check-spec-19s-acceptance-tests-by-hand)),
  keeping every token in `.local/` and printing only claims and statuses; results recorded in the quickstart's
  Validation log.
- **Rationale**: spec-19 asks for script or `curl` tests that each isolate one failure. A browser address bar
  holds the code when nothing listens on the port, so no listener code is needed. The undocumented behaviours of
  R5 and the consent prompt are settled here.
- **Consent**: a first-party client may still get a confirmation prompt when its callback is a non-verifiable
  address such as localhost, and Auth0 keeps the user's grant per application, API and scopes until revoked
  ([user consent](https://auth0.com/docs/get-started/applications/third-party-applications/user-consent-and-third-party-applications)).
  Whether `127.0.0.1` behaves the same is undocumented, and a refresh-token reuse may revoke the grant with the
  family (R3). L12 records what the person saw.
- **Alternatives considered**: a committed script that runs the flow (it would hold tokens in a long-lived tool
  and is close to the client code spec-19 scopes out).

## R15. SPEC, constitution and numbering

- **Decision**: SPEC's next version after both dependencies (expected 1.29), SEC entries from SEC-49, tests from
  T-AGT-16, T-CTK-10 and T-API-18; T-IAC-01 and T-IAC-02 amended. Constitution MINOR: Technology & Scope (four
  fixed applications) and Principle V (refresh tokens exist only in the portal's web app and the desktop client,
  never at a service).
- **Rationale**: The DAST remediation takes SEC-43..48 and the sign-up hardening T-AGT-15; both claim 1.27. A
  fixed application added is a constraint changed, not a principle redefined: MINOR under the constitution's
  governance. FR-027 requires the amendments before code.
- **Alternatives considered**: numbering now (both dependencies still move).

## R16. Delivery order

- **Decision**: rebase and amend; L2; L1; dev issuer and local lists; the tenant; infra; docs; then on the
  operator's host plan, apply, the VPS's env files and the live check ([plan.md "Delivery"](plan.md#delivery)).
- **Rationale**: L2's `account` field and row 6's code come first because the agent's mapping reads them. The
  tenant comes after the services so the services already accept the desktop client when it can issue tokens,
  and rollback is the reverse: off the lists first, then off at the tenant.
- **Alternatives considered**: the tenant first (a window where its tokens get 403 everywhere); one change for
  everything (harder to review against two moving dependencies).
