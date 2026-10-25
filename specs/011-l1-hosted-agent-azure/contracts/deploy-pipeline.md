# Contract: deployment and post-deployment regression (proposed T-E2E-AZ)

The source is `.github/workflows/deploy-azure.yml`. It is triggered by `workflow_dispatch` (input:
environment) or by a `deploy-*` tag. Azure sign-in uses OIDC with a federated credential on the
deploy app registration. No Azure secret is stored in GitHub.

## Steps (any failure stops the run and triggers rollback where noted)

| # | Step | Pass condition |
|---|---|---|
| 1 | `npm install`, `npm run typecheck`, `npm test` | green |
| 2 | Install Bicep CLI 0.47.16, `BICEP_PATH=…`, `npx vitest run test/infra.test.ts` (T-IAC-01) | green, not skipped |
| 3a | Base infrastructure without apps (`deployApps=false`), so the registry exists before the images | succeeded |
| 3 | `docker build` and `docker push` of each image in `IMAGES` as `x402-<image>:<sha>`: `l1-agent`, `l2-control` and `l3-verifier` from `docker/<image>.Dockerfile`, `seller` from `Dockerfile` (research R14). Each build fails when its closure reaches another layer's file or a module doesn't load | four images pushed |
| 3b | Image secret check on each image: `docker history --no-trunc` and `docker run … env` hold no `PRIVATE_KEY`, `_SECRET` or `_TOKEN` assignment (SC-005) | no match |
| 4 | `az deployment group what-if`, then `create` with `imageTag=<sha>` | succeeded |
| 5 | Wait for the `ca-l2-control` and `ca-l3-verifier` revisions `<sha>` to be running. Then start `job-operator` with `ledger-verify` every 15 s until it exits 0 | within 5 min (lock handover, research R12) |
| 5b | From the runner: `npm run payer-balance -- <payer address>`, a read-only `balanceOf` on Base Sepolia USDC. The address is public and no key is involved | balance ≥ 50000 atomic (0.05 test USDC), otherwise fail with "fund the payer" |
| 6 | `az containerapp job start job-regression` (template from `infra/`; command `node dist/src/main.js --scripted --check-baseline`), then wait for the execution | execution status `Succeeded` (exit 0). `--check-baseline` exits 2 unless the outcomes are `FREE, PAID, PAID, ESCALATED, DENIED, DENIED` with 2 CONFIRMED |
| 7 | `job-operator` → `ledger-verify` | exit 0 (`ok: true`) |
| 8 | Hosted smoke: get a token for the deploy service principal (assigned `Agent.Run` by `infra/entra-app.sh --deploy-sp`), `POST /v1/runs` with the default goal to the new `ca-l1-agent` revision's label URL, and time the call | 200, `status: completed`, steps include `/api/weather` and `/api/market-brief` with `outcome: PAID`, settlement `CONFIRMED`; duration ≤ 120 s, written to the job summary (SC-009) |
| 9 | Secret scan: `az monitor log-analytics query` over the container logs of steps 5–8, piped to `npm run scan-logs` (credential-shape patterns from `scripts/secret-scan-lib.ts`: JWTs, `Bearer` values, PEM blocks, `PAYMENT-SIGNATURE`/`x-api-key` values, `*_PRIVATE_KEY=`/`*_SECRET=`/`*_TOKEN=` assignments) | no match. Exact-value completeness is proven offline by T-AGT-05 (research R13) |
| 10 | Shift `ca-l1-agent` traffic 100% to revision `<sha>`, then tag each image `<sha>` as `x402-<image>:last-good` | done |

## Rollback

- **Steps 6–9 fail**: the agent's traffic stays on the previous revision. The workflow redeploys
  `ca-l2-control`, `ca-l3-verifier` and the sellers at the previous successful SHA (recorded as
  each image's `last-good` tag in the registry). It then reruns steps 5–7. A failure there leaves the run
  red for a human.
- **Steps 1–4 fail**: nothing changed in Azure, or what-if showed the change and create failed
  atomically per resource. The run is red. A partial create is fixed forward by rerunning.

## What each deployment proves (FR-024, SC-001, SC-005)

- **The pinned baseline.** The scripted plan exercises the deployed L2, L3, seller, CDP
  facilitator and Base Sepolia, and gets the pinned outcomes.
- **The chain.** It still verifies after the lock handover.
- **The agent's path.** The hosted agent's HTTP, auth, model and tools path works with a service
  identity.
- **No leaks.** No secret reached the logs.

## Cost guard

Each deployment spends 0.006 USDC of testnet funds for the regression and about 0.006 for the
smoke. Step 5b checks that the payer holds at least 0.05 test USDC before step 6.
`scripts/payer-balance.ts` is a new read-only command. It uses viem's public client, takes the
address as an argument and reads no env file.
