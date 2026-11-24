# auth0/: the Auth0 tenant, as code

Terraform for what the project needs from Auth0:

- L2's backchannel approval (SPEC L2-7, `specs/012`);
- people's sign-in at the portal (SPEC L2-8, `specs/013` research R19);
- the hosted agent's callers, people and machines (SPEC v1.17, `specs/016` research R9 and R10);
- the two ways people sign in, email and password and Google, and the clients that may use them (SPEC v1.27,
  `specs/017`).

It makes exactly four kinds of application (T-IAC-02 fails on any other):

- L2's backchannel approval client;
- the portal's single-page client;
- the agent's single-page client, through which the agent's docs page signs a person in;
- one confidential client per machine caller, for systems that start runs. The first is `checks`, the deployment
  pipeline's smoke run and scripted regression.

The Management API application Terraform signs in with (step 2 below) is made by hand and is not part of the
running system.

- **Who runs it**: an operator, on the operator's host (the sandbox's VPS), with the operator command
  `scripts/auth0-tenant.sh` (`npm run auth0:tenant`; SPEC 1.26). `plan` validates and saves a plan; `apply`
  applies exactly that plan. Nothing else applies this folder: no GitHub workflow holds an Auth0 credential, and
  `.github/workflows/validate-auth0.yml` only runs the command's `validate` (no backend, no credential) when this
  folder changes. The repository is public, so there is no self-hosted runner either.
- **Scope**: Azure stays Bicep only (`infra/`). This folder holds only Auth0 objects, through the official
  `auth0/auth0` provider.
- **Secrets**: the Management API application's credential, in the operator's own file
  `~/x402-secrets/auth0-management.<environment>.env` (mode 0600, in a 0700 folder). The command reads its two
  lines and passes them to Terraform's environment only: never exported, printed or written elsewhere. GitHub holds
  no Auth0 secret.
- **State**: a local file, `~/x402-tfstate/auth0.<environment>.tfstate` (mode 0600, in a 0700 folder), outside
  every checkout, with Terraform's variables beside it (`auth0.<environment>.tfvars`) and the saved plan while one
  waits (`auth0.<environment>.tfplan`). The state holds no secret, but it is what Terraform plans against: back it
  up ("Back up the state").
- **Terraform**: the command installs the pinned release (1.15.5, checked against its SHA-256) in `~/.local/bin`,
  without sudo, and never uses another `terraform` on `PATH`.
- **Test**: T-IAC-02 (`test/auth0-iac.test.ts`) checks the configuration, the command and the check offline, with
  must-fail mutants, runs the Actions' code, and runs the command's refusals against a stand-in Terraform.

## What it makes

