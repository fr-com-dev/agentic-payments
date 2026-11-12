# Contract: requester access and session references (proposed SPEC L1-6, SEC-14, SEC-15)

## Token verification (`src/layer1-intent/hosted/requester-auth.ts`)

It runs on every request except `GET /healthz` and `GET /readyz`, before the body is read.

**Since SPEC v1.12 (specs/013 research R19) there are two issuers.** The service reads `iss` from the token,
unverified, only to choose the checks, then verifies in full against that issuer (the shared verifier,
`src/shared/identity-token.ts`). Any other issuer is 401.

*A person: the Auth0 tenant.*

| Check | Rule | Failure |
|---|---|---|
| Header | `Authorization: Bearer <jwt>` | 401 |
| Signature | key from `<AUTH_ISSUER>.well-known/jwks.json`, RS256 only (cached by `jose`), or `AUTH_JWKS_FILE` when `NETWORK=local` | 401 |
| `iss` | `AUTH_ISSUER` exactly (`https://<domain>/`); or `urn:x402:dev-issuer` with `AUTH_JWKS_FILE` | 401 |
| `aud` | contains `AUTH_AUDIENCE`, the API's identifier. The dev issuer uses `api://x402-l1-agent` | 401 |
| `exp`, `nbf` | 60 s clock tolerance | 401 |
| `sub` | not empty, no line break | 401 |
| not a machine token | no `gty: client-credentials`, and `sub` does not end in `@clients` | 403 |
| `permissions` | contains `agent:run` | 403 |
| client | `azp` (or `client_id`) is on `AGENT_CLIENT_IDS`. The portal's client never is, so a token issued for the portal is refused here, as the portal refuses this service's (SEC-20); the service refuses to start with `PORTAL_CLIENT_ID` on the list | 403 |

*A system identity: the organization's directory (Entra).* The table below, as before, with three differences: the
audience variable is `SERVICE_AUDIENCE`; `idtyp` must be exactly `app` (403 otherwise, so a person's Entra token no
longer starts a run); and the `scp`/`azp` row of v1.10 is gone. Without `AUTH_TENANT_ID` and `SERVICE_AUDIENCE`
(both or neither) no system identity is accepted. With `AUTH_JWKS_FILE` its issuer is `urn:x402:dev-directory`.

| Check | Rule | Failure |
|---|---|---|
| Header | `Authorization: Bearer <jwt>` | 401 |
| Signature | key from the JWKS: `https://login.microsoftonline.com/<AUTH_TENANT_ID>/discovery/v2.0/keys` (cached by `jose`), or `AUTH_JWKS_FILE` when `NETWORK=local` | 401 |
| `iss` | `https://login.microsoftonline.com/<AUTH_TENANT_ID>/v2.0`; or `urn:x402:dev-issuer` with `AUTH_JWKS_FILE` | 401 |
| `tid` | equals `AUTH_TENANT_ID` (or `dev` locally) | 401 |
| `aud` | equals `SERVICE_AUDIENCE` (`AUTH_AUDIENCE` before v1.12): the API app's client ID. Entra v2.0 tokens always carry the client ID, never the `api://` URI, so with Entra any other value is a startup error. The dev issuer uses `api://x402-l1-agent-service` | 401 |
| `exp`, `nbf` | 60 s clock tolerance | 401 |
| `oid` | present | 401 |
| `idtyp` (v1.12) | exactly `app` | 403 |
| `roles` | contains `Agent.Run` | 403 |

- 401 and 403 bodies are `{ "error": "unauthorized" }` and `{ "error": "forbidden" }`. They never
  say which check failed.
- After verification the middleware deletes `req.headers.authorization`, so nothing downstream can
  forward it (FR-009).
- **Entra setup** (`infra/pre-deploy.bicep`, deployed once by an administrator; quickstart §4 step 0):
  - the API app registration `app-l1-eastus2-dev`, with application ID URI `api://app-l1-eastus2-dev`
    and v2.0 access tokens;
  - the app role `Agent.Run` with `allowedMemberTypes: ["User", "Application"]`;
  - "assignment required" on its service principal, so that unassigned users can't get a token with
    the role;
  - the delegated scope `user_impersonation` (admin consent only), with the Azure CLI
    (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) pre-authorized for it. Pre-authorization needs no
    service principal for the Azure CLI in the tenant;
  - `Agent.Run` for the deploy app and for each user in `agentUsers` (`pre-deploy.<env>.bicepparam`).
  - Its `mainParameters` output gives the app's client ID as `authAudience`, which goes into
    `main.<env>.bicepparam`. `AUTH_TENANT_ID` is that file's `tenantId`. T-IAC-01 rule 16 checks the
    whole setup.
