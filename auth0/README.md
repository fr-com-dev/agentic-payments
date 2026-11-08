# auth0/: the Auth0 tenant for backchannel approval, as code

Terraform for what L2's backchannel approval (SPEC L2-7, `specs/012`) needs from Auth0.

- **Who runs it**: a tenant administrator, by hand, like `infra/pre-deploy.bicep`. No pipeline applies it, and
  no GitHub secret exists for it.
- **Scope**: Azure stays Bicep only (`infra/`). This folder holds only Auth0 objects, through the official
  `auth0/auth0` provider.
- **Test**: T-IAC-02 (`test/auth0-iac.test.ts`) checks the configuration offline, with must-fail mutants.

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
- **The approver's Guardian enrollment**: they scan the QR code with their own phone.
- **L2's private key** (or the secret): it goes into the l2 vault (`ciba-client-credential`) or a local
  `env/l2-control.env`, never into this folder or its state.
- **The live check**, in `specs/012` quickstart §5.

## Run it

1. **The Management API application** that applies this. It is a machine-to-machine application authorized for
   the Auth0 Management API, kept by the administrator. Its scopes:
   - `read:resource_servers`, `create:resource_servers`, `update:resource_servers`, `delete:resource_servers`;
   - `read:clients`, `create:clients`, `update:clients`, `delete:clients`;
   - `read:client_credentials`, `create:client_credentials`, `update:client_credentials`,
     `delete:client_credentials`;
   - `read:client_grants`, `create:client_grants`, `update:client_grants`, `delete:client_grants`;
   - `read:guardian_factors`, `update:guardian_factors`, `read:mfa_policies`, `update:mfa_policies`;
   - `read:tenant_settings`, `read:users`.

   Put its credentials in your shell only:

   ```bash
   export AUTH0_CLIENT_ID=<management app client id> AUTH0_CLIENT_SECRET=<management app secret>
   ```

2. **L2's key pair**, outside the repository:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/x402-secrets/ciba-client-key.pem
   ```

   ```bash
   openssl pkey -in ~/x402-secrets/ciba-client-key.pem -pubout -out ~/x402-secrets/ciba-client-key.pub.pem
   ```

3. **Variables.** Copy `dev.tfvars.example` to `dev.tfvars` (gitignored) and fill in the tenant domain, the API
   identifier, the approver's user ID and the public key's path.
4. **Init, plan and apply.**

   ```bash
   terraform -chdir=auth0 init
   ```

   ```bash
   terraform -chdir=auth0 plan -var-file=dev.tfvars -out=dev.tfplan
   ```

   ```bash
   terraform -chdir=auth0 apply dev.tfplan
   ```

   Commit the `.terraform.lock.hcl` that `init` writes. State stays local in `auth0/terraform.tfstate`
   (gitignored). It holds no secret, but it does name the tenant: keep it safe, or move it to a backend you
   control.
5. **Hand the values to L2.**

   ```bash
   terraform -chdir=auth0 output -json bicepparam_ciba
   ```

   - **Azure**: paste the object as `param ciba` in `infra/main.dev.bicepparam`, with `enabled` still `false`.
     Seed the private key as `ciba-client-credential` in the l2 vault, then set `enabled: true` and run
     `deploy-l2.yml` (`specs/012` quickstart §6).
   - **Locally**: `terraform -chdir=auth0 output -raw l2_env` prints the `CIBA_*` lines for
     `env/l2-control.env`. Add `CIBA_CLIENT_KEY` yourself.
6. **The approver enrolls in Guardian push**, then you run the live check (`specs/012` quickstart §5).

With `credential = "secret"`:
- generate the secret yourself (16 or more characters);
- export it as `TF_VAR_client_secret` for `plan` and `apply` (it is an ephemeral, write-only value: never in state
  or the plan file);
- seed the same value into the vault.

To rotate it, bump `client_secret_version`.

## Notes

- **Consent.** `consent_policy = "null"` is the provider's way to set standard consent. CIBA doesn't work with
  `transactional-authorization-with-mfa`.
- **Grants and the access policy.** The grant uses `subject_type = "user"`, because a CIBA token is
  user-delegated. If Auth0 refuses the approval request with `access_denied` before anyone was notified, check
  the API's access policy first: that is the live check's job.
- **Guardian.** If another configuration owns the tenant's MFA settings, set `manage_guardian = false`, and turn
  on push there. `manage_guardian` can't go from true to false while the resource exists (`prevent_destroy`):
  run `terraform state rm 'auth0_guardian.this[0]'` first.
