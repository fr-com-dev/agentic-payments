# Research: Auth0 Sign-In, Token Propagation and Streaming for the Hosted Agent

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-11-15

Each entry: the decision, why, what was rejected. "Confirmed" means read in the vendor's documentation or in the
installed package's source on 2026-11-15; "to check live" means it could not be confirmed without the real
tenant or a deployed stream, and [quickstart.md](quickstart.md) §6 lists the check.

## R1. The owner's five decisions

Recorded in [spec.md](spec.md#clarifications). They reverse: SPEC v1.13 and `specs/013` research R19 and R20 (no
client for the agent; system identities on Entra); SPEC L1-6 and Constitution V (the requester's token is never
forwarded); T-API-08 and SEC-13 (no docs page in Azure); `specs/015` clarification D3 and FR-028 (the subject
travels on the payment request). Everything below follows from them.

## R2. One caller check, shared by L1 and L2

**Decision.** One function, `verifyCaller` in `src/shared/identity-token.ts`, used by the hosted agent and by
L2. It replaces `verifyServiceToken` (deleted, with `serviceKeys`, `SERVICE_ROLE`, `DEV_DIRECTORY_ISSUER`,
`DEV_TENANT`, `entraIssuer` and `GUID_RE`). `verifyPersonToken` stays for the portal and is what `verifyCaller`
builds on.

```ts
type Caller =
  | { kind: "person"; issuer: string; subject: string; client: string }
  | { kind: "machine"; issuer: string; subject: string; client: string };
type CallerCheck = { ok: true; caller: Caller } | { ok: false; status: 401 | 403; reason: "expired" | "invalid" | "forbidden" };
```

Order: signature with the accepted algorithms, `iss`, `aud`, `exp`/`nbf` (60 s tolerance), a usable `sub`: 401
(`expired` when the validity period is the only failure, read from jose's `JWTExpired`; otherwise `invalid`).
Then the kind: a machine token is one whose `gty` contains `client-credentials` or whose `sub` ends in
`@clients` (the rule `isMachineToken` already has).

- Machine: the client the token names (`azp` or `client_id`) must exist and `sub` must be `<client>@clients`
  (401 otherwise); then the permission `agent:run` (403 `forbidden`).
- Person: the permission `agent:run` in `permissions`, and the client on the allow-list (403 `forbidden`).

**Why.** FR-010 asks for the same checks at both layers. Two copies would drift; the portal and the agent
already share their basic checks for that reason.

**Where a machine token carries the permission.** Auth0 documents that a client-credentials token carries the
grant's scopes in `scope`; whether `permissions` is also filled under the `access_token_authz` dialect is
described differently by Auth0's own blog and by a community thread (**to check live**). So for a machine token
only, the permission counts when it is in `permissions` or in the space-separated `scope`. Both are written by
the tenant from the client's grant, and a client gets no token for the API without a grant (confirmed: the
client policy `require_client_grant` is the default and the only alternative is `deny_all`). For a person only
`permissions` counts, as today: a person's `scope` is what the client asked for.

**Rejected.** A list of machine clients at L1 and L2 as well: the grant at the tenant already is that list, and
a second one would have to be kept in step with Terraform for no gain. Checking only `permissions` for machines:
may refuse every machine token.

## R3. How the token travels from L1 to L2

**Decision.** A second header on L1's two calls, `X-Caller-Authorization: Bearer <token>`, beside
`Authorization: Bearer <CONTROL_TOKEN>` ([contracts/control-api.md](contracts/control-api.md)).
`HttpAuthorizationGate` gains `forCaller(token): AuthorizationGatePort`; the returned gate adds the header to
`authorize` and `budget`. The hosted server takes the gate through that method once per run, with the token it
verified, so the token is held by one object for the length of the run. `AuthorizationGatePort.budget` loses its
`userId` parameter. `HttpSettlementVerifier` is untouched: L3 never sees the token.

