# Implementation Plan: Loopback PKCE Sign-In from a Desktop Client for the Hosted Agent

**Branch**: `claude/spec-19-implementation-5b3595` | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/019-loopback-pkce-sign-in/spec.md`

## Summary

The tenant gains a fifth kind of application, the desktop client: native, public, authorization code with PKCE
and rotating refresh tokens, returning only to `http://127.0.0.1:53682/callback` or
`http://localhost:53682/callback`. The first post-login rule, `sign-in-time.js`, refuses sign-in and renewal
through it to anyone without `x402-agent` and refuses any PKCE method but S256, and then asks for a second
factor, as it already does for administrators. The
agent and L2 accept its tokens by listing it on `AGENT_CLIENT_IDS`; their token check is unchanged (permission
only). Before a person's run the agent asks L2's budget route, which now says whether the person can pay, and
refuses with 409 when they can't. The agent's 401 gains a code (missing, expired, invalid) beside the DAST
remediation's challenge. The run log names the client, and a token-free route serves the sign-in settings.

The decisions are in [research.md](research.md) (R1 to R16), the shapes in [data-model.md](data-model.md), the
interfaces in [contracts/](contracts/), and the way to check it in [quickstart.md](quickstart.md).

## Dependencies

Two features in progress change the same ground and land first ([research R2](research.md#r2-what-the-two-parallel-features-leave-in-place)):

| Feature | Branch | What this plan builds on |
|---|---|---|
| DAST findings remediation (`specs/017-dast-findings-remediation`) | `claude/spec-17-dast-findings-42d580` | `bearerChallenge` and `AGENT_REALM` on every agent 401; the failed-authentication limit per address; the dev issuer's local-only guard; SEC-43..48; the `plain` PKCE residual |
| Tenant sign-up hardening (pentest P1, `specs/018-tenant-signup-hardening`) | `claude/pentest-report-fixes-0709b1` | People's connections declared in `auth0/`, with the applications allowed on each, and their offline check in T-IAC-02; T-AGT-15 |

Both are merged into `main` (#58, #59): the DAST remediation is SPEC 1.27, the sign-up hardening 1.28 with T-PRT-19. This feature takes the next
free numbers after both: SPEC v1.29 (expected), SEC-49 onward, T-AGT-16 onward, T-CTK-10 onward, T-API-18. Its
code starts after this branch is rebased onto both.

Recorded at the rebase (tasks T001), and used by T011 and T015:

| What | Value |
|---|---|
| SPEC version and the last SEC, T-AGT, T-CTK and T-API IDs the two features took | SPEC 1.28; SEC-48, T-AGT-15, T-CTK-09, T-API-17 (and T-E2E-17, T-EDGE-06, T-PRT-19) |
| This feature's IDs, if any had to move | None: SPEC 1.29, SEC-49 onward, T-AGT-16..20, T-CTK-10..11 and T-API-18 are free |
| People's connection resources in `auth0/main.tf`, and the list on each that names its allowed applications | `auth0_connection_clients.database` and `auth0_connection_clients.google`, each `enabled_clients` (Google's empty unless `var.google_sign_in`) |

## Technical Context

**Language/Version**: TypeScript 7 (strict, ESM), Node 26 in development (SPEC §5 floor Node ≥ 22.13); HCL
(Terraform 1.15.5 pinned by the operator command, `auth0/auth0` ≥ 1.60, < 2.0); Bicep.

**Primary Dependencies**: Express 5.3; `jose` 6.2 (the shared caller check); `express-rate-limit` 8.7 (the
per-address limits); `@mastra/core` 1.85 as a library. No new package.

**Storage**: none new. The ledger is read for account readiness, as the budget route already does; no entry
type, no field. Refresh tokens live at the tenant and in the person's own client only.

**Testing**: Vitest. The dev issuer (`scripts/dev-issuer-lib.ts`) and the in-memory test issuer
(`test/helpers/caller-tokens.ts`) mint desktop-client tokens; T-IAC-02 runs the post-login rules' code in
`node:vm` against a stand-in for Auth0's `api`; T-IAC-01 with `BICEP_PATH`; OpenAPI conformance (T-API).

**Target Platform**: local processes (`NETWORK=local`), the VPS that hosts dev (agent at
`https://agent.fabriciorojas.com`), the Auth0 tenant applied from the operator's host. Azure templates stay
checked though the environment is deleted.

**Project Type**: multi-process service (L1, L2, L3, portal, counterparty) with infrastructure as code.

**Performance Goals**: NFR-005: the account question adds at most 1 s (a 1 s bound, then 503). SC-005: a
not-ready person learns why within 2 s.

**Constraints**: CLAUDE.md hard rules 1 to 11; the hosted agent keeps exactly `fetch_resource` and
`check_budget`; `policy.ts`, `ledger.ts` and `signer.ts` not edited; no network call inside L2's serialized
section; every new check proven by a must-fail test through a test-only dependency; the demo's summary
unchanged; no new secret anywhere; no token printed in tests, logs or the quickstart.

**Scale/Scope**: about 10 source files, 10 test files, the tenant's Terraform and one amended Action (`sign-in-time.js`; no new one), two Bicep
modules and the parameter files, two OpenAPI documents, `SPEC.md`, the constitution and the operating guides.
A handful of people; the agent runs as one replica.

## Constitution Check

*Gate: checked before research and again after design.* Constitution 3.0.0 (plus whatever the two dependencies
amend); this feature amends it as a MINOR version first (FR-027).

| Principle | Before design | After design |
|---|---|---|
| I. Separation of payment authority | Holds. No tool, input or route is added to the agent; the account question is a call L1 already makes. | Holds. `check_budget`'s output drops `account`, so the model learns nothing new. |
| II. Deterministic, pure policy | Holds. `policy.ts` is not edited. | Holds: readiness comes from `userGate`, the same pure function R16/R17 use. |
| III. Ledger is the single source of truth | Holds. No counter, no entry. | Holds: `account` is computed from the ledger on each read. |
| IV. Trust the chain | Not touched. | Not touched. |
| V. Least-privilege credentials | Holds. The desktop client is public (no secret, no key); the post-login rule holds no secret; the caller's token still goes to L2 only, on budget and authorize; refresh tokens never reach a service. | Holds. One amendment, recorded before code: the tenant's fixed applications go from three to four, and Principle V says where refresh tokens may exist (the person's own client only). |
| VI. Exact money arithmetic | Not touched. | Not touched. |
| VII. Protocol fidelity | Not touched. | Not touched. |
| VIII. Proven safety | Every new check has a must-fail ([Proofs](#proofs-constitution-viii)). | Holds. |
| Technology & Scope | "three fixed applications … two permissions and two roles": the desktop client would be a fourth application. | Amended first (MINOR). Still two permissions and two roles; no new package; client code stays out of scope. |

No violation needs justifying: Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/019-loopback-pkce-sign-in/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R16
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── hosted-agent-api.md
│   ├── control-api.md
│   └── tenant-and-config.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks, not created here
```

### Source code (repository root)

```text
auth0/
├── main.tf                     # auth0_client.desktop (+ credentials), connections list
├── sign-in-time.js             # desktop client only: no role → deny, not S256 → deny, then the second factor
├── outputs.tf                  # l1_env, l2_env, bicepparam_agent carry the desktop client
└── README.md                   # the desktop client, rollout, rollback
src/shared/
├── contracts.ts                # BudgetStatus.account?
└── identity-token.ts           # (unchanged check) Caller.client already there
src/layer1-intent/hosted/
├── config.ts                   # AGENT_DESKTOP_CLIENT_ID
├── requester-auth.ts           # error_code on 401; Requester.client; revealCheck test hook
├── server.ts                   # the account question; the settings route; client in log lines
├── account-check.ts            # NEW: one budget call → ready | 409 code | 401 | 503
├── agent.ts                    # check_budget drops `account`
├── run-log.ts                  # `client` on step and run lines
└── api-docs.ts                 # signIn scopes
src/layer2-control/
├── caller.ts                   # 403 user_accounts_off (row 6)
└── service.ts                  # budget user view gains `account`
scripts/
├── dev-issuer-lib.ts           # DEV_DESKTOP_CLIENT
├── dev-token.ts                # --desktop
├── demo-lib.ts, vscode-local.ts # AGENT_CLIENT_IDS with both dev clients
infra/
├── main.dev.bicepparam         # agent.desktopClientId
└── modules/l1-apps.bicep, l2-apps.bicep   # AGENT_CLIENT_IDS with it; AGENT_DESKTOP_CLIENT_ID (l1)
docs/
├── l1-hosted.openapi.yaml      # error_code, 409, 503, /.well-known/agent-auth, signIn scopes
└── l2-control.openapi.yaml     # BudgetStatus.account, user_accounts_off
env/l1-hosted.env.example, env/l2-control.env.example
test/
├── hosted-desktop.test.ts      # NEW: 019 US1 (a desktop token runs) and T-AGT-19 (limits per person)
├── hosted-account.test.ts      # NEW: T-AGT-17 (the account question)
├── hosted-refusals.test.ts     # NEW: T-AGT-16 (the 401 codes)
├── hosted-run-log.test.ts      # NEW: T-AGT-20 (the client in the log, the known-value scan)
├── hosted-sign-in-settings.test.ts   # NEW: T-AGT-18 (the settings route and its config)
├── caller-token.test.ts        # T-CTK-10, T-CTK-11; row 6's code
├── e2e.local.test.ts           # T-E2E-16 rewritten: a person without an account gets 409; 019 US1, US4, US5, US6 cases; accounts off
├── e2e.full.test.ts            # T-E2E-17: a desktop sign-in step; a disabled account gets 409
├── hosted-run.test.ts          # budget overrides answer account: "ready"
├── auth0-iac.test.ts           # T-IAC-02 amended, the rules run
├── infra.test.ts               # T-IAC-01 amended
├── openapi-hosted.test.ts, openapi.test.ts   # T-API-18, T-API-01..04
└── helpers/caller-tokens.ts, helpers/hosted.ts   # the desktop client in the default lists; fakePorts' budget says ready
SPEC.md, .specify/memory/constitution.md, CLAUDE.md, README.md, specs/README.md
```

**Structure Decision**: the existing layout. The one new source file, `account-check.ts`, sits in the hosted
agent's folder and imports only `../../shared/*` and its own folder (hard rule 1). The tenant gains no Action.

## Design

### L1: the hosted agent

- **401 codes** ([R10](research.md#r10-the-readable-401)): `requesterAuth` answers `{ error: "unauthorized",
  error_code }`, from `verifyCaller`'s existing `reason` (`expired` → `token_expired`, `invalid` →
  `invalid_token`) and `missing_token` when there is no bearer token. The DAST remediation's
  `bearerChallenge(AGENT_REALM, tokenPresented)` stays as it is. A test-only `revealCheck` dep is the must-fail.
- **Requester.client**: set from `Caller.client`; `run-log.ts` writes it on step and run lines.
- **Account question** ([R8, R9](research.md#r9-where-the-question-sits-and-what-it-answers)): `account-check.ts`
  exports `checkAccount(gate, sessionId, { timeoutMs: 1000 })` → `{ ok: true } | { status, body }`, using the
  mapping table in [contracts/hosted-agent-api.md](contracts/hosted-agent-api.md#the-account-question-a-persons-run-only).
  `server.ts` calls it for a `user` requester after the session check and before `limiter.start`, so a refusal
  is not counted, opens no stream and makes no model call. `skipAccountCheck` is the test-only must-fail dep.
- **check_budget**: its output drops `account` before the model sees it, so a step's `result` and the JSON answer
  keep their fields.
- **Settings route** ([R12](research.md#r12-the-sign-in-settings-route)): `GET /.well-known/agent-auth`, mounted
  after the per-address and failed-authentication limits and before `requesterAuth`, only when
  `config.auth.desktopClientId` is set. A pure function of the settings.
- **Config**: `AGENT_DESKTOP_CLIENT_ID`, checked like `API_DOCS_CLIENT_ID` (on the list, not with the dev issuer).

### L2

- `caller.ts`, row 6: 403 `user_accounts_off` instead of `caller_forbidden`.
- `service.ts`, budget user view: `account: userGate(state) ?? "ready"`, in the same read; nothing appended.
- `contracts.ts`: `BudgetStatus.account?`.

### The tenant

[contracts/tenant-and-config.md](contracts/tenant-and-config.md): the desktop client, its credentials resource,
`sign-in-time.js` amended (the two refusals, then the challenge), the connections' application lists, the
outputs. The rule recognizes the desktop client by its `client_metadata` marker, not by a secret or a templated
ID ([R4](research.md#r4-how-the-tenants-rules-recognize-the-desktop-client)); the refusals sit in the first rule
because Auth0 may reissue `event.request` after a challenge ([R5](research.md#r5-the-post-login-rule-refusal-and-pkce)).

### Settings, the dev issuer, infra

Both dev clients on every local list; `dev-token -- --desktop`; `agent.desktopClientId` in the parameter files
and the two app modules ([R7](research.md#r7-the-services-lists-and-settings), [R13](research.md#r13-the-dev-issuer-and-the-tests)).

## Requirement traceability

| Requirement | Where | Test |
|---|---|---|
| FR-001..004 | `auth0/main.tf` desktop client; no `default_audience` | T-IAC-02; quickstart §5 L6 (another API's token refused), L15 (the callbacks), L16 (revoked refresh tokens) |
| FR-005 | T-IAC-02's application list (five kinds), roles and permissions unchanged | T-IAC-02 |
| FR-006, FR-008 | `auth0/sign-in-time.js`, checks 1 and 2; the tenant's own verifier check | T-IAC-02 (rules run); quickstart §5 L3, L9, L14 |
| FR-007 | `auth0/sign-in-time.js`, check 3 | T-IAC-02 (rules run); quickstart §5 L12 |
| FR-009 | connections' application lists | T-IAC-02 (connections) |
| FR-010 | no secret: credentials `none`, no Action secret | T-IAC-02 |
| FR-011 | `AGENT_CLIENT_IDS` at the agent and L2, outputs, env examples, Bicep | T-IAC-01, T-IAC-02, T-AGT-18 |
| FR-012, FR-013 | `verifyCaller` unchanged; machine path and docs sign-in unchanged | existing T-CTK, T-AGT, T-API suites |
| FR-014 | run limiter keyed by issuer and `sub` (unchanged) | T-AGT-19 |
| FR-015..019 | `account-check.ts`, `server.ts`, L2 budget view, `caller.ts` row 6 | T-AGT-17, T-CTK-10, T-CTK-11, T-E2E-16, T-E2E-17 |
| FR-020..022 | `requester-auth.ts` | T-AGT-16 |
| FR-023 | `run-log.ts`, `Requester.client` | T-AGT-20 |
| FR-024..026 | settings route, `api-docs.ts` scopes | T-AGT-18, T-API-18 |
| FR-027, FR-028 | SPEC, constitution, OpenAPI documents | T-API-01..08, T-API-18 |
| NFR-003 | known-value scan; refresh tokens and codes never sent to a service | T-AGT-20, T-E2E-16 (the ledger); quickstart §5 L18 |
| NFR-006 | `npm run demo:local` | the definition of done |
| SC-007 | the services' lists (rollback) | quickstart §5 L17; turning the client off at the tenant is not run |

## Proofs (Constitution VIII)

| Check | Must-fail switch (test-only dep) | Unsafe outcome it shows |
|---|---|---|
| 401 says nothing beyond missing / expired / invalid | `revealCheck` on `requesterAuth` | Two invalid tokens get different answers |
| The account question | `skipAccountCheck` on the hosted app | A not-onboarded person's run calls the model and is denied per purchase |
| Limits per person, any client | `limitKey` on the hosted app | A third concurrent run through the second client starts |
| L2's distinct accounts-off code | `singleForbiddenCode` on L2's `caller` dep | The agent answers a misconfiguration with 409 instead of 503 |
| User view from the token | `trustIntentUser` (existing) | Another person's readiness is reported |
| The desktop rule on renewal | a rule variant that checks sign-in only (T-IAC-02 mutant) | A renewal without the role passes |
| S256 only | a rule variant that accepts `plain` (T-IAC-02 mutant) | `plain` passes |
| Refusals before the challenge | a rule variant that challenges first (T-IAC-02 mutant) | A person without the role is asked for a second factor |
| The desktop client's shape | T-IAC-02 mutants (third grant, wildcard callback, leeway, secret, `local_origins`, a `default_audience`) | Each is reported |
| The desktop client on the services' lists | T-IAC-01 mutant (a template drops it from L2's list); T-IAC-02 mutant (an output without it) | The agent accepts a desktop token that L2 then refuses |
| The desktop client's connections | T-IAC-02 mutant (the desktop client on a third connection) | A desktop sign-in through a connection people don't use |
| Start refusal for an advertised client not on the list | None needed: T-AGT-18 expects `loadHostedConfig` to throw, as for `API_DOCS_CLIENT_ID`, so removing the check fails it | The settings route advertises a client whose tokens get 403 |

## SPEC and governance changes (same change, before code)

- `SPEC.md` (expected v1.29): "Changes in 1.29"; §3.3 the desktop client and its refresh tokens; L1-6 the 401
  codes, the account question, the settings route, the run log's client; L2-5 row 6's code and the budget user
  view's `account`; §7 `BudgetStatus.account`; CFG-2 `AGENT_DESKTOP_CLIENT_ID` and the two-client
  `AGENT_CLIENT_IDS`; §11 new SEC entries from SEC-49 (a captured loopback code, a stolen refresh token, a
  desktop sign-in without the role, PKCE downgrade), with the DAST rule's one exception recorded on its entry;
  §12 the new and amended tests.
- Constitution MINOR (3.x → next): Technology & Scope (four fixed applications); Principle V (refresh tokens
  exist only in the portal's web app and the desktop client, never at a service). Sync Impact Report.
- `CLAUDE.md` gotchas (the tenant's applications, the desktop client, the account question), `auth0/README.md`,
  `README.md`, `specs/README.md` (row 019 and traceability), the env examples.

## Delivery

1. Rebase onto both dependencies; amend SPEC and the constitution.
2. L2: row 6's code, `account` on the user view, `contracts.ts`, `docs/l2-control.openapi.yaml`; T-CTK-10..11.
3. L1: `Requester.client` and the log, the 401 codes, the account question, `check_budget`'s output, the
   settings route and config, `docs/l1-hosted.openapi.yaml`; T-AGT-16..20, T-API-18.
4. Dev issuer and local lists; `npm run check`.
5. The tenant: desktop client, rule, `sign-in-time.js`, connections, outputs, README; T-IAC-02.
6. Infra parameters and modules; T-IAC-01.
7. Docs and indexes.
8. On the operator's host: plan, apply, the VPS's env files; the live check (quickstart §5), recorded.

## Risks

- **The rule is the only PKCE enforcement.** The tenant has no setting that requires PKCE or S256, and its code
  flow works without PKCE, so without check 2 a code with no challenge can be exchanged. `code_challenge` in
  `event.request.query` is documented; `code_challenge_method` beside it is likely but not documented. The rule
  refuses when either is missing, so an undocumented change fails closed; live check L9 confirms it
  ([R5](research.md#r5-the-post-login-rule-refusal-and-pkce)).
- **Roles on a renewal.** The post-login trigger runs on a refresh, but whether `event.authorization.roles` is
  filled there isn't documented. If it isn't, check 1 refuses every renewal: fail closed, found by live check L7.
  The fallback is to skip check 1 on renewals: a renewed access token carries the person's current permissions,
  so the agent and L2 still refuse a person whose role was removed (403), and the spec's US2 scenario 4 then
  reads "no run", not "no token".
- **The error of a refused renewal.** `api.access.deny` on a refresh isn't documented; the documented
  alternative, `api.refreshToken.revoke`, is an Enterprise feature. The plan uses `api.access.deny`; L7 and the
  role-removal check record what the client receives.
- **Consent on loopback.** The tenant may show a consent screen on a loopback return. Accepted (spec Edge Cases);
  recorded by L12.
- **Concurrent renewals in the client.** With leeway 0, a client that renews twice at once ends its own sign-in.
  The contract tells the client to renew from one place; nothing in the services can prevent it.
- **The dependencies move.** If the DAST remediation's challenge or the sign-up hardening's connections change
  shape before they merge, steps 3 and 5 follow them; the spec's FR-020 and FR-009 name what to keep.

## Complexity Tracking

None.
