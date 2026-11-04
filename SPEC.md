# SPEC — x402 Agent Payments with Three-Layer Separation

| Field | Value |
|---|---|
| Spec ID | X402-3L-SPEC |
| Version | 1.6 (2026-11-04). v1.0 described the original PoC; v1.1 is the build target for the spec-kit plans in `specs/`; v1.2 adds the CDP facilitator on Base Sepolia (`specs/009`); v1.3 adds the escalation lifecycle: operator rejection, expiry and notification (`specs/010`); v1.4 adds an OpenAPI copy of L2-5 and opt-in Swagger UI on L2 (`API_DOCS=1`); v1.5 adds the hosted agent service on Mastra and Azure (`specs/011`); v1.6 adds OpenAPI copies of L1-6 and the seller (CP-1), with opt-in Swagger UI on both (`API_DOCS=1`) |
| Owner | Fabricio Rojas |
| Status | Implemented PoC; this spec is the source of truth for changes |
| Reference | IMF Note 2026/004, *How Agentic AI Will Reshape Payments* (three-layer model) |

---

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
| §5, §6, §12, §13 | Mastra and its libraries (Node ≥ 22.13), the Azure layout under `infra/` (`pre-deploy.bicep` and `main.bicep` with their parameter files), `docker/` and `.github/workflows/deploy.yml`, tests T-AGT-02..05, T-LED-05, T-E2E-09, T-IAC-01, T-IMG-01 and T-E2E-AZ, and the new commands. |

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

### 1.3 Out of scope (v1)
Mainnet. Refunds and disputes. Schemes `upto` and `batch-settlement`. Solana. AP2 / ACP / Visa TAP / Mastercard Agent Pay integration. Multi-tenant users. Persistent DB beyond JSONL. Production authentication (mTLS). These are covered in §15. The Azure profile (§3.1, v1.5) is in scope on testnet only.

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
| Local chain | `scripts/local-chain.ts` | 8545 | `local:chain` | none |

Ports are overridable with `CONTROL_PORT`, `SELLER_PORT`, `FACILITATOR_PORT`, `SETTLEMENT_PORT`. The chain port 8545 is fixed. Each entry point loads its env with `loadEnv()` from `src/shared/config.ts`. When `ENV_FILE` is unset, it defaults to the file in the last column. Ports are read through getter functions (`controlPort()`, `sellerPort()`, `facilitatorPort()`, `settlementPort()`) at call time, so env loaded at startup applies. L2 and L3 bind only through `listenControl()` and `listenSettlement()`, which always use `127.0.0.1`.

**Azure profile (v1.5, `specs/011` contracts/cloud-topology.md).**

- **Naming.** Every resource and Entra app registration is `{type}-{app}-{location}-{env}`, written only in the parameter files' `names` (the templates and `deploy.yml` take every name from there) and checked by T-IAC-01 rule 15. `{app}` is `l1`, `l2`, `l3`, `op`, `seller` or `seller-alias`, or `x402` for what the layers share and `deploy` for the deploy app. The registry and storage account drop the hyphens (`crx402eastus2dev`). The names below are dev's in `eastus2`; the resource group is `rg-x402-eastus2-dev`, the API app `app-l1-eastus2-dev` (`api://app-l1-eastus2-dev`).
- **Environments.** One workload-profiles Container Apps environment, `cae-x402-eastus2-dev`, on a custom VNet with peer-to-peer encryption. The sellers live in a second environment, `cae-seller-eastus2-dev`, so they can't reach internal-only apps.
- **Apps and jobs** in `cae-x402-eastus2-dev`:
  - `ca-l1-eastus2-dev`: the hosted agent service, external ingress on 4024, 0–1 replicas;
  - `ca-l2-eastus2-dev` and `ca-l3-eastus2-dev`: internal-only ingress, exactly one replica each;
  - `caj-l1-eastus2-dev`: the scripted baseline with `--check-baseline`;
  - `caj-l2-eastus2-dev`: the operator commands.
- **Loopback kept.** L2 and L3 still bind 127.0.0.1. A proxy sidecar in the same app forwards from port 8080 to the loopback port; it gets no env and no secrets.
- **Identity and secrets.** Each runtime unit has its own user-assigned identity and Key Vault. The identity lifecycle is `None` everywhere except the agent, so no container in L2 or L3 can request a token at run time. Secrets reach containers only as Key Vault references.
- **Ledger.** L2's ledger lives on an NFS Azure Files share mounted at `/app/.local`, with the L2-6 lock.
- **Images.** One image per layer, plus the seller's, all tagged with the commit:
  - `x402-l1-agent`: the agent and `caj-l1-eastus2-dev`;
  - `x402-l2-control`: L2 and `caj-l2-eastus2-dev`;
  - `x402-l3-verifier`: L3;
  - `x402-seller`: the sellers.

  Each image holds only its own unit's code and the packages that code imports, so only L2's image contains the signer (T-IMG-01). Each app and job runs from its own unit's image (T-IAC-01 rule 12).
- **Templates.** Azure is provisioned by Bicep only.
  - `infra/pre-deploy.bicep` (subscription scope, deployed by an administrator by hand) makes the resource group, the API app registration (Agent.Run, `user_impersonation` with the Azure CLI pre-authorized, assignment required), the deploy app registration with a GitHub federated credential and no secret, `Agent.Run` for the deploy app and the listed people, the operators' group, and the deploy app's roles: Contributor and Role Based Access Control Administrator, limited to `main.bicep`'s four roles, on the resource group only (T-IAC-01 rule 16). The Entra objects use the Microsoft Graph Bicep extension.
  - `infra/main.bicep` makes everything in the resource group: the platform (network, identities, registry, vaults, storage, Foundry with the Claude deployment, both environments) and each unit's apps, each from its own image and with only its own identities and vaults (T-IAC-01 rules 12 and 13). Its modules take names, never other modules' outputs, so what-if previews even a first deployment.
  - Every value is in `infra/pre-deploy.<env>.bicepparam` and `infra/main.<env>.bicepparam`, the tenant, subscription and resource group included; each template fails validation anywhere else (T-IAC-01 rule 17).