| Resource | What it is | Becomes |
|---|---|---|
| `auth0_resource_server.payments` | The approval API. It uses RS256, the RFC 9068 token profile (tokens carry `jti`), 5-minute tokens, no refresh tokens and standard consent. It registers one Rich Authorization Requests type, `urn:auth0:schemas:authorization-details:v1:x402-payment`. Its access policy is: users through a client grant only, machines never. | `CIBA_AUDIENCE` |
| `auth0_client.l2` | L2's client: confidential, first-party and OIDC-conformant. Its only grant is CIBA (`urn:openid:params:grant-type:ciba`), and it notifies through `guardian-push` only. | `CIBA_CLIENT_ID` |
| `auth0_client_grant.l2_ciba` | The user-delegated grant that lets L2's client, and only it, request the payment-details type. | — |
| `auth0_client_credentials.l2` | `private_key_jwt` with the **public** half of L2's RS256 key (preferred), or `client_secret_post` with a secret you generate, sent write-only. | how L2 authenticates |
| `auth0_guardian.this` | Push notifications through the Guardian app, and one-time codes (Phase 3, for the administrators' second factor). It doesn't force MFA at login (`guardian_policy = "never"`). It is never destroyed, because destroying it would turn off every MFA factor of the tenant. | — |
| `auth0_tenant.mfa_actions` | Phase 3: the tenant setting "Customize MFA Factors using Actions" (`customize_mfa_in_postlogin_action`), without which `sign-in-time.js` can't choose the factors of its challenge. It sets nothing else of the tenant's, and exists only with `manage_guardian`. | — |

There is no approver (SPEC v1.16): each approval request goes to the person the payment is for, and nothing here
reads or manages a user.

For people's sign-in:

| Resource | What it is | Becomes |
|---|---|---|
| `auth0_resource_server.identity` | People's API, `https://x402-api/<environment>`. It uses RS256. It has two permissions (next rows), and a token's `permissions` list holds only the ones its holder's roles give, so most people's is empty. Tokens live one hour. Refresh tokens are allowed. | `AUTH_AUDIENCE`, `identity.audience` |
| `auth0_resource_server_scopes.identity` | The two permissions of people's API: `portal:admin` (014) and `agent:run` (016). | — |
| `auth0_role.admin`, `auth0_role_permissions.admin` | 014: the role `x402-admin`, which holds exactly `portal:admin`. It opens the portal's administration area and nothing else. Nobody is assigned here. | read by the portal from the token |
| `auth0_client.portal`, `auth0_client_credentials.portal` | The portal's web app: a public single-page client with no secret. It uses the authorization code with PKCE, and the `refresh_token` grant because its refresh tokens rotate. Its callbacks, web origins and logout URLs are `portal_origin` when set, and `http://localhost:4025` only where `local_origins` is on (dev). | `PORTAL_CLIENT_ID`, `userAccounts.portalClientId` |
| `auth0_action.sign_in_time`, `auth0_trigger_action.sign_in_time` | The first post-login Action, in `sign-in-time.js`. It writes one claim on the access token, `https://x402.dev/auth_time`: the time of the person's most recent authentication, in seconds. Phase 3: on an interactive sign-in in a browser of a holder of `x402-admin` whose latest second factor is older than the rest of the sign-in, or missing, it asks Auth0 to challenge them with Guardian push or a one-time code. Never on a refresh-token exchange, never for anyone else. It is appended to the tenant's post-login flow and replaces nothing there. | `AUTH_TIME_CLAIM` |
| `auth0_action.mfa_time`, `auth0_trigger_action.mfa_time` | Phase 3: the second post-login Action, in `mfa-time.js`, bound after the first (Auth0 challenges once an Action has run, so only a later one sees the second factor). It writes `https://x402.dev/mfa_time`: the time of the person's most recent second factor, in seconds, or nothing without one. The services require it, fresh, for an administrator's decision. | `DEFAULT_MFA_TIME_CLAIM` |
| `auth0_action.deny_sign_up`, `auth0_trigger_action.deny_sign_up` | Phase 3, only while `allow_sign_ups` is false: the pre-user-registration Action in `deny-sign-up.js`, which refuses every new account in the database and passwordless connections (`sign_up_closed`), the Dashboard's and the Management API's included. A first sign-in through a social or enterprise connection doesn't run it. Removed in step B of `specs/017`, once the connection's own setting (next rows) has been checked live. | — |

For the ways people sign in (SPEC v1.27, `specs/017`):

| Resource | What it is | Becomes |
|---|---|---|
| `auth0_connection.database` | The email-and-password connection, `Username-Password-Authentication`, imported. Its own "Disable Sign Ups" is `!allow_sign_ups`: closed, Auth0 refuses every self-service sign-up (the page, `/u/signup`, `POST /dbconnections/signup`) and the page shows no "Sign up" link, while you can still create a person in the Dashboard. Every option is written out, because an update replaces them all. It is never destroyed: it holds every email-and-password person. | — |
| `data.auth0_connection.google` | Google's connection, `google-oauth2`, read and never written, with `hide_client_secret`: the Google application's secret stays in the tenant and never reaches the state. | — |
| `auth0_connection_clients.database`, `auth0_connection_clients.google` | The clients that may sign a person in through each connection: exactly the portal's and the agent's (Google's only while `google_sign_in`). Each list is authoritative: a client enabled by hand shows in the next plan, and the apply takes it off. L2's approval client and the machine callers get no connection. A precondition on Google's list stops the plan unless the connection uses `google_client_id`, the project's own Google application. | — |

For the hosted agent's callers:

| Resource | What it is | Becomes |
|---|---|---|
| `auth0_role.agent`, `auth0_role_permissions.agent` | The role `x402-agent`, which holds exactly `agent:run`. Its holder may start runs at the hosted agent, for their own account. Nobody is assigned here. | read by the agent and L2 from the token |
| `auth0_client.agent`, `auth0_client_credentials.agent` | The agent's client: a public single-page client with no secret. Its only grant is the authorization code (with PKCE), so it gets no refresh token. Its callbacks are `<origin>/docs/oauth2-redirect.html`, and its allowed origins and web origins `<origin>`, for `agent_origin` when set, and `http://localhost:4024` and `http://127.0.0.1:4024` only where `local_origins` is on (dev). | `AGENT_CLIENT_IDS`, `API_DOCS_CLIENT_ID`, `agent.clientId` |
| `auth0_client.machine`, `auth0_client_credentials.machine`, `auth0_client_grant.machine` | One of each per name in `machine_caller_keys`. The client is confidential, with the client-credentials grant only and no callback, so it can't sign a person in. It authenticates with `private_key_jwt` and the **public** half of the caller's RS256 key: no secret exists. Its one grant is for people's API, with `agent:run` only. | for `checks`: `MACHINE_CLIENT_ID`, `MACHINE_CLIENT_KEY_ID`, `agent.machineClientId`, `agent.machineKeyId` |

Who accepts what:

- The portal accepts only its own client's tokens, and reads only `portal:admin`.
- The agent and L2 accept a person's token only from the agent's client (`AGENT_CLIENT_IDS`), and only with
  `agent:run`. Both refuse to start with the portal's client on that list.
- The agent and L2 accept a machine caller's token only with `agent:run` from its grant. A machine caller's client
  is never on `AGENT_CLIENT_IDS`.
- The agent role gives nothing at the portal, and the administrator's role gives nothing at the agent.

## What stays by hand

- **The plan.** CIBA needs the Enterprise plan or an add-on, and `private_key_jwt` needs Enterprise.
- **The Management API application** and its credential, in the operator's own file on the operator's host.
- **Guardian enrollment**: each person who approves their own payments by phone scans the QR code with their own
  phone.
- **An administrator's second factor** (Phase 3). Every interactive sign-in of a holder of `x402-admin` ends with
  Guardian push or a one-time code, and Auth0 ends the sign-in of one enrolled in neither. Enroll a person (for
  example with an enrollment invitation, **User Management → Users → the user → Multi-factor → Send an enrollment
  invitation**) before you assign them the role.
- **L2's private key** (or the secret): it goes into the l2 vault (`ciba-client-credential`) or a local
  `env/l2-control.env`, never into this folder, GitHub or the state.
- **The live check**, in `specs/012` quickstart §5.
- **A machine caller's private key**: it goes only where the caller runs. For `checks` that is the l1 vault
  (`machine-client-key`), or a local `env/l1-agent.env`. It never goes into this folder, GitHub or the state.
- **People who may start runs** (SPEC v1.17, `specs/016`). To let a person start runs at the hosted agent, assign
  them the role `x402-agent` in Auth0 (**User Management → Users → the user → Roles**). It takes effect at their
  next sign-in; taking it away takes effect when their access token expires, an hour at most. Nothing in this
  folder assigns a role, and T-IAC-02 fails if it does.
- **Administrators** (SPEC v1.15, `specs/014`). To let a person use the portal's administration area, assign them
  the role `x402-admin` in Auth0 (**User Management → Users → the user → Roles**). It takes effect at their next
  sign-in or token renewal; taking it away takes effect when their access token expires, an hour at most. Assign it
  only once the area is on (`userAccounts.administration`), to people who should decide payments, and once they are
  enrolled in a second factor (above).
- **People.** There is no role to assign for using the portal (SPEC v1.14, `specs/013` research R21): whoever signs in through the
  portal's application may use the portal, for their own account. Terraform creates no user. Since SPEC v1.27
  (`specs/017`):
  - **Google sign-up is public by design.** A first "Continue with Google" makes the person, with no role. They
    reach their own profile, wallet, policies and cards only, never the agent (that needs `x402-agent`) or the
    administration area (that needs `x402-admin`), and never anyone else's data or the platform account.
  - **Email-and-password sign-up** is closed by `allow_sign_ups = false`, through the connection's own "Disable Sign
    Ups": the page shows no "Sign up" link and every self-service sign-up is refused. Once step B of `specs/017` is
    applied (the deny Action gone), you can still add a person in the Dashboard (**User Management → Users →
    Create User**, connection `Username-Password-Authentication`), for example a test account.
  - **To keep one person out**, block that user (**User Management → Users → the user → Block**).
  - **To stop all new Google accounts** in an emergency, set `google_sign_in = false` and apply. It also stops every
    existing Google person from signing in until you set it back.
  - Nothing links two accounts with the same email address: a person who signs up both ways is two people.
- **The project's Google application** (`specs/017` quickstart §1). In Google Cloud, an OAuth client of type Web
  application, whose only redirect URI is `https://<tenant domain>/login/callback`, consent screen in production
  with `openid`, `email` and `profile` only. Enter its client ID and secret on the tenant's `google-oauth2`
  connection in the Dashboard (**Authentication → Social**): the secret goes nowhere else, not this folder, the
  tfvars file, the state or GitHub. Put its client ID (not a secret) in the tfvars file as `google_client_id`: a
  plan stops until the tenant's connection uses it, so Auth0's shared developer keys can't stay in place.
- **The checks of people's sign-in against the tenant**, in `specs/013` research R19 ("Unverified").

## Set it up, once per environment

Everything below runs on the operator's host, from a checkout of `main`.

1. **Folders.** Two, outside every checkout, readable by you only. The command refuses anything looser:

   ```bash
   install -d -m 700 ~/x402-tfstate ~/x402-secrets
   ```

2. **The Management API application.** In Auth0, make a machine-to-machine application authorized for the Auth0
   Management API, with these scopes and no others:
   - `read:resource_servers`, `create:resource_servers`, `update:resource_servers`, `delete:resource_servers`;
   - `read:clients`, `create:clients`, `update:clients`, `delete:clients`;
   - `read:client_credentials`, `create:client_credentials`, `update:client_credentials`,
     `delete:client_credentials`;
   - `read:client_grants`, `create:client_grants`, `update:client_grants`, `delete:client_grants`;
   - `read:guardian_factors`, `update:guardian_factors`, `read:mfa_policies`, `update:mfa_policies`;
   - `read:tenant_settings`, `update:tenant_settings` (Phase 3: `auth0_tenant.mfa_actions`);
   - for people's sign-in: `read:actions`, `create:actions`, `update:actions`, `delete:actions`, `read:triggers`,
     `update:triggers`;
   - for the two roles (014, 016): `read:roles`, `create:roles`, `update:roles`, `delete:roles`;
   - for the people's connections (017): `read:connections`, `update:connections`, `read:connections_options`,
     `update:connections_options`. Never `create:connections` or `delete:connections`: the connections hold
     people's accounts, so nothing here may replace one.

   Put its credential in its own file. This asks for both values, so the secret stays out of your shell history
   and your screen, and writes nothing when the secret is empty:

   ```bash
   ( umask 077; read -rp 'Client ID: ' id; read -rsp 'Client secret: ' secret; echo; [ -n "$secret" ] || { echo 'empty secret, nothing written'; exit 1; }; printf 'AUTH0_CLIENT_ID=%s\nAUTH0_CLIENT_SECRET=%s\n' "$id" "$secret" > ~/x402-secrets/auth0-management.dev.env ) && echo saved
   ```

3. **L2's key pair.** Make it outside the repository. Neither half is committed:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/x402-secrets/ciba-client-key.pem
   ```

   ```bash
   openssl pkey -in ~/x402-secrets/ciba-client-key.pem -pubout -out ~/x402-secrets/ciba-client-key.pub.pem
   ```

4. **The `checks` key pair** (016), only for the deployment pipeline's machine caller. Make it as in step 3:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/x402-secrets/machine-checks-key.pem
   ```

   ```bash
   openssl pkey -in ~/x402-secrets/machine-checks-key.pem -pubout -out ~/x402-secrets/machine-checks-key.pub.pem
   ```

5. **Variables.** One tfvars file, `~/x402-tfstate/auth0.dev.tfvars` (mode 0600), never in a checkout. None of its
   values is a secret. The command sets `environment` (from `AUTH0_ENVIRONMENT`, default `dev`) and
   `credential = "key"` itself, and refuses a file that sets either or any variable whose name holds `secret`, or
   that holds a private key or a Google client secret (`GOCSPX-`). dev's, as applied on 2026-11-24, with the two
   Google lines of `specs/017`:

   ```hcl
   tenant_domain  = "fabriciorojas.us.auth0.com"
   api_identifier = "https://x402-payments/dev"
   client_public_key_pem = <<-EOT
   -----BEGIN PUBLIC KEY-----
   …the contents of ~/x402-secrets/ciba-client-key.pub.pem…
   -----END PUBLIC KEY-----
   EOT
   manage_guardian     = true
   guardian_policy     = "never"
   portal_origin       = "https://dev.fabriciorojas.com"
   agent_origin        = "https://agent.fabriciorojas.com"
   machine_caller_keys = {}
   local_origins       = false
   allow_sign_ups      = false
   google_client_id    = "<the project's Google client ID>.apps.googleusercontent.com"
   google_sign_in      = true
   ```

   | Terraform variable | Needed |
   |---|---|
   | `tenant_domain` | always |
   | `api_identifier` | always |
   | `client_public_key_pem` | always |
   | `manage_guardian` | only to set `false` |
   | `guardian_policy` | only to change `never` |
   | `machine_caller_keys` | to declare a machine caller (`{}`: none) |
   | `local_origins` | `true` lets the local portal and agent (`http://localhost:4025`, `:4024`) sign in against this tenant |
   | `allow_sign_ups` | `false` closes email-and-password self-service sign-up, and the page's "Sign up" link (default `true`) |
   | `google_client_id` | while `google_sign_in` is on: the project's own Google application's client ID (not a secret; "The project's Google application") |
   | `google_sign_in` | only to set `false`, the emergency stop for Google sign-in (default `true`) |
   | `portal_origin` | once the portal is deployed: `https://<host>`, no port, path or trailing slash |
   | `agent_origin` | once the agent is deployed, and only where its docs page is on: `https://<host>` |

   `machine_caller_keys` maps each machine caller's name to the public half of its key, as PEM text. Declare
   `checks` with the public half from step 4:

   ```hcl
   machine_caller_keys = {
     checks = <<-EOT
     -----BEGIN PUBLIC KEY-----
     …
     -----END PUBLIC KEY-----
     EOT
   }
   ```

   A name is 2 to 20 lowercase letters, digits or hyphens. To add a caller, add its name and key; to remove one,
   take it out. The next apply makes or deletes its client.

## Run it

1. **Plan.** The command installs the pinned Terraform when needed, checks the files' modes, runs `fmt -check` and
   `validate`, inits the state at its path, and saves the plan as `~/x402-tfstate/auth0.dev.tfplan`:

   ```bash
   npm run auth0:tenant -- plan
   ```

2. **Apply**, once the plan is what you expect. It applies exactly the saved plan (Terraform refuses a plan the
   state has moved past), deletes it, and prints every output:

   ```bash
   npm run auth0:tenant -- apply
   ```

   The outputs again, at any time, without the credential:

   ```bash
   npm run auth0:tenant -- output
   ```

3. **Hand the values to L2.** `l2_env` holds the `CIBA_*` lines and the callers' sign-in.
   - **Locally or on the VPS**: put them in `env/l2-control.env`. Add `CIBA_CLIENT_KEY` yourself (the private half
     from step 3). There is no approver: each request goes to the person the payment is for.
   - **Azure**: paste `bicepparam_ciba` as `param ciba` in `infra/main.dev.bicepparam`, with `enabled` still
     `false`. Seed the private key as `ciba-client-credential` in the l2 vault, then set `enabled: true` and run
     `deploy-l2.yml` (`specs/012` quickstart §6).
4. **The person a payment is for enrolls in Guardian push**, then you run the live check (`specs/012` quickstart
   §5).
5. **Hand the values of people's sign-in to the portal.** `portal_env` holds the lines for `env/portal.env`. For
   Azure, `bicepparam_identity` is `param identity` and `bicepparam_portal_client_id` is
   `userAccounts.portalClientId` in `infra/main.dev.bicepparam`; then run `deploy-portal.yml`.
6. **Decide who can sign up.** Nobody needs a role to use the portal ("What stays by hand", People).
7. **Hand the callers' values to the agent and L2** (016; `specs/016` quickstart §5). `l1_env` holds the lines for
   `env/l1-hosted.env` (remove `AUTH_JWKS_FILE` there), and `l2_env` L2's. For Azure, paste `bicepparam_agent`
   into `param agent` in `infra/main.dev.bicepparam` (keep its own `apiDocs`), seed the private half of the
   `checks` key as `machine-client-key` in the l1 vault, and run `deploy-l2.yml`, then `deploy-l1.yml`.
8. **Choose who may start runs.** Assign the role `x402-agent` to each of them in Auth0 ("What stays by hand",
   People who may start runs). Without it a signed-in person gets 403 from the agent.

Other Terraform commands run on the same state through the command's passthrough, which never runs `apply` or
`destroy` (those go through `plan`):

```bash
npm run auth0:tenant -- terraform state list
```

## Move to a new state

A new, empty state (a new host, a lost state, or the move off Azure on 2026-11-24) knows none of the tenant's
objects, and a plan would try to create every one again: the apply then fails on names that exist, or makes
duplicates. Import them first, in the same plan:

1. Read each object's ID from the Management API (or the Dashboard): the two APIs' IDs, the L2 and portal clients'
   client IDs, the CIBA grant's ID (`cgr_…`), each Action's ID and each role's ID.
2. Write them as `import {}` blocks in a file of this folder that is never committed, for example
   `auth0/imports.tf`. The import IDs: an API's ID for `auth0_resource_server`; its identifier
   (`https://x402-api/dev`) for `auth0_resource_server_scopes`; the client ID for `auth0_client` and
   `auth0_client_credentials`; `cgr_…` for `auth0_client_grant`; the Action's ID for `auth0_action` and
   `post-login::<Action ID>` for its `auth0_trigger_action`; the role's ID for `auth0_role` and
   `auth0_role_permissions`; any word for the singletons `auth0_guardian.this[0]` and `auth0_tenant.mfa_actions[0]`;
   (017) the database connection's ID (`con_…`) for `auth0_connection.database` and
   `auth0_connection_clients.database`, and Google's connection ID for `auth0_connection_clients.google`
   (`data.auth0_connection.google` is read, not imported). The first plan after these imports must change the
   database connection's `disable_signup` only, and nothing in its password policy: if it shows another option
   changing, make `auth0_connection.database` match the tenant before you apply.

   ```hcl
   import {
     to = auth0_client.portal
     id = "iMNhIDWoJNpQf4dLINxOAzKFbRvy3Wjq"
   }
   ```

3. Plan. Check that the plan imports every object that exists, creates only what is missing, and destroys or
   replaces nothing. Then apply, delete the file, and plan again: there should be nothing left but the no-op below
   (Notes, "The portal's addons").

One change always follows an import: Auth0 never returns a credential's PEM, so the first plan re-registers L2's
credential with the key in `client_public_key_pem`. That is the same key when its RFC 7638 thumbprint equals the
credential's `key_id`, which Auth0 keeps: then `CIBA_CLIENT_KEY_ID` stays valid. Check it before applying:

```bash
node -e 'const c = require("crypto"); const j = c.createPublicKey(require("fs").readFileSync(process.argv[1])).export({ format: "jwk" }); console.log(c.createHash("sha256").update(JSON.stringify({ e: j.e, kty: j.kty, n: j.n })).digest("base64url"))' ~/x402-secrets/ciba-client-key.pub.pem
```

## Back up the state

The state exists only on the operator's host. Copy it after every apply, to somewhere only you can read: it names
the tenant's objects and holds no secret. For example, to your own machine:

```bash
scp <you>@<the VPS>:x402-tfstate/auth0.dev.tfstate ./auth0.dev.tfstate.$(date +%F)
```

Copy the tfvars file the same way the first time, and whenever it changes. Without a backup, a lost state is not a
lost tenant: import its objects into a new one ("Move to a new state"). The credential file needs no backup: make
a new secret for the Management API application in Auth0 instead.

**Key only.** The command provisions `credential = "key"` and nothing else, so the tfvars file holds only the
public half of L2's key. L2's credential is held by L2 only (Constitution V), which rules out a client secret here.
`private_key_jwt` needs Auth0's Enterprise plan; on a lower plan the command can't provision L2's client.

## Notes

- **Consent.** `consent_policy = "null"` is the provider's way to set standard consent. CIBA doesn't work with
  `transactional-authorization-with-mfa`.
- **Grants and the access policy.** The grant uses `subject_type = "user"`, because a CIBA token is
  user-delegated. If Auth0 refuses the approval request with `access_denied` before anyone was notified, check
  the API's access policy first: that is the live check's job.
- **A machine caller's key.** To rotate it, replace its public half in `machine_caller_keys` and apply. Auth0
  gives the new credential a new key ID: copy `machineKeyId` from the outputs to the parameter file, seed the new
  private half in the vault, and deploy L1. Between the apply and that deployment the caller gets no token.
- **Machine tokens and the approval API.** A machine caller has no grant for the approval API, whose policy
  refuses every machine token anyway (`client { policy = "deny_all" }`).
- **Guardian.** If another configuration owns the tenant's MFA settings, set `manage_guardian = false`, and turn
  on push there. `manage_guardian` can't go from true to false while the resource exists (`prevent_destroy`):
  remove `auth0_guardian.this[0]` from the state first
  (`npm run auth0:tenant -- terraform state rm 'auth0_guardian.this[0]'`).
- **The Actions.** Their code is in `sign-in-time.js`, `mfa-time.js` and `deny-sign-up.js`, so that T-IAC-02 can
  run it. The first two write a claim only when the sign-in has the time it needs. They never write the current
  time, which would make a renewed token look like a new sign-in. They run after every sign-in of the tenant, so
  they must never throw. `mfa-time.js` must stay bound after `sign-in-time.js` (`depends_on`): in a tenant where
  you reorder the post-login flow by hand, keep that order, or an administrator's token after a challenge carries no
  `mfa_time` and their decisions are refused.
- **Blocking a person.** A blocked user can't sign in or renew, but the access token they already hold stays
  valid until it expires, one hour at most.
- **Offline checks.** `npm run auth0:tenant -- validate` runs both, with no backend and no credential: it is what
  `validate-auth0.yml` runs. With Terraform on `PATH`, T-IAC-02 runs `fmt -check` too, and `validate` once
  `auth0/.terraform/` exists.
- **The lock file.** `.terraform.lock.hcl` must hold the provider's `h1` checksum for Linux (the VPS, the check's
  runner) as well as a Mac's: the command's `init -lockfile=readonly` adds none, and `validate` then refuses the
  provider ("does not match any of the checksums recorded in the dependency lock file"). After changing the
  provider's version, run `terraform -chdir=auth0 providers lock -platform=linux_amd64 -platform=darwin_arm64`
  and commit the file. T-IAC-02 fails on a lock file with one platform's checksum.
- **The portal's addons.** The provider reads an empty `addons {}` block back for the portal's single-page client
  and plans to remove it on every run. Applying that changes nothing in the tenant.
- **The old pipeline.** Until SPEC 1.26, `provision-auth0.yml` applied this folder from the GitHub environment
  `auth0-<environment>`, with its state in Azure. That environment still holds the Management API credential where
  it exists: delete it (`gh api --method DELETE repos/<owner>/<name>/environments/auth0-dev`; `infra/github-setup.sh`
  warns while it exists, and `infra/cleanup.sh` deletes it).
