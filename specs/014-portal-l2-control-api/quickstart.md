# Quickstart: validating the portal's administration area

How to prove the feature works, from the offline suite to Azure. Contracts are in [contracts/](contracts/); shapes
and rules are in [data-model.md](data-model.md). It builds on
[specs/013 quickstart](../013-l2-portal-onboarding/quickstart.md): do its §2 once, so that a user `alice` exists
with a funded wallet and a policy for the demo seller. Commands and flags that exist only after implementation are
marked *(new)*.

## 1. Offline validation (definition of done)

```bash
npm install
npm run typecheck
npm test                   # every suite; the administration area is off by default
npm run demo:local         # expect "spent on-chain: 0.006 USDC" and "hash chain ok=true", unchanged
BICEP_PATH=~/.azure/bin/bicep npm test   # adds T-IAC-01 (rule 16 changed, rule 22 new)
```

Single areas:

```bash
npx vitest run test/admin.test.ts                     # T-ADM-01..10: L2's administration routes (new file)
npx vitest run test/ledger.test.ts -t "T-LED-07"      # the portal channel in the derivations
npx vitest run test/portal-admin.test.ts              # T-PRT-10..14 (new file)
npx vitest run web/portal -t "admin"                  # T-WEB-09..12 (jsdom)
npx vitest run test/architecture.test.ts -t "A13"     # the portal's two halves stay apart
npx vitest run test/e2e.local.test.ts -t "T-E2E-14"   # approve and reject through the portal, on the local chain
```

Expected: all green, and the demo summary unchanged (NFR-006, SC-011).

## 2. Local walk-through

Four terminals. `alice` is the user from 013's walk-through; `carol` is an administrator who is not a user.

```bash
# 1: the stack with user accounts and the administration routes on (--admin is new)
npm run stack:local -- --users --admin

# 2: the portal with the administration area on (PORTAL_ADMIN is new)
npm run build:web
PORTAL_ADMIN=1 npm run portal             # http://127.0.0.1:4025

# 3: sign-ins from the local dev issuer (--admin is new)
npm run -s dev-token -- --subject carol --portal --admin --no-role   # an administrator only
npm run -s dev-token -- --subject alice --portal                     # a user only
npm run -s dev-token -- --subject alice --portal --admin             # both, for step 9

# 4: the hosted agent, and a run by alice that needs approval (the premium report costs 0.05 USDC,
#    above her 0.02 auto-approve limit)
npm run agent:hosted &
TOKEN=$(npm run -s dev-token -- --subject alice)
curl -s http://127.0.0.1:4024/v1/runs -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"goal":"Buy the premium report from the seller."}'
```

An approval or a rejection applies to one session's purchase. "Again" below means a second run that continues
the same session, with the session reference the first run returned (011, hosted-agent API).

In the browser, paste carol's token.

| Step | Do | Expect | Proves |
|---|---|---|---|
| 1 | Open the portal as carol | only "Administration" and "Sign out"; no onboarding | portal-ui "administrator only", FR-003 |
| 2 | Start alice's run (terminal 4), watch `/admin` | the payment appears within 5 s: reference code, alice's identifier, the seller, 0.05 USDC, a countdown from 5 min | US1 scenarios 1, 2, SC-002 |
| 3 | `npm run escalations` in a fifth terminal | the same payment, with the same reference code | the operator's path is unchanged, FR-019 |
| 4 | "Review" | the payment, and the budget: this run, the last 24 hours of the policy, the last 24 hours of the user | US4 scenario 1 |
| 5 | "Approve", confirm | "Approved in the portal"; it leaves the list within 5 s | US2 scenario 1 |
| 6 | Run alice's goal again, same session | the payment is AUTHORIZED once; the ledger's `HUMAN_APPROVAL` has `channel: "portal"` and carol's `usr_…` as `approver` | SC-007, FR-032 |
| 7 | A new run; "Reject" → "The amount is too high" | "Rejected in the portal"; the agent's retry is DENIED `human_rejected`, and its result names no reason and no person | US2 scenario 3, FR-016 |
| 8 | A new run; reject it with `npm run reject -- <id>`; then try "Approve" on the open screen | "This payment was already rejected, from the command line"; the ledger has one decision | US2 scenario 4, FR-017 |
| 9 | Sign in with alice's `--portal --admin` token; start another run of hers | she sees it, tagged "Your payment", with no buttons | US2 scenario 6, FR-015 |
| 10 | As carol, wait 16 minutes, then approve a new one | "Confirm it's you" (paste a fresh carol token); then it is approved if still pending | US2 scenario 2, FR-014 |
| 11 | As carol, reject with the 16-minute-old token | rejected without asking | FR-014 |
| 12 | Let one expire (5 min) with its screen open; press "Approve" | "This payment expired before it was approved." | US2 scenario 5 |
| 13 | "Activity" | every step above, newest first, each with its path and decider; decide something in another window: it appears at the top within 5 s, marked "New" | US3 scenarios 1, 2 |
| 14 | "Ledger check" → "Check the ledger" | "The ledger verifies. N entries. Checked at …"; `npm run ledger-verify` agrees (exit 0) | US5 scenario 1 |

