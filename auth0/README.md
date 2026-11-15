# auth0/: the Auth0 tenant, as code

Terraform for what the project needs from Auth0:

- L2's backchannel approval (SPEC L2-7, `specs/012`);
- people's sign-in at the portal (SPEC L2-8, `specs/013` research R19);
- the hosted agent's callers, people and machines (SPEC v1.17, `specs/016` research R9 and R10).

It makes exactly four kinds of application (T-IAC-02 fails on any other):

- L2's backchannel approval client;
- the portal's single-page client;
- the agent's single-page client, through which the agent's docs page signs a person in;
- one confidential client per machine caller, for systems that start runs. The first is `checks`, the deployment
  pipeline's smoke run and scripted regression.

The Management API application the pipeline signs in with (step 2 below) is made by hand and is not part of the
running system.

- **Who runs it**: its pipeline, `.github/workflows/provision-auth0.yml`, started by hand. Every run shows the
  plan; it applies that same plan only when `apply` is checked. Nothing else applies this folder.
- **Scope**: Azure stays Bicep only (`infra/`). This folder holds only Auth0 objects, through the official
  `auth0/auth0` provider.
- **Secrets**: the Management API application's credential is the only secret GitHub holds. It lives in the
  pipeline's own GitHub environment, `auth0-<environment>`, and only the plan and apply steps see it.
- **State**: a blob, `auth0.<environment>.tfstate`, in the storage account `infra/pre-deploy.bicep` makes. Terraform
  signs in to Azure with OIDC as the deploy app; no Azure credential exists. The state holds no secret.
- **Test**: T-IAC-02 (`test/auth0-iac.test.ts`) checks the configuration and the pipeline offline, with must-fail
  mutants, and runs the Action's code. The pipeline runs it before `init`.

## What it makes

| Resource | What it is | Becomes |
|---|---|---|
| `auth0_resource_server.payments` | The approval API. It uses RS256, the RFC 9068 token profile (tokens carry `jti`), 5-minute tokens, no refresh tokens and standard consent. It registers one Rich Authorization Requests type, `urn:auth0:schemas:authorization-details:v1:x402-payment`. Its access policy is: users through a client grant only, machines never. | `CIBA_AUDIENCE` |
| `auth0_client.l2` | L2's client: confidential, first-party and OIDC-conformant. Its only grant is CIBA (`urn:openid:params:grant-type:ciba`), and it notifies through `guardian-push` only. | `CIBA_CLIENT_ID` |
| `auth0_client_grant.l2_ciba` | The user-delegated grant that lets L2's client, and only it, request the payment-details type. | — |
| `auth0_client_credentials.l2` | `private_key_jwt` with the **public** half of L2's RS256 key (preferred), or `client_secret_post` with a secret you generate, sent write-only. | how L2 authenticates |
| `auth0_guardian.this` | Push notifications through the Guardian app. It doesn't force MFA at login (`guardian_policy = "never"`). It is never destroyed, because destroying it would turn off every MFA factor of the tenant. | — |
| `data.auth0_user.approver` | Checks that the approver exists. Users and passwords are never managed here. | `CIBA_APPROVER` |

For people's sign-in:

| Resource | What it is | Becomes |
|---|---|---|
| `auth0_resource_server.identity` | People's API, `https://x402-api/<environment>`. It uses RS256. It has two permissions (next rows), and a token's `permissions` list holds only the ones its holder's roles give, so most people's is empty. Tokens live one hour. Refresh tokens are allowed. | `AUTH_AUDIENCE`, `identity.audience` |
| `auth0_resource_server_scopes.identity` | The two permissions of people's API: `portal:admin` (014) and `agent:run` (016). | — |
| `auth0_role.admin`, `auth0_role_permissions.admin` | 014: the role `x402-admin`, which holds exactly `portal:admin`. It opens the portal's administration area and nothing else. Nobody is assigned here. | read by the portal from the token |
| `auth0_client.portal`, `auth0_client_credentials.portal` | The portal's web app: a public single-page client with no secret. It uses the authorization code with PKCE, and the `refresh_token` grant because its refresh tokens rotate. Its callbacks, web origins and logout URLs are `http://localhost:4025` and `portal_origin` when set. | `PORTAL_CLIENT_ID`, `userAccounts.portalClientId` |
| `auth0_action.sign_in_time`, `auth0_trigger_action.sign_in_time` | The post-login Action in `sign-in-time.js`. It writes one claim on the access token, `https://x402.dev/auth_time`: the time of the person's most recent authentication, in seconds. It is appended to the tenant's post-login flow and replaces nothing there. | `AUTH_TIME_CLAIM` |

