# Research: L2 Web Portal: Onboarding, Profile, Wallet and Expense Policies

Phase 0 of [plan.md](plan.md). Each section records one decision, why, and what was rejected. Nothing is left as
NEEDS CLARIFICATION. External facts were checked against the vendors' documentation on 2026-11-10; the ones that
could not be confirmed are marked **unverified** and have a check in [quickstart.md](quickstart.md).

Inputs: [spec.md](spec.md) with its eight clarifications, SPEC.md v1.8, constitution v1.3.0, and the code as of
`fcbdf0a`.

## R1. Which processes, and where the code lives

**Decision.** Two changes to the process map:

- **L2 gains user accounts**, inside `src/layer2-control/`: the user and policy state derived from the ledger, the
  per-user signing accounts, the platform config, and a set of routes for a new caller role, `portal-control`. L2
  still binds 127.0.0.1 only and gains no public route (FR-048).
- **A new process, the portal** (`src/portal/`, entry point `src/portal-main.ts`, port 4025). It serves the web app
  and its JSON API to browsers, verifies the person's sign-in, keeps the profile store, talks to the card vault and
  reads balances. It reaches L2 with its own token. It is a new top-level folder like `src/counterparty/`, so rule
  A1 keeps it from importing L2 code, and it holds no payment key (FR-048, FR-049).

The web app's source is `web/portal/`; it is built to static files that the portal process serves.

**Rationale.**
- FR-048 requires the part browsers reach to run apart from the signer. Constitution V keeps L2 on loopback.
- Everything that decides or signs stays in L2, where the serialized section and the ledger already are, so a
  policy change and a payment decision can be ordered against each other (FR-036).
- The portal is then a thin, replaceable front: if it is down, L2 keeps deciding with the last recorded policies
  (NFR-005).

**Alternatives considered.**
- *Serve the portal from L2.* Rejected: the process holding the keys would face the internet.
- *Put the policy store in the portal and have L2 fetch it.* Rejected: a decision would depend on the portal being
  up, policy history would sit outside the hash chain (INV-9), and a compromised public process could rewrite
  policies without a trace.
- *A separate "users" service between the portal and L2.* Rejected: a fourth layer with no authority of its own.

## R2. Who the user is, and how the portal tells its tokens from the agent's

**Decision.**
- **One API app registration, two delegated scopes.** The existing API app keeps `user_impersonation` (the agent
  service) and gains `Portal.Access`. A new public-client app registration for the web app (single-page app,
  authorization code with PKCE, no secret) is pre-authorized for `Portal.Access` only.
- **The one permission is the existing app role `Agent.Run`** on the API app. A person's delegated token for either
  scope carries it in `roles`. Nothing new to assign (clarified 2026-11-10): `infra/pre-deploy.bicep` already
  assigns it to each person in `agentUsers` directly, with no group, so no Entra ID P1 is needed.
