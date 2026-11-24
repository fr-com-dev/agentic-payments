# Research: Sign-Up Hardening for the Sign-In Tenant (018)

All sources were read on 2026-11-23/24. The Terraform provider's files come from tag v1.60.0 of
`auth0/terraform-provider-auth0`, the version pinned in `auth0/.terraform.lock.hcl`. Where a fact comes from Auth0's
support knowledge base, the provider's source code or an inference, rather than the documentation, it says so.
Nothing here signed in anywhere or called the tenant.

## R1. How email-and-password sign-up is closed: the connection's own "Disable Sign Ups"

- **Decision**: Close self-service email-and-password sign-up with the database connection's own option,
  `disable_signup`, set from the existing switch (`disable_signup = !var.allow_sign_ups`). This needs the
  connection to be declared in `auth0/`. Remove the pre-user-registration Action `deny-sign-up.js`, in a second
  step (R7).
- **Rationale**:
  - The option refuses sign-up "using public endpoints" (Auth0, database connection settings; Lock configuration:
    "to fully prevent new users from signing up, you must use the Disable Sign Ups option").
  - Universal Login then shows no "Sign up" link, provided every database connection enabled for the application
    has it on (support KB "Signup has been disabled but it is still showing on Login": "signup needs to be
    disabled on all of them"). The tenant has one database connection. This is the page fix (FR-001), and it
    comes from the same setting as the refusal (FR-002).
  - The operator can still create users from the Dashboard and the Management API. The documentation implies
    this ("public endpoints") but never says it outright. `auth0/README.md` already states it. The live check
    confirms it (quickstart §4).
  - The Action can't do what FR-004 needs. Auth0's trigger runs for `POST /api/v2/users` and for the Dashboard
    (custom user ID page: "The Management API's Create a user endpoint (POST /users)"; support KB: the Dashboard
    "uses the Management API to create users"). Its deny-all code therefore refuses the operator too. No event
    field reliably tells a Management API creation from a direct `/dbconnections/signup` call: both lack
    `event.transaction` (support KB "block signups via API while allowing signups via Universal Login").
  - The Action covered passwordless connections too. The tenant has none, and the declaration and the live check
    keep it that way (R5, quickstart §2).
- **Alternatives considered**:
  - Keep the Action and add a bypass for the operator. Rejected: there is no reliable field to bypass on, and a
    guessable bypass would reopen sign-up.
  - Keep the Action and also set "Disable Sign Ups" by hand. Rejected: that is two settings (against FR-002), and
    the operator still couldn't add a person (FR-004).
  - Hide the link with a custom login page template. Rejected: it hides the offer without refusing the endpoint,
    and it is a second setting.

## R2. Declaring the database connection without resetting it

- **Decision**:
  - Declare `auth0_connection.database`: the existing `Username-Password-Authentication`, strategy `auth0`.
  - Bring it in with an `import {}` block, then state its current options explicitly. The first plan after import
    must show `disable_signup` as its only change.
  - Add `prevent_destroy`.
  - Write no `configuration`, `custom_scripts` or password values. `password_policy` and similar settings are not
    passwords.
- **Rationale**:
  - The resource replaces the whole `options` object on update. The provider's docs say to "ensure that all nested
    fields within the options schema are explicitly defined". The Management API says "the entire options object
    is overridden". An options block that leaves things out could reset the password policy or brute-force
    protection.
  - Destroying the connection would delete every email-and-password person, the owner's test accounts included.
  - Amended 2026-11-24, after the first plan against the dev tenant. The declaration had stated a default
    connection's legacy password fields (`password_policy = "good"`, `password_complexity_options` with a minimum
    of 8, `password_history`, `password_dictionary`, `password_no_personal_info`). The plan showed the tenant on
    Auth0's flexible password policy instead (`password_options`: a minimum of 15 characters, all character types,
    the `en_100k` dictionary off, a history of 3 off, the profile-data check off), with `authentication_methods`
    and `passkey_options` set. The provider "cannot" set `password_options` "together with legacy password policy
    fields", so the plan was not applied (T030). The declaration now writes `password_options`,
    `authentication_methods` and `passkey_options` exactly as the tenant has them, and T-IAC-02 fails on any legacy
    password field. `authentication_methods.password.signup_behavior` stays `"allow"`, as the tenant has it:
    `disable_signup` is the one switch (R1), and quickstart §3.5 checks the refusal live.
