# Implementation Plan: Remediation of the Portal's DAST Findings

**Branch**: `claude/spec-17-dast-findings-42d580` | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/017-dast-findings-remediation/spec.md`

## Summary

Close the seven findings of the unauthenticated DAST of the dev host (a portal on the local network profile
behind the owner's Caddy) in the portal itself, in the hosted agent where it shares the same checks, and in a
reference front-proxy configuration. The portal sends HSTS by the request's host name instead of the network
profile; the local dev sign-in refuses to start off loopback or behind a declared proxy and answers 421 to any
request that isn't from the machine; both public services add a limit of 20 failed authentications per address a
minute, with one log line per burst and a warning when a proxy is in front but undeclared; 401s carry the bearer
challenge; the portal answers 404 to anything that isn't its API, a built file or a screen of its web app; three
browser policy headers are added; the public configuration loses `network` and `admin`; the image's web build drops
the pasted-token sign-in. A Caddyfile and a procedure in `docs/self-hosted/` put the dev host behind the owner's
allow-list, without proxy banners or reachable health and docs routes. Nothing in L2, L3, the seller, the ledger or
the contracts changes. SPEC goes to v1.26.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22 ESM (SPEC §5 floor; development on Node 26)

**Primary Dependencies**: Express 5.3, express-rate-limit 8.7.5 (already used for the per-address limits), jose
(token checks, unchanged). Web app: React 19, Vite 8, `@auth0/auth0-spa-js` 2.30.0. Reference proxy: Caddy 2
(documentation only, not a dependency of any process here). No new package.

**Storage**: None new. Counters and "already logged" marks are in the replica's memory (`data-model.md`).

**Testing**: vitest (Node for services and tests under `test/`, jsdom for `web/portal/test`); the OpenAPI tests
(T-API-05..08 agent, T-API-12..15 portal); T-IMG-03 for the image's build commands; an optional
`caddy validate` when `CADDY_PATH` is set, as the Bicep suites use `BICEP_PATH`.

**Target Platform**: The portal and the hosted agent on Linux containers (Azure Container Apps) and on a developer's
machine; the self-hosted dev host behind Caddy; evergreen browsers for the web app.

**Project Type**: Web services plus a single-page web app, in one repository with layered processes.

**Performance Goals**: No measurable cost: three header sets per response, one regex table lookup on non-API
paths, one more in-memory limiter on `/api`.

**Constraints**: Hard rules 1–11 (CLAUDE.md); fail closed (spec NFR-004); no new setting and no new secret
(NFR-003); no address, token or path value in a log line; local work unchanged (NFR-001); the sign-in pop-up, card
registration and administrator decisions keep working (NFR-002); `demo:local` summary unchanged.

**Scale/Scope**: Two public services, about ten source files changed, one new shared module pair, one web flag, two
new docs, about eleven test IDs. 

No item is left as NEEDS CLARIFICATION: the one open decision (who may reach the dev host) was settled in the
spec's Clarifications, and every technical unknown is decided in [research.md](research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Before research | After design |
|---|---|---|
| I. Separation of payment authority | Pass. Only the portal, the hosted agent and `src/shared` change; no layer imports another; no key, signer or tool is touched. | Pass. `src/shared/local-only.ts` and `src/shared/portal-screens.ts` import nothing from a layer; the web app imports the shared screen table as it already imports `contracts.ts`; the hosted agent still offers only `fetch_resource` and `check_budget`. |
| II. Deterministic, pure policy | Pass. `policy.ts` untouched. | Pass. |
| III. Ledger is the single source of truth | Pass. Nothing is appended; the new counters limit requests, not money (rule 4 forbids spend counters, not request limits). | Pass. |
| IV. Trust the chain | Pass. L3 untouched. | Pass. |
| V. Least-privilege credentials | Pass. No credential is added, moved or widened. The caller's and the person's tokens are still read only where they are today. | Pass. The challenge header names a realm, never a token; the failure limit counts before a token is read; the dev issuer's tokens are accepted only from the machine itself, which narrows where a development credential works. |
| VI. Exact money arithmetic | Pass. No amount is handled. | Pass. |
| VII. Protocol fidelity | Pass. x402 headers untouched. | Pass. |
| VIII. Proven safety | Pass, planned: every new mechanism gets a must-fail switch. | Pass. Must-fail switches, all test-only deps, never env: `skipLocalOnly` (portal and agent), `skipFailureLimit` (portal and agent), `skipNotFoundRules` (portal). The headers and the challenge are proven by assertions on every kind of answer, and the deployment build by a control build that does contain the dev sign-in (spec FR-028 as amended below). |
| Technology & scope | Pass. No new package; Caddy appears only as a reference configuration for an environment the owner already runs. | Pass. |
| Quality gates | Pass, planned: typecheck, full tests, demo summary, SPEC v1.26 in the same change, requirement IDs in test names and commits. | Pass. |

No violation, so Complexity Tracking stays empty. The constitution needs no amendment: no principle, invariant or
package changes, and the residual risks go to SPEC §11, as 1.18–1.25's security remediations did.

**Spec amendment made with this plan**: FR-028 listed "the headers" among the mechanisms that need a must-fail
switch. A switch that removes a header only proves the assertion runs; the plan proves the headers by checking
them on every kind of answer instead, and keeps must-fail switches for the guards, the limit and the 404 rules.
FR-028 is reworded accordingly.

## Project Structure

### Documentation (this feature)

```text
specs/017-dast-findings-remediation/
├── spec.md                 # the feature spec (with the 2026-11-23 clarification)
├── plan.md                 # this file
├── research.md             # decisions R1..R15
├── data-model.md           # in-memory state, tables and the disposition record
├── quickstart.md           # validation guide, local and on the dev host
├── contracts/
│   ├── portal-edge.md      # the portal's answers: headers, 404s, 421, 429, the challenge, the public config
│   ├── hosted-agent-edge.md# the hosted agent's deltas: 421, the failure limit, the challenge
│   └── self-hosted-proxy.md# what the reference Caddyfile must do, and the portal settings behind it
├── checklists/requirements.md
├── dispositions.md         # written during implementation (FR-027)
└── tasks.md                # /speckit-tasks, not created here
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── local-only.ts        # NEW: isLoopbackHost, isLoopbackBind, FORWARDING_HEADERS, localOnly() → 421
│   ├── portal-screens.ts    # NEW: PORTAL_SCREENS table and isScreenPath()
│   ├── address-limit.ts     # + failedAuthLimit() (20 a minute, onLimit hook), proxyWarning()
│   └── identity-token.ts    # + bearerChallenge(realm, tokenPresented)
├── portal/
│   ├── config.ts            # dev sign-in: loopback bind and no declared proxy, or ConfigError
│   ├── server.ts            # HSTS by host; Permissions-Policy, CORP, COOP; localOnly first in dev; the
│   │                        #   failure limit after addressLimit; proxy warning; 404 rules; smaller /api/config
│   ├── access.ts            # WWW-Authenticate on each 401
│   └── log.ts               # `count` joins the whitelist
├── layer1-intent/hosted/
│   ├── config.ts            # the same dev sign-in start-up check for AGENT_BIND_HOST and TRUSTED_PROXY_HOPS
│   ├── server.ts            # localOnly first in dev; failure limit after addressLimit; proxy warning
│   ├── requester-auth.ts    # WWW-Authenticate on each 401
│   └── run-log.ts           # + event() for auth_failure_limit and proxy_undeclared
web/portal/
├── src/
│   ├── env.d.ts             # ImportMeta.env.MODE
│   ├── auth/dev-sign-in.ts  # NEW: DEV_SIGN_IN = import.meta.env.MODE !== "deployment"
│   ├── main.tsx             # dynamic import of auth/dev.js under DEV_SIGN_IN; a message when it's absent
│   ├── screens/SignedOut.tsx# pasted-token field under DEV_SIGN_IN
│   ├── app.tsx              # pasted-token identity confirmation under DEV_SIGN_IN; admin from me.admin only
│   ├── routes.ts            # export SCREEN_NEEDS (the `needs` record, lifted)
│   └── types.ts             # Config without network and admin
└── test/                    # T-WEB-14 (screen table drift), T-WEB-15 (admin area from me.admin); helpers' CONFIG
docker/portal.Dockerfile     # npm run build:web -- --mode deployment
docs/
├── portal.openapi.yaml      # 401 header, 429 descriptions, config schema, 404 note
├── l1-hosted.openapi.yaml   # 401 header, 429 description
└── self-hosted/             # NEW: Caddyfile and README.md (the procedure, FR-022)
test/
├── helpers/                 # portal.ts: the three switches; hosted.ts: `tenant: true` (Auth0-shaped issuer);
│                            #   NEW raw-request.ts: node:http requests with a chosen or missing Host and a raw path
├── edge-local-only.test.ts  # NEW: T-EDGE-01..03 (loopback rules; dev sign-in start-up and per request, both services)
├── edge-failure-limit.test.ts # NEW: T-EDGE-04..05 (the failure limit and the proxy warning, both services)
├── edge-challenge.test.ts   # NEW: T-EDGE-06 (the challenge, both services)
├── portal.test.ts           # T-PRT-01 config expectation; T-PRT-07 HSTS line; NEW T-PRT-16 (headers by host and
│                            #   on every answer kind), T-PRT-17 (404 rules, the probe list), T-PRT-18 (config)
├── portal-admin.test.ts     # /api/config no longer carries admin
├── web-build.test.ts        # NEW: T-WEB-16 (deployment build has no dev sign-in; default build does)
├── self-hosted.test.ts      # NEW: T-PROXY-01 (Caddyfile directives; caddy validate with CADDY_PATH)
└── images.test.ts           # T-IMG-03 "gained" case: the new build:web literal
SPEC.md, specs/README.md, specs/007/contracts/threat-matrix.md, specs/013/contracts/portal-api.md,
specs/014/contracts/portal-api.md, specs/011/contracts/hosted-agent-api.md, specs/016/contracts/hosted-agent-api.md,
CLAUDE.md
```

**Structure Decision**: No new process, layer or image. The two shared modules sit in `src/shared` because both
public services (and, for the screen table, the web app) need the same rule. The reference proxy lives in
`docs/self-hosted/`, not `infra/`, which holds Azure templates and two shell scripts only.

## Delivery slices

Each slice leaves `npm run check` green and can be reviewed on its own. Slices 1–8 are the user stories in the
spec's priority order and match tasks.md Phases 3–10; slice 9 is its Phase 11. Every slice starts after tasks.md's
Phases 1–2 (the baseline, `local-only.ts`'s rule, the test helpers and the 1.26 heading).

1. **US1, HSTS by host name (P1)**: HSTS unless the `Host` is a loopback name (R1, R2's `isLoopbackHost`);
   T-PRT-07's HSTS line and T-PRT-16's HSTS part; SPEC L2-8 "Limits and headers", SEC-43. Closes finding 1 in the
   portal.
2. **US2, the dev sign-in stays on the machine (P1)**: `localOnly` (R2, R3), the two config checks, `localOnly`
   in both apps with `skipLocalOnly`; T-EDGE-02..03 (T-EDGE-01 comes with Phase 2); SPEC L1-6, L2-8, CFG-2 notes,
   SEC-44.
3. **US3, the failure limit (P2)**: `failedAuthLimit`, the burst log, `proxyWarning` (R4, R5), `skipFailureLimit`;
   T-EDGE-04..05; the log whitelist; SPEC SEC-45.
4. **US4, the reference proxy (P2)**: `docs/self-hosted/` (R12, R13), T-PROXY-01. It can be written beside any
   other slice; the owner applies it to the dev host and runs the quickstart's direct-connection re-test at the
   end (slice 9).
5. **US5, 404s (P3)**: `portal-screens.ts`, the 404 rules with `skipNotFoundRules` (R7, R8), `SCREEN_NEEDS`;
   T-PRT-17, T-WEB-14; SPEC SEC-47.
6. **US6, browser policies (P3)**: Permissions-Policy, CORP, COOP (R9); the rest of T-PRT-16; SPEC L2-8 "Limits and
   headers", SEC-46. Closes finding 5 in the portal.
7. **US7, what a stranger learns (P3)**: the smaller `/api/config` and `me.admin` (R10), the deployment build
   (R11); T-PRT-01/T-PRT-18, T-WEB-15, T-WEB-16, T-IMG-03; the 013/014 contracts and the OpenAPI schema; SPEC
   SEC-48.
8. **US8, the challenge (P3)**: `bearerChallenge` in both access checks (R6); T-EDGE-06; both OpenAPI files; the
   PKCE residual (R14).
9. **Records and the manual checks**: SPEC v1.26 "Changes", §11 SEC-43..48 and residuals, §12 (each slice adds its
   own rows; this one checks they're complete); `dispositions.md` (FR-027); specs index, threat matrix, CLAUDE.md;
   the deployed and dev-host checks.

Slices 1–8 touch mostly different files and could go in parallel; `src/portal/server.ts` is shared by 1, 2, 3, 5,
6 and 7, so one writer should hold it.

## Knock-on changes to existing tests

Found while planning; each is a test that encodes the old behavior, not a weakened check.

| Test | Today | Change |
|---|---|---|
| T-PRT-01 "behind a trusted proxy each client address has its own count" (`test/portal.test.ts`) | Starts the portal with the dev sign-in and `TRUSTED_PROXY_HOPS=1`, sends `X-Forwarded-For` | Start it with the tenant-shaped issuer the file already uses (`AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: ""`): the dev sign-in now refuses a declared proxy (slice 2) |
| T-PRT-01 "/api/config needs no token" | Expects `network` and `admin` | Expects `auth` and `cards` only (slice 7) |
| `test/portal-admin.test.ts` /api/config `admin` | Expects `admin.available` true/false | Expects no `admin` field, and `me.admin` false where the area is off (slice 7) |
| T-PRT-07 | "Loopback, local network: no HSTS" | Same assertion, comment says "loopback host" (slice 1) |
| `web/portal/test/helpers.tsx`, `admin.test.tsx` | `CONFIG` has `network` and `admin` | Drop both; the admin-off case comes from `me.admin` false (slice 7) |
| T-IMG-03 "gained" case (`test/images.test.ts`) | Replaces `"npm run build:web &&"` | Replaces `"npm run build:web -- --mode deployment &&"` with `"npm run build:web -- --mode deployment && npm run build:docs &&"` (slice 7) |
| T-PRT-08 log whitelist | `LOG_KEYS` without `count` | With `count` (slice 3) |
| T-API-05..08, T-API-12..15 | The OpenAPI files without the challenge header and the smaller config | Updated with the files (slices 3, 7 and 8) |

Found during implementation (same rule: the old behavior, not a weaker check):

| Test | Today | Change |
|---|---|---|
| T-PRT-07 "the built web app is served … for any other path" | `/redirect.html` gets the page | Gets 404 with the page for `Accept: text/html`; the title says "for its screens" (slice 5) |
| T-PRT-01 "no role token opens the portal" | 11 tokens × 5 routes = 55 failures from one address, on one portal | One portal per token (5 failures each); every assertion kept (slice 3) |
| T-API-13 (both cases), T-API-14 scenario (`test/openapi-portal.test.ts`) | One token-less request per documented operation from one address | `skipFailureLimit: true`, with a comment: they check the document against each route, and T-EDGE-04 checks the limit (slice 3) |
| T-ARCH-SWITCH (`test/architecture.test.ts`) | Every `skip[A-Z]…: true` is a switch turned on | express-rate-limit's own `skipSuccessfulRequests` and `skipFailedRequests` are excluded by name (slice 3) |
| T-ARCH-TRACE `SEC_ROWS` | SEC-1..30, 32..34 | Also SEC-43..48, so their rows' test IDs are checked too (slice 9) |
| T-IMG-01 portal image (`test/images.test.ts`) | Expects the build line with `npm run build:web &&` | Expects `npm run build:web -- --mode deployment &&` (slice 7) |
| `specs/011` quickstart §3, the agent image run locally | `AGENT_BIND_HOST=0.0.0.0` with the dev issuer | Refused at start-up now (spec edge case): the run needs the sign-in tenant; recorded as a v1.26 residual (slice 2) |

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

No violations.
