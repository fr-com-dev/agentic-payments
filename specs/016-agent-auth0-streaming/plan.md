# Implementation Plan: Auth0 Sign-In, Token Propagation and Streaming for the Hosted Agent

**Branch**: `claude/016-agent-auth0-streaming` | **Date**: 2026-11-15 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/016-agent-auth0-streaming/spec.md`

## Summary

The hosted agent accepts callers from one issuer, the Auth0 tenant: people who hold the new role `x402-agent`
(permission `agent:run`) and sign in through a new public client, and machine callers with their own
confidential client. Entra leaves the agent. L1 forwards the caller's token to L2 on its two calls, in a second
header beside its role token; L2 verifies the token with the same shared check and takes the user from it, so a
payment request can no longer name a user, and 015's `approvalSubject` field is replaced by the token's subject.
The run route answers with server-sent events when asked, from one streaming model path that also serves the
JSON answer. The agent's Swagger UI signs a person in with the tenant, and a parameter can turn the page on for
a deployed agent. The pipeline's hosted smoke run and scripted regression become jobs that call as one machine
caller, `checks`, whose key is in the l1 vault and never in GitHub.

The design decisions are in [research.md](research.md) (R1 to R16), the shapes in [data-model.md](data-model.md),
the interfaces in [contracts/](contracts/), and the way to check it in [quickstart.md](quickstart.md).

## Technical Context

**Language/Version**: TypeScript 5 (strict, ESM), Node 26 in development (SPEC §5 floor: Node ≥ 22.13 for
Mastra); HCL (Terraform ≥ 1.11, `auth0/auth0` ≥ 1.60); Bicep.

**Primary Dependencies**: Express 5.3; `jose` 6 (token verification, the machine caller's assertion);
`@mastra/core` 1.75.0 as a library (`Agent.stream`); `ai` 6 test helpers; `swagger-ui-dist` 5.33.1. No new
package.

**Storage**: none new. The hash-chained JSONL ledger is unchanged: no new entry type, no new field.

**Testing**: Vitest. The dev issuer (`scripts/dev-issuer-lib.ts`) signs people's and machine tokens; the
stand-in approval service (`test/helpers/ciba-stub.ts`); Bicep and Terraform static suites (T-IAC-01 with
`BICEP_PATH`, T-IAC-02); OpenAPI conformance (T-API).

**Target Platform**: local processes (`NETWORK=local`) and Azure Container Apps (dev), Auth0 tenant.

**Project Type**: multi-process service (L1, L2, L3, portal, counterparty) with infrastructure as code.

**Performance Goals**: NFR-006: the `run` event within 2 s of acceptance; text forwarded within 1 s of the
model producing it. The smoke run stays under 120 s (SC-009 of 011).

**Constraints**: CLAUDE.md hard rules 1 to 11; no network call inside L2's serialized section; `policy.ts`,
`ledger.ts` and `signer.ts` not edited; every new check proven by a must-fail test through test-only
dependencies; the demo's summary unchanged.

**Scale/Scope**: about 25 source files, 20 test files, the tenant's Terraform, three Bicep files, one workflow,
three OpenAPI documents, `SPEC.md`, the constitution and the operating guides.

## Constitution Check

*Gate: checked before research and again after design.* Constitution 1.8.0; this feature amends it to 2.0.0
first (FR-047, task T002).

| Principle | Before the amendment | After design |
|---|---|---|
| I. Separation of payment authority | Holds. L2 stays the only signer and decider; L1 holds no payment key. | Holds. L2 trusts L1 for less than before: not for who the payment is for. |
| II. Deterministic, pure policy | Holds. `policy.ts` is not edited; the user reaches it as today, in the context `service.ts` builds. | Holds. |
| III. Ledger is the single source of truth | Holds. No entry type, no field, no counter. | Holds. |
| IV. Trust the chain, not the counterparty | Not touched. | Not touched. |
| V. Least-privilege credentials | **Violated as written**: "A requester credential … MUST NOT be forwarded to L2 or L3"; "a system identity's from the organization's directory"; "the only credential GitHub holds" stays true. | Amended in 2.0.0: the requester's token is forwarded to L2 only, beside L1's role token, and opens no route by itself; both kinds of requester come from the sign-in tenant; a machine caller's key is an authentication credential confined to one module (A15) and kept in a vault. |
| VI. Exact money arithmetic | Not touched. | Not touched. |
| VII. Protocol fidelity | Not touched (x402 headers). Server-sent events follow the standard format. | Holds. |
| VIII. Proven safety | Applies to every new check. | Each has a must-fail test ([Proofs](#proofs-constitution-viii)). |

Scope constraints amended with it: "people sign in with Auth0; system identities stay on Entra" (1.6.0) and "no
application of the tenant for the agent" (1.7.0) are replaced; "the API docs are never served in Azure" gains
its one exception. The gate passes on the condition that T002 lands before any code, which the task order
enforces.

## Project Structure

### Documentation (this feature)

```text
specs/016-agent-auth0-streaming/
├── spec.md
├── plan.md              # this file
├── research.md          # R1..R16
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── control-api.md        # L2: the caller's token, the two routes
│   ├── hosted-agent-api.md   # L1: who is accepted, the stream, the docs page
│   └── tenant-and-config.md  # Auth0, settings, Azure, the pipeline
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source code (repository root)