- **Getting a token**:
  - a person: none from the sign-in tenant since SPEC v1.13. The Auth0 tenant has two applications, the portal's
    and L2's (`specs/013` research R20), so no client issues a token this service accepts, and a deployed agent is
    configured without `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS`. v1.12 had a native client with the
    device flow (`npm run user-token`); before v1.12 it was
    `az account get-access-token --scope api://app-l1-eastus2-dev/user_impersonation`. Neither starts a run now;
  - a service principal assigned `Agent.Run`: client credentials for `api://app-l1-eastus2-dev/.default`
    (the pipeline's smoke check, signed in as the deploy app, uses
    `az account get-access-token --resource api://app-l1-eastus2-dev`).
- **Local** (`NETWORK=local` only): `npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service]`
  writes `.local/dev-issuer/jwks.json` on first use and prints a signed token. With
  `NETWORK≠local`, setting `AUTH_JWKS_FILE` is a startup error.

## Session references (`src/layer1-intent/hosted/session-ref.ts`)

- **Format**: `sr1.<sessionId>.<mac>`. `sessionId` matches `^sess_[0-9a-f]{16}$`. `mac` is
  43 base64url characters.
- **MAC**: `HMAC-SHA256(SESSION_REF_SECRET, m)`, where `m` is `sr1`, the requester's kind (`user` or `service`), who
  vouches for it (a person's issuer, a system identity's tenant), its subject (`sub`, or `oid`) and the session ID,
  joined by newlines. Before v1.12 it was `"sr1|" + tid + "|" + oid + "|" + sessionId`; a reference issued then no
  longer verifies (404).
- **Issue**: a run without `sessionRef` gets a new `sessionId` (16 random hex characters) and its
  reference.
- **Verify**:
  - The format is checked first. A value matching `^sess_` or anything else malformed → 400.
  - The MAC is recomputed for the caller and compared with `timingSafeEqual`. A mismatch → 404
    `{ "error": "unknown session" }`.
- **Secret**: `SESSION_REF_SECRET` is at least 32 bytes, as base64 or hex. A missing or short
  secret is a startup error. It lives only in `kv-l1` (locally, `env/l1-hosted.env`).

## Limits (`src/layer1-intent/hosted/run-limits.ts`)

| Limit | Value | Over limit |
|---|---|---|
| concurrent runs per requester | 2 | 429, `Retry-After: 5` |
| run starts per requester per sliding 3,600 s | 20 | 429, `Retry-After` = seconds until the oldest start ages out |
| goal length | 1–4,000 characters | 400 |
| request body | 16 KB | 413 |

Limits are counted per requester key: `<issuer host>:<sub>` for a person (v1.12), `tid:oid` for a system identity. They are exact while `ca-l1-eastus2-dev` has
`maxReplicas: 1` (research R8).

## Tests

- **T-AGT-03 (access)**:
  - no token, a bad signature, expired, wrong `aud`, wrong `tid`, an issuer the service does not know → 401;
  - no permission (a person) or no role (a system identity), a machine token of the sign-in tenant, a person's
    Entra token → 403 (v1.12);
  - a person's token with `agent:run` from a listed client and a system identity's (`idtyp: app`) with the role → 200;
  - 2 + 1 concurrent → 429;
  - 21st start → 429;
  - every refusal: 0 model calls, 0 L2 calls and an unchanged ledger.
  - **Must fail**: with the middleware bypassed, the unauthenticated request reaches the model.
  - With Entra (no `AUTH_JWKS_FILE`), a non-GUID `SERVICE_AUDIENCE` is a startup error. **Must fail**:
    without that check the `api://` URI loads.
  - The API app registration is checked on the compiled `pre-deploy.bicep` (T-IAC-01 rule 16): v2.0
    tokens, its standard URI, only `Agent.Run`, only `user_impersonation` with only the Azure CLI
    pre-authorized, assignment required. **Must fail**: an API app on v1.0 tokens.
- **T-AGT-04 (sessions)**:
  - the first run issues a reference, and a second run with it uses the same `sessionId`;
  - another requester's use of it → 404;
  - `sess_…` → 400;
  - a tampered MAC → 404.
  - **Must fail**: with the MAC check disabled, the second requester's run uses the first one's
    session.
