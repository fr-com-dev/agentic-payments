# Implementation Plan: L2 Web Portal: Onboarding, Profile, Wallet and Expense Policies

**Branch**: `013-l2-portal-onboarding` | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/013-l2-portal-onboarding/spec.md`, with the eight clarifications of
session 2026-11-10 (cards registered only; many users, self-service; approvals unchanged; policies per seller under
a user daily ceiling; the operator's seller list; system identities on the platform account; disable, never delete;
portal access comes with `Agent.Run`).

## Summary

L2 becomes multi-user, and a new public process, the portal, lets each person set up what their agent may spend.

- **User accounts in L2.** Users, wallets, policies and account state are ledger entries; their current state is
  derived by pure functions (`users.ts`), as escalations are today. A payment that names a user is decided against
  that user's one active policy for the requested seller, bounded by operator-set platform limits, and signed with
  that user's own account. The engine gains two early rules (`user_not_onboarded`, `user_disabled`) and a user-wide
  daily ceiling under `daily_budget_exceeded`; without a user it is exactly v1.8.
- **Per-user accounts in the signer.** One mnemonic, read only by `signer.ts`; a user's account is derived at an
  index recorded in the ledger. Nothing per user is stored, and L2 refuses to start if a derived address differs
  from the ledger ([R3](research.md#r3-per-user-accounts-inside-the-signer)).
- **The portal** (`src/portal/`, port 4025) serves a web app and a JSON API. It verifies the person's Entra token
  (same API app as the agent, a separate scope and client), keeps names and emails in its own store, reads balances
  from the network, talks to the card vault, and reaches L2 with a new role token, `PORTAL_TOKEN`, that can do
  nothing else. No user-typed text ever reaches L2 ([R6](research.md#r6-no-user-typed-text-crosses-into-l2)).
- **Cards** are saved in Stripe's test mode through its hosted fields, with a restricted key that can't charge.
  The system stores no card data; the ledger records only an opaque card identifier.
- **The agent** gets no new tool and no new input. The hosted service names the user from the verified requester;
  a system identity names none and keeps today's platform account.
- **Loosening a policy** needs the person to have signed in within 15 minutes; L2 decides what counts as loosening.
- **Azure**: a sixth unit, `portal`, with its own image, identity, vault, file share and pipeline; two more
  always-referenced secrets in L2's vault.

Off by default (`USER_ACCOUNTS=1` in L2 turns it on), so the local demo and every existing test are unchanged.

Contract changes: `PaymentIntent.userId?`, `BudgetStatus.scope?`, `AuthorizationGatePort.budget(sessionId, userId?)`,
and the portal↔L2 shapes ([control-api.md](contracts/control-api.md)). `AuthorizationDecision` is unchanged.

## Technical Context

**Language/Version**: TypeScript (strict), ESM, Node.js ≥ 22.13 (development on Node 26). The web app is TypeScript
with JSX, compiled for browsers by Vite.

**Primary Dependencies**:
- Server, nothing new at run time: `express`, `jose` (already pinned; token verification moves to `src/shared/`),
  `viem` (`mnemonicToAccount` in the signer; a read-only public client in the portal), global `fetch` for the card
  vault. No Stripe or Microsoft package on the server.
- Web app, all devDependencies (bundled at build time): React 19, `@azure/msal-browser` 5.x and Vite 8, which
  compiles the JSX itself (as built: `@vitejs/plugin-react` was not needed and is not installed); Stripe.js is
  loaded from Stripe at run time. No router, state or component library
  ([R10](research.md#r10-the-web-apps-stack)).
- Tests: `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `axe-core`.

Exact versions are pinned when slice 4 starts; `@azure/msal-browser` 5.29.0 was current on 2026-11-10.

