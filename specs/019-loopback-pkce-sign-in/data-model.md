# Data Model: Loopback PKCE Sign-In from a Desktop Client for the Hosted Agent

**Feature**: [spec.md](spec.md) | **Research**: [research.md](research.md)

Nothing here is stored by this system's services. The tenant holds the desktop client, the sign-ins and their
refresh tokens. The agent and L2 hold settings and, for one request, what they derive from a verified token. The
ledger gains no entry type.

## Desktop client (tenant object, `auth0/main.tf` `auth0_client.desktop`)

| Attribute | Value | Rule |
|---|---|---|
| name | `app-agent-desktop-<env>` | The tenant's naming, as `app-agent-<env>` |
| app type | native | FR-001 |
| first party, OIDC conformant | yes, yes | FR-001 |
| grant types | `authorization_code`, `refresh_token` | Nothing else (FR-001) |
| authentication | none (`auth0_client_credentials.desktop`, `authentication_method = "none"`) | No secret, no key (FR-001, FR-010) |
| callbacks | `http://127.0.0.1:53682/callback`, `http://localhost:53682/callback` | Exactly these, in every environment, not under `local_origins` (FR-002) |
| web origins, allowed origins, logout URLs | none | FR-002 |
| refresh tokens | rotating, expiring; absolute 2,592,000 s (30 days); idle 604,800 s (7 days); leeway 0; no infinite lifetime | FR-003 |
| client metadata | `x402_client = "agent-desktop"` | How the post-login rules recognize it ([research R4](research.md#r4-how-the-tenants-rules-recognize-the-desktop-client)) |
| connections | the agent's docs page client's (email and password, Google) | FR-009, through the sign-up hardening's declaration |

Its client ID is public. It appears in `AGENT_CLIENT_IDS` (agent and L2), `AGENT_DESKTOP_CLIENT_ID` (agent) and
the Terraform outputs, never as a secret.

## Sign-in and its refresh token family (tenant-held)

A sign-in through the desktop client yields an access token (people's API, one hour) and a refresh token. Each
renewal spends the refresh token presented and returns a new one: the chain is one family.

| Field | Source | Notes |
|---|---|---|
| access token `iss` | the tenant | `AUTH_ISSUER` |
| `aud` | people's API (+ the userinfo audience with `openid`) | contains `AUTH_AUDIENCE` |
| `azp` | the desktop client's ID | on `AGENT_CLIENT_IDS` |
| `permissions` | RBAC, from the person's roles | must contain `agent:run`: the only permission check |
| `scope` | asked scopes ∩ permitted | `openid offline_access agent:run` when the person holds the role; never read for a person |
| `https://x402.dev/auth_time`, `https://x402.dev/mfa_time` | the existing post-login rules | written as for any sign-in; the agent and L2 don't read them |
| refresh token | the tenant | held by the person's client only (its keychain); never sent to the agent or L2 |

No roles claim is added (Clarifications).

### State transitions

```text
signed out ──sign-in (role, second factor, S256)──▶ signed in
signed in  ──renewal (role still held)───────────▶ signed in (new access + refresh token; old refresh spent)
signed in  ──access token expires───────────────▶ signed in, must renew
signed in  ──7 days without renewal──────────────▶ ended
signed in  ──30 days after sign-in───────────────▶ ended
signed in  ──spent refresh token presented───────▶ ended (family revoked)
signed in  ──role removed, then a renewal────────▶ ended (renewal refused: not_authorized_for_agent)
signed in  ──refresh tokens revoked / person blocked / client off──▶ ended
signed out ──sign-in without role / no S256──────▶ signed out (no code, no token)
```

An access token already issued stays valid until it expires (an hour at most) in every "ended" case, unless the
desktop client is taken off `AGENT_CLIENT_IDS`, which refuses it at once.

## Post-login rules (tenant, `auth0/`)

| Rule | When | Effect |
|---|---|---|
| `sign-in-time.js` (existing, first in the flow, amended) | Every login | Writes the sign-in time as today. For the desktop client only, then: refuses `not_authorized_for_agent` without `x402-agent` (sign-in and renewal), and refuses `pkce_required` on a sign-in whose `/authorize` request did not use `S256`. Then asks for a second factor on an interactive sign-in by an administrator (today) **or** through the desktop client, when the latest second factor is older than the rest. Sets one claim, assigns no role, holds no secret, calls nothing |
| `mfa-time.js` (existing) | Every login, after the above | Unchanged |

No new Action: the refusals must run before any challenge ([research R5](research.md#r5-the-post-login-rule-refusal-and-pkce)).

## Requester (L1, in memory, per request)

`specs/016`'s requester gains one field:

| Field | Value |
|---|---|
| `client` | the verified token's client (`Caller.client`): a person's `azp`/`client_id`, a machine caller's own client |

Used for the run log only. The key for limits and logs stays `<issuer host>:<sub>`; session references stay bound
to kind, issuer and subject.

## Account readiness (L2, per request, from the ledger)

`BudgetStatus.account` on the user view: `ready | not_onboarded | disabled`, from `userGate(state)` of the person
in the verified token. With user accounts off L2 answers 403 `user_accounts_off` instead
([contracts/control-api.md](contracts/control-api.md)). Never stored; never carries personal data.
`disabled` is an account the person turned off at the portal (`USER_DISABLED`). Paused or removed policies don't
change readiness: `onboarded` stays true, the answer is `ready`, and each purchase is denied by policy (spec FR-016).

## Refusal codes (L1, on the wire)

| Status | `error` | `error_code` |
|---|---|---|
| 401 | `unauthorized` | `missing_token`, `token_expired`, `invalid_token` |
| 409 | `account not ready` | `account_not_onboarded`, `account_disabled`, `accounts_off` |
| 503 | `control unavailable` | `control_unavailable` |

## Sign-in settings (L1, on the wire)

`issuer`, `authorization_endpoint`, `token_endpoint`, `audience`, `client_id`, `scopes`, `redirect_uri`, all
derived from settings ([contracts/hosted-agent-api.md](contracts/hosted-agent-api.md#get-well-knownagent-auth-new-token-free)).

## Settings objects

| Where | Object | Change |
|---|---|---|
| `env/l1-hosted.env` | `AGENT_CLIENT_IDS` | Holds the docs page client and the desktop client |
| `env/l1-hosted.env` | `AGENT_DESKTOP_CLIENT_ID` | New, optional; must be on the list |
| `env/l2-control.env` | `AGENT_CLIENT_IDS` | Holds both, as the agent's |
| `auth0/outputs.tf` | `l1_env`, `bicepparam_agent` | Add the desktop client's ID |
| `infra/main.<env>.bicepparam` | `agent.desktopClientId` | New key, `''` allowed; `l1-apps` and `l2-apps` append it to `AGENT_CLIENT_IDS` when set |
| dev issuer (`scripts/dev-issuer-lib.ts`) | `DEV_DESKTOP_CLIENT = "x402-agent-desktop-dev"` | On the local stack's `AGENT_CLIENT_IDS`; `dev-token -- --desktop` mints a person's token from it |
