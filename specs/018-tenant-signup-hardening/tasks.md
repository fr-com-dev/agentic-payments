---

description: "Task list for 018: sign-up hardening for the sign-in tenant (pentest finding P1)"
---

# Tasks: Sign-Up Hardening for the Sign-In Tenant (pentest finding P1)

**Input**: Design documents from `specs/018-tenant-signup-hardening/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md): US1–US6, FR-001..FR-020, NFR-001..004
- [research.md](research.md): R1–R12
- [data-model.md](data-model.md)
- [contracts/](contracts/): tenant-connections, new-person-access
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII and NFR-003 require a must-fail case for every new
rule.
- **Test IDs.** Each test title carries its ID: T-IAC-02 (rules 1–8 of contracts/tenant-connections.md), T-PRT-19,
  T-AGT-15, T-CTK-01 (row 5), T-ARCH-TRACE.
- **Order.** Write the T-IAC-02 rules and their mutants first, and see the real configuration fail them, before you
  change `auth0/`.
- **Behavior already in place.** T-PRT-19, T-AGT-15 and the T-CTK-01 case pin behavior that already holds. They pass
  at once. Their must-fail halves, with the existing test-only deps (`skipAdminCheck`, `skipPermission`), are the
  proof.
- **No secret in a test.** Build a Google-secret-shaped value at runtime, as
  `"GOCSPX" + "-" + "x".repeat(28)`, so that no scanner meets a literal.

**Not edited**: `src/` (no service changes, research R11), `docs/*.openapi.yaml`, `.github/workflows/`,
`auth0/.terraform.lock.hcl` (no new provider), `auth0/outputs.tf`.

**Nobody here calls the tenant.** Tasks marked *owner* or *operator* are done by hand by those people, on Google
Cloud, the tenant's Dashboard or the operator's host (the VPS), following quickstart.md. Each one's result goes in
quickstart.md's Validation log. No secret, password or token goes into the log, the repository or chat.

**Organization**: tasks are grouped by user story. Code phases follow the order the stories depend on each other.
US4's connection lists name US1's database connection, and US3's check sits on US4's Google list. Then come the
hand steps of rollout step A, then step B, which is US5. Each step is one merge to `main` (research R7).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task belongs to (US1–US6)

## Path Conventions

Repository root. The tenant in `auth0/`, the operator command in `scripts/auth0-tenant.sh`, tests in `test/`,
documents in `SPEC.md`, `CLAUDE.md`, `specs/` and `.specify/memory/constitution.md`.

---

## Phase 1: Setup

**Purpose**: a green baseline.

- [X] T001 Run `npm install` (not `npm ci`), then `npm run check`. Record the demo summary as the baseline: `spent on-chain: 0.006 USDC` and `hash chain ok=true`. Run `npx vitest run test/auth0-iac.test.ts`, which must be green. Then check whether Terraform 1.15.5 is in `~/.local/bin` or on PATH, for `terraform -chdir=auth0 fmt` in later tasks. If it isn't, say so: `.github/workflows/validate-auth0.yml` runs `fmt -check` and `validate` on the pull request.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the two new variables and the read-only Google connection. US1, US3 and US4 build on them.

- [X] T002 In `test/auth0-iac.test.ts`, add rule 8 and the variable half of rule 5 (contracts/tenant-connections.md):
  - Add `google_client_id` and `google_sign_in` to `VARIABLES`.
  - `google_client_id` must be `type = string` with `default = ""`. Its validation must accept exactly `""` or `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$`. Check it with good and bad examples, as `GOOD_ORIGINS`/`BAD_ORIGINS` do:
    - good: `""` and `123456789012-abc123def456.apps.googleusercontent.com`;
    - bad: a `GOCSPX-…` value built at runtime, `https://accounts.google.com`, an uppercase client ID, and one with a trailing dot.
  - `google_sign_in` must be `type = bool` with `default = true`.
  - Add one problem string for each variable, and mutants: the default `false`, the validation removed, the type `string`.
  - Confirm the real configuration now fails these rules.
- [X] T003 In `auth0/variables.tf`, add `google_client_id` and `google_sign_in` with data-model.md's meaning, type, default and validation. The `google_client_id` validation is `var.google_client_id == "" || can(regex("^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$", var.google_client_id))`.
  - Rewrite `allow_sign_ups`'s description. It now covers email-and-password self-service sign-up only. It sets the database connection's `disable_signup`, which also hides the page's "Sign up" link. It says nothing about Google. Until step B it still binds `deny-sign-up.js` (T037 drops that sentence).
  - Add one line to the header comment: the Google application's secret is never a variable. It is entered in the tenant's Dashboard only (research R4).
  - T-IAC-02's variable checks from T002 now pass.
- [X] T004 In `test/auth0-iac.test.ts`, add the data-source half of rule 5:
  - There is exactly one `data "auth0_connection"`, named `google`, with `name = "google-oauth2"`, `hide_client_secret = true` and `skip_enabled_clients = true`.
  - No connection resource or connection data source holds `client_secret`, `options_client_secret_wo` or `client_id =`. Scope this check to connection blocks only: L2's `var.client_secret` and its write-only `client_secret_wo` stay.
  - Mutants: `hide_client_secret = false`; the attribute removed; `skip_enabled_clients` removed; `client_secret = "x"` added to the data source.
- [X] T005 In `auth0/main.tf`, add a section `# ---- People's connections (specs/018) ----` after "The hosted agent's callers" and before "Closed sign-ups". Start it with `data "auth0_connection" "google"` (T004's shape).
  - Its comment says why it is read-only: managing it would put the Google secret in state, and the write-only secret would have to stay on the operator's host (research R4).
  - Run `terraform -chdir=auth0 fmt` where Terraform is installed. T-IAC-02 is green.

**Checkpoint**: `npx vitest run test/auth0-iac.test.ts` is green, and the tenant's declaration reads Google but changes nothing yet.

---

## Phase 3: User Story 1 - A visitor sees only the ways in that work (Priority: P1) 🎯 MVP

**Goal**: one switch, `allow_sign_ups`, decides both the page's "Sign up" offer and the refusal at every self-service entry point, through the database connection's own "Disable Sign Ups" (FR-001..FR-005, research R1, R2).

**Independent Test**: offline, T-IAC-02 rules 3 and 4 with their mutants. Live, after step A's apply: quickstart §2, §3.4 and §3.5 (T031). No "Sign up" link, two refusals, no new account.

### Tests for User Story 1

- [X] T006 [US1] In `test/auth0-iac.test.ts`, add rules 3 and 4.
  - The resource: exactly one `resource "auth0_connection"`, named `database`, with `name = "Username-Password-Authentication"` and `strategy = "auth0"`. Its `options` block holds `disable_signup = !var.allow_sign_ups`, and it has `lifecycle { prevent_destroy = true }`.
  - Forbidden in that block: a `configuration`, a `custom_scripts` block, `enabled_clients`, and any `password =` (the existing "users and passwords are never managed here" check covers that too).
  - Keep the `SIGN_UPS` rule unchanged: the Action stays bound until step B.
  - Mutants:
    - `disable_signup = true` (ignores the switch);
    - `disable_signup = var.allow_sign_ups` (inverted);
    - `disable_signup` removed;
    - `prevent_destroy` removed;
    - a `custom_scripts { login = "…" }` block added;
    - `strategy = "email"`.
  - Update the file's header comment (around line 23): sign-up is closed by the connection's own setting, with the Action kept until step B.

### Implementation for User Story 1

- [X] T007 [US1] In `auth0/main.tf`'s "People's connections" section, add `resource "auth0_connection" "database"` (T006's shape).
  - List every option explicitly, with the values Auth0 gives a tenant's default `Username-Password-Authentication`: the password policy, its history, dictionary and personal-info options, brute-force protection, and the like. Take them from the provider's `auth0_connection` documentation for v1.60.0 and Auth0's database connection reference. The resource replaces the whole `options` object (research R2), so nothing may be left out.
  - Its comment says:
    - the block is written as imported;
    - the first plan after the import must change `disable_signup` only;
    - if it shows another change, the declaration is made to match the tenant, never the other way (T030);
    - never apply a plan that changes the password policy;
    - destroying it would delete every email-and-password person, hence `prevent_destroy`, and the Management API credential has no `delete:connections` (R10).
  - Run `terraform -chdir=auth0 fmt`. T-IAC-02 is green.

**Checkpoint**: offline, one setting governs email-and-password sign-up. The live half waits for step A's apply (T029–T031).

---

## Phase 4: User Story 2 - A new person signs up with Google and sets up their profile without a role (Priority: P1)

**Goal**: show, rather than assume, that a role-less person with a Google-shaped subject reaches exactly their own account (FR-011..FR-016, contracts/new-person-access.md).

**Independent Test**: `npx vitest run test/portal.test.ts -t "T-PRT-19"`, `npx vitest run test/hosted-access.test.ts -t "T-AGT-15"` and `npx vitest run test/caller-token.test.ts -t "T-CTK-01"`. They pass, and each must-fail half turns a refusal into an acceptance.

**Independent of Phases 2 and 3**: test files only, so this phase can run beside them.

### Tests for User Story 2

- [X] T008 [P] [US2] In `test/portal.test.ts`, add `describe("T-PRT-19 a brand-new Google person, with no role (018 FR-011..FR-016, SEC-26)")`.
  - The people:
    - the new person: `sub: "google-oauth2|"` followed by 21 digits, with `permissions: []`, using `test/helpers/portal.ts` (which takes the whole `sub` in `o.sub`);
    - a second person, `auth0|<the same 21 digits>`.
  - Check each row of contracts/new-person-access.md's portal table:
    - `GET /api/config` is 200;
    - `GET /api/me` is 200, with no profile;
    - the first `PUT /api/profile` is 200, and registers `userIdFor(issuer, sub)`;
    - `GET /api/wallet` and `/api/wallet/account` show their own account, which is neither the platform payer nor the second person's;
    - `POST /api/policies` is 201, and `GET /api/policies` then lists only theirs;
    - `POST /api/cards/setup` is 200 (the stand-in card vault);
    - the second person's policy ID on `GET /api/policies/{id}` is 404, with the unknown-policy body;
    - with administration on, as `test/portal-admin.test.ts` sets it up, `GET /api/admin/escalations` is 403 `{ error: "forbidden" }` with no call to L2;
    - their token from the agent's client is 403 `forbidden`.
  - The two people get two different users and two wallets (FR-016).
  - Must-fail half: with the portal's test-only `skipAdminCheck`, the new person reaches `/api/admin/escalations`.
- [X] T009 [P] [US2] In `test/hosted-access.test.ts`, add `describe("T-AGT-15 a brand-new Google person (018 FR-013)")`.
  - The new person's token, from `a.run(…, { sub: "google-oauth2|<21 digits>", permissions: [] })`, gets 403 `forbidden`. Check that there is no model call, and that the fake gate's `authorize` and `budget` are never called (`fakePorts()`).
  - The same `sub` with `permissions: ["agent:run"]` gets 200. The gate's calls carry that person's token, and no intent names a user.
  - Must-fail half: with the test-only `skipPermission`, the role-less person starts a run and the model is called.
- [X] T010 [P] [US2] In `test/caller-token.test.ts`, add a case to T-CTK-01 row 5: "T-CTK-01 row 5 a brand-new Google person without agent:run, forwarded by a faulty L1: 403 caller_forbidden, nothing appended (018)".
  - Use `test/helpers/caller-tokens.ts` `personToken({ sub: "google-oauth2|<21 digits>", permissions: [] })` against L2 with user accounts on.
  - The ledger's entry count is the same before and after.
  - The existing must-fail case ("must fail without the permission", around line 155) covers the switch. Add this `sub` to it as well.
- [X] T011 [US2] Run T008–T010. They must pass with no change in `src/`. If one fails, stop: it is a service defect against R21, SEC-19 or SEC-20. Report it to the owner, and fix nothing in `src/` without their agreement.

**Checkpoint**: the public way in is pinned by tests. T-ARCH-TRACE can now find T-PRT-19 and T-AGT-15 (T018).

---

## Phase 5: User Story 4 - The tenant's sign-in connections can't drift unnoticed (Priority: P2)

**Goal**: the people's connections and their enabled applications are declared and authoritative. Only the portal's and the agent's clients may sign a person in (FR-018, FR-018, research R3, R5, R6).

**Independent Test**: offline, T-IAC-02 rules 1 and 2 with their mutants. Live: quickstart §3.6 (T032). A client enabled by hand shows in the next plan, and apply removes it.

**Depends on**: T005 (the Google data source) and T007 (the database connection's ID).

### Tests for User Story 4

- [X] T012 [US4] In `test/auth0-iac.test.ts`, add rules 1 and 2.
  - The connection objects are exactly `auth0_connection.database`, `data.auth0_connection.google`, `auth0_connection_clients.database` and `auth0_connection_clients.google`. No singular `auth0_connection_client` exists, and no other `auth0_connection*` resource or data source.
  - `auth0_connection_clients.database` has `connection_id = auth0_connection.database.id` and `enabled_clients = [auth0_client.portal.client_id, auth0_client.agent.client_id]`, exactly.
  - `auth0_connection_clients.google` has `connection_id = data.auth0_connection.google.id` and `enabled_clients = var.google_sign_in ? [auth0_client.portal.client_id, auth0_client.agent.client_id] : []`.
  - No `enabled_clients` names `auth0_client.l2` or `auth0_client.machine`.
  - Mutants:
    - L2's client added to the database list;
    - `values(auth0_client.machine)[*].client_id` added to Google's;
    - Google's list without the switch;
    - a passwordless `resource "auth0_connection" "email"`;
    - a singular `auth0_connection_client`;
    - a managed `resource "auth0_connection" "google"`, which would put the secret in state.

### Implementation for User Story 4

- [X] T013 [US4] In `auth0/main.tf`'s "People's connections" section, add `auth0_connection_clients.database` and `auth0_connection_clients.google` (T012's shape). Their comments say:
  - each list is authoritative: a client enabled by hand shows in the next plan, and apply removes it (FR-018);
  - an existing tenant imports them, because create fails on a connection that already has clients (contracts/tenant-connections.md, imports);
  - L2's approval client and the machine callers get no connection, because CIBA needs none (R3);
  - `var.google_sign_in = false` is the emergency stop, and it stops existing Google people too (R6).

  Run `terraform -chdir=auth0 fmt`. T-IAC-02 is green.

**Checkpoint**: offline, every rule of FR-018 has a must-fail case except the Google client ID (Phase 6).

---

## Phase 6: User Story 3 - Google sign-in runs on the project's own Google application (Priority: P2)

**Goal**: a tenant on Auth0's developer keys, or on another Google application, fails the plan. The Google secret is in nothing the project keeps (FR-007..FR-010, NFR-001, research R4, R8, R9).

**Independent Test**: offline, the rest of T-IAC-02 rule 5, and rule 7 with the operator command's run cases. Live: quickstart §1.4 (the redirect) and §7 (no `GOCSPX-` in state or tfvars), in T027 and T033.

**Depends on**: T013 (the precondition sits on `auth0_connection_clients.google`).

### Tests for User Story 3

- [X] T014 [US3] In `test/auth0-iac.test.ts`, finish rule 5.
  - `auth0_connection_clients.google` has `lifecycle { precondition { … } }`, whose condition is exactly `!var.google_sign_in || (var.google_client_id != "" && try(data.auth0_connection.google.options[0].client_id, "") == var.google_client_id)`. Its error message names `google_client_id`, and says the tenant still runs on Auth0's developer keys or on another Google application (quickstart §1).
    - Corrected while implementing: without `var.google_client_id != ""`, a tenant on developer keys has no client ID, so `"" == ""` would let it through. `try()` makes a connection without options fail the precondition rather than error.
  - Mutants: the precondition removed; `|| true` appended; the non-empty check dropped; the comparison to `""`; the switch inverted (`var.google_sign_in ||`).
- [X] T015 [US3] In `test/auth0-iac.test.ts`, add rule 7 for the operator command.
  - Add a problem string, for example `SCRIPT_NO_GOOGLE_SECRET`: `check_tfvars` must refuse any variable whose name contains `secret`, and any `GOCSPX-` value. Check it in `scriptProblems`.
  - Update the `SCRIPT_KEY_ONLY` mutant that narrows the grep (around line 1227) to the new pattern.
  - Add two run cases to the `it.each` "the operator command refuses %s, before Terraform" (around line 1254):
    - a tfvars file with `google_client_secret = "x"`, refused with the new message;
    - a tfvars file with `google_client_id` set to a `GOCSPX-…` value built at runtime, refused with "holds a Google client secret".
  - Update the existing case "a tfvars file that picks the credential" to the new message.

### Implementation for User Story 3

- [X] T016 [US3] In `scripts/auth0-tenant.sh` `check_tfvars`:
  - Widen the grep to `'^[[:space:]]*(environment|credential|[[:alnum:]_]*secret[[:alnum:]_]*)[[:space:]]*='`.
  - Change the message to "… must not set environment, credential or any variable named *secret*: this script sets the first two, always credential = \"key\", and the Google client secret goes into the tenant's Dashboard only".
  - Add `if grep -q 'GOCSPX-' "$TFVARS"; then fail "$TFVARS holds a Google client secret: it goes into the tenant's Dashboard only"; fi`.
  - Update the function's comment.
  - `bash -n scripts/auth0-tenant.sh` passes, and T015 is green.
- [X] T018 [US3] In `auth0/main.tf`, add T014's precondition to `auth0_connection_clients.google`. Its comment says: the evidence of whose Google application is used is the client ID the tenant holds. The live check reads the redirect to Google (quickstart §1.4). A hand change of Google's application fails the next plan rather than being undone, because Terraform never writes Google's options (FR-018). Run `terraform -chdir=auth0 fmt`. T-IAC-02 is green.

**Checkpoint**: T-IAC-02 rules 1–5, 7 and 8 are in place, each with its mutants. Rule 6 comes with step B (T036).

---

## Phase 7: User Story 6 - The documents say what is public and what isn't (Priority: P3)

**Goal**: SEC-26, the residual risks, the operating guide and the tenant's README state the decision (FR-020, research R12). These tasks ship in step A's merge, with the code they describe.

**Independent Test**: `npx vitest run test/architecture.test.ts -t "T-ARCH-TRACE"` is green. Reading SEC-26, the residual risks, CLAUDE.md's sign-up notes and the README's "People" section, each states US6's six points, and none still calls a social first sign-in an uncovered gap.

**Depends on**: Phase 4 (T-ARCH-TRACE needs the test titles), and Phases 3, 5 and 6 (the rules described).

- [X] T018 [P] [US6] `SPEC.md` 1.28:
  - Update the version in the header.
  - Add "Changes in 1.28" above 1.26. Its table names finding P1 and each part's resolution:
    - the page offer: the connection's own setting, one switch;
    - email-and-password sign-up stays closed;
    - Google sign-up is public by design;
    - the project's own Google application, its secret only in the tenant;
    - the connections are declared and checked;
    - test accounts are possible after step B.
    - Add one row each for step A and step B (research R7), and one line on adopting it (quickstart §1–§4).
  - In §11, rewrite SEC-26: Google sign-up is public by design; email and password are closed by `allow_sign_ups` through the connection's "Disable Sign Ups"; Google runs on the project's own application; the connections are declared; block a person in the tenant; the emergency stop `google_sign_in = false` and its cost. Its tests are T-PRT-01, T-PRT-02, T-PRT-19, T-AGT-15 and T-IAC-02.
  - Delete the v1.19 residual risk "A social connection's first sign-in doesn't run the pre-user-registration trigger …" (around line 1800). Add "Residual risks added in v1.28": anyone with a Google account can create a portal user, with no cap on how many, held only by the rate limits and blocking; the emergency stop also stops existing Google people.
  - In §12: new rows T-PRT-19 (portal) and T-AGT-15 (hosted-access); amend T-CTK-01's row (row 5, a Google-shaped person) and T-IAC-02's row (the people's connections, rules 1–8).
  - In §9, add the tenant's variables `google_client_id` and `google_sign_in` wherever the tfvars values are listed.
- [X] T019 [P] [US6] In `specs/007-process-isolation-security/contracts/threat-matrix.md`, give SEC-26 the same text and tests as T018. `SEC_ROWS` in `test/architecture.test.ts` is unchanged. Run `npx vitest run test/architecture.test.ts -t "T-ARCH-TRACE"`.
- [X] T020 [P] [US6] `.specify/memory/constitution.md` 3.0.1 (PATCH):
  - Add a Sync Impact Report entry: version 3.0.0 → 3.0.1, nothing redefined, the residual risk added, templates unaffected.
  - Technology & Scope Constraints gains the two people's connections: email and password, closed by one switch; Google, public by design, on the project's own application with its secret only in the tenant.
  - Update the version line: `**Version**: 3.0.1`, Last Amended 2026-11-24.
- [X] T021 [P] [US6] `auth0/README.md`:
  - **Management API scopes**: add `read:connections`, `update:connections`, `read:connections_options` and `update:connections_options`, and never `create:connections` or `delete:connections` (R10).
  - **The project's Google application**, by hand: quickstart §1, with the secret entered in the Dashboard only.
  - **Step A imports**: contracts/tenant-connections.md's imports table, in an uncommitted `auth0/imports.tf`, as in "Move to a new state".
  - **The variables table**: rows for `google_client_id` and `google_sign_in`, and `allow_sign_ups` narrowed to email and password.
  - **The resources table**: rows for the four connection objects.
  - **"People"**: rewrite it (around lines 105–115):
    - Google sign-up is public by design;
    - what a stranger reaches: their own account only, no agent and no administration;
    - to keep one person out, block them in the tenant;
    - the emergency stop and its cost;
    - email-and-password sign-up is closed by the one switch, and the operator can create users once step B is applied.
- [X] T022 [P] [US6] `CLAUDE.md`:
  - The gotcha "The portal asks for no role and no permission": replace "to keep strangers out, turn sign-ups off on the tenant's connection" with the decision. Google sign-up is public by design, and email and password are closed by `allow_sign_ups`. Block one person in Auth0, and the emergency stop is `google_sign_in = false`.
  - The "Auth0 side" gotchas get these points:
    - the people's connections are declared;
    - Google is read-only, with the client-ID precondition;
    - the Google secret is only in the tenant, and the operator command refuses `*secret*` variables and `GOCSPX-` values;
    - the four connection scopes;
    - an existing tenant imports the three connection objects first;
    - never apply a plan that changes the database connection's password policy.
- [X] T023 [P] [US6] `specs/README.md`: add the 018 row and SPEC 1.28, with traceability for FR-001..FR-020, SEC-26, T-PRT-19, T-AGT-15, T-CTK-01 row 5 and T-IAC-02 rules 1–8.
- [X] T024 [US6] Update `auth0/main.tf`'s header comment (lines 1–17). Add a paragraph on the people's connections (specs/018). Replace "to keep strangers out … (the pre-user-registration Action at the end), or turn sign-ups off on the …" with: Google sign-up is public by design; email and password follow `var.allow_sign_ups` through the database connection; block a person in the tenant; the emergency stop is `var.google_sign_in`. Keep "Closed sign-ups" described as the step A fallback until T037.

**Checkpoint**: step A is complete in the repository.

---

## Phase 8: Rollout step A (merge, then hand steps by the owner and the operator)

**Purpose**: put step A on `main`, set up the Google application, apply, and run the live checks of US1, US2, US3 and US4. The deny Action stays bound throughout, so sign-up is never open (FR-003).

- [X] T025 Run `npm run check`: green, with T001's demo summary unchanged. Run `npx vitest run test/auth0-iac.test.ts test/portal.test.ts test/hosted-access.test.ts test/caller-token.test.ts test/architecture.test.ts`. Scan the diff for secrets (`gitleaks`, or a grep for key patterns and `GOCSPX-`). Then commit with the task and requirement IDs. Open the step A pull request only when the owner says to. `checks (Node 22)` and `checks (Node 26)` and `validate-auth0` must be green before merging. Add a "Validation log" section at the end of `specs/018-tenant-signup-hardening/quickstart.md` for the results of T026–T034.
- [ ] T026 [US3] *Owner*, before step A's plan: do `specs/018-tenant-signup-hardening/quickstart.md` §1.1–§1.2. Create the Google Cloud OAuth client: Web application, redirect URI `https://<tenant>/login/callback` only, consent screen In production, `openid`, `email` and `profile`. Enter its client ID and secret on the tenant's `google-oauth2` connection in the Dashboard. The secret goes nowhere else.
- [ ] T027 [US3] *Owner*: do `specs/018-tenant-signup-hardening/quickstart.md` §1.3 (research R8). One existing Google person signs in again. Their `user_id`, portal user and wallet address must be unchanged, and no second user may appear with their email. If anything changed, put the old setting back and stop the rollout here (spec Assumptions). Then do §1.4: the redirect goes to `accounts.google.com` with the project's client ID and the tenant's callback, never `login.auth0.com`. Log both.
- [ ] T028 *Owner*: add the four connection scopes to the Management API application (`specs/018-tenant-signup-hardening/quickstart.md` §0, research R10). Note the `con_…` IDs of `Username-Password-Authentication` and `google-oauth2`.
- [ ] T029 [US4] *Operator*, on the VPS after the merge: do `specs/018-tenant-signup-hardening/quickstart.md` §2 for both clients (the "before" values), then §3.1–§3.3.
  - Write the three `import {}` blocks in an uncommitted `auth0/imports.tf`, and add `google_client_id` to `~/x402-tfstate/auth0.dev.tfvars`.
  - Plan. Expect three imports, a single database change (`disable_signup`), the lists trimmed to the portal and the agent, and nothing destroyed or replaced.
  - Apply exactly that plan, then delete `auth0/imports.tf`.
  - If the plan shows any other database option changing, stop before applying and do T030.
- [ ] T030 [US1] Only if T029's plan changes another option of `auth0_connection.database`: change that resource's `options` in `auth0/main.tf` to match the tenant. Use the operator's copy of that resource's plan diff, which holds no secret. Commit through a pull request, then repeat T029's plan. Never apply a plan that changes the password policy.
- [ ] T031 [US1] *Operator*: do `specs/018-tenant-signup-hardening/quickstart.md` §2, §3.4 and §3.5, and log the results. Each client lists exactly the two connections, with `"showSignup":false` and `"showForgot":true`. The portal's page has no "Sign up" link, but has "Continue with Google" and "Forgot password". `POST /dbconnections/signup` with a throwaway `example.com` address gets 400, `/u/signup` is refused, and no user is created (SC-001, SC-002).
- [ ] T032 [US4] *Operator*: do `specs/018-tenant-signup-hardening/quickstart.md` §3.6. The plan shows no changes. A connection enabled by hand for L2's client shows in the plan, and apply removes it. A Google client ID changed by hand fails the precondition, and is then put back (SC-007). Log the results.
- [ ] T033 [US3] *Operator*: do `specs/018-tenant-signup-hardening/quickstart.md` §7. `grep -c 'GOCSPX-'` gives `0` for the state and the tfvars file, and the saved plan's output names no `client_secret` (SC-005). Log the result.
- [ ] T034 [US2] *Owner*: do `specs/018-tenant-signup-hardening/quickstart.md` §5.1–§5.3, and log the results:
  - a never-seen Google account signs up and saves a profile in under 3 minutes (SC-003);
  - their run is 403 and `/admin` is refused;
  - after `x402-agent` is assigned and they sign in again, a run pays from their own account;
  - then remove the role.

  Where backchannel approval is on, also do §5.4. If §5.4 fails because L2's client has no connection, do T035.
- [ ] T035 [US4] Only if T034's §5.4 fails because the person's connection isn't enabled for L2's client (research R3, fallback): add `auth0_client.l2.client_id` to both lists in `auth0/main.tf`. Add the exception to T-IAC-02 rule 2 in `test/auth0-iac.test.ts`, keeping the machine-caller mutant. Note it in SEC-26 (`SPEC.md`, `specs/007-process-isolation-security/contracts/threat-matrix.md`) and in `specs/018-tenant-signup-hardening/contracts/tenant-connections.md`. Then plan and apply again.

**Checkpoint**: step A is live and checked. Do not start step B's merge before T031 has passed (research R7).

---

## Phase 9: User Story 5 - The operator adds named test accounts without opening sign-up (Priority: P3)

**Goal**: rollout step B. Remove the deny-all pre-user-registration Action, which refuses the operator's own user creation too, so that test accounts can be made while sign-up stays closed (FR-004, research R1, R7).

**Independent Test**: offline, T-IAC-02 rule 6 with its mutants. Live: quickstart §4. The plan destroys only the Action and its binding. Sign-up is still 400. A named person created in the Dashboard can sign in, while a parallel self-service sign-up is refused (SC-008).

**Depends on**: T031 passed.

### Tests for User Story 5

- [ ] T036 [US5] In `test/auth0-iac.test.ts`, add rule 6 and remove the Action's checks.
  - Remove the `deny_sign_up` entry of `ACTIONS` and its `instance` special case (around line 437).
  - Remove `SIGN_UP_ACTION_FILE`, `SIGN_UP_CLOSED`, `DENY_ONLY` and `signUpActionProblems` (around line 826), and their run cases (around lines 1116, 1133, 1150–1151).
  - Remove the sign-up mutants (around lines 1084–1095).
  - Narrow `SIGN_UPS` to a bool, true by default, now bound by rule 3.
  - Add rule 6: the Actions are exactly `sign_in_time` and `mfa_time`; no `pre-user-registration` trigger appears anywhere in `auth0/`; `auth0/deny-sign-up.js` doesn't exist.
  - Mutants: a pre-user-registration Action and its binding added back; `deny-sign-up.js` restored in the stand-in folder.
  - Update the file's header comment.

### Implementation for User Story 5

- [ ] T037 [US5] Complete step B in `auth0/`:
  - In `auth0/main.tf`, delete the section "Closed sign-ups" (`auth0_action.deny_sign_up` and `auth0_trigger_action.deny_sign_up`), and drop the header comment's step A fallback sentence (T024).
  - Delete `auth0/deny-sign-up.js`.
  - In `auth0/variables.tf`, drop the Action sentence from `allow_sign_ups`.
  - Run `terraform -chdir=auth0 fmt`. T-IAC-02 is green.
- [ ] T038 [P] [US5] Step B's documents:
  - `auth0/README.md`: the Action's resource row (around line 64) and the Actions list (around line 333). Test accounts: quickstart §4.3–§4.4. Create them in the Dashboard while sign-up stays closed, give the administrator a second factor before `x402-admin`, and delete both after the test.
  - `CLAUDE.md`: any mention of the deny Action.
  - `SPEC.md`: "Changes in 1.28", where the step B row becomes done, and T-IAC-02's row (rule 6).
  - `SPEC.md`'s version stays 1.28.
- [ ] T039 [US5] Run `npm run check` (green, demo summary unchanged) and the secret scan, then commit with the task and requirement IDs. Open the step B pull request only when the owner says to.
- [ ] T040 [US5] *Operator*, after the merge: do `specs/018-tenant-signup-hardening/quickstart.md` §4.1–§4.2, and log the results. The plan destroys `auth0_trigger_action.deny_sign_up[0]` and `auth0_action.deny_sign_up[0]` and nothing else. Apply it. `POST /dbconnections/signup` is still 400.
- [ ] T041 [US5] *Owner*: do `specs/018-tenant-signup-hardening/quickstart.md` §4.3–§4.4, and log the results (SC-008).
  - Create a named test person in the Dashboard while someone repeats the self-service sign-up, which must be refused.
  - Create a test administrator: second factor first, then `x402-admin`. They reach `/admin`, and the test person does not.
  - After the pentest, delete both. Neither can sign in, and their ledger entries stay.
  - The accounts' passwords never go in the repository, a file, an issue or chat.

**Checkpoint**: every story is live. Self-service sign-up was never open, and the operator can add people.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T042 [P] Search the repository for text that no longer holds: `deny-sign-up`, `deny_sign_up`, "Sign-ups are closed", "turn sign-ups off", "social connection's first sign-in". Leave the older change-log sections of `SPEC.md` and the earlier specs as history. Fix any live text in `README.md`, `docs/` or `auth0/`.
- [ ] T043 Run `specs/018-tenant-signup-hardening/quickstart.md` §6 (the offline checks) and `npm run check` on `main` after both merges, and log the results. Check that NFR-004's negative results still hold through the existing suites: T-PRT-01 and T-PRT-07, and T-IAC-02's callback and implicit-flow checks.
- [ ] T044 *Owner*: give the report's author the two test accounts out of band, never in the repository, an issue or chat, and ask for P1's retest (SC-009). Note the outcome in `specs/018-tenant-signup-hardening/quickstart.md`'s Validation log.

---

## Dependencies & Execution Order

### Phase dependencies

- Phase 1 before everything.
- Phase 2 (T002–T005) before Phases 3, 5 and 6.
- Phase 4 (US2) depends on Phase 1 only. It can run beside Phases 2, 3, 5 and 6.
- Phase 3 (US1, T007) before Phase 5 (US4): the database list names `auth0_connection.database.id`.
- Phase 5 (US4, T013) before Phase 6 (US3): the precondition sits on `auth0_connection_clients.google`.
- Phase 7 (US6) after Phases 3–6. T019 needs Phase 4's test titles.
- Phase 8 after Phase 7. Within it, the order is T025 (merge), T026–T028 (the owner, any order, but all before T029), T029 → (T030) → T031, T032 and T033, then T034 → (T035).
- Phase 9 (US5) only after T031 has passed. T036 → T037 → T038 → T039 (merge) → T040 → T041.
- Phase 10 last.

### Within each story

The T-IAC-02 rule and its mutants come first, failing; then `auth0/`; then `terraform fmt` and a green suite. A rule's
document change goes in Phase 7, in the same merge.

### Parallel opportunities

- T008, T009 and T010 (three test files), beside any of T002–T018.
- T018–T023 (six different documents).
- T026–T028 (the owner's hand steps), beside T025's review.
- T042 beside T043.
- Not in parallel: T002, T004, T006, T012, T014, T015 and T036 all edit `test/auth0-iac.test.ts`. T005, T007, T013, T018, T024 and T037 all edit `auth0/main.tf`.

### Parallel example: User Story 2

```text
Task: "T008 [US2] T-PRT-19 in test/portal.test.ts"
Task: "T009 [US2] T-AGT-15 in test/hosted-access.test.ts"
Task: "T010 [US2] T-CTK-01 row 5 case in test/caller-token.test.ts"
```

### Parallel example: User Story 6

```text
Task: "T018 [US6] SPEC.md 1.28"
Task: "T019 [US6] threat-matrix.md SEC-26"
Task: "T020 [US6] constitution 3.0.1"
Task: "T021 [US6] auth0/README.md"
Task: "T022 [US6] CLAUDE.md"
Task: "T023 [US6] specs/README.md"
```

## Implementation Strategy

### MVP first (User Stories 1 and 2)

Phases 1–4 give the offline half of the MVP:
- the switch governs the page and the endpoints (US1);
- a role-less Google person is pinned to their own account (US2).

The finding's page inconsistency is fixed only once step A is applied (T029–T031). Step A also needs US4's lists and US3's precondition: the plan imports all three connection objects together. In practice, then, the smallest deployable increment is the whole of step A (Phases 1–8).

### Incremental delivery

| Merge | Stories | Tasks | Live check |
|---|---|---|---|
| Step A | US1, US2, US3, US4, US6 | T001–T025, then T026–T035 by hand | quickstart §1, §2, §3, §5, §7 |
| Step B | US5 | T036–T041 | quickstart §4 |
| After both | none | T042–T044 | quickstart §6, P1's retest |

## Notes

- Commit after each task or small group, with the task IDs and requirement IDs in the message, and tick the task (`- [X]`) in the same commit.
- Never commit a tfvars file, state, plan, `auth0/imports.tf` or any credential. The secret scan runs before each commit (T025, T039).
- If a task turns out wrong or impossible as written, stop on it, say what was found, and carry on with the tasks that don't depend on it. Research R3 and R8 already name the two likely stops: T035 and T027.
- The owner's and the operator's tasks run on systems this session never reaches. Their results come back as log entries, never as secrets.
