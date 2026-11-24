# Quickstart: Validating the DAST Remediation

How to prove each finding is closed: first on a developer's machine (automated and by hand), then on the dev host
after the owner applies the reference proxy. Contracts: [portal-edge.md](contracts/portal-edge.md),
[hosted-agent-edge.md](contracts/hosted-agent-edge.md), [self-hosted-proxy.md](contracts/self-hosted-proxy.md).
Decisions: [research.md](research.md).

## 1. Automated (every pull request)

```bash
npm install
```

```bash
npm run check
```

Expect typecheck and every suite green, and the demo summary unchanged (`spent on-chain: 0.006 USDC`,
`hash chain ok=true`). The feature's own tests, by finding:

| Finding | Tests |
|---|---|
| 1 HSTS | T-PRT-07 (amended), T-PRT-16 |
| 2 Failed authentication | T-EDGE-04, T-EDGE-05 |
| 3 Soft 404 | T-PRT-17, T-WEB-14 |
| 4 Dev sign-in and disclosure | T-EDGE-01..03, T-PRT-18, T-WEB-15, T-WEB-16, T-IMG-03 |
| 5 Browser policies | T-PRT-16 |
| 6 Health and banner | T-PROXY-01 (and T-PRT-16 for the health routes' headers) |
| 7 Challenge | T-EDGE-06; PKCE is a recorded residual (step 4) |

Run one family:

```bash
npx vitest run test/edge-local-only.test.ts test/edge-failure-limit.test.ts test/edge-challenge.test.ts
```

With a Caddy binary on the machine, the reference file is also validated:

```bash
CADDY_PATH=$(command -v caddy) npx vitest run test/self-hosted.test.ts
```

Each must-fail switch (`skipLocalOnly`, `skipFailureLimit`, `skipNotFoundRules`) is exercised inside those suites:
the test shows the exposure with the switch on and its absence with it off.

## 2. By hand, locally (dev sign-in)

Start the stack with user accounts and the portal in dev mode, as today (`npm run stack:local -- --users`, then
`npm run build:web` and `npm run portal`).

| Step | Command | Expected |
|---|---|---|
| Loopback works | `curl -sS http://127.0.0.1:4025/api/config` | `200`, only `auth` and `cards` |
| A public name is refused | `curl -sS -H 'Host: portal.example' http://127.0.0.1:4025/api/config` | `421 {"error":"misdirected request"}` |
| A proxy is refused | `curl -sS -H 'X-Forwarded-For: 203.0.113.9' http://127.0.0.1:4025/healthz` | `421` |
| No HSTS on loopback | `curl -sSI http://127.0.0.1:4025/` | no `strict-transport-security`; `permissions-policy`, `cross-origin-resource-policy`, `cross-origin-opener-policy` present |
| Soft 404 gone | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4025/.env` | `404` |
| A screen still opens | open `http://localhost:4025/policies` in a browser and paste a dev token | the policies screen |
| Start-up refusal | `PORTAL_BIND_HOST=0.0.0.0` added to the dev `env/portal.env`, then `npm run portal` | exits 1 naming `PORTAL_BIND_HOST`, not its value |
| Start-up refusal | `TRUSTED_PROXY_HOPS=1` instead, then `npm run portal` | exits 1 naming `TRUSTED_PROXY_HOPS` |
| Challenge | `curl -sSI http://127.0.0.1:4025/api/me` | `401`, `www-authenticate: Bearer realm="x402-portal"` |
| Failure limit | 21 × `curl -s -o /dev/null -w '%{http_code} ' -H 'Authorization: Bearer a.b.c' http://127.0.0.1:4025/api/me` | twenty `401`s from this address in the minute, then `429` (the challenge row's `401` counts: run right after it, nineteen); one `auth_failure_limit` line in the portal's output |

Repeat the 421, start-up, challenge and failure-limit rows against the hosted agent on `127.0.0.1:4024` (with
`env/l1-hosted.env` in dev mode); expect the same, with realm `x402-agent`.

## 3. The deployment build

```bash
npm run build:web -- --mode deployment
```

```bash
grep -rl -e 'Development sign-in' -e 'dev-token' dist/portal-web || echo "no dev sign-in in the build"
```

Expect `no dev sign-in in the build`. Rebuild with `npm run build:web` afterwards for local work.

## 4. On the dev host (the owner, by hand)

The portal is deployed on the dev host only: sign-in is the Auth0 tenant, and Caddy is in front of it. SPEC 1.26
deleted the Azure environment, so no deployment there is checked; the Azure profile in `infra/` stays as code only.

**Set it up.** Follow `docs/self-hosted/README.md`: build with `npm run build:web -- --mode deployment`; set the
portal's env as [self-hosted-proxy.md](contracts/self-hosted-proxy.md) says (`TRUSTED_PROXY_HOPS=1`, Auth0
sign-in, loopback bind); set `portal_origin` in the operator's tfvars file and run `npm run auth0:tenant -- plan`
and `npm run auth0:tenant -- apply`; put the Caddyfile in place with `PORTAL_HOST` and `PORTAL_ALLOW_FROM` set in
Caddy's environment, and reload Caddy.

**From a direct connection** (not through a TLS-intercepting network), run every check in the last table of
[self-hosted-proxy.md](contracts/self-hosted-proxy.md): headers, the HTTP redirect, the hidden health and docs routes
(and `/healthz` still answering on `127.0.0.1:4025` from the host itself), the challenge, the `403` from an address
off the list, TLS and the open ports.

**In a browser, from an address on the list**, with the developer tools open on the network tab:

1. Load the portal: `strict-transport-security`, `permissions-policy`, `cross-origin-resource-policy` and
   `cross-origin-opener-policy` on the page and on `/api/config`; `/api/config` has only `auth` and `cards`.
2. Sign in through the Auth0 pop-up; the pop-up's address carries `code_challenge_method=S256`. The sign-in completes
   (a console warning about `window.closed` from the tenant's page may appear and is harmless).
3. Confirm your identity (the "Confirm it's you" button), register a test card, and, as an administrator, open
   the administration area; sign out. Each works in one attempt (spec SC-008).
4. Look at the tenant's application and advanced settings for a PKCE method setting. If one exists, record it
   and switch the residual in SPEC §11 to a fix through `auth0/` (research R14).

**Finally**, repeat the report's unauthenticated checks from an address on the list (spec SC-001) and record each
finding's outcome in `dispositions.md` (FR-027). From an address off the list, every request must get `403` from
the proxy (SC-002).
