# Contract: the Hosted Agent's Answers at the Edge (v1.27)

Amends `specs/016` contracts/hosted-agent-api.md and SPEC L1-6. Only these three behaviors change; the run route,
its stream, its body and its other statuses are unchanged. The agent gets none of the portal's browser headers or
404 rules (it serves no web app).

## Order per request

```text
[dev sign-in only] localOnly → 421
proxy warning (TRUSTED_PROXY_HOPS = 0 only)
/healthz, /readyz, /docs (API_DOCS=1)                      ← never counted, no token
addressLimit (300/min) → failedAuthLimit (20 × 401/min) → requesterAuth (401/403) → run limits → body → route
```

## 401 and the challenge

| Case | Status | Body | `WWW-Authenticate` |
|---|---|---|---|
| No `Authorization: Bearer` | 401 | `{ "error": "unauthorized" }` | `Bearer realm="x402-agent"` |
| A token that `verifyCaller` refuses with 401 | 401 | `{ "error": "unauthorized" }` | `Bearer realm="x402-agent", error="invalid_token"` |
| 403 (client not on the list, no `agent:run`) | 403 | `{ "error": "forbidden" }` | none |

## 429 for failed authentications

As the portal: a key with 20 answers of 401 in its window gets `429 { "error": "too many requests" }` with
`Retry-After` on every further request until the window ends, before `requesterAuth` reads a token. Successful
runs, 403s and the health and docs routes never count. One line per key per window through the run log:
`{ "event": "auth_failure_limit", "count": 20 }`. The run limits ("too many runs") are unchanged.

## 421 and start-up (dev sign-in only)

With `AUTH_JWKS_FILE`: the portal's 421 table applies unchanged; at start-up `AGENT_BIND_HOST` must be loopback and
`TRUSTED_PROXY_HOPS` 0, or `l1-hosted: AGENT_BIND_HOST must be a loopback address with AUTH_JWKS_FILE (the local
dev issuer)` / `l1-hosted: TRUSTED_PROXY_HOPS must be 0 with AUTH_JWKS_FILE (the local dev issuer)` (the prefix the
hosted entry point prints for every `ConfigError`), exit 1.

## Proxy warning

`TRUSTED_PROXY_HOPS` 0 and a request with a forwarding header: one run-log line per service instance
(each app `createHostedApp` builds; one per process in a deployment),
`{ "event": "proxy_undeclared" }`. Behind a declared proxy (`TRUSTED_PROXY_HOPS=1`, as the Azure profile sets) it never appears.

## Tests

| ID | Proves |
|---|---|
| T-EDGE-02, -03 | Start-up refusals and the 421 table on the agent (`skipLocalOnly` must-fail) |
| T-EDGE-04, -05 | The failure limit and its line, the proxy warning (`skipFailureLimit` must-fail) |
| T-EDGE-06 | The challenge table |
| T-API-05..08 | `docs/l1-hosted.openapi.yaml` matches: the 401 header and the 429 description |