- **Alternatives considered**:
  - Leave the connection out of Terraform and set the option by hand. Rejected: it breaks FR-002 and FR-018, and
    the drift that produced finding P1 would stay invisible.

## R3. Which applications may use each connection: `auth0_connection_clients`

- **Decision**:
  - Declare `auth0_connection_clients.database` and `auth0_connection_clients.google`. Each has
    `enabled_clients = [portal, agent]`. Google's is empty when `var.google_sign_in` is false (R6).
  - Bring both in with `import {}` blocks, keyed by the connections' IDs.
  - Never use the singular `auth0_connection_client`.
  - L2's approval client and the machine callers get no connection.
- **Rationale**:
  - The resource is authoritative (provider source `resource_clients.go`). Read stores the connection's full client
    list, so a client enabled by hand shows as drift (FR-018). Update disables clients dropped from the set.
    Create fails on a connection that already has clients ("Import the resource instead"), hence the imports.
  - It needs only `connection_id`. It stores only `id`, `connection_id`, `name`, `strategy` and `enabled_clients`
    (`flattenConnectionClients`), so nothing secret reaches the state. The docs say not to combine it with the
    singular resource on one connection.
  - **L2's approval client and CIBA**: none of Auth0's three CIBA pages requires the person's connection to be
    enabled for the CIBA application. They require a `login_hint` in `iss_sub` form, a first-party confidential
    client, and the person enrolled in push. Leaving L2's client without connections is least privilege. CIBA
    also needs "an Enterprise Plan or an appropriate add-on", and dev is on the free plan. Where backchannel
    approval is on, its live check (`specs/012` quickstart §5) runs after the apply (quickstart §5 here). If Auth0
    then refuses because the person's connection isn't enabled, L2's client is added to both lists, with a
    T-IAC-02 exception and a note in SEC-26. L2's grant type (CIBA only) still prevents it from signing anyone in
    interactively.

## R4. The project's own Google application, with its secret only in the tenant

- **Decision**:
  - The owner creates a Google Cloud OAuth client of type "Web application". Its only authorized redirect URI is
    `https://<tenant domain>/login/callback`, its JavaScript origin `https://<tenant domain>`. Its consent screen
    is "In production" with the scopes `openid`, `email` and `profile` only.
  - The owner enters its client ID and secret on the tenant's `google-oauth2` connection by hand, in the
    Dashboard.
  - Terraform never writes that connection's options. It reads them through `data "auth0_connection" "google"`
    with `hide_client_secret = true` and `skip_enabled_clients = true`.
  - A precondition requires `var.google_client_id != ""` and `options[0].client_id == var.google_client_id` (read
    with `try()`). That variable is the project's Google client ID; it is not a secret, and it lives in the tfvars
    file. A tenant still on Auth0's developer keys (no client ID), or one pointed at another Google application,
    fails the plan. The non-empty test matters: on developer keys both sides would be empty, and equal.
