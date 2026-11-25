# Contract: the hosted agent's API (delta to SPEC L1-6, `specs/016` and `specs/017-dast-findings-remediation`)

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

What changes on the hosted agent's HTTP API, on top of the DAST remediation (its bearer challenge, its limit on
failed authentications and its local-only guard for the dev issuer). Everything not named here is unchanged.
`docs/l1-hosted.openapi.yaml` changes with it, and T-API-05..08 fail until both match the service.

## Order per request

```text
[dev issuer] this machine only (421)          ← DAST remediation, unchanged
health, docs (API_DOCS=1)                      ← unchanged, token-free
per address (429)                              ← unchanged
failed authentications per address (429)       ← DAST remediation, unchanged
GET /.well-known/agent-auth                    ← NEW, token-free, only with AGENT_DESKTOP_CLIENT_ID
auth (401 / 403)                               ← 401 body gains error_code
run limits (429)                               ← unchanged, per person
body (400 / 413), session (400 / 404)          ← unchanged
account question, a person's run only          ← NEW: 409 / 401 / 503
run (JSON or stream)                           ← unchanged
```

Nothing after "auth" changes for a machine caller.

## Who is accepted

Unchanged ([research R1](../research.md#r1-the-owners-decisions-and-the-two-corrections)): a person's token needs
`agent:run` in `permissions` and a client on `AGENT_CLIENT_IDS`; that list now holds the docs page's client and
the desktop client. No roles claim is read. A machine caller's token is checked as before.

## 401: the code beside the challenge

Every 401 keeps the DAST remediation's challenge and gains `error_code` ([research R10](../research.md#r10-the-readable-401)).

| Case | `WWW-Authenticate` (DAST remediation) | Body |
|---|---|---|
| No `Authorization: Bearer <token>` | `Bearer realm="x402-agent"` | `{ "error": "unauthorized", "error_code": "missing_token" }` |
| The token's validity period is its only fault (`verifyCaller` reason `expired`) | `Bearer realm="x402-agent", error="invalid_token"` | `{ "error": "unauthorized", "error_code": "token_expired" }` |
| Any other failure: signature, issuer, audience, `nbf`, subject, a machine subject that is not its client's, malformed | `Bearer realm="x402-agent", error="invalid_token"` | `{ "error": "unauthorized", "error_code": "invalid_token" }` |

- `error` keeps its value, so a client that reads only `error` sees no change.
- No `error_description`, no claim value, no key ID. The answers for the "any other failure" row are
  byte-identical whichever check failed.
- A token that is expired *and* fails another check is `invalid_token`: jose reports the first failing check,
  and an expiry is only reported when signature, issuer and audience passed.
- 403 is unchanged: `{ "error": "forbidden" }`, no challenge.
- A request that asked for a stream gets the same status, header and JSON body: every refusal happens before the
  stream opens.

## The account question (a person's run only)

After the session check and before the run limiter counts a start, the agent calls L2's budget route once
through the run's own gate (`gate.forCaller(token).budget(sessionId)`), with a 1 s bound
([research R8, R9](../research.md#r8-the-account-question-reuses-the-budget-route)). The answer decides:

| L2's answer ([control-api.md](control-api.md)) | Agent's answer | Body |
|---|---|---|
| 200, `account: "ready"` | The run starts | — |
| 200, `account: "not_onboarded"` | 409 | `{ "error": "account not ready", "error_code": "account_not_onboarded" }` |
| 200, `account: "disabled"` | 409 | `{ "error": "account not ready", "error_code": "account_disabled" }` |
| 403 `{ "error": "user_accounts_off" }` | 409 | `{ "error": "account not ready", "error_code": "accounts_off" }` |
| 401 `{ "error": "caller_token_expired" }` (the token expired between the two checks) | 401, with the challenge | `{ "error": "unauthorized", "error_code": "token_expired" }` |
| Anything else: no answer within 1 s, a network error, any other status or code, a 200 without `account` or with another value | 503 | `{ "error": "control unavailable", "error_code": "control_unavailable" }` |

- A refusal here makes no model call and no payment request, creates no session reference and is not counted
  as a run start (the limiter's `start` comes after it).
- A machine caller's run skips the question: its gate's budget is the platform session's, and nothing about an
  account applies.
- The question carries the caller's token to L2 and nowhere else, as every gate call does. The answer's
  `account` value never reaches the model: the `check_budget` tool's output drops it, so a step's `result` keeps
  today's fields.

## `GET /.well-known/agent-auth` (new, token-free)

Mounted only when `AGENT_DESKTOP_CLIENT_ID` is set; without it the path is like any unknown path (401 without a
token, 404 with one). Counted by the per-address limit, like every route after it. It reads no session, calls no
model, L2 or L3, and holds no secret ([research R12](../research.md#r12-the-sign-in-settings-route)).

```json
{
  "issuer": "https://<tenant domain>/",
  "authorization_endpoint": "https://<tenant domain>/authorize",
  "token_endpoint": "https://<tenant domain>/oauth/token",
  "audience": "https://x402-api/<env>",
  "client_id": "<AGENT_DESKTOP_CLIENT_ID>",
  "scopes": ["openid", "offline_access", "agent:run"],
  "redirect_uri": "http://127.0.0.1:53682/callback"
}
```

- Every value comes from the service's settings: `issuer` is `AUTH_ISSUER`; the two endpoints are built from it
  (so a custom domain moves them together); `audience` is `AUTH_AUDIENCE`.
- `200`, `application/json`, `Cache-Control: public, max-age=300`. No other field.

## The run log

Each `step` and `run` line gains `client`: the client the caller's token was issued to (`azp` / `client_id`; for
a machine caller, its own client). The existing fields stay: `runId`, `requester` (`<issuer host>:<sub>`),
`sessionId`, and on a step `intentId` and `authorizationId`. Still never a header, a token or a code
([research R11](../research.md#r11-the-client-in-the-run-log)).

## API description (`docs/l1-hosted.openapi.yaml`)

- `info.version` follows SPEC's version.
- `Error` gains an optional `error_code` (enum of the seven codes above).
- `responses.Unauthorized` describes the three codes and the challenge; `/v1/runs` gains `409` and `503`.
- `/.well-known/agent-auth` with `security: []` and an `AgentAuthSettings` schema.
- `signIn`'s `scopes` lists `openid`, `offline_access` and `agent:run`, each described; the docs page's sign-in
  works without ticking them, and its own client still gets no refresh token.

## Settings (SPEC CFG-2, `env/l1-hosted.env`)

| Variable | Rule |
|---|---|
| `AGENT_CLIENT_IDS` | Unchanged format (comma-separated); now the docs page's client and the desktop client |
| `AGENT_DESKTOP_CLIENT_ID` | New, optional. Must be one of `AGENT_CLIENT_IDS` and not `PORTAL_CLIENT_ID`; refused with `AUTH_JWKS_FILE` (the dev issuer has no sign-in page). Absent: no settings route. The error names the variable, never its value |

## Tests

| ID | What | Must-fail |
|---|---|---|
| T-AGT-16 | The three 401 codes with the challenge; the "other failure" answers byte-identical across signature, issuer, audience, subject and malformed; `error` unchanged; same with `Accept: text/event-stream` | `revealCheck` (test-only dep of `requesterAuth`) puts jose's reason in the body: the identical-answers assertion fails |
| T-AGT-17 | The account question: each row of its table, no model call and no L2 authorize on a refusal, no start counted (a 21st goal after 20 refusals still runs), a machine caller never asked, the 1 s bound, and a budget error carrying a planted token gives the fixed 503 body with the token in neither the body nor the log | `skipAccountCheck` (test-only dep of the hosted app): the not-onboarded person's run starts and spends model calls |
| T-AGT-18 | The settings route: its values from the settings, absent without `AGENT_DESKTOP_CLIENT_ID`, no L2 or model call; the config refusals (not on the list, the portal's client, the dev issuer) | Mounting it without the variable check: the "absent" case fails |
| T-AGT-19 | Limits per person across clients: one `sub` with a docs page token and a desktop token, third concurrent run 429, 21st start 429 | Keying the limiter by client and `sub` (test-only `limitKey`): the third run starts |
| T-AGT-20 | The run log's `client` on step and run lines, from each client; a known-value scan finds no token or code in the log, the answer or the stream | — (a scan) |
| T-API-18 | The OpenAPI document matches: 401 with `error_code`, 409, 503, the settings route and schema, the `signIn` scopes | T-API-05..08's existing mutants |
