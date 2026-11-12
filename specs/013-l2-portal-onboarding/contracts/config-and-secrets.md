# Contract: configuration, credential confinement and Azure delivery

Normative for SPEC CFG-2, CFG-4 (new), §3.1, §3.3 and §4.1, and for the T-ARCH, T-IAC-01, T-IMG-01, T-DEV and
T-E2E-AZ tests that enumerate processes, units and names.

## CFG-2: `env/l2-control.env` (new optional variables)

| Variable | Required | Notes |
|---|---|---|
| `USER_ACCOUNTS` | no | `1` turns user accounts on (FR-001). Anything else, or unset: off, and the three below are ignored (L2 logs their names once, never their values). |
| `PORTAL_TOKEN` | with `USER_ACCOUNTS=1` | The `portal-control` role's token (INV-13). Dev default `dev-portal-token` on `NETWORK=local` only. Must differ from the other four tokens, or L2 refuses to start. |
| `USER_WALLET_MNEMONIC` | with `USER_ACCOUNTS=1` | A 24-word BIP-39 mnemonic. Read only by `signer.ts` (rule A11). Never logged. |
| `PLATFORM_FILE` | no | Default `config/platform.json` (CFG-4). |
| `PLATFORM_SELLERS` | no | A JSON array that replaces the file's `sellers`. |

Startup order with user accounts on: env → **these settings and the platform config are validated** → ledger lock →
ledger load → every recorded wallet's address is re-derived and compared → `PLATFORM_CONFIG` entry if the digest
changed → listen. A failure before the lock never takes it (L2-6). Errors name the variable or the field, never a
value.

## CFG-2: `env/portal.env` (new file, new template `env/portal.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `NETWORK` | yes | `local` or `base-sepolia` |
| `CONTROL_URL` | yes | L2's address |
| `PORTAL_TOKEN` | yes off `local` | the same value L2 verifies |
| `AUTH_ISSUER`, `AUTH_AUDIENCE` | yes | the Auth0 tenant's issuer (`https://<domain>/`) and the API's identifier, the same two as in `env/l1-hosted.env` |
| `PORTAL_CLIENT_ID` | yes | the Auth0 single-page client's ID: the only client whose tokens the portal accepts |
| `AUTH_JWKS_FILE` | no | the dev issuer's JWKS; allowed only with `NETWORK=local` |
| `AUTH_TIME_CLAIM` | no | the access-token claim that holds the time of the person's last sign-in, set by the tenant's post-login Action; default `https://x402.dev/auth_time` |
| `PORTAL_WEB_ROOT` | no | where the built web app is; default `dist/portal-web`. Tests point it elsewhere; without an `index.html` there the portal serves only its API |
| `PROFILE_DIR` | no | default `.local/portal/profiles` |
| `CARD_VAULT` | no | `stripe` turns cards on; unset: off |
| `CARD_VAULT_KEY` | with `CARD_VAULT=stripe` | restricted test key; only `card-vault.ts` reads it (rule A10); empty in the template |
| `CARD_VAULT_PUBLISHABLE_KEY` | with `CARD_VAULT=stripe` | `pk_test_…`; public |
| `BASE_SEPOLIA_RPC_URL` | no | as for L3 |
| `PORTAL_PORT`, `PORTAL_BIND_HOST` | no | defaults 4025 and 127.0.0.1 |
| `TRUSTED_PROXY_HOPS` | no | a whole number 0–3, default 0: how many reverse proxies stand in front, for the per-address request limit. 1 in Azure (the ingress). Also read by the hosted agent (`env/l1-hosted.env`) |
| `API_DOCS` | no | `1` mounts `/docs`; never set in Azure |

`src/portal-main.ts` loads this file and then **exits 1 if `PAYER_PRIVATE_KEY` or `USER_WALLET_MNEMONIC` is
visible**, from the process environment or from the file, before anything else (as INV-3 does for L1).

