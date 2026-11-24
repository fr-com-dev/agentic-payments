# Contract: the Portal's Answers at the Edge (v1.27)

Amends `specs/013` contracts/portal-api.md "Limits and headers" and "Access", and `specs/014`
contracts/portal-api.md where it names `admin.available`. Everything not listed here is unchanged.

## Order per request

```text
headers and the request log (sets every header below, so a 421 carries them too)
[dev sign-in only] localOnly → 421
proxy warning (TRUSTED_PROXY_HOPS = 0 only; never refuses)
/healthz, /readyz, /docs (API_DOCS=1), GET /api/config          ← never counted, no token
/api:  addressLimit (300/min) → failedAuthLimit (20 × 401/min) → access (401/403) → per-person limit (120/min)
       → [/api/admin: requireAdmin] → body → route → 404 JSON
other: dot-path / traversal → 404 JSON
       built file → 200
       /assets/* not served → 404 JSON
       GET|HEAD screen path → 200 page
       GET|HEAD with Accept text/html → 404 page
       anything else → 404 JSON
```

## Headers on every answer

| Header | Value | Change |
|---|---|---|
| `Content-Security-Policy` | as in v1.25 (T-PRT-07) | unchanged |
| `X-Content-Type-Options` | `nosniff` | unchanged |
| `Referrer-Policy` | `no-referrer` | unchanged |
| `Cache-Control` | `no-store` on `/api` | unchanged |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` when the `Host` header is not a loopback name; absent otherwise | was: when `NETWORK` is not `local` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=(self "https://js.stripe.com")` | new |
| `Cross-Origin-Resource-Policy` | `same-origin` | new |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | new |

"Every answer" includes the page, built files, API answers, health, docs, 401/403/404/413/421/429 and body errors.
The header middleware stays first, and `localOnly` comes right after it, before any route; neither reads a token.

## `GET /api/config`

```json
{
  "auth": { "mode": "auth0", "domain": "<tenant host>", "clientId": "<portal client>", "audience": "<api id>" },
  "cards": { "available": true, "publishableKey": "pk_test_…" }
}
```

`mode` is `auth0` or `dev`; `domain` is `""` in dev mode; `publishableKey` only when cards are on. No other field.
`network` and `admin` are gone: the web app shows the administration area when `GET /api/me` says `admin: true`,
which the portal sets only when the area is on and the token carries `portal:admin` (unchanged).

## 401 and the challenge

| Case | Status | Body | `WWW-Authenticate` |
|---|---|---|---|
| No `Authorization: Bearer` | 401 | `{ "error": "unauthorized" }` | `Bearer realm="x402-portal"` |
| A token that fails any check giving 401 (signature, issuer, audience, time, subject, sign-in time) | 401 | `{ "error": "unauthorized" }` | `Bearer realm="x402-portal", error="invalid_token"` |
| A valid token of another client, or a machine token | 403 | `{ "error": "forbidden" }` | none |
| Not an administrator on `/api/admin/*` | 403 | `{ "error": "forbidden" }` | none |

## 429

| Limit | Counted | Key | Answer |
|---|---|---|---|
| Per address (v1.10) | every `/api` request but `/api/config` | client address | `429 { "error": "too many requests" }`, `Retry-After` |
| Failed authentications (v1.27) | `/api` answers with 401 | client address | same body and header, until the key's window ends; checked before any token is read |
| Per person (v1.10) | every `/api` request after access | user | same body and header |

When an address goes over the failure limit, one log line in that window:
`{ "time": "…", "route": "/api/*", "status": 429, "ms": 0, "event": "auth_failure_limit", "count": 20 }`.

## 421 (dev sign-in only)

With `AUTH_JWKS_FILE` (the local dev issuer), before anything else:

| Request | Answer |
|---|---|
| `Host` is `localhost`, `127.0.0.1` or `[::1]` (any case, any port, `localhost.`) and none of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Via` | served as usual |
| Anything else, health routes included | `421 { "error": "misdirected request" }` |

And at start-up, with `AUTH_JWKS_FILE`: `PORTAL_BIND_HOST` must be `127.0.0.1`, `::1` or `localhost`, and
`TRUSTED_PROXY_HOPS` must be 0, or the portal exits 1 with
`portal: PORTAL_BIND_HOST must be a loopback address with AUTH_JWKS_FILE (the local dev issuer)` or
`portal: TRUSTED_PROXY_HOPS must be 0 with AUTH_JWKS_FILE (the local dev issuer)`. No value is printed.

## Proxy warning

`TRUSTED_PROXY_HOPS` 0 and a request with any forwarding header: once per service instance (each app
`createPortalApp` builds; one per process in a deployment), one extra line beside that
request's usual line, `{ "time": "…", "route": "<label>", "status": <status>, "ms": <ms>, "event": "proxy_undeclared" }`.
The request is served as usual (but see 421).

## Paths outside the API

| Example | Answer |
|---|---|
| `/`, `/policies`, `/policies/`, `/policies/p-1`, `/policies/p-1/history`, `/admin/escalations/a-1` | 200, the page |
| `/index.html`, `/assets/index-<hash>.js` | 200, the file |
| `/nope` with `Accept: text/html` | 404, the page |
| `/nope` with `Accept: application/json` or none | `404 { "error": "not found" }` |
| `/.env`, `/.git/HEAD`, `/x/.hidden`, `/%2e%2e/etc/passwd`, `/assets/..%2f..%2fetc/passwd` | `404 { "error": "not found" }` |
| `/assets/missing.js`, `/assets/index-<hash>.js.map` (none is built) | `404 { "error": "not found" }` |
| `POST /`, `PUT /policies` | `404 { "error": "not found" }` (as today) |

## Tests

| ID | Proves |
|---|---|
| T-PRT-07 (amended) | The v1.25 header set, unchanged, with HSTS now absent because the requests use a loopback host |
| T-PRT-16 | HSTS with a public `Host` on every answer kind (page, file, API, health, 401, 404, 429) and none with a loopback one, on `NETWORK=local` and `base-sepolia`; the three new headers on every answer kind |
| T-PRT-17 | The table above; the probe list's 56 sensitive paths and 8 traversal payloads (the report's examples and families) all 404; every screen example 200; must-fail with `skipNotFoundRules` |
| T-PRT-18 (and T-PRT-01 amended) | `/api/config` has exactly the fields above, on dev and tenant sign-in, cards on and off, administration on and off |
| T-EDGE-02, -03 | The start-up refusals and the 421 table, with `skipLocalOnly` as the must-fail |
| T-EDGE-04, -05 | The failure limit, its one log line, the proxy warning; `skipFailureLimit` as the must-fail |
| T-EDGE-06 | The challenge table |
| T-API-12..15 | `docs/portal.openapi.yaml` matches: the config schema, the 401 header, the 429 descriptions |
