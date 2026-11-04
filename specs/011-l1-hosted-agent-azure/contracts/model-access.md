# Contract: model access and agent-service configuration (proposed CFG-2 `l1-hosted.env`, §3.3)

## Configuration (`env/l1-hosted.env`, template `env/l1-hosted.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `NETWORK` | yes | `local` or `base-sepolia` |
| `SELLER_URL`, `CONTROL_URL`, `SETTLEMENT_URL` | yes | L2/L3 internal FQDNs in Azure |
| `CONTROL_TOKEN` | yes | agent→control (INV-13); dev default on `local` only |
| `VERIFIER_TOKEN` | yes | agent→verifier; dev default on `local` only |
| `MODEL_PROVIDER` | yes | `foundry` or `anthropic` |
| `ANTHROPIC_MODEL` | no | default `claude-sonnet-5-5`; must be in the allow-list below |
| `ANTHROPIC_API_KEY` | `anthropic` only | template leaves it empty (`# set me`); forbidden with `foundry` |
| `FOUNDRY_BASE_URL` | `foundry` only | `https://<resource>.services.ai.azure.com/anthropic/v1` |
| `AZURE_CLIENT_ID` | `foundry` only | client ID of `id-l1-eastus2-dev` (user-assigned identity) |
| `AUTH_TENANT_ID`, `AUTH_AUDIENCE` | yes | [access-and-sessions](access-and-sessions.md) |
| `AUTH_JWKS_FILE` | `local` only | a dev issuer; a startup error on any other network |
| `SESSION_REF_SECRET` | yes | at least 32 bytes; template leaves it empty |
| `AGENT_PORT`, `AGENT_BIND_HOST` | no | defaults 4024, `127.0.0.1` (the container sets `0.0.0.0`) |
| `MASTRA_TELEMETRY_DISABLED` | no | the image sets `1` |

**Forbidden in this file** (T-ARCH-ENV): `PAYER_PRIVATE_KEY`, `OPERATOR_TOKEN`,
`SETTLEMENT_TOKEN`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`.

## Model allow-list

`claude-sonnet-5-5` (default), `claude-sonnet-5`, `claude-opus-5-5`, `claude-opus-5`,
`claude-haiku-5-5`. Any other value is a startup error. With `foundry`, the Foundry deployment
name must equal the model ID. An unrecognized ID makes the provider add a `json` tool (research
R2).

## The Foundry deployment (`infra/modules/foundry.bicep`)

`main.bicep` deploys the model like everything else in Azure, never the portal: `claude-sonnet-5-5`,
version 2, `format: Anthropic`, Global Standard, capacity 10 (thousands of tokens per minute), named
exactly the model ID, which `main.bicep` also passes to the agent as `ANTHROPIC_MODEL`. An Anthropic
deployment must carry `modelProviderData`: the organization name, two-letter country code and
industry, from `main.<env>.bicepparam` (`claudeOrganizationName`, `claudeCountryCode`,
`claudeIndustry`). Deploying it accepts Anthropic's Azure Marketplace terms for the subscription with
those values. The published Bicep types don't list `modelProviderData` yet, so the template silences
that warning (BCP037). what-if's preflight refuses a deployment without it. Foundry Claude refuses
credit-only subscriptions, so dev uses the pay-as-you-go `fr-com-dev`.

## Provider construction (`src/layer1-intent/hosted/model.ts`)

| | `anthropic` | `foundry` |
|---|---|---|
| Base URL | provider default (`https://api.anthropic.com/v1`) | `FOUNDRY_BASE_URL` (must end in `/anthropic/v1`) |
| Auth | `apiKey: ANTHROPIC_API_KEY` → `x-api-key` | `authToken` placeholder, plus a custom `fetch` that sets `Authorization: Bearer <token>` per request. Token from `ManagedIdentityCredential(AZURE_CLIENT_ID)` for scope `https://ai.azure.com/.default` (cached by `@azure/identity`, refreshed before expiry). |
| Azure role | — | `id-l1-eastus2-dev`: Cognitive Services User on the Foundry resource. The resource has `disableLocalAuth: true`, so it refuses API keys; no Foundry key exists anywhere (T-IAC-01 rule 14) |
| Never sent | `temperature`, `top_k` (not supported by Sonnet 5.5 on Foundry; the agent sets neither) | same |

The provider choice never changes at run time. A model error fails the run (`status: failed`),
and the steps already finished are listed.

## Credential matrix rows (SPEC §3.3 additions)

| Secret or credential | L1 agent service | L2 | L3 | Operator | Notes |
|---|---|---|---|---|---|
| Requester Entra token | verifies | — | — | — | issued to people and service principals with `Agent.Run` |
| `SESSION_REF_SECRET` | ✅ | — | — | — | |
| `ANTHROPIC_API_KEY` | ✅ (`anthropic`) | — | — | — | the existing row |
| `id-l1-eastus2-dev` Foundry access | ✅ (`foundry`) | — | — | — | managed identity, no secret |

## Tests

- **T-AGT-02 (tool set)**:
  - With `MockLanguageModelV3`, every model call offers exactly `fetch_resource` and
    `check_budget`. Names, descriptions, `type`, `properties` and `required` equal L1-3.
    `maxOutputTokens` is 2048. The run stops after 10 steps.
  - With `createAnthropic` and a fake `fetch`, for both providers with `claude-sonnet-5-5`, the
    request body's `tools` has exactly those two names and `max_tokens` is 2048. The `foundry`
    request carries `Authorization: Bearer` and no `x-api-key`.
  - An unrecognized model ID → startup error.
  - **Must fail**: an agent built with one extra tool (the test-only `extraTools` option) produces
    a third tool name, and the check reports it.
- **T-ARCH-ENV**: `env/l1-hosted.env.example` holds only the variables above. Keys and secrets are
  empty.
