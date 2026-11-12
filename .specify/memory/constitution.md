<!--
Sync Impact Report
- Version change: 1.6.0 → 1.7.0 (MINOR, 2026-11-12, feature 014-portal-l2-control-api)
- Modified principles: V. Least-Privilege Credentials (the caller roles gain a sixth, portal→control for
  administration; one new bullet for the administration credential; the bullet on the portal role credential is
  unchanged word for word, and stays true: that credential still can't approve or reject). No principle is
  redefined or removed.
- Modified sections: Technology & Scope Constraints (scope: administrators decide escalations in the portal, a user
  approving their own payments stays out; residual risks for v1.15). No new technology: who is an administrator is
  a second permission of the sign-in tenant, in the same Terraform.
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.15 (Changes in 1.15, §3.3, §4 INV-13, §4.1 A12 and A13, L2-4.3, L2-5, L2-8, §11 SEC-8 and
  SEC-27..SEC-29)
- Deferred TODOs: none. The first design kept a "seen" marker in the browser's localStorage; it was dropped during
  implementation because the web app's standing safety test forbids it. The feature was first written as 1.5.0
  against SPEC v1.11, with the administrator as an app role of the organization's directory; main took those
  numbers and moved people's sign-in to Auth0 before it merged, so it is 1.7.0 and a permission of the tenant.

Previous report (1.6.0)
- Version change: 1.5.0 → 1.6.0 (MINOR, 2026-11-11, feature 013-l2-portal-onboarding, research R19)
- Modified principles: V. Least-Privilege Credentials (the requester credential is now one of two: a person's
  access token from the sign-in tenant, Auth0, or a system identity's token from the organization's directory,
  Microsoft Entra ID; the same person's token for the portal and for the agent service differ by the client they
  were issued to, and each service accepts only its own clients). No principle is redefined or removed.
- Modified sections: Technology & Scope Constraints (the web app's sign-in library is `@auth0/auth0-spa-js`
  instead of `@azure/msal-browser`; the Auth0 tenant now also holds people's sign-in, still Terraform; residual
  risks for v1.12)
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.12 (Changes in 1.12, §3.3, L1-6, L2-8, CFG-2, §11 SEC-14, SEC-19..SEC-21)
- Deferred TODOs: the five checks of specs/013 research R19 against the Auth0 tenant (tasks.md T140)

Previous report (1.5.0)
- Version change: 1.4.0 → 1.5.0 (MINOR, 2026-11-10, feature 012-ciba-escalation-approval, convergence T072–T075)
- Modified principles: V. Least-Privilege Credentials (adds the Auth0 Management API credential: held only by the
  Auth0 pipeline's GitHub environment, the only credential GitHub holds, never one of L2's and never payment
  authority). No principle is redefined or removed.
- Modified sections: Technology & Scope Constraints (the Auth0 tenant's Terraform is applied by its pipeline,
  provision-auth0.yml, started by hand, no longer by an administrator's own shell; its state is a blob in Azure
  made by Bicep; residual risks for v1.11)
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.9 (Changes in 1.9) and v1.11 (Changes in 1.11, §11 SEC-25)
- Deferred TODOs: none. This report is late for v1.9: the pipeline was merged on 2026-11-10 before the
  constitution was amended, and /speckit-converge found it.

Previous report (1.4.0)
- Version change: 1.3.0 → 1.4.0 (MINOR, 2026-11-10, feature 013-l2-portal-onboarding)
- Modified principles: I. Separation of Payment Authority (one sentence: people edit their expense policies in
  the portal; the agent never does); V. Least-Privilege Credentials (adds the portal role credential, the wallet
  mnemonic and the card vault credential, and names the portal as the second public process, holding no payment
  key). No principle is redefined or removed.
- Modified sections: Technology & Scope Constraints (multi-tenancy leaves the out-of-scope list: user accounts
  are in scope, organizations and card payments are not; the stack adds, for the portal's web app only and at
  build time, React, Vite and `@azure/msal-browser`, and a card vault, Stripe in test mode, reached over HTTPS
  from the portal only; residual risks for v1.10)
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.10 (Changes in 1.10, §1.3, §3.3, §4.1 A10–A12, L2-8, §11 SEC-19..SEC-24)
- Deferred TODOs: none. Vite's React plugin, named in the plan, was not needed: Vite compiles the JSX itself.

Previous report (1.3.0)
- Version change: 1.2.0 → 1.3.0 (MINOR, 2026-11-07, feature 012-ciba-escalation-approval)
- Modified principles: V. Least-Privilege Credentials (adds the approval-service client credential: L2 only,
  one module by rule A9, authentication only, never payment authority). No principle is redefined or removed.
- Modified sections: Technology & Scope Constraints (jose is no longer L1-only: L2 verifies the approver's token
  and signs its client assertion with it; Auth0 is the approval service, reached over HTTPS from L2 only; the
  Auth0 tenant is Terraform with the auth0/auth0 provider, administrator-applied, while Azure stays Bicep only;
  residual risks for v1.8)
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.8 (Changes in 1.8, §3.3, §4.1 A9, L2-7, §11 SEC-17/SEC-18)
- Deferred TODOs: none

Previous report (1.2.0)
- Version change: 1.1.1 → 1.2.0 (MINOR, 2026-10-22, feature 011-l1-hosted-agent-azure)
- Modified principles: V. Least-Privilege Credentials (adds the requester credential, and the
  cloud reachability rule: loopback bind kept, reached through a same-app proxy sidecar inside one
  private environment). No principle is redefined or removed.
- Modified sections: Technology & Scope Constraints (the stack adds Mastra and its model, schema,
  token and identity libraries for the hosted agent service only; the testnet Azure profile; Node
  floor 22.13; residual risks for v1.5)
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.5 (Changes in 1.5, §3.1 Azure profile, §3.3, INV-3, L1-6, L2-6, §11 SEC-14..16)
- Deferred TODOs: none

Previous report (1.1.1)
- Version change: 1.1.0 → 1.1.1 (PATCH, 2026-10-18, feature 010-operator-reject-flow)
- Modified principles: I. Separation of Payment Authority (clarification: the agent never gets a tool
  that rejects, alongside signs, approves or edits policy). No principle is redefined or removed.
- Modified sections: none
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.3 (Changes in 1.3, L2-2 R15, L2-4.3, L2-5, §11 SEC-8/SEC-12)
- Deferred TODOs: none

Previous report (1.1.0)
- Version change: 1.0.0 → 1.1.0 (MINOR, 2026-10-17, feature 009-cdp-facilitator-base-sepolia)
- Modified principles: V. Least-Privilege Credentials (adds a bullet on third-party API credentials)
- Modified sections: Technology & Scope Constraints (the stack adds the CDP SDK, auth subpath, seller
  only; residual risks add facilitator visibility of payment metadata)
- Removed sections: none
- Templates reviewed: plan-template.md, spec-template.md, tasks-template.md (no change)
- Source: SPEC.md v1.2 (Changes in 1.2, §3.3, §4.1 A8, §5, §11 SEC-10/SEC-11)
- Deferred TODOs: none

Previous report (1.0.0)
- Version change: template → 1.0.0 (initial ratification)
- Principles defined: I. Separation of Payment Authority; II. Deterministic, Pure Policy;
  III. Ledger Is the Single Source of Truth; IV. Trust the Chain, Not the Counterparty;
  V. Least-Privilege Credentials; VI. Exact Money Arithmetic; VII. Protocol Fidelity;
  VIII. Proven Safety (Test-Backed Controls)
- Added sections: Technology & Scope Constraints; Development Workflow & Quality Gates; Governance
- Removed sections: none
- Templates reviewed: plan-template.md (Constitution Check gate applies as-is),
  spec-template.md (no change), tasks-template.md (no change)
- Source: SPEC.md v1.0 §0, §4 (INV-1..INV-13), §5, §11, §12; CLAUDE.md "Hard rules"
- Deferred TODOs: none
-->

# x402 Three-Layer Agent Payments Constitution

## Core Principles

### I. Separation of Payment Authority (NON-NEGOTIABLE)

Payment authority is split across three isolated layers: Intent (L1), Control (L2) and
Settlement (L3). The isolation holds at the module, process and credential level.

- A layer MUST depend only on the shared contract module and its own code. Cross-layer
  wiring is allowed only in composition roots, scripts and tests. (INV-1)
- Only the L2 signer component MAY turn key material into a signing account. (INV-2)
- The agent (L1) MUST NOT reference the payer key and MUST refuse to start if the payer
  key is visible in its environment. (INV-3)
- The settlement verifier (L3) MUST be read-only: no signing and no on-chain writes. (INV-4)
- The agent MUST NEVER be given a tool that signs, approves, rejects or edits policy. People edit
  their own expense policies in the portal; the agent never does, and it has no tool, input, route
  or credential for a profile, a wallet or a policy.

Rationale: a prompt-injected or compromised agent can ask for a payment, but it cannot make
one happen.

### II. Deterministic, Pure Policy

- The authorization decision MUST be a pure function of (offered payment options, mandate,
  context). It does no I/O, takes time as an input, and is never influenced by LLM text.
  The agent's stated purpose is logged only. (INV-5)
- L2 MUST sign exactly one payment option: the one the policy chose. (INV-6)
- The check → sign → record sequence MUST be serialized across concurrent requests. (INV-8)
- A human approval MUST NEVER override a DENY rule. It lifts only the approval requirement,
  for one exact (session, resource, payee, amount) tuple, once. (INV-12)

Rationale: authorization must be reproducible, auditable and race-free.

### III. Ledger Is the Single Source of Truth

- Budget figures MUST be derived from the ledger. Mutable spend counters are forbidden. (INV-7)
- The ledger MUST be append-only and hash-chained. Startup MUST fail if the chain does not
  verify. Entries are never rewritten or deleted; new facts are new entry types. (INV-9)
- A CONFIRMED settlement is final. A later contradicting report MUST be recorded as an
  anomaly and MUST NOT change the effective status. (INV-11)

### IV. Trust the Chain, Not the Counterparty

- Settlement is confirmed only by on-chain evidence: a successful transaction receipt plus a
  matching token Transfer of (payer, payee, amount, asset). The seller's own payment
  response is a claim, not proof. (INV-10)
- Finality requirements scale with the amount at risk.

### V. Least-Privilege Credentials

- Every caller role (agent→control, agent→verifier, verifier→control, operator→control,
  portal→control for user accounts, portal→control for administration) MUST use its own credential. One
  credential MUST NEVER authorize two roles. (INV-13)
- Secrets are scoped per process. A shared environment file containing the payer key is
  forbidden.
- A third-party API credential (for example, the seller's CDP facilitator key) is held by
  exactly one process and confined to one file by an architecture rule. It must never become
  payment authority.
- A requester credential (the access token a person or system presents to the hosted agent
  service) authenticates the requester to L1 only. It MUST NOT be forwarded to L2 or L3, and it
  never replaces a role credential. Since 1.6.0 a person's comes from the sign-in tenant (Auth0) and a
  system identity's from the organization's directory (Microsoft Entra ID); a system identity never names a
  user. A person's token for the portal and for the agent service differ by the client they were issued to:
  each service MUST accept only its own clients and refuse the other's.
- The approval-service client credential (L2's Auth0 key or secret, for backchannel approval) is held by L2
  only and confined to one module by an architecture rule (A9). It authenticates L2 to the approval service; it
  never signs a payment, and it never approves one by itself: an approval counts only when the approver's
  signed answer verifies.
- The Auth0 Management API credential, which the tenant's pipeline (`provision-auth0.yml`) applies Terraform
  with, is held only by that pipeline's own GitHub environment and reaches only its plan and apply steps. It is
  the only credential GitHub holds: no deploy pipeline reads a secret. GitHub MUST NEVER hold a credential of
  L2's (the pipeline provisions the public half of L2's key only), a payment key or a role credential. The
  Management API credential can change the tenant's configuration; it never signs a payment and never approves
  one.
- The portal role credential opens only the control layer's user-account routes. It MUST NOT authorize,
  approve, reject or reconcile, and no other role credential opens those routes. The portal is the second
  public process beside the hosted agent service; it holds no payment key and MUST refuse to start if it
  can see one. A person's portal token is verified by the portal only and is never accepted by the agent
  service, nor the agent's by the portal.
- The portal administration credential opens only the control layer's administration routes: the escalation
  reads, approving and rejecting a pending escalation for a signed-in administrator, the budget behind an
  escalation and the ledger check. It MUST NOT open a user-account route, authorize or reconcile, and no other
  role credential opens those routes. It is held by the portal only and confined to one module by an
  architecture rule (A13), apart from the user-account half. The portal relays an administrator's decision and
  never signs; the control layer checks it (a pending escalation only, never the decider's own payment, a
  recent identity confirmation for an approval) and records it. An approval from the portal is an approval
  like any other: it MUST NEVER override a DENY rule. (INV-12)
- The wallet mnemonic, from which every user's account is derived, is payment key material: it is held by
  L2 only and read by the signer component only. (INV-2)
- The card vault credential is held by the portal only and confined to one module by an architecture rule
  (A10). It can save, list and remove cards; it MUST NOT be able to charge one. Card numbers and security
  codes never reach any process of this system.
- Internal control and verifier services listen only on the loopback interface. In the Azure
  profile they keep that bind and are reached only through a proxy sidecar in the same app, on an
  internal-only ingress inside one private environment. The sidecar holds no secrets and no
  usable identity.

### VI. Exact Money Arithmetic

- All amounts are integer atomic units represented as decimal strings. Arithmetic MUST use
  arbitrary-precision integers. Floating-point money math is forbidden.

### VII. Protocol Fidelity

- Payments follow x402 protocol v2, scheme `exact`, with EIP-3009 USDC authorizations.
- Protocol headers MUST be encoded and decoded with the official x402 SDK helpers, never by
  hand.
- Payment headers produced by L2 are opaque to L1 and are forwarded unchanged.

### VIII. Proven Safety (Test-Backed Controls)

- Every invariant, policy rule, endpoint and contract field MUST have an automated test.
- Every new safety mechanism MUST be shown to fail without the mechanism. For example, the
  concurrency test authorizes 15/15 without the mutex and 10/15 with it.
- Never weaken an invariant to make a test pass.

## Technology & Scope Constraints

- Stack (pinned, SPEC.md §5): Node.js 22 ESM, strict TypeScript, x402 SDK 2.28.0, viem,
  express, Anthropic SDK and vitest. Ganache and solc are used for the local chain only. The
  CDP SDK 1.59.0 is used by the seller only, through its auth subpath, to sign facilitator JWTs.
  Added in 1.2.0, for the hosted agent service (L1) only: Mastra 1.75.0 used as a library,
  `@ai-sdk/anthropic`, zod, jose and `@azure/identity`. The Node floor is 22.13. Added in 1.3.0: L2 also
  uses jose, to verify the approver's token and sign its client assertion; the approval service is an Auth0
  tenant reached over HTTPS by OpenID CIBA in poll mode, from L2 only, with no inbound route. The tenant is
  Terraform (`auth0/`, provider `auth0/auth0`), applied by its pipeline, `provision-auth0.yml`, which an
  administrator starts by hand (amended in 1.5.0; by hand from a shell until then); Terraform manages
  nothing in Azure, which stays Bicep only, and its state is a blob in a storage account Bicep makes. Added in 1.4.0, for the portal's web app only and at build time:
  React, Vite and a sign-in library (`@azure/msal-browser` in 1.4.0; `@auth0/auth0-spa-js` since 1.6.0, when
  people's sign-in moved to the Auth0 tenant, defined in the same Terraform), bundled into static files and never
  a runtime dependency. The two public
  services (the hosted agent and the portal) use express-rate-limit 8.7.1 to bound requests per client address
  before a token is verified. The card
  vault is Stripe in test mode, reached over HTTPS from the portal only, through its REST API with a pinned
  version and no SDK.
- Networks in scope: `local` (dev chain with a mock EIP-3009 USDC) and `base-sepolia`
  (testnet USDC). Mainnet is out of scope. The Azure profile (Container Apps, Key Vault, Microsoft
  Foundry) is in scope on testnet only.
- Out of scope for v1: refunds and disputes, the `upto` and `batch-settlement` schemes,
  Solana, AP2, ACP, Visa TAP, Mastercard Agent Pay, a persistent DB beyond JSONL, and mTLS.
  Since 1.4.0 user accounts are in scope (many users, each with their own account and expense
  policies); organizations of users, paying with a card, moving funds out of a user's account
  and deleting a user stay out. Since 1.7.0 administrators decide escalated payments in the portal; a user
  approving their own payments stays out. Each extension (EXT-1..EXT-9) is delivered one per change and MUST
  preserve every invariant.
- Cross-layer types live only in the shared contract module. Changing them is a contract
  change: update every producer, consumer and test together.
- Accepted residual risks (v1): bearer tokens over loopback, key in an environment variable,
  single-node JSONL ledger, facilitator trusted for liveness, no refund path. Added in 1.1.0:
  the hosted facilitator sees payment metadata (payer, payee, amount, resource), and a settle
  timeout without a transaction hash is indeterminate. Added in 1.2.0:
  - the payer key in Azure Key Vault trusts that vault's RBAC holders;
  - starting an operator or regression job grants that job's credentials;
  - L2/L3 are reachable from the whole private environment, with roles enforced by bearer tokens;
  - the single L2 instance has a lock-handover window;
  - requester limits are per replica.
  Added in 1.3.0:
  - the approval service is trusted to authenticate the approver;
  - the approver's phone is a new place where approvals happen.
  Added in 1.4.0:
  - the hosted agent service is trusted to name the user each payment is for;
  - a stolen portal sign-in can loosen a policy up to the platform limits, after a fresh sign-in;
  - one mnemonic covers every user's test funds and cannot be rotated in place;
  - the card vault sees card details.
  Added in 1.6.0:
  - one provider, Auth0, stands behind people's sign-in and behind approvals; their clients, credentials and
    permissions are separate;
  - step-up relies on a claim that a post-login Action of the tenant sets, to be checked against the tenant
    before user accounts are turned on anywhere.
  Added in 1.7.0:
  - the portal is trusted to name the administrator who decided an escalation and when they confirmed their
    identity; a compromised portal could approve pending escalations within the policies' limits;
  - a stolen administrator sign-in can approve pending escalations after a fresh sign-in, and an administrator
    permission taken away holds until the person's access token expires;
  - one portal process holds two role credentials, separate at the control layer and in its own code.

## Development Workflow & Quality Gates

A change is done only when:

1. Type checking passes.
2. The full test suite passes, including the architecture test.
3. The local demo summary is unchanged (`spent on-chain: 0.006 USDC`, `hash chain ok=true`).
   An intentional plan or price change is allowed only together with an updated SPEC.md.
4. SPEC.md is updated for any behavior or contract change, in the same change.
5. Requirement IDs (INV-*, L1-*, L2-*, L3-*, CP-*, CFG-*, SEC-*, T-*) are referenced in
   commit messages and test names.

New policy rules get a snake_case rule ID, a row in the SPEC rule table and a policy test.

## Governance

- SPEC.md is normative. If code and spec disagree, the spec wins. Fix the code, or amend the
  spec first in the same change with a stated reason. This constitution captures the
  non-negotiable subset of SPEC.md; the feature specs under `specs/` decompose it by area.
- Amendments: change SPEC.md and this file together, bump the version and record a Sync
  Impact Report.
- Versioning: MAJOR when a principle or invariant is removed or redefined; MINOR when a
  principle or section is added; PATCH for clarifications.
- Compliance: every plan MUST pass a Constitution Check against Principles I–VIII before
  design and again before implementation. Every review verifies the quality gates above.
- Runtime guidance for agents lives in `CLAUDE.md`.

**Version**: 1.7.0 | **Ratified**: 2026-10-16 | **Last Amended**: 2026-11-12
