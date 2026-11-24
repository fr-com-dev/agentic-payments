# Contract: the Reference Front Proxy for a Self-Hosted Portal

Files: `docs/self-hosted/Caddyfile` (the configuration) and `docs/self-hosted/README.md` (the procedure, spec
FR-022). The owner copies and adapts them on the host that runs Caddy; nothing in this repository runs them.

## What the configuration must do

| # | Requirement | Spec |
|---|---|---|
| P1 | Answer HTTPS on the site name `{$PORTAL_HOST}` with TLS 1.2 and 1.3 only (Caddy's automatic certificate) | FR-003, FR-021 |
| P2 | Answer plain HTTP on the same name with `308` to `https://{host}{uri}`, after the allow-list check, without `Server` | FR-003, FR-021 |
| P3 | Refuse with `403`, before forwarding, every connection whose own address (not a forwarded one) is outside `{$PORTAL_ALLOW_FROM}`, on HTTP and HTTPS | FR-021, US4 sc. 4 |
| P4 | `{$PORTAL_ALLOW_FROM}` defaults to `192.0.2.1/32` (TEST-NET-1), so an unset list refuses everyone | FR-021 |
| P5 | Answer `404` from outside for `/healthz`, `/readyz`, `/docs` and `/docs/*`, without forwarding | FR-021, US4 sc. 1 |
| P6 | Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every HTTPS answer, its own `403`/`404` included | FR-003 |
| P7 | Send no `Server` and no `Via` header on any answer | FR-021, US4 sc. 2 |
| P8 | Forward everything else to `127.0.0.1:4025`, with `X-Forwarded-For` set to the connection's address only (Caddy's default for a client it doesn't trust) | FR-021, US4 sc. 3 |
| P9 | Keep Caddy's admin endpoint on `localhost:2019` | FR-022 |
| P10 | Hold no address, host name, token or secret of the owner's | NFR-003 |

Order inside the HTTPS site is literal (one `route` block): P3, then P5, then P8. Header changes (P6, P7) apply to
every answer, the proxy's own included.

## The portal behind it (`env/portal.env` on that host)

| Setting | Value | Why |
|---|---|---|
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `PORTAL_CLIENT_ID` | the tenant's | Auth0 sign-in; the dev sign-in would refuse to start here (`TRUSTED_PROXY_HOPS` 1) |
| `AUTH_JWKS_FILE` | unset | as above |
| `PORTAL_BIND_HOST` | `127.0.0.1` (the default) | only Caddy reaches the portal |
| `TRUSTED_PROXY_HOPS` | `1` | each client is counted by its own address, and no proxy warning |
| web build | `npm run build:web -- --mode deployment` | no pasted-token sign-in in the files served |

The tenant must list `https://<PORTAL_HOST>` as an origin of the portal's client: `portal_origin` in the operator's
tfvars file, then `npm run auth0:tenant -- plan` and `-- apply` on the operator's host (SPEC 1.26, `auth0/README.md`).

## The procedure must end with these checks, from a direct connection (not through an intercepting proxy)

| Check | Expected |
|---|---|
| From an address on the list: `curl -sSI https://<host>/` | `200`; `strict-transport-security` present; no `server`, no `via`; the portal's CSP, Permissions-Policy, CORP, COOP |
| `curl -sSI http://<host>/` | `308` to `https://`; no `server` |
| `curl -sSI https://<host>/healthz` and `/docs` | `404` |
| On the host itself: `curl -sS http://127.0.0.1:4025/healthz` | `200 {"status":"ok"}`: the portal's own probes still reach it directly (US4 sc. 1) |
| `curl -sS https://<host>/api/me` | `401` with `www-authenticate: Bearer realm="x402-portal"` |
| From an address off the list (a phone off the VPN) | `403` on HTTP and HTTPS |
| TLS (`testssl.sh <host>` or SSL Labs) | TLS 1.2 and 1.3 only; a valid chain |
| Ports (`nmap -Pn -p 1-65535 <host>` from outside) | only 80 and 443; not 2019, 4025 or any other stack port |

## Test

T-PROXY-01 (`test/self-hosted.test.ts`) reads the Caddyfile and checks P1–P10 by their directives; with
`CADDY_PATH` set it also runs `caddy validate --adapter caddyfile` against it with `PORTAL_HOST=portal.example`.