Approving something that can't be paid: lower alice's daily budget in her policy below what she has spent, start
a run, and open the payment as carol. Expect the warning "Approving this will not make it payable" (US4 scenario
3). Approve it anyway: the agent's retry is DENIED `daily_budget_exceeded` (US2 scenario 7, SC-005).

## 3. Access checks

With `ALICE` a user-only portal token, `CAROL` an administrator's, `AGENT` an agent-service token:

```bash
code() { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }
P=http://127.0.0.1:4025

code $P/api/admin/escalations -H "authorization: Bearer $ALICE"     # 403: a user is not an administrator
code $P/api/admin/escalations -H "authorization: Bearer $AGENT"     # 403: a token for the agent service
code $P/api/admin/escalations                                       # 401: no token
code $P/api/wallet -H "authorization: Bearer $CAROL"                # 403: an administrator is not a user
code $P/api/admin/escalations -H "authorization: Bearer $CAROL"     # 200
```

The two portal credentials at L2 (local dev defaults):

```bash
L2=http://127.0.0.1:4020
code $L2/v1/admin/escalations -H 'authorization: Bearer dev-portal-token'          # 401: the user-account token
code $L2/v1/platform          -H 'authorization: Bearer dev-portal-admin-token'    # 401: the administration token
code $L2/v1/escalations       -H 'authorization: Bearer dev-portal-admin-token'    # 401: not the operator's routes
code -X POST $L2/v1/authorize -H 'authorization: Bearer dev-portal-admin-token'    # 401: a machine capability
code -X POST $L2/v1/reconcile -H 'authorization: Bearer dev-portal-admin-token'    # 401: a machine capability
```

A body that tries to name the decider is refused by the portal before L2 is called:

```bash
code -X POST $P/api/admin/escalations/<auth_…>/approve -H "authorization: Bearer $CAROL" \
  -H 'content-type: application/json' -d '{"decidedBy":"usr_00000000000000000000000000000000"}'   # 400
```

T-ADM-02, T-PRT-10 and T-PRT-12 prove the same and show each check failing when it is switched off.

## 4. Off means off

Stop terminals 1 and 2, then:

```bash
npm run stack:local -- --users        # no --admin
npm run portal                        # no PORTAL_ADMIN
```

| Check | Expect | Proves |
|---|---|---|
| `GET /api/config` | `admin: { available: false }` | FR-001 |
| carol's administrator-only token on `/api/me` | 403 | 013's access rule is back |
| alice's token on `/api/me` | as before, with `admin: false` | SC-011 |
| `GET /api/admin/escalations` with any valid portal token | 404 | not mounted |
| `GET /v1/admin/escalations` at L2 with `dev-portal-admin-token` | 404 | not mounted |
| `npm run approve`, `npm run reject`, `npm run escalations -- --watch` | work as today | FR-019, SC-012 |

## 5. With backchannel approval (012)

Only if an Auth0 tenant is set up as in [specs/012 quickstart](../012-ciba-escalation-approval/quickstart.md).
Start L2 with `CIBA_APPROVAL=1` as well.

| Check | Expect | Proves |
|---|---|---|
| A run that escalates | the phone is asked, and the list shows "Asked" | US1 scenario 4 |
| Approve in the portal before answering the phone | the waiting authorize call returns AUTHORIZED in the same request; the phone request ends as abandoned | data-model "state machine", T-ADM-07 |
| Answer the phone first, then press "Approve" in the portal | "This payment was already approved, by phone" | FR-017 |

T-E2E-14 covers the first two rows with the stand-in approval service, so this section is optional.

