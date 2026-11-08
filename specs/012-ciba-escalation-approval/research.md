# Research: Backchannel Approval of Escalated Payments (CIBA with Auth0)

Phase 0 for `specs/012-ciba-escalation-approval`. The decisions below are grounded in four sources:
- the current L2 code (`src/layer2-control/{service,escalations,approval-routes,ledger}.ts`);
- SPEC.md v1.7;
- the clarified spec;
- Auth0's documentation as of 2026-11-07.

Auth0 facts are cited by key (list at the end). Facts that Auth0 does not document, and that the live
check in [quickstart §5](quickstart.md#5-live-check-against-a-real-auth0-tenant-manual) must confirm,
are marked **(live check)**.

## R1. Protocol and endpoints

- **Decision**: OpenID CIBA in **poll mode** against the configured Auth0 tenant, with three fixed
  issuer-relative HTTPS endpoints. There is no OIDC discovery.
  - `POST {issuer}bc-authorize`, form-encoded [A][B], with:
    - `scope=openid`;
    - `login_hint={"format":"iss_sub","iss":"{issuer}","sub":"{approver}"}`;
    - `binding_message`;
    - `audience`;
    - `requested_expiry`;
    - `authorization_details` (a JSON string);
    - client authentication (R3).

    It returns `auth_req_id`, `expires_in` and `interval`.
  - `POST {issuer}oauth/token` with `grant_type=urn:openid:params:grant-type:ciba`, `auth_req_id`
    and client authentication [C].
  - `GET {issuer}.well-known/jwks.json`, through jose's `createRemoteJWKSet` (cached, refetched on an
    unknown `kid`) [O].
- **Rationale**:
  - Poll mode is the only mode that needs no inbound route (FR-010). Ping and push are out of
    scope.
  - Fixed paths derived from the issuer keep every outbound call on one host (NFR-004).
  - With no discovery, a tampered discovery document can't redirect the token or key endpoints.
  - `offline_access` is not requested, so no refresh token is ever issued.
- **Alternatives considered**:
  - OIDC discovery: one more fetch, and trust in a document that can name other hosts.
  - Ping mode: needs a public callback on the signer's host.

## R2. Auth0 SDK or plain HTTPS

- **Decision**: plain `fetch` plus `jose` (already a dependency). No Auth0 package.
- **Rationale**:
  - The flow is two form POSTs and one JWT verification, about 200 lines of code.
  - `auth0` 7.x dropped the backchannel client from its main entry point [S].
  - `@auth0/auth0-auth-js` (1.18.0) would work, but its errors carry the OAuth `error_description`
    in `.cause` [Q]. NFR-003 and NFR-006 forbid that text anywhere, so every error path would need
    wrapping.
  - With plain fetch, L2 reads only the `error` code and maps it to a fixed list (R10). No library
    object holding a token or Auth0 text can reach a log.
  - It keeps L2's image closure small (T-IMG-01) and needs no new pin in SPEC §5.
- **Alternatives considered**:
  - `@auth0/auth0-auth-js`: a new dependency, and the error text is hard to contain.
  - `@auth0/ai`'s `withAsyncAuthorization`: client secret only, and built for agent tools, not a
    signer [T].

## R3. Client authentication

- **Decision**: `private_key_jwt` with RS256 is preferred: an RSA key of 2048 to 4096 bits in
  PKCS#8 PEM, in `CIBA_CLIENT_KEY`, with an optional `kid` in `CIBA_CLIENT_KEY_ID`. A client secret,
  `CIBA_CLIENT_SECRET` sent with `client_secret_post`, is the fallback for tenants without that
  method. Exactly one of the two must be set.
  - **The assertion** carries `iss` and `sub` = the client ID, `aud` = the issuer (with its trailing
    slash), a random `jti`, `iat`, and `exp` = `iat` + 60 s. It is fresh for every call [J][K].
- **Rationale**:
  - Auth0 accepts RS256, RS384 or PS256 for `private_key_jwt`, never ES256, and offers the method on
    the Enterprise plan only [K][L].
  - CIBA itself is also sold as an add-on on Essentials and Professional [L], so a tenant without
    the Enterprise plan needs the secret fallback.
  - The spec prefers the key, so no shared secret leaves L2's vault, and the quickstart recommends
    it.
  - Both credentials are confined to `ciba-client.ts` by rule A9 (FR-030).
