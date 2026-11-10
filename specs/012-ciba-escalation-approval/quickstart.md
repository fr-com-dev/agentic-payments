# Quickstart: validating backchannel approval

This guide proves the feature works. Section 1 is offline and automated. Sections 2–6 need a real
Auth0 tenant and a phone. Contracts: [auth0-ciba](contracts/auth0-ciba.md),
[payment-details](contracts/payment-details.md), [control-api](contracts/control-api.md),
[config-and-secrets](contracts/config-and-secrets.md).

## 1. Offline validation (definition of done)

```bash
npm run typecheck
```

```bash
npx vitest run test/ciba-client.test.ts test/approval-evidence.test.ts test/backchannel.test.ts
```

```bash
npm run check
```

Expected:
- every T-CIBA-*, T-ARCH-A9, T-E2E-10 and T-E2E-11 test passes, including each must-fail proof
  (plan "Proofs");
- `npm run demo:local` still prints `spent on-chain: 0.006 USDC` and `hash chain ok=true`. The
  feature is off locally, and the scripted plan is operator-only anyway;
- with `BICEP_PATH` set, T-IAC-01's CIBA rules pass.

What the stand-in Auth0 (`test/helpers/ciba-stub.ts`) shows, one scenario per user story:

| Scenario | Expected ledger trail | Agent's call |
|---|---|---|
| Approves within the wait (US1) | `INTENT`, `ESCALATED{requested}`, `APPROVAL_REQUESTED`, `HUMAN_APPROVAL{backchannel}`, `INTENT{reevaluationOf}`, `AUTHORIZED{approvalRef}` | `AUTHORIZED`, paid once |
| Approves after the wait (US1) | the same, up to `HUMAN_APPROVAL`; the next request gives `INTENT`, `AUTHORIZED` | `ESCALATE` at 120 s, then `AUTHORIZED` |
| Refuses (US2) | `…APPROVAL_REQUESTED`, `HUMAN_REJECTION{backchannel}`, `INTENT{reevaluationOf}`, `DENIED{human_rejected}` | `DENIED` |
| Never answers (US3) | `…APPROVAL_REQUESTED`, `APPROVAL_REQUEST_LAPSED`, then `ESCALATION_EXPIRED` at 300 s | `ESCALATE` |
| Forged answer (US4) | `…APPROVAL_REQUESTED`, `APPROVAL_VERIFICATION_FAILED{check}` | `ESCALATE`; nothing signed |
| Auth0 down (US5) | `ESCALATED{requested}`, `APPROVAL_REQUEST_FAILED{start}` | `ESCALATE` within about 2 s; an operator approval still pays |
| 11 escalations in an hour (US6) | the 11th is `ESCALATED{capped}` with no request | `ESCALATE` at once |

## 2. Auth0 tenant setup (Terraform, once)

The tenant is code in [`auth0/`](../../auth0/README.md) (research R17). Its pipeline, `provision-auth0.yml`, applies
it (SPEC v1.9). You need CIBA, which comes with the Enterprise plan or an add-on; `private_key_jwt` is
Enterprise-only, otherwise set `credential = "secret"` (research R3).

