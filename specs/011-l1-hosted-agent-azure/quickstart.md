# Quickstart: validating the cloud-hosted agent

This guide proves feature 011 works, offline first and then in Azure. It refers to the contracts
rather than repeating them:
- [hosted-agent-api](contracts/hosted-agent-api.md)
- [access-and-sessions](contracts/access-and-sessions.md)
- [model-access](contracts/model-access.md)
- [ledger-lock](contracts/ledger-lock.md)
- [cloud-topology](contracts/cloud-topology.md)
- [deploy-pipeline](contracts/deploy-pipeline.md)

## 1. Offline gates (no network, no keys, no Azure)

```bash
npm install
npm run typecheck
npx vitest run test/hosted-agent.test.ts test/hosted-access.test.ts test/hosted-sessions.test.ts test/hosted-run.test.ts   # T-AGT-02..05
npx vitest run test/deploy-workflow.test.ts test/github-setup.test.ts test/cleanup.test.ts   # T-E2E-AZ static checks: the six pipelines, deploy.yml and the infra scripts
npx vitest run test/images.test.ts            # T-IMG-01: each image holds only its own unit's code and packages
npx vitest run test/agent.test.ts -t "T-AGT-KEY"   # both L1 entry points refuse the payer key
npx vitest run test/ledger-lock.test.ts       # T-LED-05, including the must-fail two-writer case
npx vitest run test/e2e.local.test.ts -t "T-E2E-09"   # hosted agent on the in-process harness: escalate → approve → continue session
npx vitest run test/architecture.test.ts      # A1, T-ARCH-ENV (l1-hosted template), T-ARCH-TRACE (SEC-14..16)
npm run check                                 # typecheck + all tests + demo:local
```

**Expected**:
- every test passes;
- T-IAC-01 and the `infra/cleanup.sh` and `infra/github-setup.sh` tests are skipped unless `BICEP_PATH`
  names the Bicep CLI (section 2): only Bicep reads a parameter file;
- `npm run check` ends with `spent on-chain: 0.006 USDC` and `hash chain ok=true`, with outcomes
  unchanged.

## 2. Infrastructure checks without deploying

```bash
az bicep install && export BICEP_PATH="$HOME/.azure/bin/bicep"   # Bicep CLI 0.47.16
npx vitest run test/infra.test.ts             # T-IAC-01: rules 1–18 on main.bicep, pre-deploy.bicep and their parameter files, plus 25 must-fail mutant tests
# Preview against Azure (reads only). Graph resources aren't previewed; main.bicep needs pre-deploy's resource group,
# and a unit's preview needs the platform deployed (its apps look the platform up by name).
# v prints one value of a parameter file, as Bicep compiles it.
v() { az bicep build-params -f "$1" --stdout --only-show-errors | jq -r --arg p "$2" '.parametersJson | fromjson | .parameters | map_values(.value) | getpath($p | split("."))'; }
P=infra/pre-deploy.dev.bicepparam; M=infra/main.dev.bicepparam
az deployment sub what-if -n pre-deploy-dev -p $P --subscription "$(v $P subscriptionId)" -l "$(v $P location)"
for unit in platform seller l3 operator l2 l1; do   # what each pipeline would deploy (main.bicep with UNIT)
  UNIT=$unit az deployment group what-if -p $M --subscription "$(v $M subscriptionId)" -g "$(v $M names.resourceGroup)"
done
# One image per unit (research R14). Each build fails if its closure reaches another unit's code.
docker build -f docker/l1-agent.Dockerfile -t x402-l1-agent:dev .
docker build -f docker/l2-control.Dockerfile -t x402-l2-control:dev .
docker build -f docker/l3-verifier.Dockerfile -t x402-l3-verifier:dev .
docker build -f docker/operator.Dockerfile -t x402-operator:dev .
docker build -t x402-seller:dev .
docker run --rm x402-l1-agent:dev sh -c 'ls dist/src/hosted-main.js && test ! -e dist/src/layer2-control && test ! -e env'
docker run --rm x402-l3-verifier:dev sh -c 'test ! -e dist/src/layer2-control/signer.js && test ! -e node_modules/@mastra'
docker run --rm x402-operator:dev sh -c 'ls dist/scripts/ledger-verify.js && test ! -e dist/src/layer2-control'
for i in l1-agent l2-control l3-verifier operator seller; do
  docker history --no-trunc x402-$i:dev | grep -E 'PRIVATE_KEY|_SECRET=|_TOKEN=' && echo "LEAK in $i" || echo "$i clean"   # SC-005
done
```

