# Contract: hosted agent HTTP API (proposed SPEC L1-6)

**Names**: SPEC calls this unit the *hosted agent service*. Its env role is `l1-hosted`, its
Azure app is `ca-l1-eastus2-dev`, and its code lives in `src/layer1-intent/hosted/`.

The entry point is `src/hosted-main.ts`, a composition root beside `src/main.ts`, run with
`npm run agent:hosted`. It sits outside the layer because rule A5 bans `PAYER_PRIVATE_KEY` under
`src/layer1-intent/`. `src/layer1-intent/hosted/server.ts` only builds the Express app. It listens on `AGENT_PORT`, default 4024: on `0.0.0.0` in a container and
on `127.0.0.1` locally (`AGENT_BIND_HOST`, default `127.0.0.1`). These are the only routes, plus the docs routes below with `API_DOCS=1` (v1.6). Mastra
publishes no routes (research R1).

## Startup (in this order)

1. Load env (`ENV_FILE`, default `env/l1-hosted.env`). This is a file read only, with no network
   activity.
2. If `PAYER_PRIVATE_KEY` is now visible, whether from the process environment or from the file:
   print the shared `REFUSAL` text and exit 1. Nothing else happens before this check (INV-3,
   FR-007), the same order as `src/main.ts`.
3. Validate the config. See
   [model-access](model-access.md) and [access-and-sessions](access-and-sessions.md). Any error
   exits 1 with a message that never echoes a secret.
4. Build the model, the agent and the port adapters, then listen.

## `POST /v1/runs`

- **Auth**: a bearer token, checked before the body is read. Since SPEC v1.12 a person's is an Auth0 access token
  with the permission `agent:run` from a client on `AGENT_CLIENT_IDS`, and a system identity's an Entra app-only
  token with role `Agent.Run` ([access-and-sessions.md](access-and-sessions.md)). Since SPEC v1.13 the sign-in tenant
  has no client for this service: a deployed service has no `AGENT_CLIENT_IDS` and answers a person's token with
  401; only the local dev issuer gives a person's token that starts a run. Before: an Entra ID bearer token with role `Agent.Run`, checked before the body is read
  ([access-and-sessions](access-and-sessions.md)).
- **Body**: `{ "goal": string, "sessionRef"?: string }`, JSON, at most 16 KB.

Order of checks: requests per client address (429; SPEC v1.10) → auth (401/403) → limits (429) → body (400) → session
(400/404) → run. The per-address limit is 300 requests a minute, counted before the token is verified, so it also
bounds a caller without a valid token; `TRUSTED_PROXY_HOPS` (1 in Azure) makes the address the client's.

**200** when the run has ended, in any status:

```json
{
  "runId": "run_3f0c…",
  "sessionRef": "sr1.sess_9a1b2c3d4e5f6a7b.k2…",
  "status": "completed",
  "stopReason": null,
  "error": null,
  "finalText": "Receipts: …",
  "steps": [
    { "index": 1, "tool": "fetch_resource", "url": "https://seller…/api/catalog", "purpose": "read the catalog",
      "result": { "outcome": "FREE", "httpStatus": 200, "body": {}, "payment": null, "violations": null, "authorizationId": null, "error": null } },
    { "index": 2, "tool": "fetch_resource", "url": "https://seller…/api/weather?city=Lima", "purpose": "weather for Lima",
      "result": { "outcome": "PAID", "httpStatus": 200, "body": {},
                  "payment": { "authorizationId": "auth_…", "amountUsd": "0.001", "settlement": { "status": "CONFIRMED", "tx": "0x…", "finality": "safe" } },
                  "violations": null, "authorizationId": "auth_…", "error": null } },
    { "index": 3, "tool": "check_budget", "result": { "sessionId": "sess_…", "remainingAtomic": "94000", "…": "…" } }
  ],
  "startedAt": "2026-10-21T22:00:00.000Z",
  "finishedAt": "2026-10-21T22:00:41.000Z"
}
```

- `status`: `completed`, `stopped` (`stopReason`: `deadline`, `step_limit`; `client_disconnected`
  never reaches the client) or `failed` (`error` set). Steps finished before a stop or failure are
  always listed (spec edge cases).
- An ESCALATED purchase appears as a step with `outcome: "ESCALATED"` and its `authorizationId`
  (US1 scenario 2). The requester gives that ID to the operator, then calls again with the same
  `sessionRef` (US5).
- `sessionRef` is always present, for a new or a continued session.

**Errors** (body `{ "error": string }`; no model call and no L2/L3 call happens for any of them):

