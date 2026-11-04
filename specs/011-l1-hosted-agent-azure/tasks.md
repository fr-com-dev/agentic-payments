---

description: "Task list for 011 cloud-hosted purchasing agent (L1) on Mastra and Azure"
---

# Tasks: Cloud-Hosted Purchasing Agent (L1) on Mastra and Azure

**Input**: Design documents from `specs/011-l1-hosted-agent-azure/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md)
- [data-model.md](data-model.md)
- [contracts/](contracts/)
- [quickstart.md](quickstart.md)

**Tests**: included and required. NFR-003 and Constitution Principle VIII require a test for every
new control, plus a must-fail proof. Test titles carry their IDs (T-AGT-02..05, T-AGT-KEY,
T-LED-05, T-E2E-09, T-IAC-01, T-E2E-AZ, or `011 USn …`), because T-ARCH-TRACE checks them. Write
each story's tests first and confirm they fail before implementing.

**Organization**: tasks are grouped by user story (US1–US7 from spec.md). Delivery slices A–E in
plan.md map onto these phases: A → Phases 2–5 and 7, B and C → Phase 6, D → Phase 6, E → Phases 8–9.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel: a different file, and no dependency on an incomplete task.
- **[Story]**: the user story the task belongs to (US1–US7).

## Path conventions

- Single repository. Hosted-agent code lives in `src/layer1-intent/hosted/` and imports only
  `../../shared/*` and `../*` (L1). Rule A1 applies (research R9).
  Its entry point `src/hosted-main.ts` is a composition root beside `src/main.ts`, outside the layer,
  because rule A5 bans the payer key's name in L1 code. The shared refusal text is `src/refusal.ts`
  for the same reason.
- The only L2 change is the lock: `src/layer2-control/ledger-lock.ts` and `main()` in
  `src/layer2-control/service.ts`.
- Infrastructure lives in `infra/`, the workflow in `.github/workflows/`, and tooling in `scripts/`.
- Constants quoted verbatim from the contracts:
  - goal 1–4,000 characters; body ≤ 16 KB;
  - `sessionId` matches `^sess_[0-9a-f]{16}$`; reference `sr1.<sessionId>.<mac>` with a
    43-character base64url MAC;
  - 2 concurrent runs and 20 starts per sliding 3,600 s per requester;
  - deadline 200 s, 10 steps, 2048 output tokens;
  - lock heartbeat 5 s, stale after 30 s, poll 1 s.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: dependencies, scripts, the env role and the env template, so later phases compile.

- [X] T001 Install the pinned dependencies (research.md "Dependency pins") and update package.json and package-lock.json:
  - runtime, exact: `npm install --save-exact @mastra/core@1.75.0 @ai-sdk/anthropic@3.0.128`;
  - runtime: `npm install zod@4.6.5 jose@6.2.12 @azure/identity@4.13.3`;
  - dev: `npm install -D ai@6.0.302 @ai-sdk/provider@3.0.18 @azure/bicep-rpc-client@0.4.1`.

  Use `npm install`, never `npm ci` (CLAUDE.md). Then `npm run typecheck` must pass with the repo's TypeScript 7. The research probe used TS 5.9, so if Mastra's types fail under TS 7, record the error and stop. Never loosen `strict`.
- [X] T002 [P] Edit package.json:
  - set `"engines": { "node": ">=22.13" }`;
  - add the scripts:
    - `"agent:hosted": "tsx src/hosted-main.ts"`
    - `"dev-token": "tsx scripts/dev-token.ts"`
    - `"ledger-verify": "tsx scripts/ledger-verify.ts"`
    - `"payer-balance": "tsx scripts/payer-balance.ts"`
    - `"scan-logs": "tsx scripts/scan-logs.ts"`
    - `"build": "tsc -p tsconfig.build.json"`
- [X] T003 [P] Add `"l1-hosted"` to `EnvRole` in src/shared/config.ts, so `loadEnv("l1-hosted")` defaults to `env/l1-hosted.env`. Change nothing else.
- [X] T004 [P] Create env/l1-hosted.env.example from the contracts/model-access.md "Configuration" table. Its contents:
  - `NETWORK=local`;
  - `SELLER_URL=http://127.0.0.1:4021`, `CONTROL_URL=http://127.0.0.1:4020`, `SETTLEMENT_URL=http://127.0.0.1:4023`;
  - `CONTROL_TOKEN=dev-control-token`, `VERIFIER_TOKEN=dev-verifier-token` (`# local only`);
  - `MODEL_PROVIDER=anthropic`, and `ANTHROPIC_API_KEY=` with `# set me`;
  - commented optional lines: `# ANTHROPIC_MODEL=`, `# FOUNDRY_BASE_URL=`, `# AZURE_CLIENT_ID=`;
  - `AUTH_TENANT_ID=dev`, `AUTH_AUDIENCE=api://x402-l1-agent`, `AUTH_JWKS_FILE=.local/dev-issuer/jwks.json` (`# local only`);
  - `SESSION_REF_SECRET=` with `# set me: 32+ random bytes, hex or base64`;
  - `# AGENT_PORT=`, `# AGENT_BIND_HOST=`.

  Then in test/architecture.test.ts add to `TEMPLATES`:

  ```ts
  "l1-hosted": {
    required: ["NETWORK", "SELLER_URL", "CONTROL_URL", "SETTLEMENT_URL", "CONTROL_TOKEN", "VERIFIER_TOKEN", "MODEL_PROVIDER", "AUTH_TENANT_ID", "AUTH_AUDIENCE", "SESSION_REF_SECRET"],
    optional: ["ANTHROPIC_MODEL", "ANTHROPIC_API_KEY", "FOUNDRY_BASE_URL", "AZURE_CLIENT_ID", "AUTH_JWKS_FILE", "AGENT_PORT", "AGENT_BIND_HOST"],
  }
  ```

  Change the T-ARCH-ENV title from "6 of 6" to "7 of 7". Extend `checkTemplate` so `SESSION_REF_SECRET` and `ANTHROPIC_API_KEY` must be empty in templates; the existing `_SECRET$` rule already covers the first.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the hosted service's skeleton. INV-3 comes first, then config, the dev issuer, auth and health. Every story depends on it.

**⚠️ CRITICAL**: no user-story work begins until this phase is complete.

- [X] T005 Draft the SPEC.md v1.5 sections before any code. Constitution governance says "amend the spec first in the same change". Add:
  - a "Changes in 1.5" table marked *draft*;
  - §3.1: the process row (L1 hosted agent service, `src/hosted-main.ts`, 4024, `agent:hosted`, `env/l1-hosted.env`) and the "Azure profile" subsection, summarizing contracts/cloud-topology.md;
  - §3.3 rows (contracts/model-access.md);
  - §4: INV-3 names `src/main.ts` and `src/hosted-main.ts`, both of which load env and then refuse;
  - §8.1: L1-4 alias and `--check-baseline`, and new L1-6 (contracts/hosted-agent-api.md and access-and-sessions.md);
  - §8.2: new L2-6 (contracts/ledger-lock.md) and the `main()` order;
  - §9 CFG-2: the `l1-hosted.env` row and the `l1-agent.env` `SELLER_ALIAS_URL?`;
  - §11: SEC-14, SEC-15, SEC-16 and the v1.5 residual risks.

  Test IDs, layout and commands are completed in the Polish phase. Leave the specs/007 threat matrix untouched until its tests exist (T-ARCH-TRACE).
- [X] T006 [P] Amend .specify/memory/constitution.md from 1.1.1 to 1.2.0 (MINOR), with a Sync Impact Report:
  - Principle V adds the requester credential and the cloud-reachability bullet (loopback bind plus a private-environment sidecar);
  - Technology & Scope adds Mastra, `@ai-sdk/anthropic`, `jose`, `@azure/identity`, Azure Container Apps and Foundry, and the testnet cloud profile;
  - the residual risks follow SPEC §11 v1.5 (T005).
- [X] T007 Move the `REFUSAL` constant from src/main.ts into a new src/layer1-intent/refusal.ts, with a header comment citing INV-3 and SEC-2. In src/main.ts, import it and re-export it (`export { REFUSAL } from "./layer1-intent/refusal.js"`), so existing imports in test/agent.test.ts keep working. Change no other behavior of main.ts.
- [X] T008 Create src/layer1-intent/hosted/config.ts, exporting `DEV_ISSUER = "urn:x402:dev-issuer"`, `DEV_TENANT = "dev"` and `loadHostedConfig(env = process.env): HostedConfig`. The loader throws `ConfigError` (from src/shared/config.ts) for each rule in contracts/model-access.md "Configuration" and "Model allow-list":
  - `MODEL_PROVIDER` ∈ {`foundry`, `anthropic`};
  - `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) ∈ {`claude-sonnet-5-5`, `claude-sonnet-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-haiku-5-5`};
  - with `anthropic`, `ANTHROPIC_API_KEY` is required;
  - with `foundry`, `ANTHROPIC_API_KEY` is forbidden, `FOUNDRY_BASE_URL` is required and must end with `/anthropic/v1`, and `AZURE_CLIENT_ID` is required;
  - `AUTH_TENANT_ID` and `AUTH_AUDIENCE` are required;
  - `AUTH_JWKS_FILE` is allowed only when `NETWORK=local`;
  - `SESSION_REF_SECRET` is required and decodes (hex or base64) to ≥ 32 bytes;
  - `AGENT_PORT` defaults to 4024 (validated like `portFrom`); `AGENT_BIND_HOST` defaults to `127.0.0.1`;
  - tokens come from `tokenFor("agent-control")` and `tokenFor("agent-verifier")`;
  - URLs come from `serviceUrls()`.

  The config's `issuer` is `https://login.microsoftonline.com/${AUTH_TENANT_ID}/v2.0`, or `DEV_ISSUER` when `AUTH_JWKS_FILE` is set. Error messages name the variable and never echo its value.
- [X] T009 [P] Create scripts/dev-issuer-lib.ts (jose). It imports `DEV_ISSUER` and `DEV_TENANT` from src/layer1-intent/hosted/config.ts (scripts may import src; never the reverse) and exports:
  - `loadOrCreateDevIssuer(dir = ".local/dev-issuer")`: an ES256 key pair stored as `private.jwk.json` (mode 0600) and `jwks.json` (public only). It refuses unless `NETWORK` is unset or `local`;
  - `signDevToken({ key, subject, roles = ["Agent.Run"], idtyp, audience = "api://x402-l1-agent", tenant = DEV_TENANT, issuer = DEV_ISSUER, expiresIn = "1h", notBefore })`. It sets `oid = subject`, `tid = tenant`, and `idtyp` only when given.
- [X] T010 Create scripts/dev-token.ts (after T009), `npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service]`. It calls `loadOrCreateDevIssuer()` and prints one token to stdout:
  - `--no-role` gives `roles: []`;
  - `--expired` sets `exp` 120 s in the past;
  - `--service` sets `idtyp: "app"`.

  It exits 2 when `NETWORK` is set to anything but `local`.
- [X] T011 [P] Create src/layer1-intent/hosted/requester-auth.ts (after T008):
  `requesterAuth({ tenantId, audience, issuer, keys: JWTVerifyGetKey, clockToleranceSec = 60 }): RequestHandler`.
  - It implements every row of the contracts/access-and-sessions.md "Token verification" table.
  - On success it sets `res.locals.requester = { tenantId, objectId, kind: idtyp === "app" ? "service" : "user", key: \`${tid}:${oid}\` }`, then runs `delete req.headers.authorization`.
  - Failures answer 401 `{ "error": "unauthorized" }` or 403 `{ "error": "forbidden" }` and never say which check failed.
  - It never logs the token.

  Also export `keysFor(config)`: `createRemoteJWKSet(new URL(\`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys\`))`, or `createLocalJWKSet(JSON.parse(readFileSync(AUTH_JWKS_FILE, "utf8")))` when `AUTH_JWKS_FILE` is set.
- [X] T012 Create src/layer1-intent/hosted/server.ts (after T011), holding **only** `createHostedApp`. No `main()`, and no mention of `PAYER_PRIVATE_KEY`, because rule A5 bans it anywhere under `src/layer1-intent/` (research R9):
  - `createHostedApp(deps: HostedDeps): { app: Express; markReady(): void }`, where `deps` carries config, keys, issuer, and later the model and ports, plus the test hooks `bypassAuth?` and `deadlineMs?`, both documented "test only, never set by the entry point".
  - `GET /healthz` → 200 `{ status: "ok" }`.
  - `GET /readyz` → 503 `{ status: "starting" }` until `markReady()`, then 200 `{ status: "ready" }`.
  - Every other request goes through `requesterAuth` (unless `bypassAuth`), then a final 404 `{ error: "not found" }`.

  Then create the entry point src/hosted-main.ts, a composition root beside src/main.ts:
  1. `loadEnv("l1-hosted")` first. It reads a file and makes no network call.
  2. **Immediately** after: `if (process.env.PAYER_PRIVATE_KEY !== undefined) { console.error(REFUSAL); process.exit(1); }`. This is the same order as src/main.ts, so a key placed only in `env/l1-hosted.env` is refused too (INV-3).
  3. `loadHostedConfig()`, `keysFor()`, `createHostedApp`, then listen on `AGENT_BIND_HOST:AGENT_PORT`.
  4. Log `l1-hosted listening on http://<host>:<port> (provider <p>, model <m>)`, call `markReady()`, and on SIGTERM/SIGINT close and exit 0.

  The entry guard is the same as src/main.ts.
- [X] T013 Create test/helpers/hosted.ts (after T009 and T012): `startHostedApp(opts)`. It:
  - creates a temp dev issuer through `loadOrCreateDevIssuer(tmpDir)`;
  - builds `createHostedApp` with that issuer's local JWKS and a `HostedConfig` from opts;
  - injects a model (default: a `MockLanguageModelV3` that returns `text("done")`);
  - injects the gate and settlement ports (default: fakes that record calls; or a harness's URLs and tokens when `opts.harness` is given);
  - listens on port 0.

  It returns `{ base, token(subject, { roles?, idtyp?, expired?, audience?, tenant?, issuer? }), model, gateCalls, settlementCalls, close }`.
- [X] T014 [P] Create test/hosted-access.test.ts with `describe("T-AGT-03 tokens (foundational)")`:
  - no `Authorization` → 401;
  - a garbage token → 401;
  - a token signed by another key → 401;
  - `/healthz` without a token → 200;
  - an unknown path with a valid token → 404;
  - the same unknown path without a token → 401.
- [X] T015 [P] In test/agent.test.ts, add `describe("T-AGT-KEY hosted (INV-3)")` with two cases. Mirror the existing T-AGT-KEY case: spawn `node_modules/.bin/tsx src/hosted-main.ts` with `NETWORK=local` and URLs pointing at a connection-counting server:
  1. `PAYER_PRIVATE_KEY=0x1` in the process env and `ENV_FILE=/dev/null`;
  2. the key **only inside** a temp `ENV_FILE` (a line `PAYER_PRIVATE_KEY=0x1`), not in the process env.

  Both exit 1, print `REFUSAL` on stderr and make 0 connections. The second case fails if the check runs before `loadEnv`.
- [X] T016 [P] Create test/hosted-agent.test.ts with `describe("T-AGT-02 hosted configuration")`, one case per `loadHostedConfig` rule from T008. One case asserts the thrown message does not contain a planted `ANTHROPIC_API_KEY` or `SESSION_REF_SECRET` value.

**Checkpoint**: T014–T016 pass (confirm each failed before T008–T012 existed). `npm test` passes, and `npm run demo:local` is unchanged.

---

## Phase 3: User Story 1 - A requester gets a purchase done by the cloud-hosted agent (Priority: P1) 🎯 MVP

**Goal**: an authenticated requester posts a goal and gets back the receipts, one outcome per resource, a session reference and a run ID. The run uses the same two tools, prompt and limits as L1-3.

**Independent Test**: on the in-process harness (T-E2E-09), a scripted mock model buys weather and market brief: two PAID with CONFIRMED settlements, session budget `spentOrReservedAtomic = 6000`, and the premium report comes back as ESCALATED with an `authorizationId`. Locally against Base Sepolia, quickstart §3 gives the same with a real model.

### Tests for User Story 1 (write first; they must fail)

- [X] T017 [P] [US1] In test/hosted-agent.test.ts, add `describe("T-AGT-02 tool set")`:
  - Through `startHostedApp` with a `MockLanguageModelV3` scripted `[call fetch_resource catalog, call check_budget, text]`, every entry of `model.doGenerateCalls` has `tools.map(t => t.name)` equal to `["fetch_resource", "check_budget"]`, and `maxOutputTokens === 2048`.
  - Each tool's `description` equals `AGENT_TOOLS[i].description` from src/layer1-intent/agent.ts, and its `inputSchema` `type`, `properties` and `required` equal `AGENT_TOOLS[i].input_schema`. Ignore `$schema` and `additionalProperties: false`, which research R3 documents as stricter.
  - A model that returns a tool call every time stops after exactly 10 model calls.
  - HTTP level: build the model with `createModel(config, { fetch: fake })` for `MODEL_PROVIDER=anthropic` and for `foundry` with a fake credential (`{ getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 3_600_000 }) }`), model `claude-sonnet-5-5`, and run one step. The captured request body's `tools` has exactly two entries with those names, and `max_tokens === 2048`.
    - The `anthropic` request has an `x-api-key` header.
    - The `foundry` request goes to `<FOUNDRY_BASE_URL>/messages` with `authorization: Bearer t` and no `x-api-key`.
- [X] T018 [P] [US1] Create test/hosted-run.test.ts with `describe("T-AGT-05 run")`:
  - **Response shape**: a completed run returns the contracts/hosted-agent-api.md 200 shape. `sessionRef` matches `^sr1\.sess_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$`, `runId` starts `run_`, `status: "completed"`, and `stopReason: null`.
  - **Deadline**: with `deadlineMs: 300`, a mock model whose first call is `fetch_resource` (then text), and a fake gate whose `authorize` resolves after 1 s, the run returns `status: "stopped"` and `stopReason: "deadline"`. That fetch is listed with its completed result, and `model.doGenerateCalls.length === 1`: no model call after the abort.
  - **Step limit**: a model that always calls `check_budget` → `stopReason: "step_limit"` and 10 steps.
  - **Body**: missing goal, empty goal, a 4,001-character goal, or an unknown field → 400; a 17 KB body → 413.
  - **Readiness**: `/readyz` → 503 before `markReady()`, 200 after.
  - **Failure**: a model `doGenerate` that throws → `status: "failed"` with the previously finished steps listed.
- [X] T019 [P] [US1] In test/e2e.local.test.ts, add `describe("T-E2E-09 hosted agent")`, `it("default goal pays weather and market brief; the premium report escalates")`:
  - Use `startHarness()`, plus `startHostedApp({ harness })` with a mock model scripted to call `fetch_resource` for `<seller>/api/catalog`, `/api/weather?city=Lima`, `/api/market-brief` and `/api/premium-report`, then answer with text.
  - Expect step outcomes `[FREE, PAID, PAID, ESCALATED]`, both PAID settled `CONFIRMED`, the ESCALATED step with an `authorizationId` and no `AUTHORIZED` ledger entry for it, and `GET /v1/budget/<sessionId>` reporting `spentOrReservedAtomic: "6000"`.

### Implementation for User Story 1

- [X] T020 [US1] Create src/layer1-intent/hosted/model.ts: `createModel(config: HostedConfig, opts?: { fetch?: typeof fetch; credential?: TokenCredential }): LanguageModel`, per contracts/model-access.md "Provider construction":
  - `anthropic` → `createAnthropic({ apiKey, fetch })(model)`;
  - `foundry` → `createAnthropic({ baseURL: FOUNDRY_BASE_URL, authToken: "entra", fetch: withEntraToken(credential ?? new ManagedIdentityCredential({ clientId: AZURE_CLIENT_ID }), opts?.fetch ?? fetch) })(model)`.

  `withEntraToken` sets `Authorization: Bearer <getToken("https://ai.azure.com/.default").token>` on every request. It also has an exported flag `STRIP_ANTHROPIC_BETA = false` that, when true, deletes the `anthropic-beta` header (research R2; flipped only if quickstart §4 shows Foundry rejects it). Never set `temperature` or `top_k`.
- [X] T021 [US1] Create src/layer1-intent/hosted/agent.ts.
  - **Tools**: `createRunTools({ orchestrator, gate, sessionId })` returns `{ fetch_resource, check_budget }` built with `createTool`:
    - ids equal the keys;
    - descriptions are `AGENT_TOOLS[0].description` and `AGENT_TOOLS[1].description`;
    - input schemas are `z.object({ url: z.string(), purpose: z.string() })` and `z.object({})`;
    - `fetch_resource` executes `toToolResult(await orchestrator.fetchPaid(url, purpose), decimals)`, with `decimals` read once from `gate.budget(sessionId)` when the first payment appears, as in `runClaudeAgent`. It never forwards `context.abortSignal` to `fetchPaid`;
    - `check_budget` executes `gate.budget(sessionId)`.
  - **Agent**: `buildAgent({ model, sellerUrl, tools })` returns `new Agent({ id: "x402-buyer", name: "x402 buyer", instructions: systemPrompt(sellerUrl), model, tools, errorProcessorDefaults: false })`. No memory, workspace, agents, workflows or processors.
  - **Run**: `runGoal({ goal, sessionId, signal, model, gate, settlement, sellerUrl, extraTools? })`. It builds `new PaidResourceOrchestrator({ gate, settlement, sessionId })` and the tools, merging `extraTools` (test-only, documented), then calls `agent.generate(goal, { maxSteps: 10, modelSettings: { maxOutputTokens: 2048, maxRetries: 2 }, abortSignal: signal })`.
  - **Result mapping**: `result.steps[*].toolResults` map to `RunStep { index, tool, url?, purpose?, result }` (data-model.md). Status:
    - `finishReason "aborted"` → `stopped` with the reason the caller set;
    - `"tool-calls"` after 10 steps → `stopped`, `step_limit`;
    - otherwise `completed`;
    - a thrown error → `failed`, with the steps recorded so far through `onStepFinish`.
- [X] T022 [P] [US1] Create src/layer1-intent/hosted/session-ref.ts with the issuing half (verification is US5):
  - `newSessionId()` returns `sess_` + `randomBytes(8).toString("hex")`;
  - `issueSessionRef(secret: Buffer, requester: { tenantId, objectId }, sessionId)` returns `sr1.${sessionId}.${base64url(HMAC-SHA256(secret, \`sr1|${tid}|${oid}|${sessionId}\`))}`;
  - export `SESSION_REF_RE = /^sr1\.(sess_[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/`.
- [X] T023 [US1] In src/layer1-intent/hosted/server.ts, add `POST /v1/runs`, after auth. In order:
  1. `express.json({ limit: "16kb" })` (413 over the limit);
  2. validate: only the keys `goal` and `sessionRef`; `goal` is a string of 1–4,000 characters after trimming (else 400). If `sessionRef` is present, answer 400 `{ error: "session continuation not available" }` until US5;
  3. `newSessionId()`;
  4. an `AbortController` with a `setTimeout(deps.deadlineMs ?? 200_000)` that sets the reason `deadline`, plus `req.on("close")` that sets `client_disconnected` when the response hasn't been sent;
  5. `runGoal(...)` with the deps' gate, settlement, model and seller URL;
  6. answer 200 with the Run (contracts/hosted-agent-api.md) and `sessionRef: issueSessionRef(...)`. Clear the timer in `finally`.

  In src/hosted-main.ts, build the gate and settlement with `new HttpAuthorizationGate(urls.control, CONTROL_TOKEN)` and `new HttpSettlementVerifier(urls.settlement, VERIFIER_TOKEN)`, and the model with `createModel(config)`.
- [X] T024 [US1] Manual check (needs your `ANTHROPIC_API_KEY`): run quickstart.md §3 up to the first `curl`, against the local stack. Record the outcomes in tasks.md under "Implementation Notes".

**Checkpoint**: T017–T019 pass. US1 is a working MVP: an authenticated requester gets purchases done through the hosted agent locally. Until US5 lands, any `sessionRef` gets 400 `session continuation not available`, so don't release a build without US5.

---

## Phase 4: User Story 2 - The hosted agent has no more payment authority than the local agent (Priority: P1)

**Goal**: prove the hosted root adds no authority. Exactly two tools, no hidden tool through the model ID, no operator access, and no requester credential forwarded. The cloud-identity half (FR-010, FR-011) is delivered by T-IAC-01 in Phase 6 (T047).

**Independent Test**: T-AGT-02's must-fail cases fail without the controls. The no-forwarding test sees only `CONTROL_TOKEN`/`VERIFIER_TOKEN` at L2/L3. The architecture test finds no operator reference in `src/layer1-intent/**`.

### Tests for User Story 2

- [X] T025 [P] [US2] In test/hosted-agent.test.ts, add `describe("T-AGT-02 must-fail")`:
  - with `runGoal({ extraTools: { approve_payment: <any createTool> } })`, the same tool-name check from T017 reports three names;
  - `loadHostedConfig` with `ANTHROPIC_MODEL=my-deployment` throws;
  - an evidence case: `createAnthropic({ fetch: fake })("my-deployment")` on a tool-using request sends **three** tools (the provider's `json`), which is why the allow-list exists (research R2).
- [X] T026 [P] [US2] In test/hosted-access.test.ts, add `describe("T-AGT-03 no forwarding")`. Fake L2 and L3 HTTP servers record every request's `authorization` header. After a run with a scripted model calling `fetch_resource` (402 path) and `check_budget`, L2 saw only `Bearer <CONTROL_TOKEN>`, L3 saw only `Bearer <VERIFIER_TOKEN>`, and neither saw the requester's JWT (FR-009).
- [X] T027 [P] [US2] In test/architecture.test.ts, confirm that the existing "010 US5 L1 never references operator routes or the operator token" walk covers `src/layer1-intent/hosted/**`. Add `it("011 US2 the hosted root offers no operator path")`: no file under `src/layer1-intent/hosted/` mentions `OPERATOR_TOKEN`, `/v1/approvals`, `/v1/rejections`, `/v1/escalations` or `/v1/ledger/verify` (comments stripped, as for A8).

### Implementation for User Story 2

- [X] T028 [US2] If T025–T027 expose a gap, fix it in src/layer1-intent/hosted/{agent,config,requester-auth}.ts. No new runtime feature is expected: the controls come from T010, T011 and T021. Document `extraTools` and `bypassAuth` as test hooks in their JSDoc ("never set in main()"), the same way `dedupePendingEscalations` is documented.

**Checkpoint**: T025–T027 pass. Each must-fail case was observed failing with its control removed.

---

## Phase 5: User Story 3 - Only authorized requesters can run the agent (Priority: P1)

**Goal**: Entra ID tokens with `Agent.Run` for people and service identities, and per-requester limits. Refusals happen before any model or L2 call.

**Independent Test**: the full T-AGT-03 matrix. Every refusal leaves 0 model calls, 0 gate calls and an unchanged ledger. A person token and a service token with the role both succeed.

### Tests for User Story 3

- [X] T029 [P] [US3] In test/hosted-access.test.ts, add `describe("T-AGT-03 access matrix")`:
  - **401**: expired, `nbf` in the future (beyond 60 s), wrong `aud`, wrong `iss`, wrong `tid`, no `oid`.
  - **403**: no `Agent.Run`.
  - **200**: a user token, and a service token (`idtyp: "app"`) with the role.
  - After each refusal: `model.doGenerateCalls.length === 0`, and the fake gate recorded 0 calls.
  - **Latency**: each refusal answers in under 1,000 ms, measured in the test (NFR-004).
  - **Must fail**: with `bypassAuth: true`, an unauthenticated `POST /v1/runs` reaches the mock model.
- [X] T030 [P] [US3] In test/hosted-access.test.ts, add `describe("T-AGT-03 limits")`, using a fake clock injected through `deps.now`:
  - a 3rd concurrent run for one requester → 429 with `Retry-After: 5`;
  - another requester is unaffected;
  - after 20 starts within 3,600 s, the 21st → 429 with `Retry-After` = seconds until the oldest start ages out;
  - after it ages out, the next start succeeds;
  - a run that fails still releases its slot;
  - a 400 body refusal doesn't count as a start.

### Implementation for User Story 3

- [X] T031 [US3] Create src/layer1-intent/hosted/run-limits.ts: `createRunLimiter({ maxConcurrent = 2, maxStartsPerHour = 20, now = Date.now })` with:
  - `check(key): number | null`, the retry-after seconds, or null when allowed;
  - `start(key): () => void`, which records a start and returns a release function that is safe to call twice.

  State per data-model.md "RunLimiter state".
- [X] T032 [US3] Wire the limiter into src/layer1-intent/hosted/server.ts in the contract order: auth → `check` (429 with `Retry-After`) → body and session validation (400/404) → `start` → run → `release` in `finally`. Add the `now?` hook to `HostedDeps`.
- [X] T033 [P] [US3] Create infra/entra-app.sh (bash, `set -euo pipefail`, `az` CLI only). It:
  - creates or updates the app registration `x402-l1-agent` with identifier URI `api://x402-l1-agent`;
  - defines the app role `Agent.Run` (`allowedMemberTypes: ["User","Application"]`, value `Agent.Run`, a stable GUID);
  - creates the service principal with `appRoleAssignmentRequired=true`;
  - with `--deploy-sp <appId>`, assigns `Agent.Run` to the deploy service principal, so the post-deployment smoke check (deploy-pipeline step 8) can call the agent. That grants the pipeline spending through the agent, within the mandate;
  - prints `AUTH_TENANT_ID` and `AUTH_AUDIENCE`.

  It never creates secrets. Document it in quickstart.md §4 as prerequisite step 0.

**Checkpoint**: T029–T030 pass. `npm test` passes.

---

## Phase 6: User Story 4 - The control and settlement layers stay private (Priority: P1)

**Goal**: L2/L3 run privately in Azure behind loopback-forwarding sidecars, each unit with its own identity and vault. Exactly one L2 writes the ledger, on NFS. The operator path is a private job. This phase also delivers the cloud half of US2 (FR-010, FR-011) through T-IAC-01.

**Independent Test**:
- T-LED-05 passes, including its must-fail case.
- T-IAC-01 passes with `BICEP_PATH` set, and each of its three mutants fails.
- `docker build` produces an image that runs `dist/`.
- In Azure (Phase 8), quickstart.md §4's reachability check shows L2/L3 are unreachable from the internet.

### Tests for User Story 4

- [X] T034 [P] [US4] Create test/ledger-lock.test.ts with `describe("T-LED-05 one ledger writer")`, using temp dirs, an injected `now`/`sleep`, and a child fixture test/fixtures/lock-holder.ts (`acquireLedgerLock(argv[2])`, print `held`, wait for SIGTERM) spawned with `node_modules/.bin/tsx`:
  - a second `acquireLedgerLock` on the same path waits while the child holds a fresh lock, and resolves within 2 s after the child gets SIGTERM;
  - a lock whose `heartbeatAt` is 31 s old is taken over, the log callback receives `took over a stale ledger lock from <holder>`, and the old file is renamed to `<lock>.stale.<holder>.<ms>`;
  - when a holder's lock file is overwritten by another holder, `onLost` is called (default `process.exit(1)`);
  - an unreadable lock file counts as fresh for one poll, then as stale;
  - **must fail**: two `AuditLedger` instances on the same temp file, without the lock, each append an entry, and `new AuditLedger(path)` then throws `integrity`.
- [X] T035 [P] [US4] Create test/infra.test.ts with `describe("T-IAC-01 Azure identity, secret and exposure rules")`. Use `it.skipIf(!process.env.BICEP_PATH)`, with a skip message naming `BICEP_PATH`. It:
  - compiles infra/main.bicep with `@azure/bicep-rpc-client` (`Bicep.initialize(BICEP_PATH)`, `compile({ path: resolve("infra/main.bicep") })`, `dispose()` in `finally`);
  - asserts rules 1–10 from contracts/cloud-topology.md "T-IAC-01 assertions" on the ARM JSON, including rule 9 (`ALLOWED_HOSTS` is the `ca-seller` FQDN, never the alias) and rule 10 (each vault denies by default, with a VNet rule for its own subnet only);
  - **must fail**: copies `infra/` to a temp dir three times, applies one mutation per copy, recompiles, and checks that the matching rule reports a violation:
    - add a role assignment of `id-l1` on `kv-x402-l2`;
    - add `PAYER_PRIVATE_KEY` to `ca-l1-agent`'s env;
    - set `external: true` on `ca-l2-control`.

### Implementation for User Story 4

- [X] T036 [US4] Create src/layer2-control/ledger-lock.ts per contracts/ledger-lock.md:
  - constants `HEARTBEAT_MS = 5_000`, `STALE_MS = 30_000`, `POLL_MS = 1_000`, which are not configurable;
  - `acquireLedgerLock(ledgerPath, opts?: { now?; sleep?; log?; onLost? }): Promise<{ holder: string; release(): void }>`, implementing the "Algorithm" steps 1–5:
    - exclusive create with `flag: "wx"`;
    - heartbeat by writing `<lock>.tmp` then `renameSync`, on an `unref()`'d timer;
    - stale takeover by rename;
    - one "waiting" log line;
    - `release()` deletes the lock only if it's still ours.

  The header comment says: "SPEC L2-6 (011). Not a ledger entry; never touches the hash chain."
- [X] T037 [US4] In src/layer2-control/service.ts, change `main()` to `async`, in the order env → `const lock = await acquireLedgerLock(ledgerPathFor())` → `new AuditLedger(...)` → profile → mandate → signer → listen. Add SIGTERM/SIGINT handlers: `server.close()`, `lock.release()`, `process.exit(0)`. Update the entry guard to `main().catch(...)` with the same `l2-control:` error prefix. Leave `createControlService` unchanged. Run `npm run demo:local`: the summary must be unchanged.
- [X] T038 [P] [US4] Create tsconfig.build.json:
  - extends ./tsconfig.json with `noEmit: false`, `outDir: "dist"`, `rootDir: "."`, `sourceMap: false`;
  - `include`: `src/**/*.ts`, plus `scripts/approve.ts`, `scripts/reject.ts`, `scripts/escalations.ts`, `scripts/ledger-verify.ts`;
  - `exclude`: `test`, `scripts/demo*`, `scripts/local-chain*`, `scripts/dev-*`, `scripts/payer-balance.ts`, `scripts/scan-logs.ts`.

  `npm run build` must emit `dist/src/hosted-main.js`, `dist/src/layer1-intent/hosted/server.js`, `dist/src/layer2-control/service.js`, `dist/src/layer3-settlement/service.js`, `dist/src/main.js` and `dist/scripts/*.js` without errors.
- [X] T039 [P] [US4] Create Dockerfile and .dockerignore per research R14:
  - **build stage**: `node:22-bookworm-slim@sha256:<digest>`. Look up the current digest with `docker buildx imagetools inspect node:22-bookworm-slim` and pin it, with a comment giving the date. Then `npm install`, then `npm run build`.
  - **runtime stage**: the same base digest; `WORKDIR /app`; `USER node`; `npm install --omit=dev`; copy `dist/`, `config/`, and `docs/` to `dist/docs/`; `ENV NODE_ENV=production MASTRA_TELEMETRY_DISABLED=1`. No default `CMD`: each app sets its command.
  - **.dockerignore** excludes `node_modules`, `.local`, `env/*.env`, `.git`, `dist`, `test`, `specs` and `*.log`.

  Verify `docker run --rm <img> sh -c 'test ! -e env/l2-control.env && ls dist/src/hosted-main.js dist/src/layer1-intent/hosted'`.

  Then check SC-005 for the image: `docker history --no-trunc <img>` and `docker run --rm <img> env` must contain no `PRIVATE_KEY`, `_SECRET=` or `_TOKEN=` assignment. Add the same check as a step in the deploy workflow (T059).
- [X] T040 [P] [US4] Create scripts/ledger-verify.ts:
  - `loadEnv("operator")`, `tokenFor("operator")`, then `GET ${CONTROL_URL}/v1/ledger/verify`;
  - prints `entries=<n> ok=<bool>` (plus `brokenAt=<n>` when present);
  - exits 0 only when `ok` is true, 1 on an HTTP or network error or `ok: false`, 2 on a missing `CONTROL_URL`.

  Add `it("011 US4 ledger-verify exits 0 on a clean chain and 1 on a wrong token")` to test/e2e.local.test.ts. It spawns the script against `startHarness()` with env vars only (`ENV_FILE=/dev/null`).
- [X] T041 [P] [US4] Create infra/proxy/nginx-l2.conf and infra/proxy/nginx-l3.conf per contracts/cloud-topology.md "Proxy sidecar":
  - `listen 8080`; `client_max_body_size 256k`;
  - `location /` → `proxy_pass http://127.0.0.1:4020;` (L3: `4023`), with `proxy_set_header Host $host`;
  - a `log_format` without `$http_authorization`;
  - `location = /healthz`: for L2, `proxy_method GET` to `/v1/escalations`; for L3, `proxy_method POST` to `/v1/settlements` with an empty body. With `proxy_intercept_errors on`, map 401 to 200 `ok` and 502/504 to 502;
  - `pid /tmp/nginx.pid` and temp paths under `/tmp` (unprivileged image).
- [X] T042 [P] [US4] Create infra/modules/network.bicep (VNet `vnet-x402`; subnets `snet-cae` and `snet-cae-cp`, both /23, delegated to `Microsoft.App/environments` and with the `Microsoft.KeyVault` service endpoint), infra/modules/logs.bicep (Log Analytics `log-x402`, 30-day retention) and infra/modules/registry.bicep (`crx402<suffix>`, admin user disabled).
- [X] T043 [P] [US4] Create infra/modules/identities.bicep: user-assigned `id-l1`, `id-l2`, `id-l3`, `id-op`, `id-seller`, plus AcrPull for each on the registry.

  Create infra/modules/vaults.bicep: five Key Vaults in RBAC mode, `kv-x402-l1`, `-l2`, `-l3`, `-op`, `-seller`, with purge protection on and `networkAcls: { defaultAction: "Deny", virtualNetworkRules: [<its unit's subnet>] }` (`snet-cae`, or `snet-cae-cp` for `kv-x402-seller`). Each identity gets "Key Vault Secrets User" on its own vault only, per the contracts/cloud-topology.md role table. No secret values in the template.
- [X] T044 [P] [US4] Create infra/modules/storage.bicep: a premium FileStorage account `stx402<suffix>` with NFS share `ledger` (NFSv4.1, secure transfer off for NFS only as Container Apps requires), network rules allowing `snet-cae` only.

  Create infra/modules/foundry.bicep: an AIServices account `ais-x402`, deployment `claude-sonnet-5-5` (Global Standard), and "Cognitive Services User" for `id-l1` on it.
- [X] T045 [US4] Create infra/modules/environments.bicep:
  - `cae-x402`: workload profiles (Consumption), VNet `snet-cae`, external, `peerTrafficConfiguration.encryption.enabled: true`, logs to `log-x402`, environment storage `ledger` (NFS from T044);
  - `cae-x402-cp`: external, on `snet-cae-cp`.

  Create infra/modules/apps.bicep with `ca-l1-agent`, `ca-l2-control`, `ca-l3-verifier` and `job-operator`, exactly per contracts/cloud-topology.md "Apps and jobs", "Non-secret env" and "Secrets":
  - commands as listed there (`ca-l1-agent` runs `node dist/src/hosted-main.js`);
  - every value in the "Non-secret env" table, computed from the environments' `defaultDomain` outputs. In particular `ALLOWED_HOSTS=ca-seller.<cp-domain>` with no port, `ALLOWED_PAYEES`, and L3's `CONTROL_URL`;
  - `ca-l2-control` has two containers, `l2` and `proxy` (nginx-unprivileged pinned by digest; T041's config loaded with `loadTextContent('../proxy/nginx-l2.conf')` into an app secret `nginx-conf` and mounted as a secret volume at `/etc/nginx/conf.d`). Only the `l2` container gets `secretRef` env. The NFS volume mounts at `/app/.local`. Ingress `external: false`, `targetPort: 8080`, `allowInsecure: true`. Replicas min 1, max 1, single revision mode. TCP probes on 8080;
  - identity `lifecycle: "None"` except `ca-l1-agent` (`"Main"`);
  - `ca-l1-agent`: external, target port 4024, multiple revision mode, min 0, max 1, HTTP probes `/healthz` and `/readyz`; env `MODEL_PROVIDER=foundry`, `FOUNDRY_BASE_URL`, `AZURE_CLIENT_ID=<id-l1 clientId>`, `AGENT_BIND_HOST=0.0.0.0`, and internal FQDN URLs.

  Create infra/modules/sellers.bicep with `ca-seller` in `cae-x402-cp`: ingress target 4021, and env per the "Non-secret env" table (`SELLER_PAY_TO`, `FACILITATOR=cdp`, `SELLER_PORT=4021`).
- [X] T046 [US4] Create infra/main.bicep, composing T042–T045 with parameters `location` (default `eastus2`), `suffix`, `imageTag`, `authTenantId`, `authAudience`, `payerAddress` (public, for outputs only). Outputs: the agent FQDN, the internal FQDNs and the job names. Create infra/params/dev.bicepparam with no secret values.
- [X] T047 [US4] Make T035 pass: `az bicep install`, `BICEP_PATH=$HOME/.azure/bin/bicep npx vitest run test/infra.test.ts`. All 8 rules pass, and each mutant fails its rule. Rule 6 (lifecycles) and rule 1 (`id-l1` has nothing on `kv-x402-l2/l3`) deliver US2's FR-010; rule 2 delivers FR-011.

**Checkpoint**: T034, T035 (with `BICEP_PATH`) and T040 pass. `npm run build` and `docker build` succeed, and `npm run check` is unchanged.

---

## Phase 7: User Story 5 - A requester continues their own session after an approval (Priority: P2)

**Goal**: the session reference lets the same requester continue a session after an operator approves an escalation. Any other requester is refused.

**Independent Test**: T-E2E-09 continuation: escalate → operator approves → the same requester continues with `sessionRef` → PAID and CONFIRMED once. Another requester's use → 404.

### Tests for User Story 5

- [X] T048 [P] [US5] Create test/hosted-sessions.test.ts with `describe("T-AGT-04 session references")`:
  - the first run returns a `sessionRef`, and a second run by the same requester with it uses the same `sessionId` (the fake gate's `budget`/`authorize` calls carry it);
  - another requester → 404 `{ error: "unknown session" }`;
  - the body `{ sessionRef: "sess_0123456789abcdef" }` → 400;
  - a malformed `sr1.x.y` → 400;
  - a reference with one MAC character changed → 404;
  - **must fail**: with the test hook `skipSessionMac: true`, requester B's run uses requester A's `sessionId`.
- [X] T049 [P] [US5] In test/e2e.local.test.ts, add `it("T-E2E-09 continuation: escalate, approve, continue the same session, pay once")`:
  1. Run 1 escalates `/api/premium-report`.
  2. `POST ${h.urls.control}/v1/approvals/<authorizationId>` with `h.tokens.operator`.
  3. Run 2, from the same requester with run 1's `sessionRef`, has the scripted model fetch the report again: `PAID`, `CONFIRMED`, and exactly one `AUTHORIZED` with `approvalRef` set.
  4. Requester B with the same `sessionRef` → 404, and the ledger is unchanged.

### Implementation for User Story 5

- [X] T050 [US5] In src/layer1-intent/hosted/session-ref.ts, add `verifySessionRef(secret, requester, ref): { ok: true; sessionId } | { ok: false; status: 400 | 404 }`:
  - a value matching `^sess_`, or one not matching `SESSION_REF_RE` → 400;
  - otherwise recompute the MAC for the caller and compare with `timingSafeEqual` on equal-length buffers; a mismatch → 404.
- [X] T051 [US5] In src/layer1-intent/hosted/server.ts, replace the US1 placeholder: when `sessionRef` is present, call `verifySessionRef`, answer 400 `{ error: "invalid sessionRef" }` or 404 `{ error: "unknown session" }`, else use its `sessionId`. The response returns the same reference. Add the `skipSessionMac?` test hook to `HostedDeps` (documented test-only).

**Checkpoint**: T048–T049 pass. US1–US5 work offline.

---

## Phase 8: User Story 6 - Every deployment is reproducible and proven by a regression run (Priority: P2)

**Goal**: one commit becomes one deployment, gated by the scripted baseline in the cloud, a hosted smoke call and a log scan. The previous agent keeps serving, and L2/L3 are restored on failure.

**Independent Test**: T-E2E-AZ's static workflow checks pass offline. The first live deployment (T060) shows every contracts/deploy-pipeline.md step green.

### Tests for User Story 6

- [X] T052 [P] [US6] Create test/deploy-workflow.test.ts with `describe("T-E2E-AZ deployment workflow gates")`. Parse .github/workflows/deploy-azure.yml with `yaml` and assert:
  - `permissions` includes `id-token: write` and `contents: read`;
  - the step order matches contracts/deploy-pipeline.md steps 1–10: tests, T-IAC-01 with `BICEP_PATH`, image build tagged `${{ github.sha }}`, what-if then create, `ledger-verify` wait, `payer-balance`, `job-regression`, `ledger-verify`, hosted smoke, `scan-logs`, traffic shift last;
  - a rollback step with `if: failure()` redeploys `last-good` and never touches `ca-l1-agent` traffic;
  - no literal secret-shaped value appears (the T058 patterns).

  **Must fail**: a mutated copy with the traffic shift moved before `job-regression` is reported.
- [X] T053 [P] [US6] In test/agent.test.ts, add `describe("L1-4 seller alias (011 US6)")`:
  - `scriptedPlan("http://127.0.0.1:4021")` is unchanged (step 6 on `localhost`);
  - `scriptedPlan("https://seller.example", "https://alias.example")` makes step 6 `https://alias.example/api/weather?city=Lima`;
  - steps 1–5 are identical in both;
  - `checkBaseline` returns ok for the baseline outcomes with both PAID results `CONFIRMED`, and not ok when an outcome differs or a PAID result is `PENDING`;
  - spawning `src/main.ts --scripted --check-baseline` against the harness exits 0 and prints `baseline: ok`.

### Implementation for User Story 6

- [X] T054 [P] [US6] In src/layer1-intent/scripted.ts, add an optional `aliasUrl` parameter to `scriptedPlan`, and pass it through `ScriptedAgentOptions`. In src/main.ts, read `SELLER_ALIAS_URL` (optional) and pass it. Add `# SELLER_ALIAS_URL=` (optional, with a comment) to env/l1-agent.env.example and `"SELLER_ALIAS_URL"` to the `l1-agent` optional list in test/architecture.test.ts.
- [X] T055 [US6] Add the baseline check:
  - In src/layer1-intent/scripted.ts, export `BASELINE_OUTCOMES = ["FREE", "PAID", "PAID", "ESCALATED", "DENIED", "DENIED"]` and `checkBaseline(results: PaidFetchResult[]): { ok: boolean; detail: string }`. It requires the outcomes equal in order and both PAID results with `payment.settlement.status === "CONFIRMED"`.
  - In src/main.ts, `--check-baseline` (with `--scripted`) prints `baseline: ok` or `baseline: mismatch <detail>` and exits 2 on a mismatch.
  - Without the flag nothing changes, so `npm run demo:local` is unaffected.
- [X] T056 [P] [US6] Create scripts/payer-balance.ts:
  - `npm run payer-balance -- <address> [--min <atomic>]`;
  - it uses viem `createPublicClient` on Base Sepolia (`BASE_SEPOLIA_RPC_URL` or the profile default) and `readContract` `balanceOf` on the profile's USDC asset;
  - it prints `balance=<atomic>` and exits 0 when the balance is ≥ `--min` (default 50000), 2 below it with `fund the payer`, 1 on an RPC error;
  - it reads no env file and holds no key.

  Export `checkBalance(client, asset, address, min)` and unit-test it in test/agent.test.ts with a fake client, as `it("011 US6 payer-balance preflight")`.
- [X] T057 [US6] Extend the infrastructure:
  - **infra/modules/sellers.bicep**: add `ca-seller-alias` (same image, env and secrets as `ca-seller`).
  - **infra/modules/apps.bicep**: add `job-regression`: manual trigger, parallelism 1, timeout 900 s, command `node dist/src/main.js --scripted --check-baseline`, identity `id-l1` with lifecycle `None`, secrets `CONTROL_TOKEN` and `VERIFIER_TOKEN` from `kv-x402-l1` only. Env: `NETWORK=base-sepolia`, `SELLER_URL`, `SELLER_ALIAS_URL`, and internal FQDN `CONTROL_URL`/`SETTLEMENT_URL`.
  - **T-IAC-01 (test/infra.test.ts)**: assert that `job-regression` references no `OPERATOR_TOKEN` and no vault other than `kv-x402-l1`, and that `ca-seller-alias` is in `cae-x402-cp`.
- [X] T058 [P] [US6] Create scripts/secret-scan-lib.ts:
  - `SECRET_SHAPES: RegExp[]` per research R13: the JWT shape `eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+`; `Bearer\s+[A-Za-z0-9._~+/-]{16,}`; `-----BEGIN [A-Z ]*PRIVATE KEY-----`; `PAYMENT-SIGNATURE["']?\s*[:=]`; `x-api-key["']?\s*[:=]\s*\S+`; `\b[A-Z0-9_]*(PRIVATE_KEY|SECRET|TOKEN)=\S+`;
  - `findSecretShapes(text): string[]`, returning the pattern names only, never the match.

  Create scripts/scan-logs.ts (`npm run scan-logs`): it reads stdin and exits 1 printing pattern names on any match, 0 otherwise.

  Add `describe("T-AGT-05 secret shapes")` to test/hosted-run.test.ts with one positive and one negative example per pattern. Transaction hashes and `auth_…`/`sess_…` IDs must not match.
- [X] T059 [US6] Create .github/workflows/deploy-azure.yml per contracts/deploy-pipeline.md:
  - triggers: `workflow_dispatch` (input `environment`) and tags `deploy-*`;
  - `permissions: { id-token: write, contents: read }`;
  - `azure/login` with OIDC (client, tenant and subscription IDs as repository *variables*, not secrets);
  - steps 1–10 in order. The `job-regression` and `job-operator` starts pass `--container-name`, `--image` and the `secretref:` env vars (research R18);
  - the rollback step `if: failure()` (contracts "Rollback");
  - step 8 times the hosted smoke call, fails above 120 s, and writes the duration to `$GITHUB_STEP_SUMMARY`, so SC-009's p95 is computed over deployment history;
  - an image check after step 3: `docker history --no-trunc` and `env` must show no secret assignments (T039).

  T052 must pass.
- [ ] T060 [US6] Manual first deployment (needs your Azure subscription, a payer funded with test USDC and the seller's CDP key). Follow quickstart.md §4:
  - step 0: run infra/entra-app.sh with `--deploy-sp` and `--assign-user`, and put the printed `AUTH_AUDIENCE` in env/infra.env as `AGENT_API_CLIENT_ID` and run infra/github-setup.sh again, which already set the other five secrets and the `dev` environment (the quickstart's prerequisites);
  - step 1: run `deploy-infra` with `platform-only: true`;
  - step 2: check the Foundry model and deployment type;
  - step 3: seed the vaults by hand, with a temporary IP rule removed afterwards. Never script `PAYER_PRIVATE_KEY`; hard rule 2;
  - step 4: run `deploy-infra` again, for the sellers;
  - step 5: run `deploy-l2` and `deploy-l3` with `first-deployment: true`, then `deploy-l1`;
  - step 6: run `deploy-l2` and `deploy-l3` once more, to record their `last-good`;
  - step 7: record the timings (SC-008: setup under 60 min, a layer redeploy under 15 min).

  Then run the seven "platform facts" checks. Record every result under "Implementation Notes", including whether `STRIP_ANTHROPIC_BETA` had to be enabled.

**Checkpoint**: T052, T053, T056 and T058 pass offline. T060's live run is green, or its failures are recorded with their cause.

---

## Phase 9: User Story 7 - Operators can trace a run without seeing secrets (Priority: P3)

**Goal**: whitelisted JSON run logs, correlated by run ID, session, intent ID and authorization ID. Nothing secret appears in them, which is proven offline with planted values and in the cloud with the shape scan.

**Independent Test**: T-AGT-05 logs. Every captured line is JSON with only whitelisted keys, and planted values never appear.

### Tests for User Story 7

- [X] T061 [P] [US7] In test/hosted-run.test.ts, add `describe("T-AGT-05 logs")`, capturing the injected logger's lines during a run with fetch, budget and escalate steps:
  - each line parses as JSON with `event` ∈ {`step`, `run`};
  - the keys are a subset of the contracts/hosted-agent-api.md "Logs" whitelist;
  - `requester` equals `tid:oid`;
  - the planted values never appear in any line: the requester's JWT, `CONTROL_TOKEN`, `VERIFIER_TOKEN`, `SESSION_REF_SECRET`, the `sessionRef` MAC, the goal text, a `purpose`, and a token planted inside a tool error message;
  - `findSecretShapes(lines.join("\n"))` is empty.

- [X] T062 [P] [US7] In test/demo.local.test.ts, add `it("011 SC-005 demo output never contains the payer key")`. Reuse the T013 smoke run's captured child output, adding capture if that test doesn't keep it. The derived local payer key from `localDevKeys()` (scripts/local-chain-lib.ts), with and without `0x`, must appear in none of the captured lines and not in the ledger file. This is the known-value proof SC-005 relies on for logs, since a key has the same shape as a transaction hash.

### Implementation for User Story 7

- [X] T063 [US7] Create src/layer1-intent/hosted/run-log.ts: `createRunLog(write = (s) => process.stdout.write(s + "\n"))` with `step({ runId, requester, sessionId, index, tool, outcome, intentId?, authorizationId?, ms })` and `run({ runId, requester, sessionId, status, stopReason, steps, ms })`. It builds each object from exactly those keys (a whitelist, never spreading input). Wire it into src/layer1-intent/hosted/agent.ts (through `onStepFinish`) and src/layer1-intent/hosted/server.ts, with a `log?` hook in `HostedDeps`.
- [X] T064 [US7] Add step 9 to .github/workflows/deploy-azure.yml: `az monitor log-analytics query` over `ContainerAppConsoleLogs_CL` for the run window, then `| npm run scan-logs`. T052 must still pass.

**Checkpoint**: T061 and T062 pass. `npm test` passes.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: SPEC v1.5, governance and docs in the same change, then the final validation.

- [X] T065 Complete SPEC.md v1.5, which T005 drafted:
  - remove the *draft* mark from "Changes in 1.5";
  - §1.3 cloud profile;
  - §5: pins and the Node ≥ 22.13 floor;
  - §6 layout;
  - §12: T-AGT-02..05, T-AGT-KEY (amended), T-LED-05, T-E2E-09, T-IAC-01 and T-E2E-AZ, with the final titles;
  - §13 commands;
  - §15: EXT-7 and EXT-8 notes;
  - reconcile any section T005 drafted with what was actually built.
- [X] T066 [P] Add SEC-14, SEC-15 and SEC-16 rows to specs/007-process-isolation-security/contracts/threat-matrix.md:
  - SEC-14: tests T-AGT-03;
  - SEC-15: tests T-AGT-04;
  - SEC-16: tests T-AGT-05, T-E2E-AZ; owner 011.

  In test/architecture.test.ts, set `SEC_ROWS` length to 16 and extend the comment (`SEC-14..16 by 011, v1.5`).
- [X] T067 [P] Update specs/README.md: the "SPEC.md v1.0 … amended through v1.5" line, and traceability rows for L1-6, L2-6, SEC-14..16, T-AGT-02..05, T-LED-05, T-E2E-09, T-IAC-01 and T-E2E-AZ. Add an "Extended by 011" note to specs/001-agent-paid-fetch/spec.md's L1-5 assumption.
- [X] T068 [P] Update README.md and CLAUDE.md:
  - **README.md**: add a "Hosted agent (Azure)" section covering local run, dev token and deployment, pointing at quickstart.md; add the new test files to the tests table.
  - **CLAUDE.md**: add to Commands `npm run agent:hosted`, `npm run dev-token`, `npm run ledger-verify` and `npm run build`; add a hard-rule note that `src/hosted-main.ts` obeys INV-3 (it loads env, then refuses; it sits outside `src/layer1-intent/` because of rule A5) and that the hosted agent offers only the two tools; add Gotchas:
    - Mastra needs Node ≥ 22.13;
    - Foundry deployment names must equal the model ID;
    - L2 waits for the ledger lock during revision overlap.
- [X] T069 Run `npm run check`. Typecheck, every test and the `demo:local` summary (`FREE, PAID, PAID, ESCALATED, DENIED, DENIED`, `spent on-chain: 0.006 USDC`, `hash chain ok=true`) must hold. Run quickstart.md §1–§3, then record the test count and results under "Implementation Notes".
- [X] T070 Add `npm run stack:local [-- --docker]` (scripts/stack-local.ts): the five local stack processes of `demo:local` without an agent, until Ctrl-C, with the same per-process env (demo-lib `childEnv`). `--docker` adds `host.docker.internal:4021` to L2's `ALLOWED_HOSTS`. Quickstart §3 uses it (the earlier "one terminal each" recipe left L2, the facilitator and the seller without their local keys) and gains the container recipe. Also SPEC §13, README and CLAUDE.md.
- [X] T071 Fix the token audience. Entra v2.0 access tokens carry the API app's client ID as `aud`, never `api://x402-l1-agent`:
  - src/layer1-intent/hosted/config.ts: with Entra (no `AUTH_JWKS_FILE`), a non-GUID `AUTH_AUDIENCE` is a `ConfigError`. Test in test/hosted-agent.test.ts, with its must-fail proof.
  - infra/main.bicep: `authAudience` has no default and is exactly 36 characters. infra/params/dev.bicepparam reads `AUTH_AUDIENCE`, and the workflow sets it from `vars.AGENT_API_CLIENT_ID`.
  - T-IAC-01 rule 11 with a mutant (test/infra.test.ts; contracts/cloud-topology.md).
- [X] T072 Let people get a token. infra/entra-app.sh:
  - exposes the delegated scope `user_impersonation` (admin consent) and pre-authorizes the Azure CLI for it;
  - adds `--assign-user`;
  - prints the client ID as `AUTH_AUDIENCE`;
  - PATCHes the whole `api` object as read.

  test/entra-app.test.ts runs it against a fake `az` (test/fixtures/fake-az.mjs), with two must-fail mutants.
- [X] T073 Update contracts/access-and-sessions.md, research.md R6, quickstart.md §4 (step 0, a seventh platform check, calling the agent as a person), SPEC.md L1-6 and the T-AGT-03/T-IAC-01 rows, README.md and CLAUDE.md. Then run `npm run check`.
- [X] T074 One image per layer, plus the seller's (research R14 revised 2026-10-25, at the owner's request). scripts/image-closure.ts holds the table `IMAGES` (Dockerfile, entry points, allowed folders, `extraPackages`). It walks each image's import graph with esbuild (pinned 0.28.2 as a dev dependency, already installed through tsx), fails on a file outside the image's folders or an undeclared package, and writes the image's compiled files, a pruned package.json and `dist/image-modules.json`.
- [X] T075 Add docker/l1-agent.Dockerfile, docker/l2-control.Dockerfile and docker/l3-verifier.Dockerfile, and trim the root Dockerfile to the seller. Each has the same pinned base and build stage, runs the closure script, installs only its own packages against the full lockfile, imports every module once, and runs as `node`. Only the L2 image gets `config/`, the OpenAPI file and `/app/.local`.
- [X] T076 infra: main.bicep `var images` (`x402-l1-agent`, `x402-l2-control`, `x402-l3-verifier`, `x402-seller`, each tagged `imageTag`). apps.bicep takes `images` and runs the agent and job-regression from L1's, L2 and job-operator from L2's, and L3 from L3's; the sellers get the seller image. T-IAC-01 rule 12, with two must-fail mutants, in test/infra.test.ts.
- [X] T077 .github/workflows/deploy-azure.yml: env `IMAGES`, and steps 3, 3b and 10 build, scan and promote (`last-good`) every image. test/deploy-workflow.test.ts checks `IMAGES` against `IMAGES` in the closure script, that the three steps cover it, and that `job-operator` is started only with an L2 entry point, with two must-fail cases.
- [X] T078 test/images.test.ts (T-IMG-01) with three must-fail cases. Update research.md R14, contracts/cloud-topology.md (images, rule 12, the full mutant list), contracts/deploy-pipeline.md (steps 3, 3b, 10, rollback), quickstart.md §1, §2, §3 and §5, plan.md, SPEC.md (§3.1, §5, §6, §12, §13), README.md and CLAUDE.md.
- [X] T079 Split the Bicep into the platform and one template per unit (research R16, revised 2026-10-25). infra/main.bicep keeps only the platform. modules/platform.bicep looks up the registry, both environments, Foundry and the unit's own identities and vaults by name, and provides the pinned nginx image. modules/apps.bicep becomes l1-apps.bicep, l2-apps.bicep and l3-apps.bicep. New top-level templates l1-agent.bicep, l2-control.bicep, l3-verifier.bicep and seller.bicep, each with its params/dev-<unit>.bicepparam.
- [X] T080 T-IAC-01 compiles all five templates and checks them together. Rules 7, 11 and 12 move to the unit templates. New rule 13: a unit template deploys only its lookup and its own apps, looks up only its own identities and vaults, and shares the platform's suffix. Ten must-fail mutants in total, two for rule 13.
- [X] T081 Replace .github/workflows/deploy-azure.yml:
  - deploy-infra.yml deploys the platform, then the seller's image and the sellers. It repeats the regression and `ledger-verify` once the layers exist, and offers `platform-only` for the very first run.
  - deploy-layer.yml (reusable) holds one layer's steps 1–10 and its rollback.
  - deploy-l1.yml, deploy-l2.yml and deploy-l3.yml call it, by hand or on `deploy-<layer>-*` tags, with `first-deployment` offered for L2 and L3 only.
  - All four share the concurrency group `deploy-azure`.
- [X] T082 test/deploy-workflow.test.ts covers the four pipelines:
  - each one's order and rollback;
  - steps skipped only by `first-deployment` (layers) or `platform-only` (infra);
  - the callers' triggers, group and images;
  - each image built by exactly one pipeline.

  It has six must-fail cases.
- [X] T083 Update contracts/deploy-pipeline.md (rewritten), contracts/cloud-topology.md (templates and pipelines, rule 13), research.md R16, quickstart.md §1, §2 and §4 (the new first-deployment order), spec.md FR-024 (amended for per-unit deployments) and the Deployment entity, data-model.md, plan.md, SPEC.md (§3.1, §6, §12), README.md and CLAUDE.md.
- [X] T084 GitHub secrets instead of variables. The deploy workflows read `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AGENT_API_CLIENT_ID`, `SELLER_PAY_TO` and `PAYER_ADDRESS` from `secrets.*`. deploy-layer.yml declares exactly those six, and the layer callers pass them with `secrets: inherit`. test/deploy-workflow.test.ts allows no other secret and no `vars.*`, requires an OIDC-only `azure/login`, and has a must-fail case for each. The application's credentials stay out of GitHub, in the Key Vaults. Update contracts/deploy-pipeline.md, contracts/access-and-sessions.md, research.md R16, quickstart.md §4 (the secrets as a prerequisite) and CLAUDE.md.
- [X] T085 T-IAC-01 rule 14, the keyless model. The Foundry account has `disableLocalAuth: true`; no container has `ANTHROPIC_API_KEY` or an Anthropic secret; the agent runs with `MODEL_PROVIDER=foundry`, signs in as `id-l1`, and uses the platform's Foundry endpoint. Two must-fail mutants: keys enabled on Foundry, and an Anthropic key on the agent. Update contracts/cloud-topology.md, contracts/model-access.md, quickstart.md §2, SPEC.md (the T-IAC-01 row) and the foundry.bicep header.
- [X] T086 infra/github-setup.sh creates the GitHub environment and sets the six repository secrets from env/infra.env (gitignored; template env/infra.env.example). The file is parsed, never sourced. It may hold only the six secrets, `GITHUB_REPO` and `GITHUB_ENVIRONMENT`. Each value must have its shape: a GUID, or a 0x address of 40 hex digits. The environment must have its infra/params file. Any failure sends nothing. Values reach `gh` on stdin, never in its arguments, and are never printed. `AGENT_API_CLIENT_ID` may stay empty until quickstart §4 step 0. `--dry-run` sends nothing. A secret in the repository that no workflow reads is reported. test/github-setup.test.ts runs it against a fake `gh` (test/fixtures/fake-gh.mjs) and compares the names it sets with the secrets deploy-layer.yml declares. Two must-fail mutants: a looser address check lets a private key through as `PAYER_ADDRESS`; `--body` puts the values in `gh`'s arguments. T-ARCH-ENV adds `infra` to the CFG-2 matrix, so the template too may hold only those eight keys. Update quickstart.md §4, contracts/deploy-pipeline.md, contracts/access-and-sessions.md, both workflow headers, SPEC.md, README.md and CLAUDE.md.
- [X] T087 infra/entra-app.sh sets v2.0 access tokens before the identifier URI. The first real run (2026-10-25) failed: the tenant's default app management policy refuses `api://x402-l1-agent`, which holds no tenant ID, app ID or verified domain, unless the app receives v2.0 tokens, and the script set the URI first. test/fixtures/fake-az.mjs now enforces that rule, and T-AGT-03 has a must-fail mutant with the old order. After the fix the real run succeeded: URI, v2.0 tokens, `user_impersonation` with the Azure CLI pre-authorized, `Agent.Run`, assignment required, and the role assigned to the deploy service principal and to the owner.
- [X] T088 The deploy workflows sign in with the deploy app's client ID and client secret instead of OIDC, at the owner's request. `azure/login` gets only `creds`, built from `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`, and the five workflows drop `id-token: write`. deploy-layer.yml declares the seven secrets. infra/github-setup.sh sets `AZURE_CLIENT_SECRET` from env/infra.env: it refuses a GUID (the secret's ID, not its value) and any character Entra doesn't generate (letters, digits and `~._-` keep the inline JSON valid). T-E2E-AZ requires exactly those `creds` and `contents: read` only, with must-fail cases for a literal client secret and for the OIDC inputs. The setup test has two new refusals and a must-fail mutant without the GUID check. T-ARCH-ENV adds the key to the `infra` template (empty). Update contracts/deploy-pipeline.md, contracts/cloud-topology.md, research.md R16, quickstart.md §4, plan.md, SPEC.md (CFG-2, T-ARCH-ENV, T-E2E-AZ, a v1.5 residual risk), README.md and CLAUDE.md.
- [X] T089 Standard names, at the owner's request: every Azure resource and Entra app registration is `{type}-{app}-{location}-{env}`, with `{app}` one of `l1`, `l2`, `l3`, `op`, `seller`, `seller-alias`, `x402` (shared) and `deploy`. Examples: `rg-x402-eastus2-dev`, `ca-l1-eastus2-dev`, `caj-l2-eastus2-dev` (the operator job), `kv-seller-eastus2-dev`, `app-l1-eastus2-dev` (`api://app-l1-eastus2-dev`); the registry and storage drop the hyphens (`crx402eastus2dev`). The random suffix is gone. infra/naming.sh lists the names, reading the location from infra/params/<env>.bicepparam. Every template and parameter file takes `location` and `environment`, and the units' parameter files must match the platform's. The workflows load the names into `$GITHUB_ENV` right after the checkout, and the smoke token is requested for `$APP_L1_URI`. infra/entra-app.sh takes `--environment` (default dev) and names the API app from the list. The deploy app was renamed in place to `app-deploy-eastus2-dev` (same client ID). T-IAC-01 rule 15 checks that every resource name is the list's for its type, that every listed Azure name is deployed, that every name built from the location and environment (lookups, URLs between apps) is on the list, and that every environment's names fit Azure's limits. Rule 13 now checks the parameter files. Must-fail mutants: a non-standard name, a lookup with its segments swapped, L3 calling L2 under an undeployed name, a location whose vault names exceed 24 characters, and a unit parameter file naming another environment. T-E2E-AZ fails on a hard-coded name in a workflow, or names loaded late. The old API app `x402-l1-agent` is replaced, not renamed. Update contracts/cloud-topology.md (new Naming section), the other contracts, research.md, quickstart.md, plan.md, data-model.md, SPEC.md, README.md and CLAUDE.md.
- [X] T090 infra/cleanup.sh deletes everything of the env/infra.env environment, in order: the seven GitHub secrets (the client secret first) and the environment; the deploy app's role assignments across the subscription (before the app, so none is left orphaned); the resource group; the app registrations (the API app, also under the old name `x402-l1-agent`, and the deploy app). It also takes the old resource group `rg-x402-<env>`. It refuses, deleting nothing, for another tenant, a deploy app without its standard name, or an `AGENT_API_CLIENT_ID` that isn't the API app. It asks for the resource group's name unless `--yes`. `--dry-run` only reads. `--purge` purges the Foundry account and the app registrations afterwards, also those an earlier run left soft-deleted. The vaults have purge protection, so it reports them with their purge date, and explains how to recover them before a redeployment. The env file is parsed, never sourced, and the client secret's line is skipped. test/cleanup.test.ts runs it against a fake tenant (test/fixtures/fake-azure.mjs: orphaned role assignments, soft-delete, purge protection, `--subscription` required) and the fake `gh`. Two must-fail mutants: without the role-assignment step an assignment is left orphaned; without the dry-run guard `--dry-run` deletes. A real `--dry-run` against the tenant (2026-11-01) listed the six GitHub secrets, the environment, the deploy app and the old API app, and deleted nothing. Update quickstart.md §6, SPEC.md, README.md and CLAUDE.md.
- [X] T091 Bicep only for Azure provisioning, at the owner's request. infra/pre-deploy.bicep (subscription scope, deployed by an administrator by hand; Microsoft Graph Bicep extension v1.0:1.0.0 in infra/bicepconfig.json) creates the resource group; the API app `app-l1-<location>-<env>` (`api://` URI, v2.0 tokens, `Agent.Run`, `user_impersonation` with the Azure CLI pre-authorized, assignment required); the deploy app `app-deploy-<location>-<env>` with a GitHub federated credential and no secret (Bicep can't create a client secret, so the sign-in is OIDC again); `Agent.Run` for the deploy app and `agentUsers`; the operators' security group `grp-op-<location>-<env>` (append membership: a group can't be created with replace semantics); and, in modules/deploy-access.bicep, the deploy app's Contributor and Role Based Access Control Administrator on the resource group, the latter limited by condition to main.bicep's four roles. A consent grant for the Azure CLI was dropped: the tenant has no Azure CLI service principal, and pre-authorization needs none. main.bicep gains the Claude model deployment (`claude-sonnet-5-5` version 2, Global Standard, capacity 10, `modelProviderData` with the owner's attestation, which accepts Anthropic's Marketplace terms; what-if's preflight refused it without that data), the operators' Container Apps Jobs Operator role on the operator job, the vault `seedIp` and `recoverVaults` (`createMode: recover`), and moves the agent's traffic on promotion by redeploying. infra/entra-app.sh, test/entra-app.test.ts and test/fixtures/fake-az.mjs are removed. T-IAC-01 rule 16 checks the Entra objects and the deploy app's roles; T-E2E-AZ fails on any provisioning `az` command outside a Bicep deployment, in the workflow or infra/*.sh. Real runs (2026-11-01): pre-deploy deployed to the MSDN subscription, then to fr-com-dev (the same Entra objects, upserted by `uniqueName`); the MSDN resource group was removed.
- [X] T092 One main.bicep and one workflow. l1-agent.bicep, l2-control.bicep, l3-verifier.bicep, seller.bicep, modules/platform.bicep and infra/params/ are merged into main.bicep and main.<env>.bicepparam; deploy-infra.yml, deploy-l1/l2/l3.yml and deploy-layer.yml become .github/workflows/deploy.yml: platform-only deployment (so the registry exists), the four images, then everything, each previewed with what-if; regression, chain, smoke and log scan before promotion; rollback of everything to `last-good`. Every module takes names and settings only and looks up runtime values with `existing`, ordered by `dependsOn`: a parameter holding another module's output made what-if skip the module (`NestedDeploymentShortCircuited`), so a first deployment previewed 7 resources; now it previews 32 (platform-only) and 40 (all) in fr-com-dev. T-IAC-01 rule 13 checks each apps module's own identities and vaults and its wait for the platform. Update contracts/deploy-pipeline.md (rewritten), cloud-topology.md, model-access.md, access-and-sessions.md, research.md R16, quickstart.md §2, §4 and §6, plan.md, data-model.md, spec.md FR-024, SPEC.md, README.md and CLAUDE.md.
- [X] T093 Every value in the parameter files, at the owner's request. pre-deploy.<env>.bicepparam and main.<env>.bicepparam hold the target (tenant, subscription, resource group, location, environment), the GitHub repository and environment, the app and group IDs (pre-deploy's `mainParameters` output), the public addresses and the Claude attestation; only `imageTag`, `platformOnly`, `seedIp`, `recoverVaults` and `agentStableRevision` come from deploy.yml's environment. Each template fails validation (`fail()`) outside its file's tenant and subscription (main.bicep also its resource group). deploy.yml reads its OIDC sign-in and target from main.<env>.bicepparam with infra/bicepparam.sh and no GitHub secret or variable; the GitHub secrets, env/infra.env and env/infra.env.example are gone, infra/github-setup.sh only creates the GitHub environment (and reports leftover secrets), and infra/cleanup.sh takes its target from pre-deploy.<env>.bicepparam and also deletes the operators' group. T-IAC-01 rule 17 checks the parameter files and the guards. Real runs (2026-11-02): pre-deploy what-if in fr-com-dev (only the resource group's tags change), its guard refusing a run in the MSDN subscription, pre-deploy redeployed (same IDs), main.bicep what-if with 32 and 40 creates and no error. Tests: 474 pass, 22 skipped; T-IAC-01 22 of 22 with BICEP_PATH.
- [X] T094 Only two scripts, and every name in the parameter files, at the owner's request (2026-11-03). infra/naming.sh, infra/bicepparam.sh and infra/run-job.sh are removed; infra/ holds only github-setup.sh and cleanup.sh (T-E2E-AZ fails on a third). Each parameter file has a `names` object, built from its `location` and `environment` (main: the resource group, network, subnets, logs, registry, storage, Foundry, environments, and per unit identities, vaults, apps and jobs; pre-deploy: the resource group, the API and deploy apps and the operators' group); `resourceGroupName` and `environment` are no longer template parameters. Every module gets `names` whole and names nothing itself. Only Bicep reads a parameter file: deploy.yml's step 0 puts the pinned CLI first on PATH and compiles main.<env>.bicepparam for the sign-in, target, `authAudience` and names; github-setup.sh and cleanup.sh use `az bicep build-params`, and cleanup.sh refuses when the two files name different resource groups. deploy.yml starts every job with its own command (`run_job`); the operator job's own command is `ledger-verify`, so the deploy identity never approves or rejects. Review fixes in the same change: the rollback also runs when step 4 fails partway; every step runs with pipefail, so the log scan can't pass on a failed query; the smoke token is for `authAudience`; the T-IAC-01 step merges into the tests (BICEP_PATH is set), and the steps are renumbered 0–11. T-IAC-01 rule 15 checks every name against the standard and that the templates take them from `names` (five must-fail mutants), rule 17 reads the compiled files; what-if is unchanged (32 creates platform-only, 40 full) and a real cleanup.sh --dry-run lists the same objects. npm test with BICEP_PATH: 501 passed.
- [X] T095 The deploy app trusts GitHub's immutable OIDC subject. The first platform-only run (2026-11-04) failed at azure/login with AADSTS700213: the repository has `use_immutable_subject` on, so its jobs sign in as `repo:fr-com-dev@274163174/agentic-payments@1422461966:environment:dev`, and the credential trusted `repo:fr-com-dev/agentic-payments:environment:dev`. pre-deploy.<env>.bicepparam gains `githubOwnerId` and `githubRepositoryId`, and pre-deploy.bicep builds the subject from them, so a deleted and recreated repository of the same name can't sign in. infra/github-setup.sh reads the repository's subject settings first and refuses, changing nothing, unless GitHub's prefix is exactly the one trusted. T-IAC-01 rule 16 checks the subject's form (a must-fail mutant without the IDs) and rule 17 that both IDs are numeric; T-E2E-AZ covers another repository ID, the subject without IDs, a custom claim template, and a must-fail mutant without the check.
- [X] T096 Each step that calls Azure signs in itself. The first run past the sign-in (2026-11-04, run 41770632830) deployed the platform in 17½ minutes, then step 3's `az acr login` failed with AADSTS700024: GitHub's OIDC token was valid from 04:04:43 to 04:09:43, and az, signed in once by `azure/login`, can't renew it, so every new token request after 5 minutes fails (the registry, the smoke token, Log Analytics, the rollback, and ARM's own after about an hour). deploy.yml drops `azure/login`; step 0 puts `TENANT_ID`, `SUBSCRIPTION_ID` and `DEPLOY_CLIENT_ID` from the parameter file in the job's environment, and every step that calls Azure (2–5, 7–11, rollback) starts with `eval "$SIGN_IN"`: a fresh GitHub token (audience `api://AzureADTokenExchange`), `az account clear`, `az login --service-principal --federated-token`, `az account set`. T-E2E-AZ checks `SIGN_IN` exactly, that no step uses `azure/login` and that every step running `az` or `run_job` signs in first; must-fail mutants: the old single `azure/login` (all ten steps reported), a sign-in moved after the step's first `az` command, and a password instead of the federated token. Run against main's deploy.yml, the new checks report every one of those steps. Update contracts/deploy-pipeline.md, SPEC.md §3.1 and T-E2E-AZ, README.md and CLAUDE.md.
- [X] T097 Step 0 refuses `seed-ip` or `recover-vaults` without `platform-only`. Run 41770632830 (2026-11-04) had `seed-ip` set and `platform-only` unchecked, so after the platform it went on to step 3; had the sign-in held, it would have built the images and deployed the apps against vaults not seeded yet. The guard is step 0's first `if … fi`, before the Bicep download, and reads the inputs as `INPUT_PLATFORM_ONLY`, `INPUT_SEED_IP` and `INPUT_RECOVER_VAULTS` (the parameter file reads `SEED_IP` and `RECOVER_VAULTS` itself, and an input is never pasted into the script); a `deploy-*` tag has no inputs and goes on. T-E2E-AZ runs the guard in bash for all eight combinations of the three inputs and checks the step's env; must-fail mutants: no guard, a guard that misses `recover-vaults`, and the inputs pasted into the script. Against main's deploy.yml both guard tests fail. Update contracts/deploy-pipeline.md (step 0, platform only), SPEC.md T-E2E-AZ and quickstart §4.
- [X] T098 OpenAPI documents and opt-in Swagger UI for the hosted agent and the seller, at the owner's request (2026-11-04; SPEC v1.6). `docs/l1-hosted.openapi.yaml` describes `POST /v1/runs` (the Entra bearer scheme, every status from 400 to 429 with `Retry-After`, the run and step shapes with OpenAPI 3.1 nullable types) and the health routes; `docs/seller.openapi.yaml` describes the catalog and the four priced routes with each catalog price as `x-x402-price-atomic`, every status (200, 402 in its three forms, 502, 503) and the decoded JSON of the x402 headers (`contentSchema`). L2's Swagger UI module moves to `src/shared/api-docs.ts`, mounted by L2, the agent and the seller through their own wrappers, each only with `API_DOCS=1` (the agent's and the seller's before auth or payment, like the health routes and the catalog); L2's routes are unchanged. Neither `infra/` nor `deploy.yml` sets `API_DOCS`. The L1 and seller images list `swagger-ui-dist` and carry their documents. T-API-05..08 (`test/openapi-hosted.test.ts`) and T-API-09..11 (`test/openapi-seller.test.ts`) run the real apps (a stub seller and a scripted model or facilitator) through every documented status and check routes, auth, prices, headers and shapes; their must-fail cases report a missing or unmounted route, a wrong security or price, and a wrong field, and a changed field type in either document fails the scenario. The OpenAPI test helpers move to `test/helpers/openapi.ts` and learn list types and `null`. Update SPEC.md (L1-6, CP-1, CFG-2, SEC-13, §5, §6, §12, §13), contracts/hosted-agent-api.md, README, CLAUDE.md and the two env templates.
- [X] T099 The seller's endpoints declared with decorators and a monetization model, at the owner's request (2026-11-04; SPEC v1.7). Each endpoint is a method of `SellerApi` (`src/counterparty/seller-api.ts`) with two TC39 decorators, its route (`@Get`, `endpoints.ts`) and one tier (`@Free`, `@PayPerUse`, `@Premium`, `@Enterprise`, `monetization.ts`), after Stripe's "What is API monetization?": freemium discovery (the catalog) plus pay-per-use in tiers priced by value. Prices are written `usdc("0.001")` (BigInt). The catalog, the x402 requirements and the Express routes are derived from the declarations; routes, prices, descriptions, bodies and statuses are unchanged, and catalog items gain `tier`. Declaration mistakes are refused while the seller is built. Node can't run decorators natively: tsc and tsx lower them, and `vitest.config.ts` lowers them with esbuild because vite 8's oxc knows only legacy decorators (checked: without it, vitest fails with a SyntaxError at the first `@`). T-MON-01..03 (`test/seller-monetization.test.ts`) and T-API-09 (tiers in `docs/seller.openapi.yaml`, grouped by tier). Update SPEC.md (CP-1, §5, §6, §12), README and CLAUDE.md ("New seller route").
- [X] T100 Debug and run every process from VS Code, always in local mode, at the owner's request (2026-11-04). `.vscode/launch.json` has a configuration per process (the facilitator, seller, L2, L3, the L1 CLI agent scripted or with Claude, the L1 hosted agent, the operator's watch, approve, reject and ledger-verify, and vitest for the open file) and compounds for the stack (alone, with the scripted plan, with the hosted agent); `.vscode/tasks.json` has `local: chain` (start or reuse), `local: wait for stack`, `local: stop chain`, `local: dev token` and the checks. Every configuration starts through `scripts/vscode-local.ts run <role>`, which builds the child env with demo-lib's `childEnv` (as stack:local does; the local keys stay in memory, each only for its process), forces `NETWORK=local`, passes only `API_DOCS` and the debugger's attach variables (`NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`; without them breakpoints wouldn't bind in the child), and spawns the entry with tsx. stack-local's processes, ports and probes move to demo-lib's `localStack()`. Verified by hand: the chain started and was reused, the four services, `wait`, the scripted plan (FREE, PAID, PAID, ESCALATED, DENIED, DENIED), ledger-verify, escalations, approve, and the hosted agent's warning without a model key. T-DEV-01..02 (`test/vscode-local.test.ts`).
- [X] T101 One pipeline per unit, at the owner's request (2026-11-04). `.github/workflows/deploy.yml` becomes the reusable steps (`workflow_call`, inputs `unit`, `environment`, `first-deployment`, `seed-ip`, `recover-vaults`, no concurrency group of its own: a called workflow sharing its caller's group deadlocks) that six pipelines call with their unit: `deploy-infra.yml` (the platform), `deploy-l1.yml`, `deploy-l2.yml`, `deploy-l3.yml`, `deploy-operator.yml` and `deploy-seller.yml`, each by hand or on its own `deploy-<unit>-*` tag, all in the concurrency group `deploy-azure`, none passing a secret. `main.bicep` gets a required `unit` parameter (`platform`, `l1`, `l2`, `l3`, `operator`, `seller`; the parameter file reads `UNIT`, replacing `platformOnly`): each platform module is deployed only when `unit` is `platform`, each unit's apps only when it is that unit, and incremental mode leaves the rest as it is. The operator job moves from `l2-apps.bicep` to `modules/operator-apps.bicep` (same resource and role assignment, so no change in Azure) and to its own image, `x402-operator` (`docker/operator.Dockerfile`: the four operator scripts and `src/shared` only; `x402-l2-control` loses them). Step 0 maps the unit to its image and refuses `seed-ip` or `recover-vaults` on a unit, `recover-vaults` without `first-deployment` and a first deployment of L1, before anything else. A unit's run builds and scans its image, deploys it, waits (the platform and L2: the lock handover through the operator job; L1 and L3: the latest revision; always both sellers), checks every unit (balance, regression, chain, smoke, log scan), then promotes its image to `last-good` (L1 first moves the agent's traffic) or rolls that unit back. The platform skips the image steps, promotion and rollback (fixed forward). A first deployment skips the checks and promotes nothing; the units go sellers, L3, operator, L2, then L1 (quickstart §4). T-E2E-AZ (test/deploy-workflow.test.ts) checks the folder, each pipeline's triggers, inputs, group and call, every step's condition, and runs the step-0 guard for all six units (and an unknown one) with every combination of the three inputs, checking the image and Dockerfile each maps to; new must-fail cases: a pipeline outside the group, on another unit, on `deploy-*` tags or a merge, with secrets or steps of its own, a missing or extra pipeline, `deploy.yml` with its own trigger or group, a platform run that builds or promotes, a rollback of the platform, a guard that lets `seed-ip` through on a unit or a first deployment of L1, a unit built from another image, and a promotion of another image. T-IAC-01 rule 18 (and rules 1, 12, 13 for the operator unit), with mutants: L1's apps deployed by the platform's runs, Foundry deployed by every run, a seventh unit value, the operator job on L2's image, and L2's apps reading the operator's vault. T-IMG-01: only the L2 image holds any L2 code. Checked by hand: actionlint (with shellcheck) on the seven workflows; `docker build` of `x402-operator` and `x402-l2-control`, the operator image's only package `dotenv` and its `ledger-verify` exiting 1 against no L2. Update contracts/deploy-pipeline.md (rewritten), cloud-topology.md (rule 18, the operator unit), research.md R14 and R16, quickstart.md §1, §2, §4, §5 and §6, spec.md FR-024 and the Deployment entity, data-model.md, SPEC.md (§3.1, §6, CFG table, security note, T-IAC-01, T-IMG-01, T-E2E-AZ, §13), README.md, CLAUDE.md, `infra/cleanup.sh`'s recovery hint and the infra comments.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: needs Phase 1. Blocks every story. T005 (SPEC v1.5 draft) and T006 (constitution 1.2.0) come first, before any code, as governance requires.
- **US1 (Phase 3)**: needs Phase 2. The MVP.
- **US2 (Phase 4)**: needs US1 (agent, model, config). Its cloud half (FR-010, FR-011) completes in US4's T047.
- **US3 (Phase 5)**: needs Phase 2. Its "0 model calls" assertions use the US1 run route.
- **US4 (Phase 6)**: L2 lock (T034, T036, T037) and build (T038, T039) need only Phase 1. Infrastructure (T041–T047) needs nothing from US1–US3, but `ca-l1-agent`'s env follows T010's config.
- **US5 (Phase 7)**: needs US1 (issuing references) and US3 (requester identity in `res.locals`).
- **US6 (Phase 8)**: needs US4 (image, infrastructure, `ledger-verify`). T060 needs everything before it.
- **US7 (Phase 9)**: needs US1. T064 needs T059.
- **Polish (Phase 10)**: needs every story. T066 must land with T065, or T-ARCH-TRACE fails on the new SEC rows.

### Within each story

Tests first, and confirm they fail. Then config and helpers → core module → server wiring → manual check.

## Parallel Example

```text
# Phase 1
T002 package.json | T003 src/shared/config.ts | T004 env template + architecture test

# Phase 2
T005 SPEC.md draft | T006 constitution (docs only, first)
# then, after T007
T008 hosted/config.ts → then T009 scripts/dev-issuer-lib.ts | T011 hosted/requester-auth.ts; T010 scripts/dev-token.ts after T009
T014 test/hosted-access.test.ts | T015 test/agent.test.ts | T016 test/hosted-agent.test.ts   (after T012/T013)

# US1 tests
T017 test/hosted-agent.test.ts | T018 test/hosted-run.test.ts | T019 test/e2e.local.test.ts

# US4: the L2 lock, build and infrastructure tracks are independent
T034 + T036 + T037 (lock) | T038 + T039 (build) | T041, T042, T043, T044 (infrastructure modules, separate files)

# Polish
T066 threat matrix + architecture test | T067 specs/README + specs/001 | T068 README + CLAUDE.md
```

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1, then Phase 2: the SPEC v1.5 draft and constitution 1.2.0 first, then INV-3, config, auth and health.
2. Phase 3 (US1): the agent, model, run route and session issuing.
3. **Stop and validate**: `npx vitest run test/hosted-agent.test.ts test/hosted-run.test.ts test/hosted-access.test.ts -t "T-AGT-0"`, then `npx vitest run test/e2e.local.test.ts -t "T-E2E-09"`, then `npm test`. A requester can now buy through the hosted agent locally.

### Incremental delivery

1. US2: authority proofs (must-fail cases).
2. US3: the full access matrix and limits; the Entra app script.
3. US4: the L2 lock (its own small change, shippable on its own), build and image, infrastructure, T-IAC-01.
4. US5: session continuation after approval.
5. US6: the alias, workflow and first live deployment.
6. US7: run logs and the cloud log scan.
7. Polish: complete SPEC v1.5, the threat matrix and docs, then `npm run check`.

### Notes

- Never weaken an invariant, the two-tool rule or the demo baseline to make a test pass
  (Constitution VIII). If observed behavior differs from a contract, update the contract and
  spec.md in the same change.
- Commit after each phase checkpoint, citing requirement IDs (FR-0xx, L1-6, L2-6, SEC-14..16,
  T-…), on branch `devsoftx/011-l1-hosted-agent-azure`.
- Scripts never handle `PAYER_PRIVATE_KEY`, and vault seeding is manual (hard rule 2).
- `createControlService` and `createHostedApp` never start timers or take the ledger lock. Only
  the `main()` functions do, so tests stay deterministic.

## Implementation Notes (2026-10-22, `/speckit-implement`)

Places where the work differs from the task text, and the validation results.

- **T007 (refusal text)**: `REFUSAL` moved to `src/refusal.ts`, not `src/layer1-intent/refusal.ts`. The text itself names `PAYER_PRIVATE_KEY`, and rule A5 bans that name in L1 code even as a string literal. It sits beside both entry points, outside the layer.
- **T012/T015 (INV-3 order)**: `src/hosted-main.ts` loads env first and then refuses, like `src/main.ts`. Mutation check: moving the refusal before `loadEnv` fails both the "key only in `ENV_FILE`" case and the source-order case.
- **T021 (Mastra logging, new)**: the probe showed Mastra prints provider errors itself (`Error in agent stream {…}`). A provider error object can carry the request body, including the goal and tool results, outside the whitelisted run log. `buildAgent` sets `noopLogger`, and errors still reach `runGoal`. SPEC L1-6 records this.
- **T021 (abort)**: `runGoal` waits for tool calls still in flight before it builds the result. The fetch in progress at the deadline is therefore always listed, whatever Mastra's own timing.
- **T025 (`json` tool evidence)**: the provider adds its `json` tool for an unrecognized model id only when structured output is requested. The agent never requests it. The allow-list is defense in depth against a later change that would.
- **T040 (`ledger-verify`)**: no "missing `CONTROL_URL`" exit 2. `serviceUrls()` defaults to the local L2, the same convention as `approve` and `reject`.
- **T050 (session MAC)**: the check compares the canonical base64url strings in constant time, not decoded bytes. Decoding ignores the last character's two padding bits, so a byte comparison accepted several spellings of one reference, and the original "tampered last character" test would have been flaky. T048 now also sends a padding-only variant, which gets 404.
- **T044–T047, T057 (infrastructure)**:
  - `main.bicep` has a `deployApps` switch. The workflow first deploys the base without apps, so the registry exists before the image does.
  - The Foundry model deployment is created in the portal (quickstart §4 step 1), not in Bicep. Its model format and version fields for Claude were unconfirmed.
  - The sellers are a copy loop, and T-IAC-01 expands loop names.
  - T-IAC-01 rule 1 resolves each template's `variables(...)` before matching role GUIDs.
  - The two `use-secure-value-for-secure-inputs` warnings for the nginx config secret are suppressed with a comment: the config is not secret, but Container Apps mounts files only through secret volumes.
- **Analysis findings closed in code**: G1 (`src/hosted-main.ts` added to the "L1 never references operator routes" check, plus a hosted-only check that also bans `/v1/ledger/verify`) and K1 (must-fail mutants for T-IAC-01 rules 9 and 10). There are 5 mutants in all, each caught.
- **T039 (image)**: both stages run `npm install --ignore-scripts`. The image's npm 10 would otherwise run native install scripts (ganache's ws helpers) that need a compiler, and no runtime dependency needs one. The image is about 874 MB, mostly `@mastra/core`'s tree. It runs as `node`, holds no `env/` and no ledger, and its secret check is clean. The payer-key refusal also works inside the container.
- **T041 (sidecar)**: checked in the real topology. A stub "L2" bound to 127.0.0.1 ran with the nginx container sharing its network namespace:
  - `/healthz` returned 200 while the guard answered 401, and 502 with the upstream down;
  - requests passed through unchanged;
  - no `Bearer` value reached the access log.
- **T058 (secret shapes)**: the assignment pattern excludes `NAME=secretref:…`, a Container Apps Key Vault reference rather than a value. The workflow's own image-check `grep` uses bracket classes so the workflow file doesn't match itself.
- **T059 (workflow)**:
  - It builds with `docker build`/`push` instead of `az acr build`, so the image can be inspected with `docker history` on the runner.
  - `last-good` is an `az acr import` alias.
  - `infra/run-job.sh` copies a job's current template and changes only the command, because an override replaces the whole template (research R18); removed in T094, when deploy.yml began starting each job with its own command.
  - actionlint and shellcheck are clean.
- **Mutation proofs run in this session**, each observed failing with its control removed and passing when restored:
  - the INV-3 order;
  - payer-key text in the demo output (T062);
  - T-IAC-01 rules 1, 2, 3, 9 and 10;
  - `bypassAuth`, `skipSessionMac` and `extraTools` (in-test hooks);
  - two unlocked ledger writers;
  - promoting before the regression.
- **Environment**: the standalone L2 with Swagger UI, started earlier on port 4020, was stopped so the demo tests could bind their ports.
- **T069 results**:
  - `npm run check` passes: typecheck clean, 22 test files with 442 passed and 6 skipped (T-IAC-01 without `BICEP_PATH`), and the demo summary `FREE, PAID, PAID, ESCALATED, DENIED, DENIED`, `spent on-chain: 0.006 USDC`, `hash chain ok=true`.
  - With `BICEP_PATH`, T-IAC-01 passes 6 of 6.
  - Quickstart §1–§2 pass, along with `npm run build`, `docker build`, and the image layout and secret checks.
  - Quickstart §3's live model run is T024.
- **T024 (2026-10-22, live model `claude-sonnet-5-5` through the Anthropic API, against the local stack)**:
  - The key came from `env/l1-agent.env` through the process environment. `env/l1-hosted.env` keeps `ANTHROPIC_API_KEY=` empty, which works because `loadEnv` never overrides the environment.
  - The weather and market-brief goal returned `completed` in 8 s. The steps were `FREE` (catalog), `check_budget`, then `PAID` and `CONFIRMED` for `/api/weather?city=Lima` and for `/api/market-brief`.
  - Access:
    - no token → 401;
    - `--no-role` token → 403 `forbidden`;
    - a third concurrent run from alice → 429 `too many runs` with `Retry-After: 5`, while the first two completed.
  - Session binding:
    - alice's `sessionRef` → 200, with the same session (budget 0.094 USDC left);
    - the same reference with bob's token → 404 `unknown session`.
  - The payer key (dummy value):
    - in the process environment → exit 1 with the refusal;
    - only inside the env file named by `ENV_FILE` → exit 1 with the refusal.
  - US5:
    - The premium report → `ESCALATED` (`human_approval_required`), then `npm run approve`.
    - The continuation with the `sessionRef` → `PAID`, `CONFIRMED`.
    - That session's ledger holds exactly one `AUTHORIZED` and one `SETTLEMENT` entry, so the payment was made once.
  - `ledger-verify` → `entries=486 ok=true`, and L2 released `<ledger>.lock` on SIGTERM.
  - The run log had 19 JSON lines. None contained a goal, `purpose`, bearer token, JWT or session-reference MAC.
- **T070–T073 (2026-10-24)**, found while answering "how do I test the cloud agent locally?":
  - **T070**: quickstart §3's manual stack never started. Started by hand, L2, the facilitator and the seller have no local keys; only `demo:local` derived them. `stack:local` reuses that code, and its `--docker` path was run end to end: a containerized agent bought through the local stack.
  - **T071**: every deployment would have refused every real token. Entra v2.0 tokens carry the client ID as `aud`, while `AUTH_AUDIENCE` was `api://x402-l1-agent`, so the smoke check would have failed and rolled back.
    - The dev issuer hid this: it signs its own tokens with that URI.
    - The check now fails in three places: at startup (`ConfigError`), when the Bicep parameters compile (BCP333 without `AUTH_AUDIENCE`), and in T-IAC-01 rule 11.
  - **T072**: no person could get a token. The API exposed no delegated scope and pre-authorized no client, so only service principals could (client credentials).
    - What `entra-app.sh` does now is tested against a fake `az` that enforces two Graph rules: enabled scopes can't change, and a pre-authorization names an existing scope.
    - That those rules, and the Azure CLI pre-authorization, match Graph is unverified until T060.
  - Must-fail proofs observed this session:
    - the config check removed → its test fails;
    - the script printing the identifier URI, or skipping the pre-authorization → reported;
    - an `api://` default for `authAudience` → rule 11 is reported.
- **T074–T078 (2026-10-25), one image per layer**:
  - Closures:
    - **L1**: 16 modules, with Mastra, both model SDKs, `@azure/identity`, `jose`, `express`, `zod`, `@x402/core` and `dotenv`, and no `viem`.
    - **L2**: 17 modules, the only image with the signer.
    - **L3**: 4 modules.
    - **Seller**: 4 modules, the only image with the CDP SDK.
  - Image sizes:

    | Image | Size | `node_modules` |
    |---|---|---|
    | L1 | 640 MB | 242 MB |
    | L2 | 539 MB | 156 MB |
    | L3 | 512 MB | 135 MB |
    | Seller | 585 MB | 201 MB |
    | The one shared image, before | 874 MB | n/a |
  - Run from the images against `stack:local -- --docker`:
    - the L1 image's hosted agent paid for the weather and the market brief, both `CONFIRMED`;
    - its `main.js --scripted --check-baseline` printed `baseline: ok`. Step 6 used a `--add-host seller-alias:host-gateway` alias, since `gateway.docker.internal` doesn't resolve here;
    - the L2 image's `ledger-verify` and `escalations` ran against the local L2.
  - The secret check found nothing in any image's history or env. A runtime user can't change `node_modules`, which is owned by root.
  - Must-fail proofs observed:
    - the closure script with L1 wired to L2's service → exit 1, nothing written;
    - the in-image module check with `viem` deleted → `ERR_MODULE_NOT_FOUND`, exit 1;
    - rule 12's mutants and T-IMG-01's and T-E2E-AZ's must-fail cases.
  - The workflow now runs four Docker builds, each with its own `npm install`. That is slower than one, and the first live run (T060) measures it.
- **T079–T083 (2026-10-25), one pipeline for the platform and one per layer**:
  - All five templates compile with no diagnostics. Each parameter file builds against its template, and `dev-l1-agent.bicepparam` still fails with BCP333 without `AUTH_AUDIENCE`.
  - T-IAC-01 passes 11 of 11 with `BICEP_PATH`; with rule 14 (T085), 13 of 13.
  - Rule 7's rewritten seller-vault check isn't vacuous. With the sellers pointed at another vault, both rule 7 and rule 13 reported it.
  - `actionlint` (with shellcheck) is clean on all five workflows.
  - The vaults exist only after the first infra run, and the sellers can't start until their CDP secrets are in, hence `platform-only`. Before L1 exists, there is no regression or agent for an L2 or L3 run to check, hence `first-deployment`. Such a run is reported as unverified and records no `last-good`; FR-024 is amended for it.
  - Not yet run live: the reusable workflow's sign-in, the cross-workflow concurrency group and the new first-deployment order, until T060.
- **Open**: T060 needs an Azure subscription, a funded payer and the seller's CDP key, for the first deployment and the seven platform-fact checks.