## 3. The hosted agent locally (against the local stack)

```bash
npm run stack:local                 # terminal 1: chain, facilitator, seller, L2, L3 (local dev keys); Ctrl-C stops them
cp env/l1-hosted.env.example env/l1-hosted.env   # NETWORK=local, MODEL_PROVIDER=anthropic, ANTHROPIC_API_KEY, SESSION_REF_SECRET
npm run dev-token -- --subject alice > .local/alice.jwt
npm run agent:hosted                # listens on 127.0.0.1:4024
curl -s -H "Authorization: Bearer $(cat .local/alice.jwt)" -H 'content-type: application/json' \
  -d '{"goal":"Get today'"'"'s weather for Lima and a short market brief"}' http://127.0.0.1:4024/v1/runs | jq '.status, [.steps[].result.outcome]'
```

**Expected**: `"completed"`, and outcomes include `FREE`, then `PAID` twice. Also check:
- no token → 401;
- `npm run dev-token -- --no-role` → 403;
- a third concurrent run from the same subject → 429;
- the `sessionRef` from the first answer works for `alice` but returns 404 with bob's token;
- `PAYER_PRIVATE_KEY=0x… npm run agent:hosted` exits 1 with the refusal. It also exits 1 when the
  key is only inside `env/l1-hosted.env`.

**Escalation and continuation (US5)**:
1. Ask for the premium report. The step shows `ESCALATED` with an `authorizationId`.
2. Run `npm run approve -- <authorizationId>`.
3. Repeat the request with `"sessionRef": "<from step 1>"`. The step is `PAID`, `CONFIRMED`.

**The same L1 image as Azure** (Docker Desktop). A container reaches the host at `host.docker.internal`,
and L2 only pays sellers whose host its mandate lists (R6), so start the stack with `--docker`:

```bash
npm run stack:local -- --docker     # L2 also allows host.docker.internal:4021
docker build -f docker/l1-agent.Dockerfile -t x402-l1-agent:dev .
docker run --rm -p 127.0.0.1:4024:4024 --env-file env/l1-hosted.env \
  -e AGENT_BIND_HOST=0.0.0.0 -e SELLER_URL=http://host.docker.internal:4021 \
  -e CONTROL_URL=http://host.docker.internal:4020 -e SETTLEMENT_URL=http://host.docker.internal:4023 \
  -v "$PWD/.local/dev-issuer/jwks.json:/app/.local/dev-issuer/jwks.json:ro" \
  x402-l1-agent:dev node dist/src/hosted-main.js
```

The same `curl` then works against `127.0.0.1:4024`. Two cloud pieces stay cloud-only: Foundry signs in with
the agent's managed identity, so locally use `MODEL_PROVIDER=anthropic`; and the local dev issuer stands in
for Entra ID.

## 4. First Azure deployment (once per subscription)

**Prerequisites**:
- a pay-as-you-go subscription (Foundry Claude excludes CSP, free and credit-only subscriptions);
- the `Microsoft.App` and `Microsoft.CognitiveServices` providers registered;
- a payer funded with test USDC (faucet.circle.com);
- a production CDP key for the seller;
- an administrator who can create app registrations and groups in the tenant, and role assignments in
  the subscription (Owner or User Access Administrator);
- `infra/pre-deploy.dev.bicepparam` and `infra/main.dev.bicepparam` filled in: the target (tenant,
  subscription, location), every resource name (`names`), the GitHub repository, `agentUsers` and
  `operators`, the seller's and payer's public addresses, and the Claude attestation (organization,
  country, industry). Deploying the model accepts Anthropic's Azure Marketplace terms with those
  values. No secret goes in either file.

