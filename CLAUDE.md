# CLAUDE.md — x402 three-layer agent payments PoC

**Read `SPEC.md` before changing anything.** It is normative and has requirement IDs. This file is the short operating guide.

## What this repo is
A Claude agent buys HTTP resources with x402 (v2, `exact`, EIP-3009 USDC). Payment authority is split into three processes:
- **L1** `src/layer1-intent/`: the agent and the 402 transport loop. No keys.
- **L2** `src/layer2-control/`: pure policy engine, sole signer, hash-chained ledger, HITL approvals and rejections (escalations end approved, denied or expired; never reversed). Port 4020.
- **L3** `src/layer3-settlement/`: read-only on-chain verification and reconciliation into L2. Port 4023.

The counterparty (seller :4021, local facilitator :4022) is in `src/counterparty/`; the facilitator process starts from `scripts/facilitator.ts`, which wraps the factory in `src/counterparty/facilitator.ts`. Cross-layer types live **only** in `src/shared/contracts.ts`.

## Commands
```bash
npm install                    # not `npm ci` (ganache lockfile quirk)
npm run typecheck
npm test                       # policy, ledger, architecture, agent, on-chain e2e
npm run demo:local             # 6 processes; expect "spent on-chain: 0.006 USDC" and "hash chain ok=true"
npm run check                  # typecheck + test + demo:local (definition of done in one command)
npm run demo:base-sepolia      # opt-in live run through the CDP facilitator; needs env/*.base-sepolia.env
npm run approve -- <id> [approver]           # operator: approve a pending escalation
npm run reject -- <id> [operator] [reason]   # operator: reject a pending escalation (R15 human_rejected)
npm run escalations -- --watch               # operator: pending escalations, then each new one and outcome
API_DOCS=1 npm run l2:control                # L2 plus Swagger UI at http://127.0.0.1:4020/docs (no token; off by default)
API_DOCS=1 npm run agent:hosted              # the hosted agent plus Swagger UI at http://127.0.0.1:4024/docs (never in Azure)
API_DOCS=1 npm run seller                    # the seller plus Swagger UI at http://127.0.0.1:4021/docs (never in Azure)
npm run stack:local [-- --docker]            # chain, facilitator, seller, L2, L3 without an agent, until Ctrl-C
node --import tsx scripts/vscode-local.ts run <role> [args]   # what .vscode/launch.json runs: one process, local mode
npm run agent:hosted                         # hosted agent service (L1-6) on 127.0.0.1:4024; env/l1-hosted.env
npm run dev-token -- --subject alice         # local dev issuer token for the hosted service (NETWORK=local only)
npm run ledger-verify                        # operator: exit 0 only when the hash chain verifies
npm run build                                # dist/ (tsconfig.build.json); each image's build stage runs it
docker build -f docker/l1-agent.Dockerfile -t x402-l1-agent .   # one image per unit (docker/, the operator's included); the seller's is the root Dockerfile
BICEP_PATH=~/.azure/bin/bicep npm test       # every suite: T-IAC-01, and the cleanup and github-setup tests, need the Bicep CLI
az bicep build-params -f infra/main.dev.bicepparam --stdout | jq '.parametersJson | fromjson | .parameters'   # every value and name, as deployed
P=infra/pre-deploy.dev.bicepparam; az deployment sub what-if -n pre-deploy-dev -p $P \
  --subscription <the file's subscriptionId> -l <its location>   # then `create`; admin, by hand
infra/github-setup.sh [--dry-run]            # the GitHub environment the pipelines run in, from pre-deploy.<env>.bicepparam
infra/cleanup.sh [--dry-run] [--purge]       # delete everything of the dev environment (asks first)
terraform -chdir=auth0 init && terraform -chdir=auth0 plan -var-file=dev.tfvars -out=dev.tfplan   # the Auth0 tenant (admin, by hand)
npx vitest run test/policy.test.ts -t "<name>"   # single test
```