1. **By hand, first**:
   - a Management API application with the scopes listed in [`auth0/README.md`](../../auth0/README.md);
   - the approver's user account. Its user ID (`auth0|…`) becomes `approver_user_id`;
   - in Azure and GitHub: `infra/pre-deploy.bicep` deployed again (the state's storage and the second sign-in),
     then `infra/github-setup.sh`, which creates the GitHub environment `auth0-dev`. Give that environment required
     reviewers, and set the Management API application's credential as its secrets `AUTH0_CLIENT_ID` and
     `AUTH0_CLIENT_SECRET`.
2. **L2's key pair**. Use `openssl genpkey`, then `openssl pkey -pubout`, as in the README. Commit only the public
   half, as `auth0/ciba-client-key.dev.pub.pem`.
3. **Variables**: copy `auth0/dev.tfvars.example` to `auth0/dev.tfvars`, fill it in and commit it. It holds no secret.
4. **Plan, then apply**: run the pipeline once to see the plan, then again with `apply`.

   ```bash
   gh workflow run provision-auth0.yml -f environment=dev
   ```

   ```bash
   gh workflow run provision-auth0.yml -f environment=dev -f apply=true
   ```

   This makes the API (RS256, RFC 9068 tokens, the payment-details type, standard consent, users through a grant
   only), L2's CIBA-only client with Guardian push and its RS256 public key, the grant, and Guardian push.
5. **Outputs**: the apply run's summary shows the `ciba` object for §6. For §3, take the `CIBA_*` values from it
   (`issuer`, `clientId`, `audience`, `approver`).
6. **The approver enrolls their phone in Guardian push**, by scanning the enrollment QR code in the Guardian app.

## 3. Local run against the real tenant

Add the values to `env/l2-control.env` only (they are in the apply run's summary, §2 step 5). No other
env file gets them (rule A9, T-ARCH-ENV):

```bash
CIBA_APPROVAL=1
CIBA_ISSUER=https://<tenant>.<region>.auth0.com/
CIBA_CLIENT_ID=<client id>
CIBA_AUDIENCE=https://x402-payments.example/
CIBA_APPROVER=auth0|<user id>
CIBA_CLIENT_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
# CIBA_CLIENT_KEY_ID=<credential id>
```

Start the stack. Then run the Claude agent with a goal that buys the premium report; it isn't the
scripted plan, which never asks.

```bash
npm run stack:local
```

```bash
npm run agent -- "Buy the premium report and give me a receipt"
```

```bash
npm run escalations -- --watch
```

Expected:
- **The phone** shows the Guardian push, with `Pay_0.05_USDC_to_<payee>_for_premium-report_#<ref>`.
- **The watch** prints `ESCALATED … approvalRequest=requested referenceCode=<ref>`, then
  `APPROVAL_REQUESTED`.
- **Approve on the phone within 2 minutes.** The watch prints
  `APPROVED … channel=backchannel decidedBy=auth0|…`, and the agent's same fetch returns PAID
  CONFIRMED.
- **Run it again in a new session and refuse.** The watch prints `DENIED … channel=backchannel`,
  and the agent reports DENIED `human_rejected`.

## 4. Fallback checks

- **Turn the phone off and repeat.** After 2 minutes the agent reports ESCALATED with the same ID.
  `npm run approve -- <id>` still works; the next fetch pays.
- **Set a wrong `CIBA_CLIENT_ID` and restart L2.** The next escalation shows
  `APPROVAL_REQUEST_FAILED failure=permanent error=invalid_client`. The free purchases still pay at
  normal speed.

## 5. Live check against a real Auth0 tenant (manual)

Record the answers in the PR. They settle the facts that research marked **(live check)**:

1. **The Guardian screen**: does it show the `authorization_details` properties (amount, payee,
   resource, network, reference), or only the binding message?
2. **The detail source**: does the approval's `evidence.detailsSource` read `token` or `response`?
   With `response`, Auth0's CIBA access token lacks the claim; this is recorded as a residual risk
   (SEC-17).
3. **Equality**: is the returned `authorization_details` canonically equal to the request, or did
   Auth0 normalize anything (for example, turn `display_order` into a string)? A
   `check=details` failure on a genuine approval means it did; update the payment-details contract.
4. **Refusal and expiry**: a refusal yields `HUMAN_REJECTION{backchannel}`, and letting the push
   time out yields `APPROVAL_REQUEST_LAPSED`.
5. **The secret scan**: on the L2 log, `npm run scan-logs` reports clean.

## 6. Azure

L2's container always references `ciba-client-credential` in the l2 vault, whether the feature is on or off
([config-and-secrets](contracts/config-and-secrets.md#azure-fr-003)). So every environment seeds it.

1. **Before the first L2 deployment with 012**, while the vaults are open to your IP (the existing seeding flow,
   `deploy-infra.yml` with `seed-ip`), seed the placeholder. A new environment does this at the 011 quickstart's
   seeding step.

   ```bash
   az keyvault secret set --vault-name kv-l2-eastus2-dev --name ciba-client-credential --value off
   ```

   Then `deploy-l2.yml` works as before, with `CIBA_APPROVAL=0`. If you deploy without the secret, the L2
   revision fails and the pipeline rolls L2 back to `last-good`; seed it, then run the pipeline again.
2. **To turn it on:**
   - replace the placeholder with the client key from §2;
   - in `infra/main.dev.bicepparam`, set `ciba` to the `bicepparam_ciba` output from §2, with `enabled: true`;
   - run `deploy-l2.yml`.

   ```bash
   az keyvault secret set --vault-name kv-l2-eastus2-dev --name ciba-client-credential --file ciba-client-key.pem
   ```

   What-if shows the `CIBA_*` values change on `ca-l2-eastus2-dev` only. L2 refuses to start if the secret still
   holds `off`, so the pipeline rolls back instead of running half-configured.
3. **Deployment checks never notify the phone**: the cloud regression (`caj-l1-eastus2-dev`) is operator-only,
   and the hosted smoke run buys only auto-approved items and fails on any escalation (US6, research R14).
4. **Repeat §3's approve and refuse** through the hosted agent (`POST /v1/runs`, a goal for the premium report).
   The run returns within 200 s, and the step shows PAID after an approval within 2 minutes.

To turn the feature off, set `ciba.enabled: false` and redeploy L2. The vault may keep the key, or go back to `off`.
