# Implementation Plan: Connected Platforms in the L2 Portal: Coinbase Balances

**Branch**: `020-coinbase-wallet-balances` (work on `claude/l2-wallet-balances-spec-0f05e7`) | **Date**: 2026-11-25 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/020-coinbase-wallet-balances/spec.md`, with the three clarifications of
session 2026-11-25 (the user's Coinbase account, not a self-custody address; a connection that lasts until
disconnected; each asset's units plus Coinbase's value and a Coinbase total).

## Summary

A registered user connects their Coinbase account from the portal's wallet and sees its balances there, view only,
beside the L2 account their agent pays from.

- **The portal is Coinbase's OAuth client.** Authorization code with PKCE (S256) and a `state` bound to the person's
  verified token (its user and its sign-in time), single use, 10 minutes. The browser goes to Coinbase in the same tab and comes back to a new
  screen, `/wallet/coinbase`, which hands the code to the portal with the person's token. The portal exchanges it
  with the project's client secret ([R2](research.md#r2-the-oauth-flow), [R3](research.md#r3-pkce-state-and-the-client-secret)).
- **Read only, checked.** The portal asks for the read scopes of an allow-list and refuses, and revokes at once, a
  grant whose scopes are anything else ([R4](research.md#r4-scopes-the-read-only-allow-list)).
- **The grant lives in one place.** A new folder, `src/portal/coinbase/`, holds the only two files that name the
  client secret (`client.ts`) and the sealing key (`grants.ts`), enforced by a new architecture rule, A18. Each
  user's refresh token is sealed with AES-256-GCM bound to the user, the connection and the platform, in one file
  per user on the portal's share; the access token stays in memory ([R5](research.md#r5-keeping-the-grant)).
- **Balances** are read from Coinbase's accounts list on demand, at most every 10 s per user, kept 20 s in memory,
  never stored. Coinbase's accounts carry no value in the person's currency any more, so each value is the amount
  at Coinbase's public USD rate, rounded to the cent; amounts stay decimal strings end to end and the total is an
  exact decimal sum, in a new pure `src/shared/decimal.ts` ([R7](research.md#r7-balances-and-coinbases-valuation),
  [R11](research.md#r11-exact-decimals)). The spec's "user's currency" becomes USD.
- **Revocation is checked, not trusted.** Coinbase's revoke answers 200 whatever happens, so the portal confirms a
  revocation by a 401 on the revoked token ([R15](research.md#r15-revocation-that-coinbase-doesnt-confirm)).
- **Coinbase's terms** ask for a privacy policy and a support contact before collecting end-user data: two required
  settings, linked before a person connects (new FR-030, [R8](research.md#r8-registering-the-client-and-coinbases-terms)).
- **L2 records what happened, and nothing else.** Two new ledger entry types, `CONNECTION_OPENED` and
  `CONNECTION_CLOSED`, written by two new user-account routes that take identifiers only, like the cards of
  013. The portal reconciles its grant file against L2 on every wallet read, so a partial failure ends with fewer
  connections, never with a grant the ledger doesn't show ([R9](research.md#r9-the-audit-trail-in-l2)).
- **Nothing touches payments.** In `src/shared/contracts.ts` only `UserView` changes: it gains `connections`
  (`UserConnectionView`, with `ConnectedPlatform`); `PaymentIntent`, `AuthorizationDecision` and `BudgetStatus` don't.
  The agent, its two tools, `check_budget`, policy, budgets, approvals and reconciliation are untouched; A18 part 3
  keeps the decision path from naming a connection.

Off by default (`CONNECTED_PLATFORMS` unset), so the local demo and every existing test are unchanged.

**Blocker outside the code** ([R0](research.md#r0-a-blocker-outside-the-code-coinbase-isnt-issuing-oauth-clients)):
on 2026-11-25 Coinbase says new OAuth clients are temporarily not being created and are limited to approved
partners, with fees under its terms, and it has no sandbox. Slices 1–4 are built and tested against a stand-in
Coinbase; slice 5 (turning it on) waits for Coinbase to approve the project.

## Technical Context

**Language/Version**: TypeScript (strict), ESM, Node.js ≥ 22.13 (development on Node 26). The web app is TypeScript
with JSX, compiled by Vite.

**Primary Dependencies**: none new ([R10](research.md#r10-no-new-package)). Global `fetch` for Coinbase (as the card
vault calls Stripe), `node:crypto` for PKCE, `state` and AES-256-GCM, `express` for the routes. The web app adds no
package.

**Storage**:
- L2's hash-chained JSONL ledger: two new entry types ([contracts/control-api.md](contracts/control-api.md#ledger-entries-l2-4)).
- The portal's grant store: one sealed JSON file per user under `CONNECTION_DIR`, beside the profile store
  ([data-model.md](data-model.md#grant-store-portal)). No database.
- Memory: pending starts (10 min), access tokens (until expiry), balances (20 s).

**Testing**: vitest. A stand-in Coinbase over HTTP on loopback (`test/helpers/coinbase-stub.ts`, as
`ciba-stub.ts` stands in for Auth0) injected through the portal's test deps; pure tests for `decimal.ts`, the scope
check and the sealing; portal route tests against an in-process L2 with user accounts; component tests in jsdom;
architecture fixtures for A18; OpenAPI, IaC rule 26 and a two-user known-value scan
([R13](research.md#r13-testing)).

**Target Platform**: the portal process (local, the self-hosted VPS for dev, and the Azure profile on Base Sepolia).
Modern evergreen browsers.

**Project Type**: the existing multi-process service; this feature changes the portal (backend and web app) and adds
two routes and two entry types to L2.

**Performance Goals**: the wallet shows without waiting for Coinbase (balances load separately); balances within 3 s
with Coinbase answering (NFR-004) and within 5 s, stale or unreadable, when it doesn't (FR-016); no effect on payment
decisions (Coinbase is never on that path).

**Constraints**: read-only scopes only; no Coinbase data at L2, in the ledger, in logs or in browser storage; exact
decimal arithmetic; one portal replica (already `maxReplicas: 1`), on which the per-user serialization of rotating
refresh tokens relies ([R5](research.md#r5-keeping-the-grant)).

**Scale/Scope**: one platform; one connection per user; up to 200 assets listed per user; the deployment's few
dozen users. Four portal routes, one new screen, two L2 routes, two entry types, one architecture rule, one IaC rule.

## Constitution Check

*GATE: checked before Phase 0 and again after Phase 1 design (constitution v3.1.0).*

| Principle | Check | Before | After design |
|---|---|---|---|
| I. Separation of payment authority | The portal holds no payment key and signs nothing; the grant can't move funds (scope allow-list, R4); the agent gets no tool, input, route or credential (FR-022); no layer imports the portal's Coinbase code (A18 part 2). | Pass | Pass |
| II. Deterministic, pure policy | `policy.ts` gets no new input; no connection or balance reaches a decision (FR-020, A18 part 3). | Pass | Pass |
| III. Ledger is the single source of truth | Budgets are untouched. Connection history is two **new** entry types, appended inside the serialized section; nothing is rewritten. Coinbase balances are not facts the system records: they are read and shown. | Pass | Pass |
| IV. Trust the chain | Untouched: Coinbase figures are display only and labeled as Coinbase's. | Pass | Pass |
| V. Least-privilege credentials | Two new credentials (the OAuth client secret, each person's grant) and a sealing key, held by the portal only, confined to one folder by rule A18; the grant has read scopes only; no role token changes; the person's token stays the portal's. **Needs the MINOR amendment below.** | Pass with amendment | Pass with amendment |
| VI. Exact money arithmetic | Decimal strings only; each USD value is one scaled-`BigInt` division with one stated rounding (half-to-even, to the cent), the total an exact sum, in `decimal.ts`; no `Number(` in the web app (T-WEB-03). Displayed values move no money. | Pass | Pass |
| VII. Protocol fidelity | Untouched: no x402 change. | Pass | Pass |
| VIII. Proven safety | Eight must-fail switches in the portal (state, PKCE, scopes, grant binding, connection owner, replace revocation, serialized renewals, the revocation check), each with a test that fails with it on (contracts/portal-api.md); A18 fixtures; the identical-decisions test (SC-005). | Pass | Pass |
| Technology & scope | Reading a person's own balances at an outside account holding **real money** is new scope. Moving funds stays out. **Needs the MINOR amendment below.** | Pass with amendment | Pass with amendment |

**Constitution amendment (3.1.0 → 3.2.0, MINOR)**, made with SPEC.md in the same change (Governance):
- Technology & Scope: "Since 3.2.0 a person may connect their own Coinbase account to the portal, read only: the
  portal reads its balances and Coinbase's valuation of them over HTTPS, as Coinbase's OAuth client. Moving funds to
  or from a connected account, and any other platform, stay out."
- Principle V: a new bullet for the Coinbase client secret, each person's read-only grant and the sealing key: held
  by the portal only, confined to one folder by rule A18, never sent to another process, the model, a log or the
  browser; a grant with any scope beyond reading is refused and revoked; none of them is payment authority.
- Residual risks: a stolen portal sign-in can see that person's connected balances; a compromised portal can read
  the connected accounts of every user who connected (balances only, until each disconnects); Coinbase learns that
  the project's application reads the account; the single portal replica is what keeps a rotating refresh token from
  being used twice; a lost grant key makes every user reconnect; a renewal that reports its scope as `all` can't be
  checked against the allow-list (research R4).

No violation needs the Complexity Tracking table.

## Project Structure

### Documentation (this feature)

```text
specs/020-coinbase-wallet-balances/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── portal-api.md         # the four portal routes, the return screen, reconcile, must-fail switches
│   ├── portal-ui.md          # the wallet's two parts and the return screen
│   ├── control-api.md        # L2's two routes and two entry types
│   ├── coinbase.md           # every call the portal makes to Coinbase
│   └── config-and-secrets.md # CFG-2, §3.3, rule A18, IaC rule 26, the VPS
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── contracts.ts                # + UserView.connections (UserConnectionView, ConnectedPlatform); nothing else
│   ├── decimal.ts                  # NEW: exact decimal strings (validate, compare, add) by scaled BigInt; pure
│   └── portal-screens.ts           # + coinbase-return (/wallet/coinbase)
├── portal/
│   ├── coinbase/                   # NEW: the only place that names the Coinbase credentials (rule A18)
│   │   ├── client.ts               #   authorize URL, code exchange, renewal, revoke, accounts list; holds the client secret
│   │   ├── grants.ts               #   sealed grant files (AES-256-GCM, bound additional data); holds the sealing key
│   │   ├── scopes.ts               #   the read-only allow-list and its pure check
│   │   └── balances.ts             #   Coinbase accounts → PlatformBalances (filter, validate, sort, total); pure
│   ├── connections.ts              # NEW: start / complete / balances / disconnect / reconcile, per-user serialization
│   ├── routes.ts                   # + the four /api/connections routes; /api/wallet gains `connections`; disable disconnects
│   ├── config.ts                   # + CONNECTED_PLATFORMS, CONNECTION_DIR, the redirect; asks coinbase/ for the rest
│   ├── control-client.ts           # + putConnection / deleteConnection
│   └── log.ts                      # + the coinbase_* event labels (no new key)
├── layer2-control/
│   ├── ledger.ts                   # + CONNECTION_OPENED, CONNECTION_CLOSED
│   ├── users.ts                    # + connections, seenConnectionIds in userState; the platform list
│   └── user-routes.ts              # + PUT / DELETE /v1/users/:userId/connections/:connectionId
├── main.ts, hosted-main.ts, smoke-main.ts   # the three L1 entry points also refuse to start if COINBASE_CLIENT_SECRET or COINBASE_GRANT_KEY is visible
web/portal/src/
├── screens/Wallet.tsx              # two parts; the Coinbase part
├── screens/CoinbaseReturn.tsx      # NEW: the return screen
├── components/PlatformBalances.tsx # NEW: the balance rows and the total
├── api.ts, types.ts, routes.ts, messages.ts, money.ts (+ formatDecimal)
test/
├── helpers/coinbase-stub.ts        # NEW: the stand-in Coinbase (authorize, token, revoke, accounts; scripted faults)
├── connections.test.ts             # NEW: T-CONN-01..12
├── decimal.test.ts                 # NEW: T-DEC-01..03
├── users.test.ts                   # + T-USR-15..16 (connection entries, replace, reuse)
├── architecture.test.ts            # + A18 (and fixtures in test/fixtures/)
├── infra.test.ts                   # + rule 26
├── openapi.test.ts, openapi-portal.test.ts   # the new routes
└── portal.test.ts                  # + T-PRT-20..21 (off by default; disable disconnects)
web/portal/test/                    # + T-WEB-17..21
docs/
├── portal.openapi.yaml, l2-control.openapi.yaml   # the new routes
└── self-hosted/README.md           # the VPS steps
infra/
├── main.bicep, modules/portal-apps.bicep, main.dev.bicepparam   # userAccounts.coinbase; two secret references
env/portal.env.example              # the eight names
```

**Structure Decision**: the existing layout. The feature lives in the portal (`src/portal/`, `web/portal/`), with a
new subfolder for everything that holds a Coinbase credential, plus two routes and two entry types in L2 and one pure
helper in `src/shared/`. No new process, image, unit or pipeline.

## Delivery

One pull request per slice, each green on `npm run check` ([R14](research.md#r14-delivery-in-slices)):

1. **SPEC and constitution**: L2-8, L2-4, L2-5, §1.3, §3.3, §4.1 (A18), CFG-2, §11 (SEC-54..58), §12 (the test IDs);
   constitution 3.2.0; `specs/README.md` row 020. No code.
2. **L2**: the two routes, the entry types, `userState`, `UserView.connections`, T-USR-15..16, T-API-01..04.
3. **Portal core**: `decimal.ts`, `coinbase/`, `connections.ts`, the routes, the stand-in, A18, T-CONN-*, T-DEC-*,
   T-PRT-20..21, T-API-12..15.
4. **Web app**: the wallet's two parts and the return screen, T-WEB-17..21.
5. **Delivery**: `portal-apps.bicep` and the parameter files (rule 26) and the VPS steps can land with the feature
   off. Turning it on needs the owner's prerequisites first (Coinbase's approval and client, its terms and fees, a
   published privacy policy and support contact), then the secrets seeded and the manual pass
   ([quickstart.md](quickstart.md) §4–§5).

## Complexity Tracking

None: no constitution violation needs justifying.
