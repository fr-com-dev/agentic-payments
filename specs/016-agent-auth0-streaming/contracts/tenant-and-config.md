# Contract: the tenant, settings and secrets (delta to SPEC CFG-2, §3.1, §3.3, T-IAC-01, T-IAC-02)

**Feature**: [../spec.md](../spec.md) | **Research**: [../research.md](../research.md)

## The tenant (`auth0/`, Terraform)

| Object | Before | Now |
|---|---|---|
| Applications | `l2` (approval client), `portal` | those two, `agent`, and `machine[<name>]` for each machine caller |
| Permissions of people's API | `portal:admin` | `portal:admin`, `agent:run` |
| Roles | `x402-admin` (holds `portal:admin`) | `x402-admin`, `x402-agent` (holds `agent:run`) |
| Role assignments | none in code | none in code |

**The agent's client** (`auth0_client.agent`, `auth0_client_credentials.agent`): single-page application,
first-party, OIDC-conformant, grant `authorization_code` only, authentication method `none`, RS256.

| Argument | Value |
|---|---|
| `callbacks` | `<origin>/docs/oauth2-redirect.html` for each docs origin |
| `allowed_origins`, `web_origins` | each docs origin |
| docs origins | `http://localhost:4024`, `http://127.0.0.1:4024`, and `var.agent_origin` when set |

**A machine caller's client** (`for_each = var.machine_caller_keys`): `non_interactive`, grant
`client_credentials` only; `private_key_jwt` with the caller's public key (RS256); one `auth0_client_grant` for
people's API with scopes `["agent:run"]`. It has no callback, no secret and no other grant.

**Variables**

| Variable | GitHub variable | Default | Meaning |
|---|---|---|---|
| `agent_origin` | `AUTH0_AGENT_ORIGIN` | `""` | the deployed agent's origin, set by hand after its first deployment; needed only where its docs page is on |
| `machine_caller_keys` | `AUTH0_MACHINE_CALLER_KEYS` | `{}` | JSON map: caller's name to the PEM of its public key |

**Outputs**

| Output | Shape | Goes to |
|---|---|---|
| `bicepparam_agent` | `clientId`, `machineClientId`, `machineKeyId` | `agent` in `infra/main.<env>.bicepparam` (`apiDocs` is written there by hand) |
| `l1_env` | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`, `API_DOCS_CLIENT_ID` | a local `env/l1-hosted.env` pointed at the tenant |
| `l2_env` (extended) | adds `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS` | a local `env/l2-control.env` |

`machineClientId` and `machineKeyId` are those of the caller named `checks`, empty when it is not declared.

## Settings (SPEC CFG-2)

### L2 (`env/l2-control.env`)

| Variable | Meaning |
|---|---|
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS` | new; all three or none. Set: every authorize and budget call needs a caller's token. Required with `USER_ACCOUNTS=1` |
| `AUTH_JWKS_FILE` | new; `NETWORK=local` only: the dev issuer's keys, and `AUTH_ISSUER` must then be the dev issuer |
| `PORTAL_CLIENT_ID` | new, optional: when set it must not be on `AGENT_CLIENT_IDS` (L2 refuses to start) |

A missing or malformed value stops L2 before it takes the ledger lock, naming the variable and never its value.

### The hosted agent (`env/l1-hosted.env`)

See [hosted-agent-api.md](hosted-agent-api.md#settings-spec-cfg-2-envl1-hostedenv).

### The CLI agent and the smoke client (`env/l1-agent.env`)

| Variable | Read by | Meaning |
|---|---|---|
| `MACHINE_CLIENT_ID` | `src/main.ts`, `src/smoke-main.ts` | the machine caller's client at the tenant. Set: the process gets a machine token and forwards it |
| `MACHINE_CLIENT_KEY_ID`, `MACHINE_CLIENT_KEY` | `src/machine-caller/token.ts` only (rule A15) | the key's ID and its private half (PEM) |
| `AUTH_ISSUER`, `AUTH_AUDIENCE` | the same module | where to ask and for which API |
| `CALLER_TOKEN` | `src/main.ts` | local only (`NETWORK=local`): a ready-made dev machine token to forward when no machine client is set |
| `AGENT_URL`, `AGENT_CANDIDATE_URL` | `src/smoke-main.ts` | the agent's address and its candidate revision's |

With none of them set the CLI agent forwards nothing, as today.

## Azure

**Parameter file** (`infra/main.<env>.bicepparam`)

```bicep
// 016: the agent's client, the docs switch and the pipeline's machine caller. clientId, machineClientId and
// machineKeyId are Terraform's output bicepparam_agent; apiDocs is this environment's own choice.
param agent = {
  clientId: '<the agent client's ID>'
  apiDocs: true
  machineClientId: '<the checks client's ID>'
  machineKeyId: '<the checks key's ID>'
}
```

`param authAudience` is removed. `names.apiApp` is removed from `pre-deploy.<env>.bicepparam`, with
`agentUsers` and `retirePortalScope`; `names.jobs.smoke` is added to `main.<env>.bicepparam`.

**What each unit receives**

| Unit | Container | New env | New secret reference |
|---|---|---|---|
| `l1` | the agent | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`, `API_DOCS`, `API_DOCS_CLIENT_ID` | none |
| `l1` | the regression job | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `MACHINE_CLIENT_ID`, `MACHINE_CLIENT_KEY_ID` | `machine-client-key` (l1 vault) as `MACHINE_CLIENT_KEY` |
| `l1` | the smoke job (new) | the same, plus `AGENT_URL`, `AGENT_CANDIDATE_URL` | the same |
| `l2` | L2 | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`, `PORTAL_CLIENT_ID` | none |

Removed from the agent: `AUTH_TENANT_ID`, `SERVICE_AUDIENCE`.

**Validation in `main.bicep`** (`fail()`): the `l1` and `l2` units need `identity.issuer`, `identity.audience`
and `agent.clientId`; `agent.apiDocs` needs `agent.clientId`; the smoke and regression jobs need
`agent.machineClientId` and `agent.machineKeyId`.

**Secrets seeded by hand**

| Vault | Secret | Value | When |
|---|---|---|---|
| l1 | `machine-client-key` | the private half of the `checks` key (PEM), or `off` | before the first L1 deployment with this feature |

`off` lets the deployment succeed before the tenant has the client; the two jobs then fail, which fails the run
that starts them.

**The pipeline** (`.github/workflows/deploy.yml`)

- Step 0 reads `names.jobs.smoke` and no longer reads `authAudience`.
- Step 8 becomes `run_job "$CAJ_SMOKE"`. The checks it made with `jq` move into `src/smoke-main.ts`, which exits
  0 only when the run completed, both purchases are `PAID` and `CONFIRMED`, nothing escalated, and it took 120 s
  or less. It prints the duration and the outcome, never the token.
- No step asks for a token, and no step reads a secret or a variable.

**Directory objects to delete by hand** after the agent with this feature is deployed: the API app registration
named by the old `names.apiApp` (its service principal, `Agent.Run` and the assignments go with it).

## Tests

T-IAC-01 rule 11 removed; rule 16 (one registration: the deploy app); rule 21 without its agent clause; rule 23
new; rules 12 and 15 with the smoke job. T-IAC-02 as in [research R10](../research.md#r10-the-tenant-applications-permission-role).
T-E2E-AZ: the smoke step, `TARGET_OUTPUTS`, `TARGET_NAMES`. T-API-08 rewritten. T-ARCH-A14, A15 new.
