# Contract: Azure topology (proposed SPEC §3.1 "Azure profile")

The sources are `infra/pre-deploy.bicep` (the resource group, the Entra objects and the deploy app's
roles) and `infra/main.bicep` with its modules (everything in the resource group), with every value in
their parameter files. Azure is provisioned by these two templates only. There is one resource group per
environment (`rg-x402-<location>-<env>`). The region is `eastus2`, where Foundry offers Claude Global
Standard deployments. The rules below are what T-IAC-01 asserts on the compiled ARM JSON and the
parameter files.

## Naming

Every resource and app registration is `{type}-{app}-{location}-{env}`. Every name is written in the
parameter files' `names` (`infra/main.<env>.bicepparam`, `infra/pre-deploy.<env>.bicepparam`; revised
2026-11-03, before that `infra/naming.sh`), and the templates and workflow take them from there: none
names a resource itself. T-IAC-01 rule 15 checks each name against this standard. The names in this
contract are dev's (`eastus2`).
- `{type}`: `rg`, `vnet`, `snet`, `log`, `cr` (registry), `st` (storage), `ais` (Foundry), `cae` (Container
  Apps environment), `id` (identity), `kv`, `ca` (container app), `caj` (container app job), `app` (Entra
  app registration).
- `{app}`: `l1`, `l2`, `l3`; `op`, the operator's identity and vault; `seller` and `seller-alias`; `x402` for
  what the layers share; `deploy` for the deploy app registration. A layer's job takes the layer's segment:
  `caj-l1-…` is the regression job, `caj-l2-…` the operator job.
- The registry and the storage account allow only letters and digits: `crx402eastus2dev`, `stx402eastus2dev`.
- Vault, registry, storage and Foundry names are global across Azure, and carry no random suffix, so one
  may already be taken. The deployment then fails on that name. A deleted vault keeps its name for 90 days
  (purge protection), so deploying the same environment again in that time means recovering the vaults
  first (quickstart §6).

## Resources

| Resource | Name pattern | Notes |
|---|---|---|
| VNet + subnets | `vnet-x402-eastus2-dev`; `snet-x402-eastus2-dev` (/23) and `snet-seller-eastus2-dev` (/23), each delegated to `Microsoft.App/environments` and with the `Microsoft.KeyVault` service endpoint | one infrastructure subnet per Container Apps environment |
| Container Apps environment (main) | `cae-x402-eastus2-dev` | workload profiles (Consumption), *external*, custom VNet, peer-to-peer encryption on, logs to Log Analytics |
| Container Apps environment (counterparty) | `cae-seller-eastus2-dev` | external, on `snet-seller-eastus2-dev`; holds only the sellers. A separate environment, so it can't reach the internal apps |
| Container registry | `crx402eastus2dev` | admin user disabled; pulls through managed identity (AcrPull) |
| Log Analytics | `log-x402-eastus2-dev` | 30-day retention |
| Storage (NFS premium) | `stx402eastus2dev`, share `ledger` | NFSv4.1, reachable from `vnet-x402-eastus2-dev` only, mounted in `cae-x402-eastus2-dev` as storage `ledger` |
| Key Vaults (RBAC mode) | `kv-l1-eastus2-dev`, `kv-l2-…`, `kv-l3-…`, `kv-op-…`, `kv-seller-…` | firewall default Deny, with a VNet rule for the owning unit's subnet (`snet-x402-eastus2-dev`, or `snet-seller-eastus2-dev` for `-seller`). Seeding opens them to an operator's IP through `seedIp` (a platform-only run of `deploy.yml`); the next run closes them. Purge protection on; `recoverVaults` recovers them from soft-delete |
| User-assigned identities | `id-l1-eastus2-dev`, `id-l2-eastus2-dev`, `id-l3-eastus2-dev`, `id-op-eastus2-dev`, `id-seller-eastus2-dev` | one per runtime unit |
| Foundry resource + deployment | `ais-x402-eastus2-dev`, deployment `claude-sonnet-5-5` (version 2, Global Standard, capacity 10) | `MODEL_PROVIDER=foundry` only; API keys disabled. The deployment declares `modelProviderData` (organization, country, industry, from `main.<env>.bicepparam`), which accepts Anthropic's Azure Marketplace terms |
| Entra app registration (API) | `app-l1-eastus2-dev` | identifier URI `api://app-l1-eastus2-dev`, v2.0 tokens; app role `Agent.Run` (User, Application), assignment required; delegated scope `user_impersonation` (admin consent), the Azure CLI pre-authorized |
| Entra app registration (deploy) | `app-deploy-eastus2-dev` | no secret, no API permission; one federated credential for GitHub's immutable subject `repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>:environment:<githubEnvironment>` (GitHub OIDC; the IDs are in `pre-deploy.<env>.bicepparam`) |
| Entra security group | `grp-op-eastus2-dev` | the operators (`operators` in `pre-deploy.<env>.bicepparam`, added, never removed by a redeployment) |

