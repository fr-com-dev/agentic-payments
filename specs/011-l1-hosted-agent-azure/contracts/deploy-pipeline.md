# Contract: deployment and post-deployment regression (proposed T-E2E-AZ)

Four pipelines deploy the Azure profile (revised 2026-10-25; first one workflow, `deploy-azure.yml`):

| Workflow | Deploys | Image | Template |
|---|---|---|---|
| `deploy-infra.yml` | the platform: network, identities, registry, vaults, storage, Foundry, both environments; then the sellers | `x402-seller` (root `Dockerfile`) | `infra/main.bicep`, then `infra/seller.bicep` |
| `deploy-l1.yml` | `ca-l1-agent`, `job-regression` | `x402-l1-agent` | `infra/l1-agent.bicep` |
| `deploy-l2.yml` | `ca-l2-control`, `job-operator` | `x402-l2-control` | `infra/l2-control.bicep` |
| `deploy-l3.yml` | `ca-l3-verifier` | `x402-l3-verifier` | `infra/l3-verifier.bicep` |

- **Shared steps.** The three layer workflows call `deploy-layer.yml` with their image name. The
  image name is also the name of the template, the parameter file (`infra/params/<env>-<image>.bicepparam`)
  and the Dockerfile (`docker/<image>.Dockerfile`).
- **Triggers.** Each runs by `workflow_dispatch` (input: environment) or by its own tag:
  `deploy-infra-*`, `deploy-l1-*`, `deploy-l2-*` or `deploy-l3-*`. Nothing deploys on a merge.
- **One at a time.** All four share the concurrency group `deploy-azure` without cancelling, so two
  deployments never overlap in an environment.
- **Sign-in and GitHub secrets.** Azure sign-in uses OIDC with a federated credential on the
  deploy app registration. The workflows read six repository secrets:
  - `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`: the deploy app's sign-in;
  - `AGENT_API_CLIENT_ID`: the API app's client ID, L1's `AUTH_AUDIENCE`;
  - `SELLER_PAY_TO`, `PAYER_ADDRESS`: public addresses.

  The layer callers pass them with `secrets: inherit`. They are identifiers, kept as secrets so the
  logs mask them. `infra/github-setup.sh` sets them, and creates the GitHub environment, from
  `env/infra.env` (gitignored; template `env/infra.env.example`). It sends nothing if the file holds
  any other key or a value of the wrong shape. No credential is stored in GitHub: the payer key, the CDP key and the service
  tokens live only in the Key Vaults, seeded by hand. T-E2E-AZ reports any other secret, and any
  `azure/login` input other than the three OIDC identifiers.
- **Mixed commits.** Each deployment comes from one commit (FR-023), but the layers can run different
  commits. Every layer run, and every infra run once the layers exist, repeats the cloud regression
  through all of them. That regression is what proves the running combination works.

## Layer steps (`deploy-layer.yml`; any failure stops the run and triggers rollback where noted)