For the hosted agent's callers:

| Resource | What it is | Becomes |
|---|---|---|
| `auth0_role.agent`, `auth0_role_permissions.agent` | The role `x402-agent`, which holds exactly `agent:run`. Its holder may start runs at the hosted agent, for their own account. Nobody is assigned here. | read by the agent and L2 from the token |
| `auth0_client.agent`, `auth0_client_credentials.agent` | The agent's client: a public single-page client with no secret. Its only grant is the authorization code (with PKCE), so it gets no refresh token. Its callbacks are `<origin>/docs/oauth2-redirect.html`, and its allowed origins and web origins `<origin>`, for `http://localhost:4024`, `http://127.0.0.1:4024` and `agent_origin` when set. | `AGENT_CLIENT_IDS`, `API_DOCS_CLIENT_ID`, `agent.clientId` |
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
- **The Management API application** and its credential, as secrets of the GitHub environment.
- **The approver's Guardian enrollment**: they scan the QR code with their own phone.
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
  only once the area is on (`userAccounts.administration`) and to people who should decide payments.
- **People.** There is no role to assign for using the portal (SPEC v1.14, `specs/013` research R21): whoever signs in through the
  portal's application may use the portal, for their own account. Terraform creates no user. Who can sign up is
  the tenant's own setting: to keep strangers out, turn sign-ups off on the connection (**Authentication →
  Database → the connection → Disable Sign Ups**) and create users yourself; to keep one person out, block that
  user (**User Management → Users → the user → Block**).
- **The checks of people's sign-in against the tenant**, in `specs/013` research R19 ("Unverified").

## Set it up, once per environment

1. **Azure and GitHub.** Deploy `infra/pre-deploy.bicep` again: it adds the state's storage account and the deploy
   app's second federated credential, for the GitHub environment `auth0-dev`. Then create that environment:

   ```bash
   infra/github-setup.sh
   ```

   In the repository's settings, give `auth0-dev` required reviewers, so every run waits for an approval.
2. **The Management API application.** In Auth0, make a machine-to-machine application authorized for the Auth0
   Management API, with these scopes:
   - `read:resource_servers`, `create:resource_servers`, `update:resource_servers`, `delete:resource_servers`;
   - `read:clients`, `create:clients`, `update:clients`, `delete:clients`;
   - `read:client_credentials`, `create:client_credentials`, `update:client_credentials`,
     `delete:client_credentials`;
   - `read:client_grants`, `create:client_grants`, `update:client_grants`, `delete:client_grants`;
   - `read:guardian_factors`, `update:guardian_factors`, `read:mfa_policies`, `update:mfa_policies`;
   - `read:tenant_settings`, `read:users`;
   - for people's sign-in: `read:actions`, `create:actions`, `update:actions`, `delete:actions`, `read:triggers`,
     `update:triggers`;
   - for the two roles (014, 016): `read:roles`, `create:roles`, `update:roles`, `delete:roles`.

   Store its credential as the environment's secrets. Each command asks for the value, so it stays out of your
   shell history:

   ```bash
   gh secret set AUTH0_CLIENT_ID --env auth0-dev
   ```

   ```bash
   gh secret set AUTH0_CLIENT_SECRET --env auth0-dev
   ```

3. **L2's key pair.** Make it outside the repository. Neither half is committed:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/x402-secrets/ciba-client-key.pem
   ```

   ```bash
   openssl pkey -in ~/x402-secrets/ciba-client-key.pem -pubout -out ~/x402-secrets/ciba-client-key.pub.pem
   ```

4. **The `checks` key pair** (016), for the deployment pipeline's machine caller. Make it outside the repository,
   as in step 3. Neither half is committed:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/x402-secrets/machine-checks-key.pem
   ```

   ```bash
   openssl pkey -in ~/x402-secrets/machine-checks-key.pem -pubout -out ~/x402-secrets/machine-checks-key.pub.pem
   ```

