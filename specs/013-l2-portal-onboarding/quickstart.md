# Quickstart: validating the portal, user wallets and expense policies

How to prove the feature works, from the offline suite to Azure. Contracts are in [contracts/](contracts/); shapes
and rules are in [data-model.md](data-model.md). Commands that exist only after implementation are marked *(new)*.

## 1. Offline validation (definition of done)

```bash
npm install
npm run typecheck          # also checks web/portal (new tsconfig)
npm test                   # every suite, with user accounts off by default
npm run demo:local         # expect "spent on-chain: 0.006 USDC" and "hash chain ok=true", unchanged
BICEP_PATH=~/.azure/bin/bicep npm test   # adds T-IAC-01 (rule 21), cleanup and github-setup tests
```

Single areas:

```bash
npx vitest run test/users.test.ts              # T-USR-01..12: routes, ownership, step-up, state
npx vitest run test/policy.test.ts -t "user"   # T-POL-16..19: the two new rules and the user daily ceiling
npx vitest run test/portal.test.ts             # T-PRT-01..09
npx vitest run test/card-vault.test.ts         # T-CARD-01..06, against the stand-in vault
npx vitest run web/portal                      # T-WEB-01..08 (jsdom)
npx vitest run test/e2e.local.test.ts -t "T-E2E-12"   # two users, two accounts, on the local chain
```

Expected: all green, and the demo summary unchanged (NFR-008, SC-012).

## 2. Local walk-through (no Azure, no card vault)

Three terminals.

```bash
# 1: the stack with user accounts on (new flag)
npm run stack:local -- --users

# 2: a portal sign-in for "alice" from the local dev issuer (new flag). The first call also creates the issuer
#    (.local/dev-issuer), which the portal needs at startup
npm run -s dev-token -- --subject alice --portal

# 3: the portal (new); build the web app once, and again after changing web/portal
npm run build:web
npm run portal             # http://127.0.0.1:4025
```

In the browser at `http://127.0.0.1:4025`, paste the token (dev mode replaces the Auth0 sign-in), then:

| Step | Do | Expect | Proves |
|---|---|---|---|
| 1 | Open the portal | three steps, none done; name and email fields | US1 scenario 1 |
| 2 | Save the profile without ticking the test-funds box | refused | FR-009 |
| 3 | Tick it and save; reload | profile done, wallet step next | US1 scenarios 2, 3 |
| 4 | "Create my wallet", twice | one address, balance 0 | US2 scenarios 1, 2 |
| 5 | `npm run fund-user -- <address> 1` *(new, local only)* | balance 1 USDC within 30 s, with a read time | US2 scenario 3, SC-007 |
| 6 | First policy: the demo seller, 0.02 / 0.10 / 0.10 / 0.50 USDC, 10 per minute | the summary reads as in [portal-ui.md](contracts/portal-ui.md#policy-editor); onboarding complete | US3 scenarios 1, 2, SC-013 |
| 7 | Enter 0.0000001 as an amount | refused, not rounded | FR-025 |
| 8 | Set per payment to 0.20 | refused, naming the platform limit | US8 scenario 1 |

Then pay as that user through the hosted agent:

```bash
npm run agent:hosted &
TOKEN=$(npm run -s dev-token -- --subject alice)       # an agent-service token, not a portal one
curl -s http://127.0.0.1:4024/v1/runs -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"goal":"Buy the basic report from the seller."}'
```

| Check | Expect | Proves |
|---|---|---|
| The run's payment | AUTHORIZED; `payer` is alice's address, not the platform payer | US3 scenario 3, FR-017 |
| The ledger line | `userId`, `policyId`, `policyVersion`, `mandateId: pol_…@1` | FR-045, SC-010 |
| The premium item (above 0.02) | ESCALATED, as today; `npm run escalations` shows alice's `userId` | US3 scenario 4, US8 scenario 4 |
| The same run with `--subject bob` (never onboarded) | DENIED `user_not_onboarded`; nothing from the platform account | US4 scenario 6, FR-012 |
| The same run with `--service` | paid by the platform payer, as today | US4 scenario 5, FR-002 |
| The portal token against the agent, and the agent token against the portal | 403 both ways | FR-005, SEC-20 |
| `npm run ledger-verify` | exit 0 | INV-9 |

Changes and stopping:

| Step | Do | Expect | Proves |
|---|---|---|---|
| 9 | Lower the daily budget below what was spent; run again | DENIED `daily_budget_exceeded` | US5 independent test |
| 10 | Pause the policy; run again | DENIED `host_not_allowed` | US5 scenario 3 |
| 11 | Wait 16 minutes, then raise a limit | asks to confirm identity (paste a fresh `--portal` token), then saves | US5 scenario 2, FR-007 |
| 12 | Lower a limit with the old token | saves without asking | FR-007 |
| 13 | Account → Disable; run again | DENIED `user_disabled`; everything still listed, marked disabled | US7 scenarios 1–3 |
| 14 | Account → Enable | policies come back paused | US7 scenario 4 |

A restart of the local chain starts from an empty chain while the ledger keeps every user and wallet: fund the
accounts again (`npm run fund-user`), or a payment is signed, refused by the facilitator and settles nothing.

## 3. Isolation checks (two users)

Repeat §2 steps 1–6 for `bob` with a different policy, then:

- alice's run pays from alice's address and bob's from bob's (two different `payer` values in the ledger);
- spend alice's whole daily budget: bob's next payment is still authorized (US4 scenario 2);
- with alice's portal token, request bob's policy by its ID:
  `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4025/api/policies/<bob's pol_…> -H "authorization: Bearer $ALICE"` → `404`.

T-USR-03 and T-PRT-02 prove the same and show the check failing when it is switched off.

## 4. Cards, against the card vault's test mode

Needs a Stripe sandbox. Create a **restricted** key with Customers, Setup Intents and Payment Methods set to Write
and everything else None, then in `env/portal.env`:

```bash
CARD_VAULT=stripe
CARD_VAULT_KEY=rk_test_…
CARD_VAULT_PUBLISHABLE_KEY=pk_test_…
```

| Step | Do | Expect | Proves |
|---|---|---|---|
| 1 | Start the portal with a key starting `sk_live_` | refuses to start, naming `CARD_VAULT_KEY` only | T-CARD-01 |
| 2 | Wallet → Add a card → `4242 4242 4242 4242` | listed with brand, last four, expiry; the notice that agents can't pay with cards | US6 scenario 1 |
| 3 | Add the same card again | "already registered" | US6 scenario 6 |
| 4 | `4000 0000 0000 0069` | refused as expired | US6 scenario 6 |
| 5 | `4000 0025 0000 3155` | 3-D Secure challenge, then listed | card-vault.md |
| 6 | Policy editor → payment method | cards shown as not available | US6 scenario 3 |
| 7 | Remove the card | gone; `CARD_ADDED` and `CARD_REMOVED` in the ledger, with a `cardId` only | US6 scenario 4, FR-044 |
| 8 | `npm run scan-logs` over the portal's and L2's output, and a search of the ledger for `4242` | nothing | SC-008 |
| 9 | Block `api.stripe.com` (or stop the stand-in in the test) and add a card | "could not be added"; profile, wallet and policies still work; an agent payment still succeeds | US6 scenario 5, SC-011 |

**Unverified items to confirm here** (research R7): the Dashboard's exact names for the three permissions, that the
restricted key can expand `payment_method` on a SetupIntent, and what the vault answers to a real card number in
test mode (do not try a real card; ask Stripe support or rely on the documentation).

## 5. Sign-in checks against the Auth0 tenant (manual, once per tenant)

People sign in with Auth0 since 2026-11-10 ([R19](research.md#r19-auth0-as-the-identity-provider-for-people)). After
`provision-auth0.yml` has applied the additions of
[config-and-secrets.md](contracts/config-and-secrets.md#auth0-terraform-applied-by-provision-auth0yml), give a test
person the role `x402-user` in Auth0, then run the portal locally with `AUTH_ISSUER`, `AUTH_AUDIENCE` and
`PORTAL_CLIENT_ID` set and no `AUTH_JWKS_FILE`.

| Check | Expect |
|---|---|
| Sign in as a person with the role | the portal opens; the access token (decode it locally) has `iss` = the tenant, `aud` containing the API, `permissions: ["agent:run"]`, the portal's client as `azp` (or `client_id`), and the sign-in time claim (R19, checks 1 and 3) |
| Sign in as a person without the role | the portal answers 403 and shows the refusal; no profile file is created |
| `npm run -s user-token` (the device flow), sent to the portal | 403: that token belongs to the agent's client |
| The portal's token sent to the agent service | 403 |
| The same `user-token` sent to the agent service | a run starts, and its intents carry the person's `userId` (R19, check 4) |
| An Entra token of a person (`az account get-access-token …`) sent to either service | 401 at the portal, 403 at the agent service |
| The deploy app's Entra token (a system identity) sent to the agent service | a run starts with no user, paid by the platform account |
| **Sign-in time after a forced sign-in** (R19, check 2) | after "Confirm it's you", the new token's claim is within the last minute |
| **Sign-in time across a silent renewal** | wait for a renewal, or reload the page: the claim is unchanged |

If either sign-in time check fails, stop: loosening changes would be always refused or wrongly accepted. Record
each result in research R19 before enabling user accounts.

*History: on 2026-11-10 the first build was checked against the Entra tenant, where a real sign-in worked and the
token passed the portal's checks. Those results are in the Validation log and no longer describe people's sign-in.*

## 6. Azure

Follows `specs/011` quickstart §4, with the additions of
[config-and-secrets.md](contracts/config-and-secrets.md#azure).

1. **Identity, by an administrator.**
   - Auth0: run `provision-auth0.yml` (plan, then apply). It adds the API with its `agent:run` permission, the
     role `x402-user`, the portal's and the agent CLI's clients, and the sign-in time Action. Paste its `identity`
     output and `portalClientId` into `infra/main.<env>.bicepparam`. Assign the role to each person in Auth0.
   - Entra: apply `infra/pre-deploy.bicep` to take out what this feature first added (the `Portal.Access` scope,
     the web app registration). Expect two deployments, the first only disabling the scope
     ([config-and-secrets.md](contracts/config-and-secrets.md#infrapre-deploybicep)).
2. **Seed placeholders** before the next L2 deployment, without printing values:

   ```bash
   printf 'off' | az keyvault secret set --vault-name <kv-l2> -n portal-token --file /dev/stdin -o none
   printf 'off' | az keyvault secret set --vault-name <kv-l2> -n user-wallet-mnemonic --file /dev/stdin -o none
   ```

3. **Deploy with the feature off**, one run after another. Until the portal exists the pipeline's `portal-smoke`
   step can't pass, so the runs before it use `first-deployment`, which skips the checks: `deploy-infra` with
   `first-deployment` (adds the identity, vault and share), seed `kv-portal` with `portal-token` and
   `card-vault-key` as `off`, `deploy-l2` with `first-deployment`, `deploy-portal` with `first-deployment` (its own
   run does the portal smoke). Then `deploy-l1`, and `deploy-l2` and `deploy-portal` once more without the flag, so
   each unit passes every check and records its `last-good`. Expect every existing check green and the regression
   unchanged. `main.bicep` refuses to deploy the portal without `portalClientId` from step 1.
4. **Allow the deployed origin**: set the `portal_origin` variable of `auth0/` to `https://<portalFqdn>` and run
   `provision-auth0.yml` again, so the portal's address is an allowed callback and web origin.
5. **Turn it on**: seed the real `portal-token` (the same value in both vaults), the mnemonic and, for cards, the
   restricted key; set `userAccounts.enabled: true`; run `deploy-l2`, `deploy-portal`, `deploy-l1`.

   ```bash
   npm run -s wallet-mnemonic | az keyvault secret set --vault-name <kv-l2> -n user-wallet-mnemonic --file /dev/stdin -o none
   ```

   *(`wallet-mnemonic` is new: it prints one fresh 24-word mnemonic and nothing else. Keep a backup where the payer
   key's backup is kept.)*
6. **Check**: the pipeline's `portal-smoke` step is green; sign in at `https://<portalFqdn>`, onboard, fund the
   account from the Base Sepolia faucet, and repeat §2's payment checks through the hosted agent. The regression
   (a system identity) still pays from the platform payer.

Rollback: `userAccounts.enabled: false` and `deploy-l2`. L2 then ignores users again; the ledger keeps every entry,
and turning it back on restores every user, wallet and policy from the ledger.

## 7. What is not covered here

Real funds, mainnet, charging a card, moving funds out of an account, and per-user approval: all out of scope
(spec, Assumptions).

## Validation log

**2026-11-10, §2 and §3 on the local network** (tasks T113). Run against `npm run stack:local -- --users` and
`npm run portal` from this branch, with the web app built by `npm run build:web` and driven in a browser. Two
departures from the text above, both forced by the machine it ran on:

- Port 4020 was held by another checkout's L2, so L2 ran on 4120 (`CONTROL_PORT`, through temporary env files that
  were removed afterwards).
- No model key was available, so `npm run agent:hosted` was not started. Each "run" below is one paid fetch through
  the same orchestrator and ports the hosted agent uses (`PaidResourceOrchestrator` with `userId` set as the service
  sets it), against the real L2, L3, seller, facilitator and chain. The agent service's own handling of tokens and
  of the user is covered by T-AGT-06 and T-AGT-07 only.

| Row | Result | Note |
|---|---|---|
| §2 step 1 | pass | three steps, none done; the name prefilled from the sign-in |
| §2 step 2 | pass | Save stays disabled until the test-funds box is ticked |
| §2 step 3 | pass | profile done, wallet step next; still so after a new sign-in |
| §2 step 4 | pass | one address; a second create call returns it and the ledger has one `WALLET_CREATED` |
| §2 step 5 | pass | balance 1.00 USDC with its read time |
| §2 step 6 | pass | the summary reads as in portal-ui.md; home shows the active policy |
| §2 step 7 | pass | `0.0000001` refused on its field, "never rounded" |
| §2 step 8 | pass | per payment 0.20 refused by L2: "the most allowed is 0.10 USDC", in a summary that takes focus |
| The run's payment | pass | PAID and CONFIRMED on-chain; `payer` is alice's address |
| The ledger line | pass | `userId`, `policyId`, `policyVersion: 1`, `mandateId: pol_…@1` |
| The premium item | pass | ESCALATED; `npm run escalations` shows `userId=usr_…` |
| The same run as bob (never onboarded) | pass | DENIED `user_not_onboarded` |
| The same run with no user | pass | PAID and CONFIRMED from the platform payer, `mandateId: mandate-poc-001` |
| Token separation | partly | the agent's token at the portal: 403. The portal's token at the agent service was not tried (see above) |
| `npm run ledger-verify` | pass | exit 0 after every part |
| §2 step 9 | pass | daily budget lowered below the spend: DENIED `daily_budget_exceeded` |
| §2 step 10 | pass | paused: DENIED `host_not_allowed` |
| §2 step 11 | pass | with a sign-in 1000 s old (`--auth-age 1000`, not a 16-minute wait), raising a limit asks to confirm; after a fresh token the same change is saved |
| §2 step 12 | pass | lowering a limit with the old sign-in saves without asking |
| §2 step 13 | pass | disabled: the banner, DENIED `user_disabled`, everything still listed |
| §2 step 14 | pass | enabled: the policy comes back paused; its history shows all six events |
| §3 two payers | pass | alice's and bob's accounts differ; bob's payment is signed by and settles from bob's |
| §3 budgets | pass | alice at her daily budget is DENIED; bob's next payment is PAID |
| §3 cross-user read | pass | alice's token on bob's policy: 404 for a read and for a pause; bob's own: 200 |

Also seen: the portal's pages load under its Content-Security-Policy with no violation in the console; no ledger
line holds a name, an email or a policy name; the layout has no horizontal scroll at 360 px. One defect was found and
fixed: the portal, started before the first `dev-token` call, stopped with a bare file error; it now says how to
create the local dev issuer, and the order in §2 was corrected.

§4 (a Stripe sandbox), §5 (the Entra tenant) and §6 (Azure) were **not** run: they need outside accounts (T114).

**Later on 2026-11-10, against the Entra dev tenant** (the first build's sign-in, since replaced by Auth0, R19). After
`infra/pre-deploy.bicep` was applied in two deployments (`portalPreAuthorized` false, then true), a real sign-in at
`http://localhost:4025` worked: the portal accepted the Entra token (scope, client, `idtyp`, `Agent.Run`,
`auth_time`), reached L2 and opened onboarding. Step-up after a forced sign-in was not tried. These results describe
the Entra build only; §5 now lists the checks for Auth0, and none of them has been run.

**2026-11-10, after the change of identity provider** (tasks T139; Phase 14, research R19). Offline and local only:
nothing here ran against the Auth0 tenant, and nothing was deployed.

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `BICEP_PATH=~/.azure/bin/bicep npm test` | 57 files, 1,333 tests pass. `terraform validate` ran inside T-IAC-02 against the pinned provider (after `terraform init -backend=false`) and passes |
| `npm run build`, `npm run build:web` | pass; the web build is one page (no `redirect.html`) with the sign-in library in its own chunk |
| `npm run demo:local` | summary unchanged: `spent on-chain: 0.006 USDC`, `hash chain ok=true` |
| Portal, `/api/config` | `{ mode: "dev", domain: "", clientId, audience }`; the policy header has no sign-in host and `frame-ancestors 'none'` on every path |
| Portal, access with dev issuer tokens | portal token 200; agent-client token 403; `--service` token 401; no token 401 |
| Portal in a browser, as a new person (`dev\|frank`) | sign-in by pasted token, profile and wallet through the screens; the ledger's `USER_REGISTERED`, `WALLET_CREATED` and `POLICY_CREATED` carry `userIdFor(issuer, sub)` |
| Step-up | a policy created with a sign-in 20 minutes old: 403 `step_up_required`; with a fresh one: 201 |
| Hosted agent's entry point (`src/hosted-main.ts`, the template's settings, no model call) | portal token 403; a person without `agent:run` 403; a system identity without `Agent.Run` 403; a person's and a system identity's token pass access (400 for an empty goal); no token 401 |
| A person's run paid from their own account, through the hosted agent | covered by T-E2E-12 with a scripted model, on the local chain. Not run with a model key (T123 stays open) |

Not checked, and still open: research R19's five items against the tenant (T140), the two deployments of
`pre-deploy.bicep` that retire the Entra scope, and `npm run user-token` against a real tenant (its test uses a
stand-in).