0. **Pre-deploy, by hand.** Preview, then deploy `pre-deploy.bicep`:

   ```bash
   P=infra/pre-deploy.dev.bicepparam
   v() { az bicep build-params -f "$1" --stdout --only-show-errors | jq -r --arg p "$2" '.parametersJson | fromjson | .parameters | map_values(.value) | getpath($p | split("."))'; }
   SUB=$(v $P subscriptionId); LOC=$(v $P location)
   az deployment sub what-if -n pre-deploy-dev -l "$LOC" --subscription "$SUB" -p $P
   az deployment sub create -n pre-deploy-dev -l "$LOC" --subscription "$SUB" -p $P \
     --query properties.outputs.mainParameters.value -o tsv
   ```

   It creates the resource group; the API app `app-l1-eastus2-dev` (`Agent.Run`, `user_impersonation`
   with the Azure CLI pre-authorized, assignment required); the deploy app `app-deploy-eastus2-dev`,
   with a federated credential for this repository's `dev` environment and no secret; `Agent.Run` for
   the deploy app (the smoke check) and `agentUsers`; the operators' group `grp-op-eastus2-dev`; and the
   deploy app's roles on the resource group. what-if previews only the resource group: the Graph
   resources and their role assignments can't be previewed. Copy the three `param` lines it prints (the
   deploy app's client ID, `authAudience` and `operatorsGroupId`) into `main.dev.bicepparam`. Run
   against another subscription or tenant than the file names, it fails validation and creates nothing.
1. **GitHub environment.** Run `infra/github-setup.sh` (`--dry-run` first). It first checks that GitHub
   signs this repository's jobs with the subject the federated credential trusts (the owner's and
   repository's IDs, `githubOwnerId` and `githubRepositoryId`), then creates the `dev`
   environment the pipelines run in, and sets no secret: they read every value from
   `main.dev.bicepparam`.
2. **Create the platform.** Run `deploy-infra` with `environment=dev`, `first-deployment: true` and
   `seed-ip` set to your public IP. It creates the network, identities, registry, the five vaults (open
   to your IP), storage, Foundry with the `claude-sonnet-5-5` deployment, and both environments. A
   unit's pipeline refuses `seed-ip` at its first step and deploys nothing.
3. **Seed the vaults.** Put the secrets in, following [cloud-topology](contracts/cloud-topology.md),
   with `az keyvault secret set` from a trusted shell. This is data, not provisioning: the secrets
   never appear in a template, a parameter file or GitHub.
4. **Close the vaults.** Run `deploy-infra` again with `first-deployment: true` and no `seed-ip`. Only
   the platform's runs change the vault firewalls, so this is the run that removes your IP.
