# Contract: requester access and session references (proposed SPEC L1-6, SEC-14, SEC-15)

## Token verification (`src/layer1-intent/hosted/requester-auth.ts`)

It runs on every request except `GET /healthz` and `GET /readyz`, before the body is read.

| Check | Rule | Failure |
|---|---|---|
| Header | `Authorization: Bearer <jwt>` | 401 |
| Signature | key from the JWKS: `https://login.microsoftonline.com/<AUTH_TENANT_ID>/discovery/v2.0/keys` (cached by `jose`), or `AUTH_JWKS_FILE` when `NETWORK=local` | 401 |
| `iss` | `https://login.microsoftonline.com/<AUTH_TENANT_ID>/v2.0`; or `urn:x402:dev-issuer` with `AUTH_JWKS_FILE` | 401 |
| `tid` | equals `AUTH_TENANT_ID` (or `dev` locally) | 401 |
| `aud` | equals `AUTH_AUDIENCE`: the API app's client ID. Entra v2.0 tokens always carry the client ID, never the `api://` URI, so with Entra any other value is a startup error. The dev issuer uses `api://x402-l1-agent` | 401 |
| `exp`, `nbf` | 60 s clock tolerance | 401 |
| `oid` | present | 401 |
| `roles` | contains `Agent.Run` | 403 |
| `scp`, `azp` (v1.10, 013 SEC-20) | for any token that is not `idtyp: app`: `scp` contains `user_impersonation`, and `azp` is not `PORTAL_CLIENT_ID` when that variable is set. A token issued for the portal is refused here, as the portal refuses this service's | 403 |

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
- **Getting a token** (both carry the client ID as `aud` and `Agent.Run` in `roles`):
  - a person assigned `Agent.Run`:
    `az account get-access-token --scope api://app-l1-eastus2-dev/user_impersonation --query accessToken -o tsv`;
  - a service principal assigned `Agent.Run`: client credentials for `api://app-l1-eastus2-dev/.default`
    (the pipeline's smoke check, signed in as the deploy app, uses
    `az account get-access-token --resource api://app-l1-eastus2-dev`).
- **Local** (`NETWORK=local` only): `npm run dev-token -- [--subject <name>] [--no-role] [--expired]`
  writes `.local/dev-issuer/jwks.json` on first use and prints a signed token. With
  `NETWORK≠local`, setting `AUTH_JWKS_FILE` is a startup error.

## Session references (`src/layer1-intent/hosted/session-ref.ts`)

- **Format**: `sr1.<sessionId>.<mac>`. `sessionId` matches `^sess_[0-9a-f]{16}$`. `mac` is
  43 base64url characters.
- **MAC**: `HMAC-SHA256(SESSION_REF_SECRET, "sr1|" + tid + "|" + oid + "|" + sessionId)`.
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

Limits are counted per requester key `tid:oid`. They are exact while `ca-l1-eastus2-dev` has
`maxReplicas: 1` (research R8).

## Tests

- **T-AGT-03 (access)**:
  - no token, a bad signature, expired, wrong `aud`, wrong `iss`, wrong `tid` → 401;
  - no role → 403;
  - a person token and a service (`idtyp: app`) token with the role → 200;
  - 2 + 1 concurrent → 429;
  - 21st start → 429;
  - every refusal: 0 model calls, 0 L2 calls and an unchanged ledger.
  - **Must fail**: with the middleware bypassed, the unauthenticated request reaches the model.
  - With Entra (no `AUTH_JWKS_FILE`), a non-GUID `AUTH_AUDIENCE` is a startup error. **Must fail**:
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