```text
src/shared/
├── identity-token.ts        # + verifyCaller; - verifyServiceToken and the directory's constants
├── contracts.ts             # PaymentIntent (no approvalSubject), AuthorizationGatePort.budget(sessionId)
└── api-docs.ts              # + optional signIn: OAuth2 scheme, initOAuth, redirect assets, connect-src
src/layer1-intent/
├── ports-http.ts            # + HttpAuthorizationGate.forCaller; the header
├── orchestrator.ts          # - userId, - approvalSubject
└── hosted/
    ├── requester-auth.ts    # one issuer; returns the requester and the token
    ├── config.ts            # required sign-in settings; refuses the directory's; API_DOCS_CLIENT_ID
    ├── server.ts            # gate.forCaller per run; stream or JSON
    ├── agent.ts             # agent.stream, onText
    ├── sse.ts               # new: wantsStream, the event writer, keep-alive
    └── api-docs.ts          # passes signIn
src/layer2-control/
├── caller.ts                # new: callerAuth, settings from env, ForwardedIdentity
└── service.ts               # the two routes; the user from the caller; refuses userId/approvalSubject
src/machine-caller/token.ts  # new: client-credentials token with a signed assertion (A15)
src/main.ts                  # CLI agent: forwards a machine token when configured
src/smoke-main.ts            # new: the smoke client
src/hosted-main.ts           # wiring
scripts/                     # dev-issuer-lib, dev-token, stack-local (--sign-in), vscode-local, image-closure
auth0/                       # main.tf, variables.tf, outputs.tf, README.md
infra/                       # pre-deploy.bicep, main.bicep, modules/l1-apps.bicep, modules/l2-apps.bicep,
                             # *.bicepparam, cleanup.sh, github-setup.sh
.github/workflows/           # deploy.yml (steps 0 and 8), provision-auth0.yml (variables)
docs/                        # l1-hosted.openapi.yaml, l2-control.openapi.yaml
env/                         # l1-hosted, l2-control, l1-agent examples
test/                        # see "Tests defined here"
```

**Structure decision**: the existing layout. Two new folders outside the layers: none for L2 (one new file in
its own folder), and `src/machine-caller/` for the one module that holds the machine caller's key, used by two
entry points and by no layer.

## Design

### The shared caller check (`src/shared/identity-token.ts`)

Research R2. `verifyCaller(token, { issuer, audience, clientIds, keys, algorithms, clockToleranceSec?,
skipChecks? })`. It calls the same `jwtVerify` options as `verifyPersonToken`, maps `JWTExpired` to
`reason: "expired"`, and then branches on the kind. `verifyPersonToken` keeps refusing machine tokens for the
portal. The directory's verifier and constants are deleted in the same change, with their tests.

