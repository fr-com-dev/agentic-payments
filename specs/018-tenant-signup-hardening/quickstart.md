# Quickstart: validating Sign-Up Hardening (018)

How to prove the feature works, offline and against the dev tenant (`fabriciorojas.us.auth0.com`, portal
`https://dev.fabriciorojas.com`). The rollout has two steps, A and B, each its own merge to `main` (research R7).
What each step declares is in `contracts/tenant-connections.md`. What a new person must reach is in
`contracts/new-person-access.md`.

Placeholders: `<tenant>` is the tenant domain, `<portal>` and `<agent>` the two client IDs (outputs `portal_env`
and `l1_env`), `<google>` the project's Google client ID. All four are public values.

## 0. Before you start

- Owner: access to the Google Cloud project and to the tenant's Dashboard.
- Operator: the operator's host (the VPS) with a checkout of `main`, and the command `npm run auth0:tenant`
  (`auth0/README.md`).
- The Management API application has the four connection scopes (research R10). Add them in the Dashboard:
  **Applications → APIs → Auth0 Management API → Machine to Machine Applications**.
- Note the IDs (`con_…`) of `Username-Password-Authentication` and `google-oauth2`
  (**Authentication → Database** and **Authentication → Social**).

## 1. The project's own Google application (by hand, before step A)

1. In Google Cloud, create an OAuth client of type **Web application**:
   - authorized JavaScript origin: `https://<tenant>`;
   - authorized redirect URI: `https://<tenant>/login/callback`, and nothing else;
   - consent screen: **In production**, with the scopes `openid`, `email` and `profile` only.
2. In the tenant (**Authentication → Social → google-oauth2**), enter its client ID and secret, then save. The
   secret goes nowhere else: not a file, not the tfvars file, not chat.
3. Note the `user_id` of one existing Google person (**User Management → Users**). Have them sign in to the portal
   again. **Expected**: the same `user_id`, no second user with their email address, and the same wallet address
   in the portal (research R8). If not, put the old setting back and stop.
4. Read the redirect to Google without signing in. The code challenge is any 43-character value, because nothing
   completes:

   ```bash
   curl -s -o /dev/null -w '%{redirect_url}\n' "https://<tenant>/authorize?response_type=code&client_id=<portal>&redirect_uri=https%3A%2F%2Fdev.fabriciorojas.com&scope=openid&connection=google-oauth2&code_challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code_challenge_method=S256"
   ```

   **Expected**: an `accounts.google.com` address with `client_id=<google>` and
   `redirect_uri=https%3A%2F%2F<tenant>%2Flogin%2Fcallback`, never `login.auth0.com`.

## 2. What the public client settings show

Run this for `<portal>` and `<agent>`, before and after each step:

```bash
curl -s "https://<tenant>/client/<portal>.js" | grep -o '"connections":\[[^]]*\]'
```

**Expected after step A**: exactly two connections:

- `Username-Password-Authentication` with `"showSignup":false` and `"showForgot":true`;
- `google-oauth2`.

Nothing else, and no passwordless connection (research R5).

Auth0's edge caches this answer for up to about two minutes (`max-age=60`, `stale-while-revalidate=60`). Right
after an apply, read it again until its `age` header counts from after the apply.

## 3. Step A: declare the connections (the deny Action stays)

1. Put three `import {}` blocks in `auth0/imports.tf`, which is never committed (`contracts/tenant-connections.md`,
   imports). Add `google_client_id = "<google>"` to `~/x402-tfstate/auth0.dev.tfvars`.
2. Plan:

   ```bash
   npm run auth0:tenant -- plan
   ```

   **Expected**:
   - three imports;
   - on `auth0_connection.database`, one change: `disable_signup` to `true`;
   - on the two `auth0_connection_clients`, any client other than the portal and the agent removed;
   - nothing destroyed or replaced.

   If the database connection shows any other option changing, make the declaration match the tenant and plan
   again (research R2). Never apply a plan that changes the password policy.
3. Apply exactly that plan:

   ```bash
   npm run auth0:tenant -- apply
   ```

   Then delete `auth0/imports.tf`.
4. Run §2 again for both clients. Open the portal's sign-in page. **Expected**: no "Sign up" link, and "Continue
   with Google" and "Forgot password" are there.