## Apps and jobs

| Unit | Env | Containers | Ingress | Scale | Identity (lifecycle) | Probes |
|---|---|---|---|---|---|---|
| `ca-l1-eastus2-dev` | main | `agent`: `node dist/src/hosted-main.js` | external, target 4024, HTTPS only | min 0, max 1; multiple revision mode | `id-l1-eastus2-dev` (Main) | HTTP `/healthz` (liveness), `/readyz` (readiness) |
| `ca-l2-eastus2-dev` | main | `l2`: `node dist/src/layer2-control/service.js`; `proxy`: `nginx-unprivileged@sha256:…` | internal (`external: false`), target 8080, `allowInsecure: true` | min 1, max 1; single revision mode | `id-l2-eastus2-dev` (None) | TCP 8080 |
| `ca-l3-eastus2-dev` | main | `l3`: `node dist/src/layer3-settlement/service.js`; `proxy` | internal, target 8080, `allowInsecure: true` | min 1, max 1; single revision | `id-l3-eastus2-dev` (None) | TCP 8080 |
| `caj-l1-eastus2-dev` | main | `regression`: `node dist/src/main.js --scripted --check-baseline` | — | manual, parallelism 1, timeout 900 s | `id-l1-eastus2-dev` (None) | — |
| `caj-l2-eastus2-dev` | main | `operator`: `node dist/scripts/ledger-verify.js`, what `deploy.yml` runs; an operator's start overrides command and args (`dist/scripts/approve.js`, `reject.js`, `escalations.js`) | — | manual, timeout 3,600 s | `id-op-eastus2-dev` (None) | — |
| `ca-seller-eastus2-dev` | cp | `seller`: `node dist/src/counterparty/seller.js` | external, target 4021 | min 0, max 1 | `id-seller-eastus2-dev` (None) | HTTP `/api/catalog` |
| `ca-seller-alias-eastus2-dev` | cp | same image and env as `ca-seller-eastus2-dev` | external | min 0, max 1 | `id-seller-eastus2-dev` (None) | same |

## Templates and pipeline

| Template | Scope | Deploys | Deployed by |
|---|---|---|---|
| `infra/pre-deploy.bicep` | subscription | the resource group; the API and deploy app registrations and their service principals; the deploy app's federated credential; `Agent.Run` for the deploy app and `agentUsers`; the operators' group; the deploy app's roles (`modules/deploy-access.bicep`) | an administrator, by hand (quickstart §4 step 0) |
| `infra/main.bicep` | resource group | the platform (network, logs, identities, registry, vaults, storage, Foundry and its model, both environments) and each unit's apps (`modules/l1-apps.bicep`, `l2-apps.bicep`, `l3-apps.bicep`, `sellers.bicep`) | `.github/workflows/deploy.yml` ([deploy-pipeline](deploy-pipeline.md)) |

