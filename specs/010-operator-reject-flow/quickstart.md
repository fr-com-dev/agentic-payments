# Quickstart: validating the escalation lifecycle

This guide proves feature 010 works. It references the contracts rather than repeating them:
[control-api](contracts/control-api.md), [policy-r15](contracts/policy-r15.md),
[operator-cli](contracts/operator-cli.md), [ledger-lifecycle](contracts/ledger-lifecycle.md).

## 1. Offline gates (no network, no keys)

```bash
npm install
npm run typecheck
npx vitest run test/policy.test.ts -t "T-POL-15"        # R15 human_rejected, including the must-fail control
npx vitest run test/escalations.test.ts -t "T-LED-04"   # lifecycle derivation, sweep, restart, events feed
npx vitest run test/e2e.local.test.ts -t "T-E2E-07|T-E2E-08|T-E2E-02"
npx vitest run test/architecture.test.ts                # A1/T-ARCH-TRACE: SEC-12 and the new test IDs resolve
npm run check                                           # typecheck + all tests + demo:local
```

Expected:
- every test is green;
- `npm run check` ends with `spent on-chain: 0.006 USDC` and `hash chain ok=true`;
- the demo outcomes are still `FREE, PAID, PAID, ESCALATED, DENIED, DENIED`.

On the first L2 start after upgrading, old pending escalations in `.local/ledger-local.jsonl` each
get one `ESCALATION_EXPIRED` entry (research R10). That changes the entry count but not the
baseline.

## 2. Operator reject flow by hand (Base Sepolia, as in the README)

Prerequisites: the `env/*.base-sepolia.env` files from the README, with a production CDP key and a
funded payer.

```bash
# terminals 1–3: services
ENV_FILE=env/seller.base-sepolia.env       npm run seller
ENV_FILE=env/l2-control.base-sepolia.env   npm run l2:control
ENV_FILE=env/l3-verifier.base-sepolia.env  npm run l3:verifier

# terminal 4: operator watch
ENV_FILE=env/operator.base-sepolia.env npm run escalations -- --watch

# terminal 5: agent, fixed session
SESSION_ID=sess_reject1 ENV_FILE=env/l1-agent.base-sepolia.env npm run agent:scripted
```

| Step | Action | Expected |
|---|---|---|
| 1 | first agent run | step 4 is `ESCALATED … authorizationId=auth_X`, and terminal 4 prints `ESCALATED auth_X … expiresAt=…` within 5 s |
| 2 | `ENV_FILE=env/operator.base-sepolia.env npm run reject -- auth_X alice too expensive` | exit 0, `{ ok, rejectionId: rej_…, alreadyRejected: false }`, and terminal 4 prints `DENIED auth_X … operator=alice reason="too expensive"` |
| 3 | the same reject again | exit 0, `alreadyRejected: true`, nothing new in terminal 4 |
| 4 | `npm run approve -- auth_X` (operator env) | exit 1, `HTTP 409 … "state":"denied"` |
| 5 | agent run again, same `SESSION_ID` | step 4 is `DENIED … rules=human_rejected`; nothing is signed for it |
| 6 | agent run with `SESSION_ID=sess_reject2` | step 4 escalates again under a new ID; another session is unaffected |
| 7 | a reject call with any non-operator token | 401, and the ledger length is unchanged. T-E2E-07 covers this, so no manual step is needed; never paste tokens on a command line. |

## 3. Expiry and repeat-while-pending by hand

| Step | Action | Expected |
|---|---|---|
| 1 | agent run with `SESSION_ID=sess_exp1` | `ESCALATED auth_Y` is printed in the watch |
| 2 | agent run again within 5 minutes, same session | step 4 returns the **same** `auth_Y`, and the watch prints nothing new (`ESCALATION_REPEATED` in the ledger). If you ran §2 just before, wait 60 s first: velocity (R13) counts `AUTHORIZED` entries from every session in the trailing 60 s, and back-to-back runs reach the cap of 10, so step 4 is `DENIED … velocity_limit` instead. |
| 3 | wait 5 minutes without deciding | the watch prints `EXPIRED auth_Y` within about 5 s of the deadline |
| 4 | `npm run approve -- auth_Y` and `npm run reject -- auth_Y` | both exit 1 with 409 `"state":"expired"` |
| 5 | agent run again, same session | step 4 escalates under a **new** ID `auth_Z`, and the watch prints `ESCALATED auth_Z` |
| 6 | approve `auth_Z`, then approve it again | the second call returns the same `approvalId` with `alreadyApproved: true`; one payment at most |
| 7 | do not use the approval for 10 minutes | the watch prints `APPROVAL_LAPSED auth_Z approvalId=…` |

## 4. Audit check

```bash
# loads CONTROL_URL and OPERATOR_TOKEN into this shell only; nothing is printed
set -a; . env/operator.base-sepolia.env; set +a
curl -s -H "Authorization: Bearer $OPERATOR_TOKEN" "$CONTROL_URL/v1/ledger/verify"
```

`GET /v1/ledger/verify` returns `ok: true`. For each escalation above, the ledger shows its creation,
exactly one final-state entry, and then every later `DENIED` entry that lists `human_rejected` (SC-009).
