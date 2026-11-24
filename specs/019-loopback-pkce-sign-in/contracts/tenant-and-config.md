# Contract: the tenant, settings and parameters (delta to SPEC §3.3, CFG-2, T-IAC-01, T-IAC-02)

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

Builds on the tenant sign-up hardening (people's connections declared, with the applications allowed on each)
and on `specs/016`'s tenant (the agent's docs page client, `agent:run`, `x402-agent`, machine callers). Applied
from the operator's host with `npm run auth0:tenant -- plan` then `-- apply` (SPEC 1.26).

## The tenant (`auth0/`)

### New: the desktop client

```hcl
resource "auth0_client" "desktop" {
  name            = "app-agent-desktop-${var.environment}"
  description     = "x402 hosted agent (${var.environment}): people sign in to it from a desktop client on their own computer (browser, loopback return, PKCE), to start runs for their own account."
  app_type        = "native"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["authorization_code", "refresh_token"]
  callbacks       = local.desktop_callbacks   # exactly the two loopback addresses, never under var.local_origins
  client_metadata = { x402_client = "agent-desktop" }
  jwt_configuration { alg = "RS256" }
  refresh_token {
    rotation_type                = "rotating"
    expiration_type              = "expiring"
    token_lifetime               = 2592000   # 30 days after the sign-in
    idle_token_lifetime          = 604800    # 7 days without a renewal
    infinite_token_lifetime      = false
    infinite_idle_token_lifetime = false
    leeway                       = 0         # a spent refresh token is reuse at once: the family is revoked
  }
}

resource "auth0_client_credentials" "desktop" {
  client_id             = auth0_client.desktop.client_id
  authentication_method = "none"
}
```