| # | Step | Pass condition |
|---|---|---|
| 1 | `npm install`, `npm run typecheck`, `npm test` | green |
| 2 | Install Bicep CLI 0.47.16, `BICEP_PATH=…`, `npx vitest run test/infra.test.ts` (T-IAC-01, every template) | green, not skipped |
| 3a | The platform exists: the resource group's registry and Log Analytics workspace | found, otherwise "run deploy-infra first" |
| 3 | `docker build -f docker/<image>.Dockerfile` and `docker push` of `x402-<image>:<sha>` (research R14). The build fails when its closure reaches another layer's file or a module doesn't load | pushed |
| 3b | Image secret check: `docker history --no-trunc` and `docker run … env` hold no `PRIVATE_KEY`, `_SECRET` or `_TOKEN` assignment (SC-005) | no match |
| 4 | `az deployment group what-if`, then `create` of `infra/<image>.bicep` with `imageTag=<sha>`. For L1, the agent's current 100% revision is passed as `agentStableRevision`, so the new revision starts at 0% with the label `candidate` | succeeded |
| 5 | L2: start `job-operator` with `ledger-verify` every 15 s until it exits 0. L1 and L3: wait for the latest revision to be `Provisioned` | within 5 min (L2's lock handover, research R12) |
| 5b | From the runner: `npm run payer-balance -- <payer address>`, a read-only `balanceOf` on Base Sepolia USDC. The address is public and no key is involved | balance ≥ 50000 atomic (0.05 test USDC), otherwise fail with "fund the payer" |
| 6 | `az containerapp job start job-regression` (command `node dist/src/main.js --scripted --check-baseline`), then wait for the execution | execution status `Succeeded` (exit 0). `--check-baseline` exits 2 unless the outcomes are `FREE, PAID, PAID, ESCALATED, DENIED, DENIED` with 2 CONFIRMED |
| 7 | `job-operator` → `ledger-verify` | exit 0 (`ok: true`) |
| 8 | Hosted smoke: get a token for the deploy service principal (assigned `Agent.Run` by `infra/entra-app.sh --deploy-sp`), `POST /v1/runs` with the default goal, and time the call. For an L1 run, it goes to the new revision's `candidate` label URL; for L2 and L3, to the agent's live revision | 200, `status: completed`, steps include `/api/weather` and `/api/market-brief` with `outcome: PAID`, settlement `CONFIRMED`; duration ≤ 120 s, written to the job summary (SC-009) |
| 9 | Secret scan: `az monitor log-analytics query` over the container logs since step 4, piped to `npm run scan-logs` (credential-shape patterns from `scripts/secret-scan-lib.ts`: JWTs, `Bearer` values, PEM blocks, `PAYMENT-SIGNATURE`/`x-api-key` values, `*_PRIVATE_KEY=`/`*_SECRET=`/`*_TOKEN=` assignments) | no match. Exact-value completeness is proven offline by T-AGT-05 (research R13) |
| 10 | L1: shift `ca-l1-agent` traffic 100% to the new revision. Every layer: tag `x402-<image>:<sha>` as `x402-<image>:last-good` | done |

**First deployment of L2 or L3** (`first-deployment: true`, offered by `deploy-l2.yml` and
`deploy-l3.yml` only). Before L1 exists there is no `job-regression` and no agent, so steps 5b–8
and 10 are skipped and no `last-good` is recorded. Steps 1–5 and 9 still run. L1 has no such input:
by the time it deploys, the other layers exist, and its first run passes every gate.

## Infra steps (`deploy-infra.yml`)

| # | Step | Pass condition |
|---|---|---|
| 1, 2 | Tests and T-IAC-01, as for a layer | green |
| 3 | `az group create`, then what-if and `create` of `infra/main.bicep` | succeeded |
| 4, 4b | Build, push and secret-check `x402-seller:<sha>` from the root `Dockerfile` | pushed, no match |
| 5 | What-if and `create` of `infra/seller.bicep` (`ca-seller`, `ca-seller-alias`) | succeeded |
| 6 | Both sellers answer `GET /api/catalog` (they scale from zero) | 200 within 3 min each |
| 7–9 | Payer balance, the regression and `ledger-verify`, as for a layer. Each records a skip in the run summary while its job doesn't exist yet (before the layers' first runs) | as for a layer |
| 10 | Secret scan of the container logs since step 3 | no match |
| 11 | Tag `x402-seller:<sha>` as `x402-seller:last-good` | done |

**Platform only** (`platform-only: true`, the very first run). It deploys step 3 and skips 4–11:
the vaults must exist before they can be seeded, and the sellers can't start without their CDP
secrets (quickstart §4).

## Rollback

- **A layer's steps 5–9 fail.** The agent's traffic stays on its previous revision. The workflow
  redeploys only that layer's template at `x402-<image>:last-good` (L1 with the same stable
  revision, so its traffic stays put), then runs `ledger-verify`. Without a `last-good` (the first
  deployment), the run stays red for a human. A failure there also leaves the run red.
- **The infra run's steps 6–10 fail.** The sellers are redeployed at `x402-seller:last-good`. A
  platform change is not rolled back automatically, because there is no previous platform to
  return to; it is fixed forward.
- **Steps 1–4 fail.** Nothing changed in Azure, or what-if showed the change and create failed
  atomically per resource. The run is red. A partial create is fixed forward by rerunning.

## What each deployment proves (FR-024, SC-001, SC-005)

- **The pinned baseline.** The scripted plan exercises the deployed L2, L3, seller, CDP
  facilitator and Base Sepolia, and gets the pinned outcomes.
- **The chain.** It still verifies, including after L2's lock handover.
- **The agent's path.** The hosted agent's HTTP, auth, model and tools path works with a service
  identity.
- **No leaks.** No secret reached the logs.

## Cost guard

Each run with the regression spends 0.006 USDC of testnet funds, and a layer run about 0.006 more for
the smoke. The balance step checks that the payer holds at least 0.05 test USDC first.
`scripts/payer-balance.ts` is a read-only command. It uses viem's public client, takes the address as
an argument and reads no env file.
