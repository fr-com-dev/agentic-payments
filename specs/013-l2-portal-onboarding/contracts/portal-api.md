# Contract: the portal API (browser → portal)

> **Since 014 (SPEC v1.11).** With the administration area on, the `roles` row of the access table accepts
> `Agent.Run` or `Portal.Admin`, each route requires one of them, and `/api/me` and `/api/config` gain additive
> fields. The administration routes are defined in
> [specs/014 contracts/portal-api.md](../../014-portal-l2-control-api/contracts/portal-api.md).

The portal process serves the web app's static files and this JSON API under `/api`. It is the only new public
entry point. Normative for SPEC L2-8 and `docs/portal.openapi.yaml`; T-API-12..15 fail until they match the service.
`API_DOCS=1` adds Swagger UI at `/docs`, as on the other services, and is never set in Azure.

## Access (FR-003, FR-005; SEC-19, SEC-20)

Every `/api` route except `/api/config` needs `Authorization: Bearer <access token>`. The token is verified before
the body is read, then deleted from the request, as the hosted agent does. No cookie is used, so there is no CSRF
surface.

| Check | Value | Failure |
|---|---|---|
| signature | the tenant's JWKS (`https://login.microsoftonline.com/<tid>/discovery/v2.0/keys`), or the dev issuer's file with `NETWORK=local` | 401 |
| `iss` | `https://login.microsoftonline.com/<tid>/v2.0` (dev: `urn:x402:dev-issuer`) | 401 |
| `aud` | the API app's client ID (`AUTH_AUDIENCE`), the same as the agent service | 401 |
| `tid`, `oid` | the configured tenant; a non-empty `oid` | 401 |
| `exp`, `nbf` | 60 s tolerance | 401 |
| `idtyp` | exactly `user` (a system identity is refused, FR-003) | 403 |
| `scp` | contains `Portal.Access` | 403 |
| `azp` | equals `PORTAL_CLIENT_ID`, the portal web app's client | 403 |
| `roles` | contains `Agent.Run`: the one permission (clarified 2026-11-10) | 403 |
| `auth_time` | present, an integer, not in the future beyond 60 s. Checked last: a token that is valid but not the portal's is 403 whether or not it carries the claim | 401 |

