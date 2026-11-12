# Quickstart: validating per-user backchannel approval

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Contracts**: [contracts/](contracts/)

How to check that the feature works, from a laptop to the tenant. Sections 1 to 5 need nothing outside this
repository. Section 7 needs the Auth0 tenant and a phone and is not a gate (spec FR-028).

## 1. Offline validation (definition of done)

```bash
npm install
```

```bash
npm run check
```

Expected: typecheck clean, every suite green, and the demo summary unchanged: `spent on-chain: 0.006 USDC` and
`hash chain ok=true`.

The suites this feature adds to or changes:

```bash
npx vitest run test/backchannel-approve.test.ts test/backchannel-verify.test.ts test/backchannel-fatigue.test.ts test/backchannel-lapse.test.ts test/backchannel-views.test.ts test/ciba-client.test.ts test/approval-evidence.test.ts
```

```bash
npx vitest run test/users.test.ts test/portal.test.ts test/hosted-run.test.ts test/e2e.local.test.ts web/portal
```

```bash
BICEP_PATH=~/.azure/bin/bicep npx vitest run test/infra.test.ts test/auth0-iac.test.ts test/github-setup.test.ts
```

| Story | Tests |
|---|---|
| US1 a person approves their own payment | T-CIBA-15, T-E2E-15 |
| US2 only the owner's answer counts | T-CIBA-16, T-CIBA-17 |
| US3 a run with no person asks nobody | T-CIBA-18, T-E2E-01 and T-E2E-10 unchanged |
| US4 no phone: the person sees why | T-USR-13, T-PRT-15, T-WEB-13, T-WEB-14 |
| US5 the limit is per person | T-CIBA-19 |
| US6 no approver anywhere | T-IAC-01 rule 19, T-IAC-02, the config cases of `ciba-client.test.ts` |
| US7 who was asked and how it ended | T-CIBA-21, T-CIBA-23, `backchannel-views.test.ts` |

## 2. The safety proofs

