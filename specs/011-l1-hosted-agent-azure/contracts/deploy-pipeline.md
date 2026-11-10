# Contract: deployment and post-deployment regression (proposed T-E2E-AZ)

One pipeline per unit deploys the Azure profile (revised 2026-11-04: before that one workflow,
`deploy.yml`, deployed everything from one commit; before that a platform pipeline and one per layer,
and first one workflow, `deploy-azure.yml`). Each pipeline deploys one unit of `infra/main.bicep`, the
`unit` parameter, and leaves the others as they are:

| Pipeline | Tag | Unit | Image | Dockerfile | Runs in |
|---|---|---|---|---|---|
| `deploy-infra.yml` | `deploy-infra-*` | `platform` | — | — | the network, logs, identities, registry, vaults, storage, Foundry, both environments |
| `deploy-seller.yml` | `deploy-seller-*` | `seller` | `x402-seller` | `Dockerfile` (root) | `ca-seller-eastus2-dev`, `ca-seller-alias-eastus2-dev` |
| `deploy-l3.yml` | `deploy-l3-*` | `l3` | `x402-l3-verifier` | `docker/l3-verifier.Dockerfile` | `ca-l3-eastus2-dev` |
| `deploy-operator.yml` | `deploy-operator-*` | `operator` | `x402-operator` | `docker/operator.Dockerfile` | `caj-l2-eastus2-dev` |
| `deploy-l2.yml` | `deploy-l2-*` | `l2` | `x402-l2-control` | `docker/l2-control.Dockerfile` | `ca-l2-eastus2-dev` |
| `deploy-l1.yml` | `deploy-l1-*` | `l1` | `x402-l1-agent` | `docker/l1-agent.Dockerfile` | `ca-l1-eastus2-dev`, `caj-l1-eastus2-dev` |

The rows are in first-deployment order (quickstart §4).

- **One set of steps.** Each pipeline holds only its triggers, its inputs and the concurrency group,
  and calls the reusable `.github/workflows/deploy.yml` with its unit. `deploy.yml` has every step
  below; it runs only when a pipeline calls it (`workflow_call`), and holds no concurrency group of its
  own, because a called workflow sharing its caller's group deadlocks. The job runs in the GitHub
  environment named like the deploy environment.
- **Bicep only.** Azure is provisioned by `infra/pre-deploy.bicep` (once, by an administrator, before
  the first run) and `infra/main.bicep` (by the pipelines). Every `az` command the workflows run is a
  Bicep deployment, previewed with what-if first, or a read, a job start or an image copy. Even the
  agent's traffic moves through `main.bicep`. T-E2E-AZ reports any other provisioning `az` command, in
  the workflows or in the only two scripts `infra/` holds, `github-setup.sh` and `cleanup.sh` (revised
  2026-11-03: the name list, the parameter reader and the job runner are gone).
- **One unit per deployment.** `deploy.yml` sets `UNIT`, which the parameter file passes to
  `main.bicep` as `unit`. Each module of `main.bicep` is deployed only when `unit` is its unit's: the
  platform's modules for `platform`, each unit's apps for that unit (T-IAC-01 rule 18). ARM's
  incremental mode leaves everything a deployment doesn't name as it is, so a unit's run changes no
  other unit's apps and no part of the platform.