### L1: the hosted agent

- `config.ts`: the three sign-in variables are required; `AUTH_TENANT_ID` or `SERVICE_AUDIENCE` present is a
  `ConfigError` naming it; `API_DOCS_CLIENT_ID` must be on the list and needs a tenant issuer.
- `requester-auth.ts`: one branch. It sets `res.locals.requester` and `res.locals.callerToken`, and no longer
  deletes the header (the token is needed until the run ends). Nothing else reads `callerToken` but the run
  route.
- `server.ts`: `HostedDeps.gate` becomes `{ forCaller(token: string): AuthorizationGatePort }`. Per run:
  `const gate = deps.gate.forCaller(token)`. `runGoal` gets that gate and no `userId`. `bypassAuth` (test only)
  uses `forCaller("")`, which sends no header.
- A refused caller at L2 reaches the tool as a `PortHttpError`. `fetchPaid` already turns a failed gate call
  into an `ERROR` result; the message for 401 `caller_token_expired` is "the sign-in has expired: sign in again",
  and for the other caller refusals "the caller was refused by the control layer". The run is not retried.
- Streaming: research R7. `agent.ts` switches to `agent.stream` with `eagerToolExecution: false`; `server.ts`
  chooses the writer.
- Docs: research R8.

### L1: the CLI agent and the smoke client

Research R9. `src/main.ts` builds its gate as today and, when a caller token source is configured, wraps it
with `forCaller`. `src/smoke-main.ts` is about sixty lines: token, target, `POST /v1/runs` with `Accept:
application/json`, the checks, the exit code. Both refuse to start if the payer key is visible, as every L1
entry point does.

### L2

Research R4 and [contracts/control-api.md](contracts/control-api.md). The two routes become
`requireRole → callerAuth → (express.json) → handler`. `decideOnce` and the budget handler read
`res.locals.caller`. `refuseUnreadBody` stays. Nothing in `policy.ts`, `ledger.ts`, `signer.ts`,
`approval-routes.ts` or `admin-routes.ts` changes.

### The tenant, Azure, the pipeline

Research R9 to R12 and [contracts/tenant-and-config.md](contracts/tenant-and-config.md).

## Requirement traceability

| Requirement | Where | Test |
|---|---|---|
| FR-001..FR-005, FR-008 | `identity-token.ts`, `requester-auth.ts`, `config.ts`, dev issuer | T-AGT-09, T-AGT-03/06/07 rewritten, identity-token tests |
| FR-006, FR-007 | `server.ts`, `session-ref.ts` (unchanged) | T-AGT-04 extended for a machine caller |
| FR-009 | `ports-http.ts`, `server.ts` | T-AGT-10, T-ARCH-A14 |
| FR-010..FR-013, FR-018 | `caller.ts`, `service.ts` | T-CTK-01..04 |
| FR-014, FR-015 | `caller.ts`, `service.ts` `main()` | T-CTK-05, T-CTK-06 |
| FR-016 | `service.ts` route order | T-CTK-01, T-API-01..04 |
| FR-017 | `service.ts` | T-CTK-02 (machine), T-USR-06 kept |
| FR-019 | `service.ts` | T-CTK-08 (verification outside the serialized section) |
| FR-020, NFR-004 | all | T-CTK-07 (planted token scan) |
| FR-021, FR-024..FR-027 | `auth0/` | T-IAC-02 |
| FR-022, FR-023 | `machine-caller/token.ts`, `l1-apps.bicep`, `deploy.yml` | T-ARCH-A15, T-IAC-01 rule 23, T-E2E-AZ, T-AGT-13 |
| FR-028..FR-031, FR-033 | `api-docs.ts` | T-API-16, T-API-17 |
| FR-032 | `main.bicep`, `l1-apps.bicep` | T-IAC-01 rule 23, T-API-08 |
| FR-034..FR-040 | `agent.ts`, `sse.ts`, `server.ts` | T-AGT-11, T-AGT-12, T-AGT-02 kept |
| FR-041, FR-042 | `service.ts`, `contracts.ts` | T-CIBA-15..18 through the token, T-AGT-08, T-E2E-15 |
| FR-043 | `specs/015/tasks.md` | review |
| FR-044 | `config.ts` | T-AGT-14 |
| FR-045, FR-046 | `infra/` | T-IAC-01 rules 16, 23 |
| FR-047, FR-048 | `SPEC.md`, constitution, OpenAPI | T-API-01..08, review |

