# Research: Cloud-Hosted Purchasing Agent (L1) on Mastra and Azure

Phase 0 for `specs/011-l1-hosted-agent-azure`. Every decision is grounded in the current code
(`src/layer1-intent/*`, `src/main.ts`, `src/layer2-control/service.ts`), SPEC.md v1.4, the
clarified spec, and two research passes on 2026-10-21/22:
- **Mastra and libraries**: npm registry, the docs bundled in `@mastra/core` 1.75.0, its source at
  that tag, and throwaway probes on Node 26.
- **Azure**: Microsoft Learn and Anthropic docs.

Facts marked *unconfirmed* are verified in the first cloud deployment (quickstart §4) before
anything depends on them.

## R1. How is Mastra used?

- **Decision**: Use Mastra's `Agent` as a library inside our own Express 5 route. Don't run the
  Mastra server, the `mastra` CLI, Studio or a `Mastra` instance. Pin `@mastra/core` 1.75.0
  exactly (published 2026-10-07).
- **Rationale**:
  - FR-004 allows exactly two operations: run a goal and health. Mastra's server and its Express
    adapter publish agent-management, tool-execute, memory and workflow routes. Owning the route
    publishes nothing else.
  - A standalone `Agent` needs no `Mastra` instance and makes no network calls of its own. The
    probe saw zero sockets during import plus a 3-step `generate`.
  - Leaving out the `Mastra` instance also rules out its global workspace, one of the ways tools
    get added (R3).
  - The rest of the repo runs Express 5 under one composition style, so this matches.
- **Alternatives considered**:
  - The Mastra server via `mastra build`: exposes extra routes and brings its own bundler and
    entry point.
  - The Express server adapter: still mounts Mastra's route set, which we'd have to filter.
  - Keeping the hand-written loop: doesn't meet NFR-001 (Mastra is user-mandated).
- **Sources**: https://mastra.ai/reference/agents/agent, https://mastra.ai/reference/agents/generate,
  `packages/core/src/agent/agent.ts` at tag `@mastra/core@1.75.0`.

## R2. How does the agent reach Claude (FR-006)?