5. **Variables.** There is no tfvars file. Terraform's variables are variables of the GitHub environment, which the
   plan step exports as `TF_VAR_*`. None is a secret. `infra/github-setup.sh` (step 1) already created seven of the
   nine: the first four as the placeholder `REPLACE_ME`, the next three as their defaults. Replace the four
   placeholders; the pipeline plans nothing while one is left:

   ```bash
   gh variable set AUTH0_TENANT_DOMAIN --env auth0-dev --body "x402-dev.us.auth0.com"
   ```

   ```bash
   gh variable set AUTH0_API_IDENTIFIER --env auth0-dev --body "https://x402-payments/dev"
   ```

   ```bash
   gh variable set AUTH0_APPROVER_USER_ID --env auth0-dev --body "auth0|000000000000000000000000"
   ```

   ```bash
   gh variable set AUTH0_CLIENT_PUBLIC_KEY --env auth0-dev < ~/x402-secrets/ciba-client-key.pub.pem
   ```

   | GitHub variable | Terraform variable | Needed |
   |---|---|---|
   | `AUTH0_TENANT_DOMAIN` | `tenant_domain` | always |
   | `AUTH0_API_IDENTIFIER` | `api_identifier` | always |
   | `AUTH0_APPROVER_USER_ID` | `approver_user_id` | always |
   | `AUTH0_CLIENT_PUBLIC_KEY` | `client_public_key_pem` | always |
   | `AUTH0_MANAGE_GUARDIAN` | `manage_guardian` | only to set `false` |
   | `AUTH0_GUARDIAN_POLICY` | `guardian_policy` | only to change `never` |
   | `AUTH0_MACHINE_CALLER_KEYS` | `machine_caller_keys` | to declare a machine caller (created as `{}`: none) |
   | `AUTH0_PORTAL_ORIGIN` | `portal_origin` | once the portal is deployed |
   | `AUTH0_AGENT_ORIGIN` | `agent_origin` | once the agent is deployed, and only where its docs page is on |

   Running `infra/github-setup.sh` again never changes a variable that exists. A variable you delete keeps the
   default in `variables.tf`. `environment` is the run's `environment` input.

   `AUTH0_MACHINE_CALLER_KEYS` is one JSON object: each machine caller's name, and the public half of its key as
   PEM text. Terraform reads it as the map `machine_caller_keys`. Declare `checks` with the public half from step 4:

   ```bash
   gh variable set AUTH0_MACHINE_CALLER_KEYS --env auth0-dev --body "$(jq -cn --rawfile checks ~/x402-secrets/machine-checks-key.pub.pem '{checks: $checks}')"
   ```

   A name is 2 to 20 lowercase letters, digits or hyphens. To add a caller, add its name and key to the object; to
   remove one, take it out. The next apply makes or deletes its client.

   `AUTH0_PORTAL_ORIGIN` and `AUTH0_AGENT_ORIGIN` are the two variables the script doesn't create, because a GitHub
   variable can't be empty. Set each one after its first deployment, to `https://` and the address (`main.bicep`'s
   `portalFqdn` or `agentFqdn` output), with no trailing slash. Then run the pipeline again, so the deployed portal
   is an allowed origin, and the deployed agent's docs page an allowed return address:

   ```bash
   gh variable set AUTH0_PORTAL_ORIGIN --env auth0-dev --body "https://<the portal's address>"
   ```

   ```bash
   gh variable set AUTH0_AGENT_ORIGIN --env auth0-dev --body "https://<the agent's address>"
   ```

   The agent's origin is needed only where its docs page is on (`agent.apiDocs` in the parameter file). Without it
   the agent still accepts tokens; only the sign-in from the deployed docs page is refused by Auth0.

## Run it

1. **Plan.** The run's summary shows what would change:

   ```bash
   gh workflow run provision-auth0.yml -f environment=dev
   ```

2. **Apply**, once the plan is what you expect. The run plans again and applies exactly that plan:

   ```bash
   gh workflow run provision-auth0.yml -f environment=dev -f apply=true
   ```

3. **Hand the values to L2.** The apply run's summary shows the `ciba` object.
   - **Azure**: paste it as `param ciba` in `infra/main.dev.bicepparam`, with `enabled` still `false`. Seed the
     private key as `ciba-client-credential` in the l2 vault, then set `enabled: true` and run `deploy-l2.yml`
     (`specs/012` quickstart §6).
   - **Locally**: put its `issuer`, `clientId`, `audience` and `approver` in `env/l2-control.env` as `CIBA_ISSUER`,
     `CIBA_CLIENT_ID`, `CIBA_AUDIENCE` and `CIBA_APPROVER`, with `CIBA_APPROVAL=1`. Add `CIBA_CLIENT_KEY` yourself.
     An administrator with a role on the state's container reads the same lines, and the callers' sign-in ones
     (step 7), with `terraform -chdir=auth0 output -raw l2_env`.
4. **The approver enrolls in Guardian push**, then you run the live check (`specs/012` quickstart §5).
5. **Hand the values of people's sign-in to the portal.** The apply run's summary also shows
   the `identity` object and the portal web app's client ID.
   - **Azure**: paste the object as `param identity` in `infra/main.dev.bicepparam`, and the client ID as
     `portalClientId` in its `userAccounts` object. Then run `deploy-portal.yml`.
   - **Locally**: an administrator with a role on the state's container reads the lines for `env/portal.env` with
     `terraform -chdir=auth0 output -raw portal_env`. They hold the same values as the summary.
