# Quickstart: validating the portal, user wallets and expense policies

How to prove the feature works, from the offline suite to Azure. Contracts are in [contracts/](contracts/); shapes
and rules are in [data-model.md](data-model.md). Commands that exist only after implementation are marked *(new)*.

## 1. Offline validation (definition of done)

```bash
npm install
npm run typecheck          # also checks web/portal (new tsconfig)
npm test                   # every suite, with user accounts off by default
npm run demo:local         # expect "spent on-chain: 0.006 USDC" and "hash chain ok=true", unchanged
BICEP_PATH=~/.azure/bin/bicep npm test   # adds T-IAC-01 (rule 20), cleanup and github-setup tests
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

# 2: the portal (new)
npm run portal             # http://127.0.0.1:4025

# 3: a portal sign-in for "alice" from the local dev issuer (new flag)
npm run -s dev-token -- --subject alice --portal
```

In the browser at `http://127.0.0.1:4025`, paste the token (dev mode replaces the Entra sign-in), then:

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

## 5. Sign-in checks against a real Entra tenant (manual, once per tenant)

After `infra/pre-deploy.bicep` has been applied with the changes of
[config-and-secrets.md](contracts/config-and-secrets.md#infrapre-deploybicep), run the portal locally with
`AUTH_TENANT_ID`, `AUTH_AUDIENCE` and `PORTAL_CLIENT_ID` set and no `AUTH_JWKS_FILE`.

| Check | Expect |
|---|---|
| Sign in as a person in `agentUsers` | the portal opens; the access token (decode it locally) has `scp: Portal.Access`, `roles: [Agent.Run]`, `idtyp: user`, `azp` = the web app, an `auth_time` |
| Sign in as a person not in `agentUsers` | Entra refuses (assignment required), or the portal answers 403; no profile file is created |
| `az account get-access-token --scope api://<api app>/user_impersonation` against the portal | 403 |
| **`auth_time` after a forced sign-in** (research R5, unverified) | after "confirm it's you", the new token's `auth_time` is within the last minute |
| **`auth_time` across a silent renewal** | wait for a renewal (or clear the access token from session storage and reload): `auth_time` is unchanged |

If either `auth_time` check fails, stop: loosening changes would be always refused or wrongly accepted. Record the
result in research R5 and switch to the fallback noted there before enabling user accounts.

## 6. Azure

Follows `specs/011` quickstart §4, with the additions of
[config-and-secrets.md](contracts/config-and-secrets.md#azure).

1. **Entra, by an administrator**: what-if, then create `infra/pre-deploy.bicep` (the new scope, claims and the web
   app's registration). Paste the new `portalClientId` into `infra/main.<env>.bicepparam` under `userAccounts`.
2. **Seed placeholders** before the next L2 deployment, without printing values:

   ```bash
   printf 'off' | az keyvault secret set --vault-name <kv-l2> -n portal-token --file /dev/stdin -o none
   printf 'off' | az keyvault secret set --vault-name <kv-l2> -n user-wallet-mnemonic --file /dev/stdin -o none
   ```

3. **Deploy with the feature off**: `deploy-infra` (adds the identity, vault and share), seed `kv-portal` with
   `portal-token` and `card-vault-key` as `off`, then `deploy-l2`, `deploy-portal`, `deploy-l1`, one after another.
   Expect every existing check green and the regression unchanged.
4. **Register the redirect**: set `portalOrigin` in `infra/pre-deploy.<env>.bicepparam` to the `portalFqdn` output
   and apply `pre-deploy.bicep` again.
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
