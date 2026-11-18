# SPEC — x402 Agent Payments with Three-Layer Separation

| Field | Value |
|---|---|
| Spec ID | X402-3L-SPEC |
| Version | 1.22 (2026-11-16). v1.0 described the original PoC; v1.1 is the build target for the spec-kit plans in `specs/`; v1.2 adds the CDP facilitator on Base Sepolia (`specs/009`); v1.3 adds the escalation lifecycle: operator rejection, expiry and notification (`specs/010`); v1.4 adds an OpenAPI copy of L2-5 and opt-in Swagger UI on L2 (`API_DOCS=1`); v1.5 adds the hosted agent service on Mastra and Azure (`specs/011`); v1.6 adds OpenAPI copies of L1-6 and the seller (CP-1), with opt-in Swagger UI on both (`API_DOCS=1`); v1.7 declares the seller's endpoints with decorators and a monetization model, freemium discovery plus pay-per-use tiers (CP-1); v1.8 adds backchannel approval of escalations through OpenID CIBA with Auth0 (L2-7, `specs/012`); v1.9 applies the Auth0 tenant from a pipeline (`provision-auth0.yml`); v1.10 adds user accounts and the L2 web portal: onboarding, a profile, a wallet per user and expense policies (L2-8, `specs/013`); v1.11 makes the Auth0 pipeline key-only and adds it to the threat model (SEC-25); v1.12 moves people's sign-in from Microsoft Entra ID to Auth0, at the portal and at the hosted agent service (`specs/013` research R19); v1.13 cuts the Auth0 tenant to two applications, the portal's and L2's: no person's token from the tenant starts a run at the hosted agent service (`specs/013` research R20); v1.14 takes the role and the permission out of the portal's access: whoever signs in through the portal's application may use it (`specs/013` research R21); v1.15 adds the portal's administration area: the rest of the control API that a person uses, for administrators (L2-8, `specs/014`); v1.16 sends each approval request to the person the run is for and removes the configured approver (L2-7, `specs/015`); v1.17 accepts callers of the hosted agent service from the sign-in tenant only, forwards the caller's token to L2, which takes the user from it, and streams the answer (L1-6, L2-5, `specs/016`); v1.18 is a security remediation: patched dependencies, bounded request bodies at L2, a refusal of published development keys and an audit of what the images ship; v1.19 is the second half of that remediation, from an in-depth review: L2 verifies the person behind a portal request itself, an administrator's approval needs a second factor, a payment's release from the budget waits for the chain to prove it can never settle, the ledger's chain is keyed, the agent fetches only the seller's host and follows no redirect, and the deploy environments take jobs from `main` and the pipelines' own tags only; v1.20 adds the pull request check: every pull request to `main`, Dependabot's included, and every push to `main` run the deploy pipeline's step 1 and the local demo (`checks.yml`); v1.21 adds the images' builds (`npm run build`, `npm run build:web`) to that step 1, so the check runs them too; v1.22 fixes the L2 and seller images, which since v1.18 stopped at their production install: each image's `package.json` writes out the `overrides` reference `$zod` |
| Owner | Fabricio Rojas |
| Status | Implemented PoC; this spec is the source of truth for changes |
| Reference | IMF Note 2026/004, *How Agentic AI Will Reshape Payments* (three-layer model) |

---

## Changes in 1.22

The L2 and seller images build again (2026-11-16). v1.18 added `"overrides": { "@coinbase/cdp-sdk": { "zod": "$zod" } }`, where `$zod` is npm's "the range of my own dependency `zod`". `scripts/image-closure.ts` copied `overrides` as they were into each image's `package.json`, which lists only that image's packages, so npm couldn't resolve `$zod` there. The runtime stage's `npm install --omit=dev` stopped with `npm error Unable to resolve reference $zod` in the L2 and seller images, whose packages bring in `@coinbase/cdp-sdk`. No deployment ran between 1.18 and this fix (the last one predates 1.17), so nothing in Azure failed that way; the pull request check builds the code, not the images, so it passed.

| Area | Change |
|---|---|
| §5, §6 | `scripts/image-closure.ts` writes each image's `package.json` with every `$name` in `overrides` replaced by the range package.json gives `name` (`imageManifest`, `resolveOverrides`); a reference to no direct dependency stops the build. `scripts/audit-shipped.ts` audits that same manifest. `@coinbase/cdp-sdk` still gets the root's zod (4.6.7). |
| §12 | Test T-IMG-04; T-IMG-02 amended: the audit's manifest is the images' own, with `overrides` resolved. |

### 1.22.1 (2026-11-17): one advisory let through the audit, until 2026-12-17

On 2026-11-17 at 15:56 UTC GitHub widened GHSA-fc5q-39xc-vjpf (picomatch, ReDoS through single-branch repeated extglobs) to `<= 4.0.7`, with no patched release: 4.0.7 is picomatch's latest, and `@mastra/core` 1.84.0 still asks for `^4.0.7`. picomatch reaches the L1 image through `@mastra/core`, so `npm run audit:shipped` failed every pull request check and would have stopped any deployment; `npm audit fix --force` would move `@mastra/core` back to 1.4.0, which §5's pins rule out. It is numbered as an amendment of 1.22, the audit's last change, because 1.23 and 1.24 were already taken by changes under review.

The advisory needs the attacker to supply the glob pattern (`+(*)`, `+(*a)`). In `@mastra/core` 1.83.0 picomatch is called only through `createGlobMatcher` (`dist/workspace-skills-*.js`), from a workspace's grep and list-files tools, its auto-index paths and its skills paths. An agent gets those only with a `workspace` or `skills` option or a Mastra instance, and the hosted agent has none (L1-6, `src/layer1-intent/hosted/agent.ts` `buildAgent`; T-AGT-02 fails on any tool besides the two). Nothing in `src/` calls a glob library. With picomatch's calls logged, the hosted agent's suites (T-AGT-02, the run, stream, session and access tests) loaded it but never called it from Mastra.

| Area | Change |
|---|---|
| §6, §13 | `scripts/audit-shipped.ts` reads `npm audit --json` and fails on every advisory at or above the level, except one that an entry of `AUDIT_EXCEPTIONS` names for that package, until the entry's expiry. The one entry: GHSA-fc5q-39xc-vjpf on picomatch, added 2026-11-17, expiring 2026-12-17. An entry names one GitHub advisory, one package and a reason, and lasts at most 31 days. From its expiry day the script fails, whether or not the advisory is still reported, until the entry is removed or renewed with a new reason. A package vulnerable only through another is judged by that one's advisories. A report it can't read, an advisory without an identifier and an unknown severity fail the gate. |
| §11 | Residual risk of the exception. |
| §12 | T-IMG-02 amended: the exceptions' shape, the report of 2026-11-17 passing, and must-fails for another advisory (on picomatch, on `@mastra/core`, on another package), the excepted advisory on another package, the expiry day, an unreadable report and a malformed or long-lived exception. |

## Changes in 1.21

The images' builds in the pull request check (2026-11-16). The images' build stages run `npm run build` (every image) and `npm run build:web` (the portal's), but the deploy pipeline's step 1, and so the pull request check, ran neither: a change that breaks only the build, as `@ai-sdk/anthropic` 4 did (`src/hosted-main.ts`), merged green and failed in step 2 of a deployment.

| Area | Change |
|---|---|
| §3.1 Azure profile | `deploy.yml`'s step 1 runs `npm run build` and `npm run build:web` after the typecheck and before the suites; `checks.yml` runs them as two steps of its own, command for command. |
| §12 | Test T-IMG-03; T-IMG-02 and T-CI-01 amended: step 1's commands include the two builds, and a check without either is reported. |

## Changes in 1.20

The pull request check (2026-11-16). That day Dependabot's tooling update (pull request 38) merged into `main` untested: `solc` 0.8.38 can't compile `contracts/MockUSDC.sol` (`pragma solidity 0.8.24`), so every on-chain suite and `demo:local` failed, and `ai` 7 broke the tests' typecheck. No workflow ran the tests on a pull request: the only check was CodeQL, which skips Dependabot's.

| Area | Change |
|---|---|
| §3.1 Azure profile, §6 | `.github/workflows/checks.yml` runs on every pull request to `main` (Dependabot's included) and every push to `main`: the Bicep CLI of `deploy.yml` (same version, checked against the release asset's SHA-256), then exactly `deploy.yml`'s step 1 (`npm install`, `npm run audit:shipped`, `npm run typecheck`, `npm test` with `BICEP_PATH`) and `npm run demo:local` against its baseline, on Node 22 (the images' and `deploy.yml`'s) and Node 26 (development's). It deploys nothing: `contents: read` only, no GitHub environment, secret, variable or OIDC token, a checkout that keeps no credential, `pull_request` (never `pull_request_target`) with no paths filter, every action pinned by commit SHA, and no dependency cache. Making it a required status check is a branch protection setting, set by hand. |
| §12 | Test T-CI-01; T-E2E-AZ amended: `.github/workflows` also holds `checks.yml`. |

## Changes in 1.19

The second half of the security remediation (2026-11-16), from an in-depth review of the policy engine, the administration paths, the card vault, the path from a prompt to a payment, and the Auth0 and Azure configuration. Findings #1–#14 of the review; each change below names its finding.

| Area | Change |
|---|---|
| L2-4.1, L3-1, §7 (#1) | A `NOT_SETTLED` report no longer repeats the seller's word. The signer returns the EIP-3009 authorization's `nonce`; L2 records it on `AUTHORIZED` and in the decision, and L1 puts it in the settlement claim. Every L3 outcome that says "nothing settled" (no or an undecodable `PAYMENT-RESPONSE`, a failure claim, no transaction, a reverted transaction) is `PENDING` with `settlesBy` (validBefore + 60 s) while the authorization can still be used, and after that the nonce's on-chain state decides: unused is `NOT_SETTLED`, used is `MISMATCH` (it keeps counting). L3 re-checks a `PENDING` with `settlesBy` at that time. L2 releases an amount whose nonce it recorded only for a `NOT_SETTLED` that names that nonce and was observed after validBefore; a report naming another nonce is a mismatch. A claim or an `AUTHORIZED` entry without a nonce (before 1.19) keeps the old rule. Before 1.19 a seller could take the money, answer without `PAYMENT-RESPONSE`, and have L2 forget the payment once validBefore passed, so no budget ever filled. |
| L2-5, L2-8, §11 SEC-35, §4.1 A17 (#5) | L2 takes the person behind a portal request from the person's own access token, which the portal forwards unchanged in `X-Person-Authorization` beside its role token on every user-account and administration route (`GET /v1/platform` excepted). L2 verifies it itself (the tenant's signature, issuer, audience, validity and `sub`; not a machine token; the portal's client, `PORTAL_CLIENT_ID`; a sign-in time not in the future): 401 `person_token_required` or `person_token_invalid`, 403 `person_forbidden`. A path's `userId` must be the token's user (403 `person_mismatch`). The step-up time of a loosening change is the token's sign-in time, and the decider of an administrator's decision is the token's user: request bodies no longer carry `identityConfirmedAtMs` or `decidedBy` (400). The administration routes need `portal:admin` in the token. With `USER_ACCOUNTS=1`, L2 needs `PORTAL_CLIENT_ID` (CFG-2). Before 1.19, whoever held `PORTAL_TOKEN` or `PORTAL_ADMIN_TOKEN` acted for any user and passed every step-up and own-payment check by naming them. |
| L2-8, auth0/ (#6) | An administrator's approval also needs the token's second-factor time (`https://x402.dev/mfa_time`) at most 15 minutes old (403 `step_up_required`). A second Action, `auth0/mfa-time.js`, bound after `sign-in-time.js`, writes the claim; `sign-in-time.js` asks a holder of `x402-admin` for a second factor (Guardian push or a one-time code) on every interactive browser sign-in. Enroll administrators before giving them the role. `dev-token --admin` writes the claim locally. |
| L2-4, INV-9, §4.1 A16 (#7) | The ledger's chain is keyed. With `LEDGER_MAC_KEY` (`off`, `<secret>`, or `<entries>:<secret>` for an existing ledger of that many entries), every new entry carries `mac = HMAC-SHA256(key, hash)`, outside what `hash` covers. From `entries` on, every entry must carry a valid MAC, an unkeyed entry may never follow a keyed one, and the ledger may never be shorter than `entries`; a keyed ledger never opens without its key. In Azure, L2 always references the l2 vault's `ledger-mac-key` (seed it as `off` first). Before 1.19 anyone who could write the ledger share (every app of the environment's subnet reaches it) could rewrite an entry and recompute every hash. |
| L2-6 (#8) | Staleness of the ledger lock is judged by how long the lock has stayed unchanged by this process's own clock (30 s, or 10 s for a heartbeat that also looks 30 s old), never by the other host's clock alone. Every ledger append checks first that the lock still names this holder, so a holder replaced after a stall writes nothing more. |
| L1-1 (#4) | The orchestrator fetches http(s) only and never follows a redirect (a 3xx is an `ERROR`; on the paid retry the payment header goes to the requested URL only). The model-driven agents (the hosted agent and the command-line agent) fetch the seller's host only (`allowedHosts`); the scripted plan keeps its second host, which L2 refuses. Before 1.19 a goal or a fetched page could send the agent to any address and get the answer back, and a redirect from an allowed host carried the signed payment to another one. |
| L2-1, R5 (#3) | Outside `NETWORK=local`, L2 refuses to start when the platform account's payee list is empty or a seller on the platform list has no payees: R5 lets any payee through an empty list. |
| L2-5, L2-2 (#9) | Each payment option must have the field types of a requirement (string `scheme`, `network`, `asset`, `payTo` and `amount`, numeric `maxTimeoutSeconds`, an object `extra`), at most 20 options: otherwise 400. R4 reads only the profile's own key. A decision that throws is `DENIED` with the new rule `decision_failed`, so an `INTENT` is always followed by one outcome entry; a 500 says `internal error` and nothing else. |
| CFG-3 (#10) | The mandate loader checks every field: `maxAuthorizationsPerMinute` 1–600 and `maxTimeoutSeconds` 1–3600 as whole numbers (a missing rate read as NaN, which R13 never trips), a non-empty `allowedSchemes` list, lists of strings, a non-empty `mandateId`. Hosts are lower-cased. |
| L2-5 (#12, #14) | `purpose` is at most 500 characters (L1 cuts it; L2 refuses a longer one). An operator's approval lives at most 3600 s, and its `approver` label is 1–64 characters like a rejection's. |
| L2-8 card vault (#13) | `CARD_VAULT_KEY` must be a restricted test key (`rk_test_…`); a secret test key is refused. SetupIntents ask for `usage=on_session`. |
| auth0/, infra/ (#2, #11, #12) | `infra/github-setup.sh` gives the deploy environment a deployment branch policy (`main` and the pipelines' own `deploy-<unit>-*` tags) and `auth0-<env>` one for `main`, keeping existing reviewers and policies, and reminds the administrator to add required reviewers to both. The deploy app's Role Based Access Control Administrator condition refuses an assignment to the deploy app itself. Terraform: localhost origins only with `local_origins` (`AUTH0_LOCAL_ORIGINS`, `true` for dev), sign-ups closable with `allow_sign_ups` (`AUTH0_ALLOW_SIGN_UPS`; a pre-user-registration Action), and the leftover `approver_user_id` removed. |
| §5 | Dependabot's bumps of 2026-11-16 are partly undone: `solc` stays 0.8.24 (`MockUSDC.sol`'s exact pragma; 0.8.38 stopped the local chain), `ai` 6 and `@ai-sdk/provider` 3 (7 and 4 don't type-check against Mastra's model types), `@ai-sdk/anthropic` 3.0.128 (4 returns a model Mastra's types refuse, and `npm run build` fails), and `@types/node` 22 (the images run Node 22). The runtime bumps that stay: `@mastra/core` 1.83.0, `@anthropic-ai/sdk` 1.8, `express-rate-limit` 8.7.4, `swagger-ui-dist` 5.35.0, dotenv and viem. `.github/dependabot.yml` ignores solc and the majors of `ai`, `@ai-sdk/*` and `@types/node`; `@azure/bicep-rpc-client` 0.6 and the minor test-tool bumps stay. |
| L2-5, L3-2, CP-2 | Every route whose handler verifies something is behind a known rate limiter (CodeQL `js/missing-rate-limiting`): the operator's `GET /v1/ledger/verify` (30 a minute per address, after `OPERATOR_TOKEN`), L3's `POST /v1/settlements` (600 a minute per address, after `VERIFIER_TOKEN`) and the local facilitator (6000 a minute). Each answers 429 `{ "error": "too many requests" }` with `Retry-After` beyond its bound. L2's user routes pass their limiter and the person's check to each route directly, never as an array. |
| §12 | Tests T-INT-01..03, T-MAN-01..02, T-APR-01, T-L3-NONCE-01..02, T-LED-08..10, T-LIM-01..02, T-L1-FETCH-01, T-L1-NONCE-01, T-PER-01..02, T-ADM-14, T-ARCH-A16, T-ARCH-A17, and the amended T-USR, T-ADM, T-PRT, T-API-01..03, T-CARD-01, T-IAC-01 (rule 16; rule 24 `ledger-mac-key`) and T-IAC-02. |

## Changes in 1.18

A security remediation (2026-11-15), from a dependency and code review. No route, token, contract field or ledger entry is added or removed; what changes is what L2 accepts as a request body, what it refuses at startup, the versions it runs on and how the pipeline checks them.

| Area | Change |
|---|---|
| §5 | `@x402/*` 2.31.0 (exact), zod ^4.6.7, `@coinbase/cdp-sdk` 1.62.0 (exact), `@azure/identity` ^4.14.1; body-parser 2.4.0, hono 4.13.18, fast-uri 3.1.9, follow-redirects 1.16.3 and `@azure/msal-node` 7.2.2 resolved through their parents. `package.json` `overrides` gives `@coinbase/cdp-sdk` the root zod (it asks for zod 3, which has no patched release; the `./auth` subpath the seller loads reaches neither zod nor abitype). |
| L2-3 | Outside `NETWORK=local`, L2 refuses to start when the payer key, or the first account of the user wallets' mnemonic, is one of the first ten accounts of a mnemonic this repository publishes (`PUBLISHED_DEV_ADDRESSES`). |
| L2-5 | Every route that takes a body reads JSON of at most 16 KB (`POST /v1/authorize` 256 KB, as before) after its guard, never inflates a compressed body (415), and answers a body it can't read with a fixed JSON message. `POST /v1/reconcile`, `/v1/approvals/:id` and `/v1/rejections/:id` had the framework's default 100 KB, inflation and HTML error page. |
| CP-1 | The seller's 402 body repeats the challenge's `error` (an `@x402/*` 2.31 change); `docs/seller.openapi.yaml` documents it. |
| CFG-2 | `TRUSTED_PROXY_HOPS` is 0 or 1 (it was 0–3). |
| §11 | The log scan's shapes (SEC-16) include the three published development mnemonics. |
| §12, §13, §16 | Tests T-BODY-01..02, T-DEVKEY-01, T-IMG-02 and T-ARCH-SWITCH; T-PRT-01 (a caller's own `X-Forwarded-For` entries) and T-PRT-09 amended. `npm run audit:shipped` audits what the images install and runs in the deploy pipeline's step 1; a root `npm audit` can't pass (ganache). |

## Changes in 1.17

Auth0 sign-in, token propagation and streaming at the hosted agent service (`specs/016`, the owner's five decisions of 2026-11-15). The hosted agent accepts callers from one issuer, the sign-in tenant: people who hold the new role `x402-agent` (the permission `agent:run`) and sign in through a new public client, and machine callers, each with a confidential client of its own. L1 forwards the caller's token to L2 on its two calls, in a second header beside its role token; L2 verifies the token with the same shared check and takes the user from it, so a payment request can no longer name a user. The run route answers with server-sent events when asked, from one streaming model path that also serves the JSON answer. The agent's Swagger UI signs a person in at the tenant, and a parameter can turn the page on for a deployed agent. The pipeline's hosted smoke run and scripted regression become jobs that call as one machine caller, `checks`, whose key is in the l1 vault and never in GitHub. The ledger gains no entry type and no field.

1.17 reverses four earlier decisions. v1.12 and v1.13 ("system identities stay with the organization's directory"; "no application of the tenant for the agent, so no person's token starts a run in a deployed environment"): Entra leaves the agent's callers, and the tenant gains the agent's client and one client per machine caller. L1-6 ("after verification the `Authorization` header is deleted, so it never reaches L2 or L3"): the token is kept for the run and sent to L2 only. T-API-08 and SEC-13 ("the Azure deployment never sets `API_DOCS`"): one exception, the agent, by its environment's parameter file. v1.16's `PaymentIntent.approvalSubject`: removed, replaced by the subject of the token L2 verified. Entra stays for the pipeline's sign-in to Azure, the agent's own access to the model and the operators' group. Where this section and an earlier "Changes" section disagree, this section and the passages marked v1.17 hold.

| Area | Change |
|---|---|
| §1.2, §1.3 | People with the role and machine callers of the hosted agent come from the sign-in tenant; the answer can be streamed. "People's agent runs in a deployed environment" leaves the out-of-scope list; forwarding a person's token from the portal to L2 is out of scope. |
| §2 | Glossary: caller, caller's token, machine caller. The administrator's permission is one of two; the platform account pays for a machine caller's run. |
| §3.1 Azure profile | `main.bicep` takes an `agent` object (`clientId`, `apiDocs`, `machineClientId`, `machineKeyId`). The agent and L2 get `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS`; `AUTH_TENANT_ID`, `SERVICE_AUDIENCE` and `authAudience` are gone. `agent.apiDocs` is the docs switch, for the agent only. A new smoke job (`names.jobs.smoke`) and the regression job call as the machine caller `checks`, with `machine-client-key` from the l1 vault. `pre-deploy.bicep` makes no API app registration, `Agent.Run`, `agentUsers` or `retirePortalScope`: no directory object stands for the agent's callers, and the old registration is deleted by hand. |
| §3.2 | The caller's token travels on the authorize call and the budget read, to L2 only. |
| §3.3 | The requester's token is verified by L1 and by L2, and forwarded to L2 only. One new row: the machine caller's key. The agent's client is public and holds no secret. |
| §4, §4.1 | INV-13: the caller's token is not a role token; it is accepted only beside L1's role token, on two routes. INV-3 names the smoke client. Rules A14 (the header's name and `forCaller`) and A15 (the machine caller's key) are new. |
| §5, §6 | One verifier for the hosted agent, the portal and L2; `jose` also signs a machine caller's assertion; no new package. New files `src/layer2-control/caller.ts`, `src/layer1-intent/hosted/sse.ts`, `src/machine-caller/token.ts`, `src/smoke-main.ts`, `test/caller-token.test.ts`, `test/hosted-stream.test.ts`, `test/machine-caller.test.ts`, `test/smoke-client.test.ts` and `test/helpers/caller-tokens.ts`. |
| §7 | `PaymentIntent.approvalSubject` is removed. `PaymentIntent.userId` stays in the type, set by L2 from the caller's token and never accepted from a request. `AuthorizationGatePort.budget(sessionId)` loses its second argument. |
| L1-1, L1-2, L1-5 | The orchestrator names no user and no subject, and reports a refused caller as an error that says whether the sign-in expired. `HttpAuthorizationGate.forCaller(token)` adds `X-Caller-Authorization` to the two calls. The command-line agent forwards a machine caller's token when one is configured; `src/smoke-main.ts` is the smoke client. |
| L1-6 | One issuer and one set of checks for both kinds of caller; the directory's settings are refused by name. The token is kept for the run and sent to L2 only. The service names no user. `POST /v1/runs` streams on request: four events, a keep-alive, the same refusals, limits and deadline. The docs page can sign in at the tenant (`API_DOCS_CLIENT_ID`) and can be turned on for a deployed agent. Session references and log keys use the issuer and `sub` for both kinds. |
| L2-5 | `POST /v1/authorize` and `GET /v1/budget/:sessionId` take the caller's token beside `CONTROL_TOKEN`: the header, seven checks in order, and the answers `caller_token_required`, `caller_token_not_accepted`, `caller_token_expired`, `caller_token_invalid` and `caller_forbidden`. `userId` and `approvalSubject` on an intent, and `?userId=` on a budget read, are refused. Where sign-in is configured the two routes share a bound of 600 requests a minute per calling address, counted after `CONTROL_TOKEN` and before the caller's token is verified (429 with `Retry-After`). |
| L2-7 | The owner and the subject of an approval request come from the forwarded identity. `no_identity` no longer arises from a missing field; `identity_mismatch` arises only when the sign-in issuer is not the approval service's; a machine caller's escalation is `no_owner`. |
| L2-8 | The user of a run comes from the token L2 verified. User accounts need sign-in configured at L2. The portal refuses the agent's client and machine tokens; people's API has two permissions and the tenant two roles. |
| CFG-2 | `l1-hosted.env`: the three sign-in variables are required, `AUTH_TENANT_ID` and `SERVICE_AUDIENCE` are removed and refused, `API_DOCS_CLIENT_ID` is new. `l2-control.env`: `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`, `AUTH_JWKS_FILE` and `PORTAL_CLIENT_ID`. `l1-agent.env`: `MACHINE_CLIENT_ID`, `MACHINE_CLIENT_KEY_ID`, `MACHINE_CLIENT_KEY`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `CALLER_TOKEN`, `AGENT_URL` and `AGENT_CANDIDATE_URL`. The parameter files' `agent` object and `names.jobs.smoke`; Terraform's `agent_origin` and `machine_caller_keys`. |
| §11 | SEC-13 (a docs page in a deployed environment, by a parameter, on the agent only), SEC-14 (one issuer), SEC-20 (the client rule at L2 too) amended; SEC-23, SEC-26 and SEC-27 follow. New SEC-32 (L1's word names no user), SEC-33 (machine callers) and SEC-34 (the docs page's sign-in). Two residual risks are added: a compromised L1 can spend for a person whose token it has seen, until it expires; the agent's identity can read the machine caller's key. Removed: the v1.10 risk "the hosted agent service is trusted to name the right user", the v1.15 risk and the v1.16 risk that rested on "no person's token starts a run in a deployed environment". Reworded: the v1.5 deploy app risk (no `Agent.Run`) and the v1.16 risk about a request on another person's phone. |
| §12, §13, §16 | Tests T-AGT-08..14, T-CTK-01..09, T-API-16..17, T-E2E-15..16 and T-ARCH-A14..A15; T-IAC-01 rule 23 new, rule 11 removed, rules 12, 15, 16 and 21 amended; T-IAC-02 (four kinds of application, two permissions, two roles); T-AGT-03, T-AGT-06, T-AGT-07, T-API-05..08, T-USR-06 and the T-E2E-AZ smoke assertions rewritten. T-AGT-08 and T-E2E-15 were reserved by `specs/015` and are used here for the same purpose; SEC-31, T-USR-13, T-PRT-15 and T-WEB-13..14 stay reserved by it. `npm run stack:local -- --sign-in`; `dev-token -- --service` makes a machine caller's token. The gotcha about the Entra scope is rewritten. |
| Constitution 2.0.0 | Principle V: the requester's token is forwarded to L2 only, beside L1's role credential, and opens no route by itself; both kinds of requester come from the sign-in tenant; a machine caller's key is an authentication credential confined to one module (A15). The scope constraints and the residual risks follow. |

## Changes in 1.16

Backchannel approval by the person the run is for (`specs/015`). Off unless `CIBA_APPROVAL=1`, as before, and it now needs user accounts (`USER_ACCOUNTS=1`). 1.8 asked one approver, named in L2's settings, about every escalation. 1.16 asks the escalation's owner, the user the payment is for, on their own phone, and nobody else: no approver is configured anywhere. An escalation with no user behind it (the scripted regression, a system identity's run, the command-line agent) asks nobody and waits for the operator and the administrators, whose paths are unchanged.

The feature is proven against the stand-in approval service (`test/helpers/ciba-stub.ts`). SPEC v1.13 stays: the tenant has no application for the hosted agent, so in a deployed environment no person's token starts a run and nobody is asked by phone there. The rows below are the ones delivered so far; the tasks of `specs/015` that change a behavior add theirs.

| Area | Change |
|---|---|
| §1.2, §1.3 | A person approves their own agent's escalated payments from their own phone. "Per-user approvers" leaves the out-of-scope list. Approving in the portal as a user, and people's runs in a deployed environment, stay out. |
| L2-7 | "One approver per L2 (`CIBA_APPROVER`)" goes: each request is addressed to the escalation's owner. Eligibility gains the owner conditions, in a fixed order; the identity check recomputes the one-way identifier under L2's own issuer; the approver check becomes an owner check made from the signed answer alone; the limit is per person; a request of an escalation with no user is not resumed. A correction: an unanswered request that lives as long as its escalation ends with `ESCALATION_EXPIRED` alone and reads `unanswered`; `APPROVAL_REQUEST_LAPSED` is written only when the request ends first. |
| §12 | T-CIBA-15 (one request, to the owner; two people each decide only their own). T-CIBA-16 (another person's signed answer approves nothing; must fail without the owner check). T-CIBA-17 (a subject that is not the user's, or none, asks nobody; must fail without the identity check). T-CIBA-18 (the scripted run, a system identity's run and the command-line agent ask nobody; must fail with a fallback subject). T-CIBA-19 (11 escalations for one person and one for another in an hour: the first is asked 10 times, the other is asked; must fail with one shared count). T-CIBA-20 (a planted subject is in no ledger line, log line, response or event). T-CIBA-22 (a request open at deployment for an escalation with no user is not polled; two people's open requests are each resumed from their own handle). T-CIBA-21 (a request nobody answered reads `unanswered`, in a clean timeout and after a restart, with no `APPROVAL_REQUEST_LAPSED`). T-CIBA-23 (entries written before 1.16 verify and read). T-CIBA-14 extended to every outcome. T-CIBA-24 (a leftover approver, or no user accounts, stops L2). T-IAC-01 rule 19 as amended. T-CIBA-02 and T-CIBA-08 as amended (the request's subject; step 7 `owner`). T-E2E-10 and T-E2E-11: the purchase approved or refused by phone is a person's. |
| §7 | `PaymentIntent.approvalSubject?`: the person's subject at the approval service, sent by the hosted agent for a person's run and kept nowhere by L2. `ApprovalRequestMark` gains `no_owner`, `no_identity` and `identity_mismatch`; `ApprovalRequestState` gains `unanswered`; new `WaitingPayment` and `WAITING_REASONS`; `PlatformView.phoneApproval`. `AuthorizationDecision` and `BudgetStatus` are unchanged. |
| L1-1 | An orchestrator built for a user with that user's `approvalSubject` copies it onto each intent beside `userId`. Nothing else in L1 reads it. |
| L2-4 | No new entry type. `ESCALATED.approvalRequest` may be `no_owner`, `no_identity` or `identity_mismatch`. The backchannel's `APPROVAL_REQUESTED`, `HUMAN_APPROVAL` and `HUMAN_REJECTION` name the owner by `usr_…` in `approver`; the approval's evidence holds `userId` and no `subject`; `APPROVAL_VERIFICATION_FAILED.check` may be `owner`; `APPROVAL_REQUEST_FAILED.failure` may be `no_owner`. Entries written before 1.16 are never rewritten. |
| L2-5 | `POST /v1/authorize` accepts `approvalSubject` and answers 400 for a malformed one or one without `userId`; a body that can't be read is answered by L2 itself, never logged. `GET /v1/platform` says whether phone approval is on (false until the person's view lands). The escalation reads show the new marks, `unanswered`, `check: owner`, `failure: no_owner`, and the owner's `usr_…` as who decided by phone; the operator's and the administrators' routes are otherwise unchanged, and `docs/l2-control.openapi.yaml` and `docs/portal.openapi.yaml` list the new values. |
| CFG-2, §3.1 Azure | `CIBA_APPROVER` is removed from L2's settings, from the parameter files' `ciba` object and from the L2 app; a leftover one stops L2. `CIBA_APPROVAL=1` needs `USER_ACCOUNTS=1`, in L2 and in `main.bicep`. Terraform's `bicepparam_ciba` output loses the key with the parameter file (T-IAC-02 ties the two); the rest of the tenant's configuration follows in the feature's tenant slice. |
| §11 | The v1.15 residual risk "an escalation of a user's payment still goes to the operator and the one configured approver" is removed; four residual risks are added for v1.16. SEC-17 names the escalation's owner where it named the approver. SEC-18 counts the limit per person. New SEC-30: another person's answer, or a request pointed at another phone. |

## Changes in 1.15

The portal's administration area (`specs/014`). Off unless L2 and the portal are both configured for it (`PORTAL_ADMIN=1`, which needs `USER_ACCOUNTS=1`); without it every process behaves as in 1.14, apart from additive fields: `admin` on the portal's `/api/me` and on its `/api/config`, and `channel: "portal"`, the decider's identifier and `reasonCode` wherever a decision is shown. 1.10 wired the portal to every user-account route of L2. 1.15 gives it what is left of the control API that a person uses: seeing the pending escalations, approving or rejecting one, following the events, seeing the budget behind an escalation, and checking the ledger. The two machine capabilities stay where they were: only the agent requests a payment authorization, and only L3 reports a settlement.

Using the portal needs no permission (1.14). Its administration area is the one thing that does: `portal:admin`, the only permission of people's API, held by the tenant's only role, `x402-admin`, which an administrator of the tenant gives to a person by hand. Every signed-in person is a user, so an administrator is a user who also holds that permission. The feature was written against 1.10, when people signed in with the organization's directory; 1.11 to 1.14 merged first, which is why it is 1.15 and SEC-27..SEC-29, and why nothing of it is in Entra.

| Area | Change |
|---|---|
| §1.2, §1.3 | Administrators, a second kind of person in the portal, decide escalated payments there. A user approving their own payments, notifications and a payment history stay out of scope. |
| §2 | Glossary: administrator, administration area, decision path. |
| §3.1, §3.2 | The portal relays an administrator's decision to L2. It still holds no key and is never on the payment decision path; §3.2 shows the relay beside the payment flow. |
| §3.3 | One row: `PORTAL_ADMIN_TOKEN`. |
| §4, §4.1 | INV-13 names the sixth role, `portal-admin`. Rule A12 also bans `PORTAL_ADMIN_TOKEN` in the layers; rule A13 is new: the portal's two halves stay apart. |
| §6 | New files `admin-routes.ts` (L2 and portal), `admin-client.ts`, `control-errors.ts`, the web app's `screens/admin/` and `poll.ts`. |
| §7 | The escalation views move to `src/shared/contracts.ts`; `DecisionChannel` gains `portal`; `EscalationEvent.reasonCode`; new `EscalationDetail`, `EscalationBudget`, `BudgetLine`, `EventPage`, `DecisionOutcome`, `LedgerCheck`, `REJECTION_REASON_CODES` and `ESCALATION_ID_RE`. `PaymentIntent`, `AuthorizationDecision` and `BudgetStatus` are unchanged. |
| L2-4, L2-4.3 | No new entry type. `HUMAN_APPROVAL` and `HUMAN_REJECTION` gain a third channel, `portal`, with the administrator's identifier as `approver`, and `identityConfirmedAtMs` or `reasonCode`. Three decision paths share one decision core (`recordApproval`, `recordRejection`). |
| L2-5 | Six administration routes under `/v1/admin/`, behind `PORTAL_ADMIN_TOKEN`. The operator's routes are unchanged; their reads show a portal decision's channel, decider and reason code. |
| L2-8 | The administration area: access by the one permission of the sign-in tenant (`portal:admin`, held by the role `x402-admin`; never by the organization's directory), six portal routes, four screens, and the checks L2 keeps. `/api/me` gains `admin`. |
| CFG-2 | `PORTAL_ADMIN` and `PORTAL_ADMIN_TOKEN` for L2 and for the portal. |
| §3.1 Azure profile, `auth0/` | `auth0/` (Terraform) gives people's API its one permission, `portal:admin`, and the tenant its one role, `x402-admin`, which holds exactly it and is assigned per person in Auth0 by hand; nothing is added to Entra. `userAccounts.administration` sets `PORTAL_ADMIN` in L2 and the portal; both always reference a new secret, `portal-admin-token`. No new unit, image or pipeline. In a deployed environment no person's token starts a run (v1.13), so the escalations administrators see there are the platform account's. |
| §11 | SEC-8 amended; SEC-27, SEC-28 and SEC-29; the v1.15 residual risks. |
| §12, §13 | Tests T-ADM-01..10, T-LED-07, T-PRT-10..14, T-WEB-09..12, T-E2E-14 and T-ARCH-A13; T-IAC-01 rule 22 new, and T-IAC-02 checks the one permission and the one role; flags `stack:local -- --users --admin` and `dev-token -- --portal --admin`. |

## Changes in 1.14

The portal asks for no role and no permission (`specs/013` research R21, decided 2026-11-12). Until now a person needed the role `x402-user`, assigned by an administrator in Auth0, which put the permission `agent:run` in their token. A new sign-up should get in without that step, and Auth0 has no default role: assigning one from a sign-in Action needs a third application and a stored secret. So **whoever signs in through the portal's application may use the portal**, for their own account only. Nothing in L2, L3, the seller, the ledger or the contracts changes, and the hosted agent service still requires `agent:run`, which only the local dev issuer gives. Where this section and a v1.12 passage further down disagree about the portal's access, this section and the passages marked v1.14 hold.

| Area | Change |
|---|---|
| §2 | A user is a person who signed in to the portal through its application. |
| L2-8 | The access list loses the permission: issuer, audience, `sub`, not a machine token, the portal's client, and the sign-in time claim. `permissions` is not read. A 403 now means a machine token or another client's token, and the web app says "This sign-in can't be used for the portal. Sign in again from this page." |
| §3.1, `auth0/` | The role `x402-user`, its permission assignment and the API's permission `agent:run` are removed. People's API keeps RBAC enforced with no permission defined, so tokens carry an empty `permissions` list and keep the shape the sign-in was verified with. |
| §11 | SEC-26: who can sign up can onboard. The tenant's sign-up setting and blocking a user are the controls, and both are by hand. |
| §12, §13 | T-PRT-01 (a token without a permission gets in; another client's does not, with the permission or not) and T-IAC-02 (no role, no permission; 36 mutants of people's sign-in). `docs/portal.openapi.yaml` follows. |

## Changes in 1.13

The Auth0 tenant has two applications: the portal's single-page client, for people's sign-in, and L2's backchannel approval client (`specs/013` research R20, decided 2026-11-11). The native client for a person's agent token is gone, so **no person's token from the tenant starts a run at the hosted agent service**: a deployed agent accepts system identities only, and a system identity never names a user, so its runs never spend a person's account. Runs as a person remain a local capability, with the dev issuer. Nothing in L2, L3, the seller, the ledger or the contracts changes. Where this section and a v1.12 passage further down disagree about a person's token at the agent service, this section and the passages marked v1.13 hold.

| Area | Change |
|---|---|
| §3.1 | `infra/main.bicep`'s `identity` object is `issuer` and `audience` only, and only the portal's module takes it. The agent's app gets none of `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS` and `PORTAL_CLIENT_ID`: in Azure it accepts system identities only (T-IAC-01 rule 21). |
| L1-6 | The checks on a person's token are unchanged, and nothing provisions a client that passes them outside local mode. People get no agent token from the tenant. |
| L2-8 | Unchanged. A person's expense policies bound the runs made as that person, which a deployed environment no longer has: there they are set up and shown, not exercised. |
| CFG-2 | `AGENT_CLI_CLIENT_ID` is gone. `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` stay in `l1-hosted.env` for the local dev issuer. |
| §11 | SEC-20: in a deployed environment the agent accepts no person's token at all, so a portal token has nothing to be confused with. |
| §12, §13 | T-IAC-01 rule 21 and T-IAC-02 follow (exactly two clients, an `identity` output that names no client). `scripts/user-token.ts`, `test/user-token.test.ts` and `npm run user-token` are removed. Research R19's check 4 (the device flow's permissions) no longer applies. |

## Changes in 1.12

People sign in with Auth0, at the portal and at the hosted agent service (`specs/013` research R19, clarified 2026-11-10). System identities stay with the organization's directory (Microsoft Entra ID) and are accepted by the agent service only. Nothing in L2, L3, the seller, the ledger's entry types or the contracts changes. Where this section and a v1.10 passage further down disagree about sign-in, this section and the updated L1-6, L2-8 and CFG-2 hold.

| Area | Change |
|---|---|
| §2 | A user is known by the sign-in tenant's issuer and the token's `sub`. Every identifier made before 1.12 belongs to an earlier user that nobody signs in as: people onboard again, and test funds in an earlier account stay there. |
| §3.1 | `infra/main.bicep` takes an `identity` object (`issuer`, `audience`, `agentClientIds`), from Terraform's outputs in `auth0/`. `infra/pre-deploy.bicep` no longer makes the portal's web app registration, the `Portal.Access` scope or the `auth_time` optional claim; the scope leaves an environment that has it in two deployments (`retirePortalScope`). |
| §3.3 | A person's token is an Auth0 access token; a system identity's is an Entra app-only token. The portal accepts no Entra token. |
| §5 | The web app signs in with `@auth0/auth0-spa-js` instead of `@azure/msal-browser`. One verifier, `src/shared/identity-token.ts`, replaces `entra-token.ts`. |
| §7 | `userIdFor(issuer, subject)`: `usr_` + 32 hex of SHA-256 over `x402-user-v2`, the issuer's host and `sub`, separated by newlines. |
| L1-6 | Two issuers. A person: the Auth0 tenant, the permission `agent:run`, a client on `AGENT_CLIENT_IDS`. A system identity: Entra, app-only, `Agent.Run`. A person's Entra token is refused (403). Session references are bound to the issuer and `sub`. |
| L2-8 | The portal's access list is Auth0's: issuer, audience, `sub`, not a machine token, the portal's client, `agent:run`, and the sign-in time claim (`AUTH_TIME_CLAIM`, set by a post-login Action). `/api/config` gives `{ mode: "auth0" \| "dev", domain, clientId, audience }`. The sign-in redirect page is gone, and no page may be framed. |
| CFG-2 | `AUTH_ISSUER` replaces `AUTH_TENANT_ID` at the portal and for people at the agent; `AGENT_CLIENT_IDS`, `SERVICE_AUDIENCE`, `AUTH_TIME_CLAIM` and `AGENT_CLI_CLIENT_ID` are new; `PORTAL_SCOPE` is gone. |
| §11 | SEC-14, SEC-19, SEC-20 and SEC-21 name the new checks; one provider now stands behind sign-in and approvals (residual risk). |
| §12, §13 | T-AGT-03, T-AGT-06, T-AGT-07, T-PRT-01, T-PRT-07, T-PRT-09, T-WEB-07, T-IAC-01 and T-IAC-02 follow; new `test/identity-token.test.ts` and `test/user-token.test.ts`; `npm run user-token` (the tenant's device flow) replaces `az account get-access-token` for people. |

## Changes in 1.11

Convergence of `specs/012` after the Auth0 pipeline (v1.9). No runtime behavior changes.

| Area | Change |
|---|---|
| §3.1 Azure profile, T-IAC-02, T-E2E-AZ | `provision-auth0.yml` provisions `credential = "key"` only. It no longer reads `AUTH0_L2_CLIENT_SECRET`, and the GitHub environment's variables `AUTH0_CREDENTIAL` and `AUTH0_CLIENT_SECRET_VERSION` are gone: L2's credential is held by L2 only, so GitHub holds the public half of L2's key and never its secret. `AUTH0_CLIENT_PUBLIC_KEY` is now required. `infra/github-setup.sh` creates six variables. |
| §11 | SEC-25 (the pipeline's credential and the Terraform state) and the v1.11 residual risks. |
| Constitution 1.5.0 | Principle V names the Auth0 Management API credential, the only one GitHub holds; the tenant's Terraform is applied by its pipeline. |

## Changes in 1.10

User accounts and the L2 web portal (`specs/013`). Off unless L2 is configured for it (`USER_ACCOUNTS=1`); without it L2, L3, the seller and the scripted agent behave as in 1.8. Two things change either way: the hosted agent service accepts a person's token only when it was issued for that service (L1-6), and `PaymentIntent.userId`, when present, must be well formed. Additive contract fields: `PaymentIntent.userId`, `BudgetStatus.scope` and a second argument of `AuthorizationGatePort.budget`.

| Area | Change |
|---|---|
| §1.2, §1.3 | Many users, self-service: every person who may start agent runs can onboard. Cards can be registered but never pay. Card payments, withdrawals, per-user approvers and deleting a user stay out of scope. |
| §2 | Glossary: user, portal, wallet, expense policy, platform limits, seller list, user daily ceiling, platform account. |
| §3.1 | A new process, the portal (`src/portal-main.ts`, port 4025): the web app's static files and a JSON API for the signed-in person. It is never on the decision path. In Azure it is a unit of its own (`ca-portal-eastus2-dev`: external ingress, its own identity, vault, image and pipeline). |
| §3.3 | A Portal column and four rows: `PORTAL_TOKEN`, `USER_WALLET_MNEMONIC`, the person's portal token and `CARD_VAULT_KEY`. |
| §4, §4.1 | INV-2 covers the wallet mnemonic; INV-13 names the fifth role, `portal-control`. Rule A1 gains the area `src/portal/`, rule A4 covers it, and rules A10–A12 are new. |
| §5, §6 | The web app's packages (React, MSAL and the test libraries, all dev-only and bundled at build time) and the new files. |
| L1-6, L2-8, CFG-2, §5 | Both public services limit requests per client address (300 a minute) before they verify a token, with `express-rate-limit` through `src/shared/address-limit.ts`. `TRUSTED_PROXY_HOPS` (0 by default, 1 in Azure) says how many proxies stand in front, so the address is the client's. |
| §7 | `PaymentIntent.userId`, `BudgetStatus.scope`, `AuthorizationGatePort.budget(sessionId, userId?)`, and the shapes the portal and L2 exchange. |
| L1-6 | For a person, every intent and budget call of a run carries `userId = userIdFor(tid, oid)`, fixed from the verified token. A token is a person's unless `idtyp` is `app`; a person's token needs the scope `user_impersonation` and must not come from the portal's client. |
| L2-1 | A user payment is decided against an effective mandate: the user's one active policy for the seller, bounded field by field by the platform limits. The platform account's mandate is unchanged. |
| L2-2 | R16 `user_not_onboarded` and R17 `user_disabled`, evaluated first; R12 also enforces the user daily ceiling. Every figure of the context is counted per user and per policy. |
| L2-3 | A keyring derives one account per user from one mnemonic; the signer takes an account as well as a key. |
| L2-4, L2-4.1 | Twelve new entry types; `userId`, `policyId` and `policyVersion` on a user payment's entries; owner filters on committed spend, velocity and approvals. |
| L2-5 | `userId` on authorize and budget, `userId` in the operator's escalation reads, and fourteen portal routes behind `PORTAL_TOKEN`. |
| L2-8 (new) | User accounts and the portal: derived state, policy validation, loosening and step-up, disable and enable, cards, the portal's API and web app, and what is never stored. |
| CFG-2, CFG-4 | `USER_ACCOUNTS`, `PORTAL_TOKEN`, `USER_WALLET_MNEMONIC`, `PLATFORM_FILE` and `PLATFORM_SELLERS` for L2; `PORTAL_CLIENT_ID` for the hosted agent; the new `env/portal.env`. `config/platform.json` (CFG-4) holds the platform limits and the seller list. |
| §11 | SEC-19..SEC-24 and the v1.10 residual risks. |
| §12, §13 | Tests T-USR-01..12, T-POL-16..19, T-LED-06, T-PRT-01..09, T-CARD-01..06, T-WEB-01..08, T-API-12..15, T-AGT-06..07, T-ARCH-A10..A12 and T-E2E-12..13; T-IAC-01 rule 21; commands `portal`, `build:web`, `fund-user`, `wallet-mnemonic`, `stack:local -- --users` and `dev-token -- --portal`. |

## Changes in 1.9

The Auth0 tenant (`auth0/`, v1.8) is applied by a pipeline instead of by hand. No runtime behavior changes.

| Area | Change |
|---|---|
| §3.1 Azure profile, §6, §13, T-IAC-02 | `.github/workflows/provision-auth0.yml` applies `auth0/` with Terraform: by hand only, a plan on every run, and that same plan applied only when `apply` is checked. It runs in its own GitHub environment, `auth0-<env>`, which holds the only secrets in GitHub: the Auth0 Management API application's credential (`AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`). Only its plan and apply steps see them. (v1.9 also took L2's client secret with `credential = "secret"`; v1.11 removes that: key only.) Terraform's variables come from the same environment's variables (`AUTH0_TENANT_DOMAIN`, `AUTH0_API_IDENTIFIER`, `AUTH0_APPROVER_USER_ID`, `AUTH0_CLIENT_PUBLIC_KEY` and two optional ones since v1.11), which the plan step exports as `TF_VAR_*`: no tfvars file exists, in the repository or on the runner. The deploy pipelines still read no GitHub secret or variable. |
| §3.1 Azure profile, T-IAC-01 (rules 15–17, new rule 20) | The Terraform state is a blob (`auth0.<env>.tfstate`, container `tfstate`) in a new storage account, `sttfstateeastus2dev`, made by `infra/pre-deploy.bicep`: Entra sign-in only (no account key, no anonymous access), versions and deleted blobs kept. The deploy app is the only principal with a role there, Storage Blob Data Contributor on that container, and gets a second federated credential, for the GitHub environment `auth0-<env>` (`githubAuth0Environment`). Terraform signs in with OIDC; no Azure credential exists. Azure stays Bicep only. |
| `auth0/` | The backend is `azurerm` with `use_azuread_auth`. `client_public_key_file` becomes `client_public_key_pem`, the public key as text. tfvars files stay gitignored, and `dev.tfvars.example` is removed. |
| T-E2E-AZ | `.github/workflows` holds the six pipelines, `deploy.yml` and `provision-auth0.yml`. `infra/github-setup.sh` also creates the GitHub environment `auth0-<env>` and its missing `AUTH0_*` variables (the placeholder `REPLACE_ME` for the four without a default, which the pipeline refuses to plan with; the defaults for the others), never changing one that exists, and sets no secret. `infra/cleanup.sh` is unchanged: it deletes the resource group, and the state with it, but nothing in the Auth0 tenant. |

## Changes in 1.8

Backchannel approval of escalated payments (`specs/012`). Off unless L2 is configured for it (`CIBA_APPROVAL=1`); without it every process behaves as in 1.7, apart from two additive audit fields (`channel` on new operator decisions, `referenceCode` in the operator's views). One additive contract field: `PaymentIntent.operatorApprovalOnly`.

| Area | Change |
|---|---|
| L2-7 (new) | When L2 escalates a payment, it asks the configured approver directly: one OpenID CIBA request (poll mode) to an Auth0 tenant, with a 64-character binding message and one `authorization_details` object describing the exact payment. The approver answers on their phone (Guardian push). L2 verifies the returned access token (issuer, signature through the JWKS, audience, client, validity, approver, the open request, the payment details field for field, single use) before recording `HUMAN_APPROVAL` with `channel: "backchannel"`; a refusal records `HUMAN_REJECTION` with the same channel. Every failure fails closed: the escalation stays pending and the operator path is unchanged. |
| L2-5 | The authorize call that creates an eligible escalation waits up to 120 s, holding no lock. If the escalation reaches approved or denied in that time (either path), a second serialized decision is returned in the same call. Otherwise the call returns ESCALATE, as before. `PaymentIntent.operatorApprovalOnly`, when present, must be a boolean. The escalation reads gain `referenceCode`, `approvalRequest`, `channel`, `decidedBy` and four event kinds. |
| L2-4 | New entry types `APPROVAL_REQUESTED`, `APPROVAL_REQUEST_FAILED`, `APPROVAL_REQUEST_LAPSED` and `APPROVAL_VERIFICATION_FAILED`; `ESCALATED.approvalRequest`; `channel` on `HUMAN_APPROVAL` and `HUMAN_REJECTION`; a second `INTENT` (with `reevaluationOf`) after a wait. The request handle is stored only sealed (AES-256-GCM under a key derived from L2's client credential). |
| L2-4.3 | L2's only outbound connections are to the configured approval service. Operator notification stays pull-based. |
| §3.3, §4.1 | L2's Auth0 client credential (`CIBA_CLIENT_KEY`, or `CIBA_CLIENT_SECRET`) is held by L2 only and confined to `src/layer2-control/ciba-client.ts` by rule A9. It authenticates L2 to Auth0 and is not payment key material. |
| §7, L1-4 | `PaymentIntent.operatorApprovalOnly?: boolean` only removes the backchannel path. The scripted regression (`--scripted`) sets it, so automated checks never notify the approver; the hosted agent never does. |
| §5, §6 | `jose` is also used by L2 (approval token, client assertion). New files `ciba-client.ts`, `approval-evidence.ts`, `payment-details.ts` and `backchannel.ts`; test helpers `ciba-stub.ts` and `backchannel-l2.ts`. |
| CFG-2 | `l2-control.env` gains `CIBA_APPROVAL?, CIBA_ISSUER?, CIBA_CLIENT_ID?, CIBA_AUDIENCE?, CIBA_APPROVER?, CIBA_CLIENT_KEY?, CIBA_CLIENT_SECRET?, CIBA_CLIENT_KEY_ID?`. A missing or invalid value stops L2 before it takes the ledger lock, naming the variable, never its value. |
| §3.1 Azure profile, T-IAC-01 | `main.bicep` gains a `ciba` parameter (non-secret values, in each parameter file). `ca-l2-eastus2-dev/l2` always gets the `CIBA_*` env from it and always references `ciba-client-credential` in the l2 vault, so every environment seeds that secret: the placeholder `off` while the feature is off (L2 ignores it then and refuses it when on). T-IAC-01 rule 19 confines the credential to L2's container and the values to the parameter file. |
| §5, §6, §13, T-IAC-02 | The Auth0 tenant is code: Terraform with the `auth0/auth0` provider in a new top-level `auth0/` folder. It makes the approval API (its payment-details type and access policy), L2's CIBA-only client and its RS256 public-key credential, the grant and Guardian push. A tenant administrator applies it by hand, with no pipeline and no GitHub secret (v1.9: its own pipeline applies it, `provision-auth0.yml`); it outputs the `ciba` object for the parameter file. Azure stays Bicep only. |
| §11, §12 | SEC-17 (a forged, replayed or swapped approval) and SEC-18 (push fatigue), residual risks; tests T-CIBA-01..14, T-ARCH-A9, T-E2E-10 and T-E2E-11. |

## Changes in 1.7

A refactor of the seller (CP-1): the same routes, prices, bodies, headers and statuses, declared once per endpoint with a monetization tier. One additive change: each catalog item gains `tier`.

| Area | Change |
|---|---|
| CP-1 | The seller's endpoints are methods of one controller class, `SellerApi` (`src/counterparty/seller-api.ts`), each with two TC39 decorators: its route (`@Get`, `src/counterparty/endpoints.ts`) and its monetization tier (`@Free`, `@PayPerUse`, `@Premium`, `@Enterprise`, `src/counterparty/monetization.ts`), with prices written as `usdc("0.001")` (BigInt math, rule 8). The catalog, the x402 payment requirements and the Express routes are derived from those declarations, so a route, its price and its catalog entry can't drift. A declaration mistake (a missing route or tier, two of either, one route for two endpoints, a non-USDC network) is refused while the seller is built. |
| CP-1 | The monetization model, after Stripe's "What is API monetization?": freemium discovery (the free catalog) plus pay-per-use in tiers priced by value. Tiers are labels with a price; the buyer's L2 decides from the price alone (INV-5). |
| CP-1 | Catalog items are `{path, priceAtomic, description, tier}`; `tier` is new. `docs/seller.openapi.yaml` names each operation's tier (`x-monetization-tier`) and groups the operations by tier. |
| §5 | Node can't run decorators natively: tsc 7 (the build) and tsx (esbuild) lower them, and `vitest.config.ts` lowers them with the same esbuild before vite 8's oxc transformer, which knows only TypeScript's legacy decorators. |
| §6, §12 | `endpoints.ts`, `monetization.ts`, `seller-api.ts`; tests T-MON-01..03, and T-API-09 checks each operation's tier as well as its price. |

## Changes in 1.6

One opt-in behavior change: with `API_DOCS=1`, the hosted agent service and the seller serve Swagger UI. Without it, every process behaves exactly as in 1.5. No contract change.

| Area | Change |
|---|---|
| L1-6, §6 | `docs/l1-hosted.openapi.yaml` describes the hosted agent's HTTP API in OpenAPI 3.1, for tools such as Swagger UI, Swagger Editor or Redocly. L1-6 and `specs/011` contracts/hosted-agent-api.md stay normative. |
| L1-6, CFG-2, §13 | `API_DOCS=1` in `env/l1-hosted.env` mounts `GET /docs`, `GET /docs/:asset` and `GET /openapi.yaml` on the agent, before requester auth like the health routes: Swagger UI over that document, with no token. Off by default, and the Azure deployment never sets it. The Swagger UI routes move to `src/shared/api-docs.ts`, which L2 and the agent each mount through their own wrapper; L2's routes and behavior are unchanged. |
| CP-1, §6 | `docs/seller.openapi.yaml` describes the seller's HTTP API in OpenAPI 3.1, the x402 headers' decoded JSON included (`contentSchema`), with each priced route's catalog price as `x-x402-price-atomic`. CP-1 stays normative. |
| CP-1, CFG-2, §13 | `API_DOCS=1` in `env/seller.env` mounts the same three docs routes on the seller, before the payment middleware like the catalog. Off by default, and the Azure deployment never sets it. |
| §11 | SEC-13 covers the agent's and the seller's docs routes too. |
| §12 | T-API-05..07 fail when the document and the agent disagree on routes, auth, response statuses, headers, media types or response shapes. T-API-08 checks that the agent's docs routes are off by default, never set in Azure, same-origin and limited to fixed files. T-API-09..11 do the same for the seller, its catalog prices included. |
| §5, T-IMG-01 | The L1 and seller images list `swagger-ui-dist`, which the shared module resolves at run time, and carry their documents. |

## Changes in 1.5

The hosted agent service: L1 as an HTTP service built on Mastra, deployable to Azure Container Apps with L2 and L3 kept private (`specs/011`). Without the new entry point and the Azure profile, every existing process behaves as in 1.4, except L2's new ledger lock (L2-6).

| Area | Change |
|---|---|
| §3.1, L1-6 | A second L1 entry point, `src/hosted-main.ts` (`npm run agent:hosted`), serves `POST /v1/runs` to requesters with Entra ID tokens carrying `Agent.Run`. Same two tools, prompt and limits as L1-3. |
| §3.1 Azure profile | One Container Apps environment. The agent has public ingress; L2 and L3 have internal-only ingress through a loopback-forwarding sidecar. One identity and one Key Vault per runtime unit, and the sellers live in a separate environment. One image per layer, plus the seller's, each holding only that unit's code. Every resource and app registration is named `{type}-{app}-{location}-{env}`, every name written in the parameter files' `names`, and `infra/cleanup.sh` deletes all of an environment. Azure is provisioned by Bicep only: `infra/pre-deploy.bicep` and `infra/main.bicep`, every value in their parameter files, deployed by one workflow. |
| §3.3, CFG-2 | New credentials: the requester's Entra token (verified by L1 only), `SESSION_REF_SECRET` (L1 only) and the agent identity's Foundry access. New env file `env/l1-hosted.env`; `env/l1-agent.env` gains optional `SELLER_ALIAS_URL`. `infra/pre-deploy.<env>.bicepparam` and `infra/main.<env>.bicepparam` hold every value the two Azure deployments use, with no secret. |
| INV-3 | Names both L1 entry points; both load env and then refuse. |
| L1-4 | Optional seller alias for step 6, and `--check-baseline` (exit 2 on a mismatch). |
| L2-6 | One ledger writer: L2 takes an exclusive lock beside the ledger before loading it, and waits in standby while another holder's heartbeat is fresh. |
| §11 | SEC-14, SEC-15 and SEC-16, plus v1.5 residual risks. |
| §5, §6, §12, §13 | Mastra and its libraries (Node ≥ 22.13), the Azure layout under `infra/` (`pre-deploy.bicep` and `main.bicep` with their parameter files), `docker/` and `.github/workflows/` (one pipeline per unit and the shared `deploy.yml`), tests T-AGT-02..05, T-LED-05, T-E2E-09, T-IAC-01, T-IMG-01 and T-E2E-AZ, and the new commands. |

## Changes in 1.4

One opt-in behavior change: with `API_DOCS=1`, L2 serves Swagger UI. Without it, L2 behaves exactly as in 1.3. No contract change.

| Area | Change |
|---|---|
| L2-5, §6 | `docs/l2-control.openapi.yaml` describes the L2 HTTP API in OpenAPI 3.1, for tools such as Swagger UI, Swagger Editor or Redocly. The L2-5 table and §7 stay normative. |
| L2-5, CFG-2, §13 | `API_DOCS=1` mounts `GET /docs`, `GET /docs/:asset` and `GET /openapi.yaml` on L2: Swagger UI over that document, with no token. Off by default; a value other than `1`, `0` or empty fails startup. |
| §5 | `swagger-ui-dist` 5.33.1 (exact) supplies the Swagger UI files. `package.json` sets `scarfSettings.enabled: false`, so its `@scarf/scarf` dependency never reports installs. `yaml` (dev only) parses the document in tests. |
| §11 | SEC-13 covers the token-free docs routes. |
| §12 | T-API-01..03 fail when the document and the service disagree on routes, bearer tokens, response statuses, media types or response shapes. T-API-04 checks that the docs routes are off by default, same-origin and limited to fixed files. |

## Changes in 1.3

From `specs/010-operator-reject-flow`. No `INV-*` is weakened. The constitution moves to v1.1.1 (PATCH: Principle I names "rejects" among the capabilities the agent never gets).

| Area | Change |
|---|---|
| L2-4.3 (new) | Every escalation starts pending and ends exactly once: approved, denied (rejected by the operator) or expired 300 s after creation. Final states are never left. A repeat of the same purchase while pending returns the pending escalation's ID. |
| L2-2 | R15 `human_rejected`: a DENY for any request whose (session, resource key) the operator rejected, at any amount or payee. Its detail carries only the rejection ID (SEC-12). |
| L2-4 | New entry types `HUMAN_REJECTION`, `ESCALATION_EXPIRED`, `APPROVAL_LAPSED` and `ESCALATION_REPEATED`. |
| L2-4.2, L2-5 | Approve is state-aware: re-approving returns the existing approval, so an escalation pays at most once; approve on a denied or expired escalation is 409. New `POST /v1/rejections/:authorizationId`, `GET /v1/escalations` and `GET /v1/escalations/events`. L2 expires escalations through a 1 s sweep and makes no outbound calls. |
| §11, §12, §13 | SEC-12; T-POL-15, T-LED-04, T-E2E-07 and T-E2E-08; `npm run reject` and `npm run escalations`. |

## Changes in 1.2

From `specs/009-cdp-facilitator-base-sepolia`. No `INV-*` is weakened. The constitution moves to v1.1.0 (MINOR: the stack gains the CDP SDK, and Principle V gains a third-party credential bullet).

| Area | Change |
|---|---|
| §1.2, CP-3, CFG-1 | On `base-sepolia` the seller defaults to the authenticated CDP x402 facilitator (`FACILITATOR=cdp`). `FACILITATOR=public` opts back into `https://x402.org/facilitator`. Invalid combinations fail at startup, and there is no runtime fallback. |
| §3.3, CFG-2, §4.1 | A new secret, `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`, is held by the seller only. New architecture rule A8 confines it to `src/counterparty/cdp-facilitator.ts` and `env/seller.env.example`. |
| §5 | `@coinbase/cdp-sdk` 1.59.0 (exact). The seller only, and only `generateJwt` from `@coinbase/cdp-sdk/auth`. |
| CP-1 | Facilitator failures map to four categories: `unavailable`, `authentication`, `rate-limited`, `unsupported`. Before a challenge they give 503 `{error, category}`; during a paid retry, 502 `{error}`. Hosted facilitator calls time out after 30 s. |
| L3-1 | Step 2: a `PAYMENT-RESPONSE` that reports failure but carries a transaction hash is checked on-chain, not trusted (INV-10). |
| §11, §12, §13, §16 | SEC-10 and SEC-11; T-CDP-01..09, T-ARCH-A8 and T-E2E-06; `npm run demo:base-sepolia`; the CDP JWT clock-skew gotcha. |

## Changes in 1.1

Accepted from the spec-kit plans (`specs/001`–`specs/008`, gate task 008 T000). No `INV-*` is weakened, and the constitution stays at v1.0.0.

| Area | Change |
|---|---|
| §3.1, §6, CP-2 | The facilitator process entry point is `scripts/facilitator.ts`. `src/counterparty/facilitator.ts` becomes a factory that takes a ready account, so INV-2 holds without an exemption. |
| §4 | Architecture test rules A1–A7 are listed (§4.1). INV-4 also bans `sendTransaction` and `privateKeyToAccount`. INV-12: "once" means once per approval. |
| §5 | Exact resolved versions recorded; the engine floor is Node ≥ 22. |
| §6, §12 | New test files and IDs: T-AUTH-01/02, T-ARCH-ENV, and an automated key-refusal test. |
| §8.1 | L1-1: a verify error after a 2xx paid retry gives `PAYMENT_FAILED` and keeps `payment`. L1-3: the tool description strings are fixed. |
| §8.2 | L2-1: a mandate that breaks the constraint fails startup. L2-4: `seq` starts at 0; canonical JSON omits absent optional fields; the MISMATCH detail format is fixed; `brokenAt` is a 0-based line index. L2-4.2: approvals are single-use by `approvalId`, and the most recent open approval wins. L2-5: budget for an unknown session; reconcile runs inside the mutex and returns 400 on a malformed body; approval request validation. |
| §8.3 | L3-1: one shared deadline. L3-2: 401 before 400, stricter 400 rules, PENDING schedule replacement, and a 5 s reconcile push timeout. |
| §8.4 | CP-1 weather seed; CP-2 error bodies; CP-4 MockUSDC extras; CP-5 deployment record schema, fail-fast and `localDevKeys()`. |
| §9 | CFG-2: tokens fail closed off `local`, `ENV_FILE` defaults per entry point, constant-time token comparison, and demo child environments. |
| §11 | The SEC-3 test column now says T-POL-05/11. |
| §13 | Demo and approve CLI exit codes, plus `npm run check`. |
| Build sync | Decisions made while implementing, folded in so SPEC matches behavior: §3.1 ports are getter functions and L2/L3 bind through `listenControl`/`listenSettlement`; L2-4.2 an approval is consumed only when it lifted R14; L3-1 non-timeout RPC errors and unexpected verifier errors give `PENDING`, and a non-integer amount gives `MISMATCH`; CP-1 the seller syncs with the facilitator lazily and answers 503 on priced routes while it is unreachable; CFG-2 demo spawning, env reading and local payee defaults, and the approve CLI token; §12 test locations and T-ARCH-TRACE/T-ARCH-BIND; the demo summary line `hash chain ok=<bool> entries=<n>`. |

---

## 0. How Claude Code must use this spec

1. **This file is normative.** If code and spec disagree, the spec wins. Fix the code, or change the spec first in the same PR with a stated reason.
2. Requirements carry IDs (`INV-*`, `L1-*`, `L2-*`, `L3-*`, `CP-*`, `CFG-*`, `SEC-*`, `T-*`). Reference them in commit messages and test names.
3. **Definition of done** for any change:
   - `npm run typecheck` passes.
   - `npm test` passes (all suites, including `test/architecture.test.ts`).
   - `npm run demo:local` ends with the summary `spent on-chain: 0.006 USDC` and `hash chain ok=true`, unless the change intentionally alters the scripted plan or prices. In that case update §12 and the README.
   - Every new rule, endpoint or contract field has a test.
4. Never weaken an `INV-*` invariant to make a test pass.
5. Build order for a from-scratch rebuild is in §14. Extensions are specified in §15.

---

## 1. Purpose and scope

### 1.1 Goal
Show, as runnable code, that an LLM agent can buy HTTP resources with x402 stablecoin micropayments **without the agent holding payment authority**. Probabilistic reasoning (L1) is isolated from deterministic authorization (L2) and from settlement verification (L3). The isolation holds at the module, process and credential level.

### 1.2 In scope
- x402 protocol v2, scheme `exact`, EVM, EIP-3009 `transferWithAuthorization` (USDC).
- Networks: `local` (ganache, chainId 31337, MockUSDC) and `base-sepolia` (chainId 84532, Circle USDC).
- One buyer agent (Claude tool-use, or a scripted agent with no LLM), one seller API, one facilitator. On `base-sepolia` the facilitator is Coinbase Developer Platform's hosted x402 facilitator by default (CP-3).
- Spending mandate, human-in-the-loop (HITL) escalation, hash-chained audit ledger, on-chain settlement verification.
- User accounts (v1.10, off by default): many users, self-service. Every person who may start agent runs can onboard in the L2 web portal: a profile, one crypto account of their own that only L2 signs with, and expense policies that say where their agent may pay, how much, and when a person is asked first (L2-8). Cards can be registered at a card vault (Stripe test mode) and are never a way to pay.
- Portal administration (v1.15, off by default): a person the organization names an administrator sees every pending escalation in the portal, approves or rejects it, follows what happened, sees the budget behind it and checks the ledger (L2-8). The operator's command line and the approver's phone stay as they are.
- Approval by the person the run is for (v1.16, off by default): when a person's agent run escalates a payment, that person, and nobody else, is asked on their own phone, and their verified answer approves or refuses it (L2-7). An escalation with no user behind it asks nobody by phone.
- Callers of the hosted agent service from the sign-in tenant (v1.17): people who hold the role `x402-agent` (the permission `agent:run`) and sign in through the agent's own client, and machine callers, each with its own client. Nothing from the organization's directory is accepted. L1 forwards the caller's token to L2, which verifies it itself and takes the user of each payment from it: a person's run pays from that person's account, a machine caller's from the platform account (L1-6, L2-5). On request the run route answers with a stream of server-sent events (L1-6).

### 1.3 Out of scope (v1)
Mainnet. Refunds and disputes. Schemes `upto` and `batch-settlement`. Solana. AP2 / ACP / Visa TAP / Mastercard Agent Pay integration. Organizations or teams of users, and roles among them (v1.10 has users, each on their own). Paying with a card. Moving funds out of a user's account. A user approving their own payments in the portal: since v1.16 a user approves them by phone (L2-7), and the portal's approve and reject stay with administrators, never for their own payment (SEC-29). Forwarding a person's token from the portal to L2 (v1.17): the portal keeps naming the user on its own routes, from the token it verified. Notifying an administrator when the portal is closed, and a payment history for users. Deleting a user: an account is disabled, never deleted. Persistent DB beyond JSONL. Production authentication (mTLS). These are covered in §15. The Azure profile (§3.1, v1.5) is in scope on testnet only.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| Atomic units | Integer token units. USDC has 6 decimals: `1000` = $0.001 |
| Challenge | Seller's HTTP 402 response with header `PAYMENT-REQUIRED` (base64 JSON `PaymentRequired`) |
| Requirement | One entry of `PaymentRequired.accepts[]` (`PaymentRequirements`) |
| Intent | L1's request to L2 to pay one challenge (`PaymentIntent`) |
| Authorization | L2's signed EIP-3009 payload, sent as header `PAYMENT-SIGNATURE` |
| Mandate | Human-defined spending rules enforced by L2 (`config/mandate.json`) |
| Committed spend | Sum of authorizations that can still move money (§8.2.6) |
| Facilitator | Service that verifies and settles x402 payments on-chain and pays gas |
| HITL | Human-in-the-loop approval of an `ESCALATE` decision |
| User (v1.10) | A person who signed in to the portal through its own application (v1.14: no role or permission is asked for; before, the permission to start agent runs). Known to L2 only as `userId` (`usr_` + 32 hex, from the issuer and the subject of their sign-in; v1.12: the Auth0 tenant and its `sub`); never by name or email |
| Portal | The web portal process (`src/portal/`, port 4025): the web app and its API. It holds no key and never signs; v1.15: it relays an administrator's decision on an escalation to L2, which checks and records it |
| Administrator (v1.15) | A user whose portal token also carries the administrator permission (`portal:admin`, held by the tenant's role `x402-admin` and given to a person by hand; v1.17: one of the two permissions of people's API, beside the agent's `agent:run`). Known to L2 only as a `usr_` identifier, like any user |
| Administration area | The part of the portal only administrators see (`/admin`, `/api/admin/*`): the waiting list, one payment with its budget and the two decisions, the activity trail and the ledger check |
| Decision path | Where an approval or a rejection came from: the operator's command line (`operator`), the approver's phone (`backchannel`, v1.8) or the portal (`portal`, v1.15). Recorded as `channel` |
| Wallet | What a user pays with: one crypto account that L2 derives and signs for, plus the cards they registered. Cards never pay |
| Expense policy | A user's own spending rules for a set of sellers: auto-approve limit, per-payment cap, per-run and per-day budgets, payments per minute, end date. Versioned; active, paused or removed |
| Platform limits | The operator's upper bounds on every policy (`config/platform.json`, CFG-4). A policy can be stricter, never looser |
| Seller list | The sellers the operator allows, by host, with a name and optional payees (CFG-4). A policy can only name sellers on it |
| User daily ceiling | The most one user can spend in any 24 hours across all their policies (`limits.userDailyCeilingAtomic`) |
| Platform account | The original payer (`PAYER_PRIVATE_KEY`) and its mandate (`config/mandate.json`): every payment with no user behind it (v1.17: a machine caller's, and one made where sign-in is not configured at L2) |
| Caller (v1.17) | Whoever sends a goal to the hosted agent service: a person (their subject at the sign-in tenant) or a machine caller (its client there). Never both |
| Caller's token (v1.17) | The access token the caller presented, issued by the sign-in tenant for people's API. It lives for the run only, in L1's memory and on its calls to L2 (`X-Caller-Authorization`) |
| Machine caller (v1.17) | A caller that is not a person: a confidential client of the sign-in tenant, one per caller, with one stored key and the permission `agent:run`. Its runs have no user, so the platform account pays. The first is `checks`, the deployment pipeline's two checks |

---

## 3. Architecture

### 3.1 Process topology

| Process | Entry point | Port (bind) | npm script | Env file |
|---|---|---|---|---|
| L1 agent | `src/main.ts` | none (client) | `agent`, `agent:scripted` | `env/l1-agent.env` |
| L1 hosted agent service (v1.5) | `src/hosted-main.ts` | 4024 (127.0.0.1; `0.0.0.0` in a container) | `agent:hosted` | `env/l1-hosted.env` |
| L1 smoke client (v1.17) | `src/smoke-main.ts` | none (client) | none (the smoke job's command, L1-5) | `env/l1-agent.env` |
| L2 control | `src/layer2-control/service.ts` | 4020 (127.0.0.1) | `l2:control` | `env/l2-control.env` |
| L3 verifier | `src/layer3-settlement/service.ts` | 4023 (127.0.0.1) | `l3:verifier` | `env/l3-verifier.env` |
| Seller (counterparty) | `src/counterparty/seller.ts` | 4021 (all interfaces) | `seller` | `env/seller.env` |
| Facilitator (counterparty, local only) | `scripts/facilitator.ts` (wraps the `src/counterparty/facilitator.ts` factory) | 4022 | `facilitator` | `env/facilitator.env` |
| Portal (v1.10) | `src/portal-main.ts` | 4025 (127.0.0.1; `0.0.0.0` in a container) | `portal` | `env/portal.env` |
| Local chain | `scripts/local-chain.ts` | 8545 | `local:chain` | none |

Ports are overridable with `CONTROL_PORT`, `SELLER_PORT`, `FACILITATOR_PORT`, `SETTLEMENT_PORT`, `AGENT_PORT` and `PORTAL_PORT`. The chain port 8545 is fixed. Each entry point loads its env with `loadEnv()` from `src/shared/config.ts`. When `ENV_FILE` is unset, it defaults to the file in the last column. Ports are read through getter functions (`controlPort()`, `sellerPort()`, `facilitatorPort()`, `settlementPort()`) at call time, so env loaded at startup applies. L2 and L3 bind only through `listenControl()` and `listenSettlement()`, which always use `127.0.0.1`.

**The portal (v1.10, L2-8)** serves the web app (`web/portal/`, built to `dist/portal-web`) and a JSON API under `/api` to the signed-in person. It calls L2's portal routes with its own role token and reads balances from the chain's RPC; it has no key and no route that authorizes, signs or reconciles. v1.15: with the administration area on (`PORTAL_ADMIN=1`), it also relays an administrator's approval or rejection of an escalation to L2's administration routes, with a second role token of its own; L2 checks and records the decision, and the portal decides nothing itself. It is never on the decision path: with the portal down, agents pay exactly as before, and with L2 down the portal answers 502 and grants nothing. It runs only when user accounts are on (`npm run stack:local -- --users`); `demo:local` never starts it.

**Azure profile (v1.5, `specs/011` contracts/cloud-topology.md).**

- **Naming.** Every resource and Entra app registration is `{type}-{app}-{location}-{env}`, written only in the parameter files' `names` (the templates and the pipelines take every name from there) and checked by T-IAC-01 rule 15. `{app}` is `l1`, `l2`, `l3`, `op`, `portal` (v1.10), `seller` or `seller-alias`, or `x402` for what the layers share and `deploy` for the deploy app. The registry and storage account drop the hyphens (`crx402eastus2dev`). The names below are dev's in `eastus2`; the resource group is `rg-x402-eastus2-dev`, the deploy app `app-deploy-eastus2-dev`. v1.17: there is no API app registration any more (`names.apiApp` is gone): the agent's callers come from the sign-in tenant.
- **Environments.** One workload-profiles Container Apps environment, `cae-x402-eastus2-dev`, on a custom VNet with peer-to-peer encryption. The sellers live in a second environment, `cae-seller-eastus2-dev`, so they can't reach internal-only apps.
- **Apps and jobs** in `cae-x402-eastus2-dev`:
  - `ca-l1-eastus2-dev`: the hosted agent service, external ingress on 4024, 0–1 replicas;
  - `ca-l2-eastus2-dev` and `ca-l3-eastus2-dev`: internal-only ingress, exactly one replica each;
  - `caj-l1-eastus2-dev`: the scripted baseline with `--check-baseline`;
  - the smoke job (v1.17, `names.jobs.smoke`): the hosted smoke run, `src/smoke-main.ts`, in the `l1` unit and on its image;
  - `caj-l2-eastus2-dev`: the operator commands, a unit of its own (the operator's identity, vault, image and pipeline);
  - `ca-portal-eastus2-dev` (v1.10): the portal, a unit of its own, external ingress on 4025, 0–1 replicas, single revision.
- **Loopback kept.** L2 and L3 still bind 127.0.0.1. A proxy sidecar in the same app forwards from port 8080 to the loopback port; it gets no env and no secrets.
- **Backchannel approval (v1.8).** L2's container always references `ciba-client-credential` in the l2 vault and always gets the `CIBA_*` values of the `ciba` parameter, so every environment seeds that secret (`off` while `ciba.enabled` is false). Turning the feature on is a vault update plus `ciba.enabled: true` and a `deploy-l2.yml` run. v1.16: `ciba` is `{ enabled, issuer, clientId, audience, credential, clientKeyId }`, with no approver; no app has a `CIBA_APPROVER` variable; and `main.bicep` refuses (`fail()`) `ciba.enabled` without `userAccounts.enabled` (T-IAC-01 rule 19). v1.17: people start runs in a deployed environment (L1-6), so the feature, when on there, asks the person a run is for; a machine caller's escalation asks nobody.
- **User accounts (v1.10).** `main.bicep` takes a `userAccounts` object (`enabled`, `portalClientId`, `sellerName`, `cardVault`, `cardVaultPublishableKey`; no secret), and since v1.12 an `identity` object (`issuer`, `audience`: the Auth0 tenant's issuer and the API's identifier; Terraform's output in `auth0/`, no secret; it names no client: the portal's is `userAccounts.portalClientId` and, since v1.17, the agent's is `agent.clientId`). `portalClientId` is the Auth0 single-page client's ID. L2's container always references `portal-token` and `user-wallet-mnemonic` in the l2 vault, and the portal always references `portal-token` and `card-vault-key` in its own vault (`kv-portal-eastus2-dev`), so every environment seeds all four, as `off` while the feature is off. L2 gets `USER_ACCOUNTS` and `PLATFORM_SELLERS` (one entry: the seller's own host, `userAccounts.sellerName` and the seller's payee) from the parameter file, and the portal `AUTH_ISSUER`, `AUTH_AUDIENCE` and `PORTAL_CLIENT_ID`; v1.17: the agent and L2 get their sign-in settings from `identity` and `agent` (the item "Callers of the agent" below), and user accounts need them at L2. The portal's profile files live on a second NFS share, `profiles`, mounted at `/app/.local/portal` by the portal only. Turning the feature on is the vault updates, `userAccounts.enabled: true`, and runs of `deploy-l2.yml`, `deploy-portal.yml` and `deploy-l1.yml`. The mnemonic is never rotated in place: with another one L2 refuses to start (L2-3).
- **Portal administration (v1.15).** `userAccounts` gains `administration` (a boolean; `main.bicep` refuses it without `enabled`), which sets `PORTAL_ADMIN` in L2 and in the portal. Both always reference one more secret, `portal-admin-token`, each from its own vault, so every environment seeds it (`off` until the area is turned on; then one new random value, the same in both vaults and different from `portal-token`). Who is an administrator is not an Azure object: `auth0/` gives people's API the permission `portal:admin` and the role `x402-admin`, which holds exactly it, and an administrator of the tenant assigns the role per person in Auth0 (T-IAC-02). No new unit, image or pipeline (T-IAC-01 rule 22). v1.17: people start runs in a deployed environment, so their escalations appear there beside the platform account's.
- **Callers of the agent (v1.17, `specs/016` contracts/tenant-and-config.md).** `main.bicep` takes an `agent` object (`clientId`, `apiDocs`, `machineClientId`, `machineKeyId`; no secret): the three IDs are Terraform's output `bicepparam_agent` (the agent's client, and the client and key ID of the machine caller `checks`), and `apiDocs` is the environment's own choice. From `identity` and `agent` the agent gets `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS`, and `API_DOCS` (`agent.apiDocs ? '1' : '0'`) with `API_DOCS_CLIENT_ID`; L2 gets `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS` and `PORTAL_CLIENT_ID`. No container gets `AUTH_TENANT_ID` or `SERVICE_AUDIENCE`, and `param authAudience` is gone. `main.bicep` refuses (`fail()`) the `l1` and `l2` units without `identity.issuer`, `identity.audience` and `agent.clientId`, `agent.apiDocs` without `agent.clientId`, and the two jobs without `agent.machineClientId` and `agent.machineKeyId` (T-IAC-01 rule 23). The first deployment of an environment with v1.17 goes L2 first, with `first-deployment` (the smoke job does not exist yet), then L1, then L2 again to promote its image: an L2 with v1.17 refuses a payment request without a caller's token, so nothing is paid until the agent follows, while a v1.17 agent in front of an older L2 would have a person's run paid by the platform account (`specs/016` quickstart §5).
  - **The docs switch.** `agent.apiDocs` turns the agent's API docs page on in that environment (L1-6); absent or false, the page does not exist there. The agent's app is the only place where `infra/` sets `API_DOCS`: L2, the seller and the portal never serve a docs page in a deployed environment (T-API-08).
  - **The pipeline's checks call as a machine caller.** The scripted regression (`caj-l1-eastus2-dev`) and the hosted smoke run (the smoke job) each get `AUTH_ISSUER`, `AUTH_AUDIENCE`, `MACHINE_CLIENT_ID` and `MACHINE_CLIENT_KEY_ID`, and reference one more secret of the l1 vault, `machine-client-key`, as `MACHINE_CLIENT_KEY`: the private half of the `checks` key. The smoke job also gets `AGENT_URL` and `AGENT_CANDIDATE_URL` (the agent's address and its `---candidate` label's), because a job start can't pass a value; it uses the candidate when its `/healthz` answers. Every environment seeds `machine-client-key` by hand before its first L1 deployment with 1.17 (`off` until the tenant has the client: the deployment then succeeds, the two jobs fail, and so does the run that starts them). GitHub holds no credential of a machine caller, and the pipeline never holds a token.
  - **No directory object for the agent's callers.** Nothing at the organization's directory stands for them: no API app registration, service principal, app role (`Agent.Run`), role assignment or list of people (`agentUsers`). Entra stays for the pipeline's sign-in to Azure, the agent's own access to the model and the operators' group, unchanged.
- **Identity and secrets.** Each runtime unit has its own user-assigned identity and Key Vault. The identity lifecycle is `None` everywhere except the agent, so no container in L2 or L3 can request a token at run time. Secrets reach containers only as Key Vault references.
- **Ledger.** L2's ledger lives on an NFS Azure Files share mounted at `/app/.local`, with the L2-6 lock.
- **Images.** One image per unit, each tagged with the commit that its own pipeline built:
  - `x402-l1-agent`: the agent, `caj-l1-eastus2-dev` and (v1.17) the smoke job;
  - `x402-l2-control`: L2;
  - `x402-l3-verifier`: L3;
  - `x402-operator`: `caj-l2-eastus2-dev`, the operator scripts only;
  - `x402-portal` (v1.10): the portal and the built web app, with no file of any layer;
  - `x402-seller`: the sellers.

  Each image holds only its own unit's code and the packages that code imports, so only L2's image contains the signer, or any L2 code (T-IMG-01). Each app and job runs from its own unit's image (T-IAC-01 rule 12).
- **Templates.** Azure is provisioned by Bicep only.
  - `infra/pre-deploy.bicep` (subscription scope, deployed by an administrator by hand) makes the resource group, the deploy app registration with a GitHub federated credential and no secret (v1.17: the only app registration it makes), the operators' group, and the deploy app's roles: Contributor and Role Based Access Control Administrator, limited to `main.bicep`'s four roles, on the resource group only (T-IAC-01 rule 16). The Entra objects use the Microsoft Graph Bicep extension. v1.17: the template no longer names the API app registration, its service principal, the `Agent.Run` role and its assignments, `agentUsers` or `retirePortalScope`, and its `mainParameters` output has no `authAudience`. Bicep does not delete a Graph object that a template stops naming, so an administrator deletes the old registration by hand once the agent with 1.17 is deployed (its service principal, the role, the assignments and the unfinished `Portal.Access` retirement go with it); deployed first, the agent already refuses the directory's tokens.
  - `infra/main.bicep` makes everything in the resource group: the platform (network, identities, registry, vaults, storage, Foundry with the Claude deployment, both environments) and each unit's apps (L1, L2, L3, the operator, the portal, the sellers), each from its own image and with only its own identities and vaults (T-IAC-01 rules 12 and 13). One deployment deploys one of them, chosen by its `unit` parameter, and leaves the rest as it is (T-IAC-01 rule 18). Its modules take names, never other modules' outputs, so what-if previews even a first deployment.
  - Every value is in `infra/pre-deploy.<env>.bicepparam` and `infra/main.<env>.bicepparam`, the tenant, subscription and resource group included; each template fails validation anywhere else (T-IAC-01 rule 17).
- **Pipelines.** One per unit in `.github/workflows/`, each run by hand or on its own tag, one at a time (one concurrency group): `deploy-infra.yml` deploys the platform (`unit` platform), and `deploy-l1.yml`, `deploy-l2.yml`, `deploy-l3.yml`, `deploy-operator.yml`, `deploy-portal.yml` (v1.10) and `deploy-seller.yml` each build their unit's image and deploy their unit's apps. All seven call the same steps, the reusable `deploy.yml`, with their unit; each deployment is previewed with what-if. It signs in with OIDC from the parameter file at the start of every step that calls Azure (GitHub's token is valid for 5 minutes) and reads no GitHub secret. One more workflow, `provision-auth0.yml` (v1.9), applies the Auth0 tenant (`auth0/`, Terraform) by hand, from its own GitHub environment `auth0-<env>`: the only place GitHub holds secrets (the Auth0 Management API credential), with its state in a storage account that `pre-deploy.bicep` makes and only the deploy app reads, over OIDC (T-IAC-02, T-IAC-01 rule 20). Every run checks the deployed units together (the cloud regression, the chain, the hosted smoke, since v1.10 the portal smoke, and the log scan; v1.17: the cloud regression and the hosted smoke are jobs that call as the machine caller `checks`, started with `run_job`, so no step asks for a token); a unit's image becomes `last-good` only after they pass, and a failure rolls back only that unit. The platform is fixed forward. L1's run moves the agent's traffic by redeploying `main.bicep`. On a new environment each pipeline but L1's starts with a first deployment, which skips the checks through units not deployed yet (T-E2E-AZ).
- **Pull request check** (v1.20). `checks.yml` runs on every pull request to `main`, Dependabot's included, and on every push to `main`: the pinned Bicep CLI of `deploy.yml`, checked against its SHA-256 and put in `BICEP_PATH`, then exactly `deploy.yml`'s step 1 (`npm install`, `npm run audit:shipped`, `npm run typecheck`, v1.21 `npm run build` and `npm run build:web`, `npm test`) and `npm run demo:local`, on Node 22 and Node 26. It deploys nothing and holds nothing a deployment has: `contents: read` only, no GitHub environment, secret, variable or OIDC token, a checkout that keeps no credential (`npm install` runs the pull request's install scripts), `pull_request` only (never `pull_request_target`) and no paths filter, every action pinned by commit SHA (T-CI-01). A merge waits for it only once the repository's branch protection requires it, which an administrator sets by hand.

### 3.2 Data flow

```mermaid
sequenceDiagram
  autonumber
  participant L1 as L1 Agent
  participant S as Seller
  participant L2 as L2 Control (key)
  participant F as Facilitator
  participant C as Chain
  participant L3 as L3 Verifier
  L1->>S: GET resource
  S-->>L1: 402 + PAYMENT-REQUIRED
  L1->>L2: POST /v1/authorize (PaymentIntent)
  L2-->>L1: AuthorizationDecision (AUTHORIZED + paymentHeaders | DENIED | ESCALATE)
  L1->>S: GET resource + PAYMENT-SIGNATURE
  S->>F: /verify then /settle
  F->>C: transferWithAuthorization
  S-->>L1: 200 + PAYMENT-RESPONSE
  L1->>L3: POST /v1/settlements (SettlementClaim)
  L3->>C: receipt, Transfer log, finality
  L3->>L2: POST /v1/reconcile (SettlementReport)
  L3-->>L1: SettlementReport
```

v1.17: on step 3, and on a budget read, the hosted agent sends the caller's token beside its role token, in the
header `X-Caller-Authorization` (L1-2); L2 verifies it and takes the user of the payment from it (L2-5). The token
goes to L2 only: it is on no other step, so the seller, the facilitator and L3 never see it.

An administrator's decision (v1.15, L2-8) runs beside this flow and never inside it. It starts only after step 4
has answered `ESCALATE`, and it ends in one ledger entry; the payment itself is still made by a later run of steps
3 to 12, where L2 decides again.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser (administrator)
  participant P as Portal (no key)
  participant L2 as L2 Control (key)
  B->>P: POST /api/admin/escalations/:id/approve or /reject (the person's token, with the permission portal:admin)
  P->>L2: POST /v1/admin/escalations/:id/approve or /reject (PORTAL_ADMIN_TOKEN; the decider and their sign-in time, from the token)
  L2-->>P: DecisionOutcome, after one HUMAN_APPROVAL or HUMAN_REJECTION (channel: portal), or a refusal that appends nothing
  P-->>B: DecisionOutcome
```

The portal names the decider and relays the answer; L2 checks that the escalation is pending, that it is not the
decider's own, and (for an approval) that their sign-in is fresh, inside the serialized section. The operator's
command line and the approver's phone (L2-7) reach the same decision core by their own routes.

### 3.3 Credential matrix (who holds what)

| Secret | L1 | L2 | L3 | Seller | Facilitator | Human operator | Portal (v1.10) |
|---|---|---|---|---|---|---|---|
| `PAYER_PRIVATE_KEY` | **never** | ✅ | — | — | — | — | **never** |
| `ANTHROPIC_API_KEY` | ✅ | — | — | — | — | — | — |
| `CONTROL_TOKEN` (L1→L2) | ✅ | ✅ verifies | — | — | — | — | — |
| `VERIFIER_TOKEN` (L1→L3) | ✅ | — | ✅ verifies | — | — | — | — |
| `SETTLEMENT_TOKEN` (L3→L2) | — | ✅ verifies | ✅ | — | — | — | — |
| `OPERATOR_TOKEN` (human→L2) | — | ✅ verifies | — | — | — | ✅ | — |
| Requester's token (requester→L1 hosted, v1.5; v1.17: a person's or a machine caller's access token from the sign-in tenant, forwarded L1→L2) | ✅ verifies, forwards to L2 only | ✅ verifies (v1.17: only beside `CONTROL_TOKEN`, on authorize and budget) | **never** | **never** | — | — | refuses it |
| Machine caller's key (`MACHINE_CLIENT_KEY`, machine caller→Auth0, v1.17) | ✅ (the command-line agent and the smoke client, `src/machine-caller/token.ts` only) | — | — | — | — | — | — |
| `SESSION_REF_SECRET` (v1.5) | ✅ (hosted only) | — | — | — | — | — | — |
| Agent identity's Foundry access (v1.5, `MODEL_PROVIDER=foundry`) | ✅ (managed identity, no secret) | — | — | — | — | — | — |
| `FACILITATOR_PRIVATE_KEY` | — | — | — | — | ✅ (local) | — | — |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | — | — | ✅ (`FACILITATOR=cdp`) | — | — | — |
| `CIBA_CLIENT_KEY` or `CIBA_CLIENT_SECRET` (L2→Auth0, v1.8) | — | ✅ (`ciba-client.ts` only) | — | — | — | — | — |
| `PORTAL_TOKEN` (portal→L2, v1.10) | **never** | ✅ verifies | — | — | — | — | ✅ |
| `PORTAL_ADMIN_TOKEN` (portal→L2, administration, v1.15) | **never** | ✅ verifies | — | — | — | — | ✅ (`admin-client.ts` only) |
| `USER_WALLET_MNEMONIC` (v1.10) | **never** | ✅ (`signer.ts` only) | — | — | — | — | **never** |
| Person's portal token (browser→portal, v1.10; v1.12: an Auth0 access token) | refuses it | — | — | — | — | — | ✅ verifies, never forwards |
| `CARD_VAULT_KEY` (portal→card vault, v1.10) | — | — | — | — | — | — | ✅ (`card-vault.ts` only) |

The CDP API credential authenticates the seller to the CDP facilitator. It cannot authorize an on-chain transfer, so it is not payment key material (INV-2). Rule A8 confines it to one file.

The Auth0 client credential (v1.8, L2-7) authenticates L2 to the approval service, for starting and polling approval requests. It cannot sign a payment or approve one by itself: an approval counts only when the approver's signed answer verifies. Rule A9 confines it to one file. The approver's Guardian enrollment lives on their phone and in Auth0, never in this system.

v1.10 (L2-8):
- The wallet mnemonic is payment key material, like `PAYER_PRIVATE_KEY`: every user's account is derived from it. INV-2 and rules A3 and A11 keep it in `signer.ts`, and the portal refuses to start when it can see it.
- `PORTAL_TOKEN` opens only L2's portal routes. It cannot authorize, approve, reject or reconcile, and none of the other four tokens opens a portal route (INV-13).
- The person's portal token is an access token of the sign-in tenant (Auth0, v1.12) for the API, issued to the portal's single-page client. The portal verifies it and never forwards it; the hosted agent service refuses it, and the portal refuses the agent's: each service accepts only its own clients (SEC-20). The portal accepts no token of the organization's directory. v1.17: L2 refuses a portal token too when one is forwarded to it (L2-5).
- The card vault key authenticates the portal to the card vault. It is a restricted test-mode key that can only save, list and remove cards, so it is not payment authority. Rule A10 confines it to one file. Card numbers and security codes go from the browser straight to the vault and never reach any process of this system.

v1.17 (L1-6, L2-5):
- The requester's token is an access token of the sign-in tenant for people's API: a person's, issued to the agent's client, or a machine caller's, issued to that caller's own client. No token of the organization's directory authenticates a caller of the agent. L1 verifies it and forwards it unchanged to L2 only, in `X-Caller-Authorization`, on the authorize and budget calls of that run, beside `CONTROL_TOKEN`. L2 verifies it itself and takes the user from it. It is not a role token: it opens no route by itself and replaces none (INV-13). It never reaches L3, the seller, the facilitator or the model, and it is never stored or logged (SEC-32).
- A machine caller's key authenticates one machine caller to the sign-in tenant: it signs the assertion with which that caller's client asks for its own token. It never signs a payment. Rule A15 confines it to `src/machine-caller/token.ts`, used by the command-line agent (`src/main.ts`) and the smoke client (`src/smoke-main.ts`). In Azure it is the l1 vault's `machine-client-key`, referenced by the regression job and the smoke job only; the tenant holds its public half, and it is never in the repository, a template, a parameter file, Terraform's state or GitHub. The agent's identity can read the l1 vault: an accepted residual risk (§11).
- The agent's client at the tenant is public: authorization code with PKCE, no secret and no refresh token. Nothing about it is a credential, and its ID is in the parameter file.

---

## 4. Invariants (non-negotiable)

| ID | Invariant | Enforced by |
|---|---|---|
| INV-1 | A layer imports only `src/shared/**` and its own folder. Only `src/main.ts`, `scripts/**` and `test/**` may import across layers. | `test/architecture.test.ts` |
| INV-2 | Only `src/layer2-control/signer.ts` turns key material into an account (`privateKeyToAccount`, `mnemonicToAccount`). v1.10: that includes the wallet mnemonic (`USER_WALLET_MNEMONIC`), from which every user's account is derived; only `signer.ts` reads it. | architecture test (A3, A11), T-USR-08 |
| INV-3 | L1 code never references `PAYER_PRIVATE_KEY`. Both L1 entry points, `src/main.ts` and `src/hosted-main.ts` (v1.5), sit outside `src/layer1-intent/`. Each loads its env file and then exits with code 1 if that variable is present, from the process environment or from the file. v1.17: the smoke client, `src/smoke-main.ts`, is a third L1 entry point and does the same. | architecture test, manual check (§12) |
| INV-4 | L3 has no signing or write capability (no `createWalletClient`, `signTypedData`, `writeContract`, `sendTransaction`, `privateKeyToAccount`). | architecture test |
| INV-5 | The L2 decision is a pure function of (accepts[], mandate, context). No I/O, no clock reads (time is passed in), no LLM text. `PaymentIntent.purpose` is logged, never evaluated. | `policy.ts` design, T-POL-02 |
| INV-6 | L2 signs **exactly one** requirement: the one the policy chose. The SDK receives a challenge whose `accepts` holds only that entry. | `signer.ts` |
| INV-7 | Budget figures are derived from the ledger, never stored as separate mutable counters. | `ledger.ts` |
| INV-8 | Authorization decisions are serialized. The check-sign-append sequence is atomic across concurrent requests. | T-E2E-04 |
| INV-9 | The ledger is append-only and hash-chained. Startup fails if the chain does not verify. v1.19: with `LEDGER_MAC_KEY`, the chain is keyed too: every entry from the point of adoption on carries `mac = HMAC-SHA256(key, hash)`, so an entry rewritten with every later hash recomputed no longer verifies (L2-4). | T-LED-01, T-LED-09 |
| INV-10 | L3 trusts the chain, not the seller's `PAYMENT-RESPONSE`. CONFIRMED requires a matching Transfer log. | T-E2E-03 |
| INV-11 | CONFIRMED is final in L2. A later contradicting report is recorded with `anomaly: true` and does not change the effective status. | T-E2E-03, T-LED-03 |
| INV-12 | A human approval never overrides a DENY rule. It only lifts `human_approval_required` for one exact (session, resource, payTo, amount) tuple, once. "Once" means once per approval: each approval is a separate human act and is consumed by the first payment that uses it. Since v1.3 an escalation has at most one approval, and a `HUMAN_REJECTION` (R15) is a DENY that no approval can lift. | T-POL-13, T-POL-15, T-E2E-02 |
| INV-13 | Each caller has its own bearer token. L1 cannot reconcile or approve; L3 cannot authorize. v1.10: a fifth role, `portal-control` (`PORTAL_TOKEN`), opens only the portal routes of L2-5 and none of the others, and no other token opens them; L2 refuses to start when the portal's token equals another role's. v1.15: a sixth role, `portal-admin` (`PORTAL_ADMIN_TOKEN`), opens only the administration routes of L2-5: no user-account route, and never authorize, budget, reconcile or the operator's routes; no other token opens them, and L2 refuses to start when it equals another role's. v1.17: the caller's token that L1 forwards (L1-6, L2-5) is not a role token. L2 accepts it only beside L1's role token (`CONTROL_TOKEN`), in a header of its own (`X-Caller-Authorization`), on the authorize and budget routes: it opens no route by itself, it never replaces a role token, and no other route reads it. Every endpoint still accepts exactly one role. | T-E2E-02, T-E2E-05, T-USR-02, T-USR-07, T-ADM-02, T-ADM-10, T-CTK-01, T-CTK-04 |

---

### 4.1 Architecture test rules (`test/architecture.test.ts`)

| Rule | Invariant | Scope | Violation |
|---|---|---|---|
| A1 | INV-1 | all layer folders, and since v1.10 the area `src/portal/**` | an import resolves into another layer's folder; a portal file imports a layer, or a layer imports the portal |
| A2 | INV-1 | `src/shared/**` | shared code re-exports or imports layer code |
| A3 | INV-2 | `src/**` except `src/layer2-control/signer.ts` (`scripts/**` is out of scope) | identifier `privateKeyToAccount` or `mnemonicToAccount`, or an import of `viem/accounts` |
| A4 | INV-4 | `src/layer3-settlement/**`, and since v1.10 `src/portal/**` | `createWalletClient`, `signTypedData`, `writeContract`, `sendTransaction`, `privateKeyToAccount` |
| A5 | INV-3 | `src/layer1-intent/**` | string or identifier `PAYER_PRIVATE_KEY` |
| A6 | INV-5 | `src/layer2-control/policy.ts` | I/O or clock imports and calls (`node:*`, `fs`, `http`, `express`, `viem`, `@anthropic-ai/*`, `Date.now`, `new Date()`, `fetch(`, `Math.random`, `console.`), or code access to `purpose` |
| A7 | §10 | all layer folders | `Buffer.from(…, "base64")`, `atob` or `btoa` in a file that mentions an x402 header name |
| A8 | §3.3, SEC-10 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` exempt) | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` or an `@coinbase/cdp-sdk` import outside `src/counterparty/cdp-facilitator.ts` and `env/seller.env.example` |
| A9 (v1.8) | §3.3, SEC-17 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` exempt) | `CIBA_CLIENT_KEY` or `CIBA_CLIENT_SECRET` outside `src/layer2-control/ciba-client.ts` and `env/l2-control.env.example` (comments in TS don't count; `CIBA_CLIENT_KEY_ID` is not the credential) |
| A10 (v1.10) | §3.3, SEC-22 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` exempt) | `CARD_VAULT_KEY` (not `CARD_VAULT_KEY_…` or the publishable key), or the string `api.stripe.com`, outside `src/portal/card-vault.ts` and `env/portal.env.example` |
| A11 (v1.10) | INV-2, SEC-24 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` exempt) | `USER_WALLET_MNEMONIC` outside `src/layer2-control/signer.ts`, `src/portal-main.ts` (the refusal), `scripts/demo-lib.ts` (the local dev value) and `env/l2-control.env.example` |
| A12 (v1.10) | INV-13, SEC-19 | `src/layer1-intent/**`, `src/layer3-settlement/**`, `src/counterparty/**`; and `src/portal/**` | in a layer: `PORTAL_TOKEN` or (v1.15) `PORTAL_ADMIN_TOKEN`. In the portal: `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `OPERATOR_TOKEN`, `SETTLEMENT_TOKEN` or `VERIFIER_TOKEN` |
| A13 (v1.15) | INV-13, SEC-28 | `src/portal/**` | the role name `portal-admin` or `PORTAL_ADMIN_TOKEN` outside `config.ts` and `admin-client.ts`; an import of `./admin-client.js` outside `admin-routes.ts` and `server.ts`; an import of `./control-client.js` in `admin-routes.ts` or `admin-client.ts` |
| A14 (v1.17) | INV-13, SEC-32 | `src/**` | the header's name, `x-caller-authorization` in any case, outside `src/layer1-intent/ports-http.ts` and `src/layer2-control/caller.ts`; a call of `forCaller(` outside `src/layer1-intent/hosted/server.ts` and `src/main.ts` |
| A15 (v1.17) | §3.3, SEC-33 | `src/**` | `MACHINE_CLIENT_KEY` or `MACHINE_CLIENT_KEY_ID` outside `src/machine-caller/token.ts`; an import of `src/machine-caller/` in a layer folder |
| A16 (v1.19) | INV-9, SEC-36 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` exempt) | `LEDGER_MAC_KEY` outside `src/layer2-control/ledger-key.ts` and `env/l2-control.env.example` |
| A17 (v1.19) | INV-13, SEC-35 | `src/**` | the person's header's name, `x-person-authorization` in any case, outside `src/portal/person-context.ts` and `src/layer2-control/person.ts` |

Each rule has a fixture under `test/fixtures/arch/` that must trip it (Principle VIII). T-ARCH-ENV checks that each `env/*.env.example` holds only the variables its process may see (§3.3, CFG-2); since v1.10 that includes `env/portal.env.example`, and a key ending in `_MNEMONIC` or named `CARD_VAULT_KEY` must be empty.

## 5. Technology stack (pinned)

| Concern | Choice | Version |
|---|---|---|
| Runtime | Node.js, ESM (`"type": "module"`) | 22.x, at least 22.13 since v1.5 (Mastra's floor) |
| Language | TypeScript (`module`/`moduleResolution: NodeNext`, `strict`) | ^7.0 |
| Runner | tsx | ^4.23 |
| x402 | `@x402/core`, `@x402/evm`, `@x402/express` | 2.31.0 (v1.18; 2.28.0 before) |
| EVM | viem | ^2.57 |
| HTTP | express | ^5.3 |
| LLM | `@anthropic-ai/sdk` | ^1.8 (v1.19; ^0.135 before) |
| Tests | vitest (`fileParallelism: false`, 120 s timeouts; v1.7: `vitest.config.ts` lowers TC39 decorators with esbuild before oxc) | ^5.0 |
| Local chain (dev) | ganache (hardfork `shanghai`) + solc 0.8.24 (`evmVersion: shanghai`, optimizer 200) | 7.9.2 / 0.8.24 (exact: `contracts/MockUSDC.sol`'s pragma; Dependabot ignores solc) |
| Config | dotenv, one file per process via `ENV_FILE` | ^18 |
| CDP facilitator auth (seller only) | `@coinbase/cdp-sdk`, `./auth` subpath only; v1.18: its zod is the root's (`overrides`; v1.22: each image's `package.json` writes `$zod` out as the root's range, T-IMG-04) | 1.62.0 (exact) |
| OpenAPI document parsing (tests only) | yaml | ^2.9 |
| API docs UI (L2 and, since v1.6, the hosted agent and the seller, only with `API_DOCS=1`; served by the service itself, never from a CDN) | swagger-ui-dist | 5.35.0 (exact; v1.19, 5.33.1 before) |
| Hosted agent service (L1-6, v1.5): Mastra `Agent` as a library only, no Mastra server, CLI or instance | `@mastra/core`, `@ai-sdk/anthropic` | 1.83.0 (v1.19; 1.75.0 before) / 3.0.128 (exact) |
| Hosted agent service: tool schemas, requester tokens, Foundry identity | zod, jose, `@azure/identity` | ^4.6.7 / ^6.2.12 / ^4.14.1 |
| L2 backchannel approval (v1.8): the approver's access token (JWKS, RS256) and the `private_key_jwt` client assertion | jose | ^6.2.12 |
| The Auth0 tenant (v1.8, `auth0/`; its pipeline only, never a runtime dependency) | Terraform, provider `auth0/auth0` | >= 1.11.0 (the pipeline pins 1.15.5 by SHA-256); >= 1.60.0, < 2.0.0 |
| Hosted agent and infrastructure tests (dev only) | `ai` (`MockLanguageModelV3`), `@ai-sdk/provider`, `@azure/bicep-rpc-client`; Bicep CLI | ^6.0.302 / ^3.0.18 / ^0.6.7 (v1.19; ^0.4.1 before); 0.47.16. `ai` and `@ai-sdk/provider` stay on the major Mastra's model types accept (`ai` 7 and `@ai-sdk/provider` 4 don't type-check against Mastra's model types), and `@ai-sdk/anthropic` likewise (4 breaks `npm run build`): a new major moves with `@mastra/core`, by hand. Dependabot ignores their majors |
| Azure profile images | `node:22-bookworm-slim`, `nginxinc/nginx-unprivileged:1.29-alpine` | pinned by digest (the Dockerfiles in `docker/`, `infra/main.bicep`) |
| Portal web app (v1.10, `web/portal/`; dev-only packages, bundled by `npm run build:web` into static files, so none is a runtime dependency of any image) | react, react-dom; `@auth0/auth0-spa-js` (v1.12, replacing `@azure/msal-browser`: sign-in in a popup, authorization code with PKCE, no secret, rotating refresh tokens kept in session storage; signing out ends the tenant's session through its logout address and returns to the portal's origin); vite (the build, with its own JSX transform and no plugin) | ^19.3.1; 2.30.0 (exact); 8.x |
| Portal web tests (dev only) | jsdom, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/dom`, axe-core | ^31.0 / ^16.3.3 / ^14.6.10 / ^10.4.2 / ^4.14 |
| Card vault (v1.10, the portal only, `CARD_VAULT=stripe`) | Stripe's REST API in test mode, called with `fetch` (no SDK): SetupIntents, PaymentMethods and Customers, six calls. Stripe.js is loaded by the browser from Stripe only when a person adds a card | API version `2026-10-28.endive`, pinned in `src/portal/card-vault.ts` |
| Requester and portal tokens (one verifier, `src/shared/identity-token.ts`, for the hosted agent, the portal and, since v1.17, L2: a person's or a machine caller's access token from the sign-in tenant); v1.17: a machine caller's signed assertion (`src/machine-caller/token.ts`) | jose | ^6.2.12 |
| Per-address request limit in front of token verification (v1.10: the hosted agent and the portal only, `src/shared/address-limit.ts`; in-memory counters) | express-rate-limit | 8.7.4 (exact; v1.19, 8.7.1 before) |

Resolved versions (v1.1, `package-lock.json`): typescript 7.0.2, tsx 4.23.15, vitest 5.0.5, viem 2.57.7, express 5.3.0 (v1.18: body-parser 2.4.0), `@x402/*` 2.28.0 (v1.18: 2.31.0), `@anthropic-ai/sdk` 0.135.0, dotenv 18.0.8, ganache 7.9.2, solc 0.8.24, `@types/node` 22.x; v1.4 adds yaml 2.9.1 and swagger-ui-dist 5.33.1. `scarfSettings.enabled: false` in `package.json` turns off the install analytics of swagger-ui-dist's `@scarf/scarf` dependency. `engines.node` is `>=22`; development also runs on Node 26. npm ≥ 11 skips dependency install scripts by default. Ganache falls back to its JavaScript implementations, which is harmless. v1.5 adds `@mastra/core` 1.75.0, `@ai-sdk/anthropic` 3.0.128, zod 4.6.5, jose 6.2.12 and `@azure/identity` 4.13.3 (runtime), and `ai` 6.0.302, `@ai-sdk/provider` 3.0.18 and `@azure/bicep-rpc-client` 0.4.1 (dev). In library use Mastra sends no telemetry; the image also sets `MASTRA_TELEMETRY_DISABLED=1`.

SDK entry points in use:

| Import | Used in |
|---|---|
| `x402Client` from `@x402/core/client` | L2 signer |
| `x402HTTPClient`, `decodePaymentRequiredHeader`, `decodePaymentResponseHeader`, `encodePaymentRequiredHeader` from `@x402/core/http` | L2, L1, L3, tests |
| `ExactEvmScheme` from `@x402/evm/exact/client` | L2 signer |
| `ExactEvmScheme` from `@x402/evm/exact/server` | seller |
| `ExactEvmScheme` from `@x402/evm/exact/facilitator`, `toFacilitatorEvmSigner` from `@x402/evm` | facilitator |
| `x402Facilitator` from `@x402/core/facilitator` | facilitator |
| `paymentMiddleware`, `x402ResourceServer` from `@x402/express`; `HTTPFacilitatorClient` from `@x402/core/server` | seller |
| `generateJwt` from `@coinbase/cdp-sdk/auth` (CDP facilitator JWTs; the `./x402` barrel is not used because it loads the optional `@x402/svm` peer) | seller (`src/counterparty/cdp-facilitator.ts` only) |
| Types from `@x402/core/types` | contracts |

---

## 6. Repository layout

```
.github/workflows/               one pipeline per unit, by hand or on its own tag (T-E2E-AZ, v1.5):
  deploy-infra.yml               the platform (infra/main.bicep with unit platform)
  deploy-l1.yml  deploy-l2.yml  deploy-l3.yml  deploy-operator.yml  deploy-portal.yml (v1.10)  deploy-seller.yml
                                 one unit each: its image, its apps, the checks through every unit, last-good
  deploy.yml                     the steps all seven call with their unit (reusable): OIDC, what-if, gates, rollback
  checks.yml                     the pull request check (v1.20, T-CI-01): deploy.yml's step 1 and demo:local on every
                                 pull request to main and push to main, Node 22 and 26; no secret, no environment
Dockerfile                       the seller's image, x402-seller (v1.5)
docker/                          one image per unit: l1-agent.Dockerfile, l2-control.Dockerfile, l3-verifier.Dockerfile,
                                 operator.Dockerfile, portal.Dockerfile (v1.10: the portal and the built web app);
                                 each holds only its unit's code and packages (T-IMG-01, v1.5)
.dockerignore                    no env file, key or local state in any build context (v1.5)
tsconfig.build.json              emits dist/ for src/ and the operator commands (v1.5)
config/mandate.json              spending mandate (CFG-3): the platform account's
config/platform.json             platform limits and the seller list for user accounts (CFG-4, v1.10)
contracts/MockUSDC.sol           local-only EIP-3009 token (CP-4)
docs/l2-control.openapi.yaml     OpenAPI 3.1 copy of the L2 HTTP API (L2-5); kept in sync by T-API-01..03; L2 serves it with API_DOCS=1
docs/l1-hosted.openapi.yaml      OpenAPI 3.1 copy of the hosted agent's HTTP API (L1-6, v1.6); kept in sync by T-API-05..07;
                                 the agent serves it with API_DOCS=1
docs/seller.openapi.yaml         OpenAPI 3.1 copy of the seller's HTTP API (CP-1, v1.6); kept in sync by T-API-09..10;
                                 the seller serves it with API_DOCS=1
docs/portal.openapi.yaml         OpenAPI 3.1 copy of the portal's HTTP API (L2-8, v1.10); kept in sync by T-API-12..14;
                                 the portal serves it with API_DOCS=1
env/*.env.example                one env template per process (CFG-2)
infra/                           Azure profile (§3.1, v1.5; T-IAC-01): pre-deploy.bicep (resource group, the deploy app,
                                 operators' group, deploy app's roles), main.bicep (everything in the resource group),
                                 modules/*.bicep, <template>.<env>.bicepparam (every value), bicepconfig.json (Graph
                                 extension), proxy/nginx-l{2,3}.conf (loopback sidecars), and its only two scripts:
                                 github-setup.sh (the GitHub environment), cleanup.sh (deletes all of an environment)
.vscode/launch.json, tasks.json   debug or run every process in local mode through scripts/vscode-local.ts (T-DEV-01)
scripts/
  local-chain-lib.ts             start ganache, compile + deploy MockUSDC, mint 10 USDC to payer, localDevKeys()
  facilitator.ts                 facilitator entry point: loads env, derives its account, starts the factory
  local-chain.ts                 CLI wrapper
  demo-lib.ts                    shared demo helpers: env reading, child envs, process groups, readiness, summary
  demo-local.ts                  6-process orchestrated demo
  demo-base-sepolia.ts           opt-in live run through the CDP facilitator (T-E2E-06)
  approve.ts                     HITL operator CLI
  reject.ts                      operator reject CLI (L2-4.3)
  escalations.ts                 operator list and watch CLI (L2-4.3)
  ledger-verify.ts               operator chain check, exit 0 only when ok (v1.5)
  payer-balance.ts               read-only payer USDC balance, the deploy preflight (v1.5)
  secret-scan-lib.ts, scan-logs.ts   credential-shape scan of logs (SEC-16, v1.5)
  audit-shipped.ts               npm audit over the packages the images install (v1.18, T-IMG-02; v1.22.1: expiring exceptions)
  dev-issuer-lib.ts, dev-token.ts    local dev issuer and tokens for the hosted service and, with --portal, the portal
                                 (NETWORK=local only, v1.5; v1.17: one issuer signs both kinds in the sign-in tenant's shape,
                                 a person's and, with --service, a machine caller's)
  fund-user.ts                   local only: mint test USDC to a user's account address (v1.10)
  wallet-mnemonic.ts             prints one new 24-word mnemonic; reads no env file and derives no account (v1.10)
  stack-local.ts                 the local stack without an agent, for the hosted service (v1.5); its processes, ports and
                                 readiness probes are demo-lib's localStack(), shared with the VS Code runner;
                                 --users turns user accounts on in L2 with the local dev mnemonic (v1.10);
                                 --sign-in configures L2's sign-in with the dev issuer, as --users also does (v1.17)
  vscode-local.ts                the VS Code runner: `chain` (start or reuse), `stack` (reuse, wait for or start each stack
                                 process; `--users` with user accounts on in L2, v1.10), `run <role>`, always NETWORK=local
  image-closure.ts               each image's files and packages from the import graph; fails the build on another
                                 layer's file (T-IMG-01, v1.5)
  solc.d.ts                      type shim
src/
  shared/contracts.ts            ALL cross-layer types and ports (§7)
  shared/config.ts               network profiles, ports, bind hosts, URLs, tokens, loadEnv, formatAtomic, parseUsdc (v1.10)
  shared/user-id.ts              userIdFor(issuer, subject) and USER_ID_RE: the one way a sign-in becomes a userId (v1.10; v2 input since v1.12)
  shared/identity-token.ts       access token verification for the hosted agent, L2 and the portal: verifyCaller (a person's or
                                 a machine caller's, from the sign-in tenant; v1.17), verifyPersonToken (the portal), and the
                                 local dev issuer's (v1.12; replaces entra-token.ts)
  shared/address-limit.ts        requests per client address, before a token is verified, for the same two services (v1.10); L2's ledger check (v1.15) and caller check (v1.17) use it too
  shared/auth.ts                 requireRole(role): per-caller bearer check, constant-time compare
  shared/api-docs.ts             Swagger UI routes over one OpenAPI document, for L2, the hosted agent and the seller (SEC-13; v1.6);
                                 v1.17: an optional sign-in at the tenant, passed by the hosted agent only (SEC-34)
  layer1-intent/
    orchestrator.ts              402 transport loop (L1-1)
    ports-http.ts                HTTP adapters for L2/L3 ports (L1-2); v1.17: forCaller and the X-Caller-Authorization header
    agent.ts                     Claude tool-use loop (L1-3)
    scripted.ts                  deterministic plan, seller alias and checkBaseline (L1-4)
    hosted/                      hosted agent service parts (L1-6, v1.5): server.ts (createHostedApp only), agent.ts,
                                 model.ts, config.ts, requester-auth.ts, session-ref.ts, run-limits.ts, run-log.ts,
                                 api-docs.ts (its OpenAPI document for src/shared/api-docs.ts, only with API_DOCS=1; v1.6),
                                 sse.ts (v1.17: wantsStream, the event writer, keep-alive)
  layer2-control/
    mandate.ts                   mandate type + loader (L2-1)
    policy.ts                    pure rule engine (L2-2)
    signer.ts                    sole key holder (L2-3); since v1.10 also the keyring: one account per user from the mnemonic
    ledger.ts                    hash-chained ledger (L2-4)
    ledger-lock.ts               one ledger writer: exclusive lock, standby, heartbeat (L2-6, v1.5)
    escalations.ts               escalation lifecycle derivations and the sweep (L2-4.3)
    approval-routes.ts           operator approve and reject (L2-5)
    json-body.ts                 every route's JSON body parser and the fixed answer to an unreadable body (L2-5; v1.18)
    escalation-routes.ts         operator escalation reads (L2-5)
    ciba-client.ts               the only reader of the Auth0 client credential: CIBA config, client, sealed handle (L2-7, A9; v1.8)
    approval-evidence.ts         verification of the approver's access token, one check per step (L2-7; v1.8)
    payment-details.ts           the authorization_details object and binding message shown to the approver (L2-7; v1.8)
    backchannel.ts               approval requests: start, poll, verify, record, resume, the bounded wait (L2-7; v1.8)
    platform.ts                  platform limits and the seller list: load, validate, digest (CFG-4; v1.10)
    users.ts                     user accounts as pure functions over ledger entries: state, policy validation, loosening,
                                 policy selection, the effective mandate, views (L2-8; v1.10)
    user-routes.ts               the portal routes of L2-5, each write inside the serialized section (L2-8; v1.10)
    admin-routes.ts              the administration routes of L2-5 for the portal's second role: the escalation reads, the
                                 two decisions with the own-payment and identity checks, the budget view, the ledger check
                                 (L2-8; v1.15)
    api-docs.ts                  L2's OpenAPI document for src/shared/api-docs.ts, only with API_DOCS=1 (L2-5, SEC-13)
    caller.ts                    the caller's token on authorize and budget: callerAuth, its settings from env, the forwarded
                                 identity (L2-5; v1.17)
    service.ts                   HTTP API (L2-5)
  layer3-settlement/
    verifier.ts                  chain verification + finality (L3-1)
    service.ts                   HTTP API + reconciliation + recheck (L3-2)
  counterparty/
    seller.ts                    x402 seller API: wiring, payment middleware, entry point (CP-1)
    seller-api.ts                the seller's endpoints: SellerApi, one decorated method each; CATALOG (CP-1; v1.7)
    endpoints.ts                 @Get, declaredEndpoints() and its checks, mountEndpoints() (CP-1; v1.7)
    monetization.ts              the monetization model: tiers, @Free/@PayPerUse/@Premium/@Enterprise, usdc() (CP-1; v1.7)
    api-docs.ts                  the seller's OpenAPI document for src/shared/api-docs.ts, only with API_DOCS=1 (CP-1; v1.6)
    facilitator-client.ts        facilitator client selection and failure categories (CP-1, CP-3); no credentials
    cdp-facilitator.ts           CDP JWT-authenticated facilitator client; the only reader of the CDP credential (A8)
    facilitator.ts               local facilitator factory, takes a ready account (CP-2)
  portal/                        the portal's backend (L2-8, v1.10): server.ts (createPortalApp, headers, limits), access.ts
                                 (the person's token), routes.ts (/api), control-client.ts (L2's portal routes),
                                 profile-store.ts (one file per user), balance.ts (read-only balance), cards.ts and
                                 card-vault.ts (the only reader of the card vault key, A10), config.ts, log.ts, api-docs.ts;
                                 v1.15: admin-routes.ts (/api/admin) and admin-client.ts (L2's administration routes, the
                                 only user of the second role token, A13), control-errors.ts (shared by both clients)
  machine-caller/token.ts        a machine caller's client-credentials token, asked for with a signed assertion; the only
                                 reader of its key (A15; v1.17). Outside the layers: two entry points use it, no layer does
  portal-main.ts                 composition root for the portal: loadEnv → refusal when a payment key is visible → listen
  main.ts                        composition root for the agent process; v1.17: forwards a machine caller's token when configured
  hosted-main.ts                 composition root for the hosted agent service: loadEnv → INV-3 refusal → listen (L1-6)
  smoke-main.ts                  the smoke client: a machine caller's token, one run at the agent, the checks, exit 0 or 1
                                 (L1-5; v1.17)
  refusal.ts                     the INV-3 refusal text both L1 roots print (outside the layer: rule A5)
web/portal/                      the portal's web app (L2-8, v1.10): React, built by `npm run build:web` to dist/portal-web
  index.html                     the app (v1.12: the sign-in pop-up needs no page of the portal's own)
  src/                           app.tsx (shell, routes), api.ts, routes.ts, money.ts, summary.ts, messages.ts, flags.ts,
                                 auth/ (Auth0, dev, step-up), components/, screens/, styles.css
  test/                          T-WEB-01..08, in jsdom with a fake API and sign-in
test/
  policy.test.ts  ledger.test.ts  architecture.test.ts  agent.test.ts  e2e.local.test.ts
  counterparty.test.ts  verifier.test.ts  settlement-service.test.ts  auth.test.ts  demo.local.test.ts
  cdp-config.test.ts  cdp-auth.test.ts  cdp-isolation.test.ts  cdp-failures.test.ts  escalations.test.ts
  openapi.test.ts  openapi-hosted.test.ts  openapi-seller.test.ts (v1.6)  seller-monetization.test.ts (v1.7)
  hosted-agent.test.ts  hosted-access.test.ts  hosted-sessions.test.ts  hosted-run.test.ts   (L1-6, v1.5)
  ledger-lock.test.ts  infra.test.ts  images.test.ts  deploy-workflow.test.ts
  github-setup.test.ts  cleanup.test.ts   (L2-6, Azure, v1.5)
  users.test.ts  user-id.test.ts  portal.test.ts  card-vault.test.ts  openapi-portal.test.ts   (L2-8, v1.10)
  admin.test.ts  portal-admin.test.ts   (the administration area, L2-8, v1.15)
  caller-token.test.ts  hosted-stream.test.ts  machine-caller.test.ts  smoke-client.test.ts
                                 (the caller's token at L2, the stream, machine callers, the smoke client; v1.17)
  body-limits.test.ts  dev-keys.test.ts   (L2's request bodies, published development keys; v1.18)
  helpers/caller-tokens.ts       in-process issuer for tests: a person's and a machine caller's token, and the settings and
                                 keys L1 and L2 take as deps (v1.17)
  helpers/users.ts               in-process L2 with user accounts on, a movable clock, two users (v1.10)
  helpers/portal.ts              in-process portal against that L2, the dev issuer and the stand-in card vault (v1.10)
  helpers/card-vault-stub.ts     stand-in card vault: the six calls, test and live answers, failures (v1.10)
  helpers/hosted.ts              in-process hosted service: dev issuer, mock model, fake or harness ports
  helpers/openapi.ts             OpenAPI document helpers for T-API: routes, a schema subset checker, a client (v1.6)
  fixtures/lock-holder.ts        child process holding the ledger lock until SIGTERM (T-LED-05)
  fixtures/fake-gh.mjs           fake `gh` recording each call and its stdin, for infra/github-setup.sh and cleanup.sh (T-E2E-AZ)
  fixtures/fake-azure.mjs        fake `az` with a tenant in a file (groups, vaults, apps, role assignments), and the real Bicep CLI for `bicep build-params`, for infra/cleanup.sh and github-setup.sh (T-E2E-AZ)
  helpers/bicep.ts               BICEP_PATH and compiled parameter files (names) for the tests (T-IAC-01, T-E2E-AZ)
  helpers/harness.ts             in-process multi-service harness shared by e2e suites
  helpers/fake-public-client.ts  deterministic read-only chain client for L3 unit tests
  helpers/cdp-stub.ts            offline CDP facilitator stub: verifies JWTs, delegates to the local facilitator
  helpers/ciba-stub.ts           stand-in Auth0 for CIBA: client authentication, RS256 tokens from its JWKS, scripted answers, forgeries (v1.8)
  helpers/backchannel-l2.ts      in-process L2 with backchannel approval against the stand-in Auth0 (v1.8)
  fixtures/arch/                 one violating fixture per architecture rule A1–A12
auth0/                           the Auth0 tenant for backchannel approval as Terraform (v1.8), applied by provision-auth0.yml (v1.9)
  versions.tf, variables.tf      provider pin; environment, tenant, API identifier, approver, credential kind
  main.tf, outputs.tf            API, L2's CIBA client, grant, credential, Guardian push; the ciba object and CIBA_* lines;
                                 v1.17: the agent's public client, the permission agent:run, the role x402-agent and one
                                 client per machine caller; the outputs bicepparam_agent, l1_env and l2_env
```

Runtime artifacts go in `.local/` (gitignored): `deployment.json`, `ledger-<network>.jsonl` and, since v1.10, the portal's `portal/profiles/<userId>.json`.

---

## 7. Boundary contracts (`src/shared/contracts.ts`)

These types are the **only** objects that cross layer boundaries. Changing them is a contract change: update all producers, consumers and tests in one change.

```ts
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";

// L1 -> L2
export interface PaymentIntent {
  intentId: string;            // "int_<uuid>"
  sessionId: string;           // agent session
  resourceUrl: string;         // URL L1 requested (http/https only)
  paymentRequired: PaymentRequired; // verbatim decoded challenge
  purpose: string;             // LLM text, audit only (INV-5)
  createdAt: string;           // ISO
  operatorApprovalOnly?: boolean; // v1.8 (L2-7): true removes the backchannel approval path; never adds one
  userId?: string;             // v1.10 (L2-8): ^usr_[0-9a-f]{32}$, the person the payment is for. v1.17: set by L2 from the
                               // caller's token, on the intent it records; never accepted from a request (L2-5).
                               // Absent: the platform account. (v1.16's approvalSubject is removed in v1.17.)
}

// L2 -> L1
export interface PolicyViolation { rule: string; detail: string }
export type AuthorizationDecision =
  | { status: "AUTHORIZED"; authorizationId: string; intentId: string;
      requirement: PaymentRequirements; paymentHeaders: Record<string, string>;
      payer: string; validBefore: number; remainingSessionBudgetAtomic: string }
  | { status: "DENIED" | "ESCALATE"; authorizationId: string; intentId: string;
      violations: PolicyViolation[] };

// L1 -> L3
export interface SettlementClaim {
  authorizationId: string; requirement: PaymentRequirements; payer: string;
  validBefore: number; httpStatus: number; paymentResponseHeader: string | null;
}

// L3 -> L2 and L1
export type SettlementStatus = "CONFIRMED" | "PENDING" | "MISMATCH" | "NOT_SETTLED";
export type FinalityClass = "included" | "confirmed-depth" | "l1-safe";
export interface SettlementReport {
  authorizationId: string; status: SettlementStatus; transaction?: string; network: string;
  blockNumber?: string; confirmations?: number; finalityClass: FinalityClass;
  detail: string; observedAt: string;
  verified: { asset: string; payer: string; payTo: string; amount: string };
}

// Ports
export interface AuthorizationGatePort {
  authorize(intent: PaymentIntent): Promise<AuthorizationDecision>;
  budget(sessionId: string): Promise<BudgetStatus>; // v1.17: no userId; a person's token gives that user's view (L2-5)
}
export interface SettlementVerifierPort { verify(claim: SettlementClaim): Promise<SettlementReport> }
export interface ReconciliationPort { reconcile(report: SettlementReport): Promise<void> }
export interface BudgetStatus {
  sessionId: string; asset: string; decimals: number; sessionCapAtomic: string;
  spentOrReservedAtomic: string; remainingAtomic: string; perPaymentCapAtomic: string;
  scope?: "session" | "user_daily"; // v1.10: what the figures count; absent means "session"
}

// v1.10 (L2-8): portal <-> L2. No field holds text a person typed.
export interface PolicyValues {
  sellers: string[]; autoApproveMaxAtomic: string; hardCapPerPaymentAtomic: string;
  sessionBudgetAtomic: string; dailyBudgetAtomic: string; maxAuthorizationsPerMinute: number;
  expiresAt: string; paymentMethod: "crypto_account";
}
export interface PolicyIssue { field: string; code: string; host?: string; policyId?: string; limitAtomic?: string; limit?: number }
export interface PolicyVersion { seq: number; ts: string; kind: "created" | "changed" | "paused" | "resumed" | "removed";
  version: number; values?: PolicyValues; cause?: "user" | "account_enabled" }
export interface PolicyView { policyId: string; version: number; values: PolicyValues;
  state: "active" | "paused" | "removed"; displayState: "active" | "paused" | "removed" | "expired" | "disabled";
  expired: boolean; limitedByPlatform: string[]; unlistedSellers: string[]; updatedAt: string; history?: PolicyVersion[] }
export interface UserView { userId: string; registered: boolean; enabled: boolean;
  onboarding: { profile: boolean; wallet: boolean; policy: boolean };
  wallet?: { address: string; network: string; asset: string; decimals: number; committedAtomic: string;
             spent24hAtomic: string; dailyCeilingAtomic: string; dailyRemainingAtomic: string };
  cards: string[]; policies: PolicyView[] }
export interface PlatformView { platformId: string; digest: string; limits: PlatformLimits;
  sellers: { host: string; name: string; payees: string[] }[]; network: string; asset: string; decimals: number;
  phoneApproval: boolean }     // v1.16: true when backchannel approval is on in this L2

// v1.16 (L2-7, specs/015): who an escalation asks, and what a person may see of their own pending payments
export type ApprovalRequestMark = "requested" | "capped" | "operator_only" | "reevaluation"
  | "no_owner" | "no_identity" | "identity_mismatch";            // the last three (v1.16) ask nobody
export type ApprovalRequestState = ApprovalRequestMark | "failed" | "verification_failed" | "lapsed" | "answered"
  | "abandoned" | "unanswered";                                  // unanswered (v1.16): expired with its request never ended
export const WAITING_REASONS = ["limit_reached", "sign_in_not_supported", "phone_unreachable", "service_unavailable",
  "request_expired", "answer_not_accepted"] as const;
export interface WaitingPayment { authorizationId: string; referenceCode: string; resourceKey: string; payTo: string;
  amount: string; createdAt: string; expiresAt: string; waitingFor: "phone" | "operator"; reason?: WaitingReason }

// v1.15 (L2-8, specs/014): the escalation views, here because the portal reads them too, and the administration shapes
export type DecisionChannel = "operator" | "backchannel" | "portal";
export const REJECTION_REASON_CODES = ["not_expected", "amount_too_high", "wrong_seller", "duplicate", "other"] as const;
export const ESCALATION_ID_RE = /^auth_[0-9a-f-]{36}$/;
export interface EscalationView { authorizationId: string; sessionId: string; resourceKey: string; payTo: string;
  amount: string; createdAt: string; expiresAt: string; referenceCode: string; approvalRequest?: ApprovalRequestState;
  userId?: string }
export interface BudgetLine { capAtomic: string; spentAtomic: string; remainingAtomic: string }
export interface EscalationBudget { asset: string; decimals: number; applies: boolean;
  notApplying?: "user_not_onboarded" | "user_disabled" | "no_active_policy"; autoApproveMaxAtomic: string;
  hardCapPerPaymentAtomic: string; run: BudgetLine; day: BudgetLine; userDay?: BudgetLine; fits: boolean }
export interface EscalationDecision { at: string; channel: DecisionChannel; decidedBy: string; approvalId?: string;
  approvalExpiresAt?: string; rejectionId?: string; reasonCode?: RejectionReasonCode; reason?: string }
export interface EscalationDetail extends EscalationView { state: "pending" | "approved" | "denied" | "expired";
  decision?: EscalationDecision; budget: EscalationBudget }
export interface EventPage { events: EscalationEvent[]; first: number; last: number; cursor: number; more: boolean }
export type DecisionOutcome =
  | { ok: true; state: "approved"; approvalId: string; expiresAt: string; already: boolean; channel: DecisionChannel; decidedBy: string }
  | { ok: true; state: "denied"; rejectionId: string; rejectedAt: string; already: boolean; channel: DecisionChannel; decidedBy: string };
export interface LedgerCheck { entries: number; ok: boolean; brokenAt?: number }
```

`EscalationEvent` (L2-5) also lives there since v1.15, with one more optional field, `reasonCode`.

All amounts are **decimal strings of atomic units**. Use `BigInt` for arithmetic, never `Number`.

`src/shared/user-id.ts` holds `userIdFor(issuer, subject)` = `usr_` + the first 32 hex characters of SHA-256 over `x402-user-v2`, the issuer's host and the token's `sub`, separated by newlines, and `USER_ID_RE`. It is pure, so L2 (v1.17: for a run, from the caller's token it verified) and the portal compute the same identifier without sharing a secret; an empty value, or one containing a line break, is refused. (v1.10 hashed `x402-user-v1|<tid>|<oid>`; an Auth0 `sub` contains `|`, so the format changed in v1.12 and every earlier identifier names a user nobody signs in as.) `parseUsdc(text, decimals)` in `src/shared/config.ts` turns USDC text into an atomic string, or says why not (`not_a_number`, `too_many_decimals`, `negative`); it never rounds.

---


v1.19 (§7): `PaymentIntent.purpose` is at most 500 characters (`PURPOSE_MAX_CHARS`) and `paymentRequired.accepts` at most 20 options with the field types of `PaymentRequirements` (`ACCEPTS_MAX`). An AUTHORIZED `AuthorizationDecision` may carry `nonce` (the EIP-3009 authorization's, `0x` + 64 hex), which L1 copies to `SettlementClaim.nonce`. `SettlementReport.verified` may carry that `nonce`, and a PENDING report `settlesBy` (ISO time), the time after which L3 reads the nonce on-chain (L3-1).

## 8. Component specifications

### 8.1 Layer 1 — Intent & Orchestration

**L1-1 Orchestrator** (`PaidResourceOrchestrator.fetchPaid(url, purpose) → PaidFetchResult`)

0. v1.19 (SEC-1): a URL that is not http(s), or (when `allowedHosts` is set) whose `host` is not on that list, is `ERROR` and nothing is requested. The hosted agent and the command-line agent set it to the seller's host (`SELLER_URL`); the scripted plan (L1-4) doesn't, and keeps its second host for L2 to refuse.
1. `GET url`, never following a redirect (v1.19: `redirect: "manual"`). On a network error, return `ERROR`. A 3xx is `ERROR` (`the resource redirected; redirects are not followed`) and L2 is not asked: an answer from another host would be judged by R6 and R7 against `url`.
2. If the status is not 402, return `FREE` with the status and body (JSON if parseable, otherwise text truncated to 2000 chars).
3. Decode `PAYMENT-REQUIRED` with `decodePaymentRequiredHeader`. If the header is absent, parse the body as JSON (v1 fallback). If that fails, return `ERROR`.
4. Build a `PaymentIntent` (`intentId = "int_" + uuid`, its own `sessionId`; v1.19: `purpose` cut to 500 characters) and call `gate.authorize`. v1.17: the intent names no user and no approval subject, and `OrchestratorDeps` has neither `userId` nor `approvalSubject`: who a payment is for is decided by L2, from the caller's token that the gate forwards (L1-2).
5. If the decision is not AUTHORIZED, return `DENIED` or `ESCALATED` with `violations` and `authorizationId`. **No retry.**
6. `GET url` again with `decision.paymentHeaders`, never following a redirect (v1.19): the payment header goes to `url` only. The headers are opaque to L1 and must be forwarded unchanged.
7. Build a `SettlementClaim` from the decision plus `PAYMENT-RESPONSE` (v1.19: with the decision's `nonce`), then call `settlement.verify`.
8. If the response is 2xx and the report is CONFIRMED or PENDING (v1.19: a PENDING without `settlesBy`; one with it is no evidence of a settlement), return `PAID`. Otherwise return `PAYMENT_FAILED`, with the body only if the response was 2xx. If `settlement.verify` throws after a 2xx paid retry, return `PAYMENT_FAILED` and keep `payment` and `authorizationId`, because money may have moved. An error from `gate.authorize` returns `ERROR`. v1.17: when L2 refused the caller, the error says so: `the sign-in has expired: sign in again` for 401 `caller_token_expired`, and `the caller was refused by the control layer` for every other caller refusal (L2-5). The call is not retried, and never with another identity.

`PaidFetchResult = { outcome: FREE|PAID|DENIED|ESCALATED|PAYMENT_FAILED|ERROR, url, httpStatus, body, payment?, violations?, authorizationId?, error? }`.

**L1-2 Port adapters** (`ports-http.ts`): `HttpAuthorizationGate` (POST `/v1/authorize`, GET `/v1/budget/:id`; v1.17: never with `?userId=`) and `HttpSettlementVerifier` (POST `/v1/settlements`). Bearer auth. Non-2xx responses throw (v1.17: a `PortHttpError` with the status and the parsed `error` code).

v1.17, the caller's token: `HttpAuthorizationGate.forCaller(token)` returns a gate that adds `X-Caller-Authorization: Bearer <token>` to `authorize` and `budget`, beside `Authorization: Bearer <CONTROL_TOKEN>`; for an empty token it sends no such header. L1 never alters the token and never builds one. The hosted server takes its gate through `forCaller` once per run, with the token it verified, so one object holds the token for the length of the run; `src/main.ts` does the same when a caller's token is configured (L1-5). Nothing else calls `forCaller`, the header's name appears in no other file of L1 (rule A14), and `HttpSettlementVerifier` is never given the token: L3 never sees it.

**L1-3 Claude agent** (`runClaudeAgent`)
- Model: `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`. `max_tokens` 2048. At most 10 turns. The client is injectable (`opts.client`) for tests.
- It exposes **exactly two tools**, and must never get a tool that signs, approves or edits policy:

```json
[{"name":"fetch_resource","input_schema":{"type":"object","properties":{"url":{"type":"string"},"purpose":{"type":"string"}},"required":["url","purpose"]}},
 {"name":"check_budget","input_schema":{"type":"object","properties":{}}}]
```

- Tool descriptions are fixed. `fetch_resource`: "Fetch an HTTP resource. If it costs money, payment is requested from the Control layer, which may authorize, deny or escalate it. You cannot sign or approve payments." `check_budget`: "Return the session budget as reported by the Control layer."
- The tool result for `fetch_resource` is JSON: `{outcome, httpStatus, body, payment:{authorizationId, amountUsd, settlement:{status, tx, finality}}, violations, authorizationId, error}`.
- The system prompt must say:
  - Start at `<seller>/api/catalog`.
  - Prices are in atomic units.
  - Buy only what the goal needs, and prefer cheaper items.
  - Never retry a DENIED payment; explain which rule blocked it.
  - Report the `authorizationId` of an ESCALATED payment.
  - End with a receipt list (resource, USD, settlement status, tx).

**L1-4 Scripted agent**: this fixed plan is the regression baseline (§12).

| # | Request | Price (atomic) | Expected outcome |
|---|---|---|---|
| 1 | `/api/catalog` | free | FREE |
| 2 | `/api/weather?city=Lima` | 1000 | PAID, CONFIRMED |
| 3 | `/api/market-brief` | pay-per-use | 5000 | PAID, CONFIRMED |
| 4 | `/api/premium-report` | premium | 50000 | ESCALATED (`human_approval_required`) |
| 5 | `/api/dataset-export` | enterprise | 500000 | DENIED (`hard_cap_exceeded`, plus budget rules) |
| 6 | same as #2 via host `localhost` | 1000 | DENIED (`host_not_allowed`) |

- **Step 6 alias (v1.5).** With `SELLER_ALIAS_URL` set, step 6 requests `<SELLER_ALIAS_URL>/api/weather?city=Lima` instead of the `localhost` rewrite: a second seller host that L2 doesn't allow, as in the cloud regression. Unset, the plan is unchanged.
- **Operator-only (v1.8).** The scripted root builds its orchestrator with `operatorApprovalOnly: true`, so every scripted intent carries it and step 4's escalation never notifies the approver (L2-7). The hosted agent and the Claude agent never set it.
- **`--check-baseline` (v1.5).** `npm run agent:scripted -- --check-baseline` compares the six outcomes with this table and requires both PAID results `CONFIRMED`. It prints `baseline: ok` or `baseline: mismatch <detail>` and exits 2 on a mismatch.

**L1-5 Composition root** (`src/main.ts`; v1.5 adds `src/hosted-main.ts`, see L1-6)
- Exits with code 1 if `PAYER_PRIVATE_KEY` is set (INV-3).
- `sessionId = SESSION_ID` or `sess_<8 hex>`.
- `--scripted` selects L1-4; otherwise L1-3 runs, with the goal taken from argv or a default.
- Prints the final budget.
- **The caller's token (v1.17).** With `MACHINE_CLIENT_ID` set, the process gets a machine caller's token from the sign-in tenant (`src/machine-caller/token.ts`: a client-credentials request with a signed assertion, the token cached until 60 s before it expires) and wraps its gate with `forCaller` (L1-2). Otherwise, with `NETWORK=local` only, it forwards `CALLER_TOKEN` when set: a ready-made dev machine token. With neither it forwards nothing, as before, which is how `demo:local` runs. An L2 with sign-in configured refuses a call without a caller's token (L2-5), so the Azure regression job runs as the machine caller `checks`.
- **The smoke client (v1.17, `src/smoke-main.ts`).** A third L1 entry point, outside the layer like the other two, and it refuses to start if the payer key is visible (INV-3). It gets a machine caller's token the same way, sends the smoke goal to the hosted agent with `POST /v1/runs` and `Accept: application/json` (to `AGENT_CANDIDATE_URL` when its `/healthz` answers, to `AGENT_URL` otherwise), and exits 0 only when the run completed, both purchases are `PAID` and `CONFIRMED`, nothing escalated and it took 120 s or less; otherwise 1. It prints the duration and the outcome, never the token (T-AGT-13).

**L1-6 Hosted agent service** (v1.5, `specs/011` contracts/hosted-agent-api.md, access-and-sessions.md, model-access.md; v1.17: `specs/016` contracts/hosted-agent-api.md)

- **Code layout.** The parts live in `src/layer1-intent/hosted/`. The entry point, `src/hosted-main.ts`, sits outside the layer (rule A5) and runs in this order: `loadEnv("l1-hosted")` → INV-3 refusal (the shared text in `src/refusal.ts`, also outside the layer because it names the key) → config → ports and model → listen.
- **Logs (outcomes).** A step's `outcome` is the fetch outcome, `ok` for a budget read, or `error` when a tool threw; Mastra's own logger is silenced (`noopLogger`), because a provider error object can carry the request body.
- **Routes.** `POST /v1/runs` runs a goal; v1.17: it answers with one JSON object or, on request, with a stream of server-sent events (see "The stream"). `GET /healthz` and `GET /readyz` report health. Every other path returns 404 after auth, and unauthenticated callers get 401 everywhere except the health routes (and the docs routes, when mounted). No Mastra server, Studio or tool-execute route exists.
- **API docs** (v1.6). `docs/l1-hosted.openapi.yaml` describes these routes in OpenAPI 3.1. When a route, status, header or response field changes, update this section, the contract and the document together; T-API-05..07 fail until they match. With `API_DOCS=1` (CFG-2), `GET /docs`, `GET /docs/:asset` and `GET /openapi.yaml` serve Swagger UI over that document with no token, mounted before auth like the health routes and from the same shared module as L2's (L2-5, SEC-13). They serve files read at startup and never reach the model, a session, L2 or L3. v1.17: an environment's parameter file can turn the page on for its deployed agent (`agent.apiDocs`, off by default, §3.1); no other deployed unit serves a docs page (T-API-08).
  - **Sign-in on the page (v1.17, SEC-34).** With `API_DOCS_CLIENT_ID` set (it must be on `AGENT_CLIENT_IDS`, and `AUTH_ISSUER` must be a tenant, not the dev issuer, which has no authorize address), the served document gains an OAuth2 scheme, `auth0` (authorization code with PKCE), whose addresses are `<AUTH_ISSUER>authorize` and `<AUTH_ISSUER>oauth/token`, and the page is initialized with that client, PKCE and `audience = AUTH_AUDIENCE`. The addresses are written into the served document at mount time, from the service's own settings, as `servers` is; the committed document names placeholder addresses. Two assets are added then, `oauth2-redirect.html` and its script `oauth2-redirect.js`, both from the pinned Swagger UI package, and the page's Content-Security-Policy gains the tenant's origin in `connect-src` only: scripts stay `'self'`. The page holds no secret and does not persist the authorization: a reload forgets the token. Without `API_DOCS_CLIENT_ID` the page offers the bearer scheme only, as before; pasting a token works either way. The docs routes stay token-free and static (T-API-16, T-API-17).
- **Auth (v1.17, one issuer).** The service accepts access tokens from one issuer only, `AUTH_ISSUER`: the sign-in tenant (Auth0), or locally the dev issuer. The token's `iss` is no longer read first to choose a set of checks: there is one set, `verifyCaller` in `src/shared/identity-token.ts`, which L2 runs again on the forwarded token (L2-5). In this order:

  | # | Check | Refusal |
  |---|---|---|
  | 1 | `Authorization: Bearer <token>` present | 401 `{ "error": "unauthorized" }` |
  | 2 | Signature (`<AUTH_ISSUER>.well-known/jwks.json`, RS256; the dev issuer's file, ES256), `iss` exactly `AUTH_ISSUER`, `aud` containing `AUTH_AUDIENCE` (the API's identifier), `exp`/`nbf` with 60 s tolerance, a usable `sub` | 401 |
  | 3 | A machine token (`gty` containing `client-credentials`, or a `sub` ending in `@clients`): `sub` is `<client>@clients` for the client the token names (`azp`, or `client_id`), and it carries `agent:run`, in `permissions` or in the space-separated `scope` | 401 when `sub` and the client disagree; 403 `{ "error": "forbidden" }` without the permission |
  | 4 | A person's token: `agent:run` in `permissions` (a person's `scope` is what the client asked for and does not count), and the client (`azp`, or `client_id`) on `AGENT_CLIENT_IDS` | 403 |

  A token from the organization's directory fails check 2 (another issuer), whatever roles it carries. The body is not read, and no model, L2 or L3 call is made, before all four pass; the per-address limit still runs before them. `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` are required: without them nobody could call the service, and it refuses to start. It also refuses to start when `AUTH_TENANT_ID` or `SERVICE_AUDIENCE` is set (the directory's settings, removed), naming the setting and never its value (T-AGT-14).
  - **People.** A person holds the role `x402-agent`, which carries the permission `agent:run` and which a tenant administrator assigns by hand, and signs in through the agent's client, the one on `AGENT_CLIENT_IDS` (`auth0/`, T-IAC-02). A role taken away takes effect when the person's token expires, an hour at most.
  - **Machine callers.** A machine caller gets its token with its own client (client credentials); the tenant puts `agent:run` in it only through that client's grant, so machine clients are not listed again at the agent or at L2. It names no user.
  - With `NETWORK=local` only, `AUTH_JWKS_FILE` selects the dev issuer, which signs both kinds in the tenant's shape (`npm run dev-token`, and `--service`); `AUTH_ISSUER` must then be `urn:x402:dev-issuer`. The dev issuer is refused outside local mode.
- **The requester (v1.17).** `kind` is `user` for a person and `service` for a machine caller; `authority` is the issuer for both; `subject` is the token's `sub`. The key for limits and logs is `<issuer host>:<sub>` for both.
- **The caller's token after verification (v1.17).** It is kept for the run, in memory, and sent to L2 only: the request handler hands it to `gate.forCaller(token)` (L1-2) and to nothing else, and it ends with the request. The `Authorization` header is no longer deleted. The token is never logged, never part of a step, an event or an answer, and never passed to the model, a tool input, L3 or the seller (T-AGT-10).
- **Whose token (SEC-20).** A token the portal's web app obtained comes from a client that is not on `AGENT_CLIENT_IDS`, so it never starts a run (403, before any model or L2 call), with or without the role. The service refuses to start when `PORTAL_CLIENT_ID` is on that list. v1.17: L2 applies the same client rule to the token L1 forwards (L2-5), and the two roles are separate: `portal:admin` gives nothing at the agent, and `agent:run` gives nothing at the portal.
- **The user (v1.17, L2-8).** The service names no user. No `PaymentIntent` carries `userId` or `approvalSubject`, and `check_budget` passes none: L2 takes the user from the caller's token it verified, `userIdFor(AUTH_ISSUER, sub)` for a person and none for a machine caller, whose runs the platform account pays for under the platform mandate (L2-5). No goal text, model output or tool input can change who a payment is for, and neither tool has an input for a user, a policy, a wallet or a token. A person with the role and no account at the portal starts a run in which the user gate denies every payment (R16), so nothing is paid and the answer says the account is missing; a run creates no account.
- **Limits.** v1.10: at most 300 requests a minute per client address on every route but health and the docs, counted before the token is verified (429 `{ "error": "too many requests" }` with `Retry-After`), so a caller without a valid token is bounded too. With `TRUSTED_PROXY_HOPS` set (1 in Azure) the address is the client's, from `X-Forwarded-For`; unset, that header is ignored. Goal 1–4,000 characters; body ≤ 16 KB (413); 2 concurrent runs and 20 starts per sliding hour per requester (429 with `Retry-After`); a 200 s deadline per run, under the ingress's 240 s idle timeout; client disconnect aborts. An abort stops the run before its next step, and a paid fetch in progress completes. v1.17: the limits are counted per caller for both kinds of caller, and all of them apply to a stream as they do to a JSON answer.
- **Agent.** A Mastra `Agent` used as a library, with exactly `fetch_resource` and `check_budget`. The descriptions are L1-3's, and the JSON schema adds `additionalProperties: false`. It has no memory, workspace, sub-agents, workflows or processors. Limits: `maxSteps` 10, `maxOutputTokens` 2048. Tool results use the L1-3 format. v1.17: one model path serves both answer forms, `agent.stream` with `eagerToolExecution: false`, so a tool runs exactly when it did before and the two forms can't differ; streaming adds no memory, workspace, sub-agent or tool.
- **The stream (v1.17).** `POST /v1/runs` answers with server-sent events when the request's `Accept` header contains `text/event-stream`, and with the JSON object otherwise (any other value, or none). The body is the same (`goal`, optional `sessionRef`). A refusal (401, 403, 429, 400, 413, 404 for an unknown session) is the same JSON answer with the same status in both forms: a stream starts only once the run does. The response is `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. Events, each `event: <name>` and one `data:` line of JSON, in this order:

  | Event | When | `data` |
  |---|---|---|
  | `run` | once, first, as soon as the run is accepted | `{ "runId": "run_…", "startedAt": "<ISO time>" }` |
  | `text` | whenever the model writes text, in the order written | `{ "delta": "<text>" }` |
  | `step` | once per finished tool call, in completion order | the step exactly as `steps[]` lists it: `index`, `tool`, `url`, `purpose`, `result` |
  | `result` | once, last | the JSON answer's object: `runId`, `sessionRef`, `status`, `stopReason`, `error`, `finalText`, `steps`, `startedAt`, `finishedAt` |

  `text` events carry everything the model writes, including what it writes before calling a tool; `result.finalText` is the final answer, as in the JSON form, and is the value to keep. A line `: keep-alive` is sent whenever 15 seconds pass with nothing else sent. After `result` the response ends, and every way a run can end is a `result`: `completed`, `stopped` (with `deadline`, `step_limit` or `client_disconnected`) or `failed` (with `error`). The stream carries nothing the JSON answer does not: no token, no model reasoning, and no tool input other than a step's `url` and `purpose`. A caller that disconnects receives nothing more, and the run log line is written as for a JSON answer. There is no resumption: a caller that loses the connection starts a new run, in the same session if it kept an earlier reference. The run's identifier arrives within 2 s of the request being accepted, and text within 1 s of the model producing it (T-AGT-11, T-AGT-12).
- **Model.** `MODEL_PROVIDER=foundry` (Microsoft Foundry, keyless Entra token for scope `https://ai.azure.com/.default`) or `anthropic` (API key). The model id must be on the allow-list (`claude-sonnet-5-5` by default), and the Foundry deployment name must equal it; otherwise the AI SDK provider would add a third `json` tool.
- **Sessions.** `sessionRef = sr1.<sessionId>.<HMAC-SHA256(SESSION_REF_SECRET, m)>`, where `m` is `sr1`, the requester's kind (`user` or `service`), who vouches for it (v1.17: the issuer, for both kinds), its subject (`sub`) and the session ID, separated by newlines. The format and its version are unchanged in v1.17, so a person's reference still verifies; a machine caller's reference issued before v1.17 was bound to a directory tenant and no longer does, and that caller starts a new session. Issued per new run and verified per requester. Another requester's reference → 404; a raw `sess_…` → 400.
- **Logs.** One JSON line per step and one per run, carrying `runId`, the requester (`<issuer host>:<sub>`; v1.17: for a machine caller too), `sessionId`, tool, outcome, `intentId`, `authorizationId` and duration. Never headers, tokens, the MAC, the goal, `purpose` or response bodies.

### 8.2 Layer 2 — Control & Authorization

**L2-1 Mandate** (`SpendingMandate`): see CFG-3 for the schema and defaults.
- `allowedNetworks` and `allowedAssets` are always derived from the active network profile.
- `ALLOWED_PAYEES` and `ALLOWED_HOSTS` (comma-separated) override the JSON values when set.
- Payees are compared lower-cased.
- If the mandate breaks `autoApproveMax < hardCap ≤ sessionBudget` (CFG-3), loading fails and L2 refuses to start.
- **User payments (v1.10, L2-8).** This mandate is the platform account's and stays as it is. A payment for a user (v1.17: one whose caller's token is a person's, L2-5) is decided against an *effective mandate*, built for that decision from the user's one active policy for the requested seller and the platform limits (CFG-4):

  | Mandate field | Value |
  |---|---|
  | `mandateId` | `<policyId>@<version>` |
  | `expiresAt`, `autoApproveMaxAtomic` | the policy's |
  | `allowedHosts` | the requested seller's host only; empty when no active policy lists it, so R6 denies with `host_not_allowed` |
  | `allowedPayees` | that seller's `payees` from the seller list, never from the user |
  | `hardCapPerPaymentAtomic`, `sessionBudgetAtomic`, `maxAuthorizationsPerMinute` | the smaller of the policy's and the platform limit |
  | `dailyBudgetAtomic` | the smaller of the policy's and the user daily ceiling |
  | `allowedSchemes`, `maxTimeoutSeconds` | the platform mandate's |
  | `allowedNetworks`, `allowedAssets` | the network profile's |

  A platform limit lowered after a policy was saved applies at the next decision; the policy is not rewritten, only flagged (`limitedByPlatform`). An effective mandate may break CFG-3's order when the platform cap falls to or below the policy's auto-approve limit; it is still evaluated, and R10 denies everything above the cap.

**L2-2 Policy engine** (`evaluateRequirement`, `decide`)

Inputs: `(req, mandate, ctx)` where `ctx = { nowMs, requestedUrl, challengeResourceUrl, sessionCommittedAtomic, dailyCommittedAtomic, authorizationsLastMinute, humanApprovedFor?, humanRejected? }`. `humanRejected = { rejectionId }` is present when a `HUMAN_REJECTION` exists for the request's (session, resource key); `service.ts` derives it from the ledger.

v1.10: for a user payment, `ctx` also has `user = { gate?, dailyCommittedAtomic, dailyCeilingAtomic }`. `gate` is `not_onboarded` or `disabled`. `sessionCommittedAtomic`, `dailyCommittedAtomic` and `authorizationsLastMinute` then count only this user's entries under this policy; `user.dailyCommittedAtomic` counts the user's entries under any policy over the trailing 24 h; approvals and rejections are looked up for the same user only. Without `ctx.user` (the platform account) the engine behaves exactly as in v1.8, and its figures count only entries without a user.

Rules are evaluated in this order. All DENY violations are collected; evaluation does not stop at the first.

| # | Rule ID | Condition for violation | Effect |
|---|---|---|---|
| R16 (v1.10) | `user_not_onboarded` | `ctx.user.gate` is `not_onboarded`: the user has no registration, no wallet or has never saved a policy. Detail: `the user's setup is incomplete`, nothing else. Evaluated first, although numbered last | DENY, **return immediately** |
| R17 (v1.10) | `user_disabled` | `ctx.user.gate` is `disabled`. Detail: `the user's account can't pay`. Evaluated first; no approval lifts it | DENY, **return immediately** |
| R1 | `mandate_expired` | `nowMs > expiresAt` | DENY |
| R2 | `scheme_not_allowed` | `req.scheme ∉ allowedSchemes` | DENY |
| R3 | `network_not_allowed` | `req.network ∉ allowedNetworks` | DENY |
| R4 | `asset_not_allowed` | `lower(req.asset) ∉ allowedAssets[network]` | DENY |
| R5 | `payee_not_allowed` | `allowedPayees` non-empty and `lower(payTo)` not in it | DENY |
| R6 | `host_not_allowed` | `host(requestedUrl)` invalid or not in `allowedHosts` (host includes port) | DENY |
| R7 | `resource_binding_mismatch` | `host(challengeResourceUrl) ≠ host(requestedUrl)` | DENY |
| R8 | `timeout_out_of_range` | not `0 < maxTimeoutSeconds ≤ mandate.maxTimeoutSeconds` | DENY |
| R9 | `amount_invalid` | amount is not `^\d+$` or is ≤ 0 | DENY, **return immediately** |
| R10 | `hard_cap_exceeded` | `amount > hardCapPerPaymentAtomic` | DENY |
| R11 | `session_budget_exceeded` | `sessionCommitted + amount > sessionBudgetAtomic` | DENY |
| R12 | `daily_budget_exceeded` | `dailyCommitted + amount > dailyBudgetAtomic`; v1.10: or, when `ctx.user` is present and that passes, `user.dailyCommitted + amount > user.dailyCeiling` (the user daily ceiling, across all the user's policies). One violation at most | DENY |
| R13 | `velocity_limit` | `authorizationsLastMinute ≥ maxAuthorizationsPerMinute` | DENY |
| R15 | `human_rejected` | `humanRejected` is present (the operator rejected this session and resource key; any amount or payee). Detail: `rejected by the operator (<rejectionId>)`, never the operator's label or reason (SEC-12). Listed here because evaluation follows table order. | DENY |
| R14 | `human_approval_required` | no DENY, and `amount > autoApproveMaxAtomic`, and no matching `humanApprovedFor` (same payTo, case-insensitive, and the exact amount string) | ESCALATE |
| — | (none) | otherwise | AUTHORIZED |

v1.19: R4 reads the network's asset list as an own key of `allowedAssets` only, so a network named like an object member (`__proto__`, `constructor`) has none. If `decide` itself throws (a value no rule foresaw), the decision is DENIED with the one violation `decision_failed` (detail `the payment request could not be evaluated`), so an `INTENT` is always followed by exactly one outcome entry.

`decide(accepts, m, ctx)`:
- If any requirement is AUTHORIZED, choose the one with the smallest amount (ties go to the first offered) → AUTHORIZED.
- Else, if any is ESCALATE → ESCALATE with that requirement's violations.
- Else → DENIED with all violations flattened, or `no_payment_options` if `accepts` is empty.

**L2-3 Signer** (`PaymentSigner`)
- Constructed with `(privateKey, net, hardCapAtomic)`; since v1.10 the first argument may be a ready local account instead of a key.
- Registers `ExactEvmScheme(account)` for `net.caip2`.
- SDK spend controls: `{ maxAmountPerPayment: false, allowedAssets: [{ network, asset, maxAmountPerPayment: hardCapAtomic }] }`. This is an independent second cap.
- `sign(challenge, approved)` calls `x402HTTPClient.createPaymentPayload({...challenge, accepts:[approved]})` and returns `{ headers: encodePaymentSignatureHeader(payload), payer: authorization.from, validBefore: Number(authorization.validBefore) }`.
- If the SDK throws, L2 records `DENIED` with rule `signer_rejected` (detail truncated to 300 chars).
- **Published development keys (v1.18).** Outside `NETWORK=local`, `main()` refuses to start (`ConfigError`, naming the variable and never its value) when the payer's address, or the address of the user wallets' mnemonic at index 0, is in `PUBLISHED_DEV_ADDRESSES`: the first ten accounts of `LOCAL_MNEMONIC`, `DEV_USER_WALLET_MNEMONIC` and the tests' `TEST_MNEMONIC`. `signer.ts` holds the addresses only, never a phrase (T-DEVKEY-01).
- **Keyring (v1.10, `WalletKeyring`, in `signer.ts` only).** With user accounts on, `keyringFromEnv` reads `USER_WALLET_MNEMONIC`, which must be a valid 24-word BIP-39 phrase (the error names the variable, never the phrase). `addressOf(index)` and `signerFor(index, hardCapAtomic)` derive the account at `m/44'/60'/0'/0/<index>`. A user's `walletIndex` is the number of `WALLET_CREATED` entries before theirs, so indexes are never reused. A user payment is signed by `signerFor(wallet.walletIndex, the effective hard cap)`; when the derived address differs from the recorded one, the decision is DENIED `signer_rejected`. At startup, after the ledger loads, every recorded wallet's address is derived again and compared: a different mnemonic stops L2. No route, log line, ledger entry or response ever carries the mnemonic or a derived key.

**L2-4 Ledger** (`AuditLedger`, JSONL at `.local/ledger-<network>.jsonl`)

Entry: `{ seq, ts (ISO), type, sessionId?, intentId?, authorizationId?, data, prevHash, hash, mac? }`.
- `seq` starts at 0 and increases by 1.
- `hash = sha256(canonicalJSON(entry without hash))`. Canonical JSON uses recursively sorted object keys and no whitespace. Absent optional fields are omitted, never written as `null`. Every amount is a string, and every number is an integer.
- The genesis `prevHash` is 64 zeros. `verifyChain` recomputes every hash and link. The constructor throws `integrity` on failure. `brokenAt` is the 0-based line index of the first bad line, which equals `seq` on a well-formed chain.
- v1.19 (SEC-36), the keyed chain. With `LEDGER_MAC_KEY` (CFG-2: `off`, `<secret>`, or `<n>:<secret>` for a ledger that already had n entries; the secret is hex or base64 of at least 32 bytes), every appended entry also carries `mac = hex(HMAC-SHA256(key, "x402-ledger-v1\n" + hash))`. `hash` never covers `mac`, so an entry written before 1.19 verifies as it did. `verifyChain` and the constructor also check, with the key: every `mac` present matches; every entry at index n or later carries one; after the first keyed entry every later one does; and the ledger has at least n entries (`brokenAt` is then its length). The constructor refuses a ledger that carries MACs when L2 has no key. A writer without the key can no longer rewrite an entry and recompute every hash after it; cutting the ledger back to a shorter prefix that is still n entries or more stays undetectable without an external anchor (§11). The key is read only by `src/layer2-control/ledger-key.ts` (A16), never logged, returned or written to an entry. Never rotate it in place: the old entries' MACs only verify with it.

| Type | Written when | `data` fields |
|---|---|---|
| `INTENT` | every authorize call, before deciding; followed by exactly one outcome entry (`AUTHORIZED`, `DENIED`, `ESCALATED` or `ESCALATION_REPEATED`). v1.8: again, with `reevaluationOf`, when a call re-evaluates after its wait ended in approved or denied (L2-5, L2-7) | `resourceUrl, purpose, accepts, reevaluationOf?` |
| `AUTHORIZED` | decision AUTHORIZED | `amount, asset, network, payTo, payer, validBefore, resourceUrl, mandateId, approvalRef` (the consumed approval's `approvalId`, or `null`; always present), and (v1.19) `nonce`: the signed EIP-3009 authorization's, lower-case hex, when the signer gives one |
| `DENIED` | decision DENIED | `violations, resourceKey` |
| `ESCALATED` | decision ESCALATE | `violations, resourceKey, payTo, amount, approvalRequest?` (v1.8: `requested`, `capped`, `operator_only` or `reevaluation`, only when backchannel approval is on; v1.16: or `no_owner`, `no_identity`, `identity_mismatch`, which ask nobody, L2-7). Never the owner's subject |
| `HUMAN_APPROVAL` | operator approves, (v1.8) a verified backchannel answer approves, or (v1.15) an administrator approves in the portal | `approvalId` (`apr_<uuid>`), `escalationId, resourceKey, payTo, amount, approver, expiresAtMs, channel` (v1.8: `operator` or `backchannel`; v1.15: or `portal`; an older entry without it is `operator`), plus `requestId, evidence {issuer, userId, answerId, issuedAt, detailsSource}` for `backchannel`: since v1.16 `approver` and `evidence.userId` are the owner's `usr_…` identifier, copied from the `ESCALATED` entry, and the answer's subject is not kept (an entry written before v1.16 holds the configured approver's subject in `approver` and in `evidence.subject`, and is never rewritten). For `portal` (v1.15): `approver` is the administrator's `usr_…` identifier, never a name; `expiresAtMs` is the append time plus 600 s; plus `identityConfirmedAtMs` |
| `HUMAN_REJECTION` | operator rejects a pending escalation (L2-4.3), (v1.8) the approver refuses, or (v1.15) an administrator rejects in the portal | `rejectionId` (`rej_<uuid>`), `escalationId, resourceKey, payTo, amount, channel`, plus `operator, reason?` for `operator` (untrusted free text, never a decision input), or `approver, issuer, requestId` for `backchannel` (v1.16: `approver` is the owner's `usr_…`; before, the configured approver's subject), or (v1.15) `approver` (the administrator's `usr_…`) and `reasonCode` (`not_expected`, `amount_too_high`, `wrong_seller`, `duplicate` or `other`) for `portal`: no label and no text |
| `APPROVAL_REQUESTED` | v1.8 (L2-7): the approval service accepted the request | `escalationId, resourceKey, payTo, amount, channel, requestId` (`apq_<uuid>`), `issuer, approver` (v1.16: the owner's `usr_…`, who the request was addressed to; before, the configured approver's subject), `referenceCode, bindingMessage, details, requestedExpirySec, requestExpiresAtMs, intervalSec, handleSealed, attempts` |
| `APPROVAL_REQUEST_FAILED` | v1.8: a start, a poll or a resume failed for good | `escalationId, resourceKey, payTo, amount, channel, requestId?, phase` (`start`, `poll` or `resume`), `failure` (`permanent`, `transient`, `unreachable`, `interrupted`, `unrecoverable`; v1.16: `no_owner`, with `phase: "resume"`, for a request whose escalation records no user), `httpStatus?, error?` (a whitelisted OAuth code or `other`), `attempts?` |
| `APPROVAL_REQUEST_LAPSED` | v1.8: the request expired, or a refusal came within 5 s of its expiry | `escalationId, resourceKey, payTo, amount, channel, requestId, cause` (`expired` or `late_refusal`), `requestExpiresAtMs` |
| `APPROVAL_VERIFICATION_FAILED` | v1.8: an answer failed a check | `escalationId, resourceKey, payTo, amount, channel, requestId, check` (`malformed`, `signature`, `issuer`, `audience`, `client`, `expired`, `owner`, `request`, `details` or `replay`; v1.16: `owner` replaces `approver`, which only entries written before hold) |
| `ESCALATION_EXPIRED` | sweep: an escalation was still pending at `expiresAtMs` | `escalationId, resourceKey, payTo, amount, expiresAtMs` |
| `APPROVAL_LAPSED` | sweep: an approval passed `expiresAtMs` without being consumed | `approvalId, escalationId, resourceKey, payTo, amount, expiresAtMs` |
| `ESCALATION_REPEATED` | ESCALATE for a purchase that already has a pending escalation | `escalationId, resourceKey, payTo, amount, violations` |
| `SETTLEMENT` | L3 reconcile | the `SettlementReport` plus `anomaly: boolean` (status forced to `MISMATCH` on field mismatch, with detail `"verified field mismatch: <fields>"`) |

`resourceKey = origin + pathname` of the resource URL (the query string is excluded).

v1.10 (L2-8) adds twelve entry types. None has `sessionId`, `intentId` or `authorizationId`, and none holds a name, an email or any other text a person typed:

| Type | Written when | `data` fields |
|---|---|---|
| `PLATFORM_CONFIG` | at startup, when user accounts are on and the platform config's digest differs from the last recorded one | `platformId, digest, limits, sellers` |
| `USER_REGISTERED` | a person saves their profile for the first time | `userId, acknowledgedTestFunds: true, termsVersion` |
| `WALLET_CREATED` | a user creates their crypto account | `userId, walletIndex, address, network` |
| `CARD_ADDED`, `CARD_REMOVED` | the portal reports a registered or removed card | `userId, cardId` (`card_<uuid>`, nothing about the card) |
| `POLICY_CREATED` | a policy is saved for the first time | `userId, policyId` (`pol_<uuid>`), `version: 1`, the eight `PolicyValues` fields, `identityConfirmedAtMs` |
| `POLICY_CHANGED` | a policy's values change | `userId, policyId, version` (n+1), the values, `loosened, identityConfirmedAtMs?` |
| `POLICY_PAUSED` | the user pauses a policy, or the account is enabled again | `userId, policyId, version, cause` (`user` or `account_enabled`) |
| `POLICY_RESUMED` | the user resumes a paused policy | `userId, policyId, version, identityConfirmedAtMs` |
| `POLICY_REMOVED` | the user removes a policy | `userId, policyId, version` |
| `USER_DISABLED` | the user disables their account | `userId` |
| `USER_ENABLED` | the user enables it again, after the `POLICY_PAUSED` entries of the same serialized section | `userId, identityConfirmedAtMs` |

For a user payment, `INTENT` also carries `userId`; `AUTHORIZED`, `ESCALATED` and `ESCALATION_REPEATED` carry `userId, policyId, policyVersion`; `DENIED` carries `userId`, and the policy fields when a policy applied. On `AUTHORIZED`, `mandateId` is `<policyId>@<version>` and `payer` is the user's account. An entry without `userId` belongs to the platform account, which is every entry written before v1.10. The approval, rejection, expiry and settlement entries are unchanged: their user is the one on the `ESCALATED` or `AUTHORIZED` entry they refer to.

**L2-4.1 Committed spend** `committedAtomic({sessionId?, sinceMs?}, nowMs)`
- The effective report per authorization is the latest `SETTLEMENT` entry with `anomaly !== true`.
- Sum the `amount` of every `AUTHORIZED` entry in the filter **except** those whose effective report is `NOT_SETTLED` **and** where `nowMs > validBefore*1000` (the signature can no longer settle). v1.19: for an entry with a `nonce`, that report must also name the same nonce (`verified.nonce`) and have been observed after validBefore (`observedAt > validBefore*1000`), which is when L3 reads the nonce's state on-chain (L3-1). A `NOT_SETTLED` made while the seller still held a usable authorization keeps the amount counted. Reconcile flags a report whose `verified.nonce` differs from the entry's as a field mismatch (`nonce`).
- `MISMATCH` and `PENDING` keep counting (conservative).
- v1.10: the filter also takes an owner, `{ userId?, policyId? }`. `userId: "usr_…"` counts that user's entries, `userId: null` counts the platform account's (entries without a user), and an absent `userId` counts all. `authorizedSince` (velocity) takes the same owner. With user accounts on, the platform account's figures use `userId: null`, so no user's spending uses up the platform account's budget, and the reverse.

**L2-4.2 Approvals**: `findOpenApproval(sessionId, resourceKey, nowMs)` returns the **most recent** `HUMAN_APPROVAL` entry for that (session, resourceKey) that has not expired and is not yet consumed. An approval is single-use. It is consumed when an `AUTHORIZED` entry's `approvalRef` equals its `approvalId`. An escalation has at most one approval (L2-4.3), so it authorizes at most one payment; approving an approved escalation returns the existing approval. An approval is consumed only when it is what lifted R14 (same payee, exact amount, amount above `autoApproveMaxAtomic`); a matching approval seen on a payment that needed no approval stays open. v1.10: with an owner, only an approval of that owner's escalation is found, so an approval for one user's purchase never lifts R14 for another user or for the platform account.

**L2-4.3 Escalation lifecycle** (v1.3, `src/layer2-control/escalations.ts`)

An escalation is created by its `ESCALATED` entry at `createdMs = Date.parse(ts)`. It expires at `expiresAtMs = createdMs + 300 000`, a constant that is not configurable. Its state is derived from the ledger and the decision time only, in this order:

1. `approved` when a `HUMAN_APPROVAL` names it.
2. `denied` when a `HUMAN_REJECTION` names it.
3. `expired` when an `ESCALATION_EXPIRED` names it, or `nowMs ≥ expiresAtMs`.
4. Otherwise `pending`.

- **Decision paths (v1.15).** A `HUMAN_APPROVAL` or a `HUMAN_REJECTION` comes from one of three paths, recorded as `channel`: the operator's routes (`operator`), a verified backchannel answer (`backchannel`, L2-7) or the portal's administration routes (`portal`, L2-8). The operator's and the portal's routes call one decision core, `recordApproval` and `recordRejection` (`approval-routes.ts`): sweep, derive the state, return the existing outcome for an escalation that is no longer pending, run the path's own checks, append one entry, all in one synchronous block inside the serialized section. So an escalation gets exactly one final state whichever paths race for it (T-ADM-07).
- **Final states.** `approved`, `denied` and `expired` are final and are never left. Approve and reject act only on a pending escalation. Repeating the deciding action returns the existing decision. The opposite action, or any action on an expired escalation, is 409 and appends nothing.
- **Sweep.** `sweep(nowMs)` runs at the start of every serialized L2 operation and every 1 s from `main()` (an unreferenced timer; `createControlService` never starts one). It appends one `ESCALATION_EXPIRED` for each escalation still pending with `nowMs ≥ expiresAtMs`, and one `APPROVAL_LAPSED` for each approval past `expiresAtMs` that was not consumed and not already recorded. A restart sweeps whatever came due while L2 was down.
- **One pending escalation per purchase.** A purchase is (session, resource key, payee lower-cased, exact amount string). While an escalation for a purchase is pending, an ESCALATE decision for the same purchase returns that escalation's `authorizationId` and is recorded as `ESCALATION_REPEATED`. A different amount or payee is a different purchase.
- **Denial scope.** A `HUMAN_REJECTION` blocks its (session, resource key) for good through R15, whatever the amount or payee. An expiry blocks nothing: the next request for the same purchase escalates again under a new ID.
- **Notifications** are the lifecycle entries themselves. The operator reads them through `GET /v1/escalations` and `GET /v1/escalations/events`. L2 makes no outbound connection to notify the operator. Since v1.8, its only outbound connections are to the configured approval service (L2-7), which asks the approver.
- Every check-then-append (approve, reject, sweep, authorize) is one synchronous block inside the serialized section (INV-8), so each escalation gets exactly one final-state entry.

**L2-5 HTTP API** (binds to 127.0.0.1)

| Method & path | Auth | Request | 200 response | Errors |
|---|---|---|---|---|
| `POST /v1/authorize` | `CONTROL_TOKEN`, and (v1.17) the caller's token beside it, in `X-Caller-Authorization` | `PaymentIntent` | `AuthorizationDecision`. v1.8: with backchannel approval on, a call that creates an eligible escalation may take up to 120 s and return the re-evaluated decision (L2-7) | 400 malformed (missing ids, `accepts` not an array, non-http(s) URL, a non-boolean `operatorApprovalOnly`; v1.19: an option without the field types of a requirement, more than 20 options, or a `purpose` that is not a string of at most 500 characters; v1.17: a `userId` or an `approvalSubject`, whatever its value and whether user accounts are on or off: `malformed PaymentIntent`, since neither is accepted on a request; the answer never repeats the value), 401 `unauthorized`; v1.17, for the caller's token: 401 `caller_token_required`, `caller_token_expired` or `caller_token_invalid`, 400 `caller_token_not_accepted`, 403 `caller_forbidden`; 429 `{ "error": "too many requests" }` with `Retry-After` beyond the bound on token checks (below) |
| `GET /v1/budget/:sessionId` | `CONTROL_TOKEN`, and (v1.17) the caller's token beside it | — (v1.17: no query) | `BudgetStatus` (`perPaymentCapAtomic` = auto-approve limit). An unknown session returns 200 with zero spend. `remainingAtomic` is never below 0. v1.17: for a person's token, the user's view (`scope: "user_daily"`), as `?userId=` gave before: the cap is the user daily ceiling, the spend is the user's committed spend over 24 h, and `perPaymentCapAtomic` is the highest auto-approve limit among the user's active policies, bounded by the platform cap; zeros for a user who is not onboarded or is disabled. For a machine caller's token, or none where sign-in is not configured, the session view | 400 `{ "error": "userId is not accepted: the user comes from the caller's token" }` for a `?userId=`, whatever its value (v1.17); 401, and the caller's token refusals and the 429 as for authorize |
| `POST /v1/reconcile` | `SETTLEMENT_TOKEN` | `SettlementReport` | `{ ok, anomaly }` | 400 malformed report (missing `authorizationId` or `verified`), 404 unknown authorizationId, 401 |
| `POST /v1/approvals/:authorizationId` | `OPERATOR_TOKEN` | `{ approver? = "operator", ttlSeconds? = 600 }` | Pending: `{ ok, approvalId, expiresAt }` and one `HUMAN_APPROVAL`. Already approved: the existing approval plus `alreadyApproved: true`; nothing is appended and the request's `ttlSeconds`/`approver` are ignored (v1.3). | 400 `ttlSeconds` not a whole number from 1 to 3600 (v1.19: it was any positive integer), or an `approver` that is not 1–64 characters, 404 no ESCALATED entry, 409 `{ error, state: "denied", rejectionId }` or `{ error, state: "expired", expiresAt }`, 401 |
| `POST /v1/rejections/:authorizationId` | `OPERATOR_TOKEN` | `{ operator? = "operator" (1–64 chars), reason? (≤ 280 chars) }` | Pending: `{ ok, rejectionId, rejectedAt, alreadyRejected: false }` and one `HUMAN_REJECTION`. Already denied: the first rejection with `alreadyRejected: true`; nothing is appended. | 400 invalid `operator` or `reason`, 404 no ESCALATED entry, 409 `{ error, state: "approved", approvalId }` or `{ error, state: "expired", expiresAt }`, 401 |
| `GET /v1/escalations` | `OPERATOR_TOKEN` | — | `{ pending: [{ authorizationId, sessionId, resourceKey, payTo, amount, createdAt, expiresAt, referenceCode, approvalRequest? }], cursor }`, oldest first; `cursor` is the last ledger `seq` (-1 when empty). v1.8: `referenceCode` (8 hex characters of the ID) always; `approvalRequest` (`requested`, `capped`, `operator_only`, `reevaluation`, `failed`, `verification_failed` or `lapsed`; v1.16: or `no_owner`, `no_identity`, `identity_mismatch`) when backchannel approval is on | 401 |
| `GET /v1/escalations/events?after=<seq>` | `OPERATOR_TOKEN` | `after`: integer ≥ -1, default -1 | `{ events, cursor }`: one event per lifecycle entry with `seq > after` (`escalated`, `approved`, `denied`, `expired`, `approval_lapsed`; v1.8 adds `approval_requested`, `approval_request_failed`, `approval_request_lapsed`, `approval_verification_failed`, and `channel`, `decidedBy`, `referenceCode` where they apply; v1.16: for a backchannel decision `approver` and `decidedBy` are the owner's `usr_…`, or the configured approver's subject for an entry written before, `check` may be `owner`, `failure` may be `no_owner`, and an `escalated` event's `approvalRequest` may be one of the three marks that ask nobody), built from a field whitelist; never tokens, request handles, payment headers, `accepts`, `purpose`, `details` or the approval service's text | 400 bad `after`, 401 |
| `GET /v1/ledger/verify` | `OPERATOR_TOKEN` | — | `{ entries, ok, brokenAt? }`. v1.19: a check re-reads the whole ledger, so one address gets at most 30 a minute (`MAX_LEDGER_VERIFIES_PER_MINUTE`), counted after `OPERATOR_TOKEN` | 401, 429 `{ "error": "too many requests" }` with `Retry-After` (v1.19; nothing read) |
| `GET /v1/platform` (v1.10) | `PORTAL_TOKEN` | — | `PlatformView`. v1.16: with `phoneApproval` | 401 |
| `GET /v1/users/:userId` | `PORTAL_TOKEN` | — | `UserView`. An unknown user: `registered: false` and empty lists, never 404 | 400, 401 |
| `PUT /v1/users/:userId/registration` | `PORTAL_TOKEN` | `{ acknowledgedTestFunds: true }` | `UserView`. The first call appends `USER_REGISTERED`; later calls append nothing | 400 (the flag is not `true`, or any other field), 401 |
| `PUT /v1/users/:userId/wallet` | `PORTAL_TOKEN` | — | `UserView`. The first call appends `WALLET_CREATED`; later calls append nothing and return the same address | 401, 409 `not_registered`, 409 `account_disabled` |
| `POST /v1/users/:userId/policies` | `PORTAL_TOKEN` | `PolicyValues & { identityConfirmedAtMs }` | 201 `PolicyView` (version 1) and `POLICY_CREATED` | 400, 401, 403 `step_up_required`, 409 `not_registered`, `no_wallet` or `account_disabled`, 422 `invalid_policy` |
| `GET /v1/users/:userId/policies/:policyId` | `PORTAL_TOKEN` | — | `PolicyView` with `history` | 401, 404 |
| `PUT /v1/users/:userId/policies/:policyId` | `PORTAL_TOKEN` | `PolicyValues & { expectedVersion, identityConfirmedAtMs? }` | `PolicyView`. New values: `POLICY_CHANGED`. The same values: nothing appended | 400, 401, 403 `step_up_required` (loosening only), 404, 409 `version_conflict` (with the current `PolicyView`), `policy_removed` or `account_disabled`, 422 `invalid_policy` |
| `POST /v1/users/:userId/policies/:policyId/pause` | `PORTAL_TOKEN` | — | `PolicyView`, and `POLICY_PAUSED` (cause `user`) unless already paused | 401, 404, 409 `policy_removed` or `account_disabled` |
| `POST /v1/users/:userId/policies/:policyId/resume` | `PORTAL_TOKEN` | `{ identityConfirmedAtMs }` | `PolicyView`, and `POLICY_RESUMED` unless already active | 401, 403 `step_up_required`, 404, 409 `policy_removed` or `account_disabled`, 422 `invalid_policy` |
| `POST /v1/users/:userId/policies/:policyId/remove` | `PORTAL_TOKEN` | — | `PolicyView`, and `POLICY_REMOVED` unless already removed | 401, 404, 409 `account_disabled` |
| `POST /v1/users/:userId/disable` | `PORTAL_TOKEN` | — | `UserView`, and `USER_DISABLED` unless already disabled | 401, 409 `not_registered` |
| `POST /v1/users/:userId/enable` | `PORTAL_TOKEN` | `{ identityConfirmedAtMs }` | `UserView`; one `POLICY_PAUSED` (cause `account_enabled`) per active policy, then `USER_ENABLED`; nothing if already enabled | 401, 403 `step_up_required`, 409 `not_registered` |
| `PUT /v1/users/:userId/cards/:cardId` | `PORTAL_TOKEN` | — | `{ cards }`, and `CARD_ADDED` unless already present | 400 (`cardId` is not `card_<uuid>`), 401, 409 `not_registered`, `account_disabled` or `card_limit` |
| `DELETE /v1/users/:userId/cards/:cardId` | `PORTAL_TOKEN` | — | `{ cards }`, and `CARD_REMOVED` if it was present; allowed while disabled | 401 |
| `GET /v1/admin/escalations` (v1.15) | `PORTAL_ADMIN_TOKEN` | — | `{ pending, cursor, readAt }`: the pending list of `GET /v1/escalations` plus the time of the read. Derived from the entries and the clock; appends nothing (no sweep) | 401 |
| `GET /v1/admin/escalations/events?after=<seq>\|before=<seq>&limit=<n>` (v1.15) | `PORTAL_ADMIN_TOKEN` | `after` or `before`: integer ≥ -1, not both; `limit`: 1–200, default 50 | `{ events, first, last, cursor, more }`: one page of the events of `GET /v1/escalations/events`, oldest first. `after`: the first `limit` with a higher `seq`; `before`: the `limit` just below; neither: the latest `limit`. Every event also carries `referenceCode` and, for a user's payment, `userId`. Appends nothing | 400 (a bad `limit` or cursor, both cursors, or any other query parameter), 401 |
| `GET /v1/admin/escalations/:authorizationId` (v1.15) | `PORTAL_ADMIN_TOKEN` | — | `EscalationDetail`: the escalation in any state (`state`: `pending`, `approved`, `denied` or `expired`), `decision` (`at, channel, decidedBy`, and the IDs, `reasonCode` or the operator's `reason`) when a person ended it, and `budget`: `{ asset, decimals, applies, notApplying?, autoApproveMaxAtomic, hardCapPerPaymentAtomic, run, day, userDay?, fits }`, each line `{ capAtomic, spentAtomic, remainingAtomic }`, from the figures the decision itself uses, under the rules in force now. Appends nothing | 400 (not an escalation ID), 401, 404 |
| `POST /v1/admin/escalations/:authorizationId/approve` (v1.15) | `PORTAL_ADMIN_TOKEN`, and (v1.19) the administrator's own token in `X-Person-Authorization` | `{}` (v1.19: the decider, `identityConfirmedAtMs` and the second-factor time are the token's; until 1.19 `{ decidedBy, identityConfirmedAtMs }`) | Pending: `{ ok, state: "approved", approvalId, expiresAt, already: false, channel: "portal", decidedBy }` and one `HUMAN_APPROVAL` (`channel: "portal"`, `approver` = the administrator's `usr_…`, `identityConfirmedAtMs`), valid 600 s. Already approved on any path: the first approval with `already: true`; nothing is appended | 400 (the ID is not `auth_<uuid>`, or any body field, `decidedBy` and `identityConfirmedAtMs` included), 401 (and the person's token's, below), 403 `own_payment` (the decider owns the escalation), 403 `step_up_required` with `maxAgeSec: 900` (the sign-in, or v1.19 the second factor, is older than 15 min, 60 s tolerance), 403 `person_forbidden`, 404, 409 `{ error: "not_pending", state, channel?, decidedBy?, rejectionId?, expiresAt? }` |
| `GET /v1/admin/ledger/verify` (v1.15) | `PORTAL_ADMIN_TOKEN` | — | `{ entries, ok, brokenAt? }`, as `GET /v1/ledger/verify`. Read-only. A check re-reads the whole ledger, so one caller's address gets at most 30 a minute (`Retry-After` on the refusal); the portal asks at most six | 401, 429 |
| `POST /v1/admin/escalations/:authorizationId/reject` (v1.15) | `PORTAL_ADMIN_TOKEN`, and (v1.19) the administrator's own token in `X-Person-Authorization` | `{ reasonCode }` (v1.19: the decider is the token's; until 1.19 `{ decidedBy, reasonCode }`); `reasonCode` is one of `not_expected`, `amount_too_high`, `wrong_seller`, `duplicate`, `other`; no text | Pending: `{ ok, state: "denied", rejectionId, rejectedAt, already: false, channel: "portal", decidedBy }` and one `HUMAN_REJECTION` (`channel: "portal"`, `approver`, `reasonCode`). Already denied on any path: the first rejection with `already: true` | 400, 401, 403 `own_payment`, 404, 409 `not_pending` |
| `GET /docs` | none; only with `API_DOCS=1` | — | Swagger UI page (HTML) whose CSP limits scripts and requests to the L2 origin | — |
| `GET /docs/:asset` | none; only with `API_DOCS=1` | — | `swagger-ui.css` or `swagger-ui-bundle.js` from `swagger-ui-dist`, or `swagger-initializer.js` | 404 any other name |
| `GET /openapi.yaml` | none; only with `API_DOCS=1` | — | `docs/l2-control.openapi.yaml` with `servers` set to `/`, the L2 serving it | — |

`docs/l2-control.openapi.yaml` describes the same API in OpenAPI 3.1, with the request and response schemas from §7. This table stays normative. When a route, token, status or response field changes, update the table, §7 and the document together; T-API-01..03 fail until they match.

With `API_DOCS=1` (CFG-2), L2 also serves that document and Swagger UI over it; without it, those three routes are not mounted and answer 404. They are the only L2 routes without a token. They serve files read at startup (a missing file fails startup) and never touch the ledger, mandate or signer. Swagger UI comes from the pinned `swagger-ui-dist` package, never a CDN. The page's Content-Security-Policy allows scripts and requests to its own origin only, because tokens typed into the page share that origin with the signing API (SEC-13). Swagger UI keeps entered tokens in memory only, and "Try it out" calls the live L2.

**Request bodies (v1.18).** Every route that takes a body parses it after its guard, so a caller without the route's token gets 401 before a byte is read. Bodies are JSON of at most 16 KB (`POST /v1/authorize`: 256 KB), read as sent: a `Content-Encoding` other than identity is 415, since no caller of L2 compresses a request. A body that can't be read is answered with its status (400, 413, 415) and a fixed JSON message, `malformed request body` or `request body refused` (`malformed PaymentIntent` or `PaymentIntent body refused` on authorize), never by the framework's default handler, which logs the error (T-BODY-01..02).

**The person's token (v1.19, SEC-35).** Every `PORTAL_TOKEN` route but `GET /v1/platform`, and every `PORTAL_ADMIN_TOKEN` route, also takes the person's own access token, which the portal forwards unchanged in `X-Person-Authorization: Bearer <token>`. It opens nothing by itself: without the role token the answer is 401 `unauthorized` before the header is looked at. Then, before the body is read, L2 verifies it itself (`src/layer2-control/person.ts`), with `AUTH_ISSUER`, `AUTH_AUDIENCE` and `PORTAL_CLIENT_ID` (CFG-2): no header, 401 `person_token_required`; the tenant's signature, issuer, audience, validity or `sub` wrong, or a sign-in time (`AUTH_TIME_CLAIM`) absent or in the future beyond 60 s, 401 `person_token_invalid`; a machine token or one issued to another client, 403 `person_forbidden`; on an administration route, a token without `portal:admin`, 403 `person_forbidden`. Requests one address sends to these routes are counted before the check (at most 6000 a minute: every portal request reaches L2 from the portal's one address). The person is `userIdFor(issuer, sub)`: a path's `:userId` that is not that user is 403 `person_mismatch`, after its format check (400). The step-up time of a loosening change (`identityConfirmedAtMs`) is the token's sign-in time and is never a body field (400); the decider of an administrator's decision is the token's user, and an approval also needs the token's second-factor time (`https://x402.dev/mfa_time`) at most 15 minutes old. The token is never stored, logged, echoed or written to the ledger; rule A17 keeps the header's name in `person.ts` and the portal's `person-context.ts`. Before 1.19 L2 took the user from the path and the times and the decider from the body, on the portal's word alone. Must-fail switch: `skipPersonCheck` on L2's `person` dep (test-only).

The fourteen `PORTAL_TOKEN` routes (v1.10, L2-8) exist only with `USER_ACCOUNTS=1`; without it each answers 404. `:userId` must match `^usr_[0-9a-f]{32}$` (else 400, after the token check). Bodies are JSON of at most 16 KB with no unknown field, and no field is free text: every string is an identifier, a host, an ISO date or an atomic amount. A `policyId` of another user is 404 with the same body as an unknown one, and no route reads a policy by its ID alone. Every write runs inside the serialized section. With user accounts on, the pending items of `GET /v1/escalations` and the `escalated` events gain `userId` when the escalation has one.

**The caller's token (v1.17, `specs/016` contracts/control-api.md).** The two routes L1 calls for a run, `POST /v1/authorize` and `GET /v1/budget/:sessionId`, keep their one role token (`CONTROL_TOKEN`, INV-13). Beside it they take the caller's token, and they no longer take a user from the request.

```http
POST /v1/authorize
Authorization: Bearer <CONTROL_TOKEN>
X-Caller-Authorization: Bearer <the access token the caller presented to the hosted agent>
```

- The header carries the caller's access token unchanged. L2 verifies it with the shared caller check (`verifyCaller`, the checks of L1-6) against its own settings (`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`; locally `AUTH_JWKS_FILE`), in `src/layer2-control/caller.ts`. It reads no statement about the caller from L1.
- The header opens nothing by itself: without a valid `CONTROL_TOKEN` the answer is 401 before the header is looked at, and no other route reads the header.
- It is verified before the body is parsed and before the serialized section. Verification may fetch the tenant's keys; nothing inside the serialized section makes a network call (INV-8). When the keys can't be fetched the request is refused and nothing is paid; keys already known keep working.
- Verifying a token costs a signature check, and at times a key fetch, so where sign-in is configured the two routes count requests per calling address first, together: at most 600 a minute (`MAX_CALLER_CHECKS_PER_MINUTE`, far above what the hosted agent sends: two runs at a time, ten steps each). The count comes after `CONTROL_TOKEN` (a caller without it is refused before it counts) and before the caller's token is looked at. Beyond it the answer is 429 `{ "error": "too many requests" }` with `Retry-After`, and nothing is verified, parsed, decided or appended; L1 reports the step as ERROR and nothing is paid. The limiter is the one of `src/shared/address-limit.ts`, with its counters in the replica's memory. Where sign-in is not configured no token is verified and nothing is bounded (T-CTK-09).
- The token is never stored, logged, echoed or written to the ledger (T-CTK-07). What L2 keeps from it, for the length of the request, is the forwarded identity: `{ kind: "person", userId, subject }`, `{ kind: "machine" }` or `{ kind: "none" }`.

Order of checks, both routes:

| # | Check | Refusal |
|---|---|---|
| 1 | `Authorization` is the `CONTROL_TOKEN` | 401 `{ "error": "unauthorized" }` (unchanged) |
| 2 | Sign-in configured, and no `X-Caller-Authorization`, or one that is not `Bearer <token>` | 401 `{ "error": "caller_token_required" }` |
| 3 | Sign-in not configured, and `X-Caller-Authorization` present | 400 `{ "error": "caller_token_not_accepted" }` |
| 4 | Signature, issuer, audience, validity, subject | 401 `{ "error": "caller_token_expired" }` when only the validity period failed; otherwise 401 `{ "error": "caller_token_invalid" }` |
| 5 | A machine token without `agent:run`; a person's token without `agent:run` or from a client not on `AGENT_CLIENT_IDS` | 403 `{ "error": "caller_forbidden" }` |
| 6 | A person's token while user accounts are off | 403 `{ "error": "caller_forbidden" }` |
| 7 | The body (authorize) or the query (budget) | 400, as in the table above |

"Sign-in configured" means L2 was started with `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` (all three or none, CFG-2). With user accounts on they are required: L2 refuses to start without them (L2-8). The portal's client is never on `AGENT_CLIENT_IDS`: L2 refuses to start when `PORTAL_CLIENT_ID` is set and on the list, as the agent does. A refusal at steps 1 to 7 decides nothing, signs nothing and appends nothing, so it creates no intent; L1 reports an error for that step (L1-1).

Who the payment is for:

| Caller's token | User | Pays |
|---|---|---|
| a person's | `userIdFor(AUTH_ISSUER, sub)` | that user's account, under the effective mandate (L2-8), never the platform account |
| a machine caller's | none | the platform account, under the platform mandate |
| none (sign-in not configured) | none | the platform account, as before v1.10 |

Ledger entries are as before: an entry for a person's payment carries `userId`, written by L2 from the verified token; an entry for a machine caller's payment, or for one without sign-in, carries none. Nothing in the ledger identifies the machine caller; the hosted agent's run log does. An approved escalation's retry is a new payment request and carries the caller's token again: an approval never stands in for the token. The portal's routes are unchanged: the portal keeps naming the user in the path, under `PORTAL_TOKEN`, from the token the portal verified.

Authorize algorithm. Each decision runs inside one serialized critical section (INV-8: a promise-chain mutex):
1. `t = now()`, sweep. Append `INTENT`. v1.17: for a person's token, L2 first writes the user it took from the token on the intent it records; no request supplies one.
2. Look up an open approval for (session, resourceKey).
3. Build `ctx`. Committed spend is per session and over the trailing 24 h; velocity counts AUTHORIZED entries in the trailing 60 s. v1.10: when the payment has a user (v1.17: the caller's token is a person's), derive the user's state from the ledger, select their active policy for the requested host, build the effective mandate (L2-1) and count every figure for that user and policy (L2-2); a person never falls back to the platform account.
4. `decide`.
5. If AUTHORIZED: optionally wait `signerLatencyMs` (a test hook that simulates a remote signer), then sign. On a signer error, the decision becomes DENIED with `signer_rejected`. v1.10: a user payment is signed with the user's own account (L2-3).
6. Append `AUTHORIZED`, `DENIED` or `ESCALATED` (v1.8: a new `ESCALATED` records `approvalRequest` when backchannel approval is on). Return the decision.

v1.8 (L2-7), only for a new `ESCALATED` with `approvalRequest: "requested"`:

7. Outside the section, start the approval request and wait at most 120 s for the escalation to reach a final state. Nothing is locked; every other call proceeds. If the caller disconnects, stop and return nothing.
8. If the escalation reached `approved` or `denied`, run steps 1–6 again as a second decision (its `INTENT` carries `reevaluationOf`; it never starts a request or waits) and return that decision. Otherwise return the decision from step 6.

Auth runs before any body validation on every endpoint, so 401 always precedes 400. Tokens are compared in constant time. v1.17: on the two routes above, the caller's token is checked after the role token and before the body; its 400 `caller_token_not_accepted` and its 403 are not body validation.

Reconcile algorithm. It runs inside the same serialized section as authorize, so there is a single ledger writer:
1. Load the `AUTHORIZED` entry.
2. Compare `report.verified.{asset, payer, payTo, amount}` (case-insensitive) with the authorization `data`. On any difference, store the entry with `status: "MISMATCH"`, `anomaly: true` and a detail naming the fields.
3. Else, if a non-anomalous `CONFIRMED` already exists and the new report is not CONFIRMED for the same tx, store it with `anomaly: true`.
4. Else store it with `anomaly: false`.

**L2-6 One ledger writer** (v1.5, `specs/011` contracts/ledger-lock.md)

- **Startup order.** `main()` runs env → **acquire the ledger lock** → ledger load and integrity check → profile → mandate → signer → listen. `createControlService` never takes the lock.
- **Lock file.** `<ledger>.lock`, created with an exclusive create, holding `{holder, pid, host, acquiredAt, heartbeatAt}`.
- **Heartbeat.** The holder refreshes `heartbeatAt` every 5 s with an atomic write-then-rename. If it ever finds the lock missing or owned by another holder, it exits 1 (`lost the ledger lock`). v1.19 (fencing): every ledger append first checks, synchronously, that the lock still names this holder, and exits the same way otherwise, so a holder that stalled past the staleness window and was replaced writes no entry when it wakes up.
- **Standby.** While another holder's heartbeat is less than 30 s old, L2 waits in standby, polling every 1 s and logging once. After 30 s without a heartbeat it renames the stale lock away and takes over. v1.19: "without a heartbeat" is judged by this process's own clock: the lock must stay unchanged for 30 s here, or for 10 s (two heartbeats) when its `heartbeatAt` also looks 30 s old. A live holder whose clock is behind this one's is seen changing and never taken over.
- **Shutdown.** SIGTERM and SIGINT release the lock.
- **Not a ledger entry.** The lock never touches the hash chain.
- **Accepted limit.** Two contenders taking over the same stale lock at the same instant could both succeed. One replica (`maxReplicas: 1`) and a stopped or crashed old holder make that impossible in the Azure profile.

**L2-7 Backchannel approval** (v1.8, `specs/012` contracts/auth0-ciba.md, payment-details.md, ledger-backchannel.md)

- **Off by default.** On only with `CIBA_APPROVAL=1` and a complete configuration (CFG-2), checked before the ledger lock. Off, L2 behaves as in v1.7. v1.16: on, it needs user accounts (`USER_ACCOUNTS=1`), because a request goes to the user a payment is for; `main()` refuses otherwise, before the lock, and `createControlService` refuses backchannel deps without user-account deps. No approver is configured: a leftover `CIBA_APPROVER` stops L2 (CFG-2). The startup line is `backchannel approval on (issuer <issuer>, per user)`.
- **Approval service.** An Auth0 tenant, reached by OpenID CIBA in poll mode at three fixed paths under `CIBA_ISSUER` (`bc-authorize`, `oauth/token`, `.well-known/jwks.json`), HTTPS only, no redirects. Each request is addressed to the escalation's owner (v1.16). Client authentication is `private_key_jwt` (RS256, preferred) or `client_secret_post`.
- **Eligibility**, decided in the section that writes the new `ESCALATED`, from the ledger and the request only, and recorded as `approvalRequest`. A repeat of a pending purchase is caught earlier (L2-4.3). Then, in this order (v1.16): a re-evaluation after a wait is `reevaluation`; `operatorApprovalOnly` is `operator_only`; an escalation that records no user is `no_owner` (v1.17: a machine caller's, and one made where sign-in is not configured); a user with no subject is `no_identity`, which since v1.17 no longer arises from a missing field, because the user and the subject come from the same verified token; a subject for which `userIdFor(CIBA_ISSUER, sub)` is not the user is `identity_mismatch`, which since v1.17 arises only when the sign-in issuer is not the approval service's; 10 `requested` escalations of that user in the trailing hour (a constant, counted for each person from the ledger, last, so an escalation that could never be sent uses up nobody's allowance) is `capped`; otherwise `requested`. Only `requested` sends a request. The other marks ask nobody: the payment is decided as usual, the call returns at once, and the escalation waits for the operator and the administrators. Nothing can route an escalation with no user to a person, and there is no fallback approver.
- **The owner's identity (v1.16; v1.17: from the forwarded identity).** The owner is the user the escalation records. Since v1.17 the owner and their subject at the approval service both come from the caller's token that L2 verified for that payment request (L2-5): the owner is `userIdFor(AUTH_ISSUER, sub)` and the subject is the token's `sub`. No field of the payment request names either: `PaymentIntent.approvalSubject` (v1.16) is removed, and a body that carries it is 400. The subject is still checked against the user by recomputing the one-way identifier under L2's own approval issuer (`CIBA_ISSUER`), which now holds by construction when sign-in and approval are the same tenant; they must be, and no caller chooses the issuer or the person. The subject then lives in memory only, until the one request's `login_hint` is sent: it is never appended, logged, returned or put in an event, and nothing needs it after a restart.
- **Start.** One request per eligible escalation, addressed to its owner (`login_hint` `{ format: "iss_sub", iss: CIBA_ISSUER, sub: <the owner's subject> }`), outside the section: up to 3 attempts (1.5 s timeout each; 250 ms and 1 s between) on transient failures, none after a permanent refusal. The request carries a binding message (at most 64 characters, `Pay_<usdc>_USDC_to_<payee>_for_<segment>_#<ref>`) and one `authorization_details` object in Auth0's Guardian schema, built only from the escalation and the chosen requirement, never from agent text. Its lifetime is at most the escalation's remaining window and 300 s, so Guardian push is used.
- **Poll.** At the service's interval; `slow_down` lengthens it by at least 5 s. Polling stops when the escalation reaches a final state by any path. After a restart, L2 resumes every open request from the ledger (`handleSealed`) without sending a new one, and needs no subject for it; a request started but never recorded is marked `interrupted` and never resent. v1.16: a request whose escalation records no user (addressed, before v1.16, to the configured approver) is not polled again for anybody: L2 records `APPROVAL_REQUEST_FAILED` with `phase: "resume"` and `failure: "no_owner"`, and the escalation follows its 300 s on the operator path.
- **Outcomes.** Every check-then-append runs inside the serialized section; no call to the service does.
  - A token answer is verified first (signature through the issuer's JWKS, issuer, audience, client, validity with a 60 s tolerance, the owner, the open request, the payment details field for field, single use). The owner check (v1.16, in the approver check's place) is made from the signed answer alone: `userIdFor(iss, sub)` must be the user recorded on the escalation, so another person's genuine answer approves nothing, and the check is the same after a restart. Passing gives `HUMAN_APPROVAL` (channel `backchannel`, TTL 600 s) naming the owner by `usr_…`; failing gives `APPROVAL_VERIFICATION_FAILED` naming the check.
  - `access_denied` at least 5 s before the request's expiry gives `HUMAN_REJECTION` (channel `backchannel`), recorded for the owner: the request was addressed to them and the service asks nobody else. A later refusal or `expired_token` gives `APPROVAL_REQUEST_LAPSED`, and so does no answer when the request ends before its escalation (the service granted a shorter lifetime). A permanent error gives `APPROVAL_REQUEST_FAILED`.
  - v1.16 (a correction; 1.8 said "no answer gives `APPROVAL_REQUEST_LAPSED`"): L2 asks for exactly the escalation's remaining window, so a request that lives as long as its escalation ends with `ESCALATION_EXPIRED` alone, with L2 running throughout or restarted meanwhile, and nothing is appended after a final state. The derived request state names it: `unanswered` when the escalation was marked `requested`, no entry ended its request and the escalation expired (by the clock, swept or not). `abandoned` is only a person's decision on another path while the request was open. `approvalRequestState` takes the clock for this (T-CIBA-21).
  - In every case but approval and rejection, the escalation stays pending and expires at 300 s as usual; the operator path works unchanged, and the first final state recorded wins.
- **Equivalence.** L2-2 consumes a backchannel approval or rejection exactly like an operator one, through `humanApprovedFor` and `humanRejected`. INV-12 is unchanged.
- **Never stored or shown**: the client credential, tokens, request handles (only sealed) and the service's free text, in the ledger, logs, events, responses, L1 or L3. Only whitelisted OAuth error codes are kept. v1.16: nor the owner's subject, anywhere but the one request to the approval service (T-CIBA-20); v1.17: nor the caller's token it is read from (T-CTK-07). An authorize body that can't be read (not JSON, too large) is answered 400 or 413 with a fixed message by L2's own handler, so the web framework's default handler never logs it: a body-parser error carries the raw body.

**L2-8 User accounts and the portal** (v1.10, `specs/013` data-model.md and contracts/control-api.md, portal-api.md, portal-ui.md, card-vault.md, config-and-secrets.md)

- **Off by default.** On only with `USER_ACCOUNTS=1` (CFG-2). Off, L2 answers 404 on every portal route, refuses a person's forwarded token (403 `caller_forbidden`, L2-5; v1.17) and otherwise behaves as in v1.8. v1.17: on, it needs sign-in configured at L2: with `USER_ACCOUNTS=1` and without `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS`, `main()` refuses before the ledger lock, naming the settings, and `createControlService` throws with user-account deps and no caller deps. On, startup runs env → the user-account settings and the platform config (CFG-4) are validated → ledger lock → ledger load → every recorded wallet's address is derived again and compared (L2-3) → a `PLATFORM_CONFIG` entry if the digest changed → listen. A failure before the lock never takes it, and an error names the variable or the field, never a value.
- **Three stores, one owner each.** No text a person typed ever reaches L2.

  | Store | Owner | Holds | Never holds |
  |---|---|---|---|
  | The ledger (L2-4) | L2 | users by `userId`, wallets, policies and their versions, card identifiers, account state, the platform config, every decision | names, emails, policy names, card nicknames, card details, keys |
  | The profile store, one JSON file per user (`<PROFILE_DIR>/<userId>.json`, mode 0600, written with a rename) | portal | display name (1–80 characters), contact email, policy names (1–60), the card vault's customer reference | amounts, limits, keys, card details |
  | The card vault (Stripe, test mode) | Stripe | card details, brand, last four, expiry, nickname (at most 40 characters) | anything about payments or policies |

- **User state** is derived from the ledger by pure functions (`users.ts`), like escalations; nothing else is stored. A user is `registered` (a `USER_REGISTERED` exists), `enabled` (unless the last of `USER_DISABLED` and `USER_ENABLED` is the former), has at most one `wallet`, a list of `cards` and their policies, and is `onboarded` when registered, with a wallet and at least one policy ever created. Onboarding stays complete after every policy is removed. A user is never deleted.
- **Policies.** A policy is `active`, `paused` or `removed`; removed is final. A change keeps the state and adds a version; pause, resume and remove keep the version. A change carries `expectedVersion`, and a mismatch is 409 `version_conflict` with the current policy, so two windows can't overwrite each other silently. A change to the same values, a pause of a paused policy and a removal of a removed one record nothing. A user has at most 10 active policies, a policy at most 20 sellers, and a seller is in at most one active policy of a user, so at most one policy applies to a payment. A policy past `expiresAt` is still selected and R1 denies it. While the account is disabled every policy reads as `disabled` and every policy write is refused with 409 `account_disabled`, removal included.
- **Validation of a save**, inside the serialized section, against the platform config in force. Every issue comes back together as 422 `{ error: "invalid_policy", issues: [{ field, code, host?, policyId?, limitAtomic?, limit? }] }`:

  | Code | Condition |
  |---|---|
  | `not_atomic` | an amount is not `^\d+$` |
  | `order_auto_below_cap`, `order_cap_within_session` | not `autoApprove < hardCap ≤ sessionBudget` (an auto-approve limit of `0` is valid: every payment then needs a person) |
  | `above_platform_limit` | the per-payment cap, the per-run budget or the rate is above its platform limit, or the daily budget is above the user daily ceiling |
  | `rate_invalid` | the rate is not an integer ≥ 1 |
  | `no_sellers`, `too_many_sellers`, `seller_not_listed`, `seller_conflict` | no seller, more than 20, one not on the seller list, or one in another active policy of this user |
  | `expires_in_past`, `expires_too_late` | the end is not after now, or more than `maxPolicyDays` ahead |
  | `payment_method_unsupported` | anything but `crypto_account` |
  | `policy_limit` | the user already has 10 active policies (create and resume) |

- **Loosening and step-up (SEC-21).** A save loosens when it raises any of the four amounts or the rate, adds a seller or moves the end date later. Creating a policy, resuming one and enabling an account always loosen. A loosening operation needs `identityConfirmedAtMs`, the time the person last entered their credentials, at most 15 minutes old (60 s of clock tolerance either way); otherwise 403 `{ error: "step_up_required", maxAgeSec: 900 }` and nothing is recorded. L2 makes the comparison; the portal supplies the time from the verified token's sign-in time claim (v1.12: `AUTH_TIME_CLAIM`) and never decides. v1.19: L2 reads the time from the person's own token, which the portal forwards (L2-5, SEC-35); no request carries it. Tightening, pausing, removing and disabling never need it.
- **Disable and enable.** Disabling appends `USER_DISABLED`: from the next decision on, R17 denies every payment of that user, including one whose escalation was approved before. Nothing is deleted. Enabling is a loosening operation: in one serialized section it appends `POLICY_PAUSED` (cause `account_enabled`) for each active policy and then `USER_ENABLED`, so nothing pays until the person resumes the policies they want.
- **The decision for a user payment** follows L2-5's algorithm with the user's state, the effective mandate (L2-1), the per-user context and R16, R17 and R12 (L2-2), and the user's own account (L2-3). A user who is not onboarded, is disabled, has no active policy for the seller, or names a seller taken off the seller list is DENIED; a person never pays from the platform account. v1.17: the user of a run is the one in the caller's token that L2 verified for that request (L2-5), never a value on the request; a machine caller's token names no user.
- **Cards.** L2 records only that a card with an identifier was added or removed (at most 5 per user). A card is never an input to a decision and can never pay: `paymentMethod` accepts only `crypto_account`.
- **Never stored or shown**: the mnemonic, any derived key, the card vault key, card numbers and security codes, the person's token, and in L2 any name, email, policy name or nickname.

The portal (`src/portal/`, `specs/013` contracts/portal-api.md):

- **Access (SEC-19, SEC-20; v1.12: Auth0).** Every `/api` route except `GET /api/config` needs the person's access token from the sign-in tenant, verified before the body is read and then deleted from the request. No cookie is used. Checks, in this order: signature (`<AUTH_ISSUER>.well-known/jwks.json`, RS256, or the dev issuer's file with `NETWORK=local`), `iss` exactly `AUTH_ISSUER` (a token of any other issuer, the organization's directory included, is refused), `aud` containing `AUTH_AUDIENCE` (the API's identifier, as for the agent), a non-empty `sub`, `exp`/`nbf` with 60 s tolerance: 401. Then not a machine token (`gty: client-credentials`, or a `sub` ending in `@clients`), and the client (`azp`, or `client_id`) equal to `PORTAL_CLIENT_ID`: 403. v1.14: no permission is asked for and `permissions` is not read, so whoever signs in through the portal's application may onboard (until v1.14 the permission `agent:run` was required here; v1.17: it exists again, for the agent, and gives nothing here: a token from the agent's client and a machine caller's token are both refused, 403). Then the sign-in time, the claim named by `AUTH_TIME_CLAIM` (default `https://x402.dev/auth_time`, set by the tenant's post-login Action): an integer not in the future beyond 60 s, else 401. Bodies of refusals are `{ error: "unauthorized" }` and `{ error: "forbidden" }` only, and a refused request makes no call to L2 or the card vault and writes nothing.
- **The user** is `userIdFor(issuer, sub)` from the verified token. No route takes a user identifier in its path, query or body; `:policyId` and `:cardId` are looked up for that user only, and anything else is 404.
- **Limits and headers.** JSON bodies of at most 16 KB (413), unknown fields refused (400); 300 requests per minute per client address on every `/api` route but `/api/config`, counted before the token is verified, and then 120 requests per minute per user (each 429 with `Retry-After`; `TRUSTED_PROXY_HOPS` as in L1-6); `Cache-Control: no-store` on `/api`; on every response `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a Content-Security-Policy with `default-src 'none'`, scripts from the portal itself and the card vault's script host, frames from the card vault only, connections to the portal itself, the card vault and the sign-in tenant's origin (from `AUTH_ISSUER`; never `login.microsoftonline.com`), `style-src 'self'`, `base-uri 'none'`, `form-action 'none'` and `frame-ancestors 'none'`. v1.12: no page may be framed; the v1.10 sign-in redirect page and its exception are gone, because the pop-up sign-in is answered by a web message and sessions are renewed with a rotating refresh token, never a hidden frame.
- **Routes.** Amounts come in as USDC text and are parsed exactly with `parseUsdc` (a seventh decimal is an issue on its field, never rounded); responses carry atomic strings only.

  | Method & path | Request | 200 response | Errors |
  |---|---|---|---|
  | `GET /api/config` (no token) | — | `{ auth: { mode, tenantId, clientId, scope }, network, cards: { available, publishableKey? }, admin: { available } }`: public values only. v1.15: `admin.available` says whether the administration area is on | — |
  | `GET /api/me` | — | `{ userId, enabled, onboarding: { profile, wallet, policy }, profile?: { displayName, contactEmail }, admin }`. v1.15: `admin` says whether the administration area is theirs to use | — |
  | `PUT /api/profile` | `{ displayName, contactEmail, acknowledgedTestFunds? }` | the `/api/me` body. The first save needs `acknowledgedTestFunds: true` and registers the user at L2; later edits touch only the profile file | 400, 422 `invalid_profile` |
  | `GET /api/platform` | — | `{ limits, sellers: [{ host, name }], network, asset, decimals }`; never a payee address | — |
  | `GET /api/wallet` | — | `{ account?: { address, network, asset, decimals, balanceAtomic?, balanceReadAt?, balanceStale, committedAtomic, spent24hAtomic, dailyCeilingAtomic, dailyRemainingAtomic, lowBalance }, cards, cardsAvailable, disabled }` | 409 `profile_required` |
  | `PUT /api/wallet/account` | — | the wallet view; creates the account once | 409 `profile_required`, 409 `account_disabled` |
  | `POST /api/cards/setup` | — | `{ clientSecret }` | 409 `account_disabled`, 409 `card_limit`, 503 `cards_unavailable`, 503 `card_vault_unavailable` |
  | `POST /api/cards` | `{ setupIntentId, nickname? }` | 201 `{ cardId, brand, last4, expMonth, expYear, nickname?, addedAt, expired }` | 404, 409 `card_not_confirmed`, `card_already_registered` or `card_limit`, 422 `card_expired` or `not_a_card`, 503 |
  | `DELETE /api/cards/:cardId` | — | `{ cards }` | 404, 503 |
  | `GET /api/policies` | — | `{ policies }`: every state, newest first, each a `PolicyView` plus `name` | — |
  | `POST /api/policies` | `{ name, sellers, autoApproveUsdc, perPaymentUsdc, perRunUsdc, perDayUsdc, paymentsPerMinute, endsOn, paymentMethod }` | 201, the policy | 403 `step_up_required`, 409 `wallet_required` or `account_disabled`, 422 `invalid_policy` |
  | `GET /api/policies/:policyId` | — | the policy with `history` | 404 |
  | `PUT /api/policies/:policyId` | the same input plus `expectedVersion` | the policy; a rename alone records nothing at L2 | 403 `step_up_required`, 404, 409 `version_conflict` (with `current`), `policy_removed` or `account_disabled`, 422 |
  | `POST /api/policies/:policyId/pause`, `/resume`, `/remove` | — | the policy | 403 `step_up_required` (resume), 404, 409, 422 (resume) |
  | `POST /api/account/disable` | `{ confirm: true }` | the `/api/me` body | 400 |
  | `POST /api/account/enable` | — | the `/api/me` body | 403 `step_up_required` |
  | `GET /api/admin/escalations/:authorizationId` (v1.15, `portal:admin`) | — | `AdminEscalation & { state, decision?, budget, readAt }`: L2's `EscalationDetail` without the session reference, with `mine` and the portal's clock at the read (the browser counts the time left from it) | 400 (a malformed ID), 404 |
  | `POST /api/admin/escalations/:authorizationId/approve` (v1.15, `portal:admin`) | `{}` or none | `{ ok, state: "approved", approvalId, expiresAt, already, channel, decidedBy }`. The decider and `identityConfirmedAtMs` come from the token only | 400 (a malformed ID, or any body field), 403 `own_payment`, 403 `step_up_required` (`maxAgeSec`), 404, 409 `not_pending` (`state`, `channel?`, `decidedBy?`) |
  | `POST /api/admin/escalations/:authorizationId/reject` (v1.15, `portal:admin`) | `{ reasonCode }` | `{ ok, state: "denied", rejectionId, rejectedAt, already, channel, decidedBy }` | 400 (a malformed ID, a reason outside the list, or any other field), 403 `own_payment`, 404, 409 `not_pending` |
  | `GET /api/admin/escalations/events?after\|before&limit` (v1.15, `portal:admin`) | — | `{ events, first, last, cursor, more }`: L2's page, each event without its session reference and with `mine` | 400 (a bad value, both cursors, or any other query parameter) |
  | `GET /api/admin/ledger/verify` (v1.15, `portal:admin`) | — | `{ entries, ok, brokenAt?, checkedAt }`. One check answers for 10 s, whoever asks; read-only | — |
  | `GET /api/admin/escalations` (v1.15, `portal:admin`) | — | `{ pending: AdminEscalation[], readAt }`, oldest first. An item: `{ authorizationId, referenceCode, owner: { userId?, platformAccount }, mine, resourceKey, payTo, amountAtomic, createdAt, expiresAt, approvalRequest? }`; no session reference | — |

  Every row can also answer 401, 403 and 429, and 502 `control_unavailable` when L2 can't be reached. `GET /healthz` and `GET /readyz` report health; any other path serves the built web app. `endsOn` (`YYYY-MM-DD`) becomes `expiresAt` at the end of that day, UTC. L2's issues come back under the input's field names.
- **Order of writes.** L2 first and the portal's own store second, so a failure in between never grants anything: a policy's name is kept only after L2 accepted the policy; a card is saved at the vault and then recorded at L2, and detached again if L2 refuses. The one exception is the first profile save, which writes the profile file before the registration, because the ledger entry is the one that can't be taken back; if the registration fails, the profile step stays not done and the next save retries.
- **Balance.** A read-only `balanceOf` on the network's RPC, cached for at most 20 s. When the read fails the last value is returned marked stale, and with no value at all the figure is absent, never a made-up zero. The rest of the wallet view comes from L2.
- **Cards** (`specs/013` contracts/card-vault.md). On only with `CARD_VAULT=stripe` and test-mode keys (v1.19: a restricted test key, `rk_test_…`; a secret test key is refused too); a live key stops the portal. The browser types the card into the vault's own fields; the portal creates a SetupIntent for the user's vault customer (cards only), and on confirmation checks that the setup succeeded in test mode for that customer, that it is a card, not expired and not already registered (by the vault's fingerprint, never returned), then records `cardId` at L2. Six REST calls with a pinned API version, each with a timeout and one retry under the same idempotency key. On every list the portal reconciles the vault with the ledger. A failing vault affects the card routes only.
- **Log.** One JSON line per request with whitelisted keys: time, route template, status, `userId`, duration. Never a token, a name, an email, a body or a card vault message.
- **API docs.** `docs/portal.openapi.yaml` describes these routes in OpenAPI 3.1; T-API-12..14 fail until it and the portal match. With `API_DOCS=1` the portal serves Swagger UI over it like the other services (SEC-13, T-API-15); the Azure deployment never sets it.

The web app (`web/portal/`, `specs/013` contracts/portal-ui.md) calls only the portal API and holds no credential but the person's own sign-in, kept by the sign-in library in memory and session storage.

**The administration area (v1.15, `specs/014`)**. Off unless `PORTAL_ADMIN=1` in L2 (which needs `USER_ACCOUNTS=1`) and in the portal; off, L2's `/v1/admin/*` and the portal's `/api/admin/*` are not mounted (404) and the permission `portal:admin` is not read at all.

- **Who.** Using the portal needs no permission (v1.14): every person who signs in through its client is a user. An administrator is a user whose token also carries `portal:admin`, a permission of people's API held by the tenant's role `x402-admin`, which an administrator of the tenant gives to a person by hand (`auth0/`, T-IAC-02). v1.17: people's API has two permissions and the tenant two roles, each role holding one; the other pair, `agent:run` and `x402-agent`, is the agent's and gives nothing here, and `portal:admin` gives nothing at the agent. Signing up gives it to nobody, and the organization's directory can't grant it: the portal accepts no Entra token. With the area on, `/api/admin/*` needs the permission (403, with the same body as any other refusal, before L2 is called); every other route is as in 1.14, and `GET /api/me` gains `admin`. An administrator is not a super-user: they reach no other person's profile, wallet, cards or policies, and can't change the platform limits. The hosted agent service never reads the permission.
- **What L2 keeps.** v1.19: L2 verifies the administrator's own token, forwarded by the portal (L2-5, SEC-35), and takes from it who decided (`decidedBy`, `userIdFor(issuer, sub)`), when they last entered their credentials (`identityConfirmedAtMs`, the sign-in time claim) and when they last completed a second factor (`https://x402.dev/mfa_time`), and checks `portal:admin` in it itself. Until 1.19 the portal said who decided and when, and L2 never saw the token. Inside the serialized section, in this order, L2 checks that the escalation exists (404), that it is pending (the same decision returns the first one with `already: true`; any other final state is 409 `not_pending` with the state, the path and the decider), that the decider is not the escalation's owner (403 `own_payment`; an escalation of the platform account has no owner), and, for an approval only, that the identity confirmation is at most 15 minutes old with 60 s tolerance (403 `step_up_required`, as for a loosening policy change), and (v1.19) so is the second factor (403 `step_up_required`). Then it appends one entry. A refusal appends nothing.
- **What an approval is.** Exactly an operator's: it lifts only R14, for one (session, resource, payee, amount), once, valid 600 s (a constant on this path), and the payment is evaluated again in full when the agent retries (INV-12). A rejection takes one of five reason codes and no text: nothing a person types in the portal reaches L2 or the ledger. The agent's R15 violation still carries only the rejection ID (SEC-12).
- **Reads write nothing.** The pending list, one escalation, the events and the ledger check derive their answers from the entries and the clock and never sweep; L2's own 1 s timer records expiries. The budget behind an escalation comes from the function the decision itself uses for its context (`spendFigures` in `service.ts`), under the rules in force for the owner now: the run's line, the last 24 hours under the same rules, and for a user's payment the user daily ceiling. `fits` says whether the amount is within the per-payment cap and within every line's remainder; it is no promise.
- **The portal's two halves.** A second client, `admin-client.ts`, is the only code in the portal that holds `PORTAL_ADMIN_TOKEN` and knows L2's administration paths; the administration routes never import the user-account client, and no user-account code path imports the administration one (rule A13). No administration route takes a user identifier, a session or any text: a user is reached only through an escalation's ID, and a body may carry `reasonCode` and nothing else. The browser gets each payment without its session reference, with `mine` set when it is the signed-in administrator's own. The ledger check's answer is kept for 10 s, whoever asks, because the check re-reads the whole ledger on L2's one thread. Each request is logged with the route template, the status, the administrator's `userId` and, for a decision, a fixed label; never the escalation's ID, a token or a body.
- **The web app.** Four screens under `/admin` (`specs/014` contracts/portal-ui.md): the waiting list, refreshed every 3 s while the tab is visible, with a countdown in words; one payment in any state with its budget, and the two decisions behind a confirmation (an approval asks for "Confirm it's you" when the sign-in is old; a rejection offers five fixed reasons and no text field; one's own payment has no buttons); the activity trail, 50 events at a time, asking every 5 s for what came after the last read; and the ledger check, run only on a button. An administrator who has not onboarded still reaches the area, and their own screens follow the onboarding rules as for anyone; a person who is not an administrator sees "Not found" and nothing is asked of the administration API. The web app stores nothing of its own in the browser.

- **Onboarding.** Three steps, each shown as done, next or later: the profile (name and email prefilled from the sign-in, and a required acknowledgement that the wallet holds test funds only), the wallet (one button; the address, the network and how to fund it), the first policy. A person lands on the first step not done, also from a deep link.
- **Policy editor.** Where (a checklist of the seller list; never a free-text host), how much (four USDC amounts, each platform limit shown beside its field) and how (the crypto account; cards shown as not available yet; payments per minute; an end date). Before saving, `summarizePolicy` says in plain words what the policy allows; the list and the history show the same text.
- **Saving.** Issues are mapped to their fields and listed in a summary that takes focus. On `step_up_required` the person confirms their identity (a new sign-in with `prompt=login`) and the same values are sent again exactly once. On `version_conflict` both sets of values are shown and nothing is overwritten.
- **Rules.** Amounts are atomic strings, parsed and formatted with `BigInt` only. Everything a person typed is rendered as text, never as HTML. No control moves funds out of an account. A disabled account shows a banner on every screen and disables every create and change control except the name and email. WCAG 2.1 AA: labelled inputs, announced errors, visible focus, dialogs that trap focus, usable with a keyboard alone and from 360 px wide; a state is always a word, never color alone.

### 8.3 Layer 3 — Settlement verification

**L3-1 Verifier** `verify(claim) → SettlementReport`, with the read-only viem public client on `net.rpcUrl`:

1. If `claim.requirement.amount` is not an integer string → `MISMATCH`. Otherwise `amount = BigInt(claim.requirement.amount)`. `finalityClass = finalityClassFor(amount, policy)`. `verified = {asset, payer, payTo, amount}` from the claim.
2. No `PAYMENT-RESPONSE` → `NOT_SETTLED`. If decoding fails → `NOT_SETTLED`. If `transaction` is not a 32-byte hex hash → `NOT_SETTLED`. v1.19: for a claim with a `nonce`, each `NOT_SETTLED` of steps 2 and 4 is decided by the chain instead: while the latest block's timestamp is before `validBefore + 60 s`, the seller still holds a usable authorization, so the report is `PENDING` with `settlesBy` set to that time; after it, `authorizationState(payer, nonce)` on `requirement.asset` decides: unused → `NOT_SETTLED`, used → `MISMATCH` (the transfer happened without a reported transaction; the amount keeps counting). `verified.nonce` is the claim's. A claim without a nonce (an L1 before 1.19) gets `NOT_SETTLED` as before. Otherwise continue with step 3, **whether `success` is true or false**: a facilitator's failure claim is not proof that nothing settled (INV-10). When `!success`, the report's `detail` starts with `facilitator reported failure (<errorReason>); ` before the step 3–6 outcome. (v1.2, SEC-11. A hosted facilitator can return `settlement_pending` with a broadcast hash.)
3. `settle.network ≠ requirement.network` → `MISMATCH`.
4. `waitForTransactionReceipt(hash, timeout = waitMs, polling = pollMs)`. Timeout → `PENDING`. Any other RPC error → `PENDING` with the reason in `detail` (the amount stays committed and L3-2 re-checks it). If the status is not `success` → `NOT_SETTLED`. Any other unexpected verifier error also gives `PENDING`, never a 5xx.
5. Parse ERC-20 `Transfer` logs emitted by `requirement.asset`. One log must match `from == payer`, `to == payTo` and `value == amount` (case-insensitive addresses). If none does → `MISMATCH`.
6. Wait for finality until `waitMs`. Reached → `CONFIRMED` (with `blockNumber` and `confirmations = head − block + 1`); otherwise `PENDING`.

| Finality class | Amount (atomic) | Requirement |
|---|---|---|
| `included` | ≤ 10,000 ($0.01) | the receipt exists |
| `confirmed-depth` | ≤ 1,000,000 ($1) | `head − block + 1 ≥ net.confirmationDepth` |
| `l1-safe` | > 1,000,000 | `getBlock({blockTag:"safe"}).number ≥ block` if `net.supportsSafeTag`, else depth × 5 |

Defaults: `waitMs = 45000`, `pollMs = 1000`. One deadline (`start + waitMs`) covers both the receipt wait (step 4) and the finality wait (step 6), so a call returns within about `waitMs`.

**L3-2 HTTP API** (binds to 127.0.0.1): `POST /v1/settlements` (auth `VERIFIER_TOKEN`, body `SettlementClaim`) returns a `SettlementReport`. Auth is checked first: 401 on bad auth. Then 400 when `authorizationId` is not a string or `requirement` is not an object. v1.19: after the token and before the body is read, at most 600 claims a minute per calling address (`MAX_SETTLEMENT_CLAIMS_PER_MINUTE`); beyond it 429 `{ "error": "too many requests" }` with `Retry-After`, and nothing is verified or pushed (T-LIM-02). In Azure every caller reaches L3 from the ingress's address, so the bound is L3's as a whole.
- Every report is pushed to L2 `/v1/reconcile` with `SETTLEMENT_TOKEN`, with a 5 s timeout. A failed or timed-out push is logged and does not fail the request.
- A `PENDING` report schedules re-checks (default 5 attempts, 30 s apart, timers `unref`'d; v1.19: a report with `settlesBy` is re-checked at that time plus 1 s, not every interval). Each re-check result is reconciled again. Re-checks stop at the first non-PENDING result. A new PENDING claim for the same `authorizationId` replaces the existing schedule.

### 8.4 Counterparty

**CP-1 Seller**
- `x402ResourceServer(HTTPFacilitatorClient{url: net.facilitatorUrl}).register(net.caip2, new ExactEvmScheme())`.
- Each priced route accepts one option: `{ scheme:"exact", network, payTo, maxTimeoutSeconds:120, price:{ asset: net.asset, amount, extra: net.assetDomain } }` (an explicit `AssetAmount`, not a "$" string).
- The seller does not sync with the facilitator at startup. It syncs lazily on the first priced request and retries; while the facilitator is unreachable, priced routes answer 503 and the catalog stays available.
- Facilitator failures (v1.2) map to four categories, each with its own response:

  | Category | Raised when |
  |---|---|
  | `unavailable` | timeout, network error, 5xx, malformed body |
  | `authentication` | 401 or 403 |
  | `rate-limited` | 429, or 402 from the facilitator |
  | `unsupported` | `exact` on the route's network is missing from `/supported` |

  - Before a challenge, priced routes answer 503 `{"error":"facilitator <category>","category":"<category>"}`.
  - During a paid retry, the seller answers 502 `{"error":"facilitator <category>"}` and does not serve the resource.
  - Verification rejections and settlement failures keep the SDK's x402 402 responses unchanged. A `PAYMENT-RESPONSE` passes through any transaction hash. Since `@x402/*` 2.31 the SDK's JSON body repeats the challenge's `error` (`{ "error": "Payment required" }` without a payment); it was `{}` before.
  - Every hosted facilitator call (`public`, `cdp`) has a 30 s timeout. The local facilitator keeps the SDK default.
  - Each failure logs one stderr line: `seller: facilitator <category> during <op>: <redacted excerpt>`.
- **Endpoints and monetization** (v1.7). Each endpoint is one method of `SellerApi` (`src/counterparty/seller-api.ts`) with two TC39 decorators: `@Get(path, {query})` (`endpoints.ts`) and one tier (`monetization.ts`). Every other description of a route is derived from them: `CATALOG`, the x402 requirements (`sellerRoutes`) and the Express routes. Free endpoints are mounted **before** the payment middleware and never appear in the x402 requirements; paid ones are mounted after it. `declaredEndpoints()` refuses a method with a tier but no route or a route but no tier, a second route or tier, two endpoints on one route, and a static or private endpoint; `usdc()` refuses zero, signs, exponents and more than 6 decimals; `createSellerApp` refuses a network whose asset doesn't have 6 decimals. The model, after Stripe's "What is API monetization?", is freemium discovery plus pay-per-use in tiers priced by value. x402 has no accounts, so every paid call is a single purchase:

  | Tier | Decorator | For | With L2's default mandate, an agent's purchase is |
  |---|---|---|---|
  | `free` | `@Free(description)` | discovery: no payment, answers while payments can't be taken | not a payment |
  | `pay-per-use` | `@PayPerUse({price, description})` | everyday data | auto-approved |
  | `premium` | `@Premium({price, description})` | high-value data, priced higher | escalated (above auto-approve) |
  | `enterprise` | `@Enterprise({price, description})` | bulk data, a substantial price | denied (above the per-payment cap) |

  A tier is a label with a price, not policy: L2 decides from the price (INV-5), whatever the tier says.
- `GET /api/catalog` (`@Free`) is free and is mounted **before** the payment middleware. It returns `{network, asset, decimals, items:[{path, priceAtomic, description, tier}]}` with one item per paid endpoint, in declaration order (`tier` since v1.7).
- **API docs** (v1.6). `docs/seller.openapi.yaml` describes these routes in OpenAPI 3.1, each priced route with its catalog price (`x-x402-price-atomic`). When a route, price, status, header or body changes, update this section and the document together; T-API-09 and T-API-10 fail until they match. With `API_DOCS=1` (CFG-2), `GET /docs`, `GET /docs/:asset` and `GET /openapi.yaml` serve Swagger UI over that document, mounted before the payment middleware like the catalog, from the same shared module as L2's (SEC-13). They never call the facilitator. The Azure deployment never sets `API_DOCS`.

| Route | Tier | Amount | Body (mock, deterministic) |
|---|---|---|---|
| `/api/weather?city=` | pay-per-use | 1000 | `{city, tempC, condition, source}`. `seed` = sum of the city's char codes; `tempC = seed % 35`; `condition = ["sunny","cloudy","rain","fog"][seed % 4]` |
| `/api/market-brief` | 5000 | `{headline, bullets[3], source}` |
| `/api/premium-report` | 50000 | `{title, pages:42, source}` |
| `/api/dataset-export` | 500000 | `{rows:1000000, source}` |

**CP-2 Facilitator** (only for `NETWORK=local`; the process exits otherwise)
- `src/counterparty/facilitator.ts` exports a factory `createFacilitatorApp({ account, rpcUrl, caip2 })` that takes a ready viem account and never handles key material. The entry point `scripts/facilitator.ts` loads `env/facilitator.env`, exits unless `NETWORK=local`, derives the account from `FACILITATOR_PRIVATE_KEY`, and listens on `FACILITATOR_PORT` (4022).
- `x402Facilitator().register(caip2, new ExactEvmScheme(toFacilitatorEvmSigner({...viem wallet+public actions, address}, {confirmationTimeoutMs:30000})))`.
- Endpoints: `GET /supported`, `POST /verify`, `POST /settle`. v1.19: at most 6000 requests a minute per address (429 beyond). The body is `{x402Version, paymentPayload, paymentRequirements}`. Exceptions map to 400 with an x402-shaped error body: `{isValid:false, invalidReason}` for `/verify`, and `{success:false, errorReason}` for `/settle`.

**CP-3 Base Sepolia** (v1.2): no local facilitator runs. The seller's facilitator is chosen once at startup by `facilitatorChoice(net, env)` and never changes at runtime. There is no fallback.

| `NETWORK` | `FACILITATOR` | `FACILITATOR_URL` | Result |
|---|---|---|---|
| local | unset or `local` | any | local: the override or `http://127.0.0.1:4022` |
| local | `public` or `cdp` | any | startup error |
| base-sepolia | unset or `cdp` | unset | CDP: `https://api.cdp.coinbase.com/platform/v2/x402`, every request authenticated with a fresh CDP JWT |
| base-sepolia | unset or `cdp` | set | startup error (`FACILITATOR=cdp cannot be combined with FACILITATOR_URL`) |
| base-sepolia | `public` | any | public: the override or `https://x402.org/facilitator`, unauthenticated |
| base-sepolia | `local` | any | startup error |

With `cdp`, a missing or empty `CDP_API_KEY_ID` or `CDP_API_KEY_SECRET`, or a secret that cannot sign a JWT locally, exits 1 with a fixed message that never echoes the value. Accepted secrets are base64 Ed25519, PKCS#8 PEM or SEC1 PEM; SEC1 is converted to PKCS#8. The startup log reads `seller listening on <host>:<port> (<caip2>, facilitator=<kind> host=<host>[ key=…<last 4 of key id>])`.

**CP-4 MockUSDC.sol**: ERC-20 with `name "USD Coin"`, `symbol "USDC"`, `version "2"`, 6 decimals, and an owner-only `mint`.
- EIP-712 domain: `(name, version, chainId, verifyingContract)`.
- `transferWithAuthorization` overloads for both `(…, v, r, s)` and `(…, bytes signature)`.
- `authorizationState(authorizer, nonce)`.
- Checks `validAfter < now < validBefore` and that the nonce is unused. Emits `AuthorizationUsed` and `Transfer`.
- Also exposes `DOMAIN_SEPARATOR()`. It reverts when the recovered signer is not `from`, and on insufficient balance.
- **Local only.**

**CP-5 Local accounts** (ganache mnemonic `myth like bonus … collect`): #0 deployer, #1 facilitator, #2 payer (L2), #3 seller payTo. 10 USDC is minted to #2 at startup.
- The deployment is written to `.local/deployment.json` as `{chainId, rpcUrl, asset, accounts:{deployer, facilitator, payer, sellerPayTo}, deployedAt}`. It holds addresses only, never keys, and is regenerated on every chain start.
- If the file is missing, `local.rpcUrl` falls back to `http://127.0.0.1:8545`. Anything that needs `local.asset` fails fast with a clear error.
- `localDevKeys()` (in `scripts/local-chain-lib.ts`, local only) derives the #1 and #2 keys from the mnemonic for the demo. Only `scripts/**` calls it, and the keys are never written to disk or logs.

---

## 9. Configuration

**CFG-1 Network profiles** (`networkProfile(name)`, selected by `NETWORK`, default `local`)

| Field | local | base-sepolia |
|---|---|---|
| caip2 / chainId | `eip155:31337` / 31337 | `eip155:84532` / 84532 |
| rpcUrl | from deployment, or `http://127.0.0.1:8545` | `BASE_SEPOLIA_RPC_URL` or `https://sepolia.base.org` |
| asset | from `.local/deployment.json` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| assetDomain | `{name:"USD Coin", version:"2"}` | `{name:"USDC", version:"2"}` |
| facilitatorUrl (`local` and `public` choices) | `FACILITATOR_URL` or `http://127.0.0.1:4022` | `FACILITATOR_URL` or `https://x402.org/facilitator` (only with `FACILITATOR=public`; the default choice is `cdp`, see CP-3) |
| confirmationDepth | 1 | 2 |
| supportsSafeTag | false | true |

**CFG-2 Environment, one file per process** (`ENV_FILE=env/<role>.env`, templates in `env/*.env.example`):

| File | Variables |
|---|---|
| `l1-agent.env` | `NETWORK, ANTHROPIC_API_KEY, ANTHROPIC_MODEL?, SELLER_URL, CONTROL_URL, SETTLEMENT_URL, CONTROL_TOKEN, VERIFIER_TOKEN, SESSION_ID?, SELLER_ALIAS_URL? (v1.5)`; v1.17, for the command-line agent and the smoke client (with none of them set the command-line agent forwards nothing, as before): `MACHINE_CLIENT_ID?` (a machine caller's client at the tenant; set, the process gets a machine token and forwards it), `MACHINE_CLIENT_KEY_ID?` and `MACHINE_CLIENT_KEY?` (the key's ID and its private half, PEM; read only by `src/machine-caller/token.ts`, rule A15), `AUTH_ISSUER?` and `AUTH_AUDIENCE?` (where that module asks and for which API), `CALLER_TOKEN?` (`NETWORK=local` only, `src/main.ts`: a ready-made dev machine token to forward when no machine client is set), `AGENT_URL?` and `AGENT_CANDIDATE_URL?` (`src/smoke-main.ts`: the agent's address and its candidate revision's) |
| `l1-hosted.env` (v1.5) | `NETWORK, SELLER_URL, CONTROL_URL, SETTLEMENT_URL, CONTROL_TOKEN, VERIFIER_TOKEN, MODEL_PROVIDER, ANTHROPIC_MODEL?, ANTHROPIC_API_KEY? (anthropic only), FOUNDRY_BASE_URL? and AZURE_CLIENT_ID? (foundry only), AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS (v1.17: required, where they were all three or none; the sign-in tenant's issuer, the API's identifier and the clients whose people's tokens start runs, comma-separated), no AUTH_TENANT_ID and no SERVICE_AUDIENCE (v1.17: removed; the service refuses to start when either is set, naming it and never its value), AUTH_JWKS_FILE? (local only; one issuer signs both kinds of dev token), SESSION_REF_SECRET, AGENT_PORT?, AGENT_BIND_HOST?, API_DOCS? (v1.6), API_DOCS_CLIENT_ID? (v1.17: only read with API_DOCS=1; the client the docs page signs in with, which must be on AGENT_CLIENT_IDS and needs a tenant issuer), PORTAL_CLIENT_ID? (the portal's client, only to refuse a start with it on AGENT_CLIENT_IDS), TRUSTED_PROXY_HOPS? (v1.10: 0 or 1, default 0; 1 behind the Azure ingress. Until v1.17 it took 0–3; more than one trusted proxy would let a caller's own `X-Forwarded-For` entries name its address)` |
| `l2-control.env` | `NETWORK, PAYER_PRIVATE_KEY, ALLOWED_PAYEES, ALLOWED_HOSTS, CONTROL_TOKEN, SETTLEMENT_TOKEN, OPERATOR_TOKEN, API_DOCS?`; v1.8 (L2-7): `CIBA_APPROVAL?` (`1` on), and when on `CIBA_ISSUER` (https), `CIBA_CLIENT_ID`, `CIBA_AUDIENCE`, exactly one of `CIBA_CLIENT_KEY` (RSA 2048–4096, PKCS#8 PEM) and `CIBA_CLIENT_SECRET`, and `CIBA_CLIENT_KEY_ID?`; v1.16: no `CIBA_APPROVER` (with `CIBA_APPROVAL=1` a leftover one stops L2 before the ledger lock, `CIBA_APPROVER is no longer used: remove it (SPEC L2-7)`, never printing its value; with the feature off it is only named as ignored), and `CIBA_APPROVAL=1` needs `USER_ACCOUNTS=1` (`CIBA_APPROVAL=1 needs USER_ACCOUNTS=1 (SPEC L2-7)`, also before the lock); v1.10 (L2-8): `USER_ACCOUNTS?` (`1` on; otherwise off, and the next four are ignored and only named in one log line), and when on `PORTAL_TOKEN` (different from the other four tokens), `USER_WALLET_MNEMONIC` (24 words, read only by `signer.ts`), `PLATFORM_FILE?` (default `config/platform.json`) and `PLATFORM_SELLERS?` (a JSON array that replaces the file's `sellers`); v1.15 (L2-8): `PORTAL_ADMIN?` (`1` on; it needs `USER_ACCOUNTS=1`), and when on `PORTAL_ADMIN_TOKEN` (the `portal-admin` role's token; a dev default on `local` only; it must differ from every other token); v1.17 (L2-5): `AUTH_ISSUER?`, `AUTH_AUDIENCE?` and `AGENT_CLIENT_IDS?` (all three or none; set, every authorize and budget call needs a caller's token; required with `USER_ACCOUNTS=1`), `AUTH_JWKS_FILE?` (`NETWORK=local` only: the dev issuer's keys, and `AUTH_ISSUER` must then be the dev issuer) and `PORTAL_CLIENT_ID?` (when set it must not be on `AGENT_CLIENT_IDS`, or L2 refuses to start); a missing or malformed value stops L2 before it takes the ledger lock, naming the variable and never its value; v1.19: `LEDGER_MAC_KEY?` (`off`, `<secret>` or `<entries>:<secret>`, L2-4; A16), and with `USER_ACCOUNTS=1` `PORTAL_CLIENT_ID` is required and `AUTH_TIME_CLAIM?` read (L2-5, SEC-35) |
| `l3-verifier.env` | `NETWORK, BASE_SEPOLIA_RPC_URL?, CONTROL_URL, VERIFIER_TOKEN, SETTLEMENT_TOKEN` |
| `seller.env` | `NETWORK, SELLER_PAY_TO, FACILITATOR?, FACILITATOR_URL?, CDP_API_KEY_ID?, CDP_API_KEY_SECRET?, API_DOCS? (v1.6)` (the CDP pair is required when the choice is `cdp`) |
| `facilitator.env` | `NETWORK=local, FACILITATOR_PRIVATE_KEY` |
| `operator.env` | `CONTROL_URL, OPERATOR_TOKEN` |
| `portal.env` (v1.10) | `NETWORK, CONTROL_URL, PORTAL_TOKEN, AUTH_ISSUER, AUTH_AUDIENCE, PORTAL_CLIENT_ID (v1.12: the sign-in tenant's issuer, the API's identifier and the portal's single-page client), AUTH_TIME_CLAIM? (v1.12; default `https://x402.dev/auth_time`), AUTH_JWKS_FILE? (local only), PROFILE_DIR? (default `.local/portal/profiles`), PORTAL_WEB_ROOT? (default `dist/portal-web`), CARD_VAULT? (`stripe` turns cards on), CARD_VAULT_KEY and CARD_VAULT_PUBLISHABLE_KEY (with `stripe`; test-mode keys only), BASE_SEPOLIA_RPC_URL?, PORTAL_PORT?, PORTAL_BIND_HOST?, TRUSTED_PROXY_HOPS?, API_DOCS?`; v1.15: `PORTAL_ADMIN?` (`1` turns the administration area on) and `PORTAL_ADMIN_TOKEN` (with it; the same value L2 verifies; a dev default on `local` only) |
| `pre-deploy.<env>.bicepparam`, `main.<env>.bicepparam` (v1.5, in `infra/`) | Not env files: every value the two Azure deployments use. The target (`tenantId, subscriptionId, location`), every resource name (`names`, with the resource group), the GitHub repository and environment, the app and group IDs from `pre-deploy.bicep`'s outputs, public addresses and the Claude attestation. Only `unit, imageTag, seedIp, recoverVaults, agentStableRevision` come from `deploy.yml`'s environment. Only Bicep reads them (`bicep build-params`). No secret values |

Token defaults (`dev-control-token`, `dev-settlement-token`, `dev-verifier-token`, `dev-operator-token`, and since v1.10 `dev-portal-token`) apply only when `NETWORK=local`. On any other network, a missing or empty token is a startup error. An empty token is always a startup error.
- Each entry point calls `loadEnv()`. `ENV_FILE` defaults to the process's own file (§3.1), and a caller can override it.
- Templates leave private keys empty (`# set me`).
- `API_DOCS` (L2 and, since v1.6, the hosted agent and the seller; read by `apiDocsEnabled()`): `1` mounts the docs routes (L2-5, L1-6, CP-1); unset, empty or `0` leaves them off; any other value is a startup error. v1.17: under `infra/` and `.github/` it appears only in `infra/modules/l1-apps.bicep`, as the agent's `agent.apiDocs ? '1' : '0'` (§3.1); no other template and no workflow sets it (T-API-08). `API_DOCS_CLIENT_ID` (the hosted agent only) adds the page's sign-in (L1-6).
- `npm run demo:local` gives each child only `PATH`, `HOME`, `NODE_*` and its own `ENV_FILE`. On `local`, if `env/l2-control.env` or `env/facilitator.env` is missing or the key is empty, the demo derives that key with `localDevKeys()`. It passes the payer key only to the L2 child and the facilitator key only to the facilitator child.
- The demo spawns `node_modules/.bin/tsx` directly (not `npx`) and reads each child's env file with a minimal `KEY=value` reader for its fallback decisions; only `src/shared/config.ts` uses dotenv (architecture test). On `local`, when `SELLER_PAY_TO` or `ALLOWED_PAYEES` is empty, the demo sets it to account #3 (CP-5).
- `src/portal-main.ts` (v1.10) loads `env/portal.env` and then exits 1 if `PAYER_PRIVATE_KEY` or `USER_WALLET_MNEMONIC` is visible, from the process environment or from the file, naming the variable and printing no value (as INV-3 does for L1). A missing or invalid portal setting stops it the same way.
- `npm run stack:local -- --users --admin` (v1.15) also gives the L2 child `PORTAL_ADMIN=1`; `--admin` alone is refused. `demo:local` and the VS Code launch configurations never pass it.
- `npm run stack:local -- --users` (v1.10) gives the L2 child `USER_ACCOUNTS=1` and a fixed local dev mnemonic (`scripts/demo-lib.ts`, local only). `npm run demo:local` never does, so its summary is unchanged.
- `npm run stack:local -- --sign-in` (v1.17) configures the L2 child's sign-in with the local dev issuer (`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`, `AUTH_JWKS_FILE`), and `--users` now does the same, because user accounts need it. Plain `stack:local` and `npm run demo:local` never do: the demo's L2 has no sign-in configured, its scripted agent forwards nothing, and its summary is unchanged. `scripts/vscode-local.ts` gives the command-line agent role a dev machine token (`CALLER_TOKEN`) when the L2 it targets has sign-in configured; scripts may use the dev issuer, `src/` never does.
- `main.<env>.bicepparam` (v1.10) gains the `userAccounts` object, and in v1.12 the `identity` object; `pre-deploy.<env>.bicepparam` (v1.12) loses `names.portalApp`, `portalOrigin` and `portalPreAuthorized`. v1.17: `main.<env>.bicepparam` gains the `agent` object (`clientId`, `apiDocs`, `machineClientId`, `machineKeyId`) and `names.jobs.smoke` and loses `authAudience`; `pre-deploy.<env>.bicepparam` loses `names.apiApp`, `agentUsers` and `retirePortalScope`. Neither holds a secret.
- The tenant's Terraform (`auth0/`, v1.17) gains two variables, each a variable of the GitHub environment `auth0-<env>`: `agent_origin` (`AUTH0_AGENT_ORIGIN`, default empty: the deployed agent's origin, set by hand after its first deployment and needed only where its docs page is on) and `machine_caller_keys` (`AUTH0_MACHINE_CALLER_KEYS`, default `{}`: a JSON map from a machine caller's name to the PEM of its public key). Its outputs: `bicepparam_agent` (`clientId`, `machineClientId`, `machineKeyId`, the last two those of the caller named `checks` and empty when it is not declared) for the parameter file's `agent`, and `l1_env` and the additions to `l2_env` for local env files pointed at the tenant.
- `npm run approve`, `npm run reject` and `npm run escalations` resolve their bearer token with `tokenFor("operator")`, so on `local` the dev operator token applies when `OPERATOR_TOKEN` is unset. They read only `env/operator.env` (or `ENV_FILE`).

**CFG-3 `config/mandate.json`** (all amounts are atomic strings; v1.19: every field is checked at load: `mandateId` a non-empty string, `allowedSchemes` a non-empty list of names, `allowedPayees` and `allowedHosts` lists of strings, hosts lower-cased, `maxAuthorizationsPerMinute` a whole number from 1 to 600 and `maxTimeoutSeconds` from 1 to 3600; and outside `NETWORK=local` an empty payee list, the platform account's or a listed seller's, stops L2, because R5 lets any payee through an empty one):

| Field | Default | Notes |
|---|---|---|
| `mandateId` | `mandate-poc-001` | logged on every AUTHORIZED entry |
| `expiresAt` | `2027-12-31T23:59:59Z` | R1 |
| `allowedSchemes` | `["exact"]` | R2 |
| `allowedPayees` | `[]` | R5; prefer setting `ALLOWED_PAYEES` |
| `allowedHosts` | `["127.0.0.1:4021"]` | R6; host:port |
| `autoApproveMaxAtomic` | `20000` ($0.02) | R14 |
| `hardCapPerPaymentAtomic` | `100000` ($0.10) | R10 and the SDK cap |
| `sessionBudgetAtomic` | `100000` ($0.10) | R11 |
| `dailyBudgetAtomic` | `500000` ($0.50) | R12 |
| `maxAuthorizationsPerMinute` | `10` | R13 |
| `maxTimeoutSeconds` | `300` | R8 |

Constraint: keep `autoApproveMax < hardCap ≤ sessionBudget`. Otherwise an approved escalation can never pay.

**CFG-4 `config/platform.json`** (v1.10, L2-8; read by L2 only when user accounts are on, validated before the ledger lock):

| Field | Default | Notes |
|---|---|---|
| `platformId` | `platform-poc-001` | recorded in `PLATFORM_CONFIG` |
| `limits.hardCapPerPaymentAtomic` | `100000` ($0.10) | the most any policy can allow per payment; at most `sessionBudgetAtomic` |
| `limits.sessionBudgetAtomic` | `100000` ($0.10) | the most any policy can allow per agent run |
| `limits.userDailyCeilingAtomic` | `500000` ($0.50) | the user daily ceiling, and the highest daily budget of one policy |
| `limits.maxAuthorizationsPerMinute` | `10` | integer 1–600 |
| `limits.maxPolicyDays` | `365` | integer 1–3650; a policy ends at most this many days after it is saved |
| `sellers` | `[{ "host": "127.0.0.1:4021", "name": "Local demo seller", "payees": [] }]` | the seller list: `host[:port]` as R6 compares it, unique, at most 200; `name` 1–60 characters, shown to users; `payees` lower-cased addresses, empty meaning any payee at that host |

The defaults equal the platform account's mandate (CFG-3). `PLATFORM_SELLERS` replaces `sellers` when set, as `ALLOWED_HOSTS` replaces the mandate's hosts. Schemes, networks, assets and `maxTimeoutSeconds` are not here: they come from the network profile and the platform mandate. The config's digest (SHA-256 of its canonical JSON) is recorded in a `PLATFORM_CONFIG` entry whenever it changes. A change applies to every policy at the next decision without rewriting any.

---

## 10. Wire formats (x402 v2)

| Header | Direction | Content |
|---|---|---|
| `PAYMENT-REQUIRED` | seller → L1 (402) | base64 JSON `{x402Version:2, resource:{url,...}, accepts:[PaymentRequirements], extensions?}` |
| `PAYMENT-SIGNATURE` | L1 → seller | base64 JSON `{x402Version:2, accepted, payload:{signature, authorization:{from,to,value,validAfter,validBefore,nonce}}}` |
| `PAYMENT-RESPONSE` | seller → L1 | base64 JSON `{success, transaction, network, payer, errorReason?}` |

Only use the SDK helpers to encode and decode these headers. Never hand-roll base64.

---

## 11. Security model

| ID | Threat | Control | Test |
|---|---|---|---|
| SEC-1 | Prompt injection makes the agent overspend | Agent has no signing tool; L2 rules R1–R15; budgets | T-E2E-01, T-POL-* |
| SEC-2 | Agent process compromise leaks the key | Key only in the L2 process; `main.ts` refuses to start with the key | architecture test, T-ARCH-ENV, T-AGT-KEY |
| SEC-3 | Malicious seller swaps payee or redirects | R5 payee allowlist, R6 host allowlist, R7 resource binding | T-POL-05/11 |
| SEC-4 | Seller claims payment without settling, or replays an old tx | L3 checks receipt + Transfer(payer, payTo, amount, asset) | T-E2E-03 |
| SEC-5 | Forged or contradictory settlement reports | L2 cross-check of `verified` fields; CONFIRMED is sticky; separate L3 token | T-E2E-03, T-E2E-05, T-AUTH-01/02 |
| SEC-6 | Concurrent burst bypasses limits | Serialized decisions (INV-8) | T-E2E-04 |
| SEC-7 | Audit tampering | Hash chain; startup integrity check | T-LED-01 |
| SEC-8 | Agent self-approves (or rejects) an escalation | Only the operator's token, a verified backchannel answer (v1.8) or the portal's administration token (v1.15) records a decision, and the agent holds none of them: `CONTROL_TOKEN` is refused on every deciding route; single-use, exact-match approval; one final state per escalation | T-E2E-02, T-POL-13, T-E2E-07, T-ADM-02 |
| SEC-9 | Stale signature settles late | Committed spend keeps counting until `validBefore` passes | T-LED-02 |
| SEC-10 | The CDP API credential leaks to another process, a log or a response, or a misconfiguration silently uses an unauthenticated facilitator | Seller-only credential (A8, T-ARCH-ENV); fail-closed startup; no runtime fallback; redaction | T-ARCH-A8, T-CDP-02, T-CDP-07, T-CDP-08 |
| SEC-11 | A facilitator reports failure for a transfer that actually settled, so the budget under-counts | L3 checks any reported hash on-chain (L3-1 step 2) | T-CDP-06 |
| SEC-12 | Operator free text (label, reason) reaches the LLM agent and acts as a prompt injection | The R15 violation detail carries only the rejection ID; label and reason are stored as data and shown to the operator only | T-POL-15 |
| SEC-13 | The token-free API docs routes expose more than the document, or run third-party code on the signer's origin where operators type tokens, or on the agent's or the seller's public origin, where requesters paste theirs (v1.6) | Off unless `API_DOCS=1`. v1.17: in a deployed environment only the agent can serve the page, and only where that environment's parameter file turns it on (`agent.apiDocs`, off by default); L2, the seller and the portal never serve one there. Fixed files and the document, no ledger, mandate, signer, model, session or facilitator access; Swagger UI from the pinned package, never a CDN; CSP `script-src 'self'`, `connect-src 'self'` (v1.17: plus the tenant's origin, on the agent's page with sign-in only, SEC-34) | T-API-04, T-API-08, T-API-11 |
| SEC-14 | Anyone who can reach the public agent endpoint spends from the budget | A token checked before the body is read and before any model or L2 call. v1.17: one issuer, the sign-in tenant: a person's token with `agent:run` (the role `x402-agent`, assigned by hand) from a client on the list, or a machine caller's with `agent:run`; a token of the organization's directory, or of any other issuer, is 401. Per-requester limits for both kinds, and since v1.10 a per-address limit before the token is verified; L2's budgets and rules unchanged | T-AGT-03, T-AGT-09 |
| SEC-15 | A requester continues another requester's session and uses its approvals or budget | HMAC-bound session references; a raw session ID is refused; a foreign reference → 404 | T-AGT-04 |
| SEC-16 | Secrets, requester tokens or payment headers reach logs or telemetry | Whitelisted JSON run logs; no Mastra observability or OTel export; known-value tests offline and a shape scan of cloud logs (v1.18: also the three published development mnemonics, and L2 refuses their keys outside local) | T-AGT-05, T-E2E-AZ, T-DEVKEY-01 |
| SEC-17 | A forged, replayed or swapped backchannel approval pays something nobody approved (v1.8) | L2 verifies the answer before recording it: signature through the issuer's JWKS, issuer, audience, client, validity, the escalation's owner (v1.16; before, the configured approver), the open request, the payment details field for field, single use; outcomes recorded inside the serialized section; the client credential confined to one module (A9) | T-CIBA-08, T-CIBA-10 |
| SEC-18 | Push fatigue: a prompt-injected agent escalates again and again until the person asked taps "approve" (v1.8); v1.16: or one person's agent uses up everybody's allowance | Repeats reuse the pending escalation; at most 10 approval requests per rolling hour per person (v1.16; before, for the one approver), counted from the ledger for the escalation's owner, so one person at the limit changes nothing for another; automated checks are operator-only, and a run with no user asks nobody | T-CIBA-03, T-CIBA-04, T-CIBA-19, T-E2E-10 |
| SEC-19 | A person reads or changes another person's profile, wallet, policies or cards (v1.10) | The user comes only from the verified token: no portal route takes a user identifier. L2 looks a policy up through its owner and answers 404 for another user's as for an unknown one. A profile file is read only for its own user. Each user has their own account, budgets and approvals. The portal's token opens nothing but the portal routes (A12) | T-PRT-02, T-USR-03, T-USR-11, T-USR-02 |
| SEC-20 | A token issued for one service is used at the other: the agent's at the portal, or the portal's at the agent (v1.17: or forwarded to L2) | A client allow-list each. The portal accepts only its own client; the agent accepts only the clients on `AGENT_CLIENT_IDS` and refuses to start with the portal's client among them. v1.17: L2 applies the agent's client rule to the token L1 forwards and refuses to start with the portal's client on its own list, so a portal token pays nothing even when it is forwarded; `agent:run` gives nothing at the portal and `portal:admin` nothing at the agent; the portal refuses a machine caller's token; neither service accepts a token of the organization's directory | T-PRT-01, T-AGT-07, T-CTK-01 |
| SEC-21 | A stolen or left-open portal sign-in loosens a policy | Every loosening operation needs credentials entered within 15 minutes, judged by L2; the platform limits bound what any policy can allow; the token lives in memory and session storage only; a strict CSP; typed text is never rendered as HTML | T-USR-05, T-USR-10, T-PRT-07 |
| SEC-22 | Card details or the card vault key are exposed | Card numbers and codes go from the browser to the vault only; the ledger holds an identifier, the portal's views only brand, last four and expiry; the key is a restricted test-mode key confined to one file (A10); a live key stops the portal; whitelisted logs | T-CARD-01, T-CARD-06, T-ARCH-A10 |
| SEC-23 | An intent carries a forged user, or omits it | v1.17: no request can name a user: L2 refuses `userId` on an intent and on a budget call, and takes the user from the caller's token it verified itself (SEC-32); the tools take no user input; a person who can't pay is denied and never falls back to the platform account; the platform limits bound every user and the platform mandate bounds a payment without one | T-AGT-06, T-USR-11, T-USR-06, T-CTK-03 |
| SEC-24 | The wallet mnemonic leaks, or is replaced | Read only by `signer.ts` (A3, A11) and given only to L2's container; the portal refuses to start when it can see it; never logged, stored or returned; a different mnemonic stops L2 at startup, because recorded addresses no longer match | T-ARCH-A11, T-USR-08, T-PRT-09 |
| SEC-25 | The Auth0 pipeline's credential leaks or is misused: someone changes the tenant (L2's client, its public key, the API), or tampers with the Terraform state (v1.11) | The Management API credential is held only by the GitHub environment `auth0-<env>`, read by one workflow, in its plan and apply steps only; that workflow runs by hand only, applies only the plan it showed, and may be gated by required reviewers; GitHub never holds a credential of L2's (key only). The state takes Entra sign-in only, keeps versions, and only the deploy app has a role on its container. A changed tenant can't approve a payment: L2 still verifies the approver's signed answer for the exact payment (SEC-17) | T-IAC-02, T-IAC-01, T-E2E-AZ |
| SEC-26 | Someone who should not use the portal signs up and onboards (v1.14) | The portal asks for no role, so the tenant decides who can sign in: sign-ups can be turned off on its connection, and a user can be blocked there; both by hand, neither in `auth0/`. A person who gets in reaches only their own profile, account and policies (SEC-19), holds only what they fund themselves, and never the platform account. v1.17: signing up starts no run: that needs the role `x402-agent`, assigned by hand, and a run spends a person's account only with that person's own token | T-PRT-01, T-PRT-02 |
| SEC-27 | A person who is not an administrator, or someone with an administrator's stolen or left-open sign-in, decides an escalation (v1.15) | The administration routes need the permission `portal:admin` of the sign-in tenant, held by the role `x402-admin` (v1.17: one of two permissions and two roles; the agent's `agent:run` and `x402-agent` give nothing here), which an administrator of the tenant gives by hand, and checked by the portal before L2 is called; signing up gives it to nobody; a token of the organization's directory, a machine token and an agent client's token are refused; an approval needs credentials entered within 15 minutes, judged by L2; a rejection can only stop a payment; an approval releases at most one payment that the policy and the platform limits already allow with a person's approval; no route takes a user identifier or text | T-PRT-10, T-ADM-05, T-PRT-12, T-ADM-03, T-IAC-02 |
| SEC-28 | A compromised portal approves in an administrator's name, or its user-account half reaches the administration routes (v1.15) | A separate role and token for administration, refused on every other route of L2 and held by one module of the portal (A13); `PORTAL_TOKEN` is refused on every administration route; only a pending escalation can be decided and INV-12 still holds; every decision is in the ledger with its path and decider. L2 trusts the portal to name the decider: an accepted residual risk | T-ADM-02, T-ARCH-A13, T-ADM-07, T-PRT-13 |
| SEC-29 | An administrator approves a payment of their own agent run (v1.15) | L2 compares the decider with the escalation's owner, from the `ESCALATED` entry, and refuses both decisions with `own_payment` before anything else is asked of them; the portal marks such a payment and offers no way to decide it | T-ADM-06, T-PRT-12 |
| SEC-30 | One person's answer approves another person's payment, or a caller points a person's approval request at another phone (v1.16) | The owner check, made from the signed answer alone: `userIdFor(iss, sub)` must be the user recorded on the escalation, so another person's genuine answer records `APPROVAL_VERIFICATION_FAILED{owner}` and approves nothing. The identity check, before any request is sent: the subject on the payment request must resolve to that user's one-way identifier, or nobody is asked. L2 reads the subject under its own issuer only, never one a caller names. An escalation with no user asks nobody, and there is no fallback approver. The subject is never stored, logged or returned, and a request body that can't be read is answered without being logged | T-CIBA-16, T-CIBA-17, T-CIBA-18, T-CIBA-20 |
| SEC-32 | L1's word names a user: a faulty or compromised hosted agent spends from the account of a person who did not call it (v1.17) | L1 names no user: it forwards the caller's token, and L2 verifies that token itself (signature, issuer, audience, validity, subject, the permission, the client), before the body is parsed and outside the serialized section, and takes the user from it. A request that names a user or an approval subject is refused; where sign-in is configured, so is one without a caller's token. The token is accepted only beside `CONTROL_TOKEN`, on the authorize and budget routes, and opens nothing by itself (INV-13). A person's payment is never paid by the platform account. The token goes to L2 only (A14) and is never stored, logged or returned. The token checks one address may ask for are bounded (600 a minute, 429 beyond), so a faulty agent can't make L2 verify signatures without bound | T-CTK-01, T-CTK-02, T-CTK-03, T-CTK-04, T-CTK-05, T-CTK-07, T-CTK-08, T-CTK-09, T-AGT-10, T-ARCH-A14 |
| SEC-33 | A machine caller's credential leaks, or its client does more than ask for its own token: it signs a person in, administers the portal or spends a person's account (v1.17) | Each machine caller has its own confidential client, declared by name in `auth0/`: client credentials only, `private_key_jwt` with the caller's public key, one grant for people's API with exactly `agent:run`, no callback and no secret. Its token names no user, so only the platform account pays, under the platform mandate; a token whose `sub` is not its own client's is refused, and the portal refuses every machine token. The key is confined to one module (A15) and kept in the l1 vault: never in the repository, a template, a parameter file, Terraform's state or GitHub. The pipeline starts jobs and never holds a token | T-AGT-09, T-CTK-02, T-AGT-13, T-ARCH-A15, T-IAC-02, T-IAC-01, T-E2E-AZ |
| SEC-35 | Whoever holds the portal's role token (a compromised portal, or its vault) acts for any user: creates or loosens their policies, approves any payment as any administrator, passes every step-up by claiming a fresh sign-in (v1.19) | L2 verifies the person's own token itself on every user-account and administration route (`X-Person-Authorization`): the tenant's signature, the portal's client, a sign-in time; the path's user must be the token's; the step-up time, the second-factor time and the decider come from the token, never a body; `portal:admin` is read from the token. A role token alone opens nothing there. Administrators complete a second factor on every interactive sign-in (the tenant's Action asks for one) and an approval needs it within 15 minutes. Rule A17 keeps the header on one path | T-PER-01, T-PER-02, T-ADM-05, T-ADM-14, T-ARCH-A17, T-IAC-02 |
| SEC-36 | Someone who can write the ledger file (the share is reachable from every app of the environment's subnet, over NFS without client authentication) rewrites history: drops a payment to reset a budget, or adds an approval, and recomputes every hash (v1.19) | The chain is keyed (`LEDGER_MAC_KEY`, in the l2 vault only, read by one file, A16): every entry from the point of adoption on carries an HMAC of its hash, every later one must, and the ledger may not shrink below that point; a keyed ledger never opens without its key | T-LED-09, T-ARCH-A16, T-IAC-01 |
| SEC-37 | A seller takes the money and has L2 forget it: it answers the paid request without `PAYMENT-RESPONSE`, L3 reports `NOT_SETTLED`, and the seller settles the authorization before validBefore, so no budget ever fills (v1.19) | L3 reads the authorization's nonce on-chain after validBefore before it reports `NOT_SETTLED`, and until then reports `PENDING`; L2 releases an amount only for its own recorded nonce, observed after validBefore (L2-4.1, L3-1) | T-L3-NONCE-01, T-L3-NONCE-02, T-LED-08 |
| SEC-38 | The model, a goal or a fetched page sends the agent somewhere it shouldn't go: an internal address whose answer comes back to the caller, or (through a redirect from an allowed seller) another host that receives the signed payment (v1.19) | The orchestrator fetches http(s) only and never follows a redirect; the model-driven agents fetch the seller's host only | T-L1-FETCH-01 |
| SEC-34 | The docs page's sign-in leaks a token, needs a secret, or lets the page run or contact anything but the agent and the tenant (v1.17) | The agent's client is public: authorization code with PKCE, no secret, no refresh token, and callbacks limited to the docs pages' redirect page, locally and where an environment's deployed agent serves it. The page keeps the token in memory only (a reload forgets it) and takes its sign-in addresses from the service's own settings. CSP: scripts from its own origin only, connections to its own origin and the tenant's only. The docs routes stay token-free, static and unable to reach the model, a session, L2 or L3; pasting a token still works; the page is off unless `API_DOCS=1` (SEC-13) | T-API-16, T-API-17, T-API-08, T-IAC-02 |

SEC-31 is reserved by `specs/015`'s unfinished tasks and has no row yet.

Residual risks (accepted in v1): bearer tokens over loopback instead of mTLS; key held in an env var; single-node JSONL ledger; facilitator trusted for liveness; no refund path.

Residual risks added in v1.2:
- The CDP facilitator sees each payment's payer, payee, amount, asset, resource URL and description, and applies its own compliance screening.
- A settle call that times out before any transaction hash comes back is indeterminate for every facilitator. The amount stays committed until `validBefore` (SEC-9), but a transfer that completed anyway is invisible to the ledger. A possible follow-up is an on-chain EIP-3009 nonce check (`authorizationState`).

Residual risks added in v1.3:
- The operator label is self-declared, and one shared operator token stands for every operator (EXT-7 would add per-person identity).
- The escalation reads expose session IDs, resources and amounts to the operator, which is their purpose.
- A rejection blocks a (session, resource key) for good; buying it again needs a new session. There is no undo by design.

Residual risks added in v1.5:
- The payer key is stored in Azure Key Vault, so the subscription's RBAC holders for that vault are trusted.
- Anyone allowed to start `caj-l2-eastus2-dev` or `caj-l1-eastus2-dev` holds that job's credentials, because a start can override the template. v1.17: the same holds for the smoke job, and the two L1 jobs' credentials include the machine caller's key.
- L2 and L3 are reachable from every app in the private environment. Bearer tokens, not the network, enforce each role.
- L2 runs as one instance. During a revision update or after a crash, calls get 502 for up to 30 s while the lock is handed over; L1 reports ERROR and nothing is paid.
- Requester limits are held in memory by the single agent replica. Scaling out would need shared storage.
- The deploy app trusts any run of the repository's deploy job in the `<env>` GitHub environment (OIDC). Whoever can run one of the pipelines (`deploy-*.yml`) or push one of their tags gets its rights: Contributor and Role Based Access Control Administrator (limited to `main.bicep`'s four roles) on `rg-x402-<location>-<env>`. v1.17: `Agent.Run` is gone with the API app registration; a run can start the two jobs that call the agent as the machine caller `checks`. v1.19, a correction: until 1.19 the deploy app could grant itself one of those four roles, Key Vault Secrets User, and with Contributor open a vault's firewall to itself, so a run in the environment could read every vault's secrets, the payer key and the wallet mnemonic included; Contributor can also change or start a job with another command, the operator job's included, which approves escalations. Since 1.19 the condition refuses an assignment to the deploy app itself, and `infra/github-setup.sh` limits the deploy environment to `main` and the pipelines' own `deploy-<unit>-*` tags (and `auth0-<env>` to `main`), so a branch's own workflow gets no token. What stays: Contributor can still reach a secret indirectly, by deploying an app that reads it, and anyone who can push a `deploy-<unit>-*` tag can run a pipeline on any commit. Required reviewers on both environments, and a tag ruleset, narrow this; they are set by hand.
- Deploying the Claude model accepts Anthropic's Azure Marketplace terms with the attestation in `main.<env>.bicepparam`.

Residual risks added in v1.8:
- The approval service (Auth0) is trusted to authenticate the approver, and the approver's phone is a new place where approvals happen.
- When Auth0's CIBA access token carries no `authorization_details`, the payment details are checked against the token response body, which is not signed but arrives over L2's own authenticated connection, in answer to its own poll; the evidence records which source was used.
- An LLM run of the hosted agent that strays to an item above the auto-approve limit notifies the approver once; the cap bounds it, and the deployment's hosted smoke run fails on any escalation.
- A refusal is an unsigned error answer; accepting it can only make L2 more restrictive.

Residual risks added in v1.14:
- With sign-ups on in the tenant, anyone on the internet can create an account, onboard, and take a wallet address and ledger entries (`USER_REGISTERED`, `WALLET_CREATED`). The per-address and per-user request limits bound the rate, nothing bounds the number of users, and no step in the portal approves a person. Turning sign-ups off is the tenant administrator's setting.
- Blocking a user in Auth0 stops their sign-in and renewal, not the access token they hold, which stays valid until it expires (one hour).

Residual risks added in v1.11:
- GitHub holds one credential, the Auth0 Management API application's. Whoever can change `provision-auth0.yml` on the default branch and pass the environment's protection can change the tenant's configuration. They can't approve a payment, and L2's private key is not there.
- The Terraform state's storage account has no firewall, because GitHub-hosted runners have no fixed address. Entra sign-in and one role on one container are the gate; the state holds no secret.
- The deploy app, which has Contributor on the resource group, is also the identity the Auth0 job uses for the state.
- `infra/cleanup.sh` deletes the state with the resource group and nothing in Auth0; the tenant's objects must then be deleted or imported by hand.

Residual risks added in v1.10:
- Step-up relies on the sign-in time claim in the access token being the time credentials were last entered, also after a forced sign-in and across a renewal by refresh token. Since v1.12 a post-login Action of the Auth0 tenant sets it (`auth0/sign-in-time.js`); that it behaves so is assumed from the documentation and must be checked against the tenant before `userAccounts.enabled` is set anywhere (`specs/013` quickstart §5, research R19's five checks). If the claim is missing, the portal refuses the token.
- v1.12: one provider, Auth0, stands behind people's sign-in and behind approvals (L2-7). Their clients, credentials and permissions are separate, but an outage or a compromise of the tenant touches both.
- v1.12: a role taken from a person stays in tokens already issued until they expire (one hour).
- The mnemonic sits in Key Vault beside the payer key, so that vault's RBAC holders are trusted. Losing it makes every user's test funds unreachable, and it can't be rotated in place.
- The card vault (Stripe) holds the card details and one customer per user. It gets no name, email, amount or policy, and only test-mode keys are accepted.
- Names and emails are plain JSON files on the portal's share; the subscription's holders of that storage can read them.
- The portal is a second public app. It has no key and no deciding route, and its limits are held in memory by its single replica.
- The per-address limit assumes exactly one proxy, the Azure ingress, in front of each public service (`TRUSTED_PROXY_HOPS=1`); that hop count is not yet checked against a live environment. People behind one address share its 300 requests a minute. L2 sets no proxy hops, so in Azure every caller of L2 arrives from its ingress's address: the bound on token checks (L2-5, v1.17) is in effect one for all of the agent's replicas together.

Residual risks added in v1.15:
- L2 never sees an administrator's sign-in, so it trusts the portal to name who decided and when they confirmed their identity. A compromised portal could approve pending escalations in any administrator's name. It could release only payments that the policy and the platform limits already allow with approval, one per escalation, and each is in the ledger with its path.
- A stolen administrator sign-in can approve pending escalations for as long as its last credential entry is under 15 minutes old, and reject them for as long as the session lasts.
- The portal reads `portal:admin` from the person's token and asks the sign-in tenant nothing per request. Taking the role away therefore takes effect at the person's next token: a token issued before still opens the administration area until it expires (an hour at most: `token_lifetime` in `auth0/`). Within that time such a person can reject, and can approve only with a sign-in under 15 minutes old. To cut it short, revoke the person's sessions in the tenant or block the user there, or turn the area off (T-PRT-10).
- Approvals rely on the same sign-in time claim as loosening a policy does (v1.12: set by the tenant's post-login Action). The administration area must not be turned on in an environment before that claim has been checked against its tenant (`specs/013` task T140).
- Anyone can sign up to the portal (v1.14), but signing up gives no administrator permission: the role `x402-admin` is assigned by hand, and nothing in `auth0/` or in the portal assigns it. Whoever administers the tenant decides who decides payments.
- Administrators see every user's pending payments: the seller, the amount and the user's identifier, never a name. That is their purpose.
- The portal holds two role tokens. They are separate at L2, and separate in the portal's code (A13), but one process holds both.
- User state is derived by scanning the ledger. That is measured at 100 users with 10 policies each (T-USR-12); real growth needs EXT-6.
- In Azure the web app's redirect URI is registered after the portal's first deployment, so nobody can sign in until `pre-deploy.bicep` is applied again with `portalOrigin`.

Residual risks added in v1.16:
- A person approves their own agent's spending, for every amount their policy and the platform limits allow. A prompt-injected agent's escalation is released by its own owner if they tap "approve": the phone shows the exact payment, the policy, the budgets and the platform limits are checked again at signing (INV-12), and at most 10 requests an hour reach one person.
- A compromised hosted agent can cause an approval request on a person's phone, for a payment from that person's own account. v1.17: only for a person whose token it holds, and only until that token expires, since the subject comes from the token L2 verified and no longer from a field the agent fills in. Only that person's answer approves it.
- Whoever knows a person's sign-in credentials can enroll a phone of their own where that person never enrolled one. For that person the phone is then no second factor; their policies and the platform limits bound what can be released.

Residual risks added in v1.17:
- L2 cannot tell whether the token L1 forwards is the token of the caller of this run. A compromised hosted agent can therefore spend for a person whose token it has seen, within that person's own policies and the platform limits, until the token expires (an hour at most). It can no longer spend for a person who has not called it: the v1.10 risk "the hosted agent service is trusted to name the right user" is removed.
- The agent's identity can read the machine caller's key: it reads the l1 vault, which holds `machine-client-key`, so the agent process could get machine tokens for itself. A compromised agent can therefore still request payments from the platform account, within the platform mandate, as it could before with its role token alone. No person's account can be spent without that person's token. A unit of its own for the pipeline's checks (identity, vault, image and pipeline) would close this and is not built.

Residual risks added in v1.22.1:
- Until 2026-12-17 the audit doesn't report GHSA-fc5q-39xc-vjpf (picomatch ReDoS). The finding that it can't be reached holds for `@mastra/core` 1.83.0 and the hosted agent as built. It would no longer hold if the agent got a workspace, skills or a Mastra instance (L1-6 allows no workspace and §5 no Mastra instance), or if a Mastra version built a glob from text that a request, the model or a fetched page supplies; the audit would say nothing either way. A `@mastra/core` update before that date needs the check in 1.22.1 repeated by hand. If picomatch publishes a fix, take it and remove the exception.

Residual risks added in v1.4:
- With `API_DOCS=1`, anyone who can reach L2's loopback port reads the API description without a token. It holds nothing that is not in the repository.
- "Try it out" acts on the live L2: an operator who enters a token there signs, approves or rejects for real, and the ledger keeps every entry.

---

Residual risks added in v1.19:
- The ledger's keyed chain detects a rewrite, not a cut: someone who can write the share can still remove its newest entries (no further back than the point the key was adopted), which releases what they recorded, and only the running L2's memory and the operator's own copies show it. An anchor outside the share (a signed head written somewhere L2 alone can write) would close this. The share is still reachable at the network level from every app of the environment's subnet; a storage account and an environment of L2's own would narrow that.
- The person's token reaches L2 now: a compromised L2 could replay it to the portal within its hour. L2 already holds the payer key and every user's account, so this adds little.
- An administrator without an enrolled second factor can't sign in to the portal at all once they hold `x402-admin` (the tenant's Action asks for one on every interactive sign-in). Enroll them first.
- A social connection's first sign-in doesn't run the pre-user-registration trigger, so `allow_sign_ups = false` closes database sign-ups only.
- The agent's host allow-list is the seller's host only, so a user's policy for another listed seller can't be used through the hosted agent until the list is configurable.

## 12. Test plan

| ID | File | Asserts |
|---|---|---|
| T-POL-01 | policy | a compliant $0.001 payment is AUTHORIZED |
| T-POL-02 | policy | `decide` is deterministic (deep-equal across two runs) and picks the cheapest allowed option |
| T-POL-03..10 | policy | network, asset, payee, scheme, timeout, hard cap, negative amount, decimal amount → expected rule |
| T-POL-11 | policy | resource binding mismatch; non-allowlisted host |
| T-POL-12 | policy | session and daily budgets include the new amount; the boundary passes |
| T-POL-13 | policy | escalation; a matching approval authorizes; a different amount still escalates; an approval never overrides a DENY |
| T-POL-14 | policy | velocity, expiry, empty `accepts` |
| T-POL-15 | policy | R15: a rejected (session, resource) is DENIED `human_rejected` at any amount; an approval never lifts it; it is collected with other DENY rules; the detail carries only the rejection ID. **Must fail without the rule**: the same request escalates |
| T-LED-01 | ledger | the chain verifies; editing an entry makes reload throw `integrity` |
| T-LED-02 | ledger | a NOT_SETTLED authorization is released only after `validBefore` |
| T-LED-08 (v1.19) | ledger | for an AUTHORIZED with a nonce: an early NOT_SETTLED keeps counting after validBefore; one for the recorded nonce observed after validBefore releases it; another nonce is a mismatch; an entry without a nonce keeps the old rule. **Must fail with `skipNonceCheck`** |
| T-LED-09 (v1.19) | ledger-key | `LEDGER_MAC_KEY` parsing (never repeats the value); every keyed entry has a MAC; a rewrite with every hash recomputed, stripped MACs, another key, an unkeyed entry after a keyed one, and a ledger cut below the adoption point are refused; an existing ledger is adopted as it is; a keyed ledger never opens without its key. **Must fail**: the same rewrite verifies with hashes only |
| T-LED-10 (v1.19) | ledger-lock | a live holder whose clock is two minutes behind is never taken over; an old-looking unchanged lock is taken after two heartbeats of local time; a replaced holder's next append is refused before anything is written. **Must fail with `skipLocalStaleness`** |
| T-LIM-01 (v1.19) | ledger | the operator's ledger checks are bounded per address: beyond the bound 429 with `Retry-After` and the ledger is not read; a request without `OPERATOR_TOKEN` is refused before it counts; `POST /v1/reconcile` has no such bound |
| T-LIM-02 (v1.19) | settlement-service | L3's claims are bounded per address: beyond the bound 429 with `Retry-After`, nothing verified and nothing pushed to L2; a request with a wrong token is refused before it counts |
| T-INT-01..03 (v1.19) | policy | a non-string amount, an object network, a null or array option, 21 options, a long or non-string `purpose` are 400 and append nothing; `__proto__`-like networks are denied by R3 and R4; a throwing decision is DENIED `decision_failed`. **Must fail with `skipIntentShape`** (a numeric amount signed and kept as a number) |
| T-MAN-01..02, T-APR-01 (v1.19) | policy | the mandate loader refuses a missing or fractional rate, a missing timeout or `mandateId`, a scheme string, an empty scheme list; hosts are lower-cased; outside local an empty platform payee list or an unbound listed seller stops L2; an operator approval lives at most 3600 s with a 1–64 character label. **Must fail**: NaN never trips R13; an empty list lets any payee through R5 |
| T-L3-NONCE-01..02 (v1.19) | verifier, settlement-service | a claim with a nonce and no settlement proof is PENDING with `settlesBy` while the authorization is live, then NOT_SETTLED for an unused nonce and MISMATCH for a used one; reverted transactions and failure claims wait too; a claim without a nonce is NOT_SETTLED at once; a PENDING with `settlesBy` is re-checked then, spending one attempt. **Must fail with `skipNonceCheck`** |
| T-L1-FETCH-01, T-L1-NONCE-01 (v1.19) | agent | every fetch asks for no redirect, a 3xx is an ERROR that asks L2 nothing, a redirect on the paid retry carries the payment header nowhere else; non-http(s) URLs and (with `allowedHosts`) other hosts are refused before anything is requested; the two model-driven agents set it, the scripted plan doesn't; the claim carries the decision's nonce; a long purpose is cut to 500 characters; a 2xx with PENDING `settlesBy` is PAYMENT_FAILED. **Must fail**: without `allowedHosts` an internal address is fetched |
| T-LED-03 | ledger | anomaly reports are ignored for the effective status |
| T-LED-04 | escalations | L2-4.3 state derivation and the 300 s boundary; `findRejection`, `findPendingEscalation`; the sweep appends each expiry and lapse once, also after a restart; operator views and events carry no secret-bearing keys. **Must fail without the clock check**: with no sweep, the state is already expired at 300 s |
| T-ARCH-* | architecture | rules A1–A7 (§4.1). Each fixture under `test/fixtures/arch/` trips its rule. (A8–A12 have their own rows.) v1.10: A1 and A4 also cover `src/portal/` |
| T-ARCH-ENV | architecture | each `env/*.env.example` holds only its process's variables; private keys and secrets are empty. v1.10: eight templates with `portal.env.example`; a mnemonic and the card vault key are empty |
| T-DEV-01 | vscode-local | every configuration in `.vscode/launch.json` runs through `scripts/vscode-local.ts run <role>` with tsx and child attach, or is the vitest one with `NETWORK=local`; every role is reachable; the stack's services have no pre-launch task and every L1 and operator configuration runs `local: stack` first; pre-launch tasks, compound members and `${input:…}` names resolve; no compound starts two members on the same pre-launch task. **Must fail**: another program, an unknown role, an env the runner drops, a service with a pre-launch task, an L1 configuration without `local: stack`, a missing task and a shared pre-launch task are reported. v1.10: the role `portal` and its configuration, which must run `local: stack: users` first |
| T-DEV-02 | vscode-local | `localRunEnv` gives each role its own env file and on local only its own key (the payer key to L2, the facilitator key to the facilitator, payTo to the seller), `NETWORK=local` whatever the file says, `API_DOCS`, and the debugger's attach variables; warnings name a missing model key without its value. **Must fail**: a `base-sepolia` file still runs locally, and VS Code's own `PAYER_PRIVATE_KEY`, `ANTHROPIC_API_KEY` or ports never reach a process. v1.10: with `--users` the mnemonic goes only to L2, the portal gets no key at all, and the users stack refuses an L2 that runs without user accounts |
| T-DEV-03 | vscode-local | `local: stack` (`vscode-local.ts stack`) decides per stack process: reuse it when it answers, wait for it when its port is taken (a compound starting it), start it when the port is free. Checked by hand: from nothing it starts all five; with the chain up it starts the four services; a second call reuses everything; SIGTERM and SIGHUP stop what it started; `run l2` on a taken port is refused |
| T-ARCH-TRACE | architecture | every test ID named in the §11 threat matrix (specs/007 contracts) appears in a test title; a row naming a missing test fails |
| T-ARCH-BIND | e2e | `listenControl`/`listenSettlement` bind 127.0.0.1 with `CONTROL_PORT`/`SETTLEMENT_PORT` overridden |
| T-AUTH-01 | e2e | `POST /v1/authorize` with `SETTLEMENT_TOKEN`, `VERIFIER_TOKEN` or `OPERATOR_TOKEN` → 401; the ledger is unchanged |
| T-AUTH-02 | e2e, settlement-service | `POST /v1/settlements` with `CONTROL_TOKEN` or `SETTLEMENT_TOKEN` → 401; no reconcile reaches L2 |
| T-API-01 | openapi | the operations in `docs/l2-control.openapi.yaml` equal the routes mounted on the L2 app with `API_DOCS=1`; without it, the mounted routes are exactly the operations not tagged `docs`. **Must fail**: a route missing from the document, or documented but not mounted, is reported |
| T-API-02 | openapi | for each operation, only the token of its documented security scheme passes the guard; no token and the other tokens get 401. A `security: []` operation passes for every caller. **Must fail**: a document naming the wrong token is reported |
| T-API-03 | openapi | an in-process scenario reaches every documented status except authorize's 500, and each response's media type is documented and its body conforms to the schema (required fields, types, no undocumented fields). **Must fail**: a missing field, a wrong type and an undocumented field are reported. v1.17 (T-API-01..04): the authorize and budget routes document the `X-Caller-Authorization` header, the caller's token answers (401, 403, 400) and no `userId` query, and `PaymentIntent` in the document has neither `userId` nor `approvalSubject` |
| T-API-04 | openapi | the docs routes (SEC-13): with `API_DOCS` unset, none is mounted and each docs URL answers 404; `API_DOCS` accepts only `1`, `0` or empty; the served document equals the file except `servers` = `/`; the page carries a CSP limiting scripts and requests to `'self'` and names no other origin; `/docs/:asset` serves its three files and 404s anything else. **Must fail**: the same probe gets 200 with `API_DOCS=1`; a document without `servers` is refused |
| T-API-05 | openapi-hosted | the operations in `docs/l1-hosted.openapi.yaml` equal the routes mounted on the hosted agent with `API_DOCS=1`; without it, the mounted routes are exactly the operations not tagged `docs` (v1.6). **Must fail**: a route missing from the document, or documented but not mounted, is reported. v1.17 (T-API-05..07): the document describes one issuer and both kinds of caller and nothing of the organization's directory, and the `text/event-stream` answer of `POST /v1/runs` with its four events |
| T-API-06 | openapi-hosted | without a token a secured operation answers 401 and a `security: []` one doesn't; v1.17: a person's token without `agent:run` gets 403 from a secured one; a person's token with it, and a machine caller's, pass every guard. **Must fail**: a document calling `/v1/runs` open, or `/healthz` secured, is reported |
| T-API-07 | openapi-hosted | an in-process scenario (a stub seller, fake L2 and L3, a scripted model) reaches every documented status of every operation, including 503, 413 and 429; each response's media type and documented headers (`Retry-After`) are present and its body conforms to the schema, through FREE, PAID, ESCALATED and DENIED fetches, a budget read, a tool error, and completed, stopped and failed runs. **Must fail**: a missing field, a value outside its enum, a wrong type, an undocumented field and a step mixing both tools' shapes are reported |
| T-API-08 | openapi-hosted | the agent's docs routes (SEC-13): with `API_DOCS` unset, none is mounted, and each docs URL answers 401 without a token and 404 with one; `API_DOCS` in `l1-hosted.env` accepts only `1`, `0` or empty; v1.17: under `infra/` and `.github/`, `API_DOCS` appears only in `infra/modules/l1-apps.bicep`, as the expression that takes it from `agent.apiDocs` (before, no file there set it); the served document equals the file except `servers` = `/`; the page carries the same-origin CSP; `/docs/:asset` serves its three files only (v1.17: with sign-in configured the document, the policy and the assets differ as T-API-16 says). **Must fail**: with `API_DOCS=1` the same probe gets 200 with no token and makes no model, L2 or L3 call; a document without `servers` is refused |
| T-API-09 | openapi-seller | the operations in `docs/seller.openapi.yaml` equal the routes mounted on the seller with `API_DOCS=1`; without it, exactly the operations not tagged `docs`; each operation's `x-monetization-tier` and `x-x402-price-atomic` equal its declared tier and price (none when free), and every declared endpoint is documented (v1.6; tiers v1.7). **Must fail**: a missing route, an unmounted route, a wrong price, a wrong tier and an undeclared operation are reported |
| T-API-10 | openapi-seller | an in-process scenario with a scripted facilitator behind the real categorized client reaches every documented status of every route: 200 paid, 402 (no payment, a rejected payment, a payment for another route, a failed settlement), 502 (facilitator failing mid-payment) and 503 (facilitator down); bodies, media types and required headers conform, and the `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` headers, decoded with the SDK, conform to their `contentSchema`, as does the payment sent. **Must fail**: a wrong enum value, a missing field, an undocumented field and a wrong `x402Version` are reported |
| T-API-11 | openapi-seller | the seller's docs routes (SEC-13): with `API_DOCS` unset, none is mounted and each docs URL answers 404; the seller refuses to start with any other value than `1`, `0` or empty; `sellers.bicep` never sets it; the served document equals the file except `servers` = `/`; the page carries the same-origin CSP; `/docs/:asset` serves its three files only. **Must fail**: with `API_DOCS=1` the same probe gets 200 and makes no facilitator call; a document without `servers` is refused |
| T-MON-01 | seller-monetization | the seller declares `/api/catalog` free, weather and the market brief pay-per-use, the premium report premium and the dataset export enterprise, at unchanged prices, and no higher tier costs less than a lower one; `sellerRoutes` holds exactly the paid endpoints with their declared price and description, and `CATALOG` their paths and tiers; with the facilitator down the catalog answers 200 and every priced route 503 (v1.7) |
| T-MON-02 | seller-monetization | `usdc()` converts decimal USDC to atomic units with BigInt (`0.001` → `1000`, `12.345678` → `12345678`). **Must fail**: zero, more than 6 decimals, signs, exponents, blanks and hex are refused |
| T-MON-03 | seller-monetization | declaration mistakes are refused while the seller is built: **must fail** on an endpoint without a tier or without a route, two tiers, two routes, two endpoints on one route, a static endpoint, a path with a query, an empty description and a network whose asset doesn't have 6 decimals; an undecorated method is a helper, not an endpoint |
| T-AGT-01 | agent | fake model → tool calls → intents carry `purpose`; the tool result contains PAID + CONFIRMED; exactly two tools are offered |
| T-AGT-KEY | agent | spawning `src/main.ts`, or `src/hosted-main.ts` with the key in the process env or only in `ENV_FILE` (v1.5), with `PAYER_PRIVATE_KEY` set exits 1 with a refusal (the automated form of the manual check below) |
| T-AGT-02 | hosted-agent | every model call offers exactly `fetch_resource` and `check_budget` with the L1-3 descriptions and schemas; 2048 max output tokens; 10 steps; both providers' HTTP requests (Foundry: Entra bearer, no `x-api-key`); config rules. **Must fail**: an injected extra tool appears as a third name; an unrecognized model id is refused |
| T-AGT-03 | hosted-access | v1.17, rewritten for one issuer: 401 for missing, invalid, expired or wrong-audience tokens and for an issuer the service does not know, a token of the organization's directory included; 403 without the permission, for a person and for a machine caller; each refusal under 1 s with 0 model and 0 L2 calls; 2 concurrent and 20 hourly runs per requester (429 with `Retry-After`); L3 never sees the requester's token, and L2 only on the gate's two calls (T-AGT-10). **Must fail**: with `bypassAuth`, an unauthenticated run, or one with a directory-shaped token, reaches the model. v1.10: a caller without a valid token is limited per address before any token is verified; **must fail** with `skipAddressLimit` |
| T-AGT-04 | hosted-sessions | a reference continues its requester's session; another requester's use → 404; a raw `sess_…` or malformed reference → 400; a tampered or non-canonical MAC → 404. **Must fail**: with `skipSessionMac`, requester B uses requester A's session. v1.17: extended for a machine caller |
| T-AGT-05 | hosted-run | response shape; the 200 s deadline (a fetch in progress completes, no model call after); step limit; body limits; readiness; failure keeps finished steps; run-log lines are whitelisted JSON and planted secrets never appear; the cloud scan's credential shapes |
| T-USR-01 | users | every portal route of L2-5: its happy path and each listed error; reads of the platform and of an unknown user; registration, wallet, cards and the account; a fresh wallet's figures; no response or ledger line holds the mnemonic or a key; a card never changes a decision |
| T-USR-02 | users | role isolation (INV-13): the portal token is refused on every deciding, approving and reconciling route; no token and each other token is refused on every portal route; 401 precedes 400 |
| T-USR-03 | users | ownership: another user's policy ID is 404 on every route, like an unknown one. **Must fail**: with `skipOwnershipCheck`, user A reads user B's policy |
| T-USR-04 | users | idempotency: registration, the wallet (ten concurrent calls create one account), card add and remove, pause, remove, and a change to the same values |
| T-USR-05 | users | loosening and step-up: creating, each raise, an added seller and a later end date loosen; fresh means at most 15 minutes, with 60 s tolerance; tightening never needs it; a stale time is 403 and appends nothing |
| T-USR-06 | users | off by default: every portal route is 404. v1.17: a `userId` on an intent is 400, on or off (before, off it changed nothing and only a malformed one was 400), and off, no person's payment is decided (T-CTK-01, T-CTK-03) |
| T-USR-07 | users | L2's settings and CFG-4: on without a token, a mnemonic or a valid platform file refuses to start before the lock, naming the setting only; equal tokens are refused; off ignores them; each platform rule; `PLATFORM_SELLERS`; the digest, and `PLATFORM_CONFIG` once per digest |
| T-USR-08 | users | the keyring (L2-3): one account per index on the standard path; an invalid phrase is refused without echoing it; a changed mnemonic stops L2 once the ledger is loaded |
| T-USR-09 | users | pure: user state, the policy state machine and history, every validation code, all issues together, the limits; through the routes: versions, version conflict, pause, resume, remove, and a resume that re-validates |
| T-USR-10 | users | pure: policy selection and the effective mandate (one policy per seller, no policy, an unlisted seller, platform limits tightened after the save); through L2: one policy per seller, the platform bound and the flags. **Must fail**: with `skipSellerOverlapCheck` two active policies list one seller; with `skipPlatformBound` a payment above the platform cap is AUTHORIZED |
| T-USR-11 | users | decisions for users: AUTHORIZED by the user's own account and recorded with user and policy; ESCALATE; DENIED by today's rules; not onboarded and disabled; payees from the seller list; the budget view; isolation between users and from the platform account; changes apply at the next decision; the user daily ceiling across two policies; an approval after a tightening or a disable is denied; a change during a decision lands after it. **Must fail**: `sharedSigner`, `sharedBudgets`, `fallbackToPlatform`, `skipUserGate` and `unserializedUserWrites` |
| T-USR-12 | users | scale: with 100 users and 10 policies each, a user decision adds under 50 ms to a platform one. Also in this file: the ledger alone rebuilds who paid under which policy version from which account, and the operator's views and CLI name the user |
| T-POL-16 | policy | R16 `user_not_onboarded`: evaluated first, returns at once with a fixed detail that names no missing step |
| T-POL-17 | policy | R17 `user_disabled`: the same shape, and no approval lifts it. **Must fail without the rule**: the same request is AUTHORIZED |
| T-POL-18 | policy | the user daily ceiling denies with `daily_budget_exceeded` although the policy's own budget passes; one violation at most; collected with the other DENY rules. **Must fail without the ceiling** |
| T-POL-19 | policy | without `ctx.user`, and with a user who has no gate and room under the ceiling, every rule gives the v1.8 result; the engine is still deterministic |
| T-LED-06 | ledger | each of the 12 new entry types appends, hashes and verifies after a reload; `committedAtomic`, `authorizedSince` and `findOpenApproval` with an owner: a user's entries, the platform account's, or all; a released authorization stops counting for its owner only |
| T-AGT-06 | hosted-access | v1.17, rewritten for one issuer: the service never names the user a payment is for: no intent and no budget call carries a `userId`, for a person's run or a machine caller's; neither the goal text nor a tool input can name a user; the tools' input schemas are unchanged. The user is L2's to take from the forwarded token (T-AGT-08, T-CTK-02) |
| T-AGT-07 | hosted-access | a portal token is refused by the agent service (403, no model or L2 call), with or without `PORTAL_CLIENT_ID`, as is any client not on `AGENT_CLIENT_IDS`; the agent's own tokens still run, in either token dialect; the service refuses to start with the portal's client on its list. **Must fail**: with `skipClientCheck`, a portal token starts a run. v1.17: rewritten for one issuer; the refusal holds with or without the role |
| T-AGT-08 | hosted-access | v1.17 (the ID was reserved by `specs/015`): a person's run sends intents with no `userId` and no `approvalSubject`, and forwards the caller's token |
| T-AGT-09 | hosted-access | v1.17: the five tokens: the role and the agent's client start a run; no role is 403; the portal's client is 403; a directory-shaped token from another issuer is 401; any other issuer is 401. A machine caller's token with the permission starts a run and one without is 403; an administrator of the portal without the agent role is 403. Each refusal makes no model call and no gate call |
| T-AGT-10 | hosted-access | v1.17: the caller's token reaches the gate's `authorize` and `budget` calls of that run and nothing else: not the settlement port (L3), the model's prompt or a tool input, a step, the answer, a log line or a second caller's run. **Must fail**: a server that hands the token to the settlement port is caught |
| T-AGT-11 | hosted-stream | v1.17: with `Accept: text/event-stream` the events arrive as `run`, `text`, `step` in completion order, and `result` last with nothing after it; `result` equals the JSON answer of the same scripted run in every field but `runId` and the times; a refusal (401, 403, 429, 400, 413, an unknown session) is the same JSON with the same status; without the header the answer is JSON; a `: keep-alive` line after 15 s of silence (clock injected); the response headers of L1-6 |
| T-AGT-12 | hosted-stream | v1.17: a disconnect aborts before the next step and a paid fetch in progress completes; the deadline and a model error end in `result` (`stopped` with `deadline`, `failed` with `error`); the stream carries no token and no tool input beyond `url` and `purpose` |
| T-AGT-13 | smoke-client | v1.17: against a fake agent, the smoke client exits 0 only when the run completed, `/api/weather` and `/api/market-brief` are `PAID` and `CONFIRMED`, nothing is `ESCALATED` and it took 120 s or less; it uses the candidate address when its `/healthz` answers and the agent's otherwise; its output holds the duration and the outcome and never the token |
| T-AGT-14 | hosted-agent | v1.17, settings: `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` are required; `AUTH_TENANT_ID` or `SERVICE_AUDIENCE` is refused by name, its value never printed; the portal's client on the list is refused; an `API_DOCS_CLIENT_ID` that is not on the list is refused |
| T-CTK-01 | caller-token | v1.17, L2's order of checks on authorize and budget (L2-5), each row in order: 401 `unauthorized` before the header is read; `caller_token_required`; `caller_token_not_accepted` when sign-in is not configured; `caller_token_expired`; `caller_token_invalid`; `caller_forbidden` without the permission, for a client off the list, for the portal's client and for a person with user accounts off; the ledger's length is unchanged after each. **Must fail**: with `skipClientCheck`, a portal-client token pays |
| T-CTK-02 | caller-token | a person's token decides under that person's policy and signs with their account; a machine caller's token names no user and the platform account signs; a person's payment is never signed by the platform account |
| T-CTK-03 | caller-token | a body with `userId` or `approvalSubject` is 400, and a budget call with `?userId=` is 400. **Must fail**: with `trustIntentUser`, a request naming Bob with Alice's token is signed by Bob's account |
| T-CTK-04 | caller-token | the caller's token without the role token is 401 on both routes and on one other route: it opens nothing by itself (INV-13) |
| T-CTK-05 | caller-token | where sign-in is configured a request without the header is refused; where it is not, a request without it decides for the platform account. **Must fail**: with `skipRequired`, a request with the role token alone is paid by the platform account |
| T-CTK-06 | caller-token | startup: user accounts on without sign-in, the portal's client on the list and `AUTH_JWKS_FILE` outside local each refuse, naming the variable and never its value |
| T-CTK-07 | caller-token | a planted token is found nowhere: the ledger file, every response body, the events route and captured console output, also for a body that is not JSON. **Must fail**: with `echoCaller`, the scan finds it |
| T-CTK-08 | caller-token | the token is verified before the serialized section: a key fetch that never returns blocks only its own request, and a second request with a known key is decided meanwhile |
| T-CTK-09 | caller-token | the token checks are bounded per calling address, for authorize and budget together: beyond the bound both answer 429 with `Retry-After`, for a good token, a bad one, none and a body that is not JSON, with no key looked up and nothing appended; a request without `CONTROL_TOKEN` does not count; other routes answer as before; with no sign-in configured nothing is bounded. **Must fail**: with `skipLimit`, every call is verified and decided |
| T-API-16 | openapi-hosted | v1.17, with sign-in configured on the agent's docs page (SEC-34): the served document has the `auth0` OAuth2 scheme with the tenant's two addresses; the initializer names the client, PKCE and the audience and does not persist; `oauth2-redirect.html` and `oauth2-redirect.js` are served and no other asset is added; the policy's `connect-src` is `'self'` and the tenant's origin only, with `script-src 'self'` |
| T-API-17 | openapi-hosted | v1.17: without it (no `API_DOCS_CLIENT_ID`, or the dev issuer) the page, the document and the policy are as before: the bearer scheme only and no origin but its own |
| T-PRT-01 | portal | access: each check of L2-8's list gives 401 or 403 with a fixed body, no call to L2 and nothing written; an agent-service token is refused on every route, and a token of the organization's directory is 401 (v1.12); v1.14: a person whose token has no permission, or another one, gets in and onboards under their own identifier, and another client's token is refused with the permission or not; 429 on the 121st request in a minute; a caller without a valid token is limited per address before any token is verified, per client address behind a trusted proxy and ignoring `X-Forwarded-For` without one. **Must fail**: with `bypassAuth`, an agent-service token reaches a route; with `skipAddressLimit`, token-less requests are never limited. v1.18: behind the proxy, entries a caller writes before the proxy's own never reset its count |
| T-PRT-02 | portal | a person reaches only their own data: another person's policy ID is 404 on every route; no route takes a user identifier. **Must fail**: with L2's `skipOwnershipCheck`, one person reads another's policy through the portal |
| T-PRT-03 | portal | the profile: validation by field, the acknowledgement, the first save writes the file and then registers, later edits write nothing to L2; the store builds a path only from a user identifier |
| T-PRT-04 | portal | the wallet view: one account, the balance with its read time, the stale path, an unreadable balance is absent and never zero, `lowBalance`, no key anywhere |
| T-PRT-05 | portal | policies: USDC text becomes exact atomic amounts, a seventh decimal is refused on its field and nothing reaches L2, issues come back under the input's names, step-up relay, `expectedVersion` and the version conflict, a rename records nothing at L2, the history; the platform view never holds a payee |
| T-PRT-06 | portal | L2 unreachable: every route that needs it answers 502 and nothing is granted; a first profile save completes on the next try |
| T-PRT-07 | portal | headers on every response: the CSP, `nosniff`, `no-referrer`, `no-store` on `/api`; the redirect page may be framed by this origin only; body limits; the built web app is served for any other path |
| T-PRT-08 | portal | the log holds whitelisted keys only, and no token, name, email or policy name appears in it; the ledger and L2's answers never hold a name, an email or a policy name |
| T-PRT-09 | portal | configuration: defaults, each error names the variable and never a value, the sign-in tenant's settings; the entry point exits 1 when a payment key is visible. v1.18: `TRUSTED_PROXY_HOPS` is 0 or 1 |
| T-CARD-01 | card-vault | configuration: unset is off; `stripe` with test keys is on; a live key, a missing key or another vault refuses startup; the vault's address and version are constants; with cards off every card route answers 503 `cards_unavailable` |
| T-CARD-02 | card-vault | adding a card: the wallet lists brand, last four, expiry and nickname, and the ledger holds an identifier only; each failed check adds no card and detaches what the vault saved; another person's setup answers like an unknown one; a live-mode answer is refused; confirming twice records once |
| T-CARD-03 | card-vault | a duplicate card is refused and detached; a sixth card is refused before a setup starts, by L2 too, and by a setup started earlier |
| T-CARD-04 | card-vault | remove detaches at the vault and then records it; an expired card is flagged; the list reconciles an interrupted add and a card removed outside the portal; a card L2 refuses is detached; removal works while disabled |
| T-CARD-05 | card-vault | a failing vault affects cards only: the wallet still shows the account; one transient failure is retried once with the same idempotency key; failures keep only whitelisted codes |
| T-CARD-06 | card-vault | only the six calls, with the pinned version, a bearer key and idempotency keys; no name, email, amount, seller, policy or address is sent; a known-value scan finds no key, client secret, fingerprint, vault identifier or vault text in logs, responses or the ledger |
| T-API-12 | openapi-portal | the operations in `docs/portal.openapi.yaml` equal the routes mounted on the portal with `API_DOCS=1`; without it, exactly the operations not tagged `docs`; no operation takes a user identifier. **Must fail**: a missing or unmounted route is reported |
| T-API-13 | openapi-portal | no token gets 401, an agent-service token 403, the person's portal token passes; open routes need none. **Must fail**: a document calling a protected route open, or the reverse, is reported |
| T-API-14 | openapi-portal | a scenario reaches every documented status, the generic ones included (502, 429, 413, 503), and each body conforms to its schema. **Must fail**: an undocumented field, a missing field and a wrong type are reported |
| T-API-15 | openapi-portal | the portal's docs routes (SEC-13): off by default, each docs URL 404; the served document equals the file except `servers`; the page keeps its same-origin policy. **Must fail**: the same probe sees every docs URL with `API_DOCS=1` |
| T-WEB-01 | web/portal/test/onboarding | routing by onboarding status: the first step not done, deep links redirect, an onboarded person stays where they asked; a 403 shows the refusal and no form, a 401 the sign-in |
| T-WEB-02 | web/portal/test/onboarding | the profile step: prefill from the sign-in, validation, Save disabled until the acknowledgement is ticked, the server's issues by field |
| T-WEB-03 | web/portal/test/money | amounts in the browser: six decimals accepted, a seventh refused and never rounded, the same answers as `parseUsdc`, exact round-trips beyond a double's range; no source file does floating-point arithmetic on an amount |
| T-WEB-04 | web/portal/test/policy | `summarizePolicy`: the contract's example word for word, the zero auto-approve case, several sellers, no rounding |
| T-WEB-05 | web/portal/test/policy | the editor: only the seller list, each platform limit as helper text, issues on their fields and in a summary that takes focus, an empty seller list shows no form; `step_up_required` confirms identity and sends the same values exactly once, and a second refusal is never retried; a version conflict shows both sets of values and overwrites nothing; the list's states as words, its actions and the history; the flags for a platform limit and a seller no longer listed |
| T-WEB-06 | web/portal/test/wallet | the wallet step and screen: one button, the address, how to fund it, the figures, no control that moves funds out; the card notice always present; Add a card disabled with its reason at 5 cards, when unavailable and when disabled; the vault's fields and only a setup reference and a nickname reach the portal; a vault failure leaves the page working; Remove asks first; in the editor a card can't be chosen. In `account.test.tsx`: disable asks first, the banner on every screen, every create and change control disabled, name and email still editable, enabling says the policies are paused |
| T-WEB-07 | web/portal/test/safety | no source file can inject HTML or run text as code; a name, policy name or nickname containing markup renders as text; no source file names a platform secret or keeps a token itself; the token travels only in the `Authorization` header and no call carries a user identifier. v1.12: the Auth0 adapter's set-up (public client, rotating refresh tokens, no hidden frame), its session-storage cache, error codes only, and a confirmation by another person signs both out |
| T-WEB-08 | web/portal/test/a11y | an axe pass on every screen in its main states, with dialogs, errors, the step-up prompt and a version conflict, reports no violation (and reports an unlabelled field when one is planted); every text color of the stylesheet has a contrast of at least 4.5:1 on its backgrounds; onboarding is completed with the keyboard alone |
| T-ARCH-A10 | architecture | rule A10 (v1.10) trips on its fixture, for the key and for the vault's host; the tree is clean; the publishable key never trips it |
| T-ARCH-A11 | architecture | rule A11 (v1.10) trips on its fixture and the tree is clean |
| T-ARCH-A12 | architecture | rule A12 (v1.10) trips on its fixture and the tree is clean: no layer names the portal's token, and the portal names no other role's secret |
| T-E2E-12 | e2e | two users on the local chain: each payment is signed by, and settles from, its own user's account, and the platform payer's balance is untouched; an account that can't cover a payment is refused by the facilitator and nothing is spent |
| T-E2E-13 | e2e | disable and enable through the portal and the chain: an escalation approved after the disable is denied; after enable the policy is paused; after resume it pays once |
| T-ADM-01 | admin | each administration route's answer and every listed error; 401 before 400, 403, 404 and 409; unknown body fields and query parameters refused; the ledger check equals the operator's and repairs nothing |
| T-ADM-02 | admin | the sixth role: no other token opens an administration route, and `PORTAL_ADMIN_TOKEN` opens nothing else (authorize, budget, reconcile, the operator's routes, the user-account routes). **Must fail with `singlePortalRole`**: the user-account token reads the list |
| T-ADM-03 | admin | a portal approval: the entry's exact fields; the effect of an operator's (one payment, once, 600 s); a paused policy, a disabled account or a used-up budget after it still denies (INV-12) |
| T-ADM-04 | admin | a portal rejection: the entry's exact fields; R15 denies the same purchase and the agent sees only the rejection ID; the five reason codes and nothing else |
| T-ADM-05 | admin | identity confirmation for approvals: the 15 min and 60 s boundaries (v1.19: to the second of the token's sign-in time; one in the future beyond the tolerance is 401 `person_token_invalid`); none for a rejection. **Must fail with `skipDecisionStepUp`** |
| T-ADM-14 (v1.19) | admin | an approval needs the token's second-factor time at most 15 minutes old (none or an old one is 403 `step_up_required`); a rejection needs none. **Must fail with `skipDecisionMfa`** |
| T-PER-01..02 (v1.19) | person-token | L2's own check of the person's portal token: the role token alone is 401 `person_token_required` on every user and administration route (the platform view excepted); another person's token is 403 `person_mismatch`; an agent client's, a machine or a timeless token is refused; the step-up time is the token's, and a body naming one is 400; an administration route needs `portal:admin`; the decider is the token's person, so the own-payment check can't be dodged. **Must fail with `skipPersonCheck`** |
| T-ADM-06 | admin | nobody decides their own payment, checked before the identity confirmation; a platform-account escalation has no owner. **Must fail with `skipOwnPaymentCheck`** |
| T-ADM-07 | admin | one final state across the portal, the operator and the backchannel stand-in, in both orders; repeats; the 300 s boundary; 25 simultaneous pairs; a portal decision ends the 120 s wait. **Must fail with `skipPendingCheck`**: an approval is recorded after a rejection |
| T-ADM-08 | admin | the reads: the pending list at the 300 s boundary without an expiry entry; the escalation in any state; budget lines equal to the ledger's own figures, the agent's budget read and the user's wallet view; `fits` at the limit and one unit over; `applies: false`; no read appends |
| T-ADM-09 | admin | events in pages: `after`, `before`, neither; walking the trail both ways yields every event once, in order; the owner and reference on every event; bad queries refused |
| T-ADM-10 | admin | configuration: `PORTAL_ADMIN=1` without `USER_ACCOUNTS=1`, without its token off `local`, or with a token equal to another role's refuses before the lock, naming the setting only; off, every route is 404 |
| T-LED-07 | escalations | the portal channel in the derivations: `channelOf`, events with the decider and the reason code and no free text, `abandoned` phone requests, no secret-bearing key. Also in this file: the operator's two decision routes pinned field by field (FR-019 of `specs/014`) |
| T-PRT-10 | portal-admin | access by permission: a user without `portal:admin` is 403 with no call to L2; an administrator is a user like any other and `/api/me` says `admin: true`; no other permission counts, nor a `roles` claim, a machine token, an agent client's token or a token of the organization's directory; a permission taken away is refused at the next token; off, 404 and the permission is not read. **Must fail with `skipAdminCheck`**: an ordinary user approves |
| T-PRT-11 | portal-admin | the reads through the portal: `mine`, the owner, no session reference; query whitelist; the detail's budget unchanged; text an operator typed returned as the same plain string; 502 when L2 is down; one ledger check per 10 s |
| T-PRT-12 | portal-admin | decisions: the decider and `identityConfirmedAtMs` come from the token only; any other body field is 400 before L2 is called; `own_payment`, `step_up_required` and `not_pending` relayed with their fields |
| T-PRT-13 | portal-admin | the log: the route template, the status, the administrator's `userId` and a fixed label per outcome; never an escalation ID, a token or a body |
| T-PRT-14 | portal-admin | configuration and flags: off unless `PORTAL_ADMIN=1`; on without its token off `local` refuses, naming the variable; `/api/config` and `/api/me` |
| T-WEB-09 | web/portal/test/admin | who sees the area: the link only for an administrator; an administrator who has not onboarded reaches the area while their own screens stay behind onboarding; anyone else gets "Not found" and no administration request; onboarding never stands in the way |
| T-WEB-10 | web/portal/test/admin | the waiting list: the table, the countdown on the portal's clock in words, the 3 s refresh, nothing asked while hidden, the live region, outside text shown as text |
| T-WEB-11 | web/portal/test/admin | one payment: what is decided repeated before sending; the step-up replay from a click; five fixed reasons and no text field; one's own payment; any state with its outcome; the budget table and its warnings |
| T-WEB-12 | web/portal/test/admin | the activity trail (pages, polling, the "New" mark in memory, nothing stored in the browser), the ledger check, and an axe pass over the four screens. Also `poll.test.ts`: the visibility-aware interval |
| T-ARCH-A13 | architecture | rule A13 (v1.15) trips on its fixture three ways and the tree is clean: the portal's two halves stay apart |
| T-ARCH-A14 | architecture | rule A14 (v1.17): the header's name appears in `src/` only in `src/layer1-intent/ports-http.ts` and `src/layer2-control/caller.ts`, and `forCaller(` is called only in `src/layer1-intent/hosted/server.ts` and `src/main.ts`. **Must fail**: a second file that names the header is reported |
| T-ARCH-A15 | architecture | rule A15 (v1.17): `MACHINE_CLIENT_KEY` and `MACHINE_CLIENT_KEY_ID` are named in `src/` only in `src/machine-caller/token.ts`, and nothing under a layer folder imports `src/machine-caller/` |
| T-ARCH-A16 (v1.19) | architecture | rule A16: `LEDGER_MAC_KEY` is named only in `src/layer2-control/ledger-key.ts` and `env/l2-control.env.example`; it must be empty in any template. **Must fail**: its fixture is reported |
| T-ARCH-A17 (v1.19) | architecture | rule A17: the person's header, `x-person-authorization` in any case, is named in `src/` only in `src/portal/person-context.ts` and `src/layer2-control/person.ts`. **Must fail**: its fixture is reported |
| T-ARCH-SWITCH | architecture | v1.18: no must-fail switch (`skip…`, `bypass…` and the others of §16) is turned on with a literal in `src/`, `scripts/` or the web app, or read from the environment there, or named in an env template, a workflow, an infrastructure file or a Dockerfile; forwarding a caller's own switch (`...(deps.x && { x: true })`) is allowed. **Must fail**: a literal `true`, list or set, an environment read and a deployment file's variable are each reported |
| T-BODY-01 | body-limits | v1.18: on `POST /v1/reconcile`, `/v1/approvals/:id` and `/v1/rejections/:id` a 64 KB body without the route's token, or with another role's, is 401, never 413, and nothing is appended |
| T-BODY-02 | body-limits | v1.18: on the same routes over 16 KB is 413, a gzip body 415 and broken JSON 400, each a fixed JSON message that repeats nothing of the body; authorize keeps its 256 KB and its own messages and refuses gzip too. **Must fail**: the parser those routes had reads the 17 KB and the gzip bodies |
| T-DEVKEY-01 | dev-keys | v1.18: `PUBLISHED_DEV_ADDRESSES` is exactly the first ten accounts of the three published phrases; on base-sepolia the local payer key, any account of `LOCAL_MNEMONIC` and both 24-word phrases are refused, naming the variable and never a word of the phrase; locally they pass, and fresh keys pass anywhere |
| T-E2E-14 | e2e | an administrator approves through the portal's HTTP API and the agent's retry pays from the user's own account, confirmed by L3, within 2 s; a rejection denies and pays nothing; with the phone asked too, a portal approval ends the wait and the same fetch pays; a known-value scan for every token |
| T-E2E-15 | e2e | v1.17 (the ID was reserved by `specs/015`): the hosted agent, L2 with user accounts and backchannel approval, and the stand-in approval service. A person's token issued under the stand-in's issuer and a goal whose purchase escalates: the stand-in receives one request, addressed to that person, approves it, and the payment is signed by that person's account. A machine caller's escalation sends none |
| T-E2E-16 | e2e | v1.17: the hosted agent (model faked) with L2 (user accounts on, sign-in configured) on the local chain. A person onboarded and funded: both purchases `PAID` and `CONFIRMED`, recorded for them and paid from their account, the platform account's balance unchanged. A machine caller: the platform account pays and the entries name no user. A person with the role and no account: nothing paid, and the answer says the account is missing. A second run with the first run's `sessionRef` carries the session; another person's reference is 404 |
| T-E2E-17 | e2e | v1.17 (`test/e2e.full.test.ts`): the whole system on one stack, real but for the model and the phone: the local chain, the facilitator, the seller, L2 (user accounts, administration, sign-in, backchannel approval), L3, the portal's HTTP API and the stand-in approval service, with one tenant signing the portal's tokens and the agent's. One journey, in order: two people onboard in the portal (profile, wallet, policy); the hosted agent runs for them with a JSON answer and with an event stream, and each wallet pays its own purchases; an escalated purchase asks its owner's phone, who approves, and another's owner refuses; a phone that does not answer leaves a purchase to an administrator, who approves it in the portal; a portal token starts no run and an agent token opens no portal; the local agent runs the scripted plan from the command line as a machine caller, the operator approves its escalation from the command line, and the Claude tool-use loop buys with a scripted client, all from the platform account; a disabled account pays nothing. At the end the hash chain verifies, every payment has exactly one effective `SETTLEMENT`, `CONFIRMED`, every wallet paid exactly its own purchases, the seller received their sum, and no token, subject or typed text is in the ledger. `npm run test:e2e` runs it with T-E2E-01..16. |
| T-E2E-01 | e2e | scripted plan outcomes `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`; on-chain delta exactly 6000; two CONFIRMED settlements; chain ok; budget `spentOrReserved = 6000` |
| T-E2E-02 | e2e | HITL: escalate → agent-token approval returns 401 → operator approval → PAID+CONFIRMED → the same request escalates again |
| T-E2E-03 | e2e | forged `PAYMENT-RESPONSE` → L3 returns MISMATCH; L2 keeps the first CONFIRMED and records an anomaly naming `amount` |
| T-E2E-04 | e2e | with `signerLatencyMs: 25`, 15 concurrent intents → exactly 10 AUTHORIZED in the trailing 60 s. **Must fail if the mutex is removed** (verified: 15/15 without it) |
| T-E2E-05 | e2e (must-fail proof in auth) | `/v1/reconcile` with the agent token returns 401; the ledger is unchanged |
| T-E2E-07 | e2e | operator reject: the retry is DENIED `human_rejected` with no operator text in the detail, another session still escalates, the ledger trail is ESCALATED → HUMAN_REJECTION → DENIED; a concurrent approve and reject yield exactly one final entry; the events feed reports escalated, denied and approved |
| T-E2E-08 | e2e | expiry on L2's clock: a repeat while pending reuses the ID; after 300 s the escalation expires, approve and reject are 409, the next request escalates under a new ID, and re-approving returns the same approval so one payment happens |
| T-E2E-09 | e2e | the hosted service on the harness: FREE, PAID, PAID, ESCALATED with both payments CONFIRMED and 6000 spent; continuation after an operator approval pays once with `approvalRef`, and another requester's use of the reference → 404 with the ledger unchanged |
| T-LED-05 | ledger-lock | one ledger writer (L2-6): a second acquirer waits while a fresh lock is held and takes it within 2 s of SIGTERM; a 31 s stale lock is taken over; a lost lock is reported; `main()` locks before loading. **Must fail**: two unlocked writers fork the chain and the reload throws `integrity` |
| T-IAC-01 | infra (needs `BICEP_PATH`) | the compiled `infra/main.bicep` and `infra/pre-deploy.bicep`, with their parameter files: role assignments only per the identity–vault matrix (the operators' group on the operator job only); the payer key only in `ca-l2-eastus2-dev/l2` from the l2 vault; internal-only L2/L3; one L2 replica on NFS; sidecars without env or secrets; identity lifecycle `Main` only for the agent; sellers in their own environment; no secret literals; `ALLOWED_HOSTS` is the seller, not the alias; vault firewalls deny by default, open only to `seedIp`, recovered only through `recoverVaults`; each app and job on its own unit's image, which contains its command's entry point (the operator job on `x402-operator`), and the operator job's own command `ledger-verify`; each unit's apps look up only their own identities and vaults and wait for the platform; the model is keyless (Foundry refuses API keys, no container gets an Anthropic key, the agent signs in as `id-l1-eastus2-dev`) and the agent's model is the Claude deployment with its attestation; every name in the parameter files' `names` is the standard one for its place there and fits Azure's limits, every resource is named from `names`, each of `names` is deployed, every module gets `names` whole, and no template builds a name from the location or writes one out; the deploy app (no secret, one federated credential for the deploy environment; v1.17: the only app registration `pre-deploy.bicep` makes), the operators' security group, and the deploy app's Contributor and condition-limited Role Based Access Control Administrator on the resource group only; every template parameter set in its parameter file, only the five per-run values from the environment, both files agreeing on the target, and each template refusing to run elsewhere; each module of `main.bicep` deployed by exactly one unit's runs (`unit`: the platform's modules by the platform's, each unit's apps by that unit's), with `unit` required and one of the six. **Must fail**: 25 mutant tests (rules 1, 2, 3, 9, 10, 11 and 18; two each for rules 14 and 17; three each for rules 12, 13 and 16; five for rule 15; v1.17: without rule 11's) v1.8, rule 19: the Auth0 client credential only in `ca-l2-eastus2-dev/l2`, from the l2 vault, under the name `ciba.credential` chooses; every other `CIBA_*` value from the `ciba` parameter; `main.bicep` refuses an enabled `ciba` it can't use. **Must fail**: the credential on the agent, a literal credential, one fixed name, a written-out `CIBA_ISSUER`, no `ciba` check. v1.16: `ciba` has exactly the keys `audience, clientId, clientKeyId, credential, enabled, issuer`, no app has `CIBA_APPROVER`, and `main.bicep` refuses `ciba.enabled` without `userAccounts.enabled`. **Must fail**: an `approver` key, `CIBA_APPROVER` put back in the L2 app, the `fail()` removed. v1.9: the deploy app has two federated credentials, for the deploy and the Auth0 GitHub environments (rule 16), `githubAuth0Environment` is `auth0-<env>` (rule 17), and rule 20: the Terraform state's storage account takes Entra sign-in only, keeps versions and deleted blobs, has one private container, and only the deploy app has a role there (Storage Blob Data Contributor on the container). **Must fail**: both credentials for one environment, an Auth0 environment that is the deploy environment, account-key access, a role on the whole account, another role, no versioning. v1.10: the portal is a unit (its app, identity, vault, image and the `profiles` share, mounted by the portal only; the ledger share by L2 only); the mnemonic only in `ca-l2-eastus2-dev/l2` from the l2 vault; the portal is the second app with external ingress, and it and the agent set `TRUSTED_PROXY_HOPS` to 1; rule 21: L2 always references `portal-token` and `user-wallet-mnemonic`, `USER_ACCOUNTS` and `PLATFORM_SELLERS` come from `userAccounts` and the seller's own host, the portal reads only its own vault and gets no payer key, no mnemonic and no token but `PORTAL_TOKEN`, and `main.bicep` passes `userAccounts` whole; v1.13: a parameter file's `identity` is exactly `issuer` and `audience` (the clause that the agent gets no setting of people's sign-in is replaced by rule 23 in v1.17). Each changed rule keeps a must-fail mutant. v1.15, rule 22 (the portal's administration area): L2's control container and the portal each always reference `portal-admin-token`, each from its own vault; `PORTAL_ADMIN` in both comes from `userAccounts.administration`; no other app holds the secret or the variable; and `main.bicep` refuses administration without user accounts. v1.17: rule 11 (the agent's audience) is removed; rule 16: one app registration, the deploy app, with no API app, `Agent.Run`, `agentUsers` or `retirePortalScope`, and `mainParameters` is `deployClientId` and `operatorsGroupId`; rules 12 and 15 know the smoke job (`names.jobs.smoke`, on the L1 image); rule 23 (new): the agent and L2 get `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` from `identity` and `agent`, no container gets `AUTH_TENANT_ID` or `SERVICE_AUDIENCE`, `API_DOCS` is only on the agent and only as `agent.apiDocs`, the regression job and the smoke job reference `machine-client-key` of the l1 vault and get the machine client's IDs, and `main.bicep` refuses the `l1` and `l2` units without `agent.clientId`. **Must fail**: one mutant for each clause of rule 23 v1.19: rule 16 also requires the Role Based Access Control Administrator condition to refuse an assignment (write or delete) to the deploy app itself; rule 24 (new): L2's control container always references the l2 vault's `ledger-mac-key` as `LEDGER_MAC_KEY`, and no other app or job holds it; rule 8 knows `LEDGER_MAC_KEY`. **Must fail**: the self clause removed; the secret on another app, from another vault, or as a literal |
| T-IMG-01 | images | each image's import graph (`scripts/image-closure.ts`) stays in its own folders and uses only runtime dependencies; only the L2 image holds the signer or any L2 code (the operator's holds only the operator scripts and `src/shared`); only the L1 image holds Mastra and the model SDKs; every Dockerfile builds its own image from the same pinned base and loads every module once. **Must fail**: L1 reaching the signer; a package resolved at run time but not listed; an imported package missing from `dependencies`. v1.10: the portal image holds `src/portal/` and `src/shared/` only, none of the agent's packages and no web package (the web app is bundled at build time and copied as static files). v1.17: the L1 image also holds `src/smoke-main.ts` and `src/machine-caller/` |
| T-IMG-02 | images | v1.18: `scripts/audit-shipped.ts` audits the union of every image's packages (runtime dependencies only, never ganache) with package.json's `overrides`, and the deploy pipeline's step 1 runs it before the typecheck and the suites (v1.21: and before the two builds); v1.22: the audited manifest is the images' own (`imageManifest`, `overrides` resolved, T-IMG-04); v1.22.1: it fails on every advisory at or above the level except one an entry of `AUDIT_EXCEPTIONS` names for that package, until the entry's expiry, and from that day on the entry itself fails it (must-fail: another advisory, the advisory on another package, the expiry, an unreadable report, a malformed or long-lived entry) |
| T-IMG-03 (v1.21) | images | the deploy pipeline's step 1 runs every npm script an image's build stage runs (`npm run build` in every image, `npm run build:web` in the portal's), before `npm test`; scripts in a runtime stage don't count. **Must fail**: a step 1 without `npm run build:web`, `npm run build` after `npm test`, a script a build stage gained that step 1 doesn't run |
| T-IMG-04 (v1.22) | images | each image's `package.json` (`imageManifest` in `scripts/image-closure.ts`) has no `$name` in `overrides` that npm can't resolve from that file's own dependencies, and `@coinbase/cdp-sdk`'s zod is package.json's range in every image; `resolveOverrides` writes out nested references, keeps plain ranges and refuses a reference to no direct dependency. **Must fail**: `overrides` copied as they are (v1.18 to v1.21) are reported for every image that doesn't list zod, the L2 and seller images included; package.json itself, which lists zod, is not |
| T-E2E-AZ | deploy-workflow, github-setup, cleanup (static) and the live workflows | `.github/workflows` holds the pipelines (six, and seven since v1.10), `deploy.yml`, (v1.9) `provision-auth0.yml`, which T-IAC-02 checks and which alone may read GitHub secrets and variables, its own, and (v1.20) `checks.yml`, which T-CI-01 checks; nothing else: each pipeline runs by hand or on its own `deploy-<unit>-*` tag, holds the concurrency group `deploy-azure`, passes no secret, and only calls `deploy.yml` with its unit and its own inputs (`first-deployment` for all but L1, `seed-ip` and `recover-vaults` for the platform), and each image is built by exactly one pipeline. `deploy.yml`: only `workflow_call`, and no concurrency group of its own (it would deadlock with its caller); OIDC sign-in with the tenant, subscription, resource group and deploy app compiled from `infra/main.<env>.bicepparam` by the pinned Bicep CLI, which every step uses, and no GitHub secret or variable; a fresh sign-in (`SIGN_IN`) first in every step that calls Azure, and no `azure/login`; Azure provisioned by Bicep only (every `az` command in the workflows and the two scripts is a Bicep deployment, a read, a job start, an image copy or a clean-up deletion), and `infra/` holds only `github-setup.sh` and `cleanup.sh`; every step with pipefail; `main.bicep` deployed with `UNIT`, what-if first; every gate (tests, T-IAC-01, image scan, deploy, wait, balance, `--check-baseline` regression, chain, smoke ≤ 120 s, log scan) before promotion; the image steps, promotion and rollback skipped only on the platform, the checks only on a first deployment; L2's ledger lock handover awaited after a platform or L2 deployment; step 0 mapping the unit to its image and refusing `seed-ip` or `recover-vaults` on a unit, `recover-vaults` without `first-deployment`, and a first deployment of L1, before anything else (the guard run for every unit with every combination of the three inputs); promotion records the unit's image as `last-good`, and on L1 first moves the agent's traffic through `main.bicep`; rollback of the unit to its `last-good` on any failure once the deploy step ran, even partway, without touching the agent's traffic; every job started with its own command (the deploy identity never approves or rejects); v1.17: the hosted smoke is the smoke job, started with its own command, and no step asks for a token (before, a smoke token for the API app's client ID); names from the parameter file right after the checkout, none hard-coded. `infra/github-setup.sh` (fake `gh`) creates only the two GitHub environments its parameter file names (the deploy job's and, v1.9, the Auth0 job's `auth0-<env>`), creates the Auth0 environment's six variables when missing (placeholders or defaults, never overwriting), sets no secret and reports leftover secrets. `infra/cleanup.sh` (fake tenant and `gh`) deletes the GitHub environment, the deploy app's role assignments before the app (none orphaned), the resource group, the deploy app's registration (v1.17: the only one) and the operators' group, and nothing else; it purges with `--purge`, reports the vaults that purge protection keeps, and deletes nothing with `--dry-run`, unconfirmed, or for another tenant. **Must fail**: a pipeline outside the group, on another unit, on `deploy-*` tags or a merge, with secrets or with steps of its own, and a missing or extra pipeline; `deploy.yml` with its own trigger or concurrency group; promoting before the regression; a regression skipped by another condition, a platform run that builds an image or promotes, or a rollback of the platform; no guard, a guard that lets `seed-ip` through on a unit or a first deployment of L1, a unit built from another image, or the inputs pasted into the script; a GitHub secret, or a sign-in that isn't OIDC from the parameter file; one `azure/login` for the whole job, or a step that calls Azure before signing in; provisioning outside Bicep (`az group create`, traffic moved with `az`); a deployment without what-if, an image built under another name, or a promotion of another image; the operator job started with an approve command; the target step run late, a missing name, an L2 deployment that doesn't wait for the lock handover, or no pipefail; a rollback that redeploys the new image, or (v1.17) a step that calls `az account get-access-token --resource`; a hard-coded name; a third script in `infra/`; the setup script without its environment check, its Auth0 environment check or its check for existing variables; the clean-up without its role-assignment step or its dry-run guard v1.8: the hosted smoke step fails when any step escalated, so a deployment check never asks the approver (L2-7). v1.10: a seventh pipeline, `deploy-portal.yml`; the guard and the image mapping for `portal`; the build's env scan also refuses a mnemonic or a card vault key; a `portal-smoke` step after the hosted smoke (`/healthz` 200, `/api/config` 200 in `entra` mode, `/api/me` without a token 401). v1.17: step 0 reads `names.jobs.smoke` (`TARGET_NAMES`) and no `authAudience` (`TARGET_OUTPUTS`); step 8 is a fresh sign-in and `run_job` of the smoke job, whose own command makes the checks the step made with `jq` (T-AGT-13); `AUTH0_VARIABLES` in `infra/github-setup.sh` lists the tenant's two new variables; `infra/cleanup.sh` looks for no API app registration |
| T-CI-01 (v1.20) | deploy-workflow | `.github/workflows/checks.yml`, the pull request check: named `checks`; triggered by `pull_request` and `push`, each with `branches: [main]` and nothing else (no paths filter, no `pull_request_target`); `permissions` exactly `contents: read`; its own concurrency group per ref (never `deploy-azure`); every step with pipefail; one job, in no GitHub environment, with no `permissions`, `secrets`, `uses`, `if`, `needs` or `continue-on-error`, a timeout of at most 60 minutes, and the matrix Node 22 and 26 with `fail-fast: false`; every action pinned by its full commit SHA; first a checkout with `persist-credentials: false`, then `setup-node` with the matrix's Node and no dependency cache, then the Bicep CLI at `deploy.yml`'s `BICEP_VERSION`, its SHA-256 (`BICEP_SHA256`, 64 hex digits) checked with `sha256sum -c` before it is made executable or put on PATH, and `BICEP_PATH` set; after it, exactly `deploy.yml`'s step 1, command for command, then `npm run demo:local`. The checksum line, run in bash, passes the published bytes and refuses others. The T-E2E-AZ checks of every workflow's text (no secret or variable, no secret-shaped literal, no token, no provisioning `az` command, no hard-coded name) cover it. **Must fail**: `pull_request_target`, a paths filter, no pull request trigger, `id-token: write`, a job's own permissions, a GitHub environment, a secret or a variable, the `deploy-azure` group; `npm ci`, `npm test \|\| true`, one suite instead of all, a dropped demo, audit or build (v1.21), a step or the job skipped or excused (`if`, `continue-on-error`, `needs`), no timeout, a command `deploy.yml`'s step 1 gained that the check didn't; an action by tag, a checkout that keeps its credential, a dependency cache, Node 26 only or `fail-fast`, another Bicep version, no checksum, a checksum after `chmod`, no `BICEP_PATH`; a folder without `checks.yml` |
| T-CDP-01 | cdp-config | the `facilitatorChoice` matrix (CP-3), and the public path sends no credential |
| T-CDP-02 | cdp-isolation | seller startup fails closed: missing ID or secret, malformed secret, conflicts; the log line format; the unused-credential warning |
| T-CDP-03 | cdp-auth | JWT headers (EdDSA, ES256 from PKCS#8 and SEC1); the scripted plan through a JWT-verifying CDP stub matches T-E2E-01 |
| T-CDP-04 | cdp-failures | pre-challenge 503 per category; 0 AUTHORIZED entries |
| T-CDP-05 | cdp-failures | paid-retry failures: compliance decline gives 402; auth failure gives 502; L1 `PAYMENT_FAILED` |
| T-CDP-06 | cdp-failures | must-fail: a `settlement_pending` failure carrying a settled hash is CONFIRMED with L3-1 v1.2 and NOT_SETTLED without it |
| T-CDP-07 | cdp-isolation | must-fail: the secret never appears in any output; the redaction wiring is proven by an echoing upstream |
| T-CDP-08 | cdp-isolation | demo child environments carry no CDP key; a down CDP facilitator causes 0 requests to any other host |
| T-CDP-09 | cdp-failures | after a facilitator outage, the next priced request succeeds without a restart |
| T-ARCH-A8 | architecture | rule A8 trips on its fixture and the tree is clean |
| T-ARCH-A9 | architecture | rule A9 (v1.8) trips on its fixture and on any other template naming the credential, the tree is clean, and `CIBA_CLIENT_KEY_ID` never trips it |
| T-CIBA-01 | ciba-client, backchannel-failures | backchannel approval is off unless `CIBA_APPROVAL=1`; each missing or invalid `CIBA_*` value stops L2 naming the variable, never the value, before the ledger lock and before listening |
| T-CIBA-24 | ciba-client, backchannel-failures | v1.16: `CIBA_APPROVER` with the feature on stops L2 before the lock, naming the variable and never its value; off, it is only named as ignored; a complete configuration without it is enabled; `CIBA_APPROVAL=1` without `USER_ACCOUNTS=1` stops L2 before the lock, naming both; `createControlService` refuses backchannel deps without user-account deps |
| T-CIBA-02 | payment-details, ciba-client, backchannel-approve | the request: exactly the contract's form fields, a fresh RS256 client assertion (or `client_secret_post`), the payment details equal to the escalation and the chosen requirement, a binding message within Auth0's limits, no agent text; one request per eligible escalation within 2 s |
| T-CIBA-03 | backchannel-fatigue | a repeat of a pending purchase sends no request and returns at once; `operatorApprovalOnly` sends nothing; a non-boolean value is 400 |
| T-CIBA-04 | backchannel-fatigue | at most 10 requests per rolling hour; the 11th escalation is `capped`. **Must fail**: without the cap, 11 are sent |
| T-CIBA-05 | backchannel-failures | start failures: transient ones retried up to 3 attempts, permanent ones not; each recorded, the escalation pending, an operator approval still pays; with a hanging service the call returns within 6 s |
| T-CIBA-06 | backchannel-approve | polling follows the interval, `slow_down` lengthens it, and polling stops once the escalation is decided |
| T-CIBA-07 | backchannel-refuse, backchannel-lapse | outcomes: a refusal is a backchannel `HUMAN_REJECTION` and R15 applies; a late refusal or an expiry is a lapse; the escalation then expires at 300 s; a late answer changes nothing |
| T-CIBA-08 | approval-evidence, backchannel-verify | each forged answer (issuer, audience, client, signature, expiry, user, amount, payee, escalation, request, replay) records its check and signs nothing. **Must fail**: without each check its forgery verifies; through L2, without the details check, the owner check (v1.16, was approver), or the issuer and owner checks together, the forgery pays. v1.16: the owner check reads the subject under the answer's own issuer, so a token from another issuer fails it too; without the issuer check alone such a token still approves nothing, and the unit proof of the issuer check uses the same tenant written without its trailing slash |
| T-CIBA-09 | backchannel-approve | the bounded wait: an approval within it pays in the same call (two `INTENT`s, one outcome each); after it, the next request pays once; a DENY rule at re-evaluation wins; a caller who leaves gets nothing signed; other calls proceed during the wait |
| T-CIBA-10 | backchannel-lapse | an operator rejection during verification leaves exactly one final state. **Must fail**: with outcomes recorded outside the serialized section, the escalation gets two |
| T-CIBA-11 | backchannel-lapse | after a restart L2 polls the same request from the sealed handle and sends no new one; a window that passed expires; an interrupted start is never resent; another credential cannot open the handle |
| T-CIBA-12 | backchannel-views | a known-value scan of the ledger, logs, responses and events finds no client key, client secret, token, request handle or Auth0 text |
| T-CIBA-13 | backchannel-failures | with the approval service hanging, auto-approved purchases are decided within 50 ms of the feature-off baseline |
| T-CIBA-14 | backchannel-views, escalations | the views and events show the request state, the channel and who decided, from a whitelist; the ledger alone tells each escalation's story (SC-010). v1.16: for each outcome (approved, refused, unanswered, failed, capped, `no_owner`, `identity_mismatch`) the operator's list and events and the administration list and detail show the owner, the request's state, the path and who decided (the owner's `usr_…` for a phone decision), and no key outside the view shapes |
| T-CIBA-15 | backchannel-owner | v1.16: an escalation of a person's sends exactly one request, addressed to that person, and nobody else's subject is in any request; their approval pays once and their refusal denies, each recorded with their `usr_…` and no subject; two people with pending escalations each decide only their own; INV-12 and a disabled account still win over the owner's approval; an administrator can't approve their own payment in the portal and can by phone. v1.17 (T-CIBA-15..18): the person is given by a caller's token, and the request is addressed to the subject of the token L2 verified |
| T-CIBA-16 | backchannel-owner | another person's genuine, signed answer for the escalation records `APPROVAL_VERIFICATION_FAILED{owner}`, approves nothing and leaves the operator path working. **Must fail**: without the owner check it approves and the owner's account pays |
| T-CIBA-17 | backchannel-owner | a subject that does not resolve to the user, under L2's issuer or only under another one, is `identity_mismatch`; no subject is `no_identity`; no request is sent, the call returns at once and the payment is decided as usual. **Must fail**: with `skipIdentityCheck` the request goes out with the mismatched subject. v1.17: a person whose sign-in issuer is not the approval service's is `identity_mismatch`; a body carrying `approvalSubject` is 400, so `no_identity` no longer arises from a missing field |
| T-CIBA-18 | backchannel-owner | no user, no request: a platform intent is `no_owner`, an operator-only one `operator_only`; nothing reaches the approval service and an operator approval pays each. **Must fail**: with `ownerlessSubject` (a fallback approver) the platform account's escalation rings somebody's phone. v1.17: a machine caller's escalation is `no_owner` |
| T-CIBA-19 | backchannel-fatigue, escalations | 11 escalations for one person and one for another within the hour: the first is asked 10 times and capped once, the other is asked; repeats count nothing; the count is per user and entries with no user count for nobody. **Must fail**: with `sharedRequestCap` the other person is not asked |
| T-CIBA-20 | backchannel-owner | an email-shaped planted subject through an approval, a refusal, a mismatch, a failed start and a malformed value is in no ledger line, log line, event or response of the authorize, operator, administration and user-account routes; a body that is not JSON is answered without being quoted or logged. **Must fail**: without L2's own handler for unreadable bodies the planted subject is in the log |
| T-CIBA-21 | backchannel-lapse, escalations | a request granted its full requested lifetime and never answered: `APPROVAL_REQUESTED`, then `ESCALATION_EXPIRED`, no `APPROVAL_REQUEST_LAPSED`, and the state `unanswered`, before the sweep and after it, with L2 running throughout or restarted after the window; an operator approval meanwhile is `abandoned`; a request that ends first is still `lapsed` |
| T-CIBA-22 | backchannel-lapse, escalations | a request open when v1.16 starts, for an escalation with no user: never polled, one `APPROVAL_REQUEST_FAILED{resume, no_owner}`, the escalation expires at 300 s; two people's open requests are each resumed from their own handle and each answer decides only its own |
| T-CIBA-23 | backchannel-views | a ledger written by v1.15 (backchannel decisions naming the configured approver's subject, `evidence.subject`, `check: "approver"`) verifies and reads through every view, unchanged, byte for byte |
| T-E2E-10 | e2e | backchannel approval within the wait pays in the same `fetchPaid` (50000 on-chain, one request). v1.16: the purchase is a person's (v1.17: made with their caller's token; no intent carries `userId` or `approvalSubject`); the request is addressed to them, the 50000 leave their own account and the platform payer is untouched. The scripted plan with backchannel on matches the baseline and sends no request |
| T-IAC-02 | auth0-iac | `auth0/` offline (v1.8): the provider pin and environment-only credentials; the payment-details type equals the one L2 sends; the API's RS256, RFC 9068, standard consent and access policy; the CIBA-only client with Guardian push; the user-delegated grant; an RS256 public-key credential or a write-only secret; Guardian never destroyed; no users, passwords, private keys or JWTs; the output's keys equal the parameter file's `ciba`; local state and plans ignored. v1.9: the state in Azure with an Entra sign-in and nothing of it written in the folder; no tfvars committed; every variable the pipeline sets declared, and only the four it requires without a default; and the pipeline `provision-auth0.yml`: by hand only, in the GitHub environment `auth0-<env>`, minimal permissions, one run at a time, only its two secrets (v1.11: never L2's client secret, and `credential = "key"` fixed) and only in the plan and apply steps, Terraform's six variables (seven since v1.12, with the portal's origin, which `infra/github-setup.sh` never creates) from the environment's variables and only in the plan step, no tfvars file or `-var`, no input pasted into a script, OIDC for the state and no Azure credential, Terraform pinned by SHA-256, the provider as locked (the lock file holds its checksum for the Linux runner as well as a Mac's, or `validate` refuses it there), the offline checks before init, the plan shown, and the saved plan the only thing applied, only when asked. v1.12 (people's sign-in, `specs/013` research R19): v1.14: no role, no permission on people's API and nothing assigned to a person (until v1.14 the one role `x402-user` holding exactly `agent:run`); v1.15: the permission `portal:admin` and the role `x402-admin`, which holds exactly it, for the portal's administration area only, still assigned to nobody here (the only permission and the only role until v1.17); the portal's single-page client, public, first-party and with only its own grant, and (v1.13, until v1.17) exactly two clients, the portal's and L2's; the portal client's callbacks, web origins and logout URLs exactly the local origin and `portal_origin` when set (one https host); the one post-login Action (`auth0/sign-in-time.js`, no secret, no package), appended to the flow, writing the one sign-in time claim and nothing else, also when run against a stand-in for Auth0's `api`; the outputs `bicepparam_identity` (v1.13: the issuer and the API's identifier, naming no client) and `bicepparam_portal_client_id` matching the parameter file and shown in the run's summary. **Must fail**: 19 mutants of the configuration (one a lock file without the Linux runner's provider checksum), 36 more of people's sign-in (43 in v1.12; v1.13 took the agent's client out and v1.14 the role) and 6 of the Action when run (v1.12), and 32 of the pipeline (a plan with a placeholder, L2's client secret in GitHub, a credential kind chosen by a variable, and a set-up script that creates the portal's origin among them), each reported. v1.17 (`specs/016` research R10): the applications are exactly `l2`, `portal`, `agent` and `machine` (a `for_each` over the declared machine callers); the agent's client is public, first-party, `authorization_code` only, and its callbacks are only `<origin>/docs/oauth2-redirect.html` for the two local origins and `agent_origin` when set; each machine client has `client_credentials` only, `private_key_jwt` and one grant for people's API with exactly `agent:run`; the permissions are exactly `portal:admin` and `agent:run`, and the roles exactly `x402-admin` and `x402-agent`, each holding one; no role is assigned; `bicepparam_agent` has the parameter file's `agent` keys but `apiDocs`; the variables `agent_origin` and `machine_caller_keys` are declared and set in the plan step. **Must fail**: a fourth kind of application, a third permission, a role assignment and a machine client with a second grant, each reported. `terraform fmt -check` with Terraform installed; `terraform validate` after `init` v1.19: no approver variable or data source; three Actions (`sign-in-time.js` first, `mfa-time.js` after it, `deny-sign-up.js` only with `allow_sign_ups = false`), the administrator's challenge and the `mfa_time` claim run in the test; Guardian with push and one-time codes, and the tenant setting for factors chosen by Actions; localhost origins only with `local_origins`. **Must fail**: each new clause |
| T-E2E-11 | e2e | a backchannel refusal through the orchestrator (v1.16: of a person's purchase, from that person's phone): DENIED `human_rejected`, nothing paid, trail `ESCALATED`, `APPROVAL_REQUESTED`, `HUMAN_REJECTION`, `INTENT`, `DENIED` |

Suites added in v1.1: `counterparty.test.ts` (seller, facilitator, MockUSDC, M2/M3), `verifier.test.ts` and `settlement-service.test.ts` (L3 units with a fake chain client), `auth.test.ts` (per-role guards), and `demo.local.test.ts` (demo smoke and clean shutdown). `test/helpers/harness.ts` runs the in-process e2e system.

v1.17: no test puts `userId` or `approvalSubject` on an intent any more. A test that needs a person mints a caller's token through one helper, `test/helpers/caller-tokens.ts`; where backchannel approval is on, the token is issued under the stand-in's issuer. `identity-token.test.ts` covers the shared caller check (`verifyCaller`) in place of the directory's verifier, with its two must-fail halves: with `skipChecks: ["permission"]` a caller without `agent:run` is accepted, and with `skipChecks: ["machineSubject"]` a machine token naming another client is accepted as that client. `machine-caller.test.ts` covers the machine caller's token client against a stub token address: the client-credentials request with an RS256 assertion (the key ID in its header, `iss` and `sub` the client, `aud` the issuer, a lifetime of at most 60 s), the cache until 60 s before expiry, and a refusal that carries no response body, key or assertion. `test/helpers/hosted.ts` fakes the model's stream.

Manual checks:
- `PAYER_PRIVATE_KEY=0x1 ENV_FILE=/dev/null npx tsx src/main.ts --scripted` exits 1 with the refusal message.
- T-E2E-06 (opt-in, needs a CDP key and a funded Base Sepolia payer): `npm run demo:base-sepolia` exits 0 three times in a row. Each run prints the demo summary plus `settlements:        2 CONFIRMED`, `payer gas spent:    0 wei` and `secret scan:        clean`.
- v1.10, needs outside accounts (`specs/013` quickstart §4 and §5): a card saved and removed against a Stripe sandbox; a sign-in to the portal against the Auth0 tenant, with research R19's checks (v1.12; four since v1.13): the token's claim names, the sign-in time after a forced sign-in and across a renewal, the pop-up without a page of the portal's own, and the two-step removal of the Entra scope (v1.17: that one no longer applies, since the registration is deleted).
- v1.17, needs the tenant and Azure (`specs/016` quickstart §5 and §6): where a `checks` token carries `agent:run` (`scope`, `permissions` or both); the docs page's sign-in on a deployed agent, with no secret, contacting the agent's origin and the tenant only; a streamed run through the ingress, with `: keep-alive` lines in quiet periods and no cut; a person's escalated run reaching that person's phone; a token of the old kind (the directory's) refused with 401.
- `npm run demo:local` summary shows `spent on-chain: 0.006 USDC` and `hash chain ok=true entries=<n>` (`entries` counts the persistent `.local` ledger and grows across runs), and no listeners remain on ports 8545 or 4020–4023 afterwards. User accounts are off in the demo, so v1.10 leaves this summary unchanged.

---

## 13. Commands

```bash
npm install                 # use install, not ci (ganache lockfile pins darwin-only fsevents)
npm run typecheck
npm test
npm run demo:local [-- --llm]
# Base Sepolia, one terminal each:
npm run seller | npm run l2:control | npm run l3:verifier | npm run agent -- "<goal>"
API_DOCS=1 npm run l2:control   # L2 plus Swagger UI at http://127.0.0.1:4020/docs (no token, off by default)
npm run demo:base-sepolia   # opt-in live run through CDP (T-E2E-06); reads env/<role>.base-sepolia.env
npm run approve -- <authorizationId> [approver]
npm run reject -- <authorizationId> [operator] [reason]
npm run escalations [-- --watch]   # pending escalations; --watch reports every new escalation and outcome
npm run check               # typecheck && test && demo:local (definition of done in one command)
npm run test:e2e            # v1.17: the two on-chain end-to-end suites (T-E2E-01..17)
# v1.5 hosted agent service and Azure profile:
npm run stack:local [-- --docker]   # chain, facilitator, seller, L2, L3 for agent:hosted, until Ctrl-C
node --import tsx scripts/vscode-local.ts chain | stack [--users] | run <role> [args]   # VS Code's runner, local mode only
npm run agent:hosted        # L1-6 on 127.0.0.1:4024 (env/l1-hosted.env)
API_DOCS=1 npm run agent:hosted   # plus Swagger UI at http://127.0.0.1:4024/docs (no token; off by default; v1.6). v1.17: with
                            # API_DOCS_CLIENT_ID the page signs in at the tenant; in Azure only where agent.apiDocs turns it on
API_DOCS=1 npm run seller        # the seller plus Swagger UI at http://127.0.0.1:4021/docs (off by default; never in Azure; v1.6)
npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service]   # local dev issuer (NETWORK=local only). v1.17: one
                            # issuer signs both: a person's token carries agent:run unless --no-role; --service makes a machine caller's
npm run stack:local -- --sign-in   # v1.17: the local stack with L2's sign-in configured (dev issuer), without user accounts
# v1.10 user accounts and the portal (L2-8):
npm run stack:local -- --users   # the local stack with user accounts on in L2 (local dev mnemonic; v1.17: and L2's sign-in)
npm run stack:local -- --users --admin   # v1.15: also L2's administration routes (PORTAL_ADMIN=1)
PORTAL_ADMIN=1 npm run portal    # v1.15: the portal with its administration area on
npm run build:web           # the portal's web app, to dist/portal-web
npm run portal              # the portal on 127.0.0.1:4025 (env/portal.env); API_DOCS=1 adds /docs
npm run dev-token -- --subject <name> --portal [--auth-age <seconds>]   # a portal token: paste it into the sign-in screen
npm run dev-token -- --subject <name> --portal --admin                  # v1.15: an administrator's (the permission portal:admin)
npm run fund-user -- <address> [usdc]   # local only: mint test USDC to a user's account
npm run wallet-mnemonic     # print one new 24-word mnemonic for USER_WALLET_MNEMONIC (never rotate one in place)
npm run agent:scripted -- --check-baseline   # L1-4 plan; exit 2 unless the baseline matches
npm run ledger-verify       # operator chain check
npm run audit:shipped       # v1.18: npm audit over the packages the images install (the deploy pipeline's step 1)
npm run payer-balance -- <address> [--min <atomic>]   # read-only Base Sepolia USDC balance
... | npm run scan-logs     # credential-shape scan of log lines
npm run build               # dist/ (each image's build stage runs it)
docker build -f docker/l1-agent.Dockerfile -t x402-l1-agent .   # one per unit in docker/; the seller's: docker build -t x402-seller .
BICEP_PATH=~/.azure/bin/bicep npm test   # every suite, T-IAC-01 and the infra script tests included
az deployment sub what-if|create -n pre-deploy-<env> -p infra/pre-deploy.<env>.bicepparam \
  --subscription <its subscriptionId> -l <its location>   # admin, by hand
infra/github-setup.sh [--environment <env>] [--dry-run]   # the GitHub environments the pipelines run in (deploy and auth0-<env>)
gh workflow run provision-auth0.yml -f environment=<env> [-f apply=true]   # the Auth0 tenant: plan, or plan and apply (v1.9)
infra/cleanup.sh [--environment <env>] [--dry-run] [--purge] [--yes]   # deletes all of an environment
```

Exit codes:
- `demo:local`: 0 when the scripted baseline matches (or an `--llm` run completes with a valid chain); 2 on a baseline mismatch; 1 on a busy port, readiness timeout or child crash.
- `approve`, `reject`: 0 on success; 1 on an HTTP or network error (409 included); 2 on a missing argument.
- `ledger-verify`: 0 when the chain verifies; 1 on an HTTP or network error or `ok: false`.
- `payer-balance`: 0 at or above the minimum; 2 below it ("fund the payer") or on a bad argument; 1 on an RPC error.
- `scan-logs`: 0 clean; 1 when a line holds a credential shape (only pattern names are printed).
- `audit:shipped` (v1.18): 0 when no package any image installs has a high or critical advisory (`--audit-level=` changes the level), apart from one that `AUDIT_EXCEPTIONS` lets through for one package until its expiry (v1.22.1); 1 otherwise, or when npm can't prune the lockfile, its report can't be read or an exception has expired; 2 on usage.
- `agent:scripted -- --check-baseline`: 2 on a baseline mismatch.
- `stack:local`: 0 when stopped by Ctrl-C or SIGTERM; 1 on a busy port, readiness timeout or child crash.
- `dev-token`: 2 when `NETWORK` is not `local`.
- `portal`: 1 on a missing or invalid setting, or when a payment key is visible.
- `fund-user`: 2 on a bad argument or when `NETWORK` is not `local`; 1 without a local deployment or on an RPC error.
- `escalations`: list mode exits 0, or 1 on an HTTP or network error. `--watch` polls every 1 s from a ledger cursor, prints errors once per failure streak and keeps polling, and exits 0 on SIGINT or SIGTERM.
- `demo:base-sepolia`: 0 when the baseline matches and there are 2 CONFIRMED settlements, 0 payer gas and a clean secret scan; 2 on a failed preflight or a mismatch; 1 on a readiness timeout or child crash.

---

## 14. Build order (from-scratch rebuild)

| Milestone | Deliverable | Exit criteria |
|---|---|---|
| M0 | Scaffold: package.json (ESM, scripts §13), tsconfig, vitest config, `.gitignore` | `npm run typecheck` on an empty `src` passes |
| M1 | `shared/contracts.ts`, `shared/config.ts`, architecture test | T-ARCH-* pass |
| M2 | `MockUSDC.sol`, `local-chain-lib.ts` | deploy + mint; payer balance 10 USDC |
| M3 | Counterparty seller + facilitator | an unpaid GET returns 402 with a decodable `PAYMENT-REQUIRED` |
| M4 | L2: mandate, policy, ledger, signer, service | T-POL-*, T-LED-* pass |
| M5 | L3: verifier, service | T-E2E-03 passes |
| M6 | L1: orchestrator, port adapters, scripted agent, `main.ts` | T-E2E-01/02/04/05 pass |
| M7 | L1 Claude agent + T-AGT-01; `demo-local.ts`; `approve.ts`; README | demo summary as §12 |

---

## 15. Extension backlog (specs for next iterations)

Each item must preserve every `INV-*` invariant.

| ID | Extension | Spec sketch | Touches |
|---|---|---|---|
| EXT-1 | **AP2 mandate as L2 input** | Replace `mandate.json` with a verified AP2 Intent Mandate (SD-JWT+kb). L2 verifies the user's signature and expiry, then maps mandate constraints onto `SpendingMandate`. Add `mandateRef` to `PaymentIntent`. Reject an unsigned or expired mandate with `mandate_invalid`. | L2-1, contracts, new tests |
| EXT-2 | **Remote signer** | Put `PaymentSigner` behind an interface `{ address; sign(challenge, req) }`. Add an implementation for Turnkey, Coinbase CDP Server Wallet or KMS. Keep the SDK spend controls. INV-2 then allows the adapter file instead of `signer.ts`. | L2-3, architecture test |
| EXT-3 | **`upto` scheme** | Allow `upto` in the mandate. L2 signs a Permit2 max. Budgets reserve the max until L3 reports the settled `amount` from `SettleResponse.amount`; then the committed figure becomes the settled amount. | L2-2/4, L3-1 |
| EXT-4 | **Solana (SVM)** | Network profile `solana-devnet`. `ExactSvmScheme` signer in L2. L3 verifies an SPL `TransferChecked` via RPC `getTransaction` with `finalized` commitment. | config, L2-3, L3-1 |
| EXT-5 | **MCP server front-end** | Expose `fetch_resource` and `check_budget` as MCP tools from a new L1 process. It is just another L1 composition root; same ports. | new `src/layer1-intent/mcp.ts` |
| EXT-6 | **Durable ledger** | SQLite with the same entry schema and hash chain; `committedAtomic` as a SQL view; WAL mode. v1.10: user state (L2-8) is derived by scanning the ledger, so this is also what real growth in users needs. | L2-4 |
| EXT-7 | **mTLS between layers** | Replace bearer tokens with client certificates; pin the CN per caller. v1.5: in the Azure profile, the L2/L3 proxy sidecars are where mTLS would terminate. | L1-2, L2-5, L3-2 |
| EXT-8 | **Observability** | OpenTelemetry spans with `intentId`/`authorizationId` as attributes across L1→L2→L3; metrics for decisions by rule and settlement latency by finality class. v1.5 adds a partial step: the hosted service's whitelisted run log correlates runs with the ledger by IDs. | all services |
| EXT-9 | **Refund / revert-grant handling** | When the seller returns non-2xx after a CONFIRMED settlement, L1 reports `PAID_NOT_SERVED`. L2 opens a dispute record; a refund flow uses the escrow scheme. | contracts, L1-1, L2-4 |

---

## 16. Known gotchas

- ganache prints a `uws_linux…node` warning and falls back to a Node implementation. This is harmless; `demo-local.ts` filters it.
- `npm ci` fails on Linux because ganache's lockfile has a darwin-only `fsevents` entry. Use `npm install`.
- `npm audit --omit=dev` at the root never reaches zero (v1.18): ganache ships its own `node_modules`, which the lockfile records as extraneous and npm audits anyway (webpack, sha.js, pbkdf2 and others). No image holds ganache. Use `npm run audit:shipped`.
- `audit:shipped` lets GHSA-fc5q-39xc-vjpf (picomatch) through until 2026-12-17 (v1.22.1). From that day it fails until the entry in `AUDIT_EXCEPTIONS` is removed (take picomatch's fix if one exists) or renewed with a new reason and a new expiry, at most 31 days on.
- On a Linux sandbox without IPv6, binding `::` fails. The tests bind the seller on `0.0.0.0` and use `localhost` as the not-allowlisted alias.
- Local ECDSA signing finishes within microtasks, so concurrency races are invisible without `signerLatencyMs`. Keep that hook in T-E2E-04.
- Base Sepolia USDC's EIP-712 name is `"USDC"`, not `"USD Coin"`. A wrong `extra.name` makes signatures fail verification.
- CDP JWTs expire 120 s after they are signed. A skewed seller clock shows up as `facilitator authentication` errors.
- `generateJwt` accepts EC keys only as PKCS#8 (`-----BEGIN PRIVATE KEY-----`, and no leading whitespace). The seller converts SEC1 (`-----BEGIN EC PRIVATE KEY-----`) keys before use.
- Entra refuses to pre-authorize a client for a scope in the same update that adds the scope (v1.10 needed two deployments for `Portal.Access`), and removes only a scope that is already disabled. v1.17: neither matters any more, because `infra/pre-deploy.bicep` no longer makes the API app registration that carried the scope, and `retirePortalScope` is gone. Bicep does not delete a Graph object a template stops naming: the old API app registration is deleted by hand once the agent with 1.17 is deployed (`az ad app delete --id <its client ID>`), as the portal's old web app registration was.
- The wallet mnemonic (v1.10) is never rotated in place: L2 compares every recorded wallet address at startup and refuses to start with another phrase. Back it up where the payer key is backed up.
- Stripe's API has two breaking releases a year. The version is pinned in one constant (`API_VERSION` in `src/portal/card-vault.ts`) and in the Stripe.js URL the web app loads; re-check the six calls when moving it.
- A sign-in window can only open from a click, so the web app parks a save that needs step-up behind a "Confirm it's you" button instead of opening the window by itself.
- Child processes spawned through `npx` must be started `detached` and killed by process group (`process.kill(-pid)`), or ganache keeps port 8545 open.
