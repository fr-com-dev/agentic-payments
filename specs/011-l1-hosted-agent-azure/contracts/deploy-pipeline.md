# Contract: deployment and post-deployment regression (proposed T-E2E-AZ)

One workflow, `.github/workflows/deploy.yml`, deploys the Azure profile from one commit (revised
2026-11-02; before that a platform pipeline and one pipeline per layer, and first one workflow,
`deploy-azure.yml`). It deploys `infra/main.bicep`: the platform, then every unit's apps, each unit on
its own image.

| Image | Dockerfile | Runs in |
|---|---|---|
| `x402-l1-agent` | `docker/l1-agent.Dockerfile` | `ca-l1-eastus2-dev`, `caj-l1-eastus2-dev` |
| `x402-l2-control` | `docker/l2-control.Dockerfile` | `ca-l2-eastus2-dev`, `caj-l2-eastus2-dev` |
| `x402-l3-verifier` | `docker/l3-verifier.Dockerfile` | `ca-l3-eastus2-dev` |
| `x402-seller` | `Dockerfile` (root) | `ca-seller-eastus2-dev`, `ca-seller-alias-eastus2-dev` |

- **Bicep only.** Azure is provisioned by `infra/pre-deploy.bicep` (once, by an administrator, before
  the first run) and `infra/main.bicep` (by this workflow). Every `az` command the workflow runs is a
  Bicep deployment, previewed with what-if first, or a read, a job start or an image copy. Even the
  agent's traffic moves through `main.bicep`. T-E2E-AZ reports any other provisioning `az` command, in
  the workflow or in the only two scripts `infra/` holds, `github-setup.sh` and `cleanup.sh` (revised
  2026-11-03: the name list, the parameter reader and the job runner are gone).
- **Triggers.** `workflow_dispatch` (inputs: environment, `platform-only`, `seed-ip`, `recover-vaults`)
  or a `deploy-*` tag. Nothing deploys on a merge.
- **One at a time.** The concurrency group `deploy-azure`, without cancelling, so two deployments never
  overlap in an environment.
- **Sign-in, target and names.** No GitHub secret or variable. The job runs in the GitHub environment
  named like the deploy environment (`environment: dev`), which `infra/github-setup.sh` creates. The
  pinned Bicep CLI compiles `infra/main.<environment>.bicepparam`, and the workflow reads from it the
  deploy app's client ID, the tenant, the subscription, the API app's client ID (`authAudience`), the
  payer's address and every resource name it uses (`names`): it names no resource itself. It signs in
  with OIDC
  (`id-token: write`): the deploy app's federated credential trusts only
  `repo:<githubRepository>:environment:<githubEnvironment>`. `main.bicep` fails validation anywhere
  but the parameter file's tenant, subscription and resource group. No credential is stored in
  GitHub: the payer key, the CDP key and the service tokens live only in the Key Vaults, seeded by hand.
- **Per-run values.** The workflow sets the only parameters a parameter file may read from the
  environment: `IMAGE_TAG` (the commit, or `last-good`), `PLATFORM_ONLY`, `SEED_IP`,
  `RECOVER_VAULTS` and `AGENT_STABLE_REVISION`.
- **One Bicep CLI.** Step 0 puts the pinned CLI (0.47.16) first on `PATH` and in `BICEP_PATH`, so the
  tests and every deployment compile with the version T-IAC-01 checked.
- **Pipes fail.** Every step runs with `bash -eo pipefail` (`defaults.run.shell: bash`), so a gate fed
  by a pipe (the log scan) fails when the command before the pipe does, never passing on empty input.