## 6. Azure

Prerequisite: 013 is deployed with `userAccounts.enabled: true`, and its sign-in check of `auth_time` (013
quickstart §5, task T114) has passed. Approvals rely on the same claim
([research R6](research.md#r6-identity-confirmation-for-approvals)); don't turn this area on before that.

1. **Seed the secret as `off`** in both vaults, before the first L2 and portal deployments that contain 014
   (values are piped in, never printed or put on a command line; see the `azure-bicep-github` notes on seeding):
   `kv-l2/portal-admin-token` and `kv-portal/portal-admin-token`.
2. Deploy L2, then the portal (`deploy-l2.yml`, `deploy-portal.yml`), one after the other. Nothing changes for
   anyone: the area is off.
3. **Turn it on**:
   - put one new random value in `portal-admin-token` in both vaults (different from `portal-token`);
   - add the administrators to `portalAdmins` in `infra/pre-deploy.<env>.bicepparam` and apply
     `pre-deploy.bicep` (an administrator, by hand);
   - set `userAccounts.administration: true` in `infra/main.<env>.bicepparam`;
   - run `deploy-l2.yml`, then `deploy-portal.yml`.
4. Check, signed in as an administrator: `/api/config` says `admin.available: true`; the "Administration" link
   is there; a person without the role doesn't see it and gets 403 on `/api/admin/escalations`.
5. Trigger an escalation with a run of your own user, and have **another** administrator approve it. Confirm
   the `HUMAN_APPROVAL` entry with the operator job (`ledger-verify` as its own command; an operator overrides the
   command to read escalation events, as in 011 quickstart §5).
6. **Turning it off again**: `userAccounts.administration: false`, deploy L2 and the portal. The secret can stay.

## 7. What is not covered here

- A browser-driven test against real Entra: sign-in, the `roles` claim with `Portal.Admin`, and the forced
  sign-in for an approval are checked by hand in §6 steps 4 and 5.
- Load: the list is polled every 3 s per open administrator tab; the suite doesn't simulate many tabs.

## Validation log

| Date | Commit | Section | Result |
|---|---|---|---|
| 2026-11-11 | working tree on `11c940c` (uncommitted) | §1 offline | Pass: `npm run check` (1264 tests, demo summary `spent on-chain: 0.006 USDC`, `hash chain ok=true`) and `BICEP_PATH=… npm test` (1341 tests, 59 files). |
| 2026-11-11 | same | §2, in a real browser, partly | Pass for steps 1, 2, 4, 5, 6, 7, 13 and 14, as an administrator who is not a user, on the local stack with escalations of the platform account created through L2's authorize route: the list with its countdown, the payment with its budget, approve (the agent's retry was then AUTHORIZED and the ledger's `HUMAN_APPROVAL` has `channel: "portal"`), reject with a reason, the activity trail, the ledger check; no console error. Phone width (375 px) checked on the list and the payment screen. Two layout defects found and fixed there: the reject reasons shared a line, and a table caption collapsed at phone width. |
| 2026-11-11 | same | §3 access, partly | Pass: `/api/admin/escalations` is 401 without a token and 200 with an administrator's; `/api/config` reports `admin.available: true`. The rest is covered by T-ADM-02, T-PRT-10 and T-PRT-12. |
| — | — | §2 steps 3, 8 to 12; §4; a keyboard-only pass | Not walked by hand. Their behavior is covered by the automated tests (T-ADM-05..07, T-PRT-10, T-PRT-14, T-WEB-09, T-WEB-11); a user's own escalation (`mine`) was not seen in a real browser. |
| — | — | §5 (Auth0), §6 (Azure) | Not run: they need outside accounts. §6 is gated on 013's task T114. |
| 2026-11-11 | same, after the convergence tasks (T074 to T086) | §1 offline | Pass: `npm run check` (1269 tests in 56 files, demo summary `spent on-chain: 0.006 USDC`, `hash chain ok=true`). `BICEP_PATH=… npm test`: 1317 tests pass in 56 files, T-IAC-01 and the cleanup and github-setup suites included; its other three files (`cdp-auth`, `cdp-isolation`, `counterparty`) failed to start with `EADDRINUSE` on port 8545, taken during the run by a local stack of another worktree. Those three had passed in `npm run check` minutes before, on the same code, so every suite passed in one of the two runs; no single run with the Bicep CLI was all green. |
