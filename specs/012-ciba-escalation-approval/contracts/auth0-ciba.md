# Contract: L2 → Auth0 (CIBA poll mode)

The only outbound interface this feature adds (NFR-004). L2 is the OAuth client; Auth0 is the
OpenID Provider. `{issuer}` is `CIBA_ISSUER` (it must be `https://` and end with `/`). Every request
goes to one of these three URLs. No other host or path is ever contacted:

| Purpose | Method and URL | Module |
|---|---|---|
| Start a request | `POST {issuer}bc-authorize` | `ciba-client.ts` |
| Poll | `POST {issuer}oauth/token` | `ciba-client.ts` |
| Signing keys | `GET {issuer}.well-known/jwks.json` | `approval-evidence.ts` (jose remote JWKS, cached) |

Timeouts: a start attempt has 1.5 s, a poll has 5 s, and the JWKS fetch has jose's default of 5 s.
A response is read as JSON, at most 64 KiB, and only the fields named below are used. Nothing from
a response body is logged.

## Client authentication (both POSTs)

Exactly one method is configured (research R3).

- **`private_key_jwt`** (preferred, `CIBA_CLIENT_KEY`). The form fields are
  `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and
  `client_assertion=<JWT>`. A new assertion is signed for every request:

  | Header or claim | Value |
  |---|---|
  | `alg` | `RS256` |
  | `kid` | `CIBA_CLIENT_KEY_ID`, when set |
  | `iss`, `sub` | `CIBA_CLIENT_ID` |
  | `aud` | `{issuer}` (trailing slash included) |
  | `jti` | 32 random bytes, base64url |
  | `iat` | now |
  | `exp` | `iat` + 60 |
- **`client_secret_post`** (fallback, `CIBA_CLIENT_SECRET`). The form fields are `client_id` and
  `client_secret`.

`client_id` is sent in both cases.

## Start: `POST {issuer}bc-authorize`

Form fields (`application/x-www-form-urlencoded`):

| Field | Value |
|---|---|
| `client_id` | `CIBA_CLIENT_ID` |
| `scope` | `openid` (no `offline_access`, so no refresh token) |
| `login_hint` | `{"format":"iss_sub","iss":"{issuer}","sub":"{CIBA_APPROVER}"}` |
| `binding_message` | [payment-details](payment-details.md#binding-message) |
| `audience` | `CIBA_AUDIENCE` |
| `requested_expiry` | `min(300, floor((escalation.expiresAtMs − now) / 1000))` (FR-006; Guardian push needs ≤ 300) |
| `authorization_details` | `JSON.stringify([details])`, see [payment-details](payment-details.md#authorization_details) |
| client authentication | as above |

How L2 reads the response:
- **200** with `auth_req_id` (a non-empty string), `expires_in` (a positive integer) and `interval`
  (optional, a positive integer, default 5) means success. In that case:
  - `requestExpiresAtMs` = `sentAt` + `expires_in` × 1000, capped at the escalation's `expiresAtMs`;
  - the handle is sealed at once, and the plaintext is kept only in the poll loop's memory.
- **4xx with an OAuth `error`** is permanent (no retry).
- **Anything else** is transient: a network error, a timeout, 429, 5xx, a non-JSON body, or a 200
  missing a field. It is retried per research R10.

## Poll: `POST {issuer}oauth/token`

| Field | Value |
|---|---|
| `grant_type` | `urn:openid:params:grant-type:ciba` |
| `auth_req_id` | the handle, from memory or opened from `handleSealed` |
| `client_id` + client authentication | as above |

| Response | L2 action |
|---|---|
| 200 with `access_token` | Verify it (below). `authorization_details` in the body is read only as the fallback source (research R5). `id_token`, `refresh_token` and `scope` are ignored and never stored. |
| `error=authorization_pending` | Poll again after `interval` |
| `error=slow_down` | `interval` = max(the returned `interval` if it is a positive integer, `interval` + 5), then poll |
| `error=access_denied` | At least 5 000 ms before `requestExpiresAtMs`: a **refusal**. Otherwise a **lapse** (`late_refusal`) |
| `error=expired_token` | A **lapse** (`expired`) |
| `error=invalid_grant`, `invalid_client`, `unauthorized_client`, `invalid_request`, any other OAuth error | **Failed**, permanent (`phase: poll`) |
| A network error, timeout, 429, 5xx or non-JSON body | Transient: wait `min(interval × 2, 30)` s and poll again, until `requestExpiresAtMs` |

There is never more than one request in flight per handle.

## The access token L2 accepts

Each check is a separate step, so each can be shown to fail on its own (Constitution VIII):
- the signature is checked with `jose.compactVerify(token, remoteJWKS, { algorithms: ["RS256"] })`;
- the claims are decoded with `jose.decodeJwt`;
- every claim is checked by L2's own code.

They run in this order, and the first failure becomes `APPROVAL_VERIFICATION_FAILED { check }`:

| # | `check` | Passes when |
|---|---|---|
| 1 | `malformed` | Three base64url JWT parts; the claims `iss`, `sub`, `aud`, `exp` and `iat` are present with the right types |
| 2 | `signature` | It verifies with a JWKS key with the matching `kid`, using RS256 |
| 3 | `issuer` | `iss === CIBA_ISSUER` (exact) |
| 4 | `audience` | `aud` (a string or an array) contains `CIBA_AUDIENCE` |
| 5 | `client` | `azp ?? client_id === CIBA_CLIENT_ID` |
| 6 | `expired` | `exp`, `nbf` (if present) and `iat` are within the 60 s tolerance of L2's clock |
| 7 | `approver` | `sub === CIBA_APPROVER` |
| 8 | `request` | The details hold exactly one object whose `properties.request_id.value` is the escalation's open request |
| 9 | `details` | `canonicalJSON(received) === canonicalJSON(sent)`, with `sent` = `APPROVAL_REQUESTED.data.details` |
| 10 | `replay` | `answerId` (`jti`, or `sha256:` + the hex SHA-256 of the token) is not on any `HUMAN_APPROVAL` |

- **The details** come from the token's `authorization_details` claim when it is present.
  Otherwise they come from the response body's `authorization_details`, and
  `detailsSource: "response"` is recorded.
- **jose's errors** from `compactVerify` all map to `signature`; those from `decodeJwt` map to
  `malformed`. The jose error message is never logged.
- **Must-fail proofs**: each check from 2 to 10 has a test-only switch (`skipChecks`) that turns
  it off. With its check off, the matching forgery is accepted. `malformed` has nothing to turn off.
- **Evidence kept on success**: `{ issuer: iss, subject: sub, answerId, issuedAt: ISO(iat),
  detailsSource }`. Never the token.

## Error codes

Only these OAuth `error` values are ever stored, in `APPROVAL_REQUEST_FAILED.error`. Any other value
is stored as `other`. `error_description` and `error_uri` are never read into a log, an entry or a
response.

`invalid_request`, `invalid_scope`, `expired_login_hint_token`, `unknown_user_id`,
`unauthorized_client`, `missing_user_code`, `invalid_user_code`, `invalid_binding_message`,
`invalid_client`, `access_denied`, `invalid_grant`, `expired_token`,
`invalid_authorization_details`, `too_many_requests`.