- **Alternatives considered**:
  - mTLS: needs a client certificate and the CA headers Auth0 expects [C], plus more Azure plumbing.
  - Key only: excludes tenants on the add-on plans.

## R4. What the approver sees

- **Decision**: two layers, carrying the same values.
  1. **`authorization_details`**: exactly one object of type
     `urn:auth0:schemas:authorization-details:v1:x402-payment`, with a fixed `instruction` and
     `properties` keyed by field name. Each property is `{display, name, display_order, value}`.
     - Displayed: amount in USDC, payee, resource, network and reference.
     - Hidden: escalation ID, request ID, atomic amount, asset and requirement digest.

     That is 10 properties [D].
  2. **`binding_message`**, e.g. `Pay_0.05_USDC_to_0x95Ac..f057_for_premium-report_#3f9c2a1b`.
     It is at most 64 characters, from `A–Z a–z 0–9 + - _ . , : #` only, with no spaces and no `/`
     [A][G].

  The exact layout is in [payment-details](contracts/payment-details.md).
- **Rationale**:
  - The stock Guardian app renders `authorization_details` only in Auth0's own schema, and only
    when the array holds exactly one object [D]. A plain custom type is shown only by custom
    consent prompts or Guardian-SDK apps [D].
  - The spec's fallback rule (Assumptions) still applies: if Guardian shows only the message, the
    message alone carries the amount, a short payee, the last resource segment and the reference
    code (SC-002).
  - The reference code is the first 8 hex digits of the escalation's UUID. It is visibly the start
    of the `authorizationId` that the operator views and the agent's ESCALATED report already show
    (US1).
  - The type must be registered on the Auth0 API, with `consent_policy: "standard"`. CIBA is not
    supported with `transactional-authorization-with-mfa` [D].
- **Alternatives considered**:
  - A flat custom type (`x402_payment` with ten string fields): simpler, but Guardian would not
    display it.
  - The message only: it can't carry the full payee address, the asset or the digest.

## R5. Which answer proves the approval

- **Decision**: L2 verifies the **access token** from the token response.
  - **How**: jose's `compactVerify` checks the signature (`RS256` only), `decodeJwt` reads the
    claims, and L2's own code checks each claim, with a 60 s clock tolerance.
  - **Why separate steps**: each check can then be switched off on its own for a must-fail proof
    (Constitution VIII).

  These checks run in this order, and the first failure names `check`:
  1. `malformed`: the JWT is unparseable or a required claim is missing;
  2. `signature`: the signature does not verify against the issuer's JWKS;
  3. `issuer`: `iss` ≠ the configured issuer (exact, trailing slash included);
  4. `audience`: `aud`, a string or an array (it can include `/userinfo` [P]), does not contain
     the configured audience;
  5. `client`: `azp` (Auth0 profile) or `client_id` (RFC 9068 profile) ≠ the configured client ID;
  6. `expired`: `exp`, `nbf` or `iat` is outside the tolerance;
  7. `approver`: `sub` ≠ `CIBA_APPROVER`;
  8. `request`: the details' `request_id` is not the open request L2 recorded for this escalation;
  9. `details`: the details are not canonically equal to the ones L2 sent;
  10. `replay`: the answer ID was already used by an earlier `HUMAN_APPROVAL`.
- **Where the details come from**: the token's `authorization_details` claim when present.
  - Otherwise, the token response's `authorization_details`. That body is unsigned, but it comes
    from the same TLS-authenticated token endpoint, as the answer to L2's own client-authenticated
    poll of the handle it recorded for this escalation.
  - The evidence records which source was used (`detailsSource: "token" | "response"`).
  - Auth0 lists `authorization_details` as a RAR claim of its access tokens [H], and RFC 9396
    recommends it [N]. Whether the CIBA access token carries it is **(live check)**.
- **The answer ID** is the token's `jti` when present (RFC 9068 profile), otherwise
  `sha256:<hex of the token>`. The Auth0 profile has no `jti` [H]. A digest identifies the answer
  without storing it (FR-025, NFR-003).
- **Rationale**:
  - The ID token carries no `authorization_details`, and only the access token is meant for the
    resource server, which L2 is here.
  - The replay check stops one approval from approving two escalations even if the transport is
    compromised.