- **Decision**: Build the model as an AI SDK instance with `createAnthropic` from
  `@ai-sdk/anthropic` 3.0.128 (the AI SDK v6 line Mastra 1.75 wraps). Never use a router string.
  `MODEL_PROVIDER` selects the path:
  - **`foundry`** (default in Azure): base URL `https://<resource>.services.ai.azure.com/anthropic/v1`
    (with `/v1`, because the provider posts to `${baseURL}/messages`).
    - Auth is keyless Entra ID: a custom `fetch` sets `Authorization: Bearer <token>` on every
      request. The token comes from `@azure/identity` 4.13.3 (`ManagedIdentityCredential` with
      the L1 identity's client ID) for scope `https://ai.azure.com/.default`.
    - `authToken` gets a placeholder value, so neither the `ANTHROPIC_API_KEY` fallback nor an
      `x-api-key` header is used.
    - The L1 identity holds **Cognitive Services User** on the Foundry resource.
  - **`anthropic`**: the default Anthropic base URL, with `ANTHROPIC_API_KEY` from L1's Key Vault.
- **Model id allow-list.** `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) must be one of the
  recognized Claude ids. The Foundry deployment name must equal the model id. The service refuses
  to start otherwise.
- **Rationale**:
  - Sonnet 5.5 is GA in Foundry (Learn, updated 2026-09-21), and keyless Entra ID is supported
    and recommended.
  - The provider detects capabilities from the model id. With an unrecognized id (for example a
    custom deployment name) it adds a **third tool named `json`**, which would break FR-003. The
    allow-list and T-AGT-02 close that hole.
  - A router string would take the models.dev and Mastra-gateway code paths, which can make
    network calls (R13).
  - Sonnet 5.5 rejects `temperature` and `top_k`. The agent sends neither, as today.
  - The provider sends `anthropic-beta: structured-outputs-2025-11-13` when tools are present.
    *Unconfirmed* whether Foundry accepts it; quickstart §4 checks it with one live call. If
    Foundry rejects it, the Foundry `fetch` wrapper removes that header.
  - **Deployment type**: Anthropic says Sonnet 5.5 is Global Standard only, while Learn lists a
    US Data Zone version. The infrastructure deploys Global Standard in `eastus2` and records the
    portal's answer in quickstart §4.
  - No automatic provider switching (spec edge case).
- **Alternatives considered**:
  - `@anthropic-ai/foundry-sdk` (`AnthropicFoundry`): it's an Anthropic SDK client, not an AI SDK
    model, so Mastra can't take it directly.
  - A Foundry API key: a long-lived secret, when managed identity needs none.
  - Anthropic API only: no Azure billing or data residency, which went against clarification Q3.
- **Sources**:
  - https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models
  - https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude
  - https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-entra-id
  - https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry

## R3. How do we guarantee exactly two tools (FR-003, SEC-1)?

- **Decision**:
  - **The tools.** Define them with `createTool` and zod 4.6.5. The tools object keys are
    `fetch_resource` and `check_budget`; the model sees the key, not the `id`. Descriptions are
    taken from the existing `AGENT_TOOLS` constants, so they stay identical.
  - **Hidden tool sources stay off.** The agent gets no `memory`, `workspace`, `agents`,
    `workflows`, skills, browser, `toolsets`, `clientTools` or input processors. It runs without
    a `Mastra` instance (R1).
  - **No history rewriting.** `errorProcessorDefaults: false`, so the default error processors
    can't rewrite history or re-send prompts.
  - **T-AGT-02 checks it at two levels.** Through `MockLanguageModelV3` (`ai` 6.0.302, test
    only): each recorded `doGenerateCalls[i].tools` names exactly the two tools. Through a fake
    `fetch` under `createAnthropic`: the HTTP request body's `tools` has exactly two entries,
    using the configured model id.
- **Rationale**:
  - Mastra assembles the tool list from `tools` plus memory, workspace, agents, workflows,
    skills, browser and processor-loaded tools, each only when configured. Leaving all of them
    unconfigured is the control; the test proves it.
  - The HTTP-level check also catches the provider's `json` tool (R2).
- **Schema difference**: the JSON schema Mastra sends adds `$schema` (draft-07) and
  `additionalProperties: false`, and `check_budget` gets `required: []`. That is stricter than the
  L1-3 JSON, not looser. T-AGT-02 compares `type`, `properties` and `required`, and the SPEC L1-6
  text records the difference.
- **Alternatives considered**:
  - A wrapper that filters tools before each model call: it would sit inside Mastra's internals
    and break on upgrades.
- **Sources**: https://mastra.ai/reference/tools/create-tool, https://mastra.ai/docs/agents/tools,
  https://mastra.ai/docs/memory/working-memory, https://ai-sdk.dev/docs/ai-sdk-core/testing.

## R4. Step, token and cancellation limits

- **Decision**: `agent.generate(goal, { maxSteps: 10, modelSettings: { maxOutputTokens: 2048,
  maxRetries: 2 }, abortSignal })`. The abort signal fires on the run deadline (R5) or when the
  client disconnects.
- **How a run reports why it ended**:
  - `finishReason: 'aborted'` (on abort `generate()` resolves rather than throws) → status
    `stopped`.
  - `'tool-calls'` at the step limit → `stopped`, reason `step_limit`.
  - `'stop'` → `completed`.
  - A thrown error → `failed`, keeping the steps completed so far.
- **Rationale**:
  - **Step limit parity.** Mastra's default is 5 steps, so 10 must be set. As in today's loop
    (`runClaudeAgent` runs the tool calls of turn 10 and then exits), the tool calls of the last
    step still run. A 10th-step `fetch_resource` can pay, exactly as in v1.4, and L2 still bounds
    it.
  - **Abort is safe for payments.** The signal reaches model calls, and tools as
    `context.abortSignal`. `fetchPaid` deliberately ignores it, so a paid fetch in progress
    completes and is recorded (spec edge case), and the next step never starts.
  - **Retries match today.** `maxRetries: 2` matches the Anthropic SDK default of today's loop. A
    retried model call never re-runs a tool.
- **Sources**: Mastra generate reference; `agent.ts` at 1.75.0 (`maxSteps`/`stopWhen`, `onAbort`).

## R5. How is the result delivered: one response, or streamed?

- **Decision**: `POST /v1/runs` answers with one JSON response when the run ends. The run deadline
  is **200 s**. No streaming in this feature.
- **Rationale**:
  - Container Apps ingress closes a request after **240 s without network activity**, and a run
    sends nothing until it finishes. Raising the timeout (4–30 min) needs premium ingress: a
    dedicated D4+ profile with at least two nodes, too costly for a PoC. 200 s leaves margin.
  - The default goal takes well under 120 s (NFR-004), so 200 s only cuts runaway runs.
  - The spec's 5-minute default is amended to 200 s.
- **Alternatives considered**:
  - SSE or NDJSON streaming with heartbeats: it would survive the idle timer (*unconfirmed*: only
    inferred from the maintainers' "idle" wording), but it adds a second response format and its
    tests for no requirement.
  - An asynchronous `202` + poll design: it needs run storage that survives restarts.
- **Sources**: https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview,
  https://learn.microsoft.com/en-us/azure/container-apps/premium-ingress,
  https://github.com/microsoft/azure-container-apps/issues/597.

## R6. How are requesters authenticated (FR-012, FR-013)?

- **Decision**: Verify Entra ID v2.0 access tokens in our Express middleware with `jose` 6.2.12
  (`createRemoteJWKSet`, `jwtVerify`), before the body is parsed. Checks:
  - the signature from the tenant's JWKS;
  - `iss` = `https://login.microsoftonline.com/<tenant>/v2.0`, and `tid` = the configured tenant;
  - `aud` = the API app's client ID. Entra v2.0 access tokens always carry the client ID, even when
    the token was requested for the `api://` URI. (Corrected 2026-10-24: the first draft also allowed
    the URI, which would have refused every real token.);
  - `exp`/`nbf` with 60 s clock tolerance;
  - `roles` contains `Agent.Run`.
- **App registration**: the API app registration defines the app role `Agent.Run` with
  `allowedMemberTypes: [User, Application]`. People get it through user or group assignment,
  other systems through an app-role assignment to their service principal.
- **People's tokens**: the app exposes the delegated scope `user_impersonation` and pre-authorizes
  the Azure CLI for it, so a person assigned `Agent.Run` runs
  `az account get-access-token --scope api://app-l1-eastus2-dev/user_impersonation`. App roles assigned to
  a user appear in `roles` of a delegated token. Without a scope and a pre-authorized client, only
  service principals (client credentials) could get a token. (Added 2026-10-24; first confirmed live
  in T060.)
- **Requester key**: `tid` + `oid`. The kind comes from `idtyp` (`app` → service, otherwise user).
- **Error mapping**: a missing, invalid or expired token, or the wrong audience, issuer or tenant,
  → 401. A valid token without the role → 403.
- **Local runs**: `NETWORK=local` may set `AUTH_JWKS_FILE`, a JWKS from `npm run dev-token`, and
  issuer `urn:x402:dev-issuer`. On any other network that variable is a startup error, the same
  pattern as the dev bearer tokens (CFG-2).
- **Rationale**:
  - One verification path serves people and service identities (clarification Q2).
  - Tests can use a local JWKS, so they run offline.
  - The requester credential never reaches L2/L3 (FR-009): the middleware strips the
    `Authorization` header from everything downstream, and the port adapters only ever send
    `CONTROL_TOKEN`/`VERIFIER_TOKEN`.
- **Alternatives considered**:
  - Container Apps built-in authentication (Easy Auth): it can't be tested in-process, and it
    still leaves the role check to the app.
  - Mastra's auth providers: only for the Mastra server, which we don't run.
  - `@mastra/auth` `verifyJwks`: it wraps the same idea with a less familiar surface.
- **Sources**: https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
  (`aud`: "In v2.0 tokens, this value is always the client ID of the API").

## R7. How are sessions bound to requesters (FR-015, FR-016)?

- **Decision**: A stateless, HMAC-bound session reference:
  `sr1.<sessionId>.<mac>`, where
  `mac = base64url(HMAC-SHA256(SESSION_REF_SECRET, "sr1|" + tid + "|" + oid + "|" + sessionId))`.
  - New runs get `sessionId = sess_` + 16 random hex characters.
  - A request carrying `sessionRef` is verified in constant time against the caller's
    `tid`/`oid`. A mismatch, or a well-formed reference made for someone else, → 404
    `unknown session`.
  - Anything shaped like a raw session ID (`sess_…`) or a malformed reference → 400.
  - `SESSION_REF_SECRET` (32+ random bytes) lives only in L1's Key Vault.
- **Rationale**:
  - No storage needed, so it survives restarts and scale-to-zero.
  - A requester can't forge a reference to another requester's session, and the 404 doesn't
    reveal whether the session exists.
  - Rotating the secret invalidates old references, which is acceptable: sessions are short.
- **Alternatives considered**:
  - A stored session table (Postgres or Table Storage): it adds storage and an identity grant.
  - Using Mastra memory threads with `resourceId`: it would bring memory, and memory can add tools
    (R3).

## R8. Where are the requester limits enforced (FR-014)?

- **Decision**: An in-memory limiter in the agent service: 2 concurrent runs and 20 run starts per
  sliding hour per requester key → 429 with `Retry-After`. The agent container app runs with
  `minReplicas: 0`, `maxReplicas: 1`.
- **Rationale**:
  - With one replica the limits are exact.
  - Runs mostly wait on the model and on L2, so one Node process handles many runs concurrently.
  - Scale-to-zero meets NFR-006.
  - The spec's "scales out" edge case is amended accordingly.
- **Alternatives considered**: a shared counter in Azure Cache for Redis or Table Storage,
  deferred until scale-out is needed.

## R9. Where does the code live (NFR-002, INV-1, INV-3)?

- **Decision**:
  - **The parts.** A new folder `src/layer1-intent/hosted/` holds the hosted agent's parts:
    `server.ts` (only `createHostedApp`), `agent.ts`, `model.ts`, `requester-auth.ts`,
    `session-ref.ts`, `run-limits.ts`, `run-log.ts` and `config.ts`. They reuse the L1
    orchestrator, the port adapters, and `systemPrompt`, `AGENT_TOOLS` and `toToolResult` from
    `src/layer1-intent/agent.ts`.
  - **The entry point.** `src/hosted-main.ts` is a composition root beside `src/main.ts`, run by
    `npm run agent:hosted`. Its order is the same as `main.ts`: `loadEnv("l1-hosted")` (a file
    read, no network), then the payer-key refusal, then config, ports, model, and listen. The
    `REFUSAL` text moves into `src/layer1-intent/refusal.ts` so both roots share it.
- **Rationale**:
  - **Rule A5.** It bans `PAYER_PRIVATE_KEY`, as an identifier or a string, in every file under
    `src/layer1-intent/`. So the refusal check can't live in the layer; it lives in a root outside
    it, exactly like `src/main.ts`.
  - **Load before checking.** Loading the env file first and checking right after catches a key
    placed in `env/l1-hosted.env` as well as one in the process environment (INV-3).
  - **A1 still holds.** The parts reach L2/L3 only through `ports-http.ts`, and the root imports
    only L1 and shared code.
  - **The SEC-8 check covers it.** The existing check ("L1 never references operator routes or
    the operator token") already walks `src/layer1-intent/`, so the new folder is covered.
- **Alternatives considered**:
  - Everything, including `main()`, in `src/layer1-intent/hosted/server.ts`: it trips A5.
  - Checking the key before loading the env file: it misses a key in the file (`/speckit-analyze`
    findings C1 and C2).

## R10. Cloud topology (FR-018–FR-022, clarification Q1)

- **Decision**:
  - **Environment.** One workload-profiles Container Apps environment (Consumption profile) on a
    custom VNet, *external*, so the agent can have public ingress. Peer-to-peer encryption is on.
  - **Apps in the environment**:
    - `ca-l1-eastus2-dev`: external ingress, target port 4024;
    - `ca-l2-eastus2-dev`: internal ingress (`external: false`);
    - `ca-l3-eastus2-dev`: internal ingress;
    - the jobs `caj-l1-eastus2-dev` and `caj-l2-eastus2-dev` (R17, R18).
  - **The seller.** The demo seller `ca-seller-eastus2-dev` and its alias `ca-seller-alias-eastus2-dev` (R17) run in a
    **second** environment, so they can't reach the internal apps.
  - **Internal calls** use `http://<app>.internal.<environment-domain>`, with `allowInsecure:
    true` on the internal apps. The platform still encrypts the hop. A maintainer recommended the
    full internal FQDN after short names proved flaky from jobs.
  - **Identities and vaults.** One user-assigned identity and one Key Vault per runtime unit:
    `id-l1-eastus2-dev/kv-l1`, `id-l2-eastus2-dev/kv-l2`, `id-l3-eastus2-dev/kv-l3`, `id-op-eastus2-dev/kv-op` and `id-seller-eastus2-dev/kv-seller`. Each
    identity gets Key Vault Secrets User on its own vault only, plus AcrPull on the registry.
    `id-l1-eastus2-dev` alone also gets Cognitive Services User on the Foundry resource.
  - **Identity lifecycle.** `None` for `id-l2-eastus2-dev`, `id-l3-eastus2-dev`, `id-op-eastus2-dev` and `id-seller-eastus2-dev`: platform use
    only, for Key Vault references and image pull, so no container can request a token at run
    time. `Main` for `id-l1-eastus2-dev`, which needs Foundry tokens.
  - **Other resources**: Azure Container Registry, Log Analytics, and a premium NFS file share for
    the L2 ledger (R12).
  - **Key Vault network access.** Each vault denies by default and has a VNet rule for its unit's
    subnet: `snet-x402-eastus2-dev` for the main environment, `snet-seller-eastus2-dev` for the counterparty environment,
    which gets its own subnet for this. Both subnets have the `Microsoft.KeyVault` service
    endpoint. Seeding secrets by hand needs a temporary IP rule for the operator: `seedIp`, set
    through Bicep on one platform-only run and removed by the next (revised 2026-11-02). *To verify* in quickstart §4 that Key Vault references resolve through the VNet
    rule.
- **Rationale**:
  - An internal-ingress app is "reachable only from other apps in the same environment", which
    excludes the rest of the VNet and other environments. That is why the seller lives in its
    own environment.
  - Every container in an app can use the app's identities. The only control is the identity
    `lifecycle`, so `None` is what keeps L2's proxy sidecar (R11) from using `id-l2-eastus2-dev`. *To verify*
    in quickstart §4: a token request from inside `ca-l2-eastus2-dev` must fail, and the Key Vault
    references must still resolve.
- **Alternatives considered**:
  - A separate environment per layer (clarification option C, not chosen).
  - AKS: more control, much more to operate.
  - App Service: no internal-only ingress between apps without VNet integration and private
    endpoints for each.
- **Sources**:
  - https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview
  - https://learn.microsoft.com/en-us/azure/container-apps/connect-apps
  - https://learn.microsoft.com/en-us/azure/container-apps/managed-identity#control-managed-identity-availability
  - https://github.com/microsoft/azure-container-apps/issues/1491

## R11. How do callers reach a loopback-only L2/L3 (FR-019, Principle V)?

- **Decision**: L2 and L3 keep binding `127.0.0.1`, with no code change. Each runs with a sidecar
  `nginx-unprivileged`, pinned by digest, that listens on `0.0.0.0:8080` and forwards to
  `127.0.0.1:4020` (L2) or `127.0.0.1:4023` (L3). Sidecar rules:
  - It gets no env vars and no secrets.
  - Its access log leaves out `Authorization`.
  - It limits the request body to 256 KB, matching L2's JSON limit.
  - It serves `GET /healthz` by proxying an unauthenticated `GET /v1/escalations` (L2) or
    `POST /v1/settlements` (L3) and mapping an upstream **401** to 200: "the guard answered". A
    502 (upstream down) stays a failure.
- **Rationale**:
  - Containers in one app share the network namespace, so loopback reaches across them.
  - The code invariant (`CONTROL_BIND_HOST` is not configurable, NFR-001) is unchanged.
  - The sidecar is also the natural place for EXT-7 mTLS later.
  - Using the 401 answer as health proves L2 is up and enforcing auth, with no token in the
    sidecar.
- **Alternatives considered**:
  - Making the bind host configurable (`0.0.0.0` in containers): it changes a SPEC invariant and
    would also widen local runs.
  - A Node proxy written by us: more code on the trust boundary than a well-known proxy.
  - Envoy: more configuration than needed until EXT-7.
- **Constitution impact**: Principle V's wording holds, but who can reach L2 widens from "same
  host" to "same private environment". See the Constitution Check and Complexity Tracking.

## R12. One L2 writer during revision updates (FR-020, INV-8, INV-9)

- **Decision**: Add a **ledger lock** to L2's `main()` (new SPEC L2-6):
  - **Acquire before loading.** `main()` takes `<ledger>.lock` with an exclusive create
    (`O_CREAT|O_EXCL`) before it loads and verifies the ledger. The lock file holds
    `{holder, pid, host, acquiredAt, heartbeatAt}`.
  - **Heartbeat.** The holder refreshes `heartbeatAt` every 5 s with an atomic write-then-rename.
  - **Release.** It deletes the lock on `SIGTERM` or `SIGINT` before exiting.
  - **Standby.** While another holder's heartbeat is fresh (< 30 s old), L2 waits in standby,
    polling every 1 s and logging once. After 30 s without a heartbeat it treats the lock as
    stale, takes it over and logs the takeover.
  - **Where the ledger lives in Azure.** On a premium **NFS** Azure Files share.
  - **Probes.** L2's container-app probes are TCP checks on the sidecar port, so a standby
    replica counts as ready and the platform can retire the old revision.
- **Rationale**:
  - **Overlap is unavoidable.** In single revision mode the old revision keeps running until the
    new one is ready, so with min = max = 1 two L2 replicas briefly run together. No supported
    stop-then-start exists. Two writers would fork the hash chain, so the single writer must be
    enforced in L2.
  - **Standby avoids a deadlock.** A new replica that waits for the lock *and* reports not-ready
    would block the old one forever.
  - **NFS, not SMB.** Microsoft documents NFS shares as fully POSIX-compliant. Exclusive create
    and append on SMB aren't documented for Container Apps.
  - **Locally**, the lock also stops a second `npm run l2:control` on the same ledger.
  - **Tests and the harness are unaffected**: they never call `main()`.
- **Limits** (accepted, written into L2-6):
  - Takeover assumes at most one live contender. That holds for one app with `maxReplicas: 1`;
    two simultaneous takers of a stale lock could race.
  - During the handover (seconds, or up to 30 s after a crash), calls to L2 get 502 from the
    sidecar. L1 reports `ERROR` and nothing is paid.
- **Alternatives considered**:
  - Deploy ordering only (multiple-revision mode with deactivate-then-activate): nothing would stop
    a manual restart or a mis-set replica count.
  - A blob lease: it brings a storage SDK and a credential into the process that holds the payer
    key.
  - `flock`: needs a native module.
- **Sources**: https://learn.microsoft.com/en-us/azure/container-apps/revisions#zero-downtime-deployment,
  https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts,
  https://learn.microsoft.com/en-us/azure/storage/files/files-nfs-protocol.

## R13. Telemetry and logs (FR-025, FR-026, SEC-16)

- **Decision**: No Mastra observability, no OpenTelemetry SDK, and `MASTRA_TELEMETRY_DISABLED=1`
  set in the container anyway.
  - The agent service writes one JSON log line per run step and one per run. They carry `runId`,
    requester `tid`/`oid`, `sessionId`, the tool, `intentId` (when there is one), `authorizationId`,
    outcome and duration.
  - They never carry headers, tokens, the session reference's MAC, the goal text or tool `body`
    contents.
  - Container stdout goes to Log Analytics.
  - **The post-deployment scan is shape-based.** It runs over the Log Analytics rows of the
    regression window and looks for credential shapes (new `scripts/secret-scan-lib.ts`): JWTs,
    `Bearer` values, PEM blocks, `PAYMENT-SIGNATURE`/`x-api-key` header values, and `NAME=value`
    assignments for `*_PRIVATE_KEY`, `*_SECRET` and `*_TOKEN`.
  - **Why not search for the actual values?** The existing `containsCdpSecret` search needs the
    values themselves. The workflow runner must not hold L2's secrets, and raw bearer tokens have
    no recognizable shape.
  - **How completeness is proven instead**: offline, T-AGT-05 plants known values (a requester
    token, the agent tokens) and checks that none appears in any log line. That is the same
    known-value approach as `demo:base-sepolia`.
- **Rationale**:
  - In library use, Mastra's PostHog code (server and CLI only) never runs, and tracing is no-op
    unless configured.
  - The ledger already gives the L2 side of the trace (`intentId`, `authorizationId`).
  - Leaving out the goal text keeps requester prompts out of logs.
  - Full cross-layer OpenTelemetry stays EXT-8.
- **Sources**: https://mastra.ai/reference/observability/tracing/configuration,
  https://mastra.ai/reference/cli/mastra#telemetry, `packages/core/src/telemetry/*` at 1.75.0.

## R14. Build and container images

- **Decision** (revised 2026-10-25: one image per layer, at the owner's request; first decided as one image
  for every process):
  - **One image per layer, plus the seller's.** Each app and job runs from its own unit's image
    (T-IAC-01 rule 12):

    | Image | Dockerfile | Entry points | Runs in |
    |---|---|---|---|
    | `x402-l1-agent` | `docker/l1-agent.Dockerfile` | `src/hosted-main.ts`, `src/main.ts` | `ca-l1-eastus2-dev`, `caj-l1-eastus2-dev` |
    | `x402-l2-control` | `docker/l2-control.Dockerfile` | `src/layer2-control/service.ts`, the four operator scripts | `ca-l2-eastus2-dev`, `caj-l2-eastus2-dev` |
    | `x402-l3-verifier` | `docker/l3-verifier.Dockerfile` | `src/layer3-settlement/service.ts` | `ca-l3-eastus2-dev` |
    | `x402-seller` | `Dockerfile` (root) | `src/counterparty/seller.ts` | `ca-seller-eastus2-dev`, `ca-seller-alias-eastus2-dev` |

  - **What an image holds.** `scripts/image-closure.ts` is the table above. esbuild walks the import
    graph of the image's entry points in the TypeScript sources, and the script copies only those
    compiled files and writes a `package.json` with only the packages they import. Each image's
    packages are installed with `npm install --omit=dev` against the full lockfile, so versions match
    the repository. The build fails when the graph reaches a file outside the image's folders, or a
    package that isn't a runtime dependency. A package resolved at run time (`createRequire`) must be
    listed in the image's `extraPackages`; L2 lists `swagger-ui-dist`. The runtime stage then imports
    every module once, so a missing file or package fails the build, not a revision start.
  - **Build stage**: `npm install`, `tsc -p tsconfig.build.json`, then the closure script.
  - **Runtime stage**: `node:22-bookworm-slim` pinned by digest (the same digest in all four), a
    non-root user. Only the L2 image adds `config/`, `docs/l2-control.openapi.yaml` (as
    `dist/docs/`, where the API-docs module looks for it) and `/app/.local` for the NFS ledger.
  - `engines.node` becomes `>=22.13`, Mastra's floor.
- **Rationale**:
  - The services run TypeScript through `tsx` today, and `tsx` is a dev dependency. A compiled
    `dist/` keeps dev tools (ganache, solc, vitest) out of the images.
  - `npm install`, not `npm ci`, because of the lockfile quirk (CLAUDE.md). On Linux, darwin-only
    `fsevents` is skipped.
  - Identities, env and network remain the primary isolation, and no image holds a key. Per-layer
    images add code isolation on top: the L1 and L3 images don't contain the signer, and the L2 and
    L3 images contain no agent framework or model SDK (T-IMG-01). Each image is also smaller. On
    2026-10-25 the one shared image was 874 MB; the four are L1 640 MB, L2 539 MB, L3 512 MB and the
    seller 585 MB.
- **Alternatives considered**:
  - `tsx` in production: ships a dev toolchain.
  - Node's built-in type stripping: the code imports `.js` specifiers that point at `.ts` files,
    which type stripping doesn't rewrite.
  - One image for every process (the first decision): simpler builds, but every process carries
    every layer's code and packages.
  - Bundling each entry point into one file: smaller still, but production would then run bundled
    copies of Mastra and the SDKs instead of the same modules the tests and the demo load.

## R15. Infrastructure as code and its test (FR-010, FR-023, T-IAC-01)

- **Decision**: Bicep under `infra/`: `main.bicep` with modules for network, environment,
  identities, vaults, storage, registry, apps and jobs.
  - **T-IAC-01** compiles it with `@azure/bicep-rpc-client` 0.4.1 (dev only; `bicep-node` is
    deprecated) and the Bicep CLI 0.47.16. It then asserts on the ARM JSON:
    - each identity has role assignments only on its own vault (plus AcrPull, and Foundry for
      `id-l1-eastus2-dev`);
    - `PAYER_PRIVATE_KEY` is referenced only by `ca-l2-eastus2-dev`'s `l2` container;
    - `ca-l2-eastus2-dev` and `ca-l3-eastus2-dev` have `external: false`;
    - `ca-l2-eastus2-dev` has `maxReplicas: 1`;
    - the sidecars get no env;
    - identity lifecycles match R10.
  - **Where it runs.** The npm package doesn't ship the CLI. The test runs when `BICEP_PATH` is
    set and is skipped with a message otherwise; the deploy workflow always sets it, so it is
    mandatory before every deployment. This is the same pattern as the opt-in T-E2E-06.
- **Rationale**:
  - Bicep is Azure-native with no state file to manage.
  - Asserting on the compiled JSON tests what is actually deployed.
- **Alternatives considered**:
  - Terraform: a state backend and another toolchain.
  - Parsing the Bicep source text: fragile.
  - `what-if` only: needs Azure credentials and can't run in `npm test`.
- **Sources**: https://github.com/Azure/bicep-deploy (`packages/bicep-rpc-client`), npm registry.

## R16. Deployment pipeline (FR-023, FR-024)

- **Revised 2026-11-02, at the owner's request** (supersedes the decision below where they differ):
  - **Bicep only.** All Azure provisioning is Bicep: `infra/pre-deploy.bicep` (subscription scope,
    deployed by an administrator by hand) makes the resource group, the API and deploy app
    registrations with their service principals (Microsoft Graph Bicep extension v1.0:1.0.0), the
    deploy app's federated credential, `Agent.Run` assignments, the operators' group and the deploy
    app's roles; `infra/main.bicep` makes everything in the resource group, the Claude model
    deployment, the vault seed IP and vault recovery included. Even the agent's traffic moves through
    `main.bicep`. Bicep can't create a client secret, so the deploy app signs in with OIDC again
    (federated credential, no secret).
  - **One template, one workflow.** The unit templates are merged into `main.bicep`, deployed by one
    workflow, `deploy.yml`, from one commit: platform first, then the four images, then everything.
    Every layer ships together again and shares one `last-good`. Its modules take names, not other
    modules' outputs, so what-if previews a first deployment fully (32 creates platform-only, 40 in all).
  - **Every value in the parameter files.** `pre-deploy.<env>.bicepparam` and `main.<env>.bicepparam`
    hold the target (tenant, subscription, resource group, location), the GitHub repository and
    environment, the app IDs and the public addresses. Each template fails validation anywhere else.
    The workflow reads its sign-in and target from the parameter file and no GitHub secret;
    `env/infra.env` is gone.
  - **Why**: one place for every value, one tool for provisioning, and a what-if that shows the whole
    change before each deployment. The cost: a change to one layer redeploys the template for all, and
    the layers no longer ship separately.
- **Decision** (revised 2026-10-25 at the owner's request: one pipeline for the platform and one per
  layer; first decided as one workflow, `deploy-azure.yml`, for everything):
  - **Four GitHub Actions workflows**, each run by hand or by its own tag, all signing in to Azure
    with the deploy app's client ID and client secret, and sharing one concurrency group (revised
    2026-10-27 at the owner's request; first decided as OIDC with a federated credential, which
    stores no credential in GitHub). They read seven GitHub secrets: the client secret, and
    identifiers or public addresses kept as secrets so the logs mask them. The application's
    credentials stay in the Key Vaults (contracts/deploy-pipeline.md). The workflows:
    - **`deploy-infra.yml`** deploys the platform (`infra/main.bicep`). It then builds the seller's
      image and deploys the sellers (`infra/seller.bicep`); the seller is the counterparty, test
      infrastructure rather than a layer.
    - **`deploy-l1.yml`, `deploy-l2.yml` and `deploy-l3.yml`** call the shared `deploy-layer.yml`,
      which builds that layer's image and deploys that layer's template (`infra/<image>.bicep`).
  - **Platform only in `main.bicep`.** Each unit template finds the platform's resources by name
    through `modules/platform.bicep`, and asks for its own identities and vaults only (T-IAC-01
    rule 13). An app's configuration and its code therefore ship together, from one commit.
  - **Layer steps:**
    1. typecheck and `npm test`;
    2. T-IAC-01 on every template;
    3. the layer's image, tagged with the commit SHA;
    4. `az deployment group what-if`, then `create` of its template with that tag;
    5. wait for the layer (L2: its lock handover);
    6. start `caj-l1-eastus2-dev` and require exit 0;
    7. the hosted smoke check and the Log Analytics secret scan;
    8. promote: the agent's traffic for L1, and the image's `last-good` tag for every layer.
  - **The agent app** runs in multiple-revision mode. A new revision gets 0% traffic and a label
    until checks pass, so the previous agent keeps serving.
  - **L2, L3 and the seller** run in single-revision mode. On failure their pipeline redeploys that
    unit's `last-good` image (FR-024 as amended).
- **Rationale**:
  - Every deployment is reproducible from one commit, and each unit records its own `last-good`.
  - A layer ships without rebuilding or restarting the others. That matters most for L2, whose
    lock handover makes every deployment a short standby.
  - The layers can run different commits, so each layer run repeats the regression through all of
    them; the infra run repeats it too once the layers exist. The baseline still gates every release.
  - The agent can stay blue-green, but L2 cannot, because only one copy may write (R12).
- **Alternatives considered**:
  - One workflow for everything (the first decision): every change redeploys every unit.
  - Infra owns all the Bicep and layer pipelines only roll images: an app's configuration would then
    ship apart from its code.
  - Deploying from a developer machine with `azd`, which isn't reproducible or gated.

## R17. How does the baseline plan run in the cloud (FR-024, T-E2E-AZ)?

- **Decision**: `caj-l1-eastus2-dev` is a manual Container Apps Job in the main environment. It runs
  the existing scripted agent (`node dist/src/main.js --scripted --check-baseline`) with L1 credentials:
  - **Identity.** It uses `id-l1-eastus2-dev` with lifecycle `None` for this job; it reads only `kv-l1`
    secrets through references.
  - **Calls.** It calls L2 and L3 by internal FQDN, and the seller by its public FQDN.
  - **Step 6.** It needs a host the seller answers on that isn't allow-listed. `localhost`
    doesn't reach anything from a cloud job, so `scriptedPlan` gains an optional `SELLER_ALIAS_URL`
    (default: today's `localhost` rewrite). In Azure that URL is `ca-seller-alias-eastus2-dev`, the same
    seller image and config on a second FQDN, scaled to zero when idle.
  - **Pass criteria** match `demo:base-sepolia`: the six outcomes, two CONFIRMED settlements, a
    verified chain (through the operator job) and a clean secret scan.
  - **Hosted smoke.** The workflow then calls the new agent revision with a service-identity
    token and the default goal, and expects two PAID, CONFIRMED purchases.
- **Rationale**:
  - The scripted plan is deterministic and has no LLM, so it is the right gate.
  - The hosted smoke proves the HTTP, auth and model path.
  - A second seller FQDN keeps the meaning of "same resource, different host".
- **Alternatives considered**:
  - A custom domain for the seller: needs DNS and certificates.
  - Changing the cloud baseline's step 6 expectation to `ERROR`: that would change the baseline.
- **Security**: holding `Microsoft.App/jobs/start/action` on `caj-l1-eastus2-dev` is equivalent to
  holding L1's credentials, because a start can override the template. Only the deploy identity
  gets it.
- **The challenge's scheme behind ingress**: the x402 Express adapter builds the challenge's
  resource URL from `req.protocol`. Behind Container Apps' TLS-terminating ingress the cloud
  seller therefore advertises `http://<fqdn>/…`, while L1 requests `https://<fqdn>/…`. Nothing is
  denied, because R7 compares hosts only (`URL.host`, with default ports omitted), and the
  approval key is the URL L1 requested. Setting `trust proxy` in the seller would align the
  scheme, but that is a counterparty change and is left out of this feature.
- **Gating on the outcomes**: `npm run agent:scripted` exits 0 whatever the outcomes. So the job
  runs `node dist/src/main.js --scripted --check-baseline`, which compares the six outcomes and
  the two CONFIRMED settlements with L1-4 and exits 2 on any mismatch.

## R18. Operator path (FR-021, SEC-8)

- **Decision**: `caj-l2-eastus2-dev` is a manual Container Apps Job in the main environment. It runs
  `dist/scripts/{approve,reject,escalations}.js` from per-start `--command`/`--args`, with `id-op-eastus2-dev`
  and `OPERATOR_TOKEN` from `kv-op`.
  - **Who can start it.** Only the operators' Entra group gets the job-start role on it.
  - **Watching.** `escalations --watch` runs as a long execution, and the operator follows it
    with `az containerapp job logs show --follow`.
  - **Overrides.** Each start passes `--container-name`, `--image` and the `secretref:` env along
    with the args, because an override replaces the whole template.
- **Rationale**:
  - It is private: the job runs inside the environment and L2 stays internal.
  - Nothing goes through the agent.
  - No VPN or jump box is needed: a P2S VPN gateway or Bastion costs around $140 a month, against
    cents per job run.
  - Azure RBAC on the job is the operator's authentication, and it can be audited in the
    activity log.
- **Alternatives considered**:
  - A P2S VPN or a jump box (more cost and more to maintain).
  - `az containerapp exec` into L2: it would put a shell in the container that holds the key.
- **Security**: as with R17, start rights on `caj-l2-eastus2-dev` equal holding `OPERATOR_TOKEN`. This is
  stated in SPEC §11 as a v1.5 residual risk.
- **Sources**: https://learn.microsoft.com/en-us/azure/container-apps/jobs,
  https://learn.microsoft.com/en-us/cli/azure/containerapp/job#az-containerapp-job-start.

## Dependency pins (newest stable at least 14 days old on 2026-10-21)

| Package | Version | Kind | Used by |
|---|---|---|---|
| `@mastra/core` | 1.75.0 (exact) | runtime | hosted agent (L1) |
| `@ai-sdk/anthropic` | 3.0.128 (exact) | runtime | hosted agent model (L1) |
| `zod` | 4.6.5 | runtime | tool input schemas (L1) |
| `jose` | 6.2.12 | runtime | requester token verification (L1) |
| `@azure/identity` | 4.13.3 | runtime | Foundry Entra tokens (L1, `foundry` only) |
| `ai` | 6.0.302 | dev | `MockLanguageModelV3` in tests |
| `@ai-sdk/provider` | 3.0.18 | dev | mock result types in tests |
| `@azure/bicep-rpc-client` | 0.4.1 | dev | T-IAC-01 |

`@mastra/core` also pulls `posthog-node`, `hono`, `ws`, `execa` and the A2A SDK as transitive
dependencies (161 packages, no install scripts). None of them runs in library use (R13).