- **Jobs run their own command.** `run_job` (the workflow's `RUN_JOB`) starts a job without an
  override, waits for the execution and prints its logs. The operator job's own command is
  `ledger-verify`, so the deploy identity never runs `approve` or `reject` (T-E2E-AZ, T-IAC-01 rule 12).

## Steps (any failure stops the run and triggers rollback where noted)

| # | Step | Pass condition |
|---|---|---|
| 0 | Right after the checkout: Bicep CLI 0.47.16, first on `PATH` and in `BICEP_PATH`; it compiles `infra/main.<environment>.bicepparam`, and the step reads `tenantId`, `subscriptionId`, `deployClientId`, `authAudience`, `payerAddress` and the names the steps use (`RG`, `CR_X402`, `LOG_X402`, `CA_L1`, `CA_L3`, `CA_SELLER`, `CA_SELLER_ALIAS`, `CAJ_L1`, `CAJ_L2`) | every value read |
| 1 | `npm install`, `npm run typecheck`, `npm test`, with T-IAC-01 (`BICEP_PATH` is set) | green, nothing skipped |
| — | `azure/login` with OIDC: client ID, tenant and subscription from step 0 | signed in |
| 2 | `az deployment group what-if`, then `create` of `main.bicep` with `PLATFORM_ONLY=true` (and `SEED_IP`, `RECOVER_VAULTS` from the inputs): the platform, without any app | succeeded |
| 3 | `docker build` and `docker push` of the four images, `x402-<image>:<sha>` (research R14). A build fails when its closure reaches another layer's file or a module doesn't load | pushed |
| 3b | Image secret check: `docker history --no-trunc` and `docker run … env` hold no `PRIVATE_KEY`, `_SECRET` or `_TOKEN` assignment (SC-005) | no match |
| 4 | what-if, then `create` of the whole `main.bicep` with `imageTag=<sha>`. The agent's current 100% revision is passed as `agentStableRevision`, so the new revision starts at 0% with the label `candidate` | succeeded |
| 5 | Wait: start `caj-l2-eastus2-dev` (its own command, `ledger-verify`) every 15 s until it exits 0 (L2's lock handover, research R12); the latest revisions of the agent and L3 `Provisioned`; both sellers answer `GET /api/catalog` (they scale from zero) | within 5 min, sellers within 3 min |
| 6 | From the runner: `npm run payer-balance -- <payerAddress>`, a read-only `balanceOf` on Base Sepolia USDC. The address is public and no key is involved | balance ≥ 50000 atomic (0.05 test USDC), otherwise fail with "fund the payer" |
| 7 | `run_job` starts `caj-l1-eastus2-dev` (its own command, `node dist/src/main.js --scripted --check-baseline`) and waits for the execution | execution status `Succeeded` (exit 0). `--check-baseline` exits 2 unless the outcomes are `FREE, PAID, PAID, ESCALATED, DENIED, DENIED` with 2 CONFIRMED |
| 8 | `run_job` starts `caj-l2-eastus2-dev` → `ledger-verify` | exit 0 (`ok: true`) |
| 9 | Hosted smoke: a token for the deploy app (`Agent.Run`, from `pre-deploy.bicep`) for the API app's client ID (`authAudience`, the audience the agent accepts), `POST /v1/runs` with the default goal to the new revision's `candidate` label URL (or the agent, on its first deployment), timed | 200, `status: completed`, steps include `/api/weather` and `/api/market-brief` with `outcome: PAID`, settlement `CONFIRMED`; duration ≤ 120 s, written to the job summary (SC-009) |
| 10 | Secret scan: `az monitor log-analytics query` over the container logs since step 2, piped to `npm run scan-logs` (credential-shape patterns from `scripts/secret-scan-lib.ts`: JWTs, `Bearer` values, PEM blocks, `PAYMENT-SIGNATURE`/`x-api-key` values, `*_PRIVATE_KEY=`/`*_SECRET=`/`*_TOKEN=` assignments) | no match. Exact-value completeness is proven offline by T-AGT-05 (research R13) |
| 11 | Promote: `main.bicep` again without a stable revision, so the agent's latest revision gets 100% of the traffic; then `az acr import` tags each of the four images `last-good` | done |

**Platform only** (`platform-only: true`, the very first run). It deploys step 2 and skips 3–11: the
vaults must exist before they can be seeded, and the apps can't start without their secrets
(quickstart §4). `seed-ip` opens the vaults to an operator's IP for the seeding; the next run without
it closes them again. `recover-vaults` (with `platform-only`, after `infra/cleanup.sh`) makes Bicep
recover the soft-deleted vaults, secrets included, instead of creating them.

## Rollback

- **Step 4 or any later step fails** (revised 2026-11-03: a step 4 that failed partway is rolled back
  too, because the single-revision apps may already run the new images). The agent's traffic stays on
  its previous revision. The workflow redeploys `main.bicep` with every image at `last-good` and the
  same stable revision, so the agent's traffic stays put, then runs `ledger-verify`. Without a
  `last-good` for every image (the first full run), the run stays red for a human.
- **A platform change** (step 2) is not rolled back automatically, because there is no previous
  platform to return to; it is fixed forward.
- **Steps 0–3b fail** otherwise. Nothing changed in the apps. The run is red; a partial platform
  create is fixed forward by rerunning.

## What each deployment proves (FR-024, SC-001, SC-005)

- **The pinned baseline.** The scripted plan exercises the deployed L2, L3, seller, CDP
  facilitator and Base Sepolia, and gets the pinned outcomes.
- **The chain.** It still verifies, including after L2's lock handover.
- **The agent's path.** The hosted agent's HTTP, auth, model and tools path works with a service
  identity.
- **No leaks.** No secret reached the logs.

## Cost guard

Each full run spends about 0.012 USDC of testnet funds: 0.006 for the regression and about 0.006 for
the smoke. The balance step checks that the payer holds at least 0.05 test USDC first.
`scripts/payer-balance.ts` is a read-only command. It uses viem's public client, takes the address as
an argument and reads no env file.