- **Alternatives considered**:
  - Verifying the ID token: it can't prove the payment details.
  - Requiring the claim in the token: safer if Auth0 includes it, but unusable if it doesn't. The
    fallback is recorded and visible in the audit trail. The risk is recorded in SPEC §11 (SEC-17).

## R6. The bounded wait and the second decision

- **Decision**: `POST /v1/authorize` becomes three steps; only the first and the last take the
  mutex.
  1. **First decision** (serialized): `decideOnce(intent)`, today's steps 1–6. A new escalation
     records its eligibility on `ESCALATED` (R9).
  2. **Wait** (no lock), only when the escalation's `approvalRequest` is `requested`. The handler
     starts the request and waits up to `BACKCHANNEL_WAIT_MS` = 120 000 for any final state. Three
     things wake it:
     - **the ledger's append listener**, on a final-state entry for this escalation, or on
       `APPROVAL_REQUEST_FAILED` or `APPROVAL_REQUEST_LAPSED` for it;
     - **a timer**, at the deadline;
     - **an abort signal**, when the response's `close` event fires before the response is sent.
  3. **Re-evaluation** (serialized), only for `approved` or `denied` with the caller still
     connected: `decideOnce(intent, { reevaluation: true })`. It appends a second `INTENT` with the
     same `intentId` and one outcome. It never starts a request or waits. If it escalates again,
     the `ESCALATED` records `approvalRequest: "reevaluation"`.
- **Rationale**:
  - It is the clarified answer (FR-016–FR-019).
  - Holding the mutex for 120 s would freeze every other payment (NFR-005).
  - The second section re-checks everything at signing time (INV-8, INV-12, FR-013). A budget
    that changed during the wait yields DENIED.
  - An `expired` final state never re-evaluates. Re-evaluating would open a second escalation
    behind the agent's back.
  - The append listener is an in-memory observer of entries written through `append`, the only
    write path. It changes nothing about the chain, so INV-9 is untouched.
- **Alternatives considered**:
  - Polling the ledger every 100 ms during the wait: wasteful, and slower to notice operator
    decisions.
  - A separate event bus fed by each writer: every writer (approve, reject, sweep, backchannel)
    would need to remember to notify it.

## R7. Refusal or lapse

- **Decision**: L2 records each request's own deadline when it is sent: `requestExpiresAtMs` =
  `sentAt` + `expires_in` × 1000, capped at the escalation's `expiresAtMs`.
  - **`access_denied`** received at least 5 000 ms before `requestExpiresAtMs`: a denial, so
    `HUMAN_REJECTION { channel: "backchannel" }`.
  - **`access_denied`** received later: a lapse, `APPROVAL_REQUEST_LAPSED { cause: "late_refusal" }`.
  - **`expired_token`**: `APPROVAL_REQUEST_LAPSED { cause: "expired" }`.
  - **No answer by `requestExpiresAtMs`**: the poll loop records `APPROVAL_REQUEST_LAPSED
    { cause: "expired" }` and stops.
  - **After a lapse**, the escalation stays pending until its own 300 s window ends, then expires
    through the sweep (FR-015).
- **Rationale**: Auth0 describes `access_denied` as "denied … or it has been expired" [A][C], and
  may never send `expired_token`. The spec fixes the 5 s rule (Edge cases).
- **The rejection's identity**: an `access_denied` answer is an unsigned error response. The
  rejection therefore records the approver it was addressed to (`CIBA_APPROVER`), the issuer and
  the `requestId`, with no token evidence.
  - This is safe because a refusal can only make L2 more restrictive (NFR-001).
  - It reached L2 over its own client-authenticated TLS connection to the configured issuer.
  - This is how FR-025's "verified identity" applies to a refusal; data-model.md states it.
- **Alternatives considered**:
  - Treating every `access_denied` as a denial: a lapsed request would block the purchase for good
    through R15.
  - Treating every `access_denied` as a lapse: a real "no" would be lost.

## R8. Resuming after a restart without storing the handle

- **Decision**: `APPROVAL_REQUESTED` stores `handleSealed`, which is `auth_req_id` encrypted with
  AES-256-GCM, never the handle itself.
  - **Key**: HKDF-SHA256 over the client credential's bytes (the key's PKCS#8 DER, or the secret),
    with salt `x402/ciba/handle/v1` and info `issuer|clientId`.
  - **Associated data**: `escalationId|requestId`.
  - **Format**: `v1.<iv b64url>.<ciphertext b64url>.<tag b64url>`.

  Only `ciba-client.ts`, the credential's module, can open it. On restart, `resume()` reopens every
  open request and goes back to polling. A handle that won't open (the credential rotated) records
  `APPROVAL_REQUEST_FAILED { failure: "unrecoverable" }`.
