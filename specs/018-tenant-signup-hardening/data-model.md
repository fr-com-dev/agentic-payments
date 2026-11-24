# Data Model: Sign-Up Hardening for the Sign-In Tenant (018)

Nothing changes in L2's ledger, the portal's files or any contract type in `src/shared/contracts.ts`. The entities
below live in the sign-in tenant and in its declaration (`auth0/`).

## Tenant variables (the operator's tfvars file, `~/x402-tfstate/auth0.<env>.tfvars`)

| Variable | Type, default | Validation | Meaning |
|---|---|---|---|
| `allow_sign_ups` (existing, narrowed) | bool, `true` | bool | Self-service email-and-password sign-up is open. It drives the database connection's `disable_signup = !allow_sign_ups`, which also hides the page's "Sign up" link. It no longer binds an Action (step B, research R7). It says nothing about Google |
| `google_client_id` (new) | string, `""` | `""`, or `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$` | The project's own Google application. Not a secret. While `google_sign_in` is true, the Google connection must use exactly this client ID (precondition). Empty fails that precondition |
| `google_sign_in` (new) | bool, `true` | bool | Google sign-in, and so Google sign-up, is on for the portal's and the agent's applications. `false` is the emergency stop: it also stops existing Google people |

No variable holds the Google secret. The operator command refuses any variable whose name contains `secret`, and
any value with the `GOCSPX-` prefix (research R9).

## People's connection

| Field | Database (`Username-Password-Authentication`) | Google (`google-oauth2`) |
|---|---|---|
| Declared as | `auth0_connection.database` (imported; `prevent_destroy`) | `data "auth0_connection" "google"` (read only; `hide_client_secret = true`, `skip_enabled_clients = true`) |
| Strategy | `auth0` | `google-oauth2` |
| Self-service sign-up | `disable_signup = !var.allow_sign_ups` | Always on, by design: a first sign-in creates the person |
| Credentials | None: no `configuration` and no `custom_scripts`. The password policy is explicit, as imported | Client ID equals `var.google_client_id`. The secret is held only by the tenant, entered by hand |
| Enabled for | `auth0_connection_clients.database`: the portal and the agent | `auth0_connection_clients.google`: the portal and the agent, or none when `google_sign_in` is false |
| Never enabled for | L2's approval client, any machine caller | L2's approval client, any machine caller |

**Validation rules** (T-IAC-02, offline):

- exactly one `auth0_connection`, one connection data source and two `auth0_connection_clients`;
- no `auth0_connection_client`;
- `disable_signup` bound to the switch;
- `prevent_destroy` on the database connection;
- `hide_client_secret = true`;
- the client-ID precondition;
- `enabled_clients` only `auth0_client.portal.client_id` and `auth0_client.agent.client_id`;
- no `configuration`, `custom_scripts`, `client_secret`, `options_client_secret_wo` or `password =` anywhere.

**Validation rules** (live check, quickstart §2): the public client settings of the portal and the agent list exactly
these two connections. The database one shows `showSignup: false` while closed.

### State transitions

```text
email-and-password sign-up:   open (allow_sign_ups = true)  <->  closed (false)
                              one variable, one plan and apply; the page link and the endpoints follow together

Google sign-in:               on (google_sign_in = true)    <->  stopped (false)
                              stopped = no application may use Google: no new Google people, and no existing ones

Google application:           developer keys | another app  ->  the project's own app (by hand, quickstart §1)
                              the plan refuses (precondition) until the tenant holds var.google_client_id
```

## Person (tenant account)

| Field | Rule |
|---|---|
| `user_id` (subject) | `google-oauth2|<Google sub>` for Google, `auth0|<id>` for email and password. Fixed for life. Google's `sub` is the same for every Google application (research R8) |
| Created by | A first Google sign-in (anyone), self-service sign-up (only while open), or the operator in the Dashboard or Management API (always, research R1) |
| Roles at creation | None. Nothing in `auth0/` or its Actions assigns one (T-IAC-02). `x402-agent` and `x402-admin` are assigned by hand |
| Linking | None. Two subjects are two people, whatever their email addresses (FR-016) |
| Blocked / deleted | By hand in the tenant. A blocked person's sign-in ends with `access_denied`, which the portal shows as "The sign-in service refused this account". A deleted person's ledger entries stay (INV-9) |

## Portal user (L2, unchanged)

`userIdFor(issuer, sub)` (`x402-user-v2`, newline-separated). It is derived from the verified token only. There is
one portal user per subject, so a Google person and an email-and-password person with the same address are two
users, each with their own wallet (`contracts/new-person-access.md`).
