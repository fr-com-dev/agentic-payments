# Contract: Azure topology (proposed SPEC §3.1 "Azure profile")

The source is `infra/main.bicep` and its modules, with one resource group per environment
(`rg-x402-<env>`). The region is `eastus2`, where Foundry offers Claude Global Standard
deployments. The rules below are what T-IAC-01 asserts on the compiled ARM JSON.

## Resources

| Resource | Name pattern | Notes |
|---|---|---|
| VNet + subnets | `vnet-x402`; `snet-cae` (/23) and `snet-cae-cp` (/23), each delegated to `Microsoft.App/environments` and with the `Microsoft.KeyVault` service endpoint | one infrastructure subnet per Container Apps environment |
| Container Apps environment (main) | `cae-x402` | workload profiles (Consumption), *external*, custom VNet, peer-to-peer encryption on, logs to Log Analytics |
| Container Apps environment (counterparty) | `cae-x402-cp` | external, on `snet-cae-cp`; holds only the sellers. A separate environment, so it can't reach the internal apps |
| Container registry | `crx402<suffix>` | admin user disabled; pulls through managed identity (AcrPull) |
| Log Analytics | `log-x402` | 30-day retention |
| Storage (NFS premium) | `stx402<suffix>`, share `ledger` | NFSv4.1, reachable from `vnet-x402` only, mounted in `cae-x402` as storage `ledger` |
| Key Vaults (RBAC mode) | `kv-x402-l1`, `-l2`, `-l3`, `-op`, `-seller` | firewall default Deny, with a VNet rule for the owning unit's subnet (`snet-cae`, or `snet-cae-cp` for `-seller`). Seeding needs a temporary IP rule for the operator, removed afterwards. Purge protection on |
| User-assigned identities | `id-l1`, `id-l2`, `id-l3`, `id-op`, `id-seller` | one per runtime unit |
| Foundry resource + deployment | `ais-x402`, deployment `claude-sonnet-5-5` (Global Standard) | `MODEL_PROVIDER=foundry` only |
| Entra app registration | `x402-l1-agent` | app role `Agent.Run` (User, Application); assignment required |

## Apps and jobs

| Unit | Env | Containers | Ingress | Scale | Identity (lifecycle) | Probes |
|---|---|---|---|---|---|---|
| `ca-l1-agent` | main | `agent`: `node dist/src/hosted-main.js` | external, target 4024, HTTPS only | min 0, max 1; multiple revision mode | `id-l1` (Main) | HTTP `/healthz` (liveness), `/readyz` (readiness) |
| `ca-l2-control` | main | `l2`: `node dist/src/layer2-control/service.js`; `proxy`: `nginx-unprivileged@sha256:…` | internal (`external: false`), target 8080, `allowInsecure: true` | min 1, max 1; single revision mode | `id-l2` (None) | TCP 8080 |
| `ca-l3-verifier` | main | `l3`: `node dist/src/layer3-settlement/service.js`; `proxy` | internal, target 8080, `allowInsecure: true` | min 1, max 1; single revision | `id-l3` (None) | TCP 8080 |
| `job-regression` | main | `regression`: `node dist/src/main.js --scripted --check-baseline` | — | manual, parallelism 1, timeout 900 s | `id-l1` (None) | — |
| `job-operator` | main | `operator`: command and args per start (`dist/scripts/approve.js`, `reject.js`, `escalations.js`, `ledger-verify.js`) | — | manual, timeout 3,600 s | `id-op` (None) | — |
| `ca-seller` | cp | `seller`: `node dist/src/counterparty/seller.js` | external, target 4021 | min 0, max 1 | `id-seller` (None) | HTTP `/api/catalog` |
| `ca-seller-alias` | cp | same image and env as `ca-seller` | external | min 0, max 1 | `id-seller` (None) | same |

`ledger-verify.js` is a new small operator command, `npm run ledger-verify`. It calls
`GET /v1/ledger/verify` with `OPERATOR_TOKEN` and exits 0 only when `ok` is true. The cloud
regression uses it for the chain check.

## Non-secret env (per container)

`<cp-domain>` and `<main-domain>` are the environments' `defaultDomain` outputs, so every value is
computed in Bicep.

| Unit / container | Env |
|---|---|
| `ca-l1-agent/agent` | `NETWORK=base-sepolia`, `SELLER_URL=https://ca-seller.<cp-domain>`, `CONTROL_URL=http://ca-l2-control.internal.<main-domain>`, `SETTLEMENT_URL=http://ca-l3-verifier.internal.<main-domain>`, `MODEL_PROVIDER=foundry`, `ANTHROPIC_MODEL=claude-sonnet-5-5`, `FOUNDRY_BASE_URL=https://ais-x402.services.ai.azure.com/anthropic/v1`, `AZURE_CLIENT_ID=<id-l1 clientId>`, `AUTH_TENANT_ID`, `AUTH_AUDIENCE=<the API app's client ID>`, `AGENT_BIND_HOST=0.0.0.0`, `AGENT_PORT=4024`, `MASTRA_TELEMETRY_DISABLED=1` |
| `ca-l2-control/l2` | `NETWORK=base-sepolia`, `ALLOWED_PAYEES=<seller payTo>`, `ALLOWED_HOSTS=ca-seller.<cp-domain>` (no port: the policy compares `URL.host`, and an https URL on 443 has none; never the alias FQDN) |
| `ca-l3-verifier/l3` | `NETWORK=base-sepolia`, `CONTROL_URL=http://ca-l2-control.internal.<main-domain>`, optional `BASE_SEPOLIA_RPC_URL` |
| `job-regression/regression` | `NETWORK=base-sepolia`, `SELLER_URL=https://ca-seller.<cp-domain>`, `SELLER_ALIAS_URL=https://ca-seller-alias.<cp-domain>`, `CONTROL_URL` and `SETTLEMENT_URL` as for the agent |
| `job-operator/operator` | `CONTROL_URL=http://ca-l2-control.internal.<main-domain>` |
| `ca-seller*/seller` | `NETWORK=base-sepolia`, `SELLER_PAY_TO=<seller payTo>`, `FACILITATOR=cdp`, `SELLER_PORT=4021` |
| `*/proxy` | none |