- Every value is in `infra/<template>.<env>.bicepparam`, the target (tenant, subscription, location) and
  every name (`names`, the resource group's included). Only `imageTag`, `platformOnly`, `seedIp`, `recoverVaults` and
  `agentStableRevision` come from the environment, set by `deploy.yml`. Each template fails validation
  (`fail()`) outside its file's tenant and subscription and, for `main.bicep`, resource group.
- Every module of `main.bicep` takes names and settings only, and looks up what it uses (identities,
  environments, Foundry) by name with `existing`. A parameter holding another module's output makes
  what-if skip the whole module, so a first deployment would preview almost nothing; `dependsOn` orders
  the modules instead. Each apps module looks up only its own identities and vaults.
- The Entra objects use the Microsoft Graph Bicep extension (`infra/bicepconfig.json`,
  `microsoftgraph/v1.0:1.0.0`). what-if can't preview them, nor the role assignments of their principals.

Each unit runs from its own layer's image, tagged with the commit SHA (research R14):
- `x402-l1-agent`: `ca-l1-eastus2-dev` and `caj-l1-eastus2-dev`;
- `x402-l2-control`: `ca-l2-eastus2-dev` and `caj-l2-eastus2-dev`;
- `x402-l3-verifier`: `ca-l3-eastus2-dev`;
- `x402-seller`: `ca-seller-eastus2-dev` and `ca-seller-alias-eastus2-dev`.

The `proxy` sidecars run the pinned nginx image.

`ledger-verify.js` is a new small operator command, `npm run ledger-verify`. It calls
`GET /v1/ledger/verify` with `OPERATOR_TOKEN` and exits 0 only when `ok` is true. The cloud
regression uses it for the chain check.

## Non-secret env (per container)

`<cp-domain>` and `<main-domain>` are the environments' `defaultDomain` outputs, so every value is
computed in Bicep.

| Unit / container | Env |
|---|---|
| `ca-l1-eastus2-dev/agent` | `NETWORK=base-sepolia`, `SELLER_URL=https://ca-seller-eastus2-dev.<cp-domain>`, `CONTROL_URL=http://ca-l2-eastus2-dev.internal.<main-domain>`, `SETTLEMENT_URL=http://ca-l3-eastus2-dev.internal.<main-domain>`, `MODEL_PROVIDER=foundry`, `ANTHROPIC_MODEL=claude-sonnet-5-5`, `FOUNDRY_BASE_URL=https://ais-x402-eastus2-dev.services.ai.azure.com/anthropic/v1`, `AZURE_CLIENT_ID=<id-l1-eastus2-dev clientId>`, `AUTH_TENANT_ID`, `AUTH_AUDIENCE=<the API app's client ID>`, `AGENT_BIND_HOST=0.0.0.0`, `AGENT_PORT=4024`, `MASTRA_TELEMETRY_DISABLED=1` |
| `ca-l2-eastus2-dev/l2` | `NETWORK=base-sepolia`, `ALLOWED_PAYEES=<seller payTo>`, `ALLOWED_HOSTS=ca-seller-eastus2-dev.<cp-domain>` (no port: the policy compares `URL.host`, and an https URL on 443 has none; never the alias FQDN) |
| `ca-l3-eastus2-dev/l3` | `NETWORK=base-sepolia`, `CONTROL_URL=http://ca-l2-eastus2-dev.internal.<main-domain>`, optional `BASE_SEPOLIA_RPC_URL` |
| `caj-l1-eastus2-dev/regression` | `NETWORK=base-sepolia`, `SELLER_URL=https://ca-seller-eastus2-dev.<cp-domain>`, `SELLER_ALIAS_URL=https://ca-seller-alias-eastus2-dev.<cp-domain>`, `CONTROL_URL` and `SETTLEMENT_URL` as for the agent |
| `caj-l2-eastus2-dev/operator` | `CONTROL_URL=http://ca-l2-eastus2-dev.internal.<main-domain>` |
| `ca-seller-eastus2-dev/seller`, `ca-seller-alias-eastus2-dev/seller` | `NETWORK=base-sepolia`, `SELLER_PAY_TO=<seller payTo>`, `FACILITATOR=cdp`, `SELLER_PORT=4021` |
| `*/proxy` | none |

## Secrets (Key Vault references, per container env)

| Unit / container | Env from secrets | Vault |
|---|---|---|
| `ca-l1-eastus2-dev/agent` | `CONTROL_TOKEN`, `VERIFIER_TOKEN`, `SESSION_REF_SECRET`, (`ANTHROPIC_API_KEY`) | `kv-l1-eastus2-dev` |
| `ca-l2-eastus2-dev/l2` | `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `SETTLEMENT_TOKEN`, `OPERATOR_TOKEN` | `kv-l2-eastus2-dev` |
| `ca-l2-eastus2-dev/proxy` | **none** | — |
| `ca-l3-eastus2-dev/l3` | `VERIFIER_TOKEN`, `SETTLEMENT_TOKEN` | `kv-l3-eastus2-dev` |
| `ca-l3-eastus2-dev/proxy` | **none** | — |
| `caj-l1-eastus2-dev/regression` | `CONTROL_TOKEN`, `VERIFIER_TOKEN` | `kv-l1-eastus2-dev` |
| `caj-l2-eastus2-dev/operator` | `OPERATOR_TOKEN` | `kv-op-eastus2-dev` |
| `ca-seller-eastus2-dev/seller`, `ca-seller-alias-eastus2-dev/seller` | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | `kv-seller-eastus2-dev` |

A shared bearer token (e.g. `CONTROL_TOKEN`) has one copy in each holder's vault. Rotation updates
both copies, then restarts both units.

## Role assignments (the only ones allowed)

| Principal | Role | Scope |
|---|---|---|
| `id-l1-eastus2-dev` | Key Vault Secrets User | `kv-l1-eastus2-dev` |
| `id-l1-eastus2-dev` | Cognitive Services User | `ais-x402-eastus2-dev` |
| `id-l2-eastus2-dev` | Key Vault Secrets User | `kv-l2-eastus2-dev` |
| `id-l3-eastus2-dev` | Key Vault Secrets User | `kv-l3-eastus2-dev` |
| `id-op-eastus2-dev` | Key Vault Secrets User | `kv-op-eastus2-dev` |
| `id-seller-eastus2-dev` | Key Vault Secrets User | `kv-seller-eastus2-dev` |
| each identity | AcrPull | `crx402eastus2dev` |
| `grp-op-eastus2-dev` (operators' group) | Container Apps Jobs Operator | `caj-l2-eastus2-dev` only |
| `app-deploy-eastus2-dev` (GitHub OIDC) | Contributor + Role Based Access Control Administrator, limited by condition to the four roles above (Key Vault Secrets User, AcrPull, Cognitive Services User, Container Apps Jobs Operator) | `rg-x402-<location>-<env>` only |
| `app-deploy-eastus2-dev` and `agentUsers` | app role `Agent.Run` | `app-l1-eastus2-dev` |

## Proxy sidecar (`infra/proxy/nginx.conf`)

- `listen 8080`. `location /` → `proxy_pass http://127.0.0.1:<4020|4023>`.
- `client_max_body_size 256k`.
- The access log format leaves out `$http_authorization`.
- `location = /healthz` proxies an unauthenticated request: `GET /v1/escalations` for L2,
  `POST /v1/settlements` for L3. `proxy_intercept_errors on`, so an upstream 401 → 200 `ok`. Any
  other status, or an unreachable upstream, → 502.
- No env and no volume mounts besides its config.

## T-IAC-01 assertions (on the compiled ARM JSON and the parameter files)

1. Role assignments are exactly the table above. In particular, `id-l1-eastus2-dev` has nothing on
   `kv-l2-eastus2-dev` or `kv-l3-eastus2-dev`.
2. `PAYER_PRIVATE_KEY` appears only in `ca-l2-eastus2-dev`'s `l2` container env, and only as a
   `secretRef` to `kv-l2-eastus2-dev`.
3. `ca-l2-eastus2-dev` and `ca-l3-eastus2-dev` have `external: false`. `ca-l1-eastus2-dev`, `ca-seller-eastus2-dev` and
   `ca-seller-alias-eastus2-dev` are the only external ingresses.
4. `ca-l2-eastus2-dev` has `maxReplicas: 1` and the `ledger` NFS volume at `/app/.local`.
5. Every `proxy` container has no `env` and no `secretRef`.
6. Identity lifecycles are `Main` for `ca-l1-eastus2-dev` and `None` everywhere else.
7. The sellers are in `cae-seller-eastus2-dev`. Nothing in `cae-seller-eastus2-dev` references `kv-l1-eastus2-dev`, `kv-l2-…`, `kv-l3-…` or `kv-op-…`.
8. No secret value, private key or token appears literally anywhere in the template or parameter
   files (the secret-scan patterns).
9. `ca-l2-eastus2-dev`'s `ALLOWED_HOSTS` equals the `ca-seller-eastus2-dev` FQDN, never the `ca-seller-alias-eastus2-dev`
   FQDN, and `ALLOWED_PAYEES` is non-empty. `caj-l1-eastus2-dev`'s `SELLER_ALIAS_URL` points at
   `ca-seller-alias-eastus2-dev`.
10. Every Key Vault's firewall default is `Deny`, and its VNet rule names only its unit's subnet. Its only
    IP rule is `seedIp`, empty unless `deploy.yml` sets it. Purge protection stays on, and a vault is
    recovered from soft-delete only through `recoverVaults`.
11. `authAudience` is a required parameter of exactly 36 characters (the API app's client ID, with no
    `api://` default), and the agent's `AUTH_AUDIENCE` comes from it.
12. Each app and job runs from its own unit's image, `x402-<image>:<imageTag>` in the platform's
    registry, as listed under "Apps and jobs". That image contains the entry point its command runs
    (`IMAGES` in `scripts/image-closure.ts`). The operator job's own command is `ledger-verify`, the
    only one `deploy.yml` starts it with. The L2 and L3 sidecars run `main.bicep`'s digest-pinned nginx.
13. Each unit's apps module looks up only its own identities and vaults (L1: `id-l1-eastus2-dev` and
    `kv-l1-…`; L2: `id-l2-eastus2-dev`, `id-op-eastus2-dev`, `kv-l2-…` and `kv-op-…`; L3: `id-l3-eastus2-dev`
    and `kv-l3-…`; the seller: `id-seller-eastus2-dev` and `kv-seller-…`), and depends on the platform's
    identities, registry, vaults and environments.
