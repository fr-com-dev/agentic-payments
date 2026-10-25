# Implementation Plan: Cloud-Hosted Purchasing Agent (L1) on Mastra and Azure

**Branch**: `011-l1-hosted-agent-azure` | **Date**: 2026-10-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/011-l1-hosted-agent-azure/spec.md`, with clarifications
from session 2026-10-21 (Q1: A, Q2: C, Q3: C).

## Summary

L1 gains a second composition root: an HTTP agent service built on Mastra's `Agent`, used as a
library inside our own Express route. It runs the same two tools, prompt and limits as the L1-3
agent.

- **Requesters.** People and service identities authenticate with Entra ID tokens that carry the
  `Agent.Run` role. Sessions are bound to requesters by an HMAC session reference. Per-requester
  limits are enforced in memory on a single agent replica.
- **Model.** Claude is reached through Microsoft Foundry with a keyless managed identity, or
  through the Anthropic API, chosen by configuration. A model ID allow-list prevents the provider
  from adding a hidden tool.
- **Azure layout.** All three layers run in one Azure Container Apps environment. The agent has
  public ingress. L2 and L3 keep binding loopback, and a proxy sidecar exposes each one only
  inside the environment. Each runtime unit has its own identity and Key Vault. The seller lives
  in a separate environment.
- **One ledger writer.** Container Apps briefly overlaps revisions on every update, so L2 gains a
  ledger lock (new L2-6). That keeps one writer, with the ledger on an NFS share.
- **Deployment.** Everything is Bicep. A GitHub Actions workflow deploys one commit and gates the
  release on the scripted baseline, run as a Container Apps Job. It also runs a hosted smoke call
  and a secret scan of the logs.

The cross-layer contracts (`src/shared/contracts.ts`) do not change, and neither does the L2 policy.

## Technical Context

**Language/Version**: TypeScript (strict), ESM, NodeNext. Node.js ≥ 22.13: Mastra's floor, which
raises `engines.node` from 22. Development runs on Node 26. The image is `node:22-bookworm-slim`.

**Primary Dependencies** (pins in [research.md](research.md#dependency-pins-newest-stable-at-least-14-days-old-on-2026-10-21)):
- runtime: `@mastra/core` 1.75.0, `@ai-sdk/anthropic` 3.0.128, `zod` 4.6.5, `jose` 6.2.12,
  `@azure/identity` 4.13.3;
- dev: `ai` 6.0.302 (mock model), `@ai-sdk/provider` 3.0.18, `@azure/bicep-rpc-client` 0.4.1;
- infrastructure: Bicep CLI 0.47.16, `nginx-unprivileged` (pinned by digest).

**Storage**:
- No new application store. Sessions are stateless HMAC references, and run limits live in memory.
- The L2 ledger stays hash-chained JSONL, on a premium NFS Azure Files share in the cloud, with a
  lock file beside it.

**Testing**:
- vitest with `MockLanguageModelV3` and fake `fetch` for the model;
- a local JWKS dev issuer for tokens;
- the in-process harness (`test/helpers/harness.ts`) for hosted e2e;
- spawned processes for INV-3 and the ledger lock;
- the Bicep compile for T-IAC-01, which is opt-in locally and mandatory in the deploy workflow;
- the live post-deployment regression (T-E2E-AZ).

**Target Platform**:
- locally, the existing multi-process stack plus `npm run agent:hosted`;
- in the cloud, Azure Container Apps (workload profiles, Consumption) in `eastus2`, on Base Sepolia.

**Project Type**: the multi-process three-layer service (L1/L2/L3), plus an HTTP front-end for L1,
infrastructure as code and a deployment workflow.

**Performance Goals**: the default goal finishes within 120 s at p95 (NFR-004). Refusals return
within 1 s. Each run has a 200 s deadline, under the 240 s ingress idle timeout (research R5).

**Constraints**:
- INV-1..13 hold, and only two tools are ever offered;
- L2/L3 bind loopback, are private, and L2 runs as one instance;
- requester credentials never reach L2/L3;
- no telemetry leaves the service;
- `demo:local` is unchanged.

**Scale/Scope**: single tenant. A handful of requesters, a few concurrent runs, one agent replica.
Testnet only.

No item is NEEDS CLARIFICATION. [research.md](research.md) records each decision (R1–R18).

## Constitution Check

*GATE: must pass before Phase 0 research, and again after Phase 1 design.*

| Principle | Check | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of payment authority | **Layer imports.** The hosted parts live in `src/layer1-intent/hosted/`, import only `../shared/*` and L1 code, and reach L2/L3 only through `ports-http.ts`, so A1 holds (R9). **No payer key.** The entry point `src/hosted-main.ts` sits outside the layer like `src/main.ts`, so A5 holds. It loads env, then refuses at once if the payer key is visible, with the shared refusal (INV-3). **Two tools only.** No tool signs, approves or rejects, enforced by T-AGT-02 at the mock and HTTP levels (R3). **No operator access.** The operator credential and routes are absent from L1, and the existing SEC-8 check covers the new folder. **In the cloud,** separate identities and vaults, checked by T-IAC-01 (R10, R15). | PASS | PASS |
| II. Deterministic, pure policy | The policy is unchanged. `purpose` stays audit-only (INV-5). The requester's identity is never a policy input and never reaches L2 (FR-009). | PASS | PASS |
| III. Ledger is the single source of truth | Budgets still come from the ledger, and a session reference only gates access to a session. The new L2-6 lock is a file beside the ledger, never an entry. It guarantees one writer across revision overlap, and the startup integrity check still runs, now after the lock is held (R12). | PASS | PASS |
| IV. Trust the chain | L3 is unchanged. The cloud regression keeps L3's on-chain checks. | PASS | PASS |
| V. Least-privilege credentials | **New credentials, one role each**: the requester's Entra token (verified by L1 only, stripped before any downstream call), `SESSION_REF_SECRET` (L1 only) and `id-l1`'s Foundry access (L1 only). **Per-unit secrets**: one vault and identity per runtime unit. Identity lifecycle `None` keeps sidecars from obtaining tokens. **Loopback kept**: L2/L3 still bind loopback, but who can reach them widens to the private environment through the sidecar (Complexity Tracking #1). | PASS, with a justified deviation | PASS. Constitution 1.2.0 states the cloud profile explicitly |
| VI. Exact money arithmetic | `amountUsd` stays the existing `formatAtomic` display value. No new arithmetic. | PASS | PASS |
| VII. Protocol fidelity | x402 headers are untouched, and L1 forwards L2's headers unchanged through the same orchestrator. | PASS | PASS |
| VIII. Proven safety | Every new control has a must-fail proof (see Proofs below): the tool set, access, session binding, the ledger lock, the identity and secret matrix, and log redaction. | PASS | PASS |
| Quality gates | typecheck, the full suite, an unchanged `demo:local` summary, SPEC v1.5 in the same change, and requirement IDs in test names. | PASS | PASS |

Complexity Tracking lists the justified deviations.

## Project Structure

### Documentation (this feature)

```text
specs/011-l1-hosted-agent-azure/
├── spec.md
├── plan.md                 # this file
├── research.md             # Phase 0: R1–R18 and dependency pins
├── data-model.md           # Phase 1: run, requester, session reference, limiter, ledger lock, runtime units
├── quickstart.md           # Phase 1: offline, local, first Azure deployment, operator flow
├── contracts/
│   ├── hosted-agent-api.md     # proposed L1-6: POST /v1/runs, health, logs
│   ├── access-and-sessions.md  # Entra token checks, session references, limits
│   ├── model-access.md         # providers, allow-list, CFG-2 l1-hosted.env, §3.3 rows
│   ├── ledger-lock.md          # proposed L2-6
│   ├── cloud-topology.md       # Azure resources, apps, secrets, roles, sidecar, T-IAC-01 rules
│   └── deploy-pipeline.md      # workflow steps, regression gate, rollback (T-E2E-AZ)
├── checklists/requirements.md
└── tasks.md                # Phase 2 (/speckit-tasks)
```

### Source code (repository root)

```text
src/layer1-intent/
├── refusal.ts              # NEW: REFUSAL text shared by both L1 roots (moved from src/main.ts, re-exported there)
├── scripted.ts             # MOD: scriptedPlan(sellerUrl, aliasUrl?); checkBaseline(results) for --check-baseline (L1-4)
└── hosted/
    ├── server.ts           # NEW: createHostedApp only: routes, auth, limits, deadline and disconnect abort (no main, no payer-key reference)
    ├── config.ts           # NEW: reads and validates l1-hosted env: provider, model allow-list, auth, secrets
    ├── agent.ts            # NEW: Mastra Agent + the two createTool tools → runGoal(goal, sessionId, signal): Run
    ├── model.ts            # NEW: createAnthropic for anthropic | foundry; per-request Entra token in fetch
    ├── requester-auth.ts   # NEW: jose verification middleware; deletes Authorization afterwards
    ├── session-ref.ts      # NEW: issue and verify sr1 references (HMAC, timingSafeEqual)
    ├── run-limits.ts       # NEW: per-requester concurrency (2) and hourly starts (20)
    └── run-log.ts          # NEW: whitelisted JSON step and run lines
src/main.ts                 # MOD: REFUSAL from refusal.ts; passes SELLER_ALIAS_URL; --check-baseline for the scripted mode
src/hosted-main.ts          # NEW: hosted composition root (outside the layer, A5): loadEnv → INV-3 refusal → config → ports, model → listen
src/shared/config.ts        # MOD: EnvRole gains "l1-hosted"
src/layer2-control/
├── ledger-lock.ts          # NEW: acquire / standby / stale takeover / heartbeat / release (L2-6)
└── service.ts              # MOD: main() takes the lock before loading the ledger; SIGTERM/SIGINT release it
scripts/
├── dev-issuer-lib.ts       # NEW: dev JWKS and token signing (jose), shared by dev-token.ts and the tests
├── dev-token.ts            # NEW: local dev issuer and tokens (NETWORK=local only)
├── secret-scan-lib.ts      # NEW: credential-shape patterns for log scans (research R13)
├── scan-logs.ts            # NEW: npm run scan-logs, reads lines on stdin, exit 1 on any match
├── ledger-verify.ts        # NEW: operator command for GET /v1/ledger/verify (exit 0 only when ok)
└── payer-balance.ts        # NEW: read-only Base Sepolia USDC balanceOf(address) for the deploy preflight
infra/
├── main.bicep              # NEW: environments, network, registry, logs, storage, vaults, identities, Foundry, apps, jobs
├── modules/*.bicep         # NEW: one module per concern
├── params/dev.bicepparam   # NEW: no secret values; vault secrets are seeded out of band
├── proxy/nginx-l2.conf, nginx-l3.conf   # NEW: loopback proxy sidecars with the 401→200 /healthz
└── entra-app.sh            # NEW: az CLI script for the API app registration and the Agent.Run role
Dockerfile                  # NEW: the seller's image (research R14, revised 2026-10-25)
docker/l1-agent.Dockerfile, l2-control.Dockerfile, l3-verifier.Dockerfile   # NEW: one image per layer: build stage (tsc,
                            #   scripts/image-closure.ts) → node:22-bookworm-slim runtime, non-root, only that layer's code
.dockerignore               # NEW
scripts/image-closure.ts    # NEW: each image's files and packages from the import graph (T-IMG-01)
tsconfig.build.json         # NEW: emits dist/ for src/ and the operator scripts
.github/workflows/deploy-azure.yml   # NEW: OIDC deploy and regression gate
env/l1-hosted.env.example   # NEW: CFG-2 template
env/l1-agent.env.example    # MOD: optional SELLER_ALIAS_URL
test/
├── hosted-agent.test.ts    # NEW: T-AGT-02 tool set, model requests, allow-list
├── hosted-access.test.ts   # NEW: T-AGT-03 tokens, roles, limits, no forwarding
├── hosted-sessions.test.ts # NEW: T-AGT-04 session references
├── hosted-run.test.ts      # NEW: T-AGT-05 deadline, step limit, disconnect, health, response shape, log redaction
├── deploy-workflow.test.ts # NEW: T-E2E-AZ static checks on .github/workflows/deploy-azure.yml (gate order, rollback)
├── ledger-lock.test.ts     # NEW: T-LED-05
├── infra.test.ts           # NEW: T-IAC-01 (skipped without BICEP_PATH)
├── agent.test.ts           # MOD: T-AGT-KEY covers the hosted entry point
├── e2e.local.test.ts       # MOD: T-E2E-09 hosted agent on the harness (escalate → approve → continue)
├── architecture.test.ts    # MOD: l1-hosted template (7 templates); SEC rows 1..16; l1-agent optional SELLER_ALIAS_URL
├── helpers/hosted.ts       # NEW: in-process hosted app with a mock model, the dev issuer and fake or harness ports
└── fixtures/lock-holder.ts # NEW: child process that holds the ledger lock until SIGTERM (T-LED-05)
package.json                # MOD: dependencies; scripts agent:hosted, dev-token, ledger-verify, payer-balance, scan-logs, build; engines >=22.13
```

**Structure decision**: keep the single-repository, three-layer layout.
- The hosted agent's parts live in `src/layer1-intent/hosted/`. Its entry point, `src/hosted-main.ts`,
  is a composition root beside `src/main.ts`, outside the layer, because rule A5 bans the payer key's
  name in L1 code (research R9).
- The only change to L2 is the lock in `main()`.
- Infrastructure lives in `infra/` and the workflow in `.github/`, outside `src/`, so the
  architecture rules don't apply to them. T-IAC-01 guards them instead.

## Design

### Hosted request path (`server.ts`; entry point `src/hosted-main.ts`)

`requester-auth` (401/403) → `run-limits` (429) → JSON body ≤ 16 KB, validated (400/413) →
session (new, or verified `sessionRef`: 400/404) → `AbortController` (200 s timer and
`req.on('close')`) → `runGoal()` → 200 with the Run ([hosted-agent-api](contracts/hosted-agent-api.md)).
The limiter slot is released in `finally`.

### Agent (`agent.ts`)

- **Built per run**, because tools close over the run's session:
  - `fetch_resource` calls `orchestrator.fetchPaid(url, purpose)` and returns
    `toToolResult(r, decimals)`. `decimals` comes from one `gate.budget` read, as in L1-3.
  - `check_budget` calls `gate.budget(sessionId)`.
  - The orchestrator is `new PaidResourceOrchestrator({ gate, settlement, sessionId })`, as in
    `main.ts`.
- **Agent options**: `new Agent({ id: 'x402-buyer', name: 'x402 buyer', instructions:
  systemPrompt(SELLER_URL), model, tools: { fetch_resource, check_budget }, errorProcessorDefaults:
  false })`. No memory, workspace, agents, workflows or processors (R3).
- **The call**: `agent.generate(goal, { maxSteps: 10, modelSettings: { maxOutputTokens: 2048,
  maxRetries: 2 }, abortSignal })`.
- **Results**: steps and tool results are mapped from `result.steps[*].toolResults` into
  `RunStep`. The status comes from `finishReason` (R4).

### Model (`model.ts`)

[model-access](contracts/model-access.md). `foundry` uses `createAnthropic({ baseURL:
FOUNDRY_BASE_URL, authToken: 'entra', fetch })`. The `fetch` sets the bearer token from
`ManagedIdentityCredential(AZURE_CLIENT_ID).getToken('https://ai.azure.com/.default')`, which
`@azure/identity` caches. It also removes `anthropic-beta` if the first deployment shows Foundry
rejects it (research R2; quickstart §4).

### L1-4 alias and baseline check (`scripted.ts`, `main.ts`)

- `scriptedPlan(sellerUrl, aliasUrl?)`: when `aliasUrl` is set (`SELLER_ALIAS_URL`), step 6 is
  `aliasUrl + /api/weather?city=Lima`. Otherwise it is today's `localhost` rewrite. With no alias
  set, the local baseline is unchanged.
- `checkBaseline(results)` compares the outcomes with `FREE, PAID, PAID, ESCALATED, DENIED,
  DENIED` and requires both PAID settled `CONFIRMED`. `npm run agent:scripted -- --check-baseline`
  prints `baseline: ok` or `baseline: mismatch …` and exits 2 on a mismatch. The cloud regression
  job gates on it (research R17).

### L2 lock (`ledger-lock.ts`, `service.ts`)

[ledger-lock](contracts/ledger-lock.md). `main()` becomes: `loadEnv` → `await acquireLedgerLock(path)` →
`new AuditLedger(path)` → … → listen. It adds `process.on('SIGTERM' | 'SIGINT')`: close the
server, release the lock, exit 0. `createControlService` is untouched.

### Infrastructure and pipeline

[cloud-topology](contracts/cloud-topology.md) and [deploy-pipeline](contracts/deploy-pipeline.md).

## Delivery slices (each keeps `npm run check` green)

| Slice | Stories | Content | Gate |
|---|---|---|---|
| A. Hosted agent, locally | US1 (local), US2, US3, US5, US7 (logs) | `hosted/*`, `refusal.ts`, `dev-token`, env template, dependencies | T-AGT-02..05, T-AGT-KEY, T-E2E-09, T-ARCH-ENV |
| B. One L2 writer | US4 (FR-020) | `ledger-lock.ts`, `main()` change | T-LED-05 with its must-fail case; `demo:local` unchanged |
| C. Build and cloud helpers | US6 | `tsconfig.build.json`, Dockerfile, `ledger-verify`, `payer-balance`, the L1-4 alias | image builds and runs `dist/`; baseline unchanged without the alias |
| D. Infrastructure | US4, US2 (identities) | `infra/**`, nginx configs, T-IAC-01 | T-IAC-01 with its 3 mutants |
| E. Pipeline and first deployment | US6, US1 (cloud), US7 | the workflow, quickstart §4–5 | T-E2E-AZ green; quickstart §4 checks recorded |

## Requirement traceability

| Requirement | Design element | Test |
|---|---|---|
| FR-001, FR-002 (run a goal, same behavior as L1-3) | `agent.ts`, `toToolResult`, `systemPrompt` | T-AGT-02; T-E2E-09; T-E2E-AZ smoke |
| FR-003 (exactly two tools) | R3: no memory, workspace or processors; allow-list | T-AGT-02 (mock and HTTP), must-fail with an injected extra tool |
| FR-004 (only run + health) | own Express routes; no Mastra server | T-AGT-03 (unknown path → 404 after auth) |
| FR-005 (goal limits) | body validation | T-AGT-03 |
| FR-006 (provider by configuration) | `model.ts` | T-AGT-02 (both providers' requests) |
| FR-007 (payer key refusal) | `src/hosted-main.ts`: `loadEnv` then the refusal (outside the layer, A5) | T-AGT-KEY (hosted: key in the process env and in `ENV_FILE`) |
| FR-008 (no operator access) | no operator adapter or token in L1 | SEC-8 architecture check over `src/layer1-intent/**` |
| FR-009 (own credentials only, requester token not forwarded) | port adapters; middleware deletes `Authorization` | T-AGT-03 (fake L2 records no requester header) |
| FR-010, FR-011 (identity separation, key only in L2) | per-unit identity and vault; lifecycle `None` | T-IAC-01 (1, 2, 5, 6); quickstart §4 token check; demo secret scan |
| FR-012–FR-014 (Entra auth, role, limits) | `requester-auth.ts`, `run-limits.ts` | T-AGT-03 |
| FR-015, FR-016 (sessions bound to requesters) | `session-ref.ts` | T-AGT-04; T-E2E-09 |
| FR-017 (budgets unchanged) | L2 unchanged | T-E2E-09; T-E2E-01 |
| FR-018, FR-019, FR-022 (private L2/L3, loopback, seller apart) | internal ingress, sidecar, counterparty environment | T-IAC-01 (3, 7); quickstart §4 reachability check |
| FR-020 (one L2 instance, ledger survives) | L2-6 lock, NFS share, `maxReplicas: 1` | T-LED-05; T-IAC-01 (4); T-E2E-AZ step 7 |
| FR-021 (operator private path) | `job-operator`, RBAC on start | quickstart §5; T-IAC-01 (role table) |
| FR-023, FR-024 (reproducible deploy, regression gate) | Bicep, the workflow, `job-regression`, rollback | T-E2E-AZ (static workflow checks in `test/deploy-workflow.test.ts`, plus the live run) |
| FR-025, FR-026 (traceability, no secrets in logs) | `run-log.ts` whitelist; Log Analytics scan | T-AGT-05 (captured logs pass the secret scan); T-E2E-AZ step 9 |
| FR-027 (health) | `/healthz`, `/readyz` | T-AGT-05 |
| FR-028, NFR-007 (local parity) | new root only; L1-4 alias optional | `npm run check` |
| NFR-001 (Mastra on Azure) | R1, R10 | — |
| NFR-002, NFR-003 (invariants, must-fail proofs) | see Proofs | architecture test; the tests listed |
| NFR-004 (performance) | 200 s deadline; one replica | T-AGT-03 refusal latency (< 1 s); T-E2E-AZ smoke duration recorded per deployment, failing above 120 s |
| NFR-005, NFR-006 (availability, cost) | single region; agent scales 0–1; L2/L3 at 1 | T-IAC-01 (replica bounds) |
| NFR-008 (testnet only) | `NETWORK` profiles unchanged | existing config tests |

## Proofs (Constitution VIII)

- **Tool set**: an agent built with one extra tool (the test-only `extraTools` builder option,
  standing in for any tool a framework might add) shows a third tool on the model call, and the
  T-AGT-02 check reports it. An unrecognized model ID is
  refused at startup, because that is what makes the provider add `json`.
- **Access**: with the middleware bypassed (test switch), an unauthenticated request reaches the
  mock model. With it, 0 model calls happen.
- **Session binding**: with MAC verification disabled (test switch), requester B's run uses
  requester A's session. With it, 404.
- **Ledger lock**: two `AuditLedger` writers on one file without the lock fork the chain, and
  the reload throws `integrity`. With the lock, the second never opens the file, because it is
  still waiting.
- **Identity and secret matrix**: three mutated templates each fail T-IAC-01.
- **Log redaction**: a test injects a bearer token into a tool's error text. The step log line
  carries only the outcome, and the secret scan of all captured lines finds nothing.

## SPEC and governance changes (same change, SPEC v1.5)

- **§1.3**: the Azure cloud profile is in scope on testnet. Multi-tenancy and mTLS stay out.
- **§3.1**: a new process row (L1 hosted agent service, `src/hosted-main.ts`, 4024,
  `agent:hosted`, `env/l1-hosted.env`) and an "Azure profile" subsection that summarizes
  [cloud-topology](contracts/cloud-topology.md).
- **§3.3**: rows for the requester Entra token, `SESSION_REF_SECRET` and `id-l1`'s Foundry access.
- **§4**: INV-3 names both L1 entry points (`src/main.ts`, `src/hosted-main.ts`). Both load
  env, then refuse.
- **§5**: rows and pins for Mastra, `@ai-sdk/anthropic`, `zod`, `jose`, `@azure/identity`, and the
  dev pins. The Node floor becomes 22.13.
- **§6**: the layout additions listed above.
- **§8.1**: L1-4 gets the optional alias and `--check-baseline`. New **L1-6 "Hosted agent service"**
  ([hosted-agent-api](contracts/hosted-agent-api.md),
  [access-and-sessions](contracts/access-and-sessions.md),
  [model-access](contracts/model-access.md)).
- **§8.2**: new **L2-6 "One ledger writer"** ([ledger-lock](contracts/ledger-lock.md)), and the
  `main()` order in L2-5.
- **§9 CFG-2**: the `l1-hosted.env` row, and the `l1-agent.env` optional `SELLER_ALIAS_URL`.
- **§11**: new threats:
  - SEC-14, abuse of the public agent endpoint (Entra role, limits, budgets; T-AGT-03);
  - SEC-15, use of another requester's session (HMAC reference; T-AGT-04);
  - SEC-16, secrets or payment headers in logs or telemetry (whitelisted logs, no telemetry,
    scan; T-AGT-05, T-E2E-AZ).

  Residual risks added in v1.5:
  - the payer key sits in Azure Key Vault, so its RBAC holders are trusted;
  - anyone who can start a job holds that job's credentials;
  - L2 is reachable from the whole private environment;
  - the single L2 instance has a lock-handover window;
  - the run limits are per replica.
- **§12**: T-AGT-02..05, T-AGT-KEY (amended), T-LED-05, T-E2E-09, T-IAC-01 and T-E2E-AZ.
- **§13**: `agent:hosted`, `dev-token`, `ledger-verify`, `payer-balance`, and the deploy workflow.
- **§15**: EXT-7 notes the proxy sidecar as its future seat. EXT-8 notes the run logs as a
  partial step.
- **Constitution 1.1.1 → 1.2.0 (MINOR)**:
  - Principle V adds the requester credential and the cloud-reachability rule (loopback bind plus
    private-environment sidecar);
  - Technology & Scope adds Mastra, Azure and Foundry and the testnet cloud profile;
  - residual risks follow §11;
  - a Sync Impact Report is recorded.
- **Feature specs and docs**:
  - `specs/007` threat matrix: SEC-14..16, and `architecture.test.ts` expects SEC rows 1..16;
  - `specs/README.md`: the traceability rows for 011;
  - `specs/001`: an "Extended by 011" note on L1-5;
  - `README.md`: a "Hosted agent" section;
  - `CLAUDE.md`: the new commands, and a hard-rule note that the hosted root obeys INV-3.

## Risks

| Risk | Mitigation |
|---|---|
| Foundry rejects the provider's `anthropic-beta` header | Checked by the first hosted smoke call (quickstart §4). The Foundry `fetch` can drop the header. Switching to `MODEL_PROVIDER=anthropic` is a configuration change. |
| A Mastra upgrade starts adding tools or calling out | Exact pin. T-AGT-02 runs on every test pass. The upgrade checklist re-runs the network-spy probe from research R13. |
| Lock handover makes L2 unavailable for seconds (up to 30 s after a crash) | L1 reports ERROR and nothing is paid. Deployments run when idle. The pipeline waits on `ledger-verify` before the regression. |
| NFS share latency slows ledger appends | Appends are small and serialized. The regression measures it. A durable ledger (EXT-6) is the long-term fix. |
| Job-start RBAC leaks credentials | Start rights only for the deploy identity (`job-regression`) and the operators' group (`job-operator`). Listed as a residual risk. |
| Identity lifecycle `None` doesn't behave as documented | Quickstart §4 checks it on the first deployment. If it fails, L2/L3 move the sidecar out (TCP probe only, ingress straight to a `0.0.0.0` bind) after a SPEC amendment, never by keeping the key reachable. |
| Testnet spend per deployment | 0.012 USDC per deployment, with a balance preflight (deploy-pipeline step 5b). |

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| 1. L2/L3 are reachable from the private environment through a sidecar, not only from the same host (Principle V's intent) | Clarification Q1: A puts L1 in a different runtime unit from L2/L3 | Running L1 inside L2's app keeps loopback, but every container would share L2's identity, L1's scaling would couple to the single writer, and the payer key would be reachable from the agent's container |
| 2. A new mechanism in the key-holding process (the L2-6 ledger lock) | Container Apps overlaps revisions on every update, so two L2 replicas briefly coexist (R12) | Deploy ordering alone can't stop a restart or a mis-set replica count from creating two writers that fork the chain |
| 3. The Node floor goes from 22 to 22.13 | `@mastra/core` 1.75.0 requires it | No Mastra 1.x supports older Node, and the user mandated Mastra |
| 4. A second seller app and an optional L1-4 alias | Step 6 relies on a host alias that `localhost` can't provide in the cloud (R17) | Changing the cloud baseline's step 6 to `ERROR` would change the baseline, and a custom domain needs DNS and certificates |
| 5. One agent replica | Exact per-requester limits without shared storage (R8) | A shared limiter (Redis or Table Storage) adds a service and a credential for no requirement |