| Status | When |
|---|---|
| 400 | goal missing, empty or over 4,000 characters; unknown body field; malformed `sessionRef`; a raw `sess_…` ID |
| 401 | missing, malformed, invalid, expired, wrong-audience, wrong-issuer or wrong-tenant token |
| 403 | valid token that may not start a run. v1.12: a person's without `agent:run`, from a client not on `AGENT_CLIENT_IDS` (the portal's web app included), or a machine token; the directory's without `Agent.Run`, or a person's (013 SEC-20) |
| 404 | well-formed `sessionRef` that doesn't verify for this requester (`unknown session`) |
| 413 | body over 16 KB |
| 429 | more than 2 concurrent runs, or 20 starts in the last hour, for this requester; or (v1.10) more than 300 requests in a minute from this client address, on any route but health and the docs; `Retry-After` header set |
| 503 | not ready (startup not finished) |

## Run semantics

- Model: [model-access](model-access.md). Exactly two tools, `fetch_resource` and `check_budget`,
  with the L1-3 descriptions. The JSON schema sent adds `additionalProperties: false` (stricter
  than L1-3). At most 10 steps and at most 2048 output tokens per model call. System prompt:
  `systemPrompt(SELLER_URL)` (L1-3).
- `fetch_resource` calls `PaidResourceOrchestrator.fetchPaid(url, purpose)` with the run's
  `sessionId`. `check_budget` calls `gate.budget(sessionId)`. Tool results use `toToolResult`
  (L1-3).
- **Deadline 200 s.** An abort stops the run before its next step. A paid fetch already in
  progress completes (research R4, R5).
- **Client disconnect** aborts the same way. The response is not sent.
- `purpose` still goes to L2 only as audit text (INV-5). The requester's identity is not sent to
  L2 (FR-009).

## `GET /healthz` and `GET /readyz`

No auth. `/healthz` → 200 `{ "status": "ok" }` while the process runs. `/readyz` → 200
`{ "status": "ready" }` after startup, 503 `{ "status": "starting" }` before. Neither returns
configuration, versions or secrets (FR-027).

## API docs (v1.6, only with `API_DOCS=1`)

`docs/l1-hosted.openapi.yaml` describes this API in OpenAPI 3.1; this contract and SPEC L1-6 stay
normative, and `test/openapi-hosted.test.ts` (T-API-05..07) fails when the document and the service disagree.
With `API_DOCS=1` in `env/l1-hosted.env`, the agent also mounts `GET /docs` (Swagger UI), `GET /docs/:asset`
(its three files) and `GET /openapi.yaml` (the document, with `servers` set to `/`). Like the health routes they
take no token and sit before auth. They serve files read at startup and never reach the model, a session, L2 or
L3; the page's CSP limits scripts and requests to the agent's origin (SEC-13). Off by default, and the Azure
deployment never sets `API_DOCS` (T-API-08).

## Anything else

Any other method or path → 404 `{ "error": "not found" }`, after auth. Unauthenticated callers get
401 for every path except the two health routes, so the 404 doesn't reveal which routes exist.

## Logs (research R13)

There is one JSON line per step:
`{ "event": "step", "runId", "requester": "<issuer host>:<sub>" (a person, v1.12) or "tid:oid" (a system identity), "sessionId", "index", "tool", "outcome", "intentId"?, "authorizationId"?, "ms" }`.
There is one line per run: `{ "event": "run", "runId", "requester", "sessionId", "status", "stopReason", "steps", "ms" }`.
They never include headers, tokens, the `sessionRef` MAC, the goal, `purpose`, or a response
`body`.

## Tests (T-AGT-05)

- **Deadline**: with a short test deadline (300 ms), a mock model that calls `fetch_resource` at
  once, and a fake gate whose `authorize` takes about 1 s, the run returns `status: stopped` and
  `stopReason: deadline`. The fetch that was in progress at abort time still completes and is
  listed with its result, and no further model call happens.
- **Step limit**: a mock model that always calls a tool stops after 10 steps with
  `stopReason: step_limit`.
- **Client disconnect**: no new step starts after the client disconnects.
- **Health**: `/healthz` answers 200 at once. `/readyz` answers 503 until startup completes,
  then 200. Neither body contains config values.
- **Response shape**: the response matches the shape above, for completed, stopped and failed
  runs.
- **Log redaction**: every log line is JSON with only the whitelisted keys. A bearer token planted
  in a tool error and in the request header never appears in captured stdout or stderr, and the
  `demo:base-sepolia` secret-scan patterns find nothing.

## v1.10 (013): the user a run pays for

- For a requester of kind `user`, every `PaymentIntent` of the run carries `userId = userIdFor(issuer, sub)` (v1.12; `userIdFor(tid, oid)` before)
  (`src/shared/user-id.ts`), and `check_budget` asks L2 for that user's view. For kind `service` (an `idtyp: app`
  token), no user: with user accounts on, L2 decides those runs against the platform account, as before.
- The value is fixed when the run starts, from the verified token. The request body still takes only `goal` and
  `sessionRef`; the two tools' input schemas are unchanged, and no model text or tool input can change the user
  (T-AGT-06).
- Details: `specs/013-l2-portal-onboarding/contracts/portal-api.md` "Hosted agent delta".
