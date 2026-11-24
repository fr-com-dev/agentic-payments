# A self-hosted portal behind a front proxy

How to run the portal on one machine, reachable at a public name, behind Caddy, with only an allow-list of
addresses let in (SPEC.md L2-8 "Self-hosted behind a front proxy", v1.27; `specs/017`
contracts/self-hosted-proxy.md). The reference configuration is [Caddyfile](Caddyfile). Nothing in this repository
runs it: copy both files to the host and adapt them there.

In Azure none of this applies: the portal runs in Container Apps behind its ingress (`infra/`).

## What you need

- Caddy 2 on the host, and a DNS name for the portal that points at it (Caddy gets the certificate).
- The sign-in tenant's portal client with `https://<the portal's name>` among its origins: set `portal_origin` in
  the operator's tfvars file, then run `npm run auth0:tenant -- plan` and `npm run auth0:tenant -- apply` on the
  operator's host (SPEC 1.26, `auth0/README.md`). Without it nobody can sign in there.
- L2 running with user accounts on, as for any portal (`env/l2-control.env`).
- The addresses that may reach the portal, as CIDR ranges: for example the range of a VPN or of a private network.

## 1. Build

```bash
npm install
```

```bash
npm run build
```

```bash
npm run build:web -- --mode deployment
```

The deployment build leaves out the pasted-token sign-in of local development. Check it:

```bash
grep -rl -e 'Development sign-in' -e 'dev-token' dist/portal-web || echo "no dev sign-in in the build"
```

## 2. The portal's settings (`env/portal.env` on the host)

Start from `env/portal.env.example` and set, beside L2's address and the portal's role token:

| Setting | Value | Why |
|---|---|---|
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `PORTAL_CLIENT_ID` | the sign-in tenant's | people sign in with the tenant |
| `AUTH_JWKS_FILE` | not set | the local dev issuer would refuse to start behind a proxy, and its tokens can be made by anyone |
| `PORTAL_BIND_HOST=127.0.0.1` | the default | only Caddy, on the same machine, reaches the portal |
| `TRUSTED_PROXY_HOPS=1` | one proxy | each client is counted by its own address, not Caddy's, and no undeclared-proxy warning is logged |
| `API_DOCS` | not set | the docs routes stay off |

Then start it:

```bash
ENV_FILE=env/portal.env npm run portal
```

## 3. Caddy's settings

Set two values in Caddy's environment on the host (for example in its service unit), never in the Caddyfile or in
this repository: the allow-list is personal data.

| Variable | Value |
|---|---|
| `PORTAL_HOST` | the portal's DNS name |
| `PORTAL_ALLOW_FROM` | the addresses allowed in, space-separated CIDR ranges, for example `10.8.0.0/24` |

Without `PORTAL_ALLOW_FROM` the Caddyfile's default, `192.0.2.1/32` (TEST-NET-1), matches nobody, so every request
gets `403`.

Put the Caddyfile where Caddy reads it, then reload Caddy:

```bash
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
```

```bash
caddy reload --config /etc/caddy/Caddyfile
```

## 4. Check it, from a direct connection

Run these from a network that doesn't intercept TLS (a phone's mobile data, not a corporate proxy). Replace
`<host>` with the portal's name.

| Check | Expected |
|---|---|
| From an address on the list: `curl -sSI https://<host>/` | `200`; `strict-transport-security` present; no `server`, no `via`; the portal's `content-security-policy`, `permissions-policy`, `cross-origin-resource-policy`, `cross-origin-opener-policy` |
| `curl -sSI http://<host>/` | `308` to `https://`; no `server` |
| `curl -sSI https://<host>/healthz` and `https://<host>/docs` | `404` |
| `curl -sS https://<host>/api/me` | `401` with `www-authenticate: Bearer realm="x402-portal"` |
| On the host itself: `curl -sS http://127.0.0.1:4025/healthz` | `200 {"status":"ok"}`: the host's own probes still reach the portal directly |
| From an address off the list (a phone off the VPN) | `403` on HTTP and HTTPS |
| TLS: `testssl.sh <host>`, or SSL Labs | TLS 1.2 and 1.3 only; a valid chain |
| Ports: `nmap -Pn -p 1-65535 <host>` from outside | only 80 and 443 open; not 2019, 4025 or any other port of the stack |

## If a check fails

- **`server` or `via` still present**: the answer didn't come through this Caddyfile's sites. Check that no other
  site block or a global `servers` option matches the name, and that Caddy was reloaded.
- **No HSTS on `200`**: the portal answered directly. Check `PORTAL_BIND_HOST=127.0.0.1` and that port 4025 is not
  published or forwarded.
- **`403` from an address that should be allowed**: Caddy sees the connection's own address. Behind another
  proxy or a NAT, list the address Caddy actually sees (its access log shows it).
- **The portal refuses to start, naming `PORTAL_BIND_HOST` or `TRUSTED_PROXY_HOPS`**: `AUTH_JWKS_FILE` is still
  set. Remove it and use the sign-in tenant.
- **Sign-in fails with `unauthorized_client`**: the tenant doesn't list the portal's origin yet (see "What you
  need").
- **Port 2019 or 4025 open from outside**: something besides this setup publishes it (a firewall rule, a router's
  port forwarding, a container). Close it there.
