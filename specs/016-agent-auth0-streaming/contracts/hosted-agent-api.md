# Contract: the hosted agent's API (delta to SPEC L1-6 and `specs/011` contracts/hosted-agent-api.md)

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

> **2026-11-26, extended by feature 021** ([specs/021 contracts/hosted-agent-api.md](../../021-bazaar-discovery-search/contracts/hosted-agent-api.md),
> SPEC v1.31): in search mode a step can also be a search step, `{ index, tool: "search_resources", query, result }`,
> in the JSON answer and in the stream's `step` and `result` events alike; the request body is unchanged, so a field
> for the mode is 400 `unknown field` like any other. Test mode is this contract as it was.

What changes on the hosted agent's HTTP API. Everything not named here is unchanged.
`docs/l1-hosted.openapi.yaml` changes with it, and T-API-05..08 fail until both match the service.

## Who is accepted

One issuer, `AUTH_ISSUER` (the sign-in tenant; locally the dev issuer with `AUTH_JWKS_FILE`). The token's `iss`
is no longer read first to choose a set of checks: there is one set
([research R2](../research.md#r2-one-caller-check-shared-by-l1-and-l2)).

| # | Check | Refusal |
|---|---|---|
| 1 | `Authorization: Bearer <token>` present | 401 `{ "error": "unauthorized" }` |
| 2 | Signature (the tenant's keys, RS256; the dev issuer's file, ES256), `iss`, `aud` contains `AUTH_AUDIENCE`, `exp`/`nbf` with 60 s tolerance, a usable `sub` | 401 |
| 3 | Machine token (client credentials): `sub` is `<client>@clients` for the client the token names, and it carries `agent:run` | 401 when `sub` and the client disagree; 403 `{ "error": "forbidden" }` without the permission |
| 4 | Person's token: it carries `agent:run`, and its client is on `AGENT_CLIENT_IDS` | 403 |

A token from the organization's directory fails check 2 (another issuer). The body is not read, and no model,
L2 or L3 call is made, before all four pass. The per-address limit still runs before them, and since v1.27
(`specs/017`) so does the failed-authentication limit: 20 answers with 401 per address in a minute, then 429
`{ "error": "too many requests" }` with `Retry-After` until the minute ends, whatever the token. Every 401
carries `WWW-Authenticate: Bearer realm="x402-agent"`, with `, error="invalid_token"` when a token was sent and
failed a check (RFC 6750 §3); a 403, 421 or 429 carries none.

v1.27 (`specs/017`): with the local dev issuer the service serves the machine it runs on only. It refuses to start
off a loopback bind or with `TRUSTED_PROXY_HOPS` above 0, and before any route answers
`421 { "error": "misdirected request" }` to a request whose `Host` is not a loopback name or that carries
`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `Via`. The full table is in
[017 contracts/hosted-agent-edge.md](../../017-dast-findings-remediation/contracts/hosted-agent-edge.md).

**The requester.** `kind` is `user` for a person and `service` for a machine caller; `authority` is the issuer
for both; `subject` is the token's `sub`. The key for limits and logs is `<issuer host>:<sub>` for both. A
session reference is bound to the three as before, so a machine caller's reference issued before this feature
(bound to a directory tenant) no longer verifies; a person's still does.

**The caller's token after verification.** It is kept for the run, in memory, and sent to L2 only
([control-api.md](control-api.md#the-callers-token)). It is not deleted from the request any more; it is never
logged, never part of a step, an event or an answer, and never passed to the model, a tool input, L3 or the
seller.

## `POST /v1/runs`

**Request.** Unchanged body (`goal`, optional `sessionRef`). One request header now matters:

| `Accept` | Answer |
|---|---|
| contains `text/event-stream` | a stream of server-sent events (below) |
| anything else, or absent | the JSON object of today, unchanged |

**Refusals** (401, 403, 429, 400, 413, 404 for an unknown session) are the same JSON answers with the same
statuses in both forms: a stream starts only once the run does.

### The stream

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

Events, each `event: <name>` and one `data:` line of JSON, in this order:

| Event | When | `data` |
|---|---|---|
| `run` | once, first, as soon as the run is accepted | `{ "runId": "run_…", "startedAt": "<ISO time>" }` |
| `text` | whenever the model writes text | `{ "delta": "<text>" }` |
| `step` | once per finished tool call, in completion order | the step exactly as `steps[]` lists it: `index`, `tool`, `url`, `purpose`, `result` |
| `result` | once, last | the JSON answer's object: `runId`, `sessionRef`, `status`, `stopReason`, `error`, `finalText`, `steps`, `startedAt`, `finishedAt` |

- `text` events carry everything the model writes, including what it writes before calling a tool.
  `result.finalText` is the final answer, as in the JSON form, and is the value to keep.
- A line `: keep-alive` is sent whenever 15 seconds pass with nothing else sent.
- After `result` the response ends. Every way a run can end is a `result`: `completed`, `stopped` (with
  `deadline`, `step_limit` or `client_disconnected`) or `failed` (with `error`).
- The stream carries nothing the JSON answer does not: no token, no model reasoning, no tool input other than
  a step's `url` and `purpose`.
- The deadline (200 s), the limits, the step limit, the abort on disconnect and the rule that a paid fetch in
  progress completes are the same. A caller that disconnects receives nothing more; the run log line is
  written as today.

```text
event: run
data: {"runId":"run_0b6c…","startedAt":"2026-11-15T10:00:00.000Z"}

event: text
data: {"delta":"I'll look at the catalog first."}

event: step
data: {"index":1,"tool":"fetch_resource","url":"http://127.0.0.1:4021/api/catalog","purpose":"Browse the catalog","result":{"outcome":"FREE","httpStatus":200,"body":{}}}

: keep-alive

event: text
data: {"delta":"Lima: 18 °C"}

event: result
data: {"runId":"run_0b6c…","sessionRef":"sr1.…","status":"completed","stopReason":null,"error":null,"finalText":"Lima: 18 °C …","steps":[],"startedAt":"…","finishedAt":"…"}
```

## API docs (`API_DOCS=1`)

- `GET /docs`, `GET /docs/:asset`, `GET /openapi.yaml` stay token-free and static. One asset is added,
  `oauth2-redirect.html` with its script `oauth2-redirect.js`, both from the pinned Swagger UI package.
- With `API_DOCS_CLIENT_ID` set (it must be on `AGENT_CLIENT_IDS`, and `AUTH_ISSUER` must be a tenant, not the
  dev issuer), the served document gains an OAuth2 scheme (authorization code, PKCE) whose addresses are
  `<AUTH_ISSUER>authorize` and `<AUTH_ISSUER>oauth/token`, and the page is initialized with that client, PKCE
  and `audience = AUTH_AUDIENCE`. Without it the page offers the bearer scheme only, as today.
- The page's Content-Security-Policy gains the tenant's origin in `connect-src` only. Scripts stay `'self'`.
- The page does not persist the authorization: a reload forgets the token.
- The committed document names placeholder addresses; the served one names the tenant from the service's
  settings ([research R8](../research.md#r8-swagger-ui-signs-in-with-the-agents-client)).

## Settings (SPEC CFG-2, `env/l1-hosted.env`)

| Variable | Change |
|---|---|
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS` | required (were all-or-none) |
| `AUTH_TENANT_ID`, `SERVICE_AUDIENCE` | removed; the service refuses to start when either is set, naming it |
| `API_DOCS_CLIENT_ID` | new, optional, only read with `API_DOCS=1` |
| `AUTH_JWKS_FILE` | unchanged (local only); one issuer signs both kinds of dev token. v1.27: with it, `AGENT_BIND_HOST` must be a loopback address and `TRUSTED_PROXY_HOPS` 0 |

## Tests

T-AGT-09..14 and T-API-16..17 ([plan.md](../plan.md#tests-defined-here)); T-AGT-03, T-AGT-06, T-AGT-07 and
T-API-05..08 are rewritten for one issuer.