- **Rationale**:
  - Developer keys "are meant strictly for testing" and "should not be used in production". Single Sign-On, MFA,
    `prompt=none` and federated logout don't work properly with them. The consent screen "may display Auth0's name,
    logo, and information" (Auth0, devkeys).
  - The secret stays out of everything the project holds (FR-008, NFR-001):
    - Managing the connection with `auth0_connection` would store `client_secret` in state: `flatten.go` writes it
      from the API's answer.
    - Its write-only variant `options_client_secret_wo` (provider 1.57.0) is resent on every apply, so the operator
      would have to keep the Google secret on the host.
    - The data source stores the secret "as an empty string" with `hide_client_secret` (provider 1.56.0).
  - A precondition stops a plan; a `check {}` block would only warn. A tenant on developer keys is the finding,
    so the plan refuses to go on until it is fixed (FR-018).
  - Google requires no verification for `openid`, `email` and `profile`. An app "In production" is "available to
    any user with a Google Account". A test-mode app would allow 100 test users. The 7-day expiry does not apply
    to the basic scopes (Google Cloud help, answers 13463073 and 15549945). Without brand verification, Google
    shows "only your application domain", not the app's name (answer 15549049).
    - So the consent screen isn't reliable evidence of whose app is used. The evidence the live check reads is
      the redirect to `accounts.google.com` after `/authorize?connection=google-oauth2`.
    - With the project's app, that redirect carries `client_id=<var.google_client_id>` and
      `redirect_uri=https://<tenant domain>/login/callback`.
    - With developer keys, Auth0's apps "call back to the URL `https://login.auth0.com/login/callback`".
    - This last step is an inference from that documented callback, not a check Auth0 documents. It reads only
      public values and signs no one in.
  - Auth0's Google page says Google "limits it to 100 logins until the OAuth consent screen is verified". Google's
    own pages tie that cap to sensitive or restricted scopes. If dev hits it anyway, brand verification is the
    owner's next step. That doesn't change this design.
- **Alternatives considered**:
  - `auth0_connection` with the write-only secret. Rejected: a second long-lived secret on the operator's host,
    and the state still risks holding it through `flatten.go`.
  - A `check {}` block with the `hashicorp/http` provider, reading the redirect at plan time. Rejected: a new
    provider, for a check the precondition and the live check already make.
  - No check, by hand only. Rejected: it breaks FR-018.

## R5. Exactly two people's connections

- **Decision**:
  - T-IAC-02 allows exactly one `auth0_connection` (`database`), one `data "auth0_connection"` (`google`) and two
    `auth0_connection_clients` (`database`, `google`).
  - Nothing else may name a connection: no third connection, no singular `auth0_connection_client`, and no
    `enabled_clients` naming `auth0_client.l2` or `auth0_client.machine`.
  - The live check also reads the public client settings of the portal's and the agent's applications. That is
    the report's own step 1: `https://<tenant>/client/<client ID>.js`, which needs no credential. Each must list
    exactly the two connections, the database one with `showSignup: false` while closed.
- **Rationale**: Terraform sees only what it declares. A connection created by hand in the Dashboard would never
  show in a plan. The public client settings show every connection a client can sign in through, so the live check
  covers what the plan can't.

## R6. The emergency stop for new Google accounts

- **Decision**: Add a new bool `var.google_sign_in`, default `true`. When it is `false`, Google's `enabled_clients`
  is empty. The operator sets it in the tfvars file, then plans and applies.
- **Rationale**: Terraform now owns Google's enabled clients. A change made by hand in the Dashboard would show
  as drift and be undone by the next apply. So the stop must be declared. It also stops existing Google people from
  signing in, which is the cost FR-020 says to document.
- **Alternative considered**: A post-login Action that refuses first sign-ins (`event.stats.logins_count`).
  Rejected: Auth0 creates the user before post-login runs, the condition is easy to get wrong, and an emergency
  stop needs no precision.

## R7. Rolling out without a sign-up window or a lock-out

- **Decision**: Roll out in two steps, each its own merge to `main` and its own plan and apply.
  - **Step A** declares the connections, binds `disable_signup` to the switch, and adds the Google precondition.
    The deny Action stays bound.
  - **Step B**, once step A's live check passes, removes the Action and its binding.
  - The Google application is set up by hand before step A's plan (quickstart §1), because the precondition
    needs it.
- **Rationale**:
  - In one apply, Terraform may delete the Action's binding before it updates the connection: they don't depend
    on each other. That would leave a short window with self-service sign-up open, against FR-003.
  - Doing the Google setup first means existing Google people move to the new app before Terraform requires it,
    so they never meet a broken sign-in (NFR-002).

## R8. Existing Google people keep their account

- **Decision**: Switch credentials once, by hand, and verify with one existing Google person. After their next
  sign-in, their Auth0 user ID must be unchanged and no second user may appear. Only then go on with step A.
