# SPEC — x402 Agent Payments with Three-Layer Separation

| Field | Value |
|---|---|
| Spec ID | X402-3L-SPEC |
| Version | 1.13 (2026-11-11). v1.0 described the original PoC; v1.1 is the build target for the spec-kit plans in `specs/`; v1.2 adds the CDP facilitator on Base Sepolia (`specs/009`); v1.3 adds the escalation lifecycle: operator rejection, expiry and notification (`specs/010`); v1.4 adds an OpenAPI copy of L2-5 and opt-in Swagger UI on L2 (`API_DOCS=1`); v1.5 adds the hosted agent service on Mastra and Azure (`specs/011`); v1.6 adds OpenAPI copies of L1-6 and the seller (CP-1), with opt-in Swagger UI on both (`API_DOCS=1`); v1.7 declares the seller's endpoints with decorators and a monetization model, freemium discovery plus pay-per-use tiers (CP-1); v1.8 adds backchannel approval of escalations through OpenID CIBA with Auth0 (L2-7, `specs/012`); v1.9 applies the Auth0 tenant from a pipeline (`provision-auth0.yml`); v1.10 adds user accounts and the L2 web portal: onboarding, a profile, a wallet per user and expense policies (L2-8, `specs/013`); v1.11 makes the Auth0 pipeline key-only and adds it to the threat model (SEC-25); v1.12 moves people's sign-in from Microsoft Entra ID to Auth0, at the portal and at the hosted agent service (`specs/013` research R19); v1.13 cuts the Auth0 tenant to two applications, the portal's and L2's: no person's token from the tenant starts a run at the hosted agent service (`specs/013` research R20) |
| Owner | Fabricio Rojas |
| Status | Implemented PoC; this spec is the source of truth for changes |
| Reference | IMF Note 2026/004, *How Agentic AI Will Reshape Payments* (three-layer model) |

---

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

### 1.3 Out of scope (v1)
Mainnet. Refunds and disputes. Schemes `upto` and `batch-settlement`. Solana. AP2 / ACP / Visa TAP / Mastercard Agent Pay integration. Organizations or teams of users, and roles among them (v1.10 has users, each on their own). Paying with a card. Moving funds out of a user's account. Per-user approvers: an escalation still goes to the operator and the one configured approver. Deleting a user: an account is disabled, never deleted. Persistent DB beyond JSONL. Production authentication (mTLS). These are covered in §15. The Azure profile (§3.1, v1.5) is in scope on testnet only.

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
| User (v1.10) | A person who signed in to the portal with the permission to start agent runs. Known to L2 only as `userId` (`usr_` + 32 hex, from the issuer and the subject of their sign-in; v1.12: the Auth0 tenant and its `sub`); never by name or email |
| Portal | The web portal process (`src/portal/`, port 4025): the web app and its API. It holds no key and decides nothing |
| Wallet | What a user pays with: one crypto account that L2 derives and signs for, plus the cards they registered. Cards never pay |
| Expense policy | A user's own spending rules for a set of sellers: auto-approve limit, per-payment cap, per-run and per-day budgets, payments per minute, end date. Versioned; active, paused or removed |
| Platform limits | The operator's upper bounds on every policy (`config/platform.json`, CFG-4). A policy can be stricter, never looser |
| Seller list | The sellers the operator allows, by host, with a name and optional payees (CFG-4). A policy can only name sellers on it |
| User daily ceiling | The most one user can spend in any 24 hours across all their policies (`limits.userDailyCeilingAtomic`) |
| Platform account | The original payer (`PAYER_PRIVATE_KEY`) and its mandate (`config/mandate.json`): every payment that names no user |

---

## 3. Architecture

### 3.1 Process topology

| Process | Entry point | Port (bind) | npm script | Env file |
|---|---|---|---|---|
| L1 agent | `src/main.ts` | none (client) | `agent`, `agent:scripted` | `env/l1-agent.env` |
| L1 hosted agent service (v1.5) | `src/hosted-main.ts` | 4024 (127.0.0.1; `0.0.0.0` in a container) | `agent:hosted` | `env/l1-hosted.env` |
| L2 control | `src/layer2-control/service.ts` | 4020 (127.0.0.1) | `l2:control` | `env/l2-control.env` |
| L3 verifier | `src/layer3-settlement/service.ts` | 4023 (127.0.0.1) | `l3:verifier` | `env/l3-verifier.env` |
| Seller (counterparty) | `src/counterparty/seller.ts` | 4021 (all interfaces) | `seller` | `env/seller.env` |
| Facilitator (counterparty, local only) | `scripts/facilitator.ts` (wraps the `src/counterparty/facilitator.ts` factory) | 4022 | `facilitator` | `env/facilitator.env` |
| Portal (v1.10) | `src/portal-main.ts` | 4025 (127.0.0.1; `0.0.0.0` in a container) | `portal` | `env/portal.env` |
| Local chain | `scripts/local-chain.ts` | 8545 | `local:chain` | none |

Ports are overridable with `CONTROL_PORT`, `SELLER_PORT`, `FACILITATOR_PORT`, `SETTLEMENT_PORT`, `AGENT_PORT` and `PORTAL_PORT`. The chain port 8545 is fixed. Each entry point loads its env with `loadEnv()` from `src/shared/config.ts`. When `ENV_FILE` is unset, it defaults to the file in the last column. Ports are read through getter functions (`controlPort()`, `sellerPort()`, `facilitatorPort()`, `settlementPort()`) at call time, so env loaded at startup applies. L2 and L3 bind only through `listenControl()` and `listenSettlement()`, which always use `127.0.0.1`.

**The portal (v1.10, L2-8)** serves the web app (`web/portal/`, built to `dist/portal-web`) and a JSON API under `/api` to the signed-in person. It calls L2's portal routes with its own role token and reads balances from the chain's RPC; it has no key and no route that decides, signs, approves or reconciles. It is never on the decision path: with the portal down, agents pay exactly as before, and with L2 down the portal answers 502 and grants nothing. It runs only when user accounts are on (`npm run stack:local -- --users`); `demo:local` never starts it.

**Azure profile (v1.5, `specs/011` contracts/cloud-topology.md).**