- **Pipeline.** `.github/workflows/deploy.yml` deploys `main.bicep` from one commit, by hand or on a `deploy-*` tag: platform first, then the four images, then everything, each deployment previewed with what-if. It signs in with OIDC from the parameter file at the start of every step that calls Azure (GitHub's token is valid for 5 minutes) and reads no GitHub secret, repeats the cloud regression before promoting, and moves the agent's traffic by redeploying `main.bicep` (T-E2E-AZ).

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

| Secret | L1 | L2 | L3 | Seller | Facilitator | Human operator |
|---|---|---|---|---|---|---|
| `PAYER_PRIVATE_KEY` | **never** | ✅ | — | — | — | — |
| `ANTHROPIC_API_KEY` | ✅ | — | — | — | — | — |
| `CONTROL_TOKEN` (L1→L2) | ✅ | ✅ verifies | — | — | — | — |
| `VERIFIER_TOKEN` (L1→L3) | ✅ | — | ✅ verifies | — | — | — |
| `SETTLEMENT_TOKEN` (L3→L2) | — | ✅ verifies | ✅ | — | — | — |
| `OPERATOR_TOKEN` (human→L2) | — | ✅ verifies | — | — | — | ✅ |
| Requester Entra token (requester→L1 hosted, v1.5) | ✅ verifies, never forwards | — | — | — | — | — |
| `SESSION_REF_SECRET` (v1.5) | ✅ (hosted only) | — | — | — | — | — |
| Agent identity's Foundry access (v1.5, `MODEL_PROVIDER=foundry`) | ✅ (managed identity, no secret) | — | — | — | — | — |
| `FACILITATOR_PRIVATE_KEY` | — | — | — | — | ✅ (local) | — |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | — | — | ✅ (`FACILITATOR=cdp`) | — | — |

The CDP API credential authenticates the seller to the CDP facilitator. It cannot authorize an on-chain transfer, so it is not payment key material (INV-2). Rule A8 confines it to one file.

---

## 4. Invariants (non-negotiable)

| ID | Invariant | Enforced by |
|---|---|---|
| INV-1 | A layer imports only `src/shared/**` and its own folder. Only `src/main.ts`, `scripts/**` and `test/**` may import across layers. | `test/architecture.test.ts` |
| INV-2 | Only `src/layer2-control/signer.ts` turns key material into an account (`privateKeyToAccount`, `mnemonicToAccount`). | architecture test |
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
| INV-13 | Each caller has its own bearer token. L1 cannot reconcile or approve; L3 cannot authorize. | T-E2E-02, T-E2E-05 |

---

### 4.1 Architecture test rules (`test/architecture.test.ts`)

| Rule | Invariant | Scope | Violation |
|---|---|---|---|
| A1 | INV-1 | all layer folders | an import resolves into another layer's folder |
| A2 | INV-1 | `src/shared/**` | shared code re-exports or imports layer code |
| A3 | INV-2 | `src/**` except `src/layer2-control/signer.ts` (`scripts/**` is out of scope) | identifier `privateKeyToAccount` or `mnemonicToAccount`, or an import of `viem/accounts` |
| A4 | INV-4 | `src/layer3-settlement/**` | `createWalletClient`, `signTypedData`, `writeContract`, `sendTransaction`, `privateKeyToAccount` |
| A5 | INV-3 | `src/layer1-intent/**` | string or identifier `PAYER_PRIVATE_KEY` |
| A6 | INV-5 | `src/layer2-control/policy.ts` | I/O or clock imports and calls (`node:*`, `fs`, `http`, `express`, `viem`, `@anthropic-ai/*`, `Date.now`, `new Date()`, `fetch(`, `Math.random`, `console.`), or code access to `purpose` |
| A7 | §10 | all layer folders | `Buffer.from(…, "base64")`, `atob` or `btoa` in a file that mentions an x402 header name |
| A8 | §3.3, SEC-10 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` exempt) | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` or an `@coinbase/cdp-sdk` import outside `src/counterparty/cdp-facilitator.ts` and `env/seller.env.example` |

Each rule has a fixture under `test/fixtures/arch/` that must trip it (Principle VIII). T-ARCH-ENV checks that each `env/*.env.example` holds only the variables its process may see (§3.3, CFG-2).

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
| Tests | vitest (`fileParallelism: false`, 120 s timeouts) | ^5.0 |
| Local chain (dev) | ganache (hardfork `shanghai`) + solc 0.8.24 (`evmVersion: shanghai`, optimizer 200) | 7.9.2 / 0.8.24 |
| Config | dotenv, one file per process via `ENV_FILE` | ^18 |
| CDP facilitator auth (seller only) | `@coinbase/cdp-sdk`, `./auth` subpath only | 1.59.0 (exact) |
| OpenAPI document parsing (tests only) | yaml | ^2.9 |
| API docs UI (L2 and, since v1.6, the hosted agent and the seller, only with `API_DOCS=1`; served by the service itself, never from a CDN) | swagger-ui-dist | 5.33.1 (exact) |
| Hosted agent service (L1-6, v1.5): Mastra `Agent` as a library only, no Mastra server, CLI or instance | `@mastra/core`, `@ai-sdk/anthropic` | 1.75.0 / 3.0.128 (exact) |
| Hosted agent service: tool schemas, requester tokens, Foundry identity | zod, jose, `@azure/identity` | ^4.6.5 / ^6.2.12 / ^4.13.3 |
| Hosted agent and infrastructure tests (dev only) | `ai` (`MockLanguageModelV3`), `@ai-sdk/provider`, `@azure/bicep-rpc-client`; Bicep CLI | ^6.0.302 / ^3.0.18 / ^0.4.1; 0.47.16 |
| Azure profile images | `node:22-bookworm-slim`, `nginxinc/nginx-unprivileged:1.29-alpine` | pinned by digest (the four Dockerfiles, `infra/main.bicep`) |

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
.github/workflows/deploy.yml     deploys infra/main.bicep from one commit with OIDC, gated by the cloud regression
                                 (T-E2E-AZ, v1.5)
Dockerfile                       the seller's image, x402-seller (v1.5)
docker/                          one image per layer: l1-agent.Dockerfile, l2-control.Dockerfile, l3-verifier.Dockerfile;
                                 each holds only its layer's code and packages (T-IMG-01, v1.5)
.dockerignore                    no env file, key or local state in any build context (v1.5)
tsconfig.build.json              emits dist/ for src/ and the operator commands (v1.5)
config/mandate.json              spending mandate (CFG-3)
contracts/MockUSDC.sol           local-only EIP-3009 token (CP-4)
docs/l2-control.openapi.yaml     OpenAPI 3.1 copy of the L2 HTTP API (L2-5); kept in sync by T-API-01..03; L2 serves it with API_DOCS=1
docs/l1-hosted.openapi.yaml      OpenAPI 3.1 copy of the hosted agent's HTTP API (L1-6, v1.6); kept in sync by T-API-05..07;
                                 the agent serves it with API_DOCS=1
docs/seller.openapi.yaml         OpenAPI 3.1 copy of the seller's HTTP API (CP-1, v1.6); kept in sync by T-API-09..10;
                                 the seller serves it with API_DOCS=1
env/*.env.example                one env template per process (CFG-2)
infra/                           Azure profile (§3.1, v1.5; T-IAC-01): pre-deploy.bicep (resource group, Entra apps,
                                 operators' group, deploy app's roles), main.bicep (everything in the resource group),
                                 modules/*.bicep, <template>.<env>.bicepparam (every value), bicepconfig.json (Graph
                                 extension), proxy/nginx-l{2,3}.conf (loopback sidecars), and its only two scripts:
                                 github-setup.sh (the GitHub environment), cleanup.sh (deletes all of an environment)
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
  dev-issuer-lib.ts, dev-token.ts    local dev issuer and tokens for the hosted service (NETWORK=local only, v1.5)
  stack-local.ts                 the local stack without an agent, for the hosted service (v1.5)
  image-closure.ts               each image's files and packages from the import graph; fails the build on another
                                 layer's file (T-IMG-01, v1.5)
  solc.d.ts                      type shim
src/
  shared/contracts.ts            ALL cross-layer types and ports (§7)
  shared/config.ts               network profiles, ports, bind hosts, URLs, tokens, loadEnv, formatAtomic
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
    signer.ts                    sole key holder (L2-3)
    ledger.ts                    hash-chained ledger (L2-4)
    ledger-lock.ts               one ledger writer: exclusive lock, standby, heartbeat (L2-6, v1.5)
    escalations.ts               escalation lifecycle derivations and the sweep (L2-4.3)
    approval-routes.ts           operator approve and reject (L2-5)
    escalation-routes.ts         operator escalation reads (L2-5)
    api-docs.ts                  L2's OpenAPI document for src/shared/api-docs.ts, only with API_DOCS=1 (L2-5, SEC-13)
    service.ts                   HTTP API (L2-5)
  layer3-settlement/
    verifier.ts                  chain verification + finality (L3-1)
    service.ts                   HTTP API + reconciliation + recheck (L3-2)
  counterparty/
    seller.ts                    x402 seller API (CP-1)
    api-docs.ts                  the seller's OpenAPI document for src/shared/api-docs.ts, only with API_DOCS=1 (CP-1; v1.6)
    facilitator-client.ts        facilitator client selection and failure categories (CP-1, CP-3); no credentials
    cdp-facilitator.ts           CDP JWT-authenticated facilitator client; the only reader of the CDP credential (A8)
    facilitator.ts               local facilitator factory, takes a ready account (CP-2)
  main.ts                        composition root for the agent process
  hosted-main.ts                 composition root for the hosted agent service: loadEnv → INV-3 refusal → listen (L1-6)
  refusal.ts                     the INV-3 refusal text both L1 roots print (outside the layer: rule A5)
test/
  policy.test.ts  ledger.test.ts  architecture.test.ts  agent.test.ts  e2e.local.test.ts
  counterparty.test.ts  verifier.test.ts  settlement-service.test.ts  auth.test.ts  demo.local.test.ts
  cdp-config.test.ts  cdp-auth.test.ts  cdp-isolation.test.ts  cdp-failures.test.ts  escalations.test.ts
  openapi.test.ts  openapi-hosted.test.ts  openapi-seller.test.ts (v1.6)
  hosted-agent.test.ts  hosted-access.test.ts  hosted-sessions.test.ts  hosted-run.test.ts   (L1-6, v1.5)
  ledger-lock.test.ts  infra.test.ts  images.test.ts  deploy-workflow.test.ts
  github-setup.test.ts  cleanup.test.ts   (L2-6, Azure, v1.5)
  helpers/hosted.ts              in-process hosted service: dev issuer, mock model, fake or harness ports
  helpers/openapi.ts             OpenAPI document helpers for T-API: routes, a schema subset checker, a client (v1.6)
  fixtures/lock-holder.ts        child process holding the ledger lock until SIGTERM (T-LED-05)
  fixtures/fake-gh.mjs           fake `gh` recording each call and its stdin, for infra/github-setup.sh and cleanup.sh (T-E2E-AZ)
  fixtures/fake-azure.mjs        fake `az` with a tenant in a file (groups, vaults, apps, role assignments), and the real Bicep CLI for `bicep build-params`, for infra/cleanup.sh and github-setup.sh (T-E2E-AZ)
  helpers/bicep.ts               BICEP_PATH and compiled parameter files (names) for the tests (T-IAC-01, T-E2E-AZ)
  helpers/harness.ts             in-process multi-service harness shared by e2e suites
  helpers/fake-public-client.ts  deterministic read-only chain client for L3 unit tests
  helpers/cdp-stub.ts            offline CDP facilitator stub: verifies JWTs, delegates to the local facilitator
  fixtures/arch/                 one violating fixture per architecture rule A1–A8
```

Runtime artifacts go in `.local/` (gitignored): `deployment.json` and `ledger-<network>.jsonl`.

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
  budget(sessionId: string): Promise<BudgetStatus>;
}
export interface SettlementVerifierPort { verify(claim: SettlementClaim): Promise<SettlementReport> }
export interface ReconciliationPort { reconcile(report: SettlementReport): Promise<void> }
export interface BudgetStatus {
  sessionId: string; asset: string; decimals: number; sessionCapAtomic: string;
  spentOrReservedAtomic: string; remainingAtomic: string; perPaymentCapAtomic: string;
}
```

All amounts are **decimal strings of atomic units**. Use `BigInt` for arithmetic, never `Number`.

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

**L1-2 Port adapters** (`ports-http.ts`): `HttpAuthorizationGate` (POST `/v1/authorize`, GET `/v1/budget/:id`) and `HttpSettlementVerifier` (POST `/v1/settlements`). Bearer auth. Non-2xx responses throw.

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
| 3 | `/api/market-brief` | 5000 | PAID, CONFIRMED |
| 4 | `/api/premium-report` | 50000 | ESCALATED (`human_approval_required`) |
| 5 | `/api/dataset-export` | 500000 | DENIED (`hard_cap_exceeded`, plus budget rules) |
| 6 | same as #2 via host `localhost` | 1000 | DENIED (`host_not_allowed`) |

- **Step 6 alias (v1.5).** With `SELLER_ALIAS_URL` set, step 6 requests `<SELLER_ALIAS_URL>/api/weather?city=Lima` instead of the `localhost` rewrite: a second seller host that L2 doesn't allow, as in the cloud regression. Unset, the plan is unchanged.
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
- **Auth.** An Entra ID v2.0 access token, verified with the tenant's JWKS: issuer, `tid`, `aud` (the API app's client ID: v2.0 tokens never carry the `api://` URI, so with Entra any other `AUTH_AUDIENCE` is a startup error), `exp`/`nbf` (60 s tolerance), `oid`, and role `Agent.Run` (else 403). People and service principals are both allowed; people get a token from the Azure CLI for `api://app-l1-eastus2-dev/user_impersonation`, which `infra/pre-deploy.bicep` pre-authorizes. After verification the `Authorization` header is deleted, so it never reaches L2 or L3. With `NETWORK=local` only, `AUTH_JWKS_FILE` selects the dev issuer (`npm run dev-token`).
- **Limits.** Goal 1–4,000 characters; body ≤ 16 KB (413); 2 concurrent runs and 20 starts per sliding hour per requester (429 with `Retry-After`); a 200 s deadline per run, under the ingress's 240 s idle timeout; client disconnect aborts. An abort stops the run before its next step, and a paid fetch in progress completes.
- **Agent.** A Mastra `Agent` used as a library, with exactly `fetch_resource` and `check_budget`. The descriptions are L1-3's, and the JSON schema adds `additionalProperties: false`. It has no memory, workspace, sub-agents, workflows or processors. Limits: `maxSteps` 10, `maxOutputTokens` 2048. Tool results use the L1-3 format.
- **Model.** `MODEL_PROVIDER=foundry` (Microsoft Foundry, keyless Entra token for scope `https://ai.azure.com/.default`) or `anthropic` (API key). The model id must be on the allow-list (`claude-sonnet-5-5` by default), and the Foundry deployment name must equal it; otherwise the AI SDK provider would add a third `json` tool.
- **Sessions.** `sessionRef = sr1.<sessionId>.<HMAC-SHA256(SESSION_REF_SECRET, "sr1|tid|oid|sessionId")>`, issued per new run and verified per requester. Another requester's reference → 404; a raw `sess_…` → 400.
- **Logs.** One JSON line per step and one per run, carrying `runId`, `tid:oid`, `sessionId`, tool, outcome, `intentId`, `authorizationId` and duration. Never headers, tokens, the MAC, the goal, `purpose` or response bodies.

### 8.2 Layer 2 — Control & Authorization

**L2-1 Mandate** (`SpendingMandate`): see CFG-3 for the schema and defaults.
- `allowedNetworks` and `allowedAssets` are always derived from the active network profile.
- `ALLOWED_PAYEES` and `ALLOWED_HOSTS` (comma-separated) override the JSON values when set.
- Payees are compared lower-cased.
- If the mandate breaks `autoApproveMax < hardCap ≤ sessionBudget` (CFG-3), loading fails and L2 refuses to start.

**L2-2 Policy engine** (`evaluateRequirement`, `decide`)

Inputs: `(req, mandate, ctx)` where `ctx = { nowMs, requestedUrl, challengeResourceUrl, sessionCommittedAtomic, dailyCommittedAtomic, authorizationsLastMinute, humanApprovedFor?, humanRejected? }`. `humanRejected = { rejectionId }` is present when a `HUMAN_REJECTION` exists for the request's (session, resource key); `service.ts` derives it from the ledger.

Rules are evaluated in this order. All DENY violations are collected; evaluation does not stop at the first.

| # | Rule ID | Condition for violation | Effect |
|---|---|---|---|
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
| R12 | `daily_budget_exceeded` | `dailyCommitted + amount > dailyBudgetAtomic` | DENY |
| R13 | `velocity_limit` | `authorizationsLastMinute ≥ maxAuthorizationsPerMinute` | DENY |
| R15 | `human_rejected` | `humanRejected` is present (the operator rejected this session and resource key; any amount or payee). Detail: `rejected by the operator (<rejectionId>)`, never the operator's label or reason (SEC-12). Listed here because evaluation follows table order. | DENY |
| R14 | `human_approval_required` | no DENY, and `amount > autoApproveMaxAtomic`, and no matching `humanApprovedFor` (same payTo, case-insensitive, and the exact amount string) | ESCALATE |
| — | (none) | otherwise | AUTHORIZED |

`decide(accepts, m, ctx)`:
- If any requirement is AUTHORIZED, choose the one with the smallest amount (ties go to the first offered) → AUTHORIZED.
- Else, if any is ESCALATE → ESCALATE with that requirement's violations.
- Else → DENIED with all violations flattened, or `no_payment_options` if `accepts` is empty.

**L2-3 Signer** (`PaymentSigner`)
- Constructed with `(privateKey, net, hardCapAtomic)`.
- Registers `ExactEvmScheme(account)` for `net.caip2`.
- SDK spend controls: `{ maxAmountPerPayment: false, allowedAssets: [{ network, asset, maxAmountPerPayment: hardCapAtomic }] }`. This is an independent second cap.
- `sign(challenge, approved)` calls `x402HTTPClient.createPaymentPayload({...challenge, accepts:[approved]})` and returns `{ headers: encodePaymentSignatureHeader(payload), payer: authorization.from, validBefore: Number(authorization.validBefore) }`.
- If the SDK throws, L2 records `DENIED` with rule `signer_rejected` (detail truncated to 300 chars).

**L2-4 Ledger** (`AuditLedger`, JSONL at `.local/ledger-<network>.jsonl`)

Entry: `{ seq, ts (ISO), type, sessionId?, intentId?, authorizationId?, data, prevHash, hash }`.
- `seq` starts at 0 and increases by 1.
- `hash = sha256(canonicalJSON(entry without hash))`. Canonical JSON uses recursively sorted object keys and no whitespace. Absent optional fields are omitted, never written as `null`. Every amount is a string, and every number is an integer.
- The genesis `prevHash` is 64 zeros. `verifyChain` recomputes every hash and link. The constructor throws `integrity` on failure. `brokenAt` is the 0-based line index of the first bad line, which equals `seq` on a well-formed chain.

| Type | Written when | `data` fields |
|---|---|---|
| `INTENT` | every authorize call, before deciding; followed by exactly one outcome entry (`AUTHORIZED`, `DENIED`, `ESCALATED` or `ESCALATION_REPEATED`) | `resourceUrl, purpose, accepts` |
| `AUTHORIZED` | decision AUTHORIZED | `amount, asset, network, payTo, payer, validBefore, resourceUrl, mandateId, approvalRef` (the consumed approval's `approvalId`, or `null`; always present) |
| `DENIED` | decision DENIED | `violations, resourceKey` |
| `ESCALATED` | decision ESCALATE | `violations, resourceKey, payTo, amount` |
| `HUMAN_APPROVAL` | operator approves | `approvalId` (`apr_<uuid>`), `escalationId, resourceKey, payTo, amount, approver, expiresAtMs` |
| `HUMAN_REJECTION` | operator rejects a pending escalation (L2-4.3) | `rejectionId` (`rej_<uuid>`), `escalationId, resourceKey, payTo, amount, operator, reason?` (the last two are untrusted free text, never a decision input) |
| `ESCALATION_EXPIRED` | sweep: an escalation was still pending at `expiresAtMs` | `escalationId, resourceKey, payTo, amount, expiresAtMs` |
| `APPROVAL_LAPSED` | sweep: an approval passed `expiresAtMs` without being consumed | `approvalId, escalationId, resourceKey, payTo, amount, expiresAtMs` |
| `ESCALATION_REPEATED` | ESCALATE for a purchase that already has a pending escalation | `escalationId, resourceKey, payTo, amount, violations` |
| `SETTLEMENT` | L3 reconcile | the `SettlementReport` plus `anomaly: boolean` (status forced to `MISMATCH` on field mismatch, with detail `"verified field mismatch: <fields>"`) |

`resourceKey = origin + pathname` of the resource URL (the query string is excluded).

**L2-4.1 Committed spend** `committedAtomic({sessionId?, sinceMs?}, nowMs)`
- The effective report per authorization is the latest `SETTLEMENT` entry with `anomaly !== true`.
- Sum the `amount` of every `AUTHORIZED` entry in the filter **except** those whose effective report is `NOT_SETTLED` **and** where `nowMs > validBefore*1000` (the signature can no longer settle).
- `MISMATCH` and `PENDING` keep counting (conservative).

**L2-4.2 Approvals**: `findOpenApproval(sessionId, resourceKey, nowMs)` returns the **most recent** `HUMAN_APPROVAL` entry for that (session, resourceKey) that has not expired and is not yet consumed. An approval is single-use. It is consumed when an `AUTHORIZED` entry's `approvalRef` equals its `approvalId`. An escalation has at most one approval (L2-4.3), so it authorizes at most one payment; approving an approved escalation returns the existing approval. An approval is consumed only when it is what lifted R14 (same payee, exact amount, amount above `autoApproveMaxAtomic`); a matching approval seen on a payment that needed no approval stays open.

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
- **Notifications** are the lifecycle entries themselves. The operator reads them through `GET /v1/escalations` and `GET /v1/escalations/events`. L2 makes no outbound connection to notify anyone.
- Every check-then-append (approve, reject, sweep, authorize) is one synchronous block inside the serialized section (INV-8), so each escalation gets exactly one final-state entry.

**L2-5 HTTP API** (binds to 127.0.0.1)

| Method & path | Auth | Request | 200 response | Errors |
|---|---|---|---|---|
| `POST /v1/authorize` | `CONTROL_TOKEN` | `PaymentIntent` | `AuthorizationDecision` | 400 malformed (missing ids, `accepts` not an array, non-http(s) URL), 401 |
| `GET /v1/budget/:sessionId` | `CONTROL_TOKEN` | — | `BudgetStatus` (`perPaymentCapAtomic` = auto-approve limit). An unknown session returns 200 with zero spend. `remainingAtomic` is never below 0. | 401 |
| `POST /v1/reconcile` | `SETTLEMENT_TOKEN` | `SettlementReport` | `{ ok, anomaly }` | 400 malformed report (missing `authorizationId` or `verified`), 404 unknown authorizationId, 401 |
| `POST /v1/approvals/:authorizationId` | `OPERATOR_TOKEN` | `{ approver? = "operator", ttlSeconds? = 600 }` | Pending: `{ ok, approvalId, expiresAt }` and one `HUMAN_APPROVAL`. Already approved: the existing approval plus `alreadyApproved: true`; nothing is appended and the request's `ttlSeconds`/`approver` are ignored (v1.3). | 400 `ttlSeconds` not a positive integer, 404 no ESCALATED entry, 409 `{ error, state: "denied", rejectionId }` or `{ error, state: "expired", expiresAt }`, 401 |
| `POST /v1/rejections/:authorizationId` | `OPERATOR_TOKEN` | `{ operator? = "operator" (1–64 chars), reason? (≤ 280 chars) }` | Pending: `{ ok, rejectionId, rejectedAt, alreadyRejected: false }` and one `HUMAN_REJECTION`. Already denied: the first rejection with `alreadyRejected: true`; nothing is appended. | 400 invalid `operator` or `reason`, 404 no ESCALATED entry, 409 `{ error, state: "approved", approvalId }` or `{ error, state: "expired", expiresAt }`, 401 |
| `GET /v1/escalations` | `OPERATOR_TOKEN` | — | `{ pending: [{ authorizationId, sessionId, resourceKey, payTo, amount, createdAt, expiresAt }], cursor }`, oldest first; `cursor` is the last ledger `seq` (-1 when empty) | 401 |
| `GET /v1/escalations/events?after=<seq>` | `OPERATOR_TOKEN` | `after`: integer ≥ -1, default -1 | `{ events, cursor }`: one event per lifecycle entry with `seq > after` (`escalated`, `approved`, `denied`, `expired`, `approval_lapsed`), built from a field whitelist; never tokens, payment headers, `accepts` or `purpose` | 400 bad `after`, 401 |
| `GET /v1/ledger/verify` | `OPERATOR_TOKEN` | — | `{ entries, ok, brokenAt? }` | 401 |
| `GET /docs` | none; only with `API_DOCS=1` | — | Swagger UI page (HTML) whose CSP limits scripts and requests to the L2 origin | — |
| `GET /docs/:asset` | none; only with `API_DOCS=1` | — | `swagger-ui.css` or `swagger-ui-bundle.js` from `swagger-ui-dist`, or `swagger-initializer.js` | 404 any other name |
| `GET /openapi.yaml` | none; only with `API_DOCS=1` | — | `docs/l2-control.openapi.yaml` with `servers` set to `/`, the L2 serving it | — |

`docs/l2-control.openapi.yaml` describes the same API in OpenAPI 3.1, with the request and response schemas from §7. This table stays normative. When a route, token, status or response field changes, update the table, §7 and the document together; T-API-01..03 fail until they match.

With `API_DOCS=1` (CFG-2), L2 also serves that document and Swagger UI over it; without it, those three routes are not mounted and answer 404. They are the only L2 routes without a token. They serve files read at startup (a missing file fails startup) and never touch the ledger, mandate or signer. Swagger UI comes from the pinned `swagger-ui-dist` package, never a CDN. The page's Content-Security-Policy allows scripts and requests to its own origin only, because tokens typed into the page share that origin with the signing API (SEC-13). Swagger UI keeps entered tokens in memory only, and "Try it out" calls the live L2.

Authorize algorithm. The whole body runs inside one serialized critical section (INV-8: a promise-chain mutex):
1. `t = now()`. Append `INTENT`.
2. Look up an open approval for (session, resourceKey).
3. Build `ctx`. Committed spend is per session and over the trailing 24 h; velocity counts AUTHORIZED entries in the trailing 60 s.
4. `decide`.
5. If AUTHORIZED: optionally wait `signerLatencyMs` (a test hook that simulates a remote signer), then sign. On a signer error, the decision becomes DENIED with `signer_rejected`.
6. Append `AUTHORIZED`, `DENIED` or `ESCALATED`. Return the decision.

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
- `GET /api/catalog` is free and is mounted **before** the payment middleware. It returns `{network, asset, decimals, items:[{path, priceAtomic, description}]}`.
- **API docs** (v1.6). `docs/seller.openapi.yaml` describes these routes in OpenAPI 3.1, each priced route with its catalog price (`x-x402-price-atomic`). When a route, price, status, header or body changes, update this section and the document together; T-API-09 and T-API-10 fail until they match. With `API_DOCS=1` (CFG-2), `GET /docs`, `GET /docs/:asset` and `GET /openapi.yaml` serve Swagger UI over that document, mounted before the payment middleware like the catalog, from the same shared module as L2's (SEC-13). They never call the facilitator. The Azure deployment never sets `API_DOCS`.

| Route | Amount | Body (mock, deterministic) |
|---|---|---|
| `/api/weather?city=` | 1000 | `{city, tempC, condition, source}`. `seed` = sum of the city's char codes; `tempC = seed % 35`; `condition = ["sunny","cloudy","rain","fog"][seed % 4]` |
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
| `l1-hosted.env` (v1.5) | `NETWORK, SELLER_URL, CONTROL_URL, SETTLEMENT_URL, CONTROL_TOKEN, VERIFIER_TOKEN, MODEL_PROVIDER, ANTHROPIC_MODEL?, ANTHROPIC_API_KEY? (anthropic only), FOUNDRY_BASE_URL? and AZURE_CLIENT_ID? (foundry only), AUTH_TENANT_ID, AUTH_AUDIENCE, AUTH_JWKS_FILE? (local only), SESSION_REF_SECRET, AGENT_PORT?, AGENT_BIND_HOST?, API_DOCS? (v1.6)` |
| `l2-control.env` | `NETWORK, PAYER_PRIVATE_KEY, ALLOWED_PAYEES, ALLOWED_HOSTS, CONTROL_TOKEN, SETTLEMENT_TOKEN, OPERATOR_TOKEN, API_DOCS?` |
| `l3-verifier.env` | `NETWORK, BASE_SEPOLIA_RPC_URL?, CONTROL_URL, VERIFIER_TOKEN, SETTLEMENT_TOKEN` |
| `seller.env` | `NETWORK, SELLER_PAY_TO, FACILITATOR?, FACILITATOR_URL?, CDP_API_KEY_ID?, CDP_API_KEY_SECRET?, API_DOCS? (v1.6)` (the CDP pair is required when the choice is `cdp`) |
| `facilitator.env` | `NETWORK=local, FACILITATOR_PRIVATE_KEY` |
| `operator.env` | `CONTROL_URL, OPERATOR_TOKEN` |
| `pre-deploy.<env>.bicepparam`, `main.<env>.bicepparam` (v1.5, in `infra/`) | Not env files: every value the two Azure deployments use. The target (`tenantId, subscriptionId, location`), every resource name (`names`, with the resource group), the GitHub repository and environment, the app and group IDs from `pre-deploy.bicep`'s outputs, public addresses and the Claude attestation. Only `imageTag, platformOnly, seedIp, recoverVaults, agentStableRevision` come from `deploy.yml`'s environment. Only Bicep reads them (`bicep build-params`). No secret values |

Token defaults (`dev-control-token`, `dev-settlement-token`, `dev-verifier-token`, `dev-operator-token`) apply only when `NETWORK=local`. On any other network, a missing or empty token is a startup error. An empty token is always a startup error.
- Each entry point calls `loadEnv()`. `ENV_FILE` defaults to the process's own file (§3.1), and a caller can override it.
- Templates leave private keys empty (`# set me`).
- `API_DOCS` (L2 and, since v1.6, the hosted agent and the seller; read by `apiDocsEnabled()`): `1` mounts the docs routes (L2-5, L1-6, CP-1); unset, empty or `0` leaves them off; any other value is a startup error. No Azure template or workflow sets it.
- `npm run demo:local` gives each child only `PATH`, `HOME`, `NODE_*` and its own `ENV_FILE`. On `local`, if `env/l2-control.env` or `env/facilitator.env` is missing or the key is empty, the demo derives that key with `localDevKeys()`. It passes the payer key only to the L2 child and the facilitator key only to the facilitator child.
- The demo spawns `node_modules/.bin/tsx` directly (not `npx`) and reads each child's env file with a minimal `KEY=value` reader for its fallback decisions; only `src/shared/config.ts` uses dotenv (architecture test). On `local`, when `SELLER_PAY_TO` or `ALLOWED_PAYEES` is empty, the demo sets it to account #3 (CP-5).
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
| SEC-14 | Anyone who can reach the public agent endpoint spends from the budget | Entra ID token with `Agent.Run` checked before any model or L2 call; per-requester limits; L2's budgets and rules unchanged | T-AGT-03 |
| SEC-15 | A requester continues another requester's session and uses its approvals or budget | HMAC-bound session references; a raw session ID is refused; a foreign reference → 404 | T-AGT-04 |
| SEC-16 | Secrets, requester tokens or payment headers reach logs or telemetry | Whitelisted JSON run logs; no Mastra observability or OTel export; known-value tests offline and a shape scan of cloud logs | T-AGT-05, T-E2E-AZ |

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
- The deploy app trusts any run of the repository's deploy job in the `<env>` GitHub environment (OIDC). Whoever can run `deploy.yml` or push a `deploy-*` tag gets its rights: Contributor and Role Based Access Control Administrator (limited to `main.bicep`'s four roles) on `rg-x402-<location>-<env>`, and `Agent.Run`. Required reviewers on the GitHub environment narrow this.
- Deploying the Claude model accepts Anthropic's Azure Marketplace terms with the attestation in `main.<env>.bicepparam`.

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
| T-ARCH-* | architecture | rules A1–A7 (§4.1). Each fixture under `test/fixtures/arch/` trips its rule. |
| T-ARCH-ENV | architecture | each `env/*.env.example` holds only its process's variables; private keys and secrets are empty |
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
| T-API-09 | openapi-seller | the operations in `docs/seller.openapi.yaml` equal the routes mounted on the seller with `API_DOCS=1`; without it, exactly the operations not tagged `docs`; each priced operation's `x-x402-price-atomic` equals its `CATALOG` price, and every catalog route is priced in the document (v1.6). **Must fail**: a missing route, an unmounted route, a wrong price and a price for a route the catalog lacks are reported |
| T-API-10 | openapi-seller | an in-process scenario with a scripted facilitator behind the real categorized client reaches every documented status of every route: 200 paid, 402 (no payment, a rejected payment, a payment for another route, a failed settlement), 502 (facilitator failing mid-payment) and 503 (facilitator down); bodies, media types and required headers conform, and the `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` headers, decoded with the SDK, conform to their `contentSchema`, as does the payment sent. **Must fail**: a wrong enum value, a missing field, an undocumented field and a wrong `x402Version` are reported |
| T-API-11 | openapi-seller | the seller's docs routes (SEC-13): with `API_DOCS` unset, none is mounted and each docs URL answers 404; the seller refuses to start with any other value than `1`, `0` or empty; `sellers.bicep` never sets it; the served document equals the file except `servers` = `/`; the page carries the same-origin CSP; `/docs/:asset` serves its three files only. **Must fail**: with `API_DOCS=1` the same probe gets 200 and makes no facilitator call; a document without `servers` is refused |
| T-AGT-01 | agent | fake model → tool calls → intents carry `purpose`; the tool result contains PAID + CONFIRMED; exactly two tools are offered |
| T-AGT-KEY | agent | spawning `src/main.ts`, or `src/hosted-main.ts` with the key in the process env or only in `ENV_FILE` (v1.5), with `PAYER_PRIVATE_KEY` set exits 1 with a refusal (the automated form of the manual check below) |
| T-AGT-02 | hosted-agent | every model call offers exactly `fetch_resource` and `check_budget` with the L1-3 descriptions and schemas; 2048 max output tokens; 10 steps; both providers' HTTP requests (Foundry: Entra bearer, no `x-api-key`); config rules. **Must fail**: an injected extra tool appears as a third name; an unrecognized model id is refused |
| T-AGT-03 | hosted-access | 401 for missing, invalid, expired, wrong-audience, wrong-issuer or wrong-tenant tokens; 403 without `Agent.Run`; each refusal under 1 s with 0 model and 0 L2 calls; 2 concurrent and 20 hourly runs per requester (429 with `Retry-After`); L2/L3 never see the requester's token; with Entra a non-GUID `AUTH_AUDIENCE` is a startup error. The API app registration itself is checked by T-IAC-01 rule 16. **Must fail**: with `bypassAuth`, an unauthenticated run reaches the model; the `api://` audience loads without the check |
| T-AGT-04 | hosted-sessions | a reference continues its requester's session; another requester's use → 404; a raw `sess_…` or malformed reference → 400; a tampered or non-canonical MAC → 404. **Must fail**: with `skipSessionMac`, requester B uses requester A's session |
| T-AGT-05 | hosted-run | response shape; the 200 s deadline (a fetch in progress completes, no model call after); step limit; body limits; readiness; failure keeps finished steps; run-log lines are whitelisted JSON and planted secrets never appear; the cloud scan's credential shapes |
| T-E2E-01 | e2e | scripted plan outcomes `[FREE, PAID, PAID, ESCALATED, DENIED, DENIED]`; on-chain delta exactly 6000; two CONFIRMED settlements; chain ok; budget `spentOrReserved = 6000` |
| T-E2E-02 | e2e | HITL: escalate → agent-token approval returns 401 → operator approval → PAID+CONFIRMED → the same request escalates again |
| T-E2E-03 | e2e | forged `PAYMENT-RESPONSE` → L3 returns MISMATCH; L2 keeps the first CONFIRMED and records an anomaly naming `amount` |
| T-E2E-04 | e2e | with `signerLatencyMs: 25`, 15 concurrent intents → exactly 10 AUTHORIZED in the trailing 60 s. **Must fail if the mutex is removed** (verified: 15/15 without it) |
| T-E2E-05 | e2e (must-fail proof in auth) | `/v1/reconcile` with the agent token returns 401; the ledger is unchanged |
| T-E2E-07 | e2e | operator reject: the retry is DENIED `human_rejected` with no operator text in the detail, another session still escalates, the ledger trail is ESCALATED → HUMAN_REJECTION → DENIED; a concurrent approve and reject yield exactly one final entry; the events feed reports escalated, denied and approved |
| T-E2E-08 | e2e | expiry on L2's clock: a repeat while pending reuses the ID; after 300 s the escalation expires, approve and reject are 409, the next request escalates under a new ID, and re-approving returns the same approval so one payment happens |
| T-E2E-09 | e2e | the hosted service on the harness: FREE, PAID, PAID, ESCALATED with both payments CONFIRMED and 6000 spent; continuation after an operator approval pays once with `approvalRef`, and another requester's use of the reference → 404 with the ledger unchanged |
| T-LED-05 | ledger-lock | one ledger writer (L2-6): a second acquirer waits while a fresh lock is held and takes it within 2 s of SIGTERM; a 31 s stale lock is taken over; a lost lock is reported; `main()` locks before loading. **Must fail**: two unlocked writers fork the chain and the reload throws `integrity` |
| T-IAC-01 | infra (needs `BICEP_PATH`) | the compiled `infra/main.bicep` and `infra/pre-deploy.bicep`, with their parameter files: role assignments only per the identity–vault matrix (the operators' group on the operator job only); the payer key only in `ca-l2-eastus2-dev/l2` from the l2 vault; internal-only L2/L3; one L2 replica on NFS; sidecars without env or secrets; identity lifecycle `Main` only for the agent; sellers in their own environment; no secret literals; `ALLOWED_HOSTS` is the seller, not the alias; vault firewalls deny by default, open only to `seedIp`, recovered only through `recoverVaults`; the agent's audience is a required client ID; each app and job on its own unit's image, which contains its command's entry point, and the operator job's own command `ledger-verify`; each unit's apps look up only their own identities and vaults and wait for the platform; the model is keyless (Foundry refuses API keys, no container gets an Anthropic key, the agent signs in as `id-l1-eastus2-dev`) and the agent's model is the Claude deployment with its attestation; every name in the parameter files' `names` is the standard one for its place there and fits Azure's limits, every resource is named from `names`, each of `names` is deployed, every module gets `names` whole, and no template builds a name from the location or writes one out; the API app (v2.0 tokens, its standard URI, only Agent.Run, only `user_impersonation` with only the Azure CLI pre-authorized, assignment required), the deploy app (no secret, one federated credential for the deploy environment), Agent.Run for the deploy app and `agentUsers` only, the operators' security group, and the deploy app's Contributor and condition-limited Role Based Access Control Administrator on the resource group only; every template parameter set in its parameter file, only the five per-run values from the environment, both files agreeing on the target, and each template refusing to run elsewhere. **Must fail**: 22 mutant tests (rules 1, 2, 3, 9, 10, 11; two each for rules 12, 13, 14 and 17; five for rule 15; three for rule 16) |
| T-IMG-01 | images | each image's import graph (`scripts/image-closure.ts`) stays in its own folders and uses only runtime dependencies; only the L2 image holds the signer; only the L1 image holds Mastra and the model SDKs; every Dockerfile builds its own image from the same pinned base and loads every module once. **Must fail**: L1 reaching the signer; a package resolved at run time but not listed; an imported package missing from `dependencies` |
| T-E2E-AZ | deploy-workflow, github-setup, cleanup (static) and the live workflow | `deploy.yml`: manual or `deploy-*` tag triggers, one concurrency group; OIDC sign-in with the tenant, subscription, resource group and deploy app compiled from `infra/main.<env>.bicepparam` by the pinned Bicep CLI, which every step uses, and no GitHub secret or variable; a fresh sign-in (`SIGN_IN`) first in every step that calls Azure, and no `azure/login`; Azure provisioned by Bicep only (every `az` command in the workflow and the two scripts is a Bicep deployment, a read, a job start, an image copy or a clean-up deletion), and `infra/` holds only `github-setup.sh` and `cleanup.sh`; every step with pipefail; what-if before each deployment; every gate (tests, T-IAC-01, image scan, deploy, wait, balance, `--check-baseline` regression, chain, smoke ≤ 120 s, log scan) before promotion; steps skipped only by the first, platform-only run; step 0 refusing `seed-ip` or `recover-vaults` without `platform-only` before anything else (the guard run for every combination of the three inputs); all four images built; promotion moves the agent's traffic through `main.bicep`; rollback to `last-good` on any failure once the deploy step ran, even partway, without touching the agent's traffic; every job started with its own command (the deploy identity never approves or rejects); the smoke token for the API app's client ID; names from the parameter file right after the checkout, none hard-coded. `infra/github-setup.sh` (fake `gh`) creates only the GitHub environment its parameter file names and reports leftover secrets. `infra/cleanup.sh` (fake tenant and `gh`) deletes the GitHub environment, the deploy app's role assignments before the app (none orphaned), the resource group, both app registrations and the operators' group, and nothing else; it purges with `--purge`, reports the vaults that purge protection keeps, and deletes nothing with `--dry-run`, unconfirmed, or for another tenant. **Must fail**: promoting before the regression; a regression skipped by another condition; no platform-only guard, a guard that misses `recover-vaults`, or the inputs pasted into the script; a GitHub secret, or a sign-in that isn't OIDC from the parameter file; one `azure/login` for the whole job, or a step that calls Azure before signing in; provisioning outside Bicep (`az group create`, traffic moved with `az`); a deployment without what-if, or a missing image; the operator job started with an approve command; the target step run late, a missing name, or no pipefail; a rollback skipped when the deploy step failed, or a smoke token for another audience; a hard-coded name; a third script in `infra/`; the setup script without its environment check; the clean-up without its role-assignment step or its dry-run guard |
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

Suites added in v1.1: `counterparty.test.ts` (seller, facilitator, MockUSDC, M2/M3), `verifier.test.ts` and `settlement-service.test.ts` (L3 units with a fake chain client), `auth.test.ts` (per-role guards), and `demo.local.test.ts` (demo smoke and clean shutdown). `test/helpers/harness.ts` runs the in-process e2e system.

Manual checks:
- `PAYER_PRIVATE_KEY=0x1 ENV_FILE=/dev/null npx tsx src/main.ts --scripted` exits 1 with the refusal message.
- T-E2E-06 (opt-in, needs a CDP key and a funded Base Sepolia payer): `npm run demo:base-sepolia` exits 0 three times in a row. Each run prints the demo summary plus `settlements:        2 CONFIRMED`, `payer gas spent:    0 wei` and `secret scan:        clean`.
- `npm run demo:local` summary shows `spent on-chain: 0.006 USDC` and `hash chain ok=true entries=<n>` (`entries` counts the persistent `.local` ledger and grows across runs), and no listeners remain on ports 8545 or 4020–4023 afterwards.

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
npm run agent:hosted        # L1-6 on 127.0.0.1:4024 (env/l1-hosted.env)
API_DOCS=1 npm run agent:hosted   # plus Swagger UI at http://127.0.0.1:4024/docs (no token; off by default; never in Azure; v1.6)
API_DOCS=1 npm run seller        # the seller plus Swagger UI at http://127.0.0.1:4021/docs (off by default; never in Azure; v1.6)
npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service]   # local dev issuer (NETWORK=local only)
npm run agent:scripted -- --check-baseline   # L1-4 plan; exit 2 unless the baseline matches
npm run ledger-verify       # operator chain check
npm run payer-balance -- <address> [--min <atomic>]   # read-only Base Sepolia USDC balance
... | npm run scan-logs     # credential-shape scan of log lines
npm run build               # dist/ (each image's build stage runs it)
docker build -f docker/l1-agent.Dockerfile -t x402-l1-agent .   # one per layer in docker/; the seller's: docker build -t x402-seller .
BICEP_PATH=~/.azure/bin/bicep npm test   # every suite, T-IAC-01 and the infra script tests included
az deployment sub what-if|create -n pre-deploy-<env> -p infra/pre-deploy.<env>.bicepparam \
  --subscription <its subscriptionId> -l <its location>   # admin, by hand
infra/github-setup.sh [--environment <env>] [--dry-run]   # the GitHub environment deploy.yml runs in
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
| EXT-6 | **Durable ledger** | SQLite with the same entry schema and hash chain; `committedAtomic` as a SQL view; WAL mode. | L2-4 |
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
- Child processes spawned through `npx` must be started `detached` and killed by process group (`process.kill(-pid)`), or ganache keeps port 8545 open.