14. The model is keyless. The Foundry account has `disableLocalAuth: true`, and no container has an
    `ANTHROPIC_API_KEY` env or an Anthropic secret. The agent runs with `MODEL_PROVIDER=foundry`,
    signs in as `id-l1-eastus2-dev` (`AZURE_CLIENT_ID`), and reaches the platform's Foundry endpoint.
    Its `ANTHROPIC_MODEL` is the Foundry deployment (`format: Anthropic`, Global Standard), which
    declares its organization, country and industry (`modelProviderData`).
15. Every name is in the parameter files' `names`, and is the standard `{type}-{app}-{location}-{env}`
    for its place there, within Azure's length and character rules (such as 24 characters for a Key
    Vault). Each resource's name comes from `names`, each of `names` is deployed, every module gets
    `names` whole, and no template builds a string from the location or writes a name out.
16. The Entra objects and the deploy app's roles (`pre-deploy.bicep`). The API app takes v2.0 tokens for
    `api://app-l1-<location>-<env>`, has only the `Agent.Run` role and only the admin-consent
    `user_impersonation` scope, with only the Azure CLI pre-authorized; its service principal requires
    assignment. No app has a password or key credential, and both are single-tenant. The deploy app
    has no API or permissions, and exactly one federated credential, for GitHub's immutable subject
    `repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>:environment:<githubEnvironment>` (both IDs numeric). `Agent.Run` goes to the deploy app and
    `agentUsers` only. The operators' group is a security group of `operators`. The deploy app has
    Contributor and Role Based Access Control Administrator on the resource group only, the latter's
    condition listing exactly the roles `main.bicep` assigns.