- **Naming.** Every resource and Entra app registration is `{type}-{app}-{location}-{env}`, written only in the parameter files' `names` (the templates and the pipelines take every name from there) and checked by T-IAC-01 rule 15. `{app}` is `l1`, `l2`, `l3`, `op`, `portal` (v1.10), `seller` or `seller-alias`, or `x402` for what the layers share and `deploy` for the deploy app. The registry and storage account drop the hyphens (`crx402eastus2dev`). The names below are dev's in `eastus2`; the resource group is `rg-x402-eastus2-dev`, the API app `app-l1-eastus2-dev` (`api://app-l1-eastus2-dev`).
- **Environments.** One workload-profiles Container Apps environment, `cae-x402-eastus2-dev`, on a custom VNet with peer-to-peer encryption. The sellers live in a second environment, `cae-seller-eastus2-dev`, so they can't reach internal-only apps.
- **Apps and jobs** in `cae-x402-eastus2-dev`:
  - `ca-l1-eastus2-dev`: the hosted agent service, external ingress on 4024, 0–1 replicas;
  - `ca-l2-eastus2-dev` and `ca-l3-eastus2-dev`: internal-only ingress, exactly one replica each;
  - `caj-l1-eastus2-dev`: the scripted baseline with `--check-baseline`;
  - `caj-l2-eastus2-dev`: the operator commands, a unit of its own (the operator's identity, vault, image and pipeline);
  - `ca-portal-eastus2-dev` (v1.10): the portal, a unit of its own, external ingress on 4025, 0–1 replicas, single revision.
- **Loopback kept.** L2 and L3 still bind 127.0.0.1. A proxy sidecar in the same app forwards from port 8080 to the loopback port; it gets no env and no secrets.
- **Backchannel approval (v1.8).** L2's container always references `ciba-client-credential` in the l2 vault and always gets the `CIBA_*` values of the `ciba` parameter, so every environment seeds that secret (`off` while `ciba.enabled` is false). Turning the feature on is a vault update plus `ciba.enabled: true` and a `deploy-l2.yml` run.
- **User accounts (v1.10).** `main.bicep` takes a `userAccounts` object (`enabled`, `portalClientId`, `sellerName`, `cardVault`, `cardVaultPublishableKey`; no secret), and since v1.12 an `identity` object (`issuer`, `audience`: the Auth0 tenant's issuer and the API's identifier; Terraform's output in `auth0/`, no secret; v1.13: no list of clients for the agent, which the tenant doesn't have). `portalClientId` is the Auth0 single-page client's ID. L2's container always references `portal-token` and `user-wallet-mnemonic` in the l2 vault, and the portal always references `portal-token` and `card-vault-key` in its own vault (`kv-portal-eastus2-dev`), so every environment seeds all four, as `off` while the feature is off. L2 gets `USER_ACCOUNTS` and `PLATFORM_SELLERS` (one entry: the seller's own host, `userAccounts.sellerName` and the seller's payee) from the parameter file; the agent gets `AUTH_TENANT_ID` and `SERVICE_AUDIENCE` (the Entra API app's client ID) for system identities and, since v1.13, nothing for people, and the portal `AUTH_ISSUER`, `AUTH_AUDIENCE` and `PORTAL_CLIENT_ID`. The portal's profile files live on a second NFS share, `profiles`, mounted at `/app/.local/portal` by the portal only. Turning the feature on is the vault updates, `userAccounts.enabled: true`, and runs of `deploy-l2.yml`, `deploy-portal.yml` and `deploy-l1.yml`. The mnemonic is never rotated in place: with another one L2 refuses to start (L2-3).
- **Identity and secrets.** Each runtime unit has its own user-assigned identity and Key Vault. The identity lifecycle is `None` everywhere except the agent, so no container in L2 or L3 can request a token at run time. Secrets reach containers only as Key Vault references.
- **Ledger.** L2's ledger lives on an NFS Azure Files share mounted at `/app/.local`, with the L2-6 lock.
- **Images.** One image per unit, each tagged with the commit that its own pipeline built:
  - `x402-l1-agent`: the agent and `caj-l1-eastus2-dev`;
  - `x402-l2-control`: L2;
  - `x402-l3-verifier`: L3;
  - `x402-operator`: `caj-l2-eastus2-dev`, the operator scripts only;
  - `x402-portal` (v1.10): the portal and the built web app, with no file of any layer;
  - `x402-seller`: the sellers.

  Each image holds only its own unit's code and the packages that code imports, so only L2's image contains the signer, or any L2 code (T-IMG-01). Each app and job runs from its own unit's image (T-IAC-01 rule 12).
- **Templates.** Azure is provisioned by Bicep only.
  - `infra/pre-deploy.bicep` (subscription scope, deployed by an administrator by hand) makes the resource group, the API app registration (Agent.Run, `user_impersonation` with the Azure CLI pre-authorized, assignment required, and the optional claim `idtyp`; v1.12: the `Portal.Access` scope, the `auth_time` claim and the portal's web app registration of v1.10 are gone, because people sign in with Auth0; `retirePortalScope` keeps the scope disabled for one deployment where it exists, since Entra removes only a disabled scope), the deploy app registration with a GitHub federated credential and no secret, `Agent.Run` for the deploy app and the listed people, the operators' group, and the deploy app's roles: Contributor and Role Based Access Control Administrator, limited to `main.bicep`'s four roles, on the resource group only (T-IAC-01 rule 16). The Entra objects use the Microsoft Graph Bicep extension.
  - `infra/main.bicep` makes everything in the resource group: the platform (network, identities, registry, vaults, storage, Foundry with the Claude deployment, both environments) and each unit's apps (L1, L2, L3, the operator, the portal, the sellers), each from its own image and with only its own identities and vaults (T-IAC-01 rules 12 and 13). One deployment deploys one of them, chosen by its `unit` parameter, and leaves the rest as it is (T-IAC-01 rule 18). Its modules take names, never other modules' outputs, so what-if previews even a first deployment.
  - Every value is in `infra/pre-deploy.<env>.bicepparam` and `infra/main.<env>.bicepparam`, the tenant, subscription and resource group included; each template fails validation anywhere else (T-IAC-01 rule 17).
- **Pipelines.** One per unit in `.github/workflows/`, each run by hand or on its own tag, one at a time (one concurrency group): `deploy-infra.yml` deploys the platform (`unit` platform), and `deploy-l1.yml`, `deploy-l2.yml`, `deploy-l3.yml`, `deploy-operator.yml`, `deploy-portal.yml` (v1.10) and `deploy-seller.yml` each build their unit's image and deploy their unit's apps. All seven call the same steps, the reusable `deploy.yml`, with their unit; each deployment is previewed with what-if. It signs in with OIDC from the parameter file at the start of every step that calls Azure (GitHub's token is valid for 5 minutes) and reads no GitHub secret. One more workflow, `provision-auth0.yml` (v1.9), applies the Auth0 tenant (`auth0/`, Terraform) by hand, from its own GitHub environment `auth0-<env>`: the only place GitHub holds secrets (the Auth0 Management API credential), with its state in a storage account that `pre-deploy.bicep` makes and only the deploy app reads, over OIDC (T-IAC-02, T-IAC-01 rule 20). Every run checks the deployed units together (the cloud regression, the chain, the hosted smoke, since v1.10 the portal smoke, and the log scan); a unit's image becomes `last-good` only after they pass, and a failure rolls back only that unit. The platform is fixed forward. L1's run moves the agent's traffic by redeploying `main.bicep`. On a new environment each pipeline but L1's starts with a first deployment, which skips the checks through units not deployed yet (T-E2E-AZ).

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

### 3.3 Credential matrix (who holds what)

| Secret | L1 | L2 | L3 | Seller | Facilitator | Human operator | Portal (v1.10) |
|---|---|---|---|---|---|---|---|
| `PAYER_PRIVATE_KEY` | **never** | ✅ | — | — | — | — | **never** |
| `ANTHROPIC_API_KEY` | ✅ | — | — | — | — | — | — |
| `CONTROL_TOKEN` (L1→L2) | ✅ | ✅ verifies | — | — | — | — | — |
| `VERIFIER_TOKEN` (L1→L3) | ✅ | — | ✅ verifies | — | — | — | — |
| `SETTLEMENT_TOKEN` (L3→L2) | — | ✅ verifies | ✅ | — | — | — | — |
| `OPERATOR_TOKEN` (human→L2) | — | ✅ verifies | — | — | — | ✅ | — |
| Requester token (requester→L1 hosted, v1.5; v1.12: a person's Auth0 token or a system identity's Entra token) | ✅ verifies, never forwards | — | — | — | — | — | — |
| `SESSION_REF_SECRET` (v1.5) | ✅ (hosted only) | — | — | — | — | — | — |
| Agent identity's Foundry access (v1.5, `MODEL_PROVIDER=foundry`) | ✅ (managed identity, no secret) | — | — | — | — | — | — |
| `FACILITATOR_PRIVATE_KEY` | — | — | — | — | ✅ (local) | — | — |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | — | — | ✅ (`FACILITATOR=cdp`) | — | — | — |
| `CIBA_CLIENT_KEY` or `CIBA_CLIENT_SECRET` (L2→Auth0, v1.8) | — | ✅ (`ciba-client.ts` only) | — | — | — | — | — |
| `PORTAL_TOKEN` (portal→L2, v1.10) | **never** | ✅ verifies | — | — | — | — | ✅ |
| `USER_WALLET_MNEMONIC` (v1.10) | **never** | ✅ (`signer.ts` only) | — | — | — | — | **never** |
| Person's portal token (browser→portal, v1.10; v1.12: an Auth0 access token) | refuses it | — | — | — | — | — | ✅ verifies, never forwards |
| `CARD_VAULT_KEY` (portal→card vault, v1.10) | — | — | — | — | — | — | ✅ (`card-vault.ts` only) |

The CDP API credential authenticates the seller to the CDP facilitator. It cannot authorize an on-chain transfer, so it is not payment key material (INV-2). Rule A8 confines it to one file.

The Auth0 client credential (v1.8, L2-7) authenticates L2 to the approval service, for starting and polling approval requests. It cannot sign a payment or approve one by itself: an approval counts only when the approver's signed answer verifies. Rule A9 confines it to one file. The approver's Guardian enrollment lives on their phone and in Auth0, never in this system.

v1.10 (L2-8):
- The wallet mnemonic is payment key material, like `PAYER_PRIVATE_KEY`: every user's account is derived from it. INV-2 and rules A3 and A11 keep it in `signer.ts`, and the portal refuses to start when it can see it.
- `PORTAL_TOKEN` opens only L2's portal routes. It cannot authorize, approve, reject or reconcile, and none of the other four tokens opens a portal route (INV-13).
- The person's portal token is an access token of the sign-in tenant (Auth0, v1.12) for the API, issued to the portal's single-page client. The portal verifies it and never forwards it; the hosted agent service refuses it, and the portal refuses the agent's: each service accepts only its own clients (SEC-20). The portal accepts no token of the organization's directory.
- The card vault key authenticates the portal to the card vault. It is a restricted test-mode key that can only save, list and remove cards, so it is not payment authority. Rule A10 confines it to one file. Card numbers and security codes go from the browser straight to the vault and never reach any process of this system.

---

## 4. Invariants (non-negotiable)

| ID | Invariant | Enforced by |
|---|---|---|
| INV-1 | A layer imports only `src/shared/**` and its own folder. Only `src/main.ts`, `scripts/**` and `test/**` may import across layers. | `test/architecture.test.ts` |
| INV-2 | Only `src/layer2-control/signer.ts` turns key material into an account (`privateKeyToAccount`, `mnemonicToAccount`). v1.10: that includes the wallet mnemonic (`USER_WALLET_MNEMONIC`), from which every user's account is derived; only `signer.ts` reads it. | architecture test (A3, A11), T-USR-08 |
| INV-3 | L1 code never references `PAYER_PRIVATE_KEY`. Both L1 entry points, `src/main.ts` and `src/hosted-main.ts` (v1.5), sit outside `src/layer1-intent/`. Each loads its env file and then exits with code 1 if that variable is present, from the process environment or from the file. | architecture test, manual check (§12) |
| INV-4 | L3 has no signing or write capability (no `createWalletClient`, `signTypedData`, `writeContract`, `sendTransaction`, `privateKeyToAccount`). | architecture test |
| INV-5 | The L2 decision is a pure function of (accepts[], mandate, context). No I/O, no clock reads (time is passed in), no LLM text. `PaymentIntent.purpose` is logged, never evaluated. | `policy.ts` design, T-POL-02 |
| INV-6 | L2 signs **exactly one** requirement: the one the policy chose. The SDK receives a challenge whose `accepts` holds only that entry. | `signer.ts` |
| INV-7 | Budget figures are derived from the ledger, never stored as separate mutable counters. | `ledger.ts` |
| INV-8 | Authorization decisions are serialized. The check-sign-append sequence is atomic across concurrent requests. | T-E2E-04 |
| INV-9 | The ledger is append-only and hash-chained. Startup fails if the chain does not verify. | T-LED-01 |
| INV-10 | L3 trusts the chain, not the seller's `PAYMENT-RESPONSE`. CONFIRMED requires a matching Transfer log. | T-E2E-03 |
| INV-11 | CONFIRMED is final in L2. A later contradicting report is recorded with `anomaly: true` and does not change the effective status. | T-E2E-03, T-LED-03 |
| INV-12 | A human approval never overrides a DENY rule. It only lifts `human_approval_required` for one exact (session, resource, payTo, amount) tuple, once. "Once" means once per approval: each approval is a separate human act and is consumed by the first payment that uses it. Since v1.3 an escalation has at most one approval, and a `HUMAN_REJECTION` (R15) is a DENY that no approval can lift. | T-POL-13, T-POL-15, T-E2E-02 |
| INV-13 | Each caller has its own bearer token. L1 cannot reconcile or approve; L3 cannot authorize. v1.10: a fifth role, `portal-control` (`PORTAL_TOKEN`), opens only the portal routes of L2-5 and none of the others, and no other token opens them; L2 refuses to start when the portal's token equals another role's. | T-E2E-02, T-E2E-05, T-USR-02, T-USR-07 |

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
| A12 (v1.10) | INV-13, SEC-19 | `src/layer1-intent/**`, `src/layer3-settlement/**`, `src/counterparty/**`; and `src/portal/**` | in a layer: `PORTAL_TOKEN`. In the portal: `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `OPERATOR_TOKEN`, `SETTLEMENT_TOKEN` or `VERIFIER_TOKEN` |

Each rule has a fixture under `test/fixtures/arch/` that must trip it (Principle VIII). T-ARCH-ENV checks that each `env/*.env.example` holds only the variables its process may see (§3.3, CFG-2); since v1.10 that includes `env/portal.env.example`, and a key ending in `_MNEMONIC` or named `CARD_VAULT_KEY` must be empty.

## 5. Technology stack (pinned)

| Concern | Choice | Version |
|---|---|---|
| Runtime | Node.js, ESM (`"type": "module"`) | 22.x, at least 22.13 since v1.5 (Mastra's floor) |
| Language | TypeScript (`module`/`moduleResolution: NodeNext`, `strict`) | ^7.0 |
| Runner | tsx | ^4.23 |
| x402 | `@x402/core`, `@x402/evm`, `@x402/express` | 2.28.0 |
| EVM | viem | ^2.57 |
| HTTP | express | ^5.3 |
| LLM | `@anthropic-ai/sdk` | ^0.135 |
| Tests | vitest (`fileParallelism: false`, 120 s timeouts; v1.7: `vitest.config.ts` lowers TC39 decorators with esbuild before oxc) | ^5.0 |
| Local chain (dev) | ganache (hardfork `shanghai`) + solc 0.8.24 (`evmVersion: shanghai`, optimizer 200) | 7.9.2 / 0.8.24 |
| Config | dotenv, one file per process via `ENV_FILE` | ^18 |
| CDP facilitator auth (seller only) | `@coinbase/cdp-sdk`, `./auth` subpath only | 1.59.0 (exact) |
| OpenAPI document parsing (tests only) | yaml | ^2.9 |
| API docs UI (L2 and, since v1.6, the hosted agent and the seller, only with `API_DOCS=1`; served by the service itself, never from a CDN) | swagger-ui-dist | 5.33.1 (exact) |
| Hosted agent service (L1-6, v1.5): Mastra `Agent` as a library only, no Mastra server, CLI or instance | `@mastra/core`, `@ai-sdk/anthropic` | 1.75.0 / 3.0.128 (exact) |
| Hosted agent service: tool schemas, requester tokens, Foundry identity | zod, jose, `@azure/identity` | ^4.6.5 / ^6.2.12 / ^4.13.3 |
| L2 backchannel approval (v1.8): the approver's access token (JWKS, RS256) and the `private_key_jwt` client assertion | jose | ^6.2.12 |
| The Auth0 tenant (v1.8, `auth0/`; its pipeline only, never a runtime dependency) | Terraform, provider `auth0/auth0` | >= 1.11.0 (the pipeline pins 1.15.5 by SHA-256); >= 1.60.0, < 2.0.0 |
| Hosted agent and infrastructure tests (dev only) | `ai` (`MockLanguageModelV3`), `@ai-sdk/provider`, `@azure/bicep-rpc-client`; Bicep CLI | ^6.0.302 / ^3.0.18 / ^0.4.1; 0.47.16 |
| Azure profile images | `node:22-bookworm-slim`, `nginxinc/nginx-unprivileged:1.29-alpine` | pinned by digest (the Dockerfiles in `docker/`, `infra/main.bicep`) |
| Portal web app (v1.10, `web/portal/`; dev-only packages, bundled by `npm run build:web` into static files, so none is a runtime dependency of any image) | react, react-dom; `@auth0/auth0-spa-js` (v1.12, replacing `@azure/msal-browser`: sign-in in a popup, authorization code with PKCE, no secret, rotating refresh tokens kept in session storage); vite (the build, with its own JSX transform and no plugin) | ^19.3.1; 2.30.0 (exact); 8.x |
| Portal web tests (dev only) | jsdom, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/dom`, axe-core | ^31.0 / ^16.3.3 / ^14.6.9 / ^10.4.2 / ^4.14 |
| Card vault (v1.10, the portal only, `CARD_VAULT=stripe`) | Stripe's REST API in test mode, called with `fetch` (no SDK): SetupIntents, PaymentMethods and Customers, six calls. Stripe.js is loaded by the browser from Stripe only when a person adds a card | API version `2026-10-28.endive`, pinned in `src/portal/card-vault.ts` |
| Requester and portal tokens (one verifier for the hosted agent and the portal; v1.12: `src/shared/identity-token.ts`, a person's Auth0 token and a system identity's Entra token) | jose | ^6.2.12 |
| Per-address request limit in front of token verification (v1.10: the hosted agent and the portal only, `src/shared/address-limit.ts`; in-memory counters) | express-rate-limit | 8.7.1 (exact) |

Resolved versions (v1.1, `package-lock.json`): typescript 7.0.2, tsx 4.23.15, vitest 5.0.5, viem 2.57.7, express 5.3.0, `@x402/*` 2.28.0, `@anthropic-ai/sdk` 0.135.0, dotenv 18.0.8, ganache 7.9.2, solc 0.8.24, `@types/node` 22.x; v1.4 adds yaml 2.9.1 and swagger-ui-dist 5.33.1. `scarfSettings.enabled: false` in `package.json` turns off the install analytics of swagger-ui-dist's `@scarf/scarf` dependency. `engines.node` is `>=22`; development also runs on Node 26. npm ≥ 11 skips dependency install scripts by default. Ganache falls back to its JavaScript implementations, which is harmless. v1.5 adds `@mastra/core` 1.75.0, `@ai-sdk/anthropic` 3.0.128, zod 4.6.5, jose 6.2.12 and `@azure/identity` 4.13.3 (runtime), and `ai` 6.0.302, `@ai-sdk/provider` 3.0.18 and `@azure/bicep-rpc-client` 0.4.1 (dev). In library use Mastra sends no telemetry; the image also sets `MASTRA_TELEMETRY_DISABLED=1`.

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
infra/                           Azure profile (§3.1, v1.5; T-IAC-01): pre-deploy.bicep (resource group, Entra apps,
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
  dev-issuer-lib.ts, dev-token.ts    local dev issuer and tokens for the hosted service and, with --portal, the portal
                                 (NETWORK=local only, v1.5; v1.12: a person's token in the sign-in tenant's shape, --service for a system identity's)
  fund-user.ts                   local only: mint test USDC to a user's account address (v1.10)
  wallet-mnemonic.ts             prints one new 24-word mnemonic; reads no env file and derives no account (v1.10)
  stack-local.ts                 the local stack without an agent, for the hosted service (v1.5); its processes, ports and
                                 readiness probes are demo-lib's localStack(), shared with the VS Code runner;
                                 --users turns user accounts on in L2 with the local dev mnemonic (v1.10)
  vscode-local.ts                the VS Code runner: `chain` (start or reuse), `stack` (reuse, wait for or start each stack
                                 process; `--users` with user accounts on in L2, v1.10), `run <role>`, always NETWORK=local
  image-closure.ts               each image's files and packages from the import graph; fails the build on another
                                 layer's file (T-IMG-01, v1.5)
  solc.d.ts                      type shim
src/
  shared/contracts.ts            ALL cross-layer types and ports (§7)
  shared/config.ts               network profiles, ports, bind hosts, URLs, tokens, loadEnv, formatAtomic, parseUsdc (v1.10)
  shared/user-id.ts              userIdFor(issuer, subject) and USER_ID_RE: the one way a sign-in becomes a userId (v1.10; v2 input since v1.12)
  shared/identity-token.ts       access token verification for the hosted agent and the portal: a person's (Auth0), a system
                                 identity's (Entra), and the local dev issuer's (v1.12; replaces entra-token.ts)
  shared/address-limit.ts        requests per client address, before a token is verified, for the same two services (v1.10)
  shared/auth.ts                 requireRole(role): per-caller bearer check, constant-time compare
  shared/api-docs.ts             Swagger UI routes over one OpenAPI document, for L2, the hosted agent and the seller (SEC-13; v1.6)
  layer1-intent/
    orchestrator.ts              402 transport loop (L1-1)
    ports-http.ts                HTTP adapters for L2/L3 ports (L1-2)
    agent.ts                     Claude tool-use loop (L1-3)
    scripted.ts                  deterministic plan, seller alias and checkBaseline (L1-4)
    hosted/                      hosted agent service parts (L1-6, v1.5): server.ts (createHostedApp only), agent.ts,
                                 model.ts, config.ts, requester-auth.ts, session-ref.ts, run-limits.ts, run-log.ts,
                                 api-docs.ts (its OpenAPI document for src/shared/api-docs.ts, only with API_DOCS=1; v1.6)
  layer2-control/
    mandate.ts                   mandate type + loader (L2-1)
    policy.ts                    pure rule engine (L2-2)
    signer.ts                    sole key holder (L2-3); since v1.10 also the keyring: one account per user from the mnemonic
    ledger.ts                    hash-chained ledger (L2-4)
    ledger-lock.ts               one ledger writer: exclusive lock, standby, heartbeat (L2-6, v1.5)
    escalations.ts               escalation lifecycle derivations and the sweep (L2-4.3)
    approval-routes.ts           operator approve and reject (L2-5)
    escalation-routes.ts         operator escalation reads (L2-5)
    ciba-client.ts               the only reader of the Auth0 client credential: CIBA config, client, sealed handle (L2-7, A9; v1.8)
    approval-evidence.ts         verification of the approver's access token, one check per step (L2-7; v1.8)
    payment-details.ts           the authorization_details object and binding message shown to the approver (L2-7; v1.8)
    backchannel.ts               approval requests: start, poll, verify, record, resume, the bounded wait (L2-7; v1.8)
    platform.ts                  platform limits and the seller list: load, validate, digest (CFG-4; v1.10)
    users.ts                     user accounts as pure functions over ledger entries: state, policy validation, loosening,
                                 policy selection, the effective mandate, views (L2-8; v1.10)
    user-routes.ts               the portal routes of L2-5, each write inside the serialized section (L2-8; v1.10)
    api-docs.ts                  L2's OpenAPI document for src/shared/api-docs.ts, only with API_DOCS=1 (L2-5, SEC-13)
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
                                 card-vault.ts (the only reader of the card vault key, A10), config.ts, log.ts, api-docs.ts
  portal-main.ts                 composition root for the portal: loadEnv → refusal when a payment key is visible → listen
  main.ts                        composition root for the agent process
  hosted-main.ts                 composition root for the hosted agent service: loadEnv → INV-3 refusal → listen (L1-6)
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
  main.tf, outputs.tf            API, L2's CIBA client, grant, credential, Guardian push; the ciba object and CIBA_* lines
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
  userId?: string;             // v1.10 (L2-8): ^usr_[0-9a-f]{32}$, the verified person who started the run. Set by the
                               // hosted agent service only, never from model text or a tool input. Absent: the platform account
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
  budget(sessionId: string, userId?: string): Promise<BudgetStatus>; // v1.10: with a user, that user's view
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
  sellers: { host: string; name: string; payees: string[] }[]; network: string; asset: string; decimals: number }
```

All amounts are **decimal strings of atomic units**. Use `BigInt` for arithmetic, never `Number`.

`src/shared/user-id.ts` holds `userIdFor(issuer, subject)` = `usr_` + the first 32 hex characters of SHA-256 over `x402-user-v2`, the issuer's host and the token's `sub`, separated by newlines, and `USER_ID_RE`. It is pure, so the hosted agent and the portal compute the same identifier without sharing a secret; an empty value, or one containing a line break, is refused. (v1.10 hashed `x402-user-v1|<tid>|<oid>`; an Auth0 `sub` contains `|`, so the format changed in v1.12 and every earlier identifier names a user nobody signs in as.) `parseUsdc(text, decimals)` in `src/shared/config.ts` turns USDC text into an atomic string, or says why not (`not_a_number`, `too_many_decimals`, `negative`); it never rounds.

---

## 8. Component specifications

### 8.1 Layer 1 — Intent & Orchestration

**L1-1 Orchestrator** (`PaidResourceOrchestrator.fetchPaid(url, purpose) → PaidFetchResult`)

1. `GET url`. On a network error, return `ERROR`.
2. If the status is not 402, return `FREE` with the status and body (JSON if parseable, otherwise text truncated to 2000 chars).
3. Decode `PAYMENT-REQUIRED` with `decodePaymentRequiredHeader`. If the header is absent, parse the body as JSON (v1 fallback). If that fails, return `ERROR`.
4. Build a `PaymentIntent` (`intentId = "int_" + uuid`, its own `sessionId`) and call `gate.authorize`.
5. If the decision is not AUTHORIZED, return `DENIED` or `ESCALATED` with `violations` and `authorizationId`. **No retry.**
6. `GET url` again with `decision.paymentHeaders`. The headers are opaque to L1 and must be forwarded unchanged.
7. Build a `SettlementClaim` from the decision plus `PAYMENT-RESPONSE`, then call `settlement.verify`.
8. If the response is 2xx and the report is CONFIRMED or PENDING, return `PAID`. Otherwise return `PAYMENT_FAILED`, with the body only if the response was 2xx. If `settlement.verify` throws after a 2xx paid retry, return `PAYMENT_FAILED` and keep `payment` and `authorizationId`, because money may have moved. An error from `gate.authorize` returns `ERROR`.

`PaidFetchResult = { outcome: FREE|PAID|DENIED|ESCALATED|PAYMENT_FAILED|ERROR, url, httpStatus, body, payment?, violations?, authorizationId?, error? }`.

**L1-2 Port adapters** (`ports-http.ts`): `HttpAuthorizationGate` (POST `/v1/authorize`, GET `/v1/budget/:id`, with `?userId=` when the run has a user, v1.10) and `HttpSettlementVerifier` (POST `/v1/settlements`). Bearer auth. Non-2xx responses throw.

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

**L1-6 Hosted agent service** (v1.5, `specs/011` contracts/hosted-agent-api.md, access-and-sessions.md, model-access.md)

- **Code layout.** The parts live in `src/layer1-intent/hosted/`. The entry point, `src/hosted-main.ts`, sits outside the layer (rule A5) and runs in this order: `loadEnv("l1-hosted")` → INV-3 refusal (the shared text in `src/refusal.ts`, also outside the layer because it names the key) → config → ports and model → listen.
- **Logs (outcomes).** A step's `outcome` is the fetch outcome, `ok` for a budget read, or `error` when a tool threw; Mastra's own logger is silenced (`noopLogger`), because a provider error object can carry the request body.
- **Routes.** `POST /v1/runs` runs a goal. `GET /healthz` and `GET /readyz` report health. Every other path returns 404 after auth, and unauthenticated callers get 401 everywhere except the health routes (and the docs routes, when mounted). No Mastra server, Studio or tool-execute route exists.
- **API docs** (v1.6). `docs/l1-hosted.openapi.yaml` describes these routes in OpenAPI 3.1. When a route, status, header or response field changes, update this section, the contract and the document together; T-API-05..07 fail until they match. With `API_DOCS=1` (CFG-2), `GET /docs`, `GET /docs/:asset` and `GET /openapi.yaml` serve Swagger UI over that document with no token, mounted before auth like the health routes and from the same shared module as L2's (L2-5, SEC-13). They serve files read at startup and never reach the model, a session, L2 or L3. The Azure deployment never sets `API_DOCS` (T-API-08).
- **Auth (v1.12, two issuers).** The service reads `iss` from the token, unverified, only to choose the checks, then verifies in full against that issuer; any other issuer is 401. The verifier is shared with the portal (`src/shared/identity-token.ts`). After verification the `Authorization` header is deleted, so it never reaches L2 or L3.
  - **A person: the Auth0 tenant (`AUTH_ISSUER`).** Signature against `<AUTH_ISSUER>.well-known/jwks.json` (RS256 only), `iss` exactly, `aud` containing `AUTH_AUDIENCE` (the API's identifier), `exp`/`nbf` with 60 s tolerance, a non-empty `sub`: 401. Then not a machine token (`gty: client-credentials`, or a `sub` ending in `@clients`), the permission `agent:run` in `permissions`, and the client (`azp`, or `client_id` under the tenant's other token dialect) on `AGENT_CLIENT_IDS`: 403. v1.13: the tenant has no client for this service (`auth0/` makes two applications, the portal's and L2's), so outside local mode nothing issues a token that passes these checks, and a deployed agent is configured without them. Without `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` (all three or none) no person is accepted: that is how every deployed environment runs. With neither people nor system identities configured the service refuses to start.
  - **A system identity: the organization's directory (Entra, `AUTH_TENANT_ID`).** Signature against the tenant's JWKS (RS256), issuer, `tid`, `aud` equal to `SERVICE_AUDIENCE` (the API app's client ID: v2.0 tokens never carry the `api://` URI, so any other value is a startup error), `exp`/`nbf`, `oid`: 401. Then `idtyp` exactly `app` and the role `Agent.Run`: 403. So a person's Entra token is refused, with or without the role. Without `AUTH_TENANT_ID` and `SERVICE_AUDIENCE` (both or neither) no system identity is accepted.
  - With `NETWORK=local` only, `AUTH_JWKS_FILE` selects the dev issuer for both kinds (`npm run dev-token`, and `--service`); `AUTH_ISSUER` must then be `urn:x402:dev-issuer`.
- **Whose token (SEC-20).** A token the portal's web app obtained comes from a client that is not on `AGENT_CLIENT_IDS`, so it never starts a run (403, before any model or L2 call). The service refuses to start when `PORTAL_CLIENT_ID` is on that list. v1.13: a deployed agent has no list at all and accepts no person's token.
- **The user (v1.10, L2-8).** For a person, every `PaymentIntent` of the run carries `userId = userIdFor(issuer, sub)`, and `check_budget` passes it to `GET /v1/budget`. For a system identity there is no user, so the platform account pays. The value is fixed when the run starts, from the verified token: no goal text, model output or tool input can change it, and neither tool has an input for a user, a policy or a wallet.
- **Limits.** v1.10: at most 300 requests a minute per client address on every route but health and the docs, counted before the token is verified (429 `{ "error": "too many requests" }` with `Retry-After`), so a caller without a valid token is bounded too. With `TRUSTED_PROXY_HOPS` set (1 in Azure) the address is the client's, from `X-Forwarded-For`; unset, that header is ignored. Goal 1–4,000 characters; body ≤ 16 KB (413); 2 concurrent runs and 20 starts per sliding hour per requester (429 with `Retry-After`); a 200 s deadline per run, under the ingress's 240 s idle timeout; client disconnect aborts. An abort stops the run before its next step, and a paid fetch in progress completes.
- **Agent.** A Mastra `Agent` used as a library, with exactly `fetch_resource` and `check_budget`. The descriptions are L1-3's, and the JSON schema adds `additionalProperties: false`. It has no memory, workspace, sub-agents, workflows or processors. Limits: `maxSteps` 10, `maxOutputTokens` 2048. Tool results use the L1-3 format.
- **Model.** `MODEL_PROVIDER=foundry` (Microsoft Foundry, keyless Entra token for scope `https://ai.azure.com/.default`) or `anthropic` (API key). The model id must be on the allow-list (`claude-sonnet-5-5` by default), and the Foundry deployment name must equal it; otherwise the AI SDK provider would add a third `json` tool.
- **Sessions.** `sessionRef = sr1.<sessionId>.<HMAC-SHA256(SESSION_REF_SECRET, m)>`, where `m` is `sr1`, the requester's kind (`user` or `service`), who vouches for it (a person's issuer, a system identity's tenant), its subject (`sub`, or `oid`) and the session ID, separated by newlines (v1.12; a reference issued before no longer verifies). Issued per new run and verified per requester. Another requester's reference → 404; a raw `sess_…` → 400.
- **Logs.** One JSON line per step and one per run, carrying `runId`, the requester (`<issuer host>:<sub>` for a person, `tid:oid` for a system identity), `sessionId`, tool, outcome, `intentId`, `authorizationId` and duration. Never headers, tokens, the MAC, the goal, `purpose` or response bodies.

### 8.2 Layer 2 — Control & Authorization

**L2-1 Mandate** (`SpendingMandate`): see CFG-3 for the schema and defaults.
- `allowedNetworks` and `allowedAssets` are always derived from the active network profile.
- `ALLOWED_PAYEES` and `ALLOWED_HOSTS` (comma-separated) override the JSON values when set.
- Payees are compared lower-cased.
- If the mandate breaks `autoApproveMax < hardCap ≤ sessionBudget` (CFG-3), loading fails and L2 refuses to start.
- **User payments (v1.10, L2-8).** This mandate is the platform account's and stays as it is. A payment that names a user is decided against an *effective mandate*, built for that decision from the user's one active policy for the requested seller and the platform limits (CFG-4):

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
- **Keyring (v1.10, `WalletKeyring`, in `signer.ts` only).** With user accounts on, `keyringFromEnv` reads `USER_WALLET_MNEMONIC`, which must be a valid 24-word BIP-39 phrase (the error names the variable, never the phrase). `addressOf(index)` and `signerFor(index, hardCapAtomic)` derive the account at `m/44'/60'/0'/0/<index>`. A user's `walletIndex` is the number of `WALLET_CREATED` entries before theirs, so indexes are never reused. A user payment is signed by `signerFor(wallet.walletIndex, the effective hard cap)`; when the derived address differs from the recorded one, the decision is DENIED `signer_rejected`. At startup, after the ledger loads, every recorded wallet's address is derived again and compared: a different mnemonic stops L2. No route, log line, ledger entry or response ever carries the mnemonic or a derived key.

**L2-4 Ledger** (`AuditLedger`, JSONL at `.local/ledger-<network>.jsonl`)

Entry: `{ seq, ts (ISO), type, sessionId?, intentId?, authorizationId?, data, prevHash, hash }`.
- `seq` starts at 0 and increases by 1.
- `hash = sha256(canonicalJSON(entry without hash))`. Canonical JSON uses recursively sorted object keys and no whitespace. Absent optional fields are omitted, never written as `null`. Every amount is a string, and every number is an integer.
- The genesis `prevHash` is 64 zeros. `verifyChain` recomputes every hash and link. The constructor throws `integrity` on failure. `brokenAt` is the 0-based line index of the first bad line, which equals `seq` on a well-formed chain.

| Type | Written when | `data` fields |
|---|---|---|
| `INTENT` | every authorize call, before deciding; followed by exactly one outcome entry (`AUTHORIZED`, `DENIED`, `ESCALATED` or `ESCALATION_REPEATED`). v1.8: again, with `reevaluationOf`, when a call re-evaluates after its wait ended in approved or denied (L2-5, L2-7) | `resourceUrl, purpose, accepts, reevaluationOf?` |
| `AUTHORIZED` | decision AUTHORIZED | `amount, asset, network, payTo, payer, validBefore, resourceUrl, mandateId, approvalRef` (the consumed approval's `approvalId`, or `null`; always present) |
| `DENIED` | decision DENIED | `violations, resourceKey` |
| `ESCALATED` | decision ESCALATE | `violations, resourceKey, payTo, amount, approvalRequest?` (v1.8: `requested`, `capped`, `operator_only` or `reevaluation`, only when backchannel approval is on) |
| `HUMAN_APPROVAL` | operator approves, or (v1.8) a verified backchannel answer approves | `approvalId` (`apr_<uuid>`), `escalationId, resourceKey, payTo, amount, approver, expiresAtMs, channel` (v1.8: `operator` or `backchannel`; an older entry without it is `operator`), plus `requestId, evidence {issuer, subject, answerId, issuedAt, detailsSource}` for `backchannel` |
| `HUMAN_REJECTION` | operator rejects a pending escalation (L2-4.3), or (v1.8) the approver refuses | `rejectionId` (`rej_<uuid>`), `escalationId, resourceKey, payTo, amount, channel`, plus `operator, reason?` for `operator` (untrusted free text, never a decision input), or `approver, issuer, requestId` for `backchannel` |
| `APPROVAL_REQUESTED` | v1.8 (L2-7): the approval service accepted the request | `escalationId, resourceKey, payTo, amount, channel, requestId` (`apq_<uuid>`), `issuer, approver, referenceCode, bindingMessage, details, requestedExpirySec, requestExpiresAtMs, intervalSec, handleSealed, attempts` |
| `APPROVAL_REQUEST_FAILED` | v1.8: a start, a poll or a resume failed for good | `escalationId, resourceKey, payTo, amount, channel, requestId?, phase, failure, httpStatus?, error?` (a whitelisted OAuth code or `other`), `attempts?` |
| `APPROVAL_REQUEST_LAPSED` | v1.8: the request expired, or a refusal came within 5 s of its expiry | `escalationId, resourceKey, payTo, amount, channel, requestId, cause` (`expired` or `late_refusal`), `requestExpiresAtMs` |
| `APPROVAL_VERIFICATION_FAILED` | v1.8: an answer failed a check | `escalationId, resourceKey, payTo, amount, channel, requestId, check` |
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
- Sum the `amount` of every `AUTHORIZED` entry in the filter **except** those whose effective report is `NOT_SETTLED` **and** where `nowMs > validBefore*1000` (the signature can no longer settle).
- `MISMATCH` and `PENDING` keep counting (conservative).
- v1.10: the filter also takes an owner, `{ userId?, policyId? }`. `userId: "usr_…"` counts that user's entries, `userId: null` counts the platform account's (entries without a user), and an absent `userId` counts all. `authorizedSince` (velocity) takes the same owner. With user accounts on, the platform account's figures use `userId: null`, so no user's spending uses up the platform account's budget, and the reverse.

**L2-4.2 Approvals**: `findOpenApproval(sessionId, resourceKey, nowMs)` returns the **most recent** `HUMAN_APPROVAL` entry for that (session, resourceKey) that has not expired and is not yet consumed. An approval is single-use. It is consumed when an `AUTHORIZED` entry's `approvalRef` equals its `approvalId`. An escalation has at most one approval (L2-4.3), so it authorizes at most one payment; approving an approved escalation returns the existing approval. An approval is consumed only when it is what lifted R14 (same payee, exact amount, amount above `autoApproveMaxAtomic`); a matching approval seen on a payment that needed no approval stays open. v1.10: with an owner, only an approval of that owner's escalation is found, so an approval for one user's purchase never lifts R14 for another user or for the platform account.

**L2-4.3 Escalation lifecycle** (v1.3, `src/layer2-control/escalations.ts`)

An escalation is created by its `ESCALATED` entry at `createdMs = Date.parse(ts)`. It expires at `expiresAtMs = createdMs + 300 000`, a constant that is not configurable. Its state is derived from the ledger and the decision time only, in this order:

1. `approved` when a `HUMAN_APPROVAL` names it.
2. `denied` when a `HUMAN_REJECTION` names it.
3. `expired` when an `ESCALATION_EXPIRED` names it, or `nowMs ≥ expiresAtMs`.
4. Otherwise `pending`.

- **Final states.** `approved`, `denied` and `expired` are final and are never left. Approve and reject act only on a pending escalation. Repeating the deciding action returns the existing decision. The opposite action, or any action on an expired escalation, is 409 and appends nothing.
- **Sweep.** `sweep(nowMs)` runs at the start of every serialized L2 operation and every 1 s from `main()` (an unreferenced timer; `createControlService` never starts one). It appends one `ESCALATION_EXPIRED` for each escalation still pending with `nowMs ≥ expiresAtMs`, and one `APPROVAL_LAPSED` for each approval past `expiresAtMs` that was not consumed and not already recorded. A restart sweeps whatever came due while L2 was down.
- **One pending escalation per purchase.** A purchase is (session, resource key, payee lower-cased, exact amount string). While an escalation for a purchase is pending, an ESCALATE decision for the same purchase returns that escalation's `authorizationId` and is recorded as `ESCALATION_REPEATED`. A different amount or payee is a different purchase.
- **Denial scope.** A `HUMAN_REJECTION` blocks its (session, resource key) for good through R15, whatever the amount or payee. An expiry blocks nothing: the next request for the same purchase escalates again under a new ID.
- **Notifications** are the lifecycle entries themselves. The operator reads them through `GET /v1/escalations` and `GET /v1/escalations/events`. L2 makes no outbound connection to notify the operator. Since v1.8, its only outbound connections are to the configured approval service (L2-7), which asks the approver.
- Every check-then-append (approve, reject, sweep, authorize) is one synchronous block inside the serialized section (INV-8), so each escalation gets exactly one final-state entry.

**L2-5 HTTP API** (binds to 127.0.0.1)

| Method & path | Auth | Request | 200 response | Errors |
|---|---|---|---|---|
| `POST /v1/authorize` | `CONTROL_TOKEN` | `PaymentIntent` | `AuthorizationDecision`. v1.8: with backchannel approval on, a call that creates an eligible escalation may take up to 120 s and return the re-evaluated decision (L2-7) | 400 malformed (missing ids, `accepts` not an array, non-http(s) URL, a non-boolean `operatorApprovalOnly`; v1.10: a `userId` that does not match `^usr_[0-9a-f]{32}$`, whether user accounts are on or off), 401 |
| `GET /v1/budget/:sessionId` | `CONTROL_TOKEN` | v1.10: optional query `userId` | `BudgetStatus` (`perPaymentCapAtomic` = auto-approve limit). An unknown session returns 200 with zero spend. `remainingAtomic` is never below 0. v1.10: with `userId` and user accounts on, the user's view (`scope: "user_daily"`): the cap is the user daily ceiling, the spend is the user's committed spend over 24 h, and `perPaymentCapAtomic` is the highest auto-approve limit among the user's active policies, bounded by the platform cap; zeros for a user who is not onboarded or is disabled | 400 malformed `userId`, 401 |
| `POST /v1/reconcile` | `SETTLEMENT_TOKEN` | `SettlementReport` | `{ ok, anomaly }` | 400 malformed report (missing `authorizationId` or `verified`), 404 unknown authorizationId, 401 |
| `POST /v1/approvals/:authorizationId` | `OPERATOR_TOKEN` | `{ approver? = "operator", ttlSeconds? = 600 }` | Pending: `{ ok, approvalId, expiresAt }` and one `HUMAN_APPROVAL`. Already approved: the existing approval plus `alreadyApproved: true`; nothing is appended and the request's `ttlSeconds`/`approver` are ignored (v1.3). | 400 `ttlSeconds` not a positive integer, 404 no ESCALATED entry, 409 `{ error, state: "denied", rejectionId }` or `{ error, state: "expired", expiresAt }`, 401 |
| `POST /v1/rejections/:authorizationId` | `OPERATOR_TOKEN` | `{ operator? = "operator" (1–64 chars), reason? (≤ 280 chars) }` | Pending: `{ ok, rejectionId, rejectedAt, alreadyRejected: false }` and one `HUMAN_REJECTION`. Already denied: the first rejection with `alreadyRejected: true`; nothing is appended. | 400 invalid `operator` or `reason`, 404 no ESCALATED entry, 409 `{ error, state: "approved", approvalId }` or `{ error, state: "expired", expiresAt }`, 401 |
| `GET /v1/escalations` | `OPERATOR_TOKEN` | — | `{ pending: [{ authorizationId, sessionId, resourceKey, payTo, amount, createdAt, expiresAt, referenceCode, approvalRequest? }], cursor }`, oldest first; `cursor` is the last ledger `seq` (-1 when empty). v1.8: `referenceCode` (8 hex characters of the ID) always; `approvalRequest` (`requested`, `capped`, `operator_only`, `reevaluation`, `failed`, `verification_failed` or `lapsed`) when backchannel approval is on | 401 |
| `GET /v1/escalations/events?after=<seq>` | `OPERATOR_TOKEN` | `after`: integer ≥ -1, default -1 | `{ events, cursor }`: one event per lifecycle entry with `seq > after` (`escalated`, `approved`, `denied`, `expired`, `approval_lapsed`; v1.8 adds `approval_requested`, `approval_request_failed`, `approval_request_lapsed`, `approval_verification_failed`, and `channel`, `decidedBy`, `referenceCode` where they apply), built from a field whitelist; never tokens, request handles, payment headers, `accepts`, `purpose`, `details` or the approval service's text | 400 bad `after`, 401 |
| `GET /v1/ledger/verify` | `OPERATOR_TOKEN` | — | `{ entries, ok, brokenAt? }` | 401 |
| `GET /v1/platform` (v1.10) | `PORTAL_TOKEN` | — | `PlatformView` | 401 |
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
| `GET /docs` | none; only with `API_DOCS=1` | — | Swagger UI page (HTML) whose CSP limits scripts and requests to the L2 origin | — |
| `GET /docs/:asset` | none; only with `API_DOCS=1` | — | `swagger-ui.css` or `swagger-ui-bundle.js` from `swagger-ui-dist`, or `swagger-initializer.js` | 404 any other name |
| `GET /openapi.yaml` | none; only with `API_DOCS=1` | — | `docs/l2-control.openapi.yaml` with `servers` set to `/`, the L2 serving it | — |

`docs/l2-control.openapi.yaml` describes the same API in OpenAPI 3.1, with the request and response schemas from §7. This table stays normative. When a route, token, status or response field changes, update the table, §7 and the document together; T-API-01..03 fail until they match.

With `API_DOCS=1` (CFG-2), L2 also serves that document and Swagger UI over it; without it, those three routes are not mounted and answer 404. They are the only L2 routes without a token. They serve files read at startup (a missing file fails startup) and never touch the ledger, mandate or signer. Swagger UI comes from the pinned `swagger-ui-dist` package, never a CDN. The page's Content-Security-Policy allows scripts and requests to its own origin only, because tokens typed into the page share that origin with the signing API (SEC-13). Swagger UI keeps entered tokens in memory only, and "Try it out" calls the live L2.

The fourteen `PORTAL_TOKEN` routes (v1.10, L2-8) exist only with `USER_ACCOUNTS=1`; without it each answers 404. `:userId` must match `^usr_[0-9a-f]{32}$` (else 400, after the token check). Bodies are JSON of at most 16 KB with no unknown field, and no field is free text: every string is an identifier, a host, an ISO date or an atomic amount. A `policyId` of another user is 404 with the same body as an unknown one, and no route reads a policy by its ID alone. Every write runs inside the serialized section. With user accounts on, the pending items of `GET /v1/escalations` and the `escalated` events gain `userId` when the escalation has one.

Authorize algorithm. Each decision runs inside one serialized critical section (INV-8: a promise-chain mutex):
1. `t = now()`, sweep. Append `INTENT`.
2. Look up an open approval for (session, resourceKey).
3. Build `ctx`. Committed spend is per session and over the trailing 24 h; velocity counts AUTHORIZED entries in the trailing 60 s. v1.10: when the intent names a user and user accounts are on, derive the user's state from the ledger, select their active policy for the requested host, build the effective mandate (L2-1) and count every figure for that user and policy (L2-2); a person never falls back to the platform account.
4. `decide`.
5. If AUTHORIZED: optionally wait `signerLatencyMs` (a test hook that simulates a remote signer), then sign. On a signer error, the decision becomes DENIED with `signer_rejected`. v1.10: a user payment is signed with the user's own account (L2-3).
6. Append `AUTHORIZED`, `DENIED` or `ESCALATED` (v1.8: a new `ESCALATED` records `approvalRequest` when backchannel approval is on). Return the decision.

v1.8 (L2-7), only for a new `ESCALATED` with `approvalRequest: "requested"`:

7. Outside the section, start the approval request and wait at most 120 s for the escalation to reach a final state. Nothing is locked; every other call proceeds. If the caller disconnects, stop and return nothing.
8. If the escalation reached `approved` or `denied`, run steps 1–6 again as a second decision (its `INTENT` carries `reevaluationOf`; it never starts a request or waits) and return that decision. Otherwise return the decision from step 6.

Auth runs before any body validation on every endpoint, so 401 always precedes 400. Tokens are compared in constant time.

Reconcile algorithm. It runs inside the same serialized section as authorize, so there is a single ledger writer:
1. Load the `AUTHORIZED` entry.
2. Compare `report.verified.{asset, payer, payTo, amount}` (case-insensitive) with the authorization `data`. On any difference, store the entry with `status: "MISMATCH"`, `anomaly: true` and a detail naming the fields.
3. Else, if a non-anomalous `CONFIRMED` already exists and the new report is not CONFIRMED for the same tx, store it with `anomaly: true`.
4. Else store it with `anomaly: false`.

**L2-6 One ledger writer** (v1.5, `specs/011` contracts/ledger-lock.md)

- **Startup order.** `main()` runs env → **acquire the ledger lock** → ledger load and integrity check → profile → mandate → signer → listen. `createControlService` never takes the lock.
- **Lock file.** `<ledger>.lock`, created with an exclusive create, holding `{holder, pid, host, acquiredAt, heartbeatAt}`.
- **Heartbeat.** The holder refreshes `heartbeatAt` every 5 s with an atomic write-then-rename. If it ever finds the lock missing or owned by another holder, it exits 1 (`lost the ledger lock`).
- **Standby.** While another holder's heartbeat is less than 30 s old, L2 waits in standby, polling every 1 s and logging once. After 30 s without a heartbeat it renames the stale lock away and takes over.
- **Shutdown.** SIGTERM and SIGINT release the lock.
- **Not a ledger entry.** The lock never touches the hash chain.
- **Accepted limit.** Two contenders taking over the same stale lock at the same instant could both succeed. One replica (`maxReplicas: 1`) and a stopped or crashed old holder make that impossible in the Azure profile.

**L2-7 Backchannel approval** (v1.8, `specs/012` contracts/auth0-ciba.md, payment-details.md, ledger-backchannel.md)

- **Off by default.** On only with `CIBA_APPROVAL=1` and a complete configuration (CFG-2), checked before the ledger lock. Off, L2 behaves as in v1.7.
- **Approval service.** An Auth0 tenant, reached by OpenID CIBA in poll mode at three fixed paths under `CIBA_ISSUER` (`bc-authorize`, `oauth/token`, `.well-known/jwks.json`), HTTPS only, no redirects. One approver per L2 (`CIBA_APPROVER`). Client authentication is `private_key_jwt` (RS256, preferred) or `client_secret_post`.
- **Eligibility**, decided in the section that writes the new `ESCALATED` and recorded as `approvalRequest`: not a repeat of a pending purchase (L2-4.3), not `operatorApprovalOnly`, and fewer than 10 `requested` escalations in the trailing hour (a constant).
- **Start.** One request per eligible escalation, outside the section: up to 3 attempts (1.5 s timeout each; 250 ms and 1 s between) on transient failures, none after a permanent refusal. The request carries a binding message (at most 64 characters, `Pay_<usdc>_USDC_to_<payee>_for_<segment>_#<ref>`) and one `authorization_details` object in Auth0's Guardian schema, built only from the escalation and the chosen requirement, never from agent text. Its lifetime is at most the escalation's remaining window and 300 s, so Guardian push is used.
- **Poll.** At the service's interval; `slow_down` lengthens it by at least 5 s. Polling stops when the escalation reaches a final state by any path. After a restart, L2 resumes every open request from the ledger (`handleSealed`) without sending a new one; a request started but never recorded is marked `interrupted` and never resent.
- **Outcomes.** Every check-then-append runs inside the serialized section; no call to the service does.
  - A token answer is verified first (signature through the issuer's JWKS, issuer, audience, client, validity with a 60 s tolerance, approver, the open request, the payment details field for field, single use). Passing gives `HUMAN_APPROVAL` (channel `backchannel`, TTL 600 s); failing gives `APPROVAL_VERIFICATION_FAILED` naming the check.
  - `access_denied` at least 5 s before the request's expiry gives `HUMAN_REJECTION` (channel `backchannel`). A later refusal, `expired_token`, or no answer gives `APPROVAL_REQUEST_LAPSED`. A permanent error gives `APPROVAL_REQUEST_FAILED`.
  - In every case but approval and rejection, the escalation stays pending and expires at 300 s as usual; the operator path works unchanged, and the first final state recorded wins.
- **Equivalence.** L2-2 consumes a backchannel approval or rejection exactly like an operator one, through `humanApprovedFor` and `humanRejected`. INV-12 is unchanged.
- **Never stored or shown**: the client credential, tokens, request handles (only sealed) and the service's free text, in the ledger, logs, events, responses, L1 or L3. Only whitelisted OAuth error codes are kept.

**L2-8 User accounts and the portal** (v1.10, `specs/013` data-model.md and contracts/control-api.md, portal-api.md, portal-ui.md, card-vault.md, config-and-secrets.md)

- **Off by default.** On only with `USER_ACCOUNTS=1` (CFG-2). Off, L2 ignores `PaymentIntent.userId` beyond checking its form, answers 404 on every portal route, and behaves as in v1.8. On, startup runs env → the user-account settings and the platform config (CFG-4) are validated → ledger lock → ledger load → every recorded wallet's address is derived again and compared (L2-3) → a `PLATFORM_CONFIG` entry if the digest changed → listen. A failure before the lock never takes it, and an error names the variable or the field, never a value.
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

- **Loosening and step-up (SEC-21).** A save loosens when it raises any of the four amounts or the rate, adds a seller or moves the end date later. Creating a policy, resuming one and enabling an account always loosen. A loosening operation needs `identityConfirmedAtMs`, the time the person last entered their credentials, at most 15 minutes old (60 s of clock tolerance either way); otherwise 403 `{ error: "step_up_required", maxAgeSec: 900 }` and nothing is recorded. L2 makes the comparison; the portal supplies the time from the verified token's sign-in time claim (v1.12: `AUTH_TIME_CLAIM`) and never decides. Tightening, pausing, removing and disabling never need it.
- **Disable and enable.** Disabling appends `USER_DISABLED`: from the next decision on, R17 denies every payment of that user, including one whose escalation was approved before. Nothing is deleted. Enabling is a loosening operation: in one serialized section it appends `POLICY_PAUSED` (cause `account_enabled`) for each active policy and then `USER_ENABLED`, so nothing pays until the person resumes the policies they want.
- **The decision for a user payment** follows L2-5's algorithm with the user's state, the effective mandate (L2-1), the per-user context and R16, R17 and R12 (L2-2), and the user's own account (L2-3). A user who is not onboarded, is disabled, has no active policy for the seller, or names a seller taken off the seller list is DENIED; a person never pays from the platform account.
- **Cards.** L2 records only that a card with an identifier was added or removed (at most 5 per user). A card is never an input to a decision and can never pay: `paymentMethod` accepts only `crypto_account`.
- **Never stored or shown**: the mnemonic, any derived key, the card vault key, card numbers and security codes, the person's token, and in L2 any name, email, policy name or nickname.

The portal (`src/portal/`, `specs/013` contracts/portal-api.md):

- **Access (SEC-19, SEC-20; v1.12: Auth0).** Every `/api` route except `GET /api/config` needs the person's access token from the sign-in tenant, verified before the body is read and then deleted from the request. No cookie is used. Checks, in this order: signature (`<AUTH_ISSUER>.well-known/jwks.json`, RS256, or the dev issuer's file with `NETWORK=local`), `iss` exactly `AUTH_ISSUER` (a token of any other issuer, the organization's directory included, is refused), `aud` containing `AUTH_AUDIENCE` (the API's identifier, as for the agent), a non-empty `sub`, `exp`/`nbf` with 60 s tolerance: 401. Then not a machine token (`gty: client-credentials`, or a `sub` ending in `@clients`), the client (`azp`, or `client_id`) equal to `PORTAL_CLIENT_ID`, and the permission `agent:run` (the one permission: whoever may start agent runs may onboard): 403. Then the sign-in time, the claim named by `AUTH_TIME_CLAIM` (default `https://x402.dev/auth_time`, set by the tenant's post-login Action): an integer not in the future beyond 60 s, else 401. Bodies of refusals are `{ error: "unauthorized" }` and `{ error: "forbidden" }` only, and a refused request makes no call to L2 or the card vault and writes nothing.
- **The user** is `userIdFor(issuer, sub)` from the verified token. No route takes a user identifier in its path, query or body; `:policyId` and `:cardId` are looked up for that user only, and anything else is 404.
- **Limits and headers.** JSON bodies of at most 16 KB (413), unknown fields refused (400); 300 requests per minute per client address on every `/api` route but `/api/config`, counted before the token is verified, and then 120 requests per minute per user (each 429 with `Retry-After`; `TRUSTED_PROXY_HOPS` as in L1-6); `Cache-Control: no-store` on `/api`; on every response `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a Content-Security-Policy with `default-src 'none'`, scripts from the portal itself and the card vault's script host, frames from the card vault only, connections to the portal itself, the card vault and the sign-in tenant's origin (from `AUTH_ISSUER`; never `login.microsoftonline.com`), `style-src 'self'`, `base-uri 'none'`, `form-action 'none'` and `frame-ancestors 'none'`. v1.12: no page may be framed; the v1.10 sign-in redirect page and its exception are gone, because the pop-up sign-in is answered by a web message and sessions are renewed with a rotating refresh token, never a hidden frame.
- **Routes.** Amounts come in as USDC text and are parsed exactly with `parseUsdc` (a seventh decimal is an issue on its field, never rounded); responses carry atomic strings only.

  | Method & path | Request | 200 response | Errors |
  |---|---|---|---|
  | `GET /api/config` (no token) | — | `{ auth: { mode, tenantId, clientId, scope }, network, cards: { available, publishableKey? } }`: public values only | — |
  | `GET /api/me` | — | `{ userId, enabled, onboarding: { profile, wallet, policy }, profile?: { displayName, contactEmail } }` | — |
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

  Every row can also answer 401, 403 and 429, and 502 `control_unavailable` when L2 can't be reached. `GET /healthz` and `GET /readyz` report health; any other path serves the built web app. `endsOn` (`YYYY-MM-DD`) becomes `expiresAt` at the end of that day, UTC. L2's issues come back under the input's field names.
- **Order of writes.** L2 first and the portal's own store second, so a failure in between never grants anything: a policy's name is kept only after L2 accepted the policy; a card is saved at the vault and then recorded at L2, and detached again if L2 refuses. The one exception is the first profile save, which writes the profile file before the registration, because the ledger entry is the one that can't be taken back; if the registration fails, the profile step stays not done and the next save retries.
- **Balance.** A read-only `balanceOf` on the network's RPC, cached for at most 20 s. When the read fails the last value is returned marked stale, and with no value at all the figure is absent, never a made-up zero. The rest of the wallet view comes from L2.
- **Cards** (`specs/013` contracts/card-vault.md). On only with `CARD_VAULT=stripe` and test-mode keys; a live key stops the portal. The browser types the card into the vault's own fields; the portal creates a SetupIntent for the user's vault customer (cards only), and on confirmation checks that the setup succeeded in test mode for that customer, that it is a card, not expired and not already registered (by the vault's fingerprint, never returned), then records `cardId` at L2. Six REST calls with a pinned API version, each with a timeout and one retry under the same idempotency key. On every list the portal reconciles the vault with the ledger. A failing vault affects the card routes only.
- **Log.** One JSON line per request with whitelisted keys: time, route template, status, `userId`, duration. Never a token, a name, an email, a body or a card vault message.
- **API docs.** `docs/portal.openapi.yaml` describes these routes in OpenAPI 3.1; T-API-12..14 fail until it and the portal match. With `API_DOCS=1` the portal serves Swagger UI over it like the other services (SEC-13, T-API-15); the Azure deployment never sets it.

The web app (`web/portal/`, `specs/013` contracts/portal-ui.md) calls only the portal API and holds no credential but the person's own sign-in, kept by the sign-in library in memory and session storage.

- **Onboarding.** Three steps, each shown as done, next or later: the profile (name and email prefilled from the sign-in, and a required acknowledgement that the wallet holds test funds only), the wallet (one button; the address, the network and how to fund it), the first policy. A person lands on the first step not done, also from a deep link.
- **Policy editor.** Where (a checklist of the seller list; never a free-text host), how much (four USDC amounts, each platform limit shown beside its field) and how (the crypto account; cards shown as not available yet; payments per minute; an end date). Before saving, `summarizePolicy` says in plain words what the policy allows; the list and the history show the same text.
- **Saving.** Issues are mapped to their fields and listed in a summary that takes focus. On `step_up_required` the person confirms their identity (a new sign-in with `prompt=login`) and the same values are sent again exactly once. On `version_conflict` both sets of values are shown and nothing is overwritten.
- **Rules.** Amounts are atomic strings, parsed and formatted with `BigInt` only. Everything a person typed is rendered as text, never as HTML. No control moves funds out of an account. A disabled account shows a banner on every screen and disables every create and change control except the name and email. WCAG 2.1 AA: labelled inputs, announced errors, visible focus, dialogs that trap focus, usable with a keyboard alone and from 360 px wide; a state is always a word, never color alone.

### 8.3 Layer 3 — Settlement verification

**L3-1 Verifier** `verify(claim) → SettlementReport`, with the read-only viem public client on `net.rpcUrl`:

1. If `claim.requirement.amount` is not an integer string → `MISMATCH`. Otherwise `amount = BigInt(claim.requirement.amount)`. `finalityClass = finalityClassFor(amount, policy)`. `verified = {asset, payer, payTo, amount}` from the claim.
2. No `PAYMENT-RESPONSE` → `NOT_SETTLED`. If decoding fails → `NOT_SETTLED`. If `transaction` is not a 32-byte hex hash → `NOT_SETTLED`. Otherwise continue with step 3, **whether `success` is true or false**: a facilitator's failure claim is not proof that nothing settled (INV-10). When `!success`, the report's `detail` starts with `facilitator reported failure (<errorReason>); ` before the step 3–6 outcome. (v1.2, SEC-11. A hosted facilitator can return `settlement_pending` with a broadcast hash.)
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

**L3-2 HTTP API** (binds to 127.0.0.1): `POST /v1/settlements` (auth `VERIFIER_TOKEN`, body `SettlementClaim`) returns a `SettlementReport`. Auth is checked first: 401 on bad auth. Then 400 when `authorizationId` is not a string or `requirement` is not an object.
- Every report is pushed to L2 `/v1/reconcile` with `SETTLEMENT_TOKEN`, with a 5 s timeout. A failed or timed-out push is logged and does not fail the request.
- A `PENDING` report schedules re-checks (default 5 attempts, 30 s apart, timers `unref`'d). Each re-check result is reconciled again. Re-checks stop at the first non-PENDING result. A new PENDING claim for the same `authorizationId` replaces the existing schedule.

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
  - Verification rejections and settlement failures keep the SDK's x402 402 responses unchanged. A `PAYMENT-RESPONSE` passes through any transaction hash.
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
- Endpoints: `GET /supported`, `POST /verify`, `POST /settle`. The body is `{x402Version, paymentPayload, paymentRequirements}`. Exceptions map to 400 with an x402-shaped error body: `{isValid:false, invalidReason}` for `/verify`, and `{success:false, errorReason}` for `/settle`.

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
| `l1-agent.env` | `NETWORK, ANTHROPIC_API_KEY, ANTHROPIC_MODEL?, SELLER_URL, CONTROL_URL, SETTLEMENT_URL, CONTROL_TOKEN, VERIFIER_TOKEN, SESSION_ID?, SELLER_ALIAS_URL? (v1.5)` |
| `l1-hosted.env` (v1.5) | `NETWORK, SELLER_URL, CONTROL_URL, SETTLEMENT_URL, CONTROL_TOKEN, VERIFIER_TOKEN, MODEL_PROVIDER, ANTHROPIC_MODEL?, ANTHROPIC_API_KEY? (anthropic only), FOUNDRY_BASE_URL? and AZURE_CLIENT_ID? (foundry only), AUTH_ISSUER?, AUTH_AUDIENCE? and AGENT_CLIENT_IDS? (v1.12, people: the issuer, the API's identifier and the clients whose tokens start runs, comma-separated; all three or none; v1.13: the local dev issuer's only, since the sign-in tenant has no client for the agent), AUTH_TENANT_ID? and SERVICE_AUDIENCE? (v1.12: system identities only; both or neither; at least one of the two groups), AUTH_JWKS_FILE? (local only), SESSION_REF_SECRET, AGENT_PORT?, AGENT_BIND_HOST?, API_DOCS? (v1.6), PORTAL_CLIENT_ID? (the portal's client, only to refuse a start with it on AGENT_CLIENT_IDS), TRUSTED_PROXY_HOPS? (v1.10: a whole number 0–3, default 0; 1 behind the Azure ingress)` |
| `l2-control.env` | `NETWORK, PAYER_PRIVATE_KEY, ALLOWED_PAYEES, ALLOWED_HOSTS, CONTROL_TOKEN, SETTLEMENT_TOKEN, OPERATOR_TOKEN, API_DOCS?`; v1.8 (L2-7): `CIBA_APPROVAL?` (`1` on), and when on `CIBA_ISSUER` (https), `CIBA_CLIENT_ID`, `CIBA_AUDIENCE`, `CIBA_APPROVER`, exactly one of `CIBA_CLIENT_KEY` (RSA 2048–4096, PKCS#8 PEM) and `CIBA_CLIENT_SECRET`, and `CIBA_CLIENT_KEY_ID?`; v1.10 (L2-8): `USER_ACCOUNTS?` (`1` on; otherwise off, and the next four are ignored and only named in one log line), and when on `PORTAL_TOKEN` (different from the other four tokens), `USER_WALLET_MNEMONIC` (24 words, read only by `signer.ts`), `PLATFORM_FILE?` (default `config/platform.json`) and `PLATFORM_SELLERS?` (a JSON array that replaces the file's `sellers`) |
| `l3-verifier.env` | `NETWORK, BASE_SEPOLIA_RPC_URL?, CONTROL_URL, VERIFIER_TOKEN, SETTLEMENT_TOKEN` |
| `seller.env` | `NETWORK, SELLER_PAY_TO, FACILITATOR?, FACILITATOR_URL?, CDP_API_KEY_ID?, CDP_API_KEY_SECRET?, API_DOCS? (v1.6)` (the CDP pair is required when the choice is `cdp`) |
| `facilitator.env` | `NETWORK=local, FACILITATOR_PRIVATE_KEY` |
| `operator.env` | `CONTROL_URL, OPERATOR_TOKEN` |
| `portal.env` (v1.10) | `NETWORK, CONTROL_URL, PORTAL_TOKEN, AUTH_ISSUER, AUTH_AUDIENCE, PORTAL_CLIENT_ID (v1.12: the sign-in tenant's issuer, the API's identifier and the portal's single-page client), AUTH_TIME_CLAIM? (v1.12; default `https://x402.dev/auth_time`), AUTH_JWKS_FILE? (local only), PROFILE_DIR? (default `.local/portal/profiles`), PORTAL_WEB_ROOT? (default `dist/portal-web`), CARD_VAULT? (`stripe` turns cards on), CARD_VAULT_KEY and CARD_VAULT_PUBLISHABLE_KEY (with `stripe`; test-mode keys only), BASE_SEPOLIA_RPC_URL?, PORTAL_PORT?, PORTAL_BIND_HOST?, TRUSTED_PROXY_HOPS?, API_DOCS?` |
| `pre-deploy.<env>.bicepparam`, `main.<env>.bicepparam` (v1.5, in `infra/`) | Not env files: every value the two Azure deployments use. The target (`tenantId, subscriptionId, location`), every resource name (`names`, with the resource group), the GitHub repository and environment, the app and group IDs from `pre-deploy.bicep`'s outputs, public addresses and the Claude attestation. Only `unit, imageTag, seedIp, recoverVaults, agentStableRevision` come from `deploy.yml`'s environment. Only Bicep reads them (`bicep build-params`). No secret values |

Token defaults (`dev-control-token`, `dev-settlement-token`, `dev-verifier-token`, `dev-operator-token`, and since v1.10 `dev-portal-token`) apply only when `NETWORK=local`. On any other network, a missing or empty token is a startup error. An empty token is always a startup error.
- Each entry point calls `loadEnv()`. `ENV_FILE` defaults to the process's own file (§3.1), and a caller can override it.
- Templates leave private keys empty (`# set me`).
- `API_DOCS` (L2 and, since v1.6, the hosted agent and the seller; read by `apiDocsEnabled()`): `1` mounts the docs routes (L2-5, L1-6, CP-1); unset, empty or `0` leaves them off; any other value is a startup error. No Azure template or workflow sets it.
- `npm run demo:local` gives each child only `PATH`, `HOME`, `NODE_*` and its own `ENV_FILE`. On `local`, if `env/l2-control.env` or `env/facilitator.env` is missing or the key is empty, the demo derives that key with `localDevKeys()`. It passes the payer key only to the L2 child and the facilitator key only to the facilitator child.
- The demo spawns `node_modules/.bin/tsx` directly (not `npx`) and reads each child's env file with a minimal `KEY=value` reader for its fallback decisions; only `src/shared/config.ts` uses dotenv (architecture test). On `local`, when `SELLER_PAY_TO` or `ALLOWED_PAYEES` is empty, the demo sets it to account #3 (CP-5).
- `src/portal-main.ts` (v1.10) loads `env/portal.env` and then exits 1 if `PAYER_PRIVATE_KEY` or `USER_WALLET_MNEMONIC` is visible, from the process environment or from the file, naming the variable and printing no value (as INV-3 does for L1). A missing or invalid portal setting stops it the same way.
- `npm run stack:local -- --users` (v1.10) gives the L2 child `USER_ACCOUNTS=1` and a fixed local dev mnemonic (`scripts/demo-lib.ts`, local only). `npm run demo:local` never does, so its summary is unchanged.
- `main.<env>.bicepparam` (v1.10) gains the `userAccounts` object, and in v1.12 the `identity` object; `pre-deploy.<env>.bicepparam` (v1.12) loses `names.portalApp`, `portalOrigin` and `portalPreAuthorized` and gains `retirePortalScope`. Neither holds a secret.
- `npm run approve`, `npm run reject` and `npm run escalations` resolve their bearer token with `tokenFor("operator")`, so on `local` the dev operator token applies when `OPERATOR_TOKEN` is unset. They read only `env/operator.env` (or `ENV_FILE`).

**CFG-3 `config/mandate.json`** (all amounts are atomic strings):

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
| SEC-8 | Agent self-approves (or rejects) an escalation | Operator token only; single-use, exact-match approval; one final state per escalation | T-E2E-02, T-POL-13, T-E2E-07 |
| SEC-9 | Stale signature settles late | Committed spend keeps counting until `validBefore` passes | T-LED-02 |
| SEC-10 | The CDP API credential leaks to another process, a log or a response, or a misconfiguration silently uses an unauthenticated facilitator | Seller-only credential (A8, T-ARCH-ENV); fail-closed startup; no runtime fallback; redaction | T-ARCH-A8, T-CDP-02, T-CDP-07, T-CDP-08 |
| SEC-11 | A facilitator reports failure for a transfer that actually settled, so the budget under-counts | L3 checks any reported hash on-chain (L3-1 step 2) | T-CDP-06 |
| SEC-12 | Operator free text (label, reason) reaches the LLM agent and acts as a prompt injection | The R15 violation detail carries only the rejection ID; label and reason are stored as data and shown to the operator only | T-POL-15 |
| SEC-13 | The token-free API docs routes expose more than the document, or run third-party code on the signer's origin where operators type tokens, or on the agent's or the seller's public origin, where requesters paste theirs (v1.6) | Off unless `API_DOCS=1`, which the Azure deployment never sets; three fixed files and the document, no ledger, mandate, signer, model, session or facilitator access; Swagger UI from the pinned package, never a CDN; CSP `script-src 'self'`, `connect-src 'self'` | T-API-04, T-API-08, T-API-11 |
| SEC-14 | Anyone who can reach the public agent endpoint spends from the budget | A token checked before any model or L2 call (v1.12: a person's Auth0 token with `agent:run` from a client on the list, or a system identity's Entra token with `Agent.Run`); per-requester limits, and since v1.10 a per-address limit before the token is verified; L2's budgets and rules unchanged | T-AGT-03 |
| SEC-15 | A requester continues another requester's session and uses its approvals or budget | HMAC-bound session references; a raw session ID is refused; a foreign reference → 404 | T-AGT-04 |
| SEC-16 | Secrets, requester tokens or payment headers reach logs or telemetry | Whitelisted JSON run logs; no Mastra observability or OTel export; known-value tests offline and a shape scan of cloud logs | T-AGT-05, T-E2E-AZ |
| SEC-17 | A forged, replayed or swapped backchannel approval pays something nobody approved (v1.8) | L2 verifies the answer before recording it: signature through the issuer's JWKS, issuer, audience, client, validity, approver, the open request, the payment details field for field, single use; outcomes recorded inside the serialized section; the client credential confined to one module (A9) | T-CIBA-08, T-CIBA-10 |
| SEC-18 | Push fatigue: a prompt-injected agent escalates again and again until the approver taps "approve" (v1.8) | Repeats reuse the pending escalation; at most 10 approval requests per rolling hour, counted from the ledger; automated checks are operator-only | T-CIBA-03, T-CIBA-04, T-E2E-10 |
| SEC-19 | A person reads or changes another person's profile, wallet, policies or cards (v1.10) | The user comes only from the verified token: no portal route takes a user identifier. L2 looks a policy up through its owner and answers 404 for another user's as for an unknown one. A profile file is read only for its own user. Each user has their own account, budgets and approvals. The portal's token opens nothing but the portal routes (A12) | T-PRT-02, T-USR-03, T-USR-11, T-USR-02 |
| SEC-20 | A token issued for one service is used at the other: the agent's at the portal, or the portal's at the agent | v1.12: one permission, and a client allow-list each. The portal accepts only its own client; the agent accepts only the clients on `AGENT_CLIENT_IDS` and refuses to start with the portal's client among them (v1.13: a deployed agent has no such list, and accepts no person's token). The portal accepts no token of the organization's directory, and the agent accepts from it only app-only tokens | T-PRT-01, T-AGT-07 |
| SEC-21 | A stolen or left-open portal sign-in loosens a policy | Every loosening operation needs credentials entered within 15 minutes, judged by L2; the platform limits bound what any policy can allow; the token lives in memory and session storage only; a strict CSP; typed text is never rendered as HTML | T-USR-05, T-USR-10, T-PRT-07 |
| SEC-22 | Card details or the card vault key are exposed | Card numbers and codes go from the browser to the vault only; the ledger holds an identifier, the portal's views only brand, last four and expiry; the key is a restricted test-mode key confined to one file (A10); a live key stops the portal; whitelisted logs | T-CARD-01, T-CARD-06, T-ARCH-A10 |
| SEC-23 | An intent carries a forged user, or omits it | `userId` is set by the hosted service from the verified token and nothing else; the tools take no user input; a named user who can't pay is denied and never falls back to the platform account; the platform limits bound every user and the platform mandate bounds a payment without one | T-AGT-06, T-USR-11, T-USR-06 |
| SEC-24 | The wallet mnemonic leaks, or is replaced | Read only by `signer.ts` (A3, A11) and given only to L2's container; the portal refuses to start when it can see it; never logged, stored or returned; a different mnemonic stops L2 at startup, because recorded addresses no longer match | T-ARCH-A11, T-USR-08, T-PRT-09 |
| SEC-25 | The Auth0 pipeline's credential leaks or is misused: someone changes the tenant (L2's client, its public key, the API), or tampers with the Terraform state (v1.11) | The Management API credential is held only by the GitHub environment `auth0-<env>`, read by one workflow, in its plan and apply steps only; that workflow runs by hand only, applies only the plan it showed, and may be gated by required reviewers; GitHub never holds a credential of L2's (key only). The state takes Entra sign-in only, keeps versions, and only the deploy app has a role on its container. A changed tenant can't approve a payment: L2 still verifies the approver's signed answer for the exact payment (SEC-17) | T-IAC-02, T-IAC-01, T-E2E-AZ |

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
- Anyone allowed to start `caj-l2-eastus2-dev` or `caj-l1-eastus2-dev` holds that job's credentials, because a start can override the template.
- L2 and L3 are reachable from every app in the private environment. Bearer tokens, not the network, enforce each role.
- L2 runs as one instance. During a revision update or after a crash, calls get 502 for up to 30 s while the lock is handed over; L1 reports ERROR and nothing is paid.
- Requester limits are held in memory by the single agent replica. Scaling out would need shared storage.
- The deploy app trusts any run of the repository's deploy job in the `<env>` GitHub environment (OIDC). Whoever can run one of the pipelines (`deploy-*.yml`) or push one of their tags gets its rights: Contributor and Role Based Access Control Administrator (limited to `main.bicep`'s four roles) on `rg-x402-<location>-<env>`, and `Agent.Run`. Required reviewers on the GitHub environment narrow this.
- Deploying the Claude model accepts Anthropic's Azure Marketplace terms with the attestation in `main.<env>.bicepparam`.

Residual risks added in v1.8:
- The approval service (Auth0) is trusted to authenticate the approver, and the approver's phone is a new place where approvals happen.
- When Auth0's CIBA access token carries no `authorization_details`, the payment details are checked against the token response body, which is not signed but arrives over L2's own authenticated connection, in answer to its own poll; the evidence records which source was used.
- An LLM run of the hosted agent that strays to an item above the auto-approve limit notifies the approver once; the cap bounds it, and the deployment's hosted smoke run fails on any escalation.
- A refusal is an unsigned error answer; accepting it can only make L2 more restrictive.

Residual risks added in v1.11:
- GitHub holds one credential, the Auth0 Management API application's. Whoever can change `provision-auth0.yml` on the default branch and pass the environment's protection can change the tenant's configuration. They can't approve a payment, and L2's private key is not there.
- The Terraform state's storage account has no firewall, because GitHub-hosted runners have no fixed address. Entra sign-in and one role on one container are the gate; the state holds no secret.
- The deploy app, which has Contributor on the resource group, is also the identity the Auth0 job uses for the state.
- `infra/cleanup.sh` deletes the state with the resource group and nothing in Auth0; the tenant's objects must then be deleted or imported by hand.

Residual risks added in v1.10:
- The hosted agent service is trusted to name the right user. If it were compromised it could name another onboarded user, and spend within that user's policies, or no user, and spend within the platform mandate. The platform limits bound both.
- Step-up relies on the sign-in time claim in the access token being the time credentials were last entered, also after a forced sign-in and across a renewal by refresh token. Since v1.12 a post-login Action of the Auth0 tenant sets it (`auth0/sign-in-time.js`); that it behaves so is assumed from the documentation and must be checked against the tenant before `userAccounts.enabled` is set anywhere (`specs/013` quickstart §5, research R19's five checks). If the claim is missing, the portal refuses the token.
- v1.12: one provider, Auth0, stands behind people's sign-in and behind approvals (L2-7). Their clients, credentials and permissions are separate, but an outage or a compromise of the tenant touches both.
- v1.12: a role taken from a person stays in tokens already issued until they expire (one hour).
- The mnemonic sits in Key Vault beside the payer key, so that vault's RBAC holders are trusted. Losing it makes every user's test funds unreachable, and it can't be rotated in place.
- The card vault (Stripe) holds the card details and one customer per user. It gets no name, email, amount or policy, and only test-mode keys are accepted.
- Names and emails are plain JSON files on the portal's share; the subscription's holders of that storage can read them.
- The portal is a second public app. It has no key and no deciding route, and its limits are held in memory by its single replica.
- The per-address limit assumes exactly one proxy, the Azure ingress, in front of each public service (`TRUSTED_PROXY_HOPS=1`); that hop count is not yet checked against a live environment. People behind one address share its 300 requests a minute.
- User state is derived by scanning the ledger. That is measured at 100 users with 10 policies each (T-USR-12); real growth needs EXT-6.
- An escalation of a user's payment still goes to the operator and the one configured approver, not to the user.
- In Azure the web app's redirect URI is registered after the portal's first deployment, so nobody can sign in until `pre-deploy.bicep` is applied again with `portalOrigin`.

Residual risks added in v1.4:
- With `API_DOCS=1`, anyone who can reach L2's loopback port reads the API description without a token. It holds nothing that is not in the repository.
- "Try it out" acts on the live L2: an operator who enters a token there signs, approves or rejects for real, and the ledger keeps every entry.

---

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
| T-API-03 | openapi | an in-process scenario reaches every documented status except authorize's 500, and each response's media type is documented and its body conforms to the schema (required fields, types, no undocumented fields). **Must fail**: a missing field, a wrong type and an undocumented field are reported |
| T-API-04 | openapi | the docs routes (SEC-13): with `API_DOCS` unset, none is mounted and each docs URL answers 404; `API_DOCS` accepts only `1`, `0` or empty; the served document equals the file except `servers` = `/`; the page carries a CSP limiting scripts and requests to `'self'` and names no other origin; `/docs/:asset` serves its three files and 404s anything else. **Must fail**: the same probe gets 200 with `API_DOCS=1`; a document without `servers` is refused |
| T-API-05 | openapi-hosted | the operations in `docs/l1-hosted.openapi.yaml` equal the routes mounted on the hosted agent with `API_DOCS=1`; without it, the mounted routes are exactly the operations not tagged `docs` (v1.6). **Must fail**: a route missing from the document, or documented but not mounted, is reported |
| T-API-06 | openapi-hosted | without a token a secured operation answers 401 and a `security: []` one doesn't; a token without `Agent.Run` gets 403 from a secured one; a token with it passes every guard. **Must fail**: a document calling `/v1/runs` open, or `/healthz` secured, is reported |
| T-API-07 | openapi-hosted | an in-process scenario (a stub seller, fake L2 and L3, a scripted model) reaches every documented status of every operation, including 503, 413 and 429; each response's media type and documented headers (`Retry-After`) are present and its body conforms to the schema, through FREE, PAID, ESCALATED and DENIED fetches, a budget read, a tool error, and completed, stopped and failed runs. **Must fail**: a missing field, a value outside its enum, a wrong type, an undocumented field and a step mixing both tools' shapes are reported |
| T-API-08 | openapi-hosted | the agent's docs routes (SEC-13): with `API_DOCS` unset, none is mounted, and each docs URL answers 401 without a token and 404 with one; `API_DOCS` in `l1-hosted.env` accepts only `1`, `0` or empty; no file in `infra/` or `deploy.yml` sets it; the served document equals the file except `servers` = `/`; the page carries the same-origin CSP; `/docs/:asset` serves its three files only. **Must fail**: with `API_DOCS=1` the same probe gets 200 with no token and makes no model, L2 or L3 call; a document without `servers` is refused |
| T-API-09 | openapi-seller | the operations in `docs/seller.openapi.yaml` equal the routes mounted on the seller with `API_DOCS=1`; without it, exactly the operations not tagged `docs`; each operation's `x-monetization-tier` and `x-x402-price-atomic` equal its declared tier and price (none when free), and every declared endpoint is documented (v1.6; tiers v1.7). **Must fail**: a missing route, an unmounted route, a wrong price, a wrong tier and an undeclared operation are reported |
| T-API-10 | openapi-seller | an in-process scenario with a scripted facilitator behind the real categorized client reaches every documented status of every route: 200 paid, 402 (no payment, a rejected payment, a payment for another route, a failed settlement), 502 (facilitator failing mid-payment) and 503 (facilitator down); bodies, media types and required headers conform, and the `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` headers, decoded with the SDK, conform to their `contentSchema`, as does the payment sent. **Must fail**: a wrong enum value, a missing field, an undocumented field and a wrong `x402Version` are reported |
| T-API-11 | openapi-seller | the seller's docs routes (SEC-13): with `API_DOCS` unset, none is mounted and each docs URL answers 404; the seller refuses to start with any other value than `1`, `0` or empty; `sellers.bicep` never sets it; the served document equals the file except `servers` = `/`; the page carries the same-origin CSP; `/docs/:asset` serves its three files only. **Must fail**: with `API_DOCS=1` the same probe gets 200 and makes no facilitator call; a document without `servers` is refused |
| T-MON-01 | seller-monetization | the seller declares `/api/catalog` free, weather and the market brief pay-per-use, the premium report premium and the dataset export enterprise, at unchanged prices, and no higher tier costs less than a lower one; `sellerRoutes` holds exactly the paid endpoints with their declared price and description, and `CATALOG` their paths and tiers; with the facilitator down the catalog answers 200 and every priced route 503 (v1.7) |
| T-MON-02 | seller-monetization | `usdc()` converts decimal USDC to atomic units with BigInt (`0.001` → `1000`, `12.345678` → `12345678`). **Must fail**: zero, more than 6 decimals, signs, exponents, blanks and hex are refused |
| T-MON-03 | seller-monetization | declaration mistakes are refused while the seller is built: **must fail** on an endpoint without a tier or without a route, two tiers, two routes, two endpoints on one route, a static endpoint, a path with a query, an empty description and a network whose asset doesn't have 6 decimals; an undecorated method is a helper, not an endpoint |
| T-AGT-01 | agent | fake model → tool calls → intents carry `purpose`; the tool result contains PAID + CONFIRMED; exactly two tools are offered |
| T-AGT-KEY | agent | spawning `src/main.ts`, or `src/hosted-main.ts` with the key in the process env or only in `ENV_FILE` (v1.5), with `PAYER_PRIVATE_KEY` set exits 1 with a refusal (the automated form of the manual check below) |
| T-AGT-02 | hosted-agent | every model call offers exactly `fetch_resource` and `check_budget` with the L1-3 descriptions and schemas; 2048 max output tokens; 10 steps; both providers' HTTP requests (Foundry: Entra bearer, no `x-api-key`); config rules. **Must fail**: an injected extra tool appears as a third name; an unrecognized model id is refused |
| T-AGT-03 | hosted-access | 401 for missing, invalid, expired, wrong-audience or wrong-tenant tokens and for an issuer the service does not know; 403 without the permission (a person) or `Agent.Run` (a system identity), for a machine token of the sign-in tenant and for a person's Entra token (v1.12); each refusal under 1 s with 0 model and 0 L2 calls; 2 concurrent and 20 hourly runs per requester (429 with `Retry-After`); L2/L3 never see the requester's token; with Entra a non-GUID `SERVICE_AUDIENCE` is a startup error. The API app registration itself is checked by T-IAC-01 rule 16. **Must fail**: with `bypassAuth`, an unauthenticated run reaches the model; the `api://` audience loads without the check. v1.10: a caller without a valid token is limited per address before any token is verified; **must fail** with `skipAddressLimit` |
| T-AGT-04 | hosted-sessions | a reference continues its requester's session; another requester's use → 404; a raw `sess_…` or malformed reference → 400; a tampered or non-canonical MAC → 404. **Must fail**: with `skipSessionMac`, requester B uses requester A's session |
| T-AGT-05 | hosted-run | response shape; the 200 s deadline (a fetch in progress completes, no model call after); step limit; body limits; readiness; failure keeps finished steps; run-log lines are whitelisted JSON and planted secrets never appear; the cloud scan's credential shapes |
| T-USR-01 | users | every portal route of L2-5: its happy path and each listed error; reads of the platform and of an unknown user; registration, wallet, cards and the account; a fresh wallet's figures; no response or ledger line holds the mnemonic or a key; a card never changes a decision |
| T-USR-02 | users | role isolation (INV-13): the portal token is refused on every deciding, approving and reconciling route; no token and each other token is refused on every portal route; 401 precedes 400 |
| T-USR-03 | users | ownership: another user's policy ID is 404 on every route, like an unknown one. **Must fail**: with `skipOwnershipCheck`, user A reads user B's policy |
| T-USR-04 | users | idempotency: registration, the wallet (ten concurrent calls create one account), card add and remove, pause, remove, and a change to the same values |
| T-USR-05 | users | loosening and step-up: creating, each raise, an added seller and a later end date loosen; fresh means at most 15 minutes, with 60 s tolerance; tightening never needs it; a stale time is 403 and appends nothing |
| T-USR-06 | users | off by default: every portal route is 404, and a `userId` on an intent changes nothing; a malformed `userId` is 400 on or off |
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
| T-AGT-06 | hosted-access | the service names the user every payment is for: a person's intents and budget calls carry their `userId`, a system identity's carry none; neither the goal text nor a tool input can name another user; the tools' input schemas are unchanged. v1.12: the user is `userIdFor(issuer, sub)`, pinned |
| T-AGT-07 | hosted-access | a portal token is refused by the agent service (403, no model or L2 call), with or without `PORTAL_CLIENT_ID`, as is any client not on `AGENT_CLIENT_IDS`; the agent's own tokens still run, in either token dialect; the service refuses to start with the portal's client on its list. **Must fail**: with `skipClientCheck`, a portal token starts a run |
| T-PRT-01 | portal | access: each check of L2-8's list gives 401 or 403 with a fixed body, no call to L2 and nothing written; an agent-service token is refused on every route, and a token of the organization's directory is 401 (v1.12); a person without `agent:run` is refused and no profile exists afterwards; 429 on the 121st request in a minute; a caller without a valid token is limited per address before any token is verified, per client address behind a trusted proxy and ignoring `X-Forwarded-For` without one. **Must fail**: with `bypassAuth`, an agent-service token reaches a route; with `skipAddressLimit`, token-less requests are never limited |
| T-PRT-02 | portal | a person reaches only their own data: another person's policy ID is 404 on every route; no route takes a user identifier. **Must fail**: with L2's `skipOwnershipCheck`, one person reads another's policy through the portal |
| T-PRT-03 | portal | the profile: validation by field, the acknowledgement, the first save writes the file and then registers, later edits write nothing to L2; the store builds a path only from a user identifier |
| T-PRT-04 | portal | the wallet view: one account, the balance with its read time, the stale path, an unreadable balance is absent and never zero, `lowBalance`, no key anywhere |
| T-PRT-05 | portal | policies: USDC text becomes exact atomic amounts, a seventh decimal is refused on its field and nothing reaches L2, issues come back under the input's names, step-up relay, `expectedVersion` and the version conflict, a rename records nothing at L2, the history; the platform view never holds a payee |
| T-PRT-06 | portal | L2 unreachable: every route that needs it answers 502 and nothing is granted; a first profile save completes on the next try |
| T-PRT-07 | portal | headers on every response: the CSP, `nosniff`, `no-referrer`, `no-store` on `/api`; the redirect page may be framed by this origin only; body limits; the built web app is served for any other path |
| T-PRT-08 | portal | the log holds whitelisted keys only, and no token, name, email or policy name appears in it; the ledger and L2's answers never hold a name, an email or a policy name |
| T-PRT-09 | portal | configuration: defaults, each error names the variable and never a value, the sign-in tenant's settings; the entry point exits 1 when a payment key is visible |
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
| T-E2E-01 | e2e | scripted plan outcomes `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`; on-chain delta exactly 6000; two CONFIRMED settlements; chain ok; budget `spentOrReserved = 6000` |
| T-E2E-02 | e2e | HITL: escalate → agent-token approval returns 401 → operator approval → PAID+CONFIRMED → the same request escalates again |
| T-E2E-03 | e2e | forged `PAYMENT-RESPONSE` → L3 returns MISMATCH; L2 keeps the first CONFIRMED and records an anomaly naming `amount` |
| T-E2E-04 | e2e | with `signerLatencyMs: 25`, 15 concurrent intents → exactly 10 AUTHORIZED in the trailing 60 s. **Must fail if the mutex is removed** (verified: 15/15 without it) |
| T-E2E-05 | e2e (must-fail proof in auth) | `/v1/reconcile` with the agent token returns 401; the ledger is unchanged |
| T-E2E-07 | e2e | operator reject: the retry is DENIED `human_rejected` with no operator text in the detail, another session still escalates, the ledger trail is ESCALATED → HUMAN_REJECTION → DENIED; a concurrent approve and reject yield exactly one final entry; the events feed reports escalated, denied and approved |
| T-E2E-08 | e2e | expiry on L2's clock: a repeat while pending reuses the ID; after 300 s the escalation expires, approve and reject are 409, the next request escalates under a new ID, and re-approving returns the same approval so one payment happens |
| T-E2E-09 | e2e | the hosted service on the harness: FREE, PAID, PAID, ESCALATED with both payments CONFIRMED and 6000 spent; continuation after an operator approval pays once with `approvalRef`, and another requester's use of the reference → 404 with the ledger unchanged |
| T-LED-05 | ledger-lock | one ledger writer (L2-6): a second acquirer waits while a fresh lock is held and takes it within 2 s of SIGTERM; a 31 s stale lock is taken over; a lost lock is reported; `main()` locks before loading. **Must fail**: two unlocked writers fork the chain and the reload throws `integrity` |
| T-IAC-01 | infra (needs `BICEP_PATH`) | the compiled `infra/main.bicep` and `infra/pre-deploy.bicep`, with their parameter files: role assignments only per the identity–vault matrix (the operators' group on the operator job only); the payer key only in `ca-l2-eastus2-dev/l2` from the l2 vault; internal-only L2/L3; one L2 replica on NFS; sidecars without env or secrets; identity lifecycle `Main` only for the agent; sellers in their own environment; no secret literals; `ALLOWED_HOSTS` is the seller, not the alias; vault firewalls deny by default, open only to `seedIp`, recovered only through `recoverVaults`; the agent's audience is a required client ID; each app and job on its own unit's image, which contains its command's entry point (the operator job on `x402-operator`), and the operator job's own command `ledger-verify`; each unit's apps look up only their own identities and vaults and wait for the platform; the model is keyless (Foundry refuses API keys, no container gets an Anthropic key, the agent signs in as `id-l1-eastus2-dev`) and the agent's model is the Claude deployment with its attestation; every name in the parameter files' `names` is the standard one for its place there and fits Azure's limits, every resource is named from `names`, each of `names` is deployed, every module gets `names` whole, and no template builds a name from the location or writes one out; the API app (v2.0 tokens, its standard URI, only Agent.Run, only `user_impersonation` with only the Azure CLI pre-authorized, assignment required), the deploy app (no secret, one federated credential for the deploy environment), Agent.Run for the deploy app and `agentUsers` only, the operators' security group, and the deploy app's Contributor and condition-limited Role Based Access Control Administrator on the resource group only; every template parameter set in its parameter file, only the five per-run values from the environment, both files agreeing on the target, and each template refusing to run elsewhere; each module of `main.bicep` deployed by exactly one unit's runs (`unit`: the platform's modules by the platform's, each unit's apps by that unit's), with `unit` required and one of the six. **Must fail**: 25 mutant tests (rules 1, 2, 3, 9, 10, 11 and 18; two each for rules 14 and 17; three each for rules 12, 13 and 16; five for rule 15) v1.8, rule 19: the Auth0 client credential only in `ca-l2-eastus2-dev/l2`, from the l2 vault, under the name `ciba.credential` chooses; every other `CIBA_*` value from the `ciba` parameter; `main.bicep` refuses an enabled `ciba` it can't use. **Must fail**: the credential on the agent, a literal credential, one fixed name, a written-out `CIBA_ISSUER`, no `ciba` check. v1.9: the deploy app has two federated credentials, for the deploy and the Auth0 GitHub environments (rule 16), `githubAuth0Environment` is `auth0-<env>` (rule 17), and rule 20: the Terraform state's storage account takes Entra sign-in only, keeps versions and deleted blobs, has one private container, and only the deploy app has a role there (Storage Blob Data Contributor on the container). **Must fail**: both credentials for one environment, an Auth0 environment that is the deploy environment, account-key access, a role on the whole account, another role, no versioning. v1.10: the portal is a unit (its app, identity, vault, image and the `profiles` share, mounted by the portal only; the ledger share by L2 only); the mnemonic only in `ca-l2-eastus2-dev/l2` from the l2 vault; the portal is the second app with external ingress, and it and the agent set `TRUSTED_PROXY_HOPS` to 1; the API app has one role, two scopes, two pre-authorized clients and the optional claims `auth_time` and `idtyp`, and the portal's web app has no credential and no role; rule 21: L2 always references `portal-token` and `user-wallet-mnemonic`, `USER_ACCOUNTS` and `PLATFORM_SELLERS` come from `userAccounts` and the seller's own host, the portal reads only its own vault and gets no payer key, no mnemonic and no token but `PORTAL_TOKEN`, and `main.bicep` passes `userAccounts` whole; v1.13: the agent's app and job get no setting of people's sign-in, `l1-apps` takes neither `identity` nor `userAccounts`, and a parameter file's `identity` is exactly `issuer` and `audience`. Each changed rule keeps a must-fail mutant. |
| T-IMG-01 | images | each image's import graph (`scripts/image-closure.ts`) stays in its own folders and uses only runtime dependencies; only the L2 image holds the signer or any L2 code (the operator's holds only the operator scripts and `src/shared`); only the L1 image holds Mastra and the model SDKs; every Dockerfile builds its own image from the same pinned base and loads every module once. **Must fail**: L1 reaching the signer; a package resolved at run time but not listed; an imported package missing from `dependencies`. v1.10: the portal image holds `src/portal/` and `src/shared/` only, none of the agent's packages and no web package (the web app is bundled at build time and copied as static files) |
| T-E2E-AZ | deploy-workflow, github-setup, cleanup (static) and the live workflows | `.github/workflows` holds the pipelines (six, and seven since v1.10), `deploy.yml` and (v1.9) `provision-auth0.yml`, which T-IAC-02 checks and which alone may read GitHub secrets and variables, its own; nothing else: each pipeline runs by hand or on its own `deploy-<unit>-*` tag, holds the concurrency group `deploy-azure`, passes no secret, and only calls `deploy.yml` with its unit and its own inputs (`first-deployment` for all but L1, `seed-ip` and `recover-vaults` for the platform), and each image is built by exactly one pipeline. `deploy.yml`: only `workflow_call`, and no concurrency group of its own (it would deadlock with its caller); OIDC sign-in with the tenant, subscription, resource group and deploy app compiled from `infra/main.<env>.bicepparam` by the pinned Bicep CLI, which every step uses, and no GitHub secret or variable; a fresh sign-in (`SIGN_IN`) first in every step that calls Azure, and no `azure/login`; Azure provisioned by Bicep only (every `az` command in the workflows and the two scripts is a Bicep deployment, a read, a job start, an image copy or a clean-up deletion), and `infra/` holds only `github-setup.sh` and `cleanup.sh`; every step with pipefail; `main.bicep` deployed with `UNIT`, what-if first; every gate (tests, T-IAC-01, image scan, deploy, wait, balance, `--check-baseline` regression, chain, smoke ≤ 120 s, log scan) before promotion; the image steps, promotion and rollback skipped only on the platform, the checks only on a first deployment; L2's ledger lock handover awaited after a platform or L2 deployment; step 0 mapping the unit to its image and refusing `seed-ip` or `recover-vaults` on a unit, `recover-vaults` without `first-deployment`, and a first deployment of L1, before anything else (the guard run for every unit with every combination of the three inputs); promotion records the unit's image as `last-good`, and on L1 first moves the agent's traffic through `main.bicep`; rollback of the unit to its `last-good` on any failure once the deploy step ran, even partway, without touching the agent's traffic; every job started with its own command (the deploy identity never approves or rejects); the smoke token for the API app's client ID; names from the parameter file right after the checkout, none hard-coded. `infra/github-setup.sh` (fake `gh`) creates only the two GitHub environments its parameter file names (the deploy job's and, v1.9, the Auth0 job's `auth0-<env>`), creates the Auth0 environment's six variables when missing (placeholders or defaults, never overwriting), sets no secret and reports leftover secrets. `infra/cleanup.sh` (fake tenant and `gh`) deletes the GitHub environment, the deploy app's role assignments before the app (none orphaned), the resource group, both app registrations and the operators' group, and nothing else; it purges with `--purge`, reports the vaults that purge protection keeps, and deletes nothing with `--dry-run`, unconfirmed, or for another tenant. **Must fail**: a pipeline outside the group, on another unit, on `deploy-*` tags or a merge, with secrets or with steps of its own, and a missing or extra pipeline; `deploy.yml` with its own trigger or concurrency group; promoting before the regression; a regression skipped by another condition, a platform run that builds an image or promotes, or a rollback of the platform; no guard, a guard that lets `seed-ip` through on a unit or a first deployment of L1, a unit built from another image, or the inputs pasted into the script; a GitHub secret, or a sign-in that isn't OIDC from the parameter file; one `azure/login` for the whole job, or a step that calls Azure before signing in; provisioning outside Bicep (`az group create`, traffic moved with `az`); a deployment without what-if, an image built under another name, or a promotion of another image; the operator job started with an approve command; the target step run late, a missing name, an L2 deployment that doesn't wait for the lock handover, or no pipefail; a rollback that redeploys the new image, or a smoke token for another audience; a hard-coded name; a third script in `infra/`; the setup script without its environment check, its Auth0 environment check or its check for existing variables; the clean-up without its role-assignment step or its dry-run guard v1.8: the hosted smoke step fails when any step escalated, so a deployment check never asks the approver (L2-7). v1.10: a seventh pipeline, `deploy-portal.yml`; the guard and the image mapping for `portal`; the build's env scan also refuses a mnemonic or a card vault key; a `portal-smoke` step after the hosted smoke (`/healthz` 200, `/api/config` 200 in `entra` mode, `/api/me` without a token 401); `infra/cleanup.sh` deletes three app registrations. |
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
| T-CIBA-02 | payment-details, ciba-client, backchannel-approve | the request: exactly the contract's form fields, a fresh RS256 client assertion (or `client_secret_post`), the payment details equal to the escalation and the chosen requirement, a binding message within Auth0's limits, no agent text; one request per eligible escalation within 2 s |
| T-CIBA-03 | backchannel-fatigue | a repeat of a pending purchase sends no request and returns at once; `operatorApprovalOnly` sends nothing; a non-boolean value is 400 |
| T-CIBA-04 | backchannel-fatigue | at most 10 requests per rolling hour; the 11th escalation is `capped`. **Must fail**: without the cap, 11 are sent |
| T-CIBA-05 | backchannel-failures | start failures: transient ones retried up to 3 attempts, permanent ones not; each recorded, the escalation pending, an operator approval still pays; with a hanging service the call returns within 6 s |
| T-CIBA-06 | backchannel-approve | polling follows the interval, `slow_down` lengthens it, and polling stops once the escalation is decided |
| T-CIBA-07 | backchannel-refuse, backchannel-lapse | outcomes: a refusal is a backchannel `HUMAN_REJECTION` and R15 applies; a late refusal or an expiry is a lapse; the escalation then expires at 300 s; a late answer changes nothing |
| T-CIBA-08 | approval-evidence, backchannel-verify | each forged answer (issuer, audience, client, signature, expiry, user, amount, payee, escalation, request, replay) records its check and signs nothing. **Must fail**: without each check its forgery verifies; through L2, without the details, approver or issuer check, the forgery pays |
| T-CIBA-09 | backchannel-approve | the bounded wait: an approval within it pays in the same call (two `INTENT`s, one outcome each); after it, the next request pays once; a DENY rule at re-evaluation wins; a caller who leaves gets nothing signed; other calls proceed during the wait |
| T-CIBA-10 | backchannel-lapse | an operator rejection during verification leaves exactly one final state. **Must fail**: with outcomes recorded outside the serialized section, the escalation gets two |
| T-CIBA-11 | backchannel-lapse | after a restart L2 polls the same request from the sealed handle and sends no new one; a window that passed expires; an interrupted start is never resent; another credential cannot open the handle |
| T-CIBA-12 | backchannel-views | a known-value scan of the ledger, logs, responses and events finds no client key, client secret, token, request handle or Auth0 text |
| T-CIBA-13 | backchannel-failures | with the approval service hanging, auto-approved purchases are decided within 50 ms of the feature-off baseline |
| T-CIBA-14 | backchannel-views, escalations | the views and events show the request state, the channel and who decided, from a whitelist; the ledger alone tells each escalation's story (SC-010) |
| T-E2E-10 | e2e | backchannel approval within the wait pays in the same `fetchPaid` (50000 on-chain, one request); the scripted plan with backchannel on matches the baseline and sends no request |
| T-IAC-02 | auth0-iac | `auth0/` offline (v1.8): the provider pin and environment-only credentials; the payment-details type equals the one L2 sends; the API's RS256, RFC 9068, standard consent and access policy; the CIBA-only client with Guardian push; the user-delegated grant; an RS256 public-key credential or a write-only secret; Guardian never destroyed; no users, passwords, private keys or JWTs; the output's keys equal the parameter file's `ciba`; local state and plans ignored. v1.9: the state in Azure with an Entra sign-in and nothing of it written in the folder; no tfvars committed; every variable the pipeline sets declared, and only the four it requires without a default; and the pipeline `provision-auth0.yml`: by hand only, in the GitHub environment `auth0-<env>`, minimal permissions, one run at a time, only its two secrets (v1.11: never L2's client secret, and `credential = "key"` fixed) and only in the plan and apply steps, Terraform's six variables (seven since v1.12, with the portal's origin, which `infra/github-setup.sh` never creates) from the environment's variables and only in the plan step, no tfvars file or `-var`, no input pasted into a script, OIDC for the state and no Azure credential, Terraform pinned by SHA-256, the provider as locked (the lock file holds its checksum for the Linux runner as well as a Mac's, or `validate` refuses it there), the offline checks before init, the plan shown, and the saved plan the only thing applied, only when asked. v1.12 (people's sign-in, `specs/013` research R19): the one role `x402-user` holding exactly the permission `agent:run` on people's API, never assigned to a person here; the portal's single-page client, public, first-party and with only its own grant, and (v1.13) exactly two clients, the portal's and L2's, none for the agent service; the portal client's callbacks, web origins and logout URLs exactly the local origin and `portal_origin` when set (one https host); the one post-login Action (`auth0/sign-in-time.js`, no secret, no package), appended to the flow, writing the one sign-in time claim and nothing else, also when run against a stand-in for Auth0's `api`; the outputs `bicepparam_identity` (v1.13: the issuer and the API's identifier, naming no client) and `bicepparam_portal_client_id` matching the parameter file and shown in the run's summary. **Must fail**: 19 mutants of the configuration (one a lock file without the Linux runner's provider checksum), 39 more of people's sign-in (43 before v1.13 took the agent's client out) and 6 of the Action when run (v1.12), and 32 of the pipeline (a plan with a placeholder, L2's client secret in GitHub, a credential kind chosen by a variable, and a set-up script that creates the portal's origin among them), each reported. `terraform fmt -check` with Terraform installed; `terraform validate` after `init` |
| T-E2E-11 | e2e | a backchannel refusal through the orchestrator: DENIED `human_rejected`, nothing paid, trail `ESCALATED`, `APPROVAL_REQUESTED`, `HUMAN_REJECTION`, `INTENT`, `DENIED` |

Suites added in v1.1: `counterparty.test.ts` (seller, facilitator, MockUSDC, M2/M3), `verifier.test.ts` and `settlement-service.test.ts` (L3 units with a fake chain client), `auth.test.ts` (per-role guards), and `demo.local.test.ts` (demo smoke and clean shutdown). `test/helpers/harness.ts` runs the in-process e2e system.

Manual checks:
- `PAYER_PRIVATE_KEY=0x1 ENV_FILE=/dev/null npx tsx src/main.ts --scripted` exits 1 with the refusal message.
- T-E2E-06 (opt-in, needs a CDP key and a funded Base Sepolia payer): `npm run demo:base-sepolia` exits 0 three times in a row. Each run prints the demo summary plus `settlements:        2 CONFIRMED`, `payer gas spent:    0 wei` and `secret scan:        clean`.
- v1.10, needs outside accounts (`specs/013` quickstart §4 and §5): a card saved and removed against a Stripe sandbox; a sign-in to the portal against the Auth0 tenant, with research R19's checks (v1.12; four since v1.13): the token's claim names, the sign-in time after a forced sign-in and across a renewal, the pop-up without a page of the portal's own, and the two-step removal of the Entra scope.
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
# v1.5 hosted agent service and Azure profile:
npm run stack:local [-- --docker]   # chain, facilitator, seller, L2, L3 for agent:hosted, until Ctrl-C
node --import tsx scripts/vscode-local.ts chain | stack [--users] | run <role> [args]   # VS Code's runner, local mode only
npm run agent:hosted        # L1-6 on 127.0.0.1:4024 (env/l1-hosted.env)
API_DOCS=1 npm run agent:hosted   # plus Swagger UI at http://127.0.0.1:4024/docs (no token; off by default; never in Azure; v1.6)
API_DOCS=1 npm run seller        # the seller plus Swagger UI at http://127.0.0.1:4021/docs (off by default; never in Azure; v1.6)
npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service]   # local dev issuer (NETWORK=local only)
# v1.10 user accounts and the portal (L2-8):
npm run stack:local -- --users   # the local stack with user accounts on in L2 (local dev mnemonic)
npm run build:web           # the portal's web app, to dist/portal-web
npm run portal              # the portal on 127.0.0.1:4025 (env/portal.env); API_DOCS=1 adds /docs
npm run dev-token -- --subject <name> --portal [--auth-age <seconds>]   # a portal token: paste it into the sign-in screen
npm run fund-user -- <address> [usdc]   # local only: mint test USDC to a user's account
npm run wallet-mnemonic     # print one new 24-word mnemonic for USER_WALLET_MNEMONIC (never rotate one in place)
npm run agent:scripted -- --check-baseline   # L1-4 plan; exit 2 unless the baseline matches
npm run ledger-verify       # operator chain check
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
- On a Linux sandbox without IPv6, binding `::` fails. The tests bind the seller on `0.0.0.0` and use `localhost` as the not-allowlisted alias.
- Local ECDSA signing finishes within microtasks, so concurrency races are invisible without `signerLatencyMs`. Keep that hook in T-E2E-04.
- Base Sepolia USDC's EIP-712 name is `"USDC"`, not `"USD Coin"`. A wrong `extra.name` makes signatures fail verification.
- CDP JWTs expire 120 s after they are signed. A skewed seller clock shows up as `facilitator authentication` errors.
- `generateJwt` accepts EC keys only as PKCS#8 (`-----BEGIN PRIVATE KEY-----`, and no leading whitespace). The seller converts SEC1 (`-----BEGIN EC PRIVATE KEY-----`) keys before use.
- Entra refuses to pre-authorize a client for a scope in the same update that adds the scope (v1.10 needed two deployments for `Portal.Access`), and removes only a scope that is already disabled. v1.12 takes that scope out again, so `infra/pre-deploy.bicep` keeps it disabled while `retirePortalScope` is true and leaves it out when false: true for one deployment where the scope exists, then false. The portal's old web app registration is deleted by hand.
- The wallet mnemonic (v1.10) is never rotated in place: L2 compares every recorded wallet address at startup and refuses to start with another phrase. Back it up where the payer key is backed up.
- Stripe's API has two breaking releases a year. The version is pinned in one constant (`API_VERSION` in `src/portal/card-vault.ts`) and in the Stripe.js URL the web app loads; re-check the six calls when moving it.
- A sign-in window can only open from a click, so the web app parks a save that needs step-up behind a "Confirm it's you" button instead of opening the window by itself.
- Child processes spawned through `npx` must be started `detached` and killed by process group (`process.kill(-pid)`), or ganache keeps port 8545 open.