- `local.desktop_callbacks = ["http://127.0.0.1:53682/callback", "http://localhost:53682/callback"]`, a
  constant: the person's own computer, not a page the tenant's environments serve
  ([research R3](../research.md#r3-the-desktop-client-at-the-tenant)).
- `auth0_client_credentials.desktop` with `authentication_method = "none"` is declared explicitly: the provider
  no longer has `token_endpoint_auth_method` on the client, and the default without the resource is not
  documented.
- No `web_origins`, `allowed_origins`, `allowed_logout_urls` or `initiate_login_uri`.
- People's API (`auth0_resource_server.identity`) is unchanged: `allow_offline_access = true`, RBAC,
  `access_token_authz`, 3600 s, consent skipped for verifiable first-party clients.
- No default audience: `auth0_tenant.mfa_actions` sets nothing but its MFA setting (T-IAC-02 `MFA_SETTINGS`; a
  `default_audience` there is a must-fail mutant). The tenant doesn't limit which API a client asks for, for
  this client as for the others: a desktop token for the approval API (`auth0_resource_server.payments`, five
  minutes, no refresh token) gets 401 at the agent and L2, and no route accepts one from a caller (spec FR-004,
  quickstart §5 L6).

### Amended: the first post-login rule, `sign-in-time.js`

No new Action and no new binding: the desktop client's checks go into the rule that already runs first in the
post-login flow, before any second-factor challenge
([research R5](../research.md#r5-the-post-login-rule-refusal-and-pkce)). After writing the sign-in time claim, as
today, and only when `event.client.metadata.x402_client === "agent-desktop"`:

| # | Condition | Effect |
|---|---|---|
| 1 | `event.authorization.roles` does not include `x402-agent`, on any protocol (a sign-in or a renewal) | `api.access.deny("not_authorized_for_agent")`, and stop |
| 2 | Any protocol but `oauth2-refresh-token`, and `event.request.query` has no `code_challenge` or a `code_challenge_method` other than `S256` | `api.access.deny("pkce_required")`, and stop |
| 3 | A browser protocol, and the latest second factor is older than the rest of the sign-in (the administrators' rule) | `api.authentication.challengeWithAny` (push or a one-time code) |

- For every other client, nothing changes: the administrators' challenge as today, and no refusal.
- Checks 1 and 2 run before check 3, so a person without the role, or a request without S256, is refused
  before any challenge. Auth0 may issue a new `event.request` after a challenge, and the PKCE check needs the
  original `/authorize` query.
- The file's header changes from "never fails a sign-in by itself" to "fails a sign-in only for the desktop
  client, for the two reasons above". It still sets one claim, assigns no role, holds no secret, uses no
  package and calls nothing.
- `mfa-time.js` and the bindings are unchanged.

### Amended: people's connections (from the sign-up hardening)

The desktop client is allowed on exactly the connections the agent's docs page client is allowed on. The rule
"only the portal's and the agent's applications may sign a person in" becomes "only the portal's, the agent's
docs page and the desktop client". Its offline check fails when the desktop client is on any other connection.

### Outputs (`auth0/outputs.tf`)

| Output | Change |
|---|---|
| `l1_env` | `AGENT_CLIENT_IDS=<agent>,<desktop>` and a new line `AGENT_DESKTOP_CLIENT_ID=<desktop>` |
| `l2_env` | `AGENT_CLIENT_IDS=<agent>,<desktop>`, the same list as `l1_env` |
| `bicepparam_agent` | A new key `desktopClientId` |

## Settings (SPEC CFG-2)

| Process | Variable | Rule |
|---|---|---|
| hosted agent | `AGENT_CLIENT_IDS` | Both clients, comma-separated (format unchanged) |
| hosted agent | `AGENT_DESKTOP_CLIENT_ID` | New, optional: on the list, not the portal's, not with the dev issuer |
| L2 | `AGENT_CLIENT_IDS` | Both clients, as the agent's |
| local stack (`scripts/demo-lib.ts`, `scripts/vscode-local.ts`, `test/helpers/hosted.ts`) | `AGENT_CLIENT_IDS` | `x402-agent-cli-dev,x402-agent-desktop-dev` |

`env/l1-hosted.env.example` and `env/l2-control.env.example` document both.

## Parameters (`infra/`)

The Azure environment is deleted (SPEC 1.26), but its templates stay checked (T-IAC-01) and stay correct:

- `agent` in `infra/main.<env>.bicepparam` gains `desktopClientId` (`''` allowed).
- `l1-apps.bicep` and `l2-apps.bicep` set `AGENT_CLIENT_IDS` to `agent.clientId`, plus `,<desktopClientId>`
  when it is not empty; `l1-apps.bicep` sets `AGENT_DESKTOP_CLIENT_ID` to it.
- `main.bicep`'s `agentChecked` is unchanged: the desktop client is optional per environment.

## Tests

| ID | What | Must-fail |
|---|---|---|
| T-IAC-02 (amended) | Five kinds of application (`agent`, `desktop`, `l2`, `machine`, `portal`), each with its own credentials resource; the desktop client is native, first-party, OIDC conformant, grants exactly `authorization_code` and `refresh_token`, authentication `none`, callbacks exactly the two loopback addresses and not under `local_origins`, no origins or logout URLs, the refresh settings above, the metadata marker; still two permissions, two roles and three Actions, no Action secret; the outputs carry the desktop ID | One mutant per rule: a third grant, a wildcard or third callback, `leeway` > 0, `infinite_token_lifetime`, a secret, callbacks under `local_origins`, a missing marker, an Action secret |
| T-IAC-02 (rules run) | `sign-in-time.js` run against a stand-in for Auth0's `api`, for the desktop client: refuses no role on sign-in and on renewal, refuses a missing challenge, `plain` and a missing method, passes `S256` with the role, challenges a stale second factor only after both checks pass, never challenges a renewal; for every other client exactly today's behaviour (the existing cases) | A variant that skips check 1 on renewal (a renewal passes without the role); one that accepts `plain`; one that challenges before refusing (a person without the role is challenged) |
| T-IAC-02 (connections) | The desktop client on exactly the docs page client's connections | The desktop client on a third connection |
| T-IAC-01 (amended) | `agent.desktopClientId` in every environment's parameter file; `AGENT_CLIENT_IDS` composed of both when set, one when empty | A template that drops the desktop ID from L2's list |