**Storage**:
- The existing hash-chained JSONL ledger: 12 new entry types and new fields on five existing ones
  ([data-model.md](data-model.md#ledger-entries)). Still L2's only store.
- A profile store owned by the portal: one small JSON file per user
  ([R9](research.md#r9-where-profiles-are-kept)).
- Card data: none here; the card vault holds it.

**Testing**: vitest. Pure tests for the rules and derived state; in-process L2 and in-process portal against a card
vault stand-in, a fake balance reader and the dev issuer; component tests in jsdom; one two-user end-to-end test on
the local chain; architecture rules with fixtures; OpenAPI, image, IaC and workflow tests for the new unit
([R15](research.md#r15-testing-approach)).

**Target Platform**: the local multi-process PoC on loopback (feature off by default), and the Azure profile on
Base Sepolia (Container Apps, Key Vault, Azure Files). Modern evergreen browsers for the web app.

**Project Type**: a multi-process service with a three-layer split, plus a web application (backend and frontend)
as a new process.

**Performance Goals**:
- a payment that needs no human is decided within 50 ms of today's time with 100 users and 10 policies each
  (NFR-010, T-USR-12);
- neither the portal nor the card vault is on the decision path (NFR-005);
- a balance shown is at most 30 s old (FR-015): 20 s cache plus the read;
- a policy change applies to the next decision recorded after it (SC-004).

**Constraints**:
- L2 still binds 127.0.0.1 only and gains no public route (FR-048);
- the policy engine stays pure; time is an input; no free text is a decision input;
- budgets come from the ledger; no counter, and no authoritative cache of users or policies;
- every policy and account write is inside the serialized section, with no network call inside it;
- the ledger stays append-only and holds no name, email, policy name, card detail or key;
- amounts are atomic strings and `BigInt` everywhere, in the browser too;
- the `demo:local` summary and the L1-4 baseline are unchanged (NFR-008).

**Scale/Scope**: about 100 users, 10 active policies each, 5 cards each. 11 screens. One portal replica. A linear
ledger scan per operation, as today.

No item is NEEDS CLARIFICATION. [research.md](research.md) records each decision (R1–R18) and marks the three
external facts that could not be confirmed from documentation, each with a check in
[quickstart.md](quickstart.md).

## Constitution Check

*GATE: must pass before Phase 0 research, and again after Phase 1 design.*

| Principle | Check | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of payment authority | Deciding and signing stay in `src/layer2-control/`. The portal is a separate process and folder, under rule A1, with no key (A4, A11, A12 and a startup refusal). The agent gains no tool, input, route or credential for profiles, wallets or policies (FR-006): `userId` is set by service code from the verified requester. L3 is untouched. People, not the agent, edit policy. | PASS, with the amendment below | PASS. The portal token is refused on every deciding, approving and reconciling route (T-USR-02) |
| II. Deterministic, pure policy | `policy.ts` stays pure (A6 unchanged). The two new rules and the ceiling read only `ctx.user`, derived from the ledger. Policy selection and the effective mandate are pure functions. A policy change and a decision are ordered by the one serialized section (FR-036). INV-12 is unchanged: an approved escalation is re-evaluated against the policy in force. | PASS | PASS |
| III. Ledger is the single source of truth | Users, wallets, policies, card events, account state and the platform config are ledger entries. Budgets are `committedAtomic` with a user and a policy filter; no counter. State is re-derived per operation; nothing else is authoritative. | PASS | PASS. The profile store holds only what must stay out of an append-only ledger (FR-046) and nothing a decision reads |
| IV. Trust the chain | L3 and settlement are unchanged. T-E2E-12 has L3 confirm that each user's transfer came from that user's account. | PASS | PASS |
| V. Least-privilege credentials | Three new credentials, each with one holder and one module: `PORTAL_TOKEN` (portal→L2, a fifth role), `USER_WALLET_MNEMONIC` (L2, `signer.ts`, rule A11), `CARD_VAULT_KEY` (portal, `card-vault.ts`, rule A10). The person's token is verified by the portal and never forwarded. L2 and L3 keep their loopback bind. | PASS, with the amendment below | PASS. The card key is a restricted key that can't charge |
| VI. Exact money arithmetic | Atomic strings and `BigInt` in L2, the portal and the web app. USDC text is parsed by one shared function that refuses a seventh decimal instead of rounding (FR-025). | PASS | PASS |
| VII. Protocol fidelity | x402 handling is unchanged; the signer still signs one requirement through the SDK, now with a per-user account. Cards are outside x402 and never pay. | PASS | PASS |
| VIII. Proven safety | Ten must-fail proofs ([Proofs](#proofs-constitution-viii)). Every new rule, entry, route and field has a test. | PASS | PASS |
| Quality gates | typecheck (now two projects), the full suite, an unchanged demo summary, SPEC v1.10 in the same change, requirement IDs in test names. | PASS | PASS |

**Amendments made in the same change, not violations** (the spec's Assumptions asked for them):

- **Constitution 1.3.0 → 1.4.0 (MINOR).**
  - Technology & Scope: multi-tenancy leaves the out-of-scope list; "a persistent DB beyond JSONL" stays out. The
    stack gains, for the portal only, React, Vite and `@azure/msal-browser` (build time), and the
    card vault (Stripe test mode) reached over HTTPS from the portal only.
  - Principle I gains one sentence: people edit policy in the portal; the agent never does.
  - Principle V gains the portal role credential, the wallet mnemonic and the card vault credential, and names the
    portal as the second public process, holding no payment key.
  - Residual risks gain: the agent service is trusted to name the user; a stolen portal sign-in can loosen a policy
    up to the platform limits after a fresh sign-in; one mnemonic covers every user's test funds; the card vault
    sees card details.
- **SPEC §1.3** loses "Multi-tenant users". No invariant is removed or redefined.

No unjustified violation, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/013-l2-portal-onboarding/
├── spec.md
├── plan.md                      # this file
├── research.md                  # Phase 0: R1–R18
├── data-model.md                # Phase 1: stores, entries, derived state, the user decision, views
├── quickstart.md                # Phase 1: validation guide, local to Azure
├── contracts/
│   ├── control-api.md           # L2-5 delta and §7: intent, budget, the portal routes, roles
│   ├── portal-api.md            # browser → portal: access checks, routes, order of writes, hosted-agent delta
│   ├── portal-ui.md             # screens, the policy summary, accessibility
│   ├── card-vault.md            # portal → Stripe test mode
│   └── config-and-secrets.md    # CFG-2, CFG-4, §3.3, rules A10–A12, Azure, image, pipeline
├── checklists/requirements.md
└── tasks.md                     # Phase 2 (/speckit-tasks)
```

### Source code (repository root)

```text
src/
├── shared/
│   ├── contracts.ts             # CHANGED  PaymentIntent.userId, BudgetStatus.scope, budget(sessionId, userId?),
│   │                            #          UserView, PolicyView, PolicyValues, PolicyIssue, PlatformView
│   ├── user-id.ts               # NEW      userIdFor(tid, oid), USER_ID_RE (pure)
│   ├── entra-token.ts           # NEW      token verification moved out of L1; dev issuer constants
│   ├── config.ts                # CHANGED  role portal-control, PORTAL_TOKEN, EnvRole portal, port 4025, parseUsdc
│   ├── auth.ts                  # CHANGED  ENDPOINT_ROLES gains the portal routes
│   └── api-docs.ts              # CHANGED  the portal's Swagger UI
├── layer2-control/
│   ├── users.ts                 # NEW      pure: user and policy state, validation, loosening, selectPolicy,
│   │                            #          effectiveMandate, userGate, views
│   ├── platform.ts              # NEW      config/platform.json loader, validation, digest
│   ├── user-routes.ts           # NEW      the portal routes (PORTAL_TOKEN), inside the serialized section
│   ├── policy.ts                # CHANGED  ctx.user; R16, R17; R12 extended
│   ├── signer.ts                # CHANGED  WalletKeyring: addressOf(index), signerFor(index, cap)
│   ├── ledger.ts                # CHANGED  12 entry types; committedAtomic and authorizedSince filters
│   ├── service.ts               # CHANGED  the user decision path; budget for a user; startup checks; mounts
│   ├── escalations.ts           # CHANGED  userId on pending items and escalated events
│   └── mandate.ts               # unchanged (the platform account's mandate)
├── layer1-intent/
│   ├── orchestrator.ts          # CHANGED  optional userId on intents
│   ├── ports-http.ts            # CHANGED  budget(sessionId, userId?)
│   └── hosted/
│       ├── requester-auth.ts    # CHANGED  built on shared/entra-token; scp and azp checks
│       ├── server.ts, agent.ts  # CHANGED  userId for kind "user", from the verified requester
│       └── config.ts            # CHANGED  optional PORTAL_CLIENT_ID
├── portal/                      # NEW      area PORTAL in the architecture test
│   ├── server.ts                #          createPortalApp: static files, /api, headers, limits
│   ├── access.ts                #          the person's token: scp, azp, idtyp, roles, auth_time
│   ├── control-client.ts        #          the only caller of L2's portal routes
│   ├── profile-store.ts         #          one file per user, atomic writes
│   ├── balance.ts               #          read-only balanceOf with a 20 s cache
│   ├── card-vault.ts            #          the only holder of CARD_VAULT_KEY (A10)
│   ├── cards.ts                 #          add, list, remove, reconcile
│   ├── routes.ts                #          profile, wallet, policies, account
│   ├── config.ts, log.ts, api-docs.ts
├── portal-main.ts               # NEW      entry point, outside src/portal/: refuses if a payment key is visible
└── layer3-settlement/, counterparty/     # unchanged

web/portal/                      # NEW      the web app (React, Vite); its own tsconfig
├── index.html, redirect.html
├── src/
│   ├── main.tsx, app.tsx, routes.ts
│   ├── auth/                    #          entra.ts (msal-browser), dev.ts (pasted token), step-up
│   ├── api.ts                   #          the portal API client
│   ├── money.ts                 #          parse and format through atomic strings
│   ├── summary.ts               #          summarizePolicy (pure)
│   ├── screens/                 #          home, onboarding, profile, wallet, policies, history, account
│   └── components/              #          fields, error summary, dialog, banners
└── test/                        #          T-WEB-01..08

config/platform.json             # NEW      CFG-4
env/portal.env.example           # NEW
env/l2-control.env.example, env/l1-hosted.env.example   # CHANGED
docs/portal.openapi.yaml         # NEW
docs/l2-control.openapi.yaml, docs/l1-hosted.openapi.yaml   # CHANGED
docker/portal.Dockerfile         # NEW
scripts/
├── image-closure.ts             # CHANGED  IMAGES.portal
├── demo-lib.ts, stack-local.ts  # CHANGED  --users
├── dev-issuer-lib.ts, dev-token.ts   # CHANGED  scp, azp, auth_time; --portal
├── vscode-local.ts              # CHANGED  role portal
├── fund-user.ts                 # NEW      local MockUSDC to a user's account
└── wallet-mnemonic.ts           # NEW      prints one new mnemonic; reads nothing
infra/
├── main.bicep, main.dev.bicepparam            # CHANGED  unit portal, userAccounts, names
├── pre-deploy.bicep, pre-deploy.dev.bicepparam   # CHANGED  scope, claims, the web app's registration
├── modules/portal-apps.bicep                  # NEW
├── modules/l2-apps.bicep, l1-apps.bicep, storage.bicep, environments.bicep   # CHANGED
└── cleanup.sh                                 # CHANGED  three app registrations
.github/workflows/deploy-portal.yml            # NEW
.github/workflows/deploy.yml                   # CHANGED  step 0 case, wait, portal-smoke
.vscode/launch.json, package.json, tsconfig.json, vitest.config.ts   # CHANGED

test/
├── users.test.ts                # NEW      T-USR-01..12
├── portal.test.ts               # NEW      T-PRT-01..09
├── card-vault.test.ts           # NEW      T-CARD-01..06
├── openapi-portal.test.ts       # NEW      T-API-12..15
├── helpers/card-vault-stub.ts, helpers/portal.ts   # NEW
├── fixtures/arch/a10-, a11-, a12-violation.ts      # NEW
└── policy, ledger, architecture, agent, hosted-*, e2e.local, openapi*, images, infra,
    deploy-workflow, vscode-local, cleanup          # CHANGED
```

**Structure Decision**: the existing single repository and its layer folders, plus two additions: `src/portal/`
(a new area with its own isolation rule and its own image) and `web/portal/` (browser code, kept out of `src/` so
the Node build, the image closure and the layer rules never see it). L2's new code stays in
`src/layer2-control/`, so the signer, the ledger and the serialized section are not shared with anything
([R1](research.md#r1-which-processes-and-where-the-code-lives)).

## Design

### The decision for a user payment (`service.ts`, `users.ts`, `policy.ts`)

`decideOnce` keeps its six steps. With user accounts on and `intent.userId` present:

1. As today: clock, sweep, `INTENT` (now with `userId`).
2. `state = userState(entries, userId)`; the approval and rejection lookups also match `userId`.
3. `gate = userGate(state)`; `policy = selectPolicy(state, host, platform)`;
   `mandate = effectiveMandate(policy, platform, platformMandate, net)`; the context is built with the user and
   policy filters and `ctx.user`.
4. `decide(accepts, mandate, ctx)`: unchanged function.
5. Sign with `keyring.signerFor(state.wallet.walletIndex, mandate.hardCapPerPaymentAtomic)`, after checking the
   derived address.
6. The outcome entry, with `userId`, and `policyId` and `policyVersion` when a policy applied.

The full tables are in [data-model.md](data-model.md#the-decision-for-a-user-payment). Without `userId`, none of
this runs and the platform account's path is the code of v1.8, with one change: its budgets count only entries
that have no `userId`.

The 012 wait and second decision are unchanged; the second decision re-derives the user's state, so a policy
paused, or an account disabled, during the wait is seen (FR-036, US7 scenario 5).

### Policy and account writes (`user-routes.ts`)

Every route runs `serialize(() => …)`: read the state, validate against the platform config, check ownership,
check loosening against the current version, append. No network call happens inside. Each write is idempotent as
[data-model.md](data-model.md#derived-state-srclayer2-controlusersts-pure-functions-over-ledger-entries)
describes. Enabling an account appends its `POLICY_PAUSED` entries and `USER_ENABLED` in one section, so no
decision can see an enabled account with a still-active policy.

### Accounts (`signer.ts`)

`WalletKeyring(mnemonic, net)` is the only code that touches the mnemonic. `addressOf(index)` and
`signerFor(index, hardCapAtomic)` return a `PaymentSignerLike` with the same SDK spend controls as today. The
mnemonic never leaves the object; nothing logs it. `main()` checks every recorded wallet at startup.

### The portal (`src/portal/`)

- `access.ts` builds on `shared/entra-token.ts` and adds the portal's checks
  ([portal-api.md](contracts/portal-api.md#access-fr-003-fr-005-sec-19-sec-20)).
- `routes.ts` never takes a user identifier from a request; it passes `userIdFor(tid, oid)` to `control-client.ts`.
- `profile-store.ts` is the only reader and writer of profile files, and takes the `userId` as its only key.
- `cards.ts` and `card-vault.ts` follow [card-vault.md](contracts/card-vault.md).
- `server.ts` serves `dist/portal-web` with the headers of
  [portal-api.md](contracts/portal-api.md#limits-and-headers); unknown paths outside `/api` return `index.html`.

### The web app (`web/portal/`)

Screens and behavior are in [portal-ui.md](contracts/portal-ui.md). Two auth adapters behind one interface: Entra
(`msal-browser`, with the redirect bridge page) and dev (a pasted token), chosen from `/api/config`. Step-up is one
function: on 403 `step_up_required`, sign in again with `prompt: "login"` and replay the request once.

### The hosted agent (`src/layer1-intent/hosted/`)

Per [portal-api.md](contracts/portal-api.md#hosted-agent-delta-l1-6): the user on every intent and budget call of
a person's run, none for a system identity, and the `scp`/`azp` check.

### Azure

Per [config-and-secrets.md](contracts/config-and-secrets.md#azure) and
[R16](research.md#r16-the-portal-as-an-azure-unit).

## Requirement traceability

| Requirement | Where | Test |
|---|---|---|
| FR-001, FR-002 off by default; no user → platform account; a person never falls back | `service.ts`, [R14](research.md#r14-turning-it-on-and-staying-compatible) | T-USR-06, T-USR-11, T-E2E-01 unchanged |
| FR-003, FR-005 sign-in; one permission; token separation | `portal/access.ts`, `requester-auth.ts`, `pre-deploy.bicep` | T-PRT-01, T-AGT-07, T-IAC-01 rule 16 |
| FR-004 own data only | `routes.ts` (no user input), `user-routes.ts` (ownership) | T-PRT-02, T-USR-03 |
| FR-006 the agent gains nothing | tools unchanged; A12 | T-AGT-06, T-ARCH-A12 |
| FR-007, FR-039 step-up | `users.ts` loosening, `access.ts` `auth_time` | T-USR-05, T-PRT-05, T-WEB-05 |
| FR-008..FR-011 onboarding and profile | `routes.ts`, `profile-store.ts`, screens | T-PRT-03, T-WEB-01, T-WEB-02 |
| FR-012 `user_not_onboarded` | `policy.ts` R16 | T-POL-16 |
| FR-013, FR-014, FR-017 account, key, own signer | `signer.ts`, `user-routes.ts` | T-USR-04, T-USR-08, T-USR-11, T-E2E-12, T-ARCH-A11 |
| FR-015, FR-016 wallet figures; no way out | `balance.ts`, `UserView`, no route | T-PRT-04, T-USR-01 |
| FR-018..FR-023 cards | `card-vault.ts`, `cards.ts`, wallet screen | T-CARD-01..06, T-WEB-06, T-ARCH-A10 |
| FR-024..FR-028 writing a policy | `users.ts` validation, editor, `summary.ts` | T-USR-09, T-PRT-05, T-WEB-03, T-WEB-04 |
| FR-029, FR-030 selection; the mandate | `selectPolicy`, `effectiveMandate` | T-USR-10, T-POL-19 |
| FR-031, FR-032 budgets per user and policy; the ceiling | `ledger.ts` filters, `policy.ts` R12 | T-LED-06, T-POL-18, T-USR-11 |
| FR-033 the user is the verified person | `hosted/server.ts` | T-AGT-06 |
| FR-034 approvals unchanged | no change; lookups also match `userId` | T-E2E-02, T-E2E-10 unchanged; T-E2E-13 |
| FR-035, FR-036 change, pause, resume, remove; serialized | `user-routes.ts` | T-USR-04, T-USR-09, T-USR-11 |
| FR-037..FR-040 disable and enable | `users.ts`, `policy.ts` R17 | T-POL-17, T-USR-11, T-E2E-13 |
| FR-041..FR-043 platform limits; seller list; flags | `platform.ts`, `effectiveMandate`, views | T-USR-07, T-USR-10 |
| FR-044..FR-047 recording; no personal data; history | `ledger.ts`, views | T-LED-06, T-USR-01, T-PRT-08 |
| FR-048, FR-049 portal apart; its own role | process and folder; `auth.ts` | T-USR-02, T-PRT-09, T-ARCH (A1, A4, A12), T-IAC-01 rule 21 |
| NFR-001, NFR-002 monotonic; fail closed | `effectiveMandate`; gates | T-USR-10, T-USR-11 |
| NFR-003, NFR-004 secrets; privacy | log whitelists; R6 | T-PRT-08, T-CARD-06, scan in T-E2E-12 |
| NFR-005 availability | nothing on the decision path | T-PRT-06, T-CARD-05 |
| NFR-006 untrusted text | no text into L2; text rendering | T-USR-01 (schema), T-WEB-07 |
| NFR-007 proven safety | [Proofs](#proofs-constitution-viii) | the must-fail tests |
| NFR-008 regression | flag off | T-E2E-01, `demo:local` |
| NFR-009 accessibility | [portal-ui.md](contracts/portal-ui.md#accessibility-and-layout-nfr-009) | T-WEB-08, manual pass |
| NFR-010 capacity | linear scans, measured | T-USR-12 |

## Proofs (Constitution VIII)

Each safety mechanism has a test that fails without it. The switches are test-only deps of
`createControlService`, `createPortalApp` or `createHostedApp`, never environment variables.

| Mechanism | Switch | Without it | Test |
|---|---|---|---|
| Ownership check (FR-004) | `skipOwnershipCheck` | user A reads and changes user B's policy | T-USR-03, T-PRT-02 |
| Per-user account (FR-017) | `sharedSigner` | A's payment is signed with the platform account | T-USR-11 |
| Per-user budgets (FR-031) | `sharedBudgets` | A's spending uses up B's daily budget | T-USR-11 |
| Platform bound (FR-041) | `skipPlatformBound` | a 0.08 payment passes a platform cap of 0.05 | T-USR-10 |
| User daily ceiling (FR-032) | `skipUserCeiling` | two policies together pay more than the ceiling | T-POL-18 |
| Disabled-account rule (FR-038) | `skipUserGate` | a disabled user's run pays | T-POL-17, T-USR-11 |
| No fallback (FR-002) | `fallbackToPlatform` | a person who has not onboarded pays from the platform account | T-USR-11 |
| One policy per seller (FR-028) | `skipSellerOverlapCheck` | two active policies list one seller | T-USR-10 |
| Serialized policy change (FR-036) | `unserializedUserWrites`, with `signerLatencyMs` | a decision's entries name two versions | T-USR-11 |
| Token separation (FR-005) | `bypassAuth` (portal), no `scp`/`azp` check (agent) | each service accepts the other's token | T-PRT-01, T-AGT-07 |

## Tests defined here

The contracts define T-USR-01..08, T-PRT-01..09, T-WEB-01..08, T-CARD-01..06, T-AGT-06..07, T-API-12..15 and
T-ARCH-A10..A12. The rest:

| ID | File | Covers |
|---|---|---|
| T-POL-16 | `test/policy.test.ts` | `user_not_onboarded`: evaluated first, returns immediately, fixed detail, no other violation listed |
| T-POL-17 | same | `user_disabled`: the same shape. **Must fail** with `skipUserGate` |
| T-POL-18 | same | the user daily ceiling under `daily_budget_exceeded`: at the limit, one atomic unit over, one violation when the policy's own budget also fails. **Must fail** with `skipUserCeiling` |
| T-POL-19 | same | without `ctx.user`, every existing rule test gives the v1.8 result; `policy.ts` stays pure (A6) |
| T-LED-06 | `test/ledger.test.ts` | the 12 entry types hash and verify; `committedAtomic` and `authorizedSince` with `userId` (a user, `null`) and `policyId`; user entries never count for the platform account |
| T-USR-09 | `test/users.test.ts` | pure: the policy state machine, every validation code, loosening against the previous version, idempotent writes, version conflict |
| T-USR-10 | same | pure: `selectPolicy` and `effectiveMandate`: one policy per seller, no policy, an unlisted seller, platform limits tightened after the save, the cap at or below the auto-approve limit. **Must fail** with `skipPlatformBound` and `skipSellerOverlapCheck` |
| T-USR-11 | same | in-process decisions for two users: own account, own budgets, no fallback, disabled, a policy change racing a decision. **Must fail** with `sharedSigner`, `sharedBudgets`, `fallbackToPlatform`, `unserializedUserWrites` |
| T-USR-12 | same | 100 users with 10 policies each and their history: the added decision time stays under 50 ms (NFR-010) |
| T-E2E-12 | `test/e2e.local.test.ts` | two users on the local chain through the real orchestrator: each payment is signed by, and settles from, its own user's account; L3 confirms each transfer; a known-value scan of the ledger and logs for the mnemonic and both tokens |
| T-E2E-13 | same | disable and enable through the stack: a pending escalation approved after the disable is denied at payment time; after enable the policy is paused; after resume the payment is authorized |

## SPEC and governance changes (same change)

SPEC.md v1.8 → **v1.10**, with a "Changes in 1.10" table:

| Section | Change |
|---|---|
| §1.2, §1.3 | multi-user in scope; cards registered only; card payments, withdrawals and per-user approval out |
| §2 | glossary: user, portal, wallet, expense policy, platform limits, seller list, user daily ceiling, platform account |
| §3.1 | the portal process (4025) and the Azure unit; the data-flow note that the portal is never on the decision path |
| §3.3 | the Portal column and four rows ([config-and-secrets.md](contracts/config-and-secrets.md#33-credential-matrix-new-rows-and-columns)) |
| §4, §4.1 | INV-2 names the mnemonic; INV-13 names the fifth role; rules A1 and A4 extended, A10–A12 new |
| §5, §6 | the web app's packages; the new files |
| §7 | `PaymentIntent.userId`, `BudgetStatus.scope`, the port, the portal shapes |
| L1-6 | the user on intents and budget calls; the `scp`/`azp` check |
| L2-1 | the mandate for a user payment; the platform account's mandate unchanged |
| L2-2 | R16, R17, R12 extended; the context per user and policy |
| L2-3 | the keyring |
| L2-4, L2-4.1 | the 12 entry types, the new fields, the filters |
| L2-5 | the changed routes and the portal routes; the authorize algorithm's step 3 and 5 |
| L2-8 (new) | user accounts and the portal: state, validation, loosening, disable and enable, cards, what is never stored |
| CFG-2, CFG-4 | the new variables and `env/portal.env`; `config/platform.json` |
| §11 | SEC-19 cross-user access; SEC-20 a token for one service used at the other; SEC-21 a stolen portal sign-in loosens a policy; SEC-22 card data or the vault key exposed; SEC-23 a forged or omitted user on an intent; SEC-24 the wallet mnemonic. New residual risks |
| §12, §13 | the tests above; `portal`, `build:web`, `fund-user`, `wallet-mnemonic`, `stack:local -- --users`, `dev-token -- --portal` |

Also in the same change:
- `.specify/memory/constitution.md` → 1.4.0, with a Sync Impact Report.
- `specs/README.md`: the 013 row and the traceability rows.
- `specs/007` contracts/threat-matrix.md: SEC-19..24 (`SEC_ROWS` goes to 24).
- `specs/011` contracts: hosted-agent-api.md, cloud-topology.md, deploy-pipeline.md.
- `CLAUDE.md`: the portal in "What this repo is", the commands, hard rule 2 (the mnemonic; `scripts/` may also
  generate a new mnemonic), hard rule 10 (five roles), "New policy for the portal" under common changes, and the
  gotchas (always-referenced secrets, the late redirect URI, never rotate the mnemonic in place).
- `README.md`, `docs/diagrams/x402-architecture.json`: the portal.

## Change of identity provider (2026-11-10)

The first build signs people in with Microsoft Entra ID. Per the clarifications of the same day, **Auth0 replaces
it for people**, at the portal and at the hosted agent service; system identities stay on Entra. The decision, its
alternatives and the facts still to verify are in [R19](research.md#r19-auth0-as-the-identity-provider-for-people).
Where this section and an earlier one disagree, this one holds. Tasks: Phase 14.

| Area | First build | Now |
|---|---|---|
| People's sign-in | Entra, one API app, scopes `user_impersonation` and `Portal.Access` | Auth0, one API, permission `agent:run` in the token, client allow-lists per service |
| Who may onboard | the Entra app role `Agent.Run`, assigned in `pre-deploy.bicep` | the Auth0 role `x402-user`, assigned per person by an administrator |
| System identities | Entra app tokens | unchanged, agent service only; never at the portal |
| Shared verifier | `src/shared/entra-token.ts` | `src/shared/identity-token.ts`: the Auth0 checks for people, the Entra checks for app tokens |
| User identifier | `x402-user-v1`, tenant and object ID | `x402-user-v2`, issuer host and `sub`; everyone onboards again |
| Step-up source | Entra's `auth_time` optional claim | a namespaced claim set by a post-login Action |
| Web sign-in | `@azure/msal-browser`, `redirect.html` | `@auth0/auth0-spa-js` behind the same `Auth` adapter; no page of its own, if R19's third check holds |
| Getting an agent token | Azure CLI | a native client with the device flow, `npm run user-token` |
| Identity as code | app registrations in `infra/pre-deploy.bicep` | the API, role, clients and Action in `auth0/` (Terraform, `provision-auth0.yml`); the Entra additions of this feature are removed |
| Parameters | `userAccounts.portalClientId` (a GUID), `portalOrigin`, `portalPreAuthorized` | an `identity` object in `main.<env>.bicepparam` from Terraform's output; the two `portal…` parameters of `pre-deploy` go |

**Constitution check.** Principle V names the requester credential as an Entra ID token: it becomes "the token a
person or a system presents", with people on Auth0 and systems on Entra, still verified by L1 and the portal only
and never forwarded. No principle is weakened: the portal still holds no key, the two services still refuse each
other's tokens, and L2 still decides step-up. This is a MINOR amendment (1.6.0), made with SPEC v1.12.

**What does not change.** L2, the ledger, the policy engine, every portal route and screen, the card vault, the
Azure unit's shape, and every test that uses the dev issuer's helpers rather than a claim name.

## As built (2026-11-10)

Where the build differs from the plan above. The contracts and SPEC.md describe the build.

| Planned | As built | Why |
|---|---|---|
| `@vitejs/plugin-react` | not installed | Vite 8 compiles JSX for the build and for vitest; the plugin only adds dev-server fast refresh, and there is no dev server |
| SPEC v1.9, T-IAC-01 rule 20 | SPEC v1.10, rule 21 | `main` took v1.9 and rule 20 for the Auth0 pipeline while this feature was open |
| T-API-11..14 for the portal's document | T-API-12..15 | T-API-11 was already the seller's |
| the web app pre-authorized for `Portal.Access` in one deployment of `pre-deploy.bicep` | two deployments, `portalPreAuthorized` false and then true | Entra refuses to pre-authorize a scope in the update that adds it ([config-and-secrets.md](contracts/config-and-secrets.md#infrapre-deploybicep)) |
| no limit before authentication | 300 requests a minute per client address before a token is verified, on the portal and the hosted agent (`express-rate-limit`, `TRUSTED_PROXY_HOPS`) | CodeQL's missing-rate-limiting finding on both public services; the one-hop setting in Azure is not yet confirmed (task T124) |
| one commit per slice | one commit for the implementation | the slices were built in order, then committed together |

## Delivery

Six slices, each mergeable with user accounts off and each leaving `npm run check` green
([R18](research.md#r18-delivery-in-slices)): L2 user accounts; the hosted agent and the shared verifier; the portal
backend; the web app; cards; Azure. `/speckit-tasks` orders the tasks along them. Slice 1 holds all payment
authority and nine of the ten proofs.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| `auth_time` does not behave as assumed (R5, unverified) | loosening always refused, or accepted when stale | fail-closed default; the two tenant checks in quickstart §5 before enabling; Conditional Access as the fallback |
| A compromised agent service names another user, or none | spends within that user's policy, or the platform mandate | accepted residual risk (spec); platform limits bound both; SEC-23 |
| The mnemonic is lost or replaced | users' test funds are unreachable; L2 refuses to start on a mismatch | backup with the payer key; the startup check; never rotated in place |
| A stolen portal sign-in | policies loosened up to the platform limits | step-up for loosening; platform limits; in-memory or session-only token; strict CSP; no HTML rendering of typed text |
| Linear scans grow with the ledger | decisions slow down as users and history grow | T-USR-12 at the spec's scale; a derived index as the fallback (R4); EXT-6 for real growth |
| Card vault and ledger disagree after a partial failure | a card shown without its entry, or the reverse | the order of writes and reconcile-on-list (R8); T-CARD-04 |
| The redirect URI is registered after the first deployment | nobody can sign in until `pre-deploy.bicep` is applied again | a quickstart step; the portal's sign-in error says which URI to register |
| A second public app | more internet-facing surface | no key and no deciding route in it; rule 3 lists it by name; `portal-smoke` checks it answers 401 without a token |
| The feature is large | long review, late surprises | six slices; the authority-bearing slice first and without any UI |
| Stripe's API moves (two breaking releases a year) | card calls start failing | the version is pinned in one constant and in the Stripe.js URL; six calls to re-check |

## Complexity Tracking

No violations to justify. The constitution amendments above are part of this change and were called for by the
spec.
