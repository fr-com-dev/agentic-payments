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
npx vitest run test/deploy-workflow.test.ts   # T-E2E-AZ static checks on the four deploy pipelines
npx vitest run test/images.test.ts            # T-IMG-01: each image holds only its own layer's code and packages
npx vitest run test/agent.test.ts -t "T-AGT-KEY"   # both L1 entry points refuse the payer key
npx vitest run test/ledger-lock.test.ts       # T-LED-05, including the must-fail two-writer case
npx vitest run test/e2e.local.test.ts -t "T-E2E-09"   # hosted agent on the in-process harness: escalate → approve → continue session
npx vitest run test/architecture.test.ts      # A1, T-ARCH-ENV (l1-hosted template), T-ARCH-TRACE (SEC-14..16)
npm run check                                 # typecheck + all tests + demo:local
```

**Expected**:
- every test passes;
- T-IAC-01 reports "skipped: BICEP_PATH not set" unless the Bicep CLI is installed (section 2);
- `npm run check` ends with `spent on-chain: 0.006 USDC` and `hash chain ok=true`, with outcomes
  unchanged.

## 2. Infrastructure checks without deploying

```bash
az bicep install && export BICEP_PATH="$HOME/.azure/bin/bicep"   # Bicep CLI 0.47.16
npx vitest run test/infra.test.ts             # T-IAC-01: rules 1–14 on the five compiled templates, plus 12 must-fail mutants
# One image per layer and the seller's (research R14). Each build fails if its closure reaches another layer.
docker build -f docker/l1-agent.Dockerfile -t x402-l1-agent:dev .
docker build -f docker/l2-control.Dockerfile -t x402-l2-control:dev .
docker build -f docker/l3-verifier.Dockerfile -t x402-l3-verifier:dev .
docker build -t x402-seller:dev .
docker run --rm x402-l1-agent:dev sh -c 'ls dist/src/hosted-main.js && test ! -e dist/src/layer2-control && test ! -e env'
docker run --rm x402-l3-verifier:dev sh -c 'test ! -e dist/src/layer2-control/signer.js && test ! -e node_modules/@mastra'
for i in l1-agent l2-control l3-verifier seller; do
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
- the deploy app registration with an OIDC federated credential for this repository, for the
  `dev` environment;
- the `dev` GitHub environment and the repository secrets the workflows read, all identifiers or
  public addresses. Fill in `env/infra.env` (gitignored), then run `infra/github-setup.sh`. Step 0
  adds `AGENT_API_CLIENT_ID`:

  ```bash
  cp env/infra.env.example env/infra.env   # GITHUB_REPO, GITHUB_ENVIRONMENT, the deploy app's
                                           # AZURE_* IDs, SELLER_PAY_TO, PAYER_ADDRESS
  infra/github-setup.sh --dry-run          # checks the file and sends nothing
  infra/github-setup.sh                    # creates the environment and sets the secrets
  ```

  The script accepts only those keys, checks each value's shape (a GUID, or a 0x address of 40 hex
  digits) and sends nothing if any check fails. Values reach `gh` on stdin and are never printed.
  Never store a credential as a GitHub secret: the payer key, the CDP key and the tokens go only
  into the Key Vaults (step 3).

0. **Register the API.** Run `infra/entra-app.sh --deploy-sp <deploy app id> --assign-user <you@tenant>`.
   It creates the API registration, `Agent.Run` and the delegated scope `user_impersonation` (the
   Azure CLI is pre-authorized for it), and assigns the role to the deploy service principal for the
   smoke check and to you. That grants the pipeline and you spending through the agent, within the
   mandate. It prints `AUTH_AUDIENCE`, the app's client ID: put it in `env/infra.env` as
   `AGENT_API_CLIENT_ID` and run `infra/github-setup.sh` again. The L1 deployment doesn't compile
   without it.
1. **Create the platform.** Run the workflow `deploy-infra` with `environment=dev` and
   `platform-only: true`. It creates the network, identities, registry, the five vaults, storage,
   Foundry and both environments, and nothing else.