5. Self-service sign-up is refused. Use a throwaway `example.com` address and a random password:

   ```bash
   curl -s -w '\n%{http_code}\n' -X POST "https://<tenant>/dbconnections/signup" -H 'content-type: application/json' --data "{\"client_id\":\"<portal>\",\"connection\":\"Username-Password-Authentication\",\"email\":\"pentest-$(date +%s)@example.com\",\"password\":\"$(openssl rand -base64 24)\"}"
   ```

   **Expected**: `400`, and no new user in the Dashboard. Opening `https://<tenant>/u/signup` from a fresh
   sign-in is refused the same way.
6. Plan again. **Expected**: no changes. Then enable one connection for L2's approval client by hand in the
   Dashboard and plan. **Expected**: the plan removes it (FR-018). Apply to restore. Then change the Google
   connection's client ID by hand to any other value, and plan. **Expected**: the precondition fails. Put it back.

## 4. Step B: remove the deny Action, then add a test account

1. Merge step B. Plan. **Expected**: `auth0_trigger_action.deny_sign_up[0]` and `auth0_action.deny_sign_up[0]`
   destroyed, and nothing else. Apply.
2. Repeat §3.5. **Expected**: still `400`, now from the connection's own setting.
3. Create a named test person in the Dashboard (**User Management → Users → Create User**, connection
   `Username-Password-Authentication`). While you do it, have someone repeat §3.5. **Expected**: the user is
   created, and the sign-up is refused. Sign in as the test person in the portal.
4. For a test administrator: create a second one, enroll a second factor, assign `x402-admin`, and sign in.
   **Expected**: the administration area opens for them, and not for the first test person. After the test,
   delete both in the Dashboard. **Expected**: neither can sign in. Their ledger entries stay.

## 5. A brand-new Google person

1. With a Google account that has never used the tenant, choose "Continue with Google" on the portal.
   **Expected**: they are signed in, and they save a profile in under 3 minutes (SC-003). They see their own
   wallet, they can add a policy, and they can start card setup.