6. **Decide who can sign up.** Nobody needs a role to use the portal. With sign-ups on, anyone who creates an
   account in the tenant can onboard; turn them off on the connection to choose the people yourself ("What stays
   by hand", People).
7. **Hand the callers' values to the agent and L2** (016; `specs/016` quickstart §5). The apply run's summary also
   shows the `agent` object: the agent's client ID, and the `checks` client's ID and key ID (both empty until
   `AUTH0_MACHINE_CALLER_KEYS` declares `checks`).
   - **Azure**: paste its three values into `param agent` in `infra/main.dev.bicepparam`, and keep that file's own
     `apiDocs`. Seed the private half of the `checks` key as `machine-client-key` in the l1 vault. Then run
     `deploy-l2.yml`, and `deploy-l1.yml` after it.
   - **Locally**: an administrator with a role on the state's container reads the lines for `env/l1-hosted.env`
     with `terraform -chdir=auth0 output -raw l1_env` (remove `AUTH_JWKS_FILE` there), and L2's with `l2_env`.
8. **Choose who may start runs.** Assign the role `x402-agent` to each of them in Auth0 ("What stays by hand",
   People who may start runs). Without it a signed-in person gets 403 from the agent.
9. **The deployed docs page.** Where `agent.apiDocs` is on, set `AUTH0_AGENT_ORIGIN` after the agent's first
   deployment and run the pipeline with `apply` again (step 5 of "Set it up").

**Key only.** The pipeline provisions `credential = "key"` and nothing else, so GitHub holds only the public half
of L2's key. L2's credential is held by L2 only (Constitution V), which rules out sending a client secret through
GitHub. `private_key_jwt` needs Auth0's Enterprise plan; on a lower plan the pipeline can't provision L2's client.

## Notes

- **Consent.** `consent_policy = "null"` is the provider's way to set standard consent. CIBA doesn't work with
  `transactional-authorization-with-mfa`.
- **Grants and the access policy.** The grant uses `subject_type = "user"`, because a CIBA token is
  user-delegated. If Auth0 refuses the approval request with `access_denied` before anyone was notified, check
  the API's access policy first: that is the live check's job.
- **A machine caller's key.** To rotate it, replace its public half in `AUTH0_MACHINE_CALLER_KEYS` and apply. Auth0
  gives the new credential a new key ID: copy `machineKeyId` from the summary to the parameter file, seed the new
  private half in the vault, and deploy L1. Between the apply and that deployment the caller gets no token.
- **Machine tokens and the approval API.** A machine caller has no grant for the approval API, whose policy
  refuses every machine token anyway (`client { policy = "deny_all" }`).
- **Guardian.** If another configuration owns the tenant's MFA settings, set `manage_guardian = false`, and turn
  on push there. `manage_guardian` can't go from true to false while the resource exists (`prevent_destroy`):
  remove `auth0_guardian.this[0]` from the state first (`terraform state rm`, by an administrator with a role on
  the state's container).
- **The Action.** Its code is `sign-in-time.js`, so that T-IAC-02 can run it. It writes the claim only when the
  sign-in has a time. It never writes the current time, which would make a renewed token look like a new sign-in.
  It runs after every sign-in of the tenant, so it must never throw.
- **Blocking a person.** A blocked user can't sign in or renew, but the access token they already hold stays
  valid until it expires, one hour at most.
- **Offline checks on your machine.** `terraform -chdir=auth0 fmt -check` needs nothing. `validate` needs the
  provider: run `terraform -chdir=auth0 init -backend=false` first. Neither reads the state.
- **The lock file.** `.terraform.lock.hcl` must hold the provider's `h1` checksum for the pipeline's Linux runner
  as well as your machine's: the pipeline's `init -lockfile=readonly` adds none, and `validate` then refuses the
  provider ("does not match any of the checksums recorded in the dependency lock file"). After changing the
  provider's version, run `terraform -chdir=auth0 providers lock -platform=linux_amd64 -platform=darwin_arm64`
  and commit the file. T-IAC-02 fails on a lock file with one platform's checksum.
- **The state and `infra/cleanup.sh`.** The clean-up deletes the resource group, and the state with it, but nothing
  in Auth0. Before the next apply for that tenant, delete the Auth0 objects by hand or import them
  (`terraform import`), or the apply fails on objects that already exist.
