# Quickstart: checking feature 016

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Contracts**: [contracts/](contracts/)

How to see that the feature works. Sections 1 to 4 need nothing but this repository; 5 and 6 need the Auth0
tenant and Azure. Record each result in the Validation log at the end.

## 1. The definition of done

```bash
npm run check
```

Expect `spent on-chain: 0.006 USDC` and `hash chain ok=true` in the demo's summary, unchanged: the demo's L2 has
no sign-in configured, so its scripted agent forwards nothing.

```bash
BICEP_PATH=~/.azure/bin/bicep npx vitest run test/infra.test.ts test/deploy-workflow.test.ts test/auth0-iac.test.ts
```

## 2. The must-fail halves

```bash
npx vitest run -t "must fail"
```

Look for the unsafe outcome of each row of [plan.md "Proofs"](plan.md#proofs-constitution-viii): Bob's account
signing with Alice's token, the platform account paying with no caller's token, a portal token paying, a person
without the role starting a run, the planted token found.

## 3. A local walk-through with the dev issuer

```bash
npm run stack:local -- --users
```

In a second terminal, the hosted agent (`env/l1-hosted.env` from the example):

```bash
API_DOCS=1 npm run agent:hosted
```

A person's token and a machine caller's (the dev issuer signs both):

```bash
npm run dev-token -- --subject alice
```

```bash
npm run dev-token -- --service
```

1. Send a goal with alice's token after onboarding her at the portal and funding her
   (`npm run fund-user -- <address>`). Her account pays; `npm run escalations` shows nothing of the platform's.
2. Send the same goal with the machine token: the platform account pays, and the entries name no user.
3. Send it with `npm run dev-token -- --subject alice --no-role`: 403. With a portal token
   (`--portal`): 403.
4. Call L2 directly with the control token and a body that names a user: 400. With no
   `X-Caller-Authorization`: 401 `caller_token_required`.

## 4. The stream

```bash
curl -N -X POST http://127.0.0.1:4024/v1/runs -H "authorization: Bearer $TOKEN" -H "accept: text/event-stream" -H "content-type: application/json" -d '{"goal":"Get the weather for Lima and list what you bought."}'
```

Expect `event: run` at once, `event: text` lines while the model writes, one `event: step` per tool call and a
last `event: result` whose `data` has the fields of the JSON answer. Without the `accept` header the answer is
the JSON object.

## 5. The tenant and Azure, in order

1. Make the `checks` key: an RSA key of 2048 bits or more. Keep the private half for step 4; put the public half
   in the GitHub variable `AUTH0_MACHINE_CALLER_KEYS` of the environment `auth0-<env>` as `{"checks":"<PEM>"}`.
2. Run `provision-auth0.yml` with `apply`. Copy the outputs `bicepparam_agent` into `agent` of
   `infra/main.<env>.bicepparam` and choose `apiDocs`.
3. In Auth0, assign the role `x402-agent` to each person who may start runs.
4. Seed `machine-client-key` in the l1 vault with the private half (a `deploy-infra` run with `seed-ip`, then one
   without, as for every vault secret).
5. Deploy L2 first, with `first-deployment` (`deploy-l2.yml`). The order matters: an L2 with this feature refuses
   every payment request that carries no caller's token, so until the agent is deployed nothing can be paid
   (the safe side). The other way round, a new agent in front of an old L2 would have a person's run paid by the
   platform account. `first-deployment` skips the checks, because the smoke job does not exist yet.
6. Deploy L1 (`deploy-l1.yml`), without `first-deployment`: the regression job and the new smoke job run as the
   `checks` machine caller, and the run promotes the agent. If this first run fails, the roll-back leaves the
   candidate on the previous image, which does not start with the new settings; traffic stays on the previous
   revision, which can no longer pay. Fix forward.
7. Deploy L2 again without `first-deployment`, so that its image becomes `last-good`.
8. Where `apiDocs` is on: set the GitHub variable `AUTH0_AGENT_ORIGIN` to the agent's origin and run
   `provision-auth0.yml` with `apply` again.
9. Delete the directory's old registration for the agent's callers:
   `az ad app delete --id <the old authAudience value>` (it is recorded in a comment of
   `infra/pre-deploy.<env>.bicepparam`).

## 6. Live checks (the points research could not confirm)

| # | Check | Expected |
|---|---|---|
| 1 | Decode a `checks` token: where is `agent:run`? | in `scope`, in `permissions`, or both; record which |
| 2 | Open `https://<agent>/docs`, press Authorize, sign in | a token is obtained with no secret; a run from the page completes |
| 3 | The same, watching the browser's network tab | requests go to the agent's origin and the tenant only |
| 4 | A streamed run through the ingress with a slow purchase | events arrive as they are written; `: keep-alive` lines appear in quiet periods; the stream is not cut |
| 5 | A person's run whose payment escalates, with their phone enrolled | the request reaches that person's phone; approving it pays from their account |
| 6 | A token of the old kind (`az account get-access-token --resource <old audience>`) | 401 |

## 7. Leftovers

```bash
grep -rnE "AUTH_TENANT_ID|SERVICE_AUDIENCE|Agent\.Run|authAudience|agentUsers|approvalSubject" src infra env docs scripts .github auth0
```

Expect only the two lines in `src/layer1-intent/hosted/config.ts` that refuse the old settings by name.

## Validation log

| Date | Section | Result |
|---|---|---|
| 2026-11-15 | §1 | `npm run typecheck` green. Every suite that needs no fixed port, with `BICEP_PATH`: 58 files, 1595 tests passed, 1 skipped (`terraform validate`, which needs `auth0/.terraform`). The chain-bound suites on a temporary port 18545: `e2e.local`, `cdp-*`, `counterparty` 114/114; `e2e.full` (T-E2E-17) 12/12. `npm run demo:local` from a scratch copy of the tree on other ports: FREE, PAID, PAID, ESCALATED, DENIED, DENIED; `spent on-chain: 0.006 USDC`; `hash chain ok=true`. Not run: `npm run check` as one command and `test/demo.local.test.ts`, because the owner's own `stack:local` was running from this worktree on the standard ports and uses its `.local/` files. |
| 2026-11-15 | §2 | `npx vitest run -t "must fail"` shows the unsafe outcome for each row of plan.md "Proofs": T-CTK-03 (`trustIntentUser`: Bob's account signs with Alice's token), T-CTK-05 (`skipRequired`: the platform account pays with no caller's token), T-CTK-01 (`skipClientCheck`: a portal token pays; `skipPermission`: a person without the role and a machine caller without a grant pay), T-CTK-07 (`echoCaller`: the scan finds the token), T-AGT-09 (`skipPermission` at the agent), the two `skipChecks` halves of `verifyCaller`, T-ARCH-A14 and A15 (their fixtures). |
| 2026-11-15 | §3, §4 | Covered by T-E2E-15, T-E2E-16 and T-E2E-17 on the local chain (the hosted agent for a person and for a machine caller, the stream, onboarding through the portal's API). The walk-through with separate processes was not run by hand. |
| 2026-11-15 | §5, §6 | Not run: they need the owner (the `checks` key, the GitHub variable, `provision-auth0.yml`, the vault secret, the role assignment, the deployments). `terraform fmt -check` is clean and the configuration validates against provider 1.60.0 from a scratch copy; no plan was run. |
| 2026-11-15 | §7 | The `grep` finds the two refusals in `src/layer1-intent/hosted/config.ts` and L2's refusal of `approvalSubject` in `src/layer2-control/service.ts`, as intended; the old names remain only in comments that say they are gone. |
| 2026-11-15 | T052 | One branch carries the whole feature, so no pull request leaves a deployed environment where L1's word names a user. The deployment order of §5 keeps that true across the two units. |