## Proofs (Constitution VIII)

| Check | Test-only switch | Without it |
|---|---|---|
| The user comes from the token (FR-011, FR-012) | `caller.trustIntentUser` | a request naming Bob with Alice's token is signed by Bob's account |
| A token is required where sign-in is configured (FR-014) | `caller.skipRequired` | a request with the role token alone is paid by the platform account |
| The client rule at L2 (FR-018) | `caller.skipClientCheck` | a portal-client token forwarded to L2 pays |
| The permission (FR-002, FR-004) | `skipChecks: ["permission"]` on `verifyCaller` | a person without the role starts a run; a machine token without the grant pays |
| A machine token's `sub` matches its client | `skipChecks: ["machineSubject"]` | a token naming another client is accepted as that client |
| One issuer at L1 (FR-001) | existing `bypassAuth` | a directory-shaped token starts a run |
| The token goes to L2 only (FR-009) | a fake gate and a fake settlement port that record headers | T-AGT-10 fails when `HttpSettlementVerifier` is given the token |
| The token is never recorded (FR-020) | a test-only `echoCaller` on L2 that writes it to the log | the scan finds it |

## Tests defined here

| ID | File | What |
|---|---|---|
| T-AGT-08 | `test/hosted-access.test.ts` | a person's run sends intents with no user and no subject, and forwards the token (reserved by 015, repurposed) |
| T-AGT-09 | `test/hosted-access.test.ts` | the five tokens of User Story 3; machine caller accepted and refused |
| T-AGT-10 | `test/hosted-access.test.ts` | the token reaches L2's two calls and nothing else: not L3, the model prompt, a step, the log or the answer |
| T-AGT-11 | `test/hosted-stream.test.ts` (new) | event order, `result` equals the JSON answer, refusals stay JSON, keep-alive |
| T-AGT-12 | `test/hosted-stream.test.ts` | disconnect aborts, deadline and failure end in `result`, a paid fetch completes |
| T-AGT-13 | `test/smoke-client.test.ts` (new) | the smoke client's checks and exit codes; it never prints the token |
| T-AGT-14 | `test/hosted-agent.test.ts` | settings: the three required, the directory's refused by name |
| T-CTK-01..08 | `test/caller-token.test.ts` (new) | L2's order of checks, the user from the token, machine caller, required token, startup refusals, the scan, verification outside the lock |
| T-API-16, T-API-17 | `test/openapi-hosted.test.ts` | the OAuth2 scheme and the redirect assets when configured; the policy's `connect-src`; absent when not configured |
| T-E2E-15 | `test/e2e.local.test.ts` | hosted agent, L2 with users and backchannel, the stand-in: a person's escalated run asks that person (reserved by 015) |
| T-E2E-16 | `test/e2e.local.test.ts` | hosted agent with a machine caller on the local chain: the platform account pays; with a person: their account pays |
| T-ARCH-A14, A15 | `test/architecture.test.ts` | the header's name and `forCaller`; the machine key's variables |
| T-IAC-01 rule 23 | `test/infra.test.ts` | sign-in settings on the agent and L2, nothing of the directory, the docs switch, the jobs' secret |
| T-IAC-02 | `test/auth0-iac.test.ts` | research R10 |

