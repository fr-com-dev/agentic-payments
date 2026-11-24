# Contract: the tenant's people's connections (FR-001 to FR-010, FR-018, FR-018)

What `auth0/` declares about the ways people sign in, what the sign-in page and the public endpoints answer, and
what T-IAC-02 enforces. The values are in `data-model.md`; the reasons are in `research.md`.

## Declaration (`auth0/main.tf`, section "People's connections")

| Object | Shape | Rules |
|---|---|---|
| `auth0_connection.database` | `name = "Username-Password-Authentication"`, `strategy = "auth0"`. `options` explicit, as imported. `disable_signup = !var.allow_sign_ups` | `lifecycle { prevent_destroy = true }`. No `configuration`, `custom_scripts` or `password =` |
| `data "auth0_connection" "google"` | `name = "google-oauth2"`, `hide_client_secret = true`, `skip_enabled_clients = true` | Read only: Terraform never writes Google's options or secret |
| `auth0_connection_clients.database` | `connection_id = auth0_connection.database.id`. `enabled_clients = [auth0_client.portal.client_id, auth0_client.agent.client_id]` | Authoritative: a client enabled by hand shows in the next plan |
| `auth0_connection_clients.google` | `connection_id = data.auth0_connection.google.id`. `enabled_clients = var.google_sign_in ? [portal, agent] : []` | Precondition: while `var.google_sign_in`, `var.google_client_id != ""` and `try(data.auth0_connection.google.options[0].client_id, "") == var.google_client_id` (on developer keys both sides are empty, so the first test is needed) |

Removed in step B (research R7): `auth0_action.deny_sign_up`, `auth0_trigger_action.deny_sign_up` and
`auth0/deny-sign-up.js`. The tenant then has no pre-user-registration Action.

Imports for an existing tenant go in an uncommitted `auth0/imports.tf` (`auth0/README.md`, "Move to a new state"):

| Address | Import ID |
|---|---|
| `auth0_connection.database` | the database connection's ID (`con_…`) |
| `auth0_connection_clients.database` | the same ID |
| `auth0_connection_clients.google` | the Google connection's ID (`con_…`) |

Management API scopes added (research R10): `read:connections`, `update:connections`, `read:connections_options`,
`update:connections_options`. No `create:connections` and no `delete:connections`.

## What a visitor sees and gets

| Where | `allow_sign_ups = false` (dev) | `allow_sign_ups = true` |
|---|---|---|
| Public client settings, `https://<tenant>/client/<portal or agent client ID>.js` | `connections`: exactly `Username-Password-Authentication` (`showSignup: false`, `showForgot: true`) and `google-oauth2` | The same, with `showSignup: true` |
| The hosted login page | "Continue with Google", email-and-password sign-in, "Forgot password". No "Sign up" link | The same, with "Sign up" |
| `/u/signup` and `POST /dbconnections/signup` | Refused by Auth0, sign-up disabled (HTTP 400). No account | Accepted, as Auth0's own sign-up |
| The operator creates a user (Dashboard or Management API) | Created | Created |
| First "Continue with Google" | Creates the person, with no role | The same |
| Redirect to `accounts.google.com` after `/authorize?connection=google-oauth2` | `client_id=<var.google_client_id>`, `redirect_uri=https://<tenant>/login/callback` | The same |

With `google_sign_in = false`, neither application lists `google-oauth2`, and `/authorize?connection=google-oauth2`
is refused for both applications.

## T-IAC-02 rules added or changed (each with at least one must-fail mutant)

1. **Connections**:
   - exactly `auth0_connection.database`, `data.auth0_connection.google`, and `auth0_connection_clients.database`
     and `.google`;
   - no `auth0_connection_client`, and no other `auth0_connection` or connection data source.
2. **Enabled clients**: each list is exactly the portal's and the agent's client IDs (Google's also behind
   `var.google_sign_in`), never `auth0_client.l2` or `auth0_client.machine`.
3. **Email-and-password sign-up**: `disable_signup = !var.allow_sign_ups`. `allow_sign_ups` stays a bool, true by
   default.
4. **The database connection**: `prevent_destroy`, no `configuration` or `custom_scripts` block, no password value.
5. **Google**:
   - the data source has `hide_client_secret = true`;
   - there is the client-ID precondition;
   - no `client_secret` or `options_client_secret_wo` anywhere;
   - `google_client_id` validates as a Google client ID or is empty, and `google_sign_in` is a bool, true by default.
6. **Actions (step B)**:
   - the Actions are exactly `sign_in_time` and `mfa_time`;
   - no pre-user-registration Action;
   - `deny-sign-up.js` is gone;
   - the `SIGN_UPS` and `DENY_ONLY` checks and their mutants are replaced by rule 3.
7. **The operator command**: `check_tfvars` refuses a variable whose name contains `secret`, and a `GOCSPX-` value.
8. **`VARIABLES`**: gains `google_client_id` and `google_sign_in`.