## Secrets (Key Vault references, per container env)

| Unit / container | Env from secrets | Vault |
|---|---|---|
| `ca-l1-agent/agent` | `CONTROL_TOKEN`, `VERIFIER_TOKEN`, `SESSION_REF_SECRET`, (`ANTHROPIC_API_KEY`) | `kv-x402-l1` |
| `ca-l2-control/l2` | `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `SETTLEMENT_TOKEN`, `OPERATOR_TOKEN` | `kv-x402-l2` |
| `ca-l2-control/proxy` | **none** | — |
| `ca-l3-verifier/l3` | `VERIFIER_TOKEN`, `SETTLEMENT_TOKEN` | `kv-x402-l3` |
| `ca-l3-verifier/proxy` | **none** | — |
| `job-regression/regression` | `CONTROL_TOKEN`, `VERIFIER_TOKEN` | `kv-x402-l1` |
| `job-operator/operator` | `OPERATOR_TOKEN` | `kv-x402-op` |
| `ca-seller*/seller` | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | `kv-x402-seller` |

A shared bearer token (e.g. `CONTROL_TOKEN`) has one copy in each holder's vault. Rotation updates
both copies, then restarts both units.

## Role assignments (the only ones allowed)

| Principal | Role | Scope |
|---|---|---|
| `id-l1` | Key Vault Secrets User | `kv-x402-l1` |
| `id-l1` | Cognitive Services User | `ais-x402` |
| `id-l2` | Key Vault Secrets User | `kv-x402-l2` |
| `id-l3` | Key Vault Secrets User | `kv-x402-l3` |
| `id-op` | Key Vault Secrets User | `kv-x402-op` |
| `id-seller` | Key Vault Secrets User | `kv-x402-seller` |
| each identity | AcrPull | `crx402<suffix>` |
| operators' Entra group | Container Apps Jobs Operator | `job-operator` only |
| deploy identity (GitHub OIDC) | Contributor + Role Based Access Control Administrator (limited to the roles above) | `rg-x402-<env>` |

## Proxy sidecar (`infra/proxy/nginx.conf`)

- `listen 8080`. `location /` → `proxy_pass http://127.0.0.1:<4020|4023>`.
- `client_max_body_size 256k`.
- The access log format leaves out `$http_authorization`.
- `location = /healthz` proxies an unauthenticated request: `GET /v1/escalations` for L2,
  `POST /v1/settlements` for L3. `proxy_intercept_errors on`, so an upstream 401 → 200 `ok`. Any
  other status, or an unreachable upstream, → 502.
- No env and no volume mounts besides its config.

## T-IAC-01 assertions (on the compiled ARM JSON)

1. Role assignments are exactly the table above. In particular, `id-l1` has nothing on
   `kv-x402-l2` or `kv-x402-l3`.
2. `PAYER_PRIVATE_KEY` appears only in `ca-l2-control`'s `l2` container env, and only as a
   `secretRef` to `kv-x402-l2`.
3. `ca-l2-control` and `ca-l3-verifier` have `external: false`. `ca-l1-agent`, `ca-seller` and
   `ca-seller-alias` are the only external ingresses.
4. `ca-l2-control` has `maxReplicas: 1` and the `ledger` NFS volume at `/app/.local`.
5. Every `proxy` container has no `env` and no `secretRef`.
6. Identity lifecycles are `Main` for `ca-l1-agent` and `None` everywhere else.
7. The sellers are in `cae-x402-cp`. Nothing in `cae-x402-cp` references `kv-x402-l1/l2/l3/op`.
8. No secret value, private key or token appears literally anywhere in the template or parameter
   files (the secret-scan patterns).
9. `ca-l2-control`'s `ALLOWED_HOSTS` equals the `ca-seller` FQDN, never the `ca-seller-alias`
   FQDN, and `ALLOWED_PAYEES` is non-empty. `job-regression`'s `SELLER_ALIAS_URL` points at
   `ca-seller-alias`.
10. Every Key Vault's firewall default is `Deny`, and its VNet rule names only its unit's subnet.
11. `authAudience` is a required parameter of exactly 36 characters (the API app's client ID, with no
    `api://` default), and the agent's `AUTH_AUDIENCE` comes from it.

**Must fail**: three mutated copies of the template, each must trip its check:
- an extra role assignment of `id-l1` on `kv-x402-l2`;
- a `PAYER_PRIVATE_KEY` env on `ca-l1-agent`;
- `external: true` on `ca-l2-control`.
- an `api://x402-l1-agent` default for `authAudience` (rule 11).