- **Rationale**: this reconciles three requirements:
  - FR-012 and FR-026: resume from the ledger, recording whatever resuming needs;
  - NFR-003 and SC-008: no request handle in the ledger;
  - INV-9: no store but the ledger.

  The ciphertext is useless without L2's credential, which never leaves L2's vault.
- **The crash window**: an escalation marked `requested` with no request entry means L2 died
  between the two sections, possibly after Auth0 notified the approver. Resume records
  `APPROVAL_REQUEST_FAILED { failure: "interrupted" }` and never resends. The approver is asked at
  most once per escalation (US6).
- **Alternatives considered**:
  - The plaintext handle in the ledger: violates NFR-003.
  - A side file: violates "only the ledger".
  - Not resuming: violates FR-012.

## R9. Where the cap is counted

- **Decision**: the first serialized section decides eligibility and writes it on the new
  `ESCALATED` entry, as `data.approvalRequest`:
  - `requested`: eligible and under the cap;
  - `capped`: 10 entries marked `requested` in the trailing 3 600 000 ms;
  - `operator_only`: the intent asked for it;
  - `reevaluation`: escalated by a second decision.

  When the feature is off, the field is absent, so the off path writes exactly what it writes
  today. The cap counts `requested` marks, whether or not the start later failed.
- **Rationale**:
  - Counting inside the mutex is race-free: two simultaneous escalations at a count of 9 can't both
    pass.
  - It is ledger-derived (FR-008, INV-7), and it records that the cap applied, on the entry that
    shows it.
  - Counting attempts rather than successes is conservative: never more than 10 notifications.
  - **Must-fail**: `approvalRequestCap: Infinity` (test-only) sends 11.
- **Alternatives considered**:
  - Counting `APPROVAL_REQUESTED` entries: they are written after a network call, so concurrent
    escalations could all pass the check before any of them is written.
  - An in-memory counter: violates INV-7, and is lost on restart.

## R10. Starting a request: retries and failure classes