- **Rationale**:
  - Google's `sub` is "unique among all Google Accounts and never reused". Google publishes
    `subject_types_supported: ["public"]`, which OpenID Connect Core §8 defines as "the same sub (subject) value
    to all Clients".
  - Auth0's user ID is `{identity provider id}|{unique id in the provider}`, so it stays `google-oauth2|<sub>`.
    The portal user is derived from issuer and subject, so it stays too.
  - Auth0's documentation never says outright that the existing user is matched again; community answers say it
    is. That is why the one-person check comes before anything else depends on the switch.
- **If it fails**: stop and put the old credentials back. The owner then decides how to move those people
  (spec Assumptions).

## R9. The variables file must not carry the Google secret

- **Decision**: The operator command's `check_tfvars` refuses three things:
  - any variable whose name contains `secret`, which widens today's list;
  - a value that looks like a Google client secret (the `GOCSPX-` prefix);
  - a private key, as today.

  T-IAC-02's script checks get a must-fail case for each.
- **Rationale**: The secret goes into the tenant through the Dashboard only (R4). The variables file is the one
  place on the operator's host where someone would be tempted to put it.

## R10. The Management API application's scopes

- **Decision**: Add these scopes:
  - `read:connections`, `update:connections`;
  - `read:connections_options`, `update:connections_options`.

  Don't add `create:connections` or `delete:connections`.
- **Rationale**:
  - `auth0_connection_clients` needs `read:connections` and `update:connections` (`GET` and `PATCH
    /connections/{id}/clients`).
  - Reading and updating a connection's options needs the `*_options` scopes as well (Management API reference).
  - Import, update and the data source need no `create` or `delete`. Without those two, a plan that would create or
    replace a connection fails at the API too, beside `prevent_destroy`. That matters because the tenant's
    connections hold people's accounts.

## R11. What a first Google sign-in gives a person

- **Decision**: No change to any service. Tests T-PRT-19 and T-AGT-15 pin the behavior for a person with a
  Google-shaped subject and no permission (`contracts/new-person-access.md`).
- **Rationale**:
  - The pre-user-registration trigger runs only for "a Database or Passwordless connection". Auth0's support article
    says plainly: with any other connection "the Action can not trigger", and the user is still created.
  - Post-login runs "including authentication after signup". So `sign-in-time.js` and `mfa-time.js` run, and they
    assign nothing.
  - The tenant assigns no role (T-IAC-02, NOBODY_ASSIGNED). So the person gets a token with no permission. Using
    the portal needs none (R21), and the agent and the administration area refuse it (016, 014).
  - The existing tests use `dev|…` and `auth0|…` subjects. The new ones use `google-oauth2|<21 digits>` and an
    email address that another person's `auth0|…` account also has. Nothing reads a token's email to find a user
    (FR-016).

## R12. Documents and versions

- **Decision**:
  - SPEC goes to 1.28. "Changes in 1.28" names finding P1 and each part of its resolution.
  - SEC-26 is rewritten, here and in the threat matrix (`specs/007` contracts/threat-matrix.md). It now says Google
    sign-up is public by design, email-and-password sign-up is closed by the switch through the connection's own
    setting, the Google application is the project's own, the connections are declared, and how to block a person
    and the emergency stop. Its tests become T-PRT-01, T-PRT-02, T-PRT-19, T-AGT-15 and T-IAC-02.
  - The v1.19 residual risk on social first sign-ins is replaced by a v1.28 one: anyone with a Google account can
    create a portal user, with no cap on how many.
  - T-IAC-02's row and §13 follow.
  - The constitution goes to 3.0.1 (PATCH). Technology & Scope Constraints gains the two people's connections,
    and the residual risk is added. No principle or section changes.
  - `CLAUDE.md`, `auth0/README.md` and `specs/README.md` follow.
- **Rationale**: SEC-26 already owns this threat, so a new row isn't needed. The architecture test's SEC_ROWS stops
  at SEC-34 and lists SEC-26, so T-ARCH-TRACE then requires T-PRT-19 and T-AGT-15 to exist as test titles.
