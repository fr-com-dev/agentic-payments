# Data Model: Remediation of the Portal's DAST Findings

Nothing here is stored on disk or in the ledger. The ledger, the profiles and every contract type in
`src/shared/contracts.ts` are unchanged. The entities below are in-memory state, fixed tables and documents.

## Loopback name (`src/shared/local-only.ts`)

A rule, not a record.

| Input | Loopback | Not loopback |
|---|---|---|
| `Host` header | `localhost`, `LOCALHOST`, `localhost.`, `127.0.0.1`, `[::1]`, each with or without `:<port>` | any other name; `127.0.0.2`; `0.0.0.0`; `[::ffff:127.0.0.1]`; empty; missing |
| Bind address (`PORTAL_BIND_HOST`, `AGENT_BIND_HOST`) | `127.0.0.1`, `::1`, `localhost` | anything else, `0.0.0.0` and `::` included |

Forwarding headers (any one present means "through a proxy"): `Forwarded`, `X-Forwarded-For`,
`X-Forwarded-Host`, `X-Forwarded-Proto`, `Via`.

Used by: HSTS (R1: not loopback → send it), the dev sign-in's start-up check and request check (R3).

## Failure count (per service, per client address)

| Field | Meaning |
|---|---|
| key | The client address as express-rate-limit keys it (IPv6 grouped by /56); behind a declared proxy, the address the proxy reports |
| count | 401 answers given to that key in its current window; a request that ends with any other status is taken off again |
| resetTime | End of the key's one-minute window |

- At most `MAX_FAILED_AUTH_PER_ADDRESS` (20). Over it, every API request from the key gets `429` with
  `Retry-After` (seconds to `resetTime`, at least 1) until `resetTime`, before any token check.
- Kept in the replica's memory, like `addressLimit`'s counts (an accepted v1.2 residual: limits are per replica).
- Separate from the per-address request count (300 a minute) and the per-person counts (portal 120 requests a
  minute; agent runs), which are unchanged.

## Burst log record (per service)

| Field | Meaning |
|---|---|
| logged | `Map<key, resetMs>`: keys whose crossing has been logged in their current window; entries past `resetMs` are dropped on each crossing |

One log line per key per window:

| Service | Line |
|---|---|
| Portal | `{ "time": "<ISO>", "route": "/api/*", "status": 429, "ms": 0, "event": "auth_failure_limit", "count": 20 }`. `count` joins `LOG_KEYS` in `src/portal/log.ts` |
| Hosted agent | `{ "event": "auth_failure_limit", "count": 20 }` through a new `RunLog.event(...)` |

Never in a line: the key (address), a token, a header, a path, query or body value (spec FR-009, NFR-003).

## Undeclared-proxy warning (per service instance)

| Field | Meaning |
|---|---|
| warned | Boolean, false at start. Set by the first request with a forwarding header while `TRUSTED_PROXY_HOPS` is 0 |

One line per service instance (each app the service builds; one per process in a deployment), written when that
first request finishes: the portal `{ "time", "route": "<the request's route label>",
"status", "ms", "event": "proxy_undeclared" }` beside the request's usual line; the agent `{ "event": "proxy_undeclared" }`.

## Screen table (`src/shared/portal-screens.ts`)

One row per screen of `web/portal/src/routes.ts`, `not-found` excepted.

| Field | Meaning |
|---|---|
| name | The web app's `Screen["name"]` (`home`, `profile-step`, …, `admin-ledger`) |
| pattern | Anchored match on the path with trailing slashes removed, e.g. `^/$`, `^/policies$`, `^/policies/[^/]+/history$`, `^/admin/escalations/[^/]+$` |
| example | A path that `matchRoute` maps to `name`, e.g. `/policies/p-1/history` |

Rules (T-WEB-14): every name of the exported `SCREEN_NEEDS` but `not-found` has exactly one row; each row's example
gives its name from `matchRoute`; no row's pattern matches a path under `/api` or `/assets`.

## Portal answer kinds (non-API paths)

| Path | Answer |
|---|---|
| A segment starting with `.` after decoding, undecodable, or decoding to `/`, `\` or NUL | `404 { "error": "not found" }` |
| A built file that exists (`/index.html`, `/assets/<file>`) | `200`, the file |
| Under `/assets/`, no such file | `404 { "error": "not found" }` |
| GET or HEAD, a screen path | `200`, the web app's page |
| GET or HEAD, `Accept` has `text/html`, anything else | `404`, the web app's page |
| Anything else | `404 { "error": "not found" }` |

## Public configuration (`GET /api/config`)

| Field | Before (v1.25) | After (v1.26) |
|---|---|---|
| `auth.mode`, `auth.domain`, `auth.clientId`, `auth.audience` | yes | yes |
| `cards.available`, `cards.publishableKey?` | yes | yes |
| `network` | yes | removed |
| `admin.available` | yes | removed (the web app reads `me.admin`) |

## Finding disposition (`specs/017-dast-findings-remediation/dispositions.md`, written during implementation)

| Field | Meaning |
|---|---|
| finding | 1–7, the report's numbering |
| severity | Low, Low/Info, Info |
| outcome | `fixed`, `accepted` (a residual, with its SPEC §11 entry), or `fixed in part, accepted in part` |
| requirements | The spec's FR IDs that resolve it |
| proof | The automated test (T-… ID) or the quickstart step that shows it |
| reason | For anything accepted: why, and what would change it |

## Reference proxy settings (`docs/self-hosted/`)

| Setting | Where | Default |
|---|---|---|
| `PORTAL_HOST` | Caddy's environment | none: required |
| `PORTAL_ALLOW_FROM` | Caddy's environment, set by the owner; personal data, never committed | `192.0.2.1/32` (TEST-NET-1): refuses everyone |
| Upstream | the Caddyfile | `127.0.0.1:4025` (the portal's default bind and port) |
| Portal settings behind it | `env/portal.env` | no `AUTH_JWKS_FILE`; `PORTAL_BIND_HOST=127.0.0.1`; `TRUSTED_PROXY_HOPS=1` |