Each of these tests has a second half that turns one check off and expects the unsafe outcome
([plan.md](plan.md#proofs-constitution-viii)). Run them by name to see both halves:

```bash
npx vitest run -t "must fail"
```

Expected among the output: B's answer approves A's payment without the owner check; a request goes to the given
subject without the identity check; B is not asked with one shared count; a run with no person notifies
somebody when a fallback subject exists; a day-old session enrolls a phone without the Action's freshness check.

## 3. Local walk-through: a person who can't be asked sees why

Locally a person signs in with the dev issuer, which is not the approval service's issuer, so nobody is ever
asked by phone (FR-011). This walk-through shows the safe path and the person's view.

1. Put the tenant's CIBA settings in `env/l2-control.env`, as in `specs/012` quickstart §3, **without**
   `CIBA_APPROVER`: `CIBA_APPROVAL=1`, `CIBA_ISSUER`, `CIBA_CLIENT_ID`, `CIBA_AUDIENCE` and the client key.
2. Start the stack with user accounts, the portal and the hosted agent, each in its own terminal:

   ```bash
   npm run stack:local -- --users
   ```

   ```bash
   npm run portal
   ```

   ```bash
   npm run agent:hosted
   ```

   Expected in L2's output: `backchannel approval on (issuer https://…, per user)`.
3. Sign in to the portal as a dev user and finish onboarding with a policy that auto-approves less than the
   premium resource costs:

   ```bash
   npm run dev-token -- --subject alice --portal
   ```

4. Start a run as the same person that buys the premium resource, with an agent-service token for `alice`
   (`specs/013` quickstart §2, the `curl` to `/v1/runs`).
   Expected: the run answers ESCALATED at once, with no 120 s wait.
5. In the portal's home screen, within 5 s: one row under "Waiting for approval" with the reference code and
   "Phone approval is not available for the way you signed in. An operator will decide this one."
6. As the operator:

   ```bash
   npm run escalations
   ```

   Expected: the escalation with `approvalRequest=identity_mismatch` and the owner's `usr_…`. Approve it with
   `npm run approve -- <id>`; the person's row disappears and the next run pays.

No request reaches the tenant in this walk-through: check the tenant's log, or L2's output, which has no
"approval request sent" line.

## 4. No approver is configured anywhere

```bash
grep -rn -i "CIBA_APPROVER\|approver_user_id\|AUTH0_APPROVER" env infra auth0 .github scripts src
```

Expected: only the line of `src/layer2-control/ciba-client.ts` that refuses a leftover `CIBA_APPROVER`.

```bash
az bicep build-params -f infra/main.dev.bicepparam --stdout | jq '.parametersJson | fromjson | .parameters.ciba.value | keys'
```

Expected: `["audience","clientId","clientKeyId","credential","enabled","issuer"]`.

A leftover setting stops L2 and names it:

```bash
CIBA_APPROVER=anything npm run l2:control
```

Expected, with `CIBA_APPROVAL=1` in the env file: `CIBA_APPROVER is no longer used: remove it`, and no value
printed. L2 exits before it takes the ledger lock.

Backchannel approval without user accounts stops L2 too: start `npm run l2:control` with `CIBA_APPROVAL=1` and
without `USER_ACCOUNTS=1`. Expected: `CIBA_APPROVAL=1 needs USER_ACCOUNTS=1`.

## 5. Off means off

With `CIBA_APPROVAL` unset, everything behaves as before this feature:

- `npm run demo:local`: the unchanged summary.
- An escalation carries no `approvalRequest` mark, and the person's row reads "Waiting for an operator."
- `GET /api/platform` answers `phoneApproval: false`, and the portal shows neither the card's phone texts nor
  "Set up your phone".

## 6. The tenant's configuration and Azure

Nothing new is seeded in a vault and no pipeline is added.

1. **Plan the tenant** with no approver:

   ```bash
   gh workflow run provision-auth0.yml -f environment=dev
   ```

   Expected in the plan: `data.auth0_user.approver` gone, one Action added (`enroll-phone`), one tenant
   setting changed, the output `bicepparam_ciba` without `approver`. Nothing about the two applications changes.
   Apply with `-f apply=true` once the plan reads so.
2. **Delete the variable that is no longer read** (the setup script never deletes one):

   ```bash
   gh variable delete AUTH0_APPROVER_USER_ID --env auth0-dev
   ```

3. **Deploy the platform**, then L2, as usual. `main.bicep` refuses `ciba.enabled: true` while
   `userAccounts.enabled` is false. In dev both are off, so the deployment changes one thing: L2's app loses
   the `CIBA_APPROVER` variable.
4. **What a deployed environment does**: with `ciba.enabled: true`, no request is sent to any phone, because
   every run there is a system identity's (`no_owner`). The operator job and the portal's administrators
   decide. This is the accepted state until a later feature lets people start runs there.

## 7. Enrollment in the tenant (by hand, not a gate)

These are the facts [research R13](research.md#r13-enrollment-the-tenants-own-asked-for-by-the-portals-sign-in)
took from Auth0's documentation. They need the applied tenant, the portal signed in through it (the deployed
portal, or a local one with `env/portal.env` pointing at the tenant), and a phone with the Guardian app.

| # | Check | Expected |
|---|---|---|
| 1 | Sign in to the portal normally | no enrollment page, no second factor asked |
| 2 | Account → "Set up your phone" | credentials asked again, then the tenant's push enrollment (a QR code) |
| 3 | Finish with the Guardian app | back in the portal, same account; the tenant's user shows one push factor |
| 4 | Press "Set up your phone" again | credentials asked, no enrollment page, no error |
| 5 | Close the pop-up during enrollment | "Nothing was changed."; the portal session still works |
| 6 | Sign out and in again | no second factor asked at sign-in (`guardian_policy` is `never`) |
| 7 | `auth.domain` in the portal's `/api/config`, and the host of `CIBA_ISSUER` | equal |

Whether an enrolled person then receives an approval request can't be checked: no run can name them until
people can start runs with a token from the tenant.

## 8. What is not covered here

- A request delivered to a real phone for a real person's run, and its approval (FR-028). It is proven against
  the stand-in approval service (T-CIBA-15, T-E2E-15).
- `specs/012` quickstart §5, the live check with one configured approver: it can no longer be repeated as
  written ([research R19](research.md#r19-what-becomes-of-012s-live-check)).
- Removing or replacing an enrolled phone: done with the tenant's own means.

## Validation log

Filled in during implementation: the date, the command or section, and what was seen.

| Date | Section | Result |
|---|---|---|
| | | |