2. **Check the model.** In the Foundry portal for `eastus2`, confirm `claude-sonnet-5-5` offers
   Global Standard, then create the deployment named exactly `claude-sonnet-5-5`. Record what the
   portal shows (research R2: Anthropic and Learn disagree on deployment types).
3. **Seed the vaults.** Add a temporary IP rule for your address to each vault
   (`az keyvault network-rule add --ip-address <you>/32`). Put the secrets in, following
   [cloud-topology](contracts/cloud-topology.md), with `az keyvault secret set` from a trusted
   shell, then remove the rule. Secrets must never pass through GitHub.
4. **Deploy the sellers.** Run `deploy-infra` again, without `platform-only`. Expected: both sellers
   answer, and the run summary records the balance, regression and `ledger-verify` steps as
   skipped, because no layer exists yet.
5. **Deploy the layers, in this order.** The [deploy-pipeline](contracts/deploy-pipeline.md) steps
   should all be green:
   1. `deploy-l2` with `first-deployment: true`; `ledger-verify` passes.
   2. `deploy-l3` with `first-deployment: true`.
   3. `deploy-l1`, with every gate, including the regression and the smoke check. The agent's
      traffic ends on its new revision.
6. **Record a last-good for L2 and L3.** Run `deploy-l2` and `deploy-l3` once more without
   `first-deployment`. Each passes every gate and tags its image `last-good`. Until then, a failed
   L2 or L3 run has nothing to roll back to.
7. **Time it.** Record the minutes from step 0 to the green `deploy-l1` run (SC-008: under 60), and
   later the minutes per layer redeploy (under 15).

Then check the platform facts the research could not confirm:

| Check | How | Expected |
|---|---|---|
| Foundry accepts the provider's `anthropic-beta` header | the hosted smoke check (step 8) succeeds; otherwise the 400 names the header | 200. If it fails, enable header stripping in the Foundry `fetch` (research R2) |
| Lifecycle `None` blocks tokens inside L2 | `az containerapp exec -n ca-l2-control --container proxy -- sh -c 'wget -qO- "$IDENTITY_ENDPOINT?resource=https://vault.azure.net&api-version=2019-08-01" -H "X-IDENTITY-HEADER: $IDENTITY_HEADER"'` | fails: no endpoint or an error. Key Vault references still resolve, because L2 started |
| Internal http calls aren't redirected | regression step 6 passes over `http://ca-l2-control.internal…` | no 301 to https |
| Key Vault references resolve through the VNet rule (firewall default Deny) | all apps start and `ledger-verify` passes | no `secret reference` errors in the revision status |
| Exclusive create on the NFS share | during a `deploy-l2` run (step 6), the L2 log shows `ledger locked … waiting` in the revision overlap, then a clean start | one writer; the chain verifies |
| L2/L3 are private | from your machine: `curl -m 5 https://ca-l2-control.<env-domain>/v1/escalations` | 404 from the environment proxy, or no route; never 401 from L2 |
| A person can get a token and run the agent | "Calling the agent as a person" below | 200. A consent error (AADSTS65001) means the Azure CLI isn't pre-authorized; 401 means `AUTH_AUDIENCE` isn't the client ID |

**Calling the agent as a person** (assigned `Agent.Run` with `--assign-user`):

```bash
TOKEN=$(az account get-access-token --scope api://x402-l1-agent/user_impersonation --query accessToken -o tsv)
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"goal":"Get the weather for Lima"}' https://<agent fqdn>/v1/runs | jq '.status, [.steps[].result.outcome]'
```

## 5. Operator flow in Azure

```bash
az containerapp job start -n job-operator -g rg-x402-dev --container-name operator --image <acr>/x402-l2-control:<sha> \
  --command node --args dist/scripts/escalations.js --env-vars OPERATOR_TOKEN=secretref:operator-token CONTROL_URL=http://ca-l2-control.internal.<env-domain>
az containerapp job logs show -n job-operator -g rg-x402-dev --follow
```

To approve, run the same command with `--args dist/scripts/approve.js <authorizationId>`. Only
members of the operators' group can start the job.

## 6. Cleanup

`az group delete -n rg-x402-dev` removes everything except the Key Vaults. They stay in a
recoverable soft-deleted state, because purge protection is on; that is intended, since the
payer key lives there.