2. With the same person, start a run at the agent (its docs page, where it's on, or with their agent token).
   **Expected**: 403. Open `/admin`. **Expected**: refused.
3. Assign them `x402-agent` and have them sign in again. **Expected**: a run works, paid from their own account.
   Remove the role after the check.
4. Where backchannel approval is on, run `specs/012` quickstart §5. **Expected**: it still passes with L2's
   client using no connection (research R3).

## 6. Offline checks (every change)

```bash
npx vitest run test/auth0-iac.test.ts
```

```bash
npx vitest run test/portal.test.ts -t "T-PRT-19"
```

```bash
npx vitest run test/hosted-access.test.ts -t "T-AGT-15"
```

```bash
npx vitest run test/caller-token.test.ts -t "T-CTK-01"
```

```bash
npm run check
```

**Expected**:

- T-IAC-02 passes, and so does each new must-fail mutant (`contracts/tenant-connections.md`, rules 1–8);
- T-PRT-19 and T-AGT-15 pass;
- the demo summary is unchanged.

## 7. No Google secret anywhere the project keeps things

On the operator's host, after step A's apply:

```bash
grep -c 'GOCSPX-' ~/x402-tfstate/auth0.dev.tfstate ~/x402-tfstate/auth0.dev.tfvars
```

**Expected**: `0` for each. In the checkout, the pre-commit secret scan (`gitleaks` or the CLAUDE.md grep) finds
nothing, and the plan's printed output names no `client_secret`.

## 8. Emergency stop (optional rehearsal, with the owner's agreement)

Set `google_sign_in = false`, then plan. **Expected**: the plan empties Google's enabled clients only. Apply it only
for a real emergency or with the owner's agreement: until it is set back, existing Google people can't sign in.

## Validation log

One line per check, with the date, who ran it and the result. Never a secret, a password, a token or a person's
email address: name a person by their role ("an existing Google person", "the test administrator").

| Date | Section | Who | Result |
|---|---|---|---|
| 2026-11-24 | §6 offline checks, on a Mac (step A in the working tree) | implementer | `npm run typecheck` green. T-IAC-02 290 tests, T-PRT-19, T-AGT-15 and the T-CTK-01 row 5 case pass; the operator command's run cases pass with a GNU `stat` stand-in on `PATH` (macOS `stat` has no `-c`, so 9 of them fail on a Mac as before this change, and pass on Linux). `npm run check` result below. |
| 2026-11-24 | §6 `npm run check` | implementer | typecheck green; 1844 tests passed, then the three on-chain suites (T-E2E-01..09, T-E2E-17, the demo's) failed only on `EADDRINUSE 127.0.0.1:8545`, a port another process held during the run; run again with the port free, they pass (49 tests). `npm run demo:local`: `spent on-chain: 0.006 USDC`, `hash chain ok=true` (the entry count grows because `.local/ledger-local.jsonl` is kept between runs). Secret scan of the change: no key, token, private key or `GOCSPX-` value. |
| 2026-11-24 | §6 again, in one pass, before the step A pull request | implementer | `npm run check` green: typecheck, 69 test files and 1891 tests passed (3 files skipped without `BICEP_PATH`), demo `spent on-chain: 0.006 USDC`, `hash chain ok=true`. With `BICEP_PATH` set, the four Bicep suites pass (129 tests). `npm run build`, `npm run build:web` and `npm run audit:shipped` pass; shellcheck finds nothing in `scripts/auth0-tenant.sh`, as before. |
| 2026-11-24 | §0 | owner | The Management API application has the four connection scopes; the two `con_…` IDs are noted. |
| 2026-11-24 | §1.1–§1.2 | owner | The project's own Google OAuth client, in a dedicated Google Cloud project, is entered on the tenant's `google-oauth2` connection; the secret was entered in the Dashboard only. |
| 2026-11-24 | §1.3 | owner | An existing Google person signed in again: the same `user_id`, no second user, the same wallet. |
| 2026-11-24 | §1.4 | implementer | The redirect goes to `accounts.google.com` with the project's client ID, `redirect_uri=https://<tenant>/login/callback` and the scopes `email profile`; no `login.auth0.com`. |
| 2026-11-24 | §3.2, first plan | operator | Not applied. 3 imports, 4 changes, nothing destroyed, the two lists trimmed to the portal and the agent as expected; but `auth0_connection.database` also added the legacy password fields (`password_policy = "good"`, a minimum of 8, …) beside the tenant's flexible `password_options` (a minimum of 15). T030: the declaration now matches the tenant; plan again. |
| 2026-11-24 | §6, for T030 | implementer | `terraform fmt -check` and `terraform validate` clean. T-IAC-02 298 tests pass, the 8 new `password_options` mutants included (operator command run cases with the GNU `stat` stand-in on a Mac). `npm run check`: typecheck green and 70 test files passed; the five on-chain and demo files failed only on `EADDRINUSE 127.0.0.1:8545`, a port another process held, and pass when run again with it free (83 tests). `npm run demo:local`: `spent on-chain: 0.006 USDC`, `hash chain ok=true`. Secret scan of the change: nothing found. |
| 2026-11-24 | §2, before step A's apply | implementer | Portal and agent: exactly `Username-Password-Authentication` and `google-oauth2`, no passwordless connection; `"showSignup":true`, `"showForgot":true` (the finding). |
| 2026-11-24 | §3.2, second plan (after T030) | operator | 3 imports, 4 changes, nothing destroyed: on `auth0_connection.database` only `disable_signup` false → true (`password_policy` stays null, `password_options` unchanged); both lists trimmed to the portal and the agent; the portal's `addons` no-op. |
| 2026-11-24 | §3.3 apply | operator | Applied exactly that plan. |
| 2026-11-24 | §2, after the apply | implementer | Portal and agent: the same two connections, now `"showSignup":false`, `"showForgot":true`. The first two reads, within two minutes of the apply, still showed `true` (the cached answer). |
| 2026-11-24 | §3.4 | implementer | The hosted sign-in page (from the portal's `/authorize`) has the email and password fields, "Reset password" and "Continue with Google", and no "Sign up" link. |
| 2026-11-24 | §3.5 | implementer | `/authorize` with `screen_hint=signup` returns to the portal with `error=invalid_request`, "signup is disabled". `POST /dbconnections/signup` with a throwaway `example.com` address, with the owner's agreement: `400 {"error":"public signup is disabled"}`, the connection's own answer, not the deny Action's. T031 passed. |
| 2026-11-24 | §1.4, after the apply | implementer | The redirect still goes to `accounts.google.com` with the project's client ID. |
| 2026-11-24 | §6, for step B (T036–T039) | implementer | `terraform fmt -check` and `terraform validate` clean. T-IAC-02 298 tests pass: rule 6 failed with the Action still in `auth0/` (rule 6 and the exact Actions), and passes once it is gone; its 4 mutants and the cleared comment case pass. `npm run check`: typecheck green, 74 test files passed; `test/cdp-failures.test.ts` failed only on `EADDRINUSE 127.0.0.1:8545` before its tests started and passes alone (21 tests). `npm run demo:local`: `spent on-chain: 0.006 USDC`, `hash chain ok=true`. Secret scan of the change: nothing found. |