- **Token verification moves to `src/shared/entra-token.ts`** (issuer, audience, tenant, `oid`, validity, JWKS or the
  dev issuer's file), with the dev-issuer constants. The hosted agent's `requester-auth.ts` and the portal both
  build on it. The portal image must not contain L1 code (T-IMG-01), and two copies of a token check would drift.
- **The portal accepts** a token only with `aud` = the API app, `roles` ∋ `Agent.Run`, `idtyp` = `user`,
  `scp` ∋ `Portal.Access` and `azp` = the web app's client ID
  ([portal-api.md](contracts/portal-api.md#access-fr-003-fr-005-sec-19-sec-20)).
- **The agent service is tightened** to refuse a user token without `user_impersonation` in `scp`, or whose `azp` is
  the portal's client. Today it checks neither, so it would accept a portal token.
- **The user identifier** is `usr_` + 32 hex of SHA-256 over `x402-user-v1|tid|oid`, computed by the same shared
  pure function in the hosted agent and in the portal.
- The API app gains two optional access-token claims: `auth_time` (R5) and `idtyp` with `include_user_token`.

**Rationale.**
- Entra puts the user's app roles on the target API into delegated tokens, so reusing the API app makes "everyone
  who may start runs" literally the same assignment.
- `scp` alone is not enough: Entra returns every scope a client has been granted for the resource, whatever it
  asked for. Pre-authorizing the web app for `Portal.Access` only, and also checking `azp`, keeps the two apart.
  `azp` is documented for authorization decisions.
- `idtyp` is the documented way to tell a user token from an app-only one; requiring `user` and a non-empty `scp`
  refuses system identities (FR-003).
- A plain hash needs no secret shared between L1 and the portal, and still reveals neither name nor email
  (FR-046). An HMAC would need one secret in two processes.

**Alternatives considered.**
- *A second API app for the portal, with its own role.* Separates by `aud` and needs no change to the agent, but it
  is a second permission to assign, against the clarification. Keeping two roles on one group needs group-based
  assignment, which needs Entra ID P1.
- *Server-side sessions with cookies (a backend-for-frontend).* Needs a client credential for the portal, a session
  store and CSRF defences. A bearer token verified per request, as the hosted agent already does, needs none.
- *Auth0 for the portal.* Auth0 is already used, but only to reach the approver (012). Requesters are Entra
  identities (011); a second identity would need a mapping between the two.

**Residual.** `azp` on a public client names the registration used, not proven client code. A token is still bound
to the person and to `Agent.Run`. A removed role stays in already-issued tokens for up to 90 minutes.

## R3. Per-user accounts inside the signer

**Decision.** One secret, a BIP-39 mnemonic (`USER_WALLET_MNEMONIC`), read only by `src/layer2-control/signer.ts`.
A user's account is `mnemonicToAccount(mnemonic, { addressIndex: walletIndex })`, the standard path
`m/44'/60'/0'/0/<walletIndex>`. `walletIndex` is the number of `WALLET_CREATED` entries so far, and it is recorded
with the address in the ledger.

- At startup L2 derives the address of every recorded wallet and refuses to start if any differs from the ledger
  (the mnemonic was changed or mistyped).
- At signing, the derived address must equal the recorded one, or the decision is `DENIED` with `signer_rejected`.
- The platform account keeps `PAYER_PRIVATE_KEY`, untouched.

**Rationale.**
- INV-2 holds as written: rule A3 already allows `mnemonicToAccount` only in `signer.ts`. No new package: it is in
  `viem/accounts`.
- Keys survive a restart with nothing stored per user (FR-014): the mnemonic plus the ledger's index rebuild them.
- L2 needs no write access to any secret store, so its identity's privileges don't grow.
- An index from the ledger can't collide and makes wallet creation idempotent inside the serialized section.

**Alternatives considered.**
- *A random key per user in Key Vault or an encrypted keystore file.* L2 would need to write secrets, and losing
  the store loses funds.
- *Deriving from `PAYER_PRIVATE_KEY`.* Rotating the platform key would move every user's address and strand funds.
- *Deriving the index from a hash of the user identifier.* No state needed, but a non-standard path and a
  (remote) collision risk.
- *A remote signer (EXT-2).* The right step for real funds; one extension per change (SPEC §15).

**Residual.** The mnemonic is the key to every user's test funds, as the payer key is to the platform's today. It
sits beside it: in L2's env file locally and L2's vault in Azure, seeded by hand.

## R4. Where policies live, and how one is chosen

**Decision.** Policies are ledger entries (`POLICY_CREATED`, `POLICY_CHANGED`, `POLICY_PAUSED`, `POLICY_RESUMED`,
`POLICY_REMOVED`), and the current state is derived from them by pure functions in `users.ts`, as `escalations.ts`
does for escalations. For a payment, pure functions pick the user's one active policy that lists the requested
host, bound it by the platform limits, and hand the result to the unchanged `decide` as a `SpendingMandate` built
for that request ([data-model.md](data-model.md#the-decision-for-a-user-payment)).

The engine gains two early rules (`user_not_onboarded`, `user_disabled`) and one extension to R12 for the user
daily ceiling, all driven by a new optional `ctx.user`. Without it, the engine is exactly v1.8.

**Rationale.**
- Principle III: the ledger is the single source of truth, and a policy's whole history is rebuilt from it alone
  (SC-010). Each decision names `policyId` and version, and the entry order says which version was in force.
- The mandate is built per request with `allowedHosts: [host]` and that seller's payees, so R5 and R6 need no
  change and can't mix one seller's payees with another's.
- "No policy applies" is a mandate with no allowed host: R6 answers `host_not_allowed` (FR-029) with no new branch.
- The user daily ceiling reuses `daily_budget_exceeded` (FR-032), so the agent learns nothing new about the user's
  setup.

**Alternatives considered.**
- *A policies file or database beside the ledger.* A second source of truth, and edits that leave no trace.
- *One mandate holding every seller of the user.* Budgets could not differ per policy, and payees would be shared
  across sellers.
- *The gates as checks in `service.ts`, outside the engine.* They would not be in the rule table or the pure
  tests; `signer_rejected` is the only rule there, for a different reason.
- *An in-memory index of users and policies.* Faster, but a second copy to keep right. Linear scans are what the
  service does today; T-USR-12 measures the cost at the spec's scale (NFR-010), and an index derived through
  `ledger.subscribe` is the fallback if it fails.

## R5. Confirming identity again (step-up)

**Decision.** The API app emits the optional claim `auth_time` in access tokens. For a loosening change the web app
signs the person in again with `prompt: "login"` and retries. The portal passes `auth_time × 1000` to L2 as
`identityConfirmedAtMs`; L2, which holds the previous version and so knows whether the change loosens, requires it
to be at most 15 minutes old, with 60 s tolerance, and answers 403 `step_up_required` otherwise.

**Rationale.**
- Works on any tenant: no Conditional Access, so no Entra ID P1.
- L2 decides, inside the serialized section, against the version actually in force. The portal can't be talked
  into skipping the check by a stale page.
- L2 never sees the person's token (Constitution V), only a time the portal vouches for. The portal is already the
  component L2 trusts to say who the person is.

**Alternatives considered.**
- *`max_age` on the authorize request.* Not a documented Entra parameter, and the sign-in library deprecated its
  option.
- *Conditional Access authentication context (`acrs`).* The documented step-up, but needs P1.
- *`iat` as the time.* It changes on every silent renewal, so it proves nothing.
- *Checking in the portal only.* The loosening comparison would run outside the serialized section, against a
  version that may have changed.

**Unverified.** No Microsoft page states that `auth_time` moves after `prompt=login`, or that it stays put across
refresh-token renewals. Quickstart §5 checks both in the tenant. If it does not move, loosening changes are always
refused (fail closed) and the fallback is Conditional Access.

## R6. No user-typed text crosses into L2

**Decision.** Profile name and email, policy names and card nicknames stay in the portal (its profile store and
the card vault's metadata). Every string L2 accepts from the portal is an identifier, a seller host from the seller
list, an ISO date or an atomic amount, each validated by pattern.

**Rationale.**
- NFR-006 becomes structural: text that never reaches L2 can't be a decision input, can't reach the agent through a
  violation detail, and can't end up in an append-only ledger where it could never be corrected (FR-046, NFR-004).
- A policy's name is for its owner only (FR-024); no rule needs it.

**Alternatives considered.** *Policy names in the ledger, like the operator's `reason`.* Free text that might hold
personal data, kept for ever.

## R7. The card vault

**Decision.** Stripe in test mode, as a vault only: a Customer per user, a SetupIntent per card, the Payment Element
in the browser, and six REST calls from one server module with global `fetch`
([card-vault.md](contracts/card-vault.md)). A restricted test key with write access to Customers, Setup Intents and
Payment Methods only. No Stripe package on the server; in the browser, Stripe.js loaded from Stripe.

- `allowed_payment_method_types[]=card`, not `payment_method_types`: the latter can no longer be written on
  SetupIntents since API version `2026-09-30.endive`.
- `Stripe-Version: 2026-10-28.endive` pinned as a constant; Stripe.js from `https://js.stripe.com/endive/stripe.js`
  so both sides are on the same release.
- Duplicate cards are refused by comparing `card.fingerprint`; Stripe does not do it.
- The portal refuses to start with a live key, and treats `livemode: true` in any answer as a failure.

**Rationale.**
- FR-018: the card fields are in Stripe's iframe, so the number and the code never reach the portal. Stripe
  documents this as PCI SAQ A scope.
- FR-021: the restricted key can't create a charge or a payment intent, so "never charged" is enforced by the
  credential as well as by the code.
- FR-019: brand, last four, expiry and the creation time all come from the payment method, so the system stores no
  card data at all, only a customer reference.
- Six calls don't justify a server SDK; the stand-in for tests is small (as for CDP and Auth0).

**Alternatives considered.**
- *Basis Theory or VGS.* Pure vaults with built-in duplicate detection, but no simulated declines or 3-D Secure.
- *Adyen.* Saving a card is a zero-value authorization whose token arrives by webhook: an inbound route.
- *Braintree.* Workable, similar effort, weaker test tooling.
- *A simulated vault with no real provider.* Would not prove that card data bypasses the portal.

**Unverified.** What Stripe answers when a real card number is used with test keys (documentation only says not
to). The Dashboard's labels for the three permissions. Both are checked in quickstart §4.

## R8. Keeping the card vault and the ledger in step

**Decision.** The vault says which cards exist; the ledger says what happened. On add: vault, then L2, and the
portal detaches the card if L2 refuses or can't be reached. On remove: vault, then L2. Every list reconciles: a
vault card without its `x402_card_id` is detached, and a ledger card the vault no longer lists is reported to L2 as
removed.

**Rationale.** There is no transaction across the two. The order makes every partial failure end with fewer cards,
never more, and never a card without its ledger entry (FR-044).

**Alternatives considered.** *L2 first on add.* A `CARD_ADDED` entry for a card that then fails at the vault
would need a compensating entry on the common failure path.

## R9. Where profiles are kept

**Decision.** One JSON file per user in a directory owned by the portal (`PROFILE_DIR`, default
`.local/portal/profiles`), written by temporary file and rename. In Azure it is an Azure Files share of its own,
mounted only into the portal app, which runs one replica.

**Rationale.**
- FR-046 keeps names and emails out of the ledger; this is the smallest store that does it.
- "No persistent database beyond JSONL" stays as it is: this is a handful of small files, like the ledger's share.
- A file per user makes a wrong read of another user's data a path bug that tests can target (T-PRT-02), and an
  atomic rename can't leave a half-written profile.

**Alternatives considered.**
- *Azure Table Storage or a database.* A new data plane, a new role assignment and a new SDK for two short strings.
- *No store: take name and email from the token on every request.* The spec makes both editable (FR-010).
- *In L2.* L2 holds keys and must not hold personal data it does not need.
- *The ledger's share.* Nothing in the templates stops a second app from mounting it, but the portal must never be
  able to read or write the ledger file. A new rule in T-IAC-01 pins each share to its one app.

**Azure detail.** The storage account has shared-key access off, so the share is NFS like the ledger's, and the
portal app must run in the `x402` environment, whose subnet is the only one the storage firewall allows.

## R10. The web app's stack

**Decision.** A single-page app in `web/portal/`: React 19, TypeScript, built with Vite (already in the tree
through vitest). `@azure/msal-browser` 5.x for sign-in, without `@azure/msal-react`. Stripe.js by script tag,
without the React wrapper. No router library, no state library, no component library; plain CSS. Tests in vitest
with jsdom, Testing Library and axe-core. All of these are devDependencies: the portal image contains only the
built files.

**Rationale.**
- Eleven screens with forms, dialogs, live validation and an accessible error summary (NFR-009) are past what is
  comfortable without a component model; React is the most widely known one.
- Every package added is one more to pin and audit, so each wrapper that saves a few lines is left out.
- MSAL 5 needs a dedicated redirect page that runs only its bridge; it is a second Vite entry.

**Alternatives considered.**
- *Server-rendered pages with form posts.* Needs cookie sessions (R2).
- *No framework.* Fewer packages, but hand-written state and focus handling for every screen.
- *A component library.* Faster to build, but accessibility then depends on a large dependency.

## R11. Reading balances

**Decision.** The portal reads `balanceOf` itself with a read-only viem public client on the network profile's RPC,
caches each address for 20 s and shows the read time. L2 supplies the committed and 24-hour figures from the
ledger.

**Rationale.** L2 has no chain client today and should not gain one; L3's job is settlement, and it has no caller
role for the portal. The address is public. A failed read returns the last value marked stale, and nothing else in
the wallet view depends on it. Rules like A4 and A5 are extended to `src/portal/**`: no signing calls, no key names.

**Alternatives considered.** *Through L3.* A new role and route on the verifier for a public read. *Through L2.*
Outbound RPC from the signer's process.

## R12. Platform limits and the seller list

**Decision.** A new file, `config/platform.json` (CFG-4), read and validated by L2 at startup when user accounts
are on, with `PLATFORM_SELLERS` as the environment override for the list. `config/mandate.json` stays, unchanged,
as the platform account's mandate. When the config's digest differs from the last one recorded, L2 appends a
`PLATFORM_CONFIG` entry.

**Rationale.**
- The seller list needs a name and payees per host, which the mandate's flat lists can't hold.
- Recording the config in the ledger lets an auditor tell which limits bounded a decision from the ledger alone
  (SC-010).
- The operator edits a file and restarts L2: no route, in the portal or elsewhere, edits the limits.

**Alternatives considered.** *More fields in `mandate.json`.* Mixes the platform account's own rules with the
ceilings for everyone else. *An operator route.* A new write path for the one configuration that bounds everything.

## R13. What `check_budget` reports for a user

**Decision.** The tool and its (empty) input stay as they are. For a user, `GET /v1/budget` reports the user daily
ceiling, the last 24 hours' committed spend, what remains, and the highest auto-approve limit among the user's
active policies, with `scope: "user_daily"`.

**Rationale.** The agent gets one true number to plan with and no new input to misuse. It learns no seller list and
no policy. Per-seller limits are enforced at authorize, where a denial already tells it what it needs.

**Alternatives considered.** *A seller parameter on the tool.* A new agent input, and a way to probe a user's
policies. *Per-policy budgets in the answer.* Gives the agent the user's whole setup.

## R14. Turning it on, and staying compatible

**Decision.** One switch, in L2: `USER_ACCOUNTS=1`. With it on, L2 needs `PORTAL_TOKEN`, `USER_WALLET_MNEMONIC`
and a valid platform config, all checked before the ledger lock. Off, the portal routes answer 404 and
`PaymentIntent.userId` is validated for shape and otherwise ignored. The hosted agent always names the user for a
person; it has no switch of its own.

**Rationale.**
- FR-001: off is the default, so the local demo and every existing test are untouched (NFR-008).
- One switch can't be set inconsistently. A switch in the hosted agent that was off while L2's was on would send
  people's payments to the platform account, which FR-002 forbids.
- A run with no user (a system identity, the scripted agent, the CLI agent) is the platform account either way.

**Alternatives considered.** *A switch in each process.* The mismatch above.

## R15. Testing approach

**Decision.**
- **Pure tests** for the new derived functions and rules (`users.ts`, `policy.ts`), in the style of
  `test/policy.test.ts`.
- **In-process L2** through `createControlService` with a `users` dep, for the portal routes and the user decision
  path, with must-fail switches as deps, never env.
- **In-process portal** (`createPortalApp`) against an in-process L2, the card vault stand-in, a fake balance
  reader and the dev issuer.
- **Component tests** for the web app in jsdom.
- **One end-to-end test on the local chain** with two users (T-E2E-12): each pays from their own address, and the
  verifier confirms each transfer came from the right account.
- **Architecture rules** A10–A12 with fixtures; the OpenAPI tests for the new document; the image, IaC and
  workflow tests for the new unit.

Must-fail proofs are listed in [plan.md](plan.md#proofs-constitution-viii).

**Rationale.** It is how 009, 011 and 012 were tested, so the helpers exist: the harness, the dev issuer, the stub
pattern.

## R16. The portal as an Azure unit

**Decision.** A sixth unit, `portal`, deployed by its own pipeline `deploy-portal.yml` from its own image
`x402-portal` ([config-and-secrets.md](contracts/config-and-secrets.md)):

- a Container App `ca-portal-…` in the `x402` environment with **external** ingress on 4025, one replica at most,
  single-revision mode, identity lifecycle `None`;
- its own identity `id-portal-…` and vault `kv-portal-…`, holding `portal-token` and `card-vault-key`;
- its own NFS share `profiles`, mounted only into this app;
- it reaches L2 at L2's internal address, like L1, L3 and the operator job.

L2 gains two secrets in its own vault, `portal-token` and `user-wallet-mnemonic`, **always referenced** and seeded
as `off` while user accounts are off, exactly like `ciba-client-credential`. A plain object parameter,
`userAccounts`, carries the switch and the non-secret values, like `ciba`.

In `infra/pre-deploy.bicep`: the API app gains the `Portal.Access` scope, the two optional claims and the
pre-authorization; a third app registration, `app-portal-…`, is the web app's public client with its redirect
URIs. Its client ID joins the `mainParameters` output.

**Rationale.**
- "A new image is a new unit" (CLAUDE.md): its module, its case in `deploy.yml` step 0, its pipeline.
- The portal is the second public app after the agent. T-IAC-01 rule 3 lists who may be public; the list grows by
  one name, on purpose and under test.
- The always-referenced pattern avoids a template whose secret list depends on a flag, which what-if can't
  preview well, and it was already accepted for CIBA.
- Vault per unit keeps rule 2 true: no other app reads L2's vault.

**Alternatives considered.**
- *Serve the web app from Azure Static Web Apps or Storage static website.* A second hosting model, a second
  deployment path and cross-origin calls to the API. One container serves both from one origin, so the CSP is
  simple and there is no CORS.
- *Reuse L1's app and identity.* "Never point an app at another layer's image"; and L1's identity can read L1's
  vault and call Foundry.

**The redirect URI is known late.** The app's hostname includes the environment's random default domain, which
exists only after the platform deployment. So `pre-deploy.bicep` first registers the web app with the local
redirect only, and is run again with `portalOrigin` set once the platform exists (quickstart §6).

## R17. Local development

**Decision.**
- `npm run portal` starts the portal on 127.0.0.1:4025 in local mode against the dev issuer, like
  `npm run agent:hosted`.
- `npm run stack:local -- --users` starts the stack with `USER_ACCOUNTS=1` on L2 and a fixed development mnemonic;
  without the flag, and in `demo:local`, nothing changes.
- `npm run dev-token -- --portal` issues a portal token (`scp: Portal.Access`, `azp`, `idtyp: user`, a fresh
  `auth_time`). Default dev tokens gain `scp: user_impersonation` and `idtyp: user`, which the tightened agent
  check needs. In dev mode the web app takes a pasted token instead of running the Entra sign-in.
- `npm run fund-user -- <address> [usdc]` mints local MockUSDC to a user's account (local network only).
- Cards are off locally unless `CARD_VAULT=stripe` and test keys are set in `env/portal.env`.

**Rationale.** The baseline stays byte-for-byte what it is (NFR-008); a developer can still walk the whole
onboarding offline, except cards.

**Alternatives considered.** *User accounts on in every local stack.* It would add a `PLATFORM_CONFIG` entry to
every local ledger and change the demo's entry count.

## R18. Delivery in slices

**Decision.** Six slices, each mergeable with the feature off and each leaving `npm run check` green:

1. **L2 user accounts**: contracts, ledger entries, `users.ts`, the rules, the signer's keyring, the platform
   config, the portal routes, SPEC and OpenAPI. Testable in-process with no portal (user stories 3, 4, 5, 7, 8 at
   the API level).
2. **The hosted agent names the user**, and the shared token verifier (user story 4).
3. **The portal backend**: sign-in check, profile store, wallet view, policy routes (user stories 1, 2).
4. **The web app** (all screens except cards).
5. **Cards** (user story 6).
6. **Azure**: the unit, the pipeline, the app registrations.

**Rationale.** Slice 1 carries all the payment authority and all the must-fail proofs, and can be reviewed without
any user interface. Cards are the only part with a new outside service, so they come after the core is proven.
SPEC §15 asks for one extension per change; this feature is not an EXT item, but the same caution applies.

## Sources

Checked 2026-11-10.

**Microsoft Entra**
- Access token claims (`roles`, `scp`, `azp`, `azpacr`): https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
- App roles in delegated tokens: https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps
- All consented scopes are returned: https://learn.microsoft.com/en-us/entra/msal/javascript/browser/resources-and-scopes
- Optional claims (`auth_time`, `idtyp`, `include_user_token`): https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
- Scopes and app roles verification: https://learn.microsoft.com/en-us/entra/identity-platform/scenario-protected-web-api-verification-scope-app-roles
- Authorization code flow, `prompt=login`, SPA redirect URIs: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- Token lifetimes: https://learn.microsoft.com/en-us/entra/msal/javascript/browser/token-lifetimes
- MSAL browser caching: https://learn.microsoft.com/en-us/entra/msal/javascript/browser/caching
- MSAL redirect bridge: https://learn.microsoft.com/en-us/entra/msal/javascript/browser/redirect-bridge
- Third-party cookies and SPAs: https://learn.microsoft.com/en-us/entra/identity-platform/reference-third-party-cookies-spas
- Conditional Access authentication context: https://learn.microsoft.com/en-us/entra/identity-platform/developer-guide-conditional-access-authentication-context
- Graph Bicep, applications: https://learn.microsoft.com/en-us/graph/templates/bicep/reference/applications?view=graph-bicep-1.0
- Graph Bicep, appRoleAssignedTo: https://learn.microsoft.com/en-us/graph/templates/bicep/reference/approleassignedto?view=graph-bicep-1.0

**Stripe**
- Save a card without charging: https://docs.stripe.com/payments/save-and-reuse?payment-ui=elements
- SetupIntents: https://docs.stripe.com/api/setup_intents/create , https://docs.stripe.com/payments/setupintents/lifecycle
- `payment_method_types` removed for writes: https://docs.stripe.com/changelog/endive/2026-09-30/removes-the-payment-method-types-parameter-from-payment-intents-and-setup-intents
- `allowed_payment_method_types`: https://docs.stripe.com/changelog/dahlia/2026-07-29/allowed-payment-method-types-parameter
- Payment methods (list, update, detach): https://docs.stripe.com/api/payment_methods/customer_list , https://docs.stripe.com/api/payment_methods/update , https://docs.stripe.com/api/payment_methods/detach
- Duplicate cards and fingerprints: https://support.stripe.com/questions/how-can-i-detect-duplicate-cards-or-bank-accounts
- Versioning and idempotency: https://docs.stripe.com/api/versioning , https://docs.stripe.com/api/idempotent_requests
- Keys, restricted keys, sandboxes: https://docs.stripe.com/keys , https://docs.stripe.com/keys/restricted-api-keys , https://docs.stripe.com/sandboxes
- Test cards: https://docs.stripe.com/testing
- Including Stripe.js and its CSP: https://docs.stripe.com/js/including , https://docs.stripe.com/security/guide
- PCI scope: https://stripe.com/guides/pci-compliance
- Rate limits: https://docs.stripe.com/rate-limits
