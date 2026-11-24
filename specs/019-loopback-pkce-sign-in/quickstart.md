# Quickstart: checking feature 019

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Contracts**: [contracts/](contracts/)

How to see that the feature works. Sections 1 to 3 need only this repository; 4 and 5 need the Auth0 tenant and
the VPS. Record each result in the Validation log at the end. Never print a token: every command below keeps
them in files under `.local/` (gitignored), readable by you alone, and prints only claims or status codes.

## 0. Before you start

This branch is rebased onto the DAST findings remediation and the tenant sign-up hardening, both merged
([plan.md "Dependencies"](plan.md#dependencies)). Check that `docs/l1-hosted.openapi.yaml` already has the bearer
challenge and that `auth0/main.tf` declares people's connections.

## 1. The definition of done

```bash
npm run check
```

Expect `spent on-chain: 0.006 USDC` and `hash chain ok=true`, unchanged.

```bash
BICEP_PATH=~/.azure/bin/bicep npx vitest run test/auth0-iac.test.ts test/infra.test.ts test/hosted-access.test.ts test/hosted-agent.test.ts test/caller-token.test.ts test/openapi-hosted.test.ts test/openapi.test.ts
```

## 2. The must-fail halves

```bash
npx vitest run -t "must fail"
```

Look for each unsafe outcome in [plan.md "Proofs"](plan.md#proofs-constitution-viii): a not-onboarded person's run
spending model calls, two different 401 answers for two invalid tokens, a third concurrent run accepted through
a second client, the desktop rule passing a renewal without the role, `plain` accepted.

## 3. A local walk-through with the dev issuer

```bash
npm run stack:local -- --users
```

In a second terminal, the hosted agent with `env/l1-hosted.env` from the example
(`AGENT_CLIENT_IDS=x402-agent-cli-dev,x402-agent-desktop-dev`):

```bash
npm run agent:hosted
```

In a third, a desktop-client token for a person who has not onboarded, kept in a file:

```bash
umask 077; npm run -s dev-token -- --subject dora --desktop > .local/dora.token
```

```bash
printf 'authorization: Bearer %s\n' "$(cat .local/dora.token)" > .local/dora.header
```

```bash
curl -sS -H @.local/dora.header -H 'content-type: application/json' -d '{"goal":"Read the catalog"}' http://127.0.0.1:4024/v1/runs
```

Expect `409` with `"error_code":"account_not_onboarded"`, and no model call in the agent's log. Onboard Dora at
the portal (`npm run portal`, the dev sign-in), send again: the run starts. Then:

| Request | Expect |
|---|---|
| No `authorization` header | 401, `WWW-Authenticate: Bearer realm="x402-agent"`, `error_code` `missing_token` |
| A token signed by another key, or for another audience | 401, `error="invalid_token"`, `error_code` `invalid_token`, the same body for both |
| `npm run -s dev-token -- --service` | 200, the platform account pays; no account question in the log |
| `curl -sS http://127.0.0.1:4024/.well-known/agent-auth` | 401 locally: `AGENT_DESKTOP_CLIENT_ID` is refused with the dev issuer (T-AGT-18 covers the route) |

Delete the files: `rm -f .local/dora.*`.

## 4. The tenant and the VPS

On the operator's host:

```bash
npm run auth0:tenant -- plan
```

The plan adds `auth0_client.desktop` and `auth0_client_credentials.desktop`, updates `auth0_action.sign_in_time`
and the connections' application lists, and changes the outputs; nothing else. Then:

```bash
npm run auth0:tenant -- apply
```

Check in the Auth0 dashboard that the desktop client saved both callback addresses. Put `l1_env`'s lines in the
agent's `env/l1-hosted.env` and `l2_env`'s `AGENT_CLIENT_IDS` in L2's, restart L2 and then the agent. Enroll the
test person in a second factor, give them an account at the portal, then the role `x402-agent`.

## 5. The live check (spec-19's acceptance tests, by hand)

With the tenant's domain in `T`, the desktop client in `D`, people's API in `A` and the agent at
`https://agent.fabriciorojas.com`, from your own computer:

```bash
umask 077; V=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64); S=$(openssl rand -hex 16)
```

```bash
C=$(printf '%s' "$V" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')
```

```bash
open "https://$T/authorize?response_type=code&client_id=$D&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&scope=openid%20offline_access%20agent%3Arun&audience=$(jq -rn --arg a "$A" '$a|@uri')&code_challenge=$C&code_challenge_method=S256&state=$S"
```

Nothing listens on port 53682, so the browser ends on an error page whose address holds `code` and `state`.
Check that `state` equals `$S`, put the code in `CODE`, and exchange it within a minute:

```bash
curl -sS "https://$T/oauth/token" --data-urlencode grant_type=authorization_code --data-urlencode client_id="$D" --data-urlencode code="$CODE" --data-urlencode code_verifier="$V" --data-urlencode redirect_uri=http://127.0.0.1:53682/callback > .local/desktop.json
```

```bash
node -e 'const t=require("./.local/desktop.json");const p=JSON.parse(Buffer.from(t.access_token.split(".")[1],"base64url"));console.log({iss:p.iss,aud:p.aud,azp:p.azp,scope:p.scope,permissions:p.permissions,refresh:typeof t.refresh_token==="string"})'
```

| # | Check | Expect |
|---|---|---|
| L1 | The claims above | `iss` = `AUTH_ISSUER`, `aud` contains `A`, `azp` = `D`, `scope` and `permissions` contain `agent:run`, `refresh: true` |
| L2 | `POST /v1/runs` with that token (header file as in §3) | 200 and a run result |
| L3 | The sign-in as a person without the role | The tenant ends it with `not_authorized_for_agent`; no code |
| L4 | The sign-in through the portal's client, its token sent to the agent | 403 |
| L5 | The token after it expires (an hour) | 401, `error_code` `token_expired` |
| L6 | A token for another audience (the approval API's identifier as `audience`) | 401, `error_code` `invalid_token` |
| L7 | A renewal: `grant_type=refresh_token` with `refresh_token` from `.local/desktop.json` | A new access token with `agent:run`, a new refresh token |
| L8 | The spent refresh token from L7 again, then the newest one | Both refused (`invalid_grant`): the family is revoked |
| L9 | The authorization without `code_challenge`, and with `code_challenge_method=plain` | No token: refused by the tenant or by `pkce_required` |
| L10 | Two sign-ins as the same person, then 3 concurrent runs | The third gets 429 |
| L11 | A person with the role and no portal account | 409 `account_not_onboarded`, before any model call |
| L12 | The first sign-in | Note whether the tenant showed a consent screen (spec Edge Cases); a second factor was asked |
| L13 | `curl -sS https://agent.fabriciorojas.com/.well-known/agent-auth` | The seven fields, `client_id` = `D` |
| L14 | A new sign-in (the same `open` command), its code exchanged with another verifier (below) | `invalid_grant`; no token |
| L15 | The `open` command with `localhost` in place of `127.0.0.1` in `redirect_uri`; then with port `53683`; then with the path `/other` | The first returns a code at `localhost`. The other two end on the tenant's error page: no return, no code |
| L16 | A new sign-in, the test person's refresh tokens revoked in the Auth0 dashboard, then a renewal with the newest refresh token | `invalid_grant` |
| L17 | Rollback: the desktop client's ID taken off `AGENT_CLIENT_IDS` at the agent and at L2, both restarted, then `POST /v1/runs` with a desktop access token that has not expired; then the ID put back and both restarted | 403 while off the lists; 200 once it is back |
| L18 | On the VPS, the lines that look like a JWT in what the agent and L2 logged during the check: `grep -cE 'eyJ[A-Za-z0-9_-]+\.eyJ'` over each service's log, printing the count only | 0 for both |

L18 runs last. Turning the desktop client off at the tenant (spec SC-007, §6 below) is not run: it would end every
desktop sign-in on the tenant, and access tokens already issued pass until they expire, an hour at most.

For L14, a second verifier that the challenge `C` was not made from:

```bash
V2=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
```

Sign in again with the `open` command above, put the new code in `CODE`, then:

```bash
curl -sS "https://$T/oauth/token" --data-urlencode grant_type=authorization_code --data-urlencode client_id="$D" --data-urlencode code="$CODE" --data-urlencode code_verifier="$V2" --data-urlencode redirect_uri=http://127.0.0.1:53682/callback > .local/desktop.wrong.json
```

```bash
jq -r '.error // "TOKEN ISSUED"' .local/desktop.wrong.json
```

Delete the files: `rm -f .local/desktop.*`, and revoke the test person's refresh tokens in the dashboard.

## 6. Rollback

Take the desktop client's ID off `AGENT_CLIENT_IDS` at the agent and at L2 and restart them: its tokens get 403
at once. Or turn the application off in Auth0: no new tokens or renewals, and issued access tokens pass until they
expire (an hour). Revoke refresh tokens in Auth0 to end the sign-ins.

## Validation log

| Date | Section | Result | By |
|---|---|---|---|
| | | | |