## Hard rules (SPEC §4). Never break these to make something pass.
1. A layer imports only `../shared/*` and its own folder. Cross-layer wiring happens only in `src/main.ts`, `scripts/` and `test/`.
2. Within `src/`, only `src/layer2-control/signer.ts` touches payment key material (`scripts/` may derive local dev keys only). The seller's CDP API credential is an auth credential confined to `src/counterparty/cdp-facilitator.ts` (A8), and L2's Auth0 client credential (`CIBA_CLIENT_KEY` / `CIBA_CLIENT_SECRET`) is one confined to `src/layer2-control/ciba-client.ts` (A9). L1 never references `PAYER_PRIVATE_KEY`. L3 never gets a wallet client. Both L1 entry points (`src/main.ts`, `src/hosted-main.ts`) sit outside `src/layer1-intent/` (rule A5 bans the key's name there), load their env file and then refuse if the key is visible. The hosted agent offers only `fetch_resource` and `check_budget`; never add a Mastra memory, workspace, sub-agent or tool to it.
3. `policy.ts` stays pure: time is an input, no I/O, and the LLM `purpose` text is never an input to a decision.
4. Budgets come from the ledger. Never add a mutable spend counter.
5. Authorize stays inside the serialized section (check → sign → append).
6. The ledger is append-only. Never rewrite or delete entries; add a new entry type instead.
7. CONFIRMED is final. Contradicting reports are stored with `anomaly: true`.
8. Amounts are atomic-unit decimal strings; use `BigInt` math only.
9. Use the `@x402/*` SDK helpers to encode and decode x402 headers. Don't hand-roll base64.
10. Each caller keeps its own bearer token. Never let one token authorize two roles.

## How to make common changes
- **New policy rule:**
  1. Add the check in `evaluateRequirement` with a snake_case rule ID.
  2. Add the row to SPEC §8.2 (L2-2).
  3. Add a test in `test/policy.test.ts`.
  4. If it needs new context, add a field to `PolicyContext` and compute it in `service.ts` from the ledger.
- **New contract field:** edit `src/shared/contracts.ts` and every producer and consumer, update SPEC §7, and extend the e2e assertions. If it crosses L2's HTTP API, also update `docs/l2-control.openapi.yaml`.
- **New or changed L2 route** (path, token, status or response field): update SPEC L2-5 and `docs/l2-control.openapi.yaml` together. `test/openapi.test.ts` (T-API-01..04) fails until both match the service. Swagger UI (`API_DOCS=1`) serves that same file, so it needs no separate update.
- **New or changed hosted agent route** (path, auth, status, header or response field): update SPEC L1-6, `specs/011` contracts/hosted-agent-api.md and `docs/l1-hosted.openapi.yaml` together. `test/openapi-hosted.test.ts` (T-API-05..08) fails until they match the service. The Swagger UI routes for L2, the agent and the seller live in `src/shared/api-docs.ts`; never set `API_DOCS` in `infra/`.
- **New network:**
  1. Add a profile in `src/shared/config.ts`.
  2. Register the scheme in the signer, seller and (if local) facilitator.
  3. Check the token's EIP-712 domain (`name`/`version`).
- **New seller route:** add a method to `SellerApi` in `src/counterparty/seller-api.ts` with `@Get(path)` and one monetization tier: `@Free(description)`, or `@PayPerUse`, `@Premium` or `@Enterprise` with `{ price: usdc("0.001"), description }` (SPEC CP-1's model). The catalog, the x402 requirements and the route follow from it. Add it to `docs/seller.openapi.yaml` with its `x-monetization-tier` and price (`x-x402-price-atomic`; T-API-09..10 fail until they match) and to the SPEC CP-1 table. If the scripted plan changes, update SPEC §8.1 L1-4 and T-E2E-01.
- **New container entry point or runtime-resolved package:** add it to `IMAGES` in `scripts/image-closure.ts` (the entry point, or `extraPackages`), and give the app or job its own unit's image in `infra/`. T-IMG-01 and T-IAC-01 rule 12 fail until they match. A new image is a new unit: its module in `main.bicep` (`if (unit == '<unit>')`, T-IAC-01 rule 18), its case in `deploy.yml` step 0 and its own `deploy-<unit>.yml` (T-E2E-AZ). Never point an app at another layer's image.
- **Extensions** (AP2 mandate, remote signer, `upto`, Solana, MCP, SQLite, mTLS, OTel, refunds): follow SPEC §15. Implement one EXT-* per PR.

## Definition of done
`npm run typecheck` and `npm test` are green. `npm run demo:local` summary is unchanged, unless the change is intentional and SPEC is updated. SPEC is updated for any behavior or contract change. New behavior has tests. When you add a safety mechanism, show its test fails without it, as T-E2E-04 does for the mutex.

## Environment
- One env file per process: `ENV_FILE=env/<role>.env`, with templates in `env/*.env.example`.
- Never create a shared `.env` containing `PAYER_PRIVATE_KEY`. The agent refuses to start if it can see that key.
- `.local/` holds the deployment and ledger and is gitignored.
- Base Sepolia needs a payer funded with test USDC (faucet.circle.com). The hosted facilitator pays gas.
- On Base Sepolia the seller uses the CDP facilitator by default. The CDP API key (`CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`) goes only in the seller's env file. `FACILITATOR=public` opts out to x402.org.
- Backchannel approval (SPEC L2-7, `specs/012`) is off unless `CIBA_APPROVAL=1`. The `CIBA_*` variables go only in `env/l2-control.env`; a missing or invalid one stops L2 before the ledger lock. Tests use the stand-in Auth0 (`test/helpers/ciba-stub.ts`) through `test/helpers/backchannel-l2.ts`, with test-only timing deps, never env.

## Gotchas
- Auth0 CIBA (L2-7): Guardian push is used only for requests that live 300 s or less (`requested_expiry`); the binding message allows at most 64 characters from `A-Za-z0-9+-_.,:#` (no spaces, no `/`); `private_key_jwt` is Enterprise-only and RS256/RS384/PS256, never ES256; Guardian displays `authorization_details` only in Auth0's schema (`urn:auth0:schemas:authorization-details:v1:…`, exactly one object); `access_denied` can also mean expired (the 5 s rule).
- The Auth0 tenant is Terraform in `auth0/` (T-IAC-02), applied by a tenant administrator with their own Management API credentials in the shell; never Terraform for Azure, never a pipeline. State, plans and `*.tfvars` are gitignored and excluded from Docker builds; commit `.terraform.lock.hcl`. The provider refuses `consent_policy = "standard"` (use `"null"`), and `auth0_guardian` is a tenant-wide singleton kept by `prevent_destroy`.
- In Azure, L2 always references the l2 vault's `ciba-client-credential` (rule 19). Seed it before an environment's first L2 deployment with 012, as `off` while `ciba.enabled` is false; otherwise the L2 revision fails and the pipeline rolls back. `ciba` in `main.bicep` is a plain object: a user-defined type switches the template to `languageVersion` 2.0, which T-IAC-01 rule 13 can't read.
- The authorize call that creates an eligible escalation waits up to 120 s outside the lock (L2-7). A must-fail switch (`serializeOutcomes`, `skipChecks`, `approvalRequestCap`) is a test-only dep of the backchannel, never env.
- Ignore ganache's `uws_linux` warning.
- Development runs on Node 26 (SPEC §5 floor is Node ≥ 22). npm 11 skips some native install scripts; ganache falls back to JS.
- Base Sepolia USDC's EIP-712 name is `"USDC"`; the local mock's is `"USD Coin"`.
- Concurrency tests need `signerLatencyMs`; local signing is too fast to expose races.
- Kill demo children by process group; otherwise ganache keeps port 8545 open.
- CDP JWTs expire in 120 s; a skewed host clock shows up as `facilitator authentication` errors.
- VS Code (`.vscode/launch.json`, `tasks.json`) runs every process through `scripts/vscode-local.ts`, always in local mode: the same child env as `stack:local` (demo-lib `childEnv`, `localStack()`), `NETWORK=local` forced, and only `API_DOCS` and the debugger's attach variables passed from VS Code. A new process or role goes in `RUN_ROLES` and gets a launch configuration; T-DEV-01 fails until they match.
- The seller's endpoints use TC39 decorators, which Node can't run natively: tsc (the build) and tsx lower them, and `vitest.config.ts` lowers them with esbuild because vite 8's oxc only knows legacy decorators. Never turn on `experimentalDecorators`.
- Mastra (`@mastra/core`) needs Node ≥ 22.13. Use it as a library only: no Mastra server, CLI or instance. Its own logger is silenced because a provider error can carry the request body.
- A Foundry deployment name must equal the model id (`claude-sonnet-5-5`); with any other id the AI SDK's Anthropic provider can add a third `json` tool, so the service refuses unknown ids.
- Entra v2.0 access tokens carry the API app's client ID as `aud`, never `api://app-l1-eastus2-dev`. In Azure, `AUTH_AUDIENCE` is that GUID (`authAudience` in `infra/main.<env>.bicepparam`, from `pre-deploy.bicep`'s `mainParameters` output), and the agent refuses anything else unless it uses the local dev issuer.
- Azure is provisioned by Bicep only (T-E2E-AZ fails on any other provisioning `az` command in the workflows or the scripts). `infra/` holds two shell scripts only, `github-setup.sh` (the GitHub environment, which Bicep can't make) and `cleanup.sh`; T-E2E-AZ fails on a third. Everything else is a template or a parameter file. `infra/pre-deploy.bicep` (subscription scope, run by an administrator by hand) makes the resource group, the API and deploy app registrations (Microsoft Graph Bicep extension, `infra/bicepconfig.json`), the operators' group and the deploy app's roles. `infra/main.bicep` makes everything in the resource group, the Claude model deployment included. what-if can't preview the Graph resources. Only the vaults' secrets are put in by hand: they never appear in a template, a parameter file or GitHub.
- Every value a deployment uses is in its parameter file, `infra/pre-deploy.<env>.bicepparam` or `infra/main.<env>.bicepparam`, the target (tenant, subscription, location) and every name included. Only Bicep reads a parameter file (`bicep build-params`, `az bicep build-params`): `deploy.yml` and both scripts use the compiled values, never a text match. Only `unit`, `imageTag`, `seedIp`, `recoverVaults` and `agentStableRevision` come from the environment, set by `deploy.yml`. Each template fails validation (`fail()`) when it runs anywhere other than its file says. T-IAC-01 rule 17 checks all of this.
- `deploy.yml` signs in with OIDC as the deploy app, whose federated credential trusts only GitHub's immutable subject `repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>:environment:<githubEnvironment>` (the repository has `use_immutable_subject` on; without the IDs, azure/login fails with AADSTS700213, and `infra/github-setup.sh` refuses when they don't match). There is no `azure/login`: every step that calls Azure starts with `eval "$SIGN_IN"`, a fresh GitHub token and `az login --federated-token`, because GitHub's token is valid for 5 minutes and az can't renew it (one sign-in for the job failed with AADSTS700024 after the platform's deployment). It reads its sign-in, target and names from `infra/main.<env>.bicepparam`, compiled by the pinned Bicep CLI that every later step and deployment uses too, and no GitHub secret or variable. Never add a credential to GitHub: there is no client secret anywhere.
- Every Azure resource and Entra app registration is named `{type}-{app}-{location}-{env}` (`ca-l1-eastus2-dev`, `kv-seller-eastus2-dev`, `app-deploy-eastus2-dev`; the registry and storage drop the hyphens). The names are written only in the parameter files' `names` object; the templates take them from `names` (every module gets it whole) and `deploy.yml` reads them from the compiled file, so neither names a resource itself. T-IAC-01 rule 15 checks every name against the standard, including Azure's length limits (a Key Vault name is at most 24 characters). A new resource needs its name in `names` first, in every environment's file.
- The vaults have purge protection and no random suffix in their names, so after `infra/cleanup.sh` their names stay taken for 90 days. Deploying the same environment again in that time means a run of `deploy-infra.yml` with `first-deployment` and `recover-vaults` (Key Vault `createMode: recover`; quickstart §6).
- `deploy.yml` starts each job with the job's own command (`run_job`), never an override: the operator job's own command is `ledger-verify`, so the deploy identity can't approve or reject. Operators override the command by hand (quickstart §5).
- Every module of `main.bicep` takes names and settings only and looks up what it uses with `existing`: a parameter holding another module's output makes what-if skip the whole module (`NestedDeploymentShortCircuited`). Order them with `dependsOn` (T-IAC-01 rule 13).
- In Azure, one pipeline per unit deploys it: `deploy-infra.yml` (the platform), `deploy-l1.yml`, `deploy-l2.yml`, `deploy-l3.yml`, `deploy-operator.yml` and `deploy-seller.yml`. Each only calls the reusable `deploy.yml` with its unit, which deploys `main.bicep` with `UNIT` set (only that unit's modules; the rest stays as it is), previewed with what-if. A unit's run builds only its image, checks every unit, then promotes that image to `last-good` or rolls that unit back; the platform is fixed forward. L1's promotion moves the agent's traffic by redeploying `main.bicep`. All six share the concurrency group `deploy-azure`; GitHub keeps one pending run per group, so a third queued run cancels the pending one: start them one after another. The pipelines hold the group, never `deploy.yml` (a called workflow sharing it deadlocks). The first deployment runs in order: `pre-deploy.bicep` by hand, `infra/github-setup.sh`, `deploy-infra` with `first-deployment` and `seed-ip`, seed the vaults, `deploy-infra` with `first-deployment` (closes the vaults), then seller, L3, operator, L2 with `first-deployment`, and L1 last (quickstart §4).
- Deploying the Claude model sends `modelProviderData` (organization, country, industry) and accepts Anthropic's Azure Marketplace terms for the subscription. Foundry Claude refuses credit-only subscriptions; dev uses the pay-as-you-go `fr-com-dev`.
- In Azure, L2 waits in standby for the ledger lock during a revision update (L2-6). Calls get 502 from its sidecar until the old revision releases the lock; L1 reports ERROR and nothing is paid.
- A CDP **Sandbox** key also shows up as `facilitator authentication` (401). Keys are environment-scoped, and the Sandbox has no x402 facilitator. Use a production key; it still settles on Base Sepolia.