17. Every value is in the parameter files. Each template parameter is set in its file; only the five
    per-run parameters come from the environment. Both files of an environment name the same tenant,
    subscription, location and resource group, and `githubEnvironment` is the environment. Each template
    refuses (`fail()`) to run outside its file's target.

**Must fail**: mutated copies of the templates and parameter files, each must trip its check:
- an extra role assignment of `id-l1-eastus2-dev` on `kv-l2-eastus2-dev` (rule 1);
- a `PAYER_PRIVATE_KEY` env on `ca-l1-eastus2-dev` (rule 2);
- `external: true` on `ca-l2-eastus2-dev` (rule 3);
- `ALLOWED_HOSTS` pointing at `ca-seller-alias-eastus2-dev` (rule 9);
- a vault firewall that allows by default (rule 10);
- an `api://app-l1-eastus2-dev` default for `authAudience` (rule 11);
- L2's apps on the L1 image, and `caj-l2-eastus2-dev` with an own command other than `ledger-verify`
  or one the L2 image doesn't contain (rule 12);
- L1's apps reading the l2 vault, and L1's apps deployed without waiting for the vaults (rule 13);
- a Foundry account that accepts API keys, and an Anthropic key on the agent (rule 14);
- a name in the parameter file outside the standard, a template that names a resource itself, L3
  calling L2 under a name the template writes out, a module that doesn't get `names` whole, and a
  location whose vault names exceed 24 characters (rule 15);
- a federated credential trusting a branch, an unconditioned Role Based Access Control Administrator or
  one that may grant Owner, and an API app on v1.0 tokens (rule 16);
- `main.bicep` without its target check, a configuration value or the environment's name read from the
  environment, and the two parameter files naming different subscriptions (rule 17).