5. **Deploy the units, one run after another** (the pipelines share one concurrency group, and GitHub
   cancels a second pending run), each with `first-deployment: true`: `deploy-seller`, `deploy-l3`,
   `deploy-operator`, then `deploy-l2`. Each builds its own image, deploys its own apps and waits for
   them (L2's wait runs the operator job, hence the operator first), but skips the checks through units
   not deployed yet and promotes nothing.
6. **Deploy L1.** Run `deploy-l1`, which has no first deployment. It builds the agent's image, deploys
   the agent and the regression job, and passes every gate of the
   [deploy-pipeline](contracts/deploy-pipeline.md): the regression, the chain check, the smoke check
   and the log scan, through every unit. The agent's traffic ends on its new revision, and
   `x402-l1-agent` is tagged `last-good`.
7. **Verify the other units.** Run `deploy-seller`, `deploy-l3`, `deploy-operator` and `deploy-l2`
   once more without `first-deployment`. Each image is tagged `last-good` once its run passes the
   gates; until then, a failed run of that unit has nothing to roll back to and stays red for a human.
8. **Time it.** Record the minutes from step 0 to the green run of step 6 (SC-008: under 60), and later
   the minutes per redeploy of one unit (under 15).

Then check the platform facts the research could not confirm:

| Check | How | Expected |
|---|---|---|
| Foundry accepts the provider's `anthropic-beta` header | the hosted smoke check (deploy.yml step 8) succeeds; otherwise the 400 names the header | 200. If it fails, enable header stripping in the Foundry `fetch` (research R2) |
| Lifecycle `None` blocks tokens inside L2 | `az containerapp exec -n ca-l2-eastus2-dev --container proxy -- sh -c 'wget -qO- "$IDENTITY_ENDPOINT?resource=https://vault.azure.net&api-version=2019-08-01" -H "X-IDENTITY-HEADER: $IDENTITY_HEADER"'` | fails: no endpoint or an error. Key Vault references still resolve, because L2 started |
| Internal http calls aren't redirected | regression step 6 passes over `http://ca-l2-eastus2-dev.internal…` | no 301 to https |
| Key Vault references resolve through the VNet rule (firewall default Deny) | all apps start and `ledger-verify` passes | no `secret reference` errors in the revision status |
| Exclusive create on the NFS share | during a `deploy-l2` run (step 4, the wait), the L2 log shows `ledger locked … waiting` in the revision overlap, then a clean start | one writer; the chain verifies |
| L2/L3 are private | from your machine: `curl -m 5 https://ca-l2-eastus2-dev.<env-domain>/v1/escalations` | 404 from the environment proxy, or no route; never 401 from L2 |
| A person can get a token and run the agent | "Calling the agent as a person" below | 200. A consent error (AADSTS65001) means the Azure CLI isn't pre-authorized; 401 means `AUTH_AUDIENCE` isn't the client ID |

**Calling the agent as a person** (listed in `agentUsers`, so assigned `Agent.Run`):

```bash
TOKEN=$(az account get-access-token --scope api://app-l1-eastus2-dev/user_impersonation --query accessToken -o tsv)
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"goal":"Get the weather for Lima"}' https://<agent fqdn>/v1/runs | jq '.status, [.steps[].result.outcome]'
```

## 5. Operator flow in Azure

```bash
az containerapp job start -n caj-l2-eastus2-dev -g rg-x402-eastus2-dev --container-name operator --image <acr>/x402-operator:<sha> \
  --command node --args dist/scripts/escalations.js --env-vars OPERATOR_TOKEN=secretref:operator-token CONTROL_URL=http://ca-l2-eastus2-dev.internal.<env-domain>
az containerapp job logs show -n caj-l2-eastus2-dev -g rg-x402-eastus2-dev --follow
```

To approve, run the same command with `--args dist/scripts/approve.js <authorizationId>`. A start
without `--command` runs the job's own command, `ledger-verify`. Only members of the operators' group
(and the deploy identity, which the pipelines use for `ledger-verify` only) can start the job. The job
runs the operator's own image, `x402-operator`, which `deploy-operator` builds: only the operator
scripts, no L2 code.

## 6. Cleanup

`infra/cleanup.sh` deletes everything `pre-deploy.bicep`, `main.bicep` and `infra/github-setup.sh`
created for an environment, with the target from `infra/pre-deploy.<env>.bicepparam`, in this order:
1. the GitHub environment;
2. the deploy app's role assignments, anywhere in the subscription. Azure keeps a deleted principal's
   role assignments, so they go before the app does;
3. the resource group `rg-x402-eastus2-dev`, with everything in it;
4. the app registrations (the API app, and the deploy app with its federated credential) and the
   operators' group.

```bash
infra/cleanup.sh --dry-run   # reads only: prints what it would delete, and deletes nothing
infra/cleanup.sh             # asks you to type rg-x402-eastus2-dev, then deletes
infra/cleanup.sh --purge     # also purges the soft-deleted Foundry account and app registrations
```

It refuses, and deletes nothing, when `az` is signed in to another tenant than the file names, or when
the file's resource group isn't the one `main.<env>.bicepparam` deploys to. It leaves any GitHub secret,
and lists it.

After a run without `--purge`, soft delete keeps two things, and their names stay taken:
- the Foundry account, for 48 hours;
- the app registrations, restorable for 30 days. The API app's identifier URI stays taken, so
  `pre-deploy.bicep` can't create the app again until it is purged.

The operators' group is a security group: it is deleted for good.

The vaults stay soft-deleted for 90 days, with their secrets, even with `--purge`. Purge protection
forbids purging them, which is intended, since the payer key lives there. To deploy the same
environment again within that time, deploy `pre-deploy.bicep` (step 0), then run `deploy-infra` with
`first-deployment` and `recover-vaults`: Bicep recovers the vaults (`createMode: recover`) with their
secrets, so steps 3 and 4 can be skipped. Then go on from step 5. `recover-vaults` without
`first-deployment` is refused: after the clean-up the units are gone.