- **Triggers.** Each pipeline runs by hand (`workflow_dispatch`, inputs: environment, plus
  `first-deployment` for every pipeline but L1's, and `seed-ip` and `recover-vaults` for the
  platform's) or on its own tag, `deploy-<unit>-*` (`deploy-infra-*` for the platform). Nothing deploys
  on a merge.
- **One at a time.** All six pipelines hold the concurrency group `deploy-azure`, without cancelling,
  so two deployments never overlap in an environment: every run's checks go through all the units, and
  a unit mid-rollout would fail another's. GitHub keeps one pending run per group and cancels it when a
  third is queued, so start the pipelines one after another.
- **Sign-in, target and names.** No GitHub secret or variable (SPEC v1.9: only `provision-auth0.yml`, the Auth0
  tenant's pipeline, reads secrets, from its own GitHub environment `auth0-<env>`; T-IAC-02). The job runs in the GitHub environment
  named like the deploy environment (`environment: dev`), which `infra/github-setup.sh` creates. The
  pinned Bicep CLI compiles `infra/main.<environment>.bicepparam`, and the workflow reads from it the
  deploy app's client ID, the tenant, the subscription, the API app's client ID (`authAudience`), the
  payer's address and every resource name it uses (`names`): it names no resource itself. It signs in
  with OIDC (`id-token: write`, granted by the pipeline): the deploy app's federated credential trusts
  only GitHub's immutable subject
  `repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>:environment:<githubEnvironment>` (revised
  2026-11-04: the repository signs its jobs with its owner's and its own IDs, and a subject without
  them fails with AADSTS700213). A called workflow's job gets the same subject as any other job in the
  environment, so the six pipelines need no other credential. `infra/github-setup.sh` refuses to set
  anything up when the two differ. `main.bicep` fails validation anywhere but the parameter file's
  tenant, subscription and resource group. No credential is stored in GitHub: the payer key, the CDP
  key and the service tokens live only in the Key Vaults, seeded by hand.
- **Signed in in each step** (revised 2026-11-04). GitHub's OIDC token is valid for 5 minutes, and az
  can't renew it: after a single `azure/login`, the first token request past that (the registry's, after
  the platform's 17-minute first deployment) failed with AADSTS700024. So there is no `azure/login`:
  every step that calls Azure starts with `eval "$SIGN_IN"`, which asks GitHub for a fresh token
  (audience `api://AzureADTokenExchange`), clears the CLI's cached tokens (`az account clear`, so the
  step's own Azure tokens last the step), and signs in as the deploy app (`az login --service-principal
  --federated-token`, then `az account set`) with the client ID, tenant and subscription step 0 read.
  The token request retries a transient answer (a timeout, 429 or 5xx; `curl --retry 5`, at most 30 s
  an attempt and 120 s in all), and a 401 or 403 still fails at once (revised 2026-11-06: a run signs
  in up to nine times, and one 503 from GitHub's token endpoint failed run 42158206985 before it built
  anything). T-E2E-AZ runs the request against a local endpoint that answers 503 once.
- **Per-run values.** The workflow sets the only parameters a parameter file may read from the
  environment: `UNIT`, `IMAGE_TAG` (the commit, or `last-good`), `SEED_IP`, `RECOVER_VAULTS` and
  `AGENT_STABLE_REVISION`.
- **One Bicep CLI.** Step 0 puts the pinned CLI (0.47.16) first on `PATH` and in `BICEP_PATH`, so the
  tests and every deployment compile with the version T-IAC-01 checked.
- **Pipes fail.** Every step runs with `bash -eo pipefail` (`defaults.run.shell: bash`), so a gate fed
  by a pipe (the log scan) fails when the command before the pipe does, never passing on empty input.
- **Jobs run their own command.** `run_job` (the workflow's `RUN_JOB`) starts a job without an
  override, waits for the execution and prints its logs. The operator job's own command is
  `ledger-verify`, so the deploy identity never runs `approve` or `reject` (T-E2E-AZ, T-IAC-01 rule 12).

## Steps of `deploy.yml` (any failure stops the run and triggers rollback where noted)

| # | Step | Runs | Pass condition |
|---|---|---|---|
| 0 | Right after the checkout. First it maps the unit to its image and Dockerfile (the table above) and refuses, before it downloads or deploys anything: an unknown unit; `seed-ip` or `recover-vaults` on a unit (they are the platform's); `recover-vaults` without `first-deployment` (it follows `infra/cleanup.sh`, so the units are gone); a first deployment of L1 (L1 runs last, through every check). The inputs come in as `INPUT_*`, never pasted into the script. Then Bicep CLI 0.47.16, first on `PATH` and in `BICEP_PATH`; it compiles `infra/main.<environment>.bicepparam`, and the step reads `tenantId`, `subscriptionId` and `deployClientId` (for `SIGN_IN`), `authAudience`, `payerAddress` and the names the steps use (`RG`, `CR_X402`, `LOG_X402`, `CA_L1`, `CA_L3`, `CA_SELLER`, `CA_SELLER_ALIAS`, `CAJ_L1`, `CAJ_L2`) | always | no refused inputs; every value read |
| 1 | `npm install`, `npm run typecheck`, `npm test`, with T-IAC-01 (`BICEP_PATH` is set) | always | green, nothing skipped |
| — | Every step below that calls Azure (2, 3–4, 6–10, rollback) first signs in (`SIGN_IN`): a fresh GitHub OIDC token, the client ID, tenant and subscription from step 0 | | signed in |
| 2 | `docker build` and `docker push` of the unit's image, `x402-<image>:<sha>` (research R14). A build fails when its closure reaches another unit's file or a module doesn't load | units | pushed |
| 2b | Image secret check: `docker history --no-trunc` and `docker run … env` hold no `PRIVATE_KEY`, `_SECRET` or `_TOKEN` assignment (SC-005) | units | no match |
| 3 | `az deployment group what-if`, then `create` of `main.bicep` with `UNIT` (and, on the platform, `SEED_IP` and `RECOVER_VAULTS` from the inputs), `imageTag=<sha>`. On L1, the agent's current 100% revision is passed as `agentStableRevision`, so the new revision starts at 0% with the label `candidate` | always | succeeded |
| 4 | Wait. After the platform or L2: start `caj-l2-eastus2-dev` (its own command, `ledger-verify`) every 15 s until it exits 0 (L2's lock handover, research R12). After L1 or L3: its latest revision `Provisioned`. Always: both sellers answer `GET /api/catalog` (they scale from zero) | units; the platform unless first deployment | within 5 min, sellers within 3 min |
| 5 | From the runner: `npm run payer-balance -- <payerAddress>`, a read-only `balanceOf` on Base Sepolia USDC. The address is public and no key is involved | unless first deployment | balance ≥ 50000 atomic (0.05 test USDC), otherwise fail with "fund the payer" |
| 6 | `run_job` starts `caj-l1-eastus2-dev` (its own command, `node dist/src/main.js --scripted --check-baseline`) and waits for the execution | unless first deployment | execution status `Succeeded` (exit 0). `--check-baseline` exits 2 unless the outcomes are `FREE, PAID, PAID, ESCALATED, DENIED, DENIED` with 2 CONFIRMED |
| 7 | `run_job` starts `caj-l2-eastus2-dev` → `ledger-verify` (on the operator's run, its new image) | unless first deployment | exit 0 (`ok: true`) |
| 8 | Hosted smoke: a token for the deploy app (`Agent.Run`, from `pre-deploy.bicep`) for the API app's client ID (`authAudience`, the audience the agent accepts), `POST /v1/runs` with the default goal to the agent; on L1, to the new revision's `candidate` label URL (or the agent, on its first deployment), timed | unless first deployment | 200, `status: completed`, steps include `/api/weather` and `/api/market-brief` with `outcome: PAID`, settlement `CONFIRMED`; duration ≤ 120 s, written to the job summary (SC-009) |
| 9 | Secret scan: `az monitor log-analytics query` over the container logs since step 3, piped to `npm run scan-logs` (credential-shape patterns from `scripts/secret-scan-lib.ts`: JWTs, `Bearer` values, PEM blocks, `PAYMENT-SIGNATURE`/`x-api-key` values, `*_PRIVATE_KEY=`/`*_SECRET=`/`*_TOKEN=` assignments) | unless first deployment | no match. Exact-value completeness is proven offline by T-AGT-05 (research R13) |
| 10 | Promote. On L1, `main.bicep` again without a stable revision, so the agent's latest revision gets 100% of the traffic; then `az acr import` tags the unit's image `last-good` | units, unless first deployment | done |

**First deployment** (`first-deployment: true`, a new environment; quickstart §4). The units are
deployed in the table's order, so when a unit's first run comes, the units after it don't exist yet:
the run deploys the unit and waits for it (steps 0–4), but skips the checks through the other units
(5–9) and promotes nothing (10), so the unit has no `last-good` until a later run without
`first-deployment` passes the checks. The run's summary says it is unverified. The platform's first
runs skip the wait too. L1, deployed last, has no first deployment: its first run passes every check
through every unit.

**The platform** (`deploy-infra.yml`). It has no image, so steps 2, 2b and 10 are skipped and it has
no rollback. Once the units exist, the run checks them through the new platform (steps 4–9). `seed-ip`
opens the vaults to an operator's IP for the seeding; only the platform's runs change the vault
firewalls, so the next platform run without it closes them again. `recover-vaults` (with
`first-deployment`, after `infra/cleanup.sh`) makes Bicep recover the soft-deleted vaults, secrets
included, instead of creating them. A unit's run refuses both at step 0 and deploys nothing (revised
2026-11-04: a run with `seed-ip` set went on to build the images).

## Rollback

- **A unit: step 3 or any later step fails** (revised 2026-11-03: a step 3 that failed partway is
  rolled back too, because the single-revision apps may already run the new image). The agent's
  traffic stays on its previous revision. The workflow redeploys `main.bicep` with the same `UNIT`, the
  unit's image at `last-good` and the same stable revision, so only that unit changes and the agent's
  traffic stays put, then runs `ledger-verify`. Without a `last-good` for the unit's image (a unit that
  hasn't passed the checks yet), the run stays red for a human.
- **The platform** is not rolled back automatically, because there is no previous platform to return
  to; it is fixed forward.
- **Steps 0–2b fail** otherwise. Nothing changed in the apps. The run is red; a partial platform
  create is fixed forward by rerunning.

## What each deployment proves (FR-024, SC-001, SC-005)

- **The pinned baseline.** The scripted plan exercises the deployed L2, L3, seller, CDP
  facilitator and Base Sepolia, and gets the pinned outcomes, whichever unit changed.
- **The chain.** It still verifies, including after L2's lock handover.
- **The agent's path.** The hosted agent's HTTP, auth, model and tools path works with a service
  identity.
- **No leaks.** No secret reached the logs.

## Cost guard

Each checked run spends about 0.012 USDC of testnet funds: 0.006 for the regression and about 0.006
for the smoke, whichever the unit; a first deployment spends nothing. The balance step checks that the
payer holds at least 0.05 test USDC first. `scripts/payer-balance.ts` is a read-only command. It uses
viem's public client, takes the address as an argument and reads no env file.