- **Decision**: `start()` makes up to 3 attempts.
  - **Timing**: the first attempt goes at once, which meets SC-001's 2 s. After a transient
    failure it waits `START_RETRY_DELAYS_MS` = `[250, 1000]` before the second and third attempts.
  - **Timeout**: each attempt has a 1 500 ms timeout (`START_ATTEMPT_TIMEOUT_MS`).
  - **Worst case**: a hanging service ends the start after 1.5 + 0.25 + 1.5 + 1.0 + 1.5 = 5.75 s.
    That is FR-018's "within 6 seconds".
  - **Polls**: each poll has a 5 s timeout, because nothing waits on a single poll.

  Each failure is classified:
  - **transient** (retried):
    - a network error;
    - a timeout;
    - HTTP 429 or 5xx;
    - a body that is not JSON.
  - **permanent** (no retry): any 4xx with an OAuth `error`, for example `unknown_user_id`,
    `unauthorized_client`, `invalid_client`, `invalid_request`, `invalid_scope`,
    `invalid_binding_message` or `invalid_authorization_details`.

  Only these are ever stored or logged:
  - the category: `unreachable`, `transient`, `permanent`, `interrupted` or `unrecoverable`;
  - the HTTP status;
  - the OAuth `error` code, if it is on the fixed list in
    [auth0-ciba](contracts/auth0-ciba.md#error-codes); any other value becomes `other`.

  `error_description`, `error_uri` and every other body field are dropped unread (NFR-003,
  NFR-006). Retries stop when the escalation stops being pending.
- **Rationale**:
  - FR-009 asks for 3 attempts and no retry on a permanent refusal.
  - A disabled or unenrolled approver is a permanent refusal (Edge cases).
  - Auth0 rate-limits at 500 requests per minute per tenant [F], so 3 attempts can't trip it.
- **Alternatives considered**:
  - Exponential backoff over minutes: misses SC-001, and the operator is the fallback anyway.

## R11. Polling cadence

- **Decision**: the first poll comes `interval` seconds after the start (5 if absent).
  - On `authorization_pending`, wait `interval` again.
  - On `slow_down`, set `interval` = max(the returned `interval`, current + 5) [C][M].
  - Never poll sooner than `interval`, and never with two polls for the same request in flight.
  - Transient errors (network, timeout, 429, 5xx) wait `interval` × 2, capped at 30 s, and continue
    until `requestExpiresAtMs`.
  - The loop stops before any poll if the escalation is no longer pending. That covers an operator
    decision or an expiry; the request is then abandoned and nothing is recorded.

  The interval → milliseconds mapping is injectable (`pollDelayMs`), so tests run in milliseconds,
  and the "never faster" test checks the real mapping with an injected sleep.
- **Rationale**: FR-011 and the edge case "The approval service asks L2 to poll more slowly".
- **Alternatives considered**:
  - A fixed 1 s poll: breaks Auth0's interval and invites `slow_down`.

## R12. The operator-only intent field

- **Decision**: `PaymentIntent.operatorApprovalOnly?: boolean` (§7).
  - **L2**: a non-boolean value is 400, like other malformed intents; only `true` changes anything.
  - **L1**: `OrchestratorDeps.operatorApprovalOnly` is copied into every intent that orchestrator
    builds. `src/main.ts` sets it for `--scripted`, which covers the local demo, T-E2E-01 and the
    cloud job `caj-l1-eastus2-dev`.
  - **Hosted agent**: the composition never sets it, and no tool schema has the field.
  - **Ledger**: the field is not copied into `INTENT`. `ESCALATED.approvalRequest: "operator_only"`
    records its effect.
- **Rationale**:
  - FR-007: the field can only remove an approval path. An untrusted L1 setting it can only make
    things more restrictive.
  - Putting it on the orchestrator, not on `fetchPaid`'s arguments, keeps it out of the tools'
    reach (FR-031).
- **Alternatives considered**:
  - A per-session L2 setting: L2 has no session registry.
  - Detecting the scripted plan by its URLs: brittle.
  - A header: not part of the §7 contract, and invisible in the OpenAPI schema.

## R13. Ledger shape

- **Decision**: four new entry types, plus new fields on existing types, as listed in
  [data-model](data-model.md):
  - new types: `APPROVAL_REQUESTED`, `APPROVAL_REQUEST_FAILED`, `APPROVAL_REQUEST_LAPSED` and
    `APPROVAL_VERIFICATION_FAILED`;
  - new fields: `approvalRequest` on `ESCALATED`, `channel` (+ `evidence`) on `HUMAN_APPROVAL`,
    and `channel` on `HUMAN_REJECTION`.

  New operator decisions also carry `channel: "operator"`, and an entry without `channel` reads as
  `operator`. A second `INTENT` with the same `intentId` is allowed only after a wait (FR-017).
  "Every `INTENT` is followed by exactly one outcome entry" still holds per `INTENT`.
- **Rationale**:
  - INV-9: new facts are new types, or fields on entries written from now on; no rewrite.
  - Writing `channel` on operator entries too makes the audit read uniform (FR-024, SC-010).
  - There is no `ABANDONED` entry: a request whose escalation got its final state another way is
    derivable from the ledger.
- **Alternatives considered**:
  - One generic `BACKCHANNEL_EVENT` with a `kind`: harder to whitelist and to test.
  - A `CAPPED` entry type: the cap is a property of the escalation's creation (R9).

## R14. Deployment checks and the approver

- **Decision**:
  - The scripted job (`caj-l1-eastus2-dev`, `--check-baseline`) is operator-only (R12), so it never
    notifies the approver.
  - The hosted smoke step in `deploy.yml` (step 8) asks only for the weather and the market brief,
    both auto-approved. The step gains a check that no step's outcome is `ESCALATED`, so an
    unexpected escalation fails the deploy instead of passing silently.
  - In dev, `ciba.enabled` starts `false` in `main.dev.bicepparam`; the quickstart turns it on.
- **Rationale**: US6 says "automated deployment checks never notify the approver". The hosted agent
  can't be made operator-only (FR-007), so its goal is limited. A notification it did cause becomes
  a visible failure.
- **Residual risk (SPEC §11)**: an LLM run that strays to a priced item above the limit notifies
  the approver once. The cap bounds it at 10 per hour.

## R15. Testing approach

- **Decision**:
  - **Stand-in Auth0.** `test/helpers/ciba-stub.ts` is an `http` server with its own RSA keys and
    JWKS. It serves the three endpoints and records every request. It verifies the client
    assertion against a registered public key and returns scripted answers: approve, deny,
    pending forever, `slow_down`, `expired_token`, late `access_denied`, 429, 503, unreachable,
    and permanent errors. It can also forge answers:
    - another issuer;
    - another audience;
    - another client;
    - a bad signature;
    - an expired token;
    - another `sub`;
    - changed details (amount, payee, escalation);
    - an unknown `request_id`;
    - a replayed token;
    - details in the token or only in the response.
  - **Plain-http issuer.** The stub's issuer is `http://127.0.0.1:<port>/`. `ciba-client.ts`
    accepts an `http://` issuer only through the test-only constructor option
    `allowInsecureLoopback`; `cibaConfigFromEnv` always requires `https://`.
  - **Time.** L2's `now` hook already exists. The wait (`backchannelWaitMs`), the poll delays
    (`pollDelayMs`) and the retry delays are test-only deps, so tests finish in milliseconds. The
    production constants are asserted separately.
  - **Known-value scan.** `scripts/secret-scan-lib.ts`'s pattern is used over the ledger file,
    captured console output, every HTTP response and the operator events, for:
    - the planted client key PEM and secret;
    - every token the stub issued;
    - every `auth_req_id`;
    - a planted `error_description`.
- **Rationale**: the same shape as 009's CDP stub (T-CDP-03..09). Real JWTs and a real JWKS
  exercise jose's verification path, rather than a mock that agrees with itself.

## R16. Configuration and Azure delivery

- **Decision**:
  - **Env** (`env/l2-control.env`, CFG-2): `CIBA_APPROVAL` (`1` on; unset, empty or `0` off);
    `CIBA_ISSUER`, `CIBA_CLIENT_ID`, `CIBA_AUDIENCE` and `CIBA_APPROVER`; one of `CIBA_CLIENT_KEY`
    or `CIBA_CLIENT_SECRET`; and `CIBA_CLIENT_KEY_ID?`.
  - **Validation**: on startup, in this order. Any error names the variable and never its value,
    and L2 exits 1 before it listens.
  - **Off**: when off, any `CIBA_*` variable present logs one warning naming them, as 009 does for
    an unused CDP key.
  - **Azure** (decided 2026-11-08: always present): `main.bicep` gains a `ciba` object parameter,
    `{ enabled, issuer, clientId, audience, approver, credential: 'key' | 'secret', clientKeyId }`.
    `l2-apps.bicep` always sets the `CIBA_*` env from it (`CIBA_APPROVAL` is `1` or `0`), and always references
    `ciba-client-credential` in L2's vault, under `CIBA_CLIENT_KEY` or `CIBA_CLIENT_SECRET` by `credential`.
    - **Why not conditional elements**: they compile `secrets` and `env` into a single ARM expression, which
      T-IAC-01's static rules can't read.
    - **Why not a user-defined type**: it switches the template to `languageVersion` 2.0.
    - **The cost**: every environment seeds the secret, with the placeholder `off` while the feature is off.
      L2 ignores the placeholder while off and refuses it while on.
  - **Seeding**: the secret is seeded by hand, like the payer key: the placeholder in every environment before its
    first L2 deployment with 012, the real key to turn the feature on (quickstart §6).
  - **Outbound**: Container Apps egress is open by default, and no UDR or NSG is added, so L2
    reaches the tenant over HTTPS.
- **Rationale**:
  - FR-002 and FR-003, and CLAUDE.md's rule that every deployed value is in the parameter file
    (T-IAC-01 rule 17).
  - The vault seeding pattern is unchanged, and `infra/` gains no script (T-E2E-AZ). T-IAC-01 keeps reading
    literal arrays, and its new rule 19 checks the credential's path.
- **Alternatives considered**: conditional `secrets`/`env` elements with T-IAC-01 taught to evaluate ARM
  expressions (no placeholder, much more test code); a user-defined type for `ciba` (languageVersion 2.0).
  - L2 makes no network call at startup, so an Auth0 outage can't stop L2 or the payments that need
    no human (NFR-005). A wrong issuer shows up on the first request, as `APPROVAL_REQUEST_FAILED`.

## R17. The Auth0 tenant as code

- **Decision** (2026-11-08): Terraform under a new top-level `auth0/` folder, with the official `auth0/auth0`
  provider pinned to `>= 1.60.0, < 2.0.0` and Terraform `>= 1.11.0`. A tenant administrator applies it by hand,
  with their own Management API application's credentials in the shell (`AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`).
  No pipeline applies it, and no GitHub secret exists for it.
  - **The API** (`auth0_resource_server`): RS256, `token_dialect = "rfc9068_profile"`, a 300 s token lifetime, no
    offline access, `consent_policy = "null"`, one `authorization_details` type, and an access policy: users through
    a client grant only, clients `deny_all`.
  - **L2's client** (`auth0_client`): `regular_web`, first-party, OIDC-conformant,
    `grant_types = ["urn:openid:params:grant-type:ciba"]` only, and
    `async_approval_notification_channels = ["guardian-push"]`.
  - **The grant** (`auth0_client_grant`): `subject_type = "user"` and `authorization_details_types` = the one type.
  - **The credential** (`auth0_client_credentials`): `private_key_jwt` with the public key (RS256), or a
    `client_secret_wo` secret from an ephemeral variable.
  - **Guardian** (`auth0_guardian`): push through the Guardian app, policy `never` by default, and
    `prevent_destroy`.
  - **The approver**: `data.auth0_user`, so a typo fails the plan.
  - **Outputs**: `bicepparam_ciba` (the `ciba` object for the parameter file) and `l2_env`.
- **Rationale**:
  - The user asked for infrastructure as code, and Bicep can't reach Auth0.
  - The provider (1.60.0) covers every object, with these features and the versions that added them:

    | Feature | Since |
    |---|---|
    | `authorization_details`, `consent_policy` | 1.7.0 |
    | `subject_type_authorization` | 1.28.0 |
    | `async_approval_notification_channels` | 1.34.0 |
    | the credentials set | 1.47.0 |
    | `client_secret_wo` | 1.51.0 |
  - **Consent**: the provider refuses `consent_policy = "standard"` and takes the string `"null"`, which
    the Management API reads as standard consent.
  - **Least privilege**: a CIBA-only client, a user-delegated grant, no machine tokens for the API, and no
    secret in state (the public key, or a write-only secret).
  - **Guardian**: it is a tenant-wide singleton whose destruction turns off every factor, hence
    `prevent_destroy` and `manage_guardian`. CIBA needs the push factor, not MFA at login, hence the `never`
    default.
  - **State**: local and gitignored (`auth0/*.tfstate*`, `*.tfvars`, `*.tfplan`), and excluded from the Docker
    build context. It names the tenant but holds no secret.
- **Checked by**: T-IAC-02 (`test/auth0-iac.test.ts`), offline, with must-fail mutants. `terraform fmt -check`
  runs when Terraform is installed; `terraform validate` runs once `terraform init` has downloaded the provider.
- **Unconfirmed (live check)**: that CIBA tokens count as user-delegated for the access policy (`subject_type =
  "user"`); that `"null"` is standard consent; and that `guardian_policy = "never"` still lets CIBA push.
- **Alternatives considered**:
  - The Auth0 Deploy CLI (YAML): another tool and less type checking.
  - A Management API script in `scripts/`: imperative, and hand-written idempotency.
  - Keeping it manual: what the user asked to replace.

## Sources

- [A] https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/user-authorization-with-ciba
- [B] https://auth0.com/docs/api/authentication/login/start-back-channel-login
- [C] https://auth0.com/docs/api/authentication/login/check-back-channel-login-status
- [D] https://auth0.com/docs/get-started/apis/configure-rich-authorization-requests
- [E] https://auth0.com/docs/get-started/applications/configure-client-initiated-backchannel-authentication
- [F] https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow
- [G] https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/mobile-push-notifications-with-ciba
- [H] https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles
- [J] https://auth0.com/docs/get-started/authentication-and-authorization-flow/authenticate-with-private-key-jwt
- [K] https://auth0.com/docs/get-started/applications/configure-private-key-jwt
- [L] https://auth0.com/pricing
- [M] https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
- [N] https://www.rfc-editor.org/rfc/rfc9396.html
- [O] https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets
- [P] https://auth0.com/docs/secure/tokens/access-tokens
- [Q] https://github.com/auth0/auth0-auth-js
- [S] https://github.com/auth0/node-auth0/blob/master/v7_MIGRATION_GUIDE.md
- [T] https://github.com/auth0/auth0-ai-js
