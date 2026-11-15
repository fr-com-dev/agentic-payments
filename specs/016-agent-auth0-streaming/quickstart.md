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
5. Deploy L2, then L1 (`deploy-l2.yml`, `deploy-l1.yml`). Each run's step 8 starts the smoke job.
6. Where `apiDocs` is on: set the GitHub variable `AUTH0_AGENT_ORIGIN` to the agent's origin and run
   `provision-auth0.yml` with `apply` again.
7. Delete the directory's old registration for the agent's callers:
   `az ad app delete --id <the old authAudience value>`.

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
| | | |
