# auth0/: the Auth0 tenant for backchannel approval, as code

Terraform for what L2's backchannel approval (SPEC L2-7, `specs/012`) needs from Auth0.

- **Who runs it**: its pipeline, `.github/workflows/provision-auth0.yml`, started by hand. Every run shows the
  plan; it applies that same plan only when `apply` is checked. Nothing else applies this folder.
- **Scope**: Azure stays Bicep only (`infra/`). This folder holds only Auth0 objects, through the official
  `auth0/auth0` provider.
- **Secrets**: the Management API application's credential is the only secret GitHub holds. It lives in the
  pipeline's own GitHub environment, `auth0-<environment>`, and only the plan and apply steps see it.
- **State**: a blob, `auth0.<environment>.tfstate`, in the storage account `infra/pre-deploy.bicep` makes. Terraform
  signs in to Azure with OIDC as the deploy app; no Azure credential exists. The state holds no secret.
- **Test**: T-IAC-02 (`test/auth0-iac.test.ts`) checks the configuration and the pipeline offline, with must-fail
  mutants. The pipeline runs it before `init`.

## What it makes

| Resource | What it is | Becomes |
|---|---|---|
| `auth0_resource_server.payments` | The approval API. It uses RS256, the RFC 9068 token profile (tokens carry `jti`), 5-minute tokens, no refresh tokens and standard consent. It registers one Rich Authorization Requests type, `urn:auth0:schemas:authorization-details:v1:x402-payment`. Its access policy is: users through a client grant only, machines never. | `CIBA_AUDIENCE` |
| `auth0_client.l2` | L2's client: confidential, first-party and OIDC-conformant. Its only grant is CIBA (`urn:openid:params:grant-type:ciba`), and it notifies through `guardian-push` only. | `CIBA_CLIENT_ID` |
| `auth0_client_grant.l2_ciba` | The user-delegated grant that lets L2's client, and only it, request the payment-details type. | — |
| `auth0_client_credentials.l2` | `private_key_jwt` with the **public** half of L2's RS256 key (preferred), or `client_secret_post` with a secret you generate, sent write-only. | how L2 authenticates |
| `auth0_guardian.this` | Push notifications through the Guardian app. It doesn't force MFA at login (`guardian_policy = "never"`). It is never destroyed, because destroying it would turn off every MFA factor of the tenant. | — |
| `data.auth0_user.approver` | Checks that the approver exists. Users and passwords are never managed here. | `CIBA_APPROVER` |

## What stays by hand

- **The plan.** CIBA needs the Enterprise plan or an add-on, and `private_key_jwt` needs Enterprise.
- **The Management API application** and its credential, as secrets of the GitHub environment.
- **The approver's Guardian enrollment**: they scan the QR code with their own phone.
- **L2's private key** (or the secret): it goes into the l2 vault (`ciba-client-credential`) or a local
  `env/l2-control.env`, never into this folder, GitHub or the state.
- **The live check**, in `specs/012` quickstart §5.

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
   - `read:tenant_settings`, `read:users`.

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

4. **Variables.** There is no tfvars file. Terraform's variables are variables of the GitHub environment, which the
   plan step exports as `TF_VAR_*`. None is a secret. Set the first four:

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
   | `AUTH0_CLIENT_PUBLIC_KEY` | `client_public_key_pem` | with `credential = "key"` (the default) |
   | `AUTH0_CREDENTIAL` | `credential` | only to choose `secret` |
   | `AUTH0_CLIENT_SECRET_VERSION` | `client_secret_version` | only to rotate the secret |
   | `AUTH0_MANAGE_GUARDIAN` | `manage_guardian` | only to set `false` |
   | `AUTH0_GUARDIAN_POLICY` | `guardian_policy` | only to change `never` |

   A variable left unset keeps the default in `variables.tf`. `environment` is the run's `environment` input.

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
4. **The approver enrolls in Guardian push**, then you run the live check (`specs/012` quickstart §5).

With `credential = "secret"`:
- generate the secret yourself (16 or more characters);
- store it as the environment's secret `AUTH0_L2_CLIENT_SECRET` (it is an ephemeral, write-only value: never in
  the state or the plan file);
- seed the same value into the vault.

To rotate it, bump the variable `AUTH0_CLIENT_SECRET_VERSION`.

## Notes

- **Consent.** `consent_policy = "null"` is the provider's way to set standard consent. CIBA doesn't work with
  `transactional-authorization-with-mfa`.
- **Grants and the access policy.** The grant uses `subject_type = "user"`, because a CIBA token is
  user-delegated. If Auth0 refuses the approval request with `access_denied` before anyone was notified, check
  the API's access policy first: that is the live check's job.
- **Guardian.** If another configuration owns the tenant's MFA settings, set `manage_guardian = false`, and turn
  on push there. `manage_guardian` can't go from true to false while the resource exists (`prevent_destroy`):
  remove `auth0_guardian.this[0]` from the state first (`terraform state rm`, by an administrator with a role on
  the state's container).
- **Offline checks on your machine.** `terraform -chdir=auth0 fmt -check` needs nothing. `validate` needs the
  provider: run `terraform -chdir=auth0 init -backend=false` first. Neither reads the state.
- **The state and `infra/cleanup.sh`.** The clean-up deletes the resource group, and the state with it, but nothing
  in Auth0. Before the next apply for that tenant, delete the Auth0 objects by hand or import them
  (`terraform import`), or the apply fails on objects that already exist.
