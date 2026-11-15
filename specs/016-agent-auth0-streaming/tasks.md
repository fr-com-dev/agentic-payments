---

description: "Task list for 016: Auth0 sign-in, token propagation and streaming for the hosted agent"
---

# Tasks: Auth0 Sign-In, Token Propagation and Streaming for the Hosted Agent

**Input**: Design documents from `specs/016-agent-auth0-streaming/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md) (R1–R16)
- [data-model.md](data-model.md)
- [contracts/](contracts/): control-api, hosted-agent-api, tenant-and-config
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII requires a test for every route, field, status
and rule, plus the must-fail proofs in plan.md "Proofs".
- **Test IDs.** Each test title carries its ID (T-CTK-01..08, T-AGT-08..14, T-API-16..17, T-E2E-15..16,
  T-ARCH-A14..A15, T-IAC-01 rule 23, T-IAC-02) or `016 USn …`.
- **Order.** Write each story's tests first and confirm they fail before implementing.
- **Switches.** Every must-fail switch (`trustIntentUser`, `skipRequired`, `skipClientCheck`, `echoCaller` on
  L2's caller deps; `skipChecks` on the shared caller check; the existing `bypassAuth` on the hosted agent) is a
  test-only dep, never an environment variable.
- **People in tests.** A person is a dev-issuer token made by `test/helpers/caller-tokens.ts` (T007). Where
  backchannel approval is on, the token is issued under the stand-in's issuer, so 015's identity check passes
  as it would with one tenant.
- **Not edited.** `src/layer2-control/policy.ts`, `ledger.ts`, `signer.ts`, `approval-routes.ts`,
  `admin-routes.ts`.

**Organization**: tasks are grouped by user story (US1–US8 from spec.md). The phases follow the order the
stories depend on each other, not their numbers: US2 (L2 takes the user from the token) and US3 (who the agent
accepts) come before US1 (a person's run end to end), which needs both.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task belongs to (US1–US8)

## Path Conventions

Repository root. Source in `src/`, tests in `test/`, the tenant in `auth0/`, Azure in `infra/`, pipelines in
`.github/workflows/`, OpenAPI documents in `docs/`.

---

## Phase 1: Setup

**Purpose**: a green baseline and the scope amendments, before any code (FR-047).

- [X] T001 Run `npm install` (not `npm ci`) and `npm run check`; record the demo's summary (`spent on-chain: 0.006 USDC`, `hash chain ok=true`) as the baseline. If a port is taken by another checkout's stack, say so and stop that stack only with the owner's agreement.
- [X] T002 Amend `SPEC.md` (v1.17, "Changes in 1.17") and `.specify/memory/constitution.md` (2.0.0, Sync Impact Report) together, from plan.md "SPEC and governance changes": §1.2, §1.3, §3.1 Azure profile, §3.3, INV-13, §7, L1-1, L1-2, L1-5, L1-6, L2-5, L2-7, L2-8, CFG-2, §11 (SEC-13, SEC-14, SEC-20 amended; SEC-32, SEC-33, SEC-34 new; the two residual risks), §12 (the tests of plan.md "Tests defined here"); Constitution Principle V and the scope constraints. Add the SEC rows to `specs/007-process-isolation-security/contracts/threat-matrix.md` and raise `SEC_ROWS` in `test/architecture.test.ts`. No code yet.
- [X] T003 [P] In `specs/015-per-user-approval/tasks.md`, mark T007, T008, T015 and T025 as replaced by 016 (a dated note under "Along the plan's slices" naming T019, T028 and T030 here), and note that 015's other open tasks are to be read against 016 (FR-043). Do not tick them.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the one caller check, the dev issuer's two kinds of token, and the test helper every story uses.

**⚠️ T004–T008 are one commit**: typecheck is green only at the end of T008.

- [X] T004 [P] In `test/identity-token.test.ts`, write the cases for `verifyCaller` (research R2): a person accepted (`kind: "person"`, issuer, subject, client); each 401 in turn (signature, issuer, audience, expired with `reason: "expired"`, not yet valid, no `sub`, a line break in `sub`); 403 for a person without `agent:run` and for a client not on the list; a machine token accepted with the permission in `permissions`, and accepted with it only in `scope`; a person's token with `agent:run` only in `scope` refused (403); a machine token whose `sub` is not `<client>@clients` refused (401); a machine token without the permission refused (403). Must-fail halves with `skipChecks: ["permission"]` and `skipChecks: ["machineSubject"]`. Delete the `verifyServiceToken` cases.
- [X] T005 Implement `verifyCaller`, `Caller` and `CallerCheck` in `src/shared/identity-token.ts` on top of the checks `verifyPersonToken` uses; map jose's `JWTExpired` to `reason: "expired"`. Delete `verifyServiceToken`, `serviceKeys`, `ServiceToken`, `ServiceVerifyOptions`, `SERVICE_ROLE`, `DEV_DIRECTORY_ISSUER`, `DEV_TENANT`, `entraIssuer` and `GUID_RE`. `verifyPersonToken` keeps refusing machine tokens (the portal's rule).
- [X] T006 In `scripts/dev-issuer-lib.ts` and `scripts/dev-token.ts` (research R13): one issuer signs both kinds; `--service` makes a machine token (`gty: "client-credentials"`, `sub: "<client>@clients"`, `azp: "<client>"`, `scope: "agent:run"`, audience the people's API); a person's token carries `permissions: ["agent:run"]` unless `--no-role`. Update the script's header comment and the tests that cover it.
- [X] T007 [P] Create `test/helpers/caller-tokens.ts`: an in-process issuer for tests (its own key pair, a JWKS, `personToken({ sub, issuer?, client?, permissions?, expiresInSec? })`, `machineToken({ client, permission? })`) and `callerDeps()` returning the settings and keys L1 and L2 take as deps. No file on disk, no environment variable.
- [X] T008 In `src/shared/contracts.ts`: remove `PaymentIntent.approvalSubject`; document `PaymentIntent.userId` as "set by L2 from the caller's token; never accepted from a request"; change `AuthorizationGatePort.budget(sessionId: string)` (no `userId`). Fix every producer and consumer so that `npm run typecheck` is green: `src/layer1-intent/orchestrator.ts` (remove `userId` and `approvalSubject` from `OrchestratorDeps` and from the intent), `src/layer1-intent/hosted/agent.ts` (`RunToolsDeps.userId`, `RunGoalOptions.userId`), `src/layer1-intent/ports-http.ts` (`budget`), `src/layer1-intent/hosted/requester-auth.ts` and `config.ts` (use `verifyCaller`; the rest of their rewrite is T022–T023), the fakes in `test/helpers/`.

**Checkpoint**: typecheck green; the suites that send `userId` on an intent fail until Phase 3.

---

## Phase 3: User Story 2 - L2 takes the user from the token it verified itself (Priority: P1) 🎯 MVP

**Goal**: L1's word names no user. L2 verifies the forwarded token and decides for the person it proves.

**Independent Test**: T-CTK-01..08 against an in-process L2 with users on: Alice's token decides under Alice's
policy; a request naming Bob is refused; without `trustIntentUser` off, Bob's account signs (must-fail).

### Tests for User Story 2 (write first; they must fail)

- [X] T009 [P] [US2] `test/caller-token.test.ts` (new), T-CTK-01..06, from contracts/control-api.md "Order of checks": T-CTK-01 each row of the table in order (401 unauthorized before the header is read; `caller_token_required`; `caller_token_not_accepted` when sign-in is not configured; `caller_token_expired`; `caller_token_invalid`; `caller_forbidden` for no permission, for a client off the list, for the portal's client, for a person with user accounts off), each with the ledger's length unchanged; T-CTK-02 a person's token decides under that person's policy and signs with their account, a machine token names no user and the platform account signs, and a person's payment is never signed by the platform account; T-CTK-03 a body with `userId` or `approvalSubject` is 400 and a budget call with `?userId=` is 400; T-CTK-04 the caller's token without the role token is 401 on both routes and on one other route; T-CTK-05 a request without the header where sign-in is configured is refused, and one without it where it is not configured decides for the platform account; T-CTK-06 startup: users on without sign-in refuses, the portal's client on the list refuses, `AUTH_JWKS_FILE` outside local refuses, each naming the variable and never its value. Must-fail halves: `trustIntentUser` (Bob's account signs), `skipRequired` (the platform account pays), `skipClientCheck` (a portal-client token pays).
- [X] T010 [P] [US2] In `test/caller-token.test.ts`: T-CTK-07 a planted token is found nowhere (ledger file, every response body, the events route, captured console output, including for a body that is not JSON); must-fail with `echoCaller`. T-CTK-08 the token is verified before the serialized section: a key fetch that never returns blocks only its own request, and a second request with a known key is decided meanwhile.
- [X] T011 [P] [US2] In `test/openapi.test.ts` (T-API-01..04): the two routes document the `X-Caller-Authorization` header, the new 401, 403 and 400 answers and no `userId` query; `PaymentIntent` in the document has no `userId` and no `approvalSubject`.
- [X] T012 [US2] Move every existing test that puts `userId` or `approvalSubject` on an intent to a caller's token: `test/helpers/backchannel-l2.ts` (`intentFor(..., { as })` returns the intent and the header to send; `people.alice` and `people.bob` hold a token), `test/users.test.ts`, `test/backchannel-owner.test.ts`, `test/backchannel-*.test.ts`, `test/admin.test.ts`, `test/escalations.test.ts`, `test/e2e.local.test.ts`, `test/agent.test.ts` (the orchestrator sends no user). Delete 015's "authorize approvalSubject" cases in `test/users.test.ts` and replace them with one case that the field is refused.

### Implementation for User Story 2

- [X] T013 [US2] Create `src/layer2-control/caller.ts` (research R4): `callerSettingsFromEnv(env, net)` (`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS` all or none; `AUTH_JWKS_FILE` local only and then the dev issuer; `PORTAL_CLIENT_ID` never on the list; `ConfigError` naming the variable), `ForwardedIdentity`, and the middleware `callerAuth(deps)` implementing the order of checks with the test-only switches. It reads the header, calls `verifyCaller`, sets `res.locals.caller` and never logs.
- [X] T014 [US2] In `src/layer2-control/service.ts`: add `caller?` to `ControlServiceDeps`; mount `requireRole → callerAuth → express.json` on `POST /v1/authorize` and `requireRole → callerAuth` on `GET /v1/budget/:sessionId`; `validIntent` refuses `userId` and `approvalSubject` and `APPROVAL_SUBJECT_RE` is removed; `decideOnce(intent, caller, opts)` takes the user from `caller`, writes it on the recorded intent, and passes `caller.subject` to `backchannel.eligibility` and `addressee`; the budget handler answers the user view for a person and refuses `?userId=`; `main()` builds the settings before the ledger lock and refuses `USER_ACCOUNTS=1` without them (`createControlService` itself does not throw: built with users and no `caller` it takes no caller's token and refuses any request that names a user, so no user can pay). Keep `refuseUnreadBody`.
- [X] T015 [US2] In `src/layer1-intent/ports-http.ts`: `HttpAuthorizationGate.forCaller(token)` returns a gate that adds `X-Caller-Authorization: Bearer <token>` to `authorize` and `budget`, and sends no header for an empty token; `PortHttpError` exposes the status and the parsed `error` code. In `src/layer1-intent/orchestrator.ts`, a gate refusal with `caller_token_expired` gives the tool result "the sign-in has expired: sign in again", and any other caller refusal "the caller was refused by the control layer"; neither is retried.
- [X] T016 [US2] Update `docs/l2-control.openapi.yaml` (the header, the statuses, the two removed fields, the removed query) and `env/l2-control.env.example` (the four variables, commented, with the dev issuer's values) so that T011 passes.
- [X] T017 [P] [US2] T-ARCH-A14 in `test/architecture.test.ts`: the string `x-caller-authorization` (any case) appears in `src/` only in `src/layer1-intent/ports-http.ts` and `src/layer2-control/caller.ts`; `forCaller(` is called only in `src/layer1-intent/hosted/server.ts` and `src/main.ts`. Must-fail: a second file that names the header is reported.

**Checkpoint**: `npm test` green except the hosted-agent suites rewritten in Phase 4.

---

## Phase 4: User Story 3 - Only a person with the role, through the agent's client, starts a run (Priority: P1)

**Goal**: one issuer at the agent; the five tokens of the story; the token kept for the run and sent to L2 only.

**Independent Test**: T-AGT-09 and T-AGT-10 against the in-process hosted app.

### Tests for User Story 3 (write first; they must fail)

- [X] T018 [P] [US3] In `test/hosted-access.test.ts` and `test/helpers/hosted.ts`: T-AGT-09 the five tokens (role and agent's client: 200; no role: 403; the portal's client: 403; a directory-shaped token from another issuer: 401; any other issuer: 401), a machine token with the permission (200) and without (403), an administrator without the agent role (403), each refusal with no model call and no gate call. Rewrite T-AGT-03, T-AGT-06 and T-AGT-07 for one issuer; keep their must-fail halves (`bypassAuth`, `skipClientCheck`).
- [X] T019 [P] [US3] In `test/hosted-access.test.ts`: T-AGT-08 (reserved by 015) a person's run sends intents with no `userId` and no `approvalSubject`; T-AGT-10 the caller's token reaches the gate's `authorize` and `budget` calls of that run and nothing else: not the settlement port, not the model's prompt or tool inputs, not a step, the answer, a log line or a second caller's run. The must-fail half is rule A14's (T017): a file that names the header or takes a gate for a caller is reported.
- [X] T020 [P] [US3] In `test/hosted-agent.test.ts`: T-AGT-14 the settings (the three sign-in variables required; `AUTH_TENANT_ID` or `SERVICE_AUDIENCE` refused by name, value never printed; the portal's client on the list refused; `API_DOCS_CLIENT_ID` not on the list refused). In `test/openapi-hosted.test.ts`: T-API-05..07 for one issuer and both kinds of caller.

### Implementation for User Story 3

- [X] T021 [US3] `src/layer1-intent/hosted/config.ts`: the three sign-in variables required; refuse `AUTH_TENANT_ID` and `SERVICE_AUDIENCE` by name (FR-044); read `API_DOCS_CLIENT_ID` (on the list; a tenant issuer); remove `auth.service`. Update `env/l1-hosted.env.example`.
- [X] T022 [US3] `src/layer1-intent/hosted/requester-auth.ts`: one branch on `verifyCaller`; `Requester` as in data-model.md; set `res.locals.requester` and `res.locals.callerToken`; do not delete the header; `keysFor` returns one key set.
- [X] T023 [US3] `src/layer1-intent/hosted/server.ts` and `src/hosted-main.ts`: `HostedDeps.gate` is `{ forCaller(token): AuthorizationGatePort }`; per run `deps.gate.forCaller(callerToken)`; no `userId` passed to `runGoal`; `bypassAuth` uses an empty token. Session references and limits are keyed as before.
- [X] T024 [US3] `docs/l1-hosted.openapi.yaml`: one issuer, both kinds, the statuses, no directory text; so that T020 passes.

**Checkpoint**: the hosted agent starts runs for people with the role and for machine callers of the dev issuer.

---

## Phase 5: User Story 1 - A person signs in and runs the agent for their own account (Priority: P1)

**Goal**: the whole path on the local chain: hosted agent, L2 with users, a person's token.

**Independent Test**: T-E2E-16.

- [X] T025 [US1] T-E2E-16 in `test/e2e.local.test.ts`: the hosted agent (model faked) with L2 (users on, sign-in configured with the test issuer) on the local chain. A person onboarded and funded: both purchases `PAID` and `CONFIRMED`, recorded for them, paid from their account, the platform account's balance unchanged. A machine caller: the platform account pays and the entries name no user. A person with the role and no account: nothing paid, the answer says the account is missing. A second run with the first run's `sessionRef` carries the session; another person's reference is 404.
- [X] T026 [US1] Local running (research R5): `scripts/stack-local.ts` configures L2's sign-in with the dev issuer for `--users` and for a new `--sign-in`; `scripts/demo-lib.ts` `childEnv` for L2; `scripts/vscode-local.ts` gives the CLI agent role `CALLER_TOKEN` (a dev machine token) when the L2 it targets has sign-in configured; update `test/vscode-local.test.ts` (T-DEV-01) and `.vscode/launch.json` if a role's arguments change. `npm run demo:local` keeps an L2 without sign-in: its summary is unchanged.
- [X] T027 [P] [US1] In `test/portal.test.ts`: a token from the agent's client and a machine token are both refused by the portal (FR-027); the agent role alone gives nothing there.

**Checkpoint**: `npm run check` green with the baseline summary.

---

## Phase 6: User Story 7 - The owner's phone is asked from the token L2 verified (Priority: P2)

**Goal**: 015's eligibility fed from the forwarded identity; its hosted-agent slice replaced.

**Independent Test**: T-E2E-15 with the stand-in approval service.

- [X] T028 [P] [US7] In `test/backchannel-owner.test.ts`: T-CIBA-15..18 through the token (the request is addressed to the forwarded token's subject; a body carrying `approvalSubject` is 400; a machine caller's escalation is `no_owner`; a person whose issuer is not the stand-in's is `identity_mismatch`). Keep 015's must-fail halves (`skipIdentityCheck`, `ownerlessSubject`, `skipChecks: ["owner"]`).
- [X] T029 [US7] Remove what is left of the field: `OrchestratorDeps.approvalSubject`, the `validIntent` clause and its comment in `src/layer2-control/service.ts`, the mention in `docs/portal.openapi.yaml` if any. `rg approvalSubject src docs` finds nothing.
- [X] T030 [US7] T-E2E-15 in `test/e2e.local.test.ts` (reserved by 015): the hosted agent, L2 with users and backchannel approval, the stand-in. A person's token issued under the stand-in's issuer; a goal whose purchase escalates; the stand-in receives one request addressed to that person, approves it, and the payment is signed by that person's account. A machine caller's escalation sends none (015's T025, the second half of T-E2E-10).

---

## Phase 7: User Story 6 - A chatbot or another agent reads the answer as it is written (Priority: P2)

**Goal**: one streaming model path; server-sent events on request.

**Independent Test**: T-AGT-11 and T-AGT-12.

- [X] T031 [US6] `test/helpers/hosted.ts`: `toolCall` and `text` return stream results (`stream-start`, the text parts or the tool call, `finish`), `mockModel` passes `doStream`, `toolNamesSeen` reads `doStreamCalls`; move the assertions on `doGenerateCalls` in `test/hosted-agent.test.ts`, `test/hosted-run.test.ts`, `test/hosted-access.test.ts` and `test/hosted-sessions.test.ts`; the two tests that answer the provider over HTTP send an event-stream body. These fail until T033.
- [X] T032 [P] [US6] `test/hosted-stream.test.ts` (new): T-AGT-11 with `Accept: text/event-stream` the events arrive as `run`, `text`…, `step`… in completion order, `result` last and nothing after; `result` equals the JSON answer of the same scripted run in every field but `runId` and the times; a refusal (401, 403, 429, 400, 413, unknown session) is the same JSON with the same status; without the header the answer is JSON; a `: keep-alive` line is written after 15 s of silence (clock injected); the response headers of contracts/hosted-agent-api.md. T-AGT-12 a disconnect aborts before the next step and a paid fetch in progress completes; the deadline and a model error end in `result` (`stopped`/`deadline`, `failed` with `error`); the stream carries no token and no tool input beyond `url` and `purpose`.
- [X] T033 [US6] `src/layer1-intent/hosted/agent.ts`: `agent.stream(goal, { maxSteps, modelSettings, abortSignal, eagerToolExecution: false })`; read `fullStream` and call `onText(payload.text)` for `text-delta`; `await getFullOutput()` for `text` and `finishReason`; the abort and error paths give the same `RunOutcome` as before (research R7).
- [X] T034 [US6] `src/layer1-intent/hosted/sse.ts` (new: `wantsStream`, the writer, the keep-alive timer, `end`) and `src/layer1-intent/hosted/server.ts` (choose the form after the last refusal; `run` first; `onText` and `onStep` write events; `result` then end; the run log unchanged).
- [X] T035 [US6] `docs/l1-hosted.openapi.yaml`: the `text/event-stream` answer of `POST /v1/runs` with the four events; `test/openapi-hosted.test.ts` checks it.

---

## Phase 8: User Story 5 - A person tries a run from the API docs without pasting a token (Priority: P2)

**Goal**: the agent's Swagger UI signs in with the tenant.

**Independent Test**: T-API-16 and T-API-17.

- [X] T036 [P] [US5] In `test/openapi-hosted.test.ts`: T-API-16 with `signIn` configured the served document has the `auth0` OAuth2 scheme with the tenant's two addresses, the initializer names the client, PKCE and the audience and does not persist, `oauth2-redirect.html` and `oauth2-redirect.js` are served and no other asset is, and the policy's `connect-src` is `'self'` and the tenant's origin only with `script-src 'self'`; T-API-17 without it (no client, or the dev issuer) the page and the policy are as before. Rewrite the existing check that the policy names no `https:` origin to "none but the tenant's when sign-in is configured".
- [X] T037 [US5] `src/shared/api-docs.ts` (`ApiDocsSite.signIn?`, the scheme written at mount time, the initializer, the two assets, the policy), `src/layer1-intent/hosted/api-docs.ts` (pass it), and the committed `docs/l1-hosted.openapi.yaml` (the scheme with placeholder addresses, listed beside the bearer scheme on `POST /v1/runs`). L2's and the seller's pages are unchanged; their tests stay green.

---

## Phase 9: User Story 4 - A machine caller runs with its own client (Priority: P2)

**Goal**: the machine caller's token client, the CLI agent's and the smoke client's use of it.

**Independent Test**: T-AGT-13 and the token client's tests against a stub token address.

- [X] T038 [P] [US4] `test/machine-caller.test.ts` (new): against a stub token address, the client posts `grant_type=client_credentials`, the audience and a `client_assertion` signed RS256 with the key ID in its header, `iss` and `sub` the client, `aud` the issuer and a lifetime of at most 60 s; it caches the token until 60 s before expiry; a refusal throws without the response body, the key or the assertion in the message. T-ARCH-A15 in `test/architecture.test.ts`: `MACHINE_CLIENT_KEY` and `MACHINE_CLIENT_KEY_ID` are named in `src/` only in `src/machine-caller/token.ts`, and nothing under `src/layer*/` imports that folder.
- [X] T039 [P] [US4] `test/smoke-client.test.ts` (new), T-AGT-13: against a fake agent, the smoke client exits 0 only when the run completed, `/api/weather` and `/api/market-brief` are `PAID` and `CONFIRMED`, nothing is `ESCALATED` and it took 120 s or less; it uses the candidate address when its `/healthz` answers and the agent's otherwise; its output holds the duration and the outcome and never the token.
- [X] T040 [US4] `src/machine-caller/token.ts` (research R9), with `jose` and `fetch` only.
- [X] T041 [US4] `src/main.ts`: resolve the caller's token source (`MACHINE_CLIENT_ID` set: the machine client; else `CALLER_TOKEN` with `NETWORK=local`; else none) and wrap the gate with `forCaller`; `env/l1-agent.env.example`. `src/smoke-main.ts` (new) for T039; both refuse to start if the payer key is visible. Add `src/smoke-main.ts` and `src/machine-caller/` to `IMAGES["l1-agent"]` in `scripts/image-closure.ts` (T-IMG-01) and a `smoke` role to `RUN_ROLES` in `scripts/vscode-local.ts` only if a launch configuration is added.

---

## Phase 10: User Story 8 - Entra is gone from the agent; the tenant, Azure and the pipeline (Priority: P3)

**Goal**: the tenant has the agent's client, the role and the `checks` caller; Azure gives the agent and L2 the
sign-in settings; the pipeline's checks run as jobs; nothing of the directory remains for callers.

**Independent Test**: T-IAC-01 (with `BICEP_PATH`), T-IAC-02, T-E2E-AZ, T-API-08.

### Tests for User Story 8 (write first; they must fail)

- [ ] T042 [P] [US8] `test/auth0-iac.test.ts` (T-IAC-02), from research R10: applications are exactly `l2`, `portal`, `agent` and `machine`; the agent's client is public, `authorization_code` only, callbacks limited to `…/docs/oauth2-redirect.html`; a machine client has `client_credentials` only, `private_key_jwt` and one grant with exactly `agent:run`; permissions exactly `portal:admin` and `agent:run`; roles exactly `x402-admin` and `x402-agent`, one permission each; no role assignment; `bicepparam_agent` has the parameter file's `agent` keys minus `apiDocs`; the new variables are in `VARIABLES`, the plan step and `AUTH0_VARIABLES`. Must-fail rows for a fourth kind of application, a third permission, a role assignment, a machine client with a second grant. Update `test/github-setup.test.ts`.
- [ ] T043 [P] [US8] `test/infra.test.ts` (T-IAC-01) and `test/helpers/bicep.ts`: rule 11 removed; rule 16 (one registration, the deploy app; `mainParameters` is `deployClientId` and `operatorsGroupId`); rule 21 without its agent clause; rule 23 new (the agent and L2 get `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` from `identity` and `agent`; no container gets `AUTH_TENANT_ID` or `SERVICE_AUDIENCE`; `API_DOCS` only on the agent, as `agent.apiDocs`; the two jobs reference `machine-client-key` of the l1 vault and get the machine client's IDs; `main.bicep` refuses the units without `agent.clientId`); rules 12 and 15 know the smoke job. Must-fail halves for each clause of rule 23. `test/openapi-hosted.test.ts` T-API-08: `API_DOCS` appears under `infra/` and `.github/` only in `infra/modules/l1-apps.bicep`, in that expression. `test/cleanup.test.ts`: no API app registration to delete.
- [ ] T044 [P] [US8] `test/deploy-workflow.test.ts` (T-E2E-AZ): step 8 is `eval "$SIGN_IN"`, `eval "$RUN_JOB"`, `run_job "$CAJ_SMOKE"` and asks for no token; `TARGET_OUTPUTS` has no `authAudience`; `TARGET_NAMES` has the smoke job; must-fail: a step that calls `az account get-access-token --resource` is reported.

### Implementation for User Story 8

- [ ] T045 [US8] The tenant (contracts/tenant-and-config.md): `auth0/main.tf` (the agent's client and its credentials; the second scope; `auth0_role.agent` and its permission; the machine clients, credentials and grants by `for_each`; the header comment), `auth0/variables.tf` (`agent_origin`, `machine_caller_keys`), `auth0/outputs.tf` (`bicepparam_agent`, `l1_env`, `l2_env`), `.github/workflows/provision-auth0.yml` (`VAR_*`, the export loop), `infra/github-setup.sh` (`AUTH0_VARIABLES`), `auth0/README.md`. `terraform -chdir=auth0 fmt` if Terraform is installed; say so if it is not.
- [ ] T046 [US8] Azure (contracts/tenant-and-config.md "Azure"): `infra/pre-deploy.bicep` and `infra/pre-deploy.dev.bicepparam` (no API app registration, service principal, role, assignments, `agentUsers`, `retirePortalScope`, `names.apiApp`); `infra/main.bicep` (`agent`, its checks, `identity` and `agent` to the l1 and l2 modules, no `authAudience`); `infra/main.dev.bicepparam` (`agent` with `REPLACE_ME`-style empty IDs until Terraform has run, `apiDocs: true`, `names.jobs.smoke`); `infra/modules/l1-apps.bicep` (the agent's env, the smoke job, the regression job's machine settings); `infra/modules/l2-apps.bicep`; `infra/cleanup.sh`.
- [ ] T047 [US8] `.github/workflows/deploy.yml`: step 0 reads `names.jobs.smoke` and not `authAudience`; step 8 starts the smoke job. `docker/l1-agent.Dockerfile` comment if it names the docs rule.

**Checkpoint**: `BICEP_PATH=~/.azure/bin/bicep npm test` green.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [ ] T048 [P] Finish `SPEC.md` v1.17 against what was delivered (every row of plan.md "SPEC and governance changes"; §12's test rows; §13 if the delivery order needs a line) and check the constitution's 2.0.0 text and residual risks against the code.
- [X] T049 [P] Update `specs/README.md` (the 016 row, SPEC v1.17, traceability for L1-6, L2-5, L2-7, L2-8, CFG-2, SEC-13, SEC-14, SEC-20, SEC-32..34, the new test IDs) and add a dated pointer to 016 at the top of `specs/011-l1-hosted-agent-azure/contracts/access-and-sessions.md`, `specs/013-l2-portal-onboarding/research.md` (R19, R20) and `specs/015-per-user-approval/contracts/control-api.md`.
- [X] T050 [P] Update `CLAUDE.md` (what the repo is; hard rules 2 and 10; the commands; "how to make common changes" for an L2 route and a hosted agent route; the gotchas about Entra tokens, the two applications, `API_DOCS` in `infra/`, the vault secrets to seed, the first-deployment order), `README.md` and `docs/` diagrams if they show the directory.
- [ ] T051 Run quickstart.md §1, §2 and §7 and record each result in its Validation log; list §5 and §6 as the owner's steps with the tenant and Azure, not run here.
- [ ] T052 Check the delivery order against research R16 before opening pull requests: no pull request leaves a deployed environment where L1's word names a user, and the settings of Phase 10 are in the same pull request as, or an earlier one than, anything that needs them.

---

## Dependencies & Execution Order

### Phase dependencies

- Phase 1 before everything; T002 before any code.
- Phase 2 before every story.
- Phase 3 (US2) before Phases 4, 5 and 6.
- Phase 4 (US3) before Phase 5 (US1).
- Phase 7 (US6) and Phase 8 (US5) need Phase 4 only, and are independent of each other.
- Phase 9 (US4) needs Phases 3 and 4; Phase 10 needs Phase 9.
- Phase 11 last.

### Within each story

Tests first, failing; then implementation in the order listed; a story's OpenAPI document with its service
change, never after.

### Parallel opportunities

T004 and T007; T009, T010 and T011; T018, T019 and T020; T032 beside T031; T038 and T039; T042, T043 and T044;
T048, T049 and T050.

## Implementation Strategy

### MVP first (User Stories 2, 3 and 1)

Phases 1 to 5: L2 decides from a verified token, the agent accepts the tenant's callers, and a person's run
works end to end locally with the dev issuer. `npm run check` is green with the baseline summary.

### Along the plan's slices

| Slice (research R16) | Tasks |
|---|---|
| 1. Scope amendments and the shared caller check | T001–T007 |
| 2. L2 takes the user from the token; L1 forwards it; Entra leaves the agent's code; 015's fields removed | T008–T030 |
| 3. Streaming | T031–T035 |
| 4. The docs page's sign-in | T036, T037 |
| 5. The machine caller, the tenant, Azure, the pipeline, then the documents | T038–T052 |

## Notes

- Commit after each task or small group, with the task IDs and requirement IDs in the message; tick the task
  (`- [X]`) in the same commit.
- A task that changes a field, route, status or header also changes its OpenAPI document and its SPEC table in
  the same task (T-API fails otherwise).
- If a task turns out wrong or impossible as written, stop on it, say what was found and why, and carry on with
  the tasks that do not depend on it.
- The live checks of quickstart.md §5 and §6 need the owner: the tenant, the vault secret, the role assignment
  and a deployment.