Rule A14 (architecture test): the header's name appears only in `src/layer1-intent/ports-http.ts` and
`src/layer2-control/caller.ts`; `forCaller` is called only in `src/layer1-intent/hosted/server.ts` and
`src/main.ts`.

**Why a second header.** INV-13: every L2 route accepts exactly one role token, in `Authorization`. The caller's
token is not a role token and must not be mistaken for one; a second header keeps the role check untouched and
makes "the caller's token opens nothing by itself" (FR-016) true by construction.

**Rejected.** Putting the token in the JSON body: it would be parsed before it is verified and would sit in the
request object that validation and error paths handle (015 already had to close a body leak). Token exchange at
the tenant (an L2-only token per run): Auth0's token exchange is not generally available and would add a
credential to L1. Signing the request at L1: L1 holds no key.

## R4. What L2 does with the verified caller

**Decision.** A new module `src/layer2-control/caller.ts` holds the middleware `callerAuth` (the checks of
[control-api.md](contracts/control-api.md#order-of-checks-both-routes)) and the settings
(`callerSettingsFromEnv`: `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`, all three or none; `AUTH_JWKS_FILE`
with `NETWORK=local` only). It runs after `requireRole` and before `express.json`, so a refused caller's body is
never parsed. It puts the forwarded identity in `res.locals.caller`:

```ts
type ForwardedIdentity = { kind: "person"; userId: string; subject: string } | { kind: "machine" } | { kind: "none" };
```

`decideOnce(intent, caller, opts)` takes the user from `caller` (never from `intent`) and passes `caller.subject`
to the backchannel as the approval subject. `validIntent` refuses `userId` and `approvalSubject`. The recorded
intent gets `userId` from the caller before it is written, so ledger entries keep their shape.

- `ControlServiceDeps.caller?` carries the settings and the keys. `main()` refuses `USER_ACCOUNTS=1` without them,
  with a `ConfigError` naming the variables, before the ledger lock (FR-015). `createControlService` does not throw
  for the same combination: it then takes no caller's token and refuses any request that names a user, so no user
  can pay. That keeps the in-process suites that only use the portal's routes as they are.
- Verification is awaited before `serialize(...)`. `jose`'s remote key set fetches the tenant's keys on first
  use and on an unknown key ID, outside the lock (FR-019).
- Test-only switches on `caller` (NFR-005): `trustIntentUser` (take `userId` from the request, the old rule),
  `skipRequired` (accept a request without a caller's token where sign-in is configured), `skipClientCheck` and
  `echoCaller` (write the token to the log, for the scan's must-fail half). Never environment variables. The
  permission's switch is on the shared check (`skipChecks`).

**Why not keep `userId` on the request as a claim to compare.** Two sources for one fact need a rule for when
they disagree, and the only safe rule is "refuse". Refusing the field outright is that rule with less code.

**The portal.** Unchanged: its routes take the user in the path under `PORTAL_TOKEN`, from the token the portal
verified. Out of scope (spec, Assumptions).

## R5. Where a caller's token is required

**Decision.** FR-014 as written: sign-in configured at L2 means every authorize and budget call needs a caller's
token. Consequences worked through:

| Who calls L2 | Sign-in at L2 | Token |
|---|---|---|
| Hosted agent, any run | configured (always in Azure; locally when the stack is started for it) | the caller's, forwarded |
| `demo:local` (scripted CLI) | not configured | none; unchanged, so the demo's summary is unchanged (NFR-007) |
| CLI agent against an L2 with sign-in | configured | a machine token: `CALLER_TOKEN` (local, a dev machine token) or the machine client's settings (R9) |
| The Azure regression job (scripted CLI) | configured | a machine token it gets itself (R9) |

`scripts/stack-local.ts` configures L2's sign-in with the dev issuer whenever it is started with `--users`, and
also with a new `--sign-in`; plain `stack:local` stays as it is. `scripts/vscode-local.ts` gives the CLI agent
role a dev machine token when the L2 it targets has sign-in configured (scripts may use the dev issuer;
`src/` never does).

**Rejected.** "Token optional when present": a compromised L1 would simply omit it and spend the platform
account, or name a user as before. A separate L2 switch for the requirement: a switch that removes a safety
check belongs in test-only dependencies.

## R6. The requester at L1, sessions and logs

**Decision.** `Requester` keeps its shape: `kind: "user" | "service"`, `authority` (now always the issuer),
`subject` (`sub`), `key` (`<issuer host>:<sub>`). `sessionRef` keeps its format and version: the MAC covers
kind, authority, subject and session, so a person's reference still verifies and a machine caller's old one
(bound to a directory tenant) does not, which the spec allows. The run log's `requester` is the key, as today.
`Requester` gains nothing that holds the token: the token is a separate local of the request handler, passed to
`gate.forCaller` and to nothing else.

## R7. Streaming: one model path, two answer forms

**Decision.** `runGoal` always calls `agent.stream(goal, { maxSteps, modelSettings, abortSignal,
eagerToolExecution: false })` and takes an optional `onText(delta)`. It reads `fullStream`, forwards
`text-delta` chunks' `payload.text`, then awaits `getFullOutput()` for `text` and `finishReason`. The JSON form
passes no `onText`; the stream form writes `text` events. Steps come from the existing `record` callback, in
both forms.

Confirmed in `@mastra/core` 1.75.0: `generate()` and `stream()` share one execution path and one options type;
`generate()` is `stream()` plus `getFullOutput()`. The differences are the provider call (`doStream`), a
first-chunk timeout, and eager tool execution, which starts a tool before its model step has finished and is on
by default for `stream()`. It is turned off so tools run exactly when they do today: the abort, deadline and
step-limit tests keep their meaning, and "a paid fetch in progress completes" stays the only way a tool
outlives its step. A model error rejects `getFullOutput()`, as `generate()` threw; an abort resolves with the
partial text. The step limit still shows as `finishReason === "tool-calls"`.

**Why one path.** Two paths (`generate` for JSON, `stream` for events) would let the two answers differ in ways
no test compares. With one path, SC-006's "the last event equals the JSON answer" holds by construction.

**Cost.** Every test fake implements `doGenerate` only. `test/helpers/hosted.ts` changes once: `toolCall` and
`text` return stream results (`stream-start`, the text or tool-call part, `finish`), `mockModel` passes
`doStream`, and assertions on `doGenerateCalls` read `doStreamCalls`. The two tests that answer the provider
over HTTP send an event-stream body.

**The HTTP side.** `src/layer1-intent/hosted/sse.ts` (new): `wantsStream(req)` (the `Accept` header contains
`text/event-stream`), and a writer with `send(event, data)`, a keep-alive timer (15 s since the last write) and
`end()`. Headers as in [hosted-agent-api.md](contracts/hosted-agent-api.md#the-stream). The stream starts after
every refusal has had its chance, immediately before `runGoal`.

**Container Apps.** The ingress is Envoy; the request timeout is 240 s and the product team describes it as
idle. Whether a comment line resets it and whether small chunks are forwarded unbuffered is **to check live**.
The run's own deadline stays 200 s, so the answer does not depend on it.

**Rejected.** An OpenAI-compatible route and the AI SDK's UI stream (the owner's decision). A resumable stream:
it needs server-side run state, which the agent does not keep.

## R8. Swagger UI signs in with the agent's client

**Decision.** `src/shared/api-docs.ts` gains an optional `signIn` on `ApiDocsSite`:
`{ issuer, clientId, audience }`. With it:

- the served document gets a second security scheme, `auth0` (OAuth2, authorization code,
  `authorizationUrl: <issuer>authorize`, `tokenUrl: <issuer>oauth/token`, `scopes: {}`), written into the
  document at mount time as the `servers` block is; the committed document carries the scheme with placeholder
  addresses, and T-API compares everything but those two values;
- the initializer calls `ui.initOAuth({ clientId, usePkceWithAuthorizationCodeGrant: true,
  additionalQueryStringParams: { audience } })` and leaves `persistAuthorization` off;
- `oauth2-redirect.html` and `oauth2-redirect.js` from the pinned package are added to the assets (the page has
  no inline script, so `script-src 'self'` stays);
- `connect-src` becomes `'self' <issuer origin>`; nothing else in the policy changes.

Only the hosted agent passes `signIn`, and only when `API_DOCS_CLIENT_ID` is set and the issuer is a tenant. L2's
and the seller's pages are unchanged.

Confirmed in Swagger UI's source: with PKCE it posts the code to the token address as a form with `client_id`
and `code_verifier`, no `Authorization` header and no secret; `additionalQueryStringParams` is added to the
authorize address (where Auth0 needs `audience`) and to the token address (harmless). It sends
`X-Requested-With`, so the token call is preflighted: the agent's client lists the docs origins under
`allowed_origins` and `web_origins` as well as the exact redirect pages under `callbacks`. Whether Auth0's
preflight accepts that header is **to check live**; the fallback is pasting a token, which always works.

**Rejected.** Our own sign-in page: more code to hold a token than Swagger UI already has. `auth0-spa-js` on the
docs page: a second script and a second origin in `script-src`.

## R9. Machine callers: one client, a key, and where it lives

**Decision.**

- **At the tenant.** `variable "machine_caller_keys"`: a map from a caller's name to the public half of its key
  (default `{}`: no machine caller). For each: `auth0_client` (`non_interactive`, grant `client_credentials`
  only), `auth0_client_credentials` (`private_key_jwt`, RS256, the public key), and `auth0_client_grant` for
  people's API with exactly `agent:run`. No secret exists, so none can be in Terraform's state or in GitHub
  (FR-022); the pipeline already provisions L2's client this way (Constitution V). `private_key_jwt` is an
  Enterprise feature of Auth0 and works with the client-credentials grant (confirmed); the tenant already uses
  it for L2.
- **The first machine caller is `checks`:** the deployment pipeline's two checks, the hosted smoke run and the
  scripted regression.
- **In the code.** `src/machine-caller/token.ts` (new, outside the layers): given the client's ID, the key ID
  and the private key, it asks the tenant for a client-credentials token with a signed assertion and caches it
  until 60 s before expiry. Rule A15 confines the variables `MACHINE_CLIENT_KEY` and `MACHINE_CLIENT_KEY_ID` to
  that file, as A9 does for L2's Auth0 credential. Two entry points use it: `src/main.ts` (the CLI agent; with
  `MACHINE_CLIENT_ID` set it forwards a machine token, otherwise `CALLER_TOKEN` when set, otherwise none) and
  `src/smoke-main.ts` (new: gets a token, sends the smoke goal to the agent, checks the answer, exits 0 or 1).
- **In Azure.** Both checks are jobs of the `l1` unit on the L1 image: the regression job that exists and a new
  smoke job (`names.jobs.smoke`). Each references one more secret of the l1 vault, `machine-client-key`, and
  gets `MACHINE_CLIENT_ID` and `MACHINE_CLIENT_KEY_ID` from the parameter file's `agent` object. The pipeline
  starts them with `run_job` and reads their outcome; it never holds a token.
- **The smoke job's target.** `run_job` cannot pass a value, so Bicep bakes in two addresses, the agent's and
  its `---candidate` label. The job uses the candidate when its `/healthz` answers and the agent's otherwise.
  During an L1 run the candidate is the new revision; otherwise there is none.

**The cost of this choice, recorded as a residual risk.** The agent's managed identity reads the l1 vault, so
the agent process can read `machine-client-key` and get machine tokens for itself. A compromised agent can
therefore still request payments from the platform account, within the platform mandate, as it can today with
its role token alone. What the feature does achieve is unchanged by this: no person's account can be spent
without that person's token.

**Rejected.**
- *A unit of its own for the checks* (identity, vault, image, pipeline, and the regression job moved there with
  copies of L1's role tokens). It closes the residual risk above. It also adds an eighth pipeline and a seventh
  vault to a proof of concept, and a second holder of L1's role tokens. Kept as the hardening step to take if
  the platform account must be out of the agent's reach: [plan.md](plan.md#risks).
- *The pipeline reads the credential from a vault.* The vaults refuse every address but their unit's subnet, the
  deploy identity has no data-plane role (T-IAC-01 rules 1 and 10), and `az keyvault secret show` is not among
  the commands a workflow may run (T-E2E-AZ).
- *A GitHub secret.* Constitution V, FR-022.
- *A client secret.* It would be in Terraform's state or need a hand-made value passed write-only; the key needs
  neither.
- *Dropping the regression job.* It is the only check of the deployed policy's ESCALATE and DENY outcomes.

## R10. The tenant: applications, permission, role

**Decision** ([contracts/tenant-and-config.md](contracts/tenant-and-config.md)).

- `auth0_client.agent`: `spa`, first-party, `authorization_code` only (no refresh tokens), authentication method
  `none`; `callbacks` are `<origin>/docs/oauth2-redirect.html` for `http://localhost:4024`,
  `http://127.0.0.1:4024` and, when set, `var.agent_origin`; `allowed_origins` and `web_origins` are those
  origins.
- `auth0_resource_server_scopes.identity` lists two permissions: `portal:admin` and `agent:run`.
- `auth0_role.agent` (`x402-agent`) with `auth0_role_permissions.agent` holding exactly `agent:run`. Assigned by
  hand, per person, as `x402-admin` is. Nothing in `auth0/` assigns a role.
- People's API keeps `enforce_policies = true` and the `access_token_authz` dialect, so a person's token carries
  the permissions of their roles for this API whichever client they signed in through. The portal never reads
  `agent:run`; the agent never reads `portal:admin`.
- Outputs: `bicepparam_agent` (`clientId`, `machineClientId`, `machineKeyId`) for the parameter file's `agent`
  object; `l1_env` and the additions to `l2_env` for local env files.
- New variables: `agent_origin` (set later, like `portal_origin`), `machine_caller_keys`. Each goes in the plan
  step's `VAR_*`, its export loop, `AUTH0_VARIABLES` in `infra/github-setup.sh` and `VARIABLES` in T-IAC-02.

T-IAC-02 changes from "exactly two applications, one permission, one role" to: applications are exactly `l2`,
`portal`, `agent` and `machine` (a `for_each`); permissions exactly `portal:admin` and `agent:run`; roles
exactly `x402-admin` and `x402-agent`, each holding one; no role assignment; every machine client has the
client-credentials grant only and a grant for people's API with exactly `agent:run`.

## R11. Azure: settings, parameters, the docs switch

**Decision** ([contracts/tenant-and-config.md](contracts/tenant-and-config.md#azure)).

- `main.bicep` gains one plain object, `agent`: `{ clientId, apiDocs, machineClientId, machineKeyId }`. It
  refuses the `l1` and `l2` units until `agent.clientId` is pasted and `identity` is set, as it refuses the
  portal until `userAccounts.portalClientId` is.
- `l1-apps.bicep` takes `identity` and `agent`. The agent gets `AUTH_ISSUER`, `AUTH_AUDIENCE`,
  `AGENT_CLIENT_IDS`, and `API_DOCS` (`agent.apiDocs ? '1' : '0'`) with `API_DOCS_CLIENT_ID`. The two jobs get
  the machine client's settings and the secret reference. `authTenantId` and `authAudience` leave the module.
- `l2-apps.bicep` takes `identity` and `agent`: L2 gets `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`.
- `param authAudience` leaves `main.bicep` and the parameter files; `tenantId` stays (the target check and the
  pipeline's sign-in).
- T-IAC-01: rule 11 is deleted; rule 21's "a deployed agent gets no people's settings" becomes rule 23, "the
  agent and L2 get the same sign-in settings and nothing of the directory"; the `API_DOCS` clause becomes "only
  on the agent, only from `agent.apiDocs`"; rules 12 and 15 learn the smoke job. T-API-08 becomes "`API_DOCS`
  appears in `infra/` only in `l1-apps.bicep`, as that expression".
- The l1 vault gets one more secret, `machine-client-key`, seeded by hand (as `off` until the tenant has the
  client), before the first L1 deployment with this feature.

## R12. Retiring the directory's objects

**Decision.** `pre-deploy.bicep` stops naming the API app registration, its service principal, the `Agent.Run`
role and its assignments, `agentUsers`, `retirePortalScope` and the `authAudience` line of `mainParameters`;
`names.apiApp` leaves the parameter files. Nothing else used that registration (the portal and L2 never did).
Bicep does not delete a Graph object a template stops naming, so the administrator deletes the registration by
hand once the agent with this feature is deployed (`az ad app delete --id <its client ID>`: the service
principal and the assignments go with it), as was done for the old portal registration. `infra/cleanup.sh`
stops looking for it. Deleting the app also ends the unfinished `Portal.Access` retirement: the scope goes with
the app.

Order: deploy the agent first (it then refuses directory tokens), delete the registration second. The other
way round only breaks the pipeline's old smoke step, which this feature replaces in the same change.

## R13. The local dev issuer

**Decision.** One issuer, `urn:x402:dev-issuer`, signs both kinds. `npm run dev-token -- --service` now makes a
machine token of the tenant's shape (`gty: "client-credentials"`, `sub: "<client>@clients"`, `azp`,
`scope: "agent:run"`), and `--subject <name>` a person's with `permissions: ["agent:run"]` unless `--no-role`.
The dev issuer has no authorize address, so the docs page offers OAuth2 only with a real tenant.

## R14. Feature 015 after this

**Decision.** In L2, `backchannel.eligibility` and `addressee` keep their signatures; `service.ts` feeds them
`owner` and `subject` from the forwarded identity. `PaymentIntent.approvalSubject`, `APPROVAL_SUBJECT_RE` and
`OrchestratorDeps.approvalSubject` (015 slice 1) are removed; `OrchestratorDeps.userId` (013) is removed too.
The marks stay as they are, for the ledger's sake. 015's tasks T007, T008, T015 and T025 are marked "replaced by
016" in its task list, with the task of this feature that covers each; T-AGT-08 and T-E2E-15, which they
reserved, are used here for the same purpose. 015's refused-body handler on `/v1/authorize` stays: `purpose`
still travels in that body.

## R15. What the ledger, the events and the responses show

**Decision.** Nothing new. The caller's token is in none of them (FR-020; a planted-token scan proves it:
T-CTK-07). A machine caller is not named in the ledger: its payments are the platform account's, as a system
identity's were. The hosted agent's run log names the requester for both kinds.

## R16. Delivery order

**Decision.** Five slices, each green on its own:

1. Scope amendments (SPEC v1.17, constitution 2.0.0) and the shared caller check.
2. L2 takes the user from the token; L1 forwards it; Entra leaves the agent's code; 015's fields removed.
3. Streaming.
4. The docs page's sign-in.
5. The tenant, Azure and the pipeline (machine caller, jobs, parameters, the docs switch), then the documents.

Slices 1 and 2 must be deployed together with slice 5's settings: an L2 with sign-in configured refuses an agent
that forwards nothing, and an agent without sign-in settings does not start. No slice leaves a deployed
environment where L1's word names a user.