`env/l1-hosted.env` changes for people's sign-in (2026-11-10, [R19](../research.md#r19-auth0-as-the-identity-provider-for-people)):
`AUTH_ISSUER` and `AUTH_AUDIENCE` are the Auth0 tenant's issuer and the API's identifier; `AGENT_CLIENT_IDS` is the
comma-separated list of Auth0 clients whose tokens the agent service accepts (never the portal's client; the
service refuses to start when `PORTAL_CLIENT_ID`, if given, is on it). `AGENT_CLI_CLIENT_ID` (optional) is the
native client `npm run user-token` signs in with; the service itself does not read it. As built, the three people's variables go together: all three, or none, and with none no person is accepted
(an environment whose `identity` parameter is still empty runs system identities only). `AUTH_TENANT_ID` and the new
`SERVICE_AUDIENCE` (the Entra API app's client ID) now cover system identities only; without them no system
identity is accepted.

## CFG-4: `config/platform.json`

See [data-model.md](../data-model.md#platform-configuration-configplatformjson-cfg-4). Checked in with defaults
equal to today's mandate. `COPY config ./config` already puts it in the L2 image.

## §3.3: credential matrix (new rows and columns)

A new column, **Portal**.

| Secret | L1 | L2 | L3 | Seller | Portal | Human |
|---|---|---|---|---|---|---|
| `PORTAL_TOKEN` (portal→L2) | — | ✅ verifies | — | — | ✅ | — |
| `USER_WALLET_MNEMONIC` | **never** | ✅ (`signer.ts` only) | — | — | **never** | — |
| Person's portal token (browser→portal; an Auth0 access token since 2026-11-10) | — | — | — | — | ✅ verifies, never forwards | — |
| `CARD_VAULT_KEY` (portal→card vault) | — | — | — | — | ✅ (`card-vault.ts` only) | — |

- The mnemonic is payment key material, like `PAYER_PRIVATE_KEY`: INV-2 and rule A3 cover it.
- The card vault key authenticates the portal to the vault. It is restricted to saving and removing cards, so it is
  not payment authority (Constitution V).
- `PORTAL_TOKEN` can't authorize, approve, reject or reconcile (FR-049).

## §4.1: architecture rules

| Rule | Invariant | Scope | Violation |
|---|---|---|---|
| A1 (extended) | INV-1 | adds the area `PORTAL` = `src/portal/**` | a portal file imports another layer's folder, or a layer imports the portal |
| A3 (unchanged text, now also covers the mnemonic) | INV-2 | `src/**` except `signer.ts` | `mnemonicToAccount`, `privateKeyToAccount`, an import of `viem/accounts` |
| A4 (extended) | INV-4 | adds `src/portal/**` | `createWalletClient`, `signTypedData`, `writeContract`, `sendTransaction` |
| A10 (new) | §3.3, SEC-22 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` exempt) | `CARD_VAULT_KEY` (not `CARD_VAULT_KEY_…`), or the string `api.stripe.com`, outside `src/portal/card-vault.ts` and `env/portal.env.example` |
| A11 (new) | INV-2 | `src/**`, `scripts/**`, `env/*.env.example` | `USER_WALLET_MNEMONIC` outside `src/layer2-control/signer.ts`, `src/portal-main.ts` (the refusal), `scripts/demo-lib.ts` (the local dev value) and `env/l2-control.env.example` |
| A12 (new) | INV-13, FR-006 | `src/layer1-intent/**`, `src/layer3-settlement/**`, `src/counterparty/**` | `PORTAL_TOKEN`; and in `src/portal/**`: `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `OPERATOR_TOKEN`, `SETTLEMENT_TOKEN`, `VERIFIER_TOKEN` |

Each new rule gets a fixture under `test/fixtures/arch/` that trips only it, a "repository is clean" walk and a
"not vacuous" check, as A8 and A9 have. T-ARCH-ENV's `TEMPLATES` gains `portal`, and `l2-control` gains the new
names; a template key ending in `_MNEMONIC`, or named `CARD_VAULT_KEY`, must be empty.

## Local processes

| Item | Change |
|---|---|
| `package.json` scripts | `user-token` (2026-11-10: a person's agent token through the tenant's device flow), `portal` (`tsx src/portal-main.ts`), `build:web` (Vite build of `web/portal` to `dist/portal-web`), `fund-user` (local only), `wallet-mnemonic` (prints one new 24-word mnemonic; reads no env file and derives no account); `typecheck` also checks `web/portal/tsconfig.json` |
| `src/shared/config.ts` | `EnvRole` gains `portal`; `Role` gains `portal-control`; `ROLE_TOKEN_VAR` and `DEV_TOKENS` gain `PORTAL_TOKEN`; `DEFAULT_PORTS` gains `portal: 4025` |
| `scripts/demo-lib.ts` | `--users`: L2's child env gets `USER_ACCOUNTS=1` and the dev mnemonic. `demo:local` never passes it |
| `scripts/dev-issuer-lib.ts`, `dev-token.ts` | since 2026-11-10 the dev issuer speaks the Auth0 shape: `sub` (`dev\|<subject>`), `permissions`, `azp`, the sign-in time claim; `--portal` for the portal's client; `--service` for an Entra-shaped app token (`idtyp: app`, `roles`) |
| `scripts/vscode-local.ts`, `.vscode/launch.json` | role `portal` (not a stack service; its pre-launch task starts the stack with `--users`); T-DEV-01 and T-DEV-02 maps |

## Azure

### Names (every environment's parameter files; T-IAC-01 rule 15)

| File | Key | dev value |
|---|---|---|
| `main.<env>.bicepparam` | `names.identities.portal` | `id-portal-eastus2-dev` |
| | `names.vaults.portal` | `kv-portal-eastus2-dev` (21 characters) |
| | `names.apps.portal` | `ca-portal-eastus2-dev` |
| `pre-deploy.<env>.bicepparam` | `names.portalApp` | removed (2026-11-10): the web app is an Auth0 client, not an Entra app registration |

Rule 15's `APPS` gains `portal`. `STANDARD` no longer has `portalApp`.

### Parameters

`main.<env>.bicepparam` gains one plain object (not a user-defined type, as for `ciba`):

```bicep
param userAccounts = {
  enabled: false
  portalClientId: ''            // the Auth0 single-page client's ID, from Terraform's output
  sellerName: 'x402 demo seller'
  cardVault: 'off'              // 'off' or 'stripe'
  cardVaultPublishableKey: ''   // pk_test_…
}
```

`main.bicep` fails validation when `enabled` is true, or the unit is `portal`, without a `portalClientId` (the
portal doesn't start without it; an Auth0 client ID is not a GUID, so the check is "not empty"), when `cardVault` is neither `off` nor `stripe`, or when it
is `stripe` without a publishable key that starts with `pk_test_`.

It also gains a second plain object, `identity`, with the values of people's sign-in, taken from Terraform's output
as `ciba` is:

```bicep
param identity = {
  issuer: ''          // https://<auth0 domain>/
  audience: ''        // the API's identifier
  agentClientIds: []  // the Auth0 clients the agent service accepts
}
```

`main.bicep` fails validation when `userAccounts.enabled` is true with an `identity.issuer` that is not `https://…/`,
an empty `audience`, or `portalClientId` among `agentClientIds`.

`pre-deploy.<env>.bicepparam` loses `portalOrigin` and `portalPreAuthorized` (2026-11-10): the portal's origin is now
a Terraform variable of `auth0/`, for the client's allowed callback and web origins.

### `infra/main.bicep`

- `unit` gains `portal`; the `units` table gains `{ key: 'portal', subnet: 'x402' }`, which gives it an identity,
  AcrPull and a vault through the existing loops.
- A new module, `modules/portal-apps.bicep`, under `if (unit == 'portal')`, taking `names` whole, its image
  `x402-portal:<imageTag>`, `acrServer`, `authAudience` and `userAccounts`.
- Platform modules: `storage.bicep` gains a second NFS share, `profiles`; `environments.bicep` gains the matching
  environment storage in the `x402` environment.
- Output `portalFqdn`.

### `modules/portal-apps.bicep`

| Setting | Value |
|---|---|
| Environment | `x402` |
| Ingress | `external: true`, `targetPort: 4025`, `transport: 'auto'`, `allowInsecure: false` |
| Revisions, scale | single revision; `minReplicas: 0`, `maxReplicas: 1` |
| Identity | `id-portal`, lifecycle `None` |
| Command | `node dist/src/portal-main.js` |
| Volume | `profiles` (NFS), mounted at `/app/.local/portal` |
| Probes | `/healthz`, `/readyz` |
| Secrets | `portal-token`, `card-vault-key`, both from `kv-portal`, always referenced |

Env: `NETWORK=base-sepolia`, `PORTAL_BIND_HOST=0.0.0.0`, `TRUSTED_PROXY_HOPS=1`, `CONTROL_URL` (L2's internal address),
`AUTH_ISSUER`, `AUTH_AUDIENCE`, `PORTAL_CLIENT_ID`, `PROFILE_DIR=/app/.local/portal/profiles`,
`CARD_VAULT` (set only when `stripe`), `CARD_VAULT_PUBLISHABLE_KEY`, and by `secretRef`: `PORTAL_TOKEN`,
`CARD_VAULT_KEY`. Never `API_DOCS`.

### `modules/l2-apps.bicep`

Two more secrets from `kv-l2`, always referenced: `portal-token` → `PORTAL_TOKEN`, `user-wallet-mnemonic` →
`USER_WALLET_MNEMONIC`. Env `USER_ACCOUNTS: userAccounts.enabled ? '1' : '0'` and `PLATFORM_SELLERS`: one entry
built from the seller's host (the same expression as `ALLOWED_HOSTS`), `userAccounts.sellerName` and `sellerPayTo`.

`modules/l1-apps.bicep`: on the agent app, `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` from `identity`,
`PORTAL_CLIENT_ID` from `userAccounts.portalClientId`, and `SERVICE_AUDIENCE` from `authAudience` (the Entra API
app, for system identities).

### Secrets, seeded by hand

```text
# every environment, before its first L2 deployment with 013 (as for ciba-client-credential):
kv-l2:      portal-token = off        user-wallet-mnemonic = off
# before the portal's first deployment:
kv-portal:  portal-token = off        card-vault-key = off

# to turn user accounts on:
kv-l2 and kv-portal: portal-token = <one new random value, the same in both>
kv-l2:               user-wallet-mnemonic = <a new 24-word mnemonic>
kv-portal:           card-vault-key = <rk_test_…>   (only with cardVault: 'stripe')
# then userAccounts.enabled: true, and deploy-l2, deploy-portal, deploy-l1
```

Values are piped into the vault, never printed or put on a command line (quickstart §6). With `off`, L2 ignores
both secrets and the portal starts, serves the web app and answers every data route with 502, since L2's portal
routes are 404.

**The mnemonic is never rotated in place**: a different one makes L2 refuse to start, because recorded addresses
no longer match (R3). Back it up where the payer key is backed up.

### `infra/pre-deploy.bicep`

Since 2026-11-10 this template no longer describes people's sign-in. What this feature first added to it is taken
out again:

- API app: the `Portal.Access` scope, its pre-authorization and the `portalPreAuthorized` parameter go, and so does
  the `auth_time` optional claim. `idtyp` stays, because the agent service needs it to recognize an app-only token.
  Entra wants a scope disabled before it is removed, so this is expected to take two deployments: one that sets
  `isEnabled: false` and drops the pre-authorization, one that removes the scope (unverified, R19). As built: a
  required bool parameter, `retirePortalScope`, says which of the two it is (true keeps the scope, disabled; false
  leaves it out; a new environment starts with false). Bicep never deletes the old web app registration: that is
  done by hand.
- The `names.portalApp` application and the `portalOrigin` parameter go. `infra/cleanup.sh` and its test are back
  to two app registrations.
- `mainParameters` is back to three lines.
- The `user_impersonation` scope, the Azure CLI's pre-authorization and the `agentUsers` assignments are left as
  they are: unused once people sign in with Auth0, and removing them is 011's decision, not this feature's.

### `auth0/` (Terraform, applied by `provision-auth0.yml`)

The tenant already holds the approval set-up of 012. This feature adds, in the same root:

| Resource | Settings |
|---|---|
| API (resource server) | identifier = `identity.audience`; RS256; RBAC enforced; permissions added to the access token; one permission, `agent:run`; offline access allowed (refresh-token rotation for the web app) |
| Role `x402-user` | exactly the permission `agent:run` on that API. No user is assigned in code |
| Client: portal (single-page application) | authorization code with PKCE, no secret; allowed callbacks, web origins and logout URLs = `http://localhost:4025` and the `portal_origin` variable when set; refresh-token rotation; no other grant |
| Client: agent CLI (native) | device authorization grant only, no secret; for `npm run user-token` |
| Action, post-login | sets `AUTH_TIME_CLAIM` on the access token to the time of the most recent authentication; sets nothing else |

Outputs, named as the existing `bicepparam_ciba` is: `bicepparam_identity` (the `identity` object) and
`bicepparam_portal_client_id` (`userAccounts.portalClientId`) for `main.<env>.bicepparam`, and `agent_env` and
`portal_env`, the `AUTH_*` lines for the env files (`agent_env` includes `AGENT_CLI_CLIENT_ID` for
`npm run user-token`). The deployed portal's origin arrives as the GitHub environment variable
`AUTH0_PORTAL_ORIGIN`, set by hand after the portal's first deployment (a GitHub variable can't be empty, so
`github-setup.sh` does not create it). No secret is created: both clients are public.

T-IAC-02 gains: the API's RBAC flags and its single permission; the role holds exactly that permission; both clients
are public and each has only its own grant; the portal client's URLs are exactly the local one and the variable;
the Action writes one namespaced claim; no user, role assignment or connection password in code. Must-fail mutants
for each.

### T-IAC-01 changes

| Rule | Change |
|---|---|
| 2 | `USER_WALLET_MNEMONIC` only in `apps.l2`'s container `l2`, from `kv-l2`; no other app reads `kv-l2` (unchanged) |
| 3 | `EXTERNAL_OK` gains `apps.portal` |
| 4 (extended) | the `ledger` storage is mounted by `apps.l2` only; the `profiles` storage by `apps.portal` only |
| 8 | the secret-name pattern gains `MNEMONIC` and `CARD_VAULT_KEY`: never literals |
| 12, 13, 15, 17, 18 | the `UNITS`, `APP_UNIT`, `APPS`, `STANDARD`, `MainNames`, `DEPLOY_UNITS` tables gain the portal |
| 16 | back to the 012 state for scopes and clients: one role, the `user_impersonation` scope, the Azure CLI as the only pre-authorized client; the optional claim `idtyp` only; no web app registration (2026-11-10) |
| 21 (new) | user accounts: L2 always references both new secrets; `USER_ACCOUNTS` and `PLATFORM_SELLERS` come from `userAccounts` and the seller's own host; the portal reads only `kv-portal`; the portal app gets no `PAYER_PRIVATE_KEY`, no `USER_WALLET_MNEMONIC` and no token other than `PORTAL_TOKEN`; `main.bicep` passes `userAccounts` whole |

Each changed rule keeps a must-fail mutant.

### Image and pipeline

- `scripts/image-closure.ts`: `ImageName` gains `portal`:
  `{ dockerfile: "docker/portal.Dockerfile", entries: ["src/portal-main.ts"], allowed: ["src/portal/", "src/shared/"], extraPackages: ["swagger-ui-dist"] }`.
- `docker/portal.Dockerfile`: the shared pinned base; `npm run build && npm run build:web && npx tsx
  scripts/image-closure.ts portal /out`; copies `dist/portal-web` and `docs/portal.openapi.yaml`; creates
  `/app/.local/portal` owned by `node`; the module-load check; `USER node`.
- T-IMG-01: the portal image holds no `src/layer2-control/`, `src/layer1-intent/`, `src/layer3-settlement/` or
  `src/counterparty/` file and none of the agent's packages. `react` and the other web packages are
  devDependencies, bundled at build time, so they are not in the runtime closure.
- `.github/workflows/deploy-portal.yml`: like `deploy-l2.yml`, with `unit: portal`, tag `deploy-portal-*`, the
  shared `deploy-azure` concurrency group.
- `.github/workflows/deploy.yml`: step 0 gains `portal) image=portal dockerfile=docker/portal.Dockerfile`; reads
  `CA_PORTAL`; the wait step polls the portal's revision like L1 and L3; a new check step `portal-smoke` after the
  hosted smoke (`/healthz` is 200, `/api/config` is 200 with `mode: "auth0"`, `/api/me` without a token is 401),
  skipped on a first deployment before the portal exists; the docker env scan (step 2b) also refuses `_MNEMONIC=`
  and `CARD_VAULT_KEY=`.
- T-E2E-AZ: `PIPELINES`, `UNIT_IMAGES`, `ORDER`, `STEP_IF` and the folder's exact file list gain the portal.
- **First deployment order** (quickstart §6): `pre-deploy.bicep`, `github-setup.sh`, platform with `seed-ip`, seed
  the vaults (now including `kv-portal`), platform again, seller, L3, operator, L2, **portal**, L1 last; then
  `provision-auth0.yml` again with `portal_origin` set, so the portal's deployed address is an allowed origin.

## Tests

| ID | Covers |
|---|---|
| T-USR-07 | L2 config: on without a token, a mnemonic or a valid platform file refuses to start before the lock, naming the setting only; equal tokens refused; off ignores them |
| T-USR-08 | wallet addresses: a changed mnemonic refuses to start; the keyring derives the recorded address for each index |
| T-PRT-09 | portal entry point refuses when a payment key name is visible; config errors name the variable only |
| T-ARCH-A10, A11, A12 | the three new rules, each with its fixture, clean walk and not-vacuous check; A1 and A4 over `src/portal/` |
| T-ARCH-ENV | 8 templates; the new names; secret-like keys empty |
| T-IAC-01 | rules 2, 3, 4, 8, 12, 13, 15–18 updated, rule 21 new, with mutants |
| T-IMG-01 | the portal image's closure and Dockerfile shape |
| T-DEV-01, 02 | the `portal` role and its launch configuration |
| T-E2E-AZ | the new pipeline, the guard for `portal`, the new step's place and condition |