Rewritten: T-AGT-03, T-AGT-06, T-AGT-07, T-API-05..08, T-IAC-01 rules 11 (removed), 12, 15, 16, 21, the
T-E2E-AZ smoke assertions, `test/identity-token.test.ts`, `test/helpers/hosted.ts` (stream fakes) and every test
that sends `userId` or `approvalSubject` on an intent (they mint a dev token instead, through one helper).

## SPEC and governance changes (same change)

`SPEC.md` v1.17 and constitution 2.0.0, amended together in T002, before code.

| Where | Change |
|---|---|
| SPEC version line, "Changes in 1.17" | the rows below |
| §1.2, §1.3 | people and machine callers of the hosted agent come from the sign-in tenant; streaming answers; out of scope: forwarding from the portal |
| §3.1 Azure profile | the `agent` parameter; the smoke job; the docs switch; no directory object for callers |
| §3.3 | the requester's token: L1 and L2; the machine caller's key; the agent's client |
| §4 INV-13 | the caller's token is not a role token: it is accepted only beside L1's role token, on two routes |
| §7 | `PaymentIntent` without `approvalSubject`; `userId` set by L2; the gate port |
| L1-1, L1-2, L1-5, L1-6 | forwarding; one issuer; the stream; the docs page; settings; the smoke entry point |
| L2-5 | the two routes, the header, the statuses |
| L2-7 | owner and subject from the forwarded identity |
| L2-8 | the user of a run comes from the token L2 verified |
| CFG-2 | the variables of [tenant-and-config.md](contracts/tenant-and-config.md) |
| §11 | SEC-13 (docs page in a deployed environment by a parameter), SEC-14 (one issuer), SEC-20 (the client rule at L2 too), new SEC-32 (L1's word names no user), SEC-33 (machine callers), SEC-34 (the docs page's sign-in); residual risks: a compromised L1 can spend for a person whose token it has seen, until it expires; the agent's identity can read the machine caller's key |
| §12 | the tests above |
| Constitution | Principle V; scope constraints; residual risks; Sync Impact Report |
| `specs/README.md`, CLAUDE.md, README.md, `auth0/README.md` | the 016 row and traceability; the operating guide's rules and gotchas |

## Delivery

Research R16: five slices. Slice 5 changes what a deployed environment needs before its next L1 and L2
deployments: Terraform applied (the agent's client, the role, the `checks` client), `agent` pasted into the
parameter file, `machine-client-key` seeded in the l1 vault, the role assigned to each person by hand, and,
where the docs page is on, `AUTH0_AGENT_ORIGIN` set and Terraform applied again. [quickstart.md](quickstart.md)
§5 has the steps in order.

## Risks

| Risk | Mitigation |
|---|---|
| A machine token carries the permission only in `scope` | accepted for machine tokens (R2); checked live (quickstart §6) |
| Auth0 refuses Swagger UI's token call (preflight) | origins listed three ways (R8); pasting a token still works; checked live |
| The ingress cuts or buffers a stream | keep-alive every 15 s; the run's deadline is under the limit; checked live |
| Deployed out of order (L2 before the tenant, or without the vault secret) | `main.bicep` refuses the units without `agent.clientId`; the secret is seeded as `off`; quickstart §5 |
| The agent's identity can read the machine caller's key | recorded residual risk (R9); the hardening step is a unit of its own for the checks |
| A compromised L1 replays a caller's token within its lifetime | recorded residual risk; tokens live an hour; the person's own policy bounds it |
| Every hosted-agent test fake changes with the streaming path | one helper changes (`test/helpers/hosted.ts`); done first in that slice |

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Constitution V amended (the requester's token is forwarded) | the owner's decision; it removes L2's trust in L1 for the user | keeping the rule means L1's word names the user |
| A module outside the layers (`src/machine-caller/`) | two entry points need a machine token; the key must be confined to one file | putting it in `src/layer1-intent/` would put a credential in L1's layer code |
| A second job in the `l1` unit | the pipeline's smoke run needs a caller that GitHub holds no credential for | a GitHub secret or a vault read from the runner break Constitution V and T-E2E-AZ |