- A token issued for the agent service has `scp: user_impersonation` and another `azp`, so the portal refuses it
  with 403 (FR-005). The agent service in turn refuses a portal token ([hosted-agent delta](#hosted-agent-delta-l1-6)).
- 401 and 403 bodies are `{ "error": "unauthorized" }` and `{ "error": "forbidden" }`, nothing more. A refused
  request creates no file, no ledger entry and no call to L2 or the card vault (T-PRT-01).
- **The user** is `userIdFor(tid, oid)`. It is never read from the path, the query or the body: no route takes a
  user identifier (FR-004).
- **Identity confirmed at** is `auth_time × 1000`. The portal passes it to L2 as `identityConfirmedAtMs` on every
  loosening call; L2 decides whether it is fresh enough ([control-api.md](control-api.md)).

## Limits and headers

- Body at most 16 KB (413); JSON only; unknown fields are a 400.
- 300 requests per minute per client address on every `/api` route but `/api/config`, counted **before** the token
  is verified (429 `{ "error": "too many requests" }` with `Retry-After`), so a caller without a valid token is
  bounded too. With `TRUSTED_PROXY_HOPS` set (1 in Azure) the address is the client's, from `X-Forwarded-For`;
  unset, that header is ignored.
- Then 120 requests per minute per user (429 with `Retry-After`). Both per replica.
- Every `/api` response: `Cache-Control: no-store`.
- Every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security` off loopback, and this Content-Security-Policy:

  ```text
  default-src 'none'; script-src 'self' https://js.stripe.com https://*.js.stripe.com;
  frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://login.microsoftonline.com;
  connect-src 'self' https://api.stripe.com https://login.microsoftonline.com;
  style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'
  ```

  The sign-in redirect page (`/redirect.html`) is the one exception: it is served without `frame-ancestors` and
  `X-Frame-Options`, because the sign-in library loads it in a hidden frame of the same origin, and it runs no
  application code.
- The portal's own log is whitelisted JSON lines: time, route template, status, `userId`, duration. Never a token, a
  name, an email, a body or a card vault message (NFR-003, NFR-004).

## Routes

Amounts cross this API twice: as atomic strings (`…Atomic`) and, on input, as USDC text that the portal parses with
`parseUsdc` (at most 6 decimals, never rounded; FR-025). Responses carry atomic strings only; the web app formats
them.

| Method & path | Request | 200 response | Errors |
|---|---|---|---|
| `GET /api/config` (no token) | — | `{ auth: { mode: "entra" \| "dev", tenantId, clientId, scope }, network, cards: { available, publishableKey? } }`: public values only | — |
| `GET /api/me` | — | `{ userId, enabled, onboarding: { profile, wallet, policy }, profile?: { displayName, contactEmail } }` | 401, 403 |
| `PUT /api/profile` | `{ displayName, contactEmail, acknowledgedTestFunds? }` | the `/api/me` body. First save needs `acknowledgedTestFunds: true` and registers the user at L2 | 400, 422 `invalid_profile` (`issues[]` by field) |
| `GET /api/platform` | — | `{ limits, sellers: [{ host, name }], network, asset, decimals }`. Payee addresses are not returned | — |
| `GET /api/wallet` | — | the wallet view of [data-model.md](../data-model.md#wallet-view-portal--browser) | 409 `profile_required` |
| `PUT /api/wallet/account` | — | the wallet view; creates the crypto account once | 409 `profile_required`, 409 `account_disabled` |
| `POST /api/cards/setup` | — | `{ clientSecret }` | 409 `account_disabled`, 409 `card_limit`, 503 `cards_unavailable`, 503 `card_vault_unavailable` |
| `POST /api/cards` | `{ setupIntentId, nickname? }` | 201 `Card` | 404, 409 `card_not_confirmed`, 409 `card_already_registered`, 409 `card_limit`, 422 `card_expired`, 422 `not_a_card`, 503 |
| `DELETE /api/cards/:cardId` | — | `{ cards }` | 404, 503 |
| `GET /api/policies` | — | `{ policies: Policy[] }`: every state, newest first | — |
| `POST /api/policies` | `PolicyInput` | 201 `Policy` | 403 `step_up_required`, 409 `wallet_required`, 409 `account_disabled`, 422 `invalid_policy` |
| `GET /api/policies/:policyId` | — | `Policy` with `history` | 404 |
| `PUT /api/policies/:policyId` | `PolicyInput & { expectedVersion }` | `Policy` | 403 `step_up_required`, 404, 409 `version_conflict` (with `current`), 409 `policy_removed`, 409 `account_disabled`, 422 |
| `POST /api/policies/:policyId/pause` | — | `Policy` | 404, 409 |
| `POST /api/policies/:policyId/resume` | — | `Policy` | 403 `step_up_required`, 404, 409, 422 |
| `POST /api/policies/:policyId/remove` | — | `Policy` | 404 |
| `POST /api/account/disable` | `{ confirm: true }` | the `/api/me` body | 400 |
| `POST /api/account/enable` | — | the `/api/me` body | 403 `step_up_required` |

Every row can also answer 401, 403 and 429, and 502 `control_unavailable` when L2 can't be reached. A 502 never
leaves a half-made change: the portal writes its own store only after L2 accepted (see "Order of writes").

```text
PolicyInput { name, sellers: string[], autoApproveUsdc, perPaymentUsdc, perRunUsdc, perDayUsdc,
              paymentsPerMinute: number, endsOn: "YYYY-MM-DD", paymentMethod: "crypto_account" }

Policy      { policyId, name, version, state, displayState, values (atomic, as PolicyValues),
              limitedByPlatform: string[], unlistedSellers: string[], updatedAt, history?: PolicyVersion[] }
```

- `endsOn` becomes `expiresAt` at the end of that day, UTC.
- `step_up_required` carries `{ maxAgeSec: 900 }`; the web app signs the person in again and retries once.
- `invalid_policy` carries L2's `issues` with fields renamed to the input's names, plus the portal's own
  (`name`, a `…Usdc` field with code `too_many_decimals` or `not_a_number`).
- `:policyId` and `:cardId` are looked up for the signed-in user only; anything else is 404 with the same body as an
  unknown one (FR-004).

## Order of writes

L2 first, the portal's own store second, so a failure in between never grants anything:

| Action | Order | If the second step fails |
|---|---|---|
| First profile save | write the profile file, then `PUT …/registration` at L2 | the file exists without a registration; `/api/me` shows the profile step as not done and the next save retries |
| Create or rename a policy | L2 (`POST` or `PUT`), then `policyNames` in the profile file | the policy shows as "Untitled policy" until renamed |
| Add a card | vault, then L2 | the portal detaches the card ([card-vault.md](card-vault.md)) |
| Remove a card | vault, then L2 | reconciled on the next list |

The first row writes the personal data before the ledger entry on purpose: the ledger entry is the one that can't be
taken back.

## Hosted agent delta (L1-6)

Normative for `specs/011` contracts/hosted-agent-api.md and `docs/l1-hosted.openapi.yaml` (T-API-05..08).

- **Naming the user (FR-033).** For a requester of kind `user`, every `PaymentIntent` of the run carries
  `userId = userIdFor(tid, oid)`, and `check_budget` passes it to `GET /v1/budget`. For kind `service`, no user
  (FR-002). The value is fixed when the run starts, from the verified token; no tool input and no model text can
  change it.
- **Refusing portal tokens (SEC-20).** A token is of kind `service` only when `idtyp === "app"`. Any other token
  must have `scp` containing `user_impersonation`, and its `azp` must not be `PORTAL_CLIENT_ID` when that variable
  is set; otherwise 403. Today the service checks neither claim.
- Nothing else changes: the same two tools, limits, session references, statuses and response fields.

## Tests

| ID | Covers |
|---|---|
| T-API-12..15 | `docs/portal.openapi.yaml` matches routes, statuses, schemas and the security scheme; Swagger UI only with `API_DOCS=1` |
| T-PRT-01 | access: each row of the access table; each refusal makes 0 calls to L2 and the vault and writes nothing. **Must fail**: with `bypassAuth`, an agent-service token reads a profile |
| T-PRT-02 | no route accepts a user identifier; user A's token with user B's `policyId` or `cardId` is 404. **Must fail** with L2's `skipOwnershipCheck` |
| T-PRT-03 | profile: validation, the acknowledgement, edits don't touch L2 after the first save |
| T-PRT-04 | wallet view: balance cache, the stale path when the RPC fails, low-balance flag |
| T-PRT-05 | policies: USDC parsing (6 decimals, no rounding), issue mapping, step-up relay, version conflict, order of writes |
| T-PRT-06 | L2 down: 502 on every route that needs it, nothing written; card vault down: only card routes fail |
| T-PRT-07 | headers and CSP on every response; the redirect page exception; `no-store` on `/api` |
| T-PRT-08 | the log whitelist; a known-value scan for tokens, names, emails and card fields |
| T-AGT-06 | hosted agent: a user's intents and budget calls carry `userId`; a service's carry none; a goal or tool input naming another user changes nothing |
| T-AGT-07 | hosted agent refuses a portal token (403). **Must fail** with the `scp`/`azp` check removed |
